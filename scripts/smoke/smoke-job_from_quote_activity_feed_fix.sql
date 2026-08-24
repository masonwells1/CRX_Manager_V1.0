-- ============================================================================
-- ROLLED-BACK smoke test for scripts/.staging-migrations/
--   job_from_quote_activity_feed_fix.sql (create_job_from_quote_section 42P01)
-- ----------------------------------------------------------------------------
-- Verifies the single F1 delta end-to-end: create_job_from_quote_section must
-- now (a) create the job at all — pre-fix, EVERY call aborted at the
-- nonexistent-relation activity_log INSERT, rolling back the job with it —
-- and (b) land the activity row in activity_feed with the draw_down_quote
-- column shape (the previously-broken statement, asserted explicitly).
--
-- HOW TO RUN: execute this whole file as a SINGLE statement (Supabase MCP
-- execute_sql, or psql -1) as postgres/service_role AFTER the migration is
-- applied. The block ALWAYS ends with RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK',
-- so every fixture, job, and feed row created here is rolled back — nothing
-- persists. Any other exception text = a real failure.
--
-- Auth: the RPC derives the actor from auth.uid() (strict-actor gate), which
-- reads request.jwt.claims — injected below via set_config(..., is_local =>
-- true) using a real active admin profile id selected at runtime. Direct
-- fixture INSERTs bypass RLS because we run as the table owner; the RPC under
-- test still enforces its own auth/role gates.
--
-- Scenarios:
--   (1) fixture quote (sent, is_planned) + section + 1 item
--       -> create_job_from_quote_section
--       -> job created (status 'scheduled', correct section/customer linkage,
--          20000 price cents, catalog-derived cost cents, 40 acres,
--          1 job_chemicals)
--   (2) THE FIXED STATEMENT: exactly one activity_feed row exists for the job
--       (event_type 'job_created_from_quote', performed_by = actor,
--        related_entity_type 'job', related_entity_id = job, customer_id set,
--        description carries job_number + quote_number)
--   (3) idempotent replay with the same key returns the cached job_id and
--       creates no second job and no second feed row
--
-- 42703 DISCIPLINE — every reference below was dry-validated against the live
-- catalog 2026-06-10 (bulk information_schema.columns probe returned ZERO
-- missing; functions probed via pg_proc, single overload each):
--   profiles(id, role, is_active, created_at)
--   customers(id, farm_name)                          [farm_name = only NOT NULL w/o default]
--   products(id, product_name, current_cost, tier1_price, unit_size)
--   quotes(id, quote_number, customer_id, created_by, status, is_planned)
--     [NOT NULL w/o default: quote_number, customer_id, created_by;
--      status 'sent' is in quotes_status_check; all quotes triggers are
--      UPDATE-only so a direct INSERT at 'sent' fires none of them]
--   quote_sections(id, quote_id, section_name, sort_order)
--   quote_items(quote_id, section_id, product_id, sort_order, price_per_unit,
--     current_cost, total_units_needed, acres, actual_rate, rate_unit)
--   jobs(id, job_number, customer_id, status, quote_id, quote_section_id,
--     total_acres, total_cost_cents, total_price_cents, deleted_at)
--     ['scheduled' is in jobs_status_check]
--   job_chemicals(job_id)
--   activity_feed(id, event_type, description, performed_by,
--     related_entity_type, related_entity_id, customer_id, created_at)
--     [no CHECK on event_type; performed_by NOT NULL FK->profiles]
--   idempotency_keys(idempotency_key, operation, result)  [written by the RPC]
--   functions: public.create_job_from_quote_section(uuid,uuid,uuid,text)
--     [1 overload], public.next_job_number() [1 overload, called internally]
-- ============================================================================

DO $smoke$
DECLARE
  v_admin uuid;
  v_customer_id uuid;
  v_product_id uuid;
  v_product_cost numeric;
  v_expected_cost_cents bigint;
  v_quote_id uuid;
  v_section_id uuid;
  v_res jsonb;
  v_res2 jsonb;
  v_job_id uuid;
  v_job RECORD;
  v_feed RECORD;
  v_count int;
  v_suffix text := substr(md5(random()::text), 1, 8);
  v_idem text;
BEGIN
  -- --------------------------------------------------------------------
  -- 0. Auth as a real active admin (RPC requires auth.uid())
  -- --------------------------------------------------------------------
  SELECT id INTO v_admin FROM profiles
  WHERE role = 'admin' AND is_active = true
  ORDER BY created_at LIMIT 1;
  IF v_admin IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: no active admin profile found';
  END IF;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);

  v_idem := '[SMOKE] jfq-' || v_suffix;

  -- --------------------------------------------------------------------
  -- 1. Synthetic fixtures (txn-local; rolled back at the end)
  -- --------------------------------------------------------------------
  INSERT INTO customers (farm_name)
  VALUES ('[SMOKE] JobFromQuote Farm ' || v_suffix)
  RETURNING id INTO v_customer_id;

  SELECT id, current_cost INTO v_product_id, v_product_cost
  FROM products
  WHERE is_active IS TRUE
    AND current_cost IS NOT NULL
    AND current_cost > 0
    AND current_cost = round(current_cost, 2)
    AND current_cost <= 10
  ORDER BY current_cost, id
  LIMIT 1;
  IF v_product_id IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: need an active product with a positive whole-cent current_cost of 10.00 or less';
  END IF;
  v_expected_cost_cents := (v_product_cost * 20 * 100)::bigint;

  -- Planned open quote (the RPC requires is_planned and a non-terminal status)
  INSERT INTO quotes (quote_number, customer_id, created_by, status, is_planned)
  VALUES ('[SMOKE] JFQ-' || v_suffix, v_customer_id, v_admin, 'sent', true)
  RETURNING id INTO v_quote_id;

  INSERT INTO quote_sections (quote_id, section_name, sort_order)
  VALUES (v_quote_id, '[SMOKE] Section A', 0)
  RETURNING id INTO v_section_id;

  -- One item: 20 units @ $10 price / the borrowed catalog cost, 40 acres.
  -- The quote trigger snapshots that same product cost into the line.
  INSERT INTO quote_items (quote_id, section_id, product_id, sort_order,
    price_per_unit, current_cost, total_units_needed, acres, actual_rate, rate_unit)
  VALUES (v_quote_id, v_section_id, v_product_id, 0, 10, v_product_cost, 20, 40, 0.5, 'gal/acre');

  -- --------------------------------------------------------------------
  -- (1) The RPC under test — pre-fix this aborted with 42P01 every time
  -- --------------------------------------------------------------------
  v_res := create_job_from_quote_section(v_quote_id, v_section_id, v_admin, v_idem);
  v_job_id := (v_res->>'job_id')::uuid;
  IF v_job_id IS NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (1) no job_id in result %', v_res;
  END IF;

  SELECT * INTO v_job FROM jobs WHERE id = v_job_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (1) job row % missing', v_job_id;
  END IF;
  IF v_job.status <> 'scheduled'
     OR v_job.quote_section_id IS DISTINCT FROM v_section_id
     OR v_job.quote_id IS DISTINCT FROM v_quote_id
     OR v_job.customer_id IS DISTINCT FROM v_customer_id THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (1) job linkage wrong: status=%, section=%, quote=%, customer=%',
      v_job.status, v_job.quote_section_id, v_job.quote_id, v_job.customer_id;
  END IF;
  IF v_job.total_price_cents <> 20000 OR v_job.total_cost_cents <> v_expected_cost_cents
     OR v_job.total_acres <> 40 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (1) job totals wrong: price_cents=%, cost_cents=% (expected %), acres=%',
      v_job.total_price_cents, v_job.total_cost_cents, v_expected_cost_cents, v_job.total_acres;
  END IF;
  SELECT count(*) INTO v_count FROM job_chemicals WHERE job_id = v_job_id;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (1) expected 1 job_chemicals row, got %', v_count;
  END IF;

  -- --------------------------------------------------------------------
  -- (2) THE FIXED STATEMENT: the activity row must land in activity_feed
  -- --------------------------------------------------------------------
  SELECT * INTO v_feed FROM activity_feed
  WHERE related_entity_type = 'job' AND related_entity_id = v_job_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (2) no activity_feed row for job % — the 42P01 statement did not land', v_job_id;
  END IF;
  IF v_feed.event_type <> 'job_created_from_quote'
     OR v_feed.performed_by IS DISTINCT FROM v_admin
     OR v_feed.customer_id IS DISTINCT FROM v_customer_id THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (2) feed row wrong: event_type=%, performed_by=%, customer_id=%',
      v_feed.event_type, v_feed.performed_by, v_feed.customer_id;
  END IF;
  IF position(v_job.job_number IN v_feed.description) = 0
     OR position(('[SMOKE] JFQ-' || v_suffix) IN v_feed.description) = 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (2) description missing job/quote number: %', v_feed.description;
  END IF;

  -- --------------------------------------------------------------------
  -- (3) Idempotent replay: cached result, no duplicate job or feed row
  -- --------------------------------------------------------------------
  v_res2 := create_job_from_quote_section(v_quote_id, v_section_id, v_admin, v_idem);
  IF (v_res2->>'job_id')::uuid IS DISTINCT FROM v_job_id THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (3) replay returned %, expected cached job %', v_res2, v_job_id;
  END IF;
  SELECT count(*) INTO v_count FROM jobs
  WHERE quote_section_id = v_section_id AND deleted_at IS NULL;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (3) replay created a second job (count=%)', v_count;
  END IF;
  SELECT count(*) INTO v_count FROM activity_feed
  WHERE related_entity_type = 'job' AND related_entity_id = v_job_id;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (3) replay duplicated the feed row (count=%)', v_count;
  END IF;

  -- --------------------------------------------------------------------
  -- All scenarios passed — force rollback of everything above.
  -- --------------------------------------------------------------------
  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END $smoke$;
