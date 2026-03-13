-- ============================================================================
-- Fix: save_purchase_order fails on partially_received POs
--
-- BUG: The RPC does DELETE FROM purchase_order_items then re-inserts.
-- When receiving_records exist (FK on po_item_id), the DELETE fails with
-- a foreign key violation. This blocks ALL edits on partially received POs.
--
-- FIX: For existing POs, UPDATE items in-place instead of delete/re-insert.
-- Items that have been received (quantity_received > 0) keep their IDs intact.
-- Unreceived items can be swapped, updated, or removed freely.
-- New items can be added.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.save_purchase_order(
  p_po_id uuid,
  p_po_payload jsonb,
  p_items jsonb,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_po_id uuid;
  v_is_new boolean := (p_po_id IS NULL);
  v_item jsonb;
  v_total_cost numeric := 0;
  v_po_number text;
  v_existing_status text;
  v_new_status text;
  v_existing_item_ids uuid[];
  v_incoming_item_ids uuid[];
  v_items_to_delete uuid[];
  v_existing jsonb;
BEGIN
  -- Verify caller is admin
  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = p_performed_by AND role = 'admin' AND is_active = true
  ) THEN
    RAISE EXCEPTION 'Only admins can manage purchase orders';
  END IF;

  -- Idempotency check
  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'save_purchase_order');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  -- Calculate total cost from items
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_total_cost := v_total_cost +
      COALESCE((v_item->>'quantity_ordered')::numeric, 0) *
      COALESCE((v_item->>'unit_cost')::numeric, 0);
  END LOOP;

  IF v_is_new THEN
    -- CREATE new PO
    INSERT INTO purchase_orders (
      po_number, vendor, status, submitted_date,
      expected_delivery_date, notes, total_cost, created_by
    ) VALUES (
      p_po_payload->>'po_number',
      p_po_payload->>'vendor',
      COALESCE(p_po_payload->>'status', 'draft'),
      (p_po_payload->>'submitted_date')::date,
      (p_po_payload->>'expected_delivery_date')::date,
      NULLIF(p_po_payload->>'notes', ''),
      v_total_cost,
      p_performed_by
    ) RETURNING id, po_number INTO v_po_id, v_po_number;

    -- Insert all items (new PO, no FK concerns)
    INSERT INTO purchase_order_items (
      purchase_order_id, product_id, product_name, unit_size,
      quantity_ordered, unit_cost, quantity_received
    )
    SELECT
      v_po_id,
      (item->>'product_id')::uuid,
      item->>'product_name',
      item->>'unit_size',
      COALESCE((item->>'quantity_ordered')::numeric, 0),
      COALESCE((item->>'unit_cost')::numeric, 0),
      0
    FROM jsonb_array_elements(p_items) AS item
    WHERE (item->>'product_id') IS NOT NULL;

  ELSE
    -- UPDATE existing PO
    v_po_id := p_po_id;

    SELECT po_number, status INTO v_po_number, v_existing_status
    FROM purchase_orders WHERE id = v_po_id;

    IF v_po_number IS NULL THEN
      RAISE EXCEPTION 'Purchase order not found: %', v_po_id;
    END IF;

    -- Block edits to terminal states
    IF v_existing_status IN ('fully_received', 'cancelled') THEN
      RAISE EXCEPTION 'Cannot edit a % purchase order', v_existing_status;
    END IF;

    -- Block backward status transitions
    v_new_status := p_po_payload->>'status';
    IF v_new_status IS NOT NULL AND v_new_status <> v_existing_status THEN
      IF NOT (
        (v_existing_status = 'draft' AND v_new_status IN ('submitted', 'cancelled')) OR
        (v_existing_status = 'submitted' AND v_new_status IN ('partially_received', 'fully_received', 'cancelled')) OR
        (v_existing_status = 'partially_received' AND v_new_status IN ('fully_received', 'cancelled'))
      ) THEN
        RAISE EXCEPTION 'Invalid PO status transition: % → %', v_existing_status, v_new_status;
      END IF;
    END IF;

    -- Update PO header
    UPDATE purchase_orders SET
      vendor = COALESCE(p_po_payload->>'vendor', vendor),
      status = COALESCE(p_po_payload->>'status', status),
      submitted_date = COALESCE((p_po_payload->>'submitted_date')::date, submitted_date),
      expected_delivery_date = COALESCE((p_po_payload->>'expected_delivery_date')::date, expected_delivery_date),
      notes = CASE WHEN p_po_payload ? 'notes'
        THEN NULLIF(p_po_payload->>'notes', '')
        ELSE notes
      END,
      total_cost = v_total_cost,
      updated_at = now()
    WHERE id = v_po_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Purchase order not found: %', v_po_id;
    END IF;

    -- *** FIX: Smart item update instead of destructive DELETE + re-INSERT ***

    -- Collect existing item IDs
    SELECT ARRAY_AGG(id) INTO v_existing_item_ids
    FROM purchase_order_items WHERE purchase_order_id = v_po_id;

    -- Collect incoming item IDs (items that already have an id)
    SELECT ARRAY_AGG((item->>'id')::uuid) INTO v_incoming_item_ids
    FROM jsonb_array_elements(p_items) AS item
    WHERE item->>'id' IS NOT NULL;

    -- Delete items that are NOT in the incoming list AND have no receiving records
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

    -- Update existing items or insert new ones
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
      IF v_item->>'id' IS NOT NULL AND (v_item->>'id')::uuid = ANY(COALESCE(v_existing_item_ids, '{}')) THEN
        -- Update existing item
        UPDATE purchase_order_items SET
          product_id = (v_item->>'product_id')::uuid,
          product_name = v_item->>'product_name',
          unit_size = COALESCE(v_item->>'unit_size', unit_size),
          quantity_ordered = COALESCE((v_item->>'quantity_ordered')::numeric, quantity_ordered),
          unit_cost = COALESCE((v_item->>'unit_cost')::numeric, unit_cost)
          -- NOTE: quantity_received is NOT updated here — that's only changed by receive_po_items
        WHERE id = (v_item->>'id')::uuid AND purchase_order_id = v_po_id;
      ELSE
        -- Insert new item
        INSERT INTO purchase_order_items (
          purchase_order_id, product_id, product_name, unit_size,
          quantity_ordered, unit_cost, quantity_received
        ) VALUES (
          v_po_id,
          (v_item->>'product_id')::uuid,
          v_item->>'product_name',
          v_item->>'unit_size',
          COALESCE((v_item->>'quantity_ordered')::numeric, 0),
          COALESCE((v_item->>'unit_cost')::numeric, 0),
          0
        );
      END IF;
    END LOOP;
  END IF;

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id
  ) VALUES (
    CASE WHEN v_is_new THEN 'po_created' ELSE 'po_updated' END,
    CASE WHEN v_is_new
      THEN 'PO ' || COALESCE(v_po_number, '') || ' created'
      ELSE 'PO ' || COALESCE(v_po_number, '') || ' updated'
    END,
    p_performed_by, 'purchase_order', v_po_id
  );

  v_po_id := v_po_id;  -- ensure not null

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'save_purchase_order',
      jsonb_build_object('status', 'saved', 'po_id', v_po_id));
  END IF;

  RETURN jsonb_build_object('status', 'saved', 'po_id', v_po_id);
END;
$$;

GRANT EXECUTE ON FUNCTION public.save_purchase_order(uuid, jsonb, jsonb, uuid, text) TO authenticated;
