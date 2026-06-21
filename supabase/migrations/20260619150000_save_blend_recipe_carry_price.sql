-- idempotency-body-check: exempt
-- sql-safety: exempt-registry — blend_recipe_items.price_per_unit_cents is added
-- by this bundle's FIRST migration 20260618230000_recipe_per_unit_pricing.sql
-- (parked, not yet applied, so absent from the schema registry). The ordering-
-- guard DO block below RAISES if the column is missing, so this can never run
-- before the column exists. Not a B1 drift — a known bundle ordering.
-- ============================================================================
-- save_blend_recipe — carry blend_recipe_items.price_per_unit_cents through the
-- delete/reinsert (Phase 4 recipe-pricing BUNDLE, part 2 of 2).
-- ----------------------------------------------------------------------------
-- BUNDLE (apply together, in order):
--   1) 20260618230000_recipe_per_unit_pricing.sql  — adds
--      blend_recipe_items.price_per_unit_cents (bigint NOT NULL DEFAULT 0,
--      CHECK >= 0) and seeds it into load_recipe_into_job.
--   2) THIS migration — wires the new column through save_blend_recipe's
--      DELETE + reinsert. WITHOUT this, the live save_blend_recipe inserts recipe
--      items WITHOUT price_per_unit_cents, so any non-zero price resets to the
--      DEFAULT 0 on the next recipe edit/duplicate (Codex Phase-4 P2 data-loss).
--   (Frontend: src/pages/BlendRecipes.tsx adds the $/unit input + carries the
--    field through the editor load, the save p_items payload, AND the
--    client-side duplicate copy — shipped in the same commit as this migration.)
--
-- BASELINE: body below is the LIVE save_blend_recipe VERBATIM (live md5(prosrc)
--   cdfeb02d1641b59b934fe22eef6e1ea8, single overload, SECDEF,
--   search_path=public,pg_temp) EXCEPT the sentinel-delimited DELTA:recipe_price
--   (one non-negative validation + one extra INSERT column/value).
--
-- PARKED: do NOT apply without Mason's explicit OK (apply 20260618230000 first).
-- ============================================================================

-- Ordering guard: the column from 20260618230000 MUST already exist.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='blend_recipe_items'
      AND column_name='price_per_unit_cents'
  ) THEN
    RAISE EXCEPTION 'Apply 20260618230000_recipe_per_unit_pricing first: blend_recipe_items.price_per_unit_cents is missing';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.save_blend_recipe(p_recipe_id uuid, p_name text, p_recipe_type text, p_items jsonb, p_description text DEFAULT NULL::text, p_crop_type text DEFAULT NULL::text, p_timing text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor        uuid := auth.uid();
  v_recipe_id    uuid;
  v_existing     jsonb;
  v_result       jsonb;
  v_item         jsonb;
  v_item_count   int := 0;
  v_idx          int := 0;
  v_was_create   boolean := (p_recipe_id IS NULL);
  v_creator      uuid;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_name IS NULL OR p_name = '' THEN RAISE EXCEPTION 'NAME_REQUIRED'; END IF;
  IF p_recipe_type NOT IN ('generic', 'crop_specific') THEN RAISE EXCEPTION 'RECIPE_TYPE_INVALID'; END IF;
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN
    RAISE EXCEPTION 'ITEMS_INVALID';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'save_blend_recipe');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  IF v_was_create THEN
    INSERT INTO public.blend_recipes (
      name, description, recipe_type, crop_type, timing, created_by
    ) VALUES (
      trim(p_name), NULLIF(p_description, ''), p_recipe_type,
      CASE WHEN p_recipe_type = 'crop_specific' THEN NULLIF(p_crop_type, '') ELSE NULL END,
      CASE WHEN p_recipe_type = 'crop_specific' THEN NULLIF(p_timing, '') ELSE NULL END,
      v_actor
    )
    RETURNING id INTO v_recipe_id;
  ELSE
    SELECT created_by INTO v_creator FROM public.blend_recipes WHERE id = p_recipe_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'RECIPE_NOT_FOUND'; END IF;
    IF NOT (is_admin() OR v_creator = v_actor) THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;

    UPDATE public.blend_recipes SET
      name = trim(p_name),
      description = NULLIF(p_description, ''),
      recipe_type = p_recipe_type,
      crop_type = CASE WHEN p_recipe_type = 'crop_specific' THEN NULLIF(p_crop_type, '') ELSE NULL END,
      timing = CASE WHEN p_recipe_type = 'crop_specific' THEN NULLIF(p_timing, '') ELSE NULL END,
      updated_at = now()
    WHERE id = p_recipe_id;

    DELETE FROM public.blend_recipe_items WHERE recipe_id = p_recipe_id;
    v_recipe_id := p_recipe_id;
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    IF (v_item->>'product_id') IS NULL THEN
      RAISE EXCEPTION 'ITEM_INVALID: product_id required';
    END IF;
    IF (v_item->>'quantity') IS NULL OR (v_item->>'quantity')::numeric <= 0 THEN
      RAISE EXCEPTION 'ITEM_INVALID: quantity must be > 0';
    END IF;
    -- >>> DELTA:recipe_price (Phase 4 bundle): validate the optional per-unit
    -- price (money is non-negative bigint cents; the column CHECK also enforces
    -- this, but we fail loud + early with a clear token).
    IF (v_item->>'price_per_unit_cents') IS NOT NULL
       AND (v_item->>'price_per_unit_cents')::bigint < 0 THEN
      RAISE EXCEPTION 'ITEM_INVALID: price_per_unit_cents must be >= 0';
    END IF;
    -- <<< DELTA:recipe_price

    INSERT INTO public.blend_recipe_items (
      recipe_id, product_id, product_name, quantity, unit,
      -- >>> DELTA:recipe_price: carry price_per_unit_cents so a set price is NOT
      -- wiped on edit/duplicate (live body omitted this column -> reset to 0).
      rate_per_acre, price_per_unit_cents, sort_order, notes
    ) VALUES (
      v_recipe_id,
      (v_item->>'product_id')::uuid,
      COALESCE(v_item->>'product_name', ''),
      (v_item->>'quantity')::numeric,
      COALESCE(NULLIF(v_item->>'unit', ''), 'gal'),
      NULLIF(v_item->>'rate_per_acre', '')::numeric,
      COALESCE((v_item->>'price_per_unit_cents')::bigint, 0),
      -- <<< DELTA:recipe_price
      v_idx,
      NULLIF(v_item->>'notes', '')
    );
    v_idx := v_idx + 1;
    v_item_count := v_item_count + 1;
  END LOOP;

  v_result := jsonb_build_object(
    'success', true, 'recipe_id', v_recipe_id,
    'created', v_was_create, 'item_count', v_item_count
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'save_blend_recipe', v_result);
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
  SELECT count(*) INTO v_count
  FROM pg_proc WHERE proname='save_blend_recipe' AND pronamespace='public'::regnamespace;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'save_blend_recipe overload count = %, expected 1', v_count;
  END IF;

  SELECT prosrc INTO v_src
  FROM pg_proc WHERE proname='save_blend_recipe' AND pronamespace='public'::regnamespace;

  IF v_src NOT LIKE '%DELTA:recipe_price%'
     OR v_src NOT LIKE '%price_per_unit_cents%' THEN
    RAISE EXCEPTION 'save_blend_recipe: price_per_unit_cents wiring missing';
  END IF;

  -- SECDEF + search_path retained
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE proname='save_blend_recipe' AND pronamespace='public'::regnamespace
      AND prosecdef AND array_to_string(proconfig, ',') LIKE '%search_path%'
  ) THEN
    RAISE EXCEPTION 'save_blend_recipe must be SECURITY DEFINER with search_path';
  END IF;
END $$;
