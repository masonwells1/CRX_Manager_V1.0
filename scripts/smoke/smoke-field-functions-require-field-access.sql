-- ============================================================================
-- SMOKE TEST (rolled back by design) for 20261023090000_field_functions_require_field_access.
--
-- CONTAINER ONLY: run through scripts/smoke/prove-field-functions-require-field-access-real-schema.mjs,
-- never against the live database: the chain plants [SMOKE] logins (auth.users rows), a customer,
-- fields, a job and a dispatch, which the LIVE-DATA GUARD refuses.
--
-- Rule under test (To-Do row 11.4, part A): field roles see only the fields assigned to them through
-- the field functions, office-only functions refuse them, global search returns them nothing, and
-- notes follow the linked record.
--   a. an applicator dispatched to one field of a two-field job gets only that field from
--      get_fields_geojson_by_ids and get_field_geojson;
--   b. a driver is refused by get_field_dashboard, get_fields_with_geojson and get_customer_summary
--      (Permission denied: requires admin or sales_rep role);
--   c. global_search returns nothing to the driver and the [SMOKE] customer to an active admin;
--   d. a note on the job: the dispatched applicator and the admin read it, the driver does not;
--   e. the admin still gets both fields and the field dashboard.
--
-- Fail-first: before the migration the applicator gets both fields (step a fails).
--
-- HOW TO RUN: as ONE statement inside a transaction that rolls back. It ALWAYS ends with RAISE
-- EXCEPTION 'SMOKE_PASS_ROLLBACK': that exact text = PASS; any other error = FAIL.
-- Auth: auth.uid() reads request.jwt.claims, set per call to a planted profile.
-- ============================================================================
DO $smoke$
DECLARE
  v_suffix text := substr(md5(random()::text), 1, 8);
  v_admin uuid := gen_random_uuid();
  v_applicator uuid := gen_random_uuid();
  v_driver uuid := gen_random_uuid();
  v_customer uuid := gen_random_uuid();
  v_field_mine uuid := gen_random_uuid();
  v_field_other uuid := gen_random_uuid();
  v_job uuid := gen_random_uuid();
  v_jf_mine uuid := gen_random_uuid();
  v_count int;
  v_err text;
  v_case text;
BEGIN
  -- 0. Fixtures: three logins (profiles from handle_new_user's direct-SQL path).
  INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    (v_admin,      'smk-ffa-admin-'  || v_suffix || '@example.invalid', jsonb_build_object('full_name', '[SMOKE] FFA admin '  || v_suffix, 'role', 'admin')),
    (v_applicator, 'smk-ffa-app-'    || v_suffix || '@example.invalid', jsonb_build_object('full_name', '[SMOKE] FFA app '    || v_suffix, 'role', 'applicator')),
    (v_driver,     'smk-ffa-driver-' || v_suffix || '@example.invalid', jsonb_build_object('full_name', '[SMOKE] FFA driver ' || v_suffix, 'role', 'driver'));
  IF (SELECT string_agg(role, ',' ORDER BY role) FROM public.profiles WHERE id IN (v_admin, v_applicator, v_driver) AND is_active)
     IS DISTINCT FROM 'admin,applicator,driver' THEN
    RAISE EXCEPTION 'SMOKE_SETUP: the planted profiles are not an active admin, applicator and driver';
  END IF;
  -- The fixtures are written as the planted admin (the note-activity trigger records its author).
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  INSERT INTO public.customers (id, farm_name, is_active) VALUES (v_customer, '[SMOKE] FFA Farm ' || v_suffix, true);
  INSERT INTO public.fields (id, customer_id, field_name, total_acres, is_active) VALUES
    (v_field_mine,  v_customer, '[SMOKE] FFA mine '  || v_suffix, 10, true),
    (v_field_other, v_customer, '[SMOKE] FFA other ' || v_suffix, 10, true);
  INSERT INTO public.jobs (id, job_number, customer_id, job_date, status)
    VALUES (v_job, 'SMK-FFA-' || v_suffix, v_customer, current_date, 'scheduled');
  INSERT INTO public.job_fields (id, job_id, field_id) VALUES (v_jf_mine, v_job, v_field_mine), (gen_random_uuid(), v_job, v_field_other);
  INSERT INTO public.job_location_dispatches (job_field_id, job_id, applicator_id, dispatch_status)
    VALUES (v_jf_mine, v_job, v_applicator, 'dispatched');
  INSERT INTO public.team_notes (created_by, title, content, note_type, linked_entity_type, linked_entity_id)
    VALUES (v_admin, '[SMOKE] FFA note ' || v_suffix, 'note', 'note', 'job', v_job);

  -- Every probe runs as a signed-in user would: role authenticated, so row security applies to
  -- get_notes_for_entity (now SECURITY INVOKER); postgres would bypass it.
  EXECUTE 'SET LOCAL ROLE authenticated';

  -- a.The dispatched applicator gets only their own field.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_applicator, 'role', 'authenticated')::text, true);
  SELECT count(*) INTO v_count FROM public.get_fields_geojson_by_ids(ARRAY[v_field_mine, v_field_other]);
  IF v_count <> 1 OR NOT EXISTS (SELECT 1 FROM public.get_fields_geojson_by_ids(ARRAY[v_field_mine, v_field_other]) g WHERE g.id = v_field_mine) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a. the dispatched applicator got % fields from get_fields_geojson_by_ids, expected only their own', v_count;
  END IF;
  IF EXISTS (SELECT 1 FROM public.get_field_geojson(v_field_other)) OR NOT EXISTS (SELECT 1 FROM public.get_field_geojson(v_field_mine)) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a. get_field_geojson did not return exactly the applicator''s own field';
  END IF;

  -- b. Office-only functions refuse the driver.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_driver, 'role', 'authenticated')::text, true);
  FOREACH v_case IN ARRAY ARRAY['dashboard', 'with_geojson', 'summary'] LOOP
    v_err := NULL;
    BEGIN
      IF v_case = 'dashboard' THEN PERFORM public.get_field_dashboard(v_field_mine, NULL);
      ELSIF v_case = 'with_geojson' THEN PERFORM count(*) FROM public.get_fields_with_geojson(NULL);
      ELSE PERFORM public.get_customer_summary(v_customer);
      END IF;
    EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
    END;
    IF v_err IS NULL OR v_err NOT LIKE 'Permission denied: requires admin or sales_rep role%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: b. the driver was not refused by % (%)', v_case, COALESCE(v_err, 'no error');
    END IF;
  END LOOP;

  -- c. Search returns nothing to the driver, the customer to the admin.
  SELECT count(*) INTO v_count FROM public.global_search('FFA Farm ' || v_suffix, 5);
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: c. global_search returned % rows to the driver', v_count;
  END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  SELECT count(*) INTO v_count FROM public.global_search('FFA Farm ' || v_suffix, 5) WHERE id = v_customer;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: c. global_search did not find the [SMOKE] customer for the admin';
  END IF;

  -- d. The job note: admin and the dispatched applicator read it, the driver does not.
  IF (SELECT count(*) FROM public.get_notes_for_entity('job', v_job)) <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: d. the admin did not read the job note';
  END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_applicator, 'role', 'authenticated')::text, true);
  IF (SELECT count(*) FROM public.get_notes_for_entity('job', v_job)) <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: d. the dispatched applicator did not read the job note';
  END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_driver, 'role', 'authenticated')::text, true);
  IF (SELECT count(*) FROM public.get_notes_for_entity('job', v_job)) <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: d. the driver read the note on a job they cannot see';
  END IF;

  -- e. The admin is unchanged.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  IF (SELECT count(*) FROM public.get_fields_geojson_by_ids(ARRAY[v_field_mine, v_field_other])) <> 2
     OR public.get_field_dashboard(v_field_other, NULL) -> 'field' ->> 'field_name' IS DISTINCT FROM '[SMOKE] FFA other ' || v_suffix THEN
    RAISE EXCEPTION 'SMOKE_FAIL: e. the admin no longer gets both fields and the field dashboard';
  END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END;
$smoke$;
