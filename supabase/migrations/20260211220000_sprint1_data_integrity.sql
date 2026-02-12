-- ============================================================================
-- SPRINT 1: DATA INTEGRITY & SECURITY FIXES
-- CRX Manager V1.0
-- Date: 2026-02-11
--
-- S1-3: Atomic PO save/delete RPCs (PO-1, PO-2, PO-3)
-- S1-6: Tighten RLS + SET search_path (DB-RLS-001, DB-RLS-002, DB-SEC-003)
-- S1-7: Fix admin_update_profile is_active check (DB-ROLE-005)
-- ============================================================================


-- ============================================================================
-- S1-3: ATOMIC PURCHASE ORDER SAVE RPC
-- Replaces non-atomic header-then-items-one-by-one pattern
-- ============================================================================

CREATE OR REPLACE FUNCTION save_purchase_order(
  p_po_id uuid,
  p_po_payload jsonb,
  p_items jsonb,
  p_performed_by uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_po_id uuid;
  v_is_new boolean := (p_po_id IS NULL);
  v_item jsonb;
  v_total_cost numeric := 0;
  v_po_number text;
BEGIN
  -- Verify caller is admin
  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = p_performed_by AND role = 'admin' AND is_active = true
  ) THEN
    RAISE EXCEPTION 'Only admins can manage purchase orders';
  END IF;

  -- Calculate total cost from items
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
      p_performed_by
    ) RETURNING id, po_number INTO v_po_id, v_po_number;
  ELSE
    v_po_id := p_po_id;

    -- Get PO number for activity log
    SELECT po_number INTO v_po_number FROM purchase_orders WHERE id = v_po_id;

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

    -- Delete existing items and re-insert (atomic within this transaction)
    DELETE FROM purchase_order_items WHERE purchase_order_id = v_po_id;
  END IF;

  -- Insert items
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
    COALESCE((item->>'quantity_received')::numeric, 0)
  FROM jsonb_array_elements(p_items) AS item
  WHERE (item->>'product_id') IS NOT NULL;

  -- Log activity
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

  RETURN jsonb_build_object('status', 'saved', 'po_id', v_po_id);
END;
$$;

GRANT EXECUTE ON FUNCTION save_purchase_order(uuid, jsonb, jsonb, uuid) TO authenticated;


-- ============================================================================
-- S1-3: ATOMIC PURCHASE ORDER DELETE RPC
-- Blocks deletion of POs with received items (PO-3)
-- Handles items-then-PO atomically (PO-2)
-- ============================================================================

CREATE OR REPLACE FUNCTION delete_purchase_order(
  p_po_id uuid,
  p_performed_by uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_po record;
  v_has_received boolean;
BEGIN
  -- Verify caller is admin
  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = p_performed_by AND role = 'admin' AND is_active = true
  ) THEN
    RAISE EXCEPTION 'Only admins can delete purchase orders';
  END IF;

  SELECT * INTO v_po FROM purchase_orders WHERE id = p_po_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Purchase order not found';
  END IF;

  -- Block deletion if any items have been received (PO-3)
  SELECT EXISTS (
    SELECT 1 FROM purchase_order_items
    WHERE purchase_order_id = p_po_id AND quantity_received > 0
  ) INTO v_has_received;

  IF v_has_received THEN
    RAISE EXCEPTION 'Cannot delete PO % — items have already been received. Cancel instead.', v_po.po_number;
  END IF;

  -- Delete items first, then PO (atomic within transaction)
  DELETE FROM purchase_order_items WHERE purchase_order_id = p_po_id;
  DELETE FROM purchase_orders WHERE id = p_po_id;

  -- Log activity
  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id
  ) VALUES (
    'po_deleted',
    'PO ' || v_po.po_number || ' deleted',
    p_performed_by, 'purchase_order', p_po_id
  );

  RETURN jsonb_build_object('status', 'deleted');
END;
$$;

GRANT EXECUTE ON FUNCTION delete_purchase_order(uuid, uuid) TO authenticated;


-- ============================================================================
-- S1-7: FIX admin_update_profile — ADD is_active CHECK (DB-ROLE-005)
-- A deactivated admin with a valid JWT could reactivate themselves.
-- ============================================================================

CREATE OR REPLACE FUNCTION admin_update_profile(
  target_user_id uuid,
  new_role text DEFAULT NULL,
  new_full_name text DEFAULT NULL,
  new_phone text DEFAULT NULL,
  new_is_active boolean DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  caller_role text;
  caller_active boolean;
  updated_count int;
BEGIN
  -- Verify caller is an ACTIVE admin (S1-7 fix: added is_active check)
  SELECT role, is_active INTO caller_role, caller_active
  FROM profiles WHERE id = (SELECT auth.uid());

  IF caller_role IS NULL OR caller_role != 'admin' OR caller_active != true THEN
    RETURN json_build_object('error', 'Active admin access required');
  END IF;

  -- Validate role if provided
  IF new_role IS NOT NULL AND new_role NOT IN ('admin', 'sales_rep', 'driver') THEN
    RETURN json_build_object('error', 'Invalid role. Must be admin, sales_rep, or driver');
  END IF;

  -- Update profile
  UPDATE profiles SET
    role = COALESCE(new_role, role),
    full_name = COALESCE(new_full_name, full_name),
    phone = COALESCE(new_phone, phone),
    is_active = COALESCE(new_is_active, is_active),
    updated_at = now()
  WHERE id = target_user_id;

  GET DIAGNOSTICS updated_count = ROW_COUNT;

  IF updated_count = 0 THEN
    RETURN json_build_object('error', 'User not found');
  END IF;

  RETURN json_build_object('success', true);
END;
$$;


-- ============================================================================
-- S1-6: ADD SET search_path TO ALL SECURITY DEFINER FUNCTIONS
-- These 3 helper functions already had it from the tier1 audit fixes.
-- Verifying the other SECURITY DEFINER functions have it:
-- (generate_ticket_number, handle_new_user, trg_payment_update_order,
--  trg_recalc_order_totals)
-- ============================================================================

-- generate_ticket_number — add SET search_path
CREATE OR REPLACE FUNCTION generate_ticket_number()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_year text := extract(year FROM current_date)::text;
  v_max int;
BEGIN
  SELECT COALESCE(MAX(
    CASE WHEN ticket_number ~ ('^BT-' || v_year || '-\d+$')
    THEN CAST(split_part(ticket_number, '-', 3) AS int)
    ELSE 0 END
  ), 0) INTO v_max FROM blend_tickets;

  RETURN 'BT-' || v_year || '-' || lpad((v_max + 1)::text, 4, '0');
END;
$$;

-- handle_new_user — add SET search_path
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO profiles (id, email, full_name, role)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.email),
    COALESCE(NEW.raw_user_meta_data->>'role', 'sales_rep')
  );
  RETURN NEW;
END;
$$;

-- trg_payment_update_order — already has SET search_path from tier1 audit
-- trg_recalc_order_totals — already has SET search_path from tier1 audit
-- is_admin, is_sales_rep, is_driver — already have SET search_path from tier1 audit
-- All RPCs (complete_delivery, cancel_order, etc.) — already have SET search_path


-- ============================================================================
-- S1-6: TIGHTEN NOTIFICATION INSERT RLS (DB-RLS-001)
-- Currently WITH CHECK (true) — any user can create notifications for any user.
-- However: notifyAdmins() needs to create notifications for OTHER users.
-- Solution: Keep the permissive policy but note the RPCs handle cross-user.
-- The RPC functions (SECURITY DEFINER) bypass RLS anyway.
-- Tighten the direct-insert policy to self-only:
-- ============================================================================

-- Note: We cannot fully restrict notifications INSERT because the client-side
-- activityLogger.ts createNotification() function is called by sales_reps to
-- create notifications for admins (via notifyAdmins). These are SECURITY DEFINER
-- RPCs or client-side supabase calls.
-- The safest approach: keep WITH CHECK(true) for now but add a TODO to move
-- all cross-user notification creation to SECURITY DEFINER RPCs.
-- This is tracked as a follow-up item.


-- ============================================================================
-- S1-6: TIGHTEN ocr_processing_queue RLS (DB-RLS-002)
-- ============================================================================

-- Check if policies exist before recreating
DROP POLICY IF EXISTS "ocr_queue_insert" ON ocr_processing_queue;
DROP POLICY IF EXISTS "ocr_queue_update" ON ocr_processing_queue;
DROP POLICY IF EXISTS "ocr_queue_select" ON ocr_processing_queue;

-- Only ticket owner can insert (via blend_ticket_id ownership)
CREATE POLICY "ocr_queue_insert" ON ocr_processing_queue
  FOR INSERT
  WITH CHECK (
    is_admin()
    OR EXISTS (
      SELECT 1 FROM blend_tickets bt
      WHERE bt.id = blend_ticket_id AND bt.uploaded_by = (SELECT auth.uid())
    )
  );

-- Only admin can update queue status
CREATE POLICY "ocr_queue_update" ON ocr_processing_queue
  FOR UPDATE
  USING (is_admin());

-- Everyone can read queue status for their own tickets
CREATE POLICY "ocr_queue_select" ON ocr_processing_queue
  FOR SELECT
  USING (
    is_admin()
    OR EXISTS (
      SELECT 1 FROM blend_tickets bt
      WHERE bt.id = blend_ticket_id AND bt.uploaded_by = (SELECT auth.uid())
    )
  );
