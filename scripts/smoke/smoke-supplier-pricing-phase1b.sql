-- ============================================================================
-- Supplier Pricing Phase 1b full business-chain smoke (rolled back by design)
--
-- Covers the complete governed flow:
--   vendor alias stage -> review -> reusable supplier link -> import stage ->
--   import read -> approval -> market/workspace/quote/history reads ->
--   correction/supersession -> pack-normalized cheapest evidence.
--
-- Every mutating SECURITY DEFINER RPC receives the standard no-auth, anon,
-- wrong-role, forged-actor, and positive-control probes. Idempotent replay,
-- payload mismatch, link/history immutability, observation immutability, and
-- the hard guarantee that Product cost/sell prices never change are asserted.
--
-- The terminal SMOKE_PASS_ROLLBACK exception is the pass signal and guarantees
-- all synthetic evidence, links, imports, observations, aliases, and idempotency
-- receipts roll back together.
-- ============================================================================

DO $smoke$
DECLARE
  v_admin uuid;
  v_wrong uuid;
  v_wrong_role text;
  v_suffix text := substr(md5(random()::text || clock_timestamp()::text), 1, 10);
  v_vendor uuid;
  v_vendor_name text;
  v_replay_vendor uuid;
  v_product uuid;
  v_product_name text;
  v_inventory_unit text;
  v_product_prices_before jsonb;
  v_product_prices_after jsonb;
  v_alias_raw text;
  v_alias_id uuid;
  v_replay_alias_id uuid;
  v_link_id uuid;
  v_import_id uuid;
  v_import_row_id uuid;
  v_observation_id uuid;
  v_correction_id uuid;
  v_correction_import_id uuid;
  v_stage_key text;
  v_approve_key text;
  v_correct_key text;
  v_rows jsonb;
  v_res jsonb;
  v_replay jsonb;
  v_workspace jsonb;
  v_market jsonb;
  v_quote jsonb;
  v_history jsonb;
  v_n integer;
  v_cost bigint;
  v_normalized bigint;
BEGIN
  -- Real actors and FK targets, selected from the live catalog. All new business
  -- rows created below are synthetic and roll back at the terminal pass signal.
  SELECT id INTO v_admin
  FROM public.profiles
  WHERE role = 'admin' AND is_active = true
  ORDER BY created_at
  LIMIT 1;
  IF v_admin IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: no active admin profile';
  END IF;

  SELECT id, role INTO v_wrong, v_wrong_role
  FROM public.profiles
  WHERE is_active = true AND role IN ('driver', 'applicator')
  ORDER BY CASE role WHEN 'driver' THEN 0 ELSE 1 END, created_at
  LIMIT 1;
  IF v_wrong IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: no active driver/applicator profile';
  END IF;

  SELECT id, name INTO v_vendor, v_vendor_name
  FROM public.vendors
  WHERE deleted_at IS NULL AND name = 'Van Diest Supply'
  LIMIT 1;
  IF v_vendor IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: active Van Diest Supply vendor not found';
  END IF;

  SELECT id, product_name, inventory_unit INTO v_product, v_product_name, v_inventory_unit
  FROM public.products
  WHERE is_active
    AND NULLIF(btrim(COALESCE(inventory_unit, '')), '') IS NOT NULL
  ORDER BY id
  LIMIT 1;
  IF v_product IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: no active Product with an inventory unit';
  END IF;

  SELECT jsonb_build_object(
    'current_cost', current_cost,
    'tier1_price', tier1_price,
    'tier2_price', tier2_price,
    'tier3_price', tier3_price,
    'pricing_version', pricing_version,
    'cost_updated_date', cost_updated_date
  ) INTO v_product_prices_before
  FROM public.products WHERE id = v_product;

  v_alias_raw := '[SMOKE] Phase1b Alias ' || v_suffix;

  -- --------------------------------------------------------------------------
  -- 1. stage_vendor_alias auth probes + positive control + exact replay.
  -- --------------------------------------------------------------------------
  PERFORM set_config('request.jwt.claims', '', true);
  BEGIN
    PERFORM public.stage_vendor_alias(v_alias_raw, v_alias_raw, v_vendor, 'manual', NULL, 'smk-' || v_suffix || '-alias-p1');
    RAISE EXCEPTION 'SMOKE_FAIL: stage_vendor_alias no-auth was allowed';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'AUTH_REQUIRED%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: stage_vendor_alias P1 expected AUTH_REQUIRED, got %', SQLERRM;
    END IF;
  END;

  PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
  BEGIN
    PERFORM public.stage_vendor_alias(v_alias_raw, v_alias_raw, v_vendor, 'manual', NULL, 'smk-' || v_suffix || '-alias-p2');
    RAISE EXCEPTION 'SMOKE_FAIL: stage_vendor_alias anon was allowed';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'AUTH_REQUIRED%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: stage_vendor_alias P2 expected AUTH_REQUIRED, got %', SQLERRM;
    END IF;
  END;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_wrong, 'role', 'authenticated')::text, true);
  BEGIN
    PERFORM public.stage_vendor_alias(v_alias_raw, v_alias_raw, v_vendor, 'manual', v_wrong, 'smk-' || v_suffix || '-alias-p3');
    RAISE EXCEPTION 'SMOKE_FAIL: stage_vendor_alias wrong-role % was allowed', v_wrong_role;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'ADMIN_REQUIRED%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: stage_vendor_alias P3 expected ADMIN_REQUIRED, got %', SQLERRM;
    END IF;
  END;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  BEGIN
    PERFORM public.stage_vendor_alias(v_alias_raw, v_alias_raw, v_vendor, 'manual', v_wrong, 'smk-' || v_suffix || '-alias-p4');
    RAISE EXCEPTION 'SMOKE_FAIL: stage_vendor_alias forged actor was allowed';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'ACTOR_MISMATCH%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: stage_vendor_alias P4 expected ACTOR_MISMATCH, got %', SQLERRM;
    END IF;
  END;

  SELECT count(*) INTO v_n FROM public.vendor_aliases WHERE alias_raw = v_alias_raw;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: rejected alias probes wrote % row(s)', v_n;
  END IF;

  v_res := public.stage_vendor_alias(v_alias_raw, v_alias_raw, v_vendor, 'manual', v_admin, 'smk-' || v_suffix || '-alias-stage');
  v_alias_id := (v_res->>'id')::uuid;
  IF v_alias_id IS NULL OR v_res->>'review_status' IS DISTINCT FROM 'pending' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: stage_vendor_alias positive control malformed: %', v_res;
  END IF;
  v_replay := public.stage_vendor_alias(v_alias_raw, v_alias_raw, v_vendor, 'manual', v_admin, 'smk-' || v_suffix || '-alias-stage');
  IF v_replay IS DISTINCT FROM v_res THEN
    RAISE EXCEPTION 'SMOKE_FAIL: stage_vendor_alias replay changed response: % vs %', v_res, v_replay;
  END IF;

  -- Durable replay must survive mutable vendor state after the cache expires.
  INSERT INTO public.vendors (name)
  VALUES ('[SMOKE] Retired Replay Vendor ' || v_suffix)
  RETURNING id INTO v_replay_vendor;
  v_res := public.stage_vendor_alias(
    '[SMOKE] Retired Replay Alias ' || v_suffix,
    '[SMOKE] Retired Replay Alias ' || v_suffix,
    v_replay_vendor,
    'manual',
    v_admin,
    'smk-' || v_suffix || '-alias-retired-replay'
  );
  v_replay_alias_id := (v_res->>'id')::uuid;
  PERFORM public.review_vendor_alias(
    v_replay_alias_id,
    v_replay_vendor,
    'approved',
    'smoke mutates the alias after staging',
    v_admin,
    'smk-' || v_suffix || '-alias-retired-review'
  );
  DELETE FROM public.idempotency_keys
  WHERE idempotency_key = 'smk-' || v_suffix || '-alias-retired-replay'
    AND operation = 'stage_vendor_alias';
  UPDATE public.vendors SET deleted_at = now() WHERE id = v_replay_vendor;
  v_replay := public.stage_vendor_alias(
    '[SMOKE] Retired Replay Alias ' || v_suffix,
    '[SMOKE] Retired Replay Alias ' || v_suffix,
    v_replay_vendor,
    'manual',
    v_admin,
    'smk-' || v_suffix || '-alias-retired-replay'
  );
  IF v_replay IS DISTINCT FROM v_res THEN
    RAISE EXCEPTION 'SMOKE_FAIL: reviewed, retired-vendor durable replay changed response: % vs %', v_res, v_replay;
  END IF;
  BEGIN
    PERFORM public.stage_vendor_alias(
      '[SMOKE] New Alias For Retired Vendor ' || v_suffix,
      '[SMOKE] New Alias For Retired Vendor ' || v_suffix,
      v_replay_vendor,
      'manual',
      v_admin,
      'smk-' || v_suffix || '-alias-retired-new'
    );
    RAISE EXCEPTION 'SMOKE_FAIL: a new alias was staged for a retired vendor';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'VENDOR_NOT_FOUND%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: retired-vendor new mutation expected VENDOR_NOT_FOUND, got %', SQLERRM;
    END IF;
  END;

  -- --------------------------------------------------------------------------
  -- 2. review_vendor_alias auth probes + approval + replay.
  -- --------------------------------------------------------------------------
  PERFORM set_config('request.jwt.claims', '', true);
  BEGIN
    PERFORM public.review_vendor_alias(v_alias_id, v_vendor, 'approved', 'smoke review', NULL, 'smk-' || v_suffix || '-alias-review-p1');
    RAISE EXCEPTION 'SMOKE_FAIL: review_vendor_alias no-auth was allowed';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'AUTH_REQUIRED%' THEN RAISE EXCEPTION 'SMOKE_FAIL: review alias P1 got %', SQLERRM; END IF;
  END;
  PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
  BEGIN
    PERFORM public.review_vendor_alias(v_alias_id, v_vendor, 'approved', 'smoke review', NULL, 'smk-' || v_suffix || '-alias-review-p2');
    RAISE EXCEPTION 'SMOKE_FAIL: review_vendor_alias anon was allowed';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'AUTH_REQUIRED%' THEN RAISE EXCEPTION 'SMOKE_FAIL: review alias P2 got %', SQLERRM; END IF;
  END;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_wrong, 'role', 'authenticated')::text, true);
  BEGIN
    PERFORM public.review_vendor_alias(v_alias_id, v_vendor, 'approved', 'smoke review', v_wrong, 'smk-' || v_suffix || '-alias-review-p3');
    RAISE EXCEPTION 'SMOKE_FAIL: review_vendor_alias wrong role was allowed';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'ADMIN_REQUIRED%' THEN RAISE EXCEPTION 'SMOKE_FAIL: review alias P3 got %', SQLERRM; END IF;
  END;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  BEGIN
    PERFORM public.review_vendor_alias(v_alias_id, v_vendor, 'approved', 'smoke review', v_wrong, 'smk-' || v_suffix || '-alias-review-p4');
    RAISE EXCEPTION 'SMOKE_FAIL: review_vendor_alias forged actor was allowed';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'ACTOR_MISMATCH%' THEN RAISE EXCEPTION 'SMOKE_FAIL: review alias P4 got %', SQLERRM; END IF;
  END;
  SELECT count(*) INTO v_n FROM public.vendor_aliases WHERE id = v_alias_id AND review_status = 'pending';
  IF v_n <> 1 THEN RAISE EXCEPTION 'SMOKE_FAIL: rejected review probes changed pending alias'; END IF;

  v_res := public.review_vendor_alias(v_alias_id, v_vendor, 'approved', 'smoke review', v_admin, 'smk-' || v_suffix || '-alias-review');
  IF v_res->>'review_status' IS DISTINCT FROM 'approved' OR (v_res->>'vendor_id')::uuid IS DISTINCT FROM v_vendor THEN
    RAISE EXCEPTION 'SMOKE_FAIL: review_vendor_alias positive control malformed: %', v_res;
  END IF;
  v_replay := public.review_vendor_alias(v_alias_id, v_vendor, 'approved', 'smoke review', v_admin, 'smk-' || v_suffix || '-alias-review');
  IF v_replay IS DISTINCT FROM v_res THEN RAISE EXCEPTION 'SMOKE_FAIL: review alias replay changed response'; END IF;

  -- --------------------------------------------------------------------------
  -- 3. upsert_product_supplier_link auth probes + reusable comparable link.
  -- --------------------------------------------------------------------------
  PERFORM set_config('request.jwt.claims', '', true);
  BEGIN
    PERFORM public.upsert_product_supplier_link(v_product, v_vendor, 'SMK-' || v_suffix, '[SMOKE] ' || v_product_name, 'case', '2 x ' || v_inventory_unit, '2', v_inventory_unit, 'comparable', 'smoke', false, NULL, 'smk-' || v_suffix || '-link-p1', NULL);
    RAISE EXCEPTION 'SMOKE_FAIL: upsert link no-auth was allowed';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'AUTH_REQUIRED%' THEN RAISE EXCEPTION 'SMOKE_FAIL: upsert link P1 got %', SQLERRM; END IF;
  END;
  PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
  BEGIN
    PERFORM public.upsert_product_supplier_link(v_product, v_vendor, 'SMK-' || v_suffix, '[SMOKE] ' || v_product_name, 'case', '2 x ' || v_inventory_unit, '2', v_inventory_unit, 'comparable', 'smoke', false, NULL, 'smk-' || v_suffix || '-link-p2', NULL);
    RAISE EXCEPTION 'SMOKE_FAIL: upsert link anon was allowed';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'AUTH_REQUIRED%' THEN RAISE EXCEPTION 'SMOKE_FAIL: upsert link P2 got %', SQLERRM; END IF;
  END;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_wrong, 'role', 'authenticated')::text, true);
  BEGIN
    PERFORM public.upsert_product_supplier_link(v_product, v_vendor, 'SMK-' || v_suffix, '[SMOKE] ' || v_product_name, 'case', '2 x ' || v_inventory_unit, '2', v_inventory_unit, 'comparable', 'smoke', false, v_wrong, 'smk-' || v_suffix || '-link-p3', NULL);
    RAISE EXCEPTION 'SMOKE_FAIL: upsert link wrong role was allowed';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'ADMIN_REQUIRED%' THEN RAISE EXCEPTION 'SMOKE_FAIL: upsert link P3 got %', SQLERRM; END IF;
  END;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  BEGIN
    PERFORM public.upsert_product_supplier_link(v_product, v_vendor, 'SMK-' || v_suffix, '[SMOKE] ' || v_product_name, 'case', '2 x ' || v_inventory_unit, '2', v_inventory_unit, 'comparable', 'smoke', false, v_wrong, 'smk-' || v_suffix || '-link-p4', NULL);
    RAISE EXCEPTION 'SMOKE_FAIL: upsert link forged actor was allowed';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'ACTOR_MISMATCH%' THEN RAISE EXCEPTION 'SMOKE_FAIL: upsert link P4 got %', SQLERRM; END IF;
  END;
  SELECT count(*) INTO v_n FROM public.product_supplier_links WHERE supplier_sku = 'SMK-' || v_suffix;
  IF v_n <> 0 THEN RAISE EXCEPTION 'SMOKE_FAIL: rejected link probes wrote % row(s)', v_n; END IF;

  v_res := public.upsert_product_supplier_link(v_product, v_vendor, 'SMK-' || v_suffix, '[SMOKE] ' || v_product_name, 'case', '2 x ' || v_inventory_unit, '2', v_inventory_unit, 'comparable', 'smoke', false, v_admin, 'smk-' || v_suffix || '-link', NULL);
  v_link_id := (v_res->>'id')::uuid;
  IF v_link_id IS NULL OR COALESCE((v_res->>'is_reusable')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'SMOKE_FAIL: reusable comparable link not created: %', v_res;
  END IF;
  v_replay := public.upsert_product_supplier_link(v_product, v_vendor, 'SMK-' || v_suffix, '[SMOKE] ' || v_product_name, 'case', '2 x ' || v_inventory_unit, '2', v_inventory_unit, 'comparable', 'smoke', false, v_admin, 'smk-' || v_suffix || '-link', NULL);
  IF v_replay IS DISTINCT FROM v_res THEN RAISE EXCEPTION 'SMOKE_FAIL: link replay changed response'; END IF;

  -- --------------------------------------------------------------------------
  -- 4. stage_supplier_price_import auth probes + stage/replay/mismatch.
  -- --------------------------------------------------------------------------
  v_rows := jsonb_build_array(jsonb_build_object(
    'product_supplier_link_id', v_link_id,
    'new_cost', '123.45',
    'price_unit', 'case',
    'package_quantity', '1',
    'effective_date', current_date,
    'price_kind', 'quote',
    'has_formula', false
  ));
  v_stage_key := 'smk-' || v_suffix || '-import-stage';

  PERFORM set_config('request.jwt.claims', '', true);
  BEGIN
    PERFORM public.stage_supplier_price_import(v_vendor, current_date, 'quick_quote', 'crx-supplier-quote-phase1b-v1', NULL, NULL, NULL, v_rows, NULL, v_stage_key || '-p1');
    RAISE EXCEPTION 'SMOKE_FAIL: stage import no-auth was allowed';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'AUTH_REQUIRED%' THEN RAISE EXCEPTION 'SMOKE_FAIL: stage import P1 got %', SQLERRM; END IF;
  END;
  PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
  BEGIN
    PERFORM public.stage_supplier_price_import(v_vendor, current_date, 'quick_quote', 'crx-supplier-quote-phase1b-v1', NULL, NULL, NULL, v_rows, NULL, v_stage_key || '-p2');
    RAISE EXCEPTION 'SMOKE_FAIL: stage import anon was allowed';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'AUTH_REQUIRED%' THEN RAISE EXCEPTION 'SMOKE_FAIL: stage import P2 got %', SQLERRM; END IF;
  END;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_wrong, 'role', 'authenticated')::text, true);
  BEGIN
    PERFORM public.stage_supplier_price_import(v_vendor, current_date, 'quick_quote', 'crx-supplier-quote-phase1b-v1', NULL, NULL, NULL, v_rows, v_wrong, v_stage_key || '-p3');
    RAISE EXCEPTION 'SMOKE_FAIL: stage import wrong role was allowed';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'ADMIN_REQUIRED%' THEN RAISE EXCEPTION 'SMOKE_FAIL: stage import P3 got %', SQLERRM; END IF;
  END;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  BEGIN
    PERFORM public.stage_supplier_price_import(v_vendor, current_date, 'quick_quote', 'crx-supplier-quote-phase1b-v1', NULL, NULL, NULL, v_rows, v_wrong, v_stage_key || '-p4');
    RAISE EXCEPTION 'SMOKE_FAIL: stage import forged actor was allowed';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'ACTOR_MISMATCH%' THEN RAISE EXCEPTION 'SMOKE_FAIL: stage import P4 got %', SQLERRM; END IF;
  END;
  SELECT count(*) INTO v_n FROM public.supplier_price_imports WHERE idempotency_key LIKE v_stage_key || '-p%';
  IF v_n <> 0 THEN RAISE EXCEPTION 'SMOKE_FAIL: rejected stage-import probes wrote % row(s)', v_n; END IF;

  v_res := public.stage_supplier_price_import(v_vendor, current_date, 'quick_quote', 'crx-supplier-quote-phase1b-v1', NULL, NULL, NULL, v_rows, v_admin, v_stage_key);
  v_import_id := (v_res->>'id')::uuid;
  v_import_row_id := (v_res->'rows'->0->>'id')::uuid;
  IF v_import_id IS NULL OR v_import_row_id IS NULL
     OR v_res->>'status' IS DISTINCT FROM 'needs_review'
     OR v_res->'rows'->0->>'row_status' IS DISTINCT FROM 'new' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: staged import malformed: %', v_res;
  END IF;
  v_replay := public.stage_supplier_price_import(v_vendor, current_date, 'quick_quote', 'crx-supplier-quote-phase1b-v1', NULL, NULL, NULL, v_rows, v_admin, v_stage_key);
  IF v_replay IS DISTINCT FROM v_res THEN RAISE EXCEPTION 'SMOKE_FAIL: stage import replay changed response'; END IF;
  BEGIN
    PERFORM public.stage_supplier_price_import(
      v_vendor, current_date, 'quick_quote', 'crx-supplier-quote-phase1b-v1', NULL, NULL, NULL,
      jsonb_set(v_rows, '{0,new_cost}', '"999.99"'::jsonb), v_admin, v_stage_key
    );
    RAISE EXCEPTION 'SMOKE_FAIL: stage import idempotency payload mismatch was allowed';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_PAYLOAD_MISMATCH%' THEN RAISE EXCEPTION 'SMOKE_FAIL: stage import mismatch got %', SQLERRM; END IF;
  END;

  -- --------------------------------------------------------------------------
  -- 5. Read-RPC auth gates using valid fixtures.
  -- --------------------------------------------------------------------------
  PERFORM set_config('request.jwt.claims', '', true);
  BEGIN PERFORM public.get_supplier_price_import(v_import_id); RAISE EXCEPTION 'SMOKE_FAIL: get import no-auth allowed';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF; IF SQLERRM NOT LIKE 'AUTH_REQUIRED%' THEN RAISE EXCEPTION 'SMOKE_FAIL: get import auth got %', SQLERRM; END IF; END;
  BEGIN PERFORM public.get_supplier_pricing_workspace(v_product, v_vendor); RAISE EXCEPTION 'SMOKE_FAIL: workspace no-auth allowed';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF; IF SQLERRM NOT LIKE 'AUTH_REQUIRED%' THEN RAISE EXCEPTION 'SMOKE_FAIL: workspace auth got %', SQLERRM; END IF; END;
  BEGIN PERFORM public.get_supplier_market_evidence(ARRAY[v_product]); RAISE EXCEPTION 'SMOKE_FAIL: market no-auth allowed';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF; IF SQLERRM NOT LIKE 'AUTH_REQUIRED%' THEN RAISE EXCEPTION 'SMOKE_FAIL: market auth got %', SQLERRM; END IF; END;
  BEGIN PERFORM public.get_supplier_quote_sheet(v_vendor); RAISE EXCEPTION 'SMOKE_FAIL: quote sheet no-auth allowed';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF; IF SQLERRM NOT LIKE 'AUTH_REQUIRED%' THEN RAISE EXCEPTION 'SMOKE_FAIL: quote sheet auth got %', SQLERRM; END IF; END;
  BEGIN PERFORM public.get_product_price_history(v_product); RAISE EXCEPTION 'SMOKE_FAIL: history no-auth allowed';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF; IF SQLERRM NOT LIKE 'AUTH_REQUIRED%' THEN RAISE EXCEPTION 'SMOKE_FAIL: history auth got %', SQLERRM; END IF; END;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_wrong, 'role', 'authenticated')::text, true);
  BEGIN PERFORM public.get_supplier_price_import(v_import_id); RAISE EXCEPTION 'SMOKE_FAIL: get import wrong-role allowed';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF; IF SQLERRM NOT LIKE 'ADMIN_REQUIRED%' THEN RAISE EXCEPTION 'SMOKE_FAIL: get import role got %', SQLERRM; END IF; END;
  BEGIN PERFORM public.get_supplier_pricing_workspace(v_product, v_vendor); RAISE EXCEPTION 'SMOKE_FAIL: workspace wrong-role allowed';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF; IF SQLERRM NOT LIKE 'ADMIN_REQUIRED%' THEN RAISE EXCEPTION 'SMOKE_FAIL: workspace role got %', SQLERRM; END IF; END;
  BEGIN PERFORM public.get_supplier_market_evidence(ARRAY[v_product]); RAISE EXCEPTION 'SMOKE_FAIL: market wrong-role allowed';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF; IF SQLERRM NOT LIKE 'ADMIN_REQUIRED%' THEN RAISE EXCEPTION 'SMOKE_FAIL: market role got %', SQLERRM; END IF; END;
  BEGIN PERFORM public.get_supplier_quote_sheet(v_vendor); RAISE EXCEPTION 'SMOKE_FAIL: quote wrong-role allowed';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF; IF SQLERRM NOT LIKE 'ADMIN_REQUIRED%' THEN RAISE EXCEPTION 'SMOKE_FAIL: quote role got %', SQLERRM; END IF; END;
  BEGIN PERFORM public.get_product_price_history(v_product); RAISE EXCEPTION 'SMOKE_FAIL: history wrong-role allowed';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF; IF SQLERRM NOT LIKE 'ADMIN_REQUIRED%' THEN RAISE EXCEPTION 'SMOKE_FAIL: history role got %', SQLERRM; END IF; END;

  -- --------------------------------------------------------------------------
  -- 6. approve_supplier_price_import auth probes + approval/replay.
  -- --------------------------------------------------------------------------
  v_approve_key := 'smk-' || v_suffix || '-import-approve';
  PERFORM set_config('request.jwt.claims', '', true);
  BEGIN PERFORM public.approve_supplier_price_import(v_import_id, ARRAY[v_import_row_id], NULL, v_approve_key || '-p1'); RAISE EXCEPTION 'SMOKE_FAIL: approve no-auth allowed';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF; IF SQLERRM NOT LIKE 'AUTH_REQUIRED%' THEN RAISE EXCEPTION 'SMOKE_FAIL: approve P1 got %', SQLERRM; END IF; END;
  PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
  BEGIN PERFORM public.approve_supplier_price_import(v_import_id, ARRAY[v_import_row_id], NULL, v_approve_key || '-p2'); RAISE EXCEPTION 'SMOKE_FAIL: approve anon allowed';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF; IF SQLERRM NOT LIKE 'AUTH_REQUIRED%' THEN RAISE EXCEPTION 'SMOKE_FAIL: approve P2 got %', SQLERRM; END IF; END;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_wrong, 'role', 'authenticated')::text, true);
  BEGIN PERFORM public.approve_supplier_price_import(v_import_id, ARRAY[v_import_row_id], v_wrong, v_approve_key || '-p3'); RAISE EXCEPTION 'SMOKE_FAIL: approve wrong-role allowed';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF; IF SQLERRM NOT LIKE 'ADMIN_REQUIRED%' THEN RAISE EXCEPTION 'SMOKE_FAIL: approve P3 got %', SQLERRM; END IF; END;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  BEGIN PERFORM public.approve_supplier_price_import(v_import_id, ARRAY[v_import_row_id], v_wrong, v_approve_key || '-p4'); RAISE EXCEPTION 'SMOKE_FAIL: approve forged actor allowed';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF; IF SQLERRM NOT LIKE 'ACTOR_MISMATCH%' THEN RAISE EXCEPTION 'SMOKE_FAIL: approve P4 got %', SQLERRM; END IF; END;
  SELECT count(*) INTO v_n FROM public.supplier_price_observations WHERE import_id = v_import_id;
  IF v_n <> 0 THEN RAISE EXCEPTION 'SMOKE_FAIL: rejected approval probes wrote % observation(s)', v_n; END IF;

  v_res := public.approve_supplier_price_import(v_import_id, ARRAY[v_import_row_id], v_admin, v_approve_key);
  IF (v_res->>'approved_count')::integer IS DISTINCT FROM 1
     OR (v_res->>'sell_prices_changed')::integer IS DISTINCT FROM 0
     OR v_res->>'status' IS DISTINCT FROM 'approved' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: approval response malformed: %', v_res;
  END IF;
  v_replay := public.approve_supplier_price_import(v_import_id, ARRAY[v_import_row_id], v_admin, v_approve_key);
  IF v_replay IS DISTINCT FROM v_res THEN RAISE EXCEPTION 'SMOKE_FAIL: approval replay changed response'; END IF;
  SELECT observation_id INTO v_observation_id FROM public.supplier_price_import_rows WHERE id = v_import_row_id;
  SELECT cost_cents INTO v_cost FROM public.supplier_price_observations WHERE id = v_observation_id;
  IF v_observation_id IS NULL OR v_cost IS DISTINCT FROM 12345 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: approved observation expected 12345 cents, got id=% cost=%', v_observation_id, v_cost;
  END IF;

  -- Positive reads before correction: pack-size normalization must make the
  -- $123.45 case quote equal 6,173 cents per inventory unit (round(12345/2)).
  v_res := public.get_supplier_price_import(v_import_id);
  IF v_res->>'status' IS DISTINCT FROM 'approved' OR (v_res->'rows'->0->>'observation_id')::uuid IS DISTINCT FROM v_observation_id THEN
    RAISE EXCEPTION 'SMOKE_FAIL: approved import read malformed: %', v_res;
  END IF;
  v_workspace := public.get_supplier_pricing_workspace(v_product, v_vendor);
  v_market := public.get_supplier_market_evidence(ARRAY[v_product]);
  v_quote := public.get_supplier_quote_sheet(v_vendor);
  v_history := public.get_product_price_history(v_product);
  v_normalized := (v_market->0->>'replacement_cost_cents')::bigint;
  IF v_normalized IS DISTINCT FROM 6173
     OR v_market->0->>'best_supplier' IS DISTINCT FROM v_vendor_name
     OR v_market->0->>'comparison_status' IS DISTINCT FROM 'comparable' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: pre-correction market normalization wrong: %', v_market;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_workspace->'links') x WHERE (x->>'id')::uuid = v_link_id)
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_workspace->'aliases') x WHERE (x->>'id')::uuid = v_alias_id)
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_quote->'rows') x WHERE (x->>'product_supplier_link_id')::uuid = v_link_id AND x->>'last_cost' = '123.45')
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_history->'points') x WHERE x->>'stream' = 'supplier_observation' AND x->>'source_id' = v_observation_id::text AND (x->>'normalized_cost_cents')::bigint = 6173) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: pre-correction reader chain missing staged evidence';
  END IF;

  -- Once evidence exists, changing the supplier pack in place is forbidden.
  BEGIN
    PERFORM public.upsert_product_supplier_link(v_product, v_vendor, 'SMK-' || v_suffix, '[SMOKE] ' || v_product_name, 'case', 'CHANGED PACK', '2', v_inventory_unit, 'comparable', 'smoke', false, v_admin, 'smk-' || v_suffix || '-link-change', v_link_id);
    RAISE EXCEPTION 'SMOKE_FAIL: link-with-history pack rewrite was allowed';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'SUPPLIER_LINK_WITH_HISTORY_IMMUTABLE%' THEN RAISE EXCEPTION 'SMOKE_FAIL: link immutability got %', SQLERRM; END IF;
  END;

  -- --------------------------------------------------------------------------
  -- 7. correct_supplier_price_observation auth probes + supersession/replay.
  -- --------------------------------------------------------------------------
  v_correct_key := 'smk-' || v_suffix || '-correct';
  PERFORM set_config('request.jwt.claims', '', true);
  BEGIN PERFORM public.correct_supplier_price_observation(v_observation_id, '111.11', 'smoke correction', NULL, v_correct_key || '-p1'); RAISE EXCEPTION 'SMOKE_FAIL: correction no-auth allowed';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF; IF SQLERRM NOT LIKE 'AUTH_REQUIRED%' THEN RAISE EXCEPTION 'SMOKE_FAIL: correction P1 got %', SQLERRM; END IF; END;
  PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
  BEGIN PERFORM public.correct_supplier_price_observation(v_observation_id, '111.11', 'smoke correction', NULL, v_correct_key || '-p2'); RAISE EXCEPTION 'SMOKE_FAIL: correction anon allowed';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF; IF SQLERRM NOT LIKE 'AUTH_REQUIRED%' THEN RAISE EXCEPTION 'SMOKE_FAIL: correction P2 got %', SQLERRM; END IF; END;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_wrong, 'role', 'authenticated')::text, true);
  BEGIN PERFORM public.correct_supplier_price_observation(v_observation_id, '111.11', 'smoke correction', v_wrong, v_correct_key || '-p3'); RAISE EXCEPTION 'SMOKE_FAIL: correction wrong-role allowed';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF; IF SQLERRM NOT LIKE 'ADMIN_REQUIRED%' THEN RAISE EXCEPTION 'SMOKE_FAIL: correction P3 got %', SQLERRM; END IF; END;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  BEGIN PERFORM public.correct_supplier_price_observation(v_observation_id, '111.11', 'smoke correction', v_wrong, v_correct_key || '-p4'); RAISE EXCEPTION 'SMOKE_FAIL: correction forged actor allowed';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF; IF SQLERRM NOT LIKE 'ACTOR_MISMATCH%' THEN RAISE EXCEPTION 'SMOKE_FAIL: correction P4 got %', SQLERRM; END IF; END;
  SELECT count(*) INTO v_n FROM public.supplier_price_observations WHERE supersedes_observation_id = v_observation_id;
  IF v_n <> 0 THEN RAISE EXCEPTION 'SMOKE_FAIL: rejected correction probes wrote % row(s)', v_n; END IF;

  v_res := public.correct_supplier_price_observation(v_observation_id, '111.11', 'smoke correction', v_admin, v_correct_key);
  v_correction_id := (v_res->>'observation_id')::uuid;
  v_correction_import_id := (v_res->>'import_id')::uuid;
  IF v_correction_id IS NULL
     OR (v_res->>'supersedes_observation_id')::uuid IS DISTINCT FROM v_observation_id
     OR (v_res->>'cost_cents')::bigint IS DISTINCT FROM 11111
     OR (v_res->>'sell_prices_changed')::integer IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: correction response malformed: %', v_res;
  END IF;
  v_replay := public.correct_supplier_price_observation(v_observation_id, '111.11', 'smoke correction', v_admin, v_correct_key);
  IF v_replay IS DISTINCT FROM v_res THEN RAISE EXCEPTION 'SMOKE_FAIL: correction replay changed response'; END IF;

  -- Append-only evidence: neither direct UPDATE nor DELETE can rewrite history.
  BEGIN
    UPDATE public.supplier_price_observations SET cost_cents = 1 WHERE id = v_observation_id;
    RAISE EXCEPTION 'SMOKE_FAIL: direct observation UPDATE was allowed';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'SUPPLIER_PRICE_OBSERVATION_IMMUTABLE%' THEN RAISE EXCEPTION 'SMOKE_FAIL: observation immutability got %', SQLERRM; END IF;
  END;

  -- Post-correction business chain: readers select the superseding quote as the
  -- pack-normalized cheapest evidence, while both points remain in history.
  v_res := public.get_supplier_price_import(v_correction_import_id);
  IF v_res->>'status' IS DISTINCT FROM 'approved' OR (v_res->'rows'->0->>'observation_id')::uuid IS DISTINCT FROM v_correction_id THEN
    RAISE EXCEPTION 'SMOKE_FAIL: correction import read malformed: %', v_res;
  END IF;
  v_workspace := public.get_supplier_pricing_workspace(v_product, v_vendor);
  v_market := public.get_supplier_market_evidence(ARRAY[v_product]);
  v_quote := public.get_supplier_quote_sheet(v_vendor);
  v_history := public.get_product_price_history(v_product);
  v_normalized := (v_market->0->>'replacement_cost_cents')::bigint;
  IF v_normalized IS DISTINCT FROM 5556
     OR v_history->'summary'->>'replacement_cost_cents' IS DISTINCT FROM '5556'
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_quote->'rows') x WHERE (x->>'product_supplier_link_id')::uuid = v_link_id AND x->>'last_cost' = '111.11')
     OR (SELECT count(*) FROM jsonb_array_elements(v_history->'points') x WHERE x->>'stream' = 'supplier_observation' AND (x->>'source_id' = v_observation_id::text OR x->>'source_id' = v_correction_id::text)) <> 2 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: post-correction cheapest/history chain wrong: market=% history=% quote=%', v_market, v_history, v_quote;
  END IF;

  SELECT jsonb_build_object(
    'current_cost', current_cost,
    'tier1_price', tier1_price,
    'tier2_price', tier2_price,
    'tier3_price', tier3_price,
    'pricing_version', pricing_version,
    'cost_updated_date', cost_updated_date
  ) INTO v_product_prices_after
  FROM public.products WHERE id = v_product;
  IF v_product_prices_after IS DISTINCT FROM v_product_prices_before THEN
    RAISE EXCEPTION 'SMOKE_FAIL: Supplier Pricing evidence changed Product cost/sell prices: before=% after=%', v_product_prices_before, v_product_prices_after;
  END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END
$smoke$;
