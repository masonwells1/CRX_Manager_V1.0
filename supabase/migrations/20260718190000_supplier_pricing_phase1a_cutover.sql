-- Supplier Pricing Phase 1a enforcement cutover (PROMOTED 2026-07-18).
--
-- All parked prerequisites verified live this session before promotion:
--   1. 20260717042803_supplier_pricing_phase1a.sql — LIVE (verified).
--   2. 20260717112011_supplier_pricing_zero_cost_guard.sql — LIVE
--      (ledger identity 20260717120500_supplier_pricing_zero_cost_guard).
--   3. RPC-only ProductDetail/Products/worksheet frontend DEPLOYED to
--      production (croprxsolutions.app) and PROVEN end-to-end on live:
--      a governed product_page edit wrote cost_history with
--      change_source='product_page' + a change_set_id (status 'applied').
--   4. Rollback window: harden migration 20260718124517 is live; the three
--      governed RPC bodies match the md5 baselines pinned in the preflight
--      below (verified live). A forward rollback would re-grant the pricing
--      columns; nothing here drops data.
--   5. This file is applied through the standard migration-review + apply-guard
--      proof gate (fresh Codex-minted proof bound to this exact SQL).
--   6. Timestamp 20260718190000 is strictly greater than the verified live
--      high-water 20260718154131 (harden migration).
--
-- The additive bootstrap intentionally kept the legacy frontend operational.
-- This second migration closes those temporary write paths after cutover:
-- pricing columns become writable ONLY through the governed preview/apply RPC.

DO $preflight$
BEGIN
  IF (SELECT count(*) FROM pg_proc p
      WHERE p.pronamespace = 'public'::regnamespace
        AND p.proname = 'create_pricing_workbook_export') <> 1
     OR (SELECT md5(replace(p.prosrc, E'\r\n', E'\n'))
         FROM pg_proc p
         WHERE p.oid = to_regprocedure(
           'public.create_pricing_workbook_export(uuid[],uuid,text)'
         )) IS DISTINCT FROM 'cd26cf7deaf683fbf546cbe89c128755'
     OR (SELECT count(*) FROM pg_proc p
      WHERE p.pronamespace = 'public'::regnamespace
        AND p.proname = 'preview_product_pricing_changes') <> 1
     OR (SELECT md5(replace(p.prosrc, E'\r\n', E'\n'))
         FROM pg_proc p
         WHERE p.oid = to_regprocedure(
           'public.preview_product_pricing_changes(text,uuid,jsonb,uuid,text)'
         )) IS DISTINCT FROM 'cf93e5b93499e066dc74c3464ae7a6f4'
     OR (SELECT count(*) FROM pg_proc p
         WHERE p.pronamespace = 'public'::regnamespace
           AND p.proname = 'apply_product_pricing_change_set') <> 1
     OR (SELECT md5(replace(p.prosrc, E'\r\n', E'\n'))
         FROM pg_proc p
         WHERE p.oid = to_regprocedure(
           'public.apply_product_pricing_change_set(uuid,text,uuid,text)'
         )) IS DISTINCT FROM '82416909e64d1c0740028be3ba6717ac' THEN
    RAISE EXCEPTION 'PHASE1A_CORRECTION_RPC_BASELINE_MISMATCH';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    WHERE c.conrelid = 'public.pricing_workbook_exports'::regclass
      AND c.conname = 'pricing_workbook_exports_row_limit'
      AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) = 'CHECK ((row_count <= 5000))'
  ) THEN
    RAISE EXCEPTION 'PHASE1A_CORRECTION_ROW_LIMIT_MISSING';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.pricing_change_sets
    WHERE status = 'previewed' AND expires_at > now()
  ) THEN
    RAISE EXCEPTION 'PHASE1A_ACTIVE_PREVIEW_EXISTS';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    WHERE t.tgrelid = 'public.products'::regclass
      AND t.tgname = 'trigger_z_guard_version_product_pricing'
      AND NOT t.tgisinternal
      AND t.tgenabled IN ('O', 'A')
      AND t.tgfoid = to_regprocedure('public.guard_and_version_product_pricing()')
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    WHERE t.tgrelid = 'public.products'::regclass
      AND t.tgname = 'trigger_recalc_product_price_per_acre'
      AND NOT t.tgisinternal
      AND t.tgenabled IN ('O', 'A')
      AND t.tgfoid = to_regprocedure('public.recalc_product_price_per_acre()')
  ) THEN
    RAISE EXCEPTION 'PHASE1A_REQUIRED_TRIGGER_INVALID';
  END IF;
END;
$preflight$;

-- Reassert the separately deployable compatibility guard at enforcement
-- cutover so the final function definition converges even if environments were
-- rebuilt from the staged sequence.
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

-- End the additive compatibility window: after cutover even a stale submitted
-- version is rejected. The database remains the sole version writer.
CREATE OR REPLACE FUNCTION public.guard_and_version_product_pricing()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_core_changed boolean;
  v_per_acre_changed boolean;
  v_actor uuid;
  v_change_set_id uuid;
  v_source text;
BEGIN
  IF NEW.current_cost::text IN ('NaN', 'Infinity', '-Infinity')
     OR NEW.tier1_price::text IN ('NaN', 'Infinity', '-Infinity')
     OR NEW.tier2_price::text IN ('NaN', 'Infinity', '-Infinity')
     OR NEW.tier3_price::text IN ('NaN', 'Infinity', '-Infinity')
     OR round(NEW.current_cost, 2) IS DISTINCT FROM NEW.current_cost
     OR round(NEW.tier1_price, 2) IS DISTINCT FROM NEW.tier1_price
     OR round(NEW.tier2_price, 2) IS DISTINCT FROM NEW.tier2_price
     OR round(NEW.tier3_price, 2) IS DISTINCT FROM NEW.tier3_price THEN
    RAISE EXCEPTION 'PRODUCT_PRICING_CENT_SCALE_INVALID';
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.pricing_version := 1;
    RETURN NEW;
  END IF;
  IF NEW.pricing_version IS DISTINCT FROM OLD.pricing_version THEN
    RAISE EXCEPTION 'PRODUCT_PRICING_VERSION_MANAGED_BY_DATABASE';
  END IF;
  v_core_changed := OLD.current_cost IS DISTINCT FROM NEW.current_cost
    OR OLD.tier1_margin IS DISTINCT FROM NEW.tier1_margin
    OR OLD.tier2_margin IS DISTINCT FROM NEW.tier2_margin
    OR OLD.tier3_margin IS DISTINCT FROM NEW.tier3_margin
    OR OLD.tier1_price IS DISTINCT FROM NEW.tier1_price
    OR OLD.tier2_price IS DISTINCT FROM NEW.tier2_price
    OR OLD.tier3_price IS DISTINCT FROM NEW.tier3_price
    OR OLD.tier1_gross_margin IS DISTINCT FROM NEW.tier1_gross_margin
    OR OLD.tier2_gross_margin IS DISTINCT FROM NEW.tier2_gross_margin
    OR OLD.tier3_gross_margin IS DISTINCT FROM NEW.tier3_gross_margin;
  v_per_acre_changed := OLD.tier1_price_per_acre IS DISTINCT FROM NEW.tier1_price_per_acre
    OR OLD.tier2_price_per_acre IS DISTINCT FROM NEW.tier2_price_per_acre
    OR OLD.tier3_price_per_acre IS DISTINCT FROM NEW.tier3_price_per_acre;
  IF v_core_changed AND current_setting('crx.pricing_authorized', true) = 'phase1a' THEN
    v_actor := NULLIF(current_setting('crx.pricing_actor', true), '')::uuid;
    v_change_set_id := NULLIF(current_setting('crx.pricing_change_set_id', true), '')::uuid;
    v_source := NULLIF(current_setting('crx.pricing_source', true), '');
    IF v_actor IS NULL OR v_actor IS DISTINCT FROM auth.uid()
       OR v_source NOT IN ('pricing_worksheet', 'product_page', 'products_inline')
       OR NOT public.is_admin()
       OR NOT EXISTS (
         SELECT 1 FROM public.pricing_change_sets c JOIN public.pricing_change_set_rows r
           ON r.change_set_id = c.id
         WHERE c.id = v_change_set_id AND c.created_by = v_actor
           AND c.source = v_source AND c.status = 'previewed' AND r.product_id = NEW.id
       ) THEN
      RAISE EXCEPTION 'PRODUCT_PRICING_CONTEXT_INVALID';
    END IF;
  END IF;
  IF v_core_changed OR v_per_acre_changed THEN
    NEW.pricing_version := OLD.pricing_version + 1;
  ELSE
    NEW.pricing_version := OLD.pricing_version;
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.guard_and_version_product_pricing()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.require_governed_product_pricing()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_pricing_changed boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_pricing_changed := NEW.current_cost IS NOT NULL
      OR NEW.tier1_margin IS NOT NULL
      OR NEW.tier2_margin IS NOT NULL
      OR NEW.tier3_margin IS NOT NULL
      OR NEW.tier1_price IS NOT NULL
      OR NEW.tier2_price IS NOT NULL
      OR NEW.tier3_price IS NOT NULL;

    -- Product creation stays a pricing-free shell. Pricing is a separate,
    -- previewed update through the governed RPC after the row exists.
    IF v_pricing_changed THEN
      RAISE EXCEPTION 'PRODUCT_PRICING_GOVERNED_PATH_REQUIRED';
    END IF;
    RETURN NEW;
  END IF;

  v_pricing_changed :=
    OLD.current_cost IS DISTINCT FROM NEW.current_cost
    OR OLD.tier1_margin IS DISTINCT FROM NEW.tier1_margin
    OR OLD.tier2_margin IS DISTINCT FROM NEW.tier2_margin
    OR OLD.tier3_margin IS DISTINCT FROM NEW.tier3_margin
    OR OLD.tier1_price IS DISTINCT FROM NEW.tier1_price
    OR OLD.tier2_price IS DISTINCT FROM NEW.tier2_price
    OR OLD.tier3_price IS DISTINCT FROM NEW.tier3_price;

  -- Gross-margin and per-acre fields are trigger-derived. Authenticated
  -- callers have no column grant for them, but ordinary rate/unit edits must
  -- be allowed to recalculate per-acre values through the live trigger.

  IF v_pricing_changed
     AND current_setting('crx.pricing_authorized', true) IS DISTINCT FROM 'phase1a' THEN
    RAISE EXCEPTION 'PRODUCT_PRICING_GOVERNED_PATH_REQUIRED';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trigger_y_require_governed_product_pricing ON public.products;
CREATE TRIGGER trigger_y_require_governed_product_pricing
  BEFORE INSERT OR UPDATE ON public.products
  FOR EACH ROW
  EXECUTE FUNCTION public.require_governed_product_pricing();

REVOKE ALL ON FUNCTION public.require_governed_product_pricing()
  FROM PUBLIC, anon, authenticated, service_role;

-- Table-level grants override column revokes, so remove them first and grant
-- authenticated users only the nonpricing columns used by the new frontend.
REVOKE INSERT, UPDATE ON TABLE public.products FROM authenticated, service_role;
REVOKE INSERT (
  current_cost, cost_updated_date,
  tier1_margin, tier2_margin, tier3_margin,
  tier1_price, tier2_price, tier3_price,
  tier1_gross_margin, tier2_gross_margin, tier3_gross_margin,
  tier1_price_per_acre, tier2_price_per_acre, tier3_price_per_acre,
  pricing_version
), UPDATE (
  current_cost, cost_updated_date,
  tier1_margin, tier2_margin, tier3_margin,
  tier1_price, tier2_price, tier3_price,
  tier1_gross_margin, tier2_gross_margin, tier3_gross_margin,
  tier1_price_per_acre, tier2_price_per_acre, tier3_price_per_acre,
  pricing_version
) ON public.products FROM anon, authenticated, service_role;

GRANT INSERT (
  product_name, sku, category, vendor, manufacturer,
  container_size, unit_size, suggested_rate, rate_per_acre, rate_unit,
  notes, is_active, updated_at, epa_registration, product_form,
  inventory_unit, container_unit, container_type, is_rup, signal_word,
  internal_notes, rei_hours, phi_days, max_label_rate, max_label_rate_unit,
  use_timing
) ON public.products TO authenticated;

GRANT UPDATE (
  product_name, sku, category, vendor, manufacturer,
  container_size, unit_size, suggested_rate, rate_per_acre, rate_unit,
  notes, is_active, updated_at, epa_registration, product_form,
  inventory_unit, container_unit, container_type, is_rup, signal_word,
  internal_notes, rei_hours, phi_days, max_label_rate, max_label_rate_unit,
  use_timing
) ON public.products TO authenticated;

DROP POLICY IF EXISTS cost_history_insert ON public.cost_history;
DROP POLICY IF EXISTS "cost_history_insert" ON public.cost_history;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.cost_history
  FROM authenticated, service_role;
REVOKE INSERT (
  id, product_id, changed_by, change_source, change_reason, change_set_id,
  old_cost, new_cost,
  old_tier1_margin, new_tier1_margin, old_tier1_price, new_tier1_price,
  old_tier2_margin, new_tier2_margin, old_tier2_price, new_tier2_price,
  old_tier3_margin, new_tier3_margin, old_tier3_price, new_tier3_price,
  old_pricing_version, new_pricing_version, change_note, changed_at
), UPDATE (
  id, product_id, changed_by, change_source, change_reason, change_set_id,
  old_cost, new_cost,
  old_tier1_margin, new_tier1_margin, old_tier1_price, new_tier1_price,
  old_tier2_margin, new_tier2_margin, old_tier2_price, new_tier2_price,
  old_tier3_margin, new_tier3_margin, old_tier3_price, new_tier3_price,
  old_pricing_version, new_pricing_version, change_note, changed_at
) ON public.cost_history FROM anon, authenticated, service_role;
REVOKE SELECT ON TABLE public.cost_history FROM anon;

ALTER TABLE public.cost_history
  ALTER COLUMN change_source DROP DEFAULT;

DO $assertions$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgrelid = 'public.products'::regclass
      AND tgname = 'trigger_y_require_governed_product_pricing'
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'pricing cutover trigger missing';
  END IF;

  IF has_table_privilege('authenticated', 'public.products', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.products', 'INSERT')
     OR has_table_privilege('service_role', 'public.products', 'UPDATE')
     OR has_table_privilege('service_role', 'public.products', 'INSERT') THEN
    RAISE EXCEPTION 'table-level Product write bypass survived cutover';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) AS roles(role_name)
    CROSS JOIN unnest(ARRAY[
      'current_cost', 'cost_updated_date',
      'tier1_margin', 'tier2_margin', 'tier3_margin',
      'tier1_price', 'tier2_price', 'tier3_price',
      'tier1_gross_margin', 'tier2_gross_margin', 'tier3_gross_margin',
      'tier1_price_per_acre', 'tier2_price_per_acre', 'tier3_price_per_acre',
      'pricing_version'
    ]) AS columns(column_name)
    WHERE has_column_privilege(role_name, 'public.products', column_name, 'INSERT')
       OR has_column_privilege(role_name, 'public.products', column_name, 'UPDATE')
  ) THEN
    RAISE EXCEPTION 'pricing-column write privilege survived cutover';
  END IF;

  IF NOT has_column_privilege('authenticated', 'public.products', 'product_name', 'INSERT')
     OR NOT has_column_privilege('authenticated', 'public.products', 'product_name', 'UPDATE') THEN
    RAISE EXCEPTION 'nonpricing Product writes were not preserved at cutover';
  END IF;

  IF has_table_privilege('authenticated', 'public.cost_history', 'INSERT')
     OR has_table_privilege('service_role', 'public.cost_history', 'INSERT')
     OR has_table_privilege('service_role', 'public.cost_history', 'UPDATE')
     OR has_table_privilege('service_role', 'public.cost_history', 'DELETE') THEN
    RAISE EXCEPTION 'direct cost-history write privilege survived cutover';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) AS roles(role_name)
    CROSS JOIN pg_attribute attribute
    WHERE attribute.attrelid = 'public.cost_history'::regclass
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND (
        has_column_privilege(role_name, 'public.cost_history', attribute.attname, 'INSERT')
        OR has_column_privilege(role_name, 'public.cost_history', attribute.attname, 'UPDATE')
      )
  ) THEN
    RAISE EXCEPTION 'column-level cost-history write privilege survived cutover';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'cost_history'
      AND column_name = 'change_source'
      AND column_default IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'legacy cost-history default survived cutover';
  END IF;
END;
$assertions$;
