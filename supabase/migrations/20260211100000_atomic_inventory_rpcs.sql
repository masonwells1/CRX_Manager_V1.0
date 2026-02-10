-- ============================================================================
-- ATOMIC INVENTORY RPCs — Eliminate Last Client-Side Race Conditions
-- CRX Manager V1.0
-- Date: 2026-02-11
--
-- This migration addresses the final 2 dangerous client-side mutations:
--   1. adjust_inventory — replaces read-then-write in InventoryPage.tsx
--   2. create_direct_order — replaces read-then-write in NewOrder.tsx
-- ============================================================================


-- ============================================================================
-- SECTION 1: adjust_inventory RPC
-- Atomic manual inventory adjustment with audit trail.
-- Replaces the read-then-write pattern in InventoryPage.tsx handleAdjust.
-- ============================================================================

CREATE OR REPLACE FUNCTION adjust_inventory(
  p_inventory_id uuid,
  p_delta numeric,
  p_reason text,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inv record;
  v_new_qty numeric;
  v_cached_result jsonb;
  v_result jsonb;
BEGIN
  -- Check idempotency key if provided
  IF p_idempotency_key IS NOT NULL THEN
    v_cached_result := check_idempotency(p_idempotency_key, 'adjust_inventory');
    IF v_cached_result IS NOT NULL THEN
      RETURN v_cached_result;
    END IF;
  END IF;

  -- Validate delta is not zero
  IF p_delta = 0 THEN
    RAISE EXCEPTION 'Adjustment quantity cannot be zero';
  END IF;

  -- Verify caller is admin
  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = p_performed_by AND role = 'admin' AND is_active = true
  ) THEN
    RAISE EXCEPTION 'Only admins can adjust inventory';
  END IF;

  -- Lock and read the inventory row
  SELECT * INTO v_inv FROM inventory WHERE id = p_inventory_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Inventory record not found';
  END IF;

  -- Atomic update — single SET, no read-then-write from client
  UPDATE inventory SET
    quantity_available = quantity_available + p_delta,
    updated_at = now()
  WHERE id = p_inventory_id;

  v_new_qty := v_inv.quantity_available + p_delta;

  -- Audit trail (immutable log)
  INSERT INTO inventory_transactions (
    product_id, transaction_type, quantity,
    to_location, performed_by, notes
  ) VALUES (
    v_inv.product_id, 'adjusted', p_delta,
    v_inv.location, p_performed_by,
    COALESCE(NULLIF(TRIM(p_reason), ''), 'Manual adjustment of ' || p_delta || ' units')
  );

  v_result := jsonb_build_object(
    'status', 'adjusted',
    'new_quantity', v_new_qty,
    'product_id', v_inv.product_id
  );

  -- Save idempotency key
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'adjust_inventory', v_result);
  END IF;

  RETURN v_result;
END;
$$;


-- ============================================================================
-- SECTION 2: create_direct_order RPC
-- Atomic direct order creation with inventory prebooking.
-- Replaces the read-then-write loop in NewOrder.tsx handleSave.
-- Follows the same pattern as convert_quote_to_order but without a quote.
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

    -- Insert order item
    INSERT INTO order_items (
      order_id, product_id, product_name,
      price_per_unit, cost_per_unit,
      total_units_needed, unit_size,
      total_price, profit, net_margin,
      quantity_delivered, quantity_remaining,
      notes, sort_order
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
      (v_item->>'quantity')::numeric,
      v_item->>'notes',
      COALESCE((v_item->>'sort_order')::int, 0)
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
-- SECTION 3: Grant permissions
-- ============================================================================

GRANT EXECUTE ON FUNCTION adjust_inventory(uuid, numeric, text, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION create_direct_order(text, uuid, date, text, jsonb, uuid, text) TO authenticated;
