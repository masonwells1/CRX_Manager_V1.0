-- Rolled-back regression proof for bounded customer statement correctness.
-- Applies the candidate migration before this chain through run-smoke.mjs.

DO $smoke$
DECLARE
  v_admin uuid;
  v_customer uuid;
  v_order uuid;
  v_old_invoice uuid;
  v_same_a uuid;
  v_same_b uuid;
  v_suffix text := substr(md5(random()::text), 1, 8);
  v_start date := CURRENT_DATE - 30;
  v_same_day date := CURRENT_DATE - 5;
  v_refs text[];
  v_balances bigint[];
  v_types text[];
  v_expected_first_ref text;
  v_expected_first_balance bigint;
  v_rows int;
  v_final bigint;
  v_invalid_range_blocked boolean := false;
BEGIN
  SELECT id INTO v_admin
    FROM public.profiles
   WHERE role = 'admin' AND is_active = true
   ORDER BY created_at
   LIMIT 1;
  IF v_admin IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: no active admin profile';
  END IF;

  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text,
    true
  );

  INSERT INTO public.customers (farm_name)
  VALUES ('[SMOKE] Statement Opening ' || v_suffix)
  RETURNING id INTO v_customer;

  INSERT INTO public.orders (order_number, customer_id)
  VALUES ('SMK-STMT-OPEN-' || v_suffix, v_customer)
  RETURNING id INTO v_order;

  INSERT INTO public.invoices (
    invoice_number, customer_id, order_id, invoice_type,
    total_amount_cents, invoice_date, created_by
  ) VALUES (
    'SMK-STMT-OLD-' || v_suffix, v_customer, v_order, 'chemical_sale',
    10000, v_start - 10, v_admin
  ) RETURNING id INTO v_old_invoice;

  INSERT INTO public.invoices (
    invoice_number, customer_id, order_id, invoice_type,
    total_amount_cents, invoice_date, created_by
  ) VALUES (
    'SMK-STMT-A-' || v_suffix, v_customer, v_order, 'chemical_sale',
    3000, v_same_day, v_admin
  ) RETURNING id INTO v_same_a;

  INSERT INTO public.invoices (
    invoice_number, customer_id, order_id, invoice_type,
    total_amount_cents, invoice_date, created_by
  ) VALUES (
    'SMK-STMT-B-' || v_suffix, v_customer, v_order, 'chemical_sale',
    5000, v_same_day, v_admin
  ) RETURNING id INTO v_same_b;

  UPDATE public.invoices
     SET status = 'posted'
   WHERE id IN (v_old_invoice, v_same_a, v_same_b);

  SELECT array_agg(s.reference_number),
         array_agg(s.running_balance),
         array_agg(s.transaction_type),
         count(*),
         max(s.running_balance) FILTER (WHERE s.transaction_date = v_same_day)
    INTO v_refs, v_balances, v_types, v_rows, v_final
    FROM public.get_customer_statement(v_customer, v_start, CURRENT_DATE) s;

  IF v_rows <> 3 OR v_types[1] <> 'opening_balance'
     OR v_balances[1] <> 10000 OR v_final <> 18000 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: opening/final balance wrong: refs=%, types=%, balances=%',
      v_refs, v_types, v_balances;
  END IF;

  IF v_same_a::text < v_same_b::text THEN
    v_expected_first_ref := 'SMK-STMT-A-' || v_suffix;
    v_expected_first_balance := 13000;
  ELSE
    v_expected_first_ref := 'SMK-STMT-B-' || v_suffix;
    v_expected_first_balance := 15000;
  END IF;

  IF v_refs[2] <> v_expected_first_ref
     OR v_balances[2] <> v_expected_first_balance
     OR v_balances[3] <> 18000
     OR v_balances[2] = v_balances[3] THEN
    RAISE EXCEPTION 'SMOKE_FAIL: same-day order/running frame wrong: refs=%, balances=%',
      v_refs, v_balances;
  END IF;

  BEGIN
    PERFORM *
      FROM public.get_customer_statement(v_customer, CURRENT_DATE, v_start);
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '%INVALID_STATEMENT_DATE_RANGE%' THEN
      v_invalid_range_blocked := true;
    ELSE
      RAISE;
    END IF;
  END;
  IF NOT v_invalid_range_blocked THEN
    RAISE EXCEPTION 'SMOKE_FAIL: reversed statement date range was accepted';
  END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END
$smoke$;
