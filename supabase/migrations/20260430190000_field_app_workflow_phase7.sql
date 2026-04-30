-- =============================================================================
-- Migration: 20260430190000_field_app_workflow_phase7.sql
-- Phase 7 of the Field Application Workflow rewrite — Codex re-review hot fixes.
--
-- See: docs/audits/2026-04-30-field-app-phase1-6-codex-rereview-findings.md
-- Bundles fixes for codex re-review findings: #1, #2, #3.
--
-- Fixes:
--   #1 (P1) start_job + complete_job had no internal auth gate. SECURITY
--      DEFINER means RLS doesn't help — any authenticated user could call
--      these RPCs for any job, mutating jobs/inventory/application_records
--      under their own auth.uid() with p_performed_by spoofed. Pattern
--      established in save_quote (auth.uid() match + role/ownership check).
--   #2 (P1) Phase 3 linked-prebook lookup matched inventory_holds.source_id
--      to jobs.quote_section_id, but planned holds are created with
--      source_id = quote_id (see 20260317100000_fix_idempotency_and_searchpath_final.sql:384,397).
--      Quote-linked jobs never released their prebooks → quantity_prebooked
--      drifts forever, net-free math wrong.
--   #3 (P2) Phase 3 multi-hold release summed all holds but only updated the
--      first one. With multiple active holds for the same quote+product
--      (planned-program flow creates one hold per quote_item), the first
--      hold could go negative and trip CHECK (quantity >= 0), failing the
--      whole completion transaction. Fix: oldest-first loop, take up to
--      each row's quantity.
-- =============================================================================


-- =============================================================================
-- 1. start_job — add auth gate
-- =============================================================================

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
  v_actor     uuid := auth.uid();
  v_existing  jsonb;
  v_job       record;
  v_now       timestamptz := now();
  v_result    jsonb;
BEGIN
  -- ── Phase 7 #1: authentication + identity match ─────────────────────────
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'p_performed_by does not match authenticated user';
  END IF;

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

  -- ── Phase 7 #1: authorization gate (admin/sales OR assigned applicator) ──
  IF NOT (
    is_admin() OR is_sales_rep()
    OR (is_applicator() AND v_job.applicator_id = v_actor)
  ) THEN
    RAISE EXCEPTION 'Not authorized to start this job';
  END IF;

  IF v_job.status = 'in_progress' THEN
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


-- =============================================================================
-- 2. complete_job — auth gate + #2 source_id fix + #3 multi-hold loop
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
  v_actor          uuid := auth.uid();
  v_existing       jsonb;
  v_job            record;
  v_record_number  text;
  v_record_id      uuid;
  v_product_data   jsonb;
  v_weather        jsonb;
  v_chem           record;
  v_inv            record;
  v_inv_found      boolean;
  v_jf             record;
  v_first_field_id uuid;
  v_field_count    int := 0;
  v_short_count    int := 0;
  v_hold_qty       numeric;
  v_decrement_pb   numeric;
  v_remaining      numeric;
  v_take           numeric;
  v_hold_row       record;
  v_new_avail      numeric;
  v_short_flag     boolean;
  v_result         jsonb;
BEGIN
  -- ── Phase 7 #1: authentication + identity match ─────────────────────────
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'p_performed_by does not match authenticated user';
  END IF;

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

  -- ── Phase 7 #1: authorization gate ───────────────────────────────────────
  IF NOT (
    is_admin() OR is_sales_rep()
    OR (is_applicator() AND v_job.applicator_id = v_actor)
  ) THEN
    RAISE EXCEPTION 'Not authorized to complete this job';
  END IF;

  IF v_job.status != 'in_progress' THEN
    RAISE EXCEPTION 'Job must be in_progress before completion. Current status: %. Use start_job() first.', v_job.status;
  END IF;

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

  -- ── Phase 7 #2 + #3: per-chemical inventory move ────────────────────────
  FOR v_chem IN
    SELECT jc.product_id, jc.quantity, jc.unit
      FROM job_chemicals jc
     WHERE jc.job_id = p_job_id AND jc.quantity > 0
  LOOP
    SELECT * INTO v_inv
      FROM inventory
     WHERE product_id = v_chem.product_id AND location = 'Main Warehouse'
     FOR UPDATE;
    v_inv_found := FOUND;

    -- Phase 7 #2: planned holds are keyed by quote_id (NOT quote_section_id).
    -- Verified against 20260317100000_fix_idempotency_and_searchpath_final.sql:384,397.
    v_hold_qty := 0;
    IF v_job.quote_id IS NOT NULL THEN
      SELECT COALESCE(SUM(ih.quantity), 0) INTO v_hold_qty
        FROM inventory_holds ih
       WHERE ih.product_id  = v_chem.product_id
         AND ih.is_active   = true
         AND ih.source_id   = v_job.quote_id;
    END IF;

    v_decrement_pb := LEAST(v_chem.quantity, COALESCE(v_hold_qty, 0));
    IF COALESCE(v_inv.quantity_prebooked, 0) < v_decrement_pb THEN
      v_decrement_pb := COALESCE(v_inv.quantity_prebooked, 0);
    END IF;

    v_new_avail  := COALESCE(v_inv.quantity_available, 0) - v_chem.quantity;
    v_short_flag := v_new_avail < 0;
    IF v_short_flag THEN
      v_short_count := v_short_count + 1;
    END IF;

    IF NOT v_inv_found THEN
      INSERT INTO inventory (product_id, location, quantity_available, quantity_prebooked, quantity_on_order)
      VALUES (v_chem.product_id, 'Main Warehouse', -v_chem.quantity, 0, 0);
    ELSE
      UPDATE inventory SET
        quantity_available = quantity_available - v_chem.quantity,
        quantity_prebooked = quantity_prebooked - v_decrement_pb,
        updated_at         = now()
      WHERE product_id = v_chem.product_id AND location = 'Main Warehouse';
    END IF;

    -- Phase 7 #3: drain matching holds oldest-first, never going negative.
    -- Single-row update was buggy: it would over-decrement the first hold
    -- when multiple were summed for the same quote+product.
    v_remaining := v_decrement_pb;
    IF v_remaining > 0 AND v_job.quote_id IS NOT NULL THEN
      FOR v_hold_row IN
        SELECT id, quantity FROM inventory_holds
         WHERE product_id  = v_chem.product_id
           AND is_active   = true
           AND source_id   = v_job.quote_id
         ORDER BY created_at, id
      LOOP
        EXIT WHEN v_remaining <= 0;
        v_take := LEAST(v_remaining, v_hold_row.quantity);
        UPDATE inventory_holds SET
          quantity   = quantity - v_take,
          is_active  = (quantity - v_take) > 0,
          updated_at = now()
        WHERE id = v_hold_row.id;
        v_remaining := v_remaining - v_take;
      END LOOP;
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


-- =============================================================================
-- 3. Verification — overload count only (per project SQL safety rules,
--    do not introspect function bodies).
-- =============================================================================

DO $$
DECLARE
  c1 int; c2 int;
BEGIN
  SELECT count(*) INTO c1 FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='start_job';
  SELECT count(*) INTO c2 FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='complete_job';
  IF c1 != 1 THEN RAISE EXCEPTION 'VERIFICATION FAILED: start_job has % overloads', c1; END IF;
  IF c2 != 1 THEN RAISE EXCEPTION 'VERIFICATION FAILED: complete_job has % overloads', c2; END IF;
  RAISE NOTICE 'Phase 7 verified: start_job + complete_job each have 1 overload';
END $$;
