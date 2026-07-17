-- DRAFT ONLY — Supplier Pricing Phase 1a enforcement cutover.
--
-- PARKED: do not copy to supabase/migrations or apply until ALL of the
-- following are true:
--   1. 20260717025710_supplier_pricing_phase1a.sql is live and verified.
--   2. The RPC-only ProductDetail/Products/worksheet frontend is deployed.
--   3. Its rollback window is closed or a forward database rollback is ready.
--   4. This exact file has fresh migration-review and apply-guard proof.
--
-- The additive bootstrap intentionally keeps the legacy frontend operational.
-- This second migration closes those temporary write paths after cutover.

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

  IF has_column_privilege('authenticated', 'public.products', 'current_cost', 'UPDATE')
     OR has_column_privilege('authenticated', 'public.products', 'tier1_price', 'UPDATE')
     OR has_column_privilege('authenticated', 'public.products', 'pricing_version', 'UPDATE')
     OR has_column_privilege('authenticated', 'public.products', 'current_cost', 'INSERT') THEN
    RAISE EXCEPTION 'authenticated pricing-column write privilege survived cutover';
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
