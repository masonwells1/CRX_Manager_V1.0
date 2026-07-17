-- Post-apply rollback-only proof for the gauntlet money-workflow corrections.
-- Uses one active admin and disposable AP, finance-charge, and prepay fixtures.
-- The terminal exception rolls back every row and sequence side effect.
DO $smoke$
DECLARE
  v_admin uuid;
  v_suffix text := substr(md5(random()::text), 1, 8);
  v_vendor uuid;
  v_bill uuid;
  v_customer uuid;
  v_source_invoice uuid;
  v_charge_invoice uuid;
  v_as_of date;
  v_future date;
  v_result jsonb;
  v_replay jsonb;
  v_before jsonb;
  v_after jsonb;
  v_splits jsonb;
  v_count bigint;
  v_balance bigint;
  v_preview_balance bigint;
  v_preview_charge bigint;
  v_err text;
  v_finance_key text := 'smk-finance-' || v_suffix;
  v_future_key text := 'smk-finance-future-' || v_suffix;
  v_prepay_bad_key text := 'smk-prepay-bad-' || v_suffix;
  v_prepay_key text := 'smk-prepay-' || v_suffix;
  v_reference text := 'SMK-PREPAY-' || v_suffix;
BEGIN
  SELECT id INTO v_admin
  FROM public.profiles
  WHERE role = 'admin' AND is_active = true
  ORDER BY created_at
  LIMIT 1;

  IF v_admin IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: active admin required';
  END IF;

  SELECT gs::date INTO v_as_of
  FROM generate_series(
    (now() AT TIME ZONE 'America/Chicago')::date,
    (now() AT TIME ZONE 'America/Chicago')::date - 365,
    interval '-1 day'
  ) AS gs
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.accounting_periods ap
    WHERE gs::date BETWEEN ap.period_start AND ap.period_end
      AND ap.status = 'closed'
  )
  ORDER BY gs DESC
  LIMIT 1;
  IF v_as_of IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: no open finance-charge date available';
  END IF;
  v_future := (now() AT TIME ZONE 'America/Chicago')::date + 1;

  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text,
    true
  );

  -- AP summary: only non-voided payments contribute to paid_this_month_cents.
  v_before := public.get_ap_dashboard_summary(NULL);

  INSERT INTO public.vendors (name)
  VALUES ('[SMOKE] AP Vendor ' || v_suffix)
  RETURNING id INTO v_vendor;

  INSERT INTO public.vendor_bills (
    vendor_id, bill_number, bill_date, due_date,
    subtotal_cents, adjustment_cents, total_cents, paid_cents,
    status, created_by
  ) VALUES (
    v_vendor, 'SMK-AP-' || v_suffix, CURRENT_DATE, CURRENT_DATE + 30,
    3000, 0, 3000, 0, 'unpaid', v_admin
  ) RETURNING id INTO v_bill;

  INSERT INTO public.vendor_payments (
    vendor_bill_id, payment_date, amount_cents, payment_method,
    reference_number, created_by
  ) VALUES (
    v_bill, CURRENT_DATE, 700, 'check', 'SMK-ACTIVE-' || v_suffix, v_admin
  );
  INSERT INTO public.vendor_payments (
    vendor_bill_id, payment_date, amount_cents, payment_method,
    reference_number, created_by, voided_at, voided_by, void_reason
  ) VALUES (
    v_bill, CURRENT_DATE, 1100, 'check', 'SMK-VOID-' || v_suffix, v_admin,
    now(), v_admin, 'rollback-only smoke'
  );

  v_after := public.get_ap_dashboard_summary(NULL);
  IF (v_after->>'paid_this_month_cents')::bigint
       <> (v_before->>'paid_this_month_cents')::bigint + 700 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: AP paid-this-month delta expected 700, before=% after=%',
      v_before, v_after;
  END IF;

  -- Finance charges: preview and generation must use the same eligible balance.
  INSERT INTO public.customers (
    farm_name, finance_charge_rate, finance_charge_enabled,
    finance_charge_grace_days, prepay_balance_cents
  ) VALUES (
    '[SMOKE] Money Farm ' || v_suffix, 12, true, 0, 0
  ) RETURNING id INTO v_customer;

  INSERT INTO public.invoices (
    invoice_number, customer_id, invoice_type, status,
    invoice_date, due_date, total_amount_cents, created_by
  ) VALUES (
    'SMK-FIN-SOURCE-' || v_suffix, v_customer, 'chemical_sale', 'draft',
    v_as_of - 40, v_as_of - 10, 100000, v_admin
  ) RETURNING id INTO v_source_invoice;
  UPDATE public.invoices
  SET status = 'posted', posted_by = v_admin, posted_at = now()
  WHERE id = v_source_invoice;

  BEGIN
    PERFORM * FROM public.preview_finance_charges(v_future);
    RAISE EXCEPTION 'SMOKE_FAIL: preview accepted a future date';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'FUTURE_FINANCE_CHARGE_DATE:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong future-preview error: %', v_err;
    END IF;
  END;

  BEGIN
    PERFORM public.generate_finance_charges(
      v_future, v_admin, ARRAY[v_customer], v_future_key
    );
    RAISE EXCEPTION 'SMOKE_FAIL: generation accepted a future date';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'FUTURE_FINANCE_CHARGE_DATE:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong future-generation error: %', v_err;
    END IF;
  END;
  SELECT count(*) INTO v_count
  FROM public.idempotency_keys
  WHERE idempotency_key = v_future_key
    AND operation = 'generate_finance_charges';
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: rejected future generation cached an idempotency result';
  END IF;

  SELECT overdue_balance_cents, charge_amount_cents
    INTO v_preview_balance, v_preview_charge
  FROM public.preview_finance_charges(v_as_of)
  WHERE customer_id = v_customer;
  IF v_preview_balance <> 100000 OR v_preview_charge <> 1000 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: preview balance/charge expected 100000/1000, got %/%',
      v_preview_balance, v_preview_charge;
  END IF;

  v_result := public.generate_finance_charges(
    v_as_of, v_admin, ARRAY[v_customer], v_finance_key
  );
  v_replay := public.generate_finance_charges(
    v_as_of, v_admin, ARRAY[v_customer], v_finance_key
  );
  IF (v_result->>'charges_generated')::integer <> 1
     OR v_replay IS DISTINCT FROM v_result THEN
    RAISE EXCEPTION 'SMOKE_FAIL: finance generation/replay mismatch first=% replay=%',
      v_result, v_replay;
  END IF;

  SELECT fc.invoice_id INTO v_charge_invoice
  FROM public.finance_charges fc
  WHERE fc.customer_id = v_customer AND fc.period_end = v_as_of;
  SELECT count(*) INTO v_count
  FROM public.finance_charges
  WHERE customer_id = v_customer AND period_end = v_as_of;
  IF v_count <> 1
     OR v_charge_invoice IS NULL
     OR (SELECT status FROM public.invoices WHERE id = v_charge_invoice) <> 'unposted'
     OR (SELECT invoice_type FROM public.invoices WHERE id = v_charge_invoice) <> 'misc_charge'
     OR (SELECT total_amount_cents FROM public.invoices WHERE id = v_charge_invoice) <> 1000
     OR (SELECT count(*) FROM public.invoice_items WHERE invoice_id = v_charge_invoice) <> 1
     OR (SELECT count(*) FROM public.financial_audit_log
         WHERE entity_id = v_charge_invoice AND operation_type = 'finance_charge') <> 1
     OR (SELECT count(*) FROM public.idempotency_keys
         WHERE idempotency_key = v_finance_key
           AND operation = 'generate_finance_charges') <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: generated finance-charge side effects incomplete invoice=% rows=%',
      v_charge_invoice, v_count;
  END IF;

  -- Prepay split: a mismatched independent total must be atomic.
  v_splits := jsonb_build_array(
    jsonb_build_object('label', 'Chemicals', 'amount_cents', 600),
    jsonb_build_object('label', 'Application', 'amount_cents', 400)
  );
  BEGIN
    PERFORM public.create_prepay_check_splits(
      v_customer, v_reference, v_splits, v_admin, v_prepay_bad_key, 999
    );
    RAISE EXCEPTION 'SMOKE_FAIL: mismatched prepay split total succeeded';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'PREPAY_SPLIT_TOTAL_MISMATCH:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong prepay mismatch error: %', v_err;
    END IF;
  END;
  SELECT prepay_balance_cents INTO v_balance
  FROM public.customers WHERE id = v_customer;
  SELECT count(*) INTO v_count
  FROM public.prepay_credits WHERE reference_number = v_reference;
  IF v_balance <> 0 OR v_count <> 0
     OR (SELECT count(*) FROM public.idempotency_keys
         WHERE idempotency_key = v_prepay_bad_key
           AND operation = 'create_prepay_check_splits') <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: rejected prepay split leaked balance=% rows=%',
      v_balance, v_count;
  END IF;

  v_result := public.create_prepay_check_splits(
    v_customer, v_reference, v_splits, v_admin, v_prepay_key, 1000
  );
  v_replay := public.create_prepay_check_splits(
    v_customer, v_reference, v_splits, v_admin, v_prepay_key, 1000
  );
  SELECT prepay_balance_cents INTO v_balance
  FROM public.customers WHERE id = v_customer;
  SELECT count(*) INTO v_count
  FROM public.prepay_credits WHERE reference_number = v_reference;
  IF (v_result->>'total_cents')::bigint <> 1000
     OR (v_result->>'split_count')::integer <> 2
     OR v_replay IS DISTINCT FROM v_result
     OR v_balance <> 1000
     OR v_count <> 2
     OR (SELECT COALESCE(sum(original_amount_cents), 0)
         FROM public.prepay_credits WHERE reference_number = v_reference) <> 1000
     OR (SELECT count(*) FROM public.financial_audit_log
         WHERE entity_id = v_customer
           AND operation_type = 'prepay_credit_created'
           AND total_impact_cents = 1000) <> 1
     OR (SELECT count(*) FROM public.idempotency_keys
         WHERE idempotency_key = v_prepay_key
           AND operation = 'create_prepay_check_splits') <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: prepay split/replay state first=% replay=% balance=% rows=%',
      v_result, v_replay, v_balance, v_count;
  END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END $smoke$;
