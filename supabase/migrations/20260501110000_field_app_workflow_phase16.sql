-- =============================================================================
-- Migration: 20260501110000_field_app_workflow_phase16.sql
-- Phase 16 — Sprint E #1: retire_inventory_item RPC
--
-- Replaces the split frontend flow in src/pages/InventoryPage.tsx:644-710
-- (3 separate validation queries → ledger insert → separate delete) with one
-- atomic SECURITY DEFINER RPC. Closes the race-condition window where
-- another user could create a hold/order/delivery between the frontend's
-- validation step and its delete step.
--
-- Behavior matches the existing frontend safety checks exactly:
--   1. Block if any active inventory_holds row exists for this product
--   2. Block if quantity_prebooked > 0
--   3. Block if any delivery_items row points at the product where the
--      parent delivery is in scheduled/in_progress
--   4. Insert one inventory_transactions row (transaction_type='adjusted',
--      quantity = negative of what was on hand) for the audit trail
--   5. Delete the inventory row
--
-- All in one transaction with FOR UPDATE on the inventory row.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.retire_inventory_item(
  p_inventory_id    uuid,
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
  v_inv               record;
  v_existing          jsonb;
  v_active_holds      int;
  v_pending_deliv     int;
  v_old_quantity      numeric;
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
    RAISE EXCEPTION 'Admin access required to retire an inventory item';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'retire_inventory_item');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  -- Lock the inventory row first so concurrent writes serialize behind us.
  SELECT * INTO v_inv FROM inventory WHERE id = p_inventory_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Inventory row not found: %', p_inventory_id;
  END IF;

  v_old_quantity := COALESCE(v_inv.quantity_available, 0);

  -- Re-check active holds (post-lock) so the validation reflects the
  -- moment of deletion, not the moment the modal was opened.
  SELECT COUNT(*) INTO v_active_holds
  FROM inventory_holds
  WHERE product_id = v_inv.product_id AND is_active = true;
  IF v_active_holds > 0 THEN
    RAISE EXCEPTION 'Cannot delete: % active inventory hold(s) on this product. Release holds first.', v_active_holds;
  END IF;

  -- Re-check prebooked from the locked row.
  IF COALESCE(v_inv.quantity_prebooked, 0) > 0 THEN
    RAISE EXCEPTION 'Cannot delete: % unit(s) committed (prebooked) on this product. Cancel/complete the linked orders first.',
      v_inv.quantity_prebooked;
  END IF;

  -- Re-check pending deliveries.
  SELECT COUNT(*) INTO v_pending_deliv
  FROM delivery_items di
  JOIN deliveries d ON d.id = di.delivery_id
  WHERE di.product_id = v_inv.product_id
    AND d.status IN ('scheduled', 'in_progress');
  IF v_pending_deliv > 0 THEN
    RAISE EXCEPTION 'Cannot delete: % delivery(ies) still scheduled/in_progress for this product.', v_pending_deliv;
  END IF;

  -- Audit trail: log the deletion BEFORE removing the row.
  INSERT INTO inventory_transactions (
    product_id, transaction_type, quantity, to_location,
    performed_by, notes
  ) VALUES (
    v_inv.product_id, 'adjusted', -v_old_quantity,
    COALESCE(v_inv.location, 'Main Warehouse'),
    v_actor,
    'Inventory record retired (had ' || v_old_quantity || ' available)'
  );

  -- Atomic delete of the inventory row.
  DELETE FROM inventory WHERE id = p_inventory_id;

  v_result := jsonb_build_object(
    'success', true,
    'inventory_id', p_inventory_id,
    'product_id', v_inv.product_id,
    'retired_quantity', v_old_quantity
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'retire_inventory_item', v_result);
  END IF;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.retire_inventory_item(uuid, uuid, text) TO authenticated;


DO $$
DECLARE c1 int;
BEGIN
  SELECT count(*) INTO c1 FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='retire_inventory_item';
  IF c1 != 1 THEN
    RAISE EXCEPTION 'VERIFICATION FAILED: retire_inventory_item has % overloads', c1;
  END IF;
  RAISE NOTICE 'Phase 16 verified';
END $$;
