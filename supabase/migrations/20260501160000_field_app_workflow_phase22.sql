-- =============================================================================
-- Migration: 20260501160000_field_app_workflow_phase22.sql
-- Phase 22 — Cleanup Sprint G3 + G4: cleanup tooling RPCs
--
-- Two new admin-only SECURITY DEFINER RPCs that surface and resolve the
-- production-data issues found by the audit's live SQL checks
-- (2026-05-01-claude-rebuttal-to-deep-and-codex-audits.md):
--
--   G3: 17 inventory rows have negative bucket values right now.
--       reconcile_negative_inventory(p_inventory_id, p_new_quantity,
--                                    p_reason, p_performed_by, p_idempotency_key)
--       — admin sets the correct on-hand value, the delta gets a paired
--       inventory_transactions audit row, the reason is captured in the
--       transaction notes for the financial trail.
--
--   G4: 60 historical completed deliveries have no associated active
--       invoice (predates Phase 15 auto-invoice restoration).
--       create_invoice_for_unbilled_delivery(p_delivery_id, p_performed_by,
--                                             p_idempotency_key)
--       — same auto-invoice logic as Phase 15's complete_delivery, factored
--       into a manual-trigger RPC. Refuses if the delivery already has an
--       active invoice (same guard as Phase 15).
--
-- Auth gate: admin-only, strict pattern (auth.uid() not null + actor
-- mismatch reject + is_admin() role check), matching every other
-- destructive RPC since Phase 13.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. reconcile_negative_inventory
-- -----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.reconcile_negative_inventory(uuid, numeric, text, uuid, text);

CREATE OR REPLACE FUNCTION public.reconcile_negative_inventory(
  p_inventory_id    uuid,
  p_new_quantity    numeric,
  p_reason          text,
  p_performed_by    uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor    uuid;
  v_existing jsonb;
  v_inv      record;
  v_delta    numeric;
  v_result   jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'p_performed_by does not match authenticated user';
  END IF;
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Admin access required to reconcile inventory';
  END IF;

  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RAISE EXCEPTION 'Reason is required for reconciliation';
  END IF;

  IF p_new_quantity IS NULL OR p_new_quantity < 0 THEN
    RAISE EXCEPTION 'New quantity must be >= 0';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'reconcile_negative_inventory');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  -- Lock + load
  SELECT * INTO v_inv FROM inventory WHERE id = p_inventory_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Inventory row not found: %', p_inventory_id;
  END IF;

  -- Compute delta (new - old). Positive means we're adding stock back to
  -- correct an under-count; negative means we're confirming the bucket
  -- is even lower than recorded (rare for reconciliation).
  v_delta := p_new_quantity - COALESCE(v_inv.quantity_available, 0);

  -- Update the bucket
  UPDATE inventory
  SET quantity_available = p_new_quantity,
      updated_at = now()
  WHERE id = p_inventory_id;

  -- Audit ledger entry — preserves the full reconciliation history
  INSERT INTO inventory_transactions (
    product_id, transaction_type, quantity,
    to_location, performed_by, notes
  ) VALUES (
    v_inv.product_id, 'adjusted', v_delta,
    v_inv.location, v_actor,
    'RECONCILIATION (was ' || COALESCE(v_inv.quantity_available, 0)::text ||
    ', now ' || p_new_quantity::text || '): ' || p_reason
  );

  v_result := jsonb_build_object(
    'success',           true,
    'inventory_id',      p_inventory_id,
    'product_id',        v_inv.product_id,
    'old_quantity',      COALESCE(v_inv.quantity_available, 0),
    'new_quantity',      p_new_quantity,
    'delta',             v_delta
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'reconcile_negative_inventory', v_result);
  END IF;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.reconcile_negative_inventory(uuid, numeric, text, uuid, text) TO authenticated;

-- -----------------------------------------------------------------------------
-- 2. create_invoice_for_unbilled_delivery
-- -----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.create_invoice_for_unbilled_delivery(uuid, uuid, text);

CREATE OR REPLACE FUNCTION public.create_invoice_for_unbilled_delivery(
  p_delivery_id     uuid,
  p_performed_by    uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor             uuid;
  v_existing          jsonb;
  v_delivery          record;
  v_existing_count    integer;
  v_invoice_id        uuid;
  v_invoice_number    text;
  v_total_cents       bigint := 0;
  v_cost_cents        bigint := 0;
  v_item              record;
  v_result            jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'p_performed_by does not match authenticated user';
  END IF;
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Admin access required to create an invoice for a delivery';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'create_invoice_for_unbilled_delivery');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  -- Lock + validate the delivery
  SELECT * INTO v_delivery FROM deliveries WHERE id = p_delivery_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Delivery not found: %', p_delivery_id;
  END IF;
  IF v_delivery.status != 'completed' THEN
    RAISE EXCEPTION 'Delivery is not completed (current status: %). Only completed deliveries can be invoiced retroactively.', v_delivery.status;
  END IF;
  IF v_delivery.order_id IS NULL THEN
    RAISE EXCEPTION 'Delivery has no order_id — cannot auto-invoice an orphan delivery';
  END IF;

  -- Refuse if an active invoice already exists for the order
  SELECT COUNT(*) INTO v_existing_count
  FROM invoices
  WHERE order_id = v_delivery.order_id
    AND status NOT IN ('voided', 'cancelled');

  IF v_existing_count > 0 THEN
    RAISE EXCEPTION 'Order already has an active invoice — nothing to backfill. Find and review the existing invoice instead.';
  END IF;

  -- Create the draft invoice
  v_invoice_number := next_invoice_number('chemical_sale');
  INSERT INTO invoices (
    invoice_number, invoice_type, order_id, customer_id, delivery_id,
    status, invoice_date, total_amount_cents, total_cost_cents, created_by
  ) VALUES (
    v_invoice_number, 'chemical_sale', v_delivery.order_id, v_delivery.customer_id, p_delivery_id,
    'draft', CURRENT_DATE, 0, 0, v_actor
  ) RETURNING id INTO v_invoice_id;

  -- Copy delivered quantities into invoice items
  FOR v_item IN
    SELECT di.product_id, di.quantity_delivered, di.unit_size, di.order_item_id,
           oi.price_per_unit, oi.cost_per_unit, oi.product_name AS oi_product_name,
           p.product_name AS p_name
      FROM delivery_items di
      JOIN order_items oi ON oi.id = di.order_item_id
      JOIN products p ON p.id = di.product_id
     WHERE di.delivery_id = p_delivery_id
       AND COALESCE(di.quantity_delivered, 0) > 0
  LOOP
    v_total_cents := v_total_cents + ROUND(v_item.quantity_delivered * v_item.price_per_unit * 100)::bigint;
    v_cost_cents  := v_cost_cents  + ROUND(v_item.quantity_delivered * COALESCE(v_item.cost_per_unit, 0) * 100)::bigint;
    INSERT INTO invoice_items (
      invoice_id, order_item_id, product_id, description,
      quantity, unit_price_cents, extended_cents, cost_cents,
      unit_size
    ) VALUES (
      v_invoice_id, v_item.order_item_id, v_item.product_id,
      COALESCE(v_item.oi_product_name, v_item.p_name),
      v_item.quantity_delivered,
      ROUND(v_item.price_per_unit * 100)::bigint,
      ROUND(v_item.quantity_delivered * v_item.price_per_unit * 100)::bigint,
      ROUND(COALESCE(v_item.cost_per_unit, 0) * 100)::bigint,
      v_item.unit_size
    );
  END LOOP;

  UPDATE invoices
     SET total_amount_cents = v_total_cents,
         total_cost_cents   = v_cost_cents
   WHERE id = v_invoice_id;

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'invoice_backfilled_for_delivery',
    'Backfilled draft invoice ' || v_invoice_number ||
    ' for completed delivery ' || v_delivery.delivery_number,
    v_actor, 'invoice', v_invoice_id, v_delivery.customer_id
  );

  v_result := jsonb_build_object(
    'success',         true,
    'delivery_id',     p_delivery_id,
    'invoice_id',      v_invoice_id,
    'invoice_number',  v_invoice_number,
    'total_cents',     v_total_cents
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'create_invoice_for_unbilled_delivery', v_result);
  END IF;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_invoice_for_unbilled_delivery(uuid, uuid, text) TO authenticated;

-- -----------------------------------------------------------------------------
-- Verify no overloads
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace
      AND proname = 'reconcile_negative_inventory') != 1 THEN
    RAISE EXCEPTION 'OVERLOAD DETECTED for reconcile_negative_inventory';
  END IF;
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace
      AND proname = 'create_invoice_for_unbilled_delivery') != 1 THEN
    RAISE EXCEPTION 'OVERLOAD DETECTED for create_invoice_for_unbilled_delivery';
  END IF;
END $$;
