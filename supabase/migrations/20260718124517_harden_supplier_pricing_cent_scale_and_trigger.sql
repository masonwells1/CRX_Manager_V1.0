-- Supplier Pricing Phase 1a forward correction.
--
-- Forward-only after the immutable production migrations through
-- 20260717171331_restore_legacy_pricing_version_compat. Live preflight on
-- 2026-07-18 confirmed the exact calculator/RPC baselines, enabled pricing
-- triggers, zero active previews/exports, 604 Products, and zero fractional-
-- cent costs. The migration fails closed if those conditions drift.
--
-- This additive correction is safe before frontend deployment. The separate
-- strict enforcement cutover remains parked until the frontend is deployed
-- and its rollback window closes.
--
-- CodeRabbit findings closed by this forward-only migration:
--   * reject positive sub-cent and all other non-cent-scale costs before any
--     pricing branch can round them into different money values;
--   * fail closed unless the pricing-version trigger is enabled for origin or
--     always firing (pg_trigger.tgenabled IN ('O', 'A')).
-- Sol adversarial-review finding closed by this forward-only migration:
--   * make preview/apply per-acre effects mirror the existing tier-2/3 zero
--     sentinel fallback enforced by recalc_product_price_per_acre().

DO $preflight$
DECLARE
  v_overload_count integer;
  v_body_md5 text;
  v_preview_overload_count integer;
  v_apply_overload_count integer;
  v_preview_body_md5 text;
  v_apply_body_md5 text;
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

  SELECT count(*), max(CASE WHEN p.oid = to_regprocedure(
    'public.preview_product_pricing_changes(text,uuid,jsonb,uuid,text)'
  ) THEN md5(replace(p.prosrc, E'\r\n', E'\n')) END)
  INTO v_preview_overload_count, v_preview_body_md5
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'preview_product_pricing_changes';
  IF v_preview_overload_count <> 1
     OR v_preview_body_md5 IS DISTINCT FROM '85772bb3e3d646e9eceafb591ec955b6' THEN
    RAISE EXCEPTION 'PHASE1A_PREVIEW_RPC_BASELINE_MISMATCH';
  END IF;

  SELECT count(*), max(CASE WHEN p.oid = to_regprocedure(
    'public.apply_product_pricing_change_set(uuid,text,uuid,text)'
  ) THEN md5(replace(p.prosrc, E'\r\n', E'\n')) END)
  INTO v_apply_overload_count, v_apply_body_md5
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'apply_product_pricing_change_set';
  IF v_apply_overload_count <> 1
     OR v_apply_body_md5 IS DISTINCT FROM 'be799fcbc7cceabcc2c5c59efe90a6ef' THEN
    RAISE EXCEPTION 'PHASE1A_APPLY_RPC_BASELINE_MISMATCH';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.oid = to_regprocedure(
      'public.preview_product_pricing_changes(text,uuid,jsonb,uuid,text)'
    )
      AND p.prosecdef
      AND p.prorettype = 'jsonb'::regtype
      AND p.pronargs = 5
      AND p.pronargdefaults = 4
      AND p.proconfig @> ARRAY['search_path=public, pg_temp']
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.oid = to_regprocedure(
      'public.apply_product_pricing_change_set(uuid,text,uuid,text)'
    )
      AND p.prosecdef
      AND p.prorettype = 'jsonb'::regtype
      AND p.pronargs = 4
      AND p.pronargdefaults = 2
      AND p.proconfig @> ARRAY['search_path=public, pg_temp']
  ) THEN
    RAISE EXCEPTION 'PHASE1A_RPC_PROPERTIES_INVALID';
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

  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger t
    WHERE t.tgrelid = 'public.products'::regclass
      AND t.tgname = 'trigger_recalc_product_price_per_acre'
      AND NOT t.tgisinternal
      AND t.tgenabled IN ('O', 'A')
      AND t.tgfoid = to_regprocedure('public.recalc_product_price_per_acre()')
  ) THEN
    RAISE EXCEPTION 'PHASE1A_PER_ACRE_TRIGGER_INVALID';
  END IF;

  IF 4 <> (
    SELECT count(*)
    FROM pg_attribute a
    WHERE a.attrelid = 'public.products'::regclass
      AND a.attname IN ('current_cost', 'tier1_price', 'tier2_price', 'tier3_price')
      AND NOT a.attisdropped
      AND format_type(a.atttypid, a.atttypmod) = 'numeric'
  ) THEN
    RAISE EXCEPTION 'PHASE1A_PRODUCT_DOLLAR_COLUMN_TYPES_INVALID';
  END IF;

  IF 11 <> (
    SELECT count(*)
    FROM pg_attribute a
    WHERE a.attrelid = 'public.pricing_change_set_rows'::regclass
      AND a.attname IN (
        'input_cost_cents', 'input_tier1_price_cents',
        'input_tier2_price_cents', 'input_tier3_price_cents',
        'output_cost_cents', 'output_tier1_price_cents',
        'output_tier2_price_cents', 'output_tier3_price_cents',
        'output_tier1_price_per_acre_cents',
        'output_tier2_price_per_acre_cents',
        'output_tier3_price_per_acre_cents'
      )
      AND NOT a.attisdropped
      AND format_type(a.atttypid, a.atttypmod) = 'bigint'
  ) THEN
    RAISE EXCEPTION 'PHASE1A_CHANGE_SET_CENT_COLUMN_TYPES_INVALID';
  END IF;

  IF 4 <> (
    SELECT count(*)
    FROM pg_attribute a
    WHERE a.attrelid = 'public.pricing_workbook_export_rows'::regclass
      AND a.attname IN (
        'current_cost_cents', 'current_tier1_price_cents',
        'current_tier2_price_cents', 'current_tier3_price_cents'
      )
      AND NOT a.attisdropped
      AND format_type(a.atttypid, a.atttypmod) = 'bigint'
  ) THEN
    RAISE EXCEPTION 'PHASE1A_EXPORT_CENT_COLUMN_TYPES_INVALID';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.pricing_change_sets
    WHERE status = 'previewed' AND expires_at > now()
  ) THEN
    RAISE EXCEPTION 'PHASE1A_ACTIVE_PREVIEW_EXISTS';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.pricing_workbook_exports WHERE row_count > 5000
  ) THEN
    RAISE EXCEPTION 'PHASE1A_OVERSIZED_EXPORT_EXISTS';
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

-- The bootstrap migration is immutable production history. Re-emit the two
-- governed RPCs explicitly so the forward correction remains reviewable and
-- reproducible without runtime source inspection or dynamic SQL. Tier-2/3 zero
-- sentinels preview the same Tier-1-derived per-acre value that the product
-- trigger stores.
CREATE OR REPLACE FUNCTION public.preview_product_pricing_changes(
  p_source text,
  p_export_id uuid DEFAULT NULL,
  p_rows jsonb DEFAULT '[]'::jsonb,
  p_performed_by uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_existing jsonb;
  v_request_fp text;
  v_change_set_id uuid;
  v_export public.pricing_workbook_exports%ROWTYPE;
  v_row jsonb;
  v_sequence integer;
  v_product public.products%ROWTYPE;
  v_manifest public.pricing_workbook_export_rows%ROWTYPE;
  v_preview_product_id uuid;
  v_mode text;
  v_cost_cents bigint;
  v_t1_margin numeric;
  v_t2_margin numeric;
  v_t3_margin numeric;
  v_t1_price_cents bigint;
  v_t2_price_cents bigint;
  v_t3_price_cents bigint;
  v_calc jsonb;
  v_output jsonb;
  v_output_fp text;
  v_identity_fp text;
  v_expected_version bigint;
  v_error_message text;
  v_error_code text;
  v_final_status text;
  v_changed_count integer := 0;
  v_unchanged_count integer := 0;
  v_conflict_count integer := 0;
  v_invalid_count integer := 0;
  v_result jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF;
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'ADMIN_REQUIRED'; END IF;
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED';
  END IF;
  IF p_source NOT IN ('pricing_worksheet', 'product_page', 'products_inline') THEN
    RAISE EXCEPTION 'PRICING_SOURCE_INVALID';
  END IF;
  IF jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) = 0 THEN
    RAISE EXCEPTION 'PRICING_ROWS_REQUIRED';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_rows) row_value
    GROUP BY row_value->>'product_id'
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'PRICING_DUPLICATE_PRODUCT_ID';
  END IF;

  v_request_fp := md5(jsonb_build_object(
    'actor_id', v_actor,
    'source', p_source,
    'export_id', p_export_id,
    'rows', p_rows
  )::text);
  v_existing := public.check_idempotency(p_idempotency_key, 'preview_product_pricing_changes');
  IF v_existing IS NOT NULL THEN
    IF v_existing->>'actor_id' IS DISTINCT FROM v_actor::text
       OR v_existing->>'request_fingerprint' IS DISTINCT FROM v_request_fp THEN
      RAISE EXCEPTION 'IDEMPOTENCY_PAYLOAD_MISMATCH';
    END IF;
    RETURN v_existing->'response';
  END IF;

  IF p_source = 'pricing_worksheet' THEN
    IF p_export_id IS NULL THEN RAISE EXCEPTION 'WORKBOOK_EXPORT_REQUIRED'; END IF;
    SELECT * INTO v_export FROM public.pricing_workbook_exports e
    WHERE e.id = p_export_id
      AND e.created_by = v_actor
      AND e.status = 'active'
      AND e.expires_at > now();
    IF NOT FOUND THEN RAISE EXCEPTION 'WORKBOOK_EXPORT_INVALID_OR_EXPIRED'; END IF;
    IF jsonb_array_length(p_rows) IS DISTINCT FROM v_export.row_count THEN
      RAISE EXCEPTION 'WORKBOOK_MANIFEST_ROW_COUNT_MISMATCH';
    END IF;
  ELSIF p_export_id IS NOT NULL THEN
    RAISE EXCEPTION 'DIRECT_PRICING_EXPORT_NOT_ALLOWED';
  END IF;

  INSERT INTO public.pricing_change_sets(
    export_id, created_by, source, request_fingerprint,
    preview_idempotency_key, submitted_row_count, row_count, status
  ) VALUES (
    p_export_id, v_actor, p_source, v_request_fp,
    p_idempotency_key, jsonb_array_length(p_rows), 0, 'invalid'
  ) RETURNING id INTO v_change_set_id;

  FOR v_sequence, v_row IN
    SELECT ordinality::integer, value
    FROM jsonb_array_elements(p_rows) WITH ORDINALITY
  LOOP
    v_preview_product_id := NULL;
    v_product.id := NULL;

    BEGIN
      IF jsonb_typeof(v_row) <> 'object'
         OR COALESCE(v_row->>'product_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
         OR COALESCE(v_row->>'row_version', '') !~ '^[0-9]+$' THEN
        RAISE EXCEPTION 'PRICING_ROW_IDENTITY_INVALID';
      END IF;

      IF p_source = 'pricing_worksheet' AND (
        NOT (v_row ? 'has_formula')
        OR jsonb_typeof(v_row->'has_formula') <> 'boolean'
        OR (v_row->>'has_formula')::boolean
        OR (v_row ? 'formula_cells' AND (
          jsonb_typeof(v_row->'formula_cells') <> 'array'
          OR jsonb_array_length(v_row->'formula_cells') > 0
        ))
      ) THEN
        RAISE EXCEPTION 'WORKBOOK_FORMULA_REJECTED';
      END IF;

      SELECT * INTO v_product
      FROM public.products
      WHERE id = (v_row->>'product_id')::uuid;
      IF NOT FOUND THEN RAISE EXCEPTION 'PRICING_PRODUCT_NOT_FOUND'; END IF;
      IF NOT v_product.is_active THEN RAISE EXCEPTION 'PRICING_PRODUCT_INACTIVE'; END IF;
      v_preview_product_id := v_product.id;

      v_expected_version := (v_row->>'row_version')::bigint;
      v_identity_fp := md5(jsonb_build_object(
        'product_id', v_product.id,
        'sku', COALESCE(v_product.sku, ''),
        'product_name', v_product.product_name,
        'category', COALESCE(v_product.category, ''),
        'container_size', COALESCE(v_product.container_size::text, ''),
        'unit_size', COALESCE(v_product.unit_size, ''),
        'inventory_unit', COALESCE(v_product.inventory_unit, '')
      )::text);

      IF p_source = 'pricing_worksheet' THEN
        SELECT * INTO v_manifest
        FROM public.pricing_workbook_export_rows
        WHERE export_id = p_export_id AND product_id = v_product.id;
        IF NOT FOUND THEN RAISE EXCEPTION 'WORKBOOK_UNKNOWN_PRODUCT'; END IF;

        IF NOT (v_row ?& ARRAY[
             'sku', 'product_name', 'category', 'container_size', 'unit_size',
             'inventory_unit', 'identity_fingerprint', 'row_token',
             'current_cost', 'current_tier1_margin_percent', 'current_tier1_price',
             'current_tier2_margin_percent', 'current_tier2_price',
             'current_tier3_margin_percent', 'current_tier3_price'
           ])
           OR v_row->>'sku' IS DISTINCT FROM COALESCE(v_manifest.sku_snapshot, '')
           OR v_row->>'product_name' IS DISTINCT FROM v_manifest.product_name_snapshot
           OR v_row->>'category' IS DISTINCT FROM COALESCE(v_manifest.category_snapshot, '')
           OR v_row->>'container_size' IS DISTINCT FROM COALESCE(v_manifest.container_size_snapshot, '')
           OR v_row->>'unit_size' IS DISTINCT FROM COALESCE(v_manifest.unit_size_snapshot, '')
           OR v_row->>'inventory_unit' IS DISTINCT FROM COALESCE(v_manifest.inventory_unit_snapshot, '')
           OR v_row->>'identity_fingerprint' IS DISTINCT FROM v_manifest.identity_fingerprint
           OR v_row->>'row_token' IS DISTINCT FROM v_manifest.row_token
           OR v_expected_version IS DISTINCT FROM v_manifest.row_version
           OR v_row->>'current_cost' IS DISTINCT FROM COALESCE(public._format_pricing_dollars(v_manifest.current_cost_cents), '')
           OR v_row->>'current_tier1_margin_percent' IS DISTINCT FROM COALESCE(public._format_pricing_margin_percent(v_manifest.current_tier1_margin), '')
           OR v_row->>'current_tier1_price' IS DISTINCT FROM COALESCE(public._format_pricing_dollars(v_manifest.current_tier1_price_cents), '')
           OR v_row->>'current_tier2_margin_percent' IS DISTINCT FROM COALESCE(public._format_pricing_margin_percent(v_manifest.current_tier2_margin), '')
           OR v_row->>'current_tier2_price' IS DISTINCT FROM COALESCE(public._format_pricing_dollars(v_manifest.current_tier2_price_cents), '')
           OR v_row->>'current_tier3_margin_percent' IS DISTINCT FROM COALESCE(public._format_pricing_margin_percent(v_manifest.current_tier3_margin), '')
           OR v_row->>'current_tier3_price' IS DISTINCT FROM COALESCE(public._format_pricing_dollars(v_manifest.current_tier3_price_cents), '') THEN
          RAISE EXCEPTION 'WORKBOOK_IDENTITY_OR_BASELINE_TAMPERED';
        END IF;
        IF v_product.pricing_version IS DISTINCT FROM v_manifest.row_version
           OR v_identity_fp IS DISTINCT FROM v_manifest.identity_fingerprint THEN
          RAISE EXCEPTION 'PRICING_ROW_CONFLICT';
        END IF;
      ELSIF v_product.pricing_version IS DISTINCT FROM v_expected_version THEN
        RAISE EXCEPTION 'PRICING_ROW_CONFLICT';
      END IF;

      v_mode := NULLIF(btrim(COALESCE(v_row->>'pricing_mode', '')), '');
      IF p_source = 'pricing_worksheet' AND v_mode IS NULL THEN
        -- Blank mode is the safe worksheet default. Proposed cells may remain
        -- blank or repeat the exact server-exported baseline, but cannot hide a
        -- pricing edit without an explicit mode.
        IF (COALESCE(v_row->>'new_cost', '') <> ''
              AND v_row->>'new_cost' IS DISTINCT FROM public._format_pricing_dollars(v_manifest.current_cost_cents))
           OR (COALESCE(v_row->>'tier1_margin_percent', '') <> ''
              AND v_row->>'tier1_margin_percent' IS DISTINCT FROM public._format_pricing_margin_percent(v_manifest.current_tier1_margin))
           OR (COALESCE(v_row->>'tier1_price', '') <> ''
              AND v_row->>'tier1_price' IS DISTINCT FROM public._format_pricing_dollars(v_manifest.current_tier1_price_cents))
           OR (COALESCE(v_row->>'tier2_margin_percent', '') <> ''
              AND v_row->>'tier2_margin_percent' IS DISTINCT FROM public._format_pricing_margin_percent(v_manifest.current_tier2_margin))
           OR (COALESCE(v_row->>'tier2_price', '') <> ''
              AND v_row->>'tier2_price' IS DISTINCT FROM public._format_pricing_dollars(v_manifest.current_tier2_price_cents))
           OR (COALESCE(v_row->>'tier3_margin_percent', '') <> ''
              AND v_row->>'tier3_margin_percent' IS DISTINCT FROM public._format_pricing_margin_percent(v_manifest.current_tier3_margin))
           OR (COALESCE(v_row->>'tier3_price', '') <> ''
              AND v_row->>'tier3_price' IS DISTINCT FROM public._format_pricing_dollars(v_manifest.current_tier3_price_cents)) THEN
          RAISE EXCEPTION 'WORKBOOK_BLANK_MODE_CHANGED_VALUES';
        END IF;

        v_output := jsonb_build_object(
          'product_id', v_product.id,
          'product_name', v_product.product_name,
          'sku', COALESCE(v_product.sku, ''),
          'before', jsonb_build_object(
            'cost', public._format_pricing_dollars(round(v_product.current_cost * 100)::bigint),
            'cost_cents', round(v_product.current_cost * 100)::bigint,
            'tier1_margin_percent', public._format_pricing_margin_percent(v_product.tier1_margin),
            'tier1_margin', v_product.tier1_margin,
            'tier1_price', public._format_pricing_dollars(round(v_product.tier1_price * 100)::bigint),
            'tier1_price_cents', round(v_product.tier1_price * 100)::bigint,
            'tier2_margin_percent', public._format_pricing_margin_percent(v_product.tier2_margin),
            'tier2_margin', v_product.tier2_margin,
            'tier2_price', public._format_pricing_dollars(round(v_product.tier2_price * 100)::bigint),
            'tier2_price_cents', round(v_product.tier2_price * 100)::bigint,
            'tier3_margin_percent', public._format_pricing_margin_percent(v_product.tier3_margin),
            'tier3_margin', v_product.tier3_margin,
            'tier3_price', public._format_pricing_dollars(round(v_product.tier3_price * 100)::bigint),
            'tier3_price_cents', round(v_product.tier3_price * 100)::bigint,
            'tier1_price_per_acre_cents', round(v_product.tier1_price_per_acre * 100)::bigint,
            'tier2_price_per_acre_cents', round(v_product.tier2_price_per_acre * 100)::bigint,
            'tier3_price_per_acre_cents', round(v_product.tier3_price_per_acre * 100)::bigint
          ),
          'cost', public._format_pricing_dollars(v_manifest.current_cost_cents),
          'cost_cents', v_manifest.current_cost_cents,
          'tier1_margin_percent', public._format_pricing_margin_percent(v_manifest.current_tier1_margin),
          'tier1_margin', v_manifest.current_tier1_margin,
          'tier1_price', public._format_pricing_dollars(v_manifest.current_tier1_price_cents),
          'tier1_price_cents', v_manifest.current_tier1_price_cents,
          'tier2_margin_percent', public._format_pricing_margin_percent(v_manifest.current_tier2_margin),
          'tier2_margin', v_manifest.current_tier2_margin,
          'tier2_price', public._format_pricing_dollars(v_manifest.current_tier2_price_cents),
          'tier2_price_cents', v_manifest.current_tier2_price_cents,
          'tier3_margin_percent', public._format_pricing_margin_percent(v_manifest.current_tier3_margin),
          'tier3_margin', v_manifest.current_tier3_margin,
          'tier3_price', public._format_pricing_dollars(v_manifest.current_tier3_price_cents),
          'tier3_price_cents', v_manifest.current_tier3_price_cents
        );
        INSERT INTO public.pricing_change_set_preview_rows(
          change_set_id, sequence, product_id, submitted_row, row_status, effect
        ) VALUES (
          v_change_set_id, v_sequence, v_product.id, v_row, 'unchanged', v_output
        );
        v_unchanged_count := v_unchanged_count + 1;
        CONTINUE;
      END IF;

      IF v_mode NOT IN ('margin_driven', 'price_driven') THEN
        RAISE EXCEPTION 'PRICING_MODE_INVALID';
      END IF;
      IF NOT (v_row ? 'new_cost') OR jsonb_typeof(v_row->'new_cost') <> 'string' THEN
        RAISE EXCEPTION 'PRICING_DOLLARS_INVALID';
      END IF;
      v_cost_cents := public._parse_pricing_dollars(v_row->>'new_cost');

      IF v_mode = 'margin_driven' THEN
        IF NOT (v_row ?& ARRAY['tier1_margin_percent', 'tier2_margin_percent', 'tier3_margin_percent'])
           OR jsonb_typeof(v_row->'tier1_margin_percent') <> 'string'
           OR jsonb_typeof(v_row->'tier2_margin_percent') <> 'string'
           OR jsonb_typeof(v_row->'tier3_margin_percent') <> 'string' THEN
          RAISE EXCEPTION 'MARGIN_DRIVEN_FIELDS_INVALID';
        END IF;
        IF p_source = 'pricing_worksheet' AND (
             (COALESCE(v_row->>'tier1_price', '') <> '' AND v_row->>'tier1_price' IS DISTINCT FROM public._format_pricing_dollars(v_manifest.current_tier1_price_cents))
          OR (COALESCE(v_row->>'tier2_price', '') <> '' AND v_row->>'tier2_price' IS DISTINCT FROM public._format_pricing_dollars(v_manifest.current_tier2_price_cents))
          OR (COALESCE(v_row->>'tier3_price', '') <> '' AND v_row->>'tier3_price' IS DISTINCT FROM public._format_pricing_dollars(v_manifest.current_tier3_price_cents))
        ) THEN
          RAISE EXCEPTION 'MARGIN_DRIVEN_COMPANION_FIELDS_CHANGED';
        ELSIF p_source <> 'pricing_worksheet' AND (
          COALESCE(v_row->>'tier1_price', '') <> '' OR COALESCE(v_row->>'tier2_price', '') <> ''
          OR COALESCE(v_row->>'tier3_price', '') <> ''
        ) THEN
          RAISE EXCEPTION 'MARGIN_DRIVEN_FIELDS_INVALID';
        END IF;
        v_t1_margin := public._parse_pricing_margin_percent(v_row->>'tier1_margin_percent');
        v_t2_margin := public._parse_pricing_margin_percent(v_row->>'tier2_margin_percent');
        v_t3_margin := public._parse_pricing_margin_percent(v_row->>'tier3_margin_percent');
        v_t1_price_cents := NULL; v_t2_price_cents := NULL; v_t3_price_cents := NULL;
      ELSE
        IF NOT (v_row ?& ARRAY['tier1_price', 'tier2_price', 'tier3_price'])
           OR jsonb_typeof(v_row->'tier1_price') <> 'string'
           OR jsonb_typeof(v_row->'tier2_price') <> 'string'
           OR jsonb_typeof(v_row->'tier3_price') <> 'string' THEN
          RAISE EXCEPTION 'PRICE_DRIVEN_FIELDS_INVALID';
        END IF;
        IF p_source = 'pricing_worksheet' AND (
             (COALESCE(v_row->>'tier1_margin_percent', '') <> '' AND v_row->>'tier1_margin_percent' IS DISTINCT FROM public._format_pricing_margin_percent(v_manifest.current_tier1_margin))
          OR (COALESCE(v_row->>'tier2_margin_percent', '') <> '' AND v_row->>'tier2_margin_percent' IS DISTINCT FROM public._format_pricing_margin_percent(v_manifest.current_tier2_margin))
          OR (COALESCE(v_row->>'tier3_margin_percent', '') <> '' AND v_row->>'tier3_margin_percent' IS DISTINCT FROM public._format_pricing_margin_percent(v_manifest.current_tier3_margin))
        ) THEN
          RAISE EXCEPTION 'PRICE_DRIVEN_COMPANION_FIELDS_CHANGED';
        ELSIF p_source <> 'pricing_worksheet' AND (
          COALESCE(v_row->>'tier1_margin_percent', '') <> '' OR COALESCE(v_row->>'tier2_margin_percent', '') <> ''
          OR COALESCE(v_row->>'tier3_margin_percent', '') <> ''
        ) THEN
          RAISE EXCEPTION 'PRICE_DRIVEN_FIELDS_INVALID';
        END IF;
        v_t1_margin := NULL; v_t2_margin := NULL; v_t3_margin := NULL;
        v_t1_price_cents := public._parse_pricing_dollars(v_row->>'tier1_price');
        v_t2_price_cents := public._parse_pricing_dollars(v_row->>'tier2_price');
        v_t3_price_cents := public._parse_pricing_dollars(v_row->>'tier3_price');
      END IF;

      v_calc := public._calculate_product_pricing(
        v_mode,
        v_cost_cents::numeric / 100,
        v_t1_margin, v_t2_margin, v_t3_margin,
        CASE WHEN v_t1_price_cents IS NULL THEN NULL ELSE v_t1_price_cents::numeric / 100 END,
        CASE WHEN v_t2_price_cents IS NULL THEN NULL ELSE v_t2_price_cents::numeric / 100 END,
        CASE WHEN v_t3_price_cents IS NULL THEN NULL ELSE v_t3_price_cents::numeric / 100 END
      );

      v_output := jsonb_build_object(
        'product_id', v_product.id,
        'product_name', v_product.product_name,
        'sku', COALESCE(v_product.sku, ''),
        'before', jsonb_build_object(
          'cost', public._format_pricing_dollars(round(v_product.current_cost * 100)::bigint),
          'cost_cents', round(v_product.current_cost * 100)::bigint,
          'tier1_margin_percent', public._format_pricing_margin_percent(v_product.tier1_margin),
          'tier1_margin', v_product.tier1_margin,
          'tier1_price', public._format_pricing_dollars(round(v_product.tier1_price * 100)::bigint),
          'tier1_price_cents', round(v_product.tier1_price * 100)::bigint,
          'tier2_margin_percent', public._format_pricing_margin_percent(v_product.tier2_margin),
          'tier2_margin', v_product.tier2_margin,
          'tier2_price', public._format_pricing_dollars(round(v_product.tier2_price * 100)::bigint),
          'tier2_price_cents', round(v_product.tier2_price * 100)::bigint,
          'tier3_margin_percent', public._format_pricing_margin_percent(v_product.tier3_margin),
          'tier3_margin', v_product.tier3_margin,
          'tier3_price', public._format_pricing_dollars(round(v_product.tier3_price * 100)::bigint),
          'tier3_price_cents', round(v_product.tier3_price * 100)::bigint,
          'tier1_price_per_acre_cents', round(v_product.tier1_price_per_acre * 100)::bigint,
          'tier2_price_per_acre_cents', round(v_product.tier2_price_per_acre * 100)::bigint,
          'tier3_price_per_acre_cents', round(v_product.tier3_price_per_acre * 100)::bigint
        ),
        'pricing_mode', v_mode,
        'cost', public._format_pricing_dollars(round((v_calc->>'current_cost')::numeric * 100)::bigint),
        'cost_cents', round((v_calc->>'current_cost')::numeric * 100)::bigint,
        'tier1_margin_percent', public._format_pricing_margin_percent((v_calc->>'tier1_margin')::numeric),
        'tier1_margin', (v_calc->>'tier1_margin')::numeric,
        'tier2_margin_percent', public._format_pricing_margin_percent((v_calc->>'tier2_margin')::numeric),
        'tier2_margin', (v_calc->>'tier2_margin')::numeric,
        'tier3_margin_percent', public._format_pricing_margin_percent((v_calc->>'tier3_margin')::numeric),
        'tier3_margin', (v_calc->>'tier3_margin')::numeric,
        'tier1_price', public._format_pricing_dollars(round((v_calc->>'tier1_price')::numeric * 100)::bigint),
        'tier1_price_cents', round((v_calc->>'tier1_price')::numeric * 100)::bigint,
        'tier2_price', public._format_pricing_dollars(round((v_calc->>'tier2_price')::numeric * 100)::bigint),
        'tier2_price_cents', round((v_calc->>'tier2_price')::numeric * 100)::bigint,
        'tier3_price', public._format_pricing_dollars(round((v_calc->>'tier3_price')::numeric * 100)::bigint),
        'tier3_price_cents', round((v_calc->>'tier3_price')::numeric * 100)::bigint,
        'tier1_gross_margin', v_calc->'tier1_gross_margin',
        'tier2_gross_margin', v_calc->'tier2_gross_margin',
        'tier3_gross_margin', v_calc->'tier3_gross_margin',
        'tier1_price_per_acre_cents', CASE
          WHEN public.product_price_per_acre((v_calc->>'tier1_price')::numeric,
            v_product.rate_per_acre, v_product.rate_unit, v_product.inventory_unit, v_product.unit_size) IS NULL
          THEN NULL ELSE round(public.product_price_per_acre((v_calc->>'tier1_price')::numeric,
            v_product.rate_per_acre, v_product.rate_unit, v_product.inventory_unit, v_product.unit_size) * 100)::bigint END,
        'tier2_price_per_acre_cents', CASE
          WHEN public.product_price_per_acre(COALESCE(NULLIF((v_calc->>'tier2_price')::numeric, 0), (v_calc->>'tier1_price')::numeric),
            v_product.rate_per_acre, v_product.rate_unit, v_product.inventory_unit, v_product.unit_size) IS NULL
          THEN NULL ELSE round(public.product_price_per_acre(COALESCE(NULLIF((v_calc->>'tier2_price')::numeric, 0), (v_calc->>'tier1_price')::numeric),
            v_product.rate_per_acre, v_product.rate_unit, v_product.inventory_unit, v_product.unit_size) * 100)::bigint END,
        'tier3_price_per_acre_cents', CASE
          WHEN public.product_price_per_acre(COALESCE(NULLIF((v_calc->>'tier3_price')::numeric, 0), (v_calc->>'tier1_price')::numeric),
            v_product.rate_per_acre, v_product.rate_unit, v_product.inventory_unit, v_product.unit_size) IS NULL
          THEN NULL ELSE round(public.product_price_per_acre(COALESCE(NULLIF((v_calc->>'tier3_price')::numeric, 0), (v_calc->>'tier1_price')::numeric),
            v_product.rate_per_acre, v_product.rate_unit, v_product.inventory_unit, v_product.unit_size) * 100)::bigint END
      );
      v_output_fp := md5((v_output - ARRAY[
        'product_id', 'product_name', 'sku', 'before', 'pricing_mode', 'cost',
        'tier1_margin_percent', 'tier2_margin_percent', 'tier3_margin_percent',
        'tier1_price', 'tier2_price', 'tier3_price'
      ]::text[])::text);

      IF (v_output->>'cost_cents')::bigint IS NOT DISTINCT FROM round(v_product.current_cost * 100)::bigint
         AND (v_output->>'tier1_margin')::numeric IS NOT DISTINCT FROM v_product.tier1_margin
         AND (v_output->>'tier2_margin')::numeric IS NOT DISTINCT FROM v_product.tier2_margin
         AND (v_output->>'tier3_margin')::numeric IS NOT DISTINCT FROM v_product.tier3_margin
         AND (v_output->>'tier1_price_cents')::bigint IS NOT DISTINCT FROM round(v_product.tier1_price * 100)::bigint
         AND (v_output->>'tier2_price_cents')::bigint IS NOT DISTINCT FROM round(v_product.tier2_price * 100)::bigint
         AND (v_output->>'tier3_price_cents')::bigint IS NOT DISTINCT FROM round(v_product.tier3_price * 100)::bigint THEN
        INSERT INTO public.pricing_change_set_preview_rows(
          change_set_id, sequence, product_id, submitted_row, row_status, effect
        ) VALUES (
          v_change_set_id, v_sequence, v_product.id, v_row, 'unchanged', v_output
        );
        v_unchanged_count := v_unchanged_count + 1;
        CONTINUE;
      END IF;

      INSERT INTO public.pricing_change_set_rows(
        change_set_id, product_id, identity_fingerprint, expected_version,
        pricing_mode, change_reason,
        input_cost_cents, input_tier1_margin, input_tier2_margin, input_tier3_margin,
        input_tier1_price_cents, input_tier2_price_cents, input_tier3_price_cents,
        output_cost_cents, output_tier1_margin, output_tier2_margin, output_tier3_margin,
        output_tier1_price_cents, output_tier2_price_cents, output_tier3_price_cents,
        output_tier1_gross_margin, output_tier2_gross_margin, output_tier3_gross_margin,
        output_tier1_price_per_acre_cents, output_tier2_price_per_acre_cents,
        output_tier3_price_per_acre_cents, output_fingerprint
      ) VALUES (
        v_change_set_id, v_product.id, v_identity_fp, v_expected_version,
        v_mode, NULLIF(btrim(v_row->>'change_reason'), ''),
        v_cost_cents, v_t1_margin, v_t2_margin, v_t3_margin,
        v_t1_price_cents, v_t2_price_cents, v_t3_price_cents,
        (v_output->>'cost_cents')::bigint,
        (v_output->>'tier1_margin')::numeric,
        (v_output->>'tier2_margin')::numeric,
        (v_output->>'tier3_margin')::numeric,
        (v_output->>'tier1_price_cents')::bigint,
        (v_output->>'tier2_price_cents')::bigint,
        (v_output->>'tier3_price_cents')::bigint,
        (v_output->>'tier1_gross_margin')::numeric,
        (v_output->>'tier2_gross_margin')::numeric,
        (v_output->>'tier3_gross_margin')::numeric,
        (v_output->>'tier1_price_per_acre_cents')::bigint,
        (v_output->>'tier2_price_per_acre_cents')::bigint,
        (v_output->>'tier3_price_per_acre_cents')::bigint,
        v_output_fp
      );
      INSERT INTO public.pricing_change_set_preview_rows(
        change_set_id, sequence, product_id, submitted_row, row_status, effect
      ) VALUES (
        v_change_set_id, v_sequence, v_product.id, v_row, 'ready', v_output
      );
      v_changed_count := v_changed_count + 1;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_error_message = MESSAGE_TEXT;
      v_error_code := CASE
        WHEN v_error_message ~ '^[A-Z0-9_]+$' THEN v_error_message
        ELSE 'PRICING_ROW_INVALID'
      END;
      IF v_error_code = 'PRICING_ROW_CONFLICT' THEN
        v_conflict_count := v_conflict_count + 1;
        INSERT INTO public.pricing_change_set_preview_rows(
          change_set_id, sequence, product_id, submitted_row, row_status, error_code
        ) VALUES (
          v_change_set_id, v_sequence, v_preview_product_id, v_row, 'conflict', v_error_code
        );
      ELSE
        v_invalid_count := v_invalid_count + 1;
        INSERT INTO public.pricing_change_set_preview_rows(
          change_set_id, sequence, product_id, submitted_row, row_status, error_code
        ) VALUES (
          v_change_set_id, v_sequence, v_preview_product_id, v_row, 'invalid', v_error_code
        );
      END IF;
    END;
  END LOOP;

  v_final_status := CASE
    WHEN v_conflict_count > 0 OR v_invalid_count > 0 THEN 'invalid'
    WHEN v_changed_count = 0 THEN 'no_changes'
    ELSE 'previewed'
  END;
  UPDATE public.pricing_change_sets
  SET row_count = v_changed_count, status = v_final_status
  WHERE id = v_change_set_id;
  SELECT jsonb_build_object(
    'change_set_id', c.id,
    'request_fingerprint', c.request_fingerprint,
    'source', c.source,
    'status', c.status,
    'expires_at', c.expires_at,
    'submitted_row_count', c.submitted_row_count,
    'ready_count', c.row_count,
    'unchanged_count', v_unchanged_count,
    'conflict_count', v_conflict_count,
    'invalid_count', v_invalid_count,
    'apply_allowed', (c.status = 'previewed' AND c.row_count > 0),
    'rows', (
      SELECT jsonb_agg(to_jsonb(r) - 'change_set_id' ORDER BY r.sequence)
      FROM public.pricing_change_set_preview_rows r WHERE r.change_set_id = c.id
    )
  ) INTO v_result
  FROM public.pricing_change_sets c WHERE c.id = v_change_set_id;

  PERFORM public.save_idempotency(
    p_idempotency_key,
    'preview_product_pricing_changes',
    jsonb_build_object('actor_id', v_actor, 'request_fingerprint', v_request_fp, 'response', v_result)
  );
  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.preview_product_pricing_changes(
  text, uuid, jsonb, uuid, text
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.preview_product_pricing_changes(
  text, uuid, jsonb, uuid, text
) TO authenticated;

-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.apply_product_pricing_change_set(
  p_change_set_id uuid,
  p_request_fingerprint text,
  p_performed_by uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_existing jsonb;
  v_idem_request_fp text;
  v_change_set public.pricing_change_sets%ROWTYPE;
  v_export public.pricing_workbook_exports%ROWTYPE;
  v_row public.pricing_change_set_rows%ROWTYPE;
  v_product public.products%ROWTYPE;
  v_calc jsonb;
  v_output jsonb;
  v_output_fp text;
  v_result jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF;
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'ADMIN_REQUIRED'; END IF;
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED';
  END IF;
  IF p_request_fingerprint IS NULL OR btrim(p_request_fingerprint) = '' THEN
    RAISE EXCEPTION 'CHANGE_SET_FINGERPRINT_REQUIRED';
  END IF;

  v_idem_request_fp := md5(jsonb_build_object(
    'actor_id', v_actor,
    'change_set_id', p_change_set_id,
    'request_fingerprint', p_request_fingerprint
  )::text);
  v_existing := public.check_idempotency(p_idempotency_key, 'apply_product_pricing_change_set');
  IF v_existing IS NOT NULL THEN
    IF v_existing->>'actor_id' IS DISTINCT FROM v_actor::text
       OR v_existing->>'request_fingerprint' IS DISTINCT FROM v_idem_request_fp THEN
      RAISE EXCEPTION 'IDEMPOTENCY_PAYLOAD_MISMATCH';
    END IF;
    RETURN v_existing->'response';
  END IF;

  -- The shared cache expires, but an apply key may never be rebound to a
  -- different durable change set. The unique partial index closes the
  -- concurrent race; this check provides a stable owner-facing error for the
  -- ordinary sequential retry/reuse case.
  IF EXISTS (
    SELECT 1
    FROM public.pricing_change_sets
    WHERE apply_idempotency_key = p_idempotency_key
      AND id IS DISTINCT FROM p_change_set_id
  ) THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED_FOR_DIFFERENT_CHANGE_SET';
  END IF;

  SELECT * INTO v_change_set
  FROM public.pricing_change_sets
  WHERE id = p_change_set_id
  FOR UPDATE;
  IF NOT FOUND OR v_change_set.created_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'CHANGE_SET_NOT_FOUND';
  END IF;
  IF v_change_set.request_fingerprint IS DISTINCT FROM p_request_fingerprint THEN
    RAISE EXCEPTION 'CHANGE_SET_FINGERPRINT_MISMATCH';
  END IF;
  IF v_change_set.status = 'applied' THEN
    -- The shared idempotency cache is finite-lived. The applied change set is
    -- the durable receipt, so the exact original key remains retry-safe even
    -- after that cache row expires; every different key still fails closed.
    IF v_change_set.apply_idempotency_key IS NOT DISTINCT FROM p_idempotency_key THEN
      RETURN v_change_set.apply_result;
    END IF;
    RAISE EXCEPTION 'CHANGE_SET_ALREADY_APPLIED';
  END IF;
  IF v_change_set.status <> 'previewed' OR v_change_set.row_count <= 0
     OR v_change_set.expires_at <= now() THEN
    RAISE EXCEPTION 'CHANGE_SET_INVALID_OR_EXPIRED';
  END IF;

  -- Lock and validate the retained workbook export before any product lock.
  -- This prevents a second preview from applying after the same workbook was
  -- already consumed. An exact apply idempotency retry returned above.
  IF v_change_set.export_id IS NOT NULL THEN
    SELECT * INTO v_export
    FROM public.pricing_workbook_exports
    WHERE id = v_change_set.export_id
    FOR UPDATE;
    IF NOT FOUND OR v_export.created_by IS DISTINCT FROM v_actor
       OR v_export.status <> 'active' OR v_export.expires_at <= now() THEN
      RAISE EXCEPTION 'WORKBOOK_EXPORT_CONSUMED_OR_EXPIRED';
    END IF;
  END IF;

  -- Stable lock order prevents two overlapping batches from deadlocking. No
  -- product is changed until every row has been locked and version-validated.
  PERFORM p.id
  FROM public.products p
  JOIN public.pricing_change_set_rows r ON r.product_id = p.id
  WHERE r.change_set_id = p_change_set_id
  ORDER BY p.id
  FOR UPDATE OF p;

  IF v_change_set.row_count IS DISTINCT FROM (
    SELECT count(*) FROM public.pricing_change_set_rows r WHERE r.change_set_id = p_change_set_id
  ) OR EXISTS (
    SELECT 1
    FROM public.pricing_change_set_rows r
    LEFT JOIN public.products p ON p.id = r.product_id
    WHERE r.change_set_id = p_change_set_id
      AND (
        p.id IS NULL
        OR NOT p.is_active
        OR p.pricing_version IS DISTINCT FROM r.expected_version
        OR md5(jsonb_build_object(
          'product_id', p.id,
          'sku', COALESCE(p.sku, ''),
          'product_name', p.product_name,
          'category', COALESCE(p.category, ''),
          'container_size', COALESCE(p.container_size::text, ''),
          'unit_size', COALESCE(p.unit_size, ''),
          'inventory_unit', COALESCE(p.inventory_unit, '')
        )::text) IS DISTINCT FROM r.identity_fingerprint
      )
  ) THEN
    RAISE EXCEPTION 'PRICING_ROW_CONFLICT';
  END IF;

  FOR v_row IN
    SELECT * FROM public.pricing_change_set_rows
    WHERE change_set_id = p_change_set_id
    ORDER BY product_id
  LOOP
    SELECT * INTO v_product FROM public.products WHERE id = v_row.product_id;
    v_calc := public._calculate_product_pricing(
      v_row.pricing_mode,
      v_row.input_cost_cents::numeric / 100,
      v_row.input_tier1_margin, v_row.input_tier2_margin, v_row.input_tier3_margin,
      CASE WHEN v_row.input_tier1_price_cents IS NULL THEN NULL ELSE v_row.input_tier1_price_cents::numeric / 100 END,
      CASE WHEN v_row.input_tier2_price_cents IS NULL THEN NULL ELSE v_row.input_tier2_price_cents::numeric / 100 END,
      CASE WHEN v_row.input_tier3_price_cents IS NULL THEN NULL ELSE v_row.input_tier3_price_cents::numeric / 100 END
    );
    v_output := jsonb_build_object(
      'cost_cents', round((v_calc->>'current_cost')::numeric * 100)::bigint,
      'tier1_margin', (v_calc->>'tier1_margin')::numeric,
      'tier2_margin', (v_calc->>'tier2_margin')::numeric,
      'tier3_margin', (v_calc->>'tier3_margin')::numeric,
      'tier1_price_cents', round((v_calc->>'tier1_price')::numeric * 100)::bigint,
      'tier2_price_cents', round((v_calc->>'tier2_price')::numeric * 100)::bigint,
      'tier3_price_cents', round((v_calc->>'tier3_price')::numeric * 100)::bigint,
      'tier1_gross_margin', v_calc->'tier1_gross_margin',
      'tier2_gross_margin', v_calc->'tier2_gross_margin',
      'tier3_gross_margin', v_calc->'tier3_gross_margin',
      'tier1_price_per_acre_cents', CASE
        WHEN public.product_price_per_acre((v_calc->>'tier1_price')::numeric,
          v_product.rate_per_acre, v_product.rate_unit, v_product.inventory_unit, v_product.unit_size) IS NULL
        THEN NULL ELSE round(public.product_price_per_acre((v_calc->>'tier1_price')::numeric,
          v_product.rate_per_acre, v_product.rate_unit, v_product.inventory_unit, v_product.unit_size) * 100)::bigint END,
      'tier2_price_per_acre_cents', CASE
        WHEN public.product_price_per_acre(COALESCE(NULLIF((v_calc->>'tier2_price')::numeric, 0), (v_calc->>'tier1_price')::numeric),
          v_product.rate_per_acre, v_product.rate_unit, v_product.inventory_unit, v_product.unit_size) IS NULL
        THEN NULL ELSE round(public.product_price_per_acre(COALESCE(NULLIF((v_calc->>'tier2_price')::numeric, 0), (v_calc->>'tier1_price')::numeric),
          v_product.rate_per_acre, v_product.rate_unit, v_product.inventory_unit, v_product.unit_size) * 100)::bigint END,
      'tier3_price_per_acre_cents', CASE
        WHEN public.product_price_per_acre(COALESCE(NULLIF((v_calc->>'tier3_price')::numeric, 0), (v_calc->>'tier1_price')::numeric),
          v_product.rate_per_acre, v_product.rate_unit, v_product.inventory_unit, v_product.unit_size) IS NULL
        THEN NULL ELSE round(public.product_price_per_acre(COALESCE(NULLIF((v_calc->>'tier3_price')::numeric, 0), (v_calc->>'tier1_price')::numeric),
          v_product.rate_per_acre, v_product.rate_unit, v_product.inventory_unit, v_product.unit_size) * 100)::bigint END
    );
    v_output_fp := md5(v_output::text);
    IF v_output_fp IS DISTINCT FROM v_row.output_fingerprint THEN
      RAISE EXCEPTION 'CHANGE_SET_OUTPUT_DRIFT';
    END IF;
  END LOOP;

  FOR v_row IN
    SELECT * FROM public.pricing_change_set_rows
    WHERE change_set_id = p_change_set_id
    ORDER BY product_id
  LOOP
    PERFORM set_config('crx.pricing_authorized', 'phase1a', true);
    PERFORM set_config('crx.pricing_actor', v_actor::text, true);
    PERFORM set_config('crx.pricing_source', v_change_set.source, true);
    PERFORM set_config('crx.pricing_reason', COALESCE(v_row.change_reason, ''), true);
    PERFORM set_config('crx.pricing_change_set_id', p_change_set_id::text, true);
    PERFORM set_config('crx.pricing_mode', v_row.pricing_mode, true);

    UPDATE public.products
    SET current_cost = v_row.output_cost_cents::numeric / 100,
        tier1_margin = v_row.output_tier1_margin,
        tier2_margin = v_row.output_tier2_margin,
        tier3_margin = v_row.output_tier3_margin,
        tier1_price = v_row.output_tier1_price_cents::numeric / 100,
        tier2_price = v_row.output_tier2_price_cents::numeric / 100,
        tier3_price = v_row.output_tier3_price_cents::numeric / 100,
        cost_updated_date = CASE
          WHEN current_cost IS DISTINCT FROM v_row.output_cost_cents::numeric / 100 THEN now()
          ELSE cost_updated_date END,
        updated_at = now()
    WHERE id = v_row.product_id;
  END LOOP;

  SELECT jsonb_build_object(
    'change_set_id', p_change_set_id,
    'status', 'applied',
    'applied_count', v_change_set.row_count,
    'rows', jsonb_agg(jsonb_build_object(
      'product_id', p.id,
      'pricing_version', p.pricing_version,
      'cost', public._format_pricing_dollars(round(p.current_cost * 100)::bigint),
      'cost_cents', round(p.current_cost * 100)::bigint,
      'tier1_margin_percent', public._format_pricing_margin_percent(p.tier1_margin),
      'tier1_margin', p.tier1_margin,
      'tier1_price', public._format_pricing_dollars(round(p.tier1_price * 100)::bigint),
      'tier1_price_cents', round(p.tier1_price * 100)::bigint,
      'tier2_margin_percent', public._format_pricing_margin_percent(p.tier2_margin),
      'tier2_margin', p.tier2_margin,
      'tier2_price', public._format_pricing_dollars(round(p.tier2_price * 100)::bigint),
      'tier2_price_cents', round(p.tier2_price * 100)::bigint,
      'tier3_margin_percent', public._format_pricing_margin_percent(p.tier3_margin),
      'tier3_margin', p.tier3_margin,
      'tier3_price', public._format_pricing_dollars(round(p.tier3_price * 100)::bigint),
      'tier3_price_cents', round(p.tier3_price * 100)::bigint
    ) ORDER BY p.id)
  ) INTO v_result
  FROM public.products p
  JOIN public.pricing_change_set_rows r ON r.product_id = p.id
  WHERE r.change_set_id = p_change_set_id;

  UPDATE public.pricing_change_sets
  SET status = 'applied', applied_by = v_actor, applied_at = now(),
      apply_idempotency_key = p_idempotency_key, apply_result = v_result
  WHERE id = p_change_set_id;

  IF v_change_set.export_id IS NOT NULL THEN
    UPDATE public.pricing_workbook_exports
    SET status = 'consumed'
    WHERE id = v_change_set.export_id AND status = 'active';
  END IF;

  PERFORM public.save_idempotency(
    p_idempotency_key,
    'apply_product_pricing_change_set',
    jsonb_build_object('actor_id', v_actor, 'request_fingerprint', v_idem_request_fp, 'response', v_result)
  );
  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.apply_product_pricing_change_set(
  uuid, text, uuid, text
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.apply_product_pricing_change_set(
  uuid, text, uuid, text
) TO authenticated;

-- ---------------------------------------------------------------------------

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

DO $postflight$
BEGIN
  IF (SELECT md5(replace(p.prosrc, E'\r\n', E'\n')) FROM pg_proc p WHERE p.oid = to_regprocedure(
        'public.preview_product_pricing_changes(text,uuid,jsonb,uuid,text)'
      )) IS DISTINCT FROM 'debb6056a4f46a7d74c34ebf8142b7fc'
     OR (SELECT md5(replace(p.prosrc, E'\r\n', E'\n')) FROM pg_proc p WHERE p.oid = to_regprocedure(
        'public.apply_product_pricing_change_set(uuid,text,uuid,text)'
      )) IS DISTINCT FROM '82416909e64d1c0740028be3ba6717ac' THEN
    RAISE EXCEPTION 'PHASE1A_CORRECTED_RPC_BODY_MISMATCH';
  END IF;

  IF has_function_privilege(
       'anon', 'public.preview_product_pricing_changes(text,uuid,jsonb,uuid,text)', 'EXECUTE'
     )
     OR has_function_privilege(
       'service_role', 'public.preview_product_pricing_changes(text,uuid,jsonb,uuid,text)', 'EXECUTE'
     )
     OR NOT has_function_privilege(
       'authenticated', 'public.preview_product_pricing_changes(text,uuid,jsonb,uuid,text)', 'EXECUTE'
     )
     OR has_function_privilege(
       'anon', 'public.apply_product_pricing_change_set(uuid,text,uuid,text)', 'EXECUTE'
     )
     OR has_function_privilege(
       'service_role', 'public.apply_product_pricing_change_set(uuid,text,uuid,text)', 'EXECUTE'
     )
     OR NOT has_function_privilege(
       'authenticated', 'public.apply_product_pricing_change_set(uuid,text,uuid,text)', 'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'PHASE1A_CORRECTED_RPC_GRANTS_INVALID';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    WHERE c.conrelid = 'public.pricing_workbook_exports'::regclass
      AND c.conname = 'pricing_workbook_exports_row_limit'
      AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) = 'CHECK ((row_count <= 5000))'
  ) THEN
    RAISE EXCEPTION 'PHASE1A_WORKBOOK_ROW_LIMIT_INVALID';
  END IF;
END;
$postflight$;
