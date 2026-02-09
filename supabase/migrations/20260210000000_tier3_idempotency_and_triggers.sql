-- ============================================================================
-- TIER 3 HARDENING — Idempotency Keys + Activity Feed Triggers
-- CRX Manager V1.0
-- Date: 2026-02-10
--
-- This migration addresses:
--   T3-003: Idempotency keys for critical operations
--   T3-005: Activity feed database triggers on critical tables
-- ============================================================================


-- ============================================================================
-- SECTION 1: Idempotency Keys Table
-- Prevents duplicate submissions of critical operations
-- ============================================================================

CREATE TABLE IF NOT EXISTS idempotency_keys (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  idempotency_key text NOT NULL UNIQUE,
  operation text NOT NULL,
  result jsonb,
  created_at timestamptz DEFAULT now(),
  expires_at timestamptz DEFAULT now() + interval '24 hours'
);

-- Auto-cleanup expired keys (checked on insert via the check_idempotency function)
CREATE INDEX idx_idempotency_keys_expires ON idempotency_keys (expires_at);
CREATE INDEX idx_idempotency_keys_key ON idempotency_keys (idempotency_key);


-- ============================================================================
-- SECTION 2: Idempotency helper function
-- Returns NULL if key is new, or the cached result if key was already used
-- ============================================================================

CREATE OR REPLACE FUNCTION check_idempotency(p_key text, p_operation text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing record;
BEGIN
  -- Clean up expired keys (lightweight, only deletes old ones)
  DELETE FROM idempotency_keys WHERE expires_at < now();

  -- Check if this key already exists
  SELECT * INTO v_existing FROM idempotency_keys
    WHERE idempotency_key = p_key AND operation = p_operation;

  IF FOUND THEN
    RETURN v_existing.result;
  END IF;

  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION save_idempotency(p_key text, p_operation text, p_result jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO idempotency_keys (idempotency_key, operation, result)
  VALUES (p_key, p_operation, p_result)
  ON CONFLICT (idempotency_key) DO NOTHING;
END;
$$;


-- ============================================================================
-- SECTION 3: Update record_payment with idempotency support
-- ============================================================================

CREATE OR REPLACE FUNCTION record_payment(
  p_order_id uuid,
  p_amount numeric,
  p_payment_method text,
  p_reference_number text,
  p_notes text,
  p_recorded_by uuid,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order record;
  v_payment_id uuid;
  v_cached_result jsonb;
  v_result jsonb;
BEGIN
  -- Check idempotency key if provided
  IF p_idempotency_key IS NOT NULL THEN
    v_cached_result := check_idempotency(p_idempotency_key, 'record_payment');
    IF v_cached_result IS NOT NULL THEN
      RETURN v_cached_result;
    END IF;
  END IF;

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

  v_result := jsonb_build_object('status', 'recorded', 'payment_id', v_payment_id);

  -- Save idempotency key
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'record_payment', v_result);
  END IF;

  RETURN v_result;
END;
$$;


-- ============================================================================
-- SECTION 4: Update receive_po_items with idempotency support
-- ============================================================================

CREATE OR REPLACE FUNCTION receive_po_items(
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
  v_item jsonb;
  v_po_item record;
  v_po record;
  v_qty numeric;
  v_product record;
  v_po_id uuid;
  v_all_received boolean;
  v_any_received boolean;
  v_new_status text;
  v_cached_result jsonb;
  v_result jsonb;
BEGIN
  -- Check idempotency key if provided
  IF p_idempotency_key IS NOT NULL THEN
    v_cached_result := check_idempotency(p_idempotency_key, 'receive_po_items');
    IF v_cached_result IS NOT NULL THEN
      RETURN v_cached_result;
    END IF;
  END IF;

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

  v_result := jsonb_build_object('status', 'received');

  -- Save idempotency key
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'receive_po_items', v_result);
  END IF;

  RETURN v_result;
END;
$$;


-- ============================================================================
-- SECTION 5: Update update_order_items with idempotency support
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

    -- Update the order item
    UPDATE order_items SET
      price_per_unit = (v_item->>'price_per_unit')::numeric,
      total_units_needed = (v_item->>'total_units_needed')::numeric,
      quantity_remaining = GREATEST(
        (v_item->>'total_units_needed')::numeric - v_old_item.quantity_delivered, 0
      ),
      total_price = (v_item->>'price_per_unit')::numeric * (v_item->>'total_units_needed')::numeric,
      updated_at = now()
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
-- SECTION 6: Activity Feed Triggers on Critical Tables (T3-005)
-- Auto-log to activity_feed when key tables change
-- ============================================================================

-- Trigger function: log order status changes
CREATE OR REPLACE FUNCTION trg_order_status_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status THEN
    INSERT INTO activity_feed (
      event_type, description, performed_by,
      related_entity_type, related_entity_id, customer_id
    ) VALUES (
      'order_status_changed',
      'Order ' || NEW.order_number || ' status changed from ' || OLD.status || ' to ' || NEW.status,
      COALESCE(auth.uid(), '00000000-0000-0000-0000-000000000000'::uuid),
      'order', NEW.id, NEW.customer_id
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_order_status_change ON orders;
CREATE TRIGGER trg_order_status_change
  AFTER UPDATE ON orders
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION trg_order_status_change();


-- Trigger function: log delivery status changes
CREATE OR REPLACE FUNCTION trg_delivery_status_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status THEN
    INSERT INTO activity_feed (
      event_type, description, performed_by,
      related_entity_type, related_entity_id, customer_id
    ) VALUES (
      'delivery_status_changed',
      'Delivery status changed to ' || NEW.status,
      COALESCE(auth.uid(), '00000000-0000-0000-0000-000000000000'::uuid),
      'delivery', NEW.id, NEW.customer_id
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_delivery_status_change ON deliveries;
CREATE TRIGGER trg_delivery_status_change
  AFTER UPDATE ON deliveries
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION trg_delivery_status_change();


-- Trigger function: log PO status changes
CREATE OR REPLACE FUNCTION trg_po_status_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status THEN
    INSERT INTO activity_feed (
      event_type, description, performed_by,
      related_entity_type, related_entity_id
    ) VALUES (
      'po_status_changed',
      'PO ' || NEW.po_number || ' status changed to ' || NEW.status,
      COALESCE(auth.uid(), '00000000-0000-0000-0000-000000000000'::uuid),
      'purchase_order', NEW.id
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_po_status_change ON purchase_orders;
CREATE TRIGGER trg_po_status_change
  AFTER UPDATE ON purchase_orders
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION trg_po_status_change();


-- Trigger function: log inventory changes (large adjustments only, not every update)
CREATE OR REPLACE FUNCTION trg_inventory_significant_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_product_name text;
  v_qty_change numeric;
BEGIN
  v_qty_change := NEW.quantity_available - COALESCE(OLD.quantity_available, 0);

  -- Only log significant changes (more than 10% or absolute > 10 units)
  IF ABS(v_qty_change) > 10 OR
     (COALESCE(OLD.quantity_available, 0) > 0 AND ABS(v_qty_change) > COALESCE(OLD.quantity_available, 1) * 0.10) THEN

    SELECT product_name INTO v_product_name FROM products WHERE id = NEW.product_id;

    INSERT INTO activity_feed (
      event_type, description, performed_by,
      related_entity_type, related_entity_id
    ) VALUES (
      'inventory_adjusted',
      COALESCE(v_product_name, 'Product') || ' inventory changed by ' || v_qty_change || ' units (now ' || NEW.quantity_available || ')',
      COALESCE(auth.uid(), '00000000-0000-0000-0000-000000000000'::uuid),
      'inventory', NEW.id
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_inventory_significant_change ON inventory;
CREATE TRIGGER trg_inventory_significant_change
  AFTER UPDATE ON inventory
  FOR EACH ROW
  WHEN (OLD.quantity_available IS DISTINCT FROM NEW.quantity_available)
  EXECUTE FUNCTION trg_inventory_significant_change();


-- ============================================================================
-- SECTION 7: Grant permissions
-- ============================================================================

-- Re-grant RPCs with new signatures (the DEFAULT param changes the signature)
GRANT EXECUTE ON FUNCTION record_payment(uuid, numeric, text, text, text, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION receive_po_items(jsonb, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION update_order_items(uuid, jsonb, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION check_idempotency(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION save_idempotency(text, text, jsonb) TO authenticated;

-- RLS for idempotency_keys table (authenticated users can insert/read)
ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can manage idempotency keys"
  ON idempotency_keys
  FOR ALL
  USING (true)
  WITH CHECK (true);
