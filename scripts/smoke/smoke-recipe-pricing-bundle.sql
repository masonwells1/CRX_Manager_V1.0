-- ============================================================================
-- SMOKE TEST (rolled back by design): recipe-pricing BUNDLE
--   20260618230000_recipe_per_unit_pricing.sql  (column + load_recipe_into_job)
-- + 20260619150000_save_blend_recipe_carry_price.sql  (save_blend_recipe carry)
-- ----------------------------------------------------------------------------
-- Run AFTER applying BOTH migrations. Pre-apply it will FAIL (the live
-- save_blend_recipe drops the price column). Pre-apply validation this session
-- (2026-06-19): the column + both function bodies were stacked in a single
-- rolled-back transaction and raised SMOKE_PASS_ROLLBACK.
--
-- Proves the no-data-loss bundle:
--   1) save_blend_recipe persists a non-zero price_per_unit_cents on CREATE.
--   2) re-saving (EDIT) carrying the price does NOT wipe it (the live body
--      omitted the column -> reset to DEFAULT 0; Codex Phase-4 P2).
--   3) load_recipe_into_job seeds job_chemicals.price_per_unit_cents from it.
--   4) a negative price is rejected (ITEM_INVALID / non-neg CHECK).
--
-- Ends in RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK' — nothing commits.
-- ============================================================================
DO $smoke$
DECLARE
  v_admin uuid; v_sfx text := substr(gen_random_uuid()::text,1,8);
  v_prod uuid; v_cust uuid; v_recipe uuid; v_job uuid;
  v_res jsonb; v_price bigint; v_jc_price bigint; v_job_total bigint;
BEGIN
  SELECT id INTO v_admin FROM profiles WHERE role='admin' AND is_active=true ORDER BY created_at LIMIT 1;
  IF v_admin IS NULL THEN RAISE EXCEPTION 'SMOKE_SETUP: no admin'; END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role','authenticated')::text, true);

  INSERT INTO products (product_name, unit_size) VALUES ('[SMOKE] RecipeProd '||v_sfx, 'gal') RETURNING id INTO v_prod;
  INSERT INTO customers (farm_name) VALUES ('[SMOKE] RecipeFarm '||v_sfx) RETURNING id INTO v_cust;

  -- 1) create with a $15.00 (1500c) price -> persisted
  v_res := save_blend_recipe(NULL, '[SMOKE] Recipe '||v_sfx, 'generic',
    jsonb_build_array(jsonb_build_object('product_id', v_prod, 'product_name','[SMOKE] RecipeProd','quantity',2,'unit','gal','rate_per_acre',1.5,'price_per_unit_cents',1500)),
    NULL,NULL,NULL,NULL);
  v_recipe := (v_res->>'recipe_id')::uuid;
  SELECT price_per_unit_cents INTO v_price FROM blend_recipe_items WHERE recipe_id=v_recipe;
  IF v_price <> 1500 THEN RAISE EXCEPTION 'SMOKE_FAIL: price not saved (% exp 1500)', v_price; END IF;

  -- 2) edit (re-save) carrying price -> NOT wiped
  v_res := save_blend_recipe(v_recipe, '[SMOKE] Recipe '||v_sfx, 'generic',
    jsonb_build_array(jsonb_build_object('product_id', v_prod, 'product_name','[SMOKE] RecipeProd','quantity',2,'unit','gal','rate_per_acre',1.5,'price_per_unit_cents',1500)),
    NULL,NULL,NULL,NULL);
  SELECT price_per_unit_cents INTO v_price FROM blend_recipe_items WHERE recipe_id=v_recipe;
  IF v_price <> 1500 THEN RAISE EXCEPTION 'SMOKE_FAIL: price wiped on edit (% exp 1500)', v_price; END IF;

  -- 3) load_recipe_into_job seeds job_chemicals.price_per_unit_cents AND re-rolls
  --    the job total from the priced chemicals (Codex P1) — the stale 99999 below
  --    must be replaced by 1500 x 2 = 3000.
  INSERT INTO jobs (job_number, customer_id, status, job_date, total_price_cents, created_by)
    VALUES ('[SMOKE] RJOB-'||v_sfx, v_cust, 'scheduled', CURRENT_DATE, 99999, v_admin) RETURNING id INTO v_job;
  PERFORM load_recipe_into_job(v_job, v_recipe, NULL);
  SELECT price_per_unit_cents INTO v_jc_price FROM job_chemicals WHERE job_id=v_job AND product_id=v_prod;
  IF v_jc_price <> 1500 THEN RAISE EXCEPTION 'SMOKE_FAIL: load_recipe did not seed price (% exp 1500)', v_jc_price; END IF;
  SELECT total_price_cents INTO v_job_total FROM jobs WHERE id=v_job;
  IF v_job_total <> 3000 THEN RAISE EXCEPTION 'SMOKE_FAIL: job total not re-rolled from priced recipe (% exp 3000)', v_job_total; END IF;

  -- 4) negative price rejected
  BEGIN
    PERFORM save_blend_recipe(NULL, '[SMOKE] Neg '||v_sfx, 'generic',
      jsonb_build_array(jsonb_build_object('product_id', v_prod, 'quantity', 1, 'price_per_unit_cents', -5)), NULL,NULL,NULL,NULL);
    RAISE EXCEPTION 'SMOKE_FAIL: negative price was ALLOWED';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'ITEM_INVALID%' AND SQLERRM NOT LIKE '%nonneg%' AND SQLERRM NOT LIKE '%check%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: expected price rejection, got %', SQLERRM; END IF;
  END;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END $smoke$;
