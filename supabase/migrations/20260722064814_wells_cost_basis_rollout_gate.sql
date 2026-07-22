-- Supplier cost-basis Wells-only rollout gate.
-- Applied live as ledger version 20260722064814 under submitted name
-- 20260722060644_wells_cost_basis_rollout_gate.
--
-- The global supplier_cost_basis_enabled switch remains the full-rollout path.
-- Until it is turned on, only the ten reviewed Wells pilot Products may use
-- supplier or received-purchase evidence. Non-pilot Products retain the
-- deployed Phase 1a quick-edit compatibility path.

DO $wells_shape$
DECLARE
  v_product_ids uuid[] := ARRAY[
    'ab708913-080e-4894-ba5c-8beb7586d356'::uuid,
    '8db05fc1-c3c9-4049-b284-c02c0a7a3056'::uuid,
    '6fd3adc1-909f-4b63-98fa-73028a780a7c'::uuid,
    '7de7131e-b4cb-4048-be14-77eb3449b20f'::uuid,
    '908f29d4-62d9-404b-93e0-50666f65ee99'::uuid,
    '05b9f5d8-3305-4234-afaa-e7a63c3b46f9'::uuid,
    '81f689f5-c78f-480a-b884-4e097986e212'::uuid,
    '44b47fe1-9484-4ede-95d6-52988a840d75'::uuid,
    'd1961efe-6133-4ab4-bf84-ac7bf7da903a'::uuid,
    '03dbce7d-c142-4f24-8bfc-cc490fa47a0d'::uuid
  ];
  v_wells_vendor_id uuid;
BEGIN
  IF cardinality(v_product_ids) <> 10
     OR (SELECT count(DISTINCT id) FROM unnest(v_product_ids) AS ids(id)) <> 10 THEN
    RAISE EXCEPTION 'WELLS_COST_BASIS_ROLLOUT_ID_SET_INVALID';
  END IF;

  -- The global switch is the first lock in every Phase 2 apply. A Wells-only
  -- rollout is safe only while that one canonical row exists and remains off.
  PERFORM s.setting_key
  FROM public.app_settings s
  WHERE s.setting_key = 'supplier_cost_basis_enabled'
  FOR UPDATE OF s;

  IF (
    SELECT count(*)
    FROM public.app_settings s
    WHERE s.setting_key = 'supplier_cost_basis_enabled'
  ) <> 1 OR (
    SELECT s.setting_value
    FROM public.app_settings s
    WHERE s.setting_key = 'supplier_cost_basis_enabled'
  ) IS DISTINCT FROM 'false' THEN
    RAISE EXCEPTION 'WELLS_COST_BASIS_ROLLOUT_GLOBAL_FLAG_DRIFT';
  END IF;

  SELECT (array_agg(v.id))[1]
  INTO v_wells_vendor_id
  FROM public.vendors v
  WHERE v.deleted_at IS NULL
    AND public.normalize_vendor_alias(v.name) =
        public.normalize_vendor_alias('Wells Ag Supply')
  HAVING count(*) = 1;

  IF v_wells_vendor_id IS NULL THEN
    RAISE EXCEPTION 'WELLS_COST_BASIS_ROLLOUT_VENDOR_SHAPE_DRIFT';
  END IF;

  -- Match the established Phase 2 apply/correction lock order. Observation
  -- locks also block a concurrent correction's supersedes FK; link/vendor/
  -- Product locks then block evidence inserts or eligibility edits through
  -- the final assertions and rollout seed commit.
  PERFORM o.id
  FROM public.supplier_price_observations o
  WHERE o.vendor_id = v_wells_vendor_id
    AND o.product_id = ANY(v_product_ids)
    AND NOT EXISTS (
      SELECT 1
      FROM public.supplier_price_observations newer
      WHERE newer.supersedes_observation_id = o.id
    )
  ORDER BY o.id
  FOR UPDATE OF o;

  PERFORM l.id
  FROM public.product_supplier_links l
  WHERE l.vendor_id = v_wells_vendor_id
    AND l.product_id = ANY(v_product_ids)
  ORDER BY l.id
  FOR UPDATE OF l;

  PERFORM v.id
  FROM public.vendors v
  WHERE v.id = v_wells_vendor_id
  FOR UPDATE OF v;

  PERFORM p.id
  FROM public.products p
  WHERE p.id = ANY(v_product_ids)
  ORDER BY p.id
  FOR UPDATE OF p;

  IF (
    SELECT count(*)
    FROM public.app_settings s
    WHERE s.setting_key = 'supplier_cost_basis_enabled'
  ) <> 1 OR (
    SELECT s.setting_value
    FROM public.app_settings s
    WHERE s.setting_key = 'supplier_cost_basis_enabled'
  ) IS DISTINCT FROM 'false' THEN
    RAISE EXCEPTION 'WELLS_COST_BASIS_ROLLOUT_GLOBAL_FLAG_DRIFT';
  END IF;

  IF (
    SELECT count(*)
    FROM public.vendors v
    WHERE v.deleted_at IS NULL
      AND public.normalize_vendor_alias(v.name) =
          public.normalize_vendor_alias('Wells Ag Supply')
  ) <> 1 OR NOT EXISTS (
    SELECT 1
    FROM public.vendors v
    WHERE v.id = v_wells_vendor_id
      AND v.deleted_at IS NULL
      AND public.normalize_vendor_alias(v.name) =
          public.normalize_vendor_alias('Wells Ag Supply')
  ) THEN
    RAISE EXCEPTION 'WELLS_COST_BASIS_ROLLOUT_VENDOR_SHAPE_DRIFT';
  END IF;

  IF (
    SELECT count(*)
    FROM public.products p
    WHERE p.id = ANY(v_product_ids) AND p.is_active
  ) <> 10 THEN
    RAISE EXCEPTION 'WELLS_COST_BASIS_ROLLOUT_PRODUCT_SHAPE_DRIFT';
  END IF;

  IF (
    SELECT count(*)
    FROM public.product_supplier_links l
    JOIN public.products p ON p.id = l.product_id
    WHERE l.vendor_id = v_wells_vendor_id
      AND l.product_id = ANY(v_product_ids)
      AND l.is_active
      AND l.is_reusable
      AND l.link_status = 'confirmed'
      AND l.comparison_status = 'comparable'
      AND l.inventory_units_per_supplier_unit > 0
      AND NULLIF(btrim(l.conversion_unit), '') IS NOT NULL
      AND lower(btrim(l.conversion_unit)) = lower(COALESCE(
        NULLIF(btrim(p.inventory_unit), ''), NULLIF(btrim(p.unit_size), '')
      ))
  ) <> 10 OR EXISTS (
    SELECT 1
    FROM unnest(v_product_ids) AS ids(product_id)
    WHERE (
      SELECT count(*)
      FROM public.product_supplier_links l
      JOIN public.products p ON p.id = l.product_id
      WHERE l.product_id = ids.product_id
        AND l.vendor_id = v_wells_vendor_id
        AND l.is_active
        AND l.is_reusable
        AND l.link_status = 'confirmed'
        AND l.comparison_status = 'comparable'
        AND l.inventory_units_per_supplier_unit > 0
        AND lower(btrim(l.conversion_unit)) = lower(COALESCE(
          NULLIF(btrim(p.inventory_unit), ''), NULLIF(btrim(p.unit_size), '')
        ))
    ) <> 1
  ) THEN
    RAISE EXCEPTION 'WELLS_COST_BASIS_ROLLOUT_LINK_SHAPE_DRIFT';
  END IF;

  IF (
    SELECT count(*)
    FROM public.supplier_price_observations o
    JOIN public.product_supplier_links l
      ON l.id = o.product_supplier_link_id
     AND l.product_id = o.product_id
     AND l.vendor_id = o.vendor_id
    JOIN public.products p ON p.id = o.product_id
    WHERE o.vendor_id = v_wells_vendor_id
      AND o.product_id = ANY(v_product_ids)
      AND l.is_active
      AND l.is_reusable
      AND l.link_status = 'confirmed'
      AND l.comparison_status = 'comparable'
      AND l.inventory_units_per_supplier_unit > 0
      AND lower(btrim(l.conversion_unit)) = lower(COALESCE(
        NULLIF(btrim(p.inventory_unit), ''), NULLIF(btrim(p.unit_size), '')
      ))
      AND o.effective_from <= (now() AT TIME ZONE 'America/Chicago')::date
      AND (o.effective_to IS NULL
        OR o.effective_to >= (now() AT TIME ZONE 'America/Chicago')::date)
      AND NOT EXISTS (
        SELECT 1
        FROM public.supplier_price_observations newer
        WHERE newer.supersedes_observation_id = o.id
      )
  ) <> 10 OR EXISTS (
    SELECT 1
    FROM unnest(v_product_ids) AS ids(product_id)
    WHERE (
      SELECT count(*)
      FROM public.supplier_price_observations o
      JOIN public.product_supplier_links l
        ON l.id = o.product_supplier_link_id
       AND l.product_id = o.product_id
       AND l.vendor_id = o.vendor_id
      JOIN public.products p ON p.id = o.product_id
      WHERE o.product_id = ids.product_id
        AND o.vendor_id = v_wells_vendor_id
        AND l.is_active
        AND l.is_reusable
        AND l.link_status = 'confirmed'
        AND l.comparison_status = 'comparable'
        AND l.inventory_units_per_supplier_unit > 0
        AND lower(btrim(l.conversion_unit)) = lower(COALESCE(
          NULLIF(btrim(p.inventory_unit), ''), NULLIF(btrim(p.unit_size), '')
        ))
        AND o.effective_from <= (now() AT TIME ZONE 'America/Chicago')::date
        AND (o.effective_to IS NULL
          OR o.effective_to >= (now() AT TIME ZONE 'America/Chicago')::date)
        AND NOT EXISTS (
          SELECT 1
          FROM public.supplier_price_observations newer
          WHERE newer.supersedes_observation_id = o.id
        )
    ) <> 1
  ) THEN
    RAISE EXCEPTION 'WELLS_COST_BASIS_ROLLOUT_OBSERVATION_SHAPE_DRIFT';
  END IF;
END;
$wells_shape$;

CREATE TABLE public.product_cost_basis_rollout (
  product_id uuid PRIMARY KEY
    REFERENCES public.products(id) ON DELETE RESTRICT,
  rollout_scope text NOT NULL
    CHECK (rollout_scope = 'wells_phase2_canary'),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.product_cost_basis_rollout ENABLE ROW LEVEL SECURITY;
CREATE POLICY product_cost_basis_rollout_deny_all
  ON public.product_cost_basis_rollout
  FOR ALL TO PUBLIC
  USING (false)
  WITH CHECK (false);

REVOKE ALL ON TABLE public.product_cost_basis_rollout
  FROM PUBLIC, anon, authenticated, service_role;

INSERT INTO public.product_cost_basis_rollout(product_id, rollout_scope)
VALUES
  ('ab708913-080e-4894-ba5c-8beb7586d356', 'wells_phase2_canary'),
  ('8db05fc1-c3c9-4049-b284-c02c0a7a3056', 'wells_phase2_canary'),
  ('6fd3adc1-909f-4b63-98fa-73028a780a7c', 'wells_phase2_canary'),
  ('7de7131e-b4cb-4048-be14-77eb3449b20f', 'wells_phase2_canary'),
  ('908f29d4-62d9-404b-93e0-50666f65ee99', 'wells_phase2_canary'),
  ('05b9f5d8-3305-4234-afaa-e7a63c3b46f9', 'wells_phase2_canary'),
  ('81f689f5-c78f-480a-b884-4e097986e212', 'wells_phase2_canary'),
  ('44b47fe1-9484-4ede-95d6-52988a840d75', 'wells_phase2_canary'),
  ('d1961efe-6133-4ab4-bf84-ac7bf7da903a', 'wells_phase2_canary'),
  ('03dbce7d-c142-4f24-8bfc-cc490fa47a0d', 'wells_phase2_canary');

CREATE OR REPLACE FUNCTION public._supplier_cost_basis_enabled_for_product(
  p_product_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
  SELECT p_product_id IS NOT NULL AND (
    COALESCE((
      SELECT s.setting_value = 'true'
      FROM public.app_settings s
      WHERE s.setting_key = 'supplier_cost_basis_enabled'
    ), false)
    OR EXISTS (
      SELECT 1
      FROM public.product_cost_basis_rollout rollout
      WHERE rollout.product_id = p_product_id
    )
  )
$function$;

REVOKE ALL ON FUNCTION public._supplier_cost_basis_enabled_for_product(uuid)
  FROM PUBLIC, anon, authenticated, service_role;


CREATE OR REPLACE FUNCTION public.capture_purchase_order_item_cost_snapshot()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_inventory_unit text;
  v_phase2_enabled boolean;
BEGIN
  v_phase2_enabled := public._supplier_cost_basis_enabled_for_product(NEW.product_id);

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
  ) AND NOT COALESCE((
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
  ), false) THEN
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

  IF public._supplier_cost_basis_enabled_for_product(OLD.id)
     AND EXISTS (
       SELECT 1
       FROM public.product_cost_basis b
       WHERE b.product_id = OLD.id
         AND b.effective_to IS NULL
  ) THEN
    RAISE EXCEPTION 'PRODUCT_COST_BASIS_UNIT_CHANGE_REQUIRES_FLAG_OFF';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.product_cost_basis b
    WHERE b.product_id = OLD.id
      AND b.effective_to IS NULL
  ) THEN
    PERFORM set_config('crx.cost_basis_authorized', 'unit_change', true);
    PERFORM set_config('crx.cost_basis_unit_change_product', OLD.id::text, true);
    UPDATE public.product_cost_basis
    SET effective_to = clock_timestamp()
    WHERE product_id = OLD.id
      AND effective_to IS NULL;
    PERFORM set_config('crx.cost_basis_unit_change_product', '', true);
    PERFORM set_config('crx.cost_basis_authorized', '', true);
  END IF;

  RETURN NEW;
END;
$function$;

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
     AND public._supplier_cost_basis_enabled_for_product(v_product_id) IS NOT TRUE THEN
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
     AND public._supplier_cost_basis_enabled_for_product(NEW.id) IS FALSE
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
     OR public._supplier_cost_basis_enabled_for_product(NEW.id) IS NOT FALSE
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
    'enabled', public._supplier_cost_basis_enabled_for_product(p_product_id),
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
     IS DISTINCT FROM (
       SELECT count(*)
       FROM public.pricing_change_set_preview_rows preview_row
       WHERE preview_row.change_set_id = p_change_set_id
         AND public._product_cost_basis_row_required(
           v_change_set.source,
           preview_row.row_status,
           preview_row.submitted_row,
           preview_row.effect
         )
     ) THEN
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

    -- Keep rollout rows behind the setting lock and ahead of evidence/Product
    -- locks, binding the canary decision through the final resolver pass.
    PERFORM rollout.product_id
    FROM public.product_cost_basis_rollout rollout
    JOIN public.product_cost_basis_change_rows r
      ON r.product_id = rollout.product_id
    WHERE r.pricing_change_set_id = p_change_set_id
    ORDER BY rollout.product_id
    FOR UPDATE OF rollout;
  END IF;

  -- Match the correction path: lock the immutable observation first. A
  -- correction holds that row before its replacement takes FK locks on the
  -- referenced link/vendor/product, so reversing this order can deadlock.
  PERFORM o.id
  FROM public.supplier_price_observations o
  JOIN public.product_cost_basis_change_rows r
    ON r.supplier_price_observation_id = o.id
  WHERE r.pricing_change_set_id = p_change_set_id
  ORDER BY o.id
  FOR UPDATE OF o;

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

REVOKE ALL ON FUNCTION public.capture_purchase_order_item_cost_snapshot()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.guard_product_cost_basis_unit_change()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._resolve_product_cost_basis_row(jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.require_product_cost_basis_context()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.sync_legacy_product_cost_basis()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_product_cost_basis_workspace(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_product_cost_basis_workspace(uuid)
  TO authenticated;
REVOKE ALL ON FUNCTION public.apply_product_cost_basis_change_set(
  uuid, text, uuid, text
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.apply_product_cost_basis_change_set(
  uuid, text, uuid, text
) TO authenticated;

DO $migration_checks$
BEGIN
  IF (SELECT count(*) FROM public.product_cost_basis_rollout) <> 10 THEN
    RAISE EXCEPTION 'product_cost_basis_rollout seed drift';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class
          WHERE oid = 'public.product_cost_basis_rollout'::regclass)
     OR has_table_privilege('authenticated',
          'public.product_cost_basis_rollout', 'SELECT')
     OR has_table_privilege('service_role',
          'public.product_cost_basis_rollout', 'SELECT') THEN
    RAISE EXCEPTION 'product_cost_basis_rollout privacy drift';
  END IF;
  IF has_function_privilege(
       'authenticated',
       'public._supplier_cost_basis_enabled_for_product(uuid)',
       'EXECUTE'
     ) OR has_function_privilege(
       'service_role',
       'public._supplier_cost_basis_enabled_for_product(uuid)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'supplier cost-basis rollout helper grant drift';
  END IF;
  IF (
    SELECT count(*) FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN (
        '_supplier_cost_basis_enabled_for_product',
        '_resolve_product_cost_basis_row',
        'apply_product_cost_basis_change_set',
        'capture_purchase_order_item_cost_snapshot',
        'get_product_cost_basis_workspace',
        'guard_product_cost_basis_unit_change',
        'require_product_cost_basis_context',
        'sync_legacy_product_cost_basis'
      )
  ) <> 8 THEN
    RAISE EXCEPTION 'supplier cost-basis rollout function overload drift';
  END IF;
END;
$migration_checks$;
