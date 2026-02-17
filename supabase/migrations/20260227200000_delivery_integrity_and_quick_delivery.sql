-- ============================================================================
-- Sprint 20: Delivery Module Integrity & Quick Delivery
-- ============================================================================
-- 1. confirm_delivery() — transitions scheduled → in_progress
-- 2. edit_delivery() — removes item replacement (items locked to order)
-- 3. complete_delivery() — requires in_progress status before completion
-- 4. create_quick_delivery() — atomic order + delivery + draft invoice
-- 5. New columns: is_quick_delivery on deliveries and invoices
-- ============================================================================

-- ============================================================================
-- 1. New columns
-- ============================================================================
ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS is_quick_delivery boolean DEFAULT false;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS is_quick_delivery boolean DEFAULT false;

-- ============================================================================
-- 2. confirm_delivery() — new RPC
-- ============================================================================
CREATE OR REPLACE FUNCTION confirm_delivery(
  p_delivery_id uuid,
  p_performed_by uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_delivery record;
  v_actor uuid;
BEGIN
  v_actor := COALESCE(p_performed_by, auth.uid());

  -- Lock delivery row
  SELECT * INTO v_delivery
  FROM deliveries WHERE id = p_delivery_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Delivery not found';
  END IF;

  IF v_delivery.status != 'scheduled' THEN
    RAISE EXCEPTION 'Delivery must be in scheduled status to start. Current status: %', v_delivery.status;
  END IF;

  -- Verify caller is admin, sales_rep, or the assigned driver
  IF NOT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = v_actor AND is_active = true
      AND (
        role IN ('admin', 'sales_rep')
        OR (role = 'driver' AND v_actor = v_delivery.assigned_driver)
      )
  ) THEN
    RAISE EXCEPTION 'Not authorized to start this delivery';
  END IF;

  -- Transition to in_progress
  UPDATE deliveries SET
    status = 'in_progress',
    updated_at = now()
  WHERE id = p_delivery_id;

  -- Log activity
  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'delivery_confirmed',
    'Delivery ' || v_delivery.delivery_number || ' confirmed and started',
    v_actor, 'delivery', p_delivery_id, v_delivery.customer_id
  );

  -- Notify assigned driver if confirmer is not the driver
  IF v_delivery.assigned_driver IS NOT NULL AND v_actor != v_delivery.assigned_driver THEN
    INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
    VALUES (
      v_delivery.assigned_driver,
      'Delivery Started',
      'Delivery ' || v_delivery.delivery_number || ' has been started and is ready for completion.',
      'delivery_update', 'delivery', p_delivery_id
    );
  END IF;

  RETURN jsonb_build_object('status', 'confirmed', 'delivery_id', p_delivery_id);
END;
$$;

GRANT EXECUTE ON FUNCTION confirm_delivery(uuid, uuid) TO authenticated;

-- ============================================================================
-- 3. edit_delivery() — remove item replacement, keep logistics editing
-- ============================================================================
CREATE OR REPLACE FUNCTION edit_delivery(
  p_delivery_id uuid,
  p_assigned_driver uuid DEFAULT NULL,
  p_scheduled_date date DEFAULT NULL,
  p_scheduled_time text DEFAULT NULL,
  p_delivery_window_start text DEFAULT NULL,
  p_delivery_window_end text DEFAULT NULL,
  p_delivery_address_id uuid DEFAULT NULL,
  p_delivery_notes text DEFAULT NULL,
  p_priority text DEFAULT NULL,
  p_items jsonb DEFAULT NULL,       -- kept in signature for backward compat, intentionally ignored
  p_performed_by uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_delivery record;
  v_actor uuid;
  v_old_driver uuid;
BEGIN
  v_actor := COALESCE(p_performed_by, auth.uid());

  -- Lock the delivery row
  SELECT * INTO v_delivery
  FROM deliveries WHERE id = p_delivery_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Delivery not found';
  END IF;

  IF v_delivery.status NOT IN ('scheduled', 'in_progress') THEN
    RAISE EXCEPTION 'Cannot edit a % delivery', v_delivery.status;
  END IF;

  -- Verify caller is admin or sales_rep
  IF NOT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'Not authorized to edit deliveries';
  END IF;

  v_old_driver := v_delivery.assigned_driver;

  -- Update delivery header (only non-null params) — NO item replacement
  -- p_items intentionally ignored: delivery items are locked to order
  UPDATE deliveries SET
    assigned_driver = COALESCE(p_assigned_driver, assigned_driver),
    scheduled_date = COALESCE(p_scheduled_date, scheduled_date),
    scheduled_time = CASE WHEN p_scheduled_time IS NOT NULL THEN p_scheduled_time ELSE scheduled_time END,
    delivery_window_start = CASE WHEN p_delivery_window_start IS NOT NULL THEN p_delivery_window_start ELSE delivery_window_start END,
    delivery_window_end = CASE WHEN p_delivery_window_end IS NOT NULL THEN p_delivery_window_end ELSE delivery_window_end END,
    delivery_address_id = CASE WHEN p_delivery_address_id IS NOT NULL THEN p_delivery_address_id ELSE delivery_address_id END,
    delivery_notes = CASE WHEN p_delivery_notes IS NOT NULL THEN p_delivery_notes ELSE delivery_notes END,
    priority = COALESCE(p_priority, priority),
    last_edited_by = v_actor,
    last_edited_at = now(),
    updated_at = now()
  WHERE id = p_delivery_id;

  -- Notify old driver if driver changed
  IF p_assigned_driver IS NOT NULL AND v_old_driver IS DISTINCT FROM p_assigned_driver THEN
    IF v_old_driver IS NOT NULL THEN
      INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
      VALUES (
        v_old_driver,
        'Delivery Reassigned',
        'Delivery ' || v_delivery.delivery_number || ' has been reassigned to another driver.',
        'delivery_update', 'delivery', p_delivery_id
      );
    END IF;

    INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
    VALUES (
      p_assigned_driver,
      'New Delivery Assigned',
      'Delivery ' || v_delivery.delivery_number || ' has been assigned to you.',
      'delivery_update', 'delivery', p_delivery_id
    );
  END IF;

  -- Activity log
  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'delivery_edited',
    'Delivery ' || v_delivery.delivery_number || ' edited',
    v_actor, 'delivery', p_delivery_id, v_delivery.customer_id
  );

  RETURN jsonb_build_object('status', 'updated', 'delivery_id', p_delivery_id);
END;
$$;

GRANT EXECUTE ON FUNCTION edit_delivery(uuid, uuid, date, text, text, text, uuid, text, text, jsonb, uuid) TO authenticated;

-- ============================================================================
-- 4. complete_delivery() — require in_progress status
-- ============================================================================
CREATE OR REPLACE FUNCTION complete_delivery(
  p_delivery_id uuid,
  p_signed_by text,
  p_performed_by uuid,
  p_quantities jsonb DEFAULT NULL,
  p_issue_type text DEFAULT NULL,
  p_issue_notes text DEFAULT NULL
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
  -- Validate delivery exists
  SELECT * INTO v_delivery FROM deliveries WHERE id = p_delivery_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Delivery not found';
  END IF;

  -- CHANGED: Require in_progress status (must be started before completing)
  IF v_delivery.status = 'completed' THEN
    RETURN jsonb_build_object('status', 'already_completed');
  END IF;

  IF v_delivery.status != 'in_progress' THEN
    RAISE EXCEPTION 'Delivery must be started before completing. Current status: %', v_delivery.status;
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
    IF p_quantities IS NOT NULL AND p_quantities ? v_item.id::text THEN
      v_qty_to_deliver := (p_quantities->>v_item.id::text)::numeric;
      v_qty_to_deliver := GREATEST(0, LEAST(v_qty_to_deliver, v_item.quantity));
    ELSE
      v_qty_to_deliver := v_item.quantity;
    END IF;

    IF v_qty_to_deliver < v_item.quantity THEN
      v_any_partial := true;
    END IF;

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

  -- Mark delivery completed (with issue info)
  UPDATE deliveries SET
    status = 'completed',
    completed_at = now(),
    signed_by = p_signed_by,
    issue_type = COALESCE(p_issue_type, issue_type),
    issue_notes = CASE WHEN p_issue_notes IS NOT NULL THEN p_issue_notes ELSE issue_notes END
  WHERE id = p_delivery_id;

  -- Process each delivery item
  FOR v_item IN
    SELECT di.*, p.product_name
    FROM delivery_items di
    JOIN products p ON p.id = di.product_id
    WHERE di.delivery_id = p_delivery_id
  LOOP
    IF p_quantities IS NOT NULL AND p_quantities ? v_item.id::text THEN
      v_qty_to_deliver := (p_quantities->>v_item.id::text)::numeric;
      v_qty_to_deliver := GREATEST(0, LEAST(v_qty_to_deliver, v_item.quantity));
    ELSE
      v_qty_to_deliver := v_item.quantity;
    END IF;

    UPDATE delivery_items SET quantity_delivered = v_qty_to_deliver
    WHERE id = v_item.id;

    IF v_qty_to_deliver = 0 THEN
      CONTINUE;
    END IF;

    UPDATE order_items SET
      quantity_delivered = quantity_delivered + v_qty_to_deliver,
      quantity_remaining = GREATEST(quantity_remaining - v_qty_to_deliver, 0)
    WHERE id = v_item.order_item_id;

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

    UPDATE inventory SET
      quantity_available = quantity_available - v_qty_to_deliver,
      quantity_prebooked = GREATEST(quantity_prebooked - v_qty_to_deliver, 0),
      updated_at = now()
    WHERE product_id = v_item.product_id AND location = 'Main Warehouse';
  END LOOP;

  -- Create remainder records for partial deliveries
  IF v_any_partial THEN
    FOR v_item IN
      SELECT di.*, p.product_name
      FROM delivery_items di
      JOIN products p ON p.id = di.product_id
      WHERE di.delivery_id = p_delivery_id
        AND di.quantity_delivered < di.quantity
    LOOP
      INSERT INTO delivery_remainders (
        original_delivery_id, order_id, order_item_id,
        customer_id, product_id, quantity_remaining, unit_size
      ) VALUES (
        p_delivery_id, v_delivery.order_id, v_item.order_item_id,
        v_delivery.customer_id, v_item.product_id,
        v_item.quantity - v_item.quantity_delivered, v_item.unit_size
      );
    END LOOP;
  END IF;

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
      CASE WHEN p_issue_type IS NOT NULL AND p_issue_type <> 'none'
        THEN '. Issue: ' || p_issue_type
        ELSE '' END ||
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

GRANT EXECUTE ON FUNCTION complete_delivery(uuid, text, uuid, jsonb, text, text) TO authenticated;

-- ============================================================================
-- 5. create_quick_delivery() — atomic order + delivery + draft invoice
-- ============================================================================
CREATE OR REPLACE FUNCTION create_quick_delivery(
  p_customer_id uuid,
  p_items jsonb,              -- [{product_id, quantity, unit_size, price_cents}]
  p_driver_id uuid DEFAULT NULL,
  p_scheduled_date date DEFAULT CURRENT_DATE,
  p_delivery_notes text DEFAULT NULL,
  p_performed_by uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid;
  v_order_id uuid;
  v_order_number text;
  v_delivery_id uuid;
  v_delivery_number text;
  v_invoice_id uuid;
  v_invoice_number text;
  v_item jsonb;
  v_order_item_id uuid;
  v_product record;
  v_total_cents bigint := 0;
  v_item_price_cents bigint;
  v_item_qty numeric;
  v_sort integer := 0;
  v_customer record;
BEGIN
  v_actor := COALESCE(p_performed_by, auth.uid());

  -- Verify caller is admin, sales_rep, or driver
  IF NOT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = v_actor AND is_active = true
      AND role IN ('admin', 'sales_rep', 'driver')
  ) THEN
    RAISE EXCEPTION 'Not authorized to create quick deliveries';
  END IF;

  -- Verify customer exists
  SELECT * INTO v_customer
  FROM customers WHERE id = p_customer_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Customer not found';
  END IF;

  -- Validate items
  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'At least one item is required';
  END IF;

  -- -----------------------------------------------------------------------
  -- Step 1: Create Order
  -- -----------------------------------------------------------------------
  v_order_id := gen_random_uuid();
  v_order_number := generate_order_number();

  INSERT INTO orders (
    id, order_number, customer_id, status,
    order_date, notes, total_price, total_cost, total_profit, total_margin_pct
  ) VALUES (
    v_order_id, v_order_number, p_customer_id, 'confirmed',
    CURRENT_DATE, 'Quick delivery', 0, 0, 0, 0
  );

  -- -----------------------------------------------------------------------
  -- Step 2: Create Delivery
  -- -----------------------------------------------------------------------
  v_delivery_id := gen_random_uuid();
  v_delivery_number := next_delivery_number();

  INSERT INTO deliveries (
    id, delivery_number, order_id, customer_id,
    assigned_driver, scheduled_date, status,
    delivery_notes, is_quick_delivery
  ) VALUES (
    v_delivery_id, v_delivery_number, v_order_id, p_customer_id,
    p_driver_id, p_scheduled_date, 'scheduled',
    p_delivery_notes, true
  );

  -- -----------------------------------------------------------------------
  -- Step 3: Create Invoice (draft chemical_sale)
  -- -----------------------------------------------------------------------
  v_invoice_id := gen_random_uuid();
  v_invoice_number := next_invoice_number('chemical_sale');

  INSERT INTO invoices (
    id, invoice_number, invoice_type, order_id, customer_id,
    status, total_amount_cents, paid_amount_cents, prepay_applied_cents,
    invoice_date, is_quick_delivery, created_by
  ) VALUES (
    v_invoice_id, v_invoice_number, 'chemical_sale', v_order_id, p_customer_id,
    'draft', 0, 0, 0,
    CURRENT_DATE, true, v_actor
  );

  -- -----------------------------------------------------------------------
  -- Step 4: Process items — create order_items, delivery_items, invoice_items
  -- -----------------------------------------------------------------------
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_sort := v_sort + 1;

    -- Lookup product
    SELECT * INTO v_product
    FROM products WHERE id = (v_item->>'product_id')::uuid AND is_active = true;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Product not found or inactive: %', v_item->>'product_id';
    END IF;

    v_item_qty := (v_item->>'quantity')::numeric;
    v_item_price_cents := (v_item->>'price_cents')::bigint;

    -- Fallback: use product tier1_price converted to cents if price_cents not provided
    IF v_item_price_cents IS NULL THEN
      v_item_price_cents := COALESCE(v_product.tier1_price * 100, 0)::bigint;
    END IF;

    -- Create order item
    v_order_item_id := gen_random_uuid();
    INSERT INTO order_items (
      id, order_id, product_id, product_name, price_per_unit, cost_per_unit,
      total_units_needed, quantity_remaining, quantity_delivered, unit_size,
      total_price, profit, net_margin
    ) VALUES (
      v_order_item_id, v_order_id, v_product.id, v_product.product_name,
      (v_item_price_cents / 100.0)::numeric, COALESCE(v_product.current_cost, 0),
      v_item_qty, v_item_qty, 0,
      COALESCE(v_item->>'unit_size', v_product.unit_size),
      (v_item_price_cents * v_item_qty / 100.0)::numeric,
      ((v_item_price_cents / 100.0) - COALESCE(v_product.current_cost, 0)) * v_item_qty,
      CASE WHEN v_item_price_cents > 0
        THEN ((v_item_price_cents / 100.0 - COALESCE(v_product.current_cost, 0)) / (v_item_price_cents / 100.0) * 100)
        ELSE 0
      END
    );

    -- Create delivery item
    INSERT INTO delivery_items (
      delivery_id, order_item_id, product_id, quantity, unit_size
    ) VALUES (
      v_delivery_id, v_order_item_id, v_product.id, v_item_qty,
      COALESCE(v_item->>'unit_size', v_product.unit_size)
    );

    -- Create invoice item
    INSERT INTO invoice_items (
      invoice_id, order_item_id, product_id, description,
      quantity, unit_price_cents, extended_cents, cost_cents,
      unit_size, sort_order
    ) VALUES (
      v_invoice_id, v_order_item_id, v_product.id, v_product.product_name,
      v_item_qty, v_item_price_cents, v_item_price_cents * v_item_qty::bigint,
      COALESCE(v_product.current_cost * 100, 0)::bigint,
      COALESCE(v_item->>'unit_size', v_product.unit_size), v_sort
    );

    v_total_cents := v_total_cents + (v_item_price_cents * v_item_qty::bigint);
  END LOOP;

  -- -----------------------------------------------------------------------
  -- Step 5: Update totals
  -- -----------------------------------------------------------------------
  UPDATE orders SET
    total_price = (v_total_cents / 100.0)::numeric
  WHERE id = v_order_id;

  UPDATE invoices SET
    total_amount_cents = v_total_cents
  WHERE id = v_invoice_id;

  -- -----------------------------------------------------------------------
  -- Step 6: Activity log
  -- -----------------------------------------------------------------------
  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'quick_delivery_created',
    'Quick delivery ' || v_delivery_number || ' created with order ' || v_order_number || ' and draft invoice ' || v_invoice_number,
    v_actor, 'delivery', v_delivery_id, p_customer_id
  );

  RETURN jsonb_build_object(
    'status', 'created',
    'order_id', v_order_id,
    'order_number', v_order_number,
    'delivery_id', v_delivery_id,
    'delivery_number', v_delivery_number,
    'invoice_id', v_invoice_id,
    'invoice_number', v_invoice_number
  );
END;
$$;

GRANT EXECUTE ON FUNCTION create_quick_delivery(uuid, jsonb, uuid, date, text, uuid) TO authenticated;
