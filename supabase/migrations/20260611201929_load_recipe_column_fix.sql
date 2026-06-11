-- ============================================================================
-- STAGING DRAFT (NOT YET A MIGRATION) -- load_recipe_column_fix
-- ============================================================================
-- Role:        DRAFT (read-only verification only; APPLY role stamps + moves
--              this file into supabase\migrations and executes it)
-- Drafted:     2026-06-11
-- Target:      public.load_recipe_into_job(p_job_id uuid, p_recipe_id uuid,
--              p_idempotency_key text DEFAULT NULL::text) RETURNS jsonb
-- Baseline:    md5(prosrc) = 8ab8d6090c7a06e5c062102614c32175
--              (live pg_proc, project rhyzpcqhnizqbxphqdkr, 2026-06-11,
--              single overload: load_recipe_into_job(uuid,uuid,text),
--              SECURITY DEFINER, search_path=public, pg_temp,
--              ACL: postgres/authenticated/service_role EXECUTE, no anon)
--
-- LIVE EVIDENCE (re-verified this session, 2026-06-11):
--   plpgsql_check_function_tb('load_recipe_into_job(uuid,uuid,text)'):
--     line 17, sqlstate 42703: column p.cost_per_unit does not exist
--     (cascade at line 22: "record v_item is not assigned yet" -- the FOR
--      query fails to plan, so the loop body was never checkable)
--
-- ROOT CAUSE: the FOR-loop SELECT and INSERT were written against column
-- names that do not exist in the live catalog. Live names (verified via
-- information_schema 2026-06-11):
--   products:           current_cost (numeric, dollars/unit)  [no cost_per_unit]
--                       inventory_unit (text)                 [no unit]
--                       rate_unit (text)
--   blend_recipe_items: sort_order (integer)                  [no sequence_order]
--                       (no rate_unit column at all)
--   job_chemicals:      cost_per_unit_cents (bigint), price_per_unit_cents
--                       (bigint), rate_unit (text, nullable), sort_order (int)
--
-- FIX: verbatim live body + 3 sentinel-delimited deltas. Original lines
-- (kept OUT of the function body so the self-verify NOT-LIKE checks hold):
--   DELTA 1 WAS: SELECT bri.*, p.cost_per_unit, p.unit AS product_unit
--   DELTA 1 NOW: SELECT bri.*, p.current_cost AS cost_per_unit,
--                p.inventory_unit AS product_unit, p.rate_unit
--                (alias keeps v_item.cost_per_unit working unchanged;
--                 p.rate_unit is REQUIRED: bri has no rate_unit, so the
--                 later v_item.rate_unit reference would be a record-field
--                 error -- products.rate_unit is the unit paired with
--                 rate_per_acre)
--   DELTA 2 WAS: WHERE bri.recipe_id = p_recipe_id ORDER BY bri.sequence_order
--   DELTA 2 NOW: WHERE bri.recipe_id = p_recipe_id ORDER BY bri.sort_order
--   DELTA 3 WAS:   COALESCE(v_item.cost_per_unit * 100, 0)::bigint, 0, v_item.sequence_order);
--   DELTA 3 NOW:   COALESCE(v_item.cost_per_unit * 100, 0)::bigint, 0, v_item.sort_order);
-- Cost math preserved verbatim: current_cost dollars * 100 -> bigint cents
-- (numeric->bigint cast rounds half away from zero, as in baseline intent).
-- Dry-validation: the fixed FOR-SELECT was executed live (LIMIT 0) and
-- plans cleanly; every referenced table/column/function checked against
-- the live catalog this session.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.load_recipe_into_job(p_job_id uuid, p_recipe_id uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_count integer := 0;
  v_item RECORD;
  v_existing jsonb;
  v_result jsonb;
BEGIN
  PERFORM require_admin_or_sales_rep();
  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'load_recipe_into_job');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM jobs WHERE id = p_job_id AND status IN ('scheduled', 'in_progress')) THEN
    RAISE EXCEPTION 'Job not found or not editable';
  END IF;
  DELETE FROM job_chemicals WHERE job_id = p_job_id;
  FOR v_item IN
    -- >>> DELTA:load_recipe_column_fix:1
    SELECT bri.*, p.current_cost AS cost_per_unit, p.inventory_unit AS product_unit, p.rate_unit
    -- <<< DELTA:load_recipe_column_fix:1
    FROM blend_recipe_items bri JOIN products p ON p.id = bri.product_id
    -- >>> DELTA:load_recipe_column_fix:2
    WHERE bri.recipe_id = p_recipe_id ORDER BY bri.sort_order
    -- <<< DELTA:load_recipe_column_fix:2
  LOOP
    INSERT INTO job_chemicals (job_id, product_id, quantity, unit, rate_per_acre, rate_unit, cost_per_unit_cents, price_per_unit_cents, sort_order)
    VALUES (p_job_id, v_item.product_id, v_item.quantity, v_item.unit, v_item.rate_per_acre, v_item.rate_unit,
    -- >>> DELTA:load_recipe_column_fix:3
      COALESCE(v_item.cost_per_unit * 100, 0)::bigint, 0, v_item.sort_order);
    -- <<< DELTA:load_recipe_column_fix:3
    v_count := v_count + 1;
  END LOOP;
  UPDATE jobs SET recipe_id = p_recipe_id WHERE id = p_job_id;
  v_result := jsonb_build_object('success', true, 'items_loaded', v_count);
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'load_recipe_into_job', v_result);
  END IF;
  RETURN v_result;
END;
$function$;

-- Grants asserted to match live ACL exactly
-- (CREATE OR REPLACE preserves the ACL, but assert explicitly):
REVOKE ALL ON FUNCTION public.load_recipe_into_job(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.load_recipe_into_job(uuid, uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.load_recipe_into_job(uuid, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.load_recipe_into_job(uuid, uuid, text) TO service_role;

-- ============================================================================
-- SELF-VERIFICATION
-- ============================================================================
DO $verify$
DECLARE
  v_cnt     integer;
  v_src     text;
  v_md5     text;
  v_secdef  boolean;
  v_cfg     text[];
  v_errs    integer;
BEGIN
  -- 1. Exactly one overload survives
  SELECT count(*) INTO v_cnt
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'load_recipe_into_job';
  IF v_cnt <> 1 THEN
    RAISE EXCEPTION 'VERIFY FAIL: expected 1 overload of load_recipe_into_job, found %', v_cnt;
  END IF;

  SELECT prosrc, md5(prosrc), prosecdef, proconfig
    INTO v_src, v_md5, v_secdef, v_cfg
  FROM pg_proc
  WHERE oid = 'public.load_recipe_into_job(uuid,uuid,text)'::regprocedure;

  -- 2. Body actually changed from the recorded baseline
  IF v_md5 = '8ab8d6090c7a06e5c062102614c32175' THEN
    RAISE EXCEPTION 'VERIFY FAIL: prosrc still at baseline md5 (function not replaced)';
  END IF;

  -- 3. All three sentinel delta markers present
  IF v_src NOT LIKE '%DELTA:load_recipe_column_fix:1%'
     OR v_src NOT LIKE '%DELTA:load_recipe_column_fix:2%'
     OR v_src NOT LIKE '%DELTA:load_recipe_column_fix:3%' THEN
    RAISE EXCEPTION 'VERIFY FAIL: missing sentinel delta marker(s)';
  END IF;

  -- 4. Fixed references present, broken references gone
  IF v_src NOT LIKE '%p.current_cost AS cost_per_unit%'
     OR v_src NOT LIKE '%ORDER BY bri.sort_order%'
     OR v_src NOT LIKE '%v_item.sort_order%' THEN
    RAISE EXCEPTION 'VERIFY FAIL: fixed column references not found in body';
  END IF;
  IF v_src LIKE '%p.cost_per_unit%'
     OR v_src LIKE '%sequence_order%'
     OR v_src LIKE '%p.unit AS product_unit%' THEN
    RAISE EXCEPTION 'VERIFY FAIL: stale broken column reference still in body';
  END IF;

  -- 5. SECURITY DEFINER + pinned search_path retained
  IF NOT v_secdef THEN
    RAISE EXCEPTION 'VERIFY FAIL: SECURITY DEFINER lost';
  END IF;
  IF v_cfg IS NULL OR NOT (v_cfg @> ARRAY['search_path=public, pg_temp']) THEN
    RAISE EXCEPTION 'VERIFY FAIL: SET search_path=public, pg_temp lost (got %)', v_cfg;
  END IF;

  -- 6. Grants match live ACL expectations
  IF NOT has_function_privilege('authenticated', 'public.load_recipe_into_job(uuid,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAIL: authenticated lost EXECUTE';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.load_recipe_into_job(uuid,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAIL: service_role lost EXECUTE';
  END IF;
  IF has_function_privilege('anon', 'public.load_recipe_into_job(uuid,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAIL: anon must not have EXECUTE';
  END IF;

  -- 7. plpgsql_check is now clean (skip gracefully if extension not resolvable)
  BEGIN
    SELECT count(*) INTO v_errs
    FROM plpgsql_check_function_tb('public.load_recipe_into_job(uuid,uuid,text)'::regprocedure)
    WHERE level = 'error';
    IF v_errs > 0 THEN
      RAISE EXCEPTION 'VERIFY FAIL: plpgsql_check still reports % error(s)', v_errs;
    END IF;
  EXCEPTION
    WHEN undefined_function THEN
      RAISE NOTICE 'VERIFY NOTE: plpgsql_check_function_tb not resolvable here; static check skipped';
  END;

  RAISE NOTICE 'VERIFY OK: load_recipe_into_job replaced (new md5 %), 3 deltas, grants intact, plpgsql_check clean', v_md5;
END
$verify$;
