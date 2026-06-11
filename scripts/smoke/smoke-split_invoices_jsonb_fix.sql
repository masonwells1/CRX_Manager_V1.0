-- ============================================================================
-- ROLLED-BACK smoke test for scripts/.staging-migrations/split_invoices_jsonb_fix.sql
-- (create_split_invoices_from_order: idempotency_keys.result 42804 fix)
-- ----------------------------------------------------------------------------
-- HOW TO RUN: execute this whole file as a SINGLE statement (Supabase MCP
-- execute_sql, or psql -1) as postgres/service_role AFTER the migration is
-- applied. The block ALWAYS ends with RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK',
-- so every fixture, invoice, audit and idempotency row created here is
-- rolled back — nothing persists. Any other exception text = a real failure.
-- NOTE: run against the UNFIXED live body, scenario 2 fails with SQLSTATE
-- 42804 at the idempotency save line — that failure is the bug itself.
--
-- Auth: the fn writes invoices.created_by / activity_feed.performed_by from
-- auth.uid() (both NOT NULL), so a real active admin profile id is injected
-- via set_config('request.jwt.claims', ..., is_local => true). 3 active
-- admin profiles exist live as of 2026-06-10. Fixture INSERTs run as the
-- table owner (RLS bypassed); the RPC is SECURITY DEFINER.
--
-- Split source: the live fn reads splits via get_field_billing_splits_for_order
-- = orders -> quotes -> quote_sections(field_id) -> field_billing_defaults.
-- (No live function reads the order_shares table — it is frontend-display
-- data; fixtures therefore go through field_billing_defaults.)
--
-- Scenarios:
--   (1) fixture order whose quote section's field carries a 60/40
--       field_billing_defaults split -> create_split_invoices_from_order
--       -> exactly 2 draft split invoices, one group id, totals 9000/6000
--       cents (sum 15000 = the 150.00-dollar order, no penny lost).
--   (2) THE FIXED LINE (idempotency save): the call in (1) passed
--       p_idempotency_key, so the row in idempotency_keys must exist for
--       operation='create_split_invoices_from_order', be VALID jsonb of type
--       'string', and unwrap (#>> '{}') to exactly the returned id list.
--   (3) replay: calling AGAIN with the SAME key returns the IDENTICAL uuid[]
--       (the fixed read path: jsonb string -> bare text -> string_to_array)
--       and creates no additional invoices.
--
-- 42703 discipline — every table/column referenced below was dry-validated
-- against the live catalog on 2026-06-10 (57/57 found, 0 missing):
--   profiles(id, role, is_active, created_at)
--   customers(id, farm_name)
--   products(id, product_name, current_cost, tier1_price, unit_size)
--   fields(id, customer_id, field_name)
--   field_billing_defaults(field_id, customer_id, split_pct, is_primary)
--   quotes(id, quote_number, customer_id, created_by, status)
--   quote_sections(quote_id, section_name, sort_order, field_id)
--   orders(id, order_number, quote_id, customer_id, status)
--   order_items(id, order_id, product_id, product_name, price_per_unit,
--     cost_per_unit, total_units_needed, total_price, sort_order, unit_size)
--   invoices(id, order_id, customer_id, status, invoice_group_id,
--     total_amount_cents, invoice_type)
--   idempotency_keys(idempotency_key, operation, result)
--   activity_feed(event_type, related_entity_id, performed_by)
--   financial_audit_log(entity_id, operation_type)
-- Functions (signatures resolved via to_regprocedure):
--   create_split_invoices_from_order(uuid,uuid,text,text)
--   get_field_billing_splits_for_order(uuid)
--   create_invoice_from_order(uuid,uuid,text,text)   [delegate, not called here]
--   current_season()                                 [via invoices default path]
-- Constraint facts relied on: field_billing_defaults.split_pct CHECK 0<x<=100
--   (60/40 OK); orders.status default 'confirmed' and invoices 'draft' are in
--   their CHECK sets; financial_audit_log CHECKs include 'invoice_created' +
--   'invoice'; activity_feed.event_type has NO check constraint;
--   idempotency_keys.idempotency_key is UNIQUE.
-- ============================================================================

DO $smoke$
DECLARE
  v_admin uuid;
  v_cust_a uuid;
  v_cust_b uuid;
  v_product_id uuid;
  v_field_id uuid;
  v_quote_id uuid;
  v_order_id uuid;
  v_ids uuid[];
  v_ids2 uuid[];
  v_key text;
  v_suffix text := substr(md5(random()::text), 1, 8);
  v_count int;
  v_groups int;
  v_total bigint;
  v_total_a bigint;
  v_total_b bigint;
  v_result jsonb;
  v_feed int;
  v_audit int;
BEGIN
  -- --------------------------------------------------------------------
  -- 0. Auth as a real active admin (fn needs auth.uid() for NOT NULL
  --    created_by / performed_by writes)
  -- --------------------------------------------------------------------
  SELECT id INTO v_admin FROM profiles
  WHERE role = 'admin' AND is_active = true
  ORDER BY created_at LIMIT 1;
  IF v_admin IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: no active admin profile found';
  END IF;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);

  v_key := '[SMOKE] split-jsonb-' || v_suffix;

  -- --------------------------------------------------------------------
  -- 1. Synthetic fixtures (txn-local; rolled back at the end)
  --    Split chain: order -> quote -> section(field) -> billing defaults
  -- --------------------------------------------------------------------
  INSERT INTO customers (farm_name)
  VALUES ('[SMOKE] Split Farm A ' || v_suffix)
  RETURNING id INTO v_cust_a;

  INSERT INTO customers (farm_name)
  VALUES ('[SMOKE] Split Farm B ' || v_suffix)
  RETURNING id INTO v_cust_b;

  INSERT INTO products (product_name, current_cost, tier1_price, unit_size)
  VALUES ('[SMOKE] Split Product ' || v_suffix, 5, 10, 'gal')
  RETURNING id INTO v_product_id;

  INSERT INTO fields (customer_id, field_name)
  VALUES (v_cust_a, '[SMOKE] Split Field ' || v_suffix)
  RETURNING id INTO v_field_id;

  INSERT INTO field_billing_defaults (field_id, customer_id, split_pct, is_primary)
  VALUES (v_field_id, v_cust_a, 60, true);
  INSERT INTO field_billing_defaults (field_id, customer_id, split_pct, is_primary)
  VALUES (v_field_id, v_cust_b, 40, false);

  INSERT INTO quotes (quote_number, customer_id, created_by)
  VALUES ('[SMOKE] SPLITQ-' || v_suffix, v_cust_a, v_admin)
  RETURNING id INTO v_quote_id;

  INSERT INTO quote_sections (quote_id, section_name, sort_order, field_id)
  VALUES (v_quote_id, '[SMOKE] Split Section', 0, v_field_id);

  INSERT INTO orders (order_number, quote_id, customer_id)
  VALUES ('[SMOKE] SPLITO-' || v_suffix, v_quote_id, v_cust_a)
  RETURNING id INTO v_order_id;

  -- Two items: 10 x $10 = $100 and 5 x $10 = $50 -> order total $150.00.
  -- Expected split cents: A(60%) 6000+3000=9000, B(40%) 4000+2000=6000.
  INSERT INTO order_items (order_id, product_id, product_name, price_per_unit,
    cost_per_unit, total_units_needed, total_price, unit_size, sort_order)
  VALUES (v_order_id, v_product_id, '[SMOKE] Split Product ' || v_suffix,
    10, 5, 10, 100, 'gal', 1);
  INSERT INTO order_items (order_id, product_id, product_name, price_per_unit,
    cost_per_unit, total_units_needed, total_price, unit_size, sort_order)
  VALUES (v_order_id, v_product_id, '[SMOKE] Split Product ' || v_suffix,
    10, 5, 5, 50, 'gal', 2);

  -- Setup sanity: the split helper must see both billing-default rows
  SELECT count(*) INTO v_count FROM get_field_billing_splits_for_order(v_order_id);
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'SMOKE_SETUP: expected 2 billing splits visible, got %', v_count;
  END IF;

  -- --------------------------------------------------------------------
  -- (1) Split invoices created (first call, WITH idempotency key)
  -- --------------------------------------------------------------------
  v_ids := create_split_invoices_from_order(v_order_id, NULL, 'chemical_sale', v_key);
  IF v_ids IS NULL OR array_length(v_ids, 1) <> 2 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (1) expected 2 split invoice ids, got %', v_ids;
  END IF;

  SELECT count(*), count(DISTINCT invoice_group_id)
  INTO v_count, v_groups
  FROM invoices WHERE order_id = v_order_id AND status = 'draft';
  IF v_count <> 2 OR v_groups <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (1) expected 2 draft invoices in 1 group, got % in % group(s)', v_count, v_groups;
  END IF;

  SELECT sum(total_amount_cents) INTO v_total FROM invoices WHERE order_id = v_order_id;
  SELECT total_amount_cents INTO v_total_a FROM invoices WHERE order_id = v_order_id AND customer_id = v_cust_a;
  SELECT total_amount_cents INTO v_total_b FROM invoices WHERE order_id = v_order_id AND customer_id = v_cust_b;
  IF v_total IS DISTINCT FROM 15000 OR v_total_a IS DISTINCT FROM 9000 OR v_total_b IS DISTINCT FROM 6000 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (1) split totals wrong: sum=%, a=%, b=% (expected 15000/9000/6000)', v_total, v_total_a, v_total_b;
  END IF;

  SELECT count(*) INTO v_audit FROM financial_audit_log
  WHERE operation_type = 'invoice_created' AND entity_id = ANY(v_ids);
  IF v_audit <> 2 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (1) expected 2 invoice_created audit rows, got %', v_audit;
  END IF;

  SELECT count(*) INTO v_feed FROM activity_feed
  WHERE event_type = 'split_invoices_created' AND related_entity_id = v_order_id;
  IF v_feed <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (1) expected 1 split_invoices_created feed row, got %', v_feed;
  END IF;

  -- --------------------------------------------------------------------
  -- (2) THE FIXED LINE executed: idempotency save wrote VALID jsonb
  --     (on the unfixed body this point is never reached — the call in (1)
  --     dies with 42804 at this exact INSERT)
  -- --------------------------------------------------------------------
  SELECT result INTO v_result FROM idempotency_keys
  WHERE idempotency_key = v_key AND operation = 'create_split_invoices_from_order';
  IF v_result IS NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (2) idempotency save path did not run (no idempotency_keys row for the key)';
  END IF;
  IF jsonb_typeof(v_result) <> 'string'
     OR (v_result #>> '{}') IS DISTINCT FROM array_to_string(v_ids, ',') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (2) idempotency result malformed: % (expected jsonb string of %)', v_result, array_to_string(v_ids, ',');
  END IF;

  -- --------------------------------------------------------------------
  -- (3) Replay with the SAME key: identical uuid[] back, nothing new created
  -- --------------------------------------------------------------------
  v_ids2 := create_split_invoices_from_order(v_order_id, NULL, 'chemical_sale', v_key);
  IF v_ids2 IS DISTINCT FROM v_ids THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (3) replay returned % (expected cached %)', v_ids2, v_ids;
  END IF;

  SELECT count(*) INTO v_count FROM invoices WHERE order_id = v_order_id;
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (3) replay created extra invoices: % total for the order', v_count;
  END IF;

  SELECT count(*) INTO v_count FROM idempotency_keys WHERE idempotency_key = v_key;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (3) expected exactly 1 idempotency row for the key, got %', v_count;
  END IF;

  -- --------------------------------------------------------------------
  -- All scenarios passed — force rollback of everything above.
  -- --------------------------------------------------------------------
  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END $smoke$;
