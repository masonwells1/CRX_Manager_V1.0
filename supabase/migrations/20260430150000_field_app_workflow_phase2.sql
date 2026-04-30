-- =============================================================================
-- Migration: 20260430150000_field_app_workflow_phase2.sql
-- Phase 2 of the Field Application Workflow rewrite — Job Lifecycle Repair.
--
-- See: docs/audits/2026-04-28-field-application-workflow-response-to-codex.md
-- Bundles fixes for codex audit items: #4, #5, #6.
--
-- Scope:
--   1. Schema:    application_record_fields join table (multi-field records)
--                 jobs.customer_id back to NOT NULL (revert of #5 mistake)
--                 application_records.field_id → nullable + DEPRECATED comment
--   2. New RPC:   start_job(uuid, uuid, text)            — scheduled → in_progress
--   3. Rewrite:   complete_job(uuid, jsonb, uuid, text)  — multi-field record
--   4. Verification: 1 overload check on start_job and complete_job
--
-- Pre-flight (verified before running):
--   SELECT count(*) FROM jobs WHERE customer_id IS NULL;       -- = 0
--   SELECT count(*) FROM application_records;                  -- = 0
--   SELECT 1 FROM information_schema.tables                    -- = false
--   WHERE table_name='application_record_fields';
-- =============================================================================


-- =============================================================================
-- 1. SCHEMA
-- =============================================================================

-- 1a. Restore NOT NULL on jobs.customer_id (codex #5 — Option A: jobs are single-customer).
--     Multi-customer billing is handled at invoice time via field_billing_defaults,
--     not at job time. Verified pre-flight: 0 rows have customer_id IS NULL.
ALTER TABLE jobs ALTER COLUMN customer_id SET NOT NULL;

-- 1b. application_record_fields: per-field detail for multi-field application records.
--     application_records.field_id (singular) is preserved for back-compat but
--     becomes optional; the join table is the source of truth for multi-field jobs.
CREATE TABLE IF NOT EXISTS application_record_fields (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_record_id  uuid NOT NULL REFERENCES application_records(id) ON DELETE CASCADE,
  field_id               uuid NOT NULL REFERENCES fields(id),
  acres                  numeric NOT NULL CHECK (acres >= 0),
  sort_order             int  NOT NULL DEFAULT 0,
  created_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT arf_unique_field_per_record UNIQUE (application_record_id, field_id)
);

CREATE INDEX IF NOT EXISTS idx_arf_record ON application_record_fields(application_record_id);
CREATE INDEX IF NOT EXISTS idx_arf_field  ON application_record_fields(field_id);

ALTER TABLE application_record_fields ENABLE ROW LEVEL SECURITY;

-- Mirror application_records' RLS pattern: admin/sales full, applicator read-only.
DROP POLICY IF EXISTS arf_select ON application_record_fields;
CREATE POLICY arf_select ON application_record_fields
  FOR SELECT
  USING (auth.uid() IS NOT NULL);

DROP POLICY IF EXISTS arf_insert ON application_record_fields;
CREATE POLICY arf_insert ON application_record_fields
  FOR INSERT
  WITH CHECK (
    EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role IN ('admin', 'sales_rep'))
  );

DROP POLICY IF EXISTS arf_update ON application_record_fields;
CREATE POLICY arf_update ON application_record_fields
  FOR UPDATE
  USING (
    EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
  );

DROP POLICY IF EXISTS arf_delete ON application_record_fields;
CREATE POLICY arf_delete ON application_record_fields
  FOR DELETE
  USING (
    EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON application_record_fields TO authenticated;

COMMENT ON TABLE application_record_fields IS
  'Per-field rows for multi-field application records. Phase 2 (2026-04-30): replaces the single-field reference in application_records.field_id, which is now legacy.';

-- 1c. application_records.field_id becomes nullable; new records use the join table.
ALTER TABLE application_records ALTER COLUMN field_id DROP NOT NULL;
COMMENT ON COLUMN application_records.field_id IS
  'DEPRECATED — single-field anchor kept for back-compat. Multi-field detail lives in application_record_fields. Phase 2 (2026-04-30).';


-- =============================================================================
-- 2. NEW RPC: start_job
--    Transitions scheduled → in_progress and stamps job_applied_info.actual_start_time.
--    Idempotent. Required before complete_job per the existing state machine.
-- =============================================================================

DROP FUNCTION IF EXISTS public.start_job(uuid, uuid, text);

CREATE OR REPLACE FUNCTION start_job(
  p_job_id          uuid,
  p_performed_by    uuid,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_existing  jsonb;
  v_job       record;
  v_now       timestamptz := now();
  v_result    jsonb;
BEGIN
  -- Idempotency replay
  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing
      FROM idempotency_keys
     WHERE idempotency_key = p_idempotency_key;
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  SELECT * INTO v_job FROM jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Job not found: %', p_job_id;
  END IF;

  IF v_job.status = 'in_progress' THEN
    -- Already started — return the existing job_applied_info actual_start_time
    v_result := jsonb_build_object(
      'job_id', p_job_id,
      'status', 'in_progress',
      'started_at', (SELECT actual_start_time FROM job_applied_info WHERE job_id = p_job_id),
      'already_started', true
    );
    IF p_idempotency_key IS NOT NULL THEN
      INSERT INTO idempotency_keys (idempotency_key, operation, result)
      VALUES (p_idempotency_key, 'start_job', v_result)
      ON CONFLICT (idempotency_key) DO NOTHING;
    END IF;
    RETURN v_result;
  END IF;

  IF v_job.status != 'scheduled' THEN
    RAISE EXCEPTION 'Cannot start job — current status is %, expected scheduled', v_job.status;
  END IF;

  UPDATE jobs SET status = 'in_progress' WHERE id = p_job_id;

  INSERT INTO job_applied_info (job_id, actual_start_time)
  VALUES (p_job_id, v_now)
  ON CONFLICT (job_id) DO UPDATE SET
    actual_start_time = COALESCE(job_applied_info.actual_start_time, EXCLUDED.actual_start_time);

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'job_started',
    'Job ' || v_job.job_number || ' started',
    p_performed_by, 'job', p_job_id, v_job.customer_id
  );

  v_result := jsonb_build_object(
    'job_id', p_job_id,
    'status', 'in_progress',
    'started_at', v_now,
    'already_started', false
  );

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'start_job', v_result);
  END IF;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION start_job(uuid, uuid, text) TO authenticated;

COMMENT ON FUNCTION start_job(uuid, uuid, text) IS
  'Phase 2 (2026-04-30): transitions a job from scheduled to in_progress and stamps job_applied_info.actual_start_time. Idempotent on second call when status is already in_progress.';


-- =============================================================================
-- 3. REWRITE: complete_job
--    Inserts ONE application_records row + N application_record_fields rows
--    so multi-field jobs no longer silently drop fields beyond the first one.
--    application_records.field_id is set to the FIRST field (back-compat for
--    callers that still read the column directly).
-- =============================================================================

CREATE OR REPLACE FUNCTION complete_job(
  p_job_id          uuid,
  p_applied_info    jsonb,
  p_performed_by    uuid,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_existing       jsonb;
  v_job            record;
  v_record_number  text;
  v_record_id      uuid;
  v_product_data   jsonb;
  v_weather        jsonb;
  v_chem           record;
  v_inv            record;
  v_jf             record;
  v_first_field_id uuid;
  v_field_count    int := 0;
  v_result         jsonb;
BEGIN
  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing
      FROM idempotency_keys
     WHERE idempotency_key = p_idempotency_key;
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  SELECT j.*, c.farm_name AS customer_name
    INTO v_job
    FROM jobs j
    JOIN customers c ON c.id = j.customer_id
   WHERE j.id = p_job_id
   FOR UPDATE OF j;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Job not found: %', p_job_id;
  END IF;

  IF v_job.status != 'in_progress' THEN
    RAISE EXCEPTION 'Job must be in_progress before completion. Current status: %. Use start_job() first.', v_job.status;
  END IF;

  -- Inventory pre-flight: same behavior as before — fail before any writes if
  -- any chemical is short. Phase 3 will relax this to allow short-stock with audit.
  FOR v_chem IN
    SELECT jc.product_id, jc.quantity, jc.unit, p.product_name
      FROM job_chemicals jc
      JOIN products p ON p.id = jc.product_id
     WHERE jc.job_id = p_job_id AND jc.quantity > 0
  LOOP
    SELECT * INTO v_inv
      FROM inventory
     WHERE product_id = v_chem.product_id AND location = 'Main Warehouse'
     FOR UPDATE;

    IF NOT FOUND OR v_inv.quantity_available < v_chem.quantity THEN
      RAISE EXCEPTION 'Insufficient inventory for %: need % units, only % available',
        v_chem.product_name,
        v_chem.quantity,
        COALESCE(v_inv.quantity_available, 0);
    END IF;
  END LOOP;

  UPDATE jobs SET status = 'completed' WHERE id = p_job_id;

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
    actual_start_time      = COALESCE(EXCLUDED.actual_start_time,      job_applied_info.actual_start_time),
    actual_end_time        = EXCLUDED.actual_end_time,
    wind_speed             = EXCLUDED.wind_speed,
    wind_direction         = EXCLUDED.wind_direction,
    temperature            = EXCLUDED.temperature,
    humidity               = EXCLUDED.humidity,
    actual_gallons_applied = EXCLUDED.actual_gallons_applied,
    notes                  = EXCLUDED.notes;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'product_id',       jc.product_id,
        'product_name',     p.product_name,
        'quantity',         jc.quantity,
        'unit',             jc.unit,
        'rate_per_acre',    jc.rate_per_acre,
        'rate_unit',        jc.rate_unit,
        'epa_registration', p.epa_registration,
        'is_rup',           COALESCE(p.is_rup, false)
      )
      ORDER BY jc.sort_order
    ),
    '[]'::jsonb
  )
  INTO v_product_data
  FROM job_chemicals jc
  LEFT JOIN products p ON p.id = jc.product_id
  WHERE jc.job_id = p_job_id;

  v_weather := jsonb_build_object(
    'wind_speed',     (p_applied_info->>'wind_speed')::numeric,
    'wind_direction', p_applied_info->>'wind_direction',
    'temperature',    (p_applied_info->>'temperature')::numeric,
    'humidity',       (p_applied_info->>'humidity')::numeric
  );

  v_record_number := next_application_record_number();

  -- Phase 2: pick the FIRST job_field as the legacy field_id anchor (preserves
  -- the application_records.field_id column for any callers reading it directly),
  -- but the join table is the source of truth for multi-field reporting.
  SELECT field_id INTO v_first_field_id
    FROM job_fields
   WHERE job_id = p_job_id
   ORDER BY sort_order, id
   LIMIT 1;

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
    v_first_field_id,
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

  -- Phase 2: per-field detail. Acres fall back from job_fields.acres_to_treat
  -- to fields.total_acres to 0.
  FOR v_jf IN
    SELECT jf.field_id,
           COALESCE(jf.acres_to_treat, f.total_acres, 0) AS acres,
           COALESCE(jf.sort_order, 0)                    AS sort_order
      FROM job_fields jf
      JOIN fields f ON f.id = jf.field_id
     WHERE jf.job_id = p_job_id
     ORDER BY jf.sort_order, jf.id
  LOOP
    INSERT INTO application_record_fields (
      application_record_id, field_id, acres, sort_order
    ) VALUES (
      v_record_id, v_jf.field_id, v_jf.acres, v_jf.sort_order
    );
    v_field_count := v_field_count + 1;
  END LOOP;

  -- Inventory deduction (unchanged from Phase 1 behavior)
  FOR v_chem IN
    SELECT jc.product_id, jc.quantity, jc.unit
      FROM job_chemicals jc
     WHERE jc.job_id = p_job_id AND jc.quantity > 0
  LOOP
    UPDATE inventory SET
      quantity_available = quantity_available - v_chem.quantity,
      quantity_prebooked = GREATEST(quantity_prebooked - v_chem.quantity, 0),
      updated_at         = now()
    WHERE product_id = v_chem.product_id AND location = 'Main Warehouse';

    INSERT INTO inventory_transactions (
      product_id, transaction_type, quantity, from_location,
      performed_by, notes
    ) VALUES (
      v_chem.product_id, 'job_applied', v_chem.quantity, 'Main Warehouse',
      p_performed_by,
      'Job ' || v_job.job_number || ' completed — ' || v_chem.quantity || ' units applied'
    );
  END LOOP;

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'job_completed',
    'Job ' || v_job.job_number || ' completed across ' || v_field_count || ' field(s). Application record: ' || v_record_number,
    p_performed_by, 'job', p_job_id, v_job.customer_id
  );

  v_result := jsonb_build_object(
    'success',               true,
    'job_id',                p_job_id,
    'application_record_id', v_record_id,
    'record_number',         v_record_number,
    'field_count',           v_field_count
  );

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'complete_job', v_result);
  END IF;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION complete_job(uuid, jsonb, uuid, text) TO authenticated;


-- =============================================================================
-- 4. VERIFICATION
-- =============================================================================

DO $$
DECLARE
  func_name      text;
  overload_count int;
  func_names     text[] := ARRAY['start_job', 'complete_job'];
BEGIN
  FOREACH func_name IN ARRAY func_names LOOP
    SELECT count(*) INTO overload_count
      FROM pg_proc p
      JOIN pg_namespace n ON p.pronamespace = n.oid
     WHERE n.nspname = 'public' AND p.proname = func_name;
    IF overload_count != 1 THEN
      RAISE EXCEPTION 'VERIFICATION FAILED: % has % overloads (expected 1)', func_name, overload_count;
    END IF;
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'application_record_fields') THEN
    RAISE EXCEPTION 'VERIFICATION FAILED: application_record_fields table not created';
  END IF;

  IF (SELECT is_nullable FROM information_schema.columns WHERE table_name='jobs' AND column_name='customer_id') = 'YES' THEN
    RAISE EXCEPTION 'VERIFICATION FAILED: jobs.customer_id is still nullable';
  END IF;

  RAISE NOTICE 'Phase 2 verified: start_job + complete_job have 1 overload each, application_record_fields exists, jobs.customer_id is NOT NULL';
END $$;
