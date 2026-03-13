-- ============================================================================
-- Phase 2.2: void_commission_payment()
-- Reverses a posted commission payment: resets commissions back to 'pending'.
-- Admin-only. Full audit trail.
-- ============================================================================

-- Expand commission_payments.status CHECK to include 'voided'
ALTER TABLE commission_payments
  DROP CONSTRAINT IF EXISTS commission_payments_status_check;

ALTER TABLE commission_payments
  ADD CONSTRAINT commission_payments_status_check
  CHECK (status IN ('unposted', 'posted', 'voided'));

-- ============================================================================
-- void_commission_payment()
-- ============================================================================
CREATE OR REPLACE FUNCTION public.void_commission_payment(
  p_payment_id      uuid,
  p_reason          text,
  p_performed_by    uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor       uuid;
  v_payment     record;
  v_reset_count integer;
BEGIN
  v_actor := COALESCE(p_performed_by, auth.uid());

  -- Admin-only
  IF (SELECT role FROM profiles WHERE id = v_actor) != 'admin' THEN
    RAISE EXCEPTION 'Admin access required to void a commission payment';
  END IF;

  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RAISE EXCEPTION 'Reason is required to void a commission payment';
  END IF;

  -- Idempotency
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM 1 FROM idempotency_keys
    WHERE key = p_idempotency_key AND operation = 'void_commission_payment';
    IF FOUND THEN
      RETURN jsonb_build_object('status', 'already_processed');
    END IF;
  END IF;

  -- Lock and fetch payment
  SELECT * INTO v_payment
  FROM commission_payments
  WHERE id = p_payment_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Commission payment not found: %', p_payment_id;
  END IF;

  IF v_payment.status != 'posted' THEN
    RAISE EXCEPTION 'Only posted commission payments can be voided (current status: %)', v_payment.status;
  END IF;

  -- Reset all linked commissions back to 'pending'
  UPDATE commissions SET
    status     = 'pending',
    paid_date  = NULL,
    updated_at = now()
  WHERE id IN (
    SELECT commission_id FROM commission_payment_items
    WHERE commission_payment_id = p_payment_id
  );

  GET DIAGNOSTICS v_reset_count = ROW_COUNT;

  -- Mark payment as voided
  UPDATE commission_payments SET
    status     = 'voided',
    updated_at = now()
  WHERE id = p_payment_id;

  -- Financial audit log
  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_role,
    old_values, new_values, description
  ) VALUES (
    'commission_payment_voided', 'commission_payment', p_payment_id,
    (SELECT role FROM profiles WHERE id = v_actor),
    jsonb_build_object('status', 'posted', 'total_amount', v_payment.total_amount),
    jsonb_build_object('status', 'voided', 'commissions_reset', v_reset_count),
    'Commission payment ' || v_payment.payment_number || ' voided: ' || p_reason
  );

  -- Activity feed
  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id
  ) VALUES (
    'commission_payment_voided',
    'Commission payment ' || v_payment.payment_number || ' voided: ' || p_reason,
    v_actor, 'commission_payment', p_payment_id
  );

  -- Record idempotency key
  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (key, operation, result_id, expires_at)
    VALUES (p_idempotency_key, 'void_commission_payment', p_payment_id, now() + interval '24 hours')
    ON CONFLICT (key) DO NOTHING;
  END IF;

  RETURN jsonb_build_object(
    'success',           true,
    'payment_id',        p_payment_id,
    'payment_number',    v_payment.payment_number,
    'commissions_reset', v_reset_count
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.void_commission_payment(uuid, text, uuid, text) TO authenticated;
