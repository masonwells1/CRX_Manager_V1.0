-- idempotency-body-check: exempt
--   (save_blend_ticket declares p_idempotency_key but is naturally idempotent —
--    an UPDATE-only path where replay overwrites identically; it is listed as
--    'natural' in rpcContracts.test.ts IDEMPOTENCY_BODY_EXEMPT. Reproduced
--    verbatim from live; the ONLY change is the return shape.)
-- ============================================================================
-- P2-H · save_blend_ticket: canonical return shape
-- ============================================================================
-- Problem (review 2026-05-28 §5 P2-H):
--   save_blend_ticket returned jsonb_build_object('status','saved') instead of
--   the canonical mutating-RPC shape jsonb_build_object('success', true, ...).
--   The sole caller (BlendTicketDetail.tsx) only calls assertRpcResult() on the
--   result and reads no specific field, so this is a migration-only consistency
--   fix with no frontend change.
--
-- Fix: return jsonb_build_object('success', true, 'ticket_id', p_ticket_id,
--   'ticket_number', v_ticket_number). Everything else is VERBATIM from live.
--
-- Single overload (verified live). SECURITY DEFINER, search_path public, pg_temp
-- (unchanged). NOTE (out of scope, pre-existing): the authorization check uses
-- p_performed_by rather than auth.uid() — a forgeable-actor pattern shared with
-- the batch RPCs; candidate for a future strict-actor pass, not changed here.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.save_blend_ticket(p_ticket_id uuid, p_ticket_payload jsonb, p_products jsonb, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_ticket_number text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = p_performed_by AND is_active = true
      AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'Not authorized to save blend tickets';
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
  RETURN jsonb_build_object('success', true, 'ticket_id', p_ticket_id, 'ticket_number', v_ticket_number);
END;
$function$;
