-- ============================================================================
-- S5-1: PARTIAL DELIVERY SUPPORT
-- CRX Manager V1.0
-- Date: 2026-02-11
--
-- Problem: Delivery completion is all-or-nothing. If a driver delivers 8 of
-- 10 items, they cannot record a partial completion.
--
-- Fix: Add p_quantities JSONB parameter to complete_delivery. When provided,
-- each delivery item is delivered at the specified quantity instead of full.
-- The delivery is always marked 'completed' but partial quantities only
-- update order_items/inventory by the actual amount delivered.
-- Also add quantity_delivered column to delivery_items for tracking.
-- ============================================================================

-- 1. Add quantity_delivered to delivery_items to track actual vs planned
ALTER TABLE delivery_items
  ADD COLUMN IF NOT EXISTS quantity_delivered numeric DEFAULT 0;

-- Backfill: completed deliveries had full quantity delivered
UPDATE delivery_items di
SET quantity_delivered = di.quantity
FROM deliveries d
WHERE d.id = di.delivery_id AND d.status = 'completed' AND di.quantity_delivered = 0;

-- 2. Recreate complete_delivery with partial delivery support
CREATE OR REPLACE FUNCTION complete_delivery(
  p_delivery_id uuid,
  p_signed_by text,
  p_performed_by uuid,
  p_quantities jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_delivery record;
  v_item record;
  v_inv record;
  v_all_delivered boolean;
  v_qty_to_deliver numeric;
  v_any_partial boolean := false;
BEGIN
  -- Validate delivery exists and is not already completed
  SELECT * INTO v_delivery FROM deliveries WHERE id = p_delivery_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Delivery not found';
  END IF;
  IF v_delivery.status = 'completed' THEN
    RETURN jsonb_build_object('status', 'already_completed');
  END IF;

  -- Verify caller is the assigned driver or an admin
  IF NOT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = p_performed_by
      AND is_active = true
      AND (role = 'admin' OR (role = 'driver' AND p_performed_by = v_delivery.assigned_driver))
  ) THEN
    RAISE EXCEPTION 'Not authorized to complete this delivery';
  END IF;

  -- PRE-CHECK INVENTORY AVAILABILITY for all items
  FOR v_item IN
    SELECT di.*, p.product_name
    FROM delivery_items di
    JOIN products p ON p.id = di.product_id
    WHERE di.delivery_id = p_delivery_id
  LOOP
    -- Determine quantity to deliver for this item
    IF p_quantities IS NOT NULL AND p_quantities ? v_item.id::text THEN
      v_qty_to_deliver := (p_quantities->>v_item.id::text)::numeric;
      -- Clamp to 0..planned quantity
      v_qty_to_deliver := GREATEST(0, LEAST(v_qty_to_deliver, v_item.quantity));
    ELSE
      v_qty_to_deliver := v_item.quantity;
    END IF;

    IF v_qty_to_deliver < v_item.quantity THEN
      v_any_partial := true;
    END IF;

    -- Skip inventory check for zero-quantity items
    IF v_qty_to_deliver = 0 THEN
      CONTINUE;
    END IF;

    SELECT * INTO v_inv
    FROM inventory
    WHERE product_id = v_item.product_id AND location = 'Main Warehouse'
    FOR UPDATE;

    IF NOT FOUND OR v_inv.quantity_available < v_qty_to_deliver THEN
      RAISE EXCEPTION 'Insufficient inventory for %: need % units, only % available',
        v_item.product_name,
        v_qty_to_deliver,
        COALESCE(v_inv.quantity_available, 0);
    END IF;
  END LOOP;

  -- Mark delivery completed
  UPDATE deliveries SET
    status = 'completed',
    completed_at = now(),
    signed_by = p_signed_by
  WHERE id = p_delivery_id;

  -- Process each delivery item
  FOR v_item IN
    SELECT di.*, p.product_name
    FROM delivery_items di
    JOIN products p ON p.id = di.product_id
    WHERE di.delivery_id = p_delivery_id
  LOOP
    -- Determine quantity to deliver
    IF p_quantities IS NOT NULL AND p_quantities ? v_item.id::text THEN
      v_qty_to_deliver := (p_quantities->>v_item.id::text)::numeric;
      v_qty_to_deliver := GREATEST(0, LEAST(v_qty_to_deliver, v_item.quantity));
    ELSE
      v_qty_to_deliver := v_item.quantity;
    END IF;

    -- Record actual quantity delivered on the delivery item
    UPDATE delivery_items SET quantity_delivered = v_qty_to_deliver
    WHERE id = v_item.id;

    -- Skip further processing for zero-quantity items
    IF v_qty_to_deliver = 0 THEN
      CONTINUE;
    END IF;

    -- Update order_item delivered/remaining counts
    UPDATE order_items SET
      quantity_delivered = quantity_delivered + v_qty_to_deliver,
      quantity_remaining = GREATEST(quantity_remaining - v_qty_to_deliver, 0)
    WHERE id = v_item.order_item_id;

    -- Create audit trail
    INSERT INTO inventory_transactions (
      product_id, transaction_type, quantity, from_location,
      order_id, delivery_id, performed_by, notes
    ) VALUES (
      v_item.product_id, 'delivered', v_qty_to_deliver, 'Main Warehouse',
      v_delivery.order_id, p_delivery_id, p_performed_by,
      'Delivery ' || v_delivery.delivery_number ||
        CASE WHEN v_qty_to_deliver < v_item.quantity
          THEN ' (partial: ' || v_qty_to_deliver || '/' || v_item.quantity || ')'
          ELSE ''
        END ||
        '. Signed by: ' || p_signed_by
    );

    -- Reduce inventory
    UPDATE inventory SET
      quantity_available = quantity_available - v_qty_to_deliver,
      quantity_prebooked = GREATEST(quantity_prebooked - v_qty_to_deliver, 0),
      updated_at = now()
    WHERE product_id = v_item.product_id AND location = 'Main Warehouse';
  END LOOP;

  -- Check if entire order is fully delivered
  SELECT NOT EXISTS (
    SELECT 1 FROM order_items
    WHERE order_id = v_delivery.order_id AND quantity_remaining > 0
  ) INTO v_all_delivered;

  UPDATE orders SET
    status = CASE WHEN v_all_delivered THEN 'fulfilled' ELSE 'partially_fulfilled' END,
    updated_at = now()
  WHERE id = v_delivery.order_id;

  -- Log activity
  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'delivery_completed',
    'Delivery ' || v_delivery.delivery_number ||
      CASE WHEN v_any_partial THEN ' completed (partial quantities)' ELSE ' completed' END ||
      '. Signed by: ' || p_signed_by,
    p_performed_by, 'delivery', p_delivery_id, v_delivery.customer_id
  );

  RETURN jsonb_build_object(
    'status', 'completed',
    'partial', v_any_partial,
    'order_status', CASE WHEN v_all_delivered THEN 'fulfilled' ELSE 'partially_fulfilled' END
  );
END;
$$;

GRANT EXECUTE ON FUNCTION complete_delivery(uuid, text, uuid, jsonb) TO authenticated;
