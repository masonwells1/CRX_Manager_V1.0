-- ============================================================================
-- Phase 1: Fix Broken Connections (B3, B5, B6, B8)
-- B3: Add cost/price columns to blend_ticket_products
-- B5: Multi-field application records from blend tickets
-- B6: Job FK on blend_tickets (alongside text job_number)
-- B7: SKIP — void_order/cancel_order already cascade commissions
-- B8: FSA numbers — UI-only change (columns already exist on fields table)
-- ============================================================================

-- ---------------------------------------------------------------------------
-- B3: Snapshot cost/price at blend ticket creation/approval time
-- ---------------------------------------------------------------------------
ALTER TABLE blend_ticket_products
  ADD COLUMN IF NOT EXISTS unit_cost_cents bigint,
  ADD COLUMN IF NOT EXISTS unit_price_cents bigint;

COMMENT ON COLUMN blend_ticket_products.unit_cost_cents
  IS 'Product cost snapshot at ticket creation — source of truth for invoicing';
COMMENT ON COLUMN blend_ticket_products.unit_price_cents
  IS 'Customer tier price snapshot at ticket creation — source of truth for invoicing';

-- ---------------------------------------------------------------------------
-- B6: Job FK on blend_tickets (OCR still populates job_number text)
-- ---------------------------------------------------------------------------
ALTER TABLE blend_tickets
  ADD COLUMN IF NOT EXISTS job_id uuid REFERENCES jobs(id);

CREATE INDEX IF NOT EXISTS idx_blend_tickets_job
  ON blend_tickets(job_id) WHERE job_id IS NOT NULL;

COMMENT ON COLUMN blend_tickets.job_id
  IS 'FK to actual job record. Set when user links ticket to a job (OCR text job_number kept for display).';

-- ---------------------------------------------------------------------------
-- B5: Multi-field application records from blend tickets
-- Returns uuid[] (one application_record per field)
-- Falls back to blend_tickets.field_id if no blend_ticket_fields rows
-- ---------------------------------------------------------------------------

-- Must drop old version first — return type changed from uuid to uuid[]
-- CREATE OR REPLACE cannot change return types
DROP FUNCTION IF EXISTS public.create_application_record_from_blend_ticket(uuid, uuid, text);

CREATE FUNCTION create_application_record_from_blend_ticket(
  p_blend_ticket_id uuid,
  p_performed_by    uuid,
  p_idempotency_key text DEFAULT NULL
)
RETURNS uuid[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
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
  -- Idempotency check
  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing
      FROM idempotency_keys
      WHERE idempotency_key = p_idempotency_key;
    IF v_existing IS NOT NULL THEN
      RETURN string_to_array(v_existing, ',')::uuid[];
    END IF;
  END IF;

  -- Fetch the blend ticket
  SELECT bt.*
  INTO v_ticket
  FROM blend_tickets bt
  WHERE bt.id = p_blend_ticket_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Blend ticket not found: %', p_blend_ticket_id;
  END IF;

  IF v_ticket.review_status != 'approved' THEN
    RAISE EXCEPTION 'Blend ticket must be approved. Current status: %', v_ticket.review_status;
  END IF;

  -- Prevent duplicate application records
  IF EXISTS (
    SELECT 1 FROM application_records
    WHERE source_type = 'blend_ticket' AND source_id = p_blend_ticket_id
  ) THEN
    RAISE EXCEPTION 'Application record(s) already exist for this blend ticket';
  END IF;

  -- Build product_data JSONB from blend_ticket_products
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'product_id',       btp.product_id,
        'product_name',     btp.product_name,
        'quantity',         btp.quantity,
        'unit',             btp.unit,
        'rate_per_acre',    btp.rate_per_acre,
        'rate_unit',        btp.rate_per_acre_unit,
        'epa_registration', p.epa_registration,
        'is_rup',           COALESCE(p.is_rup, false)
      )
      ORDER BY btp.sequence_order
    ),
    '[]'::jsonb
  )
  INTO v_product_data
  FROM blend_ticket_products btp
  LEFT JOIN products p ON p.id = btp.product_id
  WHERE btp.blend_ticket_id = p_blend_ticket_id;

  -- Calculate season (Oct 1 = new season)
  v_season := CASE
    WHEN EXTRACT(MONTH FROM COALESCE(v_ticket.ticket_date, v_ticket.upload_date)::date) >= 10
    THEN EXTRACT(YEAR FROM COALESCE(v_ticket.ticket_date, v_ticket.upload_date)::date) + 1
    ELSE EXTRACT(YEAR FROM COALESCE(v_ticket.ticket_date, v_ticket.upload_date)::date)
  END;

  -- Resolve applicator — prefer FK, fall back to name match
  v_applicator_id := v_ticket.applicator_id;
  IF v_applicator_id IS NULL AND v_ticket.applicator_name IS NOT NULL THEN
    SELECT id INTO v_applicator_id
    FROM profiles
    WHERE full_name = v_ticket.applicator_name AND role = 'applicator'
    LIMIT 1;
  END IF;

  -- Gather fields: prefer blend_ticket_fields, fall back to blend_tickets.field_id
  FOR v_field IN
    SELECT btf.field_id, btf.customer_id, COALESCE(btf.actual_acres, btf.planned_acres) AS acres
    FROM blend_ticket_fields btf
    WHERE btf.blend_ticket_id = p_blend_ticket_id
    ORDER BY btf.sort_order
  LOOP
    v_record_number := next_application_record_number();

    INSERT INTO application_records (
      record_number, source_type, source_id,
      customer_id, applicator_id, field_id,
      application_date, application_time,
      product_data, total_acres, total_volume, total_volume_unit,
      weather_conditions, notes, season, created_by
    ) VALUES (
      v_record_number, 'blend_ticket', p_blend_ticket_id,
      COALESCE(v_field.customer_id, v_ticket.customer_id),
      v_applicator_id,
      v_field.field_id,
      COALESCE(v_ticket.ticket_date, v_ticket.upload_date)::date,
      v_ticket.ticket_time,
      v_product_data,
      COALESCE(v_field.acres, v_ticket.total_acres),
      v_ticket.total_volume,
      v_ticket.total_volume_unit,
      NULL,
      v_ticket.notes,
      v_season,
      p_performed_by
    )
    RETURNING id INTO v_record_id;

    v_record_ids := v_record_ids || v_record_id;
  END LOOP;

  -- Fallback: if no blend_ticket_fields rows, use blend_tickets.field_id
  IF array_length(v_record_ids, 1) IS NULL THEN
    v_record_number := next_application_record_number();

    INSERT INTO application_records (
      record_number, source_type, source_id,
      customer_id, applicator_id, field_id,
      application_date, application_time,
      product_data, total_acres, total_volume, total_volume_unit,
      weather_conditions, notes, season, created_by
    ) VALUES (
      v_record_number, 'blend_ticket', p_blend_ticket_id,
      v_ticket.customer_id,
      v_applicator_id,
      v_ticket.field_id,
      COALESCE(v_ticket.ticket_date, v_ticket.upload_date)::date,
      v_ticket.ticket_time,
      v_product_data,
      v_ticket.total_acres,
      v_ticket.total_volume,
      v_ticket.total_volume_unit,
      NULL,
      v_ticket.notes,
      v_season,
      p_performed_by
    )
    RETURNING id INTO v_record_id;

    v_record_ids := v_record_ids || v_record_id;
  END IF;

  -- Deduct inventory for each product (once, not per field)
  FOR v_bt_product IN
    SELECT btp.product_id, btp.quantity
    FROM blend_ticket_products btp
    WHERE btp.blend_ticket_id = p_blend_ticket_id
      AND btp.product_id IS NOT NULL
      AND btp.quantity > 0
  LOOP
    UPDATE inventory SET
      quantity_available = quantity_available - v_bt_product.quantity,
      updated_at         = now()
    WHERE product_id = v_bt_product.product_id
      AND location   = 'Main Warehouse';

    INSERT INTO inventory_transactions (
      product_id, transaction_type, quantity,
      reference_id, performed_by, notes
    ) VALUES (
      v_bt_product.product_id,
      'delivered',
      v_bt_product.quantity,
      v_record_ids[1],
      p_performed_by,
      'Blend ticket application: ' || v_ticket.ticket_number
    );
  END LOOP;

  -- Save idempotency result
  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'create_app_record_from_bt', array_to_string(v_record_ids, ','));
  END IF;

  RETURN v_record_ids;
END;
$$;

-- Grant execute to authenticated (matches RLS pattern)
GRANT EXECUTE ON FUNCTION create_application_record_from_blend_ticket(uuid, uuid, text) TO authenticated;
