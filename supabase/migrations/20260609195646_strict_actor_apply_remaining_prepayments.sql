-- idempotency-body-check: exempt  (uses check_idempotency/save_idempotency helpers)
--
-- Fix Codex round-2 BLOCKER (incomplete actor-forgery sweep): apply_remaining_prepayments is an
-- authenticated-callable SECURITY DEFINER mutator with NO identity gate — it trusted p_performed_by
-- for the financial_audit_log actor and never bound to auth.uid(). Any authenticated user could
-- call it directly (PrepaymentManager UI is admin-only, App.tsx:229) to batch-apply a customer's
-- prepay balance across invoices and forge the audit actor.
--
-- Fix: canonical strict-actor block (auth.uid() -> AUTH_REQUIRED / ACTOR_MISMATCH on p_performed_by
-- / INSUFFICIENT_ROLE), role = admin (matches the UI), placed BEFORE the idempotency replay. The
-- financial_audit_log actor now uses v_actor (the authenticated caller), not the forgeable param.
-- Body otherwise verbatim from live. Reversible.

CREATE OR REPLACE FUNCTION public.apply_remaining_prepayments(p_customer_id uuid, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor         uuid;
  v_available     bigint;
  v_invoice       record;
  v_apply         bigint;
  v_applied_total bigint := 0;
  v_count         integer := 0;
  v_cached        jsonb;
  v_result        jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role = 'admin') THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_cached := check_idempotency(p_idempotency_key, 'apply_remaining_prepayments');
    IF v_cached IS NOT NULL THEN
      RETURN v_cached;
    END IF;
  END IF;

  SELECT COALESCE(c.prepay_balance_cents, 0)
    INTO v_available
    FROM customers c
   WHERE c.id = p_customer_id
   FOR UPDATE;

  IF v_available IS NULL OR v_available <= 0 THEN
    v_result := jsonb_build_object(
      'applied_count', 0,
      'applied_cents', 0,
      'remaining_prepay_cents', 0,
      'message', 'No prepay balance available'
    );
    IF p_idempotency_key IS NOT NULL THEN
      PERFORM save_idempotency(p_idempotency_key, 'apply_remaining_prepayments', v_result);
    END IF;
    RETURN v_result;
  END IF;

  FOR v_invoice IN
    SELECT id, invoice_number, invoice_date, balance_cents
      FROM invoices
     WHERE customer_id = p_customer_id
       AND status = 'posted'
       AND balance_cents > 0
       AND deleted_at IS NULL
     ORDER BY invoice_date ASC, created_at ASC
     FOR UPDATE
  LOOP
    EXIT WHEN v_available <= 0;

    PERFORM check_period_open(v_invoice.invoice_date);

    v_apply := LEAST(v_available, v_invoice.balance_cents);

    UPDATE invoices
       SET prepay_applied_cents = COALESCE(prepay_applied_cents, 0) + v_apply,
           updated_at = now()
     WHERE id = v_invoice.id;

    v_available     := v_available - v_apply;
    v_applied_total := v_applied_total + v_apply;
    v_count         := v_count + 1;
  END LOOP;

  UPDATE customers
     SET prepay_balance_cents = GREATEST(0, COALESCE(prepay_balance_cents, 0) - v_applied_total),
         updated_at = now()
   WHERE id = p_customer_id;

  IF v_applied_total > 0 THEN
    INSERT INTO financial_audit_log (
      operation_type, entity_type, entity_id,
      actor_user_id, total_impact_cents, description
    ) VALUES (
      'prepay_batch_applied', 'prepay', p_customer_id,
      v_actor, v_applied_total,
      'Batch applied $' || (v_applied_total / 100.0)::numeric(12,2) ||
      ' prepay across ' || v_count || ' invoice(s) for customer ' ||
      (SELECT farm_name FROM customers WHERE id = p_customer_id)
    );
  END IF;

  v_result := jsonb_build_object(
    'applied_count', v_count,
    'applied_cents', v_applied_total,
    'remaining_prepay_cents', v_available
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'apply_remaining_prepayments', v_result);
  END IF;

  RETURN v_result;
END;
$function$;