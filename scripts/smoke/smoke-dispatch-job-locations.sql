-- ============================================================================
-- SMOKE TEST (rolled back by design): dispatch_job_locations
-- ----------------------------------------------------------------------------
-- Field-app parity #36 (migration 20260626120000). Proves, through the REAL
-- RPC + the new job_location_dispatches table, the per-location dispatch wizard
-- commit path end-to-end:
--
--   1. MULTI-APPLICATOR SPLIT: dispatch location A -> applicator 1 and
--      location B -> applicator 2 in ONE call -> { dispatched: 2 }; two rows
--      persist with DIFFERENT applicators (a job split between two applicators).
--   2. IDEMPOTENCY: replaying the SAME key returns the SAME result and adds NO
--      new rows.
--   3. RE-DISPATCH UPSERT: re-dispatching location A (new key) to a CREW REPLACES
--      its row in place (1 row, now crew-assigned) — never a duplicate.
--   4. XOR GUARD: an assignment with BOTH applicator+crew, and one with NEITHER,
--      both raise ONE_ASSIGNEE_REQUIRED.
--   5. ROLE GATE: a non-admin / non-sales caller (an applicator) is rejected
--      (INSUFFICIENT_ROLE).
--   6. ACTOR GATE: a forged p_performed_by raises ACTOR_MISMATCH.
--   7. LIFECYCLE GATE: a location on a CANCELLED (non-dispatchable) job is
--      rejected (JOB_NOT_DISPATCHABLE).
--   8. RLS READ: the dispatched applicator can SELECT their own dispatch row even
--      though they are NOT the job's whole-job applicator.
--   9. RLS WRITE: that same applicator CANNOT directly INSERT a dispatch row
--      (dispatchers only).
--
-- Self-contained fixtures (own customer/field/job/applicators) so the chain
-- never depends on seed state. The DO block ALWAYS ends in
-- RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK' — nothing here commits.
-- Requires migration 20260626120000 applied.
-- ============================================================================

DO $$
DECLARE
  v_admin    uuid;
  v_app1     uuid;
  v_app2     uuid;
  v_crew     uuid;
  v_cust     uuid;
  v_field_a  uuid;
  v_field_b  uuid;
  v_field_c  uuid;
  v_job      uuid;
  v_jf_a     uuid;
  v_jf_b     uuid;
  v_jf_c     uuid;
  v_sfx      text := substr(gen_random_uuid()::text, 1, 8);
  v_key      text := '[SMOKE] disp-' || v_sfx;
  v_res      jsonb;
  v_res2     jsonb;
  v_n        int;
  v_app_a    uuid;
  v_app_b    uuid;
  v_seen     int;
  v_crew_member uuid;  -- a profile that is a member of v_crew (for crew RLS read)
BEGIN
  -- ----------------------------------------------------------------- actor
  SELECT id INTO v_admin FROM profiles WHERE role = 'admin' AND is_active = true
   ORDER BY created_at LIMIT 1;
  IF v_admin IS NULL THEN RAISE EXCEPTION 'SMOKE_SETUP_FAILED: no active admin'; END IF;

  -- two active applicators (seed has Bob/Carl; create if missing so the chain
  -- stands alone). Profiles require a real auth.users row — reuse existing
  -- applicators when present.
  SELECT id INTO v_app1 FROM profiles WHERE role = 'applicator' AND is_active = true ORDER BY created_at LIMIT 1;
  SELECT id INTO v_app2 FROM profiles WHERE role = 'applicator' AND is_active = true AND id <> v_app1 ORDER BY created_at LIMIT 1;
  IF v_app1 IS NULL OR v_app2 IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP_FAILED: need >=2 active applicator profiles';
  END IF;

  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);

  -- --------------------------------------------------------------- fixtures
  INSERT INTO customers (farm_name) VALUES ('[SMOKE] Dispatch Farm ' || v_sfx) RETURNING id INTO v_cust;
  INSERT INTO fields (customer_id, field_name, crop_type, total_acres)
    VALUES (v_cust, '[SMOKE] Disp Field A ' || v_sfx, 'corn', 50) RETURNING id INTO v_field_a;
  INSERT INTO fields (customer_id, field_name, crop_type, total_acres)
    VALUES (v_cust, '[SMOKE] Disp Field B ' || v_sfx, 'corn', 40) RETURNING id INTO v_field_b;
  INSERT INTO fields (customer_id, field_name, crop_type, total_acres)
    VALUES (v_cust, '[SMOKE] Disp Field C ' || v_sfx, 'corn', 30) RETURNING id INTO v_field_c;

  -- a multi-location job in a dispatchable status (INSERT bypasses the
  -- BEFORE-UPDATE status-transition trigger).
  INSERT INTO jobs (job_number, customer_id, status, job_date, total_acres, created_by)
    VALUES ('[SMOKE]-DISP-' || v_sfx, v_cust, 'scheduled', CURRENT_DATE + 2, 120, v_admin)
    RETURNING id INTO v_job;
  INSERT INTO job_fields (job_id, field_id, acres_to_treat, sort_order)
    VALUES (v_job, v_field_a, 50, 0) RETURNING id INTO v_jf_a;
  INSERT INTO job_fields (job_id, field_id, acres_to_treat, sort_order)
    VALUES (v_job, v_field_b, 40, 1) RETURNING id INTO v_jf_b;
  INSERT INTO job_fields (job_id, field_id, acres_to_treat, sort_order)
    VALUES (v_job, v_field_c, 30, 2) RETURNING id INTO v_jf_c;

  -- a crew for the upsert step
  INSERT INTO ground_crews (name, created_by)
    VALUES ('[SMOKE] Crew ' || v_sfx, v_admin) RETURNING id INTO v_crew;

  -- ============================================ 1) MULTI-APPLICATOR SPLIT
  v_res := dispatch_job_locations(
    jsonb_build_array(
      jsonb_build_object('job_field_id', v_jf_a, 'applicator_id', v_app1, 'crew_id', NULL),
      jsonb_build_object('job_field_id', v_jf_b, 'applicator_id', v_app2, 'crew_id', NULL)
    ), v_admin, v_key);
  IF (v_res->>'dispatched')::int <> 2 THEN RAISE EXCEPTION 'FAIL 1: expected dispatched=2 got %', v_res; END IF;

  SELECT count(*) INTO v_n FROM job_location_dispatches WHERE job_id = v_job;
  IF v_n <> 2 THEN RAISE EXCEPTION 'FAIL 1: expected 2 persisted rows got %', v_n; END IF;

  SELECT applicator_id INTO v_app_a FROM job_location_dispatches WHERE job_field_id = v_jf_a;
  SELECT applicator_id INTO v_app_b FROM job_location_dispatches WHERE job_field_id = v_jf_b;
  IF v_app_a IS NOT DISTINCT FROM v_app_b THEN RAISE EXCEPTION 'FAIL 1: both locations got the same applicator'; END IF;
  IF v_app_a <> v_app1 OR v_app_b <> v_app2 THEN RAISE EXCEPTION 'FAIL 1: wrong applicator mapping'; END IF;

  -- NORMAL dispatch also lands on the activity timeline (Codex re-review-5 P2): two
  -- job_location_dispatched rows for this job, NOT just override cases.
  SELECT count(*) INTO v_n FROM activity_feed
   WHERE event_type = 'job_location_dispatched' AND related_entity_id = v_job AND performed_by = v_admin;
  IF v_n <> 2 THEN RAISE EXCEPTION 'FAIL 1: expected 2 activity_feed rows for the dispatch, got %', v_n; END IF;

  -- ============================================ 2) IDEMPOTENCY
  v_res2 := dispatch_job_locations(
    jsonb_build_array(
      jsonb_build_object('job_field_id', v_jf_a, 'applicator_id', v_app1, 'crew_id', NULL),
      jsonb_build_object('job_field_id', v_jf_b, 'applicator_id', v_app2, 'crew_id', NULL)
    ), v_admin, v_key);
  IF v_res2 <> v_res THEN RAISE EXCEPTION 'FAIL 2: idempotent replay differs % vs %', v_res2, v_res; END IF;
  SELECT count(*) INTO v_n FROM job_location_dispatches WHERE job_id = v_job;
  IF v_n <> 2 THEN RAISE EXCEPTION 'FAIL 2: idempotent replay changed row count to %', v_n; END IF;

  -- ============================================ 3) RE-DISPATCH UPSERT -> crew
  v_res := dispatch_job_locations(
    jsonb_build_array(jsonb_build_object('job_field_id', v_jf_a, 'applicator_id', NULL, 'crew_id', v_crew)),
    v_admin, '[SMOKE] disp-redo-' || v_sfx);
  SELECT count(*) INTO v_n FROM job_location_dispatches WHERE job_field_id = v_jf_a;
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL 3: re-dispatch duplicated location (% rows)', v_n; END IF;
  PERFORM 1 FROM job_location_dispatches WHERE job_field_id = v_jf_a AND crew_id = v_crew AND applicator_id IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'FAIL 3: re-dispatch did not switch loc A to crew'; END IF;

  -- ============================================ 4) XOR GUARD (both / neither)
  BEGIN
    PERFORM dispatch_job_locations(
      jsonb_build_array(jsonb_build_object('job_field_id', v_jf_c, 'applicator_id', v_app1, 'crew_id', v_crew)),
      v_admin, NULL);
    RAISE EXCEPTION 'FAIL 4a: both-assignee should have been rejected';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'FAIL %' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'ONE_ASSIGNEE_REQUIRED%' THEN RAISE EXCEPTION 'FAIL 4a: wrong error %', SQLERRM; END IF;
  END;
  BEGIN
    PERFORM dispatch_job_locations(
      jsonb_build_array(jsonb_build_object('job_field_id', v_jf_c, 'applicator_id', NULL, 'crew_id', NULL)),
      v_admin, NULL);
    RAISE EXCEPTION 'FAIL 4b: neither-assignee should have been rejected';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'FAIL %' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'ONE_ASSIGNEE_REQUIRED%' THEN RAISE EXCEPTION 'FAIL 4b: wrong error %', SQLERRM; END IF;
  END;

  -- ============================================ 6) ACTOR GATE (forged actor)
  BEGIN
    PERFORM dispatch_job_locations(
      jsonb_build_array(jsonb_build_object('job_field_id', v_jf_c, 'applicator_id', v_app1, 'crew_id', NULL)),
      v_app2, NULL);  -- p_performed_by <> auth.uid()
    RAISE EXCEPTION 'FAIL 6: forged actor should raise ACTOR_MISMATCH';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'FAIL %' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'ACTOR_MISMATCH%' THEN RAISE EXCEPTION 'FAIL 6: wrong error %', SQLERRM; END IF;
  END;

  -- ============================================ 7) LIFECYCLE GATE (cancelled job)
  UPDATE jobs SET status = 'cancelled' WHERE id = v_job;  -- legal scheduled->cancelled
  BEGIN
    PERFORM dispatch_job_locations(
      jsonb_build_array(jsonb_build_object('job_field_id', v_jf_c, 'applicator_id', v_app1, 'crew_id', NULL)),
      v_admin, NULL);
    RAISE EXCEPTION 'FAIL 7: cancelled-job dispatch should be rejected';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'FAIL %' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'JOB_NOT_DISPATCHABLE%' THEN RAISE EXCEPTION 'FAIL 7: wrong error %', SQLERRM; END IF;
  END;
  -- Restore to dispatchable for the license/crew/RLS probes below (the admin-override
  -- hatch permits the otherwise-blocked cancelled->scheduled transition).
  PERFORM set_config('app.admin_override', 'true', true);
  UPDATE jobs SET status = 'scheduled' WHERE id = v_job;
  PERFORM set_config('app.admin_override', 'false', true);

  -- ============================================ 5) ROLE GATE (applicator caller)
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_app1, 'role', 'authenticated')::text, true);
  BEGIN
    PERFORM dispatch_job_locations(
      jsonb_build_array(jsonb_build_object('job_field_id', v_jf_b, 'applicator_id', v_app2, 'crew_id', NULL)),
      v_app1, NULL);
    RAISE EXCEPTION 'FAIL 5: applicator caller should be rejected';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'FAIL %' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'INSUFFICIENT_ROLE%' THEN RAISE EXCEPTION 'FAIL 5: wrong error %', SQLERRM; END IF;
  END;

  -- ============================================ 8) RLS READ (dispatched applicator)
  -- v_jf_b is dispatched to v_app2; switch to v_app2 as authenticated and confirm
  -- they can SELECT their own dispatch row through RLS.
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_app2, 'role', 'authenticated')::text, true);
  PERFORM set_config('role', 'authenticated', true);
  SELECT count(*) INTO v_seen FROM job_location_dispatches WHERE job_field_id = v_jf_b;
  IF v_seen <> 1 THEN RAISE EXCEPTION 'FAIL 8: dispatched applicator cannot see own row (saw %)', v_seen; END IF;

  -- ============================================ 9) RLS WRITE — RPC-ONLY (applicator denied)
  -- Writes are RPC-only: there is NO client INSERT/UPDATE/DELETE policy, so a
  -- direct PostgREST write by ANY role is denied (the SECURITY DEFINER RPC is the
  -- sole write path). Probe the applicator first…
  BEGIN
    INSERT INTO job_location_dispatches (job_field_id, job_id, applicator_id, dispatched_by)
      VALUES (v_jf_c, v_job, v_app2, v_app2);
    RAISE EXCEPTION 'FAIL 9: applicator INSERT should be RLS-denied';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;  -- expected: RLS row-level denial (no permissive write policy)
  WHEN OTHERS THEN
    IF SQLERRM LIKE 'FAIL %' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE '%row-level security%' THEN RAISE EXCEPTION 'FAIL 9: wrong error %', SQLERRM; END IF;
  END;
  RESET role;

  -- ============================================ 10) RPC-ONLY WRITE (admin direct INSERT denied too)
  -- Even an ADMIN cannot bypass the RPC's lifecycle/active-assignee guards via a
  -- direct table INSERT — closes the Codex #36 P2 write-bypass (admin/sales_rep
  -- could otherwise dispatch a cancelled job or assign an inactive profile).
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('role', 'authenticated', true);
  BEGIN
    INSERT INTO job_location_dispatches (job_field_id, job_id, applicator_id, dispatched_by)
      VALUES (v_jf_c, v_job, v_app1, v_admin);
    RAISE EXCEPTION 'FAIL 10: admin direct INSERT should be denied (writes are RPC-only)';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;  -- expected: no permissive write policy → denied
  WHEN OTHERS THEN
    IF SQLERRM LIKE 'FAIL %' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE '%row-level security%' THEN RAISE EXCEPTION 'FAIL 10: wrong error %', SQLERRM; END IF;
  END;
  RESET role;

  -- ============================================ 11) LICENSE GATE (Codex re-review P1)
  -- v_jf_b is currently dispatched to v_app2. Give v_app2 an EXPIRED active license,
  -- then a re-dispatch to v_app2 must be blocked with LICENSE_EXPIRED; the admin
  -- override succeeds. (applicator_licenses: staff-held via profile_id.)
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  INSERT INTO applicator_licenses (profile_id, license_number, license_type, holder_name, state, expiry_date, is_active)
    VALUES (v_app2, '[SMOKE]-LIC-' || v_sfx, 'commercial', '[SMOKE] Carl', 'IL', CURRENT_DATE - 10, true);
  BEGIN
    PERFORM dispatch_job_locations(
      jsonb_build_array(jsonb_build_object('job_field_id', v_jf_b, 'applicator_id', v_app2, 'crew_id', NULL)),
      v_admin, NULL, false);
    RAISE EXCEPTION 'FAIL 11: expired-license dispatch should raise LICENSE_EXPIRED';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'FAIL %' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'LICENSE_EXPIRED%' THEN RAISE EXCEPTION 'FAIL 11: wrong error %', SQLERRM; END IF;
  END;
  -- admin override succeeds AND is recorded durably (Codex re-review P2)
  v_res := dispatch_job_locations(
    jsonb_build_array(jsonb_build_object('job_field_id', v_jf_b, 'applicator_id', v_app2, 'crew_id', NULL)),
    v_admin, NULL, true);
  IF (v_res->>'dispatched')::int <> 1 THEN RAISE EXCEPTION 'FAIL 11: override should dispatch 1 got %', v_res; END IF;
  IF (v_res->>'license_overrides')::int <> 1 THEN RAISE EXCEPTION 'FAIL 11: override count should be 1 got %', v_res; END IF;
  PERFORM 1 FROM activity_feed
   WHERE event_type = 'job_location_dispatched' AND related_entity_id = v_job
     AND description LIKE '%EXPIRED license%override%' AND performed_by = v_admin;
  IF NOT FOUND THEN RAISE EXCEPTION 'FAIL 11: license override not recorded in activity_feed'; END IF;

  -- ============================================ 12) CREW-MEMBER RLS READ (Codex re-review P2)
  -- Dispatch v_jf_c to the crew, add v_app1 as a member of that crew, then confirm
  -- v_app1 (a crew member, NOT the whole-job applicator) can SELECT the dispatch row
  -- AND the parent job (jobs_select_location_dispatchee).
  v_res := dispatch_job_locations(
    jsonb_build_array(jsonb_build_object('job_field_id', v_jf_c, 'applicator_id', NULL, 'crew_id', v_crew)),
    v_admin, NULL, false);
  INSERT INTO ground_crew_members (crew_id, name, profile_id, is_active)
    VALUES (v_crew, 'Smoke Member', v_app1, true);
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_app1, 'role', 'authenticated')::text, true);
  PERFORM set_config('role', 'authenticated', true);
  SELECT count(*) INTO v_seen FROM job_location_dispatches WHERE job_field_id = v_jf_c;
  IF v_seen <> 1 THEN RAISE EXCEPTION 'FAIL 12: crew member cannot read crew dispatch row (saw %)', v_seen; END IF;
  -- crew member can also read the PARENT job (else their work is invisible on the board)
  SELECT count(*) INTO v_seen FROM jobs WHERE id = v_job;
  IF v_seen <> 1 THEN RAISE EXCEPTION 'FAIL 12: crew member cannot read parent job via jobs_select_location_dispatchee'; END IF;
  RESET role;

  -- ============================================ 13) PER-LOCATION APPLICATOR READS PARENT JOB (Codex re-review P1)
  -- v_jf_b is dispatched to v_app2 (who is NOT the whole-job applicator). Confirm
  -- v_app2 can read the parent job through jobs_select_location_dispatchee.
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_app2, 'role', 'authenticated')::text, true);
  PERFORM set_config('role', 'authenticated', true);
  SELECT count(*) INTO v_seen FROM jobs WHERE id = v_job;
  IF v_seen <> 1 THEN RAISE EXCEPTION 'FAIL 13: per-location applicator cannot read parent job (RLS)'; END IF;
  RESET role;

  -- ============================================ 13b) DEACTIVATED ASSIGNEE LOSES VISIBILITY (Codex re-review-6 P2)
  -- Deactivate v_app2 (still a live dispatch on v_jf_b); a deactivated profile must
  -- NOT keep reading the dispatch row / parent job, even with a valid token.
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  UPDATE profiles SET is_active = false WHERE id = v_app2;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_app2, 'role', 'authenticated')::text, true);
  PERFORM set_config('role', 'authenticated', true);
  SELECT count(*) INTO v_seen FROM job_location_dispatches WHERE job_field_id = v_jf_b;
  IF v_seen <> 0 THEN RAISE EXCEPTION 'FAIL 13b: deactivated assignee still reads dispatch row (saw %)', v_seen; END IF;
  SELECT count(*) INTO v_seen FROM jobs WHERE id = v_job;
  IF v_seen <> 0 THEN RAISE EXCEPTION 'FAIL 13b: deactivated assignee still reads parent job (saw %)', v_seen; END IF;
  RESET role;
  -- reactivate for the remaining steps
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  UPDATE profiles SET is_active = true WHERE id = v_app2;

  -- ============================================ 14) CANCELLED DISPATCH REVOKES VISIBILITY (Codex re-review P2)
  -- Mark v_jf_b's dispatch (to v_app2) cancelled; v_app2 must NO LONGER see the
  -- dispatch row OR the parent job via the per-location grants. (As admin we set
  -- the status; writes are RPC-only for clients, but the smoke runs unprivileged
  -- DML as the superuser session, which is fine for staging the state.)
  UPDATE job_location_dispatches SET dispatch_status = 'cancelled' WHERE job_field_id = v_jf_b;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_app2, 'role', 'authenticated')::text, true);
  PERFORM set_config('role', 'authenticated', true);
  SELECT count(*) INTO v_seen FROM job_location_dispatches WHERE job_field_id = v_jf_b;
  IF v_seen <> 0 THEN RAISE EXCEPTION 'FAIL 14: cancelled dispatch still visible to former assignee (saw %)', v_seen; END IF;
  -- v_app2 no longer reads the parent job EITHER (no other live dispatch to them).
  -- (v_jf_a is dispatched to v_app1, not v_app2, so v_app2 has no live grant.)
  SELECT count(*) INTO v_seen FROM jobs WHERE id = v_job;
  IF v_seen <> 0 THEN RAISE EXCEPTION 'FAIL 14: former assignee still reads parent job after cancel (saw %)', v_seen; END IF;
  RESET role;

  -- ============================================ 15) PER-LOCATION ASSIGNEE READS job_fields (Codex re-review-3 P2)
  -- v_jf_c is dispatched to v_crew; v_app1 is a member of v_crew (added in step 12).
  -- The board embeds job_fields to show the location name — confirm v_app1 (a crew
  -- member, NOT the whole-job applicator) can SELECT the job_fields rows of the job.
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_app1, 'role', 'authenticated')::text, true);
  PERFORM set_config('role', 'authenticated', true);
  SELECT count(*) INTO v_seen FROM job_fields WHERE job_id = v_job;
  IF v_seen < 1 THEN RAISE EXCEPTION 'FAIL 15: per-location assignee (crew member) cannot read job_fields (saw %)', v_seen; END IF;
  RESET role;

  -- ============================================ 17) PER-LOCATION ASSIGNEE READS customer (Codex re-review-4 P2)
  -- v_jf_c is dispatched to v_crew; v_app1 is a member. The board embeds
  -- customer:customers(farm_name) — confirm v_app1 can read the job's customer row.
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_app1, 'role', 'authenticated')::text, true);
  PERFORM set_config('role', 'authenticated', true);
  SELECT count(*) INTO v_seen FROM customers WHERE id = v_cust;
  IF v_seen <> 1 THEN RAISE EXCEPTION 'FAIL 17: per-location assignee cannot read the job customer (saw %)', v_seen; END IF;
  RESET role;

  -- ============================================ 19) DEACTIVATED CREW LOSES VISIBILITY (Codex re-review-9 P2)
  -- v_jf_c is dispatched to v_crew; v_app1 is an active member. Deactivate the CREW
  -- (members stay active) — v_app1 must lose the dispatch-row/job/job_fields/customer reads.
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  UPDATE ground_crews SET is_active = false WHERE id = v_crew;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_app1, 'role', 'authenticated')::text, true);
  PERFORM set_config('role', 'authenticated', true);
  SELECT count(*) INTO v_seen FROM job_location_dispatches WHERE job_field_id = v_jf_c;
  IF v_seen <> 0 THEN RAISE EXCEPTION 'FAIL 19: deactivated crew still grants dispatch-row read (saw %)', v_seen; END IF;
  SELECT count(*) INTO v_seen FROM job_fields WHERE job_id = v_job;
  IF v_seen <> 0 THEN RAISE EXCEPTION 'FAIL 19: deactivated crew still grants job_fields read (saw %)', v_seen; END IF;
  RESET role;
  -- reactivate for the remaining steps (16 deletes the crew anyway)
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  UPDATE ground_crews SET is_active = true WHERE id = v_crew;

  -- ============================================ 18) SOFT-DELETED JOB REJECTED (Codex re-review-4 P2)
  -- A soft-deleted job (deleted_at set) whose status is still scheduled must NOT be
  -- dispatchable, even though the RPC bypasses RLS. Soft-delete v_job and retry.
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  UPDATE jobs SET deleted_at = now() WHERE id = v_job;
  BEGIN
    PERFORM dispatch_job_locations(
      jsonb_build_array(jsonb_build_object('job_field_id', v_jf_a, 'applicator_id', v_app1, 'crew_id', NULL)),
      v_admin, NULL, false);
    RAISE EXCEPTION 'FAIL 18: soft-deleted job dispatch should be rejected';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'FAIL %' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'JOB_NOT_FOUND%' THEN RAISE EXCEPTION 'FAIL 18: wrong error %', SQLERRM; END IF;
  END;
  UPDATE jobs SET deleted_at = NULL WHERE id = v_job;  -- restore for step 16

  -- ============================================ 20) DUPLICATE LOCATION IN PAYLOAD REJECTED (Codex re-review-9 P3)
  -- The same job_field_id twice in one payload over-counts/double-logs — reject it.
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  BEGIN
    PERFORM dispatch_job_locations(
      jsonb_build_array(
        jsonb_build_object('job_field_id', v_jf_a, 'applicator_id', v_app1, 'crew_id', NULL),
        jsonb_build_object('job_field_id', v_jf_a, 'applicator_id', v_app2, 'crew_id', NULL)
      ), v_admin, NULL, false);
    RAISE EXCEPTION 'FAIL 20: duplicate job_field_id should be rejected';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'FAIL %' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'DUPLICATE_LOCATION%' THEN RAISE EXCEPTION 'FAIL 20: wrong error %', SQLERRM; END IF;
  END;

  -- ============================================ 16) FK CASCADE on assignee delete (Codex re-review-3 P2)
  -- Deleting an assignee that has a dispatch row must CASCADE-remove the row, NOT
  -- fail trying to NULL the sole assignee against the XOR check. Use a CREW (the
  -- applicator path is identical — both FKs are ON DELETE CASCADE — but crews have
  -- no blocking back-references in seed data). Dispatch v_jf_a to v_crew, delete the
  -- crew, and assert the dispatch row cascaded away (no XOR-violation error).
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  v_res := dispatch_job_locations(
    jsonb_build_array(jsonb_build_object('job_field_id', v_jf_a, 'applicator_id', NULL, 'crew_id', v_crew)),
    v_admin, NULL, false);
  SELECT count(*) INTO v_seen FROM job_location_dispatches WHERE job_field_id = v_jf_a AND crew_id = v_crew;
  IF v_seen <> 1 THEN RAISE EXCEPTION 'FAIL 16: setup — v_jf_a not dispatched to v_crew (saw %)', v_seen; END IF;
  DELETE FROM ground_crews WHERE id = v_crew;  -- must cascade the dispatch row, not error on XOR
  SELECT count(*) INTO v_seen FROM job_location_dispatches WHERE job_field_id = v_jf_a;
  IF v_seen <> 0 THEN RAISE EXCEPTION 'FAIL 16: crew delete did not cascade the dispatch row (saw %)', v_seen; END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END $$;
