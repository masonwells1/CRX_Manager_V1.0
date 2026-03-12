-- Migration: 20260312200000_deploy_reverse_receiving_record
-- Purpose: Deploy the reverse_receiving_record() RPC so that deleting a
--          receiving entry from the Receiving Log page properly subtracts
--          the quantity from inventory.  Also adds a BEFORE DELETE safety
--          trigger on receiving_records so that any raw DELETE (e.g. via
--          an admin SQL client) also reverses the inventory automatically.
--
-- Fixes: Bug #1b — deleting a receiving record did not remove inventory.
-- The RPC logic was written in wave4_bug_fixes.sql but was never applied
-- to production.  This migration deploys it as a standalone targeted fix.

-- ============================================================================
-- 1. REVERSE RECEIVING RECORD RPC
-- ============================================================================
CREATE OR REPLACE FUNCTION public.reverse_receiving_record(
  p_record_id    uuid,
  p_reason       text    DEFAULT 'Manually reversed',
  p_performed_by uuid    DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rec    record;
  v_actor  uuid;
BEGIN
  v_actor := COALESCE(p_performed_by, auth.uid());

  -- Admin-only: receiving reversals are inventory adjustments
  IF (SELECT role FROM profiles WHERE id = v_actor) != 'admin' THEN
    RAISE EXCEPTION 'Admin access required to reverse receiving records';
  END IF;

  -- Lock and fetch the record
  SELECT * INTO v_rec
  FROM receiving_records
  WHERE id = p_record_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Receiving record not found: %', p_record_id;
  END IF;

  -- Set a flag so the BEFORE DELETE safety trigger (below) knows the RPC is
  -- already handling the inventory reversal and should skip its own deduction.
  PERFORM set_config('app.reversal_rpc_active', 'true', true);

  -- Reverse inventory: subtract what was added at receive time
  UPDATE inventory
  SET quantity_available = GREATEST(quantity_available - v_rec.quantity_received, 0),
      updated_at         = now()
  WHERE product_id = v_rec.product_id
    AND location   = v_rec.storage_location;

  -- Log the inventory adjustment
  INSERT INTO inventory_transactions (
    product_id, transaction_type, quantity, to_location,
    notes, created_by
  ) VALUES (
    v_rec.product_id,
    'adjustment',
    -1 * v_rec.quantity_received,
    v_rec.storage_location,
    'Reversed receiving record ' || p_record_id::text || ': ' || p_reason,
    v_actor
  );

  -- Roll back the PO item quantity_received counter
  UPDATE purchase_order_items
  SET quantity_received = GREATEST(quantity_received - v_rec.quantity_received, 0)
  WHERE id = v_rec.po_item_id;

  -- Re-evaluate PO status after rolling back the item
  UPDATE purchase_orders
  SET status = CASE
    WHEN (
      SELECT bool_and(quantity_received = 0)
      FROM purchase_order_items
      WHERE purchase_order_id = v_rec.purchase_order_id
    ) THEN 'submitted'
    WHEN (
      SELECT bool_and(quantity_received >= quantity_ordered)
      FROM purchase_order_items
      WHERE purchase_order_id = v_rec.purchase_order_id
    ) THEN 'fully_received'
    ELSE 'partially_received'
  END,
  updated_at = now()
  WHERE id = v_rec.purchase_order_id
    AND status IN ('partially_received', 'fully_received');

  -- Delete the receiving record and its photos (trigger will fire but skip
  -- the inventory deduction because app.reversal_rpc_active = 'true')
  DELETE FROM receiving_photos WHERE receiving_record_id = p_record_id;
  DELETE FROM receiving_records WHERE id = p_record_id;

  RETURN jsonb_build_object(
    'success',             true,
    'record_id',           p_record_id,
    'product_id',          v_rec.product_id,
    'quantity_reversed',   v_rec.quantity_received,
    'storage_location',    v_rec.storage_location
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.reverse_receiving_record(uuid, text, uuid) TO authenticated;

-- ============================================================================
-- 2. SAFETY TRIGGER: auto-reverse inventory on raw DELETE of receiving_records
--    This protects against admin SQL deletes that bypass the RPC.
--    If the RPC is already handling the reversal (app.reversal_rpc_active),
--    the trigger is a no-op to avoid double-counting.
-- ============================================================================
CREATE OR REPLACE FUNCTION public._receiving_records_before_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- If the RPC already handled the inventory reversal, skip
  IF current_setting('app.reversal_rpc_active', true) = 'true' THEN
    RETURN OLD;
  END IF;

  -- Raw delete path: subtract inventory and log the adjustment
  UPDATE inventory
  SET quantity_available = GREATEST(quantity_available - OLD.quantity_received, 0),
      updated_at         = now()
  WHERE product_id = OLD.product_id
    AND location   = OLD.storage_location;

  INSERT INTO inventory_transactions (
    product_id, transaction_type, quantity, to_location,
    notes, created_by
  ) VALUES (
    OLD.product_id,
    'adjustment',
    -1 * OLD.quantity_received,
    OLD.storage_location,
    'Auto-reversed by delete trigger on receiving_records ' || OLD.id::text,
    auth.uid()
  );

  -- Roll back the PO item counter
  UPDATE purchase_order_items
  SET quantity_received = GREATEST(quantity_received - OLD.quantity_received, 0)
  WHERE id = OLD.po_item_id;

  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_receiving_records_before_delete ON receiving_records;
CREATE TRIGGER trg_receiving_records_before_delete
  BEFORE DELETE ON receiving_records
  FOR EACH ROW
  EXECUTE FUNCTION public._receiving_records_before_delete();
