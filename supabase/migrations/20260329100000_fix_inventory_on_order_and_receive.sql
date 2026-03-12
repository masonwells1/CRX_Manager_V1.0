-- Fix: receive_po_items must decrement quantity_on_order when receiving
-- The wave4 rewrite dropped this line, causing quantity_on_order to stay inflated after receiving.
-- Also adds quantity_on_order increment when PO is submitted (was never implemented).

-- ============================================================================
-- 1. Fix receive_po_items: restore quantity_on_order decrement on receive
-- ============================================================================
CREATE OR REPLACE FUNCTION public.receive_po_items(
  p_purchase_order_id uuid,
  p_items jsonb,
  p_received_by uuid,
  p_idempotency_key text DEFAULT NULL,
  p_skip_cost_update boolean DEFAULT false
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

    -- M7: Weighted average cost update
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

GRANT EXECUTE ON FUNCTION public.receive_po_items(uuid, jsonb, uuid, text, boolean) TO authenticated;

-- ============================================================================
-- 2. Trigger: increment quantity_on_order when PO is submitted
-- ============================================================================
CREATE OR REPLACE FUNCTION public.trg_po_submitted_update_on_order()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_item RECORD;
BEGIN
  -- Only fire when PO transitions TO 'submitted' from 'draft'
  IF NEW.status = 'submitted' AND OLD.status = 'draft' THEN
    FOR v_item IN
      SELECT product_id, quantity_ordered
        FROM purchase_order_items
       WHERE purchase_order_id = NEW.id
    LOOP
      UPDATE inventory SET
        quantity_on_order = COALESCE(quantity_on_order, 0) + v_item.quantity_ordered,
        updated_at = now()
      WHERE product_id = v_item.product_id AND location = 'Main Warehouse';

      -- If no inventory row exists yet, create one
      IF NOT FOUND THEN
        INSERT INTO inventory (product_id, location, quantity_available, quantity_on_order)
        VALUES (v_item.product_id, 'Main Warehouse', 0, v_item.quantity_ordered);
      END IF;
    END LOOP;
  END IF;

  -- If PO is cancelled, release the on_order quantity
  IF NEW.status = 'cancelled' AND OLD.status IN ('submitted', 'partially_received') THEN
    FOR v_item IN
      SELECT product_id, quantity_ordered, COALESCE(quantity_received, 0) AS quantity_received
        FROM purchase_order_items
       WHERE purchase_order_id = NEW.id
    LOOP
      UPDATE inventory SET
        quantity_on_order = GREATEST(COALESCE(quantity_on_order, 0) - (v_item.quantity_ordered - v_item.quantity_received), 0),
        updated_at = now()
      WHERE product_id = v_item.product_id AND location = 'Main Warehouse';
    END LOOP;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_po_submitted_on_order ON purchase_orders;
CREATE TRIGGER trg_po_submitted_on_order
  AFTER UPDATE OF status ON purchase_orders
  FOR EACH ROW
  EXECUTE FUNCTION trg_po_submitted_update_on_order();

-- ============================================================================
-- 3. One-time fix: recalculate quantity_on_order from actual PO data
--    Sets on_order = sum of (ordered - received) for submitted/partially_received POs
-- ============================================================================
UPDATE inventory SET quantity_on_order = 0;

UPDATE inventory inv SET
  quantity_on_order = sub.total_on_order
FROM (
  SELECT poi.product_id, SUM(poi.quantity_ordered - COALESCE(poi.quantity_received, 0)) AS total_on_order
    FROM purchase_order_items poi
    JOIN purchase_orders po ON po.id = poi.purchase_order_id
   WHERE po.status IN ('submitted', 'partially_received')
     AND poi.quantity_ordered > COALESCE(poi.quantity_received, 0)
   GROUP BY poi.product_id
) sub
WHERE inv.product_id = sub.product_id AND inv.location = 'Main Warehouse';
