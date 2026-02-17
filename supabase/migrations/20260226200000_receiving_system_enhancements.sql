-- ============================================================================
-- Sprint 19: Receiving System Enhancement
-- Migration: 20260226200000_receiving_system_enhancements.sql
--
-- New tables: receiving_records, receiving_photos
-- Enhanced RPC: receive_po_items (per-item notes/condition/lot, sales_rep access)
-- New RPCs: get_receiving_log, get_receiving_summary
-- RLS: sales_rep can now SELECT purchase_orders + purchase_order_items
-- Storage: receiving-photos bucket
-- ============================================================================

-- ============================================================================
-- SECTION 1: receiving_records table
-- ============================================================================

CREATE TABLE IF NOT EXISTS receiving_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_order_id uuid NOT NULL REFERENCES purchase_orders(id),
  po_item_id uuid NOT NULL REFERENCES purchase_order_items(id),
  product_id uuid NOT NULL REFERENCES products(id),
  quantity_received numeric NOT NULL CHECK (quantity_received > 0),
  received_by uuid NOT NULL REFERENCES profiles(id),
  received_at timestamptz NOT NULL DEFAULT now(),
  notes text,
  condition text NOT NULL DEFAULT 'good'
    CHECK (condition IN ('good', 'damaged', 'short', 'wrong_product', 'mixed')),
  lot_number text,
  storage_location text NOT NULL DEFAULT 'Main Warehouse',
  unit_size text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE receiving_records ENABLE ROW LEVEL SECURITY;

CREATE INDEX idx_recv_records_po ON receiving_records(purchase_order_id);
CREATE INDEX idx_recv_records_po_item ON receiving_records(po_item_id);
CREATE INDEX idx_recv_records_product ON receiving_records(product_id);
CREATE INDEX idx_recv_records_received_at ON receiving_records(received_at);
CREATE INDEX idx_recv_records_received_by ON receiving_records(received_by);
CREATE INDEX idx_recv_records_condition ON receiving_records(condition)
  WHERE condition <> 'good';

-- RLS: Admin full access
CREATE POLICY "recv_records_admin_all" ON receiving_records
  FOR ALL TO authenticated USING (is_admin()) WITH CHECK (is_admin());

-- RLS: Sales rep can view + insert
CREATE POLICY "recv_records_rep_select" ON receiving_records
  FOR SELECT TO authenticated USING (is_sales_rep());
CREATE POLICY "recv_records_rep_insert" ON receiving_records
  FOR INSERT TO authenticated WITH CHECK (is_sales_rep());

-- ============================================================================
-- SECTION 2: receiving_photos table
-- ============================================================================

CREATE TABLE IF NOT EXISTS receiving_photos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receiving_record_id uuid NOT NULL REFERENCES receiving_records(id) ON DELETE CASCADE,
  storage_path text NOT NULL,
  image_url text NOT NULL,
  caption text,
  uploaded_by uuid NOT NULL REFERENCES profiles(id),
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  file_size integer,
  sort_order integer NOT NULL DEFAULT 0
);

ALTER TABLE receiving_photos ENABLE ROW LEVEL SECURITY;

CREATE INDEX idx_recv_photos_record ON receiving_photos(receiving_record_id);

-- RLS: Admin full access
CREATE POLICY "recv_photos_admin_all" ON receiving_photos
  FOR ALL TO authenticated USING (is_admin()) WITH CHECK (is_admin());

-- RLS: Sales rep can view + insert
CREATE POLICY "recv_photos_rep_select" ON receiving_photos
  FOR SELECT TO authenticated USING (is_sales_rep());
CREATE POLICY "recv_photos_rep_insert" ON receiving_photos
  FOR INSERT TO authenticated WITH CHECK (is_sales_rep());

-- ============================================================================
-- SECTION 3: Storage bucket for receiving photos
-- ============================================================================

INSERT INTO storage.buckets (id, name, public)
VALUES ('receiving-photos', 'receiving-photos', true)
ON CONFLICT (id) DO NOTHING;

-- Storage policies for receiving-photos bucket
CREATE POLICY "recv_photos_storage_upload" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'receiving-photos');

CREATE POLICY "recv_photos_storage_read" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'receiving-photos');

CREATE POLICY "recv_photos_storage_delete" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'receiving-photos');

-- ============================================================================
-- SECTION 4: Expand PO RLS — sales_rep can now view POs
-- ============================================================================

CREATE POLICY "po_rep_select" ON purchase_orders
  FOR SELECT TO authenticated USING (is_sales_rep());

CREATE POLICY "po_items_rep_select" ON purchase_order_items
  FOR SELECT TO authenticated USING (is_sales_rep());

-- ============================================================================
-- SECTION 5: Enhanced receive_po_items() RPC
-- Now creates receiving_records entries, accepts per-item details,
-- allows sales_rep role, returns receiving_record_ids for photo attachment
-- ============================================================================

CREATE OR REPLACE FUNCTION receive_po_items(
  p_items jsonb,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL
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
BEGIN
  -- Check idempotency key if provided
  IF p_idempotency_key IS NOT NULL THEN
    v_cached_result := check_idempotency(p_idempotency_key, 'receive_po_items');
    IF v_cached_result IS NOT NULL THEN
      RETURN v_cached_result;
    END IF;
  END IF;

  -- Verify caller is admin OR sales_rep (expanded from admin-only)
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

    -- Validate not receiving more than ordered
    IF v_po_item.quantity_received + v_qty > v_po_item.quantity_ordered THEN
      RAISE EXCEPTION 'Cannot receive more than ordered for item %', v_po_item.id;
    END IF;

    v_po_id := v_po_item.purchase_order_id;

    -- Extract optional per-item fields (backward compatible — defaults if absent)
    v_condition := COALESCE(v_item->>'condition', 'good');
    v_lot_number := v_item->>'lot_number';
    v_notes := v_item->>'notes';
    v_storage_location := COALESCE(v_item->>'storage_location', 'Main Warehouse');

    -- Update PO item received count
    UPDATE purchase_order_items SET
      quantity_received = quantity_received + v_qty
    WHERE id = v_po_item.id;

    -- Update inventory (atomic increment, use storage_location instead of hardcoded)
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

    -- Create receiving record (NEW — event-level tracking)
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

    -- Collect receiving record IDs for photo attachment
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

  -- Auto-update PO status
  IF v_po_id IS NOT NULL THEN
    SELECT * INTO v_po FROM purchase_orders WHERE id = v_po_id;

    SELECT
      bool_and(quantity_received >= quantity_ordered),
      bool_or(quantity_received > 0)
    INTO v_all_received, v_any_received
    FROM purchase_order_items WHERE purchase_order_id = v_po_id;

    v_new_status := CASE
      WHEN v_all_received THEN 'fully_received'
      WHEN v_any_received THEN 'partially_received'
      ELSE v_po.status
    END;

    IF v_new_status IS DISTINCT FROM v_po.status THEN
      UPDATE purchase_orders SET status = v_new_status, updated_at = now() WHERE id = v_po_id;
    END IF;

    INSERT INTO activity_feed (
      event_type, description, performed_by,
      related_entity_type, related_entity_id
    ) VALUES (
      'po_received',
      'Items received on PO ' || v_po.po_number || ' — inventory updated',
      p_performed_by, 'purchase_order', v_po_id
    );
  END IF;

  v_result := jsonb_build_object(
    'status', 'received',
    'receiving_record_ids', v_receiving_record_ids
  );

  -- Save idempotency result if key was provided
  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (key, operation, result)
    VALUES (p_idempotency_key, 'receive_po_items', v_result)
    ON CONFLICT (key) DO NOTHING;
  END IF;

  RETURN v_result;
END;
$$;

-- Grant execute on the updated RPC (covers both old and new signatures)
GRANT EXECUTE ON FUNCTION receive_po_items(jsonb, uuid, text) TO authenticated;

-- ============================================================================
-- SECTION 6: get_receiving_log() RPC
-- Paginated, filterable query for the receiving log dashboard
-- ============================================================================

CREATE OR REPLACE FUNCTION get_receiving_log(
  p_limit integer DEFAULT 200,
  p_offset integer DEFAULT 0,
  p_vendor text DEFAULT NULL,
  p_condition text DEFAULT NULL,
  p_received_by uuid DEFAULT NULL,
  p_date_from date DEFAULT NULL,
  p_date_to date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result jsonb;
BEGIN
  -- Verify caller is admin or sales_rep
  IF NOT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = (select auth.uid()) AND is_active = true
      AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  SELECT COALESCE(jsonb_agg(row_to_json(r)), '[]'::jsonb) INTO v_result
  FROM (
    SELECT
      rr.id,
      rr.purchase_order_id,
      rr.po_item_id,
      rr.product_id,
      rr.quantity_received,
      rr.received_at,
      rr.notes,
      rr.condition,
      rr.lot_number,
      rr.storage_location,
      rr.unit_size,
      po.po_number,
      po.vendor,
      p.product_name,
      prof.full_name AS received_by_name,
      (SELECT count(*) FROM receiving_photos rp
       WHERE rp.receiving_record_id = rr.id) AS photo_count
    FROM receiving_records rr
    JOIN purchase_orders po ON po.id = rr.purchase_order_id
    JOIN products p ON p.id = rr.product_id
    JOIN profiles prof ON prof.id = rr.received_by
    WHERE (p_vendor IS NULL OR po.vendor ILIKE '%' || p_vendor || '%')
      AND (p_condition IS NULL OR rr.condition = p_condition)
      AND (p_received_by IS NULL OR rr.received_by = p_received_by)
      AND (p_date_from IS NULL OR rr.received_at::date >= p_date_from)
      AND (p_date_to IS NULL OR rr.received_at::date <= p_date_to)
    ORDER BY rr.received_at DESC
    LIMIT p_limit OFFSET p_offset
  ) r;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION get_receiving_log(integer, integer, text, text, uuid, date, date) TO authenticated;

-- ============================================================================
-- SECTION 7: get_receiving_summary() RPC
-- Dashboard card stats for receiving log page
-- ============================================================================

CREATE OR REPLACE FUNCTION get_receiving_summary()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result jsonb;
  v_today date := current_date;
  v_week_start date := date_trunc('week', current_date)::date;
  v_year_start date := make_date(
    CASE WHEN extract(month FROM current_date) >= 7
      THEN extract(year FROM current_date)::int
      ELSE extract(year FROM current_date)::int - 1
    END, 7, 1);
BEGIN
  -- Verify caller is admin or sales_rep
  IF NOT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = (select auth.uid()) AND is_active = true
      AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  SELECT jsonb_build_object(
    'expected_today', (
      SELECT count(*) FROM purchase_orders
      WHERE status IN ('submitted', 'partially_received')
        AND expected_delivery_date = v_today
    ),
    'pending_receipt', (
      SELECT count(*) FROM purchase_orders
      WHERE status IN ('submitted', 'partially_received')
    ),
    'received_this_week', (
      SELECT count(DISTINCT rr.id) FROM receiving_records rr
      WHERE rr.received_at::date >= v_week_start
    ),
    'items_received_ytd', (
      SELECT COALESCE(sum(rr.quantity_received), 0) FROM receiving_records rr
      WHERE rr.received_at::date >= v_year_start
    ),
    'damaged_this_week', (
      SELECT count(*) FROM receiving_records rr
      WHERE rr.received_at::date >= v_week_start
        AND rr.condition <> 'good'
    )
  ) INTO v_result;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION get_receiving_summary() TO authenticated;
