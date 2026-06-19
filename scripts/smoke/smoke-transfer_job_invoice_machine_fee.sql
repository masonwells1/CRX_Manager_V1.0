-- ============================================================================
-- SMOKE TEST (rolled back by design): transfer_job_to_invoice machine fee (G1)
-- + strict actor (G3) — migration 20260619140000.
-- ----------------------------------------------------------------------------
-- Run this AFTER applying 20260619140000 to confirm the live function. It
-- exercises the REAL applied transfer_job_to_invoice; pre-apply it will FAIL
-- (the current live body has no fee line) — that is expected.
--
-- Pre-apply validation (2026-06-19, incl. Codex P1/P2 fixes): the NEW function
-- body was stacked inside a single rolled-back transaction (CREATE OR REPLACE +
-- this DO block) via Supabase execute_sql and raised SMOKE_PASS_ROLLBACK.
--
-- What it proves:
--   G3  a forged p_performed_by (!= auth.uid()) -> ACTOR_MISMATCH, writes NOTHING.
--   G1  a job with jobs.application_service_id gets ONE is_application_fee=true
--       line, with a CHECK-valid price_source ('tier').
--   P2 (Codex)  the invoice carries jobs.application_service_id (service FK set).
--   P1 (Codex)  in a SPLIT job, EACH billed customer is charged at THAT customer's
--       own rate (customer_application_rates override -> service default) — NOT a
--       single job-customer rate spread across growers.
--   Quantity model preserved: a FLAT / unrated chemical line still bills.
--   Reconciliation: invoice.total_amount_cents = SUM(items) = SUM(shares), in
--       single-customer, same-rate split, AND different-rate split cases.
--
-- The DO block ALWAYS ends in RAISE EXCEPTION — on success 'SMOKE_PASS_ROLLBACK'.
-- ============================================================================
DO $smoke$
DECLARE
  v_admin uuid; v_sfx text := substr(gen_random_uuid()::text,1,8);
  v_cust uuid; v_cust2 uuid; v_prodA uuid; v_prodB uuid;
  v_field uuid; v_field2 uuid; v_field3 uuid; v_svc uuid;
  v_job uuid; v_job2 uuid; v_job3 uuid;
  v_res jsonb; v_inv uuid; v_invR RECORD; v_n int; v_fee RECORD;
  v_share_sum bigint; v_items_sum bigint; v_feeA bigint; v_feeB bigint;
  v_forged uuid := gen_random_uuid();
BEGIN
  SELECT id INTO v_admin FROM profiles WHERE role='admin' AND is_active=true ORDER BY created_at LIMIT 1;
  IF v_admin IS NULL THEN RAISE EXCEPTION 'SMOKE_SETUP: no admin'; END IF;
  INSERT INTO customers (farm_name) VALUES ('[SMOKE] FeeFarm '||v_sfx) RETURNING id INTO v_cust;
  INSERT INTO customers (farm_name) VALUES ('[SMOKE] FeeFarm2 '||v_sfx) RETURNING id INTO v_cust2;
  INSERT INTO products (product_name, unit_size, epa_registration, product_form) VALUES ('[SMOKE] Rated '||v_sfx,'GL','[SMOKE]-EPA-A','liquid') RETURNING id INTO v_prodA;
  INSERT INTO products (product_name, unit_size, epa_registration, product_form) VALUES ('[SMOKE] Flat '||v_sfx,'GL','[SMOKE]-EPA-B','liquid') RETURNING id INTO v_prodB;
  INSERT INTO fields (customer_id, field_name, crop_type) VALUES (v_cust,'[SMOKE] F1 '||v_sfx,'corn') RETURNING id INTO v_field;
  INSERT INTO fields (customer_id, field_name, crop_type) VALUES (v_cust,'[SMOKE] F2 '||v_sfx,'corn') RETURNING id INTO v_field2;
  INSERT INTO fields (customer_id, field_name, crop_type) VALUES (v_cust,'[SMOKE] F3 '||v_sfx,'corn') RETURNING id INTO v_field3;
  INSERT INTO application_services (name, default_rate_per_acre_cents, cost_per_acre_cents, is_active, created_by) VALUES ('[SMOKE] Hagie '||v_sfx, 1300, 500, true, v_admin) RETURNING id INTO v_svc;

  -- A: single customer + flat line + fee + P2 service FK
  INSERT INTO jobs (job_number, customer_id, status, job_date, season, application_service_id, total_price_cents, total_cost_cents, created_by)
    VALUES ('[SMOKE] JOBA-'||v_sfx, v_cust, 'scheduled', CURRENT_DATE-3, 2026, v_svc, 26998, 10888, v_admin) RETURNING id INTO v_job;
  INSERT INTO job_fields (job_id, field_id, acres_to_treat, sort_order) VALUES (v_job, v_field, 100, 1);
  INSERT INTO job_chemicals (job_id, product_id, quantity, unit, rate_per_acre, rate_unit, cost_per_unit_cents, price_per_unit_cents, sort_order) VALUES (v_job, v_prodA, 10, 'GL', 0.5, 'PT', 1000, 2500, 1);
  INSERT INTO job_chemicals (job_id, product_id, quantity, unit, rate_per_acre, rate_unit, cost_per_unit_cents, price_per_unit_cents, sort_order) VALUES (v_job, v_prodB, 2, 'GL', NULL, NULL, 444, 999, 2);
  UPDATE jobs SET status='in_progress' WHERE id=v_job; UPDATE jobs SET status='completed' WHERE id=v_job;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role','authenticated')::text, true);
  BEGIN
    PERFORM transfer_job_to_invoice(v_job, v_forged, NULL);
    RAISE EXCEPTION 'SMOKE_FAIL: forged actor allowed';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'ACTOR_MISMATCH%' THEN RAISE EXCEPTION 'SMOKE_FAIL: expected ACTOR_MISMATCH got %', SQLERRM; END IF;
  END;
  v_res := transfer_job_to_invoice(v_job, v_admin, '[SMOKE] feeA-'||v_sfx);
  v_inv := (v_res->>'invoice_id')::uuid; SELECT * INTO v_invR FROM invoices WHERE id=v_inv;
  IF v_invR.application_service_id IS DISTINCT FROM v_svc THEN RAISE EXCEPTION 'SMOKE_FAIL: A service FK not set (P2)'; END IF;
  SELECT count(*) INTO v_n FROM invoice_items WHERE invoice_id=v_inv;
  IF v_n<>3 THEN RAISE EXCEPTION 'SMOKE_FAIL: A items % (exp 3)', v_n; END IF;
  PERFORM 1 FROM invoice_items WHERE invoice_id=v_inv AND product_id=v_prodB AND extended_cents=1998 AND is_application_fee=false;
  IF NOT FOUND THEN RAISE EXCEPTION 'SMOKE_FAIL: A flat line missing'; END IF;
  SELECT * INTO v_fee FROM invoice_items WHERE invoice_id=v_inv AND is_application_fee=true;
  IF v_fee.extended_cents<>130000 OR v_fee.price_source NOT IN ('quoted','tier','manual') THEN RAISE EXCEPTION 'SMOKE_FAIL: A fee ext=% src=%', v_fee.extended_cents, v_fee.price_source; END IF;
  IF v_invR.total_amount_cents<>156998 OR v_invR.total_cost_cents<>60888 THEN RAISE EXCEPTION 'SMOKE_FAIL: A totals %/%', v_invR.total_amount_cents, v_invR.total_cost_cents; END IF;
  SELECT COALESCE(SUM(amount_cents),0) INTO v_share_sum FROM invoice_shares WHERE invoice_id=v_inv;
  IF v_share_sum<>v_invR.total_amount_cents THEN RAISE EXCEPTION 'SMOKE_FAIL: A shares!=header'; END IF;
  SELECT COALESCE(SUM(extended_cents),0) INTO v_items_sum FROM invoice_items WHERE invoice_id=v_inv;
  IF v_items_sum<>v_invR.total_amount_cents THEN RAISE EXCEPTION 'SMOKE_FAIL: A items!=header'; END IF;

  -- B: split, SAME default rate (penny-exact)
  INSERT INTO field_billing_defaults (field_id, customer_id, split_pct, is_primary) VALUES (v_field2, v_cust, 60, true);
  INSERT INTO field_billing_defaults (field_id, customer_id, split_pct, is_primary) VALUES (v_field2, v_cust2, 40, false);
  INSERT INTO jobs (job_number, customer_id, status, job_date, season, application_service_id, total_price_cents, total_cost_cents, created_by)
    VALUES ('[SMOKE] JOBB-'||v_sfx, v_cust, 'scheduled', CURRENT_DATE-3, 2026, v_svc, 10001, 0, v_admin) RETURNING id INTO v_job2;
  INSERT INTO job_fields (job_id, field_id, acres_to_treat, sort_order) VALUES (v_job2, v_field2, 33, 1);
  INSERT INTO job_chemicals (job_id, product_id, quantity, unit, rate_per_acre, rate_unit, cost_per_unit_cents, price_per_unit_cents, sort_order) VALUES (v_job2, v_prodA, 1, 'GL', NULL, NULL, 0, 10001, 1);
  UPDATE jobs SET status='in_progress' WHERE id=v_job2; UPDATE jobs SET status='completed' WHERE id=v_job2;
  v_res := transfer_job_to_invoice(v_job2, v_admin, '[SMOKE] feeB-'||v_sfx);
  v_inv := (v_res->>'invoice_id')::uuid; SELECT * INTO v_invR FROM invoices WHERE id=v_inv;
  SELECT count(*) INTO v_n FROM invoice_shares WHERE invoice_id=v_inv;
  IF v_n<>2 THEN RAISE EXCEPTION 'SMOKE_FAIL: B shares % (exp 2)', v_n; END IF;
  SELECT COALESCE(SUM(amount_cents),0) INTO v_share_sum FROM invoice_shares WHERE invoice_id=v_inv;
  IF v_share_sum<>v_invR.total_amount_cents THEN RAISE EXCEPTION 'SMOKE_FAIL: B shares!=header'; END IF;
  IF v_invR.total_amount_cents<>52901 THEN RAISE EXCEPTION 'SMOKE_FAIL: B total % (exp 52901)', v_invR.total_amount_cents; END IF;

  -- C: split with grower B on a DIFFERENT override rate (Codex P1 proof)
  INSERT INTO customer_application_rates (customer_id, application_service_id, rate_per_acre_cents, season, created_by) VALUES (v_cust2, v_svc, 2000, 2026, v_admin);
  INSERT INTO field_billing_defaults (field_id, customer_id, split_pct, is_primary) VALUES (v_field3, v_cust, 60, true);
  INSERT INTO field_billing_defaults (field_id, customer_id, split_pct, is_primary) VALUES (v_field3, v_cust2, 40, false);
  INSERT INTO jobs (job_number, customer_id, status, job_date, season, application_service_id, total_price_cents, total_cost_cents, created_by)
    VALUES ('[SMOKE] JOBC-'||v_sfx, v_cust, 'scheduled', CURRENT_DATE-3, 2026, v_svc, 0, 0, v_admin) RETURNING id INTO v_job3;
  INSERT INTO job_fields (job_id, field_id, acres_to_treat, sort_order) VALUES (v_job3, v_field3, 50, 1);
  INSERT INTO job_chemicals (job_id, product_id, quantity, unit, rate_per_acre, rate_unit, cost_per_unit_cents, price_per_unit_cents, sort_order) VALUES (v_job3, v_prodA, 1, 'GL', NULL, NULL, 0, 0, 1);
  UPDATE jobs SET status='in_progress' WHERE id=v_job3; UPDATE jobs SET status='completed' WHERE id=v_job3;
  v_res := transfer_job_to_invoice(v_job3, v_admin, '[SMOKE] feeC-'||v_sfx);
  v_inv := (v_res->>'invoice_id')::uuid; SELECT * INTO v_invR FROM invoices WHERE id=v_inv;
  SELECT extended_cents INTO v_n FROM invoice_items WHERE invoice_id=v_inv AND is_application_fee=true;
  IF v_n<>79000 THEN RAISE EXCEPTION 'SMOKE_FAIL: C fee total % (exp 79000 per-customer rate; old single-rate code would give 65000)', v_n; END IF;
  SELECT amount_cents INTO v_feeA FROM invoice_shares WHERE invoice_id=v_inv AND customer_id=v_cust;
  SELECT amount_cents INTO v_feeB FROM invoice_shares WHERE invoice_id=v_inv AND customer_id=v_cust2;
  IF v_feeA<>39000 THEN RAISE EXCEPTION 'SMOKE_FAIL: C grower A share % (exp 39000 @ default 1300)', v_feeA; END IF;
  IF v_feeB<>40000 THEN RAISE EXCEPTION 'SMOKE_FAIL: C grower B share % (exp 40000 @ override 2000)', v_feeB; END IF;
  SELECT COALESCE(SUM(amount_cents),0) INTO v_share_sum FROM invoice_shares WHERE invoice_id=v_inv;
  IF v_share_sum<>v_invR.total_amount_cents OR v_invR.total_amount_cents<>79000 THEN RAISE EXCEPTION 'SMOKE_FAIL: C header/shares % / %', v_invR.total_amount_cents, v_share_sum; END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END $smoke$;
