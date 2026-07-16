-- Follow-up to the money/inventory gauntlet review: new purchase orders must
-- begin as drafts. Submission is a separate status-only RPC, and receiving is
-- the only workflow allowed to advance a PO into a received status.

CREATE OR REPLACE FUNCTION public.save_purchase_order(p_po_id uuid, p_po_payload jsonb, p_items jsonb, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid; v_po_id uuid;
  v_is_new boolean := (p_po_id IS NULL);
  v_item jsonb; v_total_cost numeric := 0;
  v_po_number text; v_existing_status text; v_new_status text;
  v_existing_item_ids uuid[]; v_incoming_item_ids uuid[];
  v_items_to_delete uuid[]; v_existing jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'p_performed_by does not match authenticated user';
  END IF;
  IF NOT (is_admin() OR is_sales_rep()) THEN
    RAISE EXCEPTION 'Only admins or sales reps can manage purchase orders';
  END IF;

  IF v_is_new AND COALESCE(p_po_payload->>'status', 'draft') <> 'draft' THEN
    RAISE EXCEPTION 'INVALID_INITIAL_PO_STATUS: new purchase orders must start as draft'
      USING ERRCODE = 'P0001';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'save_purchase_order');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  -- Once any quantity has been received, the product, ordered quantity, unit,
  -- and cost are accounting evidence. Corrections must use the receiving
  -- reversal/adjustment workflow instead of rewriting the original PO line.
  IF NOT v_is_new THEN
    PERFORM 1 FROM purchase_orders WHERE id = p_po_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Purchase order not found: %', p_po_id; END IF;

    IF EXISTS (
      SELECT 1
      FROM purchase_order_items existing
      WHERE existing.purchase_order_id = p_po_id
        AND existing.quantity_received > 0
        AND (
          NOT EXISTS (
            SELECT 1
            FROM jsonb_array_elements(p_items) incoming
            WHERE incoming->>'id' = existing.id::text
          )
          OR EXISTS (
            SELECT 1
            FROM jsonb_array_elements(p_items) incoming
            WHERE incoming->>'id' = existing.id::text
              AND (
                incoming->>'product_id' IS DISTINCT FROM existing.product_id::text
                OR NULLIF(incoming->>'quantity_ordered', '')::numeric IS DISTINCT FROM existing.quantity_ordered
                OR NULLIF(incoming->>'unit_cost', '')::numeric IS DISTINCT FROM existing.unit_cost
                OR incoming->>'unit_size' IS DISTINCT FROM existing.unit_size
              )
          )
        )
    ) THEN
      RAISE EXCEPTION 'RECEIVED_PO_LINE_IMMUTABLE: reverse the receiving record before changing or removing a received PO line'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_total_cost := v_total_cost +
      COALESCE((v_item->>'quantity_ordered')::numeric, 0) *
      COALESCE((v_item->>'unit_cost')::numeric, 0);
  END LOOP;

  IF v_is_new THEN
    INSERT INTO purchase_orders (po_number, vendor, status, submitted_date,
      expected_delivery_date, notes, total_cost, created_by)
    VALUES (
      p_po_payload->>'po_number', p_po_payload->>'vendor',
      'draft',
      (p_po_payload->>'submitted_date')::date,
      (p_po_payload->>'expected_delivery_date')::date,
      NULLIF(p_po_payload->>'notes', ''),
      v_total_cost, v_actor
    ) RETURNING id, po_number INTO v_po_id, v_po_number;

    INSERT INTO purchase_order_items (purchase_order_id, product_id, product_name, unit_size,
      quantity_ordered, unit_cost, quantity_received, notes)
    SELECT v_po_id, (item->>'product_id')::uuid, item->>'product_name', item->>'unit_size',
      COALESCE((item->>'quantity_ordered')::numeric, 0),
      COALESCE((item->>'unit_cost')::numeric, 0), 0, NULLIF(item->>'notes', '')
    FROM jsonb_array_elements(p_items) AS item
    WHERE (item->>'product_id') IS NOT NULL;

    v_new_status := 'draft';
  ELSE
    v_po_id := p_po_id;
    SELECT po_number, status INTO v_po_number, v_existing_status FROM purchase_orders WHERE id = v_po_id;
    IF v_po_number IS NULL THEN RAISE EXCEPTION 'Purchase order not found: %', v_po_id; END IF;
    IF v_existing_status IN ('fully_received', 'cancelled') THEN
      RAISE EXCEPTION 'Cannot edit a % purchase order', v_existing_status;
    END IF;

    v_new_status := p_po_payload->>'status';
    IF v_new_status IS NOT NULL AND v_new_status <> v_existing_status THEN
      RAISE EXCEPTION 'PO_STATUS_RPC_REQUIRED: use submit, receive, or cancel purchase-order workflow'
        USING ERRCODE = 'P0001';
    END IF;

    UPDATE purchase_orders SET
      vendor = COALESCE(p_po_payload->>'vendor', vendor),
      status = COALESCE(p_po_payload->>'status', status),
      submitted_date = CASE
        WHEN v_existing_status = 'draft' AND v_new_status = 'submitted'
          THEN (now() AT TIME ZONE 'America/Chicago')::date
        ELSE COALESCE((p_po_payload->>'submitted_date')::date, submitted_date)
      END,
      expected_delivery_date = COALESCE((p_po_payload->>'expected_delivery_date')::date, expected_delivery_date),
      notes = CASE WHEN p_po_payload ? 'notes' THEN NULLIF(p_po_payload->>'notes', '') ELSE notes END,
      total_cost = v_total_cost,
      updated_at = now()
    WHERE id = v_po_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Purchase order not found: %', v_po_id; END IF;

    SELECT ARRAY_AGG(id) INTO v_existing_item_ids
    FROM purchase_order_items WHERE purchase_order_id = v_po_id;

    SELECT ARRAY_AGG((item->>'id')::uuid) INTO v_incoming_item_ids
    FROM jsonb_array_elements(p_items) AS item WHERE item->>'id' IS NOT NULL;

    IF v_existing_item_ids IS NOT NULL THEN
      v_items_to_delete := ARRAY(
        SELECT poi.id FROM purchase_order_items poi
        WHERE poi.purchase_order_id = v_po_id
          AND (v_incoming_item_ids IS NULL OR poi.id != ALL(v_incoming_item_ids))
          AND poi.quantity_received = 0
          AND NOT EXISTS (SELECT 1 FROM receiving_records rr WHERE rr.po_item_id = poi.id)
      );
      IF array_length(v_items_to_delete, 1) > 0 THEN
        DELETE FROM purchase_order_items WHERE id = ANY(v_items_to_delete);
      END IF;
    END IF;

    FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
      IF v_item->>'id' IS NOT NULL AND (v_item->>'id')::uuid = ANY(COALESCE(v_existing_item_ids, '{}')) THEN
        UPDATE purchase_order_items SET
          product_id = (v_item->>'product_id')::uuid,
          product_name = v_item->>'product_name',
          unit_size = COALESCE(v_item->>'unit_size', unit_size),
          quantity_ordered = COALESCE((v_item->>'quantity_ordered')::numeric, quantity_ordered),
          unit_cost = COALESCE((v_item->>'unit_cost')::numeric, unit_cost),
          notes = CASE WHEN v_item ? 'notes' THEN NULLIF(v_item->>'notes', '') ELSE notes END
        WHERE id = (v_item->>'id')::uuid AND purchase_order_id = v_po_id;
      ELSE
        INSERT INTO purchase_order_items (purchase_order_id, product_id, product_name, unit_size,
          quantity_ordered, unit_cost, quantity_received, notes)
        VALUES (v_po_id, (v_item->>'product_id')::uuid, v_item->>'product_name', v_item->>'unit_size',
          COALESCE((v_item->>'quantity_ordered')::numeric, 0),
          COALESCE((v_item->>'unit_cost')::numeric, 0), 0, NULLIF(v_item->>'notes', ''));
      END IF;
    END LOOP;
  END IF;

  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id)
  VALUES (
    CASE
      WHEN v_is_new THEN 'po_created'
      ELSE 'po_updated'
    END,
    CASE
      WHEN v_is_new THEN 'PO ' || COALESCE(v_po_number, '') || ' created'
      ELSE 'PO ' || COALESCE(v_po_number, '') || ' updated'
    END,
    v_actor, 'purchase_order', v_po_id
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'save_purchase_order',
      jsonb_build_object('status', 'saved', 'po_id', v_po_id));
  END IF;

  RETURN jsonb_build_object('status', 'saved', 'po_id', v_po_id);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.save_purchase_order(uuid, jsonb, jsonb, uuid, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_purchase_order(uuid, jsonb, jsonb, uuid, text)
  TO authenticated, service_role;
