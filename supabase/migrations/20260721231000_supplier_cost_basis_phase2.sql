-- Phase 2 supplier pricing: governed product cost basis.
--
-- This migration is intentionally additive and OFF by default for supplier/
-- purchase evidence selection. It reuses the existing Phase 1a pricing
-- preview/apply engine; no second money calculator is introduced.
--
-- Applying this file later will create baseline history rows only. It does not
-- change products.current_cost or any sell price.

INSERT INTO public.app_settings(setting_key, setting_value, description)
VALUES (
  'supplier_cost_basis_enabled',
  'false',
  'OFF-by-default gate for selecting supplier or actual-purchase evidence as the Product cost basis.'
)
ON CONFLICT (setting_key) DO UPDATE
SET setting_value = EXCLUDED.setting_value,
    description = EXCLUDED.description,
    updated_at = now();

CREATE TABLE public.product_cost_basis (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE RESTRICT,
  basis_type text NOT NULL CHECK (basis_type IN (
    'selected_supplier_price', 'actual_purchase', 'manual_override'
  )),
  cost_cents bigint NOT NULL CHECK (cost_cents >= 0),
  supplier_price_observation_id uuid
    REFERENCES public.supplier_price_observations(id) ON DELETE RESTRICT,
  purchase_order_item_id uuid
    REFERENCES public.purchase_order_items(id) ON DELETE RESTRICT,
  pricing_change_set_id uuid
    REFERENCES public.pricing_change_sets(id) ON DELETE RESTRICT,
  selection_source text NOT NULL CHECK (selection_source IN (
    'migration_baseline', 'pricing_worksheet', 'product_page',
    'products_inline', 'supplier_pricing', 'product_detail'
  )),
  reason text NOT NULL CHECK (btrim(reason) <> ''),
  selected_by uuid REFERENCES public.profiles(id) ON DELETE RESTRICT,
  selected_at timestamptz NOT NULL DEFAULT now(),
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_to timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT product_cost_basis_effective_range CHECK (
    effective_to IS NULL OR effective_to >= effective_from
  ),
  CONSTRAINT product_cost_basis_provenance_shape CHECK (
    (basis_type = 'selected_supplier_price'
      AND supplier_price_observation_id IS NOT NULL
      AND purchase_order_item_id IS NULL)
    OR
    (basis_type = 'actual_purchase'
      AND supplier_price_observation_id IS NULL
      AND purchase_order_item_id IS NOT NULL)
    OR
    (basis_type = 'manual_override'
      AND supplier_price_observation_id IS NULL
      AND purchase_order_item_id IS NULL)
  ),
  CONSTRAINT product_cost_basis_actor_shape CHECK (
    (selection_source = 'migration_baseline' AND selected_by IS NULL
      AND pricing_change_set_id IS NULL)
    OR
    (selection_source <> 'migration_baseline' AND selected_by IS NOT NULL
      AND pricing_change_set_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX uq_product_cost_basis_active
  ON public.product_cost_basis(product_id)
  WHERE effective_to IS NULL;
CREATE INDEX idx_product_cost_basis_product_history
  ON public.product_cost_basis(product_id, effective_from DESC, id DESC);
CREATE INDEX idx_product_cost_basis_supplier_observation
  ON public.product_cost_basis(supplier_price_observation_id)
  WHERE supplier_price_observation_id IS NOT NULL;
CREATE INDEX idx_product_cost_basis_purchase_item
  ON public.product_cost_basis(purchase_order_item_id)
  WHERE purchase_order_item_id IS NOT NULL;
CREATE INDEX idx_product_cost_basis_change_set
  ON public.product_cost_basis(pricing_change_set_id)
  WHERE pricing_change_set_id IS NOT NULL;

CREATE TABLE public.product_cost_basis_change_rows (
  pricing_change_set_id uuid NOT NULL
    REFERENCES public.pricing_change_sets(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE RESTRICT,
  expected_version bigint NOT NULL CHECK (expected_version >= 1),
  expected_active_basis_id uuid
    REFERENCES public.product_cost_basis(id) ON DELETE RESTRICT,
  basis_type text NOT NULL CHECK (basis_type IN (
    'selected_supplier_price', 'actual_purchase', 'manual_override'
  )),
  cost_cents bigint NOT NULL CHECK (cost_cents >= 0),
  supplier_price_observation_id uuid
    REFERENCES public.supplier_price_observations(id) ON DELETE RESTRICT,
  purchase_order_item_id uuid
    REFERENCES public.purchase_order_items(id) ON DELETE RESTRICT,
  selection_source text NOT NULL CHECK (selection_source IN (
    'pricing_worksheet', 'product_page', 'products_inline',
    'supplier_pricing', 'product_detail'
  )),
  reason text NOT NULL CHECK (btrim(reason) <> ''),
  force_selection boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (pricing_change_set_id, product_id),
  CONSTRAINT product_cost_basis_change_provenance_shape CHECK (
    (basis_type = 'selected_supplier_price'
      AND supplier_price_observation_id IS NOT NULL
      AND purchase_order_item_id IS NULL)
    OR
    (basis_type = 'actual_purchase'
      AND supplier_price_observation_id IS NULL
      AND purchase_order_item_id IS NOT NULL)
    OR
    (basis_type = 'manual_override'
      AND supplier_price_observation_id IS NULL
      AND purchase_order_item_id IS NULL)
  )
);

CREATE INDEX idx_product_cost_basis_change_rows_product
  ON public.product_cost_basis_change_rows(product_id);

ALTER TABLE public.product_cost_basis ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_cost_basis_change_rows ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS product_cost_basis_rpc_only ON public.product_cost_basis;
CREATE POLICY product_cost_basis_rpc_only
  ON public.product_cost_basis FOR ALL TO PUBLIC
  USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS product_cost_basis_change_rows_rpc_only
  ON public.product_cost_basis_change_rows;
CREATE POLICY product_cost_basis_change_rows_rpc_only
  ON public.product_cost_basis_change_rows FOR ALL TO PUBLIC
  USING (false) WITH CHECK (false);

REVOKE ALL ON TABLE public.product_cost_basis
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.product_cost_basis_change_rows
  FROM PUBLIC, anon, authenticated, service_role;

ALTER TABLE public.purchase_order_items
  ADD COLUMN inventory_unit_snapshot text,
  ADD CONSTRAINT purchase_order_items_cost_unit_snapshot_shape CHECK (
    (inventory_units_per_supplier_unit_snapshot IS NULL
      AND inventory_unit_snapshot IS NULL)
    OR
    (inventory_units_per_supplier_unit_snapshot > 0
      AND NULLIF(btrim(inventory_unit_snapshot), '') IS NOT NULL)
  );

-- Purchase-order unit costs entered by the current app are per Product
-- inventory unit. Preserve that fact as an immutable conversion snapshot when
-- the PO line uses the same unit label as the Product. Lines expressed in a
-- different supplier/package unit remain unresolved instead of guessing.
-- Installing the trigger before the historical backfill closes the concurrent
-- writer gap without depending on an outer migration transaction wrapper.

CREATE OR REPLACE FUNCTION public.capture_purchase_order_item_cost_snapshot()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_inventory_unit text;
  v_phase2_enabled boolean;
BEGIN
  SELECT COALESCE(s.setting_value = 'true', false)
  INTO v_phase2_enabled
  FROM public.app_settings s
  WHERE s.setting_key = 'supplier_cost_basis_enabled';

  v_phase2_enabled := COALESCE(v_phase2_enabled, false);

  SELECT COALESCE(
    NULLIF(btrim(p.inventory_unit), ''),
    NULLIF(btrim(p.unit_size), '')
  ) INTO v_inventory_unit
  FROM public.products p
  WHERE p.id = NEW.product_id;

  IF TG_OP = 'INSERT' THEN
    -- Snapshot provenance is server-derived. Direct callers cannot preload a
    -- conversion factor on either an open or already-received line.
    NEW.product_supplier_link_id := NULL;
    NEW.supplier_price_observation_id := NULL;
    NEW.inventory_units_per_supplier_unit_snapshot := NULL;
    NEW.inventory_unit_snapshot := NULL;
    NEW.cost_provenance := NULL;
    NEW.cost_snapshot_at := NULL;

    IF NEW.quantity_received > 0
       AND NULLIF(btrim(NEW.unit_size), '') IS NOT NULL
       AND NULLIF(btrim(v_inventory_unit), '') IS NOT NULL
       AND lower(btrim(NEW.unit_size)) = lower(btrim(v_inventory_unit)) THEN
      NEW.inventory_units_per_supplier_unit_snapshot := 1;
      NEW.inventory_unit_snapshot := v_inventory_unit;
      NEW.cost_provenance := 'manual';
      NEW.cost_snapshot_at := now();
    END IF;

    RETURN NEW;
  END IF;

  IF OLD.quantity_received > 0 AND (
    NEW.purchase_order_id IS DISTINCT FROM OLD.purchase_order_id
    OR NEW.product_id IS DISTINCT FROM OLD.product_id
    OR NEW.unit_cost IS DISTINCT FROM OLD.unit_cost
    OR NEW.unit_size IS DISTINCT FROM OLD.unit_size
    OR NEW.product_supplier_link_id IS DISTINCT FROM OLD.product_supplier_link_id
    OR NEW.supplier_price_observation_id IS DISTINCT FROM OLD.supplier_price_observation_id
    OR NEW.inventory_units_per_supplier_unit_snapshot IS DISTINCT FROM
       OLD.inventory_units_per_supplier_unit_snapshot
    OR NEW.inventory_unit_snapshot IS DISTINCT FROM OLD.inventory_unit_snapshot
    OR NEW.cost_provenance IS DISTINCT FROM OLD.cost_provenance
    OR NEW.cost_snapshot_at IS DISTINCT FROM OLD.cost_snapshot_at
  ) AND NOT (
    current_setting('crx.cost_basis_backfill', true) = 'phase2'
    AND
    OLD.inventory_units_per_supplier_unit_snapshot IS NULL
    AND NEW.inventory_units_per_supplier_unit_snapshot = 1
    AND OLD.inventory_unit_snapshot IS NULL
    AND lower(btrim(NEW.inventory_unit_snapshot)) = lower(btrim(v_inventory_unit))
    AND NEW.purchase_order_id IS NOT DISTINCT FROM OLD.purchase_order_id
    AND NEW.product_id IS NOT DISTINCT FROM OLD.product_id
    AND NEW.unit_cost IS NOT DISTINCT FROM OLD.unit_cost
    AND NEW.unit_size IS NOT DISTINCT FROM OLD.unit_size
    AND NEW.product_supplier_link_id IS NOT DISTINCT FROM OLD.product_supplier_link_id
    AND NEW.supplier_price_observation_id IS NOT DISTINCT FROM OLD.supplier_price_observation_id
    AND NEW.cost_provenance IS NOT DISTINCT FROM COALESCE(OLD.cost_provenance, 'legacy')
    AND NEW.cost_snapshot_at IS NOT NULL
    AND NULLIF(btrim(NEW.unit_size), '') IS NOT NULL
    AND NULLIF(btrim(v_inventory_unit), '') IS NOT NULL
    AND lower(btrim(NEW.unit_size)) = lower(btrim(v_inventory_unit))
  ) THEN
    IF v_phase2_enabled THEN
      RAISE EXCEPTION 'RECEIVED_PO_COST_SNAPSHOT_IMMUTABLE';
    END IF;

    -- While Phase 2 is disabled, preserve the existing partially-received PO
    -- correction workflow but discard provenance that no longer describes the
    -- edited cost. A later governed receipt/selection must capture fresh facts.
    NEW.product_supplier_link_id := NULL;
    NEW.supplier_price_observation_id := NULL;
    NEW.inventory_units_per_supplier_unit_snapshot := NULL;
    NEW.inventory_unit_snapshot := NULL;
    NEW.cost_provenance := NULL;
    NEW.cost_snapshot_at := NULL;
  END IF;

  IF COALESCE(OLD.quantity_received, 0) <= 0 THEN
    -- An open line carries no trusted purchase evidence. Clear any direct
    -- caller input, including values pre-seeded on a first-receipt update.
    NEW.product_supplier_link_id := NULL;
    NEW.supplier_price_observation_id := NULL;
    NEW.inventory_units_per_supplier_unit_snapshot := NULL;
    NEW.inventory_unit_snapshot := NULL;
    NEW.cost_provenance := NULL;
    NEW.cost_snapshot_at := NULL;
  END IF;

  IF COALESCE(OLD.quantity_received, 0) <= 0
     AND NEW.quantity_received > 0 THEN
    IF NULLIF(btrim(NEW.unit_size), '') IS NOT NULL
       AND NULLIF(btrim(v_inventory_unit), '') IS NOT NULL
       AND lower(btrim(NEW.unit_size)) = lower(btrim(v_inventory_unit)) THEN
      NEW.inventory_units_per_supplier_unit_snapshot := 1;
      NEW.inventory_unit_snapshot := v_inventory_unit;
      NEW.cost_provenance := COALESCE(NEW.cost_provenance, 'manual');
      NEW.cost_snapshot_at := COALESCE(NEW.cost_snapshot_at, now());
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.capture_purchase_order_item_cost_snapshot()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trigger_capture_purchase_order_item_cost_snapshot
  ON public.purchase_order_items;
CREATE TRIGGER trigger_capture_purchase_order_item_cost_snapshot
  BEFORE INSERT OR UPDATE OF quantity_received, purchase_order_id, product_id,
    unit_cost, unit_size, product_supplier_link_id,
    supplier_price_observation_id,
    inventory_units_per_supplier_unit_snapshot, inventory_unit_snapshot,
    cost_provenance, cost_snapshot_at
  ON public.purchase_order_items
  FOR EACH ROW
  EXECUTE FUNCTION public.capture_purchase_order_item_cost_snapshot();

-- Once governed cost basis is enabled, the Product inventory unit is part of
-- the meaning of every active per-unit cost. Unit corrections therefore use a
-- controlled flag-off maintenance window instead of silently reinterpreting an
-- active supplier or purchase basis in a different unit.
CREATE OR REPLACE FUNCTION public.guard_product_cost_basis_unit_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF lower(COALESCE(NULLIF(btrim(NEW.inventory_unit), ''), NULLIF(btrim(NEW.unit_size), '')))
       IS NOT DISTINCT FROM
     lower(COALESCE(NULLIF(btrim(OLD.inventory_unit), ''), NULLIF(btrim(OLD.unit_size), ''))) THEN
    RETURN NEW;
  END IF;

  IF COALESCE((
       SELECT setting_value = 'true'
       FROM public.app_settings
       WHERE setting_key = 'supplier_cost_basis_enabled'
     ), false)
     AND EXISTS (
       SELECT 1
       FROM public.product_cost_basis b
       WHERE b.product_id = OLD.id
         AND b.effective_to IS NULL
     ) THEN
    RAISE EXCEPTION 'PRODUCT_COST_BASIS_UNIT_CHANGE_REQUIRES_FLAG_OFF';
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.guard_product_cost_basis_unit_change()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trigger_guard_product_cost_basis_unit_change
  ON public.products;
CREATE TRIGGER trigger_guard_product_cost_basis_unit_change
  BEFORE UPDATE OF inventory_unit, unit_size ON public.products
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_product_cost_basis_unit_change();

-- Scope the one-time legacy exception to this statement. A later caller may
-- not manufacture received-line provenance by replaying the backfill shape.
DO $backfill$
BEGIN
  PERFORM set_config('crx.cost_basis_backfill', 'phase2', true);
  UPDATE public.purchase_order_items poi
  SET inventory_units_per_supplier_unit_snapshot = 1,
      inventory_unit_snapshot = COALESCE(
        NULLIF(btrim(p.inventory_unit), ''), NULLIF(btrim(p.unit_size), '')
      ),
      cost_provenance = COALESCE(poi.cost_provenance, 'legacy'),
      cost_snapshot_at = COALESCE(poi.cost_snapshot_at, now())
  FROM public.products p
  WHERE p.id = poi.product_id
    AND poi.quantity_received > 0
    AND poi.inventory_units_per_supplier_unit_snapshot IS NULL
    AND NULLIF(btrim(poi.unit_size), '') IS NOT NULL
    AND COALESCE(
      NULLIF(btrim(p.inventory_unit), ''), NULLIF(btrim(p.unit_size), '')
    ) IS NOT NULL
    AND lower(btrim(poi.unit_size)) = lower(COALESCE(
      NULLIF(btrim(p.inventory_unit), ''), NULLIF(btrim(p.unit_size), '')
    ));
END;
$backfill$;

-- Install enforcement before the baseline copy. CREATE TRIGGER takes the
-- relation lock needed to wait for in-flight Product writers; after it returns,
-- every new cost write is fail-closed while the baseline is being captured.
CREATE OR REPLACE FUNCTION public.require_product_cost_basis_context()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid;
  v_change_set_id uuid;
BEGIN
  IF TG_OP <> 'UPDATE' OR OLD.current_cost IS NOT DISTINCT FROM NEW.current_cost THEN
    RETURN NEW;
  END IF;
  v_actor := NULLIF(current_setting('crx.cost_basis_actor', true), '')::uuid;
  v_change_set_id := NULLIF(
    current_setting('crx.cost_basis_change_set_id', true), ''
  )::uuid;
  IF current_setting('crx.cost_basis_authorized', true) IS DISTINCT FROM 'phase2'
     OR v_actor IS NULL OR v_actor IS DISTINCT FROM auth.uid()
     OR v_change_set_id IS NULL
     OR NOT public.is_admin()
     OR NOT EXISTS (
       SELECT 1
       FROM public.pricing_change_sets c
       JOIN public.product_cost_basis_change_rows r
         ON r.pricing_change_set_id = c.id
       WHERE c.id = v_change_set_id
         AND c.created_by = v_actor
         AND c.status = 'previewed'
         AND r.product_id = NEW.id
         AND r.cost_cents = round(NEW.current_cost::numeric * 100)::bigint
     ) THEN
    RAISE EXCEPTION 'PRODUCT_COST_BASIS_CONTEXT_REQUIRED';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.require_product_cost_basis_context()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trigger_zz_require_product_cost_basis
  ON public.products;
CREATE TRIGGER trigger_zz_require_product_cost_basis
  BEFORE UPDATE ON public.products
  FOR EACH ROW EXECUTE FUNCTION public.require_product_cost_basis_context();

-- Capture the exact existing selected basis without changing Product pricing.
INSERT INTO public.product_cost_basis(
  product_id, basis_type, cost_cents, selection_source, reason,
  selected_by, selected_at, effective_from
)
SELECT
  p.id,
  'manual_override',
  round(p.current_cost::numeric * 100)::bigint,
  'migration_baseline',
  'Phase 2 baseline copied from the existing governed Product cost.',
  NULL,
  now(),
  LEAST(COALESCE(p.cost_updated_date, p.created_at, now()), now())
FROM public.products p
WHERE p.current_cost IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.product_cost_basis b
    WHERE b.product_id = p.id AND b.effective_to IS NULL
  );

CREATE OR REPLACE FUNCTION public.protect_product_cost_basis_history()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'PRODUCT_COST_BASIS_DELETE_FORBIDDEN';
  END IF;

  IF current_setting('crx.cost_basis_authorized', true) IS DISTINCT FROM 'phase2'
     OR OLD.effective_to IS NOT NULL
     OR NEW.effective_to IS NULL
     OR NEW.effective_to < OLD.effective_from
     OR (to_jsonb(NEW) - 'effective_to') IS DISTINCT FROM
        (to_jsonb(OLD) - 'effective_to') THEN
    RAISE EXCEPTION 'PRODUCT_COST_BASIS_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.protect_product_cost_basis_history()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trigger_protect_product_cost_basis_history
  ON public.product_cost_basis;
CREATE TRIGGER trigger_protect_product_cost_basis_history
  BEFORE UPDATE OR DELETE ON public.product_cost_basis
  FOR EACH ROW EXECUTE FUNCTION public.protect_product_cost_basis_history();

CREATE OR REPLACE FUNCTION public._resolve_product_cost_basis_row(p_row jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_product_id uuid;
  v_expected_version bigint;
  v_basis_type text;
  v_cost_cents bigint;
  v_reason text;
  v_source text;
  v_force boolean;
  v_observation_id uuid;
  v_purchase_item_id uuid;
  v_candidate_cents bigint;
  v_business_date date := (now() AT TIME ZONE 'America/Chicago')::date;
BEGIN
  IF jsonb_typeof(p_row) <> 'object' THEN
    RAISE EXCEPTION 'COST_BASIS_ROW_INVALID';
  END IF;

  BEGIN
    v_product_id := (p_row->>'product_id')::uuid;
    v_expected_version := (p_row->>'row_version')::bigint;
    v_basis_type := p_row->>'basis_type';
    v_cost_cents := public._parse_pricing_dollars(p_row->>'new_cost');
    v_reason := btrim(COALESCE(p_row->>'basis_reason', p_row->>'change_reason', ''));
    v_source := p_row->>'basis_source';
    v_force := COALESCE((p_row->>'basis_selection')::boolean, false);
    v_observation_id := NULLIF(p_row->>'supplier_price_observation_id', '')::uuid;
    v_purchase_item_id := NULLIF(p_row->>'purchase_order_item_id', '')::uuid;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'COST_BASIS_ROW_INVALID';
  END;

  IF v_product_id IS NULL OR v_expected_version IS NULL OR v_expected_version < 1
     OR v_basis_type NOT IN (
       'selected_supplier_price', 'actual_purchase', 'manual_override'
     ) OR v_reason = ''
     OR v_source NOT IN (
       'pricing_worksheet', 'product_page', 'products_inline',
       'supplier_pricing', 'product_detail'
     ) THEN
    RAISE EXCEPTION 'COST_BASIS_ROW_INVALID';
  END IF;

  IF v_basis_type <> 'manual_override'
     AND COALESCE((
       SELECT setting_value = 'true'
       FROM public.app_settings
       WHERE setting_key = 'supplier_cost_basis_enabled'
     ), false) IS NOT TRUE THEN
    RAISE EXCEPTION 'SUPPLIER_COST_BASIS_DISABLED';
  END IF;

  IF v_basis_type = 'selected_supplier_price' THEN
    IF v_observation_id IS NULL OR v_purchase_item_id IS NOT NULL THEN
      RAISE EXCEPTION 'COST_BASIS_PROVENANCE_INVALID';
    END IF;
    SELECT round(
      o.cost_cents::numeric / o.package_quantity
      / l.inventory_units_per_supplier_unit
    )::bigint
    INTO v_candidate_cents
    FROM public.supplier_price_observations o
    JOIN public.product_supplier_links l
      ON l.id = o.product_supplier_link_id
    JOIN public.products p
      ON p.id = o.product_id
    JOIN public.vendors v
      ON v.id = o.vendor_id AND v.deleted_at IS NULL
    WHERE o.id = v_observation_id
      AND o.product_id = v_product_id
      AND l.product_id = v_product_id
      AND l.vendor_id = o.vendor_id
      AND l.is_active
      AND l.is_reusable
      AND l.comparison_status = 'comparable'
      AND l.inventory_units_per_supplier_unit > 0
      AND lower(btrim(l.conversion_unit)) = lower(COALESCE(
        NULLIF(btrim(p.inventory_unit), ''), NULLIF(btrim(p.unit_size), '')
      ))
      AND o.package_quantity > 0
      AND o.effective_from <= v_business_date
      AND (o.effective_to IS NULL OR o.effective_to >= v_business_date)
      AND NOT EXISTS (
        SELECT 1 FROM public.supplier_price_observations correction
        WHERE correction.supersedes_observation_id = o.id
      );
    IF v_candidate_cents IS NULL THEN
      RAISE EXCEPTION 'SUPPLIER_COST_BASIS_NOT_COMPARABLE';
    END IF;
  ELSIF v_basis_type = 'actual_purchase' THEN
    IF v_purchase_item_id IS NULL OR v_observation_id IS NOT NULL THEN
      RAISE EXCEPTION 'COST_BASIS_PROVENANCE_INVALID';
    END IF;
    SELECT round(
      poi.unit_cost_cents::numeric
      / poi.inventory_units_per_supplier_unit_snapshot
    )::bigint
    INTO v_candidate_cents
    FROM public.purchase_order_items poi
    JOIN public.purchase_orders po ON po.id = poi.purchase_order_id
    JOIN public.products p ON p.id = poi.product_id
    WHERE poi.id = v_purchase_item_id
      AND poi.product_id = v_product_id
      AND poi.quantity_received > 0
      AND poi.unit_cost_cents IS NOT NULL
      AND poi.inventory_units_per_supplier_unit_snapshot > 0
      AND lower(btrim(poi.inventory_unit_snapshot)) = lower(COALESCE(
        NULLIF(btrim(p.inventory_unit), ''), NULLIF(btrim(p.unit_size), '')
      ))
      AND po.status <> 'cancelled';
    IF v_candidate_cents IS NULL THEN
      RAISE EXCEPTION 'ACTUAL_PURCHASE_COST_BASIS_INVALID';
    END IF;
  ELSE
    IF v_observation_id IS NOT NULL OR v_purchase_item_id IS NOT NULL THEN
      RAISE EXCEPTION 'COST_BASIS_PROVENANCE_INVALID';
    END IF;
    v_candidate_cents := v_cost_cents;
  END IF;

  IF v_candidate_cents IS DISTINCT FROM v_cost_cents THEN
    RAISE EXCEPTION 'COST_BASIS_AMOUNT_MISMATCH';
  END IF;

  RETURN jsonb_build_object(
    'product_id', v_product_id,
    'expected_version', v_expected_version,
    'basis_type', v_basis_type,
    'cost_cents', v_cost_cents,
    'supplier_price_observation_id', v_observation_id,
    'purchase_order_item_id', v_purchase_item_id,
    'selection_source', v_source,
    'reason', v_reason,
    'force_selection', v_force
  );
END;
$function$;

REVOKE ALL ON FUNCTION public._resolve_product_cost_basis_row(jsonb)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.preview_product_cost_basis_changes(
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
  v_pricing_result jsonb;
  v_change_set_id uuid;
  v_row jsonb;
  v_resolved jsonb;
  v_basis_change_count integer;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF;
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'ADMIN_REQUIRED'; END IF;
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED';
  END IF;
  IF jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) = 0 THEN
    RAISE EXCEPTION 'COST_BASIS_ROWS_REQUIRED';
  END IF;

  v_request_fp := md5(jsonb_build_object(
    'actor_id', v_actor,
    'source', p_source,
    'export_id', p_export_id,
    'rows', p_rows
  )::text);
  v_existing := public.check_idempotency(
    p_idempotency_key, 'preview_product_cost_basis_changes'
  );
  IF v_existing IS NOT NULL THEN
    IF v_existing->>'actor_id' IS DISTINCT FROM v_actor::text
       OR v_existing->>'request_fingerprint' IS DISTINCT FROM v_request_fp THEN
      RAISE EXCEPTION 'IDEMPOTENCY_PAYLOAD_MISMATCH';
    END IF;
    RETURN v_existing->'response';
  END IF;

  -- Validate every provenance row before the shared pricing engine writes its
  -- durable preview receipt. Any failure rolls back the whole preview.
  FOR v_row IN SELECT value FROM jsonb_array_elements(p_rows)
  LOOP
    PERFORM public._resolve_product_cost_basis_row(v_row);
  END LOOP;

  v_pricing_result := public.preview_product_pricing_changes(
    p_source,
    p_export_id,
    p_rows,
    v_actor,
    p_idempotency_key || ':pricing'
  );
  v_change_set_id := (v_pricing_result->>'change_set_id')::uuid;

  FOR v_row IN SELECT value FROM jsonb_array_elements(p_rows)
  LOOP
    v_resolved := public._resolve_product_cost_basis_row(v_row);
    INSERT INTO public.product_cost_basis_change_rows(
      pricing_change_set_id, product_id, expected_version,
      expected_active_basis_id, basis_type,
      cost_cents, supplier_price_observation_id, purchase_order_item_id,
      selection_source, reason, force_selection
    ) VALUES (
      v_change_set_id,
      (v_resolved->>'product_id')::uuid,
      (v_resolved->>'expected_version')::bigint,
      (SELECT active.id
       FROM public.product_cost_basis active
       WHERE active.product_id = (v_resolved->>'product_id')::uuid
         AND active.effective_to IS NULL),
      v_resolved->>'basis_type',
      (v_resolved->>'cost_cents')::bigint,
      NULLIF(v_resolved->>'supplier_price_observation_id', '')::uuid,
      NULLIF(v_resolved->>'purchase_order_item_id', '')::uuid,
      v_resolved->>'selection_source',
      v_resolved->>'reason',
      (v_resolved->>'force_selection')::boolean
    )
    ON CONFLICT (pricing_change_set_id, product_id) DO NOTHING;
  END LOOP;

  IF (SELECT count(*) FROM public.product_cost_basis_change_rows
      WHERE pricing_change_set_id = v_change_set_id)
     IS DISTINCT FROM jsonb_array_length(p_rows) THEN
    RAISE EXCEPTION 'COST_BASIS_CHANGE_SET_SHAPE_INVALID';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.product_cost_basis_change_rows r
    JOIN jsonb_array_elements(p_rows) AS submitted(value)
      ON (submitted.value->>'product_id')::uuid = r.product_id
    WHERE r.pricing_change_set_id = v_change_set_id
      AND public._resolve_product_cost_basis_row(submitted.value) IS DISTINCT FROM
          jsonb_build_object(
            'product_id', r.product_id,
            'expected_version', r.expected_version,
            'basis_type', r.basis_type,
            'cost_cents', r.cost_cents,
            'supplier_price_observation_id', r.supplier_price_observation_id,
            'purchase_order_item_id', r.purchase_order_item_id,
            'selection_source', r.selection_source,
            'reason', r.reason,
            'force_selection', r.force_selection
          )
  ) THEN
    RAISE EXCEPTION 'COST_BASIS_CHANGE_SET_DRIFT';
  END IF;

  SELECT count(*)::integer INTO v_basis_change_count
  FROM public.product_cost_basis_change_rows r
  JOIN public.products p ON p.id = r.product_id
  LEFT JOIN public.product_cost_basis active
    ON active.product_id = r.product_id AND active.effective_to IS NULL
  WHERE r.pricing_change_set_id = v_change_set_id
    AND (
      round(p.current_cost::numeric * 100)::bigint IS DISTINCT FROM r.cost_cents
      OR r.force_selection
      OR active.id IS NULL
    );

  v_pricing_result := v_pricing_result || jsonb_build_object(
    'basis_change_count', v_basis_change_count,
    'apply_allowed', (
      (v_pricing_result->>'status') = 'previewed'
      OR ((v_pricing_result->>'status') = 'no_changes' AND v_basis_change_count > 0)
    )
  );

  PERFORM public.save_idempotency(
    p_idempotency_key,
    'preview_product_cost_basis_changes',
    jsonb_build_object(
      'actor_id', v_actor,
      'request_fingerprint', v_request_fp,
      'response', v_pricing_result
    )
  );
  RETURN v_pricing_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.preview_product_cost_basis_changes(
  text, uuid, jsonb, uuid, text
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.preview_product_cost_basis_changes(
  text, uuid, jsonb, uuid, text
) TO authenticated;

CREATE OR REPLACE FUNCTION public.apply_product_cost_basis_change_set(
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
  v_idem_fp text;
  v_inner_key text;
  v_change_set public.pricing_change_sets%ROWTYPE;
  v_export public.pricing_workbook_exports%ROWTYPE;
  v_row public.product_cost_basis_change_rows%ROWTYPE;
  v_active public.product_cost_basis%ROWTYPE;
  v_pricing_result jsonb;
  v_basis_rows jsonb := '[]'::jsonb;
  v_now timestamptz := clock_timestamp();
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

  v_inner_key := p_idempotency_key || ':pricing';
  v_idem_fp := md5(jsonb_build_object(
    'actor_id', v_actor,
    'change_set_id', p_change_set_id,
    'request_fingerprint', p_request_fingerprint
  )::text);
  v_existing := public.check_idempotency(
    p_idempotency_key, 'apply_product_cost_basis_change_set'
  );
  IF v_existing IS NOT NULL THEN
    IF v_existing->>'actor_id' IS DISTINCT FROM v_actor::text
       OR v_existing->>'request_fingerprint' IS DISTINCT FROM v_idem_fp THEN
      RAISE EXCEPTION 'IDEMPOTENCY_PAYLOAD_MISMATCH';
    END IF;
    RETURN v_existing->'response';
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
    IF v_change_set.apply_idempotency_key IS NOT DISTINCT FROM v_inner_key THEN
      RETURN v_change_set.apply_result;
    END IF;
    RAISE EXCEPTION 'CHANGE_SET_ALREADY_APPLIED';
  END IF;
  IF v_change_set.status NOT IN ('previewed', 'no_changes')
     OR v_change_set.expires_at <= now() THEN
    RAISE EXCEPTION 'CHANGE_SET_INVALID_OR_EXPIRED';
  END IF;
  IF (SELECT count(*) FROM public.product_cost_basis_change_rows
      WHERE pricing_change_set_id = p_change_set_id)
     IS DISTINCT FROM v_change_set.submitted_row_count THEN
    RAISE EXCEPTION 'COST_BASIS_CHANGE_SET_SHAPE_INVALID';
  END IF;

  -- Basis-only workbook changes do not enter the Phase 1a apply RPC, so lock
  -- and validate their retained export here as well. This preserves the same
  -- one-use and expiry contract for a provenance-only selection.
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

  -- Hold every mutable source of truth used by evidence resolution until this
  -- transaction commits. In particular, FOR UPDATE on an observation blocks a
  -- concurrent correction INSERT because its supersedes FK needs a row lock.
  -- The fixed table/id order keeps overlapping batches deterministic.
  IF EXISTS (
    SELECT 1 FROM public.product_cost_basis_change_rows
    WHERE pricing_change_set_id = p_change_set_id
      AND basis_type <> 'manual_override'
  ) THEN
    PERFORM setting_key
    FROM public.app_settings
    WHERE setting_key = 'supplier_cost_basis_enabled'
    FOR UPDATE;
  END IF;

  PERFORM l.id
  FROM public.product_supplier_links l
  JOIN public.product_cost_basis_change_rows r
    ON r.supplier_price_observation_id IS NOT NULL
  JOIN public.supplier_price_observations o
    ON o.id = r.supplier_price_observation_id
   AND o.product_supplier_link_id = l.id
  WHERE r.pricing_change_set_id = p_change_set_id
  ORDER BY l.id
  FOR UPDATE OF l;

  PERFORM v.id
  FROM public.vendors v
  JOIN public.supplier_price_observations o ON o.vendor_id = v.id
  JOIN public.product_cost_basis_change_rows r
    ON r.supplier_price_observation_id = o.id
  WHERE r.pricing_change_set_id = p_change_set_id
  ORDER BY v.id
  FOR UPDATE OF v;

  PERFORM o.id
  FROM public.supplier_price_observations o
  JOIN public.product_cost_basis_change_rows r
    ON r.supplier_price_observation_id = o.id
  WHERE r.pricing_change_set_id = p_change_set_id
  ORDER BY o.id
  FOR UPDATE OF o;

  -- Match receiving/reversal lock order: item first, then parent PO. Reversing a
  -- receipt updates purchase_order_items before purchase_orders, so taking the
  -- opposite order here would create a deadlock cycle under concurrent apply.
  PERFORM poi.id
  FROM public.purchase_order_items poi
  JOIN public.product_cost_basis_change_rows r
    ON r.purchase_order_item_id = poi.id
  WHERE r.pricing_change_set_id = p_change_set_id
  ORDER BY poi.id
  FOR UPDATE OF poi;

  PERFORM po.id
  FROM public.purchase_orders po
  JOIN public.purchase_order_items poi ON poi.purchase_order_id = po.id
  JOIN public.product_cost_basis_change_rows r
    ON r.purchase_order_item_id = poi.id
  WHERE r.pricing_change_set_id = p_change_set_id
  ORDER BY po.id
  FOR UPDATE OF po;

  -- Stable product lock order and an independent version check also protect
  -- basis-only selections where the shared pricing preview had no price delta.
  PERFORM p.id
  FROM public.products p
  JOIN public.product_cost_basis_change_rows r ON r.product_id = p.id
  WHERE r.pricing_change_set_id = p_change_set_id
  ORDER BY p.id
  FOR UPDATE OF p;

  IF EXISTS (
    SELECT 1
    FROM public.product_cost_basis_change_rows r
    LEFT JOIN public.products p ON p.id = r.product_id
    WHERE r.pricing_change_set_id = p_change_set_id
      AND (p.id IS NULL OR NOT p.is_active
        OR p.pricing_version IS DISTINCT FROM r.expected_version
        OR r.expected_active_basis_id IS DISTINCT FROM (
          SELECT active.id
          FROM public.product_cost_basis active
          WHERE active.product_id = r.product_id
            AND active.effective_to IS NULL
        ))
  ) THEN
    RAISE EXCEPTION 'PRICING_ROW_CONFLICT';
  END IF;

  -- Evidence and the OFF-by-default gate are checked again at apply time only
  -- after every Product row is locked. This closes the pricing-free Product
  -- race where a concurrent unit edit could otherwise occur after evidence
  -- resolution but before the Product lock. Source rows were locked above, so
  -- the resolver now observes one stable Product/evidence snapshot.
  FOR v_row IN
    SELECT * FROM public.product_cost_basis_change_rows
    WHERE pricing_change_set_id = p_change_set_id
    ORDER BY product_id
  LOOP
    PERFORM public._resolve_product_cost_basis_row(jsonb_build_object(
      'product_id', v_row.product_id,
      'row_version', v_row.expected_version,
      'basis_type', v_row.basis_type,
      'new_cost', public._format_pricing_dollars(v_row.cost_cents),
      'basis_reason', v_row.reason,
      'basis_source', v_row.selection_source,
      'basis_selection', v_row.force_selection,
      'supplier_price_observation_id', v_row.supplier_price_observation_id,
      'purchase_order_item_id', v_row.purchase_order_item_id
    ));
  END LOOP;

  PERFORM set_config('crx.cost_basis_authorized', 'phase2', true);
  PERFORM set_config('crx.cost_basis_actor', v_actor::text, true);
  PERFORM set_config('crx.cost_basis_change_set_id', p_change_set_id::text, true);

  IF v_change_set.status = 'previewed' THEN
    v_pricing_result := public.apply_product_pricing_change_set(
      p_change_set_id,
      p_request_fingerprint,
      v_actor,
      v_inner_key
    );
  ELSE
    v_pricing_result := jsonb_build_object(
      'change_set_id', p_change_set_id,
      'status', 'applied',
      'applied_count', 0,
      'rows', '[]'::jsonb
    );
  END IF;

  FOR v_row IN
    SELECT * FROM public.product_cost_basis_change_rows
    WHERE pricing_change_set_id = p_change_set_id
    ORDER BY product_id
  LOOP
    SELECT * INTO v_active
    FROM public.product_cost_basis
    WHERE product_id = v_row.product_id AND effective_to IS NULL
    FOR UPDATE;

    IF v_active.id IS NULL
       OR v_active.cost_cents IS DISTINCT FROM v_row.cost_cents
       OR v_row.force_selection THEN
      IF v_active.id IS NOT NULL THEN
        UPDATE public.product_cost_basis
        SET effective_to = v_now
        WHERE id = v_active.id;
      END IF;

      INSERT INTO public.product_cost_basis(
        product_id, basis_type, cost_cents,
        supplier_price_observation_id, purchase_order_item_id,
        pricing_change_set_id, selection_source, reason,
        selected_by, selected_at, effective_from
      ) VALUES (
        v_row.product_id, v_row.basis_type, v_row.cost_cents,
        v_row.supplier_price_observation_id, v_row.purchase_order_item_id,
        p_change_set_id, v_row.selection_source, v_row.reason,
        v_actor, v_now, v_now
      );
    END IF;
  END LOOP;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', b.id,
    'product_id', b.product_id,
    'basis_type', b.basis_type,
    'cost_cents', b.cost_cents,
    'supplier_price_observation_id', b.supplier_price_observation_id,
    'purchase_order_item_id', b.purchase_order_item_id,
    'selection_source', b.selection_source,
    'reason', b.reason,
    'selected_at', b.selected_at
  ) ORDER BY b.product_id), '[]'::jsonb)
  INTO v_basis_rows
  FROM public.product_cost_basis b
  WHERE b.pricing_change_set_id = p_change_set_id;

  v_pricing_result := v_pricing_result || jsonb_build_object(
    'cost_basis_rows', v_basis_rows
  );

  UPDATE public.pricing_change_sets
  SET status = 'applied',
      applied_by = v_actor,
      applied_at = COALESCE(applied_at, v_now),
      apply_idempotency_key = v_inner_key,
      apply_result = v_pricing_result
  WHERE id = p_change_set_id;

  IF v_change_set.status = 'no_changes' AND v_change_set.export_id IS NOT NULL THEN
    UPDATE public.pricing_workbook_exports
    SET status = 'consumed'
    WHERE id = v_change_set.export_id AND status = 'active';
  END IF;

  PERFORM public.save_idempotency(
    p_idempotency_key,
    'apply_product_cost_basis_change_set',
    jsonb_build_object(
      'actor_id', v_actor,
      'request_fingerprint', v_idem_fp,
      'response', v_pricing_result
    )
  );
  RETURN v_pricing_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.apply_product_cost_basis_change_set(
  uuid, text, uuid, text
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.apply_product_cost_basis_change_set(
  uuid, text, uuid, text
) TO authenticated;

-- While the supplier-cost flag is OFF, preserve the deployed Phase 1a Product
-- editor without allowing ledger drift. The existing governed pricing RPC is
-- accepted only with its full actor/change-set context; an AFTER trigger below
-- records the matching manual basis atomically. Enabling Phase 2 removes this
-- compatibility route and requires the new wrapper.
CREATE OR REPLACE FUNCTION public.require_product_cost_basis_context()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := NULLIF(current_setting('crx.cost_basis_actor', true), '')::uuid;
  v_change_set_id uuid := NULLIF(
    current_setting('crx.cost_basis_change_set_id', true), ''
  )::uuid;
  v_pricing_actor uuid := NULLIF(current_setting('crx.pricing_actor', true), '')::uuid;
  v_pricing_change_set_id uuid := NULLIF(
    current_setting('crx.pricing_change_set_id', true), ''
  )::uuid;
  v_pricing_source text := NULLIF(current_setting('crx.pricing_source', true), '');
BEGIN
  IF TG_OP <> 'UPDATE' OR OLD.current_cost IS NOT DISTINCT FROM NEW.current_cost THEN
    RETURN NEW;
  END IF;

  IF current_setting('crx.cost_basis_authorized', true) = 'phase2'
     AND v_actor IS NOT NULL AND v_actor IS NOT DISTINCT FROM auth.uid()
     AND v_change_set_id IS NOT NULL
     AND public.is_admin()
     AND EXISTS (
       SELECT 1
       FROM public.pricing_change_sets c
       JOIN public.product_cost_basis_change_rows r
         ON r.pricing_change_set_id = c.id
       WHERE c.id = v_change_set_id
         AND c.created_by = v_actor
         AND c.status = 'previewed'
         AND r.product_id = NEW.id
         AND r.cost_cents = round(NEW.current_cost::numeric * 100)::bigint
     ) THEN
    RETURN NEW;
  END IF;

  IF current_setting('crx.pricing_authorized', true) = 'phase1a'
     AND v_pricing_actor IS NOT NULL
     AND v_pricing_actor IS NOT DISTINCT FROM auth.uid()
     AND v_pricing_change_set_id IS NOT NULL
     AND v_pricing_source IN ('pricing_worksheet', 'product_page', 'products_inline')
     AND public.is_admin()
     AND COALESCE((
       SELECT setting_value = 'true'
       FROM public.app_settings
       WHERE setting_key = 'supplier_cost_basis_enabled'
     ), false) IS FALSE
     AND EXISTS (
       SELECT 1
       FROM public.pricing_change_sets c
       JOIN public.pricing_change_set_rows r ON r.change_set_id = c.id
       WHERE c.id = v_pricing_change_set_id
         AND c.created_by = v_pricing_actor
         AND c.status = 'previewed'
         AND c.source = v_pricing_source
         AND r.product_id = NEW.id
         AND r.output_cost_cents = round(NEW.current_cost::numeric * 100)::bigint
     ) THEN
    PERFORM set_config('crx.cost_basis_legacy_sync', 'phase1a', true);
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'PRODUCT_COST_BASIS_CONTEXT_REQUIRED';
END;
$function$;

REVOKE ALL ON FUNCTION public.require_product_cost_basis_context()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.sync_legacy_product_cost_basis()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := NULLIF(current_setting('crx.pricing_actor', true), '')::uuid;
  v_change_set_id uuid := NULLIF(
    current_setting('crx.pricing_change_set_id', true), ''
  )::uuid;
  v_source text := NULLIF(current_setting('crx.pricing_source', true), '');
  v_reason text := NULLIF(current_setting('crx.pricing_reason', true), '');
  v_active_id uuid;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF OLD.current_cost IS NOT DISTINCT FROM NEW.current_cost
     OR current_setting('crx.cost_basis_legacy_sync', true) IS DISTINCT FROM 'phase1a' THEN
    RETURN NEW;
  END IF;

  IF v_actor IS NULL OR v_actor IS DISTINCT FROM auth.uid()
     OR v_change_set_id IS NULL
     OR v_source NOT IN ('pricing_worksheet', 'product_page', 'products_inline')
     OR NOT public.is_admin()
     OR COALESCE((
       SELECT setting_value = 'true'
       FROM public.app_settings
       WHERE setting_key = 'supplier_cost_basis_enabled'
     ), false) IS NOT FALSE
     OR NOT EXISTS (
       SELECT 1
       FROM public.pricing_change_sets c
       JOIN public.pricing_change_set_rows r ON r.change_set_id = c.id
       WHERE c.id = v_change_set_id
         AND c.created_by = v_actor
         AND c.status = 'previewed'
         AND c.source = v_source
         AND r.product_id = NEW.id
         AND r.output_cost_cents = round(NEW.current_cost::numeric * 100)::bigint
     ) THEN
    RAISE EXCEPTION 'LEGACY_COST_BASIS_CONTEXT_INVALID';
  END IF;

  SELECT id INTO v_active_id
  FROM public.product_cost_basis
  WHERE product_id = NEW.id AND effective_to IS NULL
  FOR UPDATE;

  PERFORM set_config('crx.cost_basis_authorized', 'phase2', true);
  PERFORM set_config('crx.cost_basis_actor', v_actor::text, true);
  PERFORM set_config('crx.cost_basis_change_set_id', v_change_set_id::text, true);

  IF v_active_id IS NOT NULL THEN
    UPDATE public.product_cost_basis
    SET effective_to = v_now
    WHERE id = v_active_id;
  END IF;

  INSERT INTO public.product_cost_basis(
    product_id, basis_type, cost_cents, pricing_change_set_id,
    selection_source, reason, selected_by, selected_at, effective_from
  ) VALUES (
    NEW.id, 'manual_override', round(NEW.current_cost::numeric * 100)::bigint,
    v_change_set_id, v_source,
    COALESCE(v_reason, 'Phase 1a compatibility cost update while Phase 2 is disabled.'),
    v_actor, v_now, v_now
  );
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.sync_legacy_product_cost_basis()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trigger_zz_sync_legacy_product_cost_basis
  ON public.products;
CREATE TRIGGER trigger_zz_sync_legacy_product_cost_basis
  AFTER UPDATE ON public.products
  FOR EACH ROW EXECUTE FUNCTION public.sync_legacy_product_cost_basis();

CREATE OR REPLACE FUNCTION public.get_product_cost_basis_workspace(p_product_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_business_date date := (now() AT TIME ZONE 'America/Chicago')::date;
  v_result jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'ADMIN_REQUIRED'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.products WHERE id = p_product_id) THEN
    RAISE EXCEPTION 'PRODUCT_NOT_FOUND';
  END IF;

  SELECT jsonb_build_object(
    'enabled', COALESCE((
      SELECT setting_value = 'true' FROM public.app_settings
      WHERE setting_key = 'supplier_cost_basis_enabled'
    ), false),
    'product', jsonb_build_object(
      'id', p.id,
      'product_name', p.product_name,
      'sku', p.sku,
      'pricing_version', p.pricing_version,
      'current_cost_cents', round(p.current_cost::numeric * 100)::bigint,
      'tier1_margin_percent', public._format_pricing_margin_percent(p.tier1_margin),
      'tier2_margin_percent', public._format_pricing_margin_percent(p.tier2_margin),
      'tier3_margin_percent', public._format_pricing_margin_percent(p.tier3_margin)
    ),
    'current_basis', (
      SELECT jsonb_build_object(
        'id', b.id,
        'basis_type', b.basis_type,
        'cost_cents', b.cost_cents,
        'supplier_price_observation_id', b.supplier_price_observation_id,
        'purchase_order_item_id', b.purchase_order_item_id,
        'selection_source', b.selection_source,
        'reason', b.reason,
        'selected_at', b.selected_at
      )
      FROM public.product_cost_basis b
      WHERE b.product_id = p.id AND b.effective_to IS NULL
    ),
    'supplier_candidates', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'supplier_price_observation_id', candidate.observation_id,
        'vendor_id', candidate.vendor_id,
        'vendor_name', candidate.vendor_name,
        'quoted_package_cost_cents', candidate.package_cost_cents,
        'normalized_cost_cents', candidate.normalized_cost_cents,
        'effective_from', candidate.effective_from,
        'price_kind', candidate.price_kind
      ) ORDER BY candidate.normalized_cost_cents, candidate.vendor_name)
      FROM (
        SELECT DISTINCT ON (o.product_supplier_link_id)
          o.id AS observation_id,
          o.vendor_id,
          v.name AS vendor_name,
          o.cost_cents AS package_cost_cents,
          round(o.cost_cents::numeric / o.package_quantity
            / l.inventory_units_per_supplier_unit)::bigint AS normalized_cost_cents,
          o.effective_from,
          o.price_kind,
          o.product_supplier_link_id
        FROM public.supplier_price_observations o
        JOIN public.product_supplier_links l
          ON l.id = o.product_supplier_link_id
        JOIN public.vendors v ON v.id = o.vendor_id AND v.deleted_at IS NULL
        WHERE o.product_id = p.id
          AND l.product_id = p.id
          AND l.is_active AND l.is_reusable
          AND l.comparison_status = 'comparable'
          AND l.inventory_units_per_supplier_unit > 0
          AND lower(btrim(l.conversion_unit)) = lower(COALESCE(
            NULLIF(btrim(p.inventory_unit), ''), NULLIF(btrim(p.unit_size), '')
          ))
          AND o.package_quantity > 0
          AND o.effective_from <= v_business_date
          AND (o.effective_to IS NULL OR o.effective_to >= v_business_date)
          AND NOT EXISTS (
            SELECT 1 FROM public.supplier_price_observations correction
            WHERE correction.supersedes_observation_id = o.id
          )
        ORDER BY o.product_supplier_link_id, o.effective_from DESC,
          o.observed_at DESC, o.id DESC
      ) candidate
    ), '[]'::jsonb),
    'purchase_candidates', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'purchase_order_item_id', candidate.purchase_order_item_id,
        'purchase_order_id', candidate.purchase_order_id,
        'po_number', candidate.po_number,
        'vendor_name', candidate.vendor_name,
        'normalized_cost_cents', candidate.normalized_cost_cents,
        'purchased_at', candidate.purchased_at
      ) ORDER BY candidate.purchased_at DESC, candidate.purchase_order_item_id DESC)
      FROM (
        SELECT
          poi.id AS purchase_order_item_id,
          po.id AS purchase_order_id,
          po.po_number::text AS po_number,
          COALESCE(v.name, 'supplier unknown') AS vendor_name,
          round(poi.unit_cost_cents::numeric
            / poi.inventory_units_per_supplier_unit_snapshot)::bigint
            AS normalized_cost_cents,
          COALESCE(po.submitted_date::timestamptz, po.created_at) AS purchased_at
        FROM public.purchase_order_items poi
        JOIN public.purchase_orders po ON po.id = poi.purchase_order_id
        LEFT JOIN public.legacy_vendor_resolution resolved
          ON resolved.normalized_text = public.normalize_vendor_alias(po.vendor)
         AND resolved.review_status = 'approved'
        LEFT JOIN public.vendors v ON v.id = resolved.vendor_id
        WHERE poi.product_id = p.id
          AND poi.quantity_received > 0
          AND poi.unit_cost_cents IS NOT NULL
          AND poi.inventory_units_per_supplier_unit_snapshot > 0
          AND lower(btrim(poi.inventory_unit_snapshot)) = lower(COALESCE(
            NULLIF(btrim(p.inventory_unit), ''), NULLIF(btrim(p.unit_size), '')
          ))
          AND po.status <> 'cancelled'
        ORDER BY purchased_at DESC, poi.id DESC
        LIMIT 20
      ) candidate
    ), '[]'::jsonb)
  ) INTO v_result
  FROM public.products p
  WHERE p.id = p_product_id;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_product_cost_basis_workspace(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_product_cost_basis_workspace(uuid)
  TO authenticated;

-- The Product history now reads the explicit Phase 2 basis ledger. Earlier
-- Phase 1a cost_history points remain visible before the migration baseline.
CREATE OR REPLACE FUNCTION public.get_product_price_history(p_product_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_result jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'ADMIN_REQUIRED'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.products WHERE id = p_product_id) THEN
    RAISE EXCEPTION 'PRODUCT_NOT_FOUND';
  END IF;

  WITH history_points AS (
    SELECT
      'supplier_observation'::text AS stream,
      o.id::text AS source_id,
      o.vendor_id,
      v.name AS supplier_name,
      o.cost_cents,
      CASE WHEN l.comparison_status = 'comparable'
             AND l.inventory_units_per_supplier_unit > 0
             AND lower(btrim(l.conversion_unit)) = lower(COALESCE(
               NULLIF(btrim(supplier_product.inventory_unit), ''),
               NULLIF(btrim(supplier_product.unit_size), '')
             ))
        THEN round(o.cost_cents::numeric / o.package_quantity
          / l.inventory_units_per_supplier_unit)::bigint
        ELSE NULL END AS normalized_cost_cents,
      o.effective_from::timestamptz AS occurred_at,
      o.price_kind AS detail,
      jsonb_build_object(
        'import_id', o.import_id,
        'import_row_id', o.import_row_id,
        'product_supplier_link_id', o.product_supplier_link_id,
        'price_unit', o.price_unit,
        'package_quantity', o.package_quantity
      ) AS provenance
    FROM public.supplier_price_observations o
    JOIN public.product_supplier_links l ON l.id = o.product_supplier_link_id
    JOIN public.products supplier_product ON supplier_product.id = o.product_id
    JOIN public.vendors v ON v.id = o.vendor_id
    WHERE o.product_id = p_product_id

    UNION ALL

    SELECT
      'selected_cost_basis'::text,
      b.id::text,
      COALESCE(o.vendor_id, basis_resolved.vendor_id),
      COALESCE(v.name, basis_purchase_vendor.name),
      b.cost_cents,
      b.cost_cents,
      b.effective_from,
      b.basis_type,
      jsonb_build_object(
        'pricing_change_set_id', b.pricing_change_set_id,
        'supplier_price_observation_id', b.supplier_price_observation_id,
        'purchase_order_item_id', b.purchase_order_item_id,
        'selection_source', b.selection_source,
        'reason', b.reason,
        'selected_by', b.selected_by,
        'effective_to', b.effective_to
      )
    FROM public.product_cost_basis b
    LEFT JOIN public.supplier_price_observations o
      ON o.id = b.supplier_price_observation_id
    LEFT JOIN public.vendors v ON v.id = o.vendor_id
    LEFT JOIN public.purchase_order_items basis_poi
      ON basis_poi.id = b.purchase_order_item_id
    LEFT JOIN public.purchase_orders basis_po
      ON basis_po.id = basis_poi.purchase_order_id
    LEFT JOIN public.legacy_vendor_resolution basis_resolved
      ON basis_resolved.normalized_text = public.normalize_vendor_alias(basis_po.vendor)
     AND basis_resolved.review_status = 'approved'
    LEFT JOIN public.vendors basis_purchase_vendor
      ON basis_purchase_vendor.id = basis_resolved.vendor_id
    WHERE b.product_id = p_product_id

    UNION ALL

    SELECT
      'selected_cost_basis'::text,
      ch.id::text,
      NULL::uuid,
      NULL::text,
      round(ch.new_cost * 100)::bigint,
      round(ch.new_cost * 100)::bigint,
      ch.changed_at,
      COALESCE(ch.change_note, ch.change_source, 'Product pricing history'),
      jsonb_build_object(
        'legacy_cost_history', true,
        'change_set_id', ch.change_set_id,
        'changed_by', ch.changed_by
      )
    FROM public.cost_history ch
    WHERE ch.product_id = p_product_id
      AND ch.new_cost IS NOT NULL
      AND ch.changed_at < COALESCE((
        SELECT min(b.created_at) FROM public.product_cost_basis b
        WHERE b.product_id = p_product_id
      ), 'infinity'::timestamptz)

    UNION ALL

    SELECT
      'actual_purchase'::text,
      poi.id::text,
      resolved.vendor_id,
      COALESCE(v.name, 'supplier unknown'),
      poi.unit_cost_cents,
      CASE WHEN poi.inventory_units_per_supplier_unit_snapshot > 0
          AND lower(btrim(poi.inventory_unit_snapshot)) = lower(COALESCE(
            NULLIF(btrim(p.inventory_unit), ''), NULLIF(btrim(p.unit_size), '')
          ))
        THEN round(poi.unit_cost_cents::numeric
          / poi.inventory_units_per_supplier_unit_snapshot)::bigint
        ELSE NULL END,
      COALESCE(po.submitted_date::timestamptz, po.created_at),
      'actual_purchase',
      jsonb_build_object(
        'purchase_order_id', po.id,
        'purchase_order_item_id', poi.id,
        'po_number', po.po_number,
        'legacy_vendor_text', po.vendor,
        'resolution_status', CASE WHEN resolved.vendor_id IS NULL
          THEN 'supplier unknown' ELSE 'reviewed' END,
        'cost_provenance', poi.cost_provenance
      )
    FROM public.purchase_order_items poi
    JOIN public.purchase_orders po ON po.id = poi.purchase_order_id
    JOIN public.products p ON p.id = poi.product_id
    LEFT JOIN public.legacy_vendor_resolution resolved
      ON resolved.normalized_text = public.normalize_vendor_alias(po.vendor)
     AND resolved.review_status = 'approved'
    LEFT JOIN public.vendors v ON v.id = resolved.vendor_id
    WHERE poi.product_id = p_product_id
      AND poi.quantity_received > 0
      AND poi.unit_cost_cents IS NOT NULL
      AND po.status <> 'cancelled'
  )
  SELECT jsonb_build_object(
    'product_id', p_product_id,
    'summary', COALESCE(
      public.get_supplier_market_evidence(ARRAY[p_product_id])->0,
      jsonb_build_object(
        'product_id', p_product_id,
        'supplier_quote_count', 0,
        'comparable_quote_count', 0,
        'replacement_cost_cents', NULL,
        'replacement_cost_as_of', NULL,
        'best_supplier', NULL,
        'last_paid_cents', NULL,
        'last_paid_as_of', NULL,
        'recent_po_weighted_average_cents', NULL,
        'recent_po_window', 'trailing_12_months',
        'comparison_status', 'no_evidence',
        'suppliers', '[]'::jsonb
      )
    ),
    'suppliers', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', s.vendor_id, 'name', s.supplier_name
      ) ORDER BY s.supplier_name)
      FROM (
        SELECT DISTINCT vendor_id, supplier_name FROM history_points
        WHERE vendor_id IS NOT NULL
      ) s
    ), '[]'::jsonb),
    'points', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'stream', h.stream,
        'source_id', h.source_id,
        'vendor_id', h.vendor_id,
        'supplier_name', h.supplier_name,
        'cost_cents', h.cost_cents,
        'normalized_cost_cents', h.normalized_cost_cents,
        'occurred_at', h.occurred_at,
        'detail', h.detail,
        'provenance', h.provenance
      ) ORDER BY h.occurred_at, h.stream, h.source_id)
      FROM history_points h
    ), '[]'::jsonb)
  ) INTO v_result;
  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_product_price_history(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_product_price_history(uuid)
  TO authenticated;

-- Fail closed if the migration shape or grants drift during future edits.
DO $migration_checks$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'product_cost_basis'
      AND c.relrowsecurity
  ) THEN
    RAISE EXCEPTION 'product_cost_basis RLS missing';
  END IF;
  IF has_table_privilege('authenticated', 'public.product_cost_basis', 'SELECT')
     OR has_table_privilege('authenticated', 'public.product_cost_basis', 'INSERT')
     OR has_table_privilege('authenticated', 'public.product_cost_basis', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.product_cost_basis', 'DELETE') THEN
    RAISE EXCEPTION 'direct product_cost_basis privilege survived';
  END IF;
  IF has_function_privilege(
       'anon',
       'public.preview_product_cost_basis_changes(text,uuid,jsonb,uuid,text)',
       'EXECUTE'
     ) OR has_function_privilege(
       'service_role',
       'public.apply_product_cost_basis_change_set(uuid,text,uuid,text)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'cost-basis RPC grant drift';
  END IF;
  IF NOT has_function_privilege(
       'authenticated',
       'public.get_product_cost_basis_workspace(uuid)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'cost-basis reader grant missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.products'::regclass
      AND tgname = 'trigger_zz_require_product_cost_basis'
      AND NOT tgisinternal
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.products'::regclass
      AND tgname = 'trigger_zz_sync_legacy_product_cost_basis'
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'cost-basis Product trigger missing';
  END IF;
  IF has_function_privilege(
       'authenticated', 'public.sync_legacy_product_cost_basis()', 'EXECUTE'
     ) OR has_function_privilege(
       'service_role', 'public.sync_legacy_product_cost_basis()', 'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'legacy cost-basis sync is directly executable';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.purchase_order_items'::regclass
      AND tgname = 'trigger_capture_purchase_order_item_cost_snapshot'
      AND NOT tgisinternal
  ) OR has_function_privilege(
       'authenticated', 'public.capture_purchase_order_item_cost_snapshot()',
       'EXECUTE'
     ) OR has_function_privilege(
       'service_role', 'public.capture_purchase_order_item_cost_snapshot()',
       'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'purchase-order cost snapshot trigger or grants invalid';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.products'::regclass
      AND tgname = 'trigger_guard_product_cost_basis_unit_change'
      AND NOT tgisinternal
  ) OR has_function_privilege(
       'authenticated', 'public.guard_product_cost_basis_unit_change()', 'EXECUTE'
     ) OR has_function_privilege(
       'service_role', 'public.guard_product_cost_basis_unit_change()', 'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'Product cost-basis unit guard trigger or grants invalid';
  END IF;
  IF (
    SELECT count(*) FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'preview_product_cost_basis_changes'
  ) <> 1 OR to_regprocedure(
    'public.preview_product_cost_basis_changes(text,uuid,jsonb,uuid,text)'
  ) IS NULL THEN
    RAISE EXCEPTION 'preview_product_cost_basis_changes overload drift';
  END IF;
  IF (
    SELECT count(*) FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'apply_product_cost_basis_change_set'
  ) <> 1 OR to_regprocedure(
    'public.apply_product_cost_basis_change_set(uuid,text,uuid,text)'
  ) IS NULL THEN
    RAISE EXCEPTION 'apply_product_cost_basis_change_set overload drift';
  END IF;
  IF (
    SELECT count(*) FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'get_product_cost_basis_workspace'
  ) <> 1 OR to_regprocedure(
    'public.get_product_cost_basis_workspace(uuid)'
  ) IS NULL THEN
    RAISE EXCEPTION 'get_product_cost_basis_workspace overload drift';
  END IF;
  IF (
    SELECT count(*) FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'get_product_price_history'
  ) <> 1 OR to_regprocedure('public.get_product_price_history(uuid)') IS NULL THEN
    RAISE EXCEPTION 'get_product_price_history overload drift';
  END IF;
END;
$migration_checks$;
