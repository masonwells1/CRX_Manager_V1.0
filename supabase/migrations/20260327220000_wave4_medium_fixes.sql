-- Wave 4 Medium Bug Fixes
-- M7:  receive_po_items uses last-cost replacement → switch to weighted average cost
-- M13: update_order_items doesn't delete removed items → delete items absent from p_items
-- M24: next_invoice_number has no advisory lock → concurrent creates can duplicate

BEGIN;

-- =============================================================
-- M13: update_order_items — delete items missing from p_items
-- Safety: never delete items that have been (partially) delivered
-- =============================================================
CREATE OR REPLACE FUNCTION public.update_order_items(
  p_order_id        uuid,
  p_items           jsonb,
  p_performed_by    uuid,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor      uuid;
  v_order      record;
  v_old_item   record;
  v_item       jsonb;
  v_qty_diff   numeric;
  v_new_total  numeric;
  v_result     jsonb;
  v_passed_ids uuid[];
BEGIN
  v_actor := COALESCE(p_performed_by, auth.uid());

  SELECT * INTO v_order FROM orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found: %', p_order_id;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = v_actor
      AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'Not authorized to update order items';
  END IF;

  -- Idempotency check
  IF p_idempotency_key IS NOT NULL THEN
    DECLARE v_existing jsonb;
    BEGIN
      v_existing := check_idempotency(p_idempotency_key, 'update_order_items');
      IF (v_existing->>'status') = 'completed' THEN
        RETURN v_existing->'result';
      END IF;
    END;
  END IF;

  -- Collect the IDs passed from the frontend
  SELECT array_agg((el->>'id')::uuid)
    INTO v_passed_ids
    FROM jsonb_array_elements(p_items) el
   WHERE (el->>'id') IS NOT NULL;

  -- M13: Delete items NOT in the passed list, but ONLY if they have no deliveries
  DELETE FROM order_items
   WHERE order_id = p_order_id
     AND (v_passed_ids IS NULL OR id != ALL(v_passed_ids))
     AND quantity_delivered = 0;

  -- Restore any prebooked inventory for truly deleted items
  -- (items that were in DB, not in p_items, and had prebooked qty)
  -- Already handled by the DELETE + trigger (if trigger exists), but we do it inline
  -- to be safe since some deploys may not have the trigger:
  FOR v_old_item IN
    SELECT oi.*
      FROM order_items oi
     WHERE oi.order_id = p_order_id
       AND (v_passed_ids IS NULL OR oi.id != ALL(v_passed_ids))
       AND oi.quantity_prebooked > 0
  LOOP
    UPDATE inventory
       SET quantity_prebooked = GREATEST(quantity_prebooked - v_old_item.quantity_prebooked, 0),
           updated_at = now()
     WHERE product_id = v_old_item.product_id AND location = 'Main Warehouse';
  END LOOP;

  -- Update remaining items
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    SELECT * INTO v_old_item FROM order_items WHERE id = (v_item->>'id')::uuid;
    IF NOT FOUND THEN CONTINUE; END IF;

    v_qty_diff := (v_item->>'total_units_needed')::numeric - v_old_item.total_units_needed;

    UPDATE order_items SET
      price_per_unit    = (v_item->>'price_per_unit')::numeric,
      total_units_needed = (v_item->>'total_units_needed')::numeric,
      quantity_remaining = GREATEST(
        (v_item->>'total_units_needed')::numeric - v_old_item.quantity_delivered, 0
      ),
      total_price = (v_item->>'price_per_unit')::numeric * (v_item->>'total_units_needed')::numeric
    WHERE id = v_old_item.id;

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
        p_order_id, v_actor,
        'Order edit: adjusted prebooked by ' || v_qty_diff
      );
    END IF;
  END LOOP;

  SELECT COALESCE(SUM(total_price), 0) INTO v_new_total
    FROM order_items WHERE order_id = p_order_id;

  UPDATE orders SET
    total_price = v_new_total,
    updated_at  = now()
  WHERE id = p_order_id;

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'order_edited',
    'Order ' || v_order.order_number || ' items updated — new total $' || ROUND(v_new_total, 2),
    v_actor, 'order', p_order_id, v_order.customer_id
  );

  v_result := jsonb_build_object('status', 'updated');

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'update_order_items', v_result);
  END IF;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.update_order_items(uuid, jsonb, uuid, text) TO authenticated;


-- =============================================================
-- M7: receive_po_items — weighted average cost instead of last cost
-- WAC = (current_qty * current_cost + received_qty * po_cost)
--        / (current_qty + received_qty)
-- Uses inventory.quantity_available for current stock level.
-- =============================================================
CREATE OR REPLACE FUNCTION public.receive_po_items(
  p_purchase_order_id uuid,
  p_items             jsonb,
  p_performed_by      uuid DEFAULT NULL,
  p_idempotency_key   text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor               uuid;
  v_po                  record;
  v_item                jsonb;
  v_po_item             record;
  v_product             record;
  v_qty_received        numeric;
  v_recv_id             uuid;
  v_receiving_record_ids jsonb := '[]';
  v_affected_po_ids     uuid[] := '{}';
  v_unique_po_id        uuid;
  v_result              jsonb;
  v_new_cost            numeric;
  v_current_qty         numeric;
BEGIN
  v_actor := COALESCE(p_performed_by, auth.uid());

  -- Role check
  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = v_actor
      AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'Not authorized to receive PO items';
  END IF;

  -- Idempotency check
  IF p_idempotency_key IS NOT NULL THEN
    DECLARE v_existing jsonb;
    BEGIN
      v_existing := check_idempotency(p_idempotency_key, 'receive_po_items');
      IF (v_existing->>'status') = 'completed' THEN
        RETURN v_existing->'result';
      END IF;
    END;
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    SELECT * INTO v_po_item
      FROM purchase_order_items
     WHERE id = (v_item->>'purchase_order_item_id')::uuid
       FOR UPDATE;

    IF NOT FOUND THEN CONTINUE; END IF;

    SELECT * INTO v_po
      FROM purchase_orders WHERE id = v_po_item.purchase_order_id;

    v_qty_received := (v_item->>'quantity_received')::numeric;
    IF v_qty_received IS NULL OR v_qty_received <= 0 THEN CONTINUE; END IF;

    -- Insert receiving record
    INSERT INTO receiving_records (
      purchase_order_item_id, purchase_order_id,
      product_id, quantity_received, unit_cost,
      condition, lot_number, notes, received_by
    ) VALUES (
      v_po_item.id, v_po_item.purchase_order_id,
      v_po_item.product_id, v_qty_received, v_po_item.unit_cost,
      COALESCE(v_item->>'condition', 'good'),
      v_item->>'lot_number',
      v_item->>'notes',
      v_actor
    ) RETURNING id INTO v_recv_id;

    v_receiving_record_ids := v_receiving_record_ids || to_jsonb(v_recv_id::text);

    -- Update PO item received quantity
    UPDATE purchase_order_items SET
      quantity_received = COALESCE(quantity_received, 0) + v_qty_received,
      updated_at = now()
    WHERE id = v_po_item.id;

    -- Update inventory
    UPDATE inventory SET
      quantity_available = quantity_available + v_qty_received,
      updated_at = now()
    WHERE product_id = v_po_item.product_id AND location = 'Main Warehouse';

    IF NOT FOUND THEN
      INSERT INTO inventory (product_id, location, quantity_available)
      VALUES (v_po_item.product_id, 'Main Warehouse', v_qty_received);
    END IF;

    -- Inventory transaction record
    INSERT INTO inventory_transactions (
      product_id, transaction_type, quantity,
      reference_id, performed_by, notes
    ) VALUES (
      v_po_item.product_id, 'received', v_qty_received,
      v_po_item.purchase_order_id, v_actor,
      'Received from PO: ' || COALESCE(v_po.po_number, v_po_item.purchase_order_id::text)
    );

    -- M7: Weighted average cost update
    IF v_po_item.unit_cost IS NOT NULL AND v_po_item.unit_cost > 0 THEN
      SELECT * INTO v_product FROM products WHERE id = v_po_item.product_id;
      IF FOUND THEN
        -- Get current stock level (before this receipt was added above)
        SELECT COALESCE(quantity_available, 0) - v_qty_received
          INTO v_current_qty
          FROM inventory
         WHERE product_id = v_po_item.product_id AND location = 'Main Warehouse';

        v_current_qty := GREATEST(COALESCE(v_current_qty, 0), 0);

        -- WAC formula: (old_qty * old_cost + new_qty * new_cost) / (old_qty + new_qty)
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

  -- Update PO statuses
  FOREACH v_unique_po_id IN ARRAY (SELECT ARRAY(SELECT DISTINCT unnest(v_affected_po_ids)))
  LOOP
    PERFORM update_po_status(v_unique_po_id);
  END LOOP;

  v_result := jsonb_build_object(
    'status', 'received',
    'receiving_record_ids', v_receiving_record_ids
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'receive_po_items', v_result);
  END IF;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.receive_po_items(uuid, jsonb, uuid, text) TO authenticated;


-- =============================================================
-- M24: next_invoice_number — add advisory lock to prevent duplicates
-- Uses pg_advisory_xact_lock so lock auto-releases on commit/rollback
-- =============================================================
CREATE OR REPLACE FUNCTION public.next_invoice_number()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_year   int;
  v_seq    int;
  v_prefix text;
BEGIN
  -- M24: Acquire advisory lock scoped to this transaction to prevent
  -- concurrent calls from generating the same invoice number
  PERFORM pg_advisory_xact_lock(hashtext('next_invoice_number'));

  v_year   := extract(year FROM now())::int;
  v_prefix := 'INV-' || v_year || '-';

  SELECT COALESCE(MAX(
    CASE WHEN invoice_number LIKE v_prefix || '%'
         THEN (regexp_replace(invoice_number, '^INV-\d{4}-', ''))::int
         ELSE 0
    END
  ), 0) + 1
    INTO v_seq
    FROM invoices;

  RETURN v_prefix || LPAD(v_seq::text, 5, '0');
END;
$$;

GRANT EXECUTE ON FUNCTION public.next_invoice_number() TO authenticated;


COMMIT;
