-- ============================================================================
-- ROLLED-BACK smoke test for inventory_cost_report_column_fix
-- ----------------------------------------------------------------------------
-- Verifies the 42703 fix in get_inventory_cost_report(): the dead
-- `pr.deleted_at IS NULL` filter (products has no such column) is replaced
-- with the real soft-delete mechanism `pr.is_active = true`.
--
-- HOW TO RUN: execute this whole file as a SINGLE statement (Supabase MCP
-- execute_sql, or psql -1) as postgres/service_role AFTER the migration is
-- applied. The block ALWAYS ends with RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK',
-- so every fixture created here is rolled back — nothing persists. Any other
-- exception text = a real failure. (Run BEFORE the migration it fails
-- deterministically at scenario (a) with the undefined_column message.)
--
-- Auth: the fn role-gates on auth.uid() (profiles admin/sales_rep + is_active),
-- so request.jwt.claims is injected via set_config(..., is_local => true)
-- using a real active admin profile id looked up at runtime. Direct fixture
-- INSERTs bypass RLS because we run as the table owner; the RPC under test
-- still enforces its own gate.
--
-- Scenarios:
--   (a) get_inventory_cost_report() runs and returns rows WITHOUT 42703
--   (b) active [SMOKE] product with an inventory row appears with correct
--       computed values (qty / prebooked / net / unit_cost / total / reorder /
--       below_reorder)
--   (c) soft-deleted-equivalent product (is_active = false, WITH an inventory
--       row so the exclusion is not vacuous) is EXCLUDED per the corrected
--       filter
--   (d) active product with NO inventory row still appears with COALESCE'd
--       zeros (LEFT JOIN semantics preserved — body still verbatim)
--   (e) role gate intact: a non-profile sub gets 'Access denied%' (the fix
--       did not disturb the gate)
--
-- DRY-VALIDATED CATALOG REFERENCES (the 42703 discipline) — every reference
-- below was checked against the live catalog (rhyzpcqhnizqbxphqdkr,
-- 2026-06-10) via information_schema.columns / pg_proc / pg_trigger:
--   profiles:  id, role, is_active, created_at
--   products:  id, product_name, current_cost, tier1_price, unit_size,
--              is_active (boolean NOT NULL DEFAULT true; product_name is the
--              only required insert column)
--   inventory: product_id, quantity_available, quantity_prebooked,
--              reorder_point (location defaults 'Main Warehouse'; all
--              quantities default 0)
--   function:  public.get_inventory_cost_report() — 0 args, single overload,
--              OUT columns product_id, product_name, sku, category, vendor,
--              quantity_available, quantity_prebooked, net_available,
--              unit_cost, total_cost_value, reorder_point, below_reorder
--   builtins:  set_config, json_build_object, gen_random_uuid, md5, random
--   fixture-safety triggers verified: trg_validate_product_units (no-op when
--   product_form IS NULL — ours is), trigger_calculate_prices_from_margin
--   (BEFORE INSERT; computes prices from margins — we assert against the
--   stored current_cost, not the literal, to stay immune),
--   trg_inventory_significant_change (AFTER UPDATE ONLY — our INSERTs never
--   fire it)
-- ============================================================================

DO $smoke$
DECLARE
  v_admin uuid;
  v_prod_active uuid;
  v_prod_inactive uuid;
  v_prod_noinv uuid;
  v_cost_active numeric;
  v_cost_noinv numeric;
  v_suffix text := substr(md5(random()::text), 1, 8);
  v_rows int;
  v_err text;
  r record;
BEGIN
  -- --------------------------------------------------------------------
  -- 0. Auth as a real active admin (fn gates on auth.uid() role)
  -- --------------------------------------------------------------------
  SELECT id INTO v_admin FROM profiles
  WHERE role = 'admin' AND is_active = true
  ORDER BY created_at LIMIT 1;
  IF v_admin IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: no active admin profile found';
  END IF;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);

  -- --------------------------------------------------------------------
  -- 1. Synthetic fixtures (txn-local; rolled back at the end)
  -- --------------------------------------------------------------------
  -- Active product + inventory row (the must-appear case)
  INSERT INTO products (product_name, current_cost, tier1_price, unit_size)
  VALUES ('[SMOKE] Cost Report Active ' || v_suffix, 4.25, 8.50, 'gal')
  RETURNING id INTO v_prod_active;
  SELECT current_cost INTO v_cost_active FROM products WHERE id = v_prod_active;

  INSERT INTO inventory (product_id, quantity_available, quantity_prebooked, reorder_point)
  VALUES (v_prod_active, 10, 4, 20);

  -- Soft-deleted-equivalent product (is_active = false) + inventory row,
  -- so its exclusion below is proven non-vacuous
  INSERT INTO products (product_name, current_cost, tier1_price, unit_size, is_active)
  VALUES ('[SMOKE] Cost Report Inactive ' || v_suffix, 7, 14, 'gal', false)
  RETURNING id INTO v_prod_inactive;

  INSERT INTO inventory (product_id, quantity_available, quantity_prebooked, reorder_point)
  VALUES (v_prod_inactive, 99, 0, 1);

  IF NOT EXISTS (SELECT 1 FROM products WHERE id = v_prod_inactive AND is_active = false) THEN
    RAISE EXCEPTION 'SMOKE_SETUP: inactive fixture did not persist is_active = false';
  END IF;

  -- Active product with NO inventory row (LEFT JOIN zeros case)
  INSERT INTO products (product_name, current_cost, tier1_price, unit_size)
  VALUES ('[SMOKE] Cost Report NoInv ' || v_suffix, 3, 6, 'gal')
  RETURNING id INTO v_prod_noinv;
  SELECT current_cost INTO v_cost_noinv FROM products WHERE id = v_prod_noinv;

  -- --------------------------------------------------------------------
  -- (a) The function runs without 42703 and returns rows
  -- --------------------------------------------------------------------
  BEGIN
    SELECT count(*) INTO v_rows FROM get_inventory_cost_report();
  EXCEPTION WHEN undefined_column THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (a) 42703 undefined_column still raised — migration not applied? %', SQLERRM;
  END;
  IF v_rows < 2 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (a) expected at least the 2 active [SMOKE] fixtures in the report, got % rows', v_rows;
  END IF;

  -- --------------------------------------------------------------------
  -- (b) Active fixture present with correct computed values
  -- --------------------------------------------------------------------
  SELECT * INTO r FROM get_inventory_cost_report() g WHERE g.product_id = v_prod_active;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (b) active [SMOKE] product missing from the report';
  END IF;
  IF r.quantity_available <> 10
     OR r.quantity_prebooked <> 4
     OR r.net_available <> 6
     OR r.unit_cost <> COALESCE(v_cost_active, 0)
     OR r.total_cost_value <> ROUND((10 * COALESCE(v_cost_active, 0))::numeric, 2)
     OR r.reorder_point <> 20
     OR r.below_reorder IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (b) wrong computed row: qa=% pb=% net=% cost=% total=% rp=% below=%',
      r.quantity_available, r.quantity_prebooked, r.net_available,
      r.unit_cost, r.total_cost_value, r.reorder_point, r.below_reorder;
  END IF;

  -- --------------------------------------------------------------------
  -- (c) Soft-deleted-equivalent (is_active = false) product is EXCLUDED
  -- --------------------------------------------------------------------
  SELECT count(*) INTO v_rows FROM get_inventory_cost_report() g WHERE g.product_id = v_prod_inactive;
  IF v_rows <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (c) soft-deleted (is_active=false) product leaked into the report (% rows)', v_rows;
  END IF;

  -- --------------------------------------------------------------------
  -- (d) Active product with no inventory row: LEFT JOIN zeros preserved
  -- --------------------------------------------------------------------
  SELECT * INTO r FROM get_inventory_cost_report() g WHERE g.product_id = v_prod_noinv;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (d) active product without inventory row missing — LEFT JOIN semantics broken';
  END IF;
  IF r.quantity_available <> 0
     OR r.quantity_prebooked <> 0
     OR r.net_available <> 0
     OR r.unit_cost <> COALESCE(v_cost_noinv, 0)
     OR r.total_cost_value <> 0
     OR r.reorder_point <> 0
     OR r.below_reorder IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (d) wrong zeros row: qa=% pb=% net=% cost=% total=% rp=% below=%',
      r.quantity_available, r.quantity_prebooked, r.net_available,
      r.unit_cost, r.total_cost_value, r.reorder_point, r.below_reorder;
  END IF;

  -- --------------------------------------------------------------------
  -- (e) Role gate intact: non-profile sub -> 'Access denied%'
  --     (sub-txn rollback restores the admin claims automatically)
  -- --------------------------------------------------------------------
  BEGIN
    PERFORM set_config('request.jwt.claims',
      json_build_object('sub', gen_random_uuid(), 'role', 'authenticated')::text, true);
    PERFORM count(*) FROM get_inventory_cost_report();
    RAISE EXCEPTION 'SMOKE_FAIL: (e) role gate did not fire for a non-profile sub';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'Access denied%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: (e) expected Access denied, got: %', v_err;
    END IF;
  END;

  -- --------------------------------------------------------------------
  -- All scenarios passed — force rollback of everything above.
  -- --------------------------------------------------------------------
  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END $smoke$;
