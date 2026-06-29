-- ============================================================================
-- SMOKE TEST (rolled back by design): FIX 2 (Wave 2a) — batched billed-customer
-- resolver get_jobs_billed_customers (migration 20260629160000).
-- ----------------------------------------------------------------------------
-- Run AFTER applying 20260629160000. Proves the batch resolver returns co-billed
-- customers for an APPLICATOR on a split job — the same set the per-job
-- get_job_billed_customers returns — bypassing the customers RLS that hides them.
--
--   SETUP: two billing customers (A primary, B co-billed), one shared field split
--          A/B via job_field_shares, a job for that field assigned to an applicator.
--   P1  PER-JOB vs BATCH parity — as the applicator, get_jobs_billed_customers
--          ([v_job]) returns the SAME customer_id set as get_job_billed_customers
--          (v_job): exactly {A, B}, with is_primary=true on A.
--   P2  CO-BILLED visible — B (the co-billed split owner) is present in the batch
--          result for the applicator (the bug: the RLS embed dropped B).
--   P3  GRANTS — anon has NO EXECUTE; authenticated DOES (matches the per-job fn).
--   P4  DISPATCH VISIBILITY — a DIFFERENT applicator who is NOT the whole-job
--          applicator but IS dispatched to a location of the split job (visible via
--          jobs_select_location_dispatchee / _is_dispatched_to_me) STILL gets {A, B},
--          not a primary-only fallback (Codex re-review fix).
--
-- Ends in RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK'. Any other error = FAIL.
-- ============================================================================
DO $smoke$
DECLARE
  v_sfx     text := substr(gen_random_uuid()::text,1,8);
  v_admin   uuid;
  v_appl    uuid;
  v_appl2   uuid;  -- a per-location-dispatched applicator (NOT the whole-job applicator)
  v_cust_a  uuid;  -- primary
  v_cust_b  uuid;  -- co-billed
  v_field   uuid;
  v_job     uuid;
  v_jobfield uuid; -- the job_fields row id (dispatch references this)
  v_batch   uuid[];
  v_perjob  uuid[];
  v_disp    uuid[];
  v_has_b   boolean;
  v_prim_ct int;
  v_anon    boolean;
  v_auth    boolean;
BEGIN
  SELECT id INTO v_admin FROM profiles WHERE role='admin' AND is_active=true ORDER BY created_at LIMIT 1;
  SELECT id INTO v_appl  FROM profiles WHERE role='applicator' AND is_active=true ORDER BY created_at LIMIT 1;
  SELECT id INTO v_appl2 FROM profiles WHERE role='applicator' AND is_active=true AND id <> v_appl ORDER BY created_at LIMIT 1;
  IF v_admin IS NULL OR v_appl IS NULL OR v_appl2 IS NULL THEN RAISE EXCEPTION 'SMOKE_SETUP: need admin + 2 applicators'; END IF;

  -- ── SETUP (owner privileges) ──────────────────────────────────────────────
  INSERT INTO customers (farm_name) VALUES ('[SMOKE] JBC-A '||v_sfx) RETURNING id INTO v_cust_a;
  INSERT INTO customers (farm_name) VALUES ('[SMOKE] JBC-B '||v_sfx) RETURNING id INTO v_cust_b;
  INSERT INTO fields (field_name, customer_id) VALUES ('[SMOKE] JBC-Field '||v_sfx, v_cust_a) RETURNING id INTO v_field;

  -- Job for that field, assigned to the applicator, billed primary = A.
  INSERT INTO jobs (job_number, customer_id, job_date, status, applicator_id)
    VALUES ('[SMOKE] JBC-'||v_sfx, v_cust_a, CURRENT_DATE, 'in_progress', v_appl) RETURNING id INTO v_job;
  INSERT INTO job_fields (job_id, field_id) VALUES (v_job, v_field) RETURNING id INTO v_jobfield;

  -- Per-field SPLIT: A 40% (primary), B 60% (co-billed). This is what the RLS embed hides.
  INSERT INTO job_field_shares (job_id, field_id, customer_id, split_pct, is_primary)
    VALUES (v_job, v_field, v_cust_a, 40, true);
  INSERT INTO job_field_shares (job_id, field_id, customer_id, split_pct, is_primary)
    VALUES (v_job, v_field, v_cust_b, 60, false);

  -- Become the applicator (RLS enforced).
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_appl, 'role','authenticated')::text, true);
  SET LOCAL ROLE authenticated;

  -- ── P1: batch vs per-job parity (same customer_id set) ────────────────────
  SELECT array_agg(customer_id ORDER BY customer_id) INTO v_batch
    FROM get_jobs_billed_customers(ARRAY[v_job]);
  SELECT array_agg(customer_id ORDER BY customer_id) INTO v_perjob
    FROM get_job_billed_customers(v_job);

  RESET ROLE;

  IF v_batch IS NULL THEN RAISE EXCEPTION 'SMOKE_FAIL: batch returned no rows for the applicator'; END IF;
  IF v_batch <> v_perjob THEN
    RAISE EXCEPTION 'SMOKE_FAIL: batch set % != per-job set %', v_batch, v_perjob;
  END IF;

  -- Exactly {A, B}.
  IF array_length(v_batch,1) <> 2 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: expected 2 billed customers, got %', array_length(v_batch,1);
  END IF;
  IF NOT (v_cust_a = ANY(v_batch) AND v_cust_b = ANY(v_batch)) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: batch set missing A or B (%)', v_batch;
  END IF;

  -- ── P2: the co-billed B is present (the actual bug) ───────────────────────
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_appl, 'role','authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  SELECT bool_or(customer_id = v_cust_b) INTO v_has_b FROM get_jobs_billed_customers(ARRAY[v_job]);
  SELECT count(*) INTO v_prim_ct FROM get_jobs_billed_customers(ARRAY[v_job]) WHERE is_primary;
  RESET ROLE;

  IF NOT v_has_b THEN RAISE EXCEPTION 'SMOKE_FAIL: co-billed customer B NOT returned to the applicator'; END IF;
  IF v_prim_ct <> 1 THEN RAISE EXCEPTION 'SMOKE_FAIL: expected exactly 1 is_primary row, got %', v_prim_ct; END IF;

  -- ── P3: grants (anon revoked, authenticated granted) ──────────────────────
  SELECT has_function_privilege('anon',          'public.get_jobs_billed_customers(uuid[])', 'EXECUTE') INTO v_anon;
  SELECT has_function_privilege('authenticated', 'public.get_jobs_billed_customers(uuid[])', 'EXECUTE') INTO v_auth;
  IF v_anon THEN RAISE EXCEPTION 'SMOKE_FAIL: anon can EXECUTE get_jobs_billed_customers'; END IF;
  IF NOT v_auth THEN RAISE EXCEPTION 'SMOKE_FAIL: authenticated CANNOT EXECUTE get_jobs_billed_customers'; END IF;

  -- ── P4: per-location-dispatched applicator (NOT the whole-job applicator) ──
  -- Dispatch v_appl2 to the job's only location. v_appl2 is not jobs.applicator_id,
  -- so they see the job ONLY via jobs_select_location_dispatchee. The resolver must
  -- still return {A, B}, NOT a primary-only fallback.
  INSERT INTO job_location_dispatches (job_field_id, job_id, applicator_id, dispatch_status, dispatched_by)
    VALUES (v_jobfield, v_job, v_appl2, 'dispatched', v_admin)
    ON CONFLICT (job_field_id) DO UPDATE SET applicator_id = EXCLUDED.applicator_id;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_appl2, 'role','authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  SELECT array_agg(customer_id ORDER BY customer_id) INTO v_disp FROM get_jobs_billed_customers(ARRAY[v_job]);
  RESET ROLE;

  IF v_disp IS NULL THEN RAISE EXCEPTION 'SMOKE_FAIL: dispatched applicator got NO billed customers (primary-only fallback / hole)'; END IF;
  IF v_disp <> v_batch THEN
    RAISE EXCEPTION 'SMOKE_FAIL: dispatched applicator set % != whole-job set % (co-billed hidden via dispatch path)', v_disp, v_batch;
  END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END $smoke$;
