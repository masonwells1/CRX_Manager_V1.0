-- Layer 2 · Part A · Cycle A5 — complete_job: drop the §3.5 buggy quote-hold drain
-- ============================================================================
-- Fixes the pre-existing §3.5 live bug AND makes complete_job correct under
-- Layer 2. complete_job's first act is `UPDATE jobs SET status='completed'`,
-- which now fires A4's `jobs` lifecycle trigger → _sync_job_holds releases the
-- job's own hold and re-syncs the parent quote (keeping the consumed draw, so the
-- crop_program hold stays correctly shrunk). The quote-hold / booking accounting
-- is therefore ALREADY owned by A4.
--
-- complete_job's old "Phase 7" drain (compute v_hold_qty from the quote's holds,
-- clamp v_decrement_pb to quantity_prebooked, decrement prebooked, and FIFO-drain
-- the quote's crop_program holds) is now WRONG, not just dead:
--   * §3.5 (pre-Layer-2): for a planned quote it computed 0 (no prebooked), so the
--     quote hold stayed fully active after real stock was deducted → free
--     double-reduced. Layer 2's job draw + A4 resync already fix that.
--   * Post-Layer-2: for a planned quote that ALSO has an order draw (prebooked>0),
--     the clamp lets the drain run, so completing a JOB would additionally
--     decrement the ORDER's prebooked + drain crop_program on top of A4's resync —
--     a double-reduction / corruption.
-- FIX: remove the drain entirely. complete_job now ONLY deducts physical stock
-- (quantity_available) + writes the job_applied ledger row; A4's trigger owns the
-- holds and the quote booking.
--
-- The ONLY change vs the live baseline is the deduction loop (Phase 7 removed) +
-- the now-unused DECLARE vars (v_hold_qty, v_decrement_pb, v_remaining, v_take,
-- v_hold_row). Everything else is byte-faithful. Body typed out explicitly.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.complete_job(p_job_id uuid, p_applied_info jsonb, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
  v_new_avail      numeric;
  v_short_flag     boolean;
  v_result         jsonb;
  v_deduct_qty     numeric;
  v_auto_draft_on    boolean := false;
  v_existing_invoice uuid;
  v_auto_draft_key   text;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'p_performed_by does not match authenticated user';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing
      FROM idempotency_keys
     WHERE idempotency_key = p_idempotency_key AND operation = 'complete_job';
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

  IF NOT (
    is_admin() OR is_sales_rep()
    OR (is_applicator() AND v_job.applicator_id = v_actor)
  ) THEN
    RAISE EXCEPTION 'Not authorized to complete this job';
  END IF;

  IF v_job.status != 'in_progress' THEN
    RAISE EXCEPTION 'Job must be in_progress before completion. Current status: %. Use start_job() first.', v_job.status;
  END IF;

  -- Fires A4's jobs lifecycle trigger → _sync_job_holds releases this job's hold
  -- and re-syncs the parent quote (keeping the draw). The quote hold / booking is
  -- owned by A4 from here; the loop below only deducts physical stock.
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

  FOR v_chem IN
    SELECT jc.product_id, jc.quantity, jc.unit, p.inventory_unit AS inv_unit, p.product_form AS prod_form
      FROM job_chemicals jc
      JOIN products p ON p.id = jc.product_id
     WHERE jc.job_id = p_job_id AND jc.quantity > 0
  LOOP
    v_deduct_qty := field_app_priced_quantity(v_chem.quantity, v_chem.unit, v_chem.inv_unit, v_chem.prod_form);
    IF v_deduct_qty IS NULL THEN
      RAISE EXCEPTION 'JOB_INV_UNIT_UNCONVERTIBLE: product % job-chem unit "%" not convertible to inventory unit "%"', v_chem.product_id, v_chem.unit, v_chem.inv_unit;
    END IF;

    SELECT * INTO v_inv
      FROM inventory
     WHERE product_id = v_chem.product_id AND location = 'Main Warehouse'
     FOR UPDATE;
    v_inv_found := FOUND;

    v_new_avail  := COALESCE(v_inv.quantity_available, 0) - v_deduct_qty;
    v_short_flag := v_new_avail < 0;
    IF v_short_flag THEN
      v_short_count := v_short_count + 1;
    END IF;

    -- LAYER2<<< §3.5 fix: deduct physical stock ONLY. The parent quote's holds
    -- and prebooked are owned by A4's jobs lifecycle trigger (which already fired
    -- on the status='completed' update above). The removed "Phase 7" drain
    -- (v_hold_qty / v_decrement_pb / prebooked decrement / crop_program FIFO
    -- drain) double-reduced free stock for order-drawn planned quotes.
    IF NOT v_inv_found THEN
      INSERT INTO inventory (product_id, location, quantity_available, quantity_prebooked, quantity_on_order)
      VALUES (v_chem.product_id, 'Main Warehouse', -v_deduct_qty, 0, 0);
    ELSE
      UPDATE inventory SET
        quantity_available = quantity_available - v_deduct_qty,
        updated_at         = now()
      WHERE product_id = v_chem.product_id AND location = 'Main Warehouse';
    END IF;
    -- >>>LAYER2

    INSERT INTO inventory_transactions (
      product_id, transaction_type, quantity, from_location,
      performed_by, notes, job_id, requires_review
    ) VALUES (
      v_chem.product_id, 'job_applied', v_deduct_qty, 'Main Warehouse',
      p_performed_by,
      'Job ' || v_job.job_number || ' completed — ' || v_deduct_qty || ' units applied' ||
        CASE WHEN v_short_flag THEN ' [SHORT STOCK — review required]' ELSE '' END,
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

  BEGIN
    SELECT (setting_value = 'true')
      INTO v_auto_draft_on
      FROM app_settings
     WHERE setting_key = 'auto_draft_invoice_on_job_completion';
    v_auto_draft_on := COALESCE(v_auto_draft_on, false);

    IF v_auto_draft_on AND (is_admin() OR is_sales_rep()) THEN
      SELECT i.id INTO v_existing_invoice
        FROM invoices i
       WHERE i.job_id = p_job_id
         AND i.deleted_at IS NULL
         AND i.status NOT IN ('voided', 'cancelled')
       LIMIT 1;

      IF v_existing_invoice IS NULL THEN
        v_auto_draft_key := 'auto_draft_job:' || p_job_id::text;
        PERFORM transfer_job_to_invoice(p_job_id, p_performed_by, v_auto_draft_key);
      END IF;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    BEGIN
      INSERT INTO activity_feed (
        event_type, description, performed_by,
        related_entity_type, related_entity_id, customer_id
      ) VALUES (
        'auto_draft_failed',
        'Job ' || v_job.job_number || ' completed, but the automatic draft invoice could '
          || 'not be created (needs attention — bill it manually). Reason: ' || SQLERRM,
        p_performed_by, 'job', p_job_id, v_job.customer_id
      );
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END;

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'complete_job', v_result);
  END IF;

  RETURN v_result;
END;
$function$;
