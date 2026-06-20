-- Overnight Bug Hunt — HIGH: prepay bulk-apply double-spend (no-ledger).
--
-- apply_remaining_prepayments + batch_apply_all_prepayments decrement
-- customers.prepay_balance_cents (and bump invoices.prepay_applied_cents) but
-- write NO prepay_applications / prepay_credits ledger rows. Because
-- prepay_credits.balance_cents is maintained ONLY by the AFTER INSERT/DELETE
-- trigger on prepay_applications, this bulk path never decrements per-credit
-- balances. reconcile_prepay_balances can then RE-CREATE the spent balance, and
-- apply_prepay_to_invoice (which gates on credit.balance_cents) can apply the
-- SAME dollars a second time => double-spend.
--
-- The correct fix routes bulk apply through the per-credit FIFO + FOR UPDATE
-- ledger (apply_prepay_to_invoice) — i.e. the prepay reserved-pool redesign that
-- was DELIBERATELY SHELVED (Mechanism A vs legacy aggregate Mechanism B collide).
-- Rather than reopen shelved territory, HARD-BLOCK both bulk RPCs until that
-- redesign lands. The per-invoice apply_prepay_to_invoice path is correct and
-- UNAFFECTED. Dormant on live (0 prepay rows) — latent but fully reachable via
-- the shipped PrepaymentManager buttons.
--
-- To UNBLOCK later: delete the RAISE EXCEPTION guard block at the top of each
-- function body (everything else here is the verbatim live definition).
--
-- Built on claude/overnight-bug-hunt. NOT applied live (Mason batch-approves).

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
  -- OVERNIGHT BUG HUNT GUARD (HIGH: prepay double-spend, no-ledger).
  -- Hard-block bulk prepay apply until the reserved-pool redesign lands.
  -- Remove this RAISE block to restore the (still-defective) behavior.
  RAISE EXCEPTION 'PREPAY_BULK_APPLY_DISABLED'
    USING DETAIL = 'Bulk prepay application is temporarily disabled pending the prepay reserved-pool redesign. Apply prepayments one invoice at a time (apply_prepay_to_invoice).',
          ERRCODE = 'P0001';

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

CREATE OR REPLACE FUNCTION public.batch_apply_all_prepayments(p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_cust       record;
  v_result     jsonb;
  v_details    jsonb := '[]'::jsonb;
  v_total_customers integer := 0;
  v_total_applied   bigint  := 0;
  v_actor      uuid;
  v_existing   jsonb;
  v_final      jsonb;
BEGIN
  -- OVERNIGHT BUG HUNT GUARD (HIGH: prepay double-spend, no-ledger).
  -- Hard-block bulk prepay apply until the reserved-pool redesign lands.
  -- Remove this RAISE block to restore the (still-defective) behavior.
  RAISE EXCEPTION 'PREPAY_BULK_APPLY_DISABLED'
    USING DETAIL = 'Bulk prepay application is temporarily disabled pending the prepay reserved-pool redesign. Apply prepayments one invoice at a time (apply_prepay_to_invoice).',
          ERRCODE = 'P0001';

  PERFORM require_admin_or_sales_rep();
  PERFORM check_rate_limit(auth.uid(), 'batch_apply_all_prepayments', 5, 60);
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'batch_apply_all_prepayments');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  FOR v_cust IN
    SELECT c.id, c.farm_name, c.prepay_balance_cents
    FROM customers c
    WHERE c.prepay_balance_cents > 0
      AND c.is_active = true
      AND EXISTS (
        SELECT 1 FROM invoices i
        WHERE i.customer_id = c.id
          AND i.status = 'posted'
          AND i.balance_cents > 0
          AND i.deleted_at IS NULL
      )
    ORDER BY c.farm_name
    FOR UPDATE OF c
  LOOP
    v_result := apply_remaining_prepayments(v_cust.id, v_actor);

    IF (v_result->>'applied_cents')::bigint > 0 THEN
      v_total_customers := v_total_customers + 1;
      v_total_applied := v_total_applied + (v_result->>'applied_cents')::bigint;
      v_details := v_details || jsonb_build_object(
        'customer_id', v_cust.id,
        'farm_name', v_cust.farm_name,
        'applied_count', (v_result->>'applied_count')::integer,
        'applied_cents', (v_result->>'applied_cents')::bigint,
        'remaining_prepay_cents', (v_result->>'remaining_prepay_cents')::bigint
      );
    END IF;
  END LOOP;

  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_role,
    old_values, new_values, total_impact_cents, description
  ) VALUES (
    'batch_prepay_apply', 'batch', v_actor,
    (SELECT role FROM profiles WHERE id = v_actor),
    jsonb_build_object('total_customers_checked', (
      SELECT count(*) FROM customers WHERE prepay_balance_cents > 0 AND is_active = true
    )),
    jsonb_build_object('total_customers_applied', v_total_customers, 'total_applied_cents', v_total_applied),
    v_total_applied,
    'Batch applied prepayments: ' || v_total_customers || ' customer(s), ' ||
      '$' || ROUND(v_total_applied / 100.0, 2) || ' total'
  );

  v_final := jsonb_build_object(
    'total_customers', v_total_customers,
    'total_applied_cents', v_total_applied,
    'details', v_details
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'batch_apply_all_prepayments', v_final);
  END IF;

  RETURN v_final;
END;
$function$;
