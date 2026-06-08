-- Migration: save_blend_ticket idempotency  (architecture-weakness audit AW-1)
--
-- Problem: save_blend_ticket DECLARED p_idempotency_key but its body never used it,
-- so the key the frontend passes (src/pages/BlendTicketDetail.tsx:362 via
-- useIdempotencyKey) was silently dropped — a false sense of double-submit
-- protection. A double-submit re-ran the (idempotent) UPDATEs but inserted a
-- DUPLICATE activity_feed row ("Blend ticket X updated").
--
-- Fix: wrap with the canonical check_idempotency / save_idempotency helpers
-- (defined in 20260210000000_tier3_idempotency_and_triggers.sql). The idempotency
-- check is placed AFTER the authorization check so a cached result can never leak
-- to an unauthorized caller (same ordering as 20260530183926_returns_rpc_role_actor_guard).
--
-- The body below is reproduced VERBATIM from live except for three additions:
--   1. two DECLARE vars (v_existing, v_result),
--   2. the post-auth idempotency short-circuit,
--   3. capturing the return value and PERFORM save_idempotency before RETURN.
-- No business logic, column, or return-shape change. Single overload (verified).
--
-- idempotency-body-check: exempt  (uses check_idempotency / save_idempotency helpers)

CREATE OR REPLACE FUNCTION public.save_blend_ticket(
  p_ticket_id uuid,
  p_ticket_payload jsonb,
  p_products jsonb,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ticket_number text;
  v_existing jsonb;
  v_result jsonb;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = p_performed_by AND is_active = true
      AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'Not authorized to save blend tickets';
  END IF;

  -- AW-1 fix: idempotency check, placed AFTER auth so a cached result never
  -- leaks to an unauthorized caller. (The key was previously ignored entirely.)
  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'save_blend_ticket');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  SELECT ticket_number INTO v_ticket_number FROM blend_tickets WHERE id = p_ticket_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Blend ticket not found: %', p_ticket_id;
  END IF;

  UPDATE blend_tickets SET
    customer_id = CASE WHEN p_ticket_payload ? 'customer_id'
      THEN (p_ticket_payload->>'customer_id')::uuid ELSE customer_id END,
    ticket_date = CASE WHEN p_ticket_payload ? 'ticket_date'
      THEN (p_ticket_payload->>'ticket_date')::date ELSE ticket_date END,
    ticket_time = CASE WHEN p_ticket_payload ? 'ticket_time'
      THEN p_ticket_payload->>'ticket_time' ELSE ticket_time END,
    job_number = CASE WHEN p_ticket_payload ? 'job_number'
      THEN NULLIF(p_ticket_payload->>'job_number', '') ELSE job_number END,
    invoice_number = CASE WHEN p_ticket_payload ? 'invoice_number'
      THEN NULLIF(p_ticket_payload->>'invoice_number', '') ELSE invoice_number END,
    driver_name = CASE WHEN p_ticket_payload ? 'driver_name'
      THEN NULLIF(p_ticket_payload->>'driver_name', '') ELSE driver_name END,
    applicator_name = CASE WHEN p_ticket_payload ? 'applicator_name'
      THEN NULLIF(p_ticket_payload->>'applicator_name', '') ELSE applicator_name END,
    mixer_name = CASE WHEN p_ticket_payload ? 'mixer_name'
      THEN NULLIF(p_ticket_payload->>'mixer_name', '') ELSE mixer_name END,
    tank_number = CASE WHEN p_ticket_payload ? 'tank_number'
      THEN NULLIF(p_ticket_payload->>'tank_number', '') ELSE tank_number END,
    vehicle_info = CASE WHEN p_ticket_payload ? 'vehicle_info'
      THEN NULLIF(p_ticket_payload->>'vehicle_info', '') ELSE vehicle_info END,
    field_names = CASE WHEN p_ticket_payload ? 'field_names'
      THEN NULLIF(p_ticket_payload->>'field_names', '') ELSE field_names END,
    total_acres = CASE WHEN p_ticket_payload ? 'total_acres'
      THEN (p_ticket_payload->>'total_acres')::numeric ELSE total_acres END,
    application_rate = CASE WHEN p_ticket_payload ? 'application_rate'
      THEN NULLIF(p_ticket_payload->>'application_rate', '') ELSE application_rate END,
    total_volume = CASE WHEN p_ticket_payload ? 'total_volume'
      THEN (p_ticket_payload->>'total_volume')::numeric ELSE total_volume END,
    total_volume_unit = CASE WHEN p_ticket_payload ? 'total_volume_unit'
      THEN NULLIF(p_ticket_payload->>'total_volume_unit', '') ELSE total_volume_unit END,
    notes = CASE WHEN p_ticket_payload ? 'notes'
      THEN NULLIF(p_ticket_payload->>'notes', '') ELSE notes END,
    updated_at = now()
  WHERE id = p_ticket_id;

  UPDATE blend_ticket_products btp SET
    product_id = CASE WHEN prod->>'product_id' IS NOT NULL
      THEN (prod->>'product_id')::uuid ELSE btp.product_id END,
    product_name = COALESCE(prod->>'product_name', btp.product_name),
    quantity = COALESCE((prod->>'quantity')::numeric, btp.quantity),
    unit = CASE WHEN prod ? 'unit' THEN NULLIF(prod->>'unit', '') ELSE btp.unit END,
    lot_number = CASE WHEN prod ? 'lot_number' THEN NULLIF(prod->>'lot_number', '') ELSE btp.lot_number END,
    rate_per_acre = CASE WHEN prod ? 'rate_per_acre' THEN (prod->>'rate_per_acre')::numeric ELSE btp.rate_per_acre END,
    rate_per_acre_unit = CASE WHEN prod ? 'rate_per_acre_unit' THEN NULLIF(prod->>'rate_per_acre_unit', '') ELSE btp.rate_per_acre_unit END,
    manually_corrected = true
  FROM jsonb_array_elements(p_products) AS prod
  WHERE btp.id = (prod->>'id')::uuid
    AND btp.blend_ticket_id = p_ticket_id;

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id
  ) VALUES (
    'blend_ticket_updated',
    'Blend ticket ' || COALESCE(v_ticket_number, '') || ' updated',
    p_performed_by, 'blend_ticket', p_ticket_id
  );

  -- P2-H: canonical mutating-RPC return shape (was {'status':'saved'}).
  v_result := jsonb_build_object('success', true, 'ticket_id', p_ticket_id, 'ticket_number', v_ticket_number);

  -- AW-1 fix: persist the result so a replayed key returns it (and skips the
  -- duplicate activity_feed insert above).
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'save_blend_ticket', v_result);
  END IF;

  RETURN v_result;
END;
$$;
