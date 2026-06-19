-- ============================================================================
-- SMOKE TEST (rolled back by design): save_invoice field-application aware
-- — migration 20260619160000 (#3 edit-path).
-- ----------------------------------------------------------------------------
-- Run AFTER applying 20260619160000. Pre-apply it FAILS (the live body neither
-- preserves is_application_fee nor re-balances field shares). Pre-apply validation
-- (2026-06-19): the new body was stacked in a rolled-back txn with this DO block
-- -> SMOKE_PASS_ROLLBACK.
--
-- Proves:
--   DELTA-A — editing a field_application invoice via save_invoice PRESERVES the
--             is_application_fee machine-fee line (it does not become a normal line).
--   DELTA-B — the per-grower invoice_shares re-balance to the new edited total
--             (single share -> whole total).
--   GUARD   — a chemical_sale invoice's invoice_shares are NOT touched (the
--             re-balance is field_application-only).
--
-- Ends in RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK'.
-- ============================================================================
DO $smoke$
DECLARE
  v_admin uuid; v_sfx text := substr(gen_random_uuid()::text,1,8); v_cust uuid; v_prod uuid;
  v_inv uuid; v_chem_inv uuid; v_fee_flag boolean; v_share_amt bigint; v_inv_total bigint;
BEGIN
  SELECT id INTO v_admin FROM profiles WHERE role='admin' AND is_active=true ORDER BY created_at LIMIT 1;
  IF v_admin IS NULL THEN RAISE EXCEPTION 'SMOKE_SETUP: no admin'; END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role','authenticated')::text, true);
  INSERT INTO customers (farm_name) VALUES ('[SMOKE] SI '||v_sfx) RETURNING id INTO v_cust;
  INSERT INTO products (product_name, unit_size) VALUES ('[SMOKE] SIP '||v_sfx, 'gal') RETURNING id INTO v_prod;

  -- A field_application invoice: chem line + is_application_fee line + 1 share=5100
  INSERT INTO invoices (invoice_number, customer_id, invoice_type, status, invoice_date, due_date, total_amount_cents, created_by, season)
    VALUES ('[SMOKE] FINV-'||v_sfx, v_cust, 'field_application', 'draft', CURRENT_DATE, CURRENT_DATE+30, 0, v_admin, 2026) RETURNING id INTO v_inv;
  INSERT INTO invoice_items (invoice_id, product_id, description, quantity, unit_price_cents, extended_cents, cost_cents, sort_order, is_application_fee) VALUES (v_inv, v_prod, 'Chem', 1, 100, 100, 0, 1, false);
  INSERT INTO invoice_items (invoice_id, description, quantity, unit_price_cents, extended_cents, cost_cents, sort_order, is_application_fee, price_source) VALUES (v_inv, 'Application', 10, 500, 5000, 0, 2, true, 'tier');
  UPDATE invoices SET total_amount_cents=5100, status='unposted' WHERE id=v_inv;
  INSERT INTO invoice_shares (invoice_id, customer_id, customer_name, split_percentage, acres, amount_cents, is_primary, sort_order) VALUES (v_inv, v_cust, 'SI', 100.0, 10, 5100, true, 1);

  -- Edit via save_invoice: bump chem qty 1->3 (extended 300); keep the fee line
  PERFORM save_invoice(
    jsonb_build_object('id', v_inv, 'customer_id', v_cust, 'invoice_type','field_application', 'invoice_date', CURRENT_DATE::text),
    jsonb_build_array(
      jsonb_build_object('product_id', v_prod, 'description','Chem', 'quantity', 3, 'unit_price_cents', 100, 'sort_order', 1, 'is_application_fee', false),
      jsonb_build_object('description','Application', 'quantity', 10, 'unit_price_cents', 500, 'sort_order', 2, 'is_application_fee', true, 'price_source','tier')
    ), NULL);

  SELECT is_application_fee INTO v_fee_flag FROM invoice_items WHERE invoice_id=v_inv AND extended_cents=5000;
  IF v_fee_flag IS NOT TRUE THEN RAISE EXCEPTION 'SMOKE_FAIL: fee flag lost on edit'; END IF;
  SELECT total_amount_cents INTO v_inv_total FROM invoices WHERE id=v_inv;
  IF v_inv_total <> 5300 THEN RAISE EXCEPTION 'SMOKE_FAIL: field total % (exp 5300)', v_inv_total; END IF;
  SELECT amount_cents INTO v_share_amt FROM invoice_shares WHERE invoice_id=v_inv;
  IF v_share_amt <> 5300 THEN RAISE EXCEPTION 'SMOKE_FAIL: share not re-balanced % (exp 5300)', v_share_amt; END IF;

  -- CONTROL: chemical_sale invoice with a (deliberately wrong) share is NOT touched
  INSERT INTO invoices (invoice_number, customer_id, invoice_type, status, invoice_date, due_date, total_amount_cents, created_by, season)
    VALUES ('[SMOKE] CINV-'||v_sfx, v_cust, 'chemical_sale', 'draft', CURRENT_DATE, CURRENT_DATE+30, 0, v_admin, 2026) RETURNING id INTO v_chem_inv;
  INSERT INTO invoice_items (invoice_id, product_id, description, quantity, unit_price_cents, extended_cents, cost_cents, sort_order) VALUES (v_chem_inv, v_prod, 'Chem', 1, 200, 200, 0, 1);
  UPDATE invoices SET total_amount_cents=200, status='unposted' WHERE id=v_chem_inv;
  INSERT INTO invoice_shares (invoice_id, customer_id, customer_name, split_percentage, acres, amount_cents, is_primary, sort_order) VALUES (v_chem_inv, v_cust, 'x', 100.0, 0, 999, true, 1);
  PERFORM save_invoice(
    jsonb_build_object('id', v_chem_inv, 'customer_id', v_cust, 'invoice_type','chemical_sale', 'invoice_date', CURRENT_DATE::text),
    jsonb_build_array(jsonb_build_object('product_id', v_prod, 'description','Chem', 'quantity', 5, 'unit_price_cents', 200, 'sort_order', 1)), NULL);
  SELECT amount_cents INTO v_share_amt FROM invoice_shares WHERE invoice_id=v_chem_inv;
  IF v_share_amt <> 999 THEN RAISE EXCEPTION 'SMOKE_FAIL: chemical_sale share touched by DELTA-B (% exp 999)', v_share_amt; END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END $smoke$;
