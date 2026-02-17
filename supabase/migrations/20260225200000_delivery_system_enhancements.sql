-- ============================================================================
-- Sprint 18: Delivery System Enhancements
-- CRX Manager V1.0
-- Date: 2026-02-25
--
-- Adds: edit delivery, cancel delivery, batch cancel, driver reassignment,
--       delivery photos, delivery remainders, issue reporting, priority,
--       delivery time windows, follow-up delivery creation.
--
-- New tables: delivery_photos, delivery_remainders
-- Updated tables: deliveries (new columns)
-- New RPCs: edit_delivery, cancel_delivery, batch_cancel_deliveries,
--           reassign_delivery, create_followup_delivery,
--           get_customer_delivery_remainders
-- Updated RPCs: complete_delivery (remainder tracking + issue reporting)
-- Updated RLS: sales_rep INSERT/UPDATE/DELETE on deliveries + delivery_items
-- ============================================================================


-- ═══════════════════════════════════════════════════════════════════════════
-- 1. NEW COLUMNS ON deliveries
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS priority text
  DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent'));

ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS delivery_window_start text;
ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS delivery_window_end text;

ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;
ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS cancelled_by uuid REFERENCES profiles(id);
ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS cancel_reason text;

ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS issue_type text
  CHECK (issue_type IS NULL OR issue_type IN (
    'none', 'customer_not_home', 'gate_locked', 'road_blocked',
    'wrong_address', 'refused', 'weather', 'other'
  ));
ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS issue_notes text;

ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS last_edited_by uuid REFERENCES profiles(id);
ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS last_edited_at timestamptz;

-- Indexes for new columns
CREATE INDEX IF NOT EXISTS idx_deliveries_priority ON deliveries(priority);
CREATE INDEX IF NOT EXISTS idx_deliveries_date_status ON deliveries(scheduled_date, status);


-- ═══════════════════════════════════════════════════════════════════════════
-- 2. NEW TABLE: delivery_photos
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS delivery_photos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id uuid NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  storage_path text NOT NULL,
  image_url text NOT NULL,
  caption text,
  uploaded_by uuid NOT NULL REFERENCES profiles(id),
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  file_size integer,
  sort_order integer NOT NULL DEFAULT 0
);

ALTER TABLE delivery_photos ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_del_photos_delivery ON delivery_photos(delivery_id);

-- RLS for delivery_photos
CREATE POLICY "del_photos_admin_all" ON delivery_photos
  FOR ALL TO authenticated USING (is_admin()) WITH CHECK (is_admin());
CREATE POLICY "del_photos_rep_select" ON delivery_photos
  FOR SELECT TO authenticated USING (is_sales_rep());
CREATE POLICY "del_photos_rep_insert" ON delivery_photos
  FOR INSERT TO authenticated
  WITH CHECK (is_sales_rep());
CREATE POLICY "del_photos_driver_select" ON delivery_photos
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM deliveries d
    WHERE d.id = delivery_photos.delivery_id
      AND d.assigned_driver = (select auth.uid())
  ));
CREATE POLICY "del_photos_driver_insert" ON delivery_photos
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM profiles WHERE id = (select auth.uid()) AND role = 'driver'
    )
    AND EXISTS (
      SELECT 1 FROM deliveries d
      WHERE d.id = delivery_photos.delivery_id
        AND d.assigned_driver = (select auth.uid())
    )
  );


-- ═══════════════════════════════════════════════════════════════════════════
-- 3. NEW TABLE: delivery_remainders
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS delivery_remainders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  original_delivery_id uuid NOT NULL REFERENCES deliveries(id),
  order_id uuid NOT NULL REFERENCES orders(id),
  order_item_id uuid NOT NULL REFERENCES order_items(id),
  customer_id uuid NOT NULL REFERENCES customers(id),
  product_id uuid NOT NULL REFERENCES products(id),
  quantity_remaining numeric NOT NULL CHECK (quantity_remaining > 0),
  unit_size text,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'scheduled', 'fulfilled', 'cancelled')),
  followup_delivery_id uuid REFERENCES deliveries(id),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE delivery_remainders ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_del_remainders_customer ON delivery_remainders(customer_id);
CREATE INDEX IF NOT EXISTS idx_del_remainders_order ON delivery_remainders(order_id);
CREATE INDEX IF NOT EXISTS idx_del_remainders_status ON delivery_remainders(status);
CREATE INDEX IF NOT EXISTS idx_del_remainders_delivery ON delivery_remainders(original_delivery_id);

-- RLS for delivery_remainders
CREATE POLICY "del_rem_admin_all" ON delivery_remainders
  FOR ALL TO authenticated USING (is_admin()) WITH CHECK (is_admin());
CREATE POLICY "del_rem_rep_select" ON delivery_remainders
  FOR SELECT TO authenticated USING (is_sales_rep());
CREATE POLICY "del_rem_rep_insert" ON delivery_remainders
  FOR INSERT TO authenticated WITH CHECK (is_sales_rep());
CREATE POLICY "del_rem_rep_update" ON delivery_remainders
  FOR UPDATE TO authenticated USING (is_sales_rep()) WITH CHECK (is_sales_rep());
CREATE POLICY "del_rem_driver_select" ON delivery_remainders
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM deliveries d
    WHERE d.id = delivery_remainders.original_delivery_id
      AND d.assigned_driver = (select auth.uid())
  ));


-- ═══════════════════════════════════════════════════════════════════════════
-- 4. RLS POLICY UPDATES — Sales Rep access to deliveries + delivery_items
-- ═══════════════════════════════════════════════════════════════════════════

-- Sales rep can now CREATE deliveries
DROP POLICY IF EXISTS "del_rep_insert" ON deliveries;
CREATE POLICY "del_rep_insert" ON deliveries
  FOR INSERT TO authenticated
  WITH CHECK (is_sales_rep());

-- Sales rep can now UPDATE any delivery
DROP POLICY IF EXISTS "del_rep_update" ON deliveries;
CREATE POLICY "del_rep_update" ON deliveries
  FOR UPDATE TO authenticated
  USING (is_sales_rep()) WITH CHECK (is_sales_rep());

-- Sales rep can now INSERT delivery_items
DROP POLICY IF EXISTS "del_items_rep_insert" ON delivery_items;
CREATE POLICY "del_items_rep_insert" ON delivery_items
  FOR INSERT TO authenticated
  WITH CHECK (is_sales_rep());

-- Sales rep can now UPDATE delivery_items
DROP POLICY IF EXISTS "del_items_rep_update" ON delivery_items;
CREATE POLICY "del_items_rep_update" ON delivery_items
  FOR UPDATE TO authenticated
  USING (is_sales_rep()) WITH CHECK (is_sales_rep());

-- Sales rep can now DELETE delivery_items (for edit_delivery item replacement)
DROP POLICY IF EXISTS "del_items_rep_delete" ON delivery_items;
CREATE POLICY "del_items_rep_delete" ON delivery_items
  FOR DELETE TO authenticated
  USING (is_sales_rep());


-- ═══════════════════════════════════════════════════════════════════════════
-- 5. RPC: edit_delivery()
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION edit_delivery(
  p_delivery_id uuid,
  p_assigned_driver uuid DEFAULT NULL,
  p_scheduled_date date DEFAULT NULL,
  p_scheduled_time text DEFAULT NULL,
  p_delivery_window_start text DEFAULT NULL,
  p_delivery_window_end text DEFAULT NULL,
  p_delivery_address_id uuid DEFAULT NULL,
  p_delivery_notes text DEFAULT NULL,
  p_priority text DEFAULT NULL,
  p_items jsonb DEFAULT NULL,
  p_performed_by uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_delivery record;
  v_actor uuid;
  v_old_driver uuid;
  v_item jsonb;
BEGIN
  v_actor := COALESCE(p_performed_by, auth.uid());

  -- Lock the delivery row
  SELECT * INTO v_delivery
  FROM deliveries WHERE id = p_delivery_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Delivery not found';
  END IF;

  IF v_delivery.status NOT IN ('scheduled', 'in_progress') THEN
    RAISE EXCEPTION 'Cannot edit a % delivery', v_delivery.status;
  END IF;

  -- Verify caller is admin or sales_rep
  IF NOT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'Not authorized to edit deliveries';
  END IF;

  v_old_driver := v_delivery.assigned_driver;

  -- Update delivery header (only non-null params)
  UPDATE deliveries SET
    assigned_driver = COALESCE(p_assigned_driver, assigned_driver),
    scheduled_date = COALESCE(p_scheduled_date, scheduled_date),
    scheduled_time = CASE WHEN p_scheduled_time IS NOT NULL THEN p_scheduled_time ELSE scheduled_time END,
    delivery_window_start = CASE WHEN p_delivery_window_start IS NOT NULL THEN p_delivery_window_start ELSE delivery_window_start END,
    delivery_window_end = CASE WHEN p_delivery_window_end IS NOT NULL THEN p_delivery_window_end ELSE delivery_window_end END,
    delivery_address_id = CASE WHEN p_delivery_address_id IS NOT NULL THEN p_delivery_address_id ELSE delivery_address_id END,
    delivery_notes = CASE WHEN p_delivery_notes IS NOT NULL THEN p_delivery_notes ELSE delivery_notes END,
    priority = COALESCE(p_priority, priority),
    last_edited_by = v_actor,
    last_edited_at = now(),
    updated_at = now()
  WHERE id = p_delivery_id;

  -- Replace items if provided
  IF p_items IS NOT NULL THEN
    DELETE FROM delivery_items WHERE delivery_id = p_delivery_id;

    FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
    LOOP
      INSERT INTO delivery_items (
        delivery_id, order_item_id, product_id, quantity, unit_size
      ) VALUES (
        p_delivery_id,
        (v_item->>'order_item_id')::uuid,
        (v_item->>'product_id')::uuid,
        (v_item->>'quantity')::numeric,
        v_item->>'unit_size'
      );
    END LOOP;
  END IF;

  -- Notify old driver if driver changed
  IF p_assigned_driver IS NOT NULL AND v_old_driver IS DISTINCT FROM p_assigned_driver THEN
    -- Notify old driver of reassignment
    IF v_old_driver IS NOT NULL THEN
      INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
      VALUES (
        v_old_driver,
        'Delivery Reassigned',
        'Delivery ' || v_delivery.delivery_number || ' has been reassigned to another driver.',
        'delivery_update', 'delivery', p_delivery_id
      );
    END IF;

    -- Notify new driver of assignment
    INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
    VALUES (
      p_assigned_driver,
      'New Delivery Assigned',
      'Delivery ' || v_delivery.delivery_number || ' has been assigned to you.',
      'delivery_update', 'delivery', p_delivery_id
    );
  END IF;

  -- Activity log
  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'delivery_edited',
    'Delivery ' || v_delivery.delivery_number || ' edited',
    v_actor, 'delivery', p_delivery_id, v_delivery.customer_id
  );

  RETURN jsonb_build_object('status', 'updated', 'delivery_id', p_delivery_id);
END;
$$;

GRANT EXECUTE ON FUNCTION edit_delivery(uuid, uuid, date, text, text, text, uuid, text, text, jsonb, uuid) TO authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- 6. RPC: cancel_delivery()
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION cancel_delivery(
  p_delivery_id uuid,
  p_cancel_reason text DEFAULT 'Cancelled',
  p_performed_by uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_delivery record;
  v_actor uuid;
BEGIN
  v_actor := COALESCE(p_performed_by, auth.uid());

  SELECT * INTO v_delivery
  FROM deliveries WHERE id = p_delivery_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Delivery not found';
  END IF;

  IF v_delivery.status NOT IN ('scheduled', 'in_progress') THEN
    RAISE EXCEPTION 'Cannot cancel a % delivery', v_delivery.status;
  END IF;

  -- Verify caller is admin or sales_rep
  IF NOT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'Not authorized to cancel deliveries';
  END IF;

  UPDATE deliveries SET
    status = 'cancelled',
    cancelled_at = now(),
    cancelled_by = v_actor,
    cancel_reason = p_cancel_reason,
    updated_at = now()
  WHERE id = p_delivery_id;

  -- Notify assigned driver
  IF v_delivery.assigned_driver IS NOT NULL THEN
    INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
    VALUES (
      v_delivery.assigned_driver,
      'Delivery Cancelled',
      'Delivery ' || v_delivery.delivery_number || ' has been cancelled. Reason: ' || p_cancel_reason,
      'delivery_update', 'delivery', p_delivery_id
    );
  END IF;

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'delivery_cancelled',
    'Delivery ' || v_delivery.delivery_number || ' cancelled. Reason: ' || p_cancel_reason,
    v_actor, 'delivery', p_delivery_id, v_delivery.customer_id
  );

  RETURN jsonb_build_object('status', 'cancelled', 'delivery_id', p_delivery_id);
END;
$$;

GRANT EXECUTE ON FUNCTION cancel_delivery(uuid, text, uuid) TO authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- 7. RPC: batch_cancel_deliveries()
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION batch_cancel_deliveries(
  p_delivery_ids uuid[],
  p_cancel_reason text DEFAULT 'Batch cancelled',
  p_performed_by uuid DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_del record;
  v_count integer := 0;
  v_actor uuid;
BEGIN
  v_actor := COALESCE(p_performed_by, auth.uid());

  IF array_length(p_delivery_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'No delivery IDs provided';
  END IF;

  -- Verify caller is admin or sales_rep
  IF NOT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'Not authorized to cancel deliveries';
  END IF;

  FOR v_del IN
    SELECT *
    FROM deliveries
    WHERE id = ANY(p_delivery_ids)
    ORDER BY id
    FOR UPDATE
  LOOP
    -- Skip already completed or cancelled
    IF v_del.status NOT IN ('scheduled', 'in_progress') THEN
      CONTINUE;
    END IF;

    UPDATE deliveries SET
      status = 'cancelled',
      cancelled_at = now(),
      cancelled_by = v_actor,
      cancel_reason = p_cancel_reason,
      updated_at = now()
    WHERE id = v_del.id;

    -- Notify assigned driver
    IF v_del.assigned_driver IS NOT NULL THEN
      INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
      VALUES (
        v_del.assigned_driver,
        'Delivery Cancelled',
        'Delivery ' || v_del.delivery_number || ' has been cancelled.',
        'delivery_update', 'delivery', v_del.id
      );
    END IF;

    INSERT INTO activity_feed (
      event_type, description, performed_by,
      related_entity_type, related_entity_id, customer_id
    ) VALUES (
      'delivery_cancelled',
      'Delivery ' || v_del.delivery_number || ' cancelled (batch). Reason: ' || p_cancel_reason,
      v_actor, 'delivery', v_del.id, v_del.customer_id
    );

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION batch_cancel_deliveries(uuid[], text, uuid) TO authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- 8. RPC: reassign_delivery()
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION reassign_delivery(
  p_delivery_id uuid,
  p_new_driver uuid,
  p_performed_by uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_delivery record;
  v_actor uuid;
  v_old_driver uuid;
  v_new_driver_name text;
  v_actor_name text;
BEGIN
  v_actor := COALESCE(p_performed_by, auth.uid());

  SELECT * INTO v_delivery
  FROM deliveries WHERE id = p_delivery_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Delivery not found';
  END IF;

  IF v_delivery.status NOT IN ('scheduled', 'in_progress') THEN
    RAISE EXCEPTION 'Cannot reassign a % delivery', v_delivery.status;
  END IF;

  -- Any authenticated active user can reassign
  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true
  ) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  v_old_driver := v_delivery.assigned_driver;

  -- Get names for notifications
  SELECT full_name INTO v_new_driver_name FROM profiles WHERE id = p_new_driver;
  SELECT full_name INTO v_actor_name FROM profiles WHERE id = v_actor;

  UPDATE deliveries SET
    assigned_driver = p_new_driver,
    last_edited_by = v_actor,
    last_edited_at = now(),
    updated_at = now()
  WHERE id = p_delivery_id;

  -- Notify old driver
  IF v_old_driver IS NOT NULL AND v_old_driver IS DISTINCT FROM p_new_driver THEN
    INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
    VALUES (
      v_old_driver,
      'Delivery Reassigned',
      'Delivery ' || v_delivery.delivery_number || ' has been reassigned to ' || COALESCE(v_new_driver_name, 'another driver') || ' by ' || COALESCE(v_actor_name, 'unknown') || '.',
      'delivery_update', 'delivery', p_delivery_id
    );
  END IF;

  -- Notify new driver
  IF p_new_driver IS DISTINCT FROM v_old_driver THEN
    INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
    VALUES (
      p_new_driver,
      'Delivery Assigned',
      'Delivery ' || v_delivery.delivery_number || ' has been assigned to you by ' || COALESCE(v_actor_name, 'unknown') || '.',
      'delivery_update', 'delivery', p_delivery_id
    );
  END IF;

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'delivery_reassigned',
    'Delivery ' || v_delivery.delivery_number || ' reassigned to ' || COALESCE(v_new_driver_name, 'unknown'),
    v_actor, 'delivery', p_delivery_id, v_delivery.customer_id
  );

  RETURN jsonb_build_object(
    'status', 'reassigned',
    'delivery_id', p_delivery_id,
    'old_driver', v_old_driver,
    'new_driver', p_new_driver
  );
END;
$$;

GRANT EXECUTE ON FUNCTION reassign_delivery(uuid, uuid, uuid) TO authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- 9. RPC: create_followup_delivery()
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION create_followup_delivery(
  p_original_delivery_id uuid,
  p_scheduled_date date DEFAULT NULL,
  p_performed_by uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_original record;
  v_rem record;
  v_new_del_id uuid;
  v_del_number text;
  v_item_count integer := 0;
  v_actor uuid;
BEGIN
  v_actor := COALESCE(p_performed_by, auth.uid());

  SELECT * INTO v_original
  FROM deliveries WHERE id = p_original_delivery_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Original delivery not found';
  END IF;

  -- Check there are pending remainders
  IF NOT EXISTS (
    SELECT 1 FROM delivery_remainders
    WHERE original_delivery_id = p_original_delivery_id AND status = 'pending'
  ) THEN
    RAISE EXCEPTION 'No pending remainders for this delivery';
  END IF;

  -- Generate delivery number
  SELECT next_delivery_number() INTO v_del_number;

  -- Create the follow-up delivery
  INSERT INTO deliveries (
    delivery_number, order_id, customer_id, delivery_address_id,
    assigned_driver, scheduled_date, scheduled_time, delivery_notes,
    status, priority, created_by
  ) VALUES (
    v_del_number,
    v_original.order_id,
    v_original.customer_id,
    v_original.delivery_address_id,
    v_original.assigned_driver,
    COALESCE(p_scheduled_date, CURRENT_DATE + interval '1 day'),
    v_original.scheduled_time,
    'Follow-up for ' || v_original.delivery_number,
    'scheduled',
    v_original.priority,
    v_actor
  )
  RETURNING id INTO v_new_del_id;

  -- Create delivery items from remainders
  FOR v_rem IN
    SELECT * FROM delivery_remainders
    WHERE original_delivery_id = p_original_delivery_id AND status = 'pending'
  LOOP
    INSERT INTO delivery_items (
      delivery_id, order_item_id, product_id, quantity, unit_size
    ) VALUES (
      v_new_del_id,
      v_rem.order_item_id,
      v_rem.product_id,
      v_rem.quantity_remaining,
      v_rem.unit_size
    );

    -- Update remainder status
    UPDATE delivery_remainders SET
      status = 'scheduled',
      followup_delivery_id = v_new_del_id,
      updated_at = now()
    WHERE id = v_rem.id;

    v_item_count := v_item_count + 1;
  END LOOP;

  -- Activity log
  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'delivery_created',
    'Follow-up delivery ' || v_del_number || ' created from ' || v_original.delivery_number || ' remainders (' || v_item_count || ' items)',
    v_actor, 'delivery', v_new_del_id, v_original.customer_id
  );

  -- Notify driver if assigned
  IF v_original.assigned_driver IS NOT NULL THEN
    INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
    VALUES (
      v_original.assigned_driver,
      'Follow-up Delivery Scheduled',
      'Follow-up delivery ' || v_del_number || ' created for remaining items from ' || v_original.delivery_number || '.',
      'delivery_update', 'delivery', v_new_del_id
    );
  END IF;

  RETURN jsonb_build_object(
    'status', 'created',
    'delivery_id', v_new_del_id,
    'delivery_number', v_del_number,
    'item_count', v_item_count
  );
END;
$$;

GRANT EXECUTE ON FUNCTION create_followup_delivery(uuid, date, uuid) TO authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- 10. RPC: get_customer_delivery_remainders()
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION get_customer_delivery_remainders(
  p_customer_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result jsonb;
BEGIN
  SELECT COALESCE(jsonb_agg(row_to_json(r)), '[]'::jsonb) INTO v_result
  FROM (
    SELECT
      dr.id,
      dr.original_delivery_id,
      dr.order_id,
      dr.order_item_id,
      dr.customer_id,
      dr.product_id,
      dr.quantity_remaining,
      dr.unit_size,
      dr.status,
      dr.followup_delivery_id,
      dr.notes,
      dr.created_at,
      c.farm_name AS customer_name,
      p.product_name,
      d.delivery_number AS original_delivery_number,
      d.scheduled_date AS original_delivery_date,
      o.order_number
    FROM delivery_remainders dr
    JOIN customers c ON c.id = dr.customer_id
    JOIN products p ON p.id = dr.product_id
    JOIN deliveries d ON d.id = dr.original_delivery_id
    JOIN orders o ON o.id = dr.order_id
    WHERE (p_customer_id IS NULL OR dr.customer_id = p_customer_id)
    ORDER BY dr.created_at DESC
  ) r;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION get_customer_delivery_remainders(uuid) TO authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- 11. UPDATE: complete_delivery() — add remainder tracking + issue reporting
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION complete_delivery(
  p_delivery_id uuid,
  p_signed_by text,
  p_performed_by uuid,
  p_quantities jsonb DEFAULT NULL,
  p_issue_type text DEFAULT NULL,
  p_issue_notes text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_delivery record;
  v_item record;
  v_inv record;
  v_all_delivered boolean;
  v_qty_to_deliver numeric;
  v_any_partial boolean := false;
BEGIN
  -- Validate delivery exists and is not already completed
  SELECT * INTO v_delivery FROM deliveries WHERE id = p_delivery_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Delivery not found';
  END IF;
  IF v_delivery.status = 'completed' THEN
    RETURN jsonb_build_object('status', 'already_completed');
  END IF;

  -- Verify caller is the assigned driver or an admin
  IF NOT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = p_performed_by
      AND is_active = true
      AND (role = 'admin' OR (role = 'driver' AND p_performed_by = v_delivery.assigned_driver))
  ) THEN
    RAISE EXCEPTION 'Not authorized to complete this delivery';
  END IF;

  -- PRE-CHECK INVENTORY AVAILABILITY for all items
  FOR v_item IN
    SELECT di.*, p.product_name
    FROM delivery_items di
    JOIN products p ON p.id = di.product_id
    WHERE di.delivery_id = p_delivery_id
  LOOP
    IF p_quantities IS NOT NULL AND p_quantities ? v_item.id::text THEN
      v_qty_to_deliver := (p_quantities->>v_item.id::text)::numeric;
      v_qty_to_deliver := GREATEST(0, LEAST(v_qty_to_deliver, v_item.quantity));
    ELSE
      v_qty_to_deliver := v_item.quantity;
    END IF;

    IF v_qty_to_deliver < v_item.quantity THEN
      v_any_partial := true;
    END IF;

    IF v_qty_to_deliver = 0 THEN
      CONTINUE;
    END IF;

    SELECT * INTO v_inv
    FROM inventory
    WHERE product_id = v_item.product_id AND location = 'Main Warehouse'
    FOR UPDATE;

    IF NOT FOUND OR v_inv.quantity_available < v_qty_to_deliver THEN
      RAISE EXCEPTION 'Insufficient inventory for %: need % units, only % available',
        v_item.product_name,
        v_qty_to_deliver,
        COALESCE(v_inv.quantity_available, 0);
    END IF;
  END LOOP;

  -- Mark delivery completed (with issue info)
  UPDATE deliveries SET
    status = 'completed',
    completed_at = now(),
    signed_by = p_signed_by,
    issue_type = COALESCE(p_issue_type, issue_type),
    issue_notes = CASE WHEN p_issue_notes IS NOT NULL THEN p_issue_notes ELSE issue_notes END
  WHERE id = p_delivery_id;

  -- Process each delivery item
  FOR v_item IN
    SELECT di.*, p.product_name
    FROM delivery_items di
    JOIN products p ON p.id = di.product_id
    WHERE di.delivery_id = p_delivery_id
  LOOP
    IF p_quantities IS NOT NULL AND p_quantities ? v_item.id::text THEN
      v_qty_to_deliver := (p_quantities->>v_item.id::text)::numeric;
      v_qty_to_deliver := GREATEST(0, LEAST(v_qty_to_deliver, v_item.quantity));
    ELSE
      v_qty_to_deliver := v_item.quantity;
    END IF;

    UPDATE delivery_items SET quantity_delivered = v_qty_to_deliver
    WHERE id = v_item.id;

    IF v_qty_to_deliver = 0 THEN
      CONTINUE;
    END IF;

    UPDATE order_items SET
      quantity_delivered = quantity_delivered + v_qty_to_deliver,
      quantity_remaining = GREATEST(quantity_remaining - v_qty_to_deliver, 0)
    WHERE id = v_item.order_item_id;

    INSERT INTO inventory_transactions (
      product_id, transaction_type, quantity, from_location,
      order_id, delivery_id, performed_by, notes
    ) VALUES (
      v_item.product_id, 'delivered', v_qty_to_deliver, 'Main Warehouse',
      v_delivery.order_id, p_delivery_id, p_performed_by,
      'Delivery ' || v_delivery.delivery_number ||
        CASE WHEN v_qty_to_deliver < v_item.quantity
          THEN ' (partial: ' || v_qty_to_deliver || '/' || v_item.quantity || ')'
          ELSE ''
        END ||
        '. Signed by: ' || p_signed_by
    );

    UPDATE inventory SET
      quantity_available = quantity_available - v_qty_to_deliver,
      quantity_prebooked = GREATEST(quantity_prebooked - v_qty_to_deliver, 0),
      updated_at = now()
    WHERE product_id = v_item.product_id AND location = 'Main Warehouse';
  END LOOP;

  -- *** NEW: Create remainder records for partial deliveries ***
  IF v_any_partial THEN
    FOR v_item IN
      SELECT di.*, p.product_name
      FROM delivery_items di
      JOIN products p ON p.id = di.product_id
      WHERE di.delivery_id = p_delivery_id
        AND di.quantity_delivered < di.quantity
    LOOP
      INSERT INTO delivery_remainders (
        original_delivery_id, order_id, order_item_id,
        customer_id, product_id, quantity_remaining, unit_size
      ) VALUES (
        p_delivery_id, v_delivery.order_id, v_item.order_item_id,
        v_delivery.customer_id, v_item.product_id,
        v_item.quantity - v_item.quantity_delivered, v_item.unit_size
      );
    END LOOP;
  END IF;

  -- Check if entire order is fully delivered
  SELECT NOT EXISTS (
    SELECT 1 FROM order_items
    WHERE order_id = v_delivery.order_id AND quantity_remaining > 0
  ) INTO v_all_delivered;

  UPDATE orders SET
    status = CASE WHEN v_all_delivered THEN 'fulfilled' ELSE 'partially_fulfilled' END,
    updated_at = now()
  WHERE id = v_delivery.order_id;

  -- Log activity
  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'delivery_completed',
    'Delivery ' || v_delivery.delivery_number ||
      CASE WHEN v_any_partial THEN ' completed (partial quantities)' ELSE ' completed' END ||
      CASE WHEN p_issue_type IS NOT NULL AND p_issue_type <> 'none'
        THEN '. Issue: ' || p_issue_type
        ELSE '' END ||
      '. Signed by: ' || p_signed_by,
    p_performed_by, 'delivery', p_delivery_id, v_delivery.customer_id
  );

  RETURN jsonb_build_object(
    'status', 'completed',
    'partial', v_any_partial,
    'order_status', CASE WHEN v_all_delivered THEN 'fulfilled' ELSE 'partially_fulfilled' END
  );
END;
$$;

-- Grant with new signature (6 params)
GRANT EXECUTE ON FUNCTION complete_delivery(uuid, text, uuid, jsonb, text, text) TO authenticated;
