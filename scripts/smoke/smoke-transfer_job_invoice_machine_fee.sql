-- ============================================================================
-- SMOKE TEST (rolled back by design): transfer_job_to_invoice machine fee (G1)
-- + strict actor (G3) — migration 20260619140000.
-- ----------------------------------------------------------------------------
-- Run AFTER applying 20260619140000. Pre-apply it FAILS (live body has no fee).
-- Pre-apply validation (2026-06-19, incl. Codex P1/P2 fixes): the new body was
-- stacked in a single rolled-back transaction with this DO block -> SMOKE_PASS_ROLLBACK.
--
-- Proves:
--   G3   forged p_performed_by -> ACTOR_MISMATCH, writes nothing (Scenario A).
--   G1   a job with application_service_id gets ONE is_application_fee line
--        (price_source 'tier') + the service FK on the invoice (Scenario A).
--   Flat/unrated chemical line still bills (Scenario A).
--   Per-customer fee rate in a split job (grower override honored — Codex P1):
--        Scenario C — grower B @ a 2000 customer override, A @ 1300 default.
--   Multi-owner jobs now create one invoice per owner; each member has one 100%
--        invoice_share and the group remains penny-exact (Scenarios B/C).
--   Multi-owner field price overrides fail closed with no persisted invoice because
--        percentage-split billing cannot safely preserve an all-inclusive price (D).
--   Reconciliation invoice.total_amount = SUM(items) = SUM(shares) in single,
--        same-rate-split and different-rate-split cases.
--
-- Ends in RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK'.
-- ============================================================================
DO $smoke$
DECLARE
  v_admin uuid; v_sfx text := substr(gen_random_uuid()::text,1,8);
  v_cust uuid; v_cust2 uuid; v_cust3 uuid; v_prodA uuid; v_prodB uuid;
  v_field uuid; v_field2 uuid; v_field3 uuid; v_field4 uuid; v_svc uuid;
  v_job uuid; v_job2 uuid; v_job3 uuid; v_job4 uuid;
  v_res jsonb; v_inv uuid; v_invR RECORD; v_n int; v_fee RECORD; v_share_sum bigint; v_items_sum bigint; v_a bigint; v_b bigint; v_status text; v_forged uuid := gen_random_uuid();
BEGIN
  SELECT id INTO v_admin FROM profiles WHERE role='admin' AND is_active=true ORDER BY created_at LIMIT 1;
  IF v_admin IS NULL THEN RAISE EXCEPTION 'SMOKE_SETUP: no admin'; END IF;
  INSERT INTO customers (farm_name) VALUES ('[SMOKE] A '||v_sfx) RETURNING id INTO v_cust;
  INSERT INTO customers (farm_name) VALUES ('[SMOKE] B '||v_sfx) RETURNING id INTO v_cust2;
  INSERT INTO customers (farm_name) VALUES ('[SMOKE] C '||v_sfx) RETURNING id INTO v_cust3;
  -- Product creation is intentionally pricing-free, while the live below-cost
  -- wall requires a positive governed catalog basis before an invoice item can
  -- be materialized. Reuse two active catalog products whose locked cost bases
  -- are below the fixture prices; the enclosing DO block still rolls back every
  -- customer, field, job, invoice, and idempotency receipt it creates.
  SELECT p.id INTO v_prodA
  FROM products p
  WHERE p.is_active = true
    AND p.current_cost > 0
    -- Scenario C splits a $25 chemical line 60/40, so both owner members
    -- remain at or above this same governed $10-or-less unit cost.
    AND p.current_cost <= 10
  ORDER BY p.created_at, p.id
  LIMIT 1;
  SELECT p.id INTO v_prodB
  FROM products p
  WHERE p.is_active = true
    AND p.id <> v_prodA
    AND p.current_cost > 0
    AND p.current_cost <= 9.99
  ORDER BY p.created_at, p.id
  LIMIT 1;
  IF v_prodA IS NULL OR v_prodB IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: no governed products within fixture price ceilings';
  END IF;
  INSERT INTO fields (customer_id, field_name, crop_type) VALUES (v_cust,'[SMOKE] F1 '||v_sfx,'corn') RETURNING id INTO v_field;
  INSERT INTO fields (customer_id, field_name, crop_type) VALUES (v_cust,'[SMOKE] F2 '||v_sfx,'corn') RETURNING id INTO v_field2;
  INSERT INTO fields (customer_id, field_name, crop_type) VALUES (v_cust,'[SMOKE] F3 '||v_sfx,'corn') RETURNING id INTO v_field3;
  INSERT INTO fields (customer_id, field_name, crop_type) VALUES (v_cust,'[SMOKE] F4 '||v_sfx,'corn') RETURNING id INTO v_field4;
  INSERT INTO application_services (name, default_rate_per_acre_cents, cost_per_acre_cents, is_active, created_by) VALUES ('[SMOKE] Hagie '||v_sfx, 1300, 500, true, v_admin) RETURNING id INTO v_svc;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role','authenticated')::text, true);

  -- A: single customer + flat line + fee + service FK + forged-actor reject
  INSERT INTO jobs (job_number, customer_id, status, job_date, season, application_service_id, total_price_cents, total_cost_cents, created_by) VALUES ('[SMOKE] JOBA-'||v_sfx, v_cust, 'scheduled', CURRENT_DATE-3, 2026, v_svc, 26998, 10888, v_admin) RETURNING id INTO v_job;
  INSERT INTO job_fields (job_id, field_id, acres_to_treat, sort_order) VALUES (v_job, v_field, 100, 1);
  INSERT INTO job_chemicals (job_id, product_id, quantity, unit, rate_per_acre, rate_unit, cost_per_unit_cents, price_per_unit_cents, sort_order) VALUES (v_job, v_prodA, 10, 'GL', 0.5, 'PT', 1000, 2500, 1);
  INSERT INTO job_chemicals (job_id, product_id, quantity, unit, rate_per_acre, rate_unit, cost_per_unit_cents, price_per_unit_cents, sort_order) VALUES (v_job, v_prodB, 2, 'GL', NULL, NULL, 444, 999, 2);
  UPDATE jobs SET status='in_progress' WHERE id=v_job; UPDATE jobs SET status='completed' WHERE id=v_job;
  BEGIN PERFORM transfer_job_to_invoice(v_job, v_forged, NULL); RAISE EXCEPTION 'SMOKE_FAIL: forged actor allowed';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF; IF SQLERRM NOT LIKE 'ACTOR_MISMATCH%' THEN RAISE EXCEPTION 'SMOKE_FAIL: expected ACTOR_MISMATCH got %', SQLERRM; END IF; END;
  v_res := transfer_job_to_invoice(v_job, v_admin, '[SMOKE] feeA-'||v_sfx); v_inv := (v_res->>'invoice_id')::uuid; SELECT * INTO v_invR FROM invoices WHERE id=v_inv;
  IF v_invR.application_service_id IS DISTINCT FROM v_svc THEN RAISE EXCEPTION 'SMOKE_FAIL: A service FK not set'; END IF;
  SELECT count(*) INTO v_n FROM invoice_items WHERE invoice_id=v_inv; IF v_n<>3 THEN RAISE EXCEPTION 'SMOKE_FAIL: A items % (exp 3)', v_n; END IF;
  PERFORM 1 FROM invoice_items WHERE invoice_id=v_inv AND product_id=v_prodB AND extended_cents=1998 AND is_application_fee=false; IF NOT FOUND THEN RAISE EXCEPTION 'SMOKE_FAIL: A flat line missing'; END IF;
  SELECT * INTO v_fee FROM invoice_items WHERE invoice_id=v_inv AND is_application_fee=true; IF v_fee.extended_cents<>130000 OR v_fee.price_source NOT IN ('quoted','tier','manual') THEN RAISE EXCEPTION 'SMOKE_FAIL: A fee %/%', v_fee.extended_cents, v_fee.price_source; END IF;
  IF v_invR.total_amount_cents<>156998 OR v_invR.total_cost_cents<>60888 THEN RAISE EXCEPTION 'SMOKE_FAIL: A totals %/%', v_invR.total_amount_cents, v_invR.total_cost_cents; END IF;
  SELECT COALESCE(SUM(amount_cents),0) INTO v_share_sum FROM invoice_shares WHERE invoice_id=v_inv; IF v_share_sum<>v_invR.total_amount_cents THEN RAISE EXCEPTION 'SMOKE_FAIL: A shares!=header'; END IF;
  SELECT COALESCE(SUM(extended_cents),0) INTO v_items_sum FROM invoice_items WHERE invoice_id=v_inv; IF v_items_sum<>v_invR.total_amount_cents THEN RAISE EXCEPTION 'SMOKE_FAIL: A items!=header'; END IF;

  -- B: split, same default rate (penny-exact)
  INSERT INTO field_billing_defaults (field_id, customer_id, split_pct, is_primary) VALUES (v_field2, v_cust, 60, true);
  INSERT INTO field_billing_defaults (field_id, customer_id, split_pct, is_primary) VALUES (v_field2, v_cust2, 40, false);
  INSERT INTO jobs (job_number, customer_id, status, job_date, season, application_service_id, total_price_cents, total_cost_cents, created_by) VALUES ('[SMOKE] JOBB-'||v_sfx, v_cust, 'scheduled', CURRENT_DATE-3, 2026, v_svc, 10001, 0, v_admin) RETURNING id INTO v_job2;
  INSERT INTO job_fields (job_id, field_id, acres_to_treat, sort_order) VALUES (v_job2, v_field2, 33, 1);
  INSERT INTO job_chemicals (job_id, product_id, quantity, unit, rate_per_acre, rate_unit, cost_per_unit_cents, price_per_unit_cents, sort_order) VALUES (v_job2, v_prodA, 1, 'GL', NULL, NULL, 0, 10001, 1);
  UPDATE jobs SET status='in_progress' WHERE id=v_job2; UPDATE jobs SET status='completed' WHERE id=v_job2;
  v_res := transfer_job_to_invoice(v_job2, v_admin, '[SMOKE] feeB-'||v_sfx);
  IF COALESCE((v_res->>'split')::boolean, false) IS NOT TRUE OR (v_res->>'invoice_count')::int IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: B split result %', v_res;
  END IF;
  SELECT count(*) INTO v_n FROM invoices WHERE job_id=v_job2; IF v_n<>2 THEN RAISE EXCEPTION 'SMOKE_FAIL: B invoices %', v_n; END IF;
  SELECT count(*) INTO v_n FROM invoices WHERE job_id=v_job2 AND customer_id=v_cust; IF v_n<>1 THEN RAISE EXCEPTION 'SMOKE_FAIL: B customer A invoices %', v_n; END IF;
  SELECT count(*) INTO v_n FROM invoices WHERE job_id=v_job2 AND customer_id=v_cust2; IF v_n<>1 THEN RAISE EXCEPTION 'SMOKE_FAIL: B customer B invoices %', v_n; END IF;
  SELECT count(*) INTO v_n FROM invoice_shares s JOIN invoices i ON i.id=s.invoice_id WHERE i.job_id=v_job2; IF v_n<>2 THEN RAISE EXCEPTION 'SMOKE_FAIL: B shares %', v_n; END IF;
  IF EXISTS (
    SELECT 1
    FROM invoices i
    LEFT JOIN invoice_shares s ON s.invoice_id=i.id
    WHERE i.job_id=v_job2
    GROUP BY i.id, i.customer_id
    HAVING count(s.id)<>1
       OR bool_or(s.customer_id IS DISTINCT FROM i.customer_id OR s.split_percentage IS DISTINCT FROM 100)
  ) THEN RAISE EXCEPTION 'SMOKE_FAIL: B invoice/share owner mismatch'; END IF;
  SELECT COALESCE(SUM(total_amount_cents),0) INTO v_a FROM invoices WHERE job_id=v_job2;
  SELECT COALESCE(SUM(amount_cents),0) INTO v_share_sum FROM invoice_shares s JOIN invoices i ON i.id=s.invoice_id WHERE i.job_id=v_job2;
  SELECT COALESCE(SUM(extended_cents),0) INTO v_items_sum FROM invoice_items ii JOIN invoices i ON i.id=ii.invoice_id WHERE i.job_id=v_job2;
  IF v_a<>52901 OR v_share_sum<>v_a OR v_items_sum<>v_a THEN RAISE EXCEPTION 'SMOKE_FAIL: B headers % shares % items %', v_a, v_share_sum, v_items_sum; END IF;

  -- C: split, grower B on a customer override rate 2000 (per-customer rate)
  INSERT INTO customer_application_rates (customer_id, application_service_id, rate_per_acre_cents, season, created_by) VALUES (v_cust2, v_svc, 2000, 2026, v_admin);
  INSERT INTO field_billing_defaults (field_id, customer_id, split_pct, is_primary) VALUES (v_field3, v_cust, 60, true);
  INSERT INTO field_billing_defaults (field_id, customer_id, split_pct, is_primary) VALUES (v_field3, v_cust2, 40, false);
  INSERT INTO jobs (job_number, customer_id, status, job_date, season, application_service_id, total_price_cents, total_cost_cents, created_by) VALUES ('[SMOKE] JOBC-'||v_sfx, v_cust, 'scheduled', CURRENT_DATE-3, 2026, v_svc, 0, 0, v_admin) RETURNING id INTO v_job3;
  INSERT INTO job_fields (job_id, field_id, acres_to_treat, sort_order) VALUES (v_job3, v_field3, 50, 1);
  INSERT INTO job_chemicals (job_id, product_id, quantity, unit, rate_per_acre, rate_unit, cost_per_unit_cents, price_per_unit_cents, sort_order) VALUES (v_job3, v_prodA, 1, 'GL', NULL, NULL, 1000, 2500, 1);
  UPDATE jobs SET status='in_progress' WHERE id=v_job3; UPDATE jobs SET status='completed' WHERE id=v_job3;
  v_res := transfer_job_to_invoice(v_job3, v_admin, '[SMOKE] feeC-'||v_sfx);
  IF COALESCE((v_res->>'split')::boolean, false) IS NOT TRUE OR (v_res->>'invoice_count')::int IS DISTINCT FROM 2 THEN RAISE EXCEPTION 'SMOKE_FAIL: C split result %', v_res; END IF;
  SELECT count(*) INTO v_n FROM invoices WHERE job_id=v_job3; IF v_n<>2 THEN RAISE EXCEPTION 'SMOKE_FAIL: C invoices %', v_n; END IF;
  SELECT count(*) INTO v_n FROM invoices WHERE job_id=v_job3 AND customer_id=v_cust; IF v_n<>1 THEN RAISE EXCEPTION 'SMOKE_FAIL: C customer A invoices %', v_n; END IF;
  SELECT count(*) INTO v_n FROM invoices WHERE job_id=v_job3 AND customer_id=v_cust2; IF v_n<>1 THEN RAISE EXCEPTION 'SMOKE_FAIL: C customer B invoices %', v_n; END IF;
  IF EXISTS (
    SELECT 1
    FROM invoices i
    LEFT JOIN invoice_shares s ON s.invoice_id=i.id
    WHERE i.job_id=v_job3
    GROUP BY i.id, i.customer_id
    HAVING count(s.id)<>1
       OR bool_or(s.customer_id IS DISTINCT FROM i.customer_id OR s.split_percentage IS DISTINCT FROM 100)
  ) THEN RAISE EXCEPTION 'SMOKE_FAIL: C invoice/share owner mismatch'; END IF;
  SELECT COALESCE(SUM(ii.extended_cents),0) INTO v_n FROM invoice_items ii JOIN invoices i ON i.id=ii.invoice_id WHERE i.job_id=v_job3 AND ii.is_application_fee=true; IF v_n<>79000 THEN RAISE EXCEPTION 'SMOKE_FAIL: C fee % (exp 79000)', v_n; END IF;
  SELECT s.amount_cents INTO v_a FROM invoice_shares s JOIN invoices i ON i.id=s.invoice_id WHERE i.job_id=v_job3 AND s.customer_id=v_cust;
  SELECT s.amount_cents INTO v_b FROM invoice_shares s JOIN invoices i ON i.id=s.invoice_id WHERE i.job_id=v_job3 AND s.customer_id=v_cust2;
  IF v_a IS DISTINCT FROM 40500 OR v_b IS DISTINCT FROM 41000 THEN RAISE EXCEPTION 'SMOKE_FAIL: C shares A=% B=%', v_a, v_b; END IF;
  SELECT COALESCE(SUM(total_amount_cents),0) INTO v_a FROM invoices WHERE job_id=v_job3;
  SELECT COALESCE(SUM(amount_cents),0) INTO v_share_sum FROM invoice_shares s JOIN invoices i ON i.id=s.invoice_id WHERE i.job_id=v_job3;
  SELECT COALESCE(SUM(extended_cents),0) INTO v_items_sum FROM invoice_items ii JOIN invoices i ON i.id=ii.invoice_id WHERE i.job_id=v_job3;
  IF v_a<>81500 OR v_share_sum<>v_a OR v_items_sum<>v_a THEN RAISE EXCEPTION 'SMOKE_FAIL: C headers % shares % items %', v_a, v_share_sum, v_items_sum; END IF;

  -- D: multi-owner price overrides are unsupported and must leave no persisted invoice.
  INSERT INTO field_billing_defaults (field_id, customer_id, split_pct, is_primary, price_override_cents) VALUES (v_field4, v_cust, 60, true, 5000);
  INSERT INTO field_billing_defaults (field_id, customer_id, split_pct, is_primary) VALUES (v_field4, v_cust3, 40, false);
  INSERT INTO jobs (job_number, customer_id, status, job_date, season, application_service_id, total_price_cents, total_cost_cents, created_by) VALUES ('[SMOKE] JOBD-'||v_sfx, v_cust, 'scheduled', CURRENT_DATE-3, 2026, v_svc, 0, 0, v_admin) RETURNING id INTO v_job4;
  INSERT INTO job_fields (job_id, field_id, acres_to_treat, sort_order) VALUES (v_job4, v_field4, 50, 1);
  INSERT INTO job_chemicals (job_id, product_id, quantity, unit, rate_per_acre, rate_unit, cost_per_unit_cents, price_per_unit_cents, sort_order) VALUES (v_job4, v_prodA, 1, 'GL', NULL, NULL, 0, 0, 1);
  UPDATE jobs SET status='in_progress' WHERE id=v_job4; UPDATE jobs SET status='completed' WHERE id=v_job4;
  BEGIN
    PERFORM transfer_job_to_invoice(v_job4, v_admin, '[SMOKE] feeD-'||v_sfx);
    RAISE EXCEPTION 'SMOKE_FAIL: D accepted unsupported split override';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'SPLIT_OVERRIDE_UNSUPPORTED:%' THEN RAISE EXCEPTION 'SMOKE_FAIL: D expected SPLIT_OVERRIDE_UNSUPPORTED got %', SQLERRM; END IF;
  END;
  SELECT count(*) INTO v_n FROM invoices WHERE job_id=v_job4; IF v_n<>0 THEN RAISE EXCEPTION 'SMOKE_FAIL: D wrote % invoices', v_n; END IF;
  SELECT status INTO v_status FROM jobs WHERE id=v_job4; IF v_status IS DISTINCT FROM 'completed' THEN RAISE EXCEPTION 'SMOKE_FAIL: D job status %', v_status; END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END $smoke$;
