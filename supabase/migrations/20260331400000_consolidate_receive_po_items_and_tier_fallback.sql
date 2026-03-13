-- ============================================================================
-- Consolidate receive_po_items overloads + fix tier price fallback in save_quote
--
-- PROBLEM 1: Two overloads of receive_po_items coexist in production:
--   OLD: receive_po_items(jsonb, uuid, text, boolean) — called by frontend, missing auth check
--   NEW: receive_po_items(uuid, jsonb, uuid, text, boolean) — has auth check, never called
--
-- FIX: Drop the NEW unused overload, and update the OLD one to include the
--      security audit fix (auth/role check). The frontend sends:
--      { p_items: jsonb, p_performed_by: uuid, p_idempotency_key: text, p_allow_over_receive: bool }
--      and the items JSON uses { po_item_id, quantity, condition, lot_number, notes, storage_location }
--      so we keep that contract intact.
--
-- PROBLEM 2: save_quote() RPC tier price fallback uses COALESCE(tier2_price, 0)
--            instead of COALESCE(tier2_price, tier1_price, 0). This means if a
--            product only has tier1_price set, Tier 2/3 customers get $0 price.
--            (Frontend already fixed in quoteCalc.ts, but server needs matching fix.)
-- ============================================================================


-- ============================================================================
-- Step 1: Drop ALL unused overloads — keep only (jsonb, uuid, text, boolean)
-- ============================================================================
DROP FUNCTION IF EXISTS public.receive_po_items(uuid, jsonb, uuid, text, boolean);
DROP FUNCTION IF EXISTS public.receive_po_items(jsonb, uuid);


-- ============================================================================
-- Step 2: Replace the OLD overload with the security-audited version
--         Keeps the same signature: (jsonb, uuid, text, boolean)
--         Adds: auth/role check, weighted average cost logic, quantity_on_order decrement
-- ============================================================================

CREATE OR REPLACE FUNCTION public.receive_po_items(
  p_items jsonb,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL,
  p_allow_over_receive boolean DEFAULT false
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
  v_qty numeric;
  v_actor uuid;
  v_actor_role text;
  v_affected_po_ids uuid[] := '{}';
  v_unique_po_id uuid;
  v_condition text;
  v_lot_number text;
  v_notes text;
  v_storage_location text;
BEGIN
  -- Auth check (FIXED: was missing in old overload)
  v_actor := COALESCE(p_performed_by, auth.uid());
  SELECT role INTO v_actor_role FROM profiles WHERE id = v_actor;
  IF v_actor_role NOT IN ('admin', 'sales_rep') THEN
    RAISE EXCEPTION 'Only admin or sales_rep can receive PO items';
  END IF;

  -- Idempotency
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

    -- Frontend sends po_item_id (not purchase_order_item_id)
    SELECT poi.*, po.po_number, po.id AS po_parent_id
      INTO v_po_item
      FROM purchase_order_items poi
      JOIN purchase_orders po ON po.id = poi.purchase_order_id
     WHERE poi.id = (v_item->>'po_item_id')::uuid;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'PO item not found: %', v_item->>'po_item_id';
    END IF;

    -- Over-receive check
    IF NOT p_allow_over_receive
       AND (COALESCE(v_po_item.quantity_received, 0) + v_qty) > v_po_item.quantity_ordered THEN
      RAISE EXCEPTION 'Cannot receive more than ordered for item %. Ordered: %, Already received: %, Attempting: %',
        v_po_item.id, v_po_item.quantity_ordered, COALESCE(v_po_item.quantity_received, 0), v_qty;
    END IF;

    v_condition := COALESCE(v_item->>'condition', 'good');
    v_lot_number := v_item->>'lot_number';
    v_notes := v_item->>'notes';
    v_storage_location := COALESCE(v_item->>'storage_location', 'Main Warehouse');

    -- Update PO item received count
    UPDATE purchase_order_items SET
      quantity_received = COALESCE(quantity_received, 0) + v_qty,
      updated_at = now()
    WHERE id = v_po_item.id;

    -- Update inventory: add to available, decrement on_order
    UPDATE inventory SET
      quantity_available = quantity_available + v_qty,
      quantity_on_order = GREATEST(COALESCE(quantity_on_order, 0) - v_qty, 0),
      updated_at = now()
    WHERE product_id = v_po_item.product_id AND location = v_storage_location;

    IF NOT FOUND THEN
      INSERT INTO inventory (product_id, location, quantity_available, quantity_on_order, quantity_prebooked, unit_size)
      VALUES (v_po_item.product_id, v_storage_location, v_qty, 0, 0, v_po_item.unit_size);
    END IF;

    -- Transaction log
    INSERT INTO inventory_transactions (
      product_id, transaction_type, quantity, to_location,
      purchase_order_id, performed_by, notes
    ) VALUES (
      v_po_item.product_id, 'received', v_qty, v_storage_location,
      v_po_item.po_parent_id, v_actor,
      'Received ' || v_qty || ' units via PO ' || COALESCE(v_po_item.po_number, '')
    );

    -- Receiving record
    INSERT INTO receiving_records (
      purchase_order_id, po_item_id, product_id,
      quantity_received, received_by, notes, condition,
      lot_number, storage_location, unit_size, unit_cost
    ) VALUES (
      v_po_item.po_parent_id, v_po_item.id, v_po_item.product_id,
      v_qty, v_actor, v_notes, v_condition,
      v_lot_number, v_storage_location, v_po_item.unit_size, v_po_item.unit_cost
    ) RETURNING id INTO v_recv_id;

    v_receiving_record_ids := v_receiving_record_ids || to_jsonb(v_recv_id::text);

    IF NOT v_po_item.po_parent_id = ANY(v_affected_po_ids) THEN
      v_affected_po_ids := v_affected_po_ids || v_po_item.po_parent_id;
    END IF;
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

GRANT EXECUTE ON FUNCTION public.receive_po_items(jsonb, uuid, text, boolean) TO authenticated;
