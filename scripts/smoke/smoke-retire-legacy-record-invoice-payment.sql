-- Fail-first proof: the obsolete payments-table writer must be disabled so all
-- new cash uses allocate_payment, whose allocation set can be voided safely.
DO $smoke$
DECLARE
  v_admin uuid;
  v_suffix text := substr(md5(random()::text), 1, 8);
  v_customer uuid;
  v_invoice uuid;
  v_err text;
BEGIN
  SELECT id INTO v_admin FROM public.profiles
  WHERE role = 'admin' AND is_active = true ORDER BY created_at LIMIT 1;
  IF v_admin IS NULL THEN RAISE EXCEPTION 'SMOKE_SETUP: active admin required'; END IF;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);

  INSERT INTO public.customers (farm_name)
  VALUES ('[E2E] Legacy Payment Retirement ' || v_suffix) RETURNING id INTO v_customer;
  INSERT INTO public.invoices (
    invoice_number, customer_id, invoice_type, status,
    invoice_date, due_date, total_amount_cents, created_by
  ) VALUES (
    'E2E-LEGACY-PAY-' || v_suffix, v_customer, 'chemical_sale', 'draft',
    CURRENT_DATE, CURRENT_DATE + 30, 10000, v_admin
  ) RETURNING id INTO v_invoice;
  UPDATE public.invoices SET status = 'posted', posted_by = v_admin, posted_at = now()
  WHERE id = v_invoice;

  BEGIN
    PERFORM public.record_invoice_payment(
      v_invoice, 5000, 'check', 'E2E-LEGACY-' || v_suffix, NULL,
      'e2e-retire-legacy-' || v_suffix);
    RAISE EXCEPTION 'SMOKE_FAIL: obsolete record_invoice_payment still accepted new cash';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'LEGACY_PAYMENT_PATH_DISABLED:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: obsolete writer returned wrong error: %', v_err;
    END IF;
  END;

  IF EXISTS (SELECT 1 FROM public.payments
    WHERE reference_number = 'E2E-LEGACY-' || v_suffix AND deleted_at IS NULL) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: disabled legacy writer left a payment row';
  END IF;
  IF EXISTS (SELECT 1 FROM public.invoices WHERE id = v_invoice AND paid_amount_cents <> 0) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: disabled legacy writer changed invoice paid amount';
  END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END $smoke$;
