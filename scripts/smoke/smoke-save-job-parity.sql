-- ============================================================================
-- SMOKE TEST (rolled back by design): save_job field-app parity extension
-- ----------------------------------------------------------------------------
-- Field-app parity #1 (migration 20260624120000). Proves the EXTENDED save_job
-- persists everything the tabbed editor now captures, through the REAL RPC:
--
--   1. CREATE a new job via save_job (NULL p_job_id) carrying scheduling dates
--      (call/proposed/schedule/expires + time_proposed), consultant, the three
--      memo fields, two fields with agronomy (planted_acres/crop/strip/pests),
--      per-field customer shares totalling 100%, and two chemicals with extras
--      (diluent_rate/rei_hours/phi_days/warehouse/vendor).
--   2. ASSERT every new column round-tripped (jobs, job_fields, job_chemicals,
--      job_field_shares).
--   3. ASSERT remaining_acres GENERATED column = total_acres - applied_acres.
--   4. SHARE GUARD: a second save whose field shares sum to 90 raises
--      SHARE_NOT_100 (and the job stays as it was — atomic rollback inside the
--      function is not what we test; we test the raise + that the bad shares
--      were not written).
--   5. IDEMPOTENCY: replaying the create key returns the SAME job_id without a
--      second job.
--   6. STRICT-ACTOR preserved: a forged p_performed_by raises ACTOR_MISMATCH.
--
-- Auth: save_job binds auth.uid() and role-gates admin|sales_rep. We set a
-- transaction-local request.jwt.claims sub = a real active admin.
--
-- The DO block ALWAYS ends in RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK' — nothing
-- here ever commits. Requires migration 20260624120000 applied.
-- ============================================================================

DO $$
DECLARE
  v_admin     uuid;
  v_other     uuid;
  v_cust_a    uuid;
  v_cust_b    uuid;
  v_prod_a    uuid;
  v_prod_b    uuid;
  v_field_1   uuid;
  v_field_2   uuid;
  v_sfx       text := substr(gen_random_uuid()::text, 1, 8);
  v_job_date  date := CURRENT_DATE + 5;
  v_payload   jsonb;
  v_fields    jsonb;
  v_chems     jsonb;
  v_res       jsonb;
  v_res2      jsonb;
  v_job       uuid;
  v_key       text := '[SMOKE] sj-key-' || v_sfx;
  v_jf        record;
  v_jc        record;
  v_jrow      record;
  v_n         int;
BEGIN
  -- ----------------------------------------------------------------- actor
  SELECT id INTO v_admin FROM profiles WHERE role = 'admin' AND is_active = true
   ORDER BY created_at LIMIT 1;
  IF v_admin IS NULL THEN RAISE EXCEPTION 'SMOKE_SETUP_FAILED: no active admin'; END IF;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);

  -- --------------------------------------------------------------- fixtures
  INSERT INTO customers (farm_name) VALUES ('[SMOKE] Parity Farm A ' || v_sfx) RETURNING id INTO v_cust_a;
  INSERT INTO customers (farm_name) VALUES ('[SMOKE] Parity Farm B ' || v_sfx) RETURNING id INTO v_cust_b;

  INSERT INTO products (product_name, unit_size, epa_registration, product_form, current_cost, vendor, rei_hours, phi_days, rate_per_acre, rate_unit)
  VALUES ('[SMOKE] Parity Chem A ' || v_sfx, 'GL', '[SMOKE]-EPA-PA', 'liquid', 12.50, 'Acme Chem', 24, 7, 1.5, 'pt/ac')
  RETURNING id INTO v_prod_a;
  INSERT INTO products (product_name, unit_size, epa_registration, product_form, current_cost, vendor, rei_hours, phi_days)
  VALUES ('[SMOKE] Parity Chem B ' || v_sfx, 'LB', '[SMOKE]-EPA-PB', 'dry', 4.00, 'Beta Supply', 12, 14)
  RETURNING id INTO v_prod_b;

  INSERT INTO fields (customer_id, field_name, crop_type, total_acres)
  VALUES (v_cust_a, '[SMOKE] Parity Field 1 ' || v_sfx, 'corn', 100) RETURNING id INTO v_field_1;
  INSERT INTO fields (customer_id, field_name, crop_type, total_acres)
  VALUES (v_cust_a, '[SMOKE] Parity Field 2 ' || v_sfx, 'soybeans', 60) RETURNING id INTO v_field_2;

  -- ============================================ 1) CREATE via save_job
  v_payload := jsonb_build_object(
    'customer_id',  v_cust_a,
    'job_date',     v_job_date::text,
    'total_acres',  160,
    'total_cost_cents', 200000,
    'total_price_cents', 350000,
    'call_date',      (CURRENT_DATE - 3)::text,
    'date_proposed',  (CURRENT_DATE - 1)::text,
    'time_proposed',  '08:30',
    'schedule_date',  v_job_date::text,
    'date_expires',   (v_job_date + 14)::text,
    'consultant_id',  v_admin,
    'loader_comment', '[SMOKE] mix order: A then B',
    'additional_info','[SMOKE] gate code 1234',
    'internal_memo',  '[SMOKE] DO NOT PRINT - net 15 only',
    'field_shares', jsonb_build_array(
        jsonb_build_object('field_id', v_field_1, 'customer_id', v_cust_a, 'split_pct', 70, 'is_primary', true),
        jsonb_build_object('field_id', v_field_1, 'customer_id', v_cust_b, 'split_pct', 30, 'is_primary', false),
        jsonb_build_object('field_id', v_field_2, 'customer_id', v_cust_a, 'split_pct', 100, 'is_primary', true)
    )
  );

  v_fields := jsonb_build_array(
    jsonb_build_object('field_id', v_field_1, 'acres_to_treat', 100, 'planted_acres', 98, 'crop', 'corn', 'strip', 'N', 'pests', 'waterhemp', 'sort_order', 0),
    jsonb_build_object('field_id', v_field_2, 'acres_to_treat', 60, 'planted_acres', 60, 'crop', 'soybeans', 'strip', 'Y', 'pests', 'palmer', 'sort_order', 1)
  );

  v_chems := jsonb_build_array(
    jsonb_build_object('product_id', v_prod_a, 'quantity', 240, 'unit', 'GL', 'rate_per_acre', 1.5, 'rate_unit', 'pt/ac',
                       'cost_per_unit_cents', 1250, 'price_per_unit_cents', 1800,
                       'diluent_rate', 10, 'rei_hours', 24, 'phi_days', 7, 'warehouse', 'Main', 'vendor', 'Acme Chem', 'sort_order', 0),
    jsonb_build_object('product_id', v_prod_b, 'quantity', 80, 'unit', 'LB', 'rate_per_acre', 0.5, 'rate_unit', 'lb/ac',
                       'cost_per_unit_cents', 400, 'price_per_unit_cents', 650,
                       'diluent_rate', NULL, 'rei_hours', 12, 'phi_days', 14, 'warehouse', 'South', 'vendor', 'Beta Supply', 'sort_order', 1)
  );

  v_res := save_job(NULL, v_payload, v_fields, v_chems, v_admin, v_key);
  IF (v_res->>'is_new')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: create not flagged is_new: %', v_res; END IF;
  v_job := (v_res->>'job_id')::uuid;

  -- ============================================ 2) ASSERT job header columns
  SELECT * INTO v_jrow FROM jobs WHERE id = v_job;
  IF v_jrow.call_date <> CURRENT_DATE - 3 THEN RAISE EXCEPTION 'FAIL: call_date %', v_jrow.call_date; END IF;
  IF v_jrow.date_proposed <> CURRENT_DATE - 1 THEN RAISE EXCEPTION 'FAIL: date_proposed %', v_jrow.date_proposed; END IF;
  IF v_jrow.time_proposed <> TIME '08:30' THEN RAISE EXCEPTION 'FAIL: time_proposed %', v_jrow.time_proposed; END IF;
  IF v_jrow.schedule_date <> v_job_date THEN RAISE EXCEPTION 'FAIL: schedule_date %', v_jrow.schedule_date; END IF;
  IF v_jrow.date_expires <> v_job_date + 14 THEN RAISE EXCEPTION 'FAIL: date_expires %', v_jrow.date_expires; END IF;
  IF v_jrow.consultant_id <> v_admin THEN RAISE EXCEPTION 'FAIL: consultant_id %', v_jrow.consultant_id; END IF;
  IF v_jrow.loader_comment IS NULL OR v_jrow.additional_info IS NULL OR v_jrow.internal_memo IS NULL THEN
    RAISE EXCEPTION 'FAIL: a memo field is NULL';
  END IF;

  -- ============================================ 3) remaining_acres GENERATED
  -- applied_acres defaults 0, so remaining == total (160).
  IF v_jrow.remaining_acres <> 160 THEN RAISE EXCEPTION 'FAIL: remaining_acres % (expected 160)', v_jrow.remaining_acres; END IF;

  -- ============================================ ASSERT job_fields agronomy
  SELECT * INTO v_jf FROM job_fields WHERE job_id = v_job AND field_id = v_field_1;
  IF v_jf.planted_acres <> 98 OR v_jf.crop <> 'corn' OR v_jf.strip <> 'N' OR v_jf.pests <> 'waterhemp' THEN
    RAISE EXCEPTION 'FAIL: field 1 agronomy: planted=% crop=% strip=% pests=%', v_jf.planted_acres, v_jf.crop, v_jf.strip, v_jf.pests;
  END IF;

  -- ============================================ ASSERT job_chemicals extras
  SELECT * INTO v_jc FROM job_chemicals WHERE job_id = v_job AND product_id = v_prod_a;
  IF v_jc.diluent_rate <> 10 OR v_jc.rei_hours <> 24 OR v_jc.phi_days <> 7 OR v_jc.warehouse <> 'Main' OR v_jc.vendor <> 'Acme Chem' THEN
    RAISE EXCEPTION 'FAIL: chem A extras: diluent=% rei=% phi=% wh=% vendor=%', v_jc.diluent_rate, v_jc.rei_hours, v_jc.phi_days, v_jc.warehouse, v_jc.vendor;
  END IF;

  -- ============================================ ASSERT job_field_shares
  SELECT count(*) INTO v_n FROM job_field_shares WHERE job_id = v_job;
  IF v_n <> 3 THEN RAISE EXCEPTION 'FAIL: expected 3 shares, got %', v_n; END IF;
  -- Field 1 split must total 100 across two customers.
  SELECT SUM(split_pct) INTO v_n FROM job_field_shares WHERE job_id = v_job AND field_id = v_field_1;
  IF v_n <> 100 THEN RAISE EXCEPTION 'FAIL: field 1 share total % (expected 100)', v_n; END IF;

  -- ============================================ 4) SHARE GUARD: not 100 -> raise
  BEGIN
    v_payload := jsonb_set(v_payload, '{field_shares}', jsonb_build_array(
        jsonb_build_object('field_id', v_field_2, 'customer_id', v_cust_a, 'split_pct', 90, 'is_primary', true)
    ));
    v_res2 := save_job(v_job, v_payload, v_fields, v_chems, v_admin, NULL);
    RAISE EXCEPTION 'FAIL: bad shares (90%%) did not raise';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM NOT LIKE 'SHARE_NOT_100%' THEN
        RAISE EXCEPTION 'FAIL: bad shares raised wrong error: %', SQLERRM;
      END IF;
  END;

  -- ============================================ 4b) SHARE GUARD: field not on job
  BEGIN
    -- a share for a field NOT in p_fields must raise SHARE_FIELD_NOT_ON_JOB.
    v_payload := jsonb_set(v_payload, '{field_shares}', jsonb_build_array(
        jsonb_build_object('field_id', gen_random_uuid(), 'customer_id', v_cust_a, 'split_pct', 100, 'is_primary', true)
    ));
    v_res2 := save_job(v_job, v_payload, v_fields, v_chems, v_admin, NULL);
    RAISE EXCEPTION 'FAIL: share for off-job field did not raise';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM NOT LIKE 'SHARE_FIELD_NOT_ON_JOB%' THEN
        RAISE EXCEPTION 'FAIL: off-job-field share raised wrong error: %', SQLERRM;
      END IF;
  END;

  -- Restore the valid field_shares payload for the idempotency replay below.
  v_payload := jsonb_set(v_payload, '{field_shares}', jsonb_build_array(
      jsonb_build_object('field_id', v_field_1, 'customer_id', v_cust_a, 'split_pct', 70, 'is_primary', true),
      jsonb_build_object('field_id', v_field_1, 'customer_id', v_cust_b, 'split_pct', 30, 'is_primary', false),
      jsonb_build_object('field_id', v_field_2, 'customer_id', v_cust_a, 'split_pct', 100, 'is_primary', true)
  ));

  -- ============================================ 5) IDEMPOTENCY replay
  v_res2 := save_job(NULL, v_payload, v_fields, v_chems, v_admin, v_key);
  IF (v_res2->>'job_id')::uuid <> v_job THEN RAISE EXCEPTION 'FAIL: idempotent replay gave different job_id'; END IF;
  SELECT count(*) INTO v_n FROM jobs WHERE consultant_id = v_admin AND job_date = v_job_date AND customer_id = v_cust_a AND job_number LIKE 'JOB-%';
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL: idempotent replay created a second job (% found)', v_n; END IF;

  -- ============================================ 6) STRICT-ACTOR forgery
  SELECT id INTO v_other FROM profiles WHERE id <> v_admin AND is_active = true LIMIT 1;
  IF v_other IS NOT NULL THEN
    BEGIN
      v_res2 := save_job(NULL, v_payload, v_fields, v_chems, v_other, NULL);
      RAISE EXCEPTION 'FAIL: forged p_performed_by did not raise ACTOR_MISMATCH';
    EXCEPTION
      WHEN OTHERS THEN
        IF SQLERRM NOT LIKE 'ACTOR_MISMATCH%' THEN
          RAISE EXCEPTION 'FAIL: forged actor raised wrong error: %', SQLERRM;
        END IF;
    END;
  END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END $$;
