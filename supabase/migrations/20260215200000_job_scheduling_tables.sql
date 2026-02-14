-- ============================================================================
-- SPRINT 8: JOB SCHEDULING SYSTEM
-- CRX Manager V1.0
-- Date: 2026-02-15
--
-- The job scheduling system is CheMan's core daily workflow. A "job" represents
-- a single application event: a customer, date, set of fields, list of chemicals,
-- assigned applicator + vehicle. Jobs flow through:
--   scheduled → in_progress → completed → invoiced
--
-- On completion, an application_record is auto-created and inventory deducted.
-- On transfer-to-invoice, an invoice is created from job chemicals.
-- ============================================================================

-- ============================================================================
-- 1. JOBS TABLE
-- ============================================================================

CREATE TABLE IF NOT EXISTS jobs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_number          text NOT NULL UNIQUE,           -- JOB-YYYY-NNNN
  customer_id         uuid NOT NULL REFERENCES customers(id),
  status              text NOT NULL DEFAULT 'scheduled'
                        CHECK (status IN ('scheduled','in_progress','completed','cancelled','invoiced')),
  job_date            date NOT NULL,
  scheduled_time      time,
  applicator_id       uuid REFERENCES profiles(id),
  vehicle_id          uuid REFERENCES vehicles(id),
  recipe_id           uuid REFERENCES blend_recipes(id),
  notes               text,
  tags                text[],
  batch_id            text,                           -- group related jobs
  season              integer,
  total_acres         numeric,
  total_cost_cents    bigint DEFAULT 0,
  total_price_cents   bigint DEFAULT 0,
  invoice_id          uuid REFERENCES invoices(id),   -- set when transferred
  created_by          uuid REFERENCES profiles(id),
  deleted_at          timestamptz,                    -- soft delete
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_jobs_customer ON jobs(customer_id);
CREATE INDEX IF NOT EXISTS idx_jobs_date ON jobs(job_date);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_applicator ON jobs(applicator_id);
CREATE INDEX IF NOT EXISTS idx_jobs_vehicle ON jobs(vehicle_id);
CREATE INDEX IF NOT EXISTS idx_jobs_season ON jobs(season);

CREATE TRIGGER set_jobs_updated_at
  BEFORE UPDATE ON jobs
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

-- ============================================================================
-- 2. JOB_FIELDS TABLE
-- ============================================================================

CREATE TABLE IF NOT EXISTS job_fields (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id          uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  field_id        uuid NOT NULL REFERENCES fields(id),
  acres_to_treat  numeric,
  sort_order      integer DEFAULT 0,
  UNIQUE(job_id, field_id)
);

CREATE INDEX IF NOT EXISTS idx_job_fields_job ON job_fields(job_id);

-- ============================================================================
-- 3. JOB_CHEMICALS TABLE
-- ============================================================================

CREATE TABLE IF NOT EXISTS job_chemicals (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id              uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  product_id          uuid NOT NULL REFERENCES products(id),
  quantity            numeric NOT NULL DEFAULT 0,
  unit                text,
  rate_per_acre       numeric,
  rate_unit           text,
  cost_per_unit_cents bigint DEFAULT 0,
  price_per_unit_cents bigint DEFAULT 0,
  sort_order          integer DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_job_chemicals_job ON job_chemicals(job_id);

-- ============================================================================
-- 4. JOB_APPLIED_INFO TABLE (filled on completion)
-- ============================================================================

CREATE TABLE IF NOT EXISTS job_applied_info (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id                  uuid NOT NULL REFERENCES jobs(id) UNIQUE,
  actual_start_time       timestamptz,
  actual_end_time         timestamptz,
  wind_speed              numeric,
  wind_direction          text,
  temperature             numeric,
  humidity                numeric,
  actual_gallons_applied  numeric,
  notes                   text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER set_job_applied_info_updated_at
  BEFORE UPDATE ON job_applied_info
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

-- ============================================================================
-- 5. RLS POLICIES
-- ============================================================================

ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_fields ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_chemicals ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_applied_info ENABLE ROW LEVEL SECURITY;

-- Jobs: admin + sales_rep full access; applicator can see assigned jobs
DROP POLICY IF EXISTS jobs_select ON jobs;
CREATE POLICY jobs_select ON jobs
  FOR SELECT TO authenticated
  USING (
    is_admin() OR is_sales_rep()
    OR (is_applicator() AND applicator_id = (SELECT auth.uid()))
  );

DROP POLICY IF EXISTS jobs_insert ON jobs;
CREATE POLICY jobs_insert ON jobs
  FOR INSERT TO authenticated
  WITH CHECK (is_admin() OR is_sales_rep());

DROP POLICY IF EXISTS jobs_update ON jobs;
CREATE POLICY jobs_update ON jobs
  FOR UPDATE TO authenticated
  USING (is_admin() OR is_sales_rep() OR (is_applicator() AND applicator_id = (SELECT auth.uid())))
  WITH CHECK (is_admin() OR is_sales_rep() OR (is_applicator() AND applicator_id = (SELECT auth.uid())));

DROP POLICY IF EXISTS jobs_delete ON jobs;
CREATE POLICY jobs_delete ON jobs
  FOR DELETE TO authenticated
  USING (is_admin());

-- Job fields, chemicals: inherit from parent job via RLS on jobs
DROP POLICY IF EXISTS job_fields_select ON job_fields;
CREATE POLICY job_fields_select ON job_fields
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM jobs WHERE jobs.id = job_fields.job_id AND (
    is_admin() OR is_sales_rep()
    OR (is_applicator() AND jobs.applicator_id = (SELECT auth.uid()))
  )));

DROP POLICY IF EXISTS job_fields_insert ON job_fields;
CREATE POLICY job_fields_insert ON job_fields
  FOR INSERT TO authenticated
  WITH CHECK (is_admin() OR is_sales_rep());

DROP POLICY IF EXISTS job_fields_update ON job_fields;
CREATE POLICY job_fields_update ON job_fields
  FOR UPDATE TO authenticated
  USING (is_admin() OR is_sales_rep())
  WITH CHECK (is_admin() OR is_sales_rep());

DROP POLICY IF EXISTS job_fields_delete ON job_fields;
CREATE POLICY job_fields_delete ON job_fields
  FOR DELETE TO authenticated
  USING (is_admin() OR is_sales_rep());

DROP POLICY IF EXISTS job_chemicals_select ON job_chemicals;
CREATE POLICY job_chemicals_select ON job_chemicals
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM jobs WHERE jobs.id = job_chemicals.job_id AND (
    is_admin() OR is_sales_rep()
    OR (is_applicator() AND jobs.applicator_id = (SELECT auth.uid()))
  )));

DROP POLICY IF EXISTS job_chemicals_insert ON job_chemicals;
CREATE POLICY job_chemicals_insert ON job_chemicals
  FOR INSERT TO authenticated
  WITH CHECK (is_admin() OR is_sales_rep());

DROP POLICY IF EXISTS job_chemicals_update ON job_chemicals;
CREATE POLICY job_chemicals_update ON job_chemicals
  FOR UPDATE TO authenticated
  USING (is_admin() OR is_sales_rep())
  WITH CHECK (is_admin() OR is_sales_rep());

DROP POLICY IF EXISTS job_chemicals_delete ON job_chemicals;
CREATE POLICY job_chemicals_delete ON job_chemicals
  FOR DELETE TO authenticated
  USING (is_admin() OR is_sales_rep());

DROP POLICY IF EXISTS job_applied_info_select ON job_applied_info;
CREATE POLICY job_applied_info_select ON job_applied_info
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM jobs WHERE jobs.id = job_applied_info.job_id AND (
    is_admin() OR is_sales_rep()
    OR (is_applicator() AND jobs.applicator_id = (SELECT auth.uid()))
  )));

DROP POLICY IF EXISTS job_applied_info_insert ON job_applied_info;
CREATE POLICY job_applied_info_insert ON job_applied_info
  FOR INSERT TO authenticated
  WITH CHECK (is_admin() OR is_sales_rep() OR is_applicator());

DROP POLICY IF EXISTS job_applied_info_update ON job_applied_info;
CREATE POLICY job_applied_info_update ON job_applied_info
  FOR UPDATE TO authenticated
  USING (is_admin() OR is_sales_rep() OR is_applicator())
  WITH CHECK (is_admin() OR is_sales_rep() OR is_applicator());

-- ============================================================================
-- 6. next_job_number()
-- ============================================================================

CREATE OR REPLACE FUNCTION next_job_number()
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
  PERFORM pg_advisory_xact_lock(hashtext('next_job_number'));

  SELECT COALESCE(
    MAX(
      CASE
        WHEN job_number ~ ('^JOB-' || v_year || '-\d+$')
        THEN CAST(split_part(job_number, '-', 3) AS int)
        ELSE 0
      END
    ),
    0
  )
  INTO v_max_num
  FROM jobs;

  v_next := 'JOB-' || v_year || '-' || lpad((v_max_num + 1)::text, 4, '0');
  RETURN v_next;
END;
$$;

GRANT EXECUTE ON FUNCTION next_job_number() TO authenticated;

-- ============================================================================
-- 7. save_job() — Atomic save for job + fields + chemicals
-- ============================================================================

CREATE OR REPLACE FUNCTION save_job(
  p_job_id uuid,           -- NULL for new, existing ID for edit
  p_job_payload jsonb,     -- Job header fields
  p_fields jsonb,          -- Array of { field_id, acres_to_treat, sort_order }
  p_chemicals jsonb,       -- Array of { product_id, quantity, unit, rate_per_acre, rate_unit, cost_per_unit_cents, price_per_unit_cents, sort_order }
  p_performed_by uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job_id uuid;
  v_is_new boolean := (p_job_id IS NULL);
  v_field jsonb;
  v_chem jsonb;
  v_season integer;
  v_job_date date;
BEGIN
  -- Auth check
  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = p_performed_by AND is_active = true
      AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'Not authorized to save jobs';
  END IF;

  v_job_date := (p_job_payload->>'job_date')::date;
  v_season := CASE
    WHEN EXTRACT(MONTH FROM v_job_date) >= 7
    THEN EXTRACT(YEAR FROM v_job_date) + 1
    ELSE EXTRACT(YEAR FROM v_job_date)
  END;

  IF v_is_new THEN
    INSERT INTO jobs (
      job_number, customer_id, status, job_date, scheduled_time,
      applicator_id, vehicle_id, recipe_id,
      notes, tags, batch_id, season,
      total_acres, total_cost_cents, total_price_cents,
      created_by
    ) VALUES (
      next_job_number(),
      (p_job_payload->>'customer_id')::uuid,
      COALESCE(p_job_payload->>'status', 'scheduled'),
      v_job_date,
      CASE WHEN p_job_payload->>'scheduled_time' IS NOT NULL
        THEN (p_job_payload->>'scheduled_time')::time ELSE NULL END,
      CASE WHEN p_job_payload->>'applicator_id' IS NOT NULL AND p_job_payload->>'applicator_id' != ''
        THEN (p_job_payload->>'applicator_id')::uuid ELSE NULL END,
      CASE WHEN p_job_payload->>'vehicle_id' IS NOT NULL AND p_job_payload->>'vehicle_id' != ''
        THEN (p_job_payload->>'vehicle_id')::uuid ELSE NULL END,
      CASE WHEN p_job_payload->>'recipe_id' IS NOT NULL AND p_job_payload->>'recipe_id' != ''
        THEN (p_job_payload->>'recipe_id')::uuid ELSE NULL END,
      p_job_payload->>'notes',
      CASE WHEN p_job_payload->'tags' IS NOT NULL
        THEN ARRAY(SELECT jsonb_array_elements_text(p_job_payload->'tags'))
        ELSE NULL END,
      p_job_payload->>'batch_id',
      v_season,
      COALESCE((p_job_payload->>'total_acres')::numeric, 0),
      COALESCE((p_job_payload->>'total_cost_cents')::bigint, 0),
      COALESCE((p_job_payload->>'total_price_cents')::bigint, 0),
      p_performed_by
    )
    RETURNING id INTO v_job_id;
  ELSE
    -- Lock the existing job
    SELECT id INTO v_job_id FROM jobs WHERE id = p_job_id FOR UPDATE;
    IF v_job_id IS NULL THEN
      RAISE EXCEPTION 'Job not found: %', p_job_id;
    END IF;

    UPDATE jobs SET
      customer_id = (p_job_payload->>'customer_id')::uuid,
      job_date = v_job_date,
      scheduled_time = CASE WHEN p_job_payload->>'scheduled_time' IS NOT NULL
        THEN (p_job_payload->>'scheduled_time')::time ELSE NULL END,
      applicator_id = CASE WHEN p_job_payload->>'applicator_id' IS NOT NULL AND p_job_payload->>'applicator_id' != ''
        THEN (p_job_payload->>'applicator_id')::uuid ELSE NULL END,
      vehicle_id = CASE WHEN p_job_payload->>'vehicle_id' IS NOT NULL AND p_job_payload->>'vehicle_id' != ''
        THEN (p_job_payload->>'vehicle_id')::uuid ELSE NULL END,
      recipe_id = CASE WHEN p_job_payload->>'recipe_id' IS NOT NULL AND p_job_payload->>'recipe_id' != ''
        THEN (p_job_payload->>'recipe_id')::uuid ELSE NULL END,
      notes = p_job_payload->>'notes',
      tags = CASE WHEN p_job_payload->'tags' IS NOT NULL
        THEN ARRAY(SELECT jsonb_array_elements_text(p_job_payload->'tags'))
        ELSE NULL END,
      batch_id = p_job_payload->>'batch_id',
      season = v_season,
      total_acres = COALESCE((p_job_payload->>'total_acres')::numeric, 0),
      total_cost_cents = COALESCE((p_job_payload->>'total_cost_cents')::bigint, 0),
      total_price_cents = COALESCE((p_job_payload->>'total_price_cents')::bigint, 0)
    WHERE id = v_job_id;
  END IF;

  -- Replace fields
  DELETE FROM job_fields WHERE job_id = v_job_id;
  FOR v_field IN SELECT * FROM jsonb_array_elements(p_fields) LOOP
    INSERT INTO job_fields (job_id, field_id, acres_to_treat, sort_order)
    VALUES (
      v_job_id,
      (v_field->>'field_id')::uuid,
      (v_field->>'acres_to_treat')::numeric,
      COALESCE((v_field->>'sort_order')::integer, 0)
    );
  END LOOP;

  -- Replace chemicals
  DELETE FROM job_chemicals WHERE job_id = v_job_id;
  FOR v_chem IN SELECT * FROM jsonb_array_elements(p_chemicals) LOOP
    INSERT INTO job_chemicals (job_id, product_id, quantity, unit, rate_per_acre, rate_unit, cost_per_unit_cents, price_per_unit_cents, sort_order)
    VALUES (
      v_job_id,
      (v_chem->>'product_id')::uuid,
      COALESCE((v_chem->>'quantity')::numeric, 0),
      v_chem->>'unit',
      (v_chem->>'rate_per_acre')::numeric,
      v_chem->>'rate_unit',
      COALESCE((v_chem->>'cost_per_unit_cents')::bigint, 0),
      COALESCE((v_chem->>'price_per_unit_cents')::bigint, 0),
      COALESCE((v_chem->>'sort_order')::integer, 0)
    );
  END LOOP;

  RETURN jsonb_build_object('success', true, 'job_id', v_job_id, 'is_new', v_is_new);
END;
$$;

GRANT EXECUTE ON FUNCTION save_job(uuid, jsonb, jsonb, jsonb, uuid) TO authenticated;

-- ============================================================================
-- 8. complete_job() — Mark complete, record applied info, create app record, deduct inventory
-- ============================================================================

CREATE OR REPLACE FUNCTION complete_job(
  p_job_id uuid,
  p_applied_info jsonb,   -- { actual_start_time, actual_end_time, wind_speed, wind_direction, temperature, humidity, actual_gallons_applied, notes }
  p_performed_by uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job RECORD;
  v_record_number text;
  v_record_id uuid;
  v_product_data jsonb;
  v_weather jsonb;
  v_chem RECORD;
  v_inv_id uuid;
BEGIN
  -- Lock the job
  SELECT j.*, c.farm_name AS customer_name
  INTO v_job
  FROM jobs j
  JOIN customers c ON c.id = j.customer_id
  WHERE j.id = p_job_id
  FOR UPDATE OF j;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Job not found: %', p_job_id;
  END IF;

  IF v_job.status NOT IN ('scheduled', 'in_progress') THEN
    RAISE EXCEPTION 'Job cannot be completed from status: %', v_job.status;
  END IF;

  -- Update job status
  UPDATE jobs SET status = 'completed' WHERE id = p_job_id;

  -- Insert applied info
  INSERT INTO job_applied_info (
    job_id, actual_start_time, actual_end_time,
    wind_speed, wind_direction, temperature, humidity,
    actual_gallons_applied, notes
  ) VALUES (
    p_job_id,
    CASE WHEN p_applied_info->>'actual_start_time' IS NOT NULL
      THEN (p_applied_info->>'actual_start_time')::timestamptz ELSE NULL END,
    CASE WHEN p_applied_info->>'actual_end_time' IS NOT NULL
      THEN (p_applied_info->>'actual_end_time')::timestamptz ELSE NULL END,
    (p_applied_info->>'wind_speed')::numeric,
    p_applied_info->>'wind_direction',
    (p_applied_info->>'temperature')::numeric,
    (p_applied_info->>'humidity')::numeric,
    (p_applied_info->>'actual_gallons_applied')::numeric,
    p_applied_info->>'notes'
  )
  ON CONFLICT (job_id) DO UPDATE SET
    actual_start_time = EXCLUDED.actual_start_time,
    actual_end_time = EXCLUDED.actual_end_time,
    wind_speed = EXCLUDED.wind_speed,
    wind_direction = EXCLUDED.wind_direction,
    temperature = EXCLUDED.temperature,
    humidity = EXCLUDED.humidity,
    actual_gallons_applied = EXCLUDED.actual_gallons_applied,
    notes = EXCLUDED.notes;

  -- Build product_data JSONB from job_chemicals
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'product_id', jc.product_id,
        'product_name', p.product_name,
        'quantity', jc.quantity,
        'unit', jc.unit,
        'rate_per_acre', jc.rate_per_acre,
        'rate_unit', jc.rate_unit,
        'epa_registration', p.epa_registration,
        'is_rup', COALESCE(p.is_rup, false)
      )
      ORDER BY jc.sort_order
    ),
    '[]'::jsonb
  )
  INTO v_product_data
  FROM job_chemicals jc
  LEFT JOIN products p ON p.id = jc.product_id
  WHERE jc.job_id = p_job_id;

  -- Build weather conditions
  v_weather := jsonb_build_object(
    'wind_speed', (p_applied_info->>'wind_speed')::numeric,
    'wind_direction', p_applied_info->>'wind_direction',
    'temperature', (p_applied_info->>'temperature')::numeric,
    'humidity', (p_applied_info->>'humidity')::numeric
  );

  -- Generate application record number
  v_record_number := next_application_record_number();

  -- Create application record
  INSERT INTO application_records (
    record_number, source_type, source_id,
    customer_id, applicator_id, field_id,
    application_date, product_data,
    total_acres, total_volume, total_volume_unit,
    vehicle_id, weather_conditions,
    notes, season, created_by
  ) VALUES (
    v_record_number, 'job', p_job_id,
    v_job.customer_id,
    v_job.applicator_id,
    -- Use first field from job_fields
    (SELECT field_id FROM job_fields WHERE job_id = p_job_id ORDER BY sort_order LIMIT 1),
    v_job.job_date,
    v_product_data,
    v_job.total_acres,
    (p_applied_info->>'actual_gallons_applied')::numeric,
    'gallons',
    v_job.vehicle_id,
    v_weather,
    v_job.notes,
    v_job.season,
    p_performed_by
  )
  RETURNING id INTO v_record_id;

  -- Deduct inventory for each chemical
  FOR v_chem IN
    SELECT jc.product_id, jc.quantity, jc.unit
    FROM job_chemicals jc
    WHERE jc.job_id = p_job_id AND jc.quantity > 0
  LOOP
    -- Find inventory row for this product
    SELECT inv.id INTO v_inv_id
    FROM inventory inv
    WHERE inv.product_id = v_chem.product_id
    LIMIT 1;

    IF v_inv_id IS NOT NULL THEN
      UPDATE inventory
      SET quantity_on_hand = quantity_on_hand - v_chem.quantity
      WHERE id = v_inv_id;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'job_id', p_job_id,
    'application_record_id', v_record_id,
    'record_number', v_record_number
  );
END;
$$;

GRANT EXECUTE ON FUNCTION complete_job(uuid, jsonb, uuid) TO authenticated;

-- ============================================================================
-- 9. transfer_job_to_invoice() — Create invoice from job, mark invoiced
-- ============================================================================

CREATE OR REPLACE FUNCTION transfer_job_to_invoice(
  p_job_id uuid,
  p_performed_by uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job RECORD;
  v_invoice_id uuid;
  v_invoice_number text;
  v_chem RECORD;
  v_item_order integer := 0;
BEGIN
  -- Lock the job
  SELECT j.* INTO v_job
  FROM jobs j WHERE j.id = p_job_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Job not found: %', p_job_id;
  END IF;

  IF v_job.status != 'completed' THEN
    RAISE EXCEPTION 'Only completed jobs can be transferred to invoice. Current status: %', v_job.status;
  END IF;

  IF v_job.invoice_id IS NOT NULL THEN
    RAISE EXCEPTION 'Job already has an invoice';
  END IF;

  -- Generate invoice number using existing pattern
  v_invoice_number := 'INV-' || extract(year FROM current_date)::text || '-' ||
    lpad((COALESCE(
      (SELECT MAX(CAST(split_part(invoice_number, '-', 3) AS int))
       FROM invoices
       WHERE invoice_number ~ ('^INV-' || extract(year FROM current_date)::text || '-\d+$')),
      0
    ) + 1)::text, 4, '0');

  -- Create invoice
  INSERT INTO invoices (
    invoice_number, customer_id, invoice_date, due_date,
    total_amount, status, notes, season, created_by
  ) VALUES (
    v_invoice_number,
    v_job.customer_id,
    current_date,
    current_date + interval '30 days',
    v_job.total_price_cents / 100.0,
    'unposted',
    'Auto-generated from job ' || v_job.job_number,
    v_job.season,
    p_performed_by
  )
  RETURNING id INTO v_invoice_id;

  -- Create invoice items from job chemicals
  FOR v_chem IN
    SELECT jc.*, p.product_name
    FROM job_chemicals jc
    JOIN products p ON p.id = jc.product_id
    WHERE jc.job_id = p_job_id
    ORDER BY jc.sort_order
  LOOP
    v_item_order := v_item_order + 1;
    INSERT INTO invoice_items (
      invoice_id, product_id, product_name,
      quantity, unit, unit_price, total_price, sort_order
    ) VALUES (
      v_invoice_id,
      v_chem.product_id,
      v_chem.product_name,
      v_chem.quantity,
      v_chem.unit,
      v_chem.price_per_unit_cents / 100.0,
      (v_chem.quantity * v_chem.price_per_unit_cents) / 100.0,
      v_item_order
    );
  END LOOP;

  -- Update job
  UPDATE jobs SET
    status = 'invoiced',
    invoice_id = v_invoice_id
  WHERE id = p_job_id;

  -- Link application record to invoice
  UPDATE application_records SET
    invoice_id = v_invoice_id
  WHERE source_type = 'job' AND source_id = p_job_id;

  RETURN jsonb_build_object(
    'success', true,
    'job_id', p_job_id,
    'invoice_id', v_invoice_id,
    'invoice_number', v_invoice_number
  );
END;
$$;

GRANT EXECUTE ON FUNCTION transfer_job_to_invoice(uuid, uuid) TO authenticated;

-- ============================================================================
-- 10. load_recipe_into_job() — Copy blend recipe items into job chemicals
-- ============================================================================

CREATE OR REPLACE FUNCTION load_recipe_into_job(
  p_job_id uuid,
  p_recipe_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer := 0;
  v_item RECORD;
BEGIN
  -- Verify job exists and is editable
  IF NOT EXISTS (
    SELECT 1 FROM jobs WHERE id = p_job_id AND status IN ('scheduled', 'in_progress')
  ) THEN
    RAISE EXCEPTION 'Job not found or not editable';
  END IF;

  -- Clear existing chemicals
  DELETE FROM job_chemicals WHERE job_id = p_job_id;

  -- Copy recipe items with current product pricing
  FOR v_item IN
    SELECT bri.*, p.cost_per_unit, p.unit AS product_unit
    FROM blend_recipe_items bri
    JOIN products p ON p.id = bri.product_id
    WHERE bri.recipe_id = p_recipe_id
    ORDER BY bri.sequence_order
  LOOP
    INSERT INTO job_chemicals (
      job_id, product_id, quantity, unit,
      rate_per_acre, rate_unit,
      cost_per_unit_cents, price_per_unit_cents,
      sort_order
    ) VALUES (
      p_job_id,
      v_item.product_id,
      v_item.quantity,
      v_item.unit,
      v_item.rate_per_acre,
      v_item.rate_unit,
      COALESCE(v_item.cost_per_unit * 100, 0)::bigint,
      0,  -- price set by user
      v_item.sequence_order
    );
    v_count := v_count + 1;
  END LOOP;

  -- Link recipe to job
  UPDATE jobs SET recipe_id = p_recipe_id WHERE id = p_job_id;

  RETURN jsonb_build_object('success', true, 'items_loaded', v_count);
END;
$$;

GRANT EXECUTE ON FUNCTION load_recipe_into_job(uuid, uuid) TO authenticated;
