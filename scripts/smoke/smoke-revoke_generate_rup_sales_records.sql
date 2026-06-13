-- ============================================================================
-- SMOKE TEST (rolled back by design): revoke_generate_rup_sales_records
-- ----------------------------------------------------------------------------
-- Verifies the grants-only hardening of generate_rup_sales_records(uuid,text)
-- (staged migration scripts/.staging-migrations/revoke_generate_rup_sales_records.sql).
-- Run AFTER the migration is applied; against a pre-revoke DB it FAILs loudly
-- at S0 ("migration not applied yet").
--
-- SCENARIOS (all inside one always-rolled-back transaction):
--   S0  grant-matrix probes: authenticated -> EXECUTE false; anon -> false;
--       service_role -> true; owner postgres -> true; PUBLIC -> no acl entry.
--   S1  REAL direct call under SET LOCAL ROLE authenticated (with a real
--       active admin's JWT claims — the strongest realistic caller)
--       -> 42501 insufficient_privilege.
--   S2  REAL direct call under SET LOCAL ROLE anon -> 42501.
--       + no-write assert: the denied probes inserted ZERO rup rows.
--   S3  post_invoice — the ONLY legit caller — invoked AS ROLE authenticated
--       (the real UI path) on a [SMOKE] fixture invoice: still posts AND its
--       SECDEF-internal generate_rup_sales_records call (runs as owner
--       postgres, implicit EXECUTE) inserts exactly 1 correct RUP row.
--   S4  REAL call under SET LOCAL ROLE service_role on the same invoice
--       -> returns 0 (per-(invoice,product) dedup) — proves service_role
--       EXECUTE works for real, not just on paper.
--
-- HOW TO RUN: execute this whole file as a SINGLE statement (Supabase MCP
-- execute_sql, or psql -1 / run-smoke.mjs) as postgres. The DO block ALWAYS
-- ends with RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK' — error text containing
-- SMOKE_PASS_ROLLBACK = PASS (and proves nothing persisted); ANY other error
-- = FAIL (report verbatim).
--
-- Auth: request.jwt.claims injected via set_config(..., is_local => true)
-- with a REAL active admin profile id (looked up at runtime — raises
-- SMOKE_SETUP if none). SET LOCAL ROLE works because the session user
-- (postgres) is a member of authenticated/anon/service_role (verified live
-- 2026-06-10). Role changes made inside probe sub-blocks revert automatically
-- when the sub-transaction rolls back on the expected 42501.
--
-- Live-state preconditions (checked up front, SMOKE_SETUP if unmet):
--   * at least one active admin profile (post_invoice requires
--     admin/sales_rep + the rolled-back activity/audit rows FK a real id);
--   * CURRENT_DATE not inside a CLOSED accounting period (post_invoice calls
--     check_period_open(invoice_date)).
--
-- Known benign txn-local side effect: post_invoice does
-- SET LOCAL app.admin_override = 'true' (scopes to this txn; rolled back).
--
-- 42703 DISCIPLINE — every reference below dry-validated against the LIVE
-- catalog (information_schema.columns + pg_constraint + pg_trigger + pg_proc
-- + pg_auth_members) on 2026-06-10:
--   functions: generate_rup_sales_records(uuid,text) [single overload, SECDEF,
--     owner postgres], post_invoice(uuid,text) [single overload, SECDEF,
--     authenticated-EXECUTE, body PERFORMs generate_rup_sales_records]
--   profiles: id, role ['admin' in profiles_role_check], is_active, created_at
--   accounting_periods: status, period_start, period_end
--   customers: id, farm_name [only required col]
--   products: id, product_name [only required col], is_rup [NOT NULL, default],
--     epa_registration [nullable], signal_word [nullable; CHECK allows 'Warning']
--   applicator_licenses: id, customer_id, license_number [req], license_type
--     ['private' in CHECK], holder_name [req], expiry_date [req], is_active
--     [holder CHECK satisfied via customer_id]
--   orders: id, order_number [req], customer_id [req], salesman_id [nullable],
--     status [defaults 'confirmed', in orders_status_check]
--   invoices: id, invoice_number [UNIQUE], order_id, customer_id [req],
--     invoice_type ['chemical_sale' in CHECK], status ['draft'/'posted' in
--     CHECK; trg_invoice_draft_insert requires draft on INSERT],
--     total_amount_cents, invoice_date, created_by, created_at
--     [balance_cents is GENERATED — never written]
--   invoice_items: invoice_id, product_id, description, quantity, unit_size,
--     unit_price_cents, extended_cents
--   rup_sales_records: invoice_id, product_id, season, created_by,
--     compliance_status ['compliant' in CHECK], buyer_certification_number
-- ============================================================================

DO $smoke$
DECLARE
  v_admin    uuid;
  v_suffix   text := substr(md5(random()::text), 1, 8);
  v_customer uuid;
  v_product  uuid;
  v_order    uuid;
  v_invoice  uuid;
  v_lic_num  text;
  v_n        int;
  v_status   text;
  v_created  timestamptz;
  v_season   int;
  v_row      record;
BEGIN
  -- --------------------------------------------------------------------
  -- 0a. Preconditions + auth as a real active admin
  -- --------------------------------------------------------------------
  IF EXISTS (
    SELECT 1 FROM accounting_periods
    WHERE status = 'closed' AND CURRENT_DATE BETWEEN period_start AND period_end
  ) THEN
    RAISE EXCEPTION 'SMOKE_SETUP: CURRENT_DATE falls in a CLOSED accounting period - post_invoice cannot run today';
  END IF;

  SELECT id INTO v_admin FROM profiles
  WHERE role = 'admin' AND is_active = true
  ORDER BY created_at LIMIT 1;
  IF v_admin IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: no active admin profile found';
  END IF;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);

  -- --------------------------------------------------------------------
  -- S0. Grant-matrix probes (also guards against running pre-apply)
  -- --------------------------------------------------------------------
  IF has_function_privilege('authenticated', 'public.generate_rup_sales_records(uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: S0 authenticated still has EXECUTE - migration not applied yet (or REVOKE regressed)';
  END IF;
  IF has_function_privilege('anon', 'public.generate_rup_sales_records(uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: S0 anon has EXECUTE on generate_rup_sales_records';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.generate_rup_sales_records(uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: S0 service_role lost EXECUTE on generate_rup_sales_records';
  END IF;
  IF NOT has_function_privilege('postgres', 'public.generate_rup_sales_records(uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: S0 owner postgres lost EXECUTE on generate_rup_sales_records';
  END IF;
  SELECT count(*) INTO v_n
  FROM pg_proc p, aclexplode(p.proacl) a
  WHERE p.proname = 'generate_rup_sales_records'
    AND p.pronamespace = 'public'::regnamespace
    AND a.grantee = 0 AND a.privilege_type = 'EXECUTE';
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: S0 PUBLIC still has an EXECUTE acl entry';
  END IF;

  -- --------------------------------------------------------------------
  -- 0b. Synthetic [SMOKE] fixtures, as owner, BEFORE any role switch
  --     (a draft chemical_sale invoice with one RUP line + a valid license,
  --      so S3 exercises the 'compliant' branch end-to-end)
  -- --------------------------------------------------------------------
  INSERT INTO customers (farm_name)
  VALUES ('[SMOKE] RUP Revoke Farm ' || v_suffix)
  RETURNING id INTO v_customer;

  INSERT INTO products (product_name, is_rup, epa_registration, signal_word)
  VALUES ('[SMOKE] RUP Product ' || v_suffix, true, 'EPA-SMK-' || v_suffix, 'Warning')
  RETURNING id INTO v_product;

  v_lic_num := 'SMK-LIC-' || v_suffix;
  INSERT INTO applicator_licenses (customer_id, license_number, license_type, holder_name, expiry_date, is_active)
  VALUES (v_customer, v_lic_num, 'private', '[SMOKE] Holder ' || v_suffix, CURRENT_DATE + 365, true);

  INSERT INTO orders (order_number, customer_id, salesman_id)
  VALUES ('SMK-RUP-' || v_suffix, v_customer, v_admin)
  RETURNING id INTO v_order;

  INSERT INTO invoices (invoice_number, order_id, customer_id, invoice_type,
    status, total_amount_cents, invoice_date, created_by)
  VALUES ('SMK-RUP-INV-' || v_suffix, v_order, v_customer, 'chemical_sale',
    'draft', 5000, CURRENT_DATE, v_admin)
  RETURNING id INTO v_invoice;

  INSERT INTO invoice_items (invoice_id, product_id, description, quantity,
    unit_size, unit_price_cents, extended_cents)
  VALUES (v_invoice, v_product, '[SMOKE] RUP line ' || v_suffix, 10,
    'gal', 500, 5000);

  -- --------------------------------------------------------------------
  -- S1. authenticated (real role, real admin claims) direct call -> 42501
  -- --------------------------------------------------------------------
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM public.generate_rup_sales_records(v_invoice, NULL);
    RAISE EXCEPTION 'SMOKE_FAIL: S1 authenticated direct call was ALLOWED (expected 42501)';
  EXCEPTION
    WHEN insufficient_privilege THEN
      NULL; -- expected; sub-txn rollback also reverts the SET LOCAL ROLE
    WHEN OTHERS THEN
      IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
      RAISE EXCEPTION 'SMOKE_FAIL: S1 expected 42501 insufficient_privilege, got % (%)', SQLERRM, SQLSTATE;
  END;

  -- --------------------------------------------------------------------
  -- S2. anon (real role, anon claims) direct call -> 42501
  -- --------------------------------------------------------------------
  BEGIN
    PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
    SET LOCAL ROLE anon;
    PERFORM public.generate_rup_sales_records(v_invoice, NULL);
    RAISE EXCEPTION 'SMOKE_FAIL: S2 anon direct call was ALLOWED (expected 42501)';
  EXCEPTION
    WHEN insufficient_privilege THEN
      NULL; -- expected; rollback also restores the admin claims set in 0a
    WHEN OTHERS THEN
      IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
      RAISE EXCEPTION 'SMOKE_FAIL: S2 expected 42501 insufficient_privilege, got % (%)', SQLERRM, SQLSTATE;
  END;

  -- No-write assert: the two denied probes inserted NOTHING
  SELECT count(*) INTO v_n FROM rup_sales_records WHERE invoice_id = v_invoice;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: % rup_sales_records row(s) exist after denied probes - the grant gate is leaking writes', v_n;
  END IF;

  -- --------------------------------------------------------------------
  -- S3. The legit caller: post_invoice AS ROLE authenticated (real UI path).
  --     Its SECDEF body runs as owner postgres, so the internal
  --     generate_rup_sales_records call must still work post-revoke.
  -- --------------------------------------------------------------------
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM public.post_invoice(v_invoice, NULL);
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'SMOKE_FAIL: S3 post_invoice as authenticated/admin failed post-revoke: % (%)', SQLERRM, SQLSTATE;
  END;
  RESET ROLE; -- the successful sub-block's SET LOCAL ROLE persists; restore owner

  SELECT status, created_at INTO v_status, v_created FROM invoices WHERE id = v_invoice;
  IF v_status IS DISTINCT FROM 'posted' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: S3 invoice status = %, expected posted', v_status;
  END IF;

  SELECT count(*) INTO v_n FROM rup_sales_records WHERE invoice_id = v_invoice;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: S3 expected exactly 1 RUP row, found %', v_n;
  END IF;

  SELECT season, created_by, compliance_status, buyer_certification_number
  INTO v_row
  FROM rup_sales_records
  WHERE invoice_id = v_invoice AND product_id = v_product;
  v_season := CASE
    WHEN EXTRACT(MONTH FROM v_created) >= 10 THEN EXTRACT(YEAR FROM v_created)::int + 1
    ELSE EXTRACT(YEAR FROM v_created)::int
  END;
  IF v_row.created_by IS DISTINCT FROM v_admin
     OR v_row.compliance_status IS DISTINCT FROM 'compliant'
     OR v_row.buyer_certification_number IS DISTINCT FROM v_lic_num
     OR v_row.season IS DISTINCT FROM v_season THEN
    RAISE EXCEPTION 'SMOKE_FAIL: S3 RUP row wrong (created_by=%, compliance=%, cert=%, season=% vs expected %, %, %, %)',
      v_row.created_by, v_row.compliance_status, v_row.buyer_certification_number, v_row.season,
      v_admin, 'compliant', v_lic_num, v_season;
  END IF;

  -- --------------------------------------------------------------------
  -- S4. service_role REAL execution still works: re-run on the same invoice
  --     returns 0 (per-(invoice,product) NOT EXISTS dedup), proving EXECUTE.
  -- --------------------------------------------------------------------
  BEGIN
    SET LOCAL ROLE service_role;
    v_n := public.generate_rup_sales_records(v_invoice, NULL);
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'SMOKE_FAIL: S4 service_role call failed: % (%)', SQLERRM, SQLSTATE;
  END;
  RESET ROLE;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: S4 service_role re-run inserted % row(s), expected 0 (dedup)', v_n;
  END IF;

  -- --------------------------------------------------------------------
  -- All scenarios correct - force rollback of everything above.
  -- --------------------------------------------------------------------
  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END $smoke$;
