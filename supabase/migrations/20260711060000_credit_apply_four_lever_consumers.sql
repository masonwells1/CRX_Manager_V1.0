-- Credit-memo apply — Migration 5 of 5: the four-lever consumers
-- ==============================================================
-- Codex blocker #6 (the most immediate money failure): every RPC that recomputes an invoice's
-- "is it fully settled → paid" decision INLINE from only (total − paid − prepay − write_off)
-- ignores the new credit lever and desyncs — a zero-balance invoice would stay posted and get
-- dunned. All such consumers must gain the credit lever in the SAME set as the column.
--
-- The live audit found SIX (Codex's review listed four; a full pg_proc body scan on 2026-07-10
-- additionally caught record_invoice_payment and void_payment — both do inline →paid math):
--   allocate_payment · apply_prepay_to_invoice · apply_write_off · record_invoice_payment ·
--   void_payment · (plus) mark_overdue_invoices — which must EXCLUDE credit memos and
--   balance_cents <= 0 so a credit memo (status 'posted') or a settled invoice is never dunned.
--
-- Each body below is the exact live source (verified 2026-07-10) with ONLY the credit lever
-- inserted, marked  -- CREDIT-APPLY. Targets are always non-credit invoices, so for them the
-- type-aware balance reduces to (… − credit_applied_cents).

-- =====================================================================================
-- allocate_payment
-- =====================================================================================
CREATE OR REPLACE FUNCTION public.allocate_payment(p_customer_id uuid, p_total_cents bigint, p_payment_method text, p_reference_number text DEFAULT NULL::text, p_check_number text DEFAULT NULL::text, p_payment_date date DEFAULT CURRENT_DATE, p_notes text DEFAULT NULL::text, p_allocations jsonb DEFAULT '[]'::jsonb, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid;
  v_cached_result jsonb;
  v_alloc jsonb;
  v_inv record;
  v_alloc_cents bigint;
  v_sum_allocated bigint := 0;
  v_set_id uuid;
  v_current_season integer;
  v_prepay_cents bigint;
  v_result jsonb;
  v_allocation_count integer := 0;
  v_next_version integer;
  v_customer_name text;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'p_performed_by does not match authenticated user';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_cached_result := check_idempotency(p_idempotency_key, 'allocate_payment');
    IF v_cached_result IS NOT NULL THEN RETURN v_cached_result; END IF;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'Not authorized to allocate payments';
  END IF;

  IF p_total_cents <= 0 THEN RAISE EXCEPTION 'Payment amount must be positive'; END IF;

  PERFORM check_period_open(p_payment_date);

  SELECT farm_name INTO v_customer_name FROM customers WHERE id = p_customer_id;

  v_current_season := CASE WHEN extract(month FROM CURRENT_DATE) >= 10
    THEN extract(year FROM CURRENT_DATE)::integer + 1
    ELSE extract(year FROM CURRENT_DATE)::integer END;

  SELECT COALESCE(MAX(version), 0) + 1 INTO v_next_version
  FROM allocation_sets WHERE entity_type = 'payment' AND entity_id = p_customer_id;

  INSERT INTO allocation_sets (
    entity_type, entity_id, version,
    customer_id, total_payment_cents, payment_method,
    reference_number, check_number, payment_date,
    notes, season, created_by
  ) VALUES (
    'payment', p_customer_id, v_next_version,
    p_customer_id, p_total_cents, p_payment_method,
    p_reference_number, p_check_number, p_payment_date,
    p_notes, v_current_season, v_actor
  ) RETURNING id INTO v_set_id;

  FOR v_alloc IN SELECT * FROM jsonb_array_elements(p_allocations)
  LOOP
    v_alloc_cents := (v_alloc->>'amount_cents')::bigint;
    IF v_alloc_cents <= 0 THEN CONTINUE; END IF;

    SELECT * INTO v_inv FROM invoices
    WHERE id = (v_alloc->>'invoice_id')::uuid
      AND customer_id = p_customer_id
      AND status IN ('posted', 'overdue')
      AND deleted_at IS NULL
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Invoice % not found or not eligible for payment', (v_alloc->>'invoice_id');
    END IF;

    IF v_alloc_cents > v_inv.balance_cents THEN
      RAISE EXCEPTION 'Allocation ($%) exceeds balance ($%) on invoice %',
        v_alloc_cents, v_inv.balance_cents, v_inv.invoice_number;
    END IF;

    INSERT INTO invoice_line_allocations (
      allocation_set_id, invoice_id, amount_cents,
      bill_to_customer_id, split_percentage
    ) VALUES (
      v_set_id, v_inv.id, v_alloc_cents, p_customer_id, 100
    );

    UPDATE invoices SET
      paid_amount_cents = paid_amount_cents + v_alloc_cents,
      status = CASE
        -- CREDIT-APPLY: include credit_applied_cents in the →paid recompute
        WHEN (total_amount_cents - (paid_amount_cents + v_alloc_cents) - prepay_applied_cents - write_off_cents - credit_applied_cents) <= 0
        THEN 'paid'
        ELSE status
      END,
      updated_at = now()
    WHERE id = v_inv.id;

    v_sum_allocated := v_sum_allocated + v_alloc_cents;
    v_allocation_count := v_allocation_count + 1;
  END LOOP;

  IF v_sum_allocated > p_total_cents THEN
    RAISE EXCEPTION 'OVER_ALLOCATED: allocations total $% but payment is only $%',
      (v_sum_allocated / 100.0)::numeric(12,2), (p_total_cents / 100.0)::numeric(12,2);
  END IF;

  UPDATE allocation_sets SET
    total_allocated_cents = v_sum_allocated,
    updated_at = now()
  WHERE id = v_set_id;

  v_prepay_cents := p_total_cents - v_sum_allocated;
  IF v_prepay_cents > 0 THEN
    INSERT INTO prepay_credits (
      customer_id, season, original_amount_cents, balance_cents,
      source_type, source_reference, created_by
    ) VALUES (
      p_customer_id, v_current_season, v_prepay_cents, v_prepay_cents,
      'overpayment', 'From payment ' || COALESCE(p_reference_number, p_check_number, v_set_id::text),
      v_actor
    );
    UPDATE customers SET
      prepay_balance_cents = COALESCE(prepay_balance_cents, 0) + v_prepay_cents,
      updated_at = now()
    WHERE id = p_customer_id;
  END IF;

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'payment_allocated',
    'Payment of $' || (p_total_cents / 100.0)::text || ' allocated (' || v_allocation_count || ' invoices)',
    v_actor, 'allocation_set', v_set_id, p_customer_id
  );

  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_role,
    new_values, total_impact_cents, description
  ) VALUES (
    'payment_allocated', 'allocation_set', v_set_id,
    (SELECT role FROM profiles WHERE id = v_actor),
    jsonb_build_object(
      'customer_id', p_customer_id,
      'customer_name', v_customer_name,
      'payment_method', p_payment_method,
      'reference_number', p_reference_number,
      'total_cents', p_total_cents,
      'allocated_cents', v_sum_allocated,
      'prepay_cents', v_prepay_cents,
      'invoices_paid', v_allocation_count
    ),
    p_total_cents,
    'Payment $' || (p_total_cents / 100.0)::numeric(12,2) || ' from ' ||
    COALESCE(v_customer_name, 'customer') || ' via ' || p_payment_method ||
    CASE WHEN v_prepay_cents > 0 THEN ' ($' || (v_prepay_cents / 100.0)::numeric(12,2) || ' to prepay)' ELSE '' END
  );

  v_result := jsonb_build_object(
    'success', true,
    'allocation_set_id', v_set_id,
    'total_allocated_cents', v_sum_allocated,
    'prepay_created_cents', v_prepay_cents,
    'invoices_paid', v_allocation_count
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'allocate_payment', v_result);
  END IF;

  RETURN v_result;
END;
$function$;

-- =====================================================================================
-- apply_prepay_to_invoice
-- =====================================================================================
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
  IF v_actor_role NOT IN ('admin', 'sales_rep') THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE: only admins and sales reps can apply prepayments';
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

-- =====================================================================================
-- apply_write_off  (selects credit_applied_cents + subtracts it from v_new_balance)
-- =====================================================================================
CREATE OR REPLACE FUNCTION public.apply_write_off(p_invoice_id uuid, p_amount_cents bigint, p_reason text, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid;
  v_invoice record;
  v_wo_id uuid;
  v_cached_result jsonb;
  v_new_write_off bigint;
  v_new_balance bigint;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT is_admin() THEN RAISE EXCEPTION 'INSUFFICIENT_ROLE'; END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_cached_result := public.check_idempotency(p_idempotency_key, 'apply_write_off');
    IF v_cached_result IS NOT NULL THEN
      RETURN (v_cached_result->>'id')::uuid;
    END IF;
  END IF;

  SELECT id, customer_id, balance_cents, status, write_off_cents,
         invoice_number, invoice_date, total_amount_cents,
         paid_amount_cents, prepay_applied_cents,
         credit_applied_cents  -- CREDIT-APPLY: needed for the settled recompute
    INTO v_invoice
    FROM public.invoices
   WHERE id = p_invoice_id
   FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'INVOICE_NOT_FOUND'; END IF;
  IF v_invoice.status NOT IN ('posted', 'overdue') THEN
    RAISE EXCEPTION 'INVALID_INVOICE_STATUS: %', v_invoice.status;
  END IF;
  PERFORM public.check_period_open(CURRENT_DATE);
  IF p_amount_cents <= 0 THEN RAISE EXCEPTION 'INVALID_AMOUNT'; END IF;
  IF p_amount_cents > v_invoice.balance_cents THEN RAISE EXCEPTION 'AMOUNT_EXCEEDS_BALANCE'; END IF;

  INSERT INTO public.write_offs (invoice_id, customer_id, amount_cents, reason, approved_by, created_by)
  VALUES (p_invoice_id, v_invoice.customer_id, p_amount_cents, p_reason, v_actor, v_actor)
  RETURNING id INTO v_wo_id;

  v_new_write_off := COALESCE(v_invoice.write_off_cents, 0) + p_amount_cents;
  v_new_balance := v_invoice.total_amount_cents
                 - v_invoice.paid_amount_cents
                 - v_invoice.prepay_applied_cents
                 - v_new_write_off
                 - v_invoice.credit_applied_cents;  -- CREDIT-APPLY

  UPDATE public.invoices
     SET write_off_cents = v_new_write_off,
         status = CASE WHEN v_new_balance <= 0 THEN 'paid' ELSE status END,
         updated_at = now()
   WHERE id = p_invoice_id;

  INSERT INTO public.financial_audit_log (
    operation_type,
    entity_type,
    entity_id,
    actor_user_id, total_impact_cents, description
  ) VALUES (
    'write_off_applied', 'write_off', v_wo_id,
    v_actor, -p_amount_cents,
    'Write-off of $' || (p_amount_cents / 100.0)::numeric(12,2) ||
    ' on invoice ' || v_invoice.invoice_number || ': ' || p_reason ||
    CASE WHEN v_new_balance <= 0 THEN ' (fully settled - status set to paid)' ELSE '' END
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM public.save_idempotency(
      p_idempotency_key,
      'apply_write_off',
      jsonb_build_object('id', v_wo_id)
    );
  END IF;

  RETURN v_wo_id;
END;
$function$;

-- =====================================================================================
-- record_invoice_payment
-- =====================================================================================
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
  SELECT role INTO v_actor_role FROM profiles WHERE id = auth.uid();
  IF v_actor_role NOT IN ('admin', 'sales_rep') THEN
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

-- =====================================================================================
-- void_payment  (reversal path: include credit_applied_cents in the paid/posted recompute)
-- =====================================================================================
CREATE OR REPLACE FUNCTION public.void_payment(p_allocation_set_id uuid, p_reason text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_set              record;
  v_alloc            record;
  v_actor            uuid;
  v_reversed_cents   bigint := 0;
  v_invoice_count    int    := 0;
  v_prepay_reversed  bigint := 0;
  v_old_balance      bigint;
  v_credit           record;
  v_existing         jsonb;
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
    SELECT result INTO v_existing
      FROM idempotency_keys
      WHERE idempotency_key = p_idempotency_key AND operation = 'void_payment';
    IF v_existing IS NOT NULL THEN
      RETURN jsonb_build_object('success', true, 'allocation_set_id', p_allocation_set_id, 'idempotent', true);
    END IF;
  END IF;

  SELECT * INTO v_set FROM allocation_sets WHERE id = p_allocation_set_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Allocation set not found: %', p_allocation_set_id; END IF;
  IF NOT v_set.is_active THEN RAISE EXCEPTION 'Payment already voided'; END IF;

  PERFORM check_period_open(COALESCE(v_set.payment_date, CURRENT_DATE));

  FOR v_alloc IN
    SELECT ila.invoice_id, SUM(ila.amount_cents) AS total_amount
    FROM invoice_line_allocations ila
    WHERE ila.allocation_set_id = p_allocation_set_id AND ila.invoice_id IS NOT NULL
    GROUP BY ila.invoice_id
  LOOP
    UPDATE invoices
    SET paid_amount_cents = GREATEST(paid_amount_cents - v_alloc.total_amount, 0),
        status = CASE
          WHEN status IN ('paid', 'posted') THEN
            -- CREDIT-APPLY: include credit_applied_cents in the settled recompute
            CASE WHEN (total_amount_cents - (GREATEST(paid_amount_cents - v_alloc.total_amount, 0) + prepay_applied_cents + write_off_cents + credit_applied_cents)) <= 0
                 THEN 'paid' ELSE 'posted' END
          ELSE status
        END,
        updated_at = now()
    WHERE id = v_alloc.invoice_id;
    v_reversed_cents := v_reversed_cents + v_alloc.total_amount;
    v_invoice_count  := v_invoice_count + 1;
  END LOOP;

  FOR v_credit IN
    SELECT id, balance_cents
    FROM prepay_credits
    WHERE source_type = 'overpayment'
      AND customer_id = v_set.customer_id
      AND balance_cents > 0
      AND (
        (source_reference = 'From payment ' || COALESCE(v_set.reference_number, v_set.check_number, v_set.id::text)
         AND (v_set.season IS NULL OR season = v_set.season))
        OR source_reference = p_allocation_set_id::text
      )
    FOR UPDATE
  LOOP
    UPDATE prepay_credits
    SET balance_cents = 0, notes = COALESCE(notes, '') || ' [VOIDED: ' || p_reason || ']', updated_at = now()
    WHERE id = v_credit.id;
    v_prepay_reversed := v_prepay_reversed + v_credit.balance_cents;
  END LOOP;

  IF v_prepay_reversed > 0 THEN
    UPDATE customers SET prepay_balance_cents = GREATEST(prepay_balance_cents - v_prepay_reversed, 0) WHERE id = v_set.customer_id;
  END IF;

  UPDATE allocation_sets SET is_active = false, notes = COALESCE(notes, '') || ' [VOIDED: ' || p_reason || ']', updated_at = now() WHERE id = p_allocation_set_id;

  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_user_id, old_values, new_values, total_impact_cents, description
  ) VALUES (
    'payment_voided', 'allocation_set', p_allocation_set_id, v_actor,
    jsonb_build_object('total_payment_cents', v_set.total_payment_cents, 'total_allocated_cents', v_set.total_allocated_cents, 'payment_method', v_set.payment_method, 'check_number', v_set.check_number, 'customer_id', v_set.customer_id),
    jsonb_build_object('reason', p_reason, 'invoices_reversed', v_invoice_count, 'prepay_reversed_cents', v_prepay_reversed),
    -1 * v_reversed_cents,
    'Voided payment ' || COALESCE(v_set.check_number, v_set.reference_number, v_set.id::text) || ' — ' || p_reason
  );

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'void_payment', to_jsonb(p_allocation_set_id));
  END IF;

  RETURN jsonb_build_object('success', true, 'allocation_set_id', p_allocation_set_id, 'reversed_cents', v_reversed_cents, 'invoices_affected', v_invoice_count, 'prepay_reversed_cents', v_prepay_reversed);
END;
$function$;

-- =====================================================================================
-- mark_overdue_invoices  (exclude credit memos and settled/zero-balance invoices)
-- =====================================================================================
CREATE OR REPLACE FUNCTION public.mark_overdue_invoices()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_invoice record; v_count integer := 0;
BEGIN
  -- CREDIT-APPLY: never dun a credit memo (it is 'posted' with a negative balance) or an
  -- invoice already settled to <= 0 by any lever (payments, prepay, write-off, applied credit).
  FOR v_invoice IN SELECT id, invoice_number, customer_id, due_date FROM invoices
    WHERE status = 'posted' AND due_date < CURRENT_DATE AND deleted_at IS NULL
      AND invoice_type <> 'credit_memo' AND balance_cents > 0 FOR UPDATE
  LOOP
    UPDATE invoices SET status = 'overdue', updated_at = now() WHERE id = v_invoice.id;
    INSERT INTO financial_audit_log (operation_type, entity_type, entity_id, actor_user_id, actor_role, new_values, description)
    VALUES ('invoice_marked_overdue', 'invoice', v_invoice.id, '22c1fc50-4d2a-4baa-8ff8-341c0c7edd4f', 'system',
      jsonb_build_object('invoice_number', v_invoice.invoice_number, 'customer_id', v_invoice.customer_id, 'due_date', v_invoice.due_date, 'marked_at', now()),
      'Invoice ' || v_invoice.invoice_number || ' auto-marked overdue (due ' || v_invoice.due_date || ')');
    v_count := v_count + 1;
  END LOOP;
  RETURN jsonb_build_object('invoices_marked_overdue', v_count, 'run_at', now());
END;
$function$;
