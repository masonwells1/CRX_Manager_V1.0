-- ============================================================================
-- AP period-close gates: record_vendor_payment / void_vendor_payment /
-- void_vendor_bill now respect closed accounting periods.
--
-- Money-inventory hunt 2026-07-11 (Phase 3, vendor-ap), adversarially verified
-- + Codex finding-gate REAL/HIGH/SOUND. The entire AR side (record_invoice_payment,
-- allocate_payment, void_payment, void_invoice) and vendor-bill create/update all
-- PERFORM check_period_open(...); these three AP mutators did not, so once a
-- period is closed an admin could still record or void AP activity dated into the
-- frozen month, silently corrupting closed-period AP totals.
--
-- Convention (per 20260513110000): a payment belongs to its OWN period, gated on
-- the payment's date, so old bills remain payable so long as the payment_date is
-- in an open period. Voids gate on the original document's date, matching
-- 20260622050000 (AR void/reversal period gates).
--
-- Guard-only change: each function is re-emitted byte-identical to the live
-- body except ONE added PERFORM check_period_open(...) line (proven by comparing
-- the md5 of each corrected live body against this file's function bodies).
-- Dormant today: 0 closed accounting_periods rows exist live.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.record_vendor_payment(p_vendor_bill_id uuid, p_amount_cents bigint, p_payment_date date DEFAULT CURRENT_DATE, p_payment_method text DEFAULT NULL::text, p_reference_number text DEFAULT NULL::text, p_notes text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_payment_id uuid; v_bill record; v_new_paid bigint; v_new_status text;
  v_actor uuid; v_actor_role text; v_existing jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  SELECT role INTO v_actor_role FROM profiles WHERE id = v_actor AND is_active = true;
  IF v_actor_role IS NULL OR v_actor_role <> 'admin' THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED: admin role required to record vendor payments';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'record_vendor_payment');
    IF v_existing IS NOT NULL THEN RETURN (v_existing->>'payment_id')::uuid; END IF;
  END IF;

  SELECT * INTO v_bill FROM vendor_bills WHERE id = p_vendor_bill_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'BILL_NOT_FOUND: vendor bill % does not exist', p_vendor_bill_id; END IF;
  IF v_bill.status = 'voided' THEN RAISE EXCEPTION 'BILL_VOIDED: cannot record payment on a voided bill'; END IF;
  IF p_amount_cents <= 0 THEN RAISE EXCEPTION 'INVALID_AMOUNT: payment amount must be positive'; END IF;
  IF p_amount_cents > v_bill.balance_cents THEN
    RAISE EXCEPTION 'OVER_PAYMENT: payment of $% exceeds remaining balance $%',
      (p_amount_cents / 100.0)::numeric(12,2), (v_bill.balance_cents / 100.0)::numeric(12,2);
  END IF;

  PERFORM check_period_open(p_payment_date);

  INSERT INTO vendor_payments (vendor_bill_id, payment_date, amount_cents, payment_method,
    reference_number, notes, created_by)
  VALUES (p_vendor_bill_id, p_payment_date, p_amount_cents, p_payment_method,
    p_reference_number, p_notes, v_actor)
  RETURNING id INTO v_payment_id;

  v_new_paid := COALESCE(v_bill.paid_cents, 0) + p_amount_cents;
  v_new_status := CASE
    WHEN v_new_paid >= v_bill.total_cents THEN 'paid'
    WHEN v_new_paid > 0 THEN 'partially_paid'
    ELSE 'unpaid' END;

  UPDATE vendor_bills SET paid_cents = v_new_paid, status = v_new_status, updated_at = now()
    WHERE id = p_vendor_bill_id;

  INSERT INTO financial_audit_log (operation_type, entity_type, entity_id, actor_user_id, actor_role,
    new_values, total_impact_cents, description)
  VALUES ('vendor_payment_recorded', 'vendor_payment', v_payment_id, v_actor, v_actor_role,
    jsonb_build_object('vendor_bill_id', p_vendor_bill_id, 'amount_cents', p_amount_cents,
      'payment_method', p_payment_method, 'reference_number', p_reference_number, 'new_bill_status', v_new_status),
    p_amount_cents,
    'Payment of $' || (p_amount_cents / 100.0)::numeric(12,2) ||
      ' on vendor bill ' || COALESCE(NULLIF(v_bill.bill_number, ''), p_vendor_bill_id::text));

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'record_vendor_payment', jsonb_build_object('payment_id', v_payment_id));
  END IF;

  RETURN v_payment_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.void_vendor_payment(p_payment_id uuid, p_reason text, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid; v_payment record; v_bill record; v_new_paid_cents bigint;
  v_new_status text; v_result jsonb; v_existing jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role = 'admin') THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED: only admins can void vendor payments';
  END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN RAISE EXCEPTION 'REASON_REQUIRED'; END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'void_vendor_payment');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  SELECT * INTO v_payment FROM vendor_payments WHERE id = p_payment_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PAYMENT_NOT_FOUND'; END IF;
  IF v_payment.voided_at IS NOT NULL THEN RAISE EXCEPTION 'PAYMENT_ALREADY_VOIDED'; END IF;

  SELECT * INTO v_bill FROM vendor_bills WHERE id = v_payment.vendor_bill_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'BILL_NOT_FOUND: parent vendor_bill of this payment is missing'; END IF;

  PERFORM check_period_open(v_payment.payment_date);

  v_new_paid_cents := GREATEST(v_bill.paid_cents - v_payment.amount_cents, 0);
  v_new_status := CASE
    WHEN v_new_paid_cents = 0 THEN 'unpaid'
    WHEN v_new_paid_cents < v_bill.total_cents THEN 'partially_paid'
    ELSE 'paid' END;

  UPDATE vendor_bills SET paid_cents = v_new_paid_cents, status = v_new_status, updated_at = now()
    WHERE id = v_bill.id;

  UPDATE vendor_payments SET voided_at = now(), voided_by = v_actor, void_reason = p_reason
    WHERE id = p_payment_id;

  INSERT INTO financial_audit_log (operation_type, entity_type, entity_id, actor_role,
    old_values, new_values, total_impact_cents, description)
  VALUES ('vendor_payment_voided', 'vendor_payment', p_payment_id,
    (SELECT role FROM profiles WHERE id = v_actor),
    jsonb_build_object('amount_cents', v_payment.amount_cents,
      'bill_id', v_bill.id, 'bill_status_before', v_bill.status,
      'bill_paid_cents_before', v_bill.paid_cents),
    jsonb_build_object('voided_at', now()::text, 'void_reason', p_reason,
      'bill_status_after', v_new_status, 'bill_paid_cents_after', v_new_paid_cents),
    -1 * v_payment.amount_cents,
    'Voided vendor payment of $' || (v_payment.amount_cents / 100.0)::numeric(12,2) ||
    ' on bill — ' || p_reason);

  INSERT INTO activity_feed (event_type, description, performed_by,
    related_entity_type, related_entity_id)
  VALUES ('vendor_payment_voided',
    'Voided vendor payment $' || (v_payment.amount_cents / 100.0)::numeric(12,2) || ' — ' || p_reason,
    v_actor, 'vendor_payment', p_payment_id);

  v_result := jsonb_build_object('success', true, 'payment_id', p_payment_id,
    'bill_id', v_bill.id, 'voided_amount_cents', v_payment.amount_cents,
    'new_paid_cents', v_new_paid_cents, 'new_bill_status', v_new_status);

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'void_vendor_payment', v_result);
  END IF;

  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.void_vendor_bill(p_vendor_bill_id uuid, p_reason text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_bill record; v_actor uuid; v_actor_role text; v_existing jsonb; v_active_payments int;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  SELECT role INTO v_actor_role FROM profiles WHERE id = v_actor AND is_active = true;
  IF v_actor_role IS NULL OR v_actor_role <> 'admin' THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED: admin role required to void vendor bills';
  END IF;

  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RAISE EXCEPTION 'REASON_REQUIRED: void requires a reason string';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'void_vendor_bill');
    IF v_existing IS NOT NULL THEN RETURN; END IF;
  END IF;

  SELECT * INTO v_bill FROM vendor_bills WHERE id = p_vendor_bill_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'BILL_NOT_FOUND: vendor bill % does not exist', p_vendor_bill_id; END IF;
  IF v_bill.status = 'voided' THEN RAISE EXCEPTION 'BILL_ALREADY_VOIDED'; END IF;

  SELECT count(*) INTO v_active_payments
    FROM vendor_payments
   WHERE vendor_bill_id = p_vendor_bill_id AND voided_at IS NULL;

  -- (codex audit F3): block voiding ANY bill with active payments
  IF v_active_payments > 0 THEN
    RAISE EXCEPTION
      'BILL_HAS_ACTIVE_PAYMENTS: bill has % active payment(s); void each payment first',
      v_active_payments;
  END IF;

  PERFORM check_period_open(v_bill.bill_date);

  UPDATE vendor_bills SET
    status = 'voided', voided_at = now(), voided_by = v_actor,
    void_reason = p_reason, updated_at = now()
  WHERE id = p_vendor_bill_id;

  INSERT INTO financial_audit_log (operation_type, entity_type, entity_id, actor_user_id, actor_role,
    old_values, new_values, total_impact_cents, description)
  VALUES ('vendor_bill_voided', 'vendor_bill', p_vendor_bill_id, v_actor, v_actor_role,
    jsonb_build_object('status', v_bill.status),
    jsonb_build_object('status', 'voided', 'void_reason', p_reason),
    -v_bill.total_cents,
    'Vendor bill ' || COALESCE(NULLIF(v_bill.bill_number, ''), p_vendor_bill_id::text) ||
      ' voided: ' || p_reason);

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'void_vendor_bill',
      jsonb_build_object('voided', true, 'bill_id', p_vendor_bill_id));
  END IF;
END;
$function$;

-- ---------------------------------------------------------------------------
-- Post-emit verification: exactly one overload of each, and the gate is present.
-- ---------------------------------------------------------------------------
DO $verify$
DECLARE
  v_count int;
  v_gated boolean;
BEGIN
  FOR v_count, v_gated IN
    SELECT count(*)::int,
           bool_and(p.prosrc ~ 'check_period_open')
    FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.proname = ANY (ARRAY['record_vendor_payment','void_vendor_payment','void_vendor_bill'])
    GROUP BY p.proname
  LOOP
    IF v_count <> 1 THEN
      RAISE EXCEPTION 'ap-period-gates verification: expected 1 overload, found %', v_count;
    END IF;
    IF NOT v_gated THEN
      RAISE EXCEPTION 'ap-period-gates verification: check_period_open gate missing after re-emit';
    END IF;
  END LOOP;
END;
$verify$;
