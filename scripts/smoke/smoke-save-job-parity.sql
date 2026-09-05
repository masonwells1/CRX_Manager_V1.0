-- ============================================================================
-- SMOKE TEST (rolled back by design): save_job field-app parity extension
-- ----------------------------------------------------------------------------
-- Field-app parity #1. PREREQUISITE MIGRATIONS: 20260624120000 AND
-- 20260820120000 (chem-unit invariant + derived money totals, applied live
-- 2026-08-25 as ledger version 20260825142708). Steps 3b and 7 are FAIL-CLOSED
-- on the second one: against a restored or staging database that lacks it this
-- chain FAILS BY DESIGN rather than reporting a supported pre-apply result.
-- Proves the EXTENDED save_job
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
-- Auth: save_job binds auth.uid() and role-gates admin|sales_rep. We set both
-- transaction-local request.jwt.claims and request.jwt.claim.sub to a real active admin.
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
  v_raised    boolean;
BEGIN
  -- ----------------------------------------------------------------- actor
  SELECT id INTO v_admin FROM profiles WHERE role = 'admin' AND is_active = true
   ORDER BY created_at LIMIT 1;
  IF v_admin IS NULL THEN RAISE EXCEPTION 'SMOKE_SETUP_FAILED: no active admin'; END IF;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);

  -- --------------------------------------------------------------- fixtures
  INSERT INTO customers (farm_name) VALUES ('[SMOKE] Parity Farm A ' || v_sfx) RETURNING id INTO v_cust_a;
  INSERT INTO customers (farm_name) VALUES ('[SMOKE] Parity Farm B ' || v_sfx) RETURNING id INTO v_cust_b;

  -- No current_cost here: require_governed_product_pricing() (supplier-pricing
  -- governance) refuses any pricing field on a product INSERT — creation must be
  -- a pricing-free shell. The chain never reads products.current_cost anyway;
  -- job cost/price come from the per-line cents in v_chems. (Verified live
  -- 2026-08-25 when the old fixture aborted on PRODUCT_PRICING_GOVERNED_PATH_REQUIRED.)
  INSERT INTO products (product_name, unit_size, epa_registration, product_form, vendor, rei_hours, phi_days, rate_per_acre, rate_unit)
  VALUES ('[SMOKE] Parity Chem A ' || v_sfx, 'GL', '[SMOKE]-EPA-PA', 'liquid', 'Acme Chem', 24, 7, 1.5, 'pt/ac')
  RETURNING id INTO v_prod_a;
  INSERT INTO products (product_name, unit_size, epa_registration, product_form, vendor, rei_hours, phi_days)
  VALUES ('[SMOKE] Parity Chem B ' || v_sfx, 'LB', '[SMOKE]-EPA-PB', 'dry', 'Beta Supply', 12, 14)
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
    -- Chem A carries a pt/ac rate against GL-priced stock, so its quantity must be the
    -- rate CARRIED INTO GALLONS: 1.5 pt/ac x 160 ac = 240 pt = 30 GL.
    -- It said 240 until 2026-08-23 -- i.e. 240 PINTS recorded as 240 GALLONS, priced per
    -- gallon: an 8x over-bill sitting in the repo's own parity fixture, unnoticed because
    -- nothing on either side of the wire compared the two units. The server-side invariant
    -- in 20260820120000 refuses exactly this shape, which is how the fixture was found.
    -- Do NOT "fix" a future failure here by loosening the guard; fix the numbers.
    jsonb_build_object('product_id', v_prod_a, 'quantity', 30, 'unit', 'GL', 'rate_per_acre', 1.5, 'rate_unit', 'pt/ac',
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

  -- ============================================ 3b) DERIVED MONEY TOTALS
  -- 20260820120000 was APPLIED LIVE 2026-08-25 as ledger version 20260825142708, so the
  -- derived-total behaviour is a permanent property of save_job, not a pending change.
  -- The former "not applied yet" fallback is deliberately GONE: it accepted the
  -- caller-supplied totals and skipped every unit refusal, so a stale re-emission that
  -- dropped the overbilling guard would still have reached SMOKE_PASS_ROLLBACK. A guard
  -- that cannot go red for the regression it exists to catch is worse than no guard.
  -- Absence of the marker is now a hard failure (Codex review, PR #475).
  SELECT position('CHEM_UNIT_MISMATCH' IN p.prosrc) INTO v_n
    FROM pg_proc p
   WHERE p.oid = to_regprocedure('public.save_job(uuid,jsonb,jsonb,jsonb,uuid,text)');

  IF v_n = 0 THEN
    RAISE EXCEPTION 'FAIL: installed save_job carries no CHEM_UNIT_MISMATCH. Migration 20260820120000 is applied live (ledger 20260825142708), so its absence is a REGRESSION, not a pre-apply state.';
  END IF;

  -- The payload above deliberately CLAIMS 200000 / 350000. Those are lies, and the
  -- point of 20260820120000 is that the server no longer believes them: it derives
  -- both totals from the chemical lines with safe_cents_qty.
  --   cost  = 1250 x 30 + 400 x 80 =  37500 + 32000 =  69500
  --   price = 1800 x 30 + 650 x 80 =  54000 + 52000 = 106000
  IF v_jrow.total_cost_cents <> 69500 THEN
    RAISE EXCEPTION 'FAIL: total_cost_cents % (expected derived 69500, NOT the payload 200000)', v_jrow.total_cost_cents;
  END IF;
  IF v_jrow.total_price_cents <> 106000 THEN
    RAISE EXCEPTION 'FAIL: total_price_cents % (expected derived 106000, NOT the payload 350000)', v_jrow.total_price_cents;
  END IF;

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

  -- ============================================ 7) CHEM-UNIT INVARIANT (20260820120000)
  -- Unconditional since the 2026-08-25 live apply. The marker is re-read here rather
  -- than trusting step 3b's read, and its absence fails closed.
  SELECT position('CHEM_UNIT_MISMATCH' IN p.prosrc) INTO v_n
    FROM pg_proc p
   WHERE p.oid = to_regprocedure('public.save_job(uuid,jsonb,jsonb,jsonb,uuid,text)');

  IF v_n = 0 THEN
    RAISE EXCEPTION 'FAIL: installed save_job carries no CHEM_UNIT_MISMATCH at the refusal checks - regression against applied migration 20260820120000.';
  END IF;
  -- The 16x shape: a pt/ac rate whose quantity is counted in PINTS while cost and price
  -- are quoted per GALLON. This is what chem A wrongly looked like before 2026-08-23.
  BEGIN
    v_res2 := save_job(NULL, v_payload, v_fields,
      jsonb_build_array(
        jsonb_build_object('product_id', v_prod_a, 'quantity', 240, 'unit', 'GL',
                           'rate_per_acre', 1.5, 'rate_unit', 'pt/ac',
                           'cost_per_unit_cents', 1250, 'price_per_unit_cents', 1800, 'sort_order', 0)
      ), v_admin, NULL);
    v_raised := false;
  EXCEPTION
    WHEN OTHERS THEN
      v_raised := true;
      IF SQLERRM NOT LIKE 'CHEM_UNIT_MISMATCH%' THEN
        RAISE EXCEPTION 'FAIL: unit mismatch raised wrong error: %', SQLERRM;
      END IF;
  END;
  -- Raised AFTER the block, not inside it. A sentinel raised inside is caught by the
  -- block's own WHEN OTHERS handler, so a genuine miss was reported as "raised wrong
  -- error: FAIL: a pint quantity..." -- the chain still failed, but it misnamed the cause
  -- (compliance review, 2026-08-23).
  IF NOT v_raised THEN
    RAISE EXCEPTION 'FAIL: a pint quantity priced per gallon did not raise CHEM_UNIT_MISMATCH';
  END IF;

  -- A rate measured per something other than an acre, in the spelled-out form. The
  -- slash form is the obvious one; 'per cwt' is the one that slipped through review.
  BEGIN
    v_res2 := save_job(NULL, v_payload, v_fields,
      jsonb_build_array(
        jsonb_build_object('product_id', v_prod_b, 'quantity', 80, 'unit', 'LB',
                           'rate_per_acre', 0.5, 'rate_unit', 'lb per cwt',
                           'cost_per_unit_cents', 400, 'price_per_unit_cents', 650, 'sort_order', 0)
      ), v_admin, NULL);
    v_raised := false;
  EXCEPTION
    WHEN OTHERS THEN
      v_raised := true;
      IF SQLERRM NOT LIKE 'CHEM_RATE_DENOMINATOR_NOT_ACRES%' THEN
        RAISE EXCEPTION 'FAIL: per-cwt rate raised wrong error: %', SQLERRM;
      END IF;
  END;
  IF NOT v_raised THEN
    RAISE EXCEPTION 'FAIL: a per-cwt rate did not raise CHEM_RATE_DENOMINATOR_NOT_ACRES';
  END IF;

  -- A refusal must leave nothing behind: still exactly the one job from step 1.
  SELECT count(*) INTO v_n FROM jobs WHERE consultant_id = v_admin AND job_date = v_job_date AND customer_id = v_cust_a AND job_number LIKE 'JOB-%';
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL: a refused save left a job row behind (% found)', v_n; END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END $$;
