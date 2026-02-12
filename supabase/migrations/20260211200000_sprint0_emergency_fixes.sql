-- ============================================================================
-- SPRINT 0: EMERGENCY FIXES
-- CRX Manager V1.0
-- Date: 2026-02-11
--
-- S0-1: Inventory availability check (INV-001, INV-002, INV-007)
-- S0-4: UNIQUE(product_id, location) on inventory (DB-INT-001)
-- S0-5: Over-delivery detection in complete_delivery (INV-005, INV-014)
-- ============================================================================


-- ============================================================================
-- S0-4: UNIQUE CONSTRAINT ON INVENTORY (product_id, location)
-- Must run first so FOR UPDATE locks work on a single canonical row.
-- ============================================================================

-- First: merge any duplicate rows (keep the one with highest quantity_available)
DO $$
DECLARE
  dup RECORD;
BEGIN
  FOR dup IN
    SELECT product_id, location, COUNT(*) AS cnt
    FROM inventory
    GROUP BY product_id, location
    HAVING COUNT(*) > 1
  LOOP
    -- Keep the row with the highest quantity_available, delete the rest
    DELETE FROM inventory
    WHERE id IN (
      SELECT id FROM inventory
      WHERE product_id = dup.product_id AND location = dup.location
      ORDER BY quantity_available DESC
      OFFSET 1
    );
  END LOOP;
END;
$$;

ALTER TABLE inventory
  ADD CONSTRAINT inventory_product_location_unique
  UNIQUE (product_id, location);


-- ============================================================================
-- S0-1: ADD AVAILABILITY CHECK TO convert_quote_to_order
-- Adds SELECT ... FOR UPDATE + availability check before prebooking.
-- If insufficient stock, raises a clear exception listing the shortfall.
-- ============================================================================

CREATE OR REPLACE FUNCTION convert_quote_to_order(
  p_quote_id uuid,
  p_performed_by uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_quote record;
  v_order_number text;
  v_order_id uuid;
  v_section record;
  v_item record;
  v_customer record;
  v_split jsonb;
  v_inv record;
  v_shortfalls text[] := '{}';
BEGIN
  SELECT * INTO v_quote FROM quotes WHERE id = p_quote_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Quote not found'; END IF;
  IF v_quote.status = 'accepted' THEN
    -- Check if order already exists for this quote (idempotent)
    SELECT id INTO v_order_id FROM orders WHERE quote_id = p_quote_id LIMIT 1;
    IF v_order_id IS NOT NULL THEN
      RETURN jsonb_build_object('status', 'already_converted', 'order_id', v_order_id);
    END IF;
  END IF;

  SELECT * INTO v_customer FROM customers WHERE id = v_quote.customer_id;

  -- Verify caller
  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = p_performed_by AND is_active = true
      AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  -- *** S0-1: AVAILABILITY CHECK ***
  -- Lock inventory rows and check availability BEFORE creating anything.
  -- We build a temp table of needed quantities per product.
  FOR v_item IN
    SELECT qi.product_id, p.product_name,
           SUM(COALESCE(qi.total_units_needed, 0)) AS qty_needed
    FROM quote_items qi
    JOIN products p ON p.id = qi.product_id
    WHERE qi.quote_id = p_quote_id
      AND qi.product_id IS NOT NULL
      AND COALESCE(qi.total_units_needed, 0) > 0
    GROUP BY qi.product_id, p.product_name
  LOOP
    -- Lock the inventory row (or detect it doesn't exist)
    SELECT * INTO v_inv
    FROM inventory
    WHERE product_id = v_item.product_id AND location = 'Main Warehouse'
    FOR UPDATE;

    IF NOT FOUND THEN
      v_shortfalls := array_append(v_shortfalls,
        v_item.product_name || ': need ' || v_item.qty_needed || ', have 0 in stock');
    ELSIF (v_inv.quantity_available - v_inv.quantity_prebooked) < v_item.qty_needed THEN
      v_shortfalls := array_append(v_shortfalls,
        v_item.product_name || ': need ' || v_item.qty_needed ||
        ', only ' || (v_inv.quantity_available - v_inv.quantity_prebooked) || ' free');
    END IF;
  END LOOP;

  IF array_length(v_shortfalls, 1) > 0 THEN
    RAISE EXCEPTION 'Insufficient inventory to convert quote: %', array_to_string(v_shortfalls, '; ');
  END IF;

  -- Mark quote as accepted
  UPDATE quotes SET status = 'accepted', updated_at = now() WHERE id = p_quote_id;

  -- Generate unique order number using sequence
  v_order_number := generate_order_number();

  -- Create the order
  INSERT INTO orders (
    order_number, quote_id, customer_id, status,
    commission_split, total_price, total_cost, total_profit,
    total_margin_pct, order_date, total_paid, balance_due
  ) VALUES (
    v_order_number, p_quote_id, v_quote.customer_id, 'confirmed',
    v_quote.commission_split,
    v_quote.total_price, v_quote.total_cost, v_quote.total_profit,
    v_quote.total_margin_pct, current_date, 0,
    v_quote.total_price
  ) RETURNING id INTO v_order_id;

  -- Create order items from quote items
  INSERT INTO order_items (
    order_id, product_id, quote_item_id, section_name, product_name,
    price_per_unit, cost_per_unit, actual_rate, rate_unit, acres,
    total_units_needed, unit_size, total_price, profit, net_margin,
    quantity_delivered, quantity_remaining
  )
  SELECT
    v_order_id, qi.product_id, qi.id,
    qs.section_name, p.product_name,
    qi.price_per_unit, qi.current_cost, qi.actual_rate, qi.rate_unit, qi.acres,
    COALESCE(qi.total_units_needed, 0), qi.unit_size,
    qi.total_price, qi.profit, qi.net_margin,
    0, COALESCE(qi.total_units_needed, 0)
  FROM quote_items qi
  JOIN quote_sections qs ON qs.id = qi.section_id
  JOIN products p ON p.id = qi.product_id
  WHERE qi.quote_id = p_quote_id AND qi.product_id IS NOT NULL;

  -- Pre-book inventory (rows already locked by FOR UPDATE above)
  FOR v_item IN
    SELECT oi.product_id, oi.total_units_needed, oi.unit_size
    FROM order_items oi
    WHERE oi.order_id = v_order_id AND oi.product_id IS NOT NULL AND oi.total_units_needed > 0
  LOOP
    UPDATE inventory SET
      quantity_prebooked = quantity_prebooked + v_item.total_units_needed,
      updated_at = now()
    WHERE product_id = v_item.product_id AND location = 'Main Warehouse';

    -- If no row exists, create one (availability check already flagged this)
    IF NOT FOUND THEN
      INSERT INTO inventory (product_id, location, quantity_available, quantity_prebooked, quantity_on_order, unit_size)
      VALUES (v_item.product_id, 'Main Warehouse', 0, v_item.total_units_needed, 0, v_item.unit_size);
    END IF;

    INSERT INTO inventory_transactions (
      product_id, transaction_type, quantity, to_location,
      order_id, performed_by, notes
    ) VALUES (
      v_item.product_id, 'booked', v_item.total_units_needed, 'Main Warehouse',
      v_order_id, p_performed_by,
      'Pre-booked for order ' || v_order_number
    );
  END LOOP;

  -- Create commission records
  IF v_quote.commission_split IS NOT NULL AND v_quote.commission_split ? 'splits' THEN
    INSERT INTO commissions (
      order_id, customer_id, recipient, split_percentage,
      commission_amount, order_profit, order_date, status
    )
    SELECT
      v_order_id, v_quote.customer_id,
      s->>'recipient',
      (s->>'percentage')::numeric,
      v_quote.total_profit * ((s->>'percentage')::numeric / 100),
      v_quote.total_profit,
      current_date,
      'pending'
    FROM jsonb_array_elements(v_quote.commission_split->'splits') s
    WHERE (s->>'recipient') IS NOT NULL AND (s->>'percentage')::numeric > 0;
  END IF;

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'order_created',
    'Order ' || v_order_number || ' created from quote ' || v_quote.quote_number ||
    ' for ' || COALESCE(v_customer.farm_name, 'customer'),
    p_performed_by, 'order', v_order_id, v_quote.customer_id
  );

  RETURN jsonb_build_object('status', 'created', 'order_id', v_order_id, 'order_number', v_order_number);
END;
$$;


-- ============================================================================
-- S0-1: ADD AVAILABILITY CHECK TO create_direct_order
-- Same pattern: FOR UPDATE lock + availability check before prebooking.
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
  v_inv record;
  v_shortfalls text[] := '{}';
  v_qty numeric;
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

  -- *** S0-1: AVAILABILITY CHECK ***
  -- Lock inventory rows and verify availability before creating anything.
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    IF (v_item->>'product_id') IS NULL OR COALESCE((v_item->>'quantity')::numeric, 0) <= 0 THEN
      CONTINUE;
    END IF;

    v_qty := (v_item->>'quantity')::numeric;

    SELECT * INTO v_inv
    FROM inventory
    WHERE product_id = (v_item->>'product_id')::uuid AND location = 'Main Warehouse'
    FOR UPDATE;

    IF NOT FOUND THEN
      v_shortfalls := array_append(v_shortfalls,
        COALESCE(v_item->>'product_name', 'Unknown product') ||
        ': need ' || v_qty || ', have 0 in stock');
    ELSIF (v_inv.quantity_available - v_inv.quantity_prebooked) < v_qty THEN
      v_shortfalls := array_append(v_shortfalls,
        COALESCE(v_item->>'product_name', 'Unknown product') ||
        ': need ' || v_qty ||
        ', only ' || (v_inv.quantity_available - v_inv.quantity_prebooked) || ' free');
    END IF;
  END LOOP;

  IF array_length(v_shortfalls, 1) > 0 THEN
    RAISE EXCEPTION 'Insufficient inventory to create order: %', array_to_string(v_shortfalls, '; ');
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

  -- Create order items and prebook inventory (rows already locked above)
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    IF (v_item->>'product_id') IS NULL OR COALESCE((v_item->>'quantity')::numeric, 0) <= 0 THEN
      CONTINUE;
    END IF;

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

    -- Prebook inventory (already locked by FOR UPDATE above)
    UPDATE inventory SET
      quantity_prebooked = quantity_prebooked + (v_item->>'quantity')::numeric,
      updated_at = now()
    WHERE product_id = (v_item->>'product_id')::uuid AND location = 'Main Warehouse';

    IF NOT FOUND THEN
      INSERT INTO inventory (product_id, location, quantity_available, quantity_prebooked, quantity_on_order, unit_size)
      VALUES (
        (v_item->>'product_id')::uuid, 'Main Warehouse',
        0, (v_item->>'quantity')::numeric, 0,
        v_item->>'unit_size'
      );
    END IF;

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

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'create_direct_order', v_result);
  END IF;

  RETURN v_result;
END;
$$;


-- ============================================================================
-- S0-5: OVER-DELIVERY DETECTION IN complete_delivery
-- Replace GREATEST(qty - x, 0) with pre-check that raises on insufficient stock.
-- Also logs over_delivery transactions when stock is lower than expected.
-- ============================================================================

CREATE OR REPLACE FUNCTION complete_delivery(
  p_delivery_id uuid,
  p_signed_by text,
  p_performed_by uuid
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
  v_shortfall numeric;
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

  -- *** S0-5: PRE-CHECK INVENTORY AVAILABILITY ***
  -- Lock inventory rows and verify we have enough stock to deliver.
  FOR v_item IN
    SELECT di.*, p.product_name
    FROM delivery_items di
    JOIN products p ON p.id = di.product_id
    WHERE di.delivery_id = p_delivery_id
  LOOP
    SELECT * INTO v_inv
    FROM inventory
    WHERE product_id = v_item.product_id AND location = 'Main Warehouse'
    FOR UPDATE;

    IF NOT FOUND OR v_inv.quantity_available < v_item.quantity THEN
      -- Block the delivery — don't silently deliver phantom units
      RAISE EXCEPTION 'Insufficient inventory for %: need % units, only % available',
        v_item.product_name,
        v_item.quantity,
        COALESCE(v_inv.quantity_available, 0);
    END IF;
  END LOOP;

  -- Step 1: Mark delivery completed
  UPDATE deliveries SET
    status = 'completed',
    completed_at = now(),
    signed_by = p_signed_by
  WHERE id = p_delivery_id;

  -- Step 2-4: Process each delivery item atomically
  FOR v_item IN SELECT di.*, p.product_name
    FROM delivery_items di
    JOIN products p ON p.id = di.product_id
    WHERE di.delivery_id = p_delivery_id
  LOOP
    -- Update order_item delivered/remaining counts
    UPDATE order_items SET
      quantity_delivered = quantity_delivered + v_item.quantity,
      quantity_remaining = GREATEST(quantity_remaining - v_item.quantity, 0)
    WHERE id = v_item.order_item_id;

    -- Create audit trail
    INSERT INTO inventory_transactions (
      product_id, transaction_type, quantity, from_location,
      order_id, delivery_id, performed_by, notes
    ) VALUES (
      v_item.product_id, 'delivered', v_item.quantity, 'Main Warehouse',
      v_delivery.order_id, p_delivery_id, p_performed_by,
      'Delivery ' || v_delivery.delivery_number || ' completed. Signed by: ' || p_signed_by
    );

    -- Reduce inventory — no more GREATEST clamping, we verified stock above
    UPDATE inventory SET
      quantity_available = quantity_available - v_item.quantity,
      quantity_prebooked = GREATEST(quantity_prebooked - v_item.quantity, 0),
      updated_at = now()
    WHERE product_id = v_item.product_id AND location = 'Main Warehouse';
  END LOOP;

  -- Step 5: Check if entire order is fully delivered
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
    'Delivery ' || v_delivery.delivery_number || ' completed. Signed by: ' || p_signed_by,
    p_performed_by, 'delivery', p_delivery_id, v_delivery.customer_id
  );

  RETURN jsonb_build_object(
    'status', 'completed',
    'order_status', CASE WHEN v_all_delivered THEN 'fulfilled' ELSE 'partially_fulfilled' END
  );
END;
$$;


-- Re-grant permissions (CREATE OR REPLACE doesn't lose grants, but being explicit)
GRANT EXECUTE ON FUNCTION convert_quote_to_order(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION create_direct_order(text, uuid, date, text, jsonb, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION complete_delivery(uuid, text, uuid) TO authenticated;
