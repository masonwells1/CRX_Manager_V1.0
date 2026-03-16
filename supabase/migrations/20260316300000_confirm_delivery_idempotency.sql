-- Migration: Wire idempotency logic into confirm_delivery()
-- Problem: The consolidation migration (20260331600000) added p_idempotency_key
--          as a parameter, but never wired up the check/save logic inside the body.
--          Drivers on mobile with spotty connections can fire confirm_delivery()
--          twice, creating duplicate activity_feed + notification entries.
-- Fix: Add check_idempotency / save_idempotency calls following the established
--      pattern used by create_quick_delivery, save_quote, etc.

CREATE OR REPLACE FUNCTION public.confirm_delivery(
  p_delivery_id uuid,
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
  v_existing jsonb;
  v_result jsonb;
BEGIN
  v_actor := COALESCE(p_performed_by, auth.uid());

  -- Idempotency check: return cached result if this key was already processed
  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'confirm_delivery');
    IF v_existing IS NOT NULL THEN
      RETURN v_existing;
    END IF;
  END IF;

  -- Lock delivery row
  SELECT * INTO v_delivery
  FROM deliveries WHERE id = p_delivery_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Delivery not found';
  END IF;

  IF v_delivery.status != 'scheduled' THEN
    RAISE EXCEPTION 'Delivery must be in scheduled status to start. Current status: %', v_delivery.status;
  END IF;

  -- Verify caller is admin, sales_rep, or the assigned driver
  IF NOT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = v_actor AND is_active = true
      AND (
        role IN ('admin', 'sales_rep')
        OR (role = 'driver' AND v_actor = v_delivery.assigned_driver)
      )
  ) THEN
    RAISE EXCEPTION 'Not authorized to start this delivery';
  END IF;

  -- Transition to in_progress
  UPDATE deliveries SET
    status = 'in_progress',
    updated_at = now()
  WHERE id = p_delivery_id;

  -- Log activity
  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'delivery_confirmed',
    'Delivery ' || v_delivery.delivery_number || ' confirmed and started',
    v_actor, 'delivery', p_delivery_id, v_delivery.customer_id
  );

  -- Notify assigned driver if confirmer is not the driver
  IF v_delivery.assigned_driver IS NOT NULL AND v_actor != v_delivery.assigned_driver THEN
    INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
    VALUES (
      v_delivery.assigned_driver,
      'Delivery Started',
      'Delivery ' || v_delivery.delivery_number || ' has been started and is ready for completion.',
      'delivery_update', 'delivery', p_delivery_id
    );
  END IF;

  v_result := jsonb_build_object('status', 'confirmed', 'delivery_id', p_delivery_id);

  -- Save idempotency key for deduplication
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'confirm_delivery', v_result);
  END IF;

  RETURN v_result;
END;
$$;

-- Ensure only one overload exists
GRANT EXECUTE ON FUNCTION public.confirm_delivery(uuid, uuid, text) TO authenticated;
