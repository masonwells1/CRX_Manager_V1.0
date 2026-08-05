-- Rollback-only proof for 20260805151605_fix_historical_ar_report_cutoffs and
-- 20260805171334_fix_customer_balance_paid_invoice_totals.
-- Run after the candidate migration in the same transaction pre-apply, or
-- directly through run-smoke.mjs after apply. The terminal exception proves
-- every fixture and mutation rolled back.

DO $smoke$
DECLARE
  v_admin uuid;
  v_customer uuid;
  v_unsafe_customer uuid;
  v_invoice uuid;
  v_paid_invoice uuid;
  v_future_invoice uuid;
  v_credit_memo uuid;
  v_unsafe_invoice uuid;
  v_cutoff date := (now() AT TIME ZONE 'America/Chicago')::date;
  v_suffix text := substr(md5(random()::text), 1, 10);
  v_ar record;
  v_listing record;
  v_failed_closed boolean := false;
BEGIN
  SELECT p.id
    INTO v_admin
    FROM public.profiles p
   WHERE p.role = 'admin' AND p.is_active = true
   ORDER BY p.created_at
   LIMIT 1;
  IF v_admin IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: no active admin profile';
  END IF;

  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text,
    true
  );

  INSERT INTO public.customers (farm_name, account_number, is_active)
  VALUES ('[SMOKE] Historical AR ' || v_suffix, '[SMOKE]-HIST-AR-' || v_suffix, true)
  RETURNING id INTO v_customer;

  INSERT INTO public.invoices (
    invoice_number, customer_id, invoice_type, status, invoice_date, due_date,
    total_amount_cents, created_by, salesman_id
  ) VALUES (
    '[SMOKE]-AR-OVERDUE-' || v_suffix, v_customer, 'chemical_sale', 'draft',
    v_cutoff - 60, v_cutoff - 45, 10000, v_admin, v_admin
  ) RETURNING id INTO v_invoice;

  INSERT INTO public.invoices (
    invoice_number, customer_id, invoice_type, status, invoice_date, due_date,
    total_amount_cents, paid_amount_cents, created_by, salesman_id
  ) VALUES (
    '[SMOKE]-AR-PAID-' || v_suffix, v_customer, 'chemical_sale', 'draft',
    v_cutoff - 20, v_cutoff - 5, 5000, 5000, v_admin, v_admin
  ) RETURNING id INTO v_paid_invoice;

  INSERT INTO public.invoices (
    invoice_number, customer_id, invoice_type, status, invoice_date, due_date,
    total_amount_cents, created_by, salesman_id
  ) VALUES (
    '[SMOKE]-AR-FUTURE-' || v_suffix, v_customer, 'chemical_sale', 'draft',
    v_cutoff + 1, v_cutoff + 31, 90000, v_admin, v_admin
  ) RETURNING id INTO v_future_invoice;

  INSERT INTO public.invoices (
    invoice_number, customer_id, invoice_type, status, invoice_date,
    total_amount_cents, created_by, salesman_id
  ) VALUES (
    '[SMOKE]-AR-CREDIT-' || v_suffix, v_customer, 'credit_memo', 'draft',
    v_cutoff - 30, -3000, v_admin, v_admin
  ) RETURNING id INTO v_credit_memo;

  UPDATE public.invoices
     SET status = 'posted',
         posted_at = (v_cutoff - 60)::timestamp AT TIME ZONE 'America/Chicago'
   WHERE id = v_invoice;
  UPDATE public.invoices SET status = 'overdue' WHERE id = v_invoice;

  UPDATE public.invoices
     SET status = 'posted',
         posted_at = (v_cutoff - 20)::timestamp AT TIME ZONE 'America/Chicago'
   WHERE id = v_paid_invoice;
  UPDATE public.invoices SET status = 'paid' WHERE id = v_paid_invoice;

  UPDATE public.invoices
     SET status = 'posted',
         posted_at = v_cutoff::timestamp AT TIME ZONE 'America/Chicago'
   WHERE id IN (v_future_invoice, v_credit_memo);

  -- This application occurs after the report cutoff. Today's generated rows
  -- now show an $80 target balance and $10 memo balance, but the report cutoff
  -- must reconstruct $100 gross AR and $30 open credit.
  INSERT INTO public.credit_memo_applications (
    credit_memo_id, target_invoice_id, amount_cents, applied_by, applied_at
  ) VALUES (
    v_credit_memo, v_invoice, 2000, v_admin,
    (v_cutoff + 1)::timestamp AT TIME ZONE 'America/Chicago'
  );
  UPDATE public.invoices SET credit_applied_cents = 2000 WHERE id = v_invoice;
  UPDATE public.invoices SET credit_applied_cents = 2000 WHERE id = v_credit_memo;

  SELECT *
    INTO v_ar
    FROM public.get_ar_aging(v_cutoff) a
   WHERE a.customer_id = v_customer;

  IF v_ar.customer_id IS DISTINCT FROM v_customer
     OR v_ar.total_outstanding IS DISTINCT FROM 100.00::numeric
     OR v_ar.open_credit_cents IS DISTINCT FROM 3000::bigint THEN
    RAISE EXCEPTION 'SMOKE_FAIL: AR cutoff expected gross=100.00 credit=3000, got gross=% credit=%',
      v_ar.total_outstanding, v_ar.open_credit_cents;
  END IF;

  SELECT *
    INTO v_listing
    FROM public.get_customer_balance_listing(v_cutoff) b
   WHERE b.customer_id = v_customer;

  IF v_listing.customer_id IS DISTINCT FROM v_customer
     OR v_listing.total_invoiced IS DISTINCT FROM 150.00::numeric
     OR v_listing.total_paid IS DISTINCT FROM 50.00::numeric
     OR v_listing.prepay_applied IS DISTINCT FROM 0.00::numeric
     OR v_listing.outstanding_balance IS DISTINCT FROM 100.00::numeric
     OR v_listing.open_credit IS DISTINCT FROM 30.00::numeric
     OR v_listing.invoice_count IS DISTINCT FROM 2::bigint
     OR v_listing.oldest_unpaid_date IS DISTINCT FROM (v_cutoff - 60) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: listing cutoff expected invoiced=150.00 paid=50.00 prepay=0.00 balance=100.00 credit=30.00 count=2 oldest=%, got invoiced=% paid=% prepay=% balance=% credit=% count=% oldest=%',
      v_cutoff - 60, v_listing.total_invoiced, v_listing.total_paid,
      v_listing.prepay_applied, v_listing.outstanding_balance,
      v_listing.open_credit, v_listing.invoice_count,
      v_listing.oldest_unpaid_date;
  END IF;

  -- Prove the shared guard rejects mutable history rather than reusing today's
  -- balance. A prepay credit created after the cutoff is intentionally enough.
  INSERT INTO public.customers (farm_name, account_number, is_active)
  VALUES ('[SMOKE] Unsafe Historical AR ' || v_suffix, '[SMOKE]-UNSAFE-AR-' || v_suffix, true)
  RETURNING id INTO v_unsafe_customer;

  INSERT INTO public.invoices (
    invoice_number, customer_id, invoice_type, status, invoice_date,
    total_amount_cents, created_by, salesman_id
  ) VALUES (
    '[SMOKE]-AR-UNSAFE-' || v_suffix, v_unsafe_customer, 'chemical_sale', 'draft',
    v_cutoff - 10, 5000, v_admin, v_admin
  ) RETURNING id INTO v_unsafe_invoice;
  UPDATE public.invoices
     SET status = 'posted',
         posted_at = (v_cutoff - 10)::timestamp AT TIME ZONE 'America/Chicago'
   WHERE id = v_unsafe_invoice;

  INSERT INTO public.prepay_credits (
    customer_id, original_amount_cents, balance_cents, payment_method,
    reference_number, created_by, created_at, updated_at
  ) VALUES (
    v_unsafe_customer, 1000, 1000, 'check', '[SMOKE]-LATER-' || v_suffix,
    v_admin,
    (v_cutoff + 1)::timestamp AT TIME ZONE 'America/Chicago',
    (v_cutoff + 1)::timestamp AT TIME ZONE 'America/Chicago'
  );

  BEGIN
    PERFORM public.assert_customer_balance_reconstructable_as_of(v_unsafe_customer, v_cutoff);
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'HISTORICAL_BALANCE_RECONSTRUCTION_UNAVAILABLE:%' THEN
      v_failed_closed := true;
    ELSE
      RAISE;
    END IF;
  END;
  IF NOT v_failed_closed THEN
    RAISE EXCEPTION 'SMOKE_FAIL: later prepay activity did not fail historical reconstruction closed';
  END IF;

  IF has_function_privilege('anon', 'public.get_ar_aging(date)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.get_customer_balance_listing(date)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.assert_customer_balance_reconstructable_as_of(uuid,date)', 'EXECUTE') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: reviewed RPC grant boundary regressed';
  END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END;
$smoke$;
