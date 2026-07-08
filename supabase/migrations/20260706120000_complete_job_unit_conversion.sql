-- ============================================================================
-- U11 — complete_job: warn+fallback on an unconvertible chem unit (was hard RAISE).
-- 2026-07-06. Overnight workflow-fix run, unit U11.
--
-- CONTEXT: The known P1 "deduct in the line's rate unit, not the inventory unit"
--   bug was ALREADY closed live by A6 (mig 20260702134000, in live lineage via
--   Layer2 + U4). Live complete_job already converts each job_chemicals row with
--   field_app_priced_quantity(qty, unit, inventory_unit, product_form) before
--   touching stock, records the CONVERTED qty on the job_applied inventory_transactions
--   row, and (U4) skips customer_supplied lines. So the deduction MATH is correct.
--
-- WHAT THIS CHANGES (the one remaining defect): A6 made the mutating path HARD-RAISE
--   `JOB_INV_UNIT_UNCONVERTIBLE` when the helper returns NULL (blank / unknown unit).
--   Because that RAISE happens inside the same transaction as the `status='completed'`
--   flip, a job carrying even one unconvertible unit CANNOT be completed at all — the
--   whole tx rolls back and the field applicator is stuck. Meanwhile the hold engine
--   `_sync_job_holds` (and the read-only `get_job_inventory_shortfalls`) already
--   fall back to the RAW quantity: `COALESCE(field_app_priced_quantity(...), jc.quantity)`.
--   So the hold RESERVED raw inventory-units for that line, but completion REFUSES to
--   remove them — breaking the "reserved X → removed X" invariant AND blocking the workflow.
--
-- DECISION (NULL handling): WARN + FALLBACK, not refuse. On an unconvertible unit,
--   deduct the RAW line quantity (identical to what the hold engine reserved) and flag
--   the inventory_transactions row `requires_review = true` with a self-explaining note.
--   Justification: (1) the helper genuinely CAN return NULL for valid live data —
--   products whose inventory_unit is 'each'/'unit'/'bag'/'L'/'kg' etc. or job lines whose
--   unit is blank/unknown are outside its liquid/dry gal-lb ladder; (2) a hard refusal
--   blocks the field job (mission: don't strand the applicator); (3) matching the hold
--   engine's raw fallback keeps reserve==deduct consistent; (4) A5's audit-row lesson is
--   honored — the recorded transaction qty EQUALS what inventory actually moved (raw),
--   and the note names the original line qty/unit so the office can reconcile & fix.
--   (BILLING is untouched — A5 refused for blend BILLING because a wrong bill charges a
--   customer; here nothing is billed, only physical stock moves, and a flagged raw
--   deduction is safer than a stuck job.)
--
-- SCOPE: SURGICAL. Body rebuilt VERBATIM from live pg_get_functiondef(complete_job)
--   (sole overload, args: uuid, jsonb, uuid, text) — the U4/Layer2 lineage that already
--   has customer_supplied handling + the Layer2 §3.5 "physical stock only" loop. Only the
--   marked -- U11<<< ... >>>U11 touchpoints changed; every other statement is byte-for-byte
--   the live source. Signature/SECURITY DEFINER/search_path/grants unchanged. Money untouched
--   (quantity only). Result JSON shape unchanged (CompleteJobResult in src/types stays valid).
--
-- CHANGED LINES (5 marked edits):
--   1. DECLARE: + v_unconverted boolean; + v_unconv_count int := 0;
--   2. conversion block: `IF v_deduct_qty IS NULL THEN RAISE` -> COALESCE-to-raw fallback
--      (v_deduct_qty := v_chem.quantity) + set v_unconverted + bump v_unconv_count.
--   3. inventory_transactions: note gains a "[UNIT NOT CONVERTIBLE ... recorded raw ...]"
--      / "(converted from N unit)" clause; requires_review = (v_short_flag OR v_unconverted).
--   4. activity_feed job_completed description: + a v_unconv_count warn clause (mirrors short_stock).
--   (The negative-inventory INSERT path and the UPDATE path already use v_deduct_qty, which is
--    now the converted-or-raw value, so both convert with no further edit — deliverable (c).)
--
-- SMOKE (fill in from live BEGIN…ROLLBACK before apply):
--   [ ] plpgsql_check(complete_job) = NO FINDINGS
--   [ ] 16 pt line, product inventory_unit='gal' form='liquid' -> deducts 2 (128 helper: 16*16/128)
--   [ ] unconvertible line (unit='each' or inv_unit='bag') -> deducts raw, requires_review=true, job completes
--   [ ] overload assert DO block passes (exactly 1 complete_job)
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
  -- U11<<< raw-fallback bookkeeping for unconvertible units
  v_unconverted    boolean;
  v_unconv_count   int := 0;
  -- >>>U11
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
        'is_rup',           COALESCE(p.is_rup, false),
        -- U4<<< legal record marks a grower-supplied product; the row STAYS in
        -- product_data (REI/PHI watchdog + as-applied proof still see it). (#53/#54)
        'customer_supplied', jc.customer_supplied
        -- >>>U4
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
     -- U4<<< skip customer-supplied lines: they came from the grower, not our
     -- shed — no stock to deduct, no 'job_applied' inventory transaction. (#53/#54)
     WHERE jc.job_id = p_job_id AND jc.quantity > 0 AND jc.customer_supplied = false
     -- >>>U4
  LOOP
    -- U11<<< convert the rate-unit job-chem quantity to the product's inventory unit
    -- before deducting stock (a 16-pt line on a gallons-stocked product must remove 2
    -- gal, not 16). On an unconvertible / blank / unknown unit, DO NOT block the field
    -- job (a stuck applicator can't ship the day's work): fall back to the RAW quantity
    -- and flag the row for office review. This mirrors the hold engine EXACTLY —
    -- _sync_job_holds reserved COALESCE(field_app_priced_quantity(...), jc.quantity)
    -- inventory-units for this same line, so deducting the same fallback keeps the
    -- "reserved X → removed X" invariant intact (was: A6 hard RAISE JOB_INV_UNIT_UNCONVERTIBLE,
    -- which blocked completion of ANY job carrying an unconvertible unit).
    -- Codex P1: normalize FIRST — legacy rows may carry per-acre-suffixed units
    -- ('pt/ac'); the raw string NULLs out of the converter and would raw-deduct
    -- 16 "pt/ac" as 16 gal. normalize_rate_unit('pt/ac')='pt' → converts to 2 gal.
    -- (The hold engines share this normalization gap — queued as a follow-up;
    -- correcting the PHYSICAL deduction takes precedence over symmetry.)
    v_deduct_qty  := field_app_priced_quantity(v_chem.quantity, normalize_rate_unit(v_chem.unit), v_chem.inv_unit, v_chem.prod_form);
    v_unconverted := (v_deduct_qty IS NULL);
    IF v_unconverted THEN
      v_deduct_qty   := v_chem.quantity;      -- raw fallback, equals the reserved hold
      v_unconv_count := v_unconv_count + 1;
    END IF;
    -- >>>U11

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
      -- U11<<< recorded qty ALWAYS = what stock moved (converted, or raw fallback). Name
      -- the original line qty/unit when a conversion (or a raw fallback) happened, so the
      -- audit row is self-explaining and reconcilable (mirrors A5's link/audit-row lesson).
      'Job ' || v_job.job_number || ' completed — ' || v_deduct_qty || ' units applied' ||
        CASE
          WHEN v_unconverted
            THEN ' [UNIT NOT CONVERTIBLE — line ' || v_chem.quantity || ' ' || COALESCE(NULLIF(v_chem.unit, ''), '?')
                 || ' recorded raw vs inventory unit ' || COALESCE(NULLIF(v_chem.inv_unit, ''), '?') || '; review required]'
          WHEN lower(btrim(COALESCE(v_chem.unit, ''))) IS DISTINCT FROM lower(btrim(COALESCE(v_chem.inv_unit, '')))
            THEN ' (converted from ' || v_chem.quantity || ' ' || COALESCE(NULLIF(v_chem.unit, ''), '?') || ')'
          ELSE ''
        END ||
        CASE WHEN v_short_flag THEN ' [SHORT STOCK — review required]' ELSE '' END,
      p_job_id,
      (v_short_flag OR v_unconverted)
      -- >>>U11
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
           ELSE '' END ||
      -- U11<<< surface raw-fallback lines to the office the same way short-stock is surfaced
      CASE WHEN v_unconv_count > 0
           THEN ' (⚠ ' || v_unconv_count || ' chemical(s) with non-convertible units — recorded raw, review required)'
           ELSE '' END,
      -- >>>U11
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

-- Overload guard: complete_job must remain a SINGLE overload (drift rule).
DO $$
DECLARE
  n int;
BEGIN
  SELECT count(*) INTO n
    FROM pg_proc
   WHERE proname = 'complete_job'
     AND pronamespace = 'public'::regnamespace;
  IF n <> 1 THEN
    RAISE EXCEPTION 'complete_job overload assertion failed: expected exactly 1, found %', n;
  END IF;
END $$;
