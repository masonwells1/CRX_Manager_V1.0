-- U12 (2026-07-06): Applicator "My Day" rebuild — server-side support.
-- ---------------------------------------------------------------------------
-- Three surgical, ADDITIVE changes. No table/policy/RPC is DROPPED; every
-- changed function keeps its EXACT existing signature (CREATE OR REPLACE only —
-- verified below that none of these need DROP+CREATE, because none change
-- their argument list or return TYPE, only what's inside the body/jsonb payload).
--
-- A) get_dispatched_list(uuid, uuid) — RETURNS SETOF jsonb is UNCHANGED. Adding a
--    'job_date' key to the jsonb_build_object is not a return-type change (the
--    column-level RETURNS TABLE(...) case the mission briefing warned about does
--    NOT apply here — this fn returns a single jsonb blob per row, so new keys
--    are purely additive and no existing caller can break: PostgREST/postgrest-js
--    parse jsonb by key name, never positionally).
--
-- B) start_job(uuid, uuid, text) / complete_job(uuid, jsonb, uuid, text) — the
--    authorization check today is `is_applicator() AND jobs.applicator_id = actor`
--    (the WHOLE-JOB legacy assignee). Field-app parity #36/#37 added PER-LOCATION
--    dispatch (job_location_dispatches) so an applicator can be dispatched to a
--    job WITHOUT being jobs.applicator_id. Today that applicator's FieldView
--    Start/Complete buttons would hit "Not authorized" — this widens the
--    authorization check with an OR branch (strictly a superset: every caller
--    who could start/complete before still can; nothing is narrowed) so a
--    caller with an ACTIVE ('dispatched') location dispatch on the job is ALSO
--    authorized. complete_job also gains a backward-compatible optional
--    per-field applied-acres override read from p_applied_info->'field_acres'
--    (p_applied_info is already an untyped jsonb blob — no signature change).
--    A caller that omits 'field_acres' gets byte-identical behavior to today.
--
-- C) notifications RLS INSERT policy — today only admin or the row's OWN user
--    can insert a notification for themselves; a sales_rep dispatcher inserting
--    a notification FOR someone else (e.g. notifyDriverAssigned from
--    NewDelivery.tsx, or the new dispatch/reschedule/undispatch-to-applicator
--    notifications this unit adds) silently fails under RLS today (the insert
--    is denied; createNotification() swallows the error into Sentry and the
--    caller's flow continues with NO notification ever landing). Widen the
--    WITH CHECK to also allow is_sales_rep() — mirrors the SAME dispatcher
--    trust boundary already granted to dispatch_job_locations /
--    undispatch_job_locations (admin OR sales_rep). Fixes the pre-existing
--    silent-drop for notifyDriverAssigned too, as a side effect.
-- ---------------------------------------------------------------------------

-- ── A) get_dispatched_list — add job_date (needed on the FieldView card face
--       so the applicator sees the scheduled date without expanding). Byte-
--       identical otherwise (verified against the live 20260626150000 body).
CREATE OR REPLACE FUNCTION public.get_dispatched_list(
  p_applicator_id uuid DEFAULT NULL,
  p_crew_id       uuid DEFAULT NULL
) RETURNS SETOF jsonb
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT jsonb_build_object(
    'dispatch_id',     d.id,
    'job_field_id',    d.job_field_id,
    'job_id',          d.job_id,
    'job_number',      j.job_number,
    'job_status',      j.status,
    -- U12 addition: the job's scheduled date, so the FieldView card shows it
    -- and can sort Today-first / group a Done section without an extra fetch.
    'job_date',        j.job_date,
    'dispatch_status', d.dispatch_status,
    'dispatched_at',   d.dispatched_at,
    'assignee_kind',   CASE WHEN d.applicator_id IS NOT NULL THEN 'applicator' ELSE 'crew' END,
    'applicator_id',   d.applicator_id,
    'crew_id',         d.crew_id,
    'assignee_name',   CASE WHEN d.applicator_id IS NOT NULL
                            THEN (SELECT p.full_name FROM profiles p WHERE p.id = d.applicator_id)
                            ELSE (SELECT g.name FROM ground_crews g WHERE g.id = d.crew_id) END,
    'field_name',      CASE WHEN (is_admin() OR is_sales_rep() OR is_applicator())
                            THEN (SELECT f.field_name FROM fields f WHERE f.id = jf.field_id)
                            ELSE NULL END,
    'customer_name',   CASE WHEN (
                              is_admin()
                              OR (is_sales_rep() AND c.assigned_sales_rep = (select auth.uid()))
                              OR (is_applicator() AND EXISTS (
                                    SELECT 1 FROM public.jobs j2
                                     WHERE j2.customer_id = c.id
                                       AND j2.applicator_id = (select auth.uid())
                                       AND j2.job_date >= (CURRENT_DATE - interval '7 days')))
                              OR EXISTS (
                                    SELECT 1 FROM public.jobs j3
                                     WHERE j3.customer_id = c.id
                                       AND public._is_dispatched_to_me(j3.id))
                            ) THEN c.farm_name ELSE NULL END,
    'location_acres',  jf.acres_to_treat,
    'job_applied_acres', j.applied_acres,
    'job_total_acres',   j.total_acres
  )
    FROM public.job_location_dispatches d
    JOIN public.jobs j        ON j.id = d.job_id AND j.deleted_at IS NULL
    JOIN public.job_fields jf ON jf.id = d.job_field_id
    JOIN public.customers c   ON c.id = j.customer_id
   WHERE d.dispatch_status = 'dispatched'
     AND (p_applicator_id IS NULL OR d.applicator_id = p_applicator_id)
     AND (p_crew_id IS NULL OR d.crew_id = p_crew_id)
     AND (
       is_admin()
       OR is_sales_rep()
       OR (is_applicator() AND j.applicator_id = (select auth.uid()))
       OR (
         d.applicator_id = (select auth.uid())
         AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = (select auth.uid()) AND p.is_active)
       )
       OR (
         d.crew_id IS NOT NULL
         AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = (select auth.uid()) AND p.is_active)
         AND EXISTS (
           SELECT 1 FROM public.ground_crew_members gcm
             JOIN public.ground_crews gc ON gc.id = gcm.crew_id
            WHERE gcm.crew_id = d.crew_id
              AND gcm.profile_id = (select auth.uid())
              AND gcm.is_active
              AND gc.is_active
         )
       )
     )
   ORDER BY j.job_number, d.dispatched_at DESC, d.id;
$$;

-- Re-assert the pre-existing ACL (CREATE OR REPLACE does not reset grants, but
-- pin it explicitly per migration convention).
REVOKE EXECUTE ON FUNCTION public.get_dispatched_list(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_dispatched_list(uuid, uuid) TO authenticated, service_role;


-- ── B1) start_job — widen authorization: ALSO allow a caller with an ACTIVE
--        location dispatch on this job (not just the whole-job applicator_id).
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
    OR (is_applicator() AND v_job.applicator_id = v_actor)
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

REVOKE EXECUTE ON FUNCTION public.start_job(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.start_job(uuid, uuid, text) TO authenticated, service_role;


-- ── B2) complete_job — same authorization widening as start_job, PLUS an
--        additive, backward-compatible per-field applied-acres override read
--        from p_applied_info->'field_acres' (array of {field_id, acres_applied}).
--        When absent (every existing caller), behavior is BYTE-IDENTICAL: the
--        COALESCE falls straight through to the pre-existing
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

  -- U12: widened with an OR branch (superset), mirrors start_job above.
  IF NOT (
    is_admin() OR is_sales_rep()
    OR (is_applicator() AND v_job.applicator_id = v_actor)
    OR (is_applicator() AND public._is_dispatched_to_me(p_job_id))
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

    IF NOT v_inv_found THEN
      INSERT INTO inventory (product_id, location, quantity_available, quantity_prebooked, quantity_on_order)
      VALUES (v_chem.product_id, 'Main Warehouse', -v_deduct_qty, 0, 0);
    ELSE
      UPDATE inventory SET
        quantity_available = quantity_available - v_deduct_qty,
        updated_at         = now()
      WHERE product_id = v_chem.product_id AND location = 'Main Warehouse';
    END IF;

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

REVOKE EXECUTE ON FUNCTION public.complete_job(uuid, jsonb, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.complete_job(uuid, jsonb, uuid, text) TO authenticated, service_role;


-- ── C) notifications RLS — let a dispatcher (admin OR sales_rep) insert a
--       notification FOR someone else (mirrors the dispatch_job_locations /
--       undispatch_job_locations trust boundary). Was: admin OR self; now:
--       admin OR sales_rep OR self. Nothing is narrowed — every previously
--       allowed insert (admin-for-anyone, self-for-self) is still allowed.
DROP POLICY IF EXISTS "notif_insert" ON public.notifications;
CREATE POLICY "notif_insert" ON public.notifications
  FOR INSERT TO authenticated
  WITH CHECK (
    is_admin()
    OR is_sales_rep()
    OR (user_id = (select auth.uid()))
  );


-- ── Verification ────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_count int;
BEGIN
  -- exactly one overload of each changed function (no accidental second signature)
  SELECT count(*) INTO v_count FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace AND proname = 'get_dispatched_list';
  IF v_count <> 1 THEN RAISE EXCEPTION 'get_dispatched_list overload count is % (expected 1)', v_count; END IF;

  SELECT count(*) INTO v_count FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace AND proname = 'start_job';
  IF v_count <> 1 THEN RAISE EXCEPTION 'start_job overload count is % (expected 1)', v_count; END IF;

  SELECT count(*) INTO v_count FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace AND proname = 'complete_job';
  IF v_count <> 1 THEN RAISE EXCEPTION 'complete_job overload count is % (expected 1)', v_count; END IF;

  -- anon still has no EXECUTE on any of the three
  SELECT count(*) INTO v_count
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname IN ('get_dispatched_list', 'start_job', 'complete_job')
     AND has_function_privilege('anon', p.oid, 'EXECUTE');
  IF v_count <> 0 THEN RAISE EXCEPTION 'anon must NOT have EXECUTE on get_dispatched_list/start_job/complete_job (found %)', v_count; END IF;

  -- exactly one notif_insert policy (DROP+CREATE didn't leave a duplicate)
  SELECT count(*) INTO v_count FROM pg_policy
   WHERE polrelid = 'public.notifications'::regclass AND polname = 'notif_insert';
  IF v_count <> 1 THEN RAISE EXCEPTION 'notif_insert policy count is % (expected 1)', v_count; END IF;
END $$;
