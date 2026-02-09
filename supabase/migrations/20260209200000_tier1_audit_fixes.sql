-- ============================================================================
-- TIER 1 AUDIT FIXES — Launch Blockers
-- CRX Manager V1.0 Scorched Earth Forensic Audit Remediation
-- Date: 2026-02-09
--
-- This migration addresses:
--   T1-001: 6 atomic RPC functions (KILL-TX-001 through KILL-TX-006)
--   T1-002: CHECK constraints on numeric columns (KILL-DC-001 through KILL-DC-003)
--   T1-003: Order total verification trigger (KILL-FP-002)
--   T1-004: is_active enforcement in RLS helpers (KILL-AUTH-001)
-- ============================================================================

-- ============================================================================
-- SECTION 1: CHECK CONSTRAINTS (T1-002)
-- Prevent negative quantities, prices, and invalid percentages at the DB level
-- ============================================================================

-- Inventory quantities must never go negative
ALTER TABLE inventory ADD CONSTRAINT chk_inventory_qty_available CHECK (quantity_available >= 0);
ALTER TABLE inventory ADD CONSTRAINT chk_inventory_qty_prebooked CHECK (quantity_prebooked >= 0);
ALTER TABLE inventory ADD CONSTRAINT chk_inventory_qty_on_order CHECK (quantity_on_order >= 0);

-- Order item quantities must never go negative
ALTER TABLE order_items ADD CONSTRAINT chk_oi_qty_delivered CHECK (quantity_delivered >= 0);
ALTER TABLE order_items ADD CONSTRAINT chk_oi_qty_remaining CHECK (quantity_remaining >= 0);

-- Payment amount must be positive
ALTER TABLE payments ADD CONSTRAINT chk_payment_amount CHECK (amount > 0);

-- Delivery item quantities must be positive
ALTER TABLE delivery_items ADD CONSTRAINT chk_di_quantity CHECK (quantity > 0);

-- PO item quantities must be non-negative
ALTER TABLE purchase_order_items ADD CONSTRAINT chk_poi_qty_ordered CHECK (quantity_ordered >= 0);
ALTER TABLE purchase_order_items ADD CONSTRAINT chk_poi_qty_received CHECK (quantity_received >= 0);

-- Product cost/prices must be non-negative
ALTER TABLE products ADD CONSTRAINT chk_product_cost CHECK (current_cost >= 0);
ALTER TABLE products ADD CONSTRAINT chk_product_tier1 CHECK (tier1_price >= 0);
ALTER TABLE products ADD CONSTRAINT chk_product_tier2 CHECK (tier2_price >= 0);
ALTER TABLE products ADD CONSTRAINT chk_product_tier3 CHECK (tier3_price >= 0);

-- Commission split must be 0-100
ALTER TABLE commissions ADD CONSTRAINT chk_commission_pct CHECK (split_percentage >= 0 AND split_percentage <= 100);
ALTER TABLE commissions ADD CONSTRAINT chk_commission_amount CHECK (commission_amount >= 0);


-- ============================================================================
-- SECTION 2: UPDATE RLS HELPER FUNCTIONS FOR is_active (T1-004)
-- Deactivated users must be denied access at the database level
-- ============================================================================

CREATE OR REPLACE FUNCTION is_admin()
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM profiles
    WHERE id = (SELECT auth.uid())
      AND role = 'admin'
      AND is_active = true
  );
END;
$$;

CREATE OR REPLACE FUNCTION is_sales_rep()
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM profiles
    WHERE id = (SELECT auth.uid())
      AND role = 'sales_rep'
      AND is_active = true
  );
END;
$$;

CREATE OR REPLACE FUNCTION is_driver()
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM profiles
    WHERE id = (SELECT auth.uid())
      AND role = 'driver'
      AND is_active = true
  );
END;
$$;


-- ============================================================================
-- SECTION 3: POSTGRES SEQUENCES FOR DOCUMENT NUMBERS (KILL-RC-001, KILL-RC-002)
-- Replace count-based numbering with sequences to prevent race conditions
-- ============================================================================

-- Initialize sequences from current max values
DO $$
DECLARE
  max_quote int;
  max_order int;
BEGIN
  SELECT COALESCE(MAX(
    CASE WHEN quote_number ~ '^Q-\d{4}-\d+$'
    THEN CAST(split_part(quote_number, '-', 3) AS int)
    ELSE 0 END
  ), 0) INTO max_quote FROM quotes;

  SELECT COALESCE(MAX(
    CASE WHEN order_number ~ '^ORD-\d{4}-\d+$'
    THEN CAST(split_part(order_number, '-', 3) AS int)
    ELSE 0 END
  ), 0) INTO max_order FROM orders;

  EXECUTE format('CREATE SEQUENCE IF NOT EXISTS quote_number_seq START %s', max_quote + 1);
  EXECUTE format('CREATE SEQUENCE IF NOT EXISTS order_number_seq START %s', max_order + 1);
END;
$$;

CREATE OR REPLACE FUNCTION generate_quote_number()
RETURNS text
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN 'Q-' || extract(year FROM current_date)::text || '-' || lpad(nextval('quote_number_seq')::text, 4, '0');
END;
$$;

CREATE OR REPLACE FUNCTION generate_order_number()
RETURNS text
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN 'ORD-' || extract(year FROM current_date)::text || '-' || lpad(nextval('order_number_seq')::text, 4, '0');
END;
$$;


-- ============================================================================
-- SECTION 4: PAYMENT TRIGGER (T1-003 / KILL-TX-004)
-- Auto-update order balance when a payment is inserted
-- Eliminates stale-read race condition in Payments.tsx
-- ============================================================================

CREATE OR REPLACE FUNCTION trg_payment_update_order()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE orders SET
    total_paid = COALESCE(total_paid, 0) + NEW.amount,
    balance_due = COALESCE(total_price, 0) - (COALESCE(total_paid, 0) + NEW.amount),
    updated_at = now()
  WHERE id = NEW.order_id;
  RETURN NEW;
END;
$$;

CREATE TRIGGER after_payment_insert
  AFTER INSERT ON payments
  FOR EACH ROW EXECUTE FUNCTION trg_payment_update_order();


-- ============================================================================
-- SECTION 5: ORDER TOTAL RECALCULATION TRIGGER (T1-003 / KILL-FP-002)
-- Recompute order totals from actual line items after any change
-- ============================================================================

CREATE OR REPLACE FUNCTION trg_recalc_order_totals()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order_id uuid;
  v_total_price numeric;
  v_total_cost numeric;
  v_total_profit numeric;
  v_margin_pct numeric;
BEGIN
  -- Determine which order was affected
  IF TG_OP = 'DELETE' THEN
    v_order_id := OLD.order_id;
  ELSE
    v_order_id := NEW.order_id;
  END IF;

  -- Recalculate from actual line items using exact numeric math
  SELECT
    COALESCE(SUM(total_price), 0),
    COALESCE(SUM(COALESCE(cost_per_unit, 0) * total_units_needed), 0)
  INTO v_total_price, v_total_cost
  FROM order_items
  WHERE order_id = v_order_id;

  v_total_profit := v_total_price - v_total_cost;
  v_margin_pct := CASE WHEN v_total_price > 0
    THEN ROUND((v_total_profit / v_total_price) * 100, 2)
    ELSE 0
  END;

  UPDATE orders SET
    total_price = ROUND(v_total_price, 2),
    total_cost = ROUND(v_total_cost, 2),
    total_profit = ROUND(v_total_profit, 2),
    total_margin_pct = v_margin_pct,
    balance_due = ROUND(v_total_price, 2) - COALESCE(total_paid, 0),
    updated_at = now()
  WHERE id = v_order_id;

  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;

CREATE TRIGGER after_order_items_change
  AFTER INSERT OR UPDATE OR DELETE ON order_items
  FOR EACH ROW EXECUTE FUNCTION trg_recalc_order_totals();


-- ============================================================================
-- SECTION 6: RPC — complete_delivery (KILL-TX-001, KILL-AUTH-004)
-- Atomic delivery completion: status + order_items + inventory + audit trail
-- SECURITY DEFINER allows drivers to execute multi-table writes
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
  v_all_delivered boolean;
BEGIN
  -- Validate delivery exists and is not already completed
  SELECT * INTO v_delivery FROM deliveries WHERE id = p_delivery_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Delivery not found';
  END IF;
  IF v_delivery.status = 'completed' THEN
    -- Idempotent: return success if already completed
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

    -- Reduce inventory atomically (no read-then-write)
    UPDATE inventory SET
      quantity_available = GREATEST(quantity_available - v_item.quantity, 0),
      quantity_prebooked = GREATEST(quantity_prebooked - v_item.quantity, 0),
      updated_at = now()
    WHERE product_id = v_item.product_id AND location = 'Main Warehouse';

    -- If no inventory row exists, create one (edge case)
    IF NOT FOUND THEN
      INSERT INTO inventory (product_id, location, quantity_available, quantity_prebooked, quantity_on_order)
      VALUES (v_item.product_id, 'Main Warehouse', 0, 0, 0);
    END IF;
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

  -- Log activity inside the transaction (no silent failure)
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


-- ============================================================================
-- SECTION 7: RPC — cancel_order (KILL-TX-003)
-- Atomic order cancellation with inventory release
-- ============================================================================

CREATE OR REPLACE FUNCTION cancel_order(
  p_order_id uuid,
  p_performed_by uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order record;
  v_item record;
  v_undelivered numeric;
BEGIN
  SELECT * INTO v_order FROM orders WHERE id = p_order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found';
  END IF;
  IF v_order.status = 'cancelled' THEN
    RETURN jsonb_build_object('status', 'already_cancelled');
  END IF;

  -- Verify caller is admin
  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = p_performed_by AND role = 'admin' AND is_active = true
  ) THEN
    RAISE EXCEPTION 'Only admins can cancel orders';
  END IF;

  -- Update order status
  UPDATE orders SET status = 'cancelled', updated_at = now() WHERE id = p_order_id;

  -- Release prebooked inventory for undelivered items
  FOR v_item IN
    SELECT product_id, total_units_needed, quantity_delivered
    FROM order_items WHERE order_id = p_order_id
  LOOP
    v_undelivered := GREATEST(v_item.total_units_needed - COALESCE(v_item.quantity_delivered, 0), 0);
    IF v_undelivered <= 0 THEN CONTINUE; END IF;

    -- Atomic decrement — no read-then-write
    UPDATE inventory SET
      quantity_prebooked = GREATEST(quantity_prebooked - v_undelivered, 0),
      updated_at = now()
    WHERE product_id = v_item.product_id AND location = 'Main Warehouse';

    -- Audit trail
    INSERT INTO inventory_transactions (
      product_id, transaction_type, quantity, to_location,
      order_id, performed_by, notes
    ) VALUES (
      v_item.product_id, 'adjusted', -v_undelivered, 'Main Warehouse',
      p_order_id, p_performed_by,
      'Released ' || v_undelivered || ' units — order ' || v_order.order_number || ' cancelled'
    );
  END LOOP;

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'order_cancelled',
    'Order ' || v_order.order_number || ' cancelled',
    p_performed_by, 'order', p_order_id, v_order.customer_id
  );

  RETURN jsonb_build_object('status', 'cancelled');
END;
$$;


-- ============================================================================
-- SECTION 8: RPC — update_order_items (KILL-TX-002)
-- Atomic order editing with inventory prebooked adjustments
-- ============================================================================

CREATE OR REPLACE FUNCTION update_order_items(
  p_order_id uuid,
  p_items jsonb,
  p_performed_by uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order record;
  v_item jsonb;
  v_original record;
  v_qty_delta numeric;
BEGIN
  SELECT * INTO v_order FROM orders WHERE id = p_order_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = p_performed_by AND role = 'admin' AND is_active = true
  ) THEN
    RAISE EXCEPTION 'Only admins can edit orders';
  END IF;

  -- Process each item update
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    -- Get original for delta calculation
    SELECT * INTO v_original FROM order_items WHERE id = (v_item->>'id')::uuid;
    IF NOT FOUND THEN CONTINUE; END IF;

    v_qty_delta := (v_item->>'total_units_needed')::numeric - v_original.total_units_needed;

    -- Update the order item
    UPDATE order_items SET
      price_per_unit = (v_item->>'price_per_unit')::numeric,
      total_units_needed = (v_item->>'total_units_needed')::numeric,
      total_price = (v_item->>'price_per_unit')::numeric * (v_item->>'total_units_needed')::numeric,
      quantity_remaining = (v_item->>'total_units_needed')::numeric - quantity_delivered
    WHERE id = (v_item->>'id')::uuid;

    -- Adjust prebooked inventory if quantity changed
    IF v_qty_delta <> 0 AND v_original.product_id IS NOT NULL THEN
      UPDATE inventory SET
        quantity_prebooked = GREATEST(quantity_prebooked + v_qty_delta, 0),
        updated_at = now()
      WHERE product_id = v_original.product_id AND location = 'Main Warehouse';

      INSERT INTO inventory_transactions (
        product_id, transaction_type, quantity, to_location,
        order_id, performed_by, notes
      ) VALUES (
        v_original.product_id, 'adjusted', v_qty_delta, 'Main Warehouse',
        p_order_id, p_performed_by,
        'Order ' || v_order.order_number || ' edited: qty changed by ' || v_qty_delta
      );
    END IF;
  END LOOP;

  -- Order totals are auto-recalculated by trg_recalc_order_totals trigger

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'order_updated',
    'Order ' || v_order.order_number || ' items edited',
    p_performed_by, 'order', p_order_id, v_order.customer_id
  );

  RETURN jsonb_build_object('status', 'updated');
END;
$$;


-- ============================================================================
-- SECTION 9: RPC — record_payment (KILL-TX-004)
-- Atomic payment recording — balance computed from DB, not stale frontend state
-- Note: The after_payment_insert trigger handles updating order.total_paid/balance_due
-- ============================================================================

CREATE OR REPLACE FUNCTION record_payment(
  p_order_id uuid,
  p_amount numeric,
  p_payment_method text,
  p_reference_number text,
  p_notes text,
  p_recorded_by uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order record;
  v_payment_id uuid;
BEGIN
  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'Payment amount must be positive';
  END IF;

  SELECT * INTO v_order FROM orders WHERE id = p_order_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found'; END IF;

  -- Verify caller is admin or sales_rep
  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = p_recorded_by AND is_active = true
      AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'Not authorized to record payments';
  END IF;

  -- Insert payment — the after_payment_insert trigger auto-updates order totals
  INSERT INTO payments (
    order_id, customer_id, amount, payment_method,
    payment_date, reference_number, notes, recorded_by
  ) VALUES (
    p_order_id, v_order.customer_id, p_amount, p_payment_method,
    current_date, p_reference_number, p_notes, p_recorded_by
  ) RETURNING id INTO v_payment_id;

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'payment_received',
    'Payment of $' || ROUND(p_amount, 2) || ' recorded on ' || v_order.order_number,
    p_recorded_by, 'order', p_order_id, v_order.customer_id
  );

  RETURN jsonb_build_object('status', 'recorded', 'payment_id', v_payment_id);
END;
$$;


-- ============================================================================
-- SECTION 10: RPC — convert_quote_to_order (KILL-TX-005)
-- Atomic quote-to-order conversion with inventory prebooking
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

  -- Pre-book inventory for each item (atomic, no read-then-write)
  FOR v_item IN
    SELECT oi.product_id, oi.total_units_needed, oi.unit_size
    FROM order_items oi
    WHERE oi.order_id = v_order_id AND oi.product_id IS NOT NULL AND oi.total_units_needed > 0
  LOOP
    -- Try update first
    UPDATE inventory SET
      quantity_prebooked = quantity_prebooked + v_item.total_units_needed,
      updated_at = now()
    WHERE product_id = v_item.product_id AND location = 'Main Warehouse';

    -- If no row exists, insert one
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
-- SECTION 11: RPC — receive_po_items (KILL-TX-006)
-- Atomic PO receiving: updates PO items, inventory, cost, and PO status
-- Replaces duplicated logic in InventoryPage.tsx and PurchaseOrderDetail.tsx
-- ============================================================================

CREATE OR REPLACE FUNCTION receive_po_items(
  p_items jsonb,
  p_performed_by uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_item jsonb;
  v_po_item record;
  v_po record;
  v_qty numeric;
  v_product record;
  v_po_id uuid;
  v_all_received boolean;
  v_any_received boolean;
  v_new_status text;
BEGIN
  -- Verify caller is admin
  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = p_performed_by AND role = 'admin' AND is_active = true
  ) THEN
    RAISE EXCEPTION 'Only admins can receive PO items';
  END IF;

  -- Process each item
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_qty := (v_item->>'quantity')::numeric;
    IF v_qty <= 0 THEN CONTINUE; END IF;

    SELECT * INTO v_po_item FROM purchase_order_items WHERE id = (v_item->>'po_item_id')::uuid;
    IF NOT FOUND THEN CONTINUE; END IF;

    -- Validate not receiving more than ordered
    IF v_po_item.quantity_received + v_qty > v_po_item.quantity_ordered THEN
      RAISE EXCEPTION 'Cannot receive more than ordered for item %', v_po_item.id;
    END IF;

    v_po_id := v_po_item.purchase_order_id;

    -- Update PO item received count
    UPDATE purchase_order_items SET
      quantity_received = quantity_received + v_qty
    WHERE id = v_po_item.id;

    -- Update inventory (atomic increment, no read-then-write)
    UPDATE inventory SET
      quantity_available = quantity_available + v_qty,
      quantity_on_order = GREATEST(quantity_on_order - v_qty, 0),
      updated_at = now()
    WHERE product_id = v_po_item.product_id AND location = 'Main Warehouse';

    IF NOT FOUND THEN
      INSERT INTO inventory (product_id, location, quantity_available, quantity_on_order, quantity_prebooked, unit_size)
      VALUES (v_po_item.product_id, 'Main Warehouse', v_qty, 0, 0, v_po_item.unit_size);
    END IF;

    -- Create audit trail
    INSERT INTO inventory_transactions (
      product_id, transaction_type, quantity, to_location,
      purchase_order_id, performed_by, notes
    ) VALUES (
      v_po_item.product_id, 'received', v_qty, 'Main Warehouse',
      v_po_id, p_performed_by,
      'Received ' || v_qty || ' units via PO'
    );

    -- Update product cost if PO has a different cost
    IF v_po_item.unit_cost IS NOT NULL AND v_po_item.unit_cost > 0 THEN
      SELECT * INTO v_product FROM products WHERE id = v_po_item.product_id;
      IF v_product.current_cost IS DISTINCT FROM v_po_item.unit_cost THEN
        INSERT INTO cost_history (product_id, changed_by, old_cost, new_cost, change_note)
        VALUES (v_po_item.product_id, p_performed_by, v_product.current_cost, v_po_item.unit_cost,
                'Auto-updated from PO receiving');

        UPDATE products SET
          current_cost = v_po_item.unit_cost,
          cost_updated_date = now()::text
        WHERE id = v_po_item.product_id;
      END IF;
    END IF;
  END LOOP;

  -- Auto-update PO status
  IF v_po_id IS NOT NULL THEN
    SELECT * INTO v_po FROM purchase_orders WHERE id = v_po_id;

    SELECT
      bool_and(quantity_received >= quantity_ordered),
      bool_or(quantity_received > 0)
    INTO v_all_received, v_any_received
    FROM purchase_order_items WHERE purchase_order_id = v_po_id;

    v_new_status := CASE
      WHEN v_all_received THEN 'fully_received'
      WHEN v_any_received THEN 'partially_received'
      ELSE v_po.status
    END;

    IF v_new_status IS DISTINCT FROM v_po.status THEN
      UPDATE purchase_orders SET status = v_new_status, updated_at = now() WHERE id = v_po_id;
    END IF;

    INSERT INTO activity_feed (
      event_type, description, performed_by,
      related_entity_type, related_entity_id
    ) VALUES (
      'po_received',
      'Items received on PO ' || v_po.po_number || ' — inventory updated',
      p_performed_by, 'purchase_order', v_po_id
    );
  END IF;

  RETURN jsonb_build_object('status', 'received');
END;
$$;


-- ============================================================================
-- SECTION 12: GRANT EXECUTE on RPCs to authenticated users
-- Supabase requires explicit grants for RPC functions
-- ============================================================================

GRANT EXECUTE ON FUNCTION complete_delivery(uuid, text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION cancel_order(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION update_order_items(uuid, jsonb, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION record_payment(uuid, numeric, text, text, text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION convert_quote_to_order(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION receive_po_items(jsonb, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION generate_quote_number() TO authenticated;
GRANT EXECUTE ON FUNCTION generate_order_number() TO authenticated;
