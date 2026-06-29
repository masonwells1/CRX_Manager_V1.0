-- ============================================================================
-- SMOKE TEST (rolled back by design): transfer_invoice_to_job (#27 reverse leg)
-- migration 20260625120000_transfer_invoice_to_job.sql.
-- ----------------------------------------------------------------------------
-- Run AFTER applying 20260625120000. Proves the inverse of transfer_job_to_invoice:
--
--   ROUND-TRIP   completed job -> transfer_job_to_invoice -> invoice (unposted),
--                job invoiced + invoice_id set + application_records linked + shares;
--                then transfer_invoice_to_job -> invoice cancelled, items+shares gone,
--                application_records.invoice_id cleared, job back to completed +
--                jobs.invoice_id NULL. Re-transfer works (job is reusable).
--   IDEMPOTENCY  calling transfer_invoice_to_job twice with the SAME key mutates
--                once (second call returns the saved result, no second teardown).
--   ACTOR        forged p_performed_by -> ACTOR_MISMATCH, writes nothing.
--   GUARD        a POSTED invoice cannot be reversed (honest error, no mutation).
--   GUARD        a non-job (engine-built) field invoice cannot be reversed.
--
-- Ends in RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK'.
-- ============================================================================
DO $smoke$
DECLARE
  v_admin uuid; v_sfx text := substr(gen_random_uuid()::text,1,8);
  v_cust uuid; v_cust2 uuid; v_prodA uuid; v_field uuid; v_field2 uuid;
  v_job uuid; v_res jsonb; v_inv uuid; v_invR RECORD; v_jobR RECORD;
  v_n int; v_forged uuid := gen_random_uuid();
  v_apprec uuid; v_inv2 uuid; v_posted_job uuid; v_posted_inv uuid;
  v_eng_inv uuid;
BEGIN
  SELECT id INTO v_admin FROM profiles WHERE role='admin' AND is_active=true ORDER BY created_at LIMIT 1;
  IF v_admin IS NULL THEN RAISE EXCEPTION 'SMOKE_SETUP: no admin'; END IF;
  INSERT INTO customers (farm_name) VALUES ('[SMOKE] RT A '||v_sfx) RETURNING id INTO v_cust;
  INSERT INTO customers (farm_name) VALUES ('[SMOKE] RT B '||v_sfx) RETURNING id INTO v_cust2;
  INSERT INTO products (product_name, unit_size, epa_registration, product_form) VALUES ('[SMOKE] RT Prod '||v_sfx,'GL','[SMOKE]-EPA-RT','liquid') RETURNING id INTO v_prodA;
  INSERT INTO fields (customer_id, field_name, crop_type) VALUES (v_cust,'[SMOKE] RT F1 '||v_sfx,'corn') RETURNING id INTO v_field;
  INSERT INTO fields (customer_id, field_name, crop_type) VALUES (v_cust,'[SMOKE] RT F2 '||v_sfx,'corn') RETURNING id INTO v_field2;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role','authenticated')::text, true);

  -- Build a completed, multi-customer (split via field_billing_defaults) job and transfer it.
  INSERT INTO field_billing_defaults (field_id, customer_id, split_pct, is_primary) VALUES (v_field, v_cust, 60, true);
  INSERT INTO field_billing_defaults (field_id, customer_id, split_pct, is_primary) VALUES (v_field, v_cust2, 40, false);
  INSERT INTO jobs (job_number, customer_id, status, job_date, season, total_price_cents, total_cost_cents, created_by)
    VALUES ('[SMOKE] RT JOB-'||v_sfx, v_cust, 'scheduled', CURRENT_DATE-3, 2026, 50000, 20000, v_admin) RETURNING id INTO v_job;
  INSERT INTO job_fields (job_id, field_id, acres_to_treat, sort_order) VALUES (v_job, v_field, 100, 1);
  INSERT INTO job_chemicals (job_id, product_id, quantity, unit, rate_per_acre, rate_unit, cost_per_unit_cents, price_per_unit_cents, sort_order)
    VALUES (v_job, v_prodA, 10, 'GL', 0.5, 'PT', 2000, 5000, 1);
  -- An as-applied legal record on the job (so the reverse must detach it).
  INSERT INTO application_records (record_number, source_type, source_id, customer_id, application_date, created_by)
    VALUES ('[SMOKE] REC-'||v_sfx, 'job', v_job, v_cust, CURRENT_DATE-1, v_admin) RETURNING id INTO v_apprec;
  UPDATE jobs SET status='in_progress' WHERE id=v_job; UPDATE jobs SET status='completed' WHERE id=v_job;

  v_res := transfer_job_to_invoice(v_job, v_admin, '[SMOKE] rt-fwd-'||v_sfx);
  v_inv := (v_res->>'invoice_id')::uuid;
  SELECT * INTO v_invR FROM invoices WHERE id=v_inv;
  SELECT * INTO v_jobR FROM jobs WHERE id=v_job;
  IF v_jobR.status<>'invoiced' OR v_jobR.invoice_id<>v_inv THEN RAISE EXCEPTION 'SMOKE_FAIL: fwd job not invoiced/linked (% / %)', v_jobR.status, v_jobR.invoice_id; END IF;
  SELECT count(*) INTO v_n FROM invoice_shares WHERE invoice_id=v_inv; IF v_n<>2 THEN RAISE EXCEPTION 'SMOKE_FAIL: expected 2 customer shares, got %', v_n; END IF;
  SELECT count(*) INTO v_n FROM invoice_items WHERE invoice_id=v_inv; IF v_n<1 THEN RAISE EXCEPTION 'SMOKE_FAIL: no invoice items after fwd'; END IF;
  SELECT invoice_id INTO v_inv2 FROM application_records WHERE id=v_apprec; IF v_inv2 IS DISTINCT FROM v_inv THEN RAISE EXCEPTION 'SMOKE_FAIL: app record not linked to invoice'; END IF;

  -- Forged actor must be rejected (no mutation).
  BEGIN
    PERFORM transfer_invoice_to_job(v_inv, v_forged, NULL);
    RAISE EXCEPTION 'SMOKE_FAIL: forged actor allowed';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'ACTOR_MISMATCH%' THEN RAISE EXCEPTION 'SMOKE_FAIL: expected ACTOR_MISMATCH got %', SQLERRM; END IF;
  END;
  -- ...and the invoice/job are untouched by the rejected call.
  SELECT status INTO v_invR.status FROM invoices WHERE id=v_inv;
  IF v_invR.status<>'unposted' THEN RAISE EXCEPTION 'SMOKE_FAIL: invoice changed by forged call'; END IF;

  -- The reverse (idempotency key X).
  v_res := transfer_invoice_to_job(v_inv, v_admin, '[SMOKE] rt-rev-'||v_sfx);
  IF (v_res->>'success')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'SMOKE_FAIL: reverse did not succeed'; END IF;
  SELECT * INTO v_invR FROM invoices WHERE id=v_inv;
  SELECT * INTO v_jobR FROM jobs WHERE id=v_job;
  IF v_invR.status<>'cancelled' THEN RAISE EXCEPTION 'SMOKE_FAIL: invoice not cancelled (%)', v_invR.status; END IF;
  IF v_invR.total_amount_cents<>0 THEN RAISE EXCEPTION 'SMOKE_FAIL: cancelled invoice total not zeroed (%)', v_invR.total_amount_cents; END IF;
  -- P3 remediation: the internal COGS header is zeroed too, so a cancelled, line-less
  -- invoice never keeps a stale forward cost total on its PDF.
  IF v_invR.total_cost_cents<>0 THEN RAISE EXCEPTION 'SMOKE_FAIL: cancelled invoice total_cost_cents not zeroed (%)', v_invR.total_cost_cents; END IF;
  IF v_jobR.status<>'completed' THEN RAISE EXCEPTION 'SMOKE_FAIL: job not returned to completed (%)', v_jobR.status; END IF;
  IF v_jobR.invoice_id IS NOT NULL THEN RAISE EXCEPTION 'SMOKE_FAIL: job.invoice_id not cleared'; END IF;
  SELECT count(*) INTO v_n FROM invoice_items WHERE invoice_id=v_inv; IF v_n<>0 THEN RAISE EXCEPTION 'SMOKE_FAIL: invoice_items not deleted (%)', v_n; END IF;
  SELECT count(*) INTO v_n FROM invoice_shares WHERE invoice_id=v_inv; IF v_n<>0 THEN RAISE EXCEPTION 'SMOKE_FAIL: invoice_shares not deleted (%)', v_n; END IF;
  SELECT invoice_id INTO v_inv2 FROM application_records WHERE id=v_apprec; IF v_inv2 IS NOT NULL THEN RAISE EXCEPTION 'SMOKE_FAIL: app record invoice_id not cleared'; END IF;
  -- An invoice_cancelled audit row exists for this invoice.
  PERFORM 1 FROM financial_audit_log WHERE entity_id=v_inv AND operation_type='invoice_cancelled';
  IF NOT FOUND THEN RAISE EXCEPTION 'SMOKE_FAIL: no invoice_cancelled audit row'; END IF;

  -- Idempotent replay: same key -> returns saved result, NO second mutation (the job is
  -- already 'completed' so a second real reverse would error; the saved result returns instead).
  v_res := transfer_invoice_to_job(v_inv, v_admin, '[SMOKE] rt-rev-'||v_sfx);
  IF (v_res->>'job_status')<>'completed' THEN RAISE EXCEPTION 'SMOKE_FAIL: idempotent replay wrong result'; END IF;
  SELECT count(*) INTO v_n FROM financial_audit_log WHERE entity_id=v_inv AND operation_type='invoice_cancelled';
  IF v_n<>1 THEN RAISE EXCEPTION 'SMOKE_FAIL: idempotent replay wrote a 2nd audit row (%)', v_n; END IF;

  -- The job is reusable: re-transfer the now-completed job to a NEW invoice.
  v_res := transfer_job_to_invoice(v_job, v_admin, '[SMOKE] rt-fwd2-'||v_sfx);
  v_inv2 := (v_res->>'invoice_id')::uuid;
  IF v_inv2 = v_inv THEN RAISE EXCEPTION 'SMOKE_FAIL: re-transfer reused cancelled invoice id'; END IF;
  SELECT status INTO v_jobR.status FROM jobs WHERE id=v_job;
  IF v_jobR.status<>'invoiced' THEN RAISE EXCEPTION 'SMOKE_FAIL: re-transfer did not re-invoice the job'; END IF;

  -- GUARD: a POSTED invoice cannot be reversed.
  -- Post the freshly re-transferred invoice, then attempt the reverse -> honest error.
  PERFORM post_invoice(v_inv2, '[SMOKE] rt-post-'||v_sfx);
  SELECT status INTO v_invR.status FROM invoices WHERE id=v_inv2;
  IF v_invR.status<>'posted' THEN RAISE EXCEPTION 'SMOKE_FAIL: post_invoice did not post (%)', v_invR.status; END IF;
  BEGIN
    PERFORM transfer_invoice_to_job(v_inv2, v_admin, NULL);
    RAISE EXCEPTION 'SMOKE_FAIL: reversed a POSTED invoice';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'Only a draft or unposted invoice%' THEN RAISE EXCEPTION 'SMOKE_FAIL: posted-guard wrong error: %', SQLERRM; END IF;
  END;

  -- GUARD: an engine-built field invoice (no job_id) cannot be reversed.
  INSERT INTO invoices (invoice_number, customer_id, invoice_type, status, invoice_date, total_amount_cents, created_by)
    VALUES ('[SMOKE] RT-ENG-'||v_sfx, v_cust, 'field_application', 'draft', CURRENT_DATE, 0, v_admin) RETURNING id INTO v_eng_inv;
  BEGIN
    PERFORM transfer_invoice_to_job(v_eng_inv, v_admin, NULL);
    RAISE EXCEPTION 'SMOKE_FAIL: reversed a non-job field invoice';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE '%not created from a job%' THEN RAISE EXCEPTION 'SMOKE_FAIL: no-job-guard wrong error: %', SQLERRM; END IF;
  END;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END $smoke$;
