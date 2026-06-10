-- ============================================================================
-- Codex remediation-batch review (2026-06-10) — MED: multi-field blend
-- tickets duplicated application quantities.
--
-- The per-field loop created ONE application_record PER FIELD, each carrying
-- the ticket's FULL product_data and total_volume while inventory was
-- deducted only once — multi-field compliance reports would repeat the full
-- chemical quantity for every field, and the ledger referenced only
-- v_record_ids[1].
--
-- Fix: align to complete_job's design — ONE application_record per ticket
-- (field_id = first field) + one application_record_fields row per
-- blend_ticket_fields entry (acres per field). Quantities/volume appear
-- exactly once; the ledger references the single record id.
--
-- Design note (drift-reviewer M2 this round): the replaced per-record
-- COALESCE(btf.customer_id, ...) attribution is dropped — the single record
-- carries the ticket's customer. Per-field customer data stays intact on
-- blend_ticket_fields (Q6-B multi-customer BILLING runs through
-- create_invoice_from_blend_ticket and is unaffected); if a true
-- multi-customer compliance record is ever needed, revisit then.
--
-- Also (Codex follow-up, same edit): short stock was flagged only in the
-- ledger and invisible to the user (RPC returns uuid[]; UI always toasts
-- success). Now counts shorts and writes the complete_job-style
-- activity_feed entry with the ⚠ short-stock warning, so the feed surfaces
-- it without changing the RPC's return contract.
--
-- Safe to restructure: the record-creation path has NEVER run in prod
-- (0 blend tickets; prior versions crashed in the deduction loop — see
-- 20260610131129). Auth/time-cast blocks verbatim from live; the idempotency
-- lookup gains an operation scope (rls-security-reviewer M1 this round —
-- same class as the restore_quote_version fix in 20260608193139).
-- Return contract unchanged: uuid[] (now always exactly one element).
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
  v_short_count    int := 0;
  v_field_count    int := 0;
  v_first_field_id uuid;
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
      WHERE idempotency_key = p_idempotency_key
        AND operation = 'create_app_record_from_bt';
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

  -- ONE record per ticket (complete_job pattern): field_id = first field,
  -- per-field acres live in application_record_fields below.
  SELECT btf.field_id INTO v_first_field_id
    FROM blend_ticket_fields btf
   WHERE btf.blend_ticket_id = p_blend_ticket_id
   ORDER BY btf.sort_order
   LIMIT 1;

  v_record_number := next_application_record_number();
  INSERT INTO application_records (
    record_number, source_type, source_id, customer_id, applicator_id, field_id,
    application_date, application_time, product_data, total_acres,
    total_volume, total_volume_unit, weather_conditions, notes, season, created_by
  ) VALUES (
    v_record_number, 'blend_ticket', p_blend_ticket_id,
    v_ticket.customer_id, v_applicator_id, COALESCE(v_first_field_id, v_ticket.field_id),
    COALESCE(v_ticket.ticket_date, v_ticket.upload_date)::date, v_app_time,
    v_product_data, v_ticket.total_acres,
    v_ticket.total_volume, v_ticket.total_volume_unit, NULL, v_ticket.notes, v_season, p_performed_by
  ) RETURNING id INTO v_record_id;
  v_record_ids := v_record_ids || v_record_id;

  FOR v_field IN
    -- application_record_fields.acres is NOT NULL; btf acres columns are
    -- OCR-populated and nullable — fall back to the field's own total_acres
    -- then 0, exactly like complete_job (drift-reviewer H1 this round).
    SELECT btf.field_id,
           COALESCE(btf.actual_acres, btf.planned_acres, f.total_acres, 0) AS acres,
           COALESCE(btf.sort_order, 0) AS sort_order
    FROM blend_ticket_fields btf
    LEFT JOIN fields f ON f.id = btf.field_id
    WHERE btf.blend_ticket_id = p_blend_ticket_id ORDER BY btf.sort_order
  LOOP
    INSERT INTO application_record_fields (application_record_id, field_id, acres, sort_order)
    VALUES (v_record_id, v_field.field_id, v_field.acres, v_field.sort_order);
    v_field_count := v_field_count + 1;
  END LOOP;

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
    IF v_short_flag THEN
      v_short_count := v_short_count + 1;
    END IF;

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
        ' (application record ' || v_record_id::text || ')' ||
        CASE WHEN v_short_flag THEN ' [SHORT STOCK — review required]' ELSE '' END,
      v_short_flag
    );
  END LOOP;

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'application_record_created',
    'Application record ' || v_record_number || ' created from blend ticket ' || v_ticket.ticket_number ||
      ' (' || v_field_count || ' field(s))' ||
      CASE WHEN v_short_count > 0
           THEN ' (⚠ ' || v_short_count || ' short-stock chemical(s) — review required)'
           ELSE '' END,
    p_performed_by, 'blend_ticket', p_blend_ticket_id, v_ticket.customer_id
  );

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'create_app_record_from_bt', to_jsonb(v_record_ids));
  END IF;

  RETURN v_record_ids;
END;
$function$;

-- Verification: single overload; single-record design markers present
DO $$
DECLARE v_cnt int; v_src text;
BEGIN
  SELECT count(*) INTO v_cnt FROM pg_proc
  WHERE pronamespace = 'public'::regnamespace AND proname = 'create_application_record_from_blend_ticket';
  IF v_cnt <> 1 THEN
    RAISE EXCEPTION 'create_application_record_from_blend_ticket overload count = %, expected 1', v_cnt;
  END IF;
  SELECT prosrc INTO v_src FROM pg_proc
  WHERE pronamespace = 'public'::regnamespace AND proname = 'create_application_record_from_blend_ticket';
  IF v_src NOT ILIKE '%application_record_fields%' THEN
    RAISE EXCEPTION 'per-field application_record_fields inserts missing';
  END IF;
  IF v_src NOT ILIKE '%activity_feed%' THEN
    RAISE EXCEPTION 'short-stock activity_feed surfacing missing';
  END IF;
END $$;
