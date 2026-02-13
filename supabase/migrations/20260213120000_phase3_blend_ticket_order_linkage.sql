-- Phase 3: Blend Ticket ↔ Order Linkage
-- Connects blend tickets to orders/invoices for billing workflows
-- Depends on: Phase 1 (fields), Phase 2 (billing architecture)

-- ============================================================
-- 1. Add new columns to blend_tickets
-- ============================================================

-- Field reference (which field was sprayed)
ALTER TABLE blend_tickets
  ADD COLUMN IF NOT EXISTS field_id uuid REFERENCES fields(id);

-- Salesman for commission tracking
ALTER TABLE blend_tickets
  ADD COLUMN IF NOT EXISTS salesman_id uuid REFERENCES profiles(id);

-- Split old implicit billing status into two explicit concepts:
-- order_link_status: whether ticket is linked to an order
-- payment_status: billing/payment state (independent of link)
ALTER TABLE blend_tickets
  ADD COLUMN IF NOT EXISTS order_link_status text NOT NULL DEFAULT 'unlinked'
    CHECK (order_link_status IN ('unlinked', 'linked'));

ALTER TABLE blend_tickets
  ADD COLUMN IF NOT EXISTS payment_status text NOT NULL DEFAULT 'unbilled'
    CHECK (payment_status IN ('unbilled', 'billed', 'prepaid', 'no_charge'));

-- Indexes on new columns
CREATE INDEX IF NOT EXISTS idx_blend_tickets_field_id ON blend_tickets(field_id);
CREATE INDEX IF NOT EXISTS idx_blend_tickets_salesman_id ON blend_tickets(salesman_id);
CREATE INDEX IF NOT EXISTS idx_blend_tickets_order_link_status ON blend_tickets(order_link_status);
CREATE INDEX IF NOT EXISTS idx_blend_tickets_payment_status ON blend_tickets(payment_status);


-- ============================================================
-- 2. Junction table: blend_ticket_to_order_items
-- ============================================================

CREATE TABLE IF NOT EXISTS blend_ticket_to_order_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  blend_ticket_id uuid NOT NULL REFERENCES blend_tickets(id) ON DELETE CASCADE,
  order_item_id   uuid NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
  order_id        uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  quantity_applied numeric(12,4),
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid NOT NULL REFERENCES auth.users(id) DEFAULT auth.uid(),

  UNIQUE(blend_ticket_id, order_item_id)
);

CREATE INDEX IF NOT EXISTS idx_bt_order_items_ticket ON blend_ticket_to_order_items(blend_ticket_id);
CREATE INDEX IF NOT EXISTS idx_bt_order_items_order ON blend_ticket_to_order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_bt_order_items_order_item ON blend_ticket_to_order_items(order_item_id);


-- ============================================================
-- 3. RLS policies for blend_ticket_to_order_items
-- ============================================================

ALTER TABLE blend_ticket_to_order_items ENABLE ROW LEVEL SECURITY;

-- SELECT: admin sees all, sales_rep sees own blend tickets
DROP POLICY IF EXISTS bt_order_items_select ON blend_ticket_to_order_items;
CREATE POLICY bt_order_items_select ON blend_ticket_to_order_items
  FOR SELECT USING (
    is_admin()
    OR EXISTS (
      SELECT 1 FROM blend_tickets bt
      WHERE bt.id = blend_ticket_to_order_items.blend_ticket_id
        AND bt.uploaded_by = (SELECT auth.uid())
    )
  );

-- INSERT: admin or owner of the blend ticket
DROP POLICY IF EXISTS bt_order_items_insert ON blend_ticket_to_order_items;
CREATE POLICY bt_order_items_insert ON blend_ticket_to_order_items
  FOR INSERT WITH CHECK (
    is_admin()
    OR EXISTS (
      SELECT 1 FROM blend_tickets bt
      WHERE bt.id = blend_ticket_to_order_items.blend_ticket_id
        AND bt.uploaded_by = (SELECT auth.uid())
    )
  );

-- DELETE: admin or owner of the blend ticket
DROP POLICY IF EXISTS bt_order_items_delete ON blend_ticket_to_order_items;
CREATE POLICY bt_order_items_delete ON blend_ticket_to_order_items
  FOR DELETE USING (
    is_admin()
    OR EXISTS (
      SELECT 1 FROM blend_tickets bt
      WHERE bt.id = blend_ticket_to_order_items.blend_ticket_id
        AND bt.uploaded_by = (SELECT auth.uid())
    )
  );


-- ============================================================
-- 4. RPC: link_blend_ticket_to_order
-- ============================================================

CREATE OR REPLACE FUNCTION link_blend_ticket_to_order(
  p_blend_ticket_id uuid,
  p_order_id uuid,
  p_item_mappings jsonb DEFAULT NULL,   -- [{ blend_product_id, order_item_id, quantity_applied }]
  p_performed_by uuid DEFAULT auth.uid()
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_ticket    blend_tickets%ROWTYPE;
  v_order     orders%ROWTYPE;
  v_mapping   jsonb;
  v_count     int := 0;
BEGIN
  -- Validate blend ticket exists and is unlinked
  SELECT * INTO v_ticket FROM blend_tickets WHERE id = p_blend_ticket_id AND deleted_at IS NULL;
  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', 'Blend ticket not found');
  END IF;
  IF v_ticket.order_link_status = 'linked' THEN
    RETURN json_build_object('success', false, 'error', 'Blend ticket is already linked to an order');
  END IF;

  -- Validate order exists
  SELECT * INTO v_order FROM orders WHERE id = p_order_id AND deleted_at IS NULL;
  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', 'Order not found');
  END IF;

  -- Validate same customer
  IF v_ticket.customer_id IS NOT NULL AND v_ticket.customer_id != v_order.customer_id THEN
    RETURN json_build_object('success', false, 'error', 'Blend ticket and order must belong to the same customer');
  END IF;

  -- If explicit item mappings provided, insert them
  IF p_item_mappings IS NOT NULL AND jsonb_array_length(p_item_mappings) > 0 THEN
    FOR v_mapping IN SELECT * FROM jsonb_array_elements(p_item_mappings)
    LOOP
      INSERT INTO blend_ticket_to_order_items (blend_ticket_id, order_item_id, order_id, quantity_applied, created_by)
      VALUES (
        p_blend_ticket_id,
        (v_mapping->>'order_item_id')::uuid,
        p_order_id,
        COALESCE((v_mapping->>'quantity_applied')::numeric, 0),
        p_performed_by
      )
      ON CONFLICT (blend_ticket_id, order_item_id) DO NOTHING;
      v_count := v_count + 1;
    END LOOP;
  ELSE
    -- Auto-match: try to match blend ticket products to order items by product_id
    INSERT INTO blend_ticket_to_order_items (blend_ticket_id, order_item_id, order_id, quantity_applied, created_by)
    SELECT
      p_blend_ticket_id,
      oi.id,
      p_order_id,
      btp.quantity,
      p_performed_by
    FROM blend_ticket_products btp
    JOIN order_items oi ON oi.product_id = btp.product_id AND oi.order_id = p_order_id
    WHERE btp.blend_ticket_id = p_blend_ticket_id
      AND btp.product_id IS NOT NULL
    ON CONFLICT (blend_ticket_id, order_item_id) DO NOTHING;

    GET DIAGNOSTICS v_count = ROW_COUNT;
  END IF;

  -- Update blend ticket link status
  UPDATE blend_tickets
  SET order_link_status = 'linked',
      updated_at = now()
  WHERE id = p_blend_ticket_id;

  -- Log activity
  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id)
  VALUES (
    'blend_ticket_linked_to_order',
    'Blend ticket ' || v_ticket.ticket_number || ' linked to order ' || v_order.order_number,
    p_performed_by,
    'blend_ticket',
    p_blend_ticket_id
  );

  -- Log in financial audit if exists
  INSERT INTO financial_audit_log (event_type, entity_type, entity_id, description, performed_by, metadata)
  VALUES (
    'blend_ticket_linked',
    'blend_ticket',
    p_blend_ticket_id,
    'Linked to order ' || v_order.order_number,
    p_performed_by,
    jsonb_build_object('order_id', p_order_id, 'items_linked', v_count)
  );

  RETURN json_build_object(
    'success', true,
    'items_linked', v_count,
    'order_id', p_order_id,
    'order_number', v_order.order_number
  );
END;
$$;


-- ============================================================
-- 5. RPC: unlink_blend_ticket_from_order
-- ============================================================

CREATE OR REPLACE FUNCTION unlink_blend_ticket_from_order(
  p_blend_ticket_id uuid,
  p_performed_by uuid DEFAULT auth.uid()
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_ticket    blend_tickets%ROWTYPE;
  v_order_id  uuid;
  v_order_num text;
  v_deleted   int;
BEGIN
  -- Validate blend ticket exists and is linked
  SELECT * INTO v_ticket FROM blend_tickets WHERE id = p_blend_ticket_id AND deleted_at IS NULL;
  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', 'Blend ticket not found');
  END IF;
  IF v_ticket.order_link_status != 'linked' THEN
    RETURN json_build_object('success', false, 'error', 'Blend ticket is not linked to any order');
  END IF;

  -- Get the order info for logging
  SELECT DISTINCT bto.order_id, o.order_number
  INTO v_order_id, v_order_num
  FROM blend_ticket_to_order_items bto
  JOIN orders o ON o.id = bto.order_id
  WHERE bto.blend_ticket_id = p_blend_ticket_id
  LIMIT 1;

  -- Delete junction records
  DELETE FROM blend_ticket_to_order_items
  WHERE blend_ticket_id = p_blend_ticket_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  -- Update blend ticket status
  UPDATE blend_tickets
  SET order_link_status = 'unlinked',
      updated_at = now()
  WHERE id = p_blend_ticket_id;

  -- Log activity
  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id)
  VALUES (
    'blend_ticket_unlinked_from_order',
    'Blend ticket ' || v_ticket.ticket_number || ' unlinked from order ' || COALESCE(v_order_num, 'unknown'),
    p_performed_by,
    'blend_ticket',
    p_blend_ticket_id
  );

  -- Financial audit
  INSERT INTO financial_audit_log (event_type, entity_type, entity_id, description, performed_by, metadata)
  VALUES (
    'blend_ticket_unlinked',
    'blend_ticket',
    p_blend_ticket_id,
    'Unlinked from order ' || COALESCE(v_order_num, 'unknown'),
    p_performed_by,
    jsonb_build_object('order_id', v_order_id, 'items_removed', v_deleted)
  );

  RETURN json_build_object(
    'success', true,
    'items_removed', v_deleted,
    'order_id', v_order_id
  );
END;
$$;


-- ============================================================
-- 6. RPC: create_order_from_blend_ticket
-- ============================================================

CREATE OR REPLACE FUNCTION create_order_from_blend_ticket(
  p_blend_ticket_id uuid,
  p_order_number text,
  p_order_date date DEFAULT CURRENT_DATE,
  p_notes text DEFAULT NULL,
  p_performed_by uuid DEFAULT auth.uid()
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_ticket      blend_tickets%ROWTYPE;
  v_order_id    uuid;
  v_customer    customers%ROWTYPE;
  v_product     blend_ticket_products%ROWTYPE;
  v_db_product  products%ROWTYPE;
  v_item_id     uuid;
  v_tier        int;
  v_price       numeric;
  v_cost        numeric;
  v_total_price numeric := 0;
  v_total_cost  numeric := 0;
  v_item_count  int := 0;
  v_link_result json;
BEGIN
  -- Validate blend ticket
  SELECT * INTO v_ticket FROM blend_tickets WHERE id = p_blend_ticket_id AND deleted_at IS NULL;
  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', 'Blend ticket not found');
  END IF;
  IF v_ticket.order_link_status = 'linked' THEN
    RETURN json_build_object('success', false, 'error', 'Blend ticket is already linked to an order');
  END IF;
  IF v_ticket.customer_id IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'Blend ticket has no customer assigned');
  END IF;

  -- Get customer for tier pricing
  SELECT * INTO v_customer FROM customers WHERE id = v_ticket.customer_id;
  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', 'Customer not found');
  END IF;
  v_tier := COALESCE(v_customer.assigned_tier, 1);

  -- Create the order
  v_order_id := gen_random_uuid();
  INSERT INTO orders (id, order_number, customer_id, status, order_date, notes, season, salesman_id, total_price, total_cost, total_profit, total_margin_pct, total_paid, balance_due)
  VALUES (
    v_order_id,
    p_order_number,
    v_ticket.customer_id,
    'confirmed',
    p_order_date,
    COALESCE(p_notes, 'Created from blend ticket ' || v_ticket.ticket_number),
    v_ticket.season,
    v_ticket.salesman_id,
    0, 0, 0, 0, 0, 0
  );

  -- Create order items from blend ticket products
  FOR v_product IN
    SELECT * FROM blend_ticket_products
    WHERE blend_ticket_id = p_blend_ticket_id
    ORDER BY sequence_order
  LOOP
    v_price := 0;
    v_cost := 0;

    -- Look up real product for pricing
    IF v_product.product_id IS NOT NULL THEN
      SELECT * INTO v_db_product FROM products WHERE id = v_product.product_id;
      IF FOUND THEN
        v_price := CASE v_tier
          WHEN 1 THEN COALESCE(v_db_product.tier1_price, 0)
          WHEN 2 THEN COALESCE(v_db_product.tier2_price, 0)
          WHEN 3 THEN COALESCE(v_db_product.tier3_price, 0)
          ELSE COALESCE(v_db_product.tier1_price, 0)
        END;
        v_cost := COALESCE(v_db_product.current_cost, 0);
      END IF;
    END IF;

    v_item_id := gen_random_uuid();
    INSERT INTO order_items (
      id, order_id, product_id, product_name, price_per_unit, cost_per_unit,
      actual_rate, rate_unit, acres, total_units_needed, unit_size,
      total_price, profit, net_margin, quantity_delivered, quantity_remaining, sort_order
    )
    VALUES (
      v_item_id,
      v_order_id,
      COALESCE(v_product.product_id, gen_random_uuid()),
      v_product.product_name,
      v_price,
      v_cost,
      v_product.rate_per_acre,
      v_product.rate_per_acre_unit,
      v_ticket.total_acres,
      v_product.quantity,
      COALESCE(v_product.unit, 'ea'),
      v_price * v_product.quantity,
      (v_price - v_cost) * v_product.quantity,
      CASE WHEN v_price > 0 THEN ((v_price - v_cost) / v_price * 100) ELSE 0 END,
      0,
      v_product.quantity,
      v_product.sequence_order
    );

    v_total_price := v_total_price + (v_price * v_product.quantity);
    v_total_cost := v_total_cost + (v_cost * v_product.quantity);
    v_item_count := v_item_count + 1;
  END LOOP;

  -- Update order totals
  UPDATE orders
  SET total_price = v_total_price,
      total_cost = v_total_cost,
      total_profit = v_total_price - v_total_cost,
      total_margin_pct = CASE WHEN v_total_price > 0 THEN ((v_total_price - v_total_cost) / v_total_price * 100) ELSE 0 END,
      balance_due = v_total_price
  WHERE id = v_order_id;

  -- Link the blend ticket to this new order
  v_link_result := link_blend_ticket_to_order(p_blend_ticket_id, v_order_id, NULL, p_performed_by);

  -- Log activity
  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id)
  VALUES (
    'order_created_from_blend_ticket',
    'Order ' || p_order_number || ' created from blend ticket ' || v_ticket.ticket_number,
    p_performed_by,
    'order',
    v_order_id
  );

  RETURN json_build_object(
    'success', true,
    'order_id', v_order_id,
    'order_number', p_order_number,
    'items_created', v_item_count,
    'total_price', v_total_price
  );
END;
$$;


-- ============================================================
-- 7. RPC: update_blend_ticket_billing_status
-- ============================================================

CREATE OR REPLACE FUNCTION update_blend_ticket_billing_status(
  p_blend_ticket_id uuid,
  p_payment_status text DEFAULT NULL,
  p_performed_by uuid DEFAULT auth.uid()
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_ticket blend_tickets%ROWTYPE;
BEGIN
  SELECT * INTO v_ticket FROM blend_tickets WHERE id = p_blend_ticket_id AND deleted_at IS NULL;
  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', 'Blend ticket not found');
  END IF;

  -- Validate: can't set billed if not linked
  IF p_payment_status = 'billed' AND v_ticket.order_link_status = 'unlinked' THEN
    RETURN json_build_object('success', false, 'error', 'Cannot set payment status to billed when ticket is not linked to an order');
  END IF;

  IF p_payment_status IS NOT NULL THEN
    UPDATE blend_tickets
    SET payment_status = p_payment_status,
        updated_at = now()
    WHERE id = p_blend_ticket_id;
  END IF;

  -- Log activity
  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id)
  VALUES (
    'blend_ticket_status_changed',
    'Blend ticket ' || v_ticket.ticket_number || ' payment status changed to ' || COALESCE(p_payment_status, 'unchanged'),
    p_performed_by,
    'blend_ticket',
    p_blend_ticket_id
  );

  RETURN json_build_object('success', true);
END;
$$;
