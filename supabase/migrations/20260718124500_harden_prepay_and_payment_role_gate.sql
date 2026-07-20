-- Harden the actor role gate on two money RPCs so a deactivated / profile-less
-- authenticated user can no longer pass the authorization check.
--
-- Bug (Live Foundation Gauntlet 2026-07-18, H1):
--   apply_prepay_to_invoice and record_invoice_payment gate on
--     IF v_actor_role NOT IN ('admin','sales_rep') THEN RAISE ...
--   When the caller's profile is inactive or missing, the SELECT sets
--   v_actor_role to NULL. In SQL, `NULL NOT IN (...)` evaluates to NULL, which
--   is NOT TRUE, so the RAISE never fires and the caller is let through.
--   record_invoice_payment additionally never filtered on is_active at all.
--
-- Fix (mirrors the already-hardened apply_credit_memo_to_invoice, migration
-- 20260711040000): filter the role lookup on is_active = true AND guard the
-- NULL explicitly with `v_actor_role IS NULL OR ...`.
--
-- Bodies are reproduced verbatim from the live definitions; ONLY the two gate
-- lines in each function are changed. No data is read or written by this
-- migration itself (CREATE OR REPLACE only).

CREATE OR REPLACE FUNCTION public.apply_prepay_to_invoice(p_prepay_credit_id uuid, p_invoice_id uuid, p_amount_cents bigint, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_credit    record;
  v_inv       record;
  v_app_id    uuid;
  v_actor     uuid;
  v_actor_role text;
  v_existing  jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;

  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;

  SELECT role INTO v_actor_role FROM profiles WHERE id = v_actor AND is_active = true;
  -- H1 fix: an inactive/absent profile yields NULL, and `NULL NOT IN (...)` is
  -- NOT TRUE, so the bare NOT IN would let a deactivated-but-authenticated user
  -- through. Guard the NULL explicitly.
  IF v_actor_role IS NULL OR v_actor_role NOT IN ('admin', 'sales_rep') THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE: only active admins and sales reps can apply prepayments';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'apply_prepay_to_invoice');
    IF v_existing IS NOT NULL THEN
      RETURN (v_existing->>'application_id')::uuid;
    END IF;
  END IF;

  SELECT * INTO v_credit FROM prepay_credits WHERE id = p_prepay_credit_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Prepay credit not found'; END IF;

  SELECT * INTO v_inv FROM invoices WHERE id = p_invoice_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invoice not found'; END IF;

  IF v_credit.customer_id IS DISTINCT FROM v_inv.customer_id THEN
    RAISE EXCEPTION 'CUSTOMER_MISMATCH: prepay credit % (customer %) cannot be applied to invoice % (customer %)',
      p_prepay_credit_id, v_credit.customer_id, p_invoice_id, v_inv.customer_id;
  END IF;

  IF v_inv.status NOT IN ('posted', 'overdue') THEN
    RAISE EXCEPTION 'Can only apply prepay to posted/overdue invoices (current status: %)', v_inv.status;
  END IF;

  PERFORM check_period_open(CURRENT_DATE);

  IF p_amount_cents <= 0 THEN RAISE EXCEPTION 'Application amount must be positive'; END IF;

  IF p_amount_cents > v_credit.balance_cents THEN
    RAISE EXCEPTION 'Amount exceeds prepay balance ($%)', (v_credit.balance_cents / 100.0)::numeric(12,2);
  END IF;

  IF p_amount_cents > v_inv.balance_cents THEN
    RAISE EXCEPTION 'Amount exceeds invoice balance ($%)', (v_inv.balance_cents / 100.0)::numeric(12,2);
  END IF;

  INSERT INTO prepay_applications (prepay_credit_id, invoice_id, applied_amount_cents)
  VALUES (p_prepay_credit_id, p_invoice_id, p_amount_cents)
  RETURNING id INTO v_app_id;

  UPDATE customers SET
    prepay_balance_cents = GREATEST(COALESCE(prepay_balance_cents, 0) - p_amount_cents, 0),
    updated_at = now()
  WHERE id = v_inv.customer_id;

  UPDATE invoices SET
    prepay_applied_cents = prepay_applied_cents + p_amount_cents,
    status = CASE
      -- CREDIT-APPLY: include credit_applied_cents in the →paid recompute
      WHEN (total_amount_cents - (paid_amount_cents + prepay_applied_cents + p_amount_cents) - write_off_cents - credit_applied_cents) <= 0
      THEN 'paid' ELSE status END,
    updated_at = now()
  WHERE id = p_invoice_id;

  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_role,
    new_values, total_impact_cents, description
  ) VALUES (
    'prepay_applied', 'prepay', v_app_id, v_actor_role,
    jsonb_build_object(
      'prepay_credit_id', p_prepay_credit_id,
      'invoice_id', p_invoice_id,
      'invoice_number', v_inv.invoice_number,
      'amount_cents', p_amount_cents,
      'remaining_credit', v_credit.balance_cents - p_amount_cents
    ),
    p_amount_cents,
    'Applied $' || (p_amount_cents / 100.0)::numeric(12,2) || ' prepay to ' || v_inv.invoice_number
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(
      p_idempotency_key,
      'apply_prepay_to_invoice',
      jsonb_build_object('application_id', v_app_id)
    );
  END IF;

  RETURN v_app_id;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.apply_prepay_to_invoice(uuid, uuid, bigint, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apply_prepay_to_invoice(uuid, uuid, bigint, uuid, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.record_invoice_payment(p_invoice_id uuid, p_amount_cents bigint, p_payment_method text, p_reference_number text DEFAULT NULL::text, p_notes text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_inv        record;
  v_pay_id     uuid;
  v_actor_role text;
  v_new_paid   bigint;
  v_existing   jsonb;
BEGIN
  -- H1 fix: filter on is_active = true (previously absent) AND guard the NULL
  -- role explicitly, so a deactivated / profile-less authenticated user is
  -- rejected instead of slipping past `NULL NOT IN (...)`.
  SELECT role INTO v_actor_role FROM profiles WHERE id = auth.uid() AND is_active = true;
  IF v_actor_role IS NULL OR v_actor_role NOT IN ('admin', 'sales_rep') THEN
    RAISE EXCEPTION 'Not authorized to record invoice payments';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'record_invoice_payment');
    IF v_existing IS NOT NULL THEN
      RETURN (v_existing->>'payment_id')::uuid;
    END IF;
  END IF;

  PERFORM check_period_open(now()::date);

  SELECT * INTO v_inv FROM public.invoices WHERE id = p_invoice_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invoice not found: %', p_invoice_id; END IF;
  IF v_inv.status NOT IN ('posted', 'overdue') THEN
    RAISE EXCEPTION 'Cannot record payment on invoice with status: %', v_inv.status;
  END IF;
  IF p_amount_cents <= 0 THEN RAISE EXCEPTION 'Payment amount must be positive'; END IF;
  IF p_amount_cents > v_inv.balance_cents THEN
    RAISE EXCEPTION 'Payment amount ($%) exceeds remaining balance ($%)',
      (p_amount_cents / 100.0)::numeric(12,2), (v_inv.balance_cents / 100.0)::numeric(12,2);
  END IF;

  INSERT INTO public.payments (order_id, customer_id, amount, payment_method, reference_number, notes, recorded_by)
  VALUES (v_inv.order_id, v_inv.customer_id, (p_amount_cents / 100.0)::numeric(12,2), p_payment_method, p_reference_number, p_notes, auth.uid())
  RETURNING id INTO v_pay_id;

  v_new_paid := v_inv.paid_amount_cents + p_amount_cents;

  UPDATE public.invoices SET
    paid_amount_cents = v_new_paid,
    status = CASE
      -- CREDIT-APPLY: include credit_applied_cents in the →paid recompute
      WHEN (v_inv.total_amount_cents - v_new_paid - v_inv.prepay_applied_cents - v_inv.write_off_cents - v_inv.credit_applied_cents) <= 0
      THEN 'paid' ELSE status END,
    updated_at = now()
  WHERE id = p_invoice_id;

  INSERT INTO public.financial_audit_log (operation_type, entity_type, entity_id, actor_role, new_values, total_impact_cents, description)
  VALUES ('payment_recorded', 'payment', v_pay_id, v_actor_role,
    jsonb_build_object('invoice_id', p_invoice_id, 'invoice_number', v_inv.invoice_number, 'amount_cents', p_amount_cents, 'method', p_payment_method, 'reference', p_reference_number),
    p_amount_cents,
    'Payment of $' || (p_amount_cents / 100.0)::numeric(12,2) || ' on ' || v_inv.invoice_number);

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM public.save_idempotency(p_idempotency_key, 'record_invoice_payment', jsonb_build_object('payment_id', v_pay_id));
  END IF;

  RETURN v_pay_id;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.record_invoice_payment(uuid, bigint, text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_invoice_payment(uuid, bigint, text, text, text, text) TO service_role;
