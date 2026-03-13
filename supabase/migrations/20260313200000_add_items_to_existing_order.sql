-- Add ability to insert NEW items into an existing order via update_order_items
-- Also fix transaction_type CHECK to include 'prebooked' and 'released' (already used by existing RPCs)

BEGIN;

-- =============================================================
-- Fix: expand transaction_type CHECK to include prebooked/released
-- These are already used by update_order_items and create_direct_order
-- =============================================================
ALTER TABLE inventory_transactions
  DROP CONSTRAINT IF EXISTS inventory_transactions_transaction_type_check;

ALTER TABLE inventory_transactions
  ADD CONSTRAINT inventory_transactions_transaction_type_check
  CHECK (transaction_type IN (
    'received', 'booked', 'delivered', 'returned',
    'adjusted', 'transferred', 'job_applied',
    'cancelled_delivery_reversal', 'void_delivery_reversal',
    'prebooked', 'released'
  ));

-- =============================================================
-- Extend update_order_items to support adding NEW items
-- Items with id = existing item → update price/qty
-- Items WITHOUT id (id IS NULL) → insert new order_item row
-- =============================================================
CREATE OR REPLACE FUNCTION public.update_order_items(
  p_order_id        uuid,
  p_items           jsonb,
  p_performed_by    uuid,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor      uuid;
  v_order      record;
  v_old_item   record;
  v_item       jsonb;
  v_qty_diff   numeric;
  v_new_total  numeric;
  v_result     jsonb;
  v_passed_ids uuid[];
  v_new_item_id uuid;
  v_product    record;
  v_new_qty    numeric;
  v_new_price  numeric;
  v_new_cost   numeric;
  v_new_items_added integer := 0;
BEGIN
  v_actor := COALESCE(p_performed_by, auth.uid());

  SELECT * INTO v_order FROM orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found: %', p_order_id;
  END IF;

  -- Only allow edits on pending/confirmed orders
  IF v_order.status NOT IN ('confirmed', 'pending') THEN
    RAISE EXCEPTION 'Cannot edit order in status: %', v_order.status;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = v_actor
      AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'Not authorized to update order items';
  END IF;

  -- Idempotency check
  IF p_idempotency_key IS NOT NULL THEN
    DECLARE v_existing jsonb;
    BEGIN
      v_existing := check_idempotency(p_idempotency_key, 'update_order_items');
      IF (v_existing->>'status') = 'completed' THEN
        RETURN v_existing->'result';
      END IF;
    END;
  END IF;

  -- Collect the IDs passed from the frontend (only items with an id = existing items)
  SELECT array_agg((el->>'id')::uuid)
    INTO v_passed_ids
    FROM jsonb_array_elements(p_items) el
   WHERE (el->>'id') IS NOT NULL;

  -- M13: Delete items NOT in the passed list, but ONLY if they have no deliveries
  DELETE FROM order_items
   WHERE order_id = p_order_id
     AND (v_passed_ids IS NULL OR id != ALL(v_passed_ids))
     AND quantity_delivered = 0;

  -- Restore any prebooked inventory for truly deleted items
  FOR v_old_item IN
    SELECT oi.*
      FROM order_items oi
     WHERE oi.order_id = p_order_id
       AND (v_passed_ids IS NULL OR oi.id != ALL(v_passed_ids))
       AND oi.quantity_prebooked > 0
  LOOP
    UPDATE inventory
       SET quantity_prebooked = GREATEST(quantity_prebooked - v_old_item.quantity_prebooked, 0),
           updated_at = now()
     WHERE product_id = v_old_item.product_id AND location = 'Main Warehouse';
  END LOOP;

  -- Process each item in the payload
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    IF (v_item->>'id') IS NOT NULL THEN
      -- ========== EXISTING ITEM: update price/qty ==========
      SELECT * INTO v_old_item FROM order_items WHERE id = (v_item->>'id')::uuid;
      IF NOT FOUND THEN CONTINUE; END IF;

      v_qty_diff := (v_item->>'total_units_needed')::numeric - v_old_item.total_units_needed;

      UPDATE order_items SET
        price_per_unit    = (v_item->>'price_per_unit')::numeric,
        total_units_needed = (v_item->>'total_units_needed')::numeric,
        quantity_remaining = GREATEST(
          (v_item->>'total_units_needed')::numeric - v_old_item.quantity_delivered, 0
        ),
        total_price = (v_item->>'price_per_unit')::numeric * (v_item->>'total_units_needed')::numeric
      WHERE id = v_old_item.id;

      IF v_qty_diff <> 0 THEN
        UPDATE inventory SET
          quantity_prebooked = GREATEST(quantity_prebooked + v_qty_diff, 0),
          updated_at = now()
        WHERE product_id = v_old_item.product_id AND location = 'Main Warehouse';

        INSERT INTO inventory_transactions (
          product_id, transaction_type, quantity,
          order_id, performed_by, notes
        ) VALUES (
          v_old_item.product_id,
          CASE WHEN v_qty_diff > 0 THEN 'prebooked' ELSE 'released' END,
          ABS(v_qty_diff),
          p_order_id, v_actor,
          'Order edit: adjusted prebooked by ' || v_qty_diff
        );
      END IF;

    ELSE
      -- ========== NEW ITEM: insert into order_items ==========
      -- Requires: product_id, product_name, total_units_needed, price_per_unit
      -- Optional: cost_per_unit, unit_size, section_name
      v_new_qty   := COALESCE((v_item->>'total_units_needed')::numeric, 0);
      v_new_price := COALESCE((v_item->>'price_per_unit')::numeric, 0);
      v_new_cost  := COALESCE((v_item->>'cost_per_unit')::numeric, 0);

      -- If cost not provided, look up from products table
      IF v_new_cost = 0 AND (v_item->>'product_id') IS NOT NULL THEN
        SELECT current_cost INTO v_new_cost
          FROM products WHERE id = (v_item->>'product_id')::uuid;
        v_new_cost := COALESCE(v_new_cost, 0);
      END IF;

      IF v_new_qty <= 0 THEN
        CONTINUE; -- Skip items with no quantity
      END IF;

      v_new_item_id := gen_random_uuid();

      INSERT INTO order_items (
        id, order_id, product_id, product_name,
        price_per_unit, cost_per_unit, total_units_needed,
        unit_size, section_name,
        total_price, profit, net_margin,
        quantity_delivered, quantity_remaining
      ) VALUES (
        v_new_item_id,
        p_order_id,
        (v_item->>'product_id')::uuid,
        COALESCE(v_item->>'product_name', ''),
        v_new_price,
        v_new_cost,
        v_new_qty,
        v_item->>'unit_size',
        v_item->>'section_name',
        v_new_price * v_new_qty,                              -- total_price
        (v_new_price - v_new_cost) * v_new_qty,               -- profit
        CASE WHEN v_new_price > 0
          THEN ROUND(((v_new_price - v_new_cost) / v_new_price) * 100, 2)
          ELSE 0
        END,                                                   -- net_margin
        0,                                                     -- quantity_delivered
        v_new_qty                                              -- quantity_remaining
      );

      -- Pre-book inventory for new item
      UPDATE inventory SET
        quantity_prebooked = quantity_prebooked + v_new_qty,
        updated_at = now()
      WHERE product_id = (v_item->>'product_id')::uuid AND location = 'Main Warehouse';

      INSERT INTO inventory_transactions (
        product_id, transaction_type, quantity,
        order_id, performed_by, notes
      ) VALUES (
        (v_item->>'product_id')::uuid,
        'prebooked',
        v_new_qty,
        p_order_id, v_actor,
        'New item added to existing order ' || v_order.order_number
      );

      v_new_items_added := v_new_items_added + 1;
    END IF;
  END LOOP;

  -- Recalculate order total
  SELECT COALESCE(SUM(total_price), 0) INTO v_new_total
    FROM order_items WHERE order_id = p_order_id;

  UPDATE orders SET
    total_price = v_new_total,
    updated_at  = now()
  WHERE id = p_order_id;

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'order_edited',
    'Order ' || v_order.order_number || ' items updated'
      || CASE WHEN v_new_items_added > 0
           THEN ' (' || v_new_items_added || ' new item(s) added)'
           ELSE '' END
      || ' — new total $' || ROUND(v_new_total, 2),
    v_actor, 'order', p_order_id, v_order.customer_id
  );

  v_result := jsonb_build_object(
    'status', 'updated',
    'new_items_added', v_new_items_added
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'update_order_items', v_result);
  END IF;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.update_order_items(uuid, jsonb, uuid, text) TO authenticated;

COMMIT;
