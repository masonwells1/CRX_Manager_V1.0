-- ============================================================================
-- SMOKE TEST (rolled back by design): As-Applied / Field-Invoice FULL LOOP
-- ----------------------------------------------------------------------------
-- Phase 1b of the As-Applied build (docs/plans/2026-06-18-as-applied-
-- application-invoices-plan.md). Proves the applied->invoice loop runs
-- END-TO-END through the REAL RPCs (not direct status UPDATEs), which had
-- never run together against live before:
--
--   schedule (insert job) -> start_job -> complete_job (writes the
--   application_record + weather + inventory) -> transfer_job_to_invoice
--   (unposted field invoice, links application_records.invoice_id, job->
--   invoiced) -> EDIT the unposted invoice (operator reconciles actual) ->
--   post_invoice -> void_invoice.
--
-- This differs from smoke-transfer_job_invoice_column_fixes.sql, which proves
-- only the transfer step and uses direct `UPDATE jobs SET status` to reach
-- 'completed' — it never exercises start_job/complete_job (so it never proves
-- the application_record/weather write) nor post_invoice/void_invoice.
--
-- REQUIRES migration 20260618220000 applied. Against the PRE-fix live function,
-- transfer_job_to_invoice crashes with 55000 "record v_conversion not assigned
-- yet" on the unrated Chem B line — that crash IS the bug this chain guards. The
-- parked-migration proof (the fix stacked in a rolled-back tx) passed
-- SMOKE_PASS_ROLLBACK; this file is the post-apply regression gate.
--
-- The DO block ALWAYS ends in RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK' — nothing
-- here ever commits.
--
-- Auth: every RPC is strict-actor (start_job/complete_job bind auth.uid() and
-- reject a mismatched p_performed_by; transfer/post/void role-gate on
-- auth.uid()). We set a transaction-local request.jwt.claims whose sub is a
-- REAL active admin profile id selected at runtime.
--
-- Live-catalog verified 2026-06-18 (project rhyzpcqhnizqbxphqdkr):
--   invoices.pricing_pending default false; check_period_open(CURRENT_DATE) ok;
--   next_application_record_number() exists; jobs has application_service_id,
--   job_date (NOT scheduled_date); product_form CHECK liquid|dry.
-- ============================================================================

DO $$
DECLARE
  v_admin     uuid;
  v_customer  uuid;
  v_prod_a    uuid;
  v_prod_b    uuid;
  v_field     uuid;
  v_job       uuid;
  v_sfx       text := substr(gen_random_uuid()::text, 1, 8);
  v_job_date  date := CURRENT_DATE - 2;
  v_applied   jsonb;
  v_res       jsonb;
  v_res2      jsonb;
  v_invoice   uuid;
  v_rec       uuid;
  v_inv       record;
  v_ai        record;
  v_ar        record;
  v_n         int;
  v_rc        int;
BEGIN
  -- ----------------------------------------------------------------- actor
  SELECT id INTO v_admin FROM profiles WHERE role = 'admin' AND is_active = true
   ORDER BY created_at LIMIT 1;
  IF v_admin IS NULL THEN RAISE EXCEPTION 'SMOKE_SETUP_FAILED: no active admin'; END IF;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);

  -- --------------------------------------------------------------- fixtures
  INSERT INTO customers (farm_name) VALUES ('[SMOKE] Field-Loop Farm ' || v_sfx)
  RETURNING id INTO v_customer;

  INSERT INTO products (product_name, unit_size, epa_registration, product_form)
  VALUES ('[SMOKE] Loop Chem A ' || v_sfx, 'GL', '[SMOKE]-EPA-LA', 'liquid')
  RETURNING id INTO v_prod_a;

  INSERT INTO products (product_name, unit_size, epa_registration, product_form)
  VALUES ('[SMOKE] Loop Chem B ' || v_sfx, 'GL', '[SMOKE]-EPA-LB', 'liquid')
  RETURNING id INTO v_prod_b;

  INSERT INTO fields (customer_id, field_name, crop_type, total_acres)
  VALUES (v_customer, '[SMOKE] Loop Field ' || v_sfx, 'soybeans', 120)
  RETURNING id INTO v_field;

  -- Job priced: A 10 x 2500c = 25000 price / 1000c = 10000 cost;
  --             B  5 x 2000c = 10000 price /  800c =  4000 cost.
  -- job total_price 35000, total_cost 14000.
  INSERT INTO jobs (job_number, customer_id, status, job_date, season,
                    total_acres, total_price_cents, total_cost_cents, created_by)
  VALUES ('[SMOKE] JOBL-' || v_sfx, v_customer, 'scheduled', v_job_date,
          extract(year FROM CURRENT_DATE)::int, 120, 35000, 14000, v_admin)
  RETURNING id INTO v_job;

  INSERT INTO job_fields (job_id, field_id, acres_to_treat, sort_order)
  VALUES (v_job, v_field, 120, 1);

  INSERT INTO job_chemicals (job_id, product_id, quantity, unit, rate_per_acre,
                             rate_unit, cost_per_unit_cents, price_per_unit_cents, sort_order)
  VALUES (v_job, v_prod_a, 10, 'GL', 1.0, 'PT', 1000, 2500, 1),
         (v_job, v_prod_b,  5, 'GL', NULL, NULL,  800, 2000, 2);

  -- =================================================== 1) start_job
  v_res := start_job(v_job, v_admin, '[SMOKE] sj-' || v_sfx);
  IF v_res->>'status' <> 'in_progress' THEN
    RAISE EXCEPTION 'FAIL start_job: status %', v_res;
  END IF;
  PERFORM 1 FROM jobs WHERE id = v_job AND status = 'in_progress';
  IF NOT FOUND THEN RAISE EXCEPTION 'FAIL: job not in_progress after start_job'; END IF;

  -- =================================================== 2) complete_job
  v_applied := jsonb_build_object(
    'actual_start_time', (now() - interval '3 hours')::text,
    'actual_end_time',   now()::text,
    'wind_speed',        12.5,
    'wind_direction',    'NW',
    'temperature',       74,
    'humidity',          55,
    'actual_gallons_applied', 480,
    'notes',             '[SMOKE] applied clean');

  v_res := complete_job(v_job, v_applied, v_admin, '[SMOKE] cj-' || v_sfx);
  IF COALESCE(v_res->>'success','') <> 'true' THEN
    RAISE EXCEPTION 'FAIL complete_job: %', v_res;
  END IF;
  v_rec := (v_res->>'application_record_id')::uuid;
  IF v_rec IS NULL THEN RAISE EXCEPTION 'FAIL: no application_record_id'; END IF;
  IF (v_res->>'field_count')::int <> 1 THEN
    RAISE EXCEPTION 'FAIL: field_count % (expected 1)', v_res->>'field_count';
  END IF;

  PERFORM 1 FROM jobs WHERE id = v_job AND status = 'completed';
  IF NOT FOUND THEN RAISE EXCEPTION 'FAIL: job not completed'; END IF;

  -- weather captured on job_applied_info
  SELECT * INTO v_ai FROM job_applied_info WHERE job_id = v_job;
  IF NOT FOUND THEN RAISE EXCEPTION 'FAIL: no job_applied_info row'; END IF;
  IF v_ai.wind_speed <> 12.5 OR v_ai.wind_direction <> 'NW'
     OR v_ai.temperature <> 74 OR v_ai.humidity <> 55
     OR v_ai.actual_gallons_applied <> 480 THEN
    RAISE EXCEPTION 'FAIL: job_applied_info weather wrong (%/%/%/%/%)',
      v_ai.wind_speed, v_ai.wind_direction, v_ai.temperature, v_ai.humidity, v_ai.actual_gallons_applied;
  END IF;

  -- application_record created, weather snapshotted, NOT yet invoiced
  SELECT * INTO v_ar FROM application_records WHERE id = v_rec;
  IF NOT FOUND THEN RAISE EXCEPTION 'FAIL: application_record not found'; END IF;
  IF v_ar.source_type <> 'job' OR v_ar.source_id <> v_job
     OR v_ar.customer_id <> v_customer THEN
    RAISE EXCEPTION 'FAIL: application_record linkage wrong (%/%/%)',
      v_ar.source_type, v_ar.source_id, v_ar.customer_id;
  END IF;
  IF v_ar.invoice_id IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL: application_record already linked to an invoice before transfer';
  END IF;
  IF (v_ar.weather_conditions->>'wind_speed')::numeric <> 12.5
     OR v_ar.weather_conditions->>'wind_direction' <> 'NW' THEN
    RAISE EXCEPTION 'FAIL: application_record weather snapshot wrong: %', v_ar.weather_conditions;
  END IF;
  IF v_ar.total_acres <> 120 THEN
    RAISE EXCEPTION 'FAIL: application_record total_acres % (expected 120)', v_ar.total_acres;
  END IF;
  SELECT count(*) INTO v_n FROM application_record_fields WHERE application_record_id = v_rec;
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL: % application_record_fields (expected 1)', v_n; END IF;

  -- complete_job idempotency replay: same payload, NO 2nd application_record
  v_res2 := complete_job(v_job, v_applied, v_admin, '[SMOKE] cj-' || v_sfx);
  IF v_res2 IS DISTINCT FROM v_res THEN
    RAISE EXCEPTION 'FAIL: complete_job replay differs: % vs %', v_res2, v_res;
  END IF;
  SELECT count(*) INTO v_n FROM application_records WHERE source_type='job' AND source_id=v_job;
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL: complete_job replay made a 2nd application_record (%)', v_n; END IF;

  -- =================================================== 3) transfer_job_to_invoice
  v_res := transfer_job_to_invoice(v_job, v_admin, '[SMOKE] tji-' || v_sfx);
  IF COALESCE(v_res->>'success','') <> 'true' THEN
    RAISE EXCEPTION 'FAIL transfer_job_to_invoice: %', v_res;
  END IF;
  v_invoice := (v_res->>'invoice_id')::uuid;
  IF v_invoice IS NULL THEN RAISE EXCEPTION 'FAIL: no invoice_id from transfer'; END IF;

  SELECT * INTO v_inv FROM invoices WHERE id = v_invoice;
  IF v_inv.invoice_type <> 'field_application' OR v_inv.status <> 'unposted'
     OR v_inv.customer_id <> v_customer OR v_inv.job_id <> v_job THEN
    RAISE EXCEPTION 'FAIL: invoice head wrong (type %, status %, cust %, job %)',
      v_inv.invoice_type, v_inv.status, v_inv.customer_id, v_inv.job_id;
  END IF;
  IF v_inv.application_date IS DISTINCT FROM v_job_date THEN
    RAISE EXCEPTION 'FAIL: application_date % (expected job_date %)', v_inv.application_date, v_job_date;
  END IF;
  IF v_inv.total_amount_cents <> 35000 OR v_inv.total_cost_cents <> 14000 THEN
    RAISE EXCEPTION 'FAIL: invoice totals %/% (expected 35000/14000)',
      v_inv.total_amount_cents, v_inv.total_cost_cents;
  END IF;

  -- THE Phase-1b link: application_record now points at the invoice; job invoiced
  SELECT * INTO v_ar FROM application_records WHERE id = v_rec;
  IF v_ar.invoice_id <> v_invoice THEN
    RAISE EXCEPTION 'FAIL: application_record.invoice_id % (expected %)', v_ar.invoice_id, v_invoice;
  END IF;
  PERFORM 1 FROM jobs WHERE id = v_job AND status = 'invoiced' AND invoice_id = v_invoice;
  IF NOT FOUND THEN RAISE EXCEPTION 'FAIL: job not flipped to invoiced/back-linked'; END IF;

  SELECT count(*) INTO v_n FROM invoice_items WHERE invoice_id = v_invoice;
  IF v_n <> 2 THEN RAISE EXCEPTION 'FAIL: % invoice_items (expected 2)', v_n; END IF;
  SELECT count(*) INTO v_n FROM invoice_shares WHERE invoice_id = v_invoice;
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL: % invoice_shares (expected 1)', v_n; END IF;

  -- =================================================== 4) EDIT while unposted
  -- Operator reconciles actual: Chem B went out at 6 GL, not 5 (=> 12000c).
  UPDATE invoice_items
     SET quantity = 6, unit_price_cents = 12000, extended_cents = 12000
   WHERE invoice_id = v_invoice AND product_id = v_prod_b;
  GET DIAGNOSTICS v_rc = ROW_COUNT;
  IF v_rc <> 1 THEN RAISE EXCEPTION 'FAIL: invoice_item edit affected % rows (expected 1)', v_rc; END IF;

  UPDATE invoices
     SET total_amount_cents = 37000, header_notes = '[SMOKE] reconciled to actual'
   WHERE id = v_invoice;
  GET DIAGNOSTICS v_rc = ROW_COUNT;
  IF v_rc <> 1 THEN RAISE EXCEPTION 'FAIL: invoice header edit affected % rows (expected 1)', v_rc; END IF;

  SELECT * INTO v_inv FROM invoices WHERE id = v_invoice;
  IF v_inv.status <> 'unposted' THEN
    RAISE EXCEPTION 'FAIL: edit changed status to % (expected still unposted)', v_inv.status;
  END IF;
  IF v_inv.total_amount_cents <> 37000 THEN
    RAISE EXCEPTION 'FAIL: edited total_amount_cents % (expected 37000)', v_inv.total_amount_cents;
  END IF;

  -- =================================================== 5) post_invoice
  PERFORM post_invoice(v_invoice, '[SMOKE] pi-' || v_sfx);
  SELECT * INTO v_inv FROM invoices WHERE id = v_invoice;
  IF v_inv.status <> 'posted' THEN RAISE EXCEPTION 'FAIL: not posted (status %)', v_inv.status; END IF;
  IF v_inv.posted_by <> v_admin OR v_inv.posted_at IS NULL THEN
    RAISE EXCEPTION 'FAIL: posted_by/posted_at not set (%/%)', v_inv.posted_by, v_inv.posted_at;
  END IF;
  -- balance_cents is GENERATED = total - paid - prepay - write_off; no payments => 37000
  IF v_inv.balance_cents <> 37000 THEN
    RAISE EXCEPTION 'FAIL: balance_cents % (expected 37000)', v_inv.balance_cents;
  END IF;
  SELECT count(*) INTO v_n FROM financial_audit_log
   WHERE entity_type='invoice' AND entity_id=v_invoice AND operation_type='invoice_posted';
  IF v_n < 1 THEN RAISE EXCEPTION 'FAIL: no invoice_posted audit row'; END IF;

  -- =================================================== 6) void_invoice
  PERFORM void_invoice(v_invoice, '[SMOKE] loop void', '[SMOKE] vi-' || v_sfx);
  SELECT * INTO v_inv FROM invoices WHERE id = v_invoice;
  IF v_inv.status <> 'voided' THEN RAISE EXCEPTION 'FAIL: not voided (status %)', v_inv.status; END IF;
  IF v_inv.total_amount_cents <> 0 OR v_inv.balance_cents <> 0 THEN
    RAISE EXCEPTION 'FAIL: void did not zero totals (%/%)', v_inv.total_amount_cents, v_inv.balance_cents;
  END IF;
  IF v_inv.void_reason IS DISTINCT FROM '[SMOKE] loop void' THEN
    RAISE EXCEPTION 'FAIL: void_reason %', v_inv.void_reason;
  END IF;
  SELECT count(*) INTO v_n FROM financial_audit_log
   WHERE entity_type='invoice' AND entity_id=v_invoice AND operation_type='invoice_voided';
  IF v_n < 1 THEN RAISE EXCEPTION 'FAIL: no invoice_voided audit row'; END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END $$;
