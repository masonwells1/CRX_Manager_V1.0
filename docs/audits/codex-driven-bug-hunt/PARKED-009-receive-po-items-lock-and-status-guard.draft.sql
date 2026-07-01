-- PARKED-009 (codex-driven hunt cycle 6) — DRAFT, NOT APPLIED.
-- receive_po_items has a TOCTOU race: it reads purchase_order_items.quantity_received
-- with NO row lock, checks the per-item over-receive cap against that stale value, then
-- increments inventory + quantity_received. Two concurrent receives of the SAME po_item
-- (double-click, or two receivers) can BOTH pass the over-receive check on the stale
-- value and both add — over-receiving past quantity_ordered AND double-incrementing
-- inventory. Fix: lock the po_item row (FOR UPDATE OF poi) so concurrent receives
-- serialize and the second re-reads the updated quantity_received before its check.
-- Also adds an explicit PO-status guard (submitted / partially_received) so a receive
-- against a draft/cancelled/fully_received PO fails fast BEFORE any inventory write
-- (today it only fails later when the status-transition trigger rejects the roll-up,
-- after the inventory rows were already touched in-transaction).
--
-- Only changes vs the live definition: (1) "po.status AS po_status" added to the
-- per-item SELECT, (2) "FOR UPDATE OF poi" on that SELECT, (3) the status guard block.
-- Touches inventory + money-adjacent flow -> must clear the migration-review + Codex
-- gate before apply.

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

    -- PARKED-009: lock the po_item row so concurrent receives serialize (closes the
    -- over-receive / double-increment TOCTOU race). Also pull po.status for the guard.
    SELECT poi.*, po.po_number, po.id AS po_parent_id, po.status AS po_status
      INTO v_po_item
      FROM purchase_order_items poi
      JOIN purchase_orders po ON po.id = poi.purchase_order_id
     WHERE poi.id = (v_item->>'po_item_id')::uuid
     FOR UPDATE OF poi;

    IF NOT FOUND THEN RAISE EXCEPTION 'PO item not found: %', v_item->>'po_item_id'; END IF;

    -- PARKED-009: fail fast on a PO that is not in a receivable state.
    IF v_po_item.po_status NOT IN ('submitted', 'partially_received') THEN
      RAISE EXCEPTION 'Cannot receive against PO % — status is % (must be submitted or partially_received)',
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
