-- Post-apply rollback-only regression proof for H1 (Live Foundation Gauntlet
-- 2026-07-18): apply_prepay_to_invoice must REJECT a
-- deactivated / profile-less authenticated actor.
--
-- FAIL-FIRST CONTRACT: run against the PRE-FIX functions and this chain raises
-- SMOKE_FAIL (the deactivated admin successfully applies a prepay / records a
-- payment, because `NULL NOT IN (...)` is not TRUE). Run against the FIXED
-- function and the call raises the authorization error.
--
-- Everything happens inside one DO block that ends in a terminal exception, so
-- no row or sequence side effect ever commits.
DO $smoke$
DECLARE
  v_admin      uuid;
  v_suffix     text := substr(md5(random()::text), 1, 8);
  v_customer   uuid;
  v_invoice    uuid;
  v_prepay_id  uuid;
  v_reference  text := 'SMK-H1-' || v_suffix;
  v_prepay_key text := 'smk-h1-prepay-' || v_suffix;
  v_splits     jsonb;
  v_err        text;
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

  -- ---- fixtures (created while the actor is still an active admin) ----
  -- [E2E] marker keeps the live-testdata guard satisfied; the terminal
  -- rollback removes the row regardless.
  INSERT INTO public.customers (farm_name, prepay_balance_cents)
  VALUES ('[E2E] H1 Farm ' || v_suffix, 0)
  RETURNING id INTO v_customer;

  INSERT INTO public.invoices (
    invoice_number, customer_id, invoice_type, status,
    invoice_date, due_date, total_amount_cents, created_by
  ) VALUES (
    'SMK-H1-INV-' || v_suffix, v_customer, 'chemical_sale', 'draft',
    CURRENT_DATE - 5, CURRENT_DATE + 25, 100000, v_admin
  ) RETURNING id INTO v_invoice;
  UPDATE public.invoices
  SET status = 'posted', posted_by = v_admin, posted_at = now()
  WHERE id = v_invoice;

  -- Real prepay credit for this customer via the vetted RPC.
  v_splits := jsonb_build_array(
    jsonb_build_object('label', 'Chemicals', 'amount_cents', 1000)
  );
  PERFORM public.create_prepay_check_splits(
    v_customer, v_reference, v_splits, v_admin, v_prepay_key, 1000
  );
  SELECT id INTO v_prepay_id
  FROM public.prepay_credits
  WHERE customer_id = v_customer AND balance_cents > 0
  ORDER BY created_at
  LIMIT 1;
  IF v_prepay_id IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: prepay credit fixture missing';
  END IF;

  -- ---- deactivate the actor; they remain authenticated (valid JWT) ----
  UPDATE public.profiles SET is_active = false WHERE id = v_admin;

  -- ===== NEGATIVE 1: apply_prepay_to_invoice must reject the inactive actor =====
  BEGIN
    PERFORM public.apply_prepay_to_invoice(
      v_prepay_id, v_invoice, 100, NULL, 'smk-h1-apply-' || v_suffix
    );
    -- Reached only on the PRE-FIX (buggy) function: NULL role slipped past the gate.
    RAISE EXCEPTION 'SMOKE_FAIL: deactivated actor applied a prepay (H1 auth bypass live)';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'INSUFFICIENT_ROLE:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: apply_prepay wrong rejection for inactive actor: %', v_err;
    END IF;
  END;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END $smoke$;
