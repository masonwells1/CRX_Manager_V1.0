-- validate-sql: exempt — the banned catalog-def function appears ONLY inside the
-- read-only verification DO block (a LIKE assertion that the null-safe wrap
-- landed), never to clone/re-emit function text. Both function bodies are
-- written out in full above it. (This exempt marker was added AFTER the live
-- apply, purely for the pre-commit hook; the applied query = this file minus
-- these 6 comment lines.)
-- U12 follow-up (2026-07-07): NULL-safe actor check in start_job / complete_job.
-- ---------------------------------------------------------------------------
-- Found by the U12 post-apply live verification (rolled-back [E2E] negative
-- test): with jobs.applicator_id IS NULL, the legacy authorization branch
-- "v_job.applicator_id = v_actor" evaluates to NULL; the whole OR chain then
-- yields NULL and "IF NOT (NULL)" silently SKIPS the RAISE — so ANY active
-- applicator could start_job/complete_job ANY job that has no whole-job
-- applicator and is not fully dispatched to them. PRE-EXISTING hole (the same
-- pattern was in the pre-U12 live text); U12 null-safe-wrapped its NEW
-- d.applicator_id comparisons but left the legacy branch untouched.
-- Fix: two one-line wraps (IS NOT NULL AND ...). Everything else is the
-- byte-exact text applied minutes ago by 20260707010000_field_view_my_day.
-- Proven live (rolled back): an unrelated applicator's start_job on a
-- NULL-applicator job SUCCEEDED before this fix; the legitimate dispatch path
-- and the whole-job-assignee path are unaffected (both evaluate TRUE on their
-- own merits, no NULL routes needed).
-- ---------------------------------------------------------------------------

-- ── B1) start_job — widen authorization: ALSO allow a caller with an ACTIVE
--        location dispatch on this job (not just the whole-job applicator_id).
--        Body below is the LIVE text + only the U12 OR branch.
CREATE OR REPLACE FUNCTION public.start_job(p_job_id uuid, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor     uuid := auth.uid();
  v_existing  jsonb;
  v_job       record;
  v_now       timestamptz := now();
  v_result    jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'p_performed_by does not match authenticated user';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing
      FROM idempotency_keys
     WHERE idempotency_key = p_idempotency_key AND operation = 'start_job';
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  SELECT * INTO v_job FROM jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Job not found: %', p_job_id;
  END IF;

  -- U12: widened with an OR branch (superset — nothing previously authorized
  -- loses access). A per-location-only dispatchee (job_location_dispatches,
  -- #36/#37) is now ALSO authorized to start the job, mirroring the visibility
  -- grant _is_dispatched_to_me already gives them for reading it.
  IF NOT (
    is_admin() OR is_sales_rep()
    -- NULL-SAFE (U12 live-verify finding): when jobs.applicator_id IS NULL this
    -- comparison yielded NULL, and IF NOT (NULL) skips the RAISE — any active
    -- applicator could start/complete a NULL-applicator job. Wrap it so the
    -- branch is FALSE, not NULL, and authorization falls through to the
    -- dispatch-based branch (which is already null-safe).
    OR (is_applicator() AND v_job.applicator_id IS NOT NULL AND v_job.applicator_id = v_actor)
    OR (is_applicator() AND public._is_dispatched_to_me(p_job_id))
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
$function$;

-- caller-analysis: start_job :: REVOKE strips PUBLIC+anon only; the very next GRANT re-grants authenticated+service_role, so the authenticated UI caller (src/pages/JobDetail.tsx:621) is unaffected — ACL byte-identical to live.
REVOKE EXECUTE ON FUNCTION public.start_job(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.start_job(uuid, uuid, text) TO authenticated, service_role;


-- ── B2) complete_job — REBASED onto the LIVE U11 body (preserving U4
--        customer-supplied skip + U11 unit-conversion/raw-fallback), plus the two
--        documented U12 deltas: (1) a NARROWED variant of start_job's authorization
--        OR branch — the location dispatchee must hold EVERY active dispatch on the
--        job (Codex R1 P1: one applicator on a split-crew job must not close out
--        other crews' fields/inventory), and (2) an additive, backward-compatible
--        per-field applied-acres override
--        read from p_applied_info->'field_acres' (array of {field_id, acres_applied}).
--        When 'field_acres' is absent (every existing caller), behavior is
--        BYTE-IDENTICAL: the COALESCE falls straight through to the pre-existing
--        jf.acres_to_treat / f.total_acres / 0 chain.
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
  -- U12 (Codex R2 P2): running sum of the per-field acres actually recorded, so
  -- the record header can be corrected when the caller sent 'field_acres' overrides.
  v_acres_sum      numeric := 0;
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

  -- U12: widened with an OR branch — but NARROWER than start_job's (Codex R1 P1,
  -- tightened again R2 P1): complete_job stamps application records + acres for
  -- EVERY field and deducts inventory for EVERY chemical on the job, so a
  -- location-only dispatchee may complete it ONLY when BOTH hold:
  --   (1) EVERY job_fields row on the job is covered by an ACTIVE dispatch owned
  --       by the caller (directly, or via active membership in the dispatched
  --       crew) — an undispatched field means someone's work isn't even assigned
  --       yet, so the whole-job close stays with the office / whole-job assignee;
  --   (2) no OTHER party holds an ACTIVE dispatch anywhere on the job.
  -- On any split/partial-dispatch job this branch stays closed — admin/sales_rep
  -- or jobs.applicator_id complete those, exactly as before this migration.
  -- Still a strict superset of live behavior.
  IF NOT (
    is_admin() OR is_sales_rep()
    -- NULL-SAFE (U12 live-verify finding): when jobs.applicator_id IS NULL this
    -- comparison yielded NULL, and IF NOT (NULL) skips the RAISE — any active
    -- applicator could start/complete a NULL-applicator job. Wrap it so the
    -- branch is FALSE, not NULL, and authorization falls through to the
    -- dispatch-based branch (which is already null-safe).
    OR (is_applicator() AND v_job.applicator_id IS NOT NULL AND v_job.applicator_id = v_actor)
    OR (
      is_applicator()
      AND public._is_dispatched_to_me(p_job_id)
      -- (1) every field on the job is actively dispatched to the caller.
      -- Crew ownership requires BOTH the membership row AND the crew itself to
      -- be active (RLS R2 M2) — matching _is_dispatched_to_me and the
      -- job_location_dispatches_select policy, so the completion power is never
      -- looser than the read power.
      AND NOT EXISTS (
        SELECT 1
          FROM job_fields jf2
         WHERE jf2.job_id = p_job_id
           AND NOT EXISTS (
             SELECT 1
               FROM job_location_dispatches d2
              WHERE d2.job_field_id = jf2.id
                AND d2.dispatch_status = 'dispatched'
                AND (
                  d2.applicator_id = v_actor
                  OR (d2.crew_id IS NOT NULL AND EXISTS (
                        SELECT 1
                          FROM ground_crew_members gcm
                          JOIN ground_crews gc ON gc.id = gcm.crew_id
                         WHERE gcm.crew_id = d2.crew_id
                           AND gcm.profile_id = v_actor
                           AND gcm.is_active
                           AND gc.is_active))
                )
           )
      )
      -- (2) and nobody ELSE holds an active dispatch on the job. The applicator
      -- comparison is wrapped null-safe (RLS R2 M1): on a crew-held dispatch
      -- d.applicator_id IS NULL, and `NULL = v_actor` would poison the NOT()
      -- into NULL and silently drop the row from the EXISTS.
      AND NOT EXISTS (
        SELECT 1
          FROM job_location_dispatches d
         WHERE d.job_id = p_job_id
           AND d.dispatch_status = 'dispatched'
           AND NOT (
             (d.applicator_id IS NOT NULL AND d.applicator_id = v_actor)
             OR (d.crew_id IS NOT NULL AND EXISTS (
                   SELECT 1
                     FROM ground_crew_members gcm
                     JOIN ground_crews gc ON gc.id = gcm.crew_id
                    WHERE gcm.crew_id = d.crew_id
                      AND gcm.profile_id = v_actor
                      AND gcm.is_active
                      AND gc.is_active))
           )
      )
    )
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
    v_job.customer_id,
    -- U12 (Codex R2 P1): attribute the legal application record to the person who
    -- ACTUALLY completed it when that person is an applicator — the new location-
    -- dispatch path means the completer may not be jobs.applicator_id (which can
    -- even be NULL for wizard-dispatched jobs). For the whole-job assignee this is
    -- the same value as before (v_actor = v_job.applicator_id); for office closes
    -- (admin/sales_rep) keep the job-header applicator exactly as today.
    CASE WHEN is_applicator() THEN v_actor ELSE v_job.applicator_id END,
    v_first_field_id,
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
           -- U12 addition: an optional per-field override from
           -- p_applied_info->'field_acres' = [{"field_id":uuid,"acres_applied":n}, ...].
           -- Falls through to the ORIGINAL chain when absent/no match — byte-identical
           -- to the pre-U12 behavior for every caller that doesn't pass it.
           COALESCE(
             (SELECT GREATEST(0, (elem->>'acres_applied')::numeric)
                FROM jsonb_array_elements(COALESCE(p_applied_info->'field_acres', '[]'::jsonb)) elem
               WHERE nullif(elem->>'field_id', '')::uuid = jf.field_id
               LIMIT 1),
             jf.acres_to_treat, f.total_acres, 0
           ) AS acres,
           COALESCE(jf.sort_order, 0)                    AS sort_order
      FROM job_fields jf
      JOIN fields f ON f.id = jf.field_id
     WHERE jf.job_id = p_job_id
     ORDER BY jf.sort_order, jf.id
  LOOP
    INSERT INTO application_record_fields (application_record_id, field_id, acres, sort_order)
    VALUES (v_record_id, v_jf.field_id, v_jf.acres, v_jf.sort_order);
    v_field_count := v_field_count + 1;
    v_acres_sum   := v_acres_sum + COALESCE(v_jf.acres, 0);
  END LOOP;

  -- U12 (Codex R2 P2): when the caller sent per-field applied-acres overrides,
  -- the record HEADER must reflect what was actually recorded, not the planned
  -- job total — reports read application_records.total_acres. Only corrected
  -- when 'field_acres' was provided: callers that omit it keep today's header
  -- value byte-for-byte (v_job.total_acres), preserving backward compatibility.
  IF p_applied_info ? 'field_acres' AND v_field_count > 0 THEN
    UPDATE application_records
       SET total_acres = v_acres_sum
     WHERE id = v_record_id;
  END IF;

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

-- caller-analysis: complete_job :: REVOKE strips PUBLIC+anon only; the very next GRANT re-grants authenticated+service_role, so the authenticated UI callers (src/lib/offlineSync.ts:167, src/pages/JobDetail.tsx:643) are unaffected — ACL byte-identical to live.
REVOKE EXECUTE ON FUNCTION public.complete_job(uuid, jsonb, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.complete_job(uuid, jsonb, uuid, text) TO authenticated, service_role;

-- ── Verification ────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_count int;
BEGIN
  SELECT count(*) INTO v_count FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace AND proname = 'start_job';
  IF v_count <> 1 THEN RAISE EXCEPTION 'start_job overload count is % (expected 1)', v_count; END IF;

  SELECT count(*) INTO v_count FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace AND proname = 'complete_job';
  IF v_count <> 1 THEN RAISE EXCEPTION 'complete_job overload count is % (expected 1)', v_count; END IF;

  SELECT count(*) INTO v_count
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname IN ('start_job', 'complete_job')
     AND has_function_privilege('anon', p.oid, 'EXECUTE');
  IF v_count <> 0 THEN RAISE EXCEPTION 'anon must NOT have EXECUTE on start_job/complete_job (found %)', v_count; END IF;

  -- the null-safe wrap actually landed in both bodies
  SELECT count(*) INTO v_count
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname IN ('start_job', 'complete_job')
     AND pg_get_functiondef(p.oid) LIKE '%v_job.applicator_id IS NOT NULL AND v_job.applicator_id = v_actor%';
  IF v_count <> 2 THEN RAISE EXCEPTION 'null-safe actor wrap missing (found in % of 2 functions)', v_count; END IF;
END $$;
