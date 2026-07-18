-- Post-apply rollback-only regression proof for the payment/void lifecycle
-- correction prepared after PR #168 review.
--
-- The chain proves:
--   1. an active payment allocation blocks invoice voiding even when the invoice
--      header's paid amount is zero;
--   2. void_payment deactivates the set and preserves its allocation history;
--   3. the invoice can then be voided without deleting that inactive history;
--   4. transaction review drops both the voided invoice and reversed payment;
--   5. record_invoice_payment is a non-mutating retired tombstone with no grants;
--   6. a prepay-only invoice still voids and restores both prepay balances while
--      removing the application.
--
-- FAIL-FIRST CONTRACT: before the forward correction, the inactive historical
-- allocation still blocks the second void and record_invoice_payment still
-- mutates money. After the correction every assertion reaches the terminal
-- SMOKE_PASS_ROLLBACK exception. One DO block means no fixture can commit.
DO $smoke$
DECLARE
  v_admin             uuid;
  v_suffix            text := substr(md5(random()::text), 1, 8);
  v_customer          uuid;
  v_inv_alloc         uuid;
  v_inv_legacy        uuid;
  v_inv_prepay        uuid;
  v_allocation_set    uuid;
  v_prepay_id         uuid;
  v_prepay_app_id     uuid;
  v_status            text;
  v_err               text;
  v_result            jsonb;
  v_paid_cents        bigint;
  v_prepay_cents      bigint;
  v_credit_before     bigint;
  v_customer_before   bigint;
  v_credit_after      bigint;
  v_customer_after    bigint;
  v_count             bigint;
  v_payments_before   bigint;
  v_report_rows       bigint;
  v_report_debit      bigint;
  v_report_credit     bigint;
  v_is_active         boolean;
BEGIN
  SELECT id INTO v_admin
  FROM public.profiles
  WHERE role = 'admin' AND is_active = true
  ORDER BY created_at
  LIMIT 1;
  IF v_admin IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: active admin required';
  END IF;

  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text,
    true
  );

  INSERT INTO public.customers (farm_name, prepay_balance_cents)
  VALUES ('[E2E] PR168 Payment Void Farm ' || v_suffix, 0)
  RETURNING id INTO v_customer;

  -- ====================================================================
  -- Scenario 1: allocation-only guard -> payment void -> invoice void.
  -- paid_amount_cents deliberately stays zero to exercise the allocation
  -- branch independently of the invoice-header branch.
  -- ====================================================================
  INSERT INTO public.invoices (
    invoice_number, customer_id, invoice_type, status,
    invoice_date, due_date, total_amount_cents, created_by
  ) VALUES (
    'E2E-PR168-ALLOC-' || v_suffix, v_customer, 'chemical_sale', 'draft',
    CURRENT_DATE, CURRENT_DATE + 30, 60000, v_admin
  ) RETURNING id INTO v_inv_alloc;

  UPDATE public.invoices
  SET status = 'posted', posted_by = v_admin, posted_at = now()
  WHERE id = v_inv_alloc;

  INSERT INTO public.allocation_sets (
    entity_type, entity_id, version, is_active, customer_id,
    total_payment_cents, total_allocated_cents, payment_date,
    payment_method, created_by
  ) VALUES (
    'payment', gen_random_uuid(), 1, true, v_customer,
    30000, 30000, CURRENT_DATE, 'check', v_admin
  ) RETURNING id INTO v_allocation_set;

  INSERT INTO public.invoice_line_allocations (
    allocation_set_id, bill_to_customer_id, split_percentage,
    amount_cents, invoice_id
  ) VALUES (
    v_allocation_set, v_customer, 100, 30000, v_inv_alloc
  );

  SELECT paid_amount_cents INTO v_paid_cents
  FROM public.invoices WHERE id = v_inv_alloc;
  IF v_paid_cents IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'SMOKE_SETUP: allocation-only invoice paid header = %, expected 0', v_paid_cents;
  END IF;

  SELECT count(*), COALESCE(sum(debit_cents), 0), COALESCE(sum(credit_cents), 0)
    INTO v_report_rows, v_report_debit, v_report_credit
  FROM public.get_customer_transaction_review(v_customer, CURRENT_DATE, CURRENT_DATE);
  IF v_report_rows <> 2 OR v_report_debit <> 60000 OR v_report_credit <> 30000 THEN
    RAISE EXCEPTION 'SMOKE_SETUP: active transaction review wrong (rows=%, debit=%, credit=%; expected 2/60000/30000)',
      v_report_rows, v_report_debit, v_report_credit;
  END IF;

  BEGIN
    PERFORM public.void_invoice(
      v_inv_alloc,
      'PR168 smoke: active allocation must block',
      'e2e-pr168-active-block-' || v_suffix
    );
    RAISE EXCEPTION 'SMOKE_FAIL: active payment allocation did not block invoice void';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'INVOICE_HAS_APPLIED_PAYMENTS:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: active allocation produced wrong void error: %', v_err;
    END IF;
  END;

  SELECT status INTO v_status FROM public.invoices WHERE id = v_inv_alloc;
  SELECT count(*) INTO v_count
  FROM public.invoice_line_allocations
  WHERE allocation_set_id = v_allocation_set AND invoice_id = v_inv_alloc;
  IF v_status IS DISTINCT FROM 'posted' OR v_count <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: blocked void changed invoice/history (status=%, rows=%)', v_status, v_count;
  END IF;

  SELECT public.void_payment(
    v_allocation_set,
    'PR168 smoke: reverse active payment',
    v_admin,
    'e2e-pr168-void-payment-' || v_suffix
  ) INTO v_result;

  IF COALESCE((v_result->>'success')::boolean, false) IS NOT TRUE
     OR COALESCE((v_result->>'reversed_cents')::bigint, -1) <> 30000 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: void_payment returned %, expected successful 30000 reversal', v_result;
  END IF;

  SELECT paid_amount_cents, status INTO v_paid_cents, v_status
  FROM public.invoices WHERE id = v_inv_alloc;
  SELECT is_active INTO v_is_active
  FROM public.allocation_sets WHERE id = v_allocation_set;
  SELECT count(*) INTO v_count
  FROM public.invoice_line_allocations
  WHERE allocation_set_id = v_allocation_set AND invoice_id = v_inv_alloc;

  IF v_paid_cents IS DISTINCT FROM 0
     OR v_status IS DISTINCT FROM 'posted'
     OR v_is_active IS DISTINCT FROM false
     OR v_count <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: payment void state wrong (paid=%, status=%, active=%, history_rows=%)',
      v_paid_cents, v_status, v_is_active, v_count;
  END IF;

  PERFORM public.void_invoice(
    v_inv_alloc,
    'PR168 smoke: inactive payment history must not block',
    'e2e-pr168-post-payment-void-' || v_suffix
  );

  SELECT status INTO v_status FROM public.invoices WHERE id = v_inv_alloc;
  SELECT count(*) INTO v_count
  FROM public.invoice_line_allocations
  WHERE allocation_set_id = v_allocation_set AND invoice_id = v_inv_alloc;
  IF v_status IS DISTINCT FROM 'voided' OR v_count <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: invoice void after payment reversal lost history (status=%, rows=%)',
      v_status, v_count;
  END IF;

  SELECT count(*), COALESCE(sum(debit_cents), 0), COALESCE(sum(credit_cents), 0)
    INTO v_report_rows, v_report_debit, v_report_credit
  FROM public.get_customer_transaction_review(v_customer, CURRENT_DATE, CURRENT_DATE);
  IF v_report_rows <> 0 OR v_report_debit <> 0 OR v_report_credit <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: reversed payment history leaked into transaction review (rows=%, debit=%, credit=%; expected 0/0/0)',
      v_report_rows, v_report_debit, v_report_credit;
  END IF;

  -- ====================================================================
  -- Scenario 2: legacy direct-payment RPC is retired and non-mutating.
  -- ====================================================================
  INSERT INTO public.invoices (
    invoice_number, customer_id, invoice_type, status,
    invoice_date, due_date, total_amount_cents, created_by
  ) VALUES (
    'E2E-PR168-LEGACY-' || v_suffix, v_customer, 'chemical_sale', 'draft',
    CURRENT_DATE, CURRENT_DATE + 30, 20000, v_admin
  ) RETURNING id INTO v_inv_legacy;

  UPDATE public.invoices
  SET status = 'posted', posted_by = v_admin, posted_at = now()
  WHERE id = v_inv_legacy;

  SELECT count(*) INTO v_payments_before FROM public.payments;
  IF v_payments_before <> 0 THEN
    RAISE EXCEPTION 'SMOKE_SETUP: retired payments table is not empty (rows=%)', v_payments_before;
  END IF;

  BEGIN
    PERFORM public.record_invoice_payment(
      v_inv_legacy, 10000, 'check', 'E2E-PR168-' || v_suffix,
      'retirement smoke', 'e2e-pr168-legacy-pay-' || v_suffix
    );
    RAISE EXCEPTION 'SMOKE_FAIL: retired record_invoice_payment still mutates';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'RECORD_INVOICE_PAYMENT_RETIRED:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: retired payment RPC produced wrong error: %', v_err;
    END IF;
  END;

  SELECT paid_amount_cents, status INTO v_paid_cents, v_status
  FROM public.invoices WHERE id = v_inv_legacy;
  SELECT count(*) INTO v_count FROM public.payments;
  IF v_paid_cents IS DISTINCT FROM 0
     OR v_status IS DISTINCT FROM 'posted'
     OR v_count <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: retired payment RPC changed state (paid=%, status=%, payments_before=%, payments_after=%)',
      v_paid_cents, v_status, v_payments_before, v_count;
  END IF;

  -- anon inherits PUBLIC, so this also detects any implicit/default PUBLIC grant.
  IF has_function_privilege('anon', 'public.record_invoice_payment(uuid, bigint, text, text, text, text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.record_invoice_payment(uuid, bigint, text, text, text, text)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.record_invoice_payment(uuid, bigint, text, text, text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: retired payment RPC still has an execution grant';
  END IF;

  -- ====================================================================
  -- Scenario 3: prepay-only void still restores exact balances.
  -- ====================================================================
  INSERT INTO public.invoices (
    invoice_number, customer_id, invoice_type, status,
    invoice_date, due_date, total_amount_cents, created_by
  ) VALUES (
    'E2E-PR168-PREPAY-' || v_suffix, v_customer, 'chemical_sale', 'draft',
    CURRENT_DATE, CURRENT_DATE + 30, 40000, v_admin
  ) RETURNING id INTO v_inv_prepay;

  UPDATE public.invoices
  SET status = 'posted', posted_by = v_admin, posted_at = now()
  WHERE id = v_inv_prepay;

  PERFORM public.create_prepay_check_splits(
    v_customer,
    'E2E-PR168-PP-' || v_suffix,
    jsonb_build_array(jsonb_build_object('label', 'Chemicals', 'amount_cents', 40000)),
    v_admin,
    'e2e-pr168-create-prepay-' || v_suffix,
    40000
  );

  SELECT id, balance_cents INTO v_prepay_id, v_credit_before
  FROM public.prepay_credits
  WHERE customer_id = v_customer AND balance_cents > 0
  ORDER BY created_at DESC
  LIMIT 1;
  SELECT prepay_balance_cents INTO v_customer_before
  FROM public.customers WHERE id = v_customer;

  IF v_prepay_id IS NULL
     OR v_credit_before IS DISTINCT FROM 40000
     OR v_customer_before IS DISTINCT FROM 40000 THEN
    RAISE EXCEPTION 'SMOKE_SETUP: prepay balances before apply wrong (credit_id=%, credit=%, customer=%)',
      v_prepay_id, v_credit_before, v_customer_before;
  END IF;

  SELECT public.apply_prepay_to_invoice(
    v_prepay_id,
    v_inv_prepay,
    40000,
    v_admin,
    'e2e-pr168-apply-prepay-' || v_suffix
  ) INTO v_prepay_app_id;

  SELECT balance_cents INTO v_credit_after
  FROM public.prepay_credits WHERE id = v_prepay_id;
  SELECT prepay_balance_cents INTO v_customer_after
  FROM public.customers WHERE id = v_customer;
  SELECT count(*) INTO v_count
  FROM public.prepay_applications
  WHERE id = v_prepay_app_id AND invoice_id = v_inv_prepay;

  IF v_credit_after IS DISTINCT FROM 0
     OR v_customer_after IS DISTINCT FROM 0
     OR v_count <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: prepay apply state wrong (credit=%, customer=%, applications=%)',
      v_credit_after, v_customer_after, v_count;
  END IF;

  PERFORM public.void_invoice(
    v_inv_prepay,
    'PR168 smoke: prepay-only void',
    'e2e-pr168-void-prepay-' || v_suffix
  );

  SELECT status, prepay_applied_cents INTO v_status, v_prepay_cents
  FROM public.invoices WHERE id = v_inv_prepay;
  SELECT balance_cents INTO v_credit_after
  FROM public.prepay_credits WHERE id = v_prepay_id;
  SELECT prepay_balance_cents INTO v_customer_after
  FROM public.customers WHERE id = v_customer;
  SELECT count(*) INTO v_count
  FROM public.prepay_applications
  WHERE id = v_prepay_app_id OR invoice_id = v_inv_prepay;

  IF v_status IS DISTINCT FROM 'voided'
     OR v_prepay_cents IS DISTINCT FROM 0
     OR v_credit_after IS DISTINCT FROM v_credit_before
     OR v_customer_after IS DISTINCT FROM v_customer_before
     OR v_count <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: prepay void did not restore exact state (status=%, invoice_prepay=%, credit=%/% customer=%/% applications=%)',
      v_status, v_prepay_cents, v_credit_after, v_credit_before,
      v_customer_after, v_customer_before, v_count;
  END IF;

  -- Historical payment allocation must still exist after all later work.
  SELECT count(*) INTO v_count
  FROM public.invoice_line_allocations
  WHERE allocation_set_id = v_allocation_set AND invoice_id = v_inv_alloc;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: inactive payment allocation history disappeared late in chain';
  END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END
$smoke$;
