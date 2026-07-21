-- Post-apply rollback-only regression proof for H2 (Live Foundation Gauntlet
-- 2026-07-18): generate_finance_charges must charge an overdue balance at most
-- once per customer per calendar month, even across two runs on different
-- as-of dates in that month, while permitting a corrected assessment after
-- the earlier charge invoice is voided.
--
-- FAIL-FIRST CONTRACT: against the PRE-FIX function the second same-month run
-- (different as-of date, so a different period_end) charges the balance again,
-- leaving TWO finance_charges rows -> this chain raises SMOKE_FAIL. Against the
-- FIXED function the second run skips (month-level dedup + month-keyed advisory
-- lock), preview omits the already-charged customer, one row remains, and the
-- chain reaches SMOKE_PASS_ROLLBACK.
--
-- One DO block, terminal exception -> nothing commits.
DO $smoke$
DECLARE
  v_admin    uuid;
  v_suffix   text := substr(md5(random()::text), 1, 8);
  v_customer uuid;
  v_invoice  uuid;
  v_charge_invoice uuid;
  v_late     date;
  v_early    date;
  v_res      jsonb;
  v_n        integer;
  v_preview_n integer;
  v_closed   date;
  v_err      text;
BEGIN
  SELECT id INTO v_admin FROM public.profiles
  WHERE role = 'admin' AND is_active = true ORDER BY created_at LIMIT 1;
  IF v_admin IS NULL THEN RAISE EXCEPTION 'SMOKE_SETUP: active admin required'; END IF;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);

  -- Latest open, non-future business date (mirrors smoke-gauntlet-money-workflows).
  SELECT gs::date INTO v_late
  FROM generate_series(
    (now() AT TIME ZONE 'America/Chicago')::date,
    (now() AT TIME ZONE 'America/Chicago')::date - 365,
    interval '-1 day') AS gs
  WHERE NOT EXISTS (
    SELECT 1 FROM public.accounting_periods ap
    WHERE gs::date BETWEEN ap.period_start AND ap.period_end AND ap.status = 'closed')
  ORDER BY gs DESC LIMIT 1;
  IF v_late IS NULL THEN RAISE EXCEPTION 'SMOKE_SETUP: no open finance-charge date available'; END IF;

  -- An earlier open date in the SAME calendar month.
  v_early := date_trunc('month', v_late)::date + 4;   -- the 5th
  IF v_early >= v_late THEN v_early := date_trunc('month', v_late)::date; END IF;   -- the 1st
  IF v_early >= v_late THEN
    RAISE EXCEPTION 'SMOKE_SETUP: no two distinct same-month open dates (v_late=%)', v_late;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.accounting_periods ap
    WHERE v_early BETWEEN ap.period_start AND ap.period_end AND ap.status = 'closed') THEN
    RAISE EXCEPTION 'SMOKE_SETUP: early date % is in a closed period', v_early;
  END IF;

  -- [E2E] marker satisfies the live-testdata guard; terminal rollback removes it.
  INSERT INTO public.customers (
    farm_name, finance_charge_rate, finance_charge_enabled,
    finance_charge_grace_days, prepay_balance_cents
  ) VALUES (
    '[E2E] H2 Farm ' || v_suffix, 12, true, 0, 0
  ) RETURNING id INTO v_customer;

  -- Preview and generation must reject the exact same closed business date.
  -- Prefer a real closed period; create a rollback-only historical fixture if
  -- this database has never closed one.
  SELECT ap.period_start
    INTO v_closed
    FROM public.accounting_periods ap
   WHERE ap.status = 'closed'
     AND ap.period_start <= (now() AT TIME ZONE 'America/Chicago')::date
   ORDER BY ap.period_start
   LIMIT 1;
  IF v_closed IS NULL THEN
    v_closed := DATE '1900-01-01';
    INSERT INTO public.accounting_periods (
      period_start, period_end, status, closed_by, closed_at, notes
    ) VALUES (
      v_closed, v_closed, 'closed', v_admin, now(),
      '[E2E] rollback-only finance preview parity fixture'
    );
  END IF;

  BEGIN
    PERFORM count(*) FROM public.preview_finance_charges(v_closed);
    RAISE EXCEPTION 'SMOKE_FAIL: preview accepted a closed accounting period';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'Date % falls in closed accounting period (% to %)' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: preview closed-period gate raised unexpected error: %', v_err;
    END IF;
  END;

  BEGIN
    v_res := public.generate_finance_charges(
      v_closed, v_admin, ARRAY[v_customer], 'e2e-h2-closed-' || v_suffix
    );
    RAISE EXCEPTION 'SMOKE_FAIL: generation accepted a closed accounting period';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'Date % falls in closed accounting period (% to %)' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: generation closed-period gate raised unexpected error: %', v_err;
    END IF;
  END;

  -- Overdue posted invoice (due well before either as-of date).
  INSERT INTO public.invoices (
    invoice_number, customer_id, invoice_type, status,
    invoice_date, due_date, total_amount_cents, created_by
  ) VALUES (
    'E2E-H2-INV-' || v_suffix, v_customer, 'chemical_sale', 'draft',
    v_early - 60, v_early - 40, 100000, v_admin
  ) RETURNING id INTO v_invoice;
  UPDATE public.invoices SET status = 'posted', posted_by = v_admin, posted_at = now()
  WHERE id = v_invoice;

  -- Run 1 (earlier date): must create exactly one charge.
  v_res := public.generate_finance_charges(v_early, v_admin, ARRAY[v_customer], 'e2e-h2-1-' || v_suffix);
  IF (v_res->>'charges_generated')::int IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'SMOKE_SETUP: first run did not charge as expected: %', v_res;
  END IF;
  SELECT fc.invoice_id INTO v_charge_invoice
    FROM public.finance_charges fc
   WHERE fc.customer_id = v_customer
   ORDER BY fc.created_at DESC
   LIMIT 1;

  -- Preview must mirror generation's calendar-month exclusion. Against the
  -- pre-fix preview this customer remains selectable even though generation's
  -- next same-month run will skip it.
  SELECT count(*)
    INTO v_preview_n
    FROM public.preview_finance_charges(v_late) p
   WHERE p.customer_id = v_customer;
  IF v_preview_n IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION
      'SMOKE_FAIL: preview still offered a customer already charged in this calendar month';
  END IF;

  -- Run 2 (later date, SAME month, different key): must NOT charge again.
  v_res := public.generate_finance_charges(v_late, v_admin, ARRAY[v_customer], 'e2e-h2-2-' || v_suffix);

  SELECT count(*) INTO v_n FROM public.finance_charges WHERE customer_id = v_customer;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: % finance charges after two same-month runs, expected 1 (double-charge live)', v_n;
  END IF;
  IF (v_res->>'charges_generated')::int IS DISTINCT FROM 0
     OR (v_res->>'skipped_already_charged')::int IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: second same-month run should skip, got %', v_res;
  END IF;

  -- Once the charge invoice is voided it is no longer an active assessment.
  -- Both preview and generation must allow one corrected charge in that month.
  PERFORM public.void_invoice(
    v_charge_invoice,
    '[E2E] void finance charge before corrected assessment',
    'e2e-h2-void-' || v_suffix
  );

  SELECT count(*) INTO v_preview_n
    FROM public.preview_finance_charges(v_late) p
   WHERE p.customer_id = v_customer;
  IF v_preview_n IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: preview did not offer a corrected charge after voiding the first one';
  END IF;

  v_res := public.generate_finance_charges(
    v_late, v_admin, ARRAY[v_customer], 'e2e-h2-corrected-' || v_suffix
  );
  IF (v_res->>'charges_generated')::int IS DISTINCT FROM 1
     OR (v_res->>'skipped_already_charged')::int IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: corrected same-month charge was not generated: %', v_res;
  END IF;

  SELECT count(*) INTO v_n
    FROM public.finance_charges fc
    JOIN public.invoices i ON i.id = fc.invoice_id
   WHERE fc.customer_id = v_customer
     AND i.deleted_at IS NULL
     AND i.status NOT IN ('voided', 'cancelled');
  IF v_n IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: expected exactly one active finance charge after correction, got %', v_n;
  END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END $smoke$;
