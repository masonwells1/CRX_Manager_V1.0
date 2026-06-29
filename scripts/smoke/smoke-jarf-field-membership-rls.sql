-- ============================================================================
-- SMOKE TEST (rolled back by design): FIX 1 (Wave 2a) — field-membership RLS on
-- job_applied_record_fields (migration 20260629150000_jarf_field_membership_rls).
-- ----------------------------------------------------------------------------
-- Run AFTER applying 20260629150000. Proves the INSERT/UPDATE WITH CHECK now
-- requires the row's field_id to belong to the parent record's job:
--
--   SETUP (as table owner, RLS-bypassed): a sales_rep, a job with ONE in-job
--          field (v_field_in), a SEPARATE field NOT on the job (v_field_out), and
--          an applied record on that job.
--   P1  REJECT — as the sales_rep (role authenticated, RLS enforced), inserting a
--          job_applied_record_fields row with the FOREIGN field_id (v_field_out)
--          FAILS the WITH CHECK (insufficient_privilege / RLS violation).
--   P2  ACCEPT — the SAME sales_rep inserting the IN-JOB field_id (v_field_in)
--          SUCCEEDS (one row written, recompute trigger runs).
--   P3  UPDATE REJECT — moving the legit row's field_id to the foreign field
--          FAILS the WITH CHECK (the row stays on the in-job field).
--
-- Ends in RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK'. Any other error = FAIL.
-- ============================================================================
DO $smoke$
DECLARE
  v_sfx       text := substr(gen_random_uuid()::text,1,8);
  v_sales     uuid;
  v_cust      uuid;
  v_job       uuid;
  v_field_in  uuid;   -- a field ON the job
  v_field_out uuid;   -- a field NOT on the job (foreign)
  v_rec       uuid;   -- the applied record
  v_n         int;
  v_rowid     uuid;
BEGIN
  SELECT id INTO v_sales FROM profiles WHERE role='sales_rep' AND is_active=true ORDER BY created_at LIMIT 1;
  IF v_sales IS NULL THEN RAISE EXCEPTION 'SMOKE_SETUP: no sales_rep'; END IF;

  -- ── SETUP (owner privileges, RLS bypassed) ────────────────────────────────
  INSERT INTO customers (farm_name) VALUES ('[SMOKE] JARF '||v_sfx) RETURNING id INTO v_cust;
  INSERT INTO fields (field_name, customer_id) VALUES ('[SMOKE] InJob '||v_sfx, v_cust) RETURNING id INTO v_field_in;
  INSERT INTO fields (field_name, customer_id) VALUES ('[SMOKE] Foreign '||v_sfx, v_cust) RETURNING id INTO v_field_out;

  INSERT INTO jobs (job_number, customer_id, job_date, status)
    VALUES ('[SMOKE] JARF-'||v_sfx, v_cust, CURRENT_DATE, 'in_progress') RETURNING id INTO v_job;
  -- Only v_field_in is a field on the job; v_field_out deliberately is NOT.
  INSERT INTO job_fields (job_id, field_id) VALUES (v_job, v_field_in);

  INSERT INTO job_applied_records (job_id, application_date) VALUES (v_job, CURRENT_DATE) RETURNING id INTO v_rec;

  -- Become the sales_rep with RLS enforced (authenticated role + jwt sub).
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_sales, 'role','authenticated')::text, true);
  SET LOCAL ROLE authenticated;

  -- ── P1 REJECT: foreign field_id fails the WITH CHECK ──────────────────────
  BEGIN
    INSERT INTO job_applied_record_fields (application_record_id, field_id, applied_acres)
      VALUES (v_rec, v_field_out, 50);
    RESET ROLE;
    RAISE EXCEPTION 'SMOKE_FAIL: foreign field_id was accepted (RLS hole still open)';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RESET ROLE; RAISE; END IF;
    -- RLS violation surfaces as 'new row violates row-level security policy'.
    IF SQLERRM NOT LIKE '%row-level security%' THEN
      RESET ROLE;
      RAISE EXCEPTION 'SMOKE_FAIL: foreign insert failed for the WRONG reason: %', SQLERRM;
    END IF;
  END;

  -- ── P2 ACCEPT: in-job field_id passes ─────────────────────────────────────
  INSERT INTO job_applied_record_fields (application_record_id, field_id, applied_acres)
    VALUES (v_rec, v_field_in, 40) RETURNING id INTO v_rowid;
  RESET ROLE;  -- back to owner to read the result without RLS narrowing

  SELECT count(*) INTO v_n FROM job_applied_record_fields WHERE application_record_id=v_rec;
  IF v_n <> 1 THEN RAISE EXCEPTION 'SMOKE_FAIL: expected exactly 1 in-job row, got %', v_n; END IF;
  SELECT count(*) INTO v_n FROM job_applied_record_fields WHERE application_record_id=v_rec AND field_id=v_field_out;
  IF v_n <> 0 THEN RAISE EXCEPTION 'SMOKE_FAIL: a foreign-field row exists (count %)', v_n; END IF;

  -- ── P3 UPDATE REJECT: cannot move the legit row onto the foreign field ─────
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_sales, 'role','authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  BEGIN
    UPDATE job_applied_record_fields SET field_id = v_field_out WHERE id = v_rowid;
    -- An RLS WITH CHECK failure on UPDATE raises; if it does NOT raise, the move was allowed.
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RESET ROLE;
    IF v_n > 0 THEN RAISE EXCEPTION 'SMOKE_FAIL: UPDATE moved the row onto a foreign field'; END IF;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RESET ROLE; RAISE; END IF;
    IF SQLERRM NOT LIKE '%row-level security%' THEN
      RESET ROLE;
      RAISE EXCEPTION 'SMOKE_FAIL: UPDATE failed for the WRONG reason: %', SQLERRM;
    END IF;
    RESET ROLE;
  END;

  -- Confirm the row is still on the in-job field.
  SELECT field_id INTO v_field_out FROM job_applied_record_fields WHERE id=v_rowid;
  IF v_field_out <> v_field_in THEN RAISE EXCEPTION 'SMOKE_FAIL: row field_id drifted off the in-job field'; END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END $smoke$;
