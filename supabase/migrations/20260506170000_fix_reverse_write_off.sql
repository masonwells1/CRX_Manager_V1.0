-- ============================================================================
-- Wave A.1 — Fix reverse_write_off()  (audit finding P3-1)
-- ----------------------------------------------------------------------------
-- The previous version of reverse_write_off had three correctness bugs:
--
--   1. It executed
--          UPDATE invoices SET balance_cents = balance_cents + amount_cents
--      but invoices.balance_cents has been GENERATED ALWAYS since migration
--      20260305200000_audit_safety_fixes.sql. Postgres rejects writes to a
--      GENERATED column ("can only be updated to DEFAULT"), so every call
--      to reverse_write_off has been raising an error since that migration
--      shipped — the bug was masked only by the fact that no admin had
--      clicked "Reverse Write-Off" in production.
--
--      Fix: decrement write_off_cents (one of the GENERATED formula inputs).
--      GREATEST(... , 0) defends against any prior data drift that might
--      have left write_off_cents lower than amount_cents.
--
--   2. It did not re-derive status. If the write-off was the thing that
--      drove balance_cents to 0 and flipped invoice.status from 'posted' to
--      'paid', reversing the write-off lifts balance > 0 again but leaves
--      status='paid' — silently misclassifying the invoice in AR aging.
--
--      Fix: after the GENERATED column updates, re-read balance_cents and
--      flip status 'paid' -> 'posted' when balance > 0.
--
--   3. The idempotency_keys references used wrong column names that do not
--      exist on the table. Correct columns are documented in CLAUDE.md:
--      idempotency_key, operation, result (jsonb), expires_at. A prior
--      migration tried to patch this dynamically by cloning function bodies
--      via regex; that approach is exactly what audit finding P3-2 banned.
--      This migration replaces the function explicitly with the right names.
--
-- Also adds pg_temp to search_path per project rule "every SECURITY DEFINER
-- function MUST have SET search_path = public, pg_temp".
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
  v_actor       uuid;
  v_wo          record;
  v_existing    jsonb;
  v_new_balance bigint;
  v_old_status  text;
  v_result      jsonb;
BEGIN
  v_actor := COALESCE(p_performed_by, auth.uid());

  -- Admin-only
  IF (SELECT role FROM profiles WHERE id = v_actor) != 'admin' THEN
    RAISE EXCEPTION 'Admin access required to reverse write-offs';
  END IF;

  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RAISE EXCEPTION 'Reason is required to reverse a write-off';
  END IF;

  -- Idempotency replay
  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing
      FROM idempotency_keys
     WHERE idempotency_key = p_idempotency_key
       AND operation = 'reverse_write_off';
    IF v_existing IS NOT NULL THEN
      RETURN v_existing;
    END IF;
  END IF;

  -- Lock the write-off row
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

  -- Lock the invoice and capture pre-reversal status
  SELECT status INTO v_old_status
    FROM invoices
   WHERE id = v_wo.invoice_id
   FOR UPDATE;

  IF v_old_status IS NULL THEN
    RAISE EXCEPTION 'Invoice not found for write-off %: %', p_write_off_id, v_wo.invoice_id;
  END IF;

  -- Mark write-off reversed (write_offs has NO updated_at column — do not set it)
  UPDATE write_offs
     SET reversed_at     = now(),
         reversed_by     = v_actor,
         reversed_reason = p_reason
   WHERE id = p_write_off_id;

  -- Decrement write_off_cents. balance_cents is GENERATED ALWAYS and updates
  -- automatically. GREATEST(..., 0) prevents going negative if data drift
  -- ever leaves write_off_cents below amount_cents.
  UPDATE invoices
     SET write_off_cents = GREATEST(COALESCE(write_off_cents, 0) - v_wo.amount_cents, 0),
         updated_at      = now()
   WHERE id = v_wo.invoice_id;

  -- Re-derive status: if invoice was 'paid' and reversal lifted balance > 0,
  -- flip it back to 'posted' so AR aging stays correct.
  SELECT balance_cents INTO v_new_balance
    FROM invoices
   WHERE id = v_wo.invoice_id;

  IF v_old_status = 'paid' AND v_new_balance > 0 THEN
    UPDATE invoices
       SET status     = 'posted',
           updated_at = now()
     WHERE id = v_wo.invoice_id;
  END IF;

  -- Audit log (financial_audit_log has no updated_at column)
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
      'reversed_at',     now(),
      'reverse_reason',  p_reason,
      'invoice_status',  CASE WHEN v_old_status = 'paid' AND v_new_balance > 0
                                THEN 'posted' ELSE v_old_status END,
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
    'status_changed',    (v_old_status = 'paid' AND v_new_balance > 0)
  );

  -- Record idempotency key
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
  'Reverses a write-off by decrementing invoices.write_off_cents (balance_cents is GENERATED). Re-derives status from paid->posted when reversal lifts balance > 0. Idempotency-safe: replays return the previous result jsonb. Wave A.1 / audit finding P3-1.';
