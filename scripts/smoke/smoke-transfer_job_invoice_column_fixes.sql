-- ============================================================================
-- SMOKE TEST (rolled back by design): transfer_job_to_invoice column fixes
-- ----------------------------------------------------------------------------
-- Verifies scripts/.staging-migrations/transfer_job_invoice_column_fixes.sql
-- (baseline live prosrc md5 2603774c9d5175cf17481a700d3616cc). Full chain:
--   fixture customer + 2 products + field -> job (scheduled -> in_progress ->
--   completed, the enforcer-legal path) + job_fields + 2 job_chemicals ->
--   transfer_job_to_invoice -> assert every previously-broken reference now
--   resolves with correct values:
--     B-a  invoices.application_date = jobs.job_date (CURRENT_DATE - 3, set
--          deliberately != invoice_date so a wrong source can't pass)
--     B-b/B-c  invoice_items unit_price/extended/cost = per-unit cents x
--          quantity via safe_cents_qty, incl. a fractional-quantity rounding
--          case (444c x 2.5 = 1110; 999c x 2.5 = 2498 — ROUND half-away);
--          invoices.total_cost_cents = sum of line costs
--     B-d  activity_feed row (event_type 'job_invoiced', related job,
--          performed_by = admin, customer_id set, description carries the
--          invoice number) — the live body targeted nonexistent activity_log
--     B-e  invoice ends 'unposted' (insert-as-draft + legal flip; the live
--          'unposted' direct insert dies on trg_invoice_draft_insert)
--   Plus: shares fallback row (no field_billing_defaults), job flipped to
--   'invoiced' + back-linked, rate math (0.5/ac x 100 ac = 50 PT -> 6.25 GL),
--   and an idempotency replay (same key -> byte-identical cached jsonb, still
--   exactly one invoice + one feed row).
--
-- The DO block ALWAYS ends in RAISE EXCEPTION — on success it raises
-- 'SMOKE_PASS_ROLLBACK' — so nothing here ever commits.
--
-- Calling context: transfer_job_to_invoice is authenticated-executable and
-- role-gates on auth.uid() (active admin/sales_rep). We simulate the
-- authenticated context with transaction-local request.jwt.claims whose sub
-- is a REAL active admin profile id selected at runtime (verified live
-- 2026-06-10: 0b03fc35-49b5-454c-b7ca-eb56b20e8a5e exists, role=admin,
-- is_active=true).
--
-- Catalog dry-validation (42703 discipline) — every reference below was
-- checked against the live catalog 2026-06-10:
--   profiles(id, role, is_active); customers(id, farm_name);
--   products(id, product_name, unit_size, epa_registration, product_form
--     [CHECK liquid|dry]);
--   fields(id, customer_id, field_name, crop_type);
--   jobs(id, job_number, customer_id, status [CHECK incl. scheduled/
--     in_progress/completed/invoiced], job_date, notes, total_price_cents,
--     total_cost_cents, created_by, invoice_id);
--   job_fields(job_id, field_id, acres_to_treat, sort_order);
--   job_chemicals(job_id, product_id, quantity, unit, rate_per_acre,
--     rate_unit, cost_per_unit_cents, price_per_unit_cents, sort_order);
--   invoices(id, invoice_number, customer_id, invoice_type [CHECK incl.
--     field_application], status [CHECK incl. draft/unposted], invoice_date,
--     due_date, total_amount_cents, total_cost_cents, paid_amount_cents,
--     prepay_applied_cents, field_names, crop_type, total_acres,
--     applicator_name, vehicle_name, application_date, header_notes, season,
--     created_by, job_id);
--   invoice_items(invoice_id, product_id, description, quantity, unit_size,
--     unit_price_cents, extended_cents, cost_cents, sort_order, acres,
--     rate_per_acre, rate_unit, total_applied, total_applied_unit,
--     total_applied_gl_lb, gl_lb_unit, epa_registration, product_form,
--     is_application_fee);
--   invoice_shares(invoice_id, customer_id, customer_name, split_percentage,
--     acres, amount_cents, is_primary, sort_order);
--   activity_feed(event_type, description, performed_by, related_entity_type,
--     related_entity_id, customer_id);
--   idempotency_keys(idempotency_key, operation, result);
--   functions: transfer_job_to_invoice(uuid,uuid,text),
--     safe_cents_qty(bigint,numeric), convert_to_gl_lb(numeric,text,text),
--     check_idempotency(text,text)/save_idempotency (internal), auth.uid().
--   triggers exercised: _enforce_job_status_transition (scheduled ->
--     in_progress -> completed -> invoiced), enforce_invoice_draft_on_insert,
--     _enforce_invoice_status_transition (draft -> unposted),
--     trg_sync_blend_ticket_payment (no-op, blend_ticket_id NULL),
--     _enforce_applicator_license (no-op, applicator_id NULL).
-- ============================================================================

DO $$
DECLARE
  v_admin uuid;
  v_customer uuid;
  v_prod_a uuid;
  v_prod_b uuid;
  v_field uuid;
  v_job uuid;
  v_sfx text := substr(gen_random_uuid()::text, 1, 8);
  v_idem text;
  v_job_date date := CURRENT_DATE - 3;
  v_result jsonb;
  v_result2 jsonb;
  v_invoice_id uuid;
  v_inv RECORD;
  v_item RECORD;
  v_n int;
  v_feed RECORD;
BEGIN
  v_idem := '[SMOKE] tji-' || v_sfx;

  SELECT id INTO v_admin FROM profiles WHERE role = 'admin' AND is_active = true ORDER BY created_at LIMIT 1;
  IF v_admin IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP_FAILED: no active admin profile';
  END IF;

  -- Authenticated context: the fn role-gates on auth.uid()
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);

  -- ---------------------------------------------------------------- fixtures
  INSERT INTO customers (farm_name)
  VALUES ('[SMOKE] Transfer Farm ' || v_sfx)
  RETURNING id INTO v_customer;

  INSERT INTO products (product_name, unit_size, epa_registration, product_form)
  VALUES ('[SMOKE] Chem Alpha ' || v_sfx, 'GL', '[SMOKE]-EPA-A', 'liquid')
  RETURNING id INTO v_prod_a;

  INSERT INTO products (product_name, unit_size, epa_registration, product_form)
  VALUES ('[SMOKE] Chem Beta ' || v_sfx, 'GL', '[SMOKE]-EPA-B', 'liquid')
  RETURNING id INTO v_prod_b;

  INSERT INTO fields (customer_id, field_name, crop_type)
  VALUES (v_customer, '[SMOKE] North 40 ' || v_sfx, 'corn')
  RETURNING id INTO v_field;

  -- Job: total_price_cents = 27498 = sum of the two chem line prices below,
  -- so invoice total, line totals, and the share row all tie out.
  INSERT INTO jobs (job_number, customer_id, status, job_date, notes,
                    total_price_cents, total_cost_cents, created_by)
  VALUES ('[SMOKE] JOB-' || v_sfx, v_customer, 'scheduled', v_job_date,
          '[SMOKE] header notes', 27498, 11110, v_admin)
  RETURNING id INTO v_job;

  INSERT INTO job_fields (job_id, field_id, acres_to_treat, sort_order)
  VALUES (v_job, v_field, 100, 1);

  -- Chem Alpha: 10 x 2500c price / 1000c cost -> line price 25000, cost 10000;
  -- rate 0.5 PT/ac x 100 ac = 50 PT -> 6.25 GL (liquid PT/8).
  INSERT INTO job_chemicals (job_id, product_id, quantity, unit, rate_per_acre,
                             rate_unit, cost_per_unit_cents, price_per_unit_cents, sort_order)
  VALUES (v_job, v_prod_a, 10, 'GL', 0.5, 'PT', 1000, 2500, 1);

  -- Chem Beta: fractional qty rounding — 2.5 x 999c = 2497.5 -> 2498;
  -- 2.5 x 444c = 1110. No rate (total_applied stays NULL).
  INSERT INTO job_chemicals (job_id, product_id, quantity, unit, rate_per_acre,
                             rate_unit, cost_per_unit_cents, price_per_unit_cents, sort_order)
  VALUES (v_job, v_prod_b, 2.5, 'GL', NULL, NULL, 444, 999, 2);

  -- Lifecycle: the enforcer-legal path to 'completed'
  UPDATE jobs SET status = 'in_progress' WHERE id = v_job;
  UPDATE jobs SET status = 'completed' WHERE id = v_job;

  -- ------------------------------------------------------------------- call
  v_result := transfer_job_to_invoice(v_job, v_admin, v_idem);

  IF COALESCE(v_result->>'success', '') <> 'true' THEN
    RAISE EXCEPTION 'FAIL: success != true: %', v_result;
  END IF;
  v_invoice_id := (v_result->>'invoice_id')::uuid;
  IF v_invoice_id IS NULL OR v_result->>'invoice_number' IS NULL THEN
    RAISE EXCEPTION 'FAIL: missing invoice_id/invoice_number in result: %', v_result;
  END IF;

  -- ------------------------------------------------------- invoice head
  SELECT * INTO v_inv FROM invoices WHERE id = v_invoice_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'FAIL: invoice row not found'; END IF;

  -- B-e: end state 'unposted' (insert-as-draft survived trg_invoice_draft_insert)
  IF v_inv.status <> 'unposted' THEN
    RAISE EXCEPTION 'FAIL: invoice status % (expected unposted)', v_inv.status;
  END IF;
  -- B-a: application_date sourced from jobs.job_date, NOT invoice_date
  IF v_inv.application_date IS DISTINCT FROM v_job_date THEN
    RAISE EXCEPTION 'FAIL: application_date % (expected job_date %)', v_inv.application_date, v_job_date;
  END IF;
  IF v_inv.invoice_type <> 'field_application' OR v_inv.customer_id <> v_customer OR v_inv.job_id <> v_job THEN
    RAISE EXCEPTION 'FAIL: invoice head fields wrong (type %, customer %, job %)', v_inv.invoice_type, v_inv.customer_id, v_inv.job_id;
  END IF;
  IF v_inv.total_amount_cents <> 27498 THEN
    RAISE EXCEPTION 'FAIL: total_amount_cents % (expected 27498)', v_inv.total_amount_cents;
  END IF;
  -- B-b: rolled-up cost from per-unit x qty (10000 + 1110)
  IF v_inv.total_cost_cents <> 11110 THEN
    RAISE EXCEPTION 'FAIL: total_cost_cents % (expected 11110)', v_inv.total_cost_cents;
  END IF;
  IF v_inv.total_acres <> 100 OR v_inv.crop_type IS DISTINCT FROM 'corn' THEN
    RAISE EXCEPTION 'FAIL: acres/crop % / %', v_inv.total_acres, v_inv.crop_type;
  END IF;
  IF v_inv.invoice_number NOT LIKE 'INV-' || to_char(CURRENT_DATE, 'YYYY') || '-%' THEN
    RAISE EXCEPTION 'FAIL: invoice_number format %', v_inv.invoice_number;
  END IF;

  -- ------------------------------------------------------- invoice items
  SELECT count(*) INTO v_n FROM invoice_items WHERE invoice_id = v_invoice_id;
  IF v_n <> 2 THEN RAISE EXCEPTION 'FAIL: % invoice_items (expected 2)', v_n; END IF;

  -- Item 1: Chem Alpha (product_name sort order)
  SELECT * INTO v_item FROM invoice_items WHERE invoice_id = v_invoice_id AND product_id = v_prod_a;
  IF NOT FOUND THEN RAISE EXCEPTION 'FAIL: Chem Alpha item missing'; END IF;
  IF v_item.unit_price_cents <> 25000 OR v_item.extended_cents <> 25000 OR v_item.cost_cents <> 10000 THEN
    RAISE EXCEPTION 'FAIL: Alpha money %/%/% (expected 25000/25000/10000)',
      v_item.unit_price_cents, v_item.extended_cents, v_item.cost_cents;
  END IF;
  IF v_item.sort_order <> 1 OR v_item.acres <> 100 OR v_item.rate_per_acre <> 0.5 THEN
    RAISE EXCEPTION 'FAIL: Alpha sort/acres/rate %/%/%', v_item.sort_order, v_item.acres, v_item.rate_per_acre;
  END IF;
  IF v_item.total_applied <> 50 OR v_item.total_applied_gl_lb <> 6.25 OR v_item.gl_lb_unit IS DISTINCT FROM 'GL' THEN
    RAISE EXCEPTION 'FAIL: Alpha applied math %/%/%', v_item.total_applied, v_item.total_applied_gl_lb, v_item.gl_lb_unit;
  END IF;

  -- Item 2: Chem Beta (fractional-quantity rounding case)
  SELECT * INTO v_item FROM invoice_items WHERE invoice_id = v_invoice_id AND product_id = v_prod_b;
  IF NOT FOUND THEN RAISE EXCEPTION 'FAIL: Chem Beta item missing'; END IF;
  IF v_item.unit_price_cents <> 2498 OR v_item.extended_cents <> 2498 OR v_item.cost_cents <> 1110 THEN
    RAISE EXCEPTION 'FAIL: Beta money %/%/% (expected 2498/2498/1110)',
      v_item.unit_price_cents, v_item.extended_cents, v_item.cost_cents;
  END IF;
  IF v_item.sort_order <> 2 OR v_item.total_applied IS NOT NULL OR v_item.total_applied_gl_lb IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL: Beta sort/applied %/%/%', v_item.sort_order, v_item.total_applied, v_item.total_applied_gl_lb;
  END IF;

  -- ------------------------------------------------------- shares fallback
  SELECT count(*) INTO v_n FROM invoice_shares WHERE invoice_id = v_invoice_id;
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL: % invoice_shares (expected 1)', v_n; END IF;
  PERFORM 1 FROM invoice_shares
   WHERE invoice_id = v_invoice_id AND customer_id = v_customer
     AND amount_cents = 27498 AND split_percentage = 100.0 AND is_primary = true;
  IF NOT FOUND THEN RAISE EXCEPTION 'FAIL: fallback share row wrong'; END IF;

  -- ------------------------------------------------------- job back-link
  PERFORM 1 FROM jobs WHERE id = v_job AND status = 'invoiced' AND invoice_id = v_invoice_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'FAIL: job not flipped to invoiced/back-linked'; END IF;

  -- ------------------------------------------------------- B-d: activity_feed
  SELECT * INTO v_feed FROM activity_feed
   WHERE related_entity_type = 'job' AND related_entity_id = v_job;
  IF NOT FOUND THEN RAISE EXCEPTION 'FAIL: no activity_feed row for the job'; END IF;
  IF v_feed.event_type <> 'job_invoiced' THEN
    RAISE EXCEPTION 'FAIL: feed event_type % (expected job_invoiced)', v_feed.event_type;
  END IF;
  IF v_feed.performed_by <> v_admin OR v_feed.customer_id IS DISTINCT FROM v_customer THEN
    RAISE EXCEPTION 'FAIL: feed actor/customer %/%', v_feed.performed_by, v_feed.customer_id;
  END IF;
  IF position(v_inv.invoice_number IN v_feed.description) = 0 THEN
    RAISE EXCEPTION 'FAIL: feed description lacks invoice number: %', v_feed.description;
  END IF;

  -- ------------------------------------------------------- idempotency replay
  v_result2 := transfer_job_to_invoice(v_job, v_admin, v_idem);
  IF v_result2 IS DISTINCT FROM v_result THEN
    RAISE EXCEPTION 'FAIL: replay returned different payload: % vs %', v_result2, v_result;
  END IF;
  SELECT count(*) INTO v_n FROM invoices WHERE job_id = v_job;
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL: replay created a 2nd invoice (%)', v_n; END IF;
  SELECT count(*) INTO v_n FROM activity_feed WHERE related_entity_type = 'job' AND related_entity_id = v_job;
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL: replay created a 2nd feed row (%)', v_n; END IF;
  PERFORM 1 FROM idempotency_keys WHERE idempotency_key = v_idem AND operation = 'transfer_job_to_invoice';
  IF NOT FOUND THEN RAISE EXCEPTION 'FAIL: idempotency key row missing'; END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END $$;
