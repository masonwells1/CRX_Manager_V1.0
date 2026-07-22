-- Prevent a received purchase-order line from escaping Wells cost-basis
-- immutability by being reassigned from a rollout Product to a non-rollout
-- Product. The original rollout migration checked only NEW.product_id.

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

  IF TG_OP = 'UPDATE' THEN
    v_phase2_enabled := v_phase2_enabled
      OR public._supplier_cost_basis_enabled_for_product(OLD.product_id);
  END IF;

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

REVOKE ALL ON FUNCTION public.capture_purchase_order_item_cost_snapshot()
  FROM PUBLIC, anon, authenticated, service_role;
