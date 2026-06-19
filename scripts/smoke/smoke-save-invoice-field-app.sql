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
--   DELTA-D  — a field_application invoice's customer_id is LOCKED on edit: passing
--              a different customer_id in the payload is ignored (a chemical_sale
--              invoice still honors a customer change — covered by the control).
--   GUARD    — a chemical_sale invoice's shares are NOT touched (field-only).
--
-- Ends in RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK'.
-- ============================================================================
DO $smoke$
DECLARE
  v_admin uuid; v_sfx text := substr(gen_random_uuid()::text,1,8); v_cust uuid; v_prod uuid;
  v_inv uuid; v_chem_inv uuid; v_chem2 uuid; v_inv3 uuid; v_cust2 uuid; v_cust_b uuid; v_who uuid; v_fee_flag boolean; v_share_amt bigint; v_inv_total bigint; v_fee_ext bigint; v_a bigint; v_b bigint;
BEGIN
  SELECT id INTO v_admin FROM profiles WHERE role='admin' AND is_active=true ORDER BY created_at LIMIT 1;
  IF v_admin IS NULL THEN RAISE EXCEPTION 'SMOKE_SETUP: no admin'; END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role','authenticated')::text, true);
  INSERT INTO customers (farm_name) VALUES ('[SMOKE] SI '||v_sfx) RETURNING id INTO v_cust;
  INSERT INTO customers (farm_name) VALUES ('[SMOKE] SIb '||v_sfx) RETURNING id INTO v_cust_b;
  INSERT INTO products (product_name, unit_size, current_cost) VALUES ('[SMOKE] SIP '||v_sfx, 'gal', 10.00) RETURNING id INTO v_prod;  -- per-unit cost = $10 -> 1000c

  -- A field_application invoice: chem line + an is_application_fee line whose EXACT
  -- extended (79000) != quantity(33) x blended unit_price(2394)=79002. Share=79100.
  INSERT INTO invoices (invoice_number, customer_id, invoice_type, status, invoice_date, due_date, total_amount_cents, total_cost_cents, created_by, season)
    VALUES ('[SMOKE] FINV-'||v_sfx, v_cust, 'field_application', 'draft', CURRENT_DATE, CURRENT_DATE+30, 0, 99999, v_admin, 2026) RETURNING id INTO v_inv;  -- stale cost 99999 must be OVERWRITTEN by the edit
  INSERT INTO invoice_items (invoice_id, product_id, description, quantity, unit_price_cents, extended_cents, cost_cents, sort_order, is_application_fee) VALUES (v_inv, v_prod, 'Chem', 1, 100, 100, 0, 1, false);
  INSERT INTO invoice_items (invoice_id, description, quantity, unit_price_cents, extended_cents, cost_cents, sort_order, acres, rate_per_acre, rate_unit, is_application_fee, price_source) VALUES (v_inv, 'Application', 33, 2394, 79000, 0, 2, 33, 2394, 'acre', true, 'tier');
  UPDATE invoices SET total_amount_cents=79100, status='unposted' WHERE id=v_inv;
  INSERT INTO invoice_shares (invoice_id, customer_id, customer_name, split_percentage, acres, amount_cents, is_primary, sort_order) VALUES (v_inv, v_cust, 'SI', 100.0, 33, 79100, true, 1);

  -- Edit via save_invoice: bump chem qty 1->3 (extended 300); fee line unchanged (send its exact extended_cents).
  -- DELTA-D: deliberately pass a DIFFERENT customer (v_cust_b) -- it must be ignored (customer locked).
  -- DELTA-F: deliberately pass a HOSTILE invoice_type='chemical_sale' -- it must be ignored (type locked
  -- so the field-invoice guards below still see field_application and run).
  PERFORM save_invoice(
    jsonb_build_object('id', v_inv, 'customer_id', v_cust_b, 'invoice_type','chemical_sale', 'invoice_date', CURRENT_DATE::text),
    jsonb_build_array(
      jsonb_build_object('product_id', v_prod, 'description','Chem', 'quantity', 1, 'unit_price_cents', 300, 'extended_cents', 300, 'cost_cents', 200, 'sort_order', 1, 'is_application_fee', false),
      jsonb_build_object('description','Application', 'quantity', 33, 'unit_price_cents', 2394, 'extended_cents', 79000, 'sort_order', 2, 'acres', 33, 'rate_per_acre', 2394, 'rate_unit','acre', 'is_application_fee', true, 'price_source','tier', 'cost_cents', 5000)
    ), NULL);

  -- DELTA-E + DELTA-G: header cost re-synced from the re-billed lines, PRESERVING the field
  -- line's incoming EXTENDED cost. Field chem line is quantity=1 with cost_cents=200; DELTA-G
  -- SKIPS the per-unit products.current_cost ($10 -> 1000) refresh, so cost stays 200 (x qty 1).
  -- Fee line cost is EXACT/extended (5000, x1 NOT x33 acres). Total = 200 + 5000 = 5200.
  -- Without DELTA-G the override would give 1000 + 5000 = 6000; a fee x-acres bug = 1000 + 165000.
  SELECT total_cost_cents INTO v_inv_total FROM invoices WHERE id=v_inv;
  IF v_inv_total <> 5200 THEN RAISE EXCEPTION 'SMOKE_FAIL: field total_cost_cents % (exp 5200 = 200 chem preserved + 5000 fee x1; override-not-skipped = 6000; stale 99999 not overwritten?)', v_inv_total; END IF;
  -- DELTA-G: the field chem line cost_cents was PRESERVED (200), not refreshed to per-unit 1000
  IF (SELECT cost_cents FROM invoice_items WHERE invoice_id=v_inv AND is_application_fee=false) <> 200
    THEN RAISE EXCEPTION 'SMOKE_FAIL: field chem line cost refreshed from products (DELTA-G preserve broken)'; END IF;

  SELECT is_application_fee, extended_cents INTO v_fee_flag, v_fee_ext FROM invoice_items WHERE invoice_id=v_inv AND is_application_fee=true;
  IF v_fee_flag IS NOT TRUE THEN RAISE EXCEPTION 'SMOKE_FAIL: fee flag lost on edit'; END IF;
  IF v_fee_ext <> 79000 THEN RAISE EXCEPTION 'SMOKE_FAIL: fee extended drifted to % (exp exact 79000, not 33x2394=79002)', v_fee_ext; END IF;
  SELECT total_amount_cents INTO v_inv_total FROM invoices WHERE id=v_inv;
  IF v_inv_total <> 79300 THEN RAISE EXCEPTION 'SMOKE_FAIL: field total % (exp 79300 = 300 chem + 79000 fee)', v_inv_total; END IF;
  SELECT amount_cents INTO v_share_amt FROM invoice_shares WHERE invoice_id=v_inv;
  IF v_share_amt <> 79300 THEN RAISE EXCEPTION 'SMOKE_FAIL: share not re-balanced % (exp 79300)', v_share_amt; END IF;
  -- DELTA-D: the customer must NOT have changed to v_cust_b
  SELECT customer_id INTO v_who FROM invoices WHERE id=v_inv;
  IF v_who <> v_cust THEN RAISE EXCEPTION 'SMOKE_FAIL: field invoice customer changed to % (must stay locked to %)', v_who, v_cust; END IF;
  -- DELTA-F (a): the hostile invoice_type='chemical_sale' must have been IGNORED (still field_application)
  IF (SELECT invoice_type FROM invoices WHERE id=v_inv) <> 'field_application'
    THEN RAISE EXCEPTION 'SMOKE_FAIL: field invoice was reclassified out of field_application (DELTA-F lock broken)'; END IF;

  -- CONTROL: chemical_sale invoice with a (deliberately wrong) share is NOT touched; product line still recomputed
  INSERT INTO invoices (invoice_number, customer_id, invoice_type, status, invoice_date, due_date, total_amount_cents, total_cost_cents, created_by, season)
    VALUES ('[SMOKE] CINV-'||v_sfx, v_cust, 'chemical_sale', 'draft', CURRENT_DATE, CURRENT_DATE+30, 0, 77777, v_admin, 2026) RETURNING id INTO v_chem_inv;  -- cost sentinel: DELTA-E must NOT touch a chemical_sale invoice
  INSERT INTO invoice_items (invoice_id, product_id, description, quantity, unit_price_cents, extended_cents, cost_cents, sort_order) VALUES (v_chem_inv, v_prod, 'Chem', 1, 200, 200, 0, 1);
  UPDATE invoices SET total_amount_cents=200, status='unposted' WHERE id=v_chem_inv;
  INSERT INTO invoice_shares (invoice_id, customer_id, customer_name, split_percentage, acres, amount_cents, is_primary, sort_order) VALUES (v_chem_inv, v_cust, 'x', 100.0, 0, 999, true, 1);
  -- a non-fee product line that LIES about extended_cents must be recomputed (anti-tamper): 5 x 200 = 1000, NOT the 1 sent.
  -- DELTA-D control: a chemical_sale invoice DOES honor a customer change (pass v_cust_b -> it sticks).
  -- DELTA-F (c): a NON-field type change (chemical_sale -> misc_charge) is still ALLOWED (no over-lock).
  PERFORM save_invoice(
    jsonb_build_object('id', v_chem_inv, 'customer_id', v_cust_b, 'invoice_type','misc_charge', 'invoice_date', CURRENT_DATE::text),
    jsonb_build_array(jsonb_build_object('product_id', v_prod, 'description','Chem', 'quantity', 5, 'unit_price_cents', 200, 'extended_cents', 1, 'sort_order', 1)), NULL);
  SELECT customer_id INTO v_who FROM invoices WHERE id=v_chem_inv;
  IF v_who <> v_cust_b THEN RAISE EXCEPTION 'SMOKE_FAIL: chemical_sale customer NOT updated (% exp %, DELTA-D over-locked)', v_who, v_cust_b; END IF;
  -- DELTA-F (c): the non-field type change took effect
  IF (SELECT invoice_type FROM invoices WHERE id=v_chem_inv) <> 'misc_charge'
    THEN RAISE EXCEPTION 'SMOKE_FAIL: chemical_sale -> misc_charge change was blocked (DELTA-F over-locked non-field types)'; END IF;
  SELECT amount_cents INTO v_share_amt FROM invoice_shares WHERE invoice_id=v_chem_inv;
  IF v_share_amt <> 999 THEN RAISE EXCEPTION 'SMOKE_FAIL: chemical_sale share touched by DELTA-B (% exp 999)', v_share_amt; END IF;
  SELECT total_amount_cents INTO v_inv_total FROM invoices WHERE id=v_chem_inv;
  IF v_inv_total <> 1000 THEN RAISE EXCEPTION 'SMOKE_FAIL: chemical product line not recomputed (% exp 1000, the lied extended_cents=1 must be ignored)', v_inv_total; END IF;
  -- DELTA-E field-only: a chemical_sale invoice's total_cost_cents is NOT recomputed (stays at its sentinel)
  SELECT total_cost_cents INTO v_inv_total FROM invoices WHERE id=v_chem_inv;
  IF v_inv_total <> 77777 THEN RAISE EXCEPTION 'SMOKE_FAIL: chemical_sale total_cost_cents touched by DELTA-E (% exp 77777, field-only scope broken)', v_inv_total; END IF;
  -- DELTA-G field-scoped: a NON-field product line STILL refreshes cost from products
  -- (per-unit current_cost $10 -> 1000); the override is only skipped for field invoices.
  IF (SELECT cost_cents FROM invoice_items WHERE invoice_id=v_chem_inv) <> 1000
    THEN RAISE EXCEPTION 'SMOKE_FAIL: chemical product line cost NOT refreshed from products (DELTA-G over-broadened to non-field)'; END IF;

  -- DELTA-F (b): a chemical invoice CANNOT be reclassified INTO field_application (else it
  -- becomes a 'field' invoice with no invoice_shares / field data and escapes into /field-invoices).
  INSERT INTO invoices (invoice_number, customer_id, invoice_type, status, invoice_date, due_date, total_amount_cents, created_by, season)
    VALUES ('[SMOKE] CINV2-'||v_sfx, v_cust, 'chemical_sale', 'draft', CURRENT_DATE, CURRENT_DATE+30, 0, v_admin, 2026) RETURNING id INTO v_chem2;
  INSERT INTO invoice_items (invoice_id, product_id, description, quantity, unit_price_cents, extended_cents, cost_cents, sort_order) VALUES (v_chem2, v_prod, 'Chem', 1, 200, 200, 0, 1);
  UPDATE invoices SET total_amount_cents=200, status='unposted' WHERE id=v_chem2;
  PERFORM save_invoice(
    jsonb_build_object('id', v_chem2, 'invoice_type','field_application', 'invoice_date', CURRENT_DATE::text),
    jsonb_build_array(jsonb_build_object('product_id', v_prod, 'description','Chem', 'quantity', 1, 'unit_price_cents', 200, 'extended_cents', 200, 'sort_order', 1)), NULL);
  IF (SELECT invoice_type FROM invoices WHERE id=v_chem2) <> 'chemical_sale'
    THEN RAISE EXCEPTION 'SMOKE_FAIL: chemical invoice reclassified INTO field_application (DELTA-F in-lock broken)'; END IF;

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
