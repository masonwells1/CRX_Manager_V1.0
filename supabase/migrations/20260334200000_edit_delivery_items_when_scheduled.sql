-- ============================================================================
-- Migration: 20260334200000_edit_delivery_items_when_scheduled.sql
--
-- Feature: Allow editing delivery items (add/remove/change quantities) when
-- delivery status is 'scheduled'. Once a delivery is 'in_progress' or beyond,
-- items remain locked.
--
-- Key insight: delivery items don't affect inventory until complete_delivery()
-- runs. Prebooked inventory is managed at the order level. So editing items
-- on a scheduled delivery is safe — removed items naturally remain as
-- order_items.quantity_remaining > 0 for future deliveries.
--
-- Changes:
--   - Replaces edit_delivery() to honor p_items when status = 'scheduled'
--   - Validates item quantities against order_items.quantity_remaining
--   - Accounts for quantities already scheduled on OTHER active deliveries
-- ============================================================================

-- Drop the single existing overload (consolidated in 20260331600000)
DROP FUNCTION IF EXISTS public.edit_delivery(uuid, uuid, date, text, text, text, uuid, text, text, jsonb, uuid, text);

CREATE OR REPLACE FUNCTION public.edit_delivery(
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
  p_performed_by uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_delivery record;
  v_actor uuid;
  v_old_driver uuid;
  v_item jsonb;
  v_oi record;
  v_other_scheduled numeric;
  v_requested_qty numeric;
  v_max_allowed numeric;
  v_items_changed boolean := false;
  v_cached_result jsonb;
BEGIN
  v_actor := COALESCE(p_performed_by, auth.uid());

  -- Idempotency check
  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_cached_result
      FROM idempotency_keys
      WHERE idempotency_key = p_idempotency_key;
    IF v_cached_result IS NOT NULL THEN RETURN v_cached_result; END IF;
  END IF;

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

  -- ── Item editing: only when status = 'scheduled' ──
  IF p_items IS NOT NULL AND v_delivery.status = 'scheduled' THEN
    -- Validate each item
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
    LOOP
      v_requested_qty := (v_item->>'quantity')::numeric;

      IF v_requested_qty <= 0 THEN
        CONTINUE;  -- skip zero-qty items, they won't be inserted
      END IF;

      -- Look up the order item to get quantity_remaining
      SELECT * INTO v_oi
      FROM order_items
      WHERE id = (v_item->>'order_item_id')::uuid
        AND order_id = v_delivery.order_id
      FOR UPDATE;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'Order item % not found on order %',
          v_item->>'order_item_id', v_delivery.order_id;
      END IF;

      -- Calculate how much is already scheduled on OTHER active deliveries
      -- (not counting THIS delivery, since we're replacing its items)
      SELECT COALESCE(SUM(di.quantity), 0) INTO v_other_scheduled
      FROM delivery_items di
      JOIN deliveries d ON d.id = di.delivery_id
      WHERE di.order_item_id = v_oi.id
        AND d.status IN ('scheduled', 'in_progress')
        AND d.id != p_delivery_id;

      -- Max this delivery can claim = remaining + what this delivery currently has
      -- (since quantity_remaining hasn't been decremented for scheduled deliveries)
      v_max_allowed := v_oi.quantity_remaining - v_other_scheduled;

      IF v_requested_qty > v_max_allowed THEN
        RAISE EXCEPTION 'Cannot schedule % units of % — only % available (% remaining on order, % on other deliveries)',
          v_requested_qty,
          v_oi.product_name,
          GREATEST(v_max_allowed, 0),
          v_oi.quantity_remaining,
          v_other_scheduled;
      END IF;
    END LOOP;

    -- Delete old items and insert new ones
    DELETE FROM delivery_items WHERE delivery_id = p_delivery_id;

    FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
    LOOP
      IF (v_item->>'quantity')::numeric > 0 THEN
        INSERT INTO delivery_items (
          delivery_id, order_item_id, product_id, quantity, unit_size
        ) VALUES (
          p_delivery_id,
          (v_item->>'order_item_id')::uuid,
          (v_item->>'product_id')::uuid,
          (v_item->>'quantity')::numeric,
          v_item->>'unit_size'
        );
      END IF;
    END LOOP;

    v_items_changed := true;
  END IF;

  -- Block item editing on in_progress deliveries with a clear message
  IF p_items IS NOT NULL AND v_delivery.status = 'in_progress' THEN
    RAISE EXCEPTION 'Cannot edit delivery items once delivery is in progress';
  END IF;

  -- Notify old driver if driver changed
  IF p_assigned_driver IS NOT NULL AND v_old_driver IS DISTINCT FROM p_assigned_driver THEN
    IF v_old_driver IS NOT NULL THEN
      INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
      VALUES (
        v_old_driver,
        'Delivery Reassigned',
        'Delivery ' || v_delivery.delivery_number || ' has been reassigned to another driver.',
        'delivery_update', 'delivery', p_delivery_id
      );
    END IF;

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
    'Delivery ' || v_delivery.delivery_number || ' edited' ||
      CASE WHEN v_items_changed THEN ' (items updated)' ELSE '' END,
    v_actor, 'delivery', p_delivery_id, v_delivery.customer_id
  );

  -- Store idempotency result (result column is jsonb)
  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'edit_delivery',
      jsonb_build_object('status', 'updated', 'delivery_id', p_delivery_id, 'items_changed', v_items_changed)
    );
  END IF;

  RETURN jsonb_build_object('status', 'updated', 'delivery_id', p_delivery_id, 'items_changed', v_items_changed);
END;
$$;

GRANT EXECUTE ON FUNCTION public.edit_delivery(uuid, uuid, date, text, text, text, uuid, text, text, jsonb, uuid, text) TO authenticated;

-- ============================================================================
-- Verification: ensure exactly 1 overload
-- ============================================================================
DO $$
DECLARE
  v_count integer;
BEGIN
  SELECT count(*) INTO v_count
  FROM pg_proc p
  JOIN pg_namespace n ON p.pronamespace = n.oid
  WHERE p.proname = 'edit_delivery' AND n.nspname = 'public';

  IF v_count != 1 THEN
    RAISE EXCEPTION 'edit_delivery has % overloads — expected exactly 1', v_count;
  END IF;

  RAISE NOTICE 'VERIFIED: edit_delivery has exactly 1 overload';
END;
$$;
