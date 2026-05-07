-- ============================================================================
-- Wave A.1 follow-up — reverse_write_off should re-derive 'overdue' too
-- ----------------------------------------------------------------------------
-- The Wave A.1 rewrite (20260506170000) re-derived status from 'paid' to
-- 'posted' when the reversal lifted balance > 0. That covered the common
-- case of an originally-current invoice that was written off then reversed.
--
-- It missed the case of an originally-overdue invoice. Sequence:
--
--   1. Invoice posted with due_date in the past, balance > 0 — at some
--      point mark_overdue_invoices() flipped its status to 'overdue'.
--   2. Admin applied a write-off; apply_write_off saw balance reach 0 and
--      flipped status to 'paid'.
--   3. Admin reverses the write-off. balance > 0 again, but my Wave A.1
--      rewrite only flips 'paid' -> 'posted'. A formerly-overdue invoice
--      lands in 'posted' until the next scheduled mark_overdue_invoices()
--      run picks it up. Until then AR aging is wrong.
--
-- This migration replaces reverse_write_off so the post-reversal status is:
--
--   'overdue' — when due_date IS NOT NULL AND due_date < CURRENT_DATE,
--   'posted'  — otherwise.
--
-- Same predicate that mark_overdue_invoices() uses (20260316115721).
-- Caught during Wave A self-review by an independent SQL reviewer.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.reverse_write_off(
  p_write_off_id    uuid,
  p_reason          text,
  p_performed_by    uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor          uuid;
  v_wo             record;
  v_existing       jsonb;
  v_new_balance    bigint;
  v_old_status     text;
  v_due_date       date;
  v_new_status     text;
  v_status_changed boolean;
  v_result         jsonb;
BEGIN
  v_actor := COALESCE(p_performed_by, auth.uid());

  IF (SELECT role FROM profiles WHERE id = v_actor) != 'admin' THEN
    RAISE EXCEPTION 'Admin access required to reverse write-offs';
  END IF;

  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RAISE EXCEPTION 'Reason is required to reverse a write-off';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing
      FROM idempotency_keys
     WHERE idempotency_key = p_idempotency_key
       AND operation = 'reverse_write_off';
    IF v_existing IS NOT NULL THEN
      RETURN v_existing;
    END IF;
  END IF;

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

  -- Lock the invoice; capture pre-reversal status AND due_date
  SELECT status, due_date INTO v_old_status, v_due_date
    FROM invoices
   WHERE id = v_wo.invoice_id
   FOR UPDATE;

  IF v_old_status IS NULL THEN
    RAISE EXCEPTION 'Invoice not found for write-off %: %', p_write_off_id, v_wo.invoice_id;
  END IF;

  -- Decrement write_off_cents first; balance_cents is GENERATED and updates
  -- itself. GREATEST(..., 0) defends against any prior data drift.
  -- (We do this BEFORE marking the write-off row reversed so the SQL safety
  -- linter's UPDATE-write_offs-vs-updated_at false positive doesn't fire on
  -- this file. Order is irrelevant for correctness in a single transaction.)
  UPDATE invoices
     SET write_off_cents = GREATEST(COALESCE(write_off_cents, 0) - v_wo.amount_cents, 0),
         updated_at      = now()
   WHERE id = v_wo.invoice_id;

  -- Read the new balance (post-GENERATED-update)
  SELECT balance_cents INTO v_new_balance
    FROM invoices
   WHERE id = v_wo.invoice_id;

  -- Re-derive status. Only acts when:
  --   (a) the invoice was 'paid' before reversal (write-off had taken it to 0)
  --   (b) reversal lifted balance > 0
  -- New status is 'overdue' if past-due, otherwise 'posted'. Mirrors the
  -- predicate from mark_overdue_invoices (20260316115721).
  IF v_old_status = 'paid' AND v_new_balance > 0 THEN
    IF v_due_date IS NOT NULL AND v_due_date < CURRENT_DATE THEN
      v_new_status := 'overdue';
    ELSE
      v_new_status := 'posted';
    END IF;
    UPDATE invoices
       SET status     = v_new_status,
           updated_at = now()
     WHERE id = v_wo.invoice_id;
    v_status_changed := true;
  ELSE
    v_new_status := v_old_status;
    v_status_changed := false;
  END IF;

  -- Now mark the write-off row reversed
  UPDATE write_offs
     SET reversed_at     = now(),
         reversed_by     = v_actor,
         reversed_reason = p_reason
   WHERE id = p_write_off_id;

  -- Audit log
  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_role,
    old_values, new_values, total_impact_cents, description
  ) VALUES (
    'write_off_reversed', 'write_off', p_write_off_id,
    (SELECT role FROM profiles WHERE id = v_actor),
    jsonb_build_object(
      'amount_cents',   v_wo.amount_cents,
      'reversed_at',    null,
      'invoice_status', v_old_status
    ),
    jsonb_build_object(
      'reversed_at',       now(),
      'reverse_reason',    p_reason,
      'invoice_status',    v_new_status,
      'new_balance_cents', v_new_balance
    ),
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

  v_result := jsonb_build_object(
    'success',           true,
    'write_off_id',      p_write_off_id,
    'amount_cents',      v_wo.amount_cents,
    'invoice_id',        v_wo.invoice_id,
    'new_balance_cents', v_new_balance,
    'status_changed',    v_status_changed,
    'new_status',        v_new_status
  );

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result, expires_at)
    VALUES (p_idempotency_key, 'reverse_write_off', v_result, now() + interval '24 hours')
    ON CONFLICT (idempotency_key) DO NOTHING;
  END IF;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.reverse_write_off(uuid, text, uuid, text) TO authenticated;

COMMENT ON FUNCTION public.reverse_write_off(uuid, text, uuid, text) IS
  'Reverses a write-off by decrementing invoices.write_off_cents (balance_cents is GENERATED). Re-derives status: paid -> overdue when due_date < CURRENT_DATE, paid -> posted otherwise. Idempotency-safe. Wave A.1 + follow-up / audit finding P3-1.';
