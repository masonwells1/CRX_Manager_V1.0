-- ============================================================================
-- ADMIN CORRECTIONS: Phase 1
-- 1.2 reopen_accounting_period()  — allows admin to reopen a closed period
-- 1.3 reverse_write_off()         — marks a write-off reversed, restores AR
-- ============================================================================

-- Add reversed_by column to write_offs (reversed_at and reversed_reason already exist)
ALTER TABLE write_offs ADD COLUMN IF NOT EXISTS reversed_by uuid REFERENCES profiles(id);

-- ============================================================================
-- 1.2  reopen_accounting_period()
-- ============================================================================
CREATE OR REPLACE FUNCTION public.reopen_accounting_period(
  p_period_id    uuid,
  p_reason       text,
  p_performed_by uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor  uuid;
  v_period record;
BEGIN
  v_actor := COALESCE(p_performed_by, auth.uid());

  -- Admin-only
  IF (SELECT role FROM profiles WHERE id = v_actor) != 'admin' THEN
    RAISE EXCEPTION 'Admin access required to reopen accounting periods';
  END IF;

  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RAISE EXCEPTION 'Reason is required to reopen an accounting period';
  END IF;

  -- Idempotency
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM 1 FROM idempotency_keys
    WHERE key = p_idempotency_key AND operation = 'reopen_accounting_period';
    IF FOUND THEN
      RETURN jsonb_build_object('status', 'already_processed');
    END IF;
  END IF;

  -- Lock and fetch
  SELECT * INTO v_period
  FROM accounting_periods
  WHERE id = p_period_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Accounting period not found: %', p_period_id;
  END IF;

  IF v_period.status != 'closed' THEN
    RAISE EXCEPTION 'Accounting period is not closed (status: %)', v_period.status;
  END IF;

  -- Reopen
  UPDATE accounting_periods SET
    status     = 'open',
    closed_at  = NULL,
    closed_by  = NULL,
    updated_at = now()
  WHERE id = p_period_id;

  -- Audit log
  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_role,
    old_values, new_values, description
  ) VALUES (
    'period_reopened', 'accounting_period', p_period_id,
    (SELECT role FROM profiles WHERE id = v_actor),
    jsonb_build_object('status', 'closed', 'closed_at', v_period.closed_at),
    jsonb_build_object('status', 'open'),
    'Accounting period reopened: ' || p_reason
  );

  -- Activity feed
  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id
  ) VALUES (
    'period_reopened',
    'Accounting period ' || v_period.period_start || ' to ' || v_period.period_end ||
      ' reopened: ' || p_reason,
    v_actor, 'accounting_period', p_period_id
  );

  -- Record idempotency key
  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (key, operation, result_id, expires_at)
    VALUES (p_idempotency_key, 'reopen_accounting_period', p_period_id, now() + interval '24 hours')
    ON CONFLICT (key) DO NOTHING;
  END IF;

  RETURN jsonb_build_object(
    'success',    true,
    'period_id',  p_period_id,
    'period_start', v_period.period_start,
    'period_end',   v_period.period_end
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.reopen_accounting_period(uuid, text, uuid, text) TO authenticated;


-- ============================================================================
-- 1.3  reverse_write_off()
-- ============================================================================
CREATE OR REPLACE FUNCTION public.reverse_write_off(
  p_write_off_id uuid,
  p_reason       text,
  p_performed_by uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid;
  v_wo    record;
BEGIN
  v_actor := COALESCE(p_performed_by, auth.uid());

  -- Admin-only
  IF (SELECT role FROM profiles WHERE id = v_actor) != 'admin' THEN
    RAISE EXCEPTION 'Admin access required to reverse write-offs';
  END IF;

  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RAISE EXCEPTION 'Reason is required to reverse a write-off';
  END IF;

  -- Idempotency
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM 1 FROM idempotency_keys
    WHERE key = p_idempotency_key AND operation = 'reverse_write_off';
    IF FOUND THEN
      RETURN jsonb_build_object('status', 'already_processed');
    END IF;
  END IF;

  -- Lock and fetch
  SELECT * INTO v_wo
  FROM write_offs
  WHERE id = p_write_off_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Write-off not found: %', p_write_off_id;
  END IF;

  IF v_wo.reversed_at IS NOT NULL THEN
    RAISE EXCEPTION 'Write-off has already been reversed';
  END IF;

  -- Mark write-off reversed
  UPDATE write_offs SET
    reversed_at      = now(),
    reversed_by      = v_actor,
    reversed_reason  = p_reason
  WHERE id = p_write_off_id;

  -- Restore invoice balance (add back what was written off)
  UPDATE invoices SET
    balance_cents = balance_cents + v_wo.amount_cents,
    updated_at    = now()
  WHERE id = v_wo.invoice_id;

  -- Audit log
  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_role,
    old_values, new_values, total_impact_cents, description
  ) VALUES (
    'write_off_reversed', 'write_off', p_write_off_id,
    (SELECT role FROM profiles WHERE id = v_actor),
    jsonb_build_object('amount_cents', v_wo.amount_cents, 'reversed_at', null),
    jsonb_build_object('reversed_at', now(), 'reverse_reason', p_reason),
    v_wo.amount_cents,
    'Write-off of ' || (v_wo.amount_cents::numeric / 100)::text ||
      ' reversed on invoice ' || v_wo.invoice_id::text || ': ' || p_reason
  );

  -- Activity feed
  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'write_off_reversed',
    'Write-off of $' || (v_wo.amount_cents::numeric / 100)::text || ' reversed: ' || p_reason,
    v_actor, 'invoice', v_wo.invoice_id, v_wo.customer_id
  );

  -- Record idempotency key
  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (key, operation, result_id, expires_at)
    VALUES (p_idempotency_key, 'reverse_write_off', p_write_off_id, now() + interval '24 hours')
    ON CONFLICT (key) DO NOTHING;
  END IF;

  RETURN jsonb_build_object(
    'success',         true,
    'write_off_id',    p_write_off_id,
    'amount_cents',    v_wo.amount_cents,
    'invoice_id',      v_wo.invoice_id
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.reverse_write_off(uuid, text, uuid, text) TO authenticated;
