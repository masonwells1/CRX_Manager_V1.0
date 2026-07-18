-- Post-apply rollback-only regression proof for B2 (Live Foundation Gauntlet
-- 2026-07-18): a quote stranded at 'accepted' after its whole-conversion order
-- was cancelled must be rescuable via revert_quote_status, and genuinely
-- re-convertible afterwards.
--
-- FAIL-FIRST CONTRACT: against the PRE-FIX revert_quote_status this chain raises
-- SMOKE_FAIL — the revert is refused ("an order has already been created") so
-- the stranded quote can never be reopened. Against the FIXED function the
-- revert succeeds, the draw ledger is released, and a re-convert produces a NEW
-- order, so the chain reaches SMOKE_PASS_ROLLBACK.
--
-- One DO block, terminal exception → nothing commits.
DO $smoke$
DECLARE
  v_admin    uuid;
  v_suffix   text := substr(md5(random()::text), 1, 8);
  v_customer uuid;
  v_product  uuid;
  v_quote    uuid;
  v_sec      uuid;
  v_res      jsonb;
  v_order1   uuid;
  v_order2   uuid;
  v_status   text;
  v_drawn    numeric;
  v_err      text;
BEGIN
  SELECT id INTO v_admin FROM public.profiles
  WHERE role = 'admin' AND is_active = true ORDER BY created_at LIMIT 1;
  IF v_admin IS NULL THEN RAISE EXCEPTION 'SMOKE_SETUP: active admin required'; END IF;

  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);

  -- [E2E] marker keeps the live-testdata guard satisfied; terminal rollback removes it.
  INSERT INTO public.customers (farm_name)
  VALUES ('[E2E] B2 Farm ' || v_suffix) RETURNING id INTO v_customer;
  INSERT INTO public.products (product_name)
  VALUES ('[E2E] B2 Herbicide ' || v_suffix) RETURNING id INTO v_product;

  -- Whole booking (not planned): one product, 300 units.
  INSERT INTO public.quotes (quote_number, customer_id, created_by, status, commission_split)
  VALUES ('E2E-B2-Q-' || v_suffix, v_customer, v_admin, 'sent', '{"splits": []}'::jsonb)
  RETURNING id INTO v_quote;
  INSERT INTO public.quote_sections (quote_id, section_name)
  VALUES (v_quote, 'Main') RETURNING id INTO v_sec;
  INSERT INTO public.quote_items (quote_id, section_id, product_id,
    price_per_unit, current_cost, total_units_needed, unit_size)
  VALUES (v_quote, v_sec, v_product, 10, 6, 300, 'gal');

  -- ---- whole conversion -> order created, quote 'accepted', draws = 300 ----
  SELECT public.convert_quote_to_order(v_quote) INTO v_res;
  PERFORM set_config('app.admin_override', 'false', true);
  IF v_res->>'status' IS DISTINCT FROM 'created' THEN
    RAISE EXCEPTION 'SMOKE_SETUP: convert returned %, expected created', v_res;
  END IF;
  v_order1 := (v_res->>'order_id')::uuid;

  -- ---- cancel the order (whole conversion: booking_draw = false) ----
  SELECT public.cancel_order(v_order1, v_admin) INTO v_res;
  PERFORM set_config('app.admin_override', 'false', true);
  IF v_res->>'status' IS DISTINCT FROM 'cancelled' THEN
    RAISE EXCEPTION 'SMOKE_SETUP: cancel returned %, expected cancelled', v_res;
  END IF;

  -- ---- stranded pre-condition: quote still 'accepted', draws still 300 ----
  SELECT status INTO v_status FROM public.quotes WHERE id = v_quote;
  IF v_status <> 'accepted' THEN
    RAISE EXCEPTION 'SMOKE_SETUP: quote after cancel = %, expected accepted (whole-conversion stays closed)', v_status;
  END IF;

  -- ===== FAIL-FIRST: revert must rescue the stranded quote =====
  BEGIN
    SELECT public.revert_quote_status(v_quote, 'B2 smoke: un-strand', v_admin, 'e2e-b2-revert-' || v_suffix)
    INTO v_res;
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    -- PRE-FIX path: revert refuses because *an order exists* -> quote stays stranded.
    RAISE EXCEPTION 'SMOKE_FAIL: stranded quote could not be reverted (B2 live): %', v_err;
  END;
  PERFORM set_config('app.admin_override', 'false', true);
  IF v_res->>'new_status' IS DISTINCT FROM 'sent' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: revert returned %, expected new_status=sent', v_res;
  END IF;

  SELECT status INTO v_status FROM public.quotes WHERE id = v_quote;
  IF v_status <> 'sent' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: quote after revert = %, expected sent', v_status;
  END IF;
  SELECT COALESCE(quantity_drawn, 0) INTO v_drawn
  FROM public.quote_product_draws WHERE quote_id = v_quote AND product_id = v_product;
  IF COALESCE(v_drawn, 0) <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: draw ledger after revert = %, expected 0 (released)', v_drawn;
  END IF;

  -- ---- proof it is genuinely re-convertible: a NEW order is created ----
  SELECT public.convert_quote_to_order(v_quote) INTO v_res;
  PERFORM set_config('app.admin_override', 'false', true);
  IF v_res->>'status' IS DISTINCT FROM 'created' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: re-convert returned %, expected created (still stranded)', v_res;
  END IF;
  v_order2 := (v_res->>'order_id')::uuid;
  IF v_order2 IS NULL OR v_order2 = v_order1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: re-convert did not create a new order (got %, cancelled was %)', v_order2, v_order1;
  END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END $smoke$;
