-- ============================================================================
-- ROLLED-BACK smoke test for scripts/.staging-migrations/blend_invoice_app_service_guard.sql
-- (create_invoice_from_blend_ticket 55000 repair: v_has_app_service guard
--  boolean -- the application-fee gate no longer references the
--  never-assigned v_app_service record on no-service tickets)
-- ----------------------------------------------------------------------------
-- HOW TO RUN: execute this whole file as a SINGLE statement (Supabase MCP
-- execute_sql, or psql -1) as postgres/service_role AFTER the migration is
-- applied. The block ALWAYS ends with RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK',
-- so every fixture, invoice, share, feed and idempotency row created here is
-- rolled back -- nothing persists. Any other exception text = a real failure.
--
-- Auth: the RPC requires auth.uid() AND (is_admin() OR is_sales_rep()), and
-- asserts p_created_by = auth.uid(). auth.uid() reads request.jwt.claims --
-- injected below via set_config(..., is_local => true) using a real active
-- admin profile id selected at runtime (never hardcoded). Direct fixture
-- INSERTs bypass RLS because we run as the table owner; the RPC under test
-- still enforces its own auth/role gates.
--
-- THE PATHS (both sides of the guard required -- plpgsql_check CANNOT see
-- this bug class, it reported 0 errors on the broken live body; this smoke is
-- the only proof):
--  (a) NO-SERVICE PATH (the main path; on live TODAY this exact call raises
--      55000 'record "v_app_service" is not yet assigned'): completed+approved
--      ticket, application_service_id NULL, one field (10 ac), one chem line
--      (rate 2/ac, tier1 $10.00, current_cost 12.34) -> invoice MUST be
--      created: draft field_application, total 20000, cost 24680, EXACTLY one
--      line, ZERO is_application_fee lines (guard correctly off), no
--      application_service_id on the invoice, ticket flips to billed.
--  (b) WITH-SERVICE PATH (guard passes through): same chem fixture shape plus
--      a FULLY-POPULATED application_services row (is_active = true,
--      default_rate_per_acre_cents 850, cost_per_acre_cents 300, vehicle_id +
--      created_by set -- the preserved gate includes the original composite
--      'v_app_service IS NOT NULL', true only when EVERY column is non-null,
--      and all 4 live fee-producing services are fully populated like this;
--      NO customer_application_rates row, so the default-rate fallback is the
--      branch exercised) -> EXACTLY 2 lines: the same chem line + a fee line
--      (description = service name, quantity/acres 10, unit_price_cents 850,
--      extended = safe_cents_qty(850,10) = 8500, cost = safe_cents_qty(300,10)
--      = 3000, sort_order 9999, rate_unit 'acre', is_application_fee true,
--      price_source 'tier'); header totals 28500/27680 and
--      invoices.application_service_id stamped; ticket flips to billed.
--  (b2) PRESERVED-SEMANTICS REGRESSION CHECK: an ACTIVE service row with NULL
--      vehicle_id/created_by fails the composite test, so live silently
--      skipped its fee BEFORE this fix (with-service calls never crashed) --
--      and must STILL skip it after: invoice created, 1 line, ZERO fee lines,
--      total 20000. This pins down that the fix changes ONLY the no-service
--      crash path, not with-service billing.
--  (c) IDEMPOTENT REPLAY: replaying path (a)'s key returns the cached jsonb
--      verbatim and does NOT create a second invoice.
--
-- Expected money math (bigint cents end to end):
--   chem qty   = rate 2/ac * 10 share acres       = 20 units
--   chem price = tier1 ($10.00 * 100, tier path)  = 1000 c/unit -> ext 20000
--   chem cost  = ROUND(12.34 * 100) = 1234 c/unit -> 24680
--   fee  ext   = safe_cents_qty(850, 10)          = 8500   (path b only)
--   fee  cost  = safe_cents_qty(300, 10)          = 3000   (path b only)
--   invoice b  = 28500 total / 27680 cost
--
-- Fixture notes (live-catalog-validated at draft time):
-- * application_services: only "name" is NOT NULL without a default; no CHECK
--   constraints; the updated_at trigger is benign; is_active boolean NOT NULL.
--   Path (b)'s row sets vehicle_id (FK vehicles.id -- a [SMOKE] ground vehicle
--   fixture; vehicles requires vehicle_name + vehicle_type IN ('ground','air'))
--   and created_by (FK profiles.id = the runtime admin) so all 10 columns are
--   non-null and the preserved composite test passes, matching every live
--   fee-producing service. Path (b2)'s row deliberately leaves them NULL.
-- * products: tier1_margin left NULL so trigger calculate_prices_from_margin
--   keeps tier1_price exactly as inserted; product_form NULL so
--   validate_product_units is a no-op.
-- * customers.assigned_tier 1 -> derive_customer_shares_from_fields fallback
--   path yields ONE customer, tier 1, no overrides -> a single invoice per
--   ticket, invoice_group_id NULL.
-- * blend ticket literals are all in the live CHECK sets: status 'completed',
--   review_status 'approved', payment_status 'unbilled'->'billed',
--   source 'manual'.
-- ============================================================================

DO $smoke$
DECLARE
  v_admin       uuid;
  v_customer_id uuid;
  v_field_id    uuid;
  v_product_id  uuid;
  v_vehicle_id  uuid;
  v_svc_id      uuid;
  v_svc_nq      uuid;
  v_ticket_a    uuid;
  v_ticket_b    uuid;
  v_ticket_c    uuid;
  v_inv_a       uuid;
  v_inv_b       uuid;
  v_inv_c       uuid;
  v_res         jsonb;
  v_res_b       jsonb;
  v_res_c       jsonb;
  v_res2        jsonb;
  v_suffix      text := substr(md5(random()::text), 1, 8);
  v_idem_a      text;
  v_idem_b      text;
  v_idem_c      text;
  v_count       int;
  v_pay         text;
  v_inv         record;
  v_item        record;
  v_fee         record;
BEGIN
  -- --------------------------------------------------------------------
  -- 0. Auth as a real active admin (runtime-selected, never hardcoded)
  -- --------------------------------------------------------------------
  SELECT id INTO v_admin FROM profiles
  WHERE role = 'admin' AND is_active = true
  ORDER BY created_at LIMIT 1;
  IF v_admin IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: no active admin profile found';
  END IF;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);

  -- --------------------------------------------------------------------
  -- 1. Shared fixtures (txn-local; rolled back at the end)
  -- --------------------------------------------------------------------
  INSERT INTO customers (farm_name, assigned_tier)
  VALUES ('[SMOKE] AppSvc Guard Farm ' || v_suffix, 1)
  RETURNING id INTO v_customer_id;

  INSERT INTO fields (customer_id, field_name, total_acres)
  VALUES (v_customer_id, '[SMOKE] Field ' || v_suffix, 10)
  RETURNING id INTO v_field_id;

  INSERT INTO products (product_name, current_cost, tier1_price, unit_size, rate_unit)
  VALUES ('[SMOKE] AppSvc Guard Product ' || v_suffix, 12.34, 10, '2.5 GAL', 'oz/ac')
  RETURNING id INTO v_product_id;

  INSERT INTO vehicles (vehicle_name, vehicle_type)
  VALUES ('[SMOKE] Rig ' || v_suffix, 'ground')
  RETURNING id INTO v_vehicle_id;

  -- Fully populated (all 10 columns non-null) so the preserved composite
  -- 'v_app_service IS NOT NULL' passes, like every live fee-producing service.
  INSERT INTO application_services (name, vehicle_id, default_rate_per_acre_cents, cost_per_acre_cents, is_active, created_by)
  VALUES ('[SMOKE] App Svc ' || v_suffix, v_vehicle_id, 850, 300, true, v_admin)
  RETURNING id INTO v_svc_id;

  -- --------------------------------------------------------------------
  -- 2. PATH (a): ticket WITHOUT application_service_id -- THE bug path.
  --    On the unfixed live body this call dies with 55000 before any write.
  -- --------------------------------------------------------------------
  INSERT INTO blend_tickets (
    ticket_number, uploaded_by, customer_id, status, review_status,
    payment_status, season, total_acres, source
  ) VALUES (
    '[SMOKE]-BTA-' || v_suffix, v_admin, v_customer_id, 'completed', 'approved',
    'unbilled', current_season(), 10, 'manual'
  ) RETURNING id INTO v_ticket_a;

  INSERT INTO blend_ticket_fields (blend_ticket_id, field_id, customer_id, actual_acres)
  VALUES (v_ticket_a, v_field_id, v_customer_id, 10);

  INSERT INTO blend_ticket_products (
    blend_ticket_id, product_id, product_name, quantity, rate_per_acre, sequence_order
  ) VALUES (
    v_ticket_a, v_product_id, '[SMOKE] BTP-A ' || v_suffix, 20, 2, 1
  );

  v_idem_a := '[SMOKE]-idem-a-' || v_suffix;
  BEGIN
    v_res := create_invoice_from_blend_ticket(v_ticket_a, v_admin, v_idem_a);
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'SMOKE_FAIL(a): the no-service (main-path) ticket raised [%] % -- the 55000 unassigned-record bug is NOT fixed', SQLSTATE, SQLERRM;
  END;

  IF jsonb_array_length(v_res -> 'invoice_ids') IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL(a): expected exactly 1 invoice id, got %', v_res;
  END IF;
  IF (v_res ->> 'invoice_group_id') IS NOT NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL(a): single-customer ticket must not create a group, got %', v_res;
  END IF;
  v_inv_a := (v_res -> 'invoice_ids' ->> 0)::uuid;

  SELECT * INTO v_inv FROM invoices WHERE id = v_inv_a;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SMOKE_FAIL(a): invoice row % not found', v_inv_a;
  END IF;
  IF v_inv.status <> 'draft'
     OR v_inv.invoice_type <> 'field_application'
     OR v_inv.customer_id <> v_customer_id
     OR v_inv.blend_ticket_id <> v_ticket_a
     OR v_inv.application_service_id IS NOT NULL
     OR v_inv.total_amount_cents <> 20000
     OR COALESCE(v_inv.total_cost_cents, -1) <> 24680 THEN
    RAISE EXCEPTION 'SMOKE_FAIL(a): invoice header wrong: status=% type=% svc=% total=% cost=%',
      v_inv.status, v_inv.invoice_type, v_inv.application_service_id,
      v_inv.total_amount_cents, v_inv.total_cost_cents;
  END IF;

  -- Exactly one chem line, ZERO fee lines: the guard is provably OFF
  SELECT count(*) INTO v_count FROM invoice_items WHERE invoice_id = v_inv_a;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL(a): expected exactly 1 invoice item, got %', v_count;
  END IF;
  SELECT count(*) INTO v_count FROM invoice_items
  WHERE invoice_id = v_inv_a AND COALESCE(is_application_fee, false);
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL(a): no-service invoice has % application-fee line(s)', v_count;
  END IF;

  SELECT payment_status INTO v_pay FROM blend_tickets WHERE id = v_ticket_a;
  IF v_pay <> 'billed' THEN
    RAISE EXCEPTION 'SMOKE_FAIL(a): blend ticket payment_status=% (expected billed)', v_pay;
  END IF;

  -- --------------------------------------------------------------------
  -- 3. PATH (b): ticket WITH an active application service -- the guard
  --    boolean must pass through and produce the fee line.
  -- --------------------------------------------------------------------
  INSERT INTO blend_tickets (
    ticket_number, uploaded_by, customer_id, status, review_status,
    payment_status, season, total_acres, source, application_service_id
  ) VALUES (
    '[SMOKE]-BTB-' || v_suffix, v_admin, v_customer_id, 'completed', 'approved',
    'unbilled', current_season(), 10, 'manual', v_svc_id
  ) RETURNING id INTO v_ticket_b;

  INSERT INTO blend_ticket_fields (blend_ticket_id, field_id, customer_id, actual_acres)
  VALUES (v_ticket_b, v_field_id, v_customer_id, 10);

  INSERT INTO blend_ticket_products (
    blend_ticket_id, product_id, product_name, quantity, rate_per_acre, sequence_order
  ) VALUES (
    v_ticket_b, v_product_id, '[SMOKE] BTP-B ' || v_suffix, 20, 2, 1
  );

  v_idem_b := '[SMOKE]-idem-b-' || v_suffix;
  v_res_b := create_invoice_from_blend_ticket(v_ticket_b, v_admin, v_idem_b);

  IF jsonb_array_length(v_res_b -> 'invoice_ids') IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL(b): expected exactly 1 invoice id, got %', v_res_b;
  END IF;
  v_inv_b := (v_res_b -> 'invoice_ids' ->> 0)::uuid;

  SELECT * INTO v_inv FROM invoices WHERE id = v_inv_b;
  IF v_inv.status <> 'draft'
     OR v_inv.invoice_type <> 'field_application'
     OR v_inv.blend_ticket_id <> v_ticket_b
     OR v_inv.application_service_id IS DISTINCT FROM v_svc_id
     OR v_inv.total_amount_cents <> 28500
     OR COALESCE(v_inv.total_cost_cents, -1) <> 27680 THEN
    RAISE EXCEPTION 'SMOKE_FAIL(b): invoice header wrong: status=% type=% svc=% total=% cost=%',
      v_inv.status, v_inv.invoice_type, v_inv.application_service_id,
      v_inv.total_amount_cents, v_inv.total_cost_cents;
  END IF;

  SELECT count(*) INTO v_count FROM invoice_items WHERE invoice_id = v_inv_b;
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'SMOKE_FAIL(b): expected exactly 2 invoice items (chem + fee), got %', v_count;
  END IF;

  -- The chem line (unchanged by this fix -- the 20260611001954 math holds)
  SELECT * INTO v_item FROM invoice_items
  WHERE invoice_id = v_inv_b AND NOT COALESCE(is_application_fee, false);
  IF v_item.product_id IS DISTINCT FROM v_product_id
     OR v_item.quantity <> 20
     OR v_item.unit_price_cents <> 1000
     OR v_item.extended_cents <> 20000
     OR v_item.cost_cents <> 1234 THEN
    RAISE EXCEPTION 'SMOKE_FAIL(b): chem line wrong: qty=% price=% ext=% cost=%',
      v_item.quantity, v_item.unit_price_cents, v_item.extended_cents, v_item.cost_cents;
  END IF;

  -- THE FEE LINE: default-rate fallback (no customer_application_rates row)
  SELECT * INTO v_fee FROM invoice_items
  WHERE invoice_id = v_inv_b AND COALESCE(is_application_fee, false);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SMOKE_FAIL(b): active-service invoice has NO application-fee line (guard stuck off)';
  END IF;
  IF v_fee.description IS DISTINCT FROM ('[SMOKE] App Svc ' || v_suffix)
     OR v_fee.quantity <> 10
     OR v_fee.unit_price_cents <> 850
     OR v_fee.extended_cents <> 8500
     OR v_fee.cost_cents <> 3000
     OR v_fee.sort_order <> 9999
     OR COALESCE(v_fee.acres, -1) <> 10
     OR v_fee.rate_per_acre <> 850
     OR v_fee.rate_unit IS DISTINCT FROM 'acre'
     OR v_fee.price_source IS DISTINCT FROM 'tier' THEN
    RAISE EXCEPTION 'SMOKE_FAIL(b): fee line wrong: desc=% qty=% price=% ext=% cost=% sort=% acres=% rate=% unit=% src=%',
      v_fee.description, v_fee.quantity, v_fee.unit_price_cents, v_fee.extended_cents,
      v_fee.cost_cents, v_fee.sort_order, v_fee.acres, v_fee.rate_per_acre,
      v_fee.rate_unit, v_fee.price_source;
  END IF;

  SELECT payment_status INTO v_pay FROM blend_tickets WHERE id = v_ticket_b;
  IF v_pay <> 'billed' THEN
    RAISE EXCEPTION 'SMOKE_FAIL(b): blend ticket payment_status=% (expected billed)', v_pay;
  END IF;

  -- --------------------------------------------------------------------
  -- 4. PATH (b2): preserved-semantics regression check. An ACTIVE service
  --    with NULL vehicle_id/created_by fails the original composite
  --    'v_app_service IS NOT NULL' (true only when EVERY column is
  --    non-null), so live skipped its fee silently BEFORE this fix -- and
  --    must STILL skip it after. Pins the fix to the no-service crash path
  --    only; with-service billing behavior is byte-for-byte preserved.
  -- --------------------------------------------------------------------
  INSERT INTO application_services (name, default_rate_per_acre_cents, cost_per_acre_cents, is_active)
  VALUES ('[SMOKE] App Svc NQ ' || v_suffix, 850, 300, true)
  RETURNING id INTO v_svc_nq;

  INSERT INTO blend_tickets (
    ticket_number, uploaded_by, customer_id, status, review_status,
    payment_status, season, total_acres, source, application_service_id
  ) VALUES (
    '[SMOKE]-BTC-' || v_suffix, v_admin, v_customer_id, 'completed', 'approved',
    'unbilled', current_season(), 10, 'manual', v_svc_nq
  ) RETURNING id INTO v_ticket_c;

  INSERT INTO blend_ticket_fields (blend_ticket_id, field_id, customer_id, actual_acres)
  VALUES (v_ticket_c, v_field_id, v_customer_id, 10);

  INSERT INTO blend_ticket_products (
    blend_ticket_id, product_id, product_name, quantity, rate_per_acre, sequence_order
  ) VALUES (
    v_ticket_c, v_product_id, '[SMOKE] BTP-C ' || v_suffix, 20, 2, 1
  );

  v_idem_c := '[SMOKE]-idem-c-' || v_suffix;
  v_res_c := create_invoice_from_blend_ticket(v_ticket_c, v_admin, v_idem_c);
  v_inv_c := (v_res_c -> 'invoice_ids' ->> 0)::uuid;

  SELECT count(*) INTO v_count FROM invoice_items WHERE invoice_id = v_inv_c;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL(b2): expected exactly 1 item on the NULL-column-service invoice, got %', v_count;
  END IF;
  SELECT count(*) INTO v_count FROM invoice_items
  WHERE invoice_id = v_inv_c AND COALESCE(is_application_fee, false);
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL(b2): NULL-column service produced % fee line(s) -- the fix CHANGED with-service semantics (composite test lost)', v_count;
  END IF;
  SELECT total_amount_cents INTO v_count FROM invoices WHERE id = v_inv_c;
  IF v_count <> 20000 THEN
    RAISE EXCEPTION 'SMOKE_FAIL(b2): expected total 20000 (chem only), got %', v_count;
  END IF;

  -- --------------------------------------------------------------------
  -- 5. PATH (c): idempotent replay of path (a)'s key returns the cached
  --    result and does NOT raise "already billed" or create a 2nd invoice.
  -- --------------------------------------------------------------------
  SELECT count(*) INTO v_count FROM idempotency_keys
  WHERE idempotency_key = v_idem_a AND operation = 'create_invoice_from_blend_ticket';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL(c): idempotency_keys row missing/dup (count=%)', v_count;
  END IF;

  v_res2 := create_invoice_from_blend_ticket(v_ticket_a, v_admin, v_idem_a);
  IF v_res2 IS DISTINCT FROM v_res THEN
    RAISE EXCEPTION 'SMOKE_FAIL(c): idempotent replay returned a different result: % vs %', v_res2, v_res;
  END IF;
  SELECT count(*) INTO v_count FROM invoices WHERE blend_ticket_id = v_ticket_a;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL(c): replay created a second invoice (count=%)', v_count;
  END IF;

  -- --------------------------------------------------------------------
  -- All scenarios passed -- force rollback of everything above.
  -- --------------------------------------------------------------------
  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END $smoke$;
