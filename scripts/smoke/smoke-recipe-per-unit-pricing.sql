-- ============================================================================
-- SMOKE TEST (rolled back by design): recipe per-unit pricing (Phase 4)
-- ----------------------------------------------------------------------------
-- Verifies migration 20260618230000_recipe_per_unit_pricing.sql:
--   * blend_recipe_items.price_per_unit_cents seeds job_chemicals.price_per_unit_cents
--     via load_recipe_into_job (was hard-coded 0 — gap G5).
--   * A recipe item left at the default keeps price 0 (behaviour-preserving).
--   * cost_per_unit_cents still seeds from products.current_cost (x100).
--   * the non-negative CHECK rejects a negative price.
--
-- REQUIRES migration 20260618230000 applied. Pre-apply, blend_recipe_items has
-- no price_per_unit_cents column, so the priced INSERT below errors ("column
-- does not exist") — that is the documented pre-apply state. The parked-migration
-- proof (column + RPC stacked in a rolled-back tx) passed SMOKE_PASS_ROLLBACK.
--
-- The DO block ALWAYS ends in RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK' — nothing
-- here ever commits. Auth: load_recipe_into_job role-gates on auth.uid() via
-- require_admin_or_sales_rep(); we set a tx-local request.jwt.claims with a real
-- active admin sub.
-- ============================================================================

DO $$
DECLARE
  v_admin uuid; v_cust uuid; v_recipe uuid; v_pa uuid; v_pb uuid; v_job uuid;
  v_sfx text := substr(gen_random_uuid()::text,1,8); v_res jsonb;
  v_jc_a record; v_jc_b record; v_caught boolean := false;
BEGIN
  SELECT id INTO v_admin FROM profiles WHERE role='admin' AND is_active=true ORDER BY created_at LIMIT 1;
  IF v_admin IS NULL THEN RAISE EXCEPTION 'SMOKE_SETUP_FAILED: no active admin'; END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub',v_admin,'role','authenticated')::text, true);

  INSERT INTO customers (farm_name) VALUES ('[SMOKE] Recipe Farm '||v_sfx) RETURNING id INTO v_cust;
  INSERT INTO products (product_name, unit_size, current_cost, inventory_unit, rate_unit)
    VALUES ('[SMOKE] RP A '||v_sfx,'GL',12.50,'GL','PT') RETURNING id INTO v_pa;
  INSERT INTO products (product_name, unit_size, current_cost, inventory_unit, rate_unit)
    VALUES ('[SMOKE] RP B '||v_sfx,'GL',8.00,'GL','PT') RETURNING id INTO v_pb;
  INSERT INTO blend_recipes (name, recipe_type, created_by) VALUES ('[SMOKE] Recipe '||v_sfx,'generic',v_admin) RETURNING id INTO v_recipe;

  -- Item A: priced 1500c/unit. Item B: default price (0).
  INSERT INTO blend_recipe_items (recipe_id, product_id, product_name, quantity, unit, rate_per_acre, sort_order, price_per_unit_cents)
    VALUES (v_recipe, v_pa, '[SMOKE] RP A '||v_sfx, 5, 'GL', 1.0, 1, 1500);
  INSERT INTO blend_recipe_items (recipe_id, product_id, product_name, quantity, unit, rate_per_acre, sort_order)
    VALUES (v_recipe, v_pb, '[SMOKE] RP B '||v_sfx, 3, 'GL', 0.5, 2);

  INSERT INTO jobs (job_number, customer_id, status, job_date, created_by)
    VALUES ('[SMOKE] RJOB-'||v_sfx, v_cust, 'scheduled', CURRENT_DATE, v_admin) RETURNING id INTO v_job;

  v_res := load_recipe_into_job(v_job, v_recipe, '[SMOKE] lr-'||v_sfx);
  IF (v_res->>'items_loaded')::int <> 2 THEN RAISE EXCEPTION 'FAIL: items_loaded %', v_res; END IF;

  SELECT * INTO v_jc_a FROM job_chemicals WHERE job_id=v_job AND product_id=v_pa;
  IF v_jc_a.price_per_unit_cents <> 1500 THEN RAISE EXCEPTION 'FAIL: item A price % (expected 1500 from recipe)', v_jc_a.price_per_unit_cents; END IF;
  IF v_jc_a.cost_per_unit_cents <> 1250 THEN RAISE EXCEPTION 'FAIL: item A cost % (expected 1250)', v_jc_a.cost_per_unit_cents; END IF;

  SELECT * INTO v_jc_b FROM job_chemicals WHERE job_id=v_job AND product_id=v_pb;
  IF v_jc_b.price_per_unit_cents <> 0 THEN RAISE EXCEPTION 'FAIL: item B price % (expected 0 default)', v_jc_b.price_per_unit_cents; END IF;
  IF v_jc_b.cost_per_unit_cents <> 800 THEN RAISE EXCEPTION 'FAIL: item B cost % (expected 800)', v_jc_b.cost_per_unit_cents; END IF;

  -- Non-negative CHECK guards bad data
  BEGIN
    INSERT INTO blend_recipe_items (recipe_id, product_id, product_name, quantity, unit, sort_order, price_per_unit_cents)
      VALUES (v_recipe, v_pa, 'neg', 1, 'GL', 9, -1);
  EXCEPTION WHEN check_violation THEN v_caught := true;
  END;
  IF NOT v_caught THEN RAISE EXCEPTION 'FAIL: negative price was NOT rejected by the CHECK'; END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END $$;
