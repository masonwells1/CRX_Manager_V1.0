-- ============================================================================
-- PARKED DRAFT — DO NOT APPLY (structure-fix loop, Wave A / A2). 2026-07-02.
-- Mason applies via the DRAFT/APPLY protocol after review.
--
-- WHAT: save_blend_ticket persists job_id + application_service_id.
-- WHY:  BlendTicketDetail's UI has job + application-service dropdowns and passes
--       both in ticketPayload, but the live save_blend_ticket UPDATE omits them,
--       so create_invoice_from_blend_ticket's application-fee lines and quoted-
--       pricing branch (both gated on ticket.job_id / application_service_id) are
--       unreachable from the UI. Additive: two new CASE assignments in the SET
--       clause; nothing else changed (rebuilt verbatim from live pg_get_functiondef
--       of 20260608152631_save_blend_ticket_strict_actor, the sole overload).
-- SAFE: additive-only; no signature change; strict-actor + idempotency preserved.
--       NULLIF(...,'')::uuid so an empty UI value clears the link (no cast crash).
--
-- SMOKE (2026-07-02, live rolled-back BEGIN…ROLLBACK + plpgsql_check): PASS —
--   CREATE OR REPLACE parsed & created inside a tx; plpgsql_check = NO FINDINGS - CLEAN;
--   tx aborted via summary RAISE so nothing persisted (confirmed live fn still lacks the
--   application_service_id SET line, position()=0).
-- CODEX: CLEAN after 3 rounds. R1 flagged that persisting job_id enables mis-pricing from an
--   unrelated customer's quote (create_invoice_from_blend_ticket reads job.quote_section_id) →
--   added a job/customer-match guard. R2 flagged the sparse-payload edge (customer changed, job_id
--   omitted, old job left attached) → validate the EFFECTIVE job (payload's if present else current)
--   vs the effective customer. R3: "did not find an introduced correctness issue that would block."
-- ============================================================================

CREATE OR REPLACE FUNCTION public.save_blend_ticket(p_ticket_id uuid, p_ticket_payload jsonb, p_products jsonb, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_ticket_number text;
  v_existing jsonb;
  v_result jsonb;
  v_actor uuid;
  v_effective_customer uuid;
  v_current_job_id uuid;
  v_effective_job_id uuid;
BEGIN
  -- Strict-actor guard: authorize the REAL caller (auth.uid()), not a caller-supplied id.
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED';
  END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true
      AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  -- Idempotency check, AFTER the auth/role guard so a cached result can't leak.
  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'save_blend_ticket');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  SELECT ticket_number, customer_id, job_id
    INTO v_ticket_number, v_effective_customer, v_current_job_id
    FROM blend_tickets WHERE id = p_ticket_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Blend ticket not found: %', p_ticket_id;
  END IF;

  -- A2 hardening (Codex P2): a linked job must belong to the ticket's customer, else
  -- create_invoice_from_blend_ticket could pull quoted pricing (via job.quote_section_id)
  -- from an unrelated customer's quote. Validate the EFFECTIVE pair AFTER this save:
  -- the effective customer (payload's if supplied, else current) and the effective job
  -- (payload's if the key is present — possibly cleared to NULL — else the current link).
  -- This also catches a sparse payload that changes customer_id but leaves the old job
  -- attached (which would otherwise silently mismatch).
  IF p_ticket_payload ? 'customer_id' THEN
    v_effective_customer := (p_ticket_payload->>'customer_id')::uuid;
  END IF;
  IF p_ticket_payload ? 'job_id' THEN
    v_effective_job_id := NULLIF(p_ticket_payload->>'job_id', '')::uuid;
  ELSE
    v_effective_job_id := v_current_job_id;
  END IF;
  IF v_effective_job_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM jobs j WHERE j.id = v_effective_job_id AND j.customer_id = v_effective_customer
  ) THEN
    RAISE EXCEPTION 'BLEND_JOB_CUSTOMER_MISMATCH';
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
    -- A2: persist the job + application-service links the UI already sends.
    job_id = CASE WHEN p_ticket_payload ? 'job_id'
      THEN NULLIF(p_ticket_payload->>'job_id', '')::uuid ELSE job_id END,
    application_service_id = CASE WHEN p_ticket_payload ? 'application_service_id'
      THEN NULLIF(p_ticket_payload->>'application_service_id', '')::uuid ELSE application_service_id END,
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
    v_actor, 'blend_ticket', p_ticket_id
  );

  v_result := jsonb_build_object('success', true, 'ticket_id', p_ticket_id, 'ticket_number', v_ticket_number);

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'save_blend_ticket', v_result);
  END IF;

  RETURN v_result;
END;
$function$;
