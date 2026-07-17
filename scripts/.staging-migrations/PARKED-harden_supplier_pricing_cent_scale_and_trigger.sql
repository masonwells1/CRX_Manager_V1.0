-- DRAFT ONLY — Supplier Pricing Phase 1a CodeRabbit forward correction.
--
-- PARKED: do not copy to supabase/migrations or apply until ALL of the
-- following are true:
--   1. The applied files
--      20260717112011_supplier_pricing_zero_cost_guard.sql and
--      20260717171331_restore_legacy_pricing_version_compat.sql remain
--      unchanged as immutable production history.
--   2. The live calculator body and pricing-version trigger are re-verified.
--   3. The staged Phase 1a cutover retains the same cent-scale guard so a
--      later promotion cannot overwrite this correction.
--   4. This exact SQL receives fresh migration-review and apply-guard proof.
--   5. Mason authorizes the live apply in the current conversation (unless a
--      separately pre-authorized hands-free run is armed and passes its gate).
--   6. Before promotion, create the active migration with a fresh timestamp
--      strictly greater than the then-current live high-water (verified as
--      `20260717171331` when this draft was written). This parked filename is
--      never a ledger identity.
--
-- CodeRabbit findings closed by this forward-only draft:
--   * reject positive sub-cent and all other non-cent-scale costs before any
--     pricing branch can round them into different money values;
--   * fail closed unless the pricing-version trigger is enabled for origin or
--     always firing (pg_trigger.tgenabled IN ('O', 'A')).
-- Sol adversarial-review finding closed by this forward-only draft:
--   * make preview/apply per-acre effects mirror the existing tier-2/3 zero
--     sentinel fallback enforced by recalc_product_price_per_acre().

DO $preflight$
DECLARE
  v_overload_count integer;
  v_body_md5 text;
BEGIN
  SELECT
    count(*),
    max(
      CASE
        WHEN p.oid = to_regprocedure(
          'public._calculate_product_pricing(text,numeric,numeric,numeric,numeric,numeric,numeric,numeric)'
        ) THEN md5(p.prosrc)
        ELSE NULL
      END
    )
  INTO v_overload_count, v_body_md5
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = '_calculate_product_pricing';

  -- The trusted live apply and byte-identical repository replay differ only
  -- in wrapper-preserved body whitespace, so accept their two exact prosrc
  -- hashes and no other calculator baseline.
  IF v_overload_count <> 1
     OR v_body_md5 NOT IN (
       '2dfc7733ee31aa82899473db7e8dbfe0',
       '170b717e06531cf808090cfb50a27dee'
     ) THEN
    RAISE EXCEPTION 'PRICING_CALCULATOR_BASELINE_MISMATCH';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger t
    WHERE t.tgrelid = 'public.products'::regclass
      AND t.tgname = 'trigger_z_guard_version_product_pricing'
      AND NOT t.tgisinternal
      AND t.tgenabled IN ('O', 'A')
      AND t.tgfoid = to_regprocedure(
        'public.guard_and_version_product_pricing()'
      )
  ) THEN
    RAISE EXCEPTION 'PHASE1A_PRICING_VERSION_COMPAT_TRIGGER_INVALID';
  END IF;
END;
$preflight$;

CREATE OR REPLACE FUNCTION public._calculate_product_pricing(
  p_mode text,
  p_current_cost numeric,
  p_tier1_margin numeric,
  p_tier2_margin numeric,
  p_tier3_margin numeric,
  p_tier1_price numeric,
  p_tier2_price numeric,
  p_tier3_price numeric
)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_t1_margin numeric := p_tier1_margin;
  v_t2_margin numeric := p_tier2_margin;
  v_t3_margin numeric := p_tier3_margin;
  v_t1_price numeric := p_tier1_price;
  v_t2_price numeric := p_tier2_price;
  v_t3_price numeric := p_tier3_price;
  v_t1_gross numeric;
  v_t2_gross numeric;
  v_t3_gross numeric;
BEGIN
  IF p_mode NOT IN ('legacy_margin', 'margin_driven', 'price_driven') THEN
    RAISE EXCEPTION 'PRICING_MODE_INVALID';
  END IF;
  IF (p_mode <> 'legacy_margin' AND p_current_cost IS NULL)
     OR p_current_cost::text IN ('NaN', 'Infinity', '-Infinity')
     OR p_current_cost < 0
     OR round(p_current_cost, 2) IS DISTINCT FROM p_current_cost
     OR (p_mode = 'margin_driven' AND p_current_cost = 0) THEN
    RAISE EXCEPTION 'PRICING_COST_INVALID';
  END IF;

  IF p_mode IN ('legacy_margin', 'margin_driven') THEN
    IF p_mode = 'margin_driven' AND (
      v_t1_margin IS NULL OR v_t2_margin IS NULL OR v_t3_margin IS NULL
      OR v_t1_margin::text IN ('NaN', 'Infinity', '-Infinity')
      OR v_t2_margin::text IN ('NaN', 'Infinity', '-Infinity')
      OR v_t3_margin::text IN ('NaN', 'Infinity', '-Infinity')
      OR v_t1_margin < 0 OR v_t1_margin >= 1
      OR v_t2_margin < 0 OR v_t2_margin >= 1
      OR v_t3_margin < 0 OR v_t3_margin >= 1
    ) THEN
      RAISE EXCEPTION 'PRICING_MARGIN_INVALID';
    END IF;

    -- legacy_margin deliberately preserves the exact pre-Phase-1a behavior:
    -- only positive margins on a positive cost overwrite the matching price.
    IF (p_mode = 'margin_driven' OR p_current_cost > 0)
       AND v_t1_margin IS NOT NULL AND v_t1_margin >= 0 AND v_t1_margin < 1
       AND (p_mode = 'margin_driven' OR v_t1_margin > 0) THEN
      v_t1_price := round(p_current_cost / (1 - v_t1_margin), 2);
      v_t1_gross := CASE WHEN v_t1_margin = 1 THEN NULL
                         ELSE round(v_t1_margin / (1 - v_t1_margin), 4) END;
    ELSE
      v_t1_gross := NULL;
    END IF;
    IF (p_mode = 'margin_driven' OR p_current_cost > 0)
       AND v_t2_margin IS NOT NULL AND v_t2_margin >= 0 AND v_t2_margin < 1
       AND (p_mode = 'margin_driven' OR v_t2_margin > 0) THEN
      v_t2_price := round(p_current_cost / (1 - v_t2_margin), 2);
      v_t2_gross := CASE WHEN v_t2_margin = 1 THEN NULL
                         ELSE round(v_t2_margin / (1 - v_t2_margin), 4) END;
    ELSE
      v_t2_gross := NULL;
    END IF;
    IF (p_mode = 'margin_driven' OR p_current_cost > 0)
       AND v_t3_margin IS NOT NULL AND v_t3_margin >= 0 AND v_t3_margin < 1
       AND (p_mode = 'margin_driven' OR v_t3_margin > 0) THEN
      v_t3_price := round(p_current_cost / (1 - v_t3_margin), 2);
      v_t3_gross := CASE WHEN v_t3_margin = 1 THEN NULL
                         ELSE round(v_t3_margin / (1 - v_t3_margin), 4) END;
    ELSE
      v_t3_gross := NULL;
    END IF;
  ELSE
    IF v_t1_price IS NULL OR v_t2_price IS NULL OR v_t3_price IS NULL
       OR v_t1_price::text IN ('NaN', 'Infinity', '-Infinity')
       OR v_t2_price::text IN ('NaN', 'Infinity', '-Infinity')
       OR v_t3_price::text IN ('NaN', 'Infinity', '-Infinity')
       OR v_t1_price < 0 OR v_t2_price < 0 OR v_t3_price < 0
       OR round(v_t1_price, 2) IS DISTINCT FROM v_t1_price
       OR round(v_t2_price, 2) IS DISTINCT FROM v_t2_price
       OR round(v_t3_price, 2) IS DISTINCT FROM v_t3_price THEN
      RAISE EXCEPTION 'PRICING_PRICE_INVALID';
    END IF;
    IF (v_t1_price = 0 AND p_current_cost > 0)
       OR (v_t2_price = 0 AND p_current_cost > 0)
       OR (v_t3_price = 0 AND p_current_cost > 0) THEN
      RAISE EXCEPTION 'PRICING_ZERO_PRICE_BELOW_COST';
    END IF;

    v_t1_margin := CASE WHEN v_t1_price = 0 THEN 0
                        ELSE round((v_t1_price - p_current_cost) / v_t1_price, 8) END;
    v_t2_margin := CASE WHEN v_t2_price = 0 THEN 0
                        ELSE round((v_t2_price - p_current_cost) / v_t2_price, 8) END;
    v_t3_margin := CASE WHEN v_t3_price = 0 THEN 0
                        ELSE round((v_t3_price - p_current_cost) / v_t3_price, 8) END;
    v_t1_gross := CASE WHEN p_current_cost = 0 THEN NULL
                       ELSE round((v_t1_price - p_current_cost) / p_current_cost, 4) END;
    v_t2_gross := CASE WHEN p_current_cost = 0 THEN NULL
                       ELSE round((v_t2_price - p_current_cost) / p_current_cost, 4) END;
    v_t3_gross := CASE WHEN p_current_cost = 0 THEN NULL
                       ELSE round((v_t3_price - p_current_cost) / p_current_cost, 4) END;
  END IF;

  RETURN jsonb_build_object(
    'current_cost', p_current_cost,
    'tier1_margin', v_t1_margin,
    'tier2_margin', v_t2_margin,
    'tier3_margin', v_t3_margin,
    'tier1_price', v_t1_price,
    'tier2_price', v_t2_price,
    'tier3_price', v_t3_price,
    'tier1_gross_margin', v_t1_gross,
    'tier2_gross_margin', v_t2_gross,
    'tier3_gross_margin', v_t3_gross
  );
END;
$function$;

REVOKE ALL ON FUNCTION public._calculate_product_pricing(
  text, numeric, numeric, numeric, numeric, numeric, numeric, numeric
) FROM PUBLIC, anon, authenticated, service_role;

DO $assertions$
DECLARE
  v_cost numeric;
  v_mode text;
  v_rejected boolean;
  v_result jsonb;
BEGIN
  FOREACH v_cost IN ARRAY ARRAY[0.001::numeric, 1.001::numeric] LOOP
    FOREACH v_mode IN ARRAY ARRAY['legacy_margin', 'margin_driven', 'price_driven'] LOOP
      v_rejected := false;
      BEGIN
        PERFORM public._calculate_product_pricing(
          v_mode, v_cost,
          0.20, 0.25, 0.30,
          10.00, 20.00, 30.00
        );
      EXCEPTION
        WHEN OTHERS THEN
          IF SQLERRM = 'PRICING_COST_INVALID' THEN
            v_rejected := true;
          ELSE
            RAISE;
          END IF;
      END;

      IF NOT v_rejected THEN
        RAISE EXCEPTION '% accepted non-cent-scale cost %', v_mode, v_cost;
      END IF;
    END LOOP;
  END LOOP;

  v_rejected := false;
  BEGIN
    PERFORM public._calculate_product_pricing(
      'margin_driven', 0,
      0.20, 0.25, 0.30,
      10.00, 20.00, 30.00
    );
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM = 'PRICING_COST_INVALID' THEN
        v_rejected := true;
      ELSE
        RAISE;
      END IF;
  END;

  IF NOT v_rejected THEN
    RAISE EXCEPTION 'margin-driven zero cost unexpectedly passed';
  END IF;

  v_result := public._calculate_product_pricing(
    'legacy_margin', 0,
    0.20, 0.25, 0.30,
    10.00, 20.00, 30.00
  );
  IF (v_result->>'tier1_price')::numeric IS DISTINCT FROM 10.00
     OR (v_result->>'tier2_price')::numeric IS DISTINCT FROM 20.00
     OR (v_result->>'tier3_price')::numeric IS DISTINCT FROM 30.00 THEN
    RAISE EXCEPTION 'legacy zero-cost pricing behavior changed';
  END IF;

  v_result := public._calculate_product_pricing(
    'margin_driven', 0.01,
    0.20, 0.25, 0.30,
    10.00, 20.00, 30.00
  );
  IF (v_result->>'current_cost')::numeric IS DISTINCT FROM 0.01
     OR (v_result->>'tier1_price')::numeric <= 0
     OR (v_result->>'tier2_price')::numeric <= 0
     OR (v_result->>'tier3_price')::numeric <= 0 THEN
    RAISE EXCEPTION 'valid one-cent margin-driven pricing changed';
  END IF;

  v_result := public._calculate_product_pricing(
    'price_driven', 0,
    NULL, NULL, NULL,
    10.00, 20.00, 30.00
  );
  IF (v_result->>'tier1_price')::numeric IS DISTINCT FROM 10.00
     OR (v_result->>'tier2_price')::numeric IS DISTINCT FROM 20.00
     OR (v_result->>'tier3_price')::numeric IS DISTINCT FROM 30.00 THEN
    RAISE EXCEPTION 'valid zero-cost price-driven behavior changed';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger t
    WHERE t.tgrelid = 'public.products'::regclass
      AND t.tgname = 'trigger_z_guard_version_product_pricing'
      AND NOT t.tgisinternal
      AND t.tgenabled IN ('O', 'A')
      AND t.tgfoid = to_regprocedure(
        'public.guard_and_version_product_pricing()'
      )
  ) THEN
    RAISE EXCEPTION 'PHASE1A_PRICING_VERSION_COMPAT_TRIGGER_INVALID';
  END IF;

  IF has_function_privilege(
       'anon',
       'public._calculate_product_pricing(text,numeric,numeric,numeric,numeric,numeric,numeric,numeric)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'authenticated',
       'public._calculate_product_pricing(text,numeric,numeric,numeric,numeric,numeric,numeric,numeric)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'service_role',
       'public._calculate_product_pricing(text,numeric,numeric,numeric,numeric,numeric,numeric,numeric)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'private pricing calculator execution grant survived';
  END IF;
END;
$assertions$;

-- The bootstrap migration is immutable production history. Patch the two
-- governed RPC definitions forward from their exact expected source shape so
-- an explicit tier-2/3 zero sentinel previews the same Tier-1-derived per-acre
-- value that the existing product trigger stores.
DO $per_acre_preview_fix$
DECLARE
  v_function regprocedure;
  v_definition text;
  v_old_tier2 constant text :=
    'public.product_price_per_acre((v_calc->>''tier2_price'')::numeric,';
  v_new_tier2 constant text :=
    'public.product_price_per_acre(COALESCE(NULLIF((v_calc->>''tier2_price'')::numeric, 0), (v_calc->>''tier1_price'')::numeric),';
  v_old_tier3 constant text :=
    'public.product_price_per_acre((v_calc->>''tier3_price'')::numeric,';
  v_new_tier3 constant text :=
    'public.product_price_per_acre(COALESCE(NULLIF((v_calc->>''tier3_price'')::numeric, 0), (v_calc->>''tier1_price'')::numeric),';
  v_occurrences integer;
BEGIN
  FOREACH v_function IN ARRAY ARRAY[
    to_regprocedure('public.preview_product_pricing_changes(text,uuid,jsonb,uuid,text)'),
    to_regprocedure('public.apply_product_pricing_change_set(uuid,text,uuid,text)')
  ] LOOP
    IF v_function IS NULL THEN
      RAISE EXCEPTION 'PHASE1A_PER_ACRE_RPC_BASELINE_MISSING';
    END IF;

    v_definition := pg_get_functiondef(v_function);
    v_occurrences := (
      length(v_definition) - length(replace(v_definition, v_old_tier2, ''))
    ) / length(v_old_tier2);
    IF v_occurrences <> 2 THEN
      RAISE EXCEPTION 'PHASE1A_TIER2_PER_ACRE_BASELINE_MISMATCH:%', v_function;
    END IF;

    v_occurrences := (
      length(v_definition) - length(replace(v_definition, v_old_tier3, ''))
    ) / length(v_old_tier3);
    IF v_occurrences <> 2 THEN
      RAISE EXCEPTION 'PHASE1A_TIER3_PER_ACRE_BASELINE_MISMATCH:%', v_function;
    END IF;

    v_definition := replace(v_definition, v_old_tier2, v_new_tier2);
    v_definition := replace(v_definition, v_old_tier3, v_new_tier3);
    EXECUTE v_definition;
  END LOOP;

  IF position(v_new_tier2 IN pg_get_functiondef(
       'public.preview_product_pricing_changes(text,uuid,jsonb,uuid,text)'::regprocedure
     )) = 0
     OR position(v_new_tier3 IN pg_get_functiondef(
       'public.preview_product_pricing_changes(text,uuid,jsonb,uuid,text)'::regprocedure
     )) = 0
     OR position(v_new_tier2 IN pg_get_functiondef(
       'public.apply_product_pricing_change_set(uuid,text,uuid,text)'::regprocedure
     )) = 0
     OR position(v_new_tier3 IN pg_get_functiondef(
       'public.apply_product_pricing_change_set(uuid,text,uuid,text)'::regprocedure
     )) = 0 THEN
    RAISE EXCEPTION 'PHASE1A_PER_ACRE_FORWARD_FIX_NOT_INSTALLED';
  END IF;
END;
$per_acre_preview_fix$;

-- Keep the export and import sides of the worksheet round-trip on the same
-- 5,000-row ceiling. create_pricing_workbook_export() updates row_count in the
-- same transaction after materializing the manifest, so this database invariant
-- rejects and atomically rolls back any oversized RPC export. The UI rejects the
-- request before the RPC for a plain-English owner-facing error.
ALTER TABLE public.pricing_workbook_exports
  DROP CONSTRAINT IF EXISTS pricing_workbook_exports_row_limit;
ALTER TABLE public.pricing_workbook_exports
  ADD CONSTRAINT pricing_workbook_exports_row_limit
  CHECK (row_count <= 5000);
