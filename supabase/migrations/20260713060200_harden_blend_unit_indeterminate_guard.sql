-- Migration: fail safely when a blend-ticket product has no inventory unit metadata.
-- The function body is preserved from 20260704120000 except for the both-NULL A5 guard.
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
  -- A5: quantity converted to the product's inventory unit for the stock deduction
  v_deduct_qty     numeric;
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

  -- B1 lot propagation (ADDED): auto-fill application_record_lots from the blend ticket's
  -- per-product lot numbers so blend-sourced applications carry lots with no re-typing.
  -- Skips null product_id and blank lot_number; dedupes identical (product_id, lot_number)
  -- component rows; source_receiving_record_id stays NULL (these came from the blend, not a
  -- receiving record). Filtering keeps this insert from ever rolling back the whole RPC.
  INSERT INTO application_record_lots (application_record_id, product_id, lot_number, created_by)
  SELECT v_record_id, d.product_id, d.lot_number, p_performed_by
  FROM (
    SELECT DISTINCT ON (btp.product_id, lower(btrim(btp.lot_number)))
           btp.product_id, btrim(btp.lot_number) AS lot_number
    FROM blend_ticket_products btp
    WHERE btp.blend_ticket_id = p_blend_ticket_id
      AND btp.product_id IS NOT NULL
      AND btp.lot_number IS NOT NULL
      AND btrim(btp.lot_number) <> ''
    ORDER BY btp.product_id, lower(btrim(btp.lot_number))
  ) d;

  FOR v_field IN
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
    -- A5: join products for the inventory unit + form so the deduction converts.
    SELECT btp.product_id, btp.quantity, btp.unit AS qty_unit, btp.product_name,
           p.inventory_unit, p.unit_size, p.product_form
      FROM blend_ticket_products btp
      LEFT JOIN products p ON p.id = btp.product_id
    WHERE btp.blend_ticket_id = p_blend_ticket_id AND btp.product_id IS NOT NULL AND btp.quantity > 0
  LOOP
    -- A5: deduct in the product's inventory unit. The blend line quantity may be in a
    -- different unit (e.g. pints on a gallons-stocked product) — deducting the raw
    -- number corrupts stock by the unit ratio (the complete_job bug class).
    IF v_bt_product.inventory_unit IS NULL AND v_bt_product.unit_size IS NULL THEN
      RAISE EXCEPTION 'BLEND_TICKET_UNIT_UNCONVERTIBLE: product % (id %) has inventory_unit and unit_size unset',
        v_bt_product.product_name, v_bt_product.product_id;
    ELSE
      v_deduct_qty := field_app_priced_quantity(
                        v_bt_product.quantity,
                        normalize_rate_unit(NULLIF(btrim(v_bt_product.qty_unit), '')),
                        normalize_rate_unit(COALESCE(NULLIF(btrim(v_bt_product.inventory_unit), ''), v_bt_product.unit_size)),
                        v_bt_product.product_form);
      IF v_deduct_qty IS NULL THEN
        RAISE EXCEPTION 'BLEND_TICKET_UNIT_UNCONVERTIBLE: product % quantity unit "%" cannot convert to inventory unit "%"',
          v_bt_product.product_name, v_bt_product.qty_unit, COALESCE(v_bt_product.inventory_unit, v_bt_product.unit_size);
      END IF;
    END IF;

    SELECT * INTO v_inv
      FROM inventory
     WHERE product_id = v_bt_product.product_id AND location = 'Main Warehouse'
     FOR UPDATE;
    v_inv_found := FOUND;

    v_new_avail  := COALESCE(v_inv.quantity_available, 0) - v_deduct_qty;
    v_short_flag := v_new_avail < 0;
    IF v_short_flag THEN
      v_short_count := v_short_count + 1;
    END IF;

    IF NOT v_inv_found THEN
      INSERT INTO inventory (product_id, location, quantity_available, quantity_prebooked, quantity_on_order)
      VALUES (v_bt_product.product_id, 'Main Warehouse', -v_deduct_qty, 0, 0);
    ELSE
      UPDATE inventory
      SET quantity_available = quantity_available - v_deduct_qty,
          updated_at         = now()
      WHERE product_id = v_bt_product.product_id AND location = 'Main Warehouse';
    END IF;

    INSERT INTO inventory_transactions (
      product_id, transaction_type, quantity, from_location,
      performed_by, notes, requires_review
    ) VALUES (
      v_bt_product.product_id, 'job_applied', v_deduct_qty, 'Main Warehouse',
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

-- Re-assert the deliberate grant model (RLS reviewer H1). Live ACL is already
-- {authenticated, service_role} with no PUBLIC/anon, so this is a no-op that matches
-- convention and keeps the anon-exec invariant sweep permanently green.
-- caller-analysis: create_application_record_from_blend_ticket :: UI caller src/pages/BlendTicketDetail.tsx:733 calls via an authenticated Supabase session and retains EXECUTE (granted to authenticated). REVOKE strips only PUBLIC/anon, which live already lacks — zero access change.
REVOKE ALL ON FUNCTION public.create_application_record_from_blend_ticket(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_application_record_from_blend_ticket(uuid, uuid, text) TO authenticated, service_role;

