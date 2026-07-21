-- Post-apply rollback-only regression proof for H3 (Live Foundation Gauntlet
-- 2026-07-18): void_invoice must REFUSE to void a posted invoice that still has
-- direct cash applied (it would strand that cash), but must STILL void a
-- prepay-only invoice (which it re-banks correctly).
--
-- FAIL-FIRST CONTRACT: against the PRE-FIX function, voiding a partially-paid
-- posted invoice SUCCEEDS (silently stranding the payment) -> this chain raises
-- SMOKE_FAIL. Against the FIXED function that void raises
-- INVOICE_HAS_APPLIED_PAYMENTS, and the prepay-only void still succeeds, so the
-- chain reaches SMOKE_PASS_ROLLBACK.
--
-- One DO block, terminal exception -> nothing commits.
DO $smoke$
DECLARE
  v_admin     uuid;
  v_suffix    text := substr(md5(random()::text), 1, 8);
  v_customer  uuid;
  v_inv_paid  uuid;
  v_inv_prepay uuid;
  v_prepay_id uuid;
  v_status    text;
  v_err       text;
  v_pay_result jsonb;
  v_set_id     uuid;
  v_history_count integer;
  v_history_total bigint;
BEGIN
  SELECT id INTO v_admin FROM public.profiles
  WHERE role = 'admin' AND is_active = true ORDER BY created_at LIMIT 1;
  IF v_admin IS NULL THEN RAISE EXCEPTION 'SMOKE_SETUP: active admin required'; END IF;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);

  -- [E2E] marker satisfies the live-testdata guard; terminal rollback removes it.
  INSERT INTO public.customers (farm_name, prepay_balance_cents)
  VALUES ('[E2E] H3 Farm ' || v_suffix, 0) RETURNING id INTO v_customer;

  -- ===== Scenario 1: posted invoice with a direct payment must NOT void =====
  INSERT INTO public.invoices (
    invoice_number, customer_id, invoice_type, status,
    invoice_date, due_date, total_amount_cents, created_by
  ) VALUES (
    'E2E-H3-PAID-' || v_suffix, v_customer, 'chemical_sale', 'draft',
    CURRENT_DATE, CURRENT_DATE + 30, 100000, v_admin
  ) RETURNING id INTO v_inv_paid;
  UPDATE public.invoices SET status = 'posted', posted_by = v_admin, posted_at = now()
  WHERE id = v_inv_paid;

  v_pay_result := public.allocate_payment(
    v_customer, 50000, 'check', 'E2E-H3-' || v_suffix, NULL, CURRENT_DATE,
    'H3 reversible allocation smoke',
    jsonb_build_array(jsonb_build_object('invoice_id', v_inv_paid, 'amount_cents', 50000)),
    v_admin, 'e2e-h3-pay-' || v_suffix);
  v_set_id := (v_pay_result->>'allocation_set_id')::uuid;

  BEGIN
    PERFORM public.void_invoice(v_inv_paid, 'H3 smoke: should be blocked', 'e2e-h3-void-' || v_suffix);
    -- Reached only on the PRE-FIX function: void stranded the applied payment.
    RAISE EXCEPTION 'SMOKE_FAIL: void_invoice succeeded on an invoice with an applied payment — cash stranded (H3 live)';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'INVOICE_HAS_APPLIED_PAYMENTS:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: void_invoice wrong rejection with an applied payment: %', v_err;
    END IF;
  END;

  -- The supported payment ledger has a real reversal. Once unapplied, the
  -- invoice is no longer stranded and can be voided normally.
  PERFORM public.void_payment(v_set_id, 'H3 smoke: unapply before invoice void', v_admin, 'e2e-h3-unpay-' || v_suffix);
  PERFORM public.void_invoice(v_inv_paid, 'H3 smoke: safe after payment reversal', 'e2e-h3-void-after-unpay-' || v_suffix);
  SELECT status INTO v_status FROM public.invoices WHERE id = v_inv_paid;
  IF v_status <> 'voided' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: invoice did not void after supported payment reversal (status=%)', v_status;
  END IF;
  SELECT count(*) INTO v_history_count
  FROM public.invoice_line_allocations
  WHERE allocation_set_id = v_set_id AND invoice_id = v_inv_paid;
  SELECT total_allocated_cents INTO v_history_total
  FROM public.allocation_sets WHERE id = v_set_id AND is_active = false;
  IF v_history_count IS DISTINCT FROM 1 OR v_history_total IS DISTINCT FROM 50000 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: payment reversal history was erased by invoice void (rows=%, cached_total=%)',
      v_history_count, v_history_total;
  END IF;

  -- ===== Scenario 2: a PREPAY-ONLY posted invoice must STILL void =====
  -- (guard must not over-block; void re-banks prepay correctly).
  INSERT INTO public.invoices (
    invoice_number, customer_id, invoice_type, status,
    invoice_date, due_date, total_amount_cents, created_by
  ) VALUES (
    'E2E-H3-PREPAY-' || v_suffix, v_customer, 'chemical_sale', 'draft',
    CURRENT_DATE, CURRENT_DATE + 30, 40000, v_admin
  ) RETURNING id INTO v_inv_prepay;
  UPDATE public.invoices SET status = 'posted', posted_by = v_admin, posted_at = now()
  WHERE id = v_inv_prepay;

  PERFORM public.create_prepay_check_splits(
    v_customer, 'E2E-H3-PP-' || v_suffix,
    jsonb_build_array(jsonb_build_object('label', 'Chemicals', 'amount_cents', 40000)),
    v_admin, 'e2e-h3-pp-' || v_suffix, 40000);
  SELECT id INTO v_prepay_id FROM public.prepay_credits
  WHERE customer_id = v_customer AND balance_cents > 0 ORDER BY created_at LIMIT 1;

  PERFORM public.apply_prepay_to_invoice(v_prepay_id, v_inv_prepay, 40000, NULL, 'e2e-h3-applypp-' || v_suffix);

  -- prepay-only (paid_amount_cents = 0, no invoice_line_allocations) -> not blocked.
  PERFORM public.void_invoice(v_inv_prepay, 'H3 smoke: prepay-only void allowed', 'e2e-h3-voidpp-' || v_suffix);
  SELECT status INTO v_status FROM public.invoices WHERE id = v_inv_prepay;
  IF v_status <> 'voided' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: prepay-only invoice was not voided (status=%), guard over-blocked', v_status;
  END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END $smoke$;
