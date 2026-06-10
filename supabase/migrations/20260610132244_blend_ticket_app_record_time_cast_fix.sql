-- ============================================================================
-- M2d (found by the 2026-06-10 rolled-back smoke test, the 4th latent break
-- in this never-exercised RPC): both application_records INSERTs passed
-- blend_tickets.ticket_time (text) straight into application_time
-- (time without time zone) -> 42804 on every call that reaches the INSERT.
-- Pre-existing in the live baseline; carried forward by 20260610100002.
--
-- Fix: compute v_app_time once via an exception-wrapped cast — castable
-- clock strings become a time; anything else (free-text OCR output, range-
-- invalid digits like '99:99') becomes NULL rather than crashing. Body
-- otherwise identical to the reviewed + applied 20260610100002 version.
-- idempotency-body-check: exempt
-- ============================================================================

CREATE OR REPLACE FUNCTION public.create_application_record_from_blend_ticket(p_blend_ticket_id uuid, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS uuid[]
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor          uuid := auth.uid();
  v_existing       jsonb;
  v_ticket         record;
  v_product_data   jsonb;
  v_season         integer;
  v_bt_product     record;
  v_field          record;
  v_record_id      uuid;
  v_record_ids     uuid[] := '{}';
  v_record_number  text;
  v_applicator_id  uuid;
  v_inv            record;
  v_inv_found      boolean;
  v_new_avail      numeric;
  v_short_flag     boolean;
  v_app_time       time;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT (is_admin() OR is_sales_rep()) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE: admin or sales role required to create application records from blend tickets';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing
      FROM idempotency_keys
      WHERE idempotency_key = p_idempotency_key;
    IF v_existing IS NOT NULL THEN
      RETURN ARRAY(SELECT jsonb_array_elements_text(v_existing))::uuid[];
    END IF;
  END IF;

  SELECT bt.* INTO v_ticket FROM blend_tickets bt WHERE bt.id = p_blend_ticket_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Blend ticket not found: %', p_blend_ticket_id; END IF;
  IF v_ticket.review_status != 'approved' THEN
    RAISE EXCEPTION 'Blend ticket must be approved. Current status: %', v_ticket.review_status;
  END IF;

  IF EXISTS (
    SELECT 1 FROM application_records
    WHERE source_type = 'blend_ticket' AND source_id = p_blend_ticket_id
  ) THEN
    RAISE EXCEPTION 'Application record(s) already exist for this blend ticket';
  END IF;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'product_id', btp.product_id, 'product_name', btp.product_name,
        'quantity', btp.quantity, 'unit', btp.unit,
        'rate_per_acre', btp.rate_per_acre, 'rate_unit', btp.rate_per_acre_unit,
        'epa_registration', p.epa_registration, 'is_rup', COALESCE(p.is_rup, false)
      ) ORDER BY btp.sequence_order
    ), '[]'::jsonb
  ) INTO v_product_data
  FROM blend_ticket_products btp
  LEFT JOIN products p ON p.id = btp.product_id
  WHERE btp.blend_ticket_id = p_blend_ticket_id;

  v_season := CASE
    WHEN EXTRACT(MONTH FROM COALESCE(v_ticket.ticket_date, v_ticket.upload_date)::date) >= 10
    THEN EXTRACT(YEAR FROM COALESCE(v_ticket.ticket_date, v_ticket.upload_date)::date) + 1
    ELSE EXTRACT(YEAR FROM COALESCE(v_ticket.ticket_date, v_ticket.upload_date)::date)
  END;

  -- M2d: blend_tickets.ticket_time is free text (OCR) — castable clock
  -- strings become a time, ANYTHING else (free text, range-invalid digits
  -- like '99:99') becomes NULL instead of crashing (application_time is
  -- nullable). Exception sub-block per both reviewers: a shape regex alone
  -- still crashed on range-invalid matches.
  BEGIN
    v_app_time := NULLIF(btrim(v_ticket.ticket_time), '')::time;
  EXCEPTION WHEN OTHERS THEN
    v_app_time := NULL;
  END;

  v_applicator_id := v_ticket.applicator_id;
  IF v_applicator_id IS NULL AND v_ticket.applicator_name IS NOT NULL THEN
    SELECT id INTO v_applicator_id FROM profiles
    WHERE full_name = v_ticket.applicator_name AND role = 'applicator' LIMIT 1;
  END IF;

  FOR v_field IN
    SELECT btf.field_id, btf.customer_id, COALESCE(btf.actual_acres, btf.planned_acres) AS acres
    FROM blend_ticket_fields btf
    WHERE btf.blend_ticket_id = p_blend_ticket_id ORDER BY btf.sort_order
  LOOP
    v_record_number := next_application_record_number();
    INSERT INTO application_records (
      record_number, source_type, source_id, customer_id, applicator_id, field_id,
      application_date, application_time, product_data, total_acres,
      total_volume, total_volume_unit, weather_conditions, notes, season, created_by
    ) VALUES (
      v_record_number, 'blend_ticket', p_blend_ticket_id,
      COALESCE(v_field.customer_id, v_ticket.customer_id), v_applicator_id, v_field.field_id,
      COALESCE(v_ticket.ticket_date, v_ticket.upload_date)::date, v_app_time,
      v_product_data, COALESCE(v_field.acres, v_ticket.total_acres),
      v_ticket.total_volume, v_ticket.total_volume_unit, NULL, v_ticket.notes, v_season, p_performed_by
    ) RETURNING id INTO v_record_id;
    v_record_ids := v_record_ids || v_record_id;
  END LOOP;

  IF array_length(v_record_ids, 1) IS NULL THEN
    v_record_number := next_application_record_number();
    INSERT INTO application_records (
      record_number, source_type, source_id, customer_id, applicator_id, field_id,
      application_date, application_time, product_data, total_acres,
      total_volume, total_volume_unit, weather_conditions, notes, season, created_by
    ) VALUES (
      v_record_number, 'blend_ticket', p_blend_ticket_id,
      v_ticket.customer_id, v_applicator_id, v_ticket.field_id,
      COALESCE(v_ticket.ticket_date, v_ticket.upload_date)::date, v_app_time,
      v_product_data, v_ticket.total_acres,
      v_ticket.total_volume, v_ticket.total_volume_unit, NULL, v_ticket.notes, v_season, p_performed_by
    ) RETURNING id INTO v_record_id;
    v_record_ids := v_record_ids || v_record_id;
  END IF;

  FOR v_bt_product IN
    SELECT btp.product_id, btp.quantity FROM blend_ticket_products btp
    WHERE btp.blend_ticket_id = p_blend_ticket_id AND btp.product_id IS NOT NULL AND btp.quantity > 0
  LOOP
    SELECT * INTO v_inv
      FROM inventory
     WHERE product_id = v_bt_product.product_id AND location = 'Main Warehouse'
     FOR UPDATE;
    v_inv_found := FOUND;

    v_new_avail  := COALESCE(v_inv.quantity_available, 0) - v_bt_product.quantity;
    v_short_flag := v_new_avail < 0;

    IF NOT v_inv_found THEN
      INSERT INTO inventory (product_id, location, quantity_available, quantity_prebooked, quantity_on_order)
      VALUES (v_bt_product.product_id, 'Main Warehouse', -v_bt_product.quantity, 0, 0);
    ELSE
      UPDATE inventory
      SET quantity_available = quantity_available - v_bt_product.quantity,
          updated_at         = now()
      WHERE product_id = v_bt_product.product_id AND location = 'Main Warehouse';
    END IF;

    INSERT INTO inventory_transactions (
      product_id, transaction_type, quantity, from_location,
      performed_by, notes, requires_review
    ) VALUES (
      v_bt_product.product_id, 'job_applied', v_bt_product.quantity, 'Main Warehouse',
      p_performed_by,
      'Blend ticket application: ' || v_ticket.ticket_number ||
        ' (application record ' || v_record_ids[1]::text || ')' ||
        CASE WHEN v_short_flag THEN ' [SHORT STOCK — review required]' ELSE '' END,
      v_short_flag
    );
  END LOOP;

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'create_app_record_from_bt', to_jsonb(v_record_ids));
  END IF;

  RETURN v_record_ids;
END;
$function$;

-- Verification: single overload; cast guard present; raw text pass-through gone
DO $$
DECLARE v_cnt int; v_src text;
BEGIN
  SELECT count(*) INTO v_cnt FROM pg_proc
  WHERE pronamespace = 'public'::regnamespace AND proname = 'create_application_record_from_blend_ticket';
  IF v_cnt <> 1 THEN
    RAISE EXCEPTION 'overload count = %, expected 1', v_cnt;
  END IF;
  SELECT prosrc INTO v_src FROM pg_proc
  WHERE pronamespace = 'public'::regnamespace AND proname = 'create_application_record_from_blend_ticket';
  IF v_src NOT ILIKE '%v_app_time%' THEN
    RAISE EXCEPTION 'time-cast guard missing';
  END IF;
  IF v_src ILIKE '%::date, v_ticket.ticket_time,%' THEN
    RAISE EXCEPTION 'raw text ticket_time still passed to application_time';
  END IF;
END $$;
