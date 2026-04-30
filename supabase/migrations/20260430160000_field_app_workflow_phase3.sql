-- =============================================================================
-- Migration: 20260430160000_field_app_workflow_phase3.sql
-- Phase 3 of the Field Application Workflow rewrite — Inventory Completion Behavior.
--
-- See: docs/audits/2026-04-28-field-application-workflow-response-to-codex.md
-- Bundles fixes for codex audit item: #7.
--
-- Problems being fixed:
--   1. complete_job RAISES on insufficient inventory — blocks recording reality
--      when the field work already happened. The DB has to be able to capture
--      truth even when stock is short.
--   2. complete_job decrements quantity_prebooked unconditionally for every
--      job_applied transaction. If Customer A has a 100gal prebook and
--      Customer B's job applies 50gal of the same SKU without being tied to
--      A's order, A's prebook gets silently halved. Net-free math breaks
--      downstream.
--
-- Fixes:
--   1. inventory_transactions.requires_review flag for short-stock applications
--   2. inventory_transactions.job_id FK so the audit trail joins back cleanly
--   3. complete_job now allows short-stock completion (audit row carries
--      requires_review = true) and only decrements quantity_prebooked when the
--      job is linked to the source hold via jobs.quote_section_id →
--      inventory_holds.source_id.
-- =============================================================================


-- =============================================================================
-- 1. SCHEMA
-- =============================================================================

ALTER TABLE inventory_transactions
  ADD COLUMN IF NOT EXISTS requires_review boolean NOT NULL DEFAULT false;

ALTER TABLE inventory_transactions
  ADD COLUMN IF NOT EXISTS job_id uuid REFERENCES jobs(id);

CREATE INDEX IF NOT EXISTS idx_inv_tx_job_id ON inventory_transactions(job_id) WHERE job_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_inv_tx_requires_review
  ON inventory_transactions(requires_review)
  WHERE requires_review = true;

COMMENT ON COLUMN inventory_transactions.requires_review IS
  'Phase 3 (2026-04-30): set true when an application happened on stock that went negative. Surfaces in dashboard alerts so an admin can investigate (PO not received, miscount, etc.) without blocking the field work.';

COMMENT ON COLUMN inventory_transactions.job_id IS
  'Phase 3 (2026-04-30): links job_applied transactions back to the source job for audit trail.';


-- =============================================================================
-- 2. REWRITE: complete_job — short-stock-tolerant + linked-prebook decrement
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
  v_short_count    int := 0;
  v_hold_qty       numeric;
  v_decrement_pb   numeric;
  v_new_avail      numeric;
  v_short_flag     boolean;
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

  -- Phase 3: NO MORE pre-flight inventory exception. Field work happened;
  -- the DB has to record reality. Short stock surfaces via requires_review.

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
    v_job.customer_id, v_job.applicator_id, v_first_field_id,
    v_job.job_date, v_product_data,
    v_job.total_acres,
    (p_applied_info->>'actual_gallons_applied')::numeric,
    'gallons',
    v_job.vehicle_id, v_weather, v_job.notes, v_job.season,
    p_performed_by
  )
  RETURNING id INTO v_record_id;

  FOR v_jf IN
    SELECT jf.field_id,
           COALESCE(jf.acres_to_treat, f.total_acres, 0) AS acres,
           COALESCE(jf.sort_order, 0)                    AS sort_order
      FROM job_fields jf
      JOIN fields f ON f.id = jf.field_id
     WHERE jf.job_id = p_job_id
     ORDER BY jf.sort_order, jf.id
  LOOP
    INSERT INTO application_record_fields (application_record_id, field_id, acres, sort_order)
    VALUES (v_record_id, v_jf.field_id, v_jf.acres, v_jf.sort_order);
    v_field_count := v_field_count + 1;
  END LOOP;

  -- Phase 3: per-chemical inventory move with linked-prebook guard.
  FOR v_chem IN
    SELECT jc.product_id, jc.quantity, jc.unit
      FROM job_chemicals jc
     WHERE jc.job_id = p_job_id AND jc.quantity > 0
  LOOP
    SELECT * INTO v_inv
      FROM inventory
     WHERE product_id = v_chem.product_id AND location = 'Main Warehouse'
     FOR UPDATE;

    -- Look up a matching prebook hold for THIS job's quote linkage.
    -- Only linked prebooks should be drawn down. Otherwise we leave
    -- quantity_prebooked alone (other customers' holds stay intact).
    v_hold_qty := 0;
    IF v_job.quote_section_id IS NOT NULL THEN
      SELECT COALESCE(SUM(ih.quantity), 0) INTO v_hold_qty
        FROM inventory_holds ih
       WHERE ih.product_id  = v_chem.product_id
         AND ih.is_active   = true
         AND ih.source_id   = v_job.quote_section_id;
    END IF;

    -- We can only release as much prebook as we actually used (and as much as
    -- exists). Anything beyond that is "fresh" stock decrement.
    v_decrement_pb := LEAST(v_chem.quantity, COALESCE(v_hold_qty, 0));
    IF COALESCE(v_inv.quantity_prebooked, 0) < v_decrement_pb THEN
      v_decrement_pb := COALESCE(v_inv.quantity_prebooked, 0);
    END IF;

    v_new_avail  := COALESCE(v_inv.quantity_available, 0) - v_chem.quantity;
    v_short_flag := v_new_avail < 0;
    IF v_short_flag THEN
      v_short_count := v_short_count + 1;
    END IF;

    IF NOT FOUND THEN
      -- No inventory row exists at all — create one going negative so the
      -- short-stock state is queryable / reviewable.
      INSERT INTO inventory (product_id, location, quantity_available, quantity_prebooked, quantity_on_order)
      VALUES (v_chem.product_id, 'Main Warehouse', -v_chem.quantity, 0, 0);
    ELSE
      UPDATE inventory SET
        quantity_available = quantity_available - v_chem.quantity,
        quantity_prebooked = quantity_prebooked - v_decrement_pb,
        updated_at         = now()
      WHERE product_id = v_chem.product_id AND location = 'Main Warehouse';
    END IF;

    -- Reduce the matching hold quantities so net-free math doesn't double-count.
    IF v_decrement_pb > 0 AND v_job.quote_section_id IS NOT NULL THEN
      UPDATE inventory_holds SET
        quantity   = quantity - v_decrement_pb,
        is_active  = (quantity - v_decrement_pb) > 0,
        updated_at = now()
      WHERE id = (
        SELECT id FROM inventory_holds
         WHERE product_id  = v_chem.product_id
           AND is_active   = true
           AND source_id   = v_job.quote_section_id
         ORDER BY created_at LIMIT 1
      );
    END IF;

    INSERT INTO inventory_transactions (
      product_id, transaction_type, quantity, from_location,
      performed_by, notes, job_id, requires_review
    ) VALUES (
      v_chem.product_id, 'job_applied', v_chem.quantity, 'Main Warehouse',
      p_performed_by,
      'Job ' || v_job.job_number || ' completed — ' || v_chem.quantity || ' units applied' ||
        CASE WHEN v_short_flag    THEN ' [SHORT STOCK — review required]' ELSE '' END ||
        CASE WHEN v_decrement_pb > 0 THEN ' [linked prebook released: ' || v_decrement_pb || ']' ELSE '' END,
      p_job_id,
      v_short_flag
    );
  END LOOP;

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'job_completed',
    'Job ' || v_job.job_number || ' completed across ' || v_field_count || ' field(s). Application record: ' || v_record_number ||
      CASE WHEN v_short_count > 0
           THEN ' (⚠ ' || v_short_count || ' short-stock chemical(s) — review required)'
           ELSE '' END,
    p_performed_by, 'job', p_job_id, v_job.customer_id
  );

  v_result := jsonb_build_object(
    'success',                true,
    'job_id',                 p_job_id,
    'application_record_id',  v_record_id,
    'record_number',          v_record_number,
    'field_count',            v_field_count,
    'short_stock_count',      v_short_count
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
-- 3. VERIFICATION
-- =============================================================================

DO $$
DECLARE
  c1 int;
BEGIN
  SELECT count(*) INTO c1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'complete_job';
  IF c1 != 1 THEN
    RAISE EXCEPTION 'VERIFICATION FAILED: complete_job has % overloads (expected 1)', c1;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name='inventory_transactions' AND column_name='requires_review'
  ) THEN
    RAISE EXCEPTION 'VERIFICATION FAILED: inventory_transactions.requires_review missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name='inventory_transactions' AND column_name='job_id'
  ) THEN
    RAISE EXCEPTION 'VERIFICATION FAILED: inventory_transactions.job_id missing';
  END IF;

  RAISE NOTICE 'Phase 3 verified: complete_job rewritten, requires_review + job_id columns present';
END $$;
