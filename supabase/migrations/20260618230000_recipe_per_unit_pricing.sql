-- idempotency-body-check: exempt
-- ============================================================================
-- Recipe per-unit pricing (Phase 4 of the As-Applied / Field-Invoice build)
-- ----------------------------------------------------------------------------
-- Gap G5 (docs/plans/2026-06-18-as-applied-application-invoices-plan.md):
-- load_recipe_into_job already seeds job_chemicals.cost_per_unit_cents from
-- products.current_cost, but HARD-CODES price_per_unit_cents = 0 — so every
-- recipe-loaded job arrives with $0 chemical prices and must be hand-priced
-- before it can be billed.
--
-- THIS MIGRATION (the "attempt a sensible model for Mason's review" of locked
-- decision #11) proposes the model that FITS the existing data path:
--   * Add an optional per-unit price to recipe items:
--       blend_recipe_items.price_per_unit_cents bigint NOT NULL DEFAULT 0
--       (CHECK >= 0 — money is non-negative bigint cents).
--   * load_recipe_into_job seeds job_chemicals.price_per_unit_cents from it
--     (instead of 0). Existing recipes keep price 0 (no behaviour change until
--     someone sets a recipe price), so this is purely ADDITIVE.
--
-- WHY per-unit (not the per-acre $/ac Mason floated): the field invoice already
-- prices CHEMICAL lines per unit (job_chemicals.price_per_unit_cents ->
-- invoice_items.unit_price_cents) and charges the per-ACRE machine work
-- separately via application_services / compute_application_service_fee. A
-- per-unit recipe price drops straight into that chemical-pricing slot and fixes
-- G5 with one line. A per-acre "recipe applied at $X/acre" price would need a
-- NEW billing path that overlaps the existing per-acre application fee — a
-- bigger design. >>> MASON DECISION: confirm per-unit (this) vs per-acre. <<<
--
-- This migration is PARKED — do NOT apply without Mason's explicit OK.
--
-- !!! DO NOT APPLY THIS MIGRATION ALONE !!! (Codex Phase-4 review, P2 — a real
-- data-loss path once non-zero prices exist.) Recipe pricing must land as a
-- BUNDLE, because the current recipe-save path would WIPE a set price:
--   * src/pages/BlendRecipes.tsx strips fields before calling save_blend_recipe, and
--   * save_blend_recipe DELETEs + reinserts recipe items WITHOUT this column,
--     so any non-zero price_per_unit_cents resets to the DEFAULT 0 on the next
--     recipe edit/duplicate.
-- BEFORE/WITH applying this migration, the follow-up MUST also: (a) wire
-- price_per_unit_cents through save_blend_recipe's delete/reinsert, and (b) add
-- the recipe-editor price input (which is also what lets anyone SET a price).
-- Until that bundle is built, this migration is harmless (no UI/backfill can
-- create a non-zero price), so it stays staged.
--
-- EVIDENCE (live, project rhyzpcqhnizqbxphqdkr, 2026-06-18):
--   * blend_recipe_items has NO price column today (cols: id, recipe_id,
--     product_id, product_name, quantity, unit, rate_per_acre, sort_order,
--     notes, created_at).
--   * load_recipe_into_job(uuid,uuid,text) pre-change md5(prosrc) =
--     d9aabca6daefc03ecac6393bb029a954 (single overload, SECDEF,
--     search_path=public,pg_temp). Body reproduced verbatim below except the
--     single price-seed delta (DELTA:recipe_price).
--   * The loop selects `bri.*`, so v_item.price_per_unit_cents is in scope once
--     the column exists.
-- ============================================================================

-- 1) Additive column: per-unit price on a recipe item (cents, non-negative).
ALTER TABLE public.blend_recipe_items
  ADD COLUMN IF NOT EXISTS price_per_unit_cents bigint NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.blend_recipe_items'::regclass
      AND conname = 'blend_recipe_items_price_nonneg'
  ) THEN
    ALTER TABLE public.blend_recipe_items
      ADD CONSTRAINT blend_recipe_items_price_nonneg CHECK (price_per_unit_cents >= 0);
  END IF;
END $$;

-- 2) Seed the price into the job when a recipe is loaded (verbatim-from-live
--    body; only DELTA:recipe_price changes the hard-coded 0).
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
    -- >>> DELTA:recipe_price (Phase 4): seed price_per_unit_cents from the recipe
    -- item instead of the hard-coded 0 (G5). Existing recipes default 0, so this
    -- is behaviour-preserving until a recipe price is set. Live literal was `0`.
      COALESCE(v_item.cost_per_unit * 100, 0)::bigint, COALESCE(v_item.price_per_unit_cents, 0), v_item.sort_order);
    -- <<< DELTA:recipe_price
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

-- ============================================================================
-- SELF-VERIFICATION — raises (rolling back the migration) on any failure.
-- ============================================================================
DO $$
DECLARE
  v_count int;
  v_src text;
BEGIN
  -- Column present + non-negative CHECK present
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='blend_recipe_items'
      AND column_name='price_per_unit_cents' AND data_type='bigint'
  ) THEN
    RAISE EXCEPTION 'blend_recipe_items.price_per_unit_cents (bigint) missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='public.blend_recipe_items'::regclass
      AND conname='blend_recipe_items_price_nonneg'
  ) THEN
    RAISE EXCEPTION 'blend_recipe_items_price_nonneg CHECK missing';
  END IF;

  -- Exactly one load_recipe_into_job overload
  SELECT count(*) INTO v_count
  FROM pg_proc WHERE proname='load_recipe_into_job' AND pronamespace='public'::regnamespace;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'load_recipe_into_job overload count = %, expected 1', v_count;
  END IF;

  SELECT prosrc INTO v_src
  FROM pg_proc WHERE proname='load_recipe_into_job' AND pronamespace='public'::regnamespace;

  -- Price seed now reads the recipe item (no longer the bare hard-coded 0)
  IF v_src NOT LIKE '%COALESCE(v_item.price_per_unit_cents, 0)%' THEN
    RAISE EXCEPTION 'load_recipe_into_job: price seed not wired to recipe price';
  END IF;
  IF v_src NOT LIKE '%DELTA:recipe_price%' THEN
    RAISE EXCEPTION 'load_recipe_into_job: DELTA:recipe_price sentinel missing';
  END IF;

  -- SECDEF + search_path retained
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE proname='load_recipe_into_job' AND pronamespace='public'::regnamespace
      AND prosecdef AND array_to_string(proconfig, ',') LIKE '%search_path%'
  ) THEN
    RAISE EXCEPTION 'load_recipe_into_job must be SECURITY DEFINER with search_path';
  END IF;
END $$;
