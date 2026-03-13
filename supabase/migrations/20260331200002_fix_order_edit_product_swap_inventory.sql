-- ============================================================================
-- Fix: update_order_items does NOT handle product swaps
--
-- BUG: When editing an existing order item and changing its product_id
-- (e.g., Trivapro 2.5g → Trivapro Bulk), the RPC:
--   1. Never updates product_id or product_name on the order_item row
--   2. Never releases prebooked inventory from the old product
--   3. Never adds prebooked inventory for the new product
-- Result: inventory is completely wrong after a product swap.
--
-- FIX: Accept product_id/product_name for existing items. When product_id
-- changes, release old prebooked qty and add new prebooked qty.
-- Also update product_name, cost_per_unit, and unit_size on the order_item.
-- ============================================================================

-- Drop existing function first (required to change search_path setting)
DROP FUNCTION IF EXISTS public.update_order_items(uuid, jsonb, uuid, text);

CREATE OR REPLACE FUNCTION public.update_order_items(
  p_order_id        uuid,
  p_items           jsonb,
  p_performed_by    uuid,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
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
  v_new_product_id uuid;
  v_old_remaining numeric;
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

  -- Delete items NOT in the passed list, but ONLY if they have no deliveries
  -- First capture what we're about to delete for inventory restoration
  FOR v_old_item IN
    SELECT oi.*
      FROM order_items oi
     WHERE oi.order_id = p_order_id
       AND (v_passed_ids IS NULL OR oi.id != ALL(v_passed_ids))
       AND oi.quantity_delivered = 0
  LOOP
    -- Release prebooked inventory for items being removed
    IF v_old_item.quantity_remaining > 0 THEN
      UPDATE inventory
         SET quantity_prebooked = GREATEST(quantity_prebooked - v_old_item.quantity_remaining, 0),
             updated_at = now()
       WHERE product_id = v_old_item.product_id AND location = 'Main Warehouse';

      INSERT INTO inventory_transactions (
        product_id, transaction_type, quantity,
        order_id, performed_by, notes
      ) VALUES (
        v_old_item.product_id, 'released', v_old_item.quantity_remaining,
        p_order_id, v_actor,
        'Order edit: item removed from ' || v_order.order_number
      );
    END IF;
  END LOOP;

  -- Now delete the items
  DELETE FROM order_items
   WHERE order_id = p_order_id
     AND (v_passed_ids IS NULL OR id != ALL(v_passed_ids))
     AND quantity_delivered = 0;

  -- Process each item in the payload
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    IF (v_item->>'id') IS NOT NULL THEN
      -- ========== EXISTING ITEM: update price/qty/product ==========
      SELECT * INTO v_old_item FROM order_items WHERE id = (v_item->>'id')::uuid;
      IF NOT FOUND THEN CONTINUE; END IF;

      v_new_product_id := COALESCE((v_item->>'product_id')::uuid, v_old_item.product_id);
      v_qty_diff := (v_item->>'total_units_needed')::numeric - v_old_item.total_units_needed;

      -- *** FIX: Handle product swap ***
      IF v_new_product_id IS DISTINCT FROM v_old_item.product_id THEN
        -- Product changed! Release ALL prebooked from old product, add to new product
        v_old_remaining := GREATEST(v_old_item.total_units_needed - v_old_item.quantity_delivered, 0);

        -- Release old product prebooked
        IF v_old_remaining > 0 THEN
          UPDATE inventory SET
            quantity_prebooked = GREATEST(quantity_prebooked - v_old_remaining, 0),
            updated_at = now()
          WHERE product_id = v_old_item.product_id AND location = 'Main Warehouse';

          INSERT INTO inventory_transactions (
            product_id, transaction_type, quantity,
            order_id, performed_by, notes
          ) VALUES (
            v_old_item.product_id, 'released', v_old_remaining,
            p_order_id, v_actor,
            'Order edit: product swapped from ' || v_old_item.product_name || ' on ' || v_order.order_number
          );
        END IF;

        -- Add new product prebooked (use new quantity)
        v_new_qty := (v_item->>'total_units_needed')::numeric;
        IF v_new_qty > 0 THEN
          UPDATE inventory SET
            quantity_prebooked = quantity_prebooked + v_new_qty,
            updated_at = now()
          WHERE product_id = v_new_product_id AND location = 'Main Warehouse';

          INSERT INTO inventory_transactions (
            product_id, transaction_type, quantity,
            order_id, performed_by, notes
          ) VALUES (
            v_new_product_id, 'prebooked', v_new_qty,
            p_order_id, v_actor,
            'Order edit: product swapped to ' || COALESCE(v_item->>'product_name', '') || ' on ' || v_order.order_number
          );
        END IF;

        -- Look up cost for new product if not provided
        v_new_cost := COALESCE((v_item->>'cost_per_unit')::numeric, 0);
        IF v_new_cost = 0 THEN
          SELECT current_cost INTO v_new_cost FROM products WHERE id = v_new_product_id;
          v_new_cost := COALESCE(v_new_cost, 0);
        END IF;

        -- Update the order item with new product info
        UPDATE order_items SET
          product_id         = v_new_product_id,
          product_name       = COALESCE(v_item->>'product_name', product_name),
          unit_size          = COALESCE(v_item->>'unit_size', unit_size),
          cost_per_unit      = v_new_cost,
          price_per_unit     = (v_item->>'price_per_unit')::numeric,
          total_units_needed = (v_item->>'total_units_needed')::numeric,
          quantity_remaining = GREATEST(
            (v_item->>'total_units_needed')::numeric - v_old_item.quantity_delivered, 0
          ),
          total_price = (v_item->>'price_per_unit')::numeric * (v_item->>'total_units_needed')::numeric,
          profit      = ((v_item->>'price_per_unit')::numeric - v_new_cost) * (v_item->>'total_units_needed')::numeric,
          net_margin  = CASE WHEN (v_item->>'price_per_unit')::numeric > 0
            THEN ROUND((((v_item->>'price_per_unit')::numeric - v_new_cost) / (v_item->>'price_per_unit')::numeric) * 100, 2)
            ELSE 0
          END
        WHERE id = v_old_item.id;

      ELSE
        -- *** Same product: just update price/qty (original logic) ***
        UPDATE order_items SET
          product_name       = COALESCE(v_item->>'product_name', product_name),
          price_per_unit     = (v_item->>'price_per_unit')::numeric,
          total_units_needed = (v_item->>'total_units_needed')::numeric,
          quantity_remaining = GREATEST(
            (v_item->>'total_units_needed')::numeric - v_old_item.quantity_delivered, 0
          ),
          total_price = (v_item->>'price_per_unit')::numeric * (v_item->>'total_units_needed')::numeric
        WHERE id = v_old_item.id;

        -- Adjust prebooked if quantity changed
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
      END IF;

    ELSE
      -- ========== NEW ITEM: insert into order_items ==========
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
        v_new_price * v_new_qty,
        (v_new_price - v_new_cost) * v_new_qty,
        CASE WHEN v_new_price > 0
          THEN ROUND(((v_new_price - v_new_cost) / v_new_price) * 100, 2)
          ELSE 0
        END,
        0,
        v_new_qty
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
