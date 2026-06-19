-- ============================================================================
-- SMOKE TEST (rolled back by design): save_invoice field-application aware
-- — migration 20260619160000 (#3 edit-path).
-- ----------------------------------------------------------------------------
-- Run AFTER applying 20260619160000. Pre-apply it FAILS. Pre-apply validation
-- (2026-06-19): the new body was stacked in a rolled-back txn with this DO block
-- -> SMOKE_PASS_ROLLBACK.
--
-- Proves:
--   DELTA-A  — editing a field_application invoice PRESERVES the is_application_fee
--              machine-fee line (it does not become a normal line).
--   DELTA-A2 — the fee line's EXACT extended_cents is honored on save (a no-op
--              save does NOT drift it by a rounding cent even when the fee's
--              quantity x blended-unit-price != the exact total). Codex final.
--   DELTA-B  — the per-grower invoice_shares re-balance to the new edited total.
--   GUARD    — a chemical_sale invoice's shares are NOT touched (field-only).
--
-- Ends in RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK'.
-- ============================================================================
DO $smoke$
DECLARE
  v_admin uuid; v_sfx text := substr(gen_random_uuid()::text,1,8); v_cust uuid; v_prod uuid;
  v_inv uuid; v_chem_inv uuid; v_inv3 uuid; v_cust2 uuid; v_fee_flag boolean; v_share_amt bigint; v_inv_total bigint; v_fee_ext bigint; v_a bigint; v_b bigint;
BEGIN
  SELECT id INTO v_admin FROM profiles WHERE role='admin' AND is_active=true ORDER BY created_at LIMIT 1;
  IF v_admin IS NULL THEN RAISE EXCEPTION 'SMOKE_SETUP: no admin'; END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role','authenticated')::text, true);
  INSERT INTO customers (farm_name) VALUES ('[SMOKE] SI '||v_sfx) RETURNING id INTO v_cust;
  INSERT INTO products (product_name, unit_size) VALUES ('[SMOKE] SIP '||v_sfx, 'gal') RETURNING id INTO v_prod;

  -- A field_application invoice: chem line + an is_application_fee line whose EXACT
  -- extended (79000) != quantity(33) x blended unit_price(2394)=79002. Share=79100.
  INSERT INTO invoices (invoice_number, customer_id, invoice_type, status, invoice_date, due_date, total_amount_cents, created_by, season)
    VALUES ('[SMOKE] FINV-'||v_sfx, v_cust, 'field_application', 'draft', CURRENT_DATE, CURRENT_DATE+30, 0, v_admin, 2026) RETURNING id INTO v_inv;
  INSERT INTO invoice_items (invoice_id, product_id, description, quantity, unit_price_cents, extended_cents, cost_cents, sort_order, is_application_fee) VALUES (v_inv, v_prod, 'Chem', 1, 100, 100, 0, 1, false);
  INSERT INTO invoice_items (invoice_id, description, quantity, unit_price_cents, extended_cents, cost_cents, sort_order, acres, rate_per_acre, rate_unit, is_application_fee, price_source) VALUES (v_inv, 'Application', 33, 2394, 79000, 0, 2, 33, 2394, 'acre', true, 'tier');
  UPDATE invoices SET total_amount_cents=79100, status='unposted' WHERE id=v_inv;
  INSERT INTO invoice_shares (invoice_id, customer_id, customer_name, split_percentage, acres, amount_cents, is_primary, sort_order) VALUES (v_inv, v_cust, 'SI', 100.0, 33, 79100, true, 1);

  -- Edit via save_invoice: bump chem qty 1->3 (extended 300); fee line unchanged (send its exact extended_cents)
  PERFORM save_invoice(
    jsonb_build_object('id', v_inv, 'customer_id', v_cust, 'invoice_type','field_application', 'invoice_date', CURRENT_DATE::text),
    jsonb_build_array(
      jsonb_build_object('product_id', v_prod, 'description','Chem', 'quantity', 3, 'unit_price_cents', 100, 'extended_cents', 300, 'sort_order', 1, 'is_application_fee', false),
      jsonb_build_object('description','Application', 'quantity', 33, 'unit_price_cents', 2394, 'extended_cents', 79000, 'sort_order', 2, 'acres', 33, 'rate_per_acre', 2394, 'rate_unit','acre', 'is_application_fee', true, 'price_source','tier')
    ), NULL);

  SELECT is_application_fee, extended_cents INTO v_fee_flag, v_fee_ext FROM invoice_items WHERE invoice_id=v_inv AND is_application_fee=true;
  IF v_fee_flag IS NOT TRUE THEN RAISE EXCEPTION 'SMOKE_FAIL: fee flag lost on edit'; END IF;
  IF v_fee_ext <> 79000 THEN RAISE EXCEPTION 'SMOKE_FAIL: fee extended drifted to % (exp exact 79000, not 33x2394=79002)', v_fee_ext; END IF;
  SELECT total_amount_cents INTO v_inv_total FROM invoices WHERE id=v_inv;
  IF v_inv_total <> 79300 THEN RAISE EXCEPTION 'SMOKE_FAIL: field total % (exp 79300 = 300 chem + 79000 fee)', v_inv_total; END IF;
  SELECT amount_cents INTO v_share_amt FROM invoice_shares WHERE invoice_id=v_inv;
  IF v_share_amt <> 79300 THEN RAISE EXCEPTION 'SMOKE_FAIL: share not re-balanced % (exp 79300)', v_share_amt; END IF;

  -- CONTROL: chemical_sale invoice with a (deliberately wrong) share is NOT touched; product line still recomputed
  INSERT INTO invoices (invoice_number, customer_id, invoice_type, status, invoice_date, due_date, total_amount_cents, created_by, season)
    VALUES ('[SMOKE] CINV-'||v_sfx, v_cust, 'chemical_sale', 'draft', CURRENT_DATE, CURRENT_DATE+30, 0, v_admin, 2026) RETURNING id INTO v_chem_inv;
  INSERT INTO invoice_items (invoice_id, product_id, description, quantity, unit_price_cents, extended_cents, cost_cents, sort_order) VALUES (v_chem_inv, v_prod, 'Chem', 1, 200, 200, 0, 1);
  UPDATE invoices SET total_amount_cents=200, status='unposted' WHERE id=v_chem_inv;
  INSERT INTO invoice_shares (invoice_id, customer_id, customer_name, split_percentage, acres, amount_cents, is_primary, sort_order) VALUES (v_chem_inv, v_cust, 'x', 100.0, 0, 999, true, 1);
  -- a non-fee product line that LIES about extended_cents must be recomputed (anti-tamper): 5 x 200 = 1000, NOT the 1 sent
  PERFORM save_invoice(
    jsonb_build_object('id', v_chem_inv, 'customer_id', v_cust, 'invoice_type','chemical_sale', 'invoice_date', CURRENT_DATE::text),
    jsonb_build_array(jsonb_build_object('product_id', v_prod, 'description','Chem', 'quantity', 5, 'unit_price_cents', 200, 'extended_cents', 1, 'sort_order', 1)), NULL);
  SELECT amount_cents INTO v_share_amt FROM invoice_shares WHERE invoice_id=v_chem_inv;
  IF v_share_amt <> 999 THEN RAISE EXCEPTION 'SMOKE_FAIL: chemical_sale share touched by DELTA-B (% exp 999)', v_share_amt; END IF;
  SELECT total_amount_cents INTO v_inv_total FROM invoices WHERE id=v_chem_inv;
  IF v_inv_total <> 1000 THEN RAISE EXCEPTION 'SMOKE_FAIL: chemical product line not recomputed (% exp 1000, the lied extended_cents=1 must be ignored)', v_inv_total; END IF;

  -- SPLIT/OVERRIDE: a multi-grower (or fixed-price/override) field invoice cannot
  -- be re-balanced from line items without corrupting per-grower fees; editing it
  -- is BLOCKED (void/reissue). This fixture is a 2-grower split with an override (Codex).
  INSERT INTO customers (farm_name) VALUES ('[SMOKE] OvB '||v_sfx) RETURNING id INTO v_cust2;
  INSERT INTO invoices (invoice_number, customer_id, invoice_type, status, invoice_date, due_date, total_amount_cents, created_by, season)
    VALUES ('[SMOKE] OINV-'||v_sfx, v_cust, 'field_application', 'draft', CURRENT_DATE, CURRENT_DATE+30, 0, v_admin, 2026) RETURNING id INTO v_inv3;
  INSERT INTO invoice_items (invoice_id, product_id, description, quantity, unit_price_cents, extended_cents, cost_cents, sort_order, is_application_fee) VALUES (v_inv3, v_prod, 'Chem (A itemized)', 1, 1000, 1000, 0, 1, false);
  UPDATE invoices SET total_amount_cents=151000, status='unposted' WHERE id=v_inv3;
  INSERT INTO invoice_shares (invoice_id, customer_id, customer_name, split_percentage, acres, amount_cents, is_primary, sort_order, price_per_acre_cents) VALUES (v_inv3, v_cust,  'A', 100.0, 1,  1000,   true,  1, NULL);
  INSERT INTO invoice_shares (invoice_id, customer_id, customer_name, split_percentage, acres, amount_cents, is_primary, sort_order, price_per_acre_cents) VALUES (v_inv3, v_cust2, 'B', 100.0, 30, 150000, false, 2, 5000);
  BEGIN
    PERFORM save_invoice(
      jsonb_build_object('id', v_inv3, 'customer_id', v_cust, 'invoice_type','field_application', 'invoice_date', CURRENT_DATE::text),
      jsonb_build_array(jsonb_build_object('product_id', v_prod, 'description','Chem (A itemized)', 'quantity', 3, 'unit_price_cents', 1000, 'extended_cents', 3000, 'sort_order', 1, 'is_application_fee', false)), NULL);
    RAISE EXCEPTION 'SMOKE_FAIL: editing a split/override field invoice was ALLOWED';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'FIELD_INVOICE_SPLIT_LOCKED%' THEN RAISE EXCEPTION 'SMOKE_FAIL: expected FIELD_INVOICE_SPLIT_LOCKED got %', SQLERRM; END IF;
  END;
  -- nothing mutated by the blocked edit: override share + items intact
  SELECT amount_cents INTO v_b FROM invoice_shares WHERE invoice_id=v_inv3 AND customer_id=v_cust2;
  IF v_b <> 150000 THEN RAISE EXCEPTION 'SMOKE_FAIL: override invoice mutated despite the block (share %)', v_b; END IF;
  SELECT count(*) INTO v_a FROM invoice_items WHERE invoice_id=v_inv3;
  IF v_a <> 1 THEN RAISE EXCEPTION 'SMOKE_FAIL: override invoice items changed despite the block (% items)', v_a; END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END $smoke$;
