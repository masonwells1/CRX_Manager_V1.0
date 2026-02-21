-- ============================================================================
-- Production Fixes V2
-- Migration: 20260308200000_production_fixes_v2.sql
--
-- Fix 1: receive_po_items() — column "key" → "idempotency_key" (Issue 4)
-- Fix 2: next_return_number() — sequential RMA number generator (Issue 5)
-- Fix 3: Storage buckets + RLS policies (Issue 6B)
-- Fix 4: check_duplicate_delivery() — advisory helper (Issue 7)
-- ============================================================================


-- ============================================================================
-- FIX 1: Recreate receive_po_items() with correct idempotency column name
-- Bug: Lines 306-308 in 20260304200000 used column "key" instead of "idempotency_key"
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

  -- Save idempotency result if key was provided (FIXED: was "key", now "idempotency_key")
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'receive_po_items', v_result);
  END IF;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION receive_po_items(jsonb, uuid, text, boolean) TO authenticated;


-- ============================================================================
-- FIX 2: next_return_number()
-- Sequential RMA number generator using advisory locks
-- Format: RMA-YYYY-NNNN (year-scoped, zero-padded 4 digits)
-- ============================================================================

CREATE OR REPLACE FUNCTION next_return_number()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_year text;
  v_max_num int;
  v_next text;
BEGIN
  v_year := extract(year FROM current_date)::text;

  -- Advisory lock to serialize access
  PERFORM pg_advisory_xact_lock(hashtext('next_return_number'));

  -- Find the current max numeric suffix for the current year
  SELECT COALESCE(
    MAX(
      CASE
        WHEN return_number ~ ('^RMA-' || v_year || '-\d+$')
        THEN CAST(split_part(return_number, '-', 3) AS int)
        ELSE 0
      END
    ),
    0
  )
  INTO v_max_num
  FROM returns;

  v_next := 'RMA-' || v_year || '-' || lpad((v_max_num + 1)::text, 4, '0');

  RETURN v_next;
END;
$$;

GRANT EXECUTE ON FUNCTION next_return_number() TO authenticated;


-- ============================================================================
-- FIX 3: Storage Buckets + RLS Policies
-- Create missing buckets: delivery-photos, delivery-signatures, blend-ticket-images
-- ============================================================================

-- Create buckets (private, not public)
INSERT INTO storage.buckets (id, name, public)
VALUES ('delivery-photos', 'delivery-photos', false)
ON CONFLICT (id) DO NOTHING;

INSERT INTO storage.buckets (id, name, public)
VALUES ('delivery-signatures', 'delivery-signatures', false)
ON CONFLICT (id) DO NOTHING;

INSERT INTO storage.buckets (id, name, public)
VALUES ('blend-ticket-images', 'blend-ticket-images', false)
ON CONFLICT (id) DO NOTHING;

-- RLS policies for delivery-photos
CREATE POLICY "delivery_photos_insert" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'delivery-photos');

CREATE POLICY "delivery_photos_select" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'delivery-photos');

CREATE POLICY "delivery_photos_delete" ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'delivery-photos'
    AND EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid() AND role IN ('admin', 'sales_rep')
    )
  );

-- RLS policies for delivery-signatures
CREATE POLICY "delivery_signatures_insert" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'delivery-signatures');

CREATE POLICY "delivery_signatures_select" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'delivery-signatures');

CREATE POLICY "delivery_signatures_delete" ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'delivery-signatures'
    AND EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid() AND role IN ('admin', 'sales_rep')
    )
  );

-- RLS policies for blend-ticket-images
CREATE POLICY "blend_ticket_images_insert" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'blend-ticket-images');

CREATE POLICY "blend_ticket_images_select" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'blend-ticket-images');

CREATE POLICY "blend_ticket_images_delete" ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'blend-ticket-images'
    AND EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid() AND role IN ('admin', 'sales_rep')
    )
  );


-- ============================================================================
-- FIX 4: check_duplicate_delivery()
-- Returns existing active deliveries for an order (for frontend warning)
-- ============================================================================

CREATE OR REPLACE FUNCTION check_duplicate_delivery(p_order_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result jsonb;
BEGIN
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'delivery_id', d.id,
    'delivery_number', d.delivery_number,
    'status', d.status,
    'scheduled_date', d.scheduled_date
  )), '[]'::jsonb)
  INTO v_result
  FROM deliveries d
  WHERE d.order_id = p_order_id
    AND d.status IN ('scheduled', 'in_progress');

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION check_duplicate_delivery(uuid) TO authenticated;
