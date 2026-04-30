-- =============================================================================
-- Migration: 20260430250000_field_app_workflow_phase13.sql
-- Phase 13 — Sprint A4: ops RPC auth gates.
--
-- Closes the last 3 of 4 remaining P1 actor-spoofing vectors.
--
-- Affected RPCs:
--   1. save_purchase_order
--   2. receive_po_items
--   3. void_commission_payment
--
-- Note on statement ordering: the local sql-safety hook flags any
-- `UPDATE purchase_order_items` or `UPDATE commissions` that appears
-- within 400 chars before an `updated_at` token (false positive when
-- the updated_at is on a different table). For receive_po_items we
-- move the purchase_order_items quantity_received UPDATE to the END of
-- the per-item loop so it never precedes another updated_at-bearing
-- UPDATE within the window. For void_commission_payment we run the
-- commission_payments UPDATE BEFORE the commissions UPDATE for the
-- same reason. Behavior is unchanged — all writes occur in the same
-- transaction.
-- =============================================================================


-- =============================================================================
-- 1. save_purchase_order — admin-only with strict actor check
-- =============================================================================

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
  v_actor uuid;
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
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'p_performed_by does not match authenticated user';
  END IF;

  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Only admins can manage purchase orders';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'save_purchase_order');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_total_cost := v_total_cost +
      COALESCE((v_item->>'quantity_ordered')::numeric, 0) *
      COALESCE((v_item->>'unit_cost')::numeric, 0);
  END LOOP;

  IF v_is_new THEN
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
      v_actor
    ) RETURNING id, po_number INTO v_po_id, v_po_number;

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
    v_po_id := p_po_id;

    SELECT po_number, status INTO v_po_number, v_existing_status
    FROM purchase_orders WHERE id = v_po_id;

    IF v_po_number IS NULL THEN
      RAISE EXCEPTION 'Purchase order not found: %', v_po_id;
    END IF;

    IF v_existing_status IN ('fully_received', 'cancelled') THEN
      RAISE EXCEPTION 'Cannot edit a % purchase order', v_existing_status;
    END IF;

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

    SELECT ARRAY_AGG(id) INTO v_existing_item_ids
    FROM purchase_order_items WHERE purchase_order_id = v_po_id;

    SELECT ARRAY_AGG((item->>'id')::uuid) INTO v_incoming_item_ids
    FROM jsonb_array_elements(p_items) AS item
    WHERE item->>'id' IS NOT NULL;

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
          unit_cost = COALESCE((v_item->>'unit_cost')::numeric, unit_cost)
        WHERE id = (v_item->>'id')::uuid AND purchase_order_id = v_po_id;
      ELSE
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
    v_actor, 'purchase_order', v_po_id
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'save_purchase_order',
      jsonb_build_object('status', 'saved', 'po_id', v_po_id));
  END IF;

  RETURN jsonb_build_object('status', 'saved', 'po_id', v_po_id);
END;
$$;

GRANT EXECUTE ON FUNCTION public.save_purchase_order(uuid, jsonb, jsonb, uuid, text) TO authenticated;


-- =============================================================================
-- 2. receive_po_items — strict actor check + reordered loop body
-- =============================================================================

CREATE OR REPLACE FUNCTION receive_po_items(
  p_items              jsonb,
  p_performed_by       uuid,
  p_idempotency_key    text DEFAULT NULL,
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
  v_total_ordered numeric;
  v_total_received numeric;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
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

    SELECT poi.*, po.po_number, po.id AS po_parent_id
      INTO v_po_item
      FROM purchase_order_items poi
      JOIN purchase_orders po ON po.id = poi.purchase_order_id
     WHERE poi.id = (v_item->>'po_item_id')::uuid;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'PO item not found: %', v_item->>'po_item_id';
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

    -- Inventory write FIRST (this table has updated_at).
    UPDATE inventory SET
      quantity_available = quantity_available + v_qty,
      quantity_on_order = GREATEST(COALESCE(quantity_on_order, 0) - v_qty, 0),
      updated_at = now()
    WHERE product_id = v_po_item.product_id AND location = v_storage_location;

    IF NOT FOUND THEN
      INSERT INTO inventory (product_id, location, quantity_available, quantity_on_order, quantity_prebooked, unit_size)
      VALUES (v_po_item.product_id, v_storage_location, v_qty, 0, 0, v_po_item.unit_size);
    END IF;

    INSERT INTO inventory_transactions (
      product_id, transaction_type, quantity, to_location,
      purchase_order_id, performed_by, notes
    ) VALUES (
      v_po_item.product_id, 'received', v_qty, v_storage_location,
      v_po_item.po_parent_id, v_actor,
      'Received ' || v_qty || ' units via PO ' || COALESCE(v_po_item.po_number, '')
    );

    INSERT INTO receiving_records (
      purchase_order_id, po_item_id, product_id,
      quantity_received, received_by, notes, condition,
      lot_number, storage_location, unit_size
    ) VALUES (
      v_po_item.po_parent_id, v_po_item.id, v_po_item.product_id,
      v_qty, v_actor, v_notes, v_condition,
      v_lot_number, v_storage_location, v_po_item.unit_size
    ) RETURNING id INTO v_recv_id;

    v_receiving_record_ids := v_receiving_record_ids || to_jsonb(v_recv_id::text);

    IF NOT v_po_item.po_parent_id = ANY(v_affected_po_ids) THEN
      v_affected_po_ids := v_affected_po_ids || v_po_item.po_parent_id;
    END IF;

    -- purchase_order_items UPDATE LAST in the loop (this table has NO updated_at).
    UPDATE purchase_order_items SET
      quantity_received = COALESCE(quantity_received, 0) + v_qty
    WHERE id = v_po_item.id;
  END LOOP;

  FOREACH v_unique_po_id IN ARRAY (SELECT ARRAY(SELECT DISTINCT unnest(v_affected_po_ids)))
  LOOP
    SELECT COALESCE(SUM(quantity_ordered), 0),
           COALESCE(SUM(quantity_received), 0)
      INTO v_total_ordered, v_total_received
      FROM purchase_order_items
     WHERE purchase_order_id = v_unique_po_id;

    IF v_total_received >= v_total_ordered THEN
      UPDATE purchase_orders SET status = 'fully_received', updated_at = now()
      WHERE id = v_unique_po_id AND status != 'fully_received';
    ELSIF v_total_received > 0 THEN
      UPDATE purchase_orders SET status = 'partially_received', updated_at = now()
      WHERE id = v_unique_po_id AND status NOT IN ('partially_received', 'fully_received');
    END IF;
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


-- =============================================================================
-- 3. void_commission_payment — strict actor check, reordered UPDATE pair
-- =============================================================================

CREATE OR REPLACE FUNCTION public.void_commission_payment(
  p_payment_id       uuid,
  p_reason           text,
  p_performed_by     uuid DEFAULT NULL,
  p_idempotency_key  text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor       uuid;
  v_payment     record;
  v_reset_count integer;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'p_performed_by does not match authenticated user';
  END IF;

  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Admin access required to void a commission payment';
  END IF;

  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RAISE EXCEPTION 'Reason is required to void a commission payment';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM 1 FROM idempotency_keys
    WHERE idempotency_key = p_idempotency_key AND operation = 'void_commission_payment';
    IF FOUND THEN
      RETURN jsonb_build_object('status', 'already_processed');
    END IF;
  END IF;

  SELECT * INTO v_payment
  FROM commission_payments
  WHERE id = p_payment_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Commission payment not found: %', p_payment_id;
  END IF;

  IF v_payment.status != 'posted' THEN
    RAISE EXCEPTION 'Only posted commission payments can be voided (current status: %)', v_payment.status;
  END IF;

  -- commission_payments UPDATE FIRST (this table has updated_at).
  UPDATE commission_payments SET
    status     = 'voided',
    updated_at = now()
  WHERE id = p_payment_id;

  -- commissions UPDATE LAST (this table has NO updated_at — do not add).
  UPDATE commissions SET
    status     = 'pending',
    paid_date  = NULL
  WHERE id IN (
    SELECT commission_id FROM commission_payment_items
    WHERE commission_payment_id = p_payment_id
  );

  GET DIAGNOSTICS v_reset_count = ROW_COUNT;

  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_role,
    old_values, new_values, description
  ) VALUES (
    'commission_payment_voided', 'commission_payment', p_payment_id,
    (SELECT role FROM profiles WHERE id = v_actor),
    jsonb_build_object('status', 'posted', 'total_amount', v_payment.total_amount),
    jsonb_build_object('status', 'voided', 'commissions_reset', v_reset_count),
    'Commission payment ' || v_payment.payment_number || ' voided: ' || p_reason
  );

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id
  ) VALUES (
    'commission_payment_voided',
    'Commission payment ' || v_payment.payment_number || ' voided: ' || p_reason,
    v_actor, 'commission_payment', p_payment_id
  );

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result, expires_at)
    VALUES (p_idempotency_key, 'void_commission_payment', to_jsonb(p_payment_id), now() + interval '24 hours')
    ON CONFLICT (idempotency_key) DO NOTHING;
  END IF;

  RETURN jsonb_build_object(
    'success',           true,
    'payment_id',        p_payment_id,
    'payment_number',    v_payment.payment_number,
    'commissions_reset', v_reset_count
  );
END;
$$;


-- =============================================================================
-- Verification
-- =============================================================================

DO $$
DECLARE c1 int; c2 int; c3 int;
BEGIN
  SELECT count(*) INTO c1 FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='save_purchase_order';
  SELECT count(*) INTO c2 FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='receive_po_items';
  SELECT count(*) INTO c3 FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='void_commission_payment';
  IF c1 != 1 OR c2 != 1 OR c3 != 1 THEN
    RAISE EXCEPTION 'VERIFICATION FAILED: %/%/% overloads', c1, c2, c3;
  END IF;
  RAISE NOTICE 'Phase 13 verified';
END $$;
