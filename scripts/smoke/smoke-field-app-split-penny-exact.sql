-- ============================================================================
-- SMOKE TEST (rolled back by design): section #26 — auto-split one job into
-- per-customer invoices by share. Proves the EXISTING split engine
-- (save_field_app_invoice + preview_field_app_invoice_split) is penny-exact and
-- idempotent. No migration in #26; this is a behavior proof of the live engine.
-- ----------------------------------------------------------------------------
-- Proves:
--   P1  — a multi-customer field produces ONE invoice PER billing customer,
--          linked by a shared invoice_group_id (separate invoices, not one
--          grouped invoice).
--   P2  — PENNY-EXACT: SUM(per-customer invoices.total_amount_cents) equals the
--          preview grand_total_cents EXACTLY, including an INDIVISIBLE total
--          (the per-customer pieces individually round, yet the sum is exact
--          because each customer is computed independently — no remainder lost).
--   P3  — invoice_shares.amount_cents per customer ties to that customer's
--          invoice total (statements read invoice_shares).
--   P4  — ACRE conservation: SUM(per-customer share acres) == total applied acres.
--   P5  — IDEMPOTENT: re-running save with the SAME idempotency key does NOT
--          create a second set of invoices (no double-split on a double-click).
--   P6  — SAVE/POST SERIALIZATION: the public save owns a row-lock/recheck
--          wrapper, and a save attempted after real group posting is rejected
--          before any invoice child rows are rebuilt.
--   P7  — GROUP DUE DATES: system dates on both members are replaced from the
--          common Chicago posting date using each customer's invoice terms.
--
-- Ends in RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK'.
-- ============================================================================
DO $smoke$
DECLARE
  v_admin uuid;
  v_sfx   text := substr(gen_random_uuid()::text,1,8);
  v_chicago_posting_date date := (now() AT TIME ZONE 'America/Chicago')::date;
  v_cust_a uuid; v_cust_b uuid;
  v_field uuid;
  v_prod uuid;
  v_idem text := 'smoke-split-'||v_sfx;
  v_preview jsonb;
  v_grand bigint;
  v_pc_count int;
  v_save jsonb;
  v_ids uuid[];
  v_ids2 uuid[];
  v_group uuid;
  v_sum bigint;
  v_share_sum bigint;
  v_acres numeric;
  v_locations jsonb;
  v_chemicals jsonb;
  v_inv_count int;
  v_item_count int;
  v_item_count_after int;
  v_err text;
  v_save_source text;
  v_post_group_source text;
BEGIN
  SELECT id INTO v_admin FROM profiles WHERE role='admin' AND is_active=true ORDER BY created_at LIMIT 1;
  IF v_admin IS NULL THEN RAISE EXCEPTION 'SMOKE_SETUP: no admin'; END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role','authenticated')::text, true);

  -- Two billing customers + one shared field split 1/3 (A) / 2/3 (B).
  INSERT INTO customers (farm_name, assigned_tier) VALUES ('[SMOKE] Split A '||v_sfx, 1) RETURNING id INTO v_cust_a;
  INSERT INTO customers (farm_name, assigned_tier) VALUES ('[SMOKE] Split B '||v_sfx, 1) RETURNING id INTO v_cust_b;

  -- Field owned by A; billing split defaults give A 33.3333% and B 66.6667%.
  INSERT INTO fields (field_name, customer_id, total_acres)
    VALUES ('[SMOKE] Split Field '||v_sfx, v_cust_a, 100.02) RETURNING id INTO v_field;
  INSERT INTO field_billing_defaults (field_id, customer_id, split_pct, is_primary)
    VALUES (v_field, v_cust_a, 33.3333, true);
  INSERT INTO field_billing_defaults (field_id, customer_id, split_pct, is_primary)
    VALUES (v_field, v_cust_b, 66.6667, false);

  -- A product with a manual-override unit price chosen so the grand total lands on
  -- an ODD cent count that does NOT divide evenly across the two customers. The
  -- engine computes each customer's line as ROUND(unit_price_cents * rate * share_acres).
  INSERT INTO products (product_name, unit_size, current_cost, tier1_price)
    VALUES ('[SMOKE] Split Prod '||v_sfx, 'gal', 1.00, 10.00) RETURNING id INTO v_prod;

  -- One location: applied 100.02 ac. Shares: A = 33.3333% of 100.02 = 33.339...,
  -- B = 66.6667% of 100.02 = 66.68... The chemical rate 1.0/ac at a manual unit
  -- price of $10.0003 (100003 c... not integer) is impossible; instead use an
  -- override price of 30001 cents/unit at rate 0.001/ac so per-customer cents are
  -- fractional and round independently.
  v_locations := jsonb_build_array(jsonb_build_object(
    'field_id', v_field, 'map_number', 1,
    'total_acres', 100.02, 'planted_acres', NULL,
    'applied_acres', 100.02, 'crop_type', NULL,
    'wind_direction', NULL, 'sort_order', 0
  ));
  -- price 1501c/unit, rate 0.01/ac chosen so the two customers round INDEPENDENTLY
  -- to an ODD, indivisible-by-2 grand total: A = ROUND(1501*0.01*33.34)=500,
  -- B = ROUND(1501*0.01*66.68)=1001, SUM = 1501 (odd). B rounds up from 1000.68 on
  -- its own; the engine never divides 1501, so the sum is exact by construction.
  v_chemicals := jsonb_build_array(jsonb_build_object(
    'product_id', v_prod, 'description', 'Split Chem',
    'quantity', 0, 'unit_size', 'gal',
    'unit_price_cents', 1501, 'cost_cents', 0, 'sort_order', 0,
    'rate_per_acre', 0.01, 'rate_unit', 'gal',
    'manual_override', true
  ));

  -- PREVIEW first (server source of truth for the grand total + customer count).
  v_preview := preview_field_app_invoice_split(v_locations, v_chemicals, NULL, NULL);
  v_grand   := (v_preview->>'grand_total_cents')::bigint;
  v_pc_count := (v_preview->>'customer_count')::int;
  IF v_pc_count <> 2 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: expected 2 customers in preview, got %', v_pc_count;
  END IF;
  IF v_grand <= 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: preview grand total non-positive (%)', v_grand;
  END IF;

  -- SAVE = create the separate per-customer invoices (the real split engine).
  v_save := save_field_app_invoice(
    NULL,
    jsonb_build_object('invoice_date', CURRENT_DATE::text, 'header_notes', '[SMOKE] split'),
    v_locations, v_chemicals, v_admin, NULL, v_idem
  );
  v_ids   := ARRAY(SELECT (jsonb_array_elements_text(v_save->'invoice_ids'))::uuid);
  v_group := (v_save->>'invoice_group_id')::uuid;

  -- P1: one invoice per customer, sharing a group id.
  IF array_length(v_ids,1) <> 2 THEN
    RAISE EXCEPTION 'SMOKE_FAIL(P1): expected 2 separate invoices, got %', array_length(v_ids,1);
  END IF;
  IF v_group IS NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL(P1): split invoices have no invoice_group_id';
  END IF;
  SELECT count(*) INTO v_inv_count FROM invoices WHERE invoice_group_id = v_group AND deleted_at IS NULL;
  IF v_inv_count <> 2 THEN
    RAISE EXCEPTION 'SMOKE_FAIL(P1): group has % live invoices (exp 2)', v_inv_count;
  END IF;
  -- distinct customers, one each
  IF (SELECT count(DISTINCT customer_id) FROM invoices WHERE invoice_group_id = v_group) <> 2 THEN
    RAISE EXCEPTION 'SMOKE_FAIL(P1): split invoices are not one-per-customer';
  END IF;

  -- P2: PENNY-EXACT — the sum of the separate invoice totals equals the preview
  -- grand total to the CENT, even though the customer pieces individually round.
  SELECT COALESCE(SUM(total_amount_cents),0) INTO v_sum
    FROM invoices WHERE invoice_group_id = v_group AND deleted_at IS NULL;
  IF v_sum <> v_grand THEN
    RAISE EXCEPTION 'SMOKE_FAIL(P2): split totals % do NOT equal preview grand total % (penny drift!)', v_sum, v_grand;
  END IF;
  -- The total MUST be indivisible-by-2 so this is a real penny test: the per-
  -- customer pieces round independently (B rounds up from x.68) yet the sum is
  -- exact. An even total would be a weaker test, so assert odd here.
  IF v_grand % 2 = 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL(P2 setup): grand total % is even — not an indivisible penny test', v_grand;
  END IF;

  -- P3: each customer's invoice_shares.amount_cents ties to that customer's invoice total.
  SELECT COALESCE(SUM(s.amount_cents),0) INTO v_share_sum
    FROM invoice_shares s
    JOIN invoices i ON i.id = s.invoice_id
   WHERE i.invoice_group_id = v_group AND i.deleted_at IS NULL;
  IF v_share_sum <> v_grand THEN
    RAISE EXCEPTION 'SMOKE_FAIL(P3): invoice_shares sum % != grand total % (statements would not tie)', v_share_sum, v_grand;
  END IF;
  -- per invoice: share total == invoice total
  IF EXISTS (
    SELECT 1 FROM invoices i
     WHERE i.invoice_group_id = v_group AND i.deleted_at IS NULL
       AND i.total_amount_cents <> (SELECT COALESCE(SUM(amount_cents),0) FROM invoice_shares s WHERE s.invoice_id = i.id)
  ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL(P3): a per-customer invoice total does not match its shares';
  END IF;

  -- P4: acre conservation — per-customer share acres sum to the applied acres (100.02).
  SELECT COALESCE(SUM(s.acres),0) INTO v_acres
    FROM invoice_shares s
    JOIN invoices i ON i.id = s.invoice_id
   WHERE i.invoice_group_id = v_group AND i.deleted_at IS NULL;
  IF round(v_acres, 2) <> 100.02 THEN
    RAISE EXCEPTION 'SMOKE_FAIL(P4): split acres % != applied acres 100.02 (acre drift)', v_acres;
  END IF;

  -- P5: IDEMPOTENT — same idempotency key returns the SAME invoice ids and creates
  -- no second set (no double-split on a double-click).
  v_save := save_field_app_invoice(
    NULL,
    jsonb_build_object('invoice_date', CURRENT_DATE::text, 'header_notes', '[SMOKE] split'),
    v_locations, v_chemicals, v_admin, NULL, v_idem
  );
  v_ids2 := ARRAY(SELECT (jsonb_array_elements_text(v_save->'invoice_ids'))::uuid);
  IF v_ids2 IS DISTINCT FROM v_ids THEN
    RAISE EXCEPTION 'SMOKE_FAIL(P5): idempotent re-run returned different invoice ids (double-split risk)';
  END IF;
  -- still only the live group invoices exist for these two customers
  SELECT count(*) INTO v_inv_count
    FROM invoices
   WHERE customer_id IN (v_cust_a, v_cust_b)
     AND invoice_type = 'field_application'
     AND deleted_at IS NULL;
  IF v_inv_count <> 2 THEN
    RAISE EXCEPTION 'SMOKE_FAIL(P5): double-split created % invoices for the two customers (exp 2)', v_inv_count;
  END IF;

  -- P6: use the real posting path, then prove a later save is rejected without
  -- deleting/rebuilding any invoice lines. The catalog assertions pin the
  -- concurrency mechanism itself because a single SQL session cannot interleave
  -- two transactions deterministically.
  SELECT prosrc INTO v_save_source
  FROM pg_proc
  WHERE oid = 'public.save_field_app_invoice(uuid,jsonb,jsonb,jsonb,uuid,uuid,text)'::regprocedure;
  IF v_save_source NOT LIKE '%FOR UPDATE%'
     OR v_save_source NOT LIKE '%LIMIT 1%'
     OR v_save_source NOT LIKE '%v_locked_status NOT IN%'
     OR v_save_source NOT LIKE '%_save_field_app_invoice_impl_20260714%' THEN
    RAISE EXCEPTION 'SMOKE_FAIL(P6): public save lost its lock/recheck wrapper';
  END IF;
  IF has_function_privilege(
       'authenticated',
       'public._save_field_app_invoice_impl_20260714(uuid,jsonb,jsonb,jsonb,uuid,uuid,text)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL(P6): authenticated can bypass the save lock wrapper';
  END IF;
  SELECT prosrc INTO v_post_group_source
  FROM pg_proc
  WHERE oid = 'public.post_invoice_group(uuid,uuid,text)'::regprocedure;
  IF v_post_group_source NOT LIKE '%LIMIT 1%'
     OR v_post_group_source NOT LIKE '%ORDER BY id%'
     OR v_post_group_source NOT LIKE '%FOR UPDATE%'
     OR v_post_group_source NOT LIKE '%check_idempotency%'
     OR v_post_group_source NOT LIKE '%_post_invoice_impl_20260714%' THEN
    RAISE EXCEPTION 'SMOKE_FAIL(P6): group post lost anchor/ordered locking';
  END IF;

  BEGIN
    PERFORM post_invoice(v_ids[1], 'smoke-split-direct-post-' || v_sfx);
    RAISE EXCEPTION 'SMOKE_FAIL(P6): one split-group member posted directly';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'GROUP_POST_REQUIRED%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL(P6): wrong direct group-member post error: %', v_err;
    END IF;
  END;

  UPDATE invoices
     SET payment_terms = CASE customer_id
           WHEN v_cust_a THEN 'Net 15'
           ELSE 'Net 45'
         END,
         due_date = invoice_date + 30,
         due_date_source = 'system'
   WHERE id = ANY(v_ids);

  PERFORM post_invoice_group(v_group, v_admin, 'smoke-split-post-' || v_sfx);
  IF EXISTS (
    SELECT 1
      FROM invoices
     WHERE id = ANY(v_ids)
       AND (
         due_date_source IS DISTINCT FROM 'system'
         OR due_date IS DISTINCT FROM (
           v_chicago_posting_date
           + CASE customer_id WHEN v_cust_a THEN 15 ELSE 45 END
         )
       )
  ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL(P7): group posting did not derive each system due date from Chicago posting date and terms';
  END IF;
  SELECT count(*) INTO v_item_count
  FROM invoice_items
  WHERE invoice_id = ANY(v_ids);

  BEGIN
    PERFORM save_field_app_invoice(
      v_ids[1],
      jsonb_build_object('invoice_date', CURRENT_DATE::text, 'header_notes', '[SMOKE] late save'),
      v_locations, v_chemicals, v_admin, NULL, 'smoke-split-late-save-' || v_sfx
    );
    RAISE EXCEPTION 'SMOKE_FAIL(P6): save succeeded after group posting';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'Cannot edit field app invoice with status:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL(P6): wrong post-then-save error: %', v_err;
    END IF;
  END;

  SELECT count(*) INTO v_item_count_after
  FROM invoice_items
  WHERE invoice_id = ANY(v_ids);
  IF v_item_count_after IS DISTINCT FROM v_item_count THEN
    RAISE EXCEPTION 'SMOKE_FAIL(P6): rejected late save changed invoice items from % to %',
      v_item_count, v_item_count_after;
  END IF;

  RAISE NOTICE 'SMOKE OK: 2 invoices, grand=% c, sum=% c, shares=% c, acres=%, idempotent, save/post locked', v_grand, v_sum, v_share_sum, v_acres;
  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END $smoke$;
