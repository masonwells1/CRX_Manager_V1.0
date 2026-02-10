-- ============================================================================
-- FIX COLUMN MISMATCHES — RPCs referencing non-existent columns
-- CRX Manager V1.0
-- Date: 2026-02-11
--
-- Fixes:
--   1. update_order_items: referenced updated_at on order_items (doesn't exist)
--   2. create_direct_order: referenced notes/sort_order on order_items (don't exist)
--      (Already fixed in 20260211100000 migration file, re-deployed here)
-- ============================================================================


-- ============================================================================
-- SECTION 1: Fix update_order_items — remove updated_at on order_items
-- The order_items table has no updated_at column.
-- The orders and inventory tables DO have updated_at, those SET clauses are fine.
-- ============================================================================

CREATE OR REPLACE FUNCTION update_order_items(
  p_order_id uuid,
  p_items jsonb,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order record;
  v_item jsonb;
  v_old_item record;
  v_qty_diff numeric;
  v_new_total numeric := 0;
  v_cached_result jsonb;
  v_result jsonb;
BEGIN
  -- Check idempotency key if provided
  IF p_idempotency_key IS NOT NULL THEN
    v_cached_result := check_idempotency(p_idempotency_key, 'update_order_items');
    IF v_cached_result IS NOT NULL THEN
      RETURN v_cached_result;
    END IF;
  END IF;

  SELECT * INTO v_order FROM orders WHERE id = p_order_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found'; END IF;

  IF v_order.status NOT IN ('pending', 'confirmed') THEN
    RAISE EXCEPTION 'Cannot edit items on a % order', v_order.status;
  END IF;

  -- Verify caller is admin or sales_rep
  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = p_performed_by AND is_active = true
      AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'Not authorized to update order items';
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    SELECT * INTO v_old_item FROM order_items WHERE id = (v_item->>'id')::uuid;
    IF NOT FOUND THEN CONTINUE; END IF;

    v_qty_diff := (v_item->>'total_units_needed')::numeric - v_old_item.total_units_needed;

    -- Update the order item (no updated_at — column does not exist on order_items)
    UPDATE order_items SET
      price_per_unit = (v_item->>'price_per_unit')::numeric,
      total_units_needed = (v_item->>'total_units_needed')::numeric,
      quantity_remaining = GREATEST(
        (v_item->>'total_units_needed')::numeric - v_old_item.quantity_delivered, 0
      ),
      total_price = (v_item->>'price_per_unit')::numeric * (v_item->>'total_units_needed')::numeric
    WHERE id = v_old_item.id;

    -- Adjust prebooked inventory
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
        p_order_id, p_performed_by,
        'Order edit: adjusted prebooked by ' || v_qty_diff
      );
    END IF;
  END LOOP;

  -- Recalculate order total from actual line items
  SELECT COALESCE(SUM(total_price), 0) INTO v_new_total
  FROM order_items WHERE order_id = p_order_id;

  UPDATE orders SET
    total_price = v_new_total,
    balance_due = v_new_total - COALESCE(total_paid, 0),
    updated_at = now()
  WHERE id = p_order_id;

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'order_edited',
    'Order ' || v_order.order_number || ' items updated — new total $' || ROUND(v_new_total, 2),
    p_performed_by, 'order', p_order_id, v_order.customer_id
  );

  v_result := jsonb_build_object('status', 'updated');

  -- Save idempotency key
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'update_order_items', v_result);
  END IF;

  RETURN v_result;
END;
$$;


-- ============================================================================
-- SECTION 2: Re-deploy fixed create_direct_order
-- Removes references to non-existent notes/sort_order columns on order_items
-- ============================================================================

CREATE OR REPLACE FUNCTION create_direct_order(
  p_order_number text,
  p_customer_id uuid,
  p_order_date date,
  p_notes text,
  p_items jsonb,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order_id uuid;
  v_item jsonb;
  v_total_price numeric := 0;
  v_total_cost numeric := 0;
  v_total_profit numeric;
  v_total_margin_pct numeric;
  v_customer record;
  v_cached_result jsonb;
  v_result jsonb;
BEGIN
  -- Check idempotency key if provided
  IF p_idempotency_key IS NOT NULL THEN
    v_cached_result := check_idempotency(p_idempotency_key, 'create_direct_order');
    IF v_cached_result IS NOT NULL THEN
      RETURN v_cached_result;
    END IF;
  END IF;

  -- Verify caller is admin or sales_rep
  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = p_performed_by AND is_active = true
      AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'Not authorized to create orders';
  END IF;

  -- Verify customer exists
  SELECT * INTO v_customer FROM customers WHERE id = p_customer_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Customer not found';
  END IF;

  -- Validate items
  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Order must have at least one item';
  END IF;

  -- Calculate totals from items
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_total_price := v_total_price
      + COALESCE((v_item->>'quantity')::numeric, 0)
      * COALESCE((v_item->>'price_per_unit')::numeric, 0);
    v_total_cost := v_total_cost
      + COALESCE((v_item->>'quantity')::numeric, 0)
      * COALESCE((v_item->>'unit_cost')::numeric, 0);
  END LOOP;

  v_total_profit := v_total_price - v_total_cost;
  v_total_margin_pct := CASE
    WHEN v_total_price > 0 THEN (v_total_profit / v_total_price) * 100
    ELSE 0
  END;

  -- Create the order
  INSERT INTO orders (
    order_number, customer_id, status,
    total_price, total_cost, total_profit, total_margin_pct,
    order_date, total_paid, balance_due, notes
  ) VALUES (
    p_order_number, p_customer_id, 'confirmed',
    v_total_price, v_total_cost, v_total_profit, v_total_margin_pct,
    p_order_date, 0, v_total_price,
    NULLIF(TRIM(COALESCE(p_notes, '')), '')
  ) RETURNING id INTO v_order_id;

  -- Create order items and prebook inventory atomically
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    -- Skip items without a product or quantity
    IF (v_item->>'product_id') IS NULL OR COALESCE((v_item->>'quantity')::numeric, 0) <= 0 THEN
      CONTINUE;
    END IF;

    -- Insert order item (order_items has no sort_order, notes, or updated_at columns)
    INSERT INTO order_items (
      order_id, product_id, product_name,
      price_per_unit, cost_per_unit,
      total_units_needed, unit_size,
      total_price, profit, net_margin,
      quantity_delivered, quantity_remaining
    ) VALUES (
      v_order_id,
      (v_item->>'product_id')::uuid,
      v_item->>'product_name',
      COALESCE((v_item->>'price_per_unit')::numeric, 0),
      COALESCE((v_item->>'unit_cost')::numeric, 0),
      (v_item->>'quantity')::numeric,
      v_item->>'unit_size',
      COALESCE((v_item->>'quantity')::numeric, 0) * COALESCE((v_item->>'price_per_unit')::numeric, 0),
      (COALESCE((v_item->>'price_per_unit')::numeric, 0) - COALESCE((v_item->>'unit_cost')::numeric, 0))
        * COALESCE((v_item->>'quantity')::numeric, 0),
      CASE WHEN COALESCE((v_item->>'price_per_unit')::numeric, 0) > 0
        THEN ((COALESCE((v_item->>'price_per_unit')::numeric, 0) - COALESCE((v_item->>'unit_cost')::numeric, 0))
              / (v_item->>'price_per_unit')::numeric) * 100
        ELSE 0
      END,
      0,
      (v_item->>'quantity')::numeric
    );

    -- Atomic prebook — no read-then-write
    UPDATE inventory SET
      quantity_prebooked = quantity_prebooked + (v_item->>'quantity')::numeric,
      updated_at = now()
    WHERE product_id = (v_item->>'product_id')::uuid AND location = 'Main Warehouse';

    -- If no inventory row exists, create one
    IF NOT FOUND THEN
      INSERT INTO inventory (product_id, location, quantity_available, quantity_prebooked, quantity_on_order, unit_size)
      VALUES (
        (v_item->>'product_id')::uuid, 'Main Warehouse',
        0, (v_item->>'quantity')::numeric, 0,
        v_item->>'unit_size'
      );
    END IF;

    -- Audit trail
    INSERT INTO inventory_transactions (
      product_id, transaction_type, quantity, to_location,
      order_id, performed_by, notes
    ) VALUES (
      (v_item->>'product_id')::uuid, 'booked', (v_item->>'quantity')::numeric,
      'Main Warehouse', v_order_id, p_performed_by,
      'Pre-booked for order ' || p_order_number
    );
  END LOOP;

  -- Log activity
  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'order_created',
    'Direct order ' || p_order_number || ' created for ' || COALESCE(v_customer.farm_name, 'customer'),
    p_performed_by, 'order', v_order_id, p_customer_id
  );

  v_result := jsonb_build_object('status', 'created', 'order_id', v_order_id);

  -- Save idempotency key
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'create_direct_order', v_result);
  END IF;

  RETURN v_result;
END;
$$;


-- ============================================================================
-- SECTION 3: Grant permissions (re-grant for safety)
-- ============================================================================

GRANT EXECUTE ON FUNCTION update_order_items(uuid, jsonb, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION create_direct_order(text, uuid, date, text, jsonb, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION adjust_inventory(uuid, numeric, text, uuid, text) TO authenticated;
