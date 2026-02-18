-- ============================================================================
-- Quick Receive Feature
-- Migration: 20260304200000_quick_receive.sql
--
-- New RPC: match_quick_receive_items — matches received products to open POs
-- Updated RPC: receive_po_items — adds p_allow_over_receive param + multi-PO fix
-- ============================================================================

-- ============================================================================
-- SECTION 1: match_quick_receive_items()
-- Takes a list of products + quantities and optional vendor, returns
-- which open PO items each should be allocated to (oldest PO first).
-- ============================================================================

CREATE OR REPLACE FUNCTION match_quick_receive_items(
  p_items jsonb,
  p_vendor text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_item jsonb;
  v_product_id uuid;
  v_qty_to_allocate numeric;
  v_lot_number text;
  v_remaining numeric;
  v_alloc_qty numeric;
  v_multiple_costs boolean;
  v_result jsonb := '[]'::jsonb;
  v_allocations jsonb;
  v_po_cursor record;
  v_product_name text;
BEGIN
  -- Verify caller is admin or sales_rep
  IF NOT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = (select auth.uid()) AND is_active = true
      AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  -- Process each item in the input array
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_product_id := (v_item->>'product_id')::uuid;
    v_qty_to_allocate := (v_item->>'quantity')::numeric;
    v_lot_number := v_item->>'lot_number';
    v_remaining := v_qty_to_allocate;
    v_allocations := '[]'::jsonb;

    IF v_qty_to_allocate <= 0 THEN CONTINUE; END IF;

    -- Get product name for display
    SELECT product_name INTO v_product_name FROM products WHERE id = v_product_id;

    -- Check if this product has multiple open POs at different costs (no-return scenario)
    SELECT count(DISTINCT poi.unit_cost) > 1 INTO v_multiple_costs
    FROM purchase_order_items poi
    JOIN purchase_orders po ON po.id = poi.purchase_order_id
    WHERE poi.product_id = v_product_id
      AND po.status IN ('submitted', 'partially_received')
      AND poi.quantity_received < poi.quantity_ordered
      AND (p_vendor IS NULL OR p_vendor = '' OR po.vendor ILIKE '%' || p_vendor || '%');

    -- Loop through open PO items for this product, oldest PO first
    FOR v_po_cursor IN
      SELECT
        poi.id AS po_item_id,
        poi.purchase_order_id,
        po.po_number,
        po.vendor AS po_vendor,
        po.submitted_date,
        poi.unit_cost,
        poi.quantity_ordered,
        poi.quantity_received,
        (poi.quantity_ordered - poi.quantity_received) AS remaining_capacity,
        poi.unit_size
      FROM purchase_order_items poi
      JOIN purchase_orders po ON po.id = poi.purchase_order_id
      WHERE poi.product_id = v_product_id
        AND po.status IN ('submitted', 'partially_received')
        AND poi.quantity_received < poi.quantity_ordered
        AND (p_vendor IS NULL OR p_vendor = '' OR po.vendor ILIKE '%' || p_vendor || '%')
      ORDER BY po.submitted_date ASC NULLS LAST, po.created_at ASC
    LOOP
      IF v_remaining <= 0 THEN EXIT; END IF;

      v_alloc_qty := LEAST(v_remaining, v_po_cursor.remaining_capacity);

      v_allocations := v_allocations || jsonb_build_object(
        'po_item_id', v_po_cursor.po_item_id,
        'purchase_order_id', v_po_cursor.purchase_order_id,
        'po_number', v_po_cursor.po_number,
        'po_vendor', v_po_cursor.po_vendor,
        'unit_cost', v_po_cursor.unit_cost,
        'quantity_allocated', v_alloc_qty,
        'po_remaining_before', v_po_cursor.remaining_capacity,
        'po_remaining_after', v_po_cursor.remaining_capacity - v_alloc_qty,
        'unit_size', v_po_cursor.unit_size
      );

      v_remaining := v_remaining - v_alloc_qty;
    END LOOP;

    v_result := v_result || jsonb_build_object(
      'product_id', v_product_id,
      'product_name', COALESCE(v_product_name, 'Unknown'),
      'quantity_requested', v_qty_to_allocate,
      'quantity_allocated', v_qty_to_allocate - v_remaining,
      'quantity_unmatched', v_remaining,
      'has_multiple_costs', COALESCE(v_multiple_costs, false),
      'lot_number', v_lot_number,
      'allocations', v_allocations
    );
  END LOOP;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION match_quick_receive_items(jsonb, text) TO authenticated;

-- ============================================================================
-- SECTION 2: Updated receive_po_items()
-- Adds p_allow_over_receive parameter (backward compatible, default false)
-- Fixes multi-PO status update bug (now updates ALL affected POs, not just last)
-- ============================================================================

CREATE OR REPLACE FUNCTION receive_po_items(
  p_items jsonb,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL,
  p_allow_over_receive boolean DEFAULT false
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
  v_receiving_record_ids jsonb := '[]'::jsonb;
  v_recv_id uuid;
  v_condition text;
  v_lot_number text;
  v_notes text;
  v_storage_location text;
  v_affected_po_ids uuid[] := '{}';
  v_unique_po_id uuid;
BEGIN
  -- Check idempotency key if provided
  IF p_idempotency_key IS NOT NULL THEN
    v_cached_result := check_idempotency(p_idempotency_key, 'receive_po_items');
    IF v_cached_result IS NOT NULL THEN
      RETURN v_cached_result;
    END IF;
  END IF;

  -- Verify caller is admin OR sales_rep
  IF NOT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = p_performed_by
      AND role IN ('admin', 'sales_rep')
      AND is_active = true
  ) THEN
    RAISE EXCEPTION 'Only admins and sales reps can receive PO items';
  END IF;

  -- Process each item
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_qty := (v_item->>'quantity')::numeric;
    IF v_qty <= 0 THEN CONTINUE; END IF;

    SELECT * INTO v_po_item FROM purchase_order_items WHERE id = (v_item->>'po_item_id')::uuid;
    IF NOT FOUND THEN CONTINUE; END IF;

    -- Validate not receiving more than ordered (unless over-receive allowed)
    IF NOT p_allow_over_receive AND v_po_item.quantity_received + v_qty > v_po_item.quantity_ordered THEN
      RAISE EXCEPTION 'Cannot receive more than ordered for item %', v_po_item.id;
    END IF;

    v_po_id := v_po_item.purchase_order_id;

    -- Track all affected PO IDs for status update (multi-PO fix)
    IF NOT v_po_id = ANY(v_affected_po_ids) THEN
      v_affected_po_ids := v_affected_po_ids || v_po_id;
    END IF;

    -- Extract optional per-item fields (backward compatible)
    v_condition := COALESCE(v_item->>'condition', 'good');
    v_lot_number := v_item->>'lot_number';
    v_notes := v_item->>'notes';
    v_storage_location := COALESCE(v_item->>'storage_location', 'Main Warehouse');

    -- Update PO item received count
    UPDATE purchase_order_items SET
      quantity_received = quantity_received + v_qty
    WHERE id = v_po_item.id;

    -- Update inventory (atomic increment)
    UPDATE inventory SET
      quantity_available = quantity_available + v_qty,
      quantity_on_order = GREATEST(quantity_on_order - v_qty, 0),
      updated_at = now()
    WHERE product_id = v_po_item.product_id AND location = v_storage_location;

    IF NOT FOUND THEN
      INSERT INTO inventory (product_id, location, quantity_available, quantity_on_order, quantity_prebooked, unit_size)
      VALUES (v_po_item.product_id, v_storage_location, v_qty, 0, 0, v_po_item.unit_size);
    END IF;

    -- Create audit trail in inventory_transactions
    INSERT INTO inventory_transactions (
      product_id, transaction_type, quantity, to_location,
      purchase_order_id, performed_by, notes
    ) VALUES (
      v_po_item.product_id, 'received', v_qty, v_storage_location,
      v_po_id, p_performed_by,
      'Received ' || v_qty || ' units via PO'
    );

    -- Create receiving record (event-level tracking)
    INSERT INTO receiving_records (
      purchase_order_id, po_item_id, product_id,
      quantity_received, received_by, notes, condition,
      lot_number, storage_location, unit_size
    ) VALUES (
      v_po_id, v_po_item.id, v_po_item.product_id,
      v_qty, p_performed_by, v_notes, v_condition,
      v_lot_number, v_storage_location, v_po_item.unit_size
    )
    RETURNING id INTO v_recv_id;

    v_receiving_record_ids := v_receiving_record_ids || to_jsonb(v_recv_id::text);

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

  -- Auto-update PO status for ALL affected POs (multi-PO fix)
  FOREACH v_unique_po_id IN ARRAY v_affected_po_ids
  LOOP
    SELECT * INTO v_po FROM purchase_orders WHERE id = v_unique_po_id;
    IF NOT FOUND THEN CONTINUE; END IF;

    SELECT
      bool_and(quantity_received >= quantity_ordered),
      bool_or(quantity_received > 0)
    INTO v_all_received, v_any_received
    FROM purchase_order_items WHERE purchase_order_id = v_unique_po_id;

    v_new_status := CASE
      WHEN v_all_received THEN 'fully_received'
      WHEN v_any_received THEN 'partially_received'
      ELSE v_po.status
    END;

    IF v_new_status IS DISTINCT FROM v_po.status THEN
      UPDATE purchase_orders SET status = v_new_status, updated_at = now() WHERE id = v_unique_po_id;
    END IF;

    INSERT INTO activity_feed (
      event_type, description, performed_by,
      related_entity_type, related_entity_id
    ) VALUES (
      'po_received',
      'Items received on PO ' || v_po.po_number || ' — inventory updated',
      p_performed_by, 'purchase_order', v_unique_po_id
    );
  END LOOP;

  v_result := jsonb_build_object(
    'status', 'received',
    'receiving_record_ids', v_receiving_record_ids
  );

  -- Save idempotency result if key was provided
  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (key, operation, result)
    VALUES (p_idempotency_key, 'receive_po_items', v_result)
    ON CONFLICT (key) DO NOTHING;
  END IF;

  RETURN v_result;
END;
$$;

-- Grant execute covers old 3-param and new 4-param signatures
GRANT EXECUTE ON FUNCTION receive_po_items(jsonb, uuid, text, boolean) TO authenticated;
