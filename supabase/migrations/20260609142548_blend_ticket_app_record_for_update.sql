-- Fix M1 + OBS-1 (foundation audit 2026-06-09): create_application_record_from_blend_ticket.
--
-- TWO fixes to this SECDEF, authenticated-executable RPC:
-- (1) M1 double-deduct race: it read the blend ticket with a plain (non-locking) SELECT,
--     checked `IF EXISTS (application_records ...)`, then created records + deducted inventory.
--     Two concurrent calls both passed the guard and both deducted. Added `FOR UPDATE` to the
--     blend_tickets SELECT so concurrent calls serialize (second re-checks EXISTS -> "already exist").
-- (2) OBS-1 ungated-SECDEF / actor-forgery: the function had NO in-function auth gate — it trusted
--     the caller-supplied p_performed_by (written to created_by / performed_by) and deducts inventory,
--     so any authenticated user could forge p_performed_by (admin id readable via profile_public_view)
--     via direct PostgREST. Added the same auth gate as its sibling create_invoice_from_blend_ticket:
--     auth.uid() bound actor + p_performed_by match + is_admin()/is_sales_rep(). Verified safe: the
--     only UI caller (BlendTicketDetail.tsx:681, admin/sales_rep-gated page) passes profile.id.
--
-- Body otherwise verbatim from live. Signature unchanged (one overload). Reversible.

CREATE OR REPLACE FUNCTION public.create_application_record_from_blend_ticket(p_blend_ticket_id uuid, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS uuid[]
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor          uuid := auth.uid();
  v_existing       text;
  v_ticket         record;
  v_product_data   jsonb;
  v_season         integer;
  v_bt_product     record;
  v_field          record;
  v_record_id      uuid;
  v_record_ids     uuid[] := '{}';
  v_record_number  text;
  v_applicator_id  uuid;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'p_performed_by does not match authenticated user';
  END IF;
  IF NOT (is_admin() OR is_sales_rep()) THEN
    RAISE EXCEPTION 'Not authorized: admin or sales role required to create application records from blend tickets';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing
      FROM idempotency_keys
      WHERE idempotency_key = p_idempotency_key;
    IF v_existing IS NOT NULL THEN
      RETURN string_to_array(v_existing, ',')::uuid[];
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
      COALESCE(v_ticket.ticket_date, v_ticket.upload_date)::date, v_ticket.ticket_time,
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
      COALESCE(v_ticket.ticket_date, v_ticket.upload_date)::date, v_ticket.ticket_time,
      v_product_data, v_ticket.total_acres,
      v_ticket.total_volume, v_ticket.total_volume_unit, NULL, v_ticket.notes, v_season, p_performed_by
    ) RETURNING id INTO v_record_id;
    v_record_ids := v_record_ids || v_record_id;
  END IF;

  FOR v_bt_product IN
    SELECT btp.product_id, btp.quantity FROM blend_ticket_products btp
    WHERE btp.blend_ticket_id = p_blend_ticket_id AND btp.product_id IS NOT NULL AND btp.quantity > 0
  LOOP
    UPDATE inventory SET quantity_available = quantity_available - v_bt_product.quantity, updated_at = now()
    WHERE product_id = v_bt_product.product_id AND location = 'Main Warehouse';
    INSERT INTO inventory_transactions (product_id, transaction_type, quantity, reference_id, performed_by, notes)
    VALUES (v_bt_product.product_id, 'delivered', v_bt_product.quantity, v_record_ids[1], p_performed_by,
      'Blend ticket application: ' || v_ticket.ticket_number);
  END LOOP;

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'create_app_record_from_bt', array_to_string(v_record_ids, ','));
  END IF;

  RETURN v_record_ids;
END;
$function$;
