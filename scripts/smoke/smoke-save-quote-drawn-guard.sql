-- ============================================================================
-- ROLLED-BACK smoke test for 20260610190100_save_quote_drawn_product_guard
-- ----------------------------------------------------------------------------
-- Verifies the drawn-product guard in save_quote (finding A4): a partially-
-- drawn booking cannot be edited below — or out of — its drawn history.
--
-- HOW TO RUN: execute this whole file as a SINGLE statement (Supabase MCP
-- execute_sql, or psql -1) as postgres after the migration under test is
-- applied. Once the pending 20260819232000 cutover is also present, the draw
-- wrapper is authenticated-only and service_role cannot execute it. The block
-- ALWAYS ends with RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK',
-- so every fixture, order, ledger row and audit row created here is rolled
-- back — nothing persists. Any other exception text = a real failure.
--
-- Auth: SECURITY DEFINER RPCs derive the actor from auth.uid(), which reads
-- request.jwt.claims — injected below via set_config(..., is_local => true)
-- using a real active admin profile id (3 exist live as of 2026-06-10).
-- Direct fixture INSERTs bypass RLS because we run as the table owner; the
-- RPCs under test still enforce their own auth/role gates.
--
-- Scenarios (per the A4 fix spec):
--   (a) quote booked 500, draw 200, save_quote reducing the product to 100
--       -> must raise BOOKING_OVERDRAWN ('cannot reduce ...')
--   (b) same quote, save_quote removing the product entirely
--       -> must raise BOOKING_OVERDRAWN ('cannot remove ...')
--   (c) same quote, save_quote keeping the product at 400 (>= 200 drawn)
--       -> succeeds; ledger stays drawn=200; drawing 200 more then flips the
--          booking to 'accepted' at the new 400 total (fully-drawn calc works)
--   (d) control: a quote with NO draws saves freely (reduce + remove both OK)
--
-- Fixture shape mirrors QuoteBuilder.tsx's rpc('save_quote') payload
-- (src/pages/QuoteBuilder.tsx ~line 865): p_quote_payload jsonb,
-- p_sections jsonb array of {section_name, sort_order, items:[...]}.
-- calc_mode 'units_direct' is used so the server recalc keeps
-- total_units_needed equal to the submitted quantity (booked totals are
-- deterministic). commission_split '{"splits": []}'::jsonb per quotes schema.
-- ============================================================================

DO $smoke$
DECLARE
  v_admin uuid;
  v_customer_id uuid;
  v_product_id uuid;
  v_quote_id uuid;
  v_quote_b_id uuid;
  v_quote_version bigint;
  v_quote_b_version bigint;
  v_res jsonb;
  v_err text;
  v_booked numeric;
  v_drawn numeric;
  v_status text;
  v_orders int;
  v_suffix text := substr(md5(random()::text), 1, 8);
  v_item_base jsonb;
  v_payload jsonb;
  v_sections jsonb;
BEGIN
  -- --------------------------------------------------------------------
  -- 0. Auth as a real active admin
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

  -- --------------------------------------------------------------------
  -- 1. Synthetic fixtures (txn-local; rolled back at the end)
  -- --------------------------------------------------------------------
  INSERT INTO customers (farm_name)
  VALUES ('[SMOKE] Drawn Guard Farm ' || v_suffix)
  RETURNING id INTO v_customer_id;

  -- Establish the cost through the governed pricing path so the real immutable
  -- quote-cost snapshot remains enabled during this rollback-only smoke.
  INSERT INTO products (product_name, unit_size)
  VALUES ('[SMOKE] Drawn Guard Product ' || v_suffix, 'gal')
  RETURNING id INTO v_product_id;
  v_res := preview_product_pricing_changes(
    'product_page', NULL,
    jsonb_build_array(jsonb_build_object(
      'product_id', v_product_id,
      'row_version', (SELECT pricing_version FROM products WHERE id = v_product_id),
      'pricing_mode', 'margin_driven',
      'new_cost', '6.00',
      'tier1_margin_percent', '20',
      'tier2_margin_percent', '25',
      'tier3_margin_percent', '30',
      'change_reason', 'Rollback smoke save-quote fixture setup'
    )),
    v_admin, 'smk-sqdg-price-preview-' || v_suffix
  );
  PERFORM apply_product_pricing_change_set(
    (v_res->>'change_set_id')::uuid,
    v_res->>'request_fingerprint',
    v_admin,
    'smk-sqdg-price-apply-' || v_suffix
  );

  v_item_base := jsonb_build_object(
    'product_id', v_product_id,
    'sort_order', 0,
    'notes', null,
    'calc_mode', 'units_direct',
    'total_units_needed', 0,
    'price_override', 10,
    'price_per_unit', 10,
    'current_cost', 5,
    'unit_size', 'gal',
    'acres', 0
  );

  -- --------------------------------------------------------------------
  -- 2. Quote A: create draft @500, flip to sent (an open booking)
  -- --------------------------------------------------------------------
  v_payload := jsonb_build_object(
    'quote_number', '[SMOKE] QG-' || v_suffix,
    'customer_id', v_customer_id,
    'status', 'draft',
    'tier', 1,
    'commission_split', '{"splits": []}'::jsonb
  );
  v_sections := jsonb_build_array(jsonb_build_object(
    'section_name', 'Smoke Section', 'sort_order', 0,
    'items', jsonb_build_array(
      jsonb_set(v_item_base, '{total_units_needed}', to_jsonb(500)))));

  v_res := save_quote(NULL, v_payload, v_sections, v_admin, NULL);
  IF v_res->>'status' IS DISTINCT FROM 'saved' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: create draft returned %', v_res;
  END IF;
  v_quote_id := (v_res->>'quote_id')::uuid;
  v_quote_version := (v_res->>'row_version')::bigint;

  v_payload := v_payload || jsonb_build_object(
    'status', 'sent',
    'row_version_expected', v_quote_version
  );
  v_res := save_quote(v_quote_id, v_payload, v_sections, v_admin, NULL);
  v_quote_version := (v_res->>'row_version')::bigint;

  SELECT status INTO v_status FROM quotes WHERE id = v_quote_id;
  SELECT COALESCE(SUM(total_units_needed), 0) INTO v_booked
  FROM quote_items WHERE quote_id = v_quote_id AND product_id = v_product_id;
  IF v_status <> 'sent' OR v_booked <> 500 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: setup expected sent/500, got %/%', v_status, v_booked;
  END IF;

  -- --------------------------------------------------------------------
  -- 3. Draw 200 of 500 (partial — booking stays open)
  -- --------------------------------------------------------------------
  v_res := draw_down_quote(v_quote_id,
    jsonb_build_array(jsonb_build_object('product_id', v_product_id, 'quantity', 200)),
    v_admin, 'smk-sqdg-first-' || v_suffix);
  IF (v_res->>'fully_drawn')::boolean IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'SMOKE_FAIL: draw 200/500 reported fully_drawn: %', v_res;
  END IF;
  -- Re-read the token after draw_down_quote. Converting the whole row to JSON
  -- keeps this smoke compatible before the row_version column exists.
  SELECT (to_jsonb(q)->>'row_version')::bigint INTO v_quote_version
  FROM quotes q WHERE id = v_quote_id;
  v_payload := v_payload || jsonb_build_object('row_version_expected', v_quote_version);
  SELECT quantity_drawn INTO v_drawn FROM quote_product_draws
  WHERE quote_id = v_quote_id AND product_id = v_product_id;
  SELECT status INTO v_status FROM quotes WHERE id = v_quote_id;
  IF COALESCE(v_drawn, 0) <> 200 OR v_status <> 'sent' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: after draw expected drawn=200/status=sent, got %/%', v_drawn, v_status;
  END IF;

  -- --------------------------------------------------------------------
  -- (a) Reduce drawn product 500 -> 100 (< 200 drawn): must be BLOCKED
  -- --------------------------------------------------------------------
  BEGIN
    v_sections := jsonb_build_array(jsonb_build_object(
      'section_name', 'Smoke Section', 'sort_order', 0,
      'items', jsonb_build_array(
        jsonb_set(v_item_base, '{total_units_needed}', to_jsonb(100)))));
    PERFORM save_quote(v_quote_id, v_payload, v_sections, v_admin, NULL);
    RAISE EXCEPTION 'SMOKE_FAIL: (a) reducing below drawn quantity was ALLOWED';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'BOOKING_OVERDRAWN: cannot reduce%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: (a) expected BOOKING_OVERDRAWN cannot-reduce, got: %', v_err;
    END IF;
  END;
  -- Sub-txn rollback must leave the booking intact
  SELECT COALESCE(SUM(total_units_needed), 0) INTO v_booked
  FROM quote_items WHERE quote_id = v_quote_id AND product_id = v_product_id;
  IF v_booked <> 500 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (a) booking not restored after block, booked=%', v_booked;
  END IF;

  -- --------------------------------------------------------------------
  -- (b) Remove the drawn product entirely: must be BLOCKED
  -- --------------------------------------------------------------------
  BEGIN
    PERFORM save_quote(v_quote_id, v_payload, '[]'::jsonb, v_admin, NULL);
    RAISE EXCEPTION 'SMOKE_FAIL: (b) removing a drawn product was ALLOWED';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'BOOKING_OVERDRAWN: cannot remove%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: (b) expected BOOKING_OVERDRAWN cannot-remove, got: %', v_err;
    END IF;
  END;
  SELECT COALESCE(SUM(total_units_needed), 0) INTO v_booked
  FROM quote_items WHERE quote_id = v_quote_id AND product_id = v_product_id;
  SELECT quantity_drawn INTO v_drawn FROM quote_product_draws
  WHERE quote_id = v_quote_id AND product_id = v_product_id;
  IF v_booked <> 500 OR COALESCE(v_drawn, 0) <> 200 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (b) state corrupted after block: booked=%, drawn=%', v_booked, v_drawn;
  END IF;

  -- --------------------------------------------------------------------
  -- (c) Reduce 500 -> 400 (>= 200 drawn): ALLOWED; booking stays consistent;
  --     drawing the remaining 200 then closes the booking at the new total
  -- --------------------------------------------------------------------
  v_sections := jsonb_build_array(jsonb_build_object(
    'section_name', 'Smoke Section', 'sort_order', 0,
    'items', jsonb_build_array(
      jsonb_set(v_item_base, '{total_units_needed}', to_jsonb(400)))));
  v_res := save_quote(v_quote_id, v_payload, v_sections, v_admin, NULL);
  v_quote_version := (v_res->>'row_version')::bigint;

  SELECT COALESCE(SUM(total_units_needed), 0) INTO v_booked
  FROM quote_items WHERE quote_id = v_quote_id AND product_id = v_product_id;
  SELECT quantity_drawn INTO v_drawn FROM quote_product_draws
  WHERE quote_id = v_quote_id AND product_id = v_product_id;
  SELECT status INTO v_status FROM quotes WHERE id = v_quote_id;
  IF v_booked <> 400 OR COALESCE(v_drawn, 0) <> 200 OR v_status <> 'sent' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (c) after legal reduce expected 400/200/sent, got %/%/%',
      v_booked, v_drawn, v_status;
  END IF;

  v_res := draw_down_quote(v_quote_id,
    jsonb_build_array(jsonb_build_object('product_id', v_product_id, 'quantity', 200)),
    v_admin, 'smk-sqdg-final-' || v_suffix);
  IF (v_res->>'fully_drawn')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (c) draw to 400/400 not reported fully drawn: %', v_res;
  END IF;
  SELECT status INTO v_status FROM quotes WHERE id = v_quote_id;
  SELECT quantity_drawn INTO v_drawn FROM quote_product_draws
  WHERE quote_id = v_quote_id AND product_id = v_product_id;
  SELECT count(*) INTO v_orders FROM orders WHERE quote_id = v_quote_id;
  IF v_status <> 'accepted' OR v_drawn <> 400 OR v_orders <> 2 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (c) final expected accepted/400/2 orders, got %/%/%',
      v_status, v_drawn, v_orders;
  END IF;

  -- --------------------------------------------------------------------
  -- (d) Control: a quote with NO draws saves freely
  -- --------------------------------------------------------------------
  v_payload := jsonb_build_object(
    'quote_number', '[SMOKE] QG-CTRL-' || v_suffix,
    'customer_id', v_customer_id,
    'status', 'draft',
    'tier', 1,
    'commission_split', '{"splits": []}'::jsonb
  );
  v_sections := jsonb_build_array(jsonb_build_object(
    'section_name', 'Smoke Section', 'sort_order', 0,
    'items', jsonb_build_array(
      jsonb_set(v_item_base, '{total_units_needed}', to_jsonb(300)))));
  v_res := save_quote(NULL, v_payload, v_sections, v_admin, NULL);
  v_quote_b_id := (v_res->>'quote_id')::uuid;
  v_quote_b_version := (v_res->>'row_version')::bigint;
  v_payload := v_payload || jsonb_build_object(
    'status', 'sent',
    'row_version_expected', v_quote_b_version
  );
  v_res := save_quote(v_quote_b_id, v_payload, v_sections, v_admin, NULL);
  v_quote_b_version := (v_res->>'row_version')::bigint;

  -- reduce 300 -> 50: allowed (no draws)
  v_sections := jsonb_build_array(jsonb_build_object(
    'section_name', 'Smoke Section', 'sort_order', 0,
    'items', jsonb_build_array(
      jsonb_set(v_item_base, '{total_units_needed}', to_jsonb(50)))));
  v_payload := v_payload || jsonb_build_object('row_version_expected', v_quote_b_version);
  v_res := save_quote(v_quote_b_id, v_payload, v_sections, v_admin, NULL);
  v_quote_b_version := (v_res->>'row_version')::bigint;
  SELECT COALESCE(SUM(total_units_needed), 0) INTO v_booked
  FROM quote_items WHERE quote_id = v_quote_b_id AND product_id = v_product_id;
  IF v_booked <> 50 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (d) control reduce blocked or wrong, booked=%', v_booked;
  END IF;

  -- remove entirely: also allowed (no draws)
  v_payload := v_payload || jsonb_build_object('row_version_expected', v_quote_b_version);
  v_res := save_quote(v_quote_b_id, v_payload, '[]'::jsonb, v_admin, NULL);
  v_quote_b_version := (v_res->>'row_version')::bigint;
  SELECT COALESCE(SUM(total_units_needed), 0) INTO v_booked
  FROM quote_items WHERE quote_id = v_quote_b_id;
  IF v_booked <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (d) control remove blocked or wrong, booked=%', v_booked;
  END IF;

  -- --------------------------------------------------------------------
  -- All scenarios passed — force rollback of everything above.
  -- --------------------------------------------------------------------
  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END $smoke$;
