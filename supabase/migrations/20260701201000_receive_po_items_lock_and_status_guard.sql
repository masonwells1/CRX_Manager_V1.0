-- 20260701201000_receive_po_items_lock_and_status_guard.sql
-- PARKED-009 (codex-driven hunt cycle 6). receive_po_items read
-- purchase_order_items.quantity_received with NO row lock, checked the over-receive
-- cap against that stale value, then incremented inventory + quantity_received. Two
-- concurrent receives of the SAME po_item (double-click / two receivers) could BOTH
-- pass the check on the stale value and both add -> over-receive past quantity_ordered
-- AND double-increment inventory.
--
-- Changes vs the current live definition (everything else verbatim):
--   1. add "po.status AS po_status" to the per-item SELECT
--   2. "FOR UPDATE OF poi" on that SELECT -> concurrent receives of the same item
--      serialize; the 2nd re-reads the updated quantity_received before its check
--   3. fail-fast guard: a receive against a draft/cancelled PO is rejected BEFORE any
--      inventory write (today it wastefully touches inventory then rolls back when the
--      status-transition trigger rejects the roll-up). NOTE: submitted /
--      partially_received / fully_received all stay receivable -- fully_received only
--      via p_allow_over_receive, preserving the existing correction path.

CREATE OR REPLACE FUNCTION public.receive_po_items(p_items jsonb, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text, p_allow_over_receive boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_item jsonb; v_po_item RECORD;
  v_existing jsonb; v_result jsonb;
  v_recv_id uuid; v_receiving_record_ids jsonb := '[]'::jsonb;
  v_qty numeric; v_actor uuid; v_actor_role text;
  v_affected_po_ids uuid[] := '{}'; v_unique_po_id uuid;
  v_condition text; v_lot_number text; v_notes text;
  v_storage_location text;
  v_total_ordered numeric; v_total_received numeric;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'p_performed_by does not match authenticated user';
  END IF;

  SELECT role INTO v_actor_role FROM profiles WHERE id = v_actor;
  IF v_actor_role NOT IN ('admin', 'sales_rep') THEN
    RAISE EXCEPTION 'Only admin or sales_rep can receive PO items';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'receive_po_items');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'No items provided for receiving';
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_qty := COALESCE((v_item->>'quantity')::numeric, 0);
    IF v_qty <= 0 THEN CONTINUE; END IF;

    -- PARKED-009: lock the po_item row so concurrent receives of the same item
    -- serialize (closes the over-receive / double-increment TOCTOU race). Also pull
    -- po.status for the fail-fast guard below.
    SELECT poi.*, po.po_number, po.id AS po_parent_id, po.status AS po_status
      INTO v_po_item
      FROM purchase_order_items poi
      JOIN purchase_orders po ON po.id = poi.purchase_order_id
     WHERE poi.id = (v_item->>'po_item_id')::uuid
     FOR UPDATE OF poi;

    IF NOT FOUND THEN RAISE EXCEPTION 'PO item not found: %', v_item->>'po_item_id'; END IF;

    -- PARKED-009: fail fast on a PO that cannot legitimately be received. draft (never
    -- submitted) and cancelled are the states where a receive today wastefully touches
    -- inventory before the status-transition trigger rejects the roll-up. submitted /
    -- partially_received / fully_received stay receivable (fully_received only via
    -- p_allow_over_receive, preserving the existing over-receive correction path).
    IF v_po_item.po_status IN ('draft', 'cancelled') THEN
      RAISE EXCEPTION 'Cannot receive against PO % -- status is % (draft/cancelled cannot be received)',
        v_po_item.po_number, v_po_item.po_status;
    END IF;

    IF NOT p_allow_over_receive
       AND (COALESCE(v_po_item.quantity_received, 0) + v_qty) > v_po_item.quantity_ordered THEN
      RAISE EXCEPTION 'Cannot receive more than ordered for item %. Ordered: %, Already received: %, Attempting: %',
        v_po_item.id, v_po_item.quantity_ordered, COALESCE(v_po_item.quantity_received, 0), v_qty;
    END IF;

    v_condition := COALESCE(v_item->>'condition', 'good');
    v_lot_number := v_item->>'lot_number';
    v_notes := v_item->>'notes';
    v_storage_location := COALESCE(v_item->>'storage_location', 'Main Warehouse');

    UPDATE inventory SET
      quantity_available = quantity_available + v_qty,
      quantity_on_order = GREATEST(COALESCE(quantity_on_order, 0) - v_qty, 0),
      updated_at = now()
    WHERE product_id = v_po_item.product_id AND location = v_storage_location;

    IF NOT FOUND THEN
      INSERT INTO inventory (product_id, location, quantity_available, quantity_on_order, quantity_prebooked, unit_size)
      VALUES (v_po_item.product_id, v_storage_location, v_qty, 0, 0, v_po_item.unit_size);
    END IF;

    INSERT INTO inventory_transactions (product_id, transaction_type, quantity, to_location,
      purchase_order_id, performed_by, notes)
    VALUES (v_po_item.product_id, 'received', v_qty, v_storage_location,
      v_po_item.po_parent_id, v_actor,
      'Received ' || v_qty || ' units via PO ' || COALESCE(v_po_item.po_number, ''));

    INSERT INTO receiving_records (purchase_order_id, po_item_id, product_id,
      quantity_received, received_by, notes, condition,
      lot_number, storage_location, unit_size)
    VALUES (v_po_item.po_parent_id, v_po_item.id, v_po_item.product_id,
      v_qty, v_actor, v_notes, v_condition,
      v_lot_number, v_storage_location, v_po_item.unit_size)
    RETURNING id INTO v_recv_id;

    v_receiving_record_ids := v_receiving_record_ids || to_jsonb(v_recv_id::text);

    IF NOT v_po_item.po_parent_id = ANY(v_affected_po_ids) THEN
      v_affected_po_ids := v_affected_po_ids || v_po_item.po_parent_id;
    END IF;

    UPDATE purchase_order_items SET
      quantity_received = COALESCE(quantity_received, 0) + v_qty
    WHERE id = v_po_item.id;
  END LOOP;

  FOREACH v_unique_po_id IN ARRAY (SELECT ARRAY(SELECT DISTINCT unnest(v_affected_po_ids)))
  LOOP
    SELECT COALESCE(SUM(quantity_ordered), 0), COALESCE(SUM(quantity_received), 0)
      INTO v_total_ordered, v_total_received
      FROM purchase_order_items WHERE purchase_order_id = v_unique_po_id;

    IF v_total_received >= v_total_ordered THEN
      UPDATE purchase_orders SET status = 'fully_received', updated_at = now()
      WHERE id = v_unique_po_id AND status != 'fully_received';
    ELSIF v_total_received > 0 THEN
      UPDATE purchase_orders SET status = 'partially_received', updated_at = now()
      WHERE id = v_unique_po_id AND status NOT IN ('partially_received', 'fully_received');
    END IF;
  END LOOP;

  v_result := jsonb_build_object('status', 'received', 'receiving_record_ids', v_receiving_record_ids);

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'receive_po_items', v_result);
  END IF;

  RETURN v_result;
END;
$function$;
