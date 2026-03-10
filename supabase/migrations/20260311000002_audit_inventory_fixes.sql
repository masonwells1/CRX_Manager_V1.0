-- ============================================================================
-- Migration: 20260311000002_audit_inventory_fixes.sql
--
-- Fixes 6 critical bugs found during inventory/concurrency audit:
--
-- Bug 1: create_quick_delivery missing inventory prebooking after order_items INSERT
-- Bug 2: convert_quote_to_order has two conflicting overloads — consolidate into one
-- Bug 3: complete_delivery creates duplicate invoices for quick deliveries
-- Bug 4: receive_return missing FOR UPDATE lock on inventory rows
-- Bug 5: complete_cycle_count missing FOR UPDATE lock on inventory rows
-- Bug 6: create_quick_delivery missing idempotency support
-- ============================================================================


-- ============================================================================
-- BUG 1 + BUG 6: Rewrite create_quick_delivery
--   - Add inventory prebooking after order_items INSERT (Bug 1)
--   - Add p_idempotency_key parameter with check/save pattern (Bug 6)
-- ============================================================================

-- Drop the old signature first so we can add the new parameter
DROP FUNCTION IF EXISTS create_quick_delivery(uuid, jsonb, uuid, date, text, uuid);

CREATE OR REPLACE FUNCTION create_quick_delivery(
  p_customer_id uuid,
  p_items jsonb,
  p_driver_id uuid DEFAULT NULL,
  p_scheduled_date date DEFAULT CURRENT_DATE,
  p_delivery_notes text DEFAULT NULL,
  p_performed_by uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL  -- BUG 6: Add idempotency support
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
  v_inv record;
  v_total_cents bigint := 0;
  v_total_cost_cents bigint := 0;
  v_item_price_cents bigint;
  v_item_qty numeric;
  v_item_product_id uuid;  -- BUG 1: track product_id for prebooking
  v_sort integer := 0;
  v_customer record;
  v_split jsonb;
  v_split_entry jsonb;
  v_order_profit numeric;
  v_split_total numeric;
  v_net_available numeric;
  v_cached_result jsonb;  -- BUG 6: idempotency
  v_result jsonb;          -- BUG 6: idempotency
BEGIN
  v_actor := COALESCE(p_performed_by, auth.uid());

  -- BUG 6: Check idempotency key if provided
  IF p_idempotency_key IS NOT NULL THEN
    v_cached_result := check_idempotency(p_idempotency_key, 'create_quick_delivery');
    IF v_cached_result IS NOT NULL THEN
      RETURN v_cached_result;
    END IF;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = v_actor AND is_active = true
      AND role IN ('admin', 'sales_rep', 'driver')
  ) THEN
    RAISE EXCEPTION 'Not authorized to create quick deliveries';
  END IF;

  SELECT * INTO v_customer
  FROM customers WHERE id = p_customer_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Customer not found';
  END IF;

  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'At least one item is required';
  END IF;

  -- Pre-check inventory availability before creating anything
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    SELECT * INTO v_product
    FROM products WHERE id = (v_item->>'product_id')::uuid AND is_active = true;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Product not found or inactive: %', v_item->>'product_id';
    END IF;

    v_item_qty := (v_item->>'quantity')::numeric;

    SELECT * INTO v_inv
    FROM inventory
    WHERE product_id = v_product.id AND location = 'Main Warehouse'
    FOR UPDATE;

    -- Subtract prebooked from available for net free check
    v_net_available := COALESCE(v_inv.quantity_available, 0) - COALESCE(v_inv.quantity_prebooked, 0);

    IF NOT FOUND OR v_net_available < v_item_qty THEN
      RAISE EXCEPTION 'Insufficient inventory for %: need % units, only % net available (% on hand, % prebooked)',
        v_product.product_name,
        v_item_qty,
        GREATEST(v_net_available, 0),
        COALESCE(v_inv.quantity_available, 0),
        COALESCE(v_inv.quantity_prebooked, 0);
    END IF;
  END LOOP;

  -- Commission split from customer defaults
  v_split := v_customer.default_commission_split;

  -- Commission splits are stored as {splits: [{recipient, percentage}]}, not bare array
  IF v_split IS NOT NULL AND v_split ? 'splits' AND jsonb_array_length(v_split->'splits') > 0 THEN
    SELECT COALESCE(SUM((elem->>'percentage')::numeric), 0)
    INTO v_split_total
    FROM jsonb_array_elements(v_split->'splits') elem;

    IF ABS(v_split_total - 100) > 0.01 THEN
      RAISE EXCEPTION 'Customer commission splits must sum to 100%% (got %). Fix customer settings before creating delivery.', v_split_total;
    END IF;
  END IF;

  -- Step 1: Create Order
  v_order_id := gen_random_uuid();
  v_order_number := generate_order_number();

  INSERT INTO orders (
    id, order_number, customer_id, status,
    order_date, notes, total_price, total_cost, total_profit, total_margin_pct,
    commission_split
  ) VALUES (
    v_order_id, v_order_number, p_customer_id, 'confirmed',
    CURRENT_DATE, 'Quick delivery', 0, 0, 0, 0,
    v_customer.default_commission_split
  );

  -- Step 2: Create Delivery
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

  -- Step 3: Create Invoice (draft)
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

  -- Step 4: Process items (inventory already validated above)
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_sort := v_sort + 1;

    SELECT * INTO v_product
    FROM products WHERE id = (v_item->>'product_id')::uuid AND is_active = true;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Product not found or inactive: %', v_item->>'product_id';
    END IF;

    v_item_qty := (v_item->>'quantity')::numeric;
    v_item_price_cents := (v_item->>'price_cents')::bigint;
    v_item_product_id := v_product.id;  -- BUG 1: save product_id for prebooking

    IF v_item_price_cents IS NULL THEN
      v_item_price_cents := CASE COALESCE(v_customer.assigned_tier, 1)
        WHEN 1 THEN COALESCE(v_product.tier1_price * 100, 0)::bigint
        WHEN 2 THEN COALESCE(v_product.tier2_price * 100, v_product.tier1_price * 100, 0)::bigint
        WHEN 3 THEN COALESCE(v_product.tier3_price * 100, v_product.tier1_price * 100, 0)::bigint
        ELSE COALESCE(v_product.tier1_price * 100, 0)::bigint
      END;
    END IF;

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

    -- BUG 1 FIX: Pre-book inventory for each item (matches create_direct_order behavior)
    -- Without this, two concurrent quick deliveries can double-allocate the same inventory.
    UPDATE inventory
    SET quantity_prebooked = quantity_prebooked + v_item_qty,
        updated_at = now()
    WHERE product_id = v_item_product_id AND location = 'Main Warehouse';

    IF NOT FOUND THEN
      INSERT INTO inventory (product_id, location, quantity_available, quantity_prebooked, quantity_on_order, unit_size)
      VALUES (v_item_product_id, 'Main Warehouse', 0, v_item_qty, 0, COALESCE(v_item->>'unit_size', v_product.unit_size));
    END IF;

    INSERT INTO inventory_transactions (
      product_id, transaction_type, quantity, to_location,
      order_id, performed_by, notes
    ) VALUES (
      v_item_product_id, 'booked', v_item_qty, 'Main Warehouse',
      v_order_id, v_actor,
      'Pre-booked for quick delivery order ' || v_order_number
    );

    INSERT INTO delivery_items (
      delivery_id, order_item_id, product_id, quantity, unit_size
    ) VALUES (
      v_delivery_id, v_order_item_id, v_product.id, v_item_qty,
      COALESCE(v_item->>'unit_size', v_product.unit_size)
    );

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
    v_total_cost_cents := v_total_cost_cents + (COALESCE(v_product.current_cost * 100, 0)::bigint * v_item_qty::bigint);
  END LOOP;

  -- Step 5: Update totals
  v_order_profit := ((v_total_cents - v_total_cost_cents) / 100.0)::numeric;

  UPDATE orders SET
    total_price = (v_total_cents / 100.0)::numeric,
    total_cost = (v_total_cost_cents / 100.0)::numeric,
    total_profit = v_order_profit,
    total_margin_pct = CASE WHEN v_total_cents > 0
      THEN ((v_total_cents - v_total_cost_cents)::numeric / v_total_cents * 100)
      ELSE 0 END
  WHERE id = v_order_id;

  UPDATE invoices SET
    total_amount_cents = v_total_cents
  WHERE id = v_invoice_id;

  -- Generate commissions (correct JSON path through 'splits' key)
  IF v_split IS NOT NULL AND v_split ? 'splits' AND jsonb_array_length(v_split->'splits') > 0 THEN
    FOR v_split_entry IN SELECT * FROM jsonb_array_elements(v_split->'splits')
    LOOP
      INSERT INTO commissions (
        order_id, customer_id, recipient,
        split_percentage, commission_amount, order_profit,
        order_date, status
      ) VALUES (
        v_order_id, p_customer_id,
        COALESCE(v_split_entry->>'recipient', v_split_entry->>'name', 'Unknown'),
        (v_split_entry->>'percentage')::numeric,
        v_order_profit * ((v_split_entry->>'percentage')::numeric / 100.0),
        v_order_profit,
        CURRENT_DATE,
        'pending'
      );
    END LOOP;
  END IF;

  -- Activity log
  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'quick_delivery_created',
    'Quick delivery ' || v_delivery_number || ' created with order ' || v_order_number || ' and draft invoice ' || v_invoice_number,
    v_actor, 'delivery', v_delivery_id, p_customer_id
  );

  v_result := jsonb_build_object(
    'status', 'created',
    'order_id', v_order_id,
    'order_number', v_order_number,
    'delivery_id', v_delivery_id,
    'delivery_number', v_delivery_number,
    'invoice_id', v_invoice_id,
    'invoice_number', v_invoice_number
  );

  -- BUG 6 FIX: Save idempotency result if key was provided
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'create_quick_delivery', v_result);
  END IF;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION create_quick_delivery(uuid, jsonb, uuid, date, text, uuid, text) TO authenticated;


-- ============================================================================
-- BUG 2: Drop orphan convert_quote_to_order overloads and consolidate
--   - Drop 2-param (uuid, uuid) from 20260322100000 — has net position but NO idempotency
--   - Drop 3-param (uuid, uuid, text) from 20260320100000 — has idempotency but OLD blocking check
--   - Create unified version with: net position check (warn not block) + idempotency
-- ============================================================================

-- Drop both overloads
DROP FUNCTION IF EXISTS convert_quote_to_order(uuid, uuid);
DROP FUNCTION IF EXISTS convert_quote_to_order(uuid, uuid, text);

CREATE OR REPLACE FUNCTION convert_quote_to_order(
  p_quote_id uuid,
  p_performed_by uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid;
  v_quote record;
  v_order_number text;
  v_order_id uuid;
  v_section record;
  v_item record;
  v_customer record;
  v_split jsonb;
  v_inv record;
  v_shortfalls text[] := '{}';
  v_net_position numeric;
  v_cached_result jsonb;
  v_result jsonb;
BEGIN
  -- Derive actor from JWT, reject spoofing
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by <> v_actor THEN
    RAISE EXCEPTION 'Actor mismatch';
  END IF;

  -- BUG 2 FIX: Check idempotency key if provided (from 3-param version)
  IF p_idempotency_key IS NOT NULL THEN
    v_cached_result := check_idempotency(p_idempotency_key, 'convert_quote_to_order');
    IF v_cached_result IS NOT NULL THEN
      RETURN v_cached_result;
    END IF;
  END IF;

  SELECT * INTO v_quote FROM quotes WHERE id = p_quote_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Quote not found'; END IF;

  -- Idempotency: already converted? (from 2-param version)
  IF v_quote.status = 'accepted' THEN
    SELECT id INTO v_order_id FROM orders WHERE quote_id = p_quote_id LIMIT 1;
    IF v_order_id IS NOT NULL THEN
      RETURN jsonb_build_object('status', 'already_converted', 'order_id', v_order_id);
    END IF;
  END IF;

  SELECT * INTO v_customer FROM customers WHERE id = v_quote.customer_id;

  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true
      AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  -- BUG 2 FIX: Availability check using NET POSITION (from 2-param version)
  -- Collects warnings, does NOT block order creation
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
    SELECT * INTO v_inv
    FROM inventory
    WHERE product_id = v_item.product_id AND location = 'Main Warehouse'
    FOR UPDATE;

    IF NOT FOUND THEN
      v_shortfalls := array_append(v_shortfalls,
        v_item.product_name || ': need ' || v_item.qty_needed || ', net position is 0 (no inventory record)');
    ELSE
      -- Net position = available - prebooked + on_order
      v_net_position := v_inv.quantity_available - v_inv.quantity_prebooked + COALESCE(v_inv.quantity_on_order, 0);
      IF v_net_position < v_item.qty_needed THEN
        v_shortfalls := array_append(v_shortfalls,
          v_item.product_name || ': need ' || v_item.qty_needed ||
          ', net position is ' || GREATEST(v_net_position, 0) ||
          ' (on floor: ' || (v_inv.quantity_available - v_inv.quantity_prebooked) ||
          ', on order: ' || COALESCE(v_inv.quantity_on_order, 0) || ')');
      END IF;
    END IF;
  END LOOP;

  SET LOCAL app.admin_override = 'true';

  UPDATE quotes SET status = 'accepted', updated_at = now() WHERE id = p_quote_id;

  v_order_number := generate_order_number();

  INSERT INTO orders (
    order_number, quote_id, customer_id, status,
    commission_split, total_price, total_cost, total_profit,
    total_margin_pct, order_date
  ) VALUES (
    v_order_number, p_quote_id, v_quote.customer_id, 'confirmed',
    v_quote.commission_split,
    v_quote.total_price, v_quote.total_cost, v_quote.total_profit,
    v_quote.total_margin_pct, current_date
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

  -- Pre-book inventory (even if exceeding available — tracks oversold status)
  FOR v_item IN
    SELECT oi.product_id, oi.total_units_needed, oi.unit_size
    FROM order_items oi
    WHERE oi.order_id = v_order_id AND oi.product_id IS NOT NULL AND oi.total_units_needed > 0
  LOOP
    UPDATE inventory SET
      quantity_prebooked = quantity_prebooked + v_item.total_units_needed,
      updated_at = now()
    WHERE product_id = v_item.product_id AND location = 'Main Warehouse';

    IF NOT FOUND THEN
      INSERT INTO inventory (product_id, location, quantity_available, quantity_prebooked, quantity_on_order, unit_size)
      VALUES (v_item.product_id, 'Main Warehouse', 0, v_item.total_units_needed, 0, v_item.unit_size);
    END IF;

    INSERT INTO inventory_transactions (
      product_id, transaction_type, quantity, to_location,
      order_id, performed_by, notes
    ) VALUES (
      v_item.product_id, 'booked', v_item.total_units_needed, 'Main Warehouse',
      v_order_id, v_actor,
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
    ' for ' || COALESCE(v_customer.farm_name, 'customer') ||
    CASE WHEN array_length(v_shortfalls, 1) > 0
      THEN ' (inventory warnings: ' || array_to_string(v_shortfalls, '; ') || ')'
      ELSE '' END,
    v_actor, 'order', v_order_id, v_quote.customer_id
  );

  -- Return result WITH warnings (instead of blocking)
  v_result := jsonb_build_object(
    'status', 'created',
    'order_id', v_order_id,
    'order_number', v_order_number,
    'warnings', to_jsonb(v_shortfalls)
  );

  -- BUG 2 FIX: Save idempotency result if key was provided
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'convert_quote_to_order', v_result);
  END IF;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION convert_quote_to_order(uuid, uuid, text) TO authenticated;


-- ============================================================================
-- BUG 3: Fix complete_delivery duplicate invoice for quick deliveries
--   - Before calling create_invoice_from_delivery, check if order already has
--     a draft/posted/overdue/paid invoice (e.g., from quick delivery flow)
--   - Skip auto-invoice creation if one already exists
-- ============================================================================

CREATE OR REPLACE FUNCTION complete_delivery(
  p_delivery_id uuid,
  p_signed_by text,
  p_performed_by uuid,
  p_quantities jsonb DEFAULT NULL,
  p_issue_type text DEFAULT NULL,
  p_issue_notes text DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_delivery record;
  v_item record;
  v_inv record;
  v_all_delivered boolean;
  v_qty_to_deliver numeric;
  v_any_partial boolean := false;
  v_linked_invoice record;
  v_old_total bigint;
  v_new_total bigint;
  v_admin record;
  v_deduct_from_prebooked numeric;
  v_deduct_from_available numeric;
  v_auto_invoice jsonb;
BEGIN
  SELECT * INTO v_delivery FROM deliveries WHERE id = p_delivery_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Delivery not found'; END IF;

  IF v_delivery.status = 'completed' THEN
    RETURN jsonb_build_object('status', 'already_completed');
  END IF;
  IF v_delivery.status != 'in_progress' THEN
    RAISE EXCEPTION 'Delivery must be started before completing. Current status: %', v_delivery.status;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = p_performed_by AND is_active = true
      AND (role IN ('admin', 'sales_rep') OR (role = 'driver' AND p_performed_by = v_delivery.assigned_driver))
  ) THEN RAISE EXCEPTION 'Not authorized to complete this delivery'; END IF;

  -- PRE-CHECK INVENTORY (now accounts for prebooked stock)
  FOR v_item IN
    SELECT di.*, p.product_name
    FROM delivery_items di JOIN products p ON p.id = di.product_id
    WHERE di.delivery_id = p_delivery_id
  LOOP
    IF p_quantities IS NOT NULL AND p_quantities ? v_item.id::text THEN
      v_qty_to_deliver := GREATEST(0, LEAST((p_quantities->>v_item.id::text)::numeric, v_item.quantity));
    ELSE
      v_qty_to_deliver := v_item.quantity;
    END IF;

    IF v_qty_to_deliver < v_item.quantity THEN v_any_partial := true; END IF;
    IF v_qty_to_deliver = 0 THEN CONTINUE; END IF;

    SELECT * INTO v_inv FROM inventory
    WHERE product_id = v_item.product_id AND location = 'Main Warehouse' FOR UPDATE;

    IF NOT FOUND OR (v_inv.quantity_available + v_inv.quantity_prebooked) < v_qty_to_deliver THEN
      RAISE EXCEPTION 'Insufficient inventory for %: need % units, only % available (% on-hand + % prebooked)',
        v_item.product_name, v_qty_to_deliver,
        COALESCE(v_inv.quantity_available, 0) + COALESCE(v_inv.quantity_prebooked, 0),
        COALESCE(v_inv.quantity_available, 0),
        COALESCE(v_inv.quantity_prebooked, 0);
    END IF;
  END LOOP;

  UPDATE deliveries SET
    status = 'completed', completed_at = now(), signed_by = p_signed_by,
    issue_type = COALESCE(p_issue_type, issue_type),
    issue_notes = CASE WHEN p_issue_notes IS NOT NULL THEN p_issue_notes ELSE issue_notes END
  WHERE id = p_delivery_id;

  FOR v_item IN
    SELECT di.*, p.product_name
    FROM delivery_items di JOIN products p ON p.id = di.product_id
    WHERE di.delivery_id = p_delivery_id
  LOOP
    IF p_quantities IS NOT NULL AND p_quantities ? v_item.id::text THEN
      v_qty_to_deliver := GREATEST(0, LEAST((p_quantities->>v_item.id::text)::numeric, v_item.quantity));
    ELSE
      v_qty_to_deliver := v_item.quantity;
    END IF;

    UPDATE delivery_items SET quantity_delivered = v_qty_to_deliver WHERE id = v_item.id;
    IF v_qty_to_deliver = 0 THEN CONTINUE; END IF;

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
          ELSE '' END || '. Signed by: ' || p_signed_by
    );

    SELECT * INTO v_inv FROM inventory
    WHERE product_id = v_item.product_id AND location = 'Main Warehouse';

    v_deduct_from_prebooked := LEAST(v_qty_to_deliver, COALESCE(v_inv.quantity_prebooked, 0));
    v_deduct_from_available := v_qty_to_deliver - v_deduct_from_prebooked;

    UPDATE inventory SET
      quantity_available = quantity_available - v_deduct_from_available,
      quantity_prebooked = quantity_prebooked - v_deduct_from_prebooked,
      updated_at = now()
    WHERE product_id = v_item.product_id AND location = 'Main Warehouse';
  END LOOP;

  IF v_any_partial THEN
    FOR v_item IN
      SELECT di.*, p.product_name
      FROM delivery_items di JOIN products p ON p.id = di.product_id
      WHERE di.delivery_id = p_delivery_id AND di.quantity_delivered < di.quantity
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

  SELECT NOT EXISTS (
    SELECT 1 FROM order_items WHERE order_id = v_delivery.order_id AND quantity_remaining > 0
  ) INTO v_all_delivered;

  UPDATE orders SET
    status = CASE WHEN v_all_delivered THEN 'fulfilled' ELSE 'partially_fulfilled' END,
    updated_at = now()
  WHERE id = v_delivery.order_id;

  -- When order is fully delivered, mark all pending remainders as 'fulfilled'
  IF v_all_delivered AND v_delivery.order_id IS NOT NULL THEN
    UPDATE delivery_remainders SET
      status = 'fulfilled',
      updated_at = now()
    WHERE order_id = v_delivery.order_id
      AND status = 'pending';
  END IF;

  IF v_any_partial AND v_delivery.order_id IS NOT NULL THEN
    FOR v_linked_invoice IN
      SELECT * FROM invoices
      WHERE order_id = v_delivery.order_id AND deleted_at IS NULL AND status IN ('draft', 'posted')
    LOOP
      IF v_linked_invoice.status = 'draft' THEN
        v_old_total := v_linked_invoice.total_amount_cents;
        UPDATE invoice_items ii SET
          quantity = oi.quantity_delivered,
          extended_cents = ii.unit_price_cents * oi.quantity_delivered::bigint
        FROM order_items oi
        WHERE ii.invoice_id = v_linked_invoice.id
          AND ii.order_item_id = oi.id
          AND oi.quantity_delivered < oi.total_units_needed;

        SELECT COALESCE(SUM(extended_cents), 0) INTO v_new_total
        FROM invoice_items WHERE invoice_id = v_linked_invoice.id;

        UPDATE invoices SET
          total_amount_cents = v_new_total,
          total_cost_cents = (SELECT COALESCE(SUM(cost_cents * quantity), 0) FROM invoice_items WHERE invoice_id = v_linked_invoice.id),
          updated_at = now()
        WHERE id = v_linked_invoice.id;
      ELSE
        FOR v_admin IN SELECT id FROM profiles WHERE role = 'admin' AND is_active = true
        LOOP
          INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
          VALUES (v_admin.id, 'Partial Delivery — Posted Invoice Needs Review',
            'Delivery ' || v_delivery.delivery_number || ' completed with partial quantities. Invoice ' ||
              v_linked_invoice.invoice_number || ' may need adjustment.',
            'delivery_partial', 'invoice', v_linked_invoice.id);
        END LOOP;
      END IF;
    END LOOP;
  END IF;

  -- BUG 3 FIX: Auto-create draft invoice ONLY if order does not already have one
  -- Quick deliveries create a draft invoice upfront, so skip auto-invoice to avoid duplicates.
  IF v_delivery.order_id IS NOT NULL THEN
    -- Skip auto-invoice if order already has a draft/posted/overdue/paid invoice
    IF NOT EXISTS (
      SELECT 1 FROM invoices
      WHERE order_id = v_delivery.order_id
        AND deleted_at IS NULL
        AND status IN ('draft', 'posted', 'overdue', 'paid')
    ) THEN
      BEGIN
        v_auto_invoice := create_invoice_from_delivery(p_delivery_id, p_performed_by);
      EXCEPTION WHEN OTHERS THEN
        -- Non-blocking: log failure but don't fail the delivery completion
        INSERT INTO activity_feed (
          event_type, description, performed_by,
          related_entity_type, related_entity_id, customer_id
        ) VALUES (
          'invoice_auto_create_failed',
          'Auto-invoice creation failed for delivery ' || v_delivery.delivery_number || ': ' || SQLERRM,
          p_performed_by, 'delivery', p_delivery_id, v_delivery.customer_id
        );
        v_auto_invoice := NULL;
      END;
    ELSE
      -- Order already has an invoice — skip auto-creation
      v_auto_invoice := NULL;
    END IF;
  END IF;

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'delivery_completed',
    'Delivery ' || v_delivery.delivery_number || ' completed.' ||
      CASE WHEN v_any_partial THEN ' Partial delivery — some items have remainders.' ELSE '' END ||
      ' Signed by: ' || p_signed_by ||
      CASE WHEN v_auto_invoice IS NOT NULL
        THEN ' Draft invoice ' || (v_auto_invoice->>'invoice_number') || ' auto-created.'
        ELSE '' END,
    p_performed_by, 'delivery', p_delivery_id, v_delivery.customer_id
  );

  RETURN jsonb_build_object(
    'status', 'completed', 'delivery_id', p_delivery_id,
    'partial', v_any_partial, 'order_fully_delivered', v_all_delivered,
    'auto_invoice', COALESCE(v_auto_invoice, 'null'::jsonb)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION complete_delivery(uuid, text, uuid, jsonb, text, text, text) TO authenticated;


-- ============================================================================
-- BUG 4: Fix receive_return — add FOR UPDATE lock on inventory row
--   - Before updating inventory quantity, lock the row to prevent concurrent
--     modifications from other returns or transactions
-- ============================================================================

CREATE OR REPLACE FUNCTION receive_return(
  p_return_id uuid,
  p_received_by uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_item RECORD;
  v_return_number text;
  v_inv record;  -- BUG 4: variable to hold locked inventory row
BEGIN
  -- Get return info (must be in approved status)
  SELECT return_number INTO v_return_number
  FROM returns WHERE id = p_return_id AND status = 'approved';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Return not found or not in approved status';
  END IF;

  -- Process each item that should be restocked
  -- Use LATERAL to pick exactly one inventory row per item
  -- (prevents duplicate processing when product exists in multiple warehouses)
  FOR v_item IN
    SELECT ri.id AS item_id, ri.product_id, ri.quantity, ri.product_name, ri.condition,
           inv.id AS inv_id, inv.location AS inv_location
    FROM return_items ri
    LEFT JOIN LATERAL (
      SELECT id, location FROM inventory WHERE product_id = ri.product_id LIMIT 1
    ) inv ON true
    WHERE ri.return_id = p_return_id
      AND ri.restock = true
      AND ri.restocked = false
    ORDER BY ri.sort_order
  LOOP
    -- Only update inventory AND mark restocked when row exists
    IF v_item.inv_id IS NOT NULL THEN
      -- BUG 4 FIX: Lock the inventory row before updating to prevent concurrent
      -- modifications from racing with other return processing or deliveries
      SELECT * INTO v_inv FROM inventory
      WHERE id = v_item.inv_id
      FOR UPDATE;

      UPDATE inventory
      SET quantity_available = quantity_available + v_item.quantity,
          updated_at = now()
      WHERE id = v_item.inv_id;

      -- Audit trail
      INSERT INTO inventory_transactions (
        product_id, transaction_type, quantity,
        to_location, performed_by, notes
      ) VALUES (
        v_item.product_id, 'returned', v_item.quantity,
        v_item.inv_location, p_received_by,
        'Return ' || v_return_number || ': ' || v_item.product_name ||
        ' (' || v_item.condition || ')'
      );

      -- Only mark restocked when inventory was actually updated
      UPDATE return_items SET restocked = true WHERE id = v_item.item_id;
    ELSE
      -- No inventory row — log warning, do NOT mark as restocked
      RAISE WARNING 'No inventory row found for product % in return %. Item NOT restocked.',
        v_item.product_id, v_return_number;
    END IF;
  END LOOP;

  -- Update return status
  UPDATE returns
  SET status = 'received',
      received_by = p_received_by,
      received_at = now(),
      updated_at = now()
  WHERE id = p_return_id;
END;
$$;

GRANT EXECUTE ON FUNCTION receive_return(uuid, uuid) TO authenticated;


-- ============================================================================
-- BUG 5: Fix complete_cycle_count — add FOR UPDATE lock on inventory rows
--   - Before modifying each inventory row during cycle count adjustment,
--     lock it to prevent concurrent modifications
-- ============================================================================

CREATE OR REPLACE FUNCTION complete_cycle_count(
  p_cycle_count_id uuid,
  p_completed_by uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_item RECORD;
  v_count record;
  v_new_qty numeric;
  v_locked_inv record;  -- BUG 5: variable for locked inventory row
BEGIN
  -- Lock the cycle count row FOR UPDATE
  SELECT * INTO v_count
    FROM cycle_counts
   WHERE id = p_cycle_count_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Cycle count not found';
  END IF;

  -- Only in_progress counts can be completed
  IF v_count.status != 'in_progress' THEN
    RAISE EXCEPTION 'Cycle count is not in progress (current status: %)', v_count.status;
  END IF;

  -- Process each counted item that has a variance
  FOR v_item IN
    SELECT cci.*, i.quantity_available, i.location
    FROM cycle_count_items cci
    LEFT JOIN inventory i ON i.id = cci.inventory_id
    WHERE cci.cycle_count_id = p_cycle_count_id
      AND cci.is_counted = true
      AND cci.variance IS NOT NULL
      AND cci.variance <> 0
  LOOP
    IF v_item.inventory_id IS NOT NULL THEN
      -- BUG 5 FIX: Lock the inventory row before modifying to prevent concurrent
      -- updates from deliveries, returns, or other cycle counts
      SELECT * INTO v_locked_inv FROM inventory
      WHERE id = v_item.inventory_id
      FOR UPDATE;

      -- Negative quantity guard — cap at zero (use locked row's current value)
      v_new_qty := GREATEST(0, v_locked_inv.quantity_available + v_item.variance);

      IF v_locked_inv.quantity_available + v_item.variance < 0 THEN
        RAISE WARNING 'Cycle count adjustment would make inventory negative for product %. Capping at 0 (expected: %, counted: %)',
          v_item.product_id, v_item.expected_qty, v_item.counted_qty;
      END IF;

      UPDATE inventory
      SET quantity_available = v_new_qty,
          last_counted_at = now(),
          updated_at = now()
      WHERE id = v_item.inventory_id;

      -- Audit trail transaction
      INSERT INTO inventory_transactions (
        product_id, transaction_type, quantity,
        to_location, performed_by, notes
      ) VALUES (
        v_item.product_id, 'adjusted', v_item.variance,
        v_locked_inv.location, p_completed_by,
        'Cycle count ' || v_count.count_number || ': adjusted from ' ||
        v_item.expected_qty || ' to ' || v_item.counted_qty
      );
    END IF;
  END LOOP;

  -- Update last_counted_at for zero-variance items
  -- BUG 5 FIX: Lock these rows too before updating
  UPDATE inventory
  SET last_counted_at = now(), updated_at = now()
  WHERE id IN (
    SELECT cci.inventory_id FROM cycle_count_items cci
    WHERE cci.cycle_count_id = p_cycle_count_id
      AND cci.is_counted = true
      AND cci.inventory_id IS NOT NULL
  );

  -- Mark cycle count as completed
  UPDATE cycle_counts
  SET status = 'completed',
      completed_by = p_completed_by,
      completed_at = now()
  WHERE id = p_cycle_count_id;
END;
$$;

GRANT EXECUTE ON FUNCTION complete_cycle_count(uuid, uuid) TO authenticated;
