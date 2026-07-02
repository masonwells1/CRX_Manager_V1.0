-- ============================================================================
-- PARKED DRAFT — DO NOT APPLY (structure-fix loop, Wave A / A6). 2026-07-02.
-- Mason applies via the DRAFT/APPLY protocol after review.
--
-- WHAT: Convert job-chemical quantities from their RATE unit to the product's
--       INVENTORY unit before touching stock, in two functions:
--         (1) complete_job                — inventory-deduction loop (mutating)
--         (2) get_job_inventory_shortfalls — office cockpit demand (read-only)
-- WHY:  Both currently treat a rate-unit job_chemicals.quantity as if it were the
--       inventory unit. A 2 pt/ac job on a GALLONS-stocked product deducts "2" from
--       gallons-on-hand (way too much) and reports demand in the wrong unit. The live
--       helper field_app_priced_quantity(qty, rate_unit, inventory_unit, product_form)
--       already does exactly this conversion (returns NULL when the units are not
--       convertible / blank / unknown; passes qty through when units are equal).
-- SCOPE: SURGICAL — both bodies rebuilt VERBATIM from live pg_get_functiondef
--        (complete_job = 20260630073344 lineage, oid 57996; shortfalls =
--        20260702120000, oid 91511; each the SOLE overload). Only the unit-conversion
--        touchpoints changed; every other statement is byte-for-byte the live source.
--        - complete_job: loop SELECT also fetches p.inventory_unit/p.product_form;
--          new local v_deduct_qty := field_app_priced_quantity(...); NULL => HARD RAISE
--          (JOB_INV_UNIT_UNCONVERTIBLE) so stock is never mis-deducted; v_deduct_qty
--          replaces v_chem.quantity ONLY in the five inventory writes + the note text
--          (prebook-decrement basis, new-avail, insert-new-inventory, UPDATE inventory,
--          inventory_transactions.quantity, and the "N units applied" note). Hold-drain
--          logic is untouched (holds are already inventory-unit).
--        - get_job_inventory_shortfalls: demand CTE joins products + a scalar LATERAL
--          computing COALESCE(field_app_priced_quantity(...), jc.quantity) as demand_qty;
--          the three jc.quantity references in the aggregate/FILTER expressions use it.
--          Read-only visibility RPC => COALESCE FALLBACK to raw qty (do NOT raise here).
-- SAFE: no signature change; both keep SECURITY DEFINER + search_path; grants untouched.
--       complete_job's new RAISE is the intended guard — a job whose chem unit is blank
--       or not in the known set now BLOCKS completion instead of silently mis-deducting
--       (surfaces the bad unit for the office to fix). shortfalls never raises.
--
-- SMOKE (2026-07-02, live rolled-back BEGIN…ROLLBACK + plpgsql_check, one tx per fn,
--   never called, tx aborted via summary RAISE so nothing persists): PASS —
--   complete_job(uuid,jsonb,uuid,text): plpgsql_check = NO FINDINGS - CLEAN.
--   get_job_inventory_shortfalls(integer): plpgsql_check = NO FINDINGS - CLEAN.
--   Live unchanged confirmed: live complete_job body has NO 'v_deduct_qty' (position()=0)
--   and live shortfalls body has NO 'field_app_priced_quantity' (position()=0).
-- CODEX: CLEAN — "did not find a discrete regression that would block the patch; typecheck and lint
--   also passed during review." (Reviewed together with the DispatchBoard.tsx frontend compare.)
-- NOTE (behavior change to flag for Mason): a job chemical whose unit is blank or unknown will now
--   HARD-STOP complete_job with JOB_INV_UNIT_UNCONVERTIBLE instead of silently deducting the raw
--   number. Intended guard; common case (chem unit == inventory unit) is unaffected.
-- ============================================================================

-- ────────────────────────────────────────────────────────────────────────────
-- FUNCTION 1 of 2: complete_job — deduct in the INVENTORY unit, not the rate unit.
-- ────────────────────────────────────────────────────────────────────────────
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
  v_hold_qty       numeric;
  v_decrement_pb   numeric;
  v_remaining      numeric;
  v_take           numeric;
  v_hold_row       record;
  v_new_avail      numeric;
  v_short_flag     boolean;
  v_result         jsonb;
  v_deduct_qty     numeric;  -- A6: job-chem qty converted from rate-unit to inventory-unit
  -- §4: auto-draft locals (no pricing here — only the trigger decision)
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
    -- A6: deduct in the product's INVENTORY unit, not the rate unit. Convert the rate-unit
    -- job-chem quantity first (e.g. 2 pt/ac on a gallons-stocked product must NOT remove 2
    -- gallons). An unconvertible / blank / unknown unit must never silently over- or under-
    -- deduct stock, so hard-stop and make the office fix the unit (this is a mutating RPC —
    -- unlike the read-only shortfalls RPC below, which falls back to the raw quantity).
    v_deduct_qty := field_app_priced_quantity(v_chem.quantity, v_chem.unit, v_chem.inv_unit, v_chem.prod_form);
    IF v_deduct_qty IS NULL THEN
      RAISE EXCEPTION 'JOB_INV_UNIT_UNCONVERTIBLE: product % job-chem unit "%" not convertible to inventory unit "%"', v_chem.product_id, v_chem.unit, v_chem.inv_unit;
    END IF;

    SELECT * INTO v_inv
      FROM inventory
     WHERE product_id = v_chem.product_id AND location = 'Main Warehouse'
     FOR UPDATE;
    v_inv_found := FOUND;

    -- Phase 7 #2: planned holds keyed by quote_id, NOT quote_section_id.
    v_hold_qty := 0;
    IF v_job.quote_id IS NOT NULL THEN
      SELECT COALESCE(SUM(ih.quantity), 0) INTO v_hold_qty
        FROM inventory_holds ih
       WHERE ih.product_id  = v_chem.product_id
         AND ih.is_active   = true
         AND ih.source_id   = v_job.quote_id;
    END IF;

    v_decrement_pb := LEAST(v_deduct_qty, COALESCE(v_hold_qty, 0));
    IF COALESCE(v_inv.quantity_prebooked, 0) < v_decrement_pb THEN
      v_decrement_pb := COALESCE(v_inv.quantity_prebooked, 0);
    END IF;

    v_new_avail  := COALESCE(v_inv.quantity_available, 0) - v_deduct_qty;
    v_short_flag := v_new_avail < 0;
    IF v_short_flag THEN
      v_short_count := v_short_count + 1;
    END IF;

    IF NOT v_inv_found THEN
      INSERT INTO inventory (product_id, location, quantity_available, quantity_prebooked, quantity_on_order)
      VALUES (v_chem.product_id, 'Main Warehouse', -v_deduct_qty, 0, 0);
    ELSE
      UPDATE inventory SET
        quantity_available = quantity_available - v_deduct_qty,
        quantity_prebooked = quantity_prebooked - v_decrement_pb,
        updated_at         = now()
      WHERE product_id = v_chem.product_id AND location = 'Main Warehouse';
    END IF;

    -- Phase 7 #3: drain matching holds oldest-first, never going negative.
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
      v_chem.product_id, 'job_applied', v_deduct_qty, 'Main Warehouse',
      p_performed_by,
      'Job ' || v_job.job_number || ' completed — ' || v_deduct_qty || ' units applied' ||
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

  -- ───────────────────────────────────────────────────────────────────────────
  -- §4: AUTO-DRAFT INVOICE (never auto-post; OFF by default; idempotent; fail-soft).
  -- Runs only after every core completion side effect above has succeeded. The whole
  -- block is wrapped so a draft problem can NEVER roll back / block the completion that
  -- already happened — the job is completed regardless of what happens here.
  -- ───────────────────────────────────────────────────────────────────────────
  BEGIN
    -- Read the toggle cheaply. Absent/malformed => OFF (default, no auto-draft).
    SELECT (setting_value = 'true')
      INTO v_auto_draft_on
      FROM app_settings
     WHERE setting_key = 'auto_draft_invoice_on_job_completion';
    v_auto_draft_on := COALESCE(v_auto_draft_on, false);

    -- OFFICE-COMPLETIONS ONLY (Mason, 2026-06-30): only an admin/sales_rep completion auto-drafts.
    -- An applicator (field driver) completing their OWN job does NOT auto-draft — transfer_job_to_invoice
    -- is admin/sales_rep-gated and we deliberately do NOT loosen it; the office bills those by hand
    -- (they surface in the Cockpit "completed-but-unbilled" tile). Checking the role HERE (vs letting
    -- the call fail-soft) keeps applicator completions clean — no spurious 'auto_draft_failed' note.
    IF v_auto_draft_on AND (is_admin() OR is_sales_rep()) THEN
      -- IDEMPOTENCY: never create a second draft. If ANY non-voided/cancelled invoice
      -- already points at this job (the manual transfer, a prior auto-draft, or a retry),
      -- do nothing. transfer_job_to_invoice also sets jobs.status='invoiced', but we
      -- check invoices directly so a half-state can't slip a duplicate through.
      SELECT i.id INTO v_existing_invoice
        FROM invoices i
       WHERE i.job_id = p_job_id
         AND i.deleted_at IS NULL
         AND i.status NOT IN ('voided', 'cancelled')
       LIMIT 1;

      IF v_existing_invoice IS NULL THEN
        -- Job-scoped key so a retried completion reuses the SAME transfer key (no dup),
        -- yet two different jobs never collide. transfer_job_to_invoice reuses the price
        -- book + per-acre shares; it inserts DRAFT then flips to 'unposted' and STOPS —
        -- it NEVER posts. We do NOT call any post RPC here.
        v_auto_draft_key := 'auto_draft_job:' || p_job_id::text;
        PERFORM transfer_job_to_invoice(p_job_id, p_performed_by, v_auto_draft_key);
      END IF;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    -- FAIL-SOFT: the job is already completed and committed-in-spirit; the auto-draft is
    -- best-effort. Swallow the error, record a 'needs attention' signal so the office can
    -- bill by hand, and let completion succeed. We do NOT re-raise.
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
      -- Even the note is best-effort; never let logging block completion.
      NULL;
    END;
  END;
  -- §4 END

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'complete_job', v_result);
  END IF;

  RETURN v_result;
END;
$function$;

-- ────────────────────────────────────────────────────────────────────────────
-- FUNCTION 2 of 2: get_job_inventory_shortfalls — demand in the INVENTORY unit.
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_job_inventory_shortfalls(p_days_ahead integer DEFAULT 7)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- Office-only surface: returns GLOBAL upcoming-job numbers + product shortfalls
  -- (SECURITY DEFINER bypasses job RLS) and the only caller is the admin/sales_rep Office
  -- Cockpit. Gate on that role boundary so the broad `authenticated` EXECUTE grant is not
  -- the real gate and no other role can read cross-customer job data.
  PERFORM require_admin_or_sales_rep();

  RETURN (
    WITH win_jobs AS (
      SELECT j.id, j.job_number, j.quote_id
      FROM jobs j
      WHERE j.status IN ('scheduled', 'in_progress')
        AND j.deleted_at IS NULL
        AND j.job_date >= CURRENT_DATE
        AND j.job_date <= (CURRENT_DATE + (p_days_ahead || ' days')::interval)::date
    ),
    -- Per-product UNCOVERED job demand: job need minus the parent planned-quote's active
    -- hold coverage for that product (quantity-aware, not all-or-nothing).
    -- A6: demand is measured in the product's INVENTORY unit. cq.demand_qty converts the
    -- rate-unit job-chem quantity via field_app_priced_quantity so it is comparable to
    -- hold coverage and free stock (both already inventory-unit). Read-only RPC => on an
    -- unconvertible / blank unit fall back to the raw jc.quantity (do NOT raise here).
    demand AS (
      SELECT jc.product_id,
             SUM(GREATEST(cq.demand_qty - COALESCE(hc.covered, 0), 0)) AS needed_qty,
             COUNT(DISTINCT wj.id) FILTER (WHERE cq.demand_qty - COALESCE(hc.covered, 0) > 0) AS job_count,
             ARRAY_AGG(DISTINCT wj.job_number ORDER BY wj.job_number)
               FILTER (WHERE cq.demand_qty - COALESCE(hc.covered, 0) > 0) AS job_numbers
      FROM win_jobs wj
      JOIN job_chemicals jc ON jc.job_id = wj.id
      JOIN products p ON p.id = jc.product_id
      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(ih.quantity), 0) AS covered
        FROM inventory_holds ih
        WHERE ih.source_id = wj.quote_id
          AND ih.product_id = jc.product_id
          AND ih.is_active = true
          AND (ih.expires_at IS NULL OR ih.expires_at >= CURRENT_DATE)
      ) hc ON true
      CROSS JOIN LATERAL (
        SELECT COALESCE(
                 field_app_priced_quantity(jc.quantity, jc.unit, p.inventory_unit, p.product_form),
                 jc.quantity
               ) AS demand_qty
      ) cq
      WHERE jc.quantity > 0
      GROUP BY jc.product_id
    ),
    avail AS (
      SELECT i.product_id,
             COALESCE(SUM(i.quantity_available - i.quantity_prebooked), 0) AS avail_less_prebooked
      FROM inventory i
      GROUP BY i.product_id
    ),
    active_holds AS (
      SELECT ih.product_id, SUM(ih.quantity) AS holds_qty
      FROM inventory_holds ih
      WHERE ih.is_active = true
        AND (ih.expires_at IS NULL OR ih.expires_at >= CURRENT_DATE)
      GROUP BY ih.product_id
    )
    SELECT COALESCE(jsonb_agg(row_to_json(r) ORDER BY r.shortfall_qty DESC), '[]'::jsonb)
    FROM (
      SELECT
        d.product_id,
        p.product_name,
        p.inventory_unit,
        d.needed_qty,
        (COALESCE(a.avail_less_prebooked, 0) - COALESCE(ah.holds_qty, 0)) AS available_free,
        (d.needed_qty - (COALESCE(a.avail_less_prebooked, 0) - COALESCE(ah.holds_qty, 0))) AS shortfall_qty,
        d.job_count,
        d.job_numbers
      FROM demand d
      JOIN products p ON p.id = d.product_id
      LEFT JOIN avail a          ON a.product_id  = d.product_id
      LEFT JOIN active_holds ah  ON ah.product_id = d.product_id
      -- Only real uncovered demand that exceeds today's free stock.
      WHERE d.needed_qty > 0
        AND d.needed_qty > (COALESCE(a.avail_less_prebooked, 0) - COALESCE(ah.holds_qty, 0))
    ) r
  );
END;
$function$;
