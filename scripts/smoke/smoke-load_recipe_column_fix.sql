-- ============================================================================
-- SMOKE TEST -- load_recipe_column_fix (load_recipe_into_job)
-- ============================================================================
-- Run AFTER applying scripts\.staging-migrations\load_recipe_column_fix.sql.
-- Single DO block; every write is rolled back by the terminal
-- RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK'. Success == that exact exception.
-- Any other exception (e.g. 42703 column p.cost_per_unit does not exist,
-- which is the pre-fix live failure verified 2026-06-11) == FAIL.
-- Fixtures are [SMOKE]-prefixed. Auth via request.jwt.claims with a real
-- ACTIVE ADMIN profile id looked up at runtime (verified live 2026-06-11
-- that active admins exist, e.g. 0b03fc35-49b5-454c-b7ca-eb56b20e8a5e).
-- ============================================================================

DO $smoke$
DECLARE
  v_admin    uuid;
  v_customer uuid;
  v_job      uuid;
  v_recipe   uuid;
  v_prod_a   uuid;
  v_prod_b   uuid;
  v_result   jsonb;
  v_replay   jsonb;
  v_key      text;
  v_cnt      integer;
  v_cost_a   bigint;
  v_cost_b   bigint;
  v_rate_u_a text;
  v_sort_a   integer;
  v_sort_b   integer;
BEGIN
  ------------------------------------------------------------------
  -- Auth: impersonate a real active admin (require_admin_or_sales_rep
  -- checks profiles.role/is_active against auth.uid() = jwt 'sub')
  ------------------------------------------------------------------
  SELECT id INTO v_admin
  FROM profiles
  WHERE role = 'admin' AND is_active = true
  ORDER BY created_at
  LIMIT 1;
  IF v_admin IS NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL: no active admin profile found';
  END IF;

  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text,
    true
  );

  ------------------------------------------------------------------
  -- Fixtures ([SMOKE]-prefixed, all rolled back)
  ------------------------------------------------------------------
  INSERT INTO customers (farm_name)
  VALUES ('[SMOKE] Recipe Column Fix Farm')
  RETURNING id INTO v_customer;

  -- current_cost in dollars/unit; expect *100 -> cents in job_chemicals
  INSERT INTO products (product_name, current_cost, inventory_unit, rate_unit, is_active)
  VALUES ('[SMOKE] Chem A', 12.50, 'gal', 'pt/acre', true)
  RETURNING id INTO v_prod_a;

  INSERT INTO products (product_name, current_cost, inventory_unit, rate_unit, is_active)
  VALUES ('[SMOKE] Chem B', 3.75, 'oz', 'oz/acre', true)
  RETURNING id INTO v_prod_b;

  INSERT INTO blend_recipes (name, description, created_by)
  VALUES ('[SMOKE] Blend Recipe', '[SMOKE] column-fix smoke', v_admin)
  RETURNING id INTO v_recipe;

  INSERT INTO blend_recipe_items (recipe_id, product_id, product_name, quantity, unit, rate_per_acre, sort_order)
  VALUES
    (v_recipe, v_prod_a, '[SMOKE] Chem A', 10,  'gal', 1.5, 1),
    (v_recipe, v_prod_b, '[SMOKE] Chem B', 4,   'oz',  0.5, 2);

  INSERT INTO jobs (job_number, customer_id, job_date, status, created_by)
  VALUES ('[SMOKE]-RCFIX-' || left(gen_random_uuid()::text, 8), v_customer, current_date, 'scheduled', v_admin)
  RETURNING id INTO v_job;

  ------------------------------------------------------------------
  -- Scenario: load recipe into job (exercises the fixed FOR-SELECT,
  -- the fixed ORDER BY, and the fixed INSERT ... v_item.sort_order)
  ------------------------------------------------------------------
  v_key := '[SMOKE]-rcfix-' || gen_random_uuid()::text;
  v_result := load_recipe_into_job(v_job, v_recipe, v_key);

  IF v_result IS NULL OR NOT COALESCE((v_result->>'success')::boolean, false) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: success flag not true: %', v_result;
  END IF;
  IF (v_result->>'items_loaded')::integer <> 2 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: expected items_loaded=2, got %', v_result->>'items_loaded';
  END IF;

  SELECT count(*) INTO v_cnt FROM job_chemicals WHERE job_id = v_job;
  IF v_cnt <> 2 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: expected 2 job_chemicals rows, found %', v_cnt;
  END IF;

  -- Correct costs: products.current_cost (dollars) * 100 -> cost_per_unit_cents
  SELECT cost_per_unit_cents, rate_unit, sort_order
    INTO v_cost_a, v_rate_u_a, v_sort_a
  FROM job_chemicals WHERE job_id = v_job AND product_id = v_prod_a;
  IF v_cost_a IS DISTINCT FROM 1250 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: Chem A cost_per_unit_cents expected 1250, got %', v_cost_a;
  END IF;
  IF v_rate_u_a IS DISTINCT FROM 'pt/acre' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: Chem A rate_unit expected pt/acre (from products.rate_unit), got %', v_rate_u_a;
  END IF;
  IF v_sort_a IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: Chem A sort_order expected 1, got %', v_sort_a;
  END IF;

  SELECT cost_per_unit_cents, sort_order
    INTO v_cost_b, v_sort_b
  FROM job_chemicals WHERE job_id = v_job AND product_id = v_prod_b;
  IF v_cost_b IS DISTINCT FROM 375 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: Chem B cost_per_unit_cents expected 375, got %', v_cost_b;
  END IF;
  IF v_sort_b IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: Chem B sort_order expected 2, got %', v_sort_b;
  END IF;

  -- price_per_unit_cents written as literal 0 by the function
  SELECT count(*) INTO v_cnt
  FROM job_chemicals
  WHERE job_id = v_job AND price_per_unit_cents IS DISTINCT FROM 0;
  IF v_cnt <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: % row(s) with price_per_unit_cents <> 0', v_cnt;
  END IF;

  -- Job linked to recipe
  IF (SELECT recipe_id FROM jobs WHERE id = v_job) IS DISTINCT FROM v_recipe THEN
    RAISE EXCEPTION 'SMOKE_FAIL: jobs.recipe_id not updated to fixture recipe';
  END IF;

  ------------------------------------------------------------------
  -- Idempotent replay: same key returns the cached result
  ------------------------------------------------------------------
  v_replay := load_recipe_into_job(v_job, v_recipe, v_key);
  IF v_replay IS DISTINCT FROM v_result THEN
    RAISE EXCEPTION 'SMOKE_FAIL: idempotent replay mismatch: % vs %', v_replay, v_result;
  END IF;

  ------------------------------------------------------------------
  -- All assertions passed; roll everything back
  ------------------------------------------------------------------
  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END
$smoke$;
