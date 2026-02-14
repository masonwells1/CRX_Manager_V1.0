-- ============================================================================
-- SPRINT 7: APPLICATION RECORDS TABLE
-- CRX Manager V1.0
-- Date: 2026-02-14
--
-- Creates the application_records table — the single source of truth for
-- "what was applied, where, when, by whom." Data flows in from two sources:
--   1. Completed jobs (Sprint 8) → application_records
--   2. Approved blend tickets → application_records
--
-- Logbook reports (Sprint 9) read exclusively from this table.
-- ============================================================================

-- ============================================================================
-- 1. APPLICATION_RECORDS TABLE
-- ============================================================================

CREATE TABLE IF NOT EXISTS application_records (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  record_number       text NOT NULL UNIQUE,     -- APP-YYYY-NNNN
  source_type         text NOT NULL CHECK (source_type IN ('job', 'blend_ticket')),
  source_id           uuid NOT NULL,            -- FK to jobs.id or blend_tickets.id (polymorphic)
  customer_id         uuid NOT NULL REFERENCES customers(id),
  applicator_id       uuid REFERENCES profiles(id),
  field_id            uuid REFERENCES fields(id),
  application_date    date NOT NULL,
  application_time    time,
  -- Product data stored as JSONB array for flexibility and performance
  -- Each element: { product_id, product_name, quantity, unit, rate_per_acre, rate_unit, epa_registration, is_rup }
  product_data        jsonb NOT NULL DEFAULT '[]'::jsonb,
  total_acres         numeric,
  total_volume        numeric,
  total_volume_unit   text,
  vehicle_id          uuid REFERENCES vehicles(id),
  -- Weather at time of application (regulatory requirement for logbooks)
  weather_conditions  jsonb,
    -- { wind_speed, wind_direction, temperature, humidity }
  notes               text,
  season              integer,
  invoice_id          uuid REFERENCES invoices(id),   -- set when transferred to invoice
  created_by          uuid REFERENCES profiles(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- Indexes for common report queries
CREATE INDEX IF NOT EXISTS idx_app_records_customer ON application_records(customer_id);
CREATE INDEX IF NOT EXISTS idx_app_records_applicator ON application_records(applicator_id);
CREATE INDEX IF NOT EXISTS idx_app_records_field ON application_records(field_id);
CREATE INDEX IF NOT EXISTS idx_app_records_date ON application_records(application_date);
CREATE INDEX IF NOT EXISTS idx_app_records_season ON application_records(season);
CREATE INDEX IF NOT EXISTS idx_app_records_vehicle ON application_records(vehicle_id);
CREATE INDEX IF NOT EXISTS idx_app_records_source ON application_records(source_type, source_id);

-- ============================================================================
-- 2. RLS POLICIES
-- ============================================================================

ALTER TABLE application_records ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS app_records_select ON application_records;
CREATE POLICY app_records_select ON application_records
  FOR SELECT TO authenticated
  USING (is_admin() OR is_sales_rep() OR is_applicator());

DROP POLICY IF EXISTS app_records_insert ON application_records;
CREATE POLICY app_records_insert ON application_records
  FOR INSERT TO authenticated
  WITH CHECK (is_admin() OR is_sales_rep());

DROP POLICY IF EXISTS app_records_update ON application_records;
CREATE POLICY app_records_update ON application_records
  FOR UPDATE TO authenticated
  USING (is_admin())
  WITH CHECK (is_admin());

DROP POLICY IF EXISTS app_records_delete ON application_records;
CREATE POLICY app_records_delete ON application_records
  FOR DELETE TO authenticated
  USING (is_admin());

-- ============================================================================
-- 3. UPDATED_AT TRIGGER
-- ============================================================================

CREATE TRIGGER set_app_records_updated_at
  BEFORE UPDATE ON application_records
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

-- ============================================================================
-- 4. next_application_record_number()
--    Format: APP-YYYY-NNNN (year-scoped sequential, zero-padded 4 digits)
--    Uses advisory lock pattern from next_delivery_number() / next_po_number()
-- ============================================================================

CREATE OR REPLACE FUNCTION next_application_record_number()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_year text;
  v_max_num int;
  v_next text;
BEGIN
  v_year := extract(year FROM current_date)::text;

  PERFORM pg_advisory_xact_lock(hashtext('next_application_record_number'));

  SELECT COALESCE(
    MAX(
      CASE
        WHEN record_number ~ ('^APP-' || v_year || '-\d+$')
        THEN CAST(split_part(record_number, '-', 3) AS int)
        ELSE 0
      END
    ),
    0
  )
  INTO v_max_num
  FROM application_records;

  v_next := 'APP-' || v_year || '-' || lpad((v_max_num + 1)::text, 4, '0');

  RETURN v_next;
END;
$$;

GRANT EXECUTE ON FUNCTION next_application_record_number() TO authenticated;

-- ============================================================================
-- 5. create_application_record_from_blend_ticket()
--    Pulls data from an approved blend ticket and inserts into application_records.
--    Only works if the blend ticket has review_status = 'approved'.
-- ============================================================================

CREATE OR REPLACE FUNCTION create_application_record_from_blend_ticket(
  p_blend_ticket_id uuid,
  p_performed_by uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ticket RECORD;
  v_record_number text;
  v_product_data jsonb;
  v_record_id uuid;
  v_season integer;
BEGIN
  -- Fetch the blend ticket
  SELECT bt.*, f.id AS linked_field_id
  INTO v_ticket
  FROM blend_tickets bt
  LEFT JOIN fields f ON f.id = bt.field_id
  WHERE bt.id = p_blend_ticket_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Blend ticket not found: %', p_blend_ticket_id;
  END IF;

  IF v_ticket.review_status != 'approved' THEN
    RAISE EXCEPTION 'Blend ticket must be approved before creating an application record. Current status: %', v_ticket.review_status;
  END IF;

  -- Check if an application record already exists for this blend ticket
  IF EXISTS (
    SELECT 1 FROM application_records
    WHERE source_type = 'blend_ticket' AND source_id = p_blend_ticket_id
  ) THEN
    RAISE EXCEPTION 'An application record already exists for this blend ticket';
  END IF;

  -- Generate record number
  v_record_number := next_application_record_number();

  -- Build product_data JSONB from blend_ticket_products
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'product_id', btp.product_id,
        'product_name', btp.product_name,
        'quantity', btp.quantity,
        'unit', btp.unit,
        'rate_per_acre', btp.rate_per_acre,
        'rate_unit', btp.rate_per_acre_unit,
        'epa_registration', p.epa_registration,
        'is_rup', COALESCE(p.is_rup, false)
      )
      ORDER BY btp.sequence_order
    ),
    '[]'::jsonb
  )
  INTO v_product_data
  FROM blend_ticket_products btp
  LEFT JOIN products p ON p.id = btp.product_id
  WHERE btp.blend_ticket_id = p_blend_ticket_id;

  -- Calculate season from application date
  v_season := CASE
    WHEN EXTRACT(MONTH FROM COALESCE(v_ticket.ticket_date, v_ticket.upload_date)::date) >= 7
    THEN EXTRACT(YEAR FROM COALESCE(v_ticket.ticket_date, v_ticket.upload_date)::date) + 1
    ELSE EXTRACT(YEAR FROM COALESCE(v_ticket.ticket_date, v_ticket.upload_date)::date)
  END;

  -- Insert the application record
  INSERT INTO application_records (
    record_number, source_type, source_id,
    customer_id, applicator_id, field_id,
    application_date, application_time,
    product_data, total_acres, total_volume, total_volume_unit,
    weather_conditions, notes, season, created_by
  )
  VALUES (
    v_record_number, 'blend_ticket', p_blend_ticket_id,
    v_ticket.customer_id,
    -- Try to find the applicator profile by name
    (SELECT id FROM profiles WHERE full_name = v_ticket.applicator_name AND role = 'applicator' LIMIT 1),
    v_ticket.linked_field_id,
    COALESCE(v_ticket.ticket_date, v_ticket.upload_date)::date,
    v_ticket.ticket_time,
    v_product_data,
    v_ticket.total_acres,
    v_ticket.total_volume,
    v_ticket.total_volume_unit,
    NULL,  -- weather not captured on blend tickets
    v_ticket.notes,
    v_season,
    p_performed_by
  )
  RETURNING id INTO v_record_id;

  RETURN v_record_id;
END;
$$;

GRANT EXECUTE ON FUNCTION create_application_record_from_blend_ticket(uuid, uuid) TO authenticated;
