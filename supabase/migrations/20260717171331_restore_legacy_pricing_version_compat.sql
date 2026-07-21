-- Supplier Pricing Phase 1a: preserve the legacy Product form during the
-- additive rollout. That deployed form resubmits its originally loaded
-- pricing_version on each full-row save. Treat that stale client value as
-- input to ignore, while the database remains the only version writer.
-- The parked enforcement cutover restores the unconditional rejection.

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
  IF TG_OP = 'INSERT' THEN
    NEW.pricing_version := 1;
    RETURN NEW;
  END IF;

  IF NEW.pricing_version IS DISTINCT FROM OLD.pricing_version THEN
    -- Governed writers must never choose a version. The deployed legacy
    -- Product form submits the stale value it originally read.
    IF current_setting('crx.pricing_authorized', true) = 'phase1a' THEN
      RAISE EXCEPTION 'PRODUCT_PRICING_VERSION_MANAGED_BY_DATABASE';
    END IF;
    NEW.pricing_version := OLD.pricing_version;
  END IF;

  v_core_changed :=
    OLD.current_cost IS DISTINCT FROM NEW.current_cost
    OR OLD.tier1_margin IS DISTINCT FROM NEW.tier1_margin
    OR OLD.tier2_margin IS DISTINCT FROM NEW.tier2_margin
    OR OLD.tier3_margin IS DISTINCT FROM NEW.tier3_margin
    OR OLD.tier1_price IS DISTINCT FROM NEW.tier1_price
    OR OLD.tier2_price IS DISTINCT FROM NEW.tier2_price
    OR OLD.tier3_price IS DISTINCT FROM NEW.tier3_price
    OR OLD.tier1_gross_margin IS DISTINCT FROM NEW.tier1_gross_margin
    OR OLD.tier2_gross_margin IS DISTINCT FROM NEW.tier2_gross_margin
    OR OLD.tier3_gross_margin IS DISTINCT FROM NEW.tier3_gross_margin;
  v_per_acre_changed :=
    OLD.tier1_price_per_acre IS DISTINCT FROM NEW.tier1_price_per_acre
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
         SELECT 1 FROM public.pricing_change_sets c
         JOIN public.pricing_change_set_rows r ON r.change_set_id = c.id
         WHERE c.id = v_change_set_id AND c.created_by = v_actor
           AND c.source = v_source AND c.status = 'previewed'
           AND r.product_id = NEW.id
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

DO $assertions$
BEGIN
  IF (SELECT count(*) FROM pg_proc p
      WHERE p.pronamespace = 'public'::regnamespace
        AND p.proname = 'guard_and_version_product_pricing'
        AND pg_get_function_identity_arguments(p.oid) = '') <> 1 THEN
    RAISE EXCEPTION 'PHASE1A_PRICING_VERSION_COMPAT_FUNCTION_SHAPE_INVALID';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
    WHERE t.tgrelid = 'public.products'::regclass
      AND t.tgname = 'trigger_z_guard_version_product_pricing'
      AND NOT t.tgisinternal AND p.proname = 'guard_and_version_product_pricing'
  ) THEN
    RAISE EXCEPTION 'PHASE1A_PRICING_VERSION_COMPAT_TRIGGER_INVALID';
  END IF;
END;
$assertions$;
