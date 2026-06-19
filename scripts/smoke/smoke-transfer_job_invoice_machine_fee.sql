-- ============================================================================
-- SMOKE TEST (rolled back by design): transfer_job_to_invoice machine fee (G1)
-- + strict actor (G3) — migration 20260619140000.
-- ----------------------------------------------------------------------------
-- Run this AFTER applying 20260619140000 to confirm the live function. It
-- exercises the REAL applied transfer_job_to_invoice; pre-apply it will FAIL
-- (the current live body has no fee line) — that is expected.
--
-- Pre-apply validation (this session, 2026-06-19): the NEW function body was
-- stacked inside a single rolled-back transaction (CREATE OR REPLACE + this DO
-- block) via Supabase execute_sql and raised SMOKE_PASS_ROLLBACK — proving the
-- logic against the live schema with zero prod footprint.
--
-- What it proves:
--   G3  a forged p_performed_by (!= auth.uid()) -> ACTOR_MISMATCH and writes
--       NOTHING (no invoice, job stays 'completed'); honest admin -> success.
--   G1  a job with jobs.application_service_id gets ONE is_application_fee=true
--       line via compute_application_service_fee (default rate path), with a
--       CHECK-valid price_source ('tier' — chk_invoice_items_price_source only
--       allows quoted/tier/manual; the helper's `source` value would violate it).
--   Quantity model preserved: a FLAT / unrated chemical line still bills (it is
--       NOT dropped — the per-acre engine would drop it).
--   Reconciliation: invoice.total_amount_cents = SUM(line items) = SUM(shares),
--       in BOTH the single-customer fallback AND a penny-exact 2-grower split.
--
-- The DO block ALWAYS ends in RAISE EXCEPTION — on success 'SMOKE_PASS_ROLLBACK'
-- — so nothing here ever commits.
--
-- Calling context: simulate the authenticated admin via transaction-local
-- request.jwt.claims whose sub is a REAL active admin profile selected at runtime.
-- ============================================================================

DO $smoke$
DECLARE
  v_admin uuid;
  v_sfx text := substr(gen_random_uuid()::text,1,8);
  v_cust uuid; v_cust2 uuid;
  v_prodA uuid; v_prodB uuid;
  v_field uuid; v_field2 uuid;
  v_svc uuid;
  v_job uuid; v_job2 uuid;
  v_res jsonb; v_inv uuid; v_invR RECORD;
  v_n int; v_fee RECORD; v_share_sum bigint;
  v_items_sum bigint;
  v_forged uuid := gen_random_uuid();
BEGIN
  SELECT id INTO v_admin FROM profiles WHERE role='admin' AND is_active=true ORDER BY created_at LIMIT 1;
  IF v_admin IS NULL THEN RAISE EXCEPTION 'SMOKE_SETUP: no active admin'; END IF;

  INSERT INTO customers (farm_name) VALUES ('[SMOKE] FeeFarm '||v_sfx) RETURNING id INTO v_cust;
  INSERT INTO customers (farm_name) VALUES ('[SMOKE] FeeFarm2 '||v_sfx) RETURNING id INTO v_cust2;
  INSERT INTO products (product_name, unit_size, epa_registration, product_form)
    VALUES ('[SMOKE] Rated '||v_sfx,'GL','[SMOKE]-EPA-A','liquid') RETURNING id INTO v_prodA;
  INSERT INTO products (product_name, unit_size, epa_registration, product_form)
    VALUES ('[SMOKE] Flat '||v_sfx,'GL','[SMOKE]-EPA-B','liquid') RETURNING id INTO v_prodB;
  INSERT INTO fields (customer_id, field_name, crop_type) VALUES (v_cust,'[SMOKE] F1 '||v_sfx,'corn') RETURNING id INTO v_field;
  INSERT INTO fields (customer_id, field_name, crop_type) VALUES (v_cust,'[SMOKE] F2 '||v_sfx,'corn') RETURNING id INTO v_field2;
  INSERT INTO application_services (name, default_rate_per_acre_cents, cost_per_acre_cents, is_active, created_by)
    VALUES ('[SMOKE] Hagie '||v_sfx, 1300, 500, true, v_admin) RETURNING id INTO v_svc;

  -- Scenario A: single customer, rated + FLAT chem + per-acre fee
  INSERT INTO jobs (job_number, customer_id, status, job_date, season, application_service_id, total_price_cents, total_cost_cents, created_by)
    VALUES ('[SMOKE] JOBA-'||v_sfx, v_cust, 'scheduled', CURRENT_DATE-3, 2026, v_svc, 26998, 10888, v_admin) RETURNING id INTO v_job;
  INSERT INTO job_fields (job_id, field_id, acres_to_treat, sort_order) VALUES (v_job, v_field, 100, 1);
  INSERT INTO job_chemicals (job_id, product_id, quantity, unit, rate_per_acre, rate_unit, cost_per_unit_cents, price_per_unit_cents, sort_order)
    VALUES (v_job, v_prodA, 10, 'GL', 0.5, 'PT', 1000, 2500, 1);   -- price line 25000, cost 10000
  INSERT INTO job_chemicals (job_id, product_id, quantity, unit, rate_per_acre, rate_unit, cost_per_unit_cents, price_per_unit_cents, sort_order)
    VALUES (v_job, v_prodB, 2, 'GL', NULL, NULL, 444, 999, 2);     -- FLAT line 1998, cost 888
  UPDATE jobs SET status='in_progress' WHERE id=v_job;
  UPDATE jobs SET status='completed' WHERE id=v_job;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role','authenticated')::text, true);

  -- G3: forged actor BEFORE success -> ACTOR_MISMATCH, no write
  BEGIN
    PERFORM transfer_job_to_invoice(v_job, v_forged, NULL);
    RAISE EXCEPTION 'SMOKE_FAIL: forged actor was ALLOWED';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'ACTOR_MISMATCH%' THEN RAISE EXCEPTION 'SMOKE_FAIL: expected ACTOR_MISMATCH got %', SQLERRM; END IF;
  END;
  SELECT count(*) INTO v_n FROM invoices WHERE job_id=v_job;
  IF v_n<>0 THEN RAISE EXCEPTION 'SMOKE_FAIL: forged probe wrote an invoice'; END IF;
  PERFORM 1 FROM jobs WHERE id=v_job AND status='completed';
  IF NOT FOUND THEN RAISE EXCEPTION 'SMOKE_FAIL: forged probe changed job status'; END IF;

  -- G3 positive + G1 fee
  v_res := transfer_job_to_invoice(v_job, v_admin, '[SMOKE] feeA-'||v_sfx);
  IF COALESCE(v_res->>'success','')<>'true' THEN RAISE EXCEPTION 'SMOKE_FAIL: A success!=true %', v_res; END IF;
  v_inv := (v_res->>'invoice_id')::uuid;

  SELECT count(*) INTO v_n FROM invoice_items WHERE invoice_id=v_inv;
  IF v_n<>3 THEN RAISE EXCEPTION 'SMOKE_FAIL: A expected 3 items got %', v_n; END IF;
  PERFORM 1 FROM invoice_items WHERE invoice_id=v_inv AND product_id=v_prodB AND extended_cents=1998 AND is_application_fee=false;
  IF NOT FOUND THEN RAISE EXCEPTION 'SMOKE_FAIL: A flat (unrated) line missing/wrong'; END IF;
  SELECT count(*) INTO v_n FROM invoice_items WHERE invoice_id=v_inv AND is_application_fee=true;
  IF v_n<>1 THEN RAISE EXCEPTION 'SMOKE_FAIL: A expected 1 fee line got %', v_n; END IF;
  SELECT * INTO v_fee FROM invoice_items WHERE invoice_id=v_inv AND is_application_fee=true;
  IF v_fee.extended_cents<>130000 OR v_fee.rate_per_acre<>1300 OR v_fee.acres<>100 OR v_fee.cost_cents<>50000 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: A fee math ext=%/rate=%/acres=%/cost=%', v_fee.extended_cents, v_fee.rate_per_acre, v_fee.acres, v_fee.cost_cents; END IF;
  IF v_fee.price_source NOT IN ('quoted','tier','manual') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: A fee price_source % violates CHECK', v_fee.price_source; END IF;
  SELECT * INTO v_invR FROM invoices WHERE id=v_inv;
  IF v_invR.total_amount_cents<>156998 THEN RAISE EXCEPTION 'SMOKE_FAIL: A total_amount % (exp 156998)', v_invR.total_amount_cents; END IF;
  IF v_invR.total_cost_cents<>60888 THEN RAISE EXCEPTION 'SMOKE_FAIL: A total_cost % (exp 60888)', v_invR.total_cost_cents; END IF;
  SELECT COALESCE(SUM(amount_cents),0) INTO v_share_sum FROM invoice_shares WHERE invoice_id=v_inv;
  IF v_share_sum<>v_invR.total_amount_cents THEN RAISE EXCEPTION 'SMOKE_FAIL: A shares % != header %', v_share_sum, v_invR.total_amount_cents; END IF;
  SELECT COALESCE(SUM(extended_cents),0) INTO v_items_sum FROM invoice_items WHERE invoice_id=v_inv;
  IF v_items_sum<>v_invR.total_amount_cents THEN RAISE EXCEPTION 'SMOKE_FAIL: A items % != header %', v_items_sum, v_invR.total_amount_cents; END IF;

  -- Scenario B: 2-grower split (60/40 on 33 acres) -> penny-exact fee allocation
  INSERT INTO field_billing_defaults (field_id, customer_id, split_pct, is_primary) VALUES (v_field2, v_cust, 60, true);
  INSERT INTO field_billing_defaults (field_id, customer_id, split_pct, is_primary) VALUES (v_field2, v_cust2, 40, false);
  INSERT INTO jobs (job_number, customer_id, status, job_date, season, application_service_id, total_price_cents, total_cost_cents, created_by)
    VALUES ('[SMOKE] JOBB-'||v_sfx, v_cust, 'scheduled', CURRENT_DATE-3, 2026, v_svc, 10001, 0, v_admin) RETURNING id INTO v_job2;
  INSERT INTO job_fields (job_id, field_id, acres_to_treat, sort_order) VALUES (v_job2, v_field2, 33, 1);
  INSERT INTO job_chemicals (job_id, product_id, quantity, unit, rate_per_acre, rate_unit, cost_per_unit_cents, price_per_unit_cents, sort_order)
    VALUES (v_job2, v_prodA, 1, 'GL', NULL, NULL, 0, 10001, 1);
  UPDATE jobs SET status='in_progress' WHERE id=v_job2;
  UPDATE jobs SET status='completed' WHERE id=v_job2;
  v_res := transfer_job_to_invoice(v_job2, v_admin, '[SMOKE] feeB-'||v_sfx);
  v_inv := (v_res->>'invoice_id')::uuid;
  SELECT * INTO v_invR FROM invoices WHERE id=v_inv;
  SELECT count(*) INTO v_n FROM invoice_shares WHERE invoice_id=v_inv;
  IF v_n<>2 THEN RAISE EXCEPTION 'SMOKE_FAIL: B expected 2 shares got %', v_n; END IF;
  SELECT COALESCE(SUM(amount_cents),0) INTO v_share_sum FROM invoice_shares WHERE invoice_id=v_inv;
  IF v_share_sum<>v_invR.total_amount_cents THEN RAISE EXCEPTION 'SMOKE_FAIL: B shares % != header % (penny drift)', v_share_sum, v_invR.total_amount_cents; END IF;
  SELECT count(*) INTO v_n FROM invoice_items WHERE invoice_id=v_inv AND is_application_fee=true AND price_source IN ('quoted','tier','manual');
  IF v_n<>1 THEN RAISE EXCEPTION 'SMOKE_FAIL: B fee line missing/invalid price_source'; END IF;
  IF v_invR.total_amount_cents<>52901 THEN RAISE EXCEPTION 'SMOKE_FAIL: B total_amount % (exp 52901)', v_invR.total_amount_cents; END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END $smoke$;
