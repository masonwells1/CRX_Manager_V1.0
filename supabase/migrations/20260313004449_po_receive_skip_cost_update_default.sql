-- ============================================================================
-- Stop PO receiving from updating product master cost
--
-- Business rule: products.current_cost is the PRICING BASIS set by admin.
-- It should NOT auto-update when receiving POs at different supplier costs.
-- Supplier cost is still tracked on purchase_order_items.unit_cost and
-- receiving_records.unit_cost for future actual-cost reporting.
--
-- Change: flip p_skip_cost_update from DEFAULT false → DEFAULT true
-- The weighted-average cost update block is preserved but now opt-in,
-- meaning callers must explicitly pass p_skip_cost_update := false
-- if they ever want the old behavior.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.receive_po_items(
  p_purchase_order_id uuid,
  p_items jsonb,
  p_received_by uuid,
  p_idempotency_key text DEFAULT NULL,
  p_skip_cost_update boolean DEFAULT true   -- ← was DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_item jsonb;
  v_po_item RECORD;
  v_po RECORD;
  v_existing jsonb;
  v_result jsonb;
  v_recv_id uuid;
  v_receiving_record_ids jsonb := '[]'::jsonb;
  v_qty_received numeric;
  v_actor uuid;
  v_affected_po_ids uuid[] := '{}';
  v_unique_po_id uuid;
  v_product RECORD;
  v_current_qty numeric;
  v_new_cost numeric;
BEGIN
  v_actor := COALESCE(p_received_by, auth.uid());

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'receive_po_items');
    IF v_existing IS NOT NULL THEN
      RETURN v_existing;
    END IF;
  END IF;

  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'No items provided for receiving';
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    SELECT poi.*, po.po_number, po.id AS purchase_order_id
      INTO v_po_item
      FROM purchase_order_items poi
      JOIN purchase_orders po ON po.id = poi.purchase_order_id
     WHERE poi.id = (v_item->>'purchase_order_item_id')::uuid;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'PO item not found: %', v_item->>'purchase_order_item_id';
    END IF;

    SELECT * INTO v_po FROM purchase_orders WHERE id = v_po_item.purchase_order_id;

    v_qty_received := (v_item->>'quantity_received')::numeric;
    IF v_qty_received IS NULL OR v_qty_received <= 0 THEN
      CONTINUE;
    END IF;

    -- H10: Over-receive validation
    IF (COALESCE(v_po_item.quantity_received, 0) + v_qty_received) > v_po_item.quantity_ordered THEN
      RAISE EXCEPTION 'Cannot receive more than ordered for item %. Ordered: %, Already received: %, Attempting: %',
        v_po_item.id, v_po_item.quantity_ordered, COALESCE(v_po_item.quantity_received, 0), v_qty_received;
    END IF;

    INSERT INTO receiving_records (
      purchase_order_id, purchase_order_item_id,
      product_id, quantity_received, unit_cost,
      condition, lot_number, notes, received_by
    ) VALUES (
      v_po_item.purchase_order_id, v_po_item.id,
      v_po_item.product_id, v_qty_received, v_po_item.unit_cost,
      COALESCE(v_item->>'condition', 'good'),
      v_item->>'lot_number',
      v_item->>'notes',
      v_actor
    ) RETURNING id INTO v_recv_id;

    v_receiving_record_ids := v_receiving_record_ids || to_jsonb(v_recv_id::text);

    UPDATE purchase_order_items SET
      quantity_received = COALESCE(quantity_received, 0) + v_qty_received,
      updated_at        = now()
    WHERE id = v_po_item.id;

    -- Add to available AND decrement on_order
    UPDATE inventory SET
      quantity_available = quantity_available + v_qty_received,
      quantity_on_order  = GREATEST(COALESCE(quantity_on_order, 0) - v_qty_received, 0),
      updated_at         = now()
    WHERE product_id = v_po_item.product_id AND location = 'Main Warehouse';

    IF NOT FOUND THEN
      INSERT INTO inventory (product_id, location, quantity_available, quantity_on_order)
      VALUES (v_po_item.product_id, 'Main Warehouse', v_qty_received, 0);
    END IF;

    INSERT INTO inventory_transactions (
      product_id, transaction_type, quantity,
      reference_id, performed_by, notes
    ) VALUES (
      v_po_item.product_id, 'received', v_qty_received,
      v_po_item.purchase_order_id, v_actor,
      'Received from PO: ' || COALESCE(v_po.po_number, v_po_item.purchase_order_id::text)
    );

    -- M7: Weighted average cost update (now skipped by default)
    IF NOT p_skip_cost_update AND v_po_item.unit_cost IS NOT NULL AND v_po_item.unit_cost > 0 THEN
      SELECT * INTO v_product FROM products WHERE id = v_po_item.product_id;
      IF FOUND THEN
        SELECT COALESCE(quantity_available, 0) - v_qty_received
          INTO v_current_qty
          FROM inventory
         WHERE product_id = v_po_item.product_id AND location = 'Main Warehouse';

        v_current_qty := GREATEST(COALESCE(v_current_qty, 0), 0);

        IF (v_current_qty + v_qty_received) > 0 THEN
          v_new_cost := ROUND(
            (v_current_qty * COALESCE(v_product.current_cost, v_po_item.unit_cost) +
             v_qty_received * v_po_item.unit_cost)
            / (v_current_qty + v_qty_received),
            4
          );
        ELSE
          v_new_cost := v_po_item.unit_cost;
        END IF;

        IF v_new_cost IS DISTINCT FROM v_product.current_cost THEN
          INSERT INTO cost_history (product_id, changed_by, old_cost, new_cost, change_note)
          VALUES (
            v_po_item.product_id, v_actor,
            v_product.current_cost, v_new_cost,
            'Weighted avg cost update from PO receiving'
          );

          UPDATE products SET
            current_cost      = v_new_cost,
            cost_updated_date = now()
          WHERE id = v_po_item.product_id;
        END IF;
      END IF;
    END IF;

    v_affected_po_ids := array_append(v_affected_po_ids, v_po_item.purchase_order_id);
  END LOOP;

  FOREACH v_unique_po_id IN ARRAY (SELECT ARRAY(SELECT DISTINCT unnest(v_affected_po_ids)))
  LOOP
    PERFORM update_po_status(v_unique_po_id);
  END LOOP;

  v_result := jsonb_build_object(
    'status',                'received',
    'receiving_record_ids',  v_receiving_record_ids
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'receive_po_items', v_result);
  END IF;

  RETURN v_result;
END;
$$;

-- Re-grant with updated signature (same signature, just new default)
GRANT EXECUTE ON FUNCTION public.receive_po_items(uuid, jsonb, uuid, text, boolean) TO authenticated;
