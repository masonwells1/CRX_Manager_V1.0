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
--   Override-priced (all-inclusive $/acre) grower pays NO machine fee (Codex P1):
--        Scenario D — A on a field price_override -> no fee; only B's acres billed.
--   Reconciliation invoice.total_amount = SUM(items) = SUM(shares) in single,
--        same-rate-split, different-rate-split, and override-skip cases.
--   New system due-date provenance survives transfer's non-null +30 stamp;
--        posting overwrites it from Chicago date using Net 15 (single) and each
--        member's Net 15 / Net 45 customer terms (split group).
--   An ambiguous historical transfer-shaped +30 date marked legacy is preserved.
--
-- Ends in RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK'.
-- ============================================================================
DO $smoke$
DECLARE
  v_admin uuid; v_sfx text := substr(gen_random_uuid()::text,1,8);
  v_chicago_posting_date date := (now() AT TIME ZONE 'America/Chicago')::date;
  v_cust uuid; v_cust2 uuid; v_cust3 uuid; v_prodA uuid; v_prodB uuid;
  v_field uuid; v_field2 uuid; v_field3 uuid; v_field4 uuid; v_svc uuid;
  v_job uuid; v_job2 uuid; v_job3 uuid; v_job4 uuid;
  v_res jsonb; v_inv uuid; v_legacy_inv uuid; v_inv_ids uuid[]; v_group uuid; v_invR RECORD; v_n int; v_fee RECORD; v_share_sum bigint; v_items_sum bigint; v_a bigint; v_b bigint; v_forged uuid := gen_random_uuid();
BEGIN
  SELECT id INTO v_admin FROM profiles WHERE role='admin' AND is_active=true ORDER BY created_at LIMIT 1;
  IF v_admin IS NULL THEN RAISE EXCEPTION 'SMOKE_SETUP: no admin'; END IF;
  INSERT INTO customers (farm_name, payment_terms) VALUES ('[SMOKE] A '||v_sfx, 'Net 15') RETURNING id INTO v_cust;
  INSERT INTO customers (farm_name, payment_terms) VALUES ('[SMOKE] B '||v_sfx, 'Net 45') RETURNING id INTO v_cust2;
  INSERT INTO customers (farm_name, payment_terms) VALUES ('[SMOKE] C '||v_sfx, 'Net 60') RETURNING id INTO v_cust3;
  INSERT INTO products (product_name, unit_size, epa_registration, product_form) VALUES ('[SMOKE] Rated '||v_sfx,'GL','[SMOKE]-EPA-A','liquid') RETURNING id INTO v_prodA;
  INSERT INTO products (product_name, unit_size, epa_registration, product_form) VALUES ('[SMOKE] Flat '||v_sfx,'GL','[SMOKE]-EPA-B','liquid') RETURNING id INTO v_prodB;
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
  IF v_invR.due_date IS NULL OR v_invR.due_date_source IS DISTINCT FROM 'system' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: A transfer did not retain system provenance for its prefilled due date';
  END IF;
  PERFORM public.post_invoice(v_inv, '[SMOKE] feeA-post-'||v_sfx);
  IF (SELECT due_date FROM invoices WHERE id=v_inv) IS DISTINCT FROM v_chicago_posting_date + 15 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: A post did not replace transfer +30 with Chicago Net 15';
  END IF;

  -- A historical non-null value cannot be proven system-generated merely
  -- because it matches the old transfer +30 shape. Preserve it as legacy.
  INSERT INTO invoices (
    invoice_number, customer_id, invoice_type, status, invoice_date, due_date,
    due_date_source, payment_terms, total_amount_cents, created_by, job_id
  ) VALUES (
    '[SMOKE] LEGACY-DUE-'||v_sfx, v_cust, 'field_application', 'draft',
    CURRENT_DATE-3, CURRENT_DATE+27, 'legacy', 'Net 15', 0, v_admin, v_job
  ) RETURNING id INTO v_legacy_inv;
  PERFORM public.post_invoice(v_legacy_inv, '[SMOKE] legacy-due-post-'||v_sfx);
  IF (SELECT due_date FROM invoices WHERE id=v_legacy_inv) IS DISTINCT FROM CURRENT_DATE+27
     OR (SELECT due_date_source FROM invoices WHERE id=v_legacy_inv) IS DISTINCT FROM 'legacy' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: historical transfer-shaped legacy due date was replaced';
  END IF;

  -- B: split, same default rate (penny-exact)
  INSERT INTO field_billing_defaults (field_id, customer_id, split_pct, is_primary) VALUES (v_field2, v_cust, 60, true);
  INSERT INTO field_billing_defaults (field_id, customer_id, split_pct, is_primary) VALUES (v_field2, v_cust2, 40, false);
  INSERT INTO jobs (job_number, customer_id, status, job_date, season, application_service_id, total_price_cents, total_cost_cents, created_by) VALUES ('[SMOKE] JOBB-'||v_sfx, v_cust, 'scheduled', CURRENT_DATE-3, 2026, v_svc, 10001, 0, v_admin) RETURNING id INTO v_job2;
  INSERT INTO job_fields (job_id, field_id, acres_to_treat, sort_order) VALUES (v_job2, v_field2, 33, 1);
  INSERT INTO job_chemicals (job_id, product_id, quantity, unit, rate_per_acre, rate_unit, cost_per_unit_cents, price_per_unit_cents, sort_order) VALUES (v_job2, v_prodA, 1, 'GL', NULL, NULL, 0, 10001, 1);
  UPDATE jobs SET status='in_progress' WHERE id=v_job2; UPDATE jobs SET status='completed' WHERE id=v_job2;
  v_res := transfer_job_to_invoice(v_job2, v_admin, '[SMOKE] feeB-'||v_sfx); v_inv := (v_res->>'invoice_id')::uuid; v_group := (v_res->>'invoice_group_id')::uuid; v_inv_ids := ARRAY(SELECT (jsonb_array_elements_text(v_res->'invoice_ids'))::uuid); SELECT * INTO v_invR FROM invoices WHERE id=v_inv;
  IF EXISTS (SELECT 1 FROM invoices WHERE id=ANY(v_inv_ids) AND (due_date IS NULL OR due_date_source IS DISTINCT FROM 'system')) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: B transfer members did not retain system provenance for prefilled due dates';
  END IF;
  PERFORM public.post_invoice_group(v_group, v_admin, '[SMOKE] feeB-post-'||v_sfx);
  IF EXISTS (
    SELECT 1 FROM invoices
     WHERE id=ANY(v_inv_ids)
       AND due_date IS DISTINCT FROM (
         v_chicago_posting_date + CASE customer_id WHEN v_cust THEN 15 ELSE 45 END
       )
  ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: B group post did not replace transfer +30 with each customer term';
  END IF;
  SELECT count(*) INTO v_n FROM invoice_shares WHERE invoice_id=v_inv; IF v_n<>2 THEN RAISE EXCEPTION 'SMOKE_FAIL: B shares %', v_n; END IF;
  SELECT COALESCE(SUM(amount_cents),0) INTO v_share_sum FROM invoice_shares WHERE invoice_id=v_inv; IF v_share_sum<>v_invR.total_amount_cents OR v_invR.total_amount_cents<>52901 THEN RAISE EXCEPTION 'SMOKE_FAIL: B header % shares %', v_invR.total_amount_cents, v_share_sum; END IF;

  -- C: split, grower B on a customer override rate 2000 (per-customer rate)
  INSERT INTO customer_application_rates (customer_id, application_service_id, rate_per_acre_cents, season, created_by) VALUES (v_cust2, v_svc, 2000, 2026, v_admin);
  INSERT INTO field_billing_defaults (field_id, customer_id, split_pct, is_primary) VALUES (v_field3, v_cust, 60, true);
  INSERT INTO field_billing_defaults (field_id, customer_id, split_pct, is_primary) VALUES (v_field3, v_cust2, 40, false);
  INSERT INTO jobs (job_number, customer_id, status, job_date, season, application_service_id, total_price_cents, total_cost_cents, created_by) VALUES ('[SMOKE] JOBC-'||v_sfx, v_cust, 'scheduled', CURRENT_DATE-3, 2026, v_svc, 0, 0, v_admin) RETURNING id INTO v_job3;
  INSERT INTO job_fields (job_id, field_id, acres_to_treat, sort_order) VALUES (v_job3, v_field3, 50, 1);
  INSERT INTO job_chemicals (job_id, product_id, quantity, unit, rate_per_acre, rate_unit, cost_per_unit_cents, price_per_unit_cents, sort_order) VALUES (v_job3, v_prodA, 1, 'GL', NULL, NULL, 0, 0, 1);
  UPDATE jobs SET status='in_progress' WHERE id=v_job3; UPDATE jobs SET status='completed' WHERE id=v_job3;
  v_res := transfer_job_to_invoice(v_job3, v_admin, '[SMOKE] feeC-'||v_sfx); v_inv := (v_res->>'invoice_id')::uuid; SELECT * INTO v_invR FROM invoices WHERE id=v_inv;
  SELECT extended_cents INTO v_n FROM invoice_items WHERE invoice_id=v_inv AND is_application_fee=true; IF v_n<>79000 THEN RAISE EXCEPTION 'SMOKE_FAIL: C fee % (exp 79000)', v_n; END IF;
  SELECT amount_cents INTO v_a FROM invoice_shares WHERE invoice_id=v_inv AND customer_id=v_cust; SELECT amount_cents INTO v_b FROM invoice_shares WHERE invoice_id=v_inv AND customer_id=v_cust2;
  IF v_a<>39000 OR v_b<>40000 THEN RAISE EXCEPTION 'SMOKE_FAIL: C shares A=% B=%', v_a, v_b; END IF;
  SELECT COALESCE(SUM(amount_cents),0) INTO v_share_sum FROM invoice_shares WHERE invoice_id=v_inv; IF v_share_sum<>v_invR.total_amount_cents OR v_invR.total_amount_cents<>79000 THEN RAISE EXCEPTION 'SMOKE_FAIL: C header/shares'; END IF;

  -- D: grower A on a field price_override (all-in) gets NO machine fee; grower B does (Codex P1)
  INSERT INTO field_billing_defaults (field_id, customer_id, split_pct, is_primary, price_override_cents) VALUES (v_field4, v_cust, 60, true, 5000);
  INSERT INTO field_billing_defaults (field_id, customer_id, split_pct, is_primary) VALUES (v_field4, v_cust3, 40, false);
  INSERT INTO jobs (job_number, customer_id, status, job_date, season, application_service_id, total_price_cents, total_cost_cents, created_by) VALUES ('[SMOKE] JOBD-'||v_sfx, v_cust, 'scheduled', CURRENT_DATE-3, 2026, v_svc, 0, 0, v_admin) RETURNING id INTO v_job4;
  INSERT INTO job_fields (job_id, field_id, acres_to_treat, sort_order) VALUES (v_job4, v_field4, 50, 1);
  INSERT INTO job_chemicals (job_id, product_id, quantity, unit, rate_per_acre, rate_unit, cost_per_unit_cents, price_per_unit_cents, sort_order) VALUES (v_job4, v_prodA, 1, 'GL', NULL, NULL, 0, 0, 1);
  UPDATE jobs SET status='in_progress' WHERE id=v_job4; UPDATE jobs SET status='completed' WHERE id=v_job4;
  v_res := transfer_job_to_invoice(v_job4, v_admin, '[SMOKE] feeD-'||v_sfx); v_inv := (v_res->>'invoice_id')::uuid; SELECT * INTO v_invR FROM invoices WHERE id=v_inv;
  SELECT extended_cents INTO v_n FROM invoice_items WHERE invoice_id=v_inv AND is_application_fee=true; IF v_n<>26000 THEN RAISE EXCEPTION 'SMOKE_FAIL: D fee % (exp 26000 — override acres excluded)', v_n; END IF;
  SELECT acres INTO v_a FROM invoice_items WHERE invoice_id=v_inv AND is_application_fee=true; IF v_a<>20 THEN RAISE EXCEPTION 'SMOKE_FAIL: D fee acres % (exp 20)', v_a; END IF;
  SELECT amount_cents INTO v_a FROM invoice_shares WHERE invoice_id=v_inv AND customer_id=v_cust; SELECT amount_cents INTO v_b FROM invoice_shares WHERE invoice_id=v_inv AND customer_id=v_cust3;
  IF v_a<>150000 THEN RAISE EXCEPTION 'SMOKE_FAIL: D override grower share % (exp 150000, no fee)', v_a; END IF;
  IF v_b<>26000 THEN RAISE EXCEPTION 'SMOKE_FAIL: D fee grower share % (exp 26000)', v_b; END IF;
  SELECT COALESCE(SUM(amount_cents),0) INTO v_share_sum FROM invoice_shares WHERE invoice_id=v_inv; IF v_share_sum<>v_invR.total_amount_cents OR v_invR.total_amount_cents<>176000 THEN RAISE EXCEPTION 'SMOKE_FAIL: D header % shares %', v_invR.total_amount_cents, v_share_sum; END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END $smoke$;
