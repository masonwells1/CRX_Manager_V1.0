-- Fix: Allow admin and sales_rep users to be reassigned as delivery targets
-- Previously only users with role='driver' could be targets, causing
-- "Target driver not found or inactive" when admins clicked "Take Delivery"

CREATE OR REPLACE FUNCTION reassign_delivery(
  p_delivery_id uuid,
  p_new_driver uuid,
  p_performed_by uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid;
  v_delivery record;
  v_old_driver uuid;
BEGIN
  v_actor := COALESCE(p_performed_by, auth.uid());

  -- HARDENED: Only admin and sales_rep can reassign (not driver/applicator)
  -- Exception: driver can self-assign if delivery is unassigned
  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true
      AND role IN ('admin', 'sales_rep')
  ) THEN
    -- Check if driver is self-assigning an unassigned delivery
    IF NOT EXISTS (
      SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role = 'driver'
    ) OR NOT EXISTS (
      SELECT 1 FROM deliveries WHERE id = p_delivery_id AND assigned_driver IS NULL
    ) THEN
      RAISE EXCEPTION 'Not authorized to reassign deliveries';
    END IF;
  END IF;

  -- Verify new driver exists and is active (allow admin, sales_rep, or driver)
  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = p_new_driver AND is_active = true AND role IN ('admin', 'sales_rep', 'driver')
  ) THEN
    RAISE EXCEPTION 'Target driver not found or inactive';
  END IF;

  SELECT * INTO v_delivery FROM deliveries WHERE id = p_delivery_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Delivery not found';
  END IF;

  IF v_delivery.status NOT IN ('scheduled', 'in_progress') THEN
    RAISE EXCEPTION 'Cannot reassign a % delivery', v_delivery.status;
  END IF;

  v_old_driver := v_delivery.assigned_driver;

  UPDATE deliveries SET
    assigned_driver = p_new_driver,
    last_edited_by = v_actor,
    last_edited_at = now(),
    updated_at = now()
  WHERE id = p_delivery_id;

  -- Notify old driver
  IF v_old_driver IS NOT NULL AND v_old_driver != p_new_driver THEN
    INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
    VALUES (
      v_old_driver, 'Delivery Reassigned',
      'Delivery ' || v_delivery.delivery_number || ' has been reassigned.',
      'delivery_update', 'delivery', p_delivery_id
    );
  END IF;

  -- Notify new driver
  INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
  VALUES (
    p_new_driver, 'New Delivery Assigned',
    'Delivery ' || v_delivery.delivery_number || ' has been assigned to you.',
    'delivery_update', 'delivery', p_delivery_id
  );

  -- Activity log
  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'delivery_reassigned',
    'Delivery ' || v_delivery.delivery_number || ' reassigned',
    v_actor, 'delivery', p_delivery_id, v_delivery.customer_id
  );

  RETURN jsonb_build_object('status', 'reassigned', 'delivery_id', p_delivery_id);
END;
$$;
