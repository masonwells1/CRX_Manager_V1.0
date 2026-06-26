-- ============================================================================
-- SMOKE TEST (rolled back by design): undispatch_job_locations + get_dispatched_list
-- ----------------------------------------------------------------------------
-- Field-app parity #37 (migration 20260626140000). Proves, through the REAL RPCs,
-- the Dispatched List + reassign/undispatch path end-to-end:
--
--   1. SETUP/LIST: dispatch loc A -> app1, loc B -> app2; get_dispatched_list
--      returns BOTH rows fully shaped (assignee name, job#, field, status, acres).
--   2. ASSIGNEE FILTER: get_dispatched_list(app1) returns ONLY loc A.
--   3. REASSIGN: dispatch_job_locations re-dispatches loc A -> app2 (upsert);
--      the list now shows loc A assigned to app2 (single current row, no dup).
--   4. UNDISPATCH: undispatch_job_locations([loc B]) cancels it -> { undispatched: 1 };
--      the row's dispatch_status = 'cancelled'; the list NO LONGER includes loc B.
--   5. UNDISPATCH REVOKES VISIBILITY: app2 (former assignee of loc B, no other live
--      grant) can no longer SELECT the cancelled dispatch row.
--   6. ROLE GATE: a non-admin/non-sales caller (an applicator) is rejected
--      (INSUFFICIENT_ROLE).
--   7. ACTOR GATE: a forged p_performed_by raises ACTOR_MISMATCH.
--   8. IDEMPOTENCY: replaying the SAME undispatch key returns the SAME result and
--      cancels nothing new.
--   9. NO-OP UNDISPATCH: undispatching a location with no current dispatch returns
--      { undispatched: 0 } (not an error).
--  10. ANON DENIED: anon has no EXECUTE on either new function.
--
-- Self-contained fixtures. The DO block ALWAYS ends in
-- RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK' — nothing here commits.
-- Requires migrations 20260626120000 + 20260626140000 applied.
-- ============================================================================

DO $$
DECLARE
  v_admin    uuid;
  v_app1     uuid;
  v_app2     uuid;
  v_cust     uuid;
  v_field_a  uuid;
  v_field_b  uuid;
  v_field_c  uuid;
  v_job      uuid;
  v_jf_a     uuid;
  v_jf_b     uuid;
  v_jf_orphan uuid;
  v_sfx      text := substr(gen_random_uuid()::text, 1, 8);
  v_key      text := '[SMOKE] undisp-' || v_sfx;
  v_res      jsonb;
  v_res2     jsonb;
  v_n        int;
  v_status   text;
  v_assignee text;
BEGIN
  -- ----------------------------------------------------------------- actor
  SELECT id INTO v_admin FROM profiles WHERE role = 'admin' AND is_active = true
   ORDER BY created_at LIMIT 1;
  IF v_admin IS NULL THEN RAISE EXCEPTION 'SMOKE_SETUP_FAILED: no active admin'; END IF;

  SELECT id INTO v_app1 FROM profiles WHERE role = 'applicator' AND is_active = true ORDER BY created_at LIMIT 1;
  SELECT id INTO v_app2 FROM profiles WHERE role = 'applicator' AND is_active = true AND id <> v_app1 ORDER BY created_at LIMIT 1;
  IF v_app1 IS NULL OR v_app2 IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP_FAILED: need >=2 active applicator profiles';
  END IF;

  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);

  -- --------------------------------------------------------------- fixtures
  INSERT INTO customers (farm_name) VALUES ('[SMOKE] Undisp Farm ' || v_sfx) RETURNING id INTO v_cust;
  INSERT INTO fields (customer_id, field_name, crop_type, total_acres)
    VALUES (v_cust, '[SMOKE] Undisp Field A ' || v_sfx, 'corn', 50) RETURNING id INTO v_field_a;
  INSERT INTO fields (customer_id, field_name, crop_type, total_acres)
    VALUES (v_cust, '[SMOKE] Undisp Field B ' || v_sfx, 'corn', 40) RETURNING id INTO v_field_b;
  INSERT INTO fields (customer_id, field_name, crop_type, total_acres)
    VALUES (v_cust, '[SMOKE] Undisp Field C ' || v_sfx, 'corn', 10) RETURNING id INTO v_field_c;

  INSERT INTO jobs (job_number, customer_id, status, job_date, total_acres, applied_acres, created_by)
    VALUES ('[SMOKE]-UNDISP-' || v_sfx, v_cust, 'scheduled', CURRENT_DATE + 2, 90, 0, v_admin)
    RETURNING id INTO v_job;
  INSERT INTO job_fields (job_id, field_id, acres_to_treat, sort_order)
    VALUES (v_job, v_field_a, 50, 0) RETURNING id INTO v_jf_a;
  INSERT INTO job_fields (job_id, field_id, acres_to_treat, sort_order)
    VALUES (v_job, v_field_b, 40, 1) RETURNING id INTO v_jf_b;
  -- an orphan location never dispatched (for the no-op undispatch probe).
  INSERT INTO job_fields (job_id, field_id, acres_to_treat, sort_order)
    VALUES (v_job, v_field_c, 10, 2) RETURNING id INTO v_jf_orphan;

  -- ============================================ 1) SETUP + LIST
  v_res := dispatch_job_locations(
    jsonb_build_array(
      jsonb_build_object('job_field_id', v_jf_a, 'applicator_id', v_app1, 'crew_id', NULL),
      jsonb_build_object('job_field_id', v_jf_b, 'applicator_id', v_app2, 'crew_id', NULL)
    ), v_admin, '[SMOKE] disp-' || v_sfx);
  IF (v_res->>'dispatched')::int <> 2 THEN RAISE EXCEPTION 'FAIL 1: expected dispatched=2 got %', v_res; END IF;

  SELECT count(*) INTO v_n FROM get_dispatched_list(NULL, NULL) r
   WHERE (r->>'job_id')::uuid = v_job;
  IF v_n <> 2 THEN RAISE EXCEPTION 'FAIL 1: list should show 2 rows for the job got %', v_n; END IF;

  -- assignee names resolved server-side (not null), field name present, acres present.
  SELECT (r->>'assignee_name') INTO v_assignee FROM get_dispatched_list(NULL, NULL) r
   WHERE (r->>'job_field_id')::uuid = v_jf_a;
  IF v_assignee IS NULL OR v_assignee = '' THEN RAISE EXCEPTION 'FAIL 1: loc A assignee_name not resolved'; END IF;
  PERFORM 1 FROM get_dispatched_list(NULL, NULL) r
   WHERE (r->>'job_field_id')::uuid = v_jf_a
     AND r->>'field_name' IS NOT NULL
     AND (r->>'location_acres')::numeric = 50
     AND (r->>'job_total_acres')::numeric = 90
     AND r->>'job_number' = '[SMOKE]-UNDISP-' || v_sfx;
  IF NOT FOUND THEN RAISE EXCEPTION 'FAIL 1: loc A row not fully shaped'; END IF;

  -- ============================================ 2) ASSIGNEE FILTER
  SELECT count(*) INTO v_n FROM get_dispatched_list(v_app1, NULL) r WHERE (r->>'job_id')::uuid = v_job;
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL 2: app1 filter should show 1 row got %', v_n; END IF;
  PERFORM 1 FROM get_dispatched_list(v_app1, NULL) r WHERE (r->>'job_field_id')::uuid = v_jf_a;
  IF NOT FOUND THEN RAISE EXCEPTION 'FAIL 2: app1 filter returned the wrong location'; END IF;

  -- ============================================ 3) REASSIGN (upsert loc A -> app2)
  v_res := dispatch_job_locations(
    jsonb_build_array(jsonb_build_object('job_field_id', v_jf_a, 'applicator_id', v_app2, 'crew_id', NULL)),
    v_admin, '[SMOKE] reassign-' || v_sfx);
  IF (v_res->>'dispatched')::int <> 1 THEN RAISE EXCEPTION 'FAIL 3: reassign should dispatch 1 got %', v_res; END IF;
  SELECT count(*) INTO v_n FROM job_location_dispatches WHERE job_field_id = v_jf_a AND dispatch_status = 'dispatched';
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL 3: reassign duplicated loc A (% current rows)', v_n; END IF;
  -- the list now shows loc A assigned to app2.
  PERFORM 1 FROM get_dispatched_list(v_app2, NULL) r WHERE (r->>'job_field_id')::uuid = v_jf_a;
  IF NOT FOUND THEN RAISE EXCEPTION 'FAIL 3: list does not reflect loc A reassigned to app2'; END IF;
  SELECT count(*) INTO v_n FROM get_dispatched_list(v_app1, NULL) r WHERE (r->>'job_field_id')::uuid = v_jf_a;
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL 3: loc A still shows under app1 after reassign'; END IF;

  -- ============================================ 4) UNDISPATCH loc B
  v_res := undispatch_job_locations(ARRAY[v_jf_b], v_admin, v_key);
  IF (v_res->>'undispatched')::int <> 1 THEN RAISE EXCEPTION 'FAIL 4: expected undispatched=1 got %', v_res; END IF;
  SELECT dispatch_status INTO v_status FROM job_location_dispatches WHERE job_field_id = v_jf_b;
  IF v_status <> 'cancelled' THEN RAISE EXCEPTION 'FAIL 4: loc B status should be cancelled got %', v_status; END IF;
  -- the list no longer includes loc B.
  SELECT count(*) INTO v_n FROM get_dispatched_list(NULL, NULL) r WHERE (r->>'job_field_id')::uuid = v_jf_b;
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL 4: undispatched loc B still in list'; END IF;
  -- an activity row was written.
  PERFORM 1 FROM activity_feed
   WHERE event_type = 'job_location_undispatched' AND related_entity_id = v_job AND performed_by = v_admin;
  IF NOT FOUND THEN RAISE EXCEPTION 'FAIL 4: undispatch not recorded in activity_feed'; END IF;

  -- ============================================ 5) UNDISPATCH REVOKES VISIBILITY
  -- app2 was the assignee of loc B (now cancelled). loc A is also app2 now, so to test
  -- the loc-B-specific revoke we check the cancelled row directly is hidden from app2.
  -- (app2 still sees loc A's CURRENT row — that is correct; only the cancelled one hides.)
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_app2, 'role', 'authenticated')::text, true);
  PERFORM set_config('role', 'authenticated', true);
  SELECT count(*) INTO v_n FROM job_location_dispatches WHERE job_field_id = v_jf_b;
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL 5: former assignee still sees cancelled loc B row (saw %)', v_n; END IF;
  RESET role;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);

  -- ============================================ 6) ROLE GATE (applicator caller)
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_app1, 'role', 'authenticated')::text, true);
  BEGIN
    PERFORM undispatch_job_locations(ARRAY[v_jf_a], v_app1, NULL);
    RAISE EXCEPTION 'FAIL 6: applicator caller should be rejected';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'FAIL %' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'INSUFFICIENT_ROLE%' THEN RAISE EXCEPTION 'FAIL 6: wrong error %', SQLERRM; END IF;
  END;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);

  -- ============================================ 7) ACTOR GATE (forged actor)
  BEGIN
    PERFORM undispatch_job_locations(ARRAY[v_jf_a], v_app2, NULL);  -- p_performed_by <> auth.uid()
    RAISE EXCEPTION 'FAIL 7: forged actor should raise ACTOR_MISMATCH';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'FAIL %' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'ACTOR_MISMATCH%' THEN RAISE EXCEPTION 'FAIL 7: wrong error %', SQLERRM; END IF;
  END;

  -- ============================================ 8) IDEMPOTENCY (replay undispatch key)
  v_res2 := undispatch_job_locations(ARRAY[v_jf_b], v_admin, v_key);
  IF v_res2 <> v_res THEN RAISE EXCEPTION 'FAIL 8: idempotent replay differs % vs %', v_res2, v_res; END IF;

  -- ============================================ 9) NO-OP UNDISPATCH (never dispatched)
  v_res := undispatch_job_locations(ARRAY[v_jf_orphan], v_admin, NULL);
  IF (v_res->>'undispatched')::int <> 0 THEN RAISE EXCEPTION 'FAIL 9: orphan undispatch should be 0 got %', v_res; END IF;

  -- ============================================ 10) ANON DENIED
  SELECT count(*) INTO v_n FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname IN ('undispatch_job_locations', 'get_dispatched_list')
     AND has_function_privilege('anon', p.oid, 'EXECUTE');
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL 10: anon can execute a new dispatch fn (% grants)', v_n; END IF;

  -- ============================================ 11) DEACTIVATED ASSIGNEE HIDDEN IN LIST RPC (Codex #37 P1)
  -- get_dispatched_list is SECURITY DEFINER (bypasses RLS); a DEACTIVATED user with a
  -- still-valid token must NOT receive their dispatch rows. loc A is dispatched to app2
  -- (the reassign in step 3). app2 is NOT the whole-job applicator of SPLITBILL's job
  -- here (this is the self-contained UNDISP job whose whole-job applicator is unset), so
  -- once app2 is deactivated the list must show 0 rows for them.
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  -- confirm app2 (active) DOES see loc A via the list RPC first (control)
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_app2, 'role', 'authenticated')::text, true);
  SELECT count(*) INTO v_n FROM get_dispatched_list(NULL, NULL) r WHERE (r->>'job_field_id')::uuid = v_jf_a;
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL 11a: active per-location assignee should see their list row (saw %)', v_n; END IF;
  -- deactivate app2, then app2 must see 0 (deactivation revokes list visibility immediately)
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  UPDATE profiles SET is_active = false WHERE id = v_app2;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_app2, 'role', 'authenticated')::text, true);
  SELECT count(*) INTO v_n FROM get_dispatched_list(NULL, NULL) r WHERE (r->>'job_field_id')::uuid = v_jf_a;
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL 11b: DEACTIVATED assignee still sees list row via SECDEF RPC (saw %)', v_n; END IF;
  -- reactivate (cleanliness; rolled back anyway)
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  UPDATE profiles SET is_active = true WHERE id = v_app2;

  -- ============================================ 12) UNDISPATCH GATED BY JOB LIFECYCLE (Codex #37 final P2)
  -- loc A is currently dispatched (to app2 after reassign). Move the job to a NON-dispatchable
  -- status (cancelled) and confirm a DIRECT undispatch_job_locations call is a NO-OP: the
  -- finished job's dispatch must NOT be cancellable (the server is the write boundary; the
  -- UI hiding the control is not enough). The dispatch row stays 'dispatched'.
  UPDATE jobs SET status = 'cancelled' WHERE id = v_job;  -- legal scheduled->cancelled
  v_res := undispatch_job_locations(ARRAY[v_jf_a], v_admin, '[SMOKE] undisp-finished-' || v_sfx);
  IF (v_res->>'undispatched')::int <> 0 THEN
    RAISE EXCEPTION 'FAIL 12: undispatch on a cancelled job should be a no-op got %', v_res;
  END IF;
  SELECT dispatch_status INTO v_status FROM job_location_dispatches WHERE job_field_id = v_jf_a;
  IF v_status <> 'dispatched' THEN
    RAISE EXCEPTION 'FAIL 12: finished-job dispatch was wrongly cancelled (status %)', v_status;
  END IF;
  -- restore for cleanliness (rolled back anyway): admin-override permits cancelled->scheduled
  PERFORM set_config('app.admin_override', 'true', true);
  UPDATE jobs SET status = 'scheduled' WHERE id = v_job;
  PERFORM set_config('app.admin_override', 'false', true);

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END $$;
