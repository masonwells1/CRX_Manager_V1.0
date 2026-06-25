-- ============================================================================
-- SMOKE TEST (rolled back by design): section #32 — FUEL SURCHARGE
-- (configurable setting, OFF by default). Proves the surcharge wiring in
-- save_field_app_invoice is INERT at the shipped default and computes a correct
-- bigint-cents line when an admin enables it AND enters a rate.
-- REQUIRES migration 20260625140000_fuel_surcharge_setting.sql.
-- ----------------------------------------------------------------------------
-- Proves:
--   P1  — DEFAULT-OFF INERT: with app_settings.fuel_surcharge at the shipped
--          default (enabled=false, rate blank), a saved field-app invoice has
--          NO 'Fuel Surcharge' line and its total is the pure pre-surcharge sum.
--   P2  — ENABLED + RATE => LINE: after an admin sets enabled=true + a TEST
--          per-acre rate, a re-save adds exactly ONE is_application_fee
--          'Fuel Surcharge' line whose extended_cents = ROUND(rate*100*acres),
--          and the invoice total rises by EXACTLY that amount (no other drift).
--   P3  — SHARE SPLIT: invoice_shares.amount_cents for the ON invoice equals its
--          total (the surcharge flows into the customer share, so the printed
--          split and statements include it).
--   P4  — BLANK-RATE GUARD: enabled=true but a BLANK rate => NO line, total
--          identical to the OFF total (the "off if formula blank" rule).
--
-- The config writes here are inside the rolled-back transaction, so the persisted
-- shipped default (OFF/blank) is NEVER changed by this test.
-- Ends in RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK'.
-- ============================================================================
DO $smoke$
DECLARE
  v_admin uuid;
  v_sfx   text := substr(gen_random_uuid()::text,1,8);
  v_cust  uuid;
  v_field uuid;
  v_prod  uuid;
  v_locations jsonb;
  v_chemicals jsonb;
  v_save jsonb;
  v_inv_off  uuid;
  v_inv_on   uuid;
  v_inv_blank uuid;
  v_total_off  bigint;
  v_total_on   bigint;
  v_total_blank bigint;
  v_surcharge_lines int;
  v_surcharge_cents bigint;
  v_acres numeric := 80;          -- applied acres on the single field
  v_test_rate text := '2.50';     -- TEST per-acre rate ONLY ($2.50/ac). NOT a real rate.
  v_expected_surcharge bigint;    -- ROUND(2.50 * 100 * 80) = 20000 cents = $200.00
  v_share_sum bigint;
BEGIN
  SELECT id INTO v_admin FROM profiles WHERE role='admin' AND is_active=true ORDER BY created_at LIMIT 1;
  IF v_admin IS NULL THEN RAISE EXCEPTION 'SMOKE_SETUP: no admin'; END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role','authenticated')::text, true);

  v_expected_surcharge := ROUND(v_test_rate::numeric * 100 * v_acres)::bigint;  -- 20000

  -- One customer, one field they own, one tier-priced product.
  INSERT INTO customers (farm_name, assigned_tier) VALUES ('[SMOKE] Fuel '||v_sfx, 1) RETURNING id INTO v_cust;
  INSERT INTO fields (field_name, customer_id, total_acres)
    VALUES ('[SMOKE] Fuel Field '||v_sfx, v_cust, v_acres) RETURNING id INTO v_field;
  INSERT INTO field_billing_defaults (field_id, customer_id, split_pct, is_primary)
    VALUES (v_field, v_cust, 100, true);
  INSERT INTO products (product_name, unit_size, current_cost, tier1_price)
    VALUES ('[SMOKE] Fuel Prod '||v_sfx, 'gal', 1.00, 10.00) RETURNING id INTO v_prod;

  v_locations := jsonb_build_array(jsonb_build_object(
    'field_id', v_field, 'map_number', 1,
    'total_acres', v_acres, 'planted_acres', NULL,
    'applied_acres', v_acres, 'crop_type', NULL,
    'wind_direction', NULL, 'sort_order', 0
  ));
  -- One chemical: tier1 $10/gal at 1 gal/ac over 80 ac = $800.00 base.
  v_chemicals := jsonb_build_array(jsonb_build_object(
    'product_id', v_prod, 'description', 'Fuel Test Chem',
    'quantity', 0, 'unit_size', 'gal',
    'unit_price_cents', NULL, 'cost_cents', 0, 'sort_order', 0,
    'rate_per_acre', 1.0, 'rate_unit', 'gal',
    'manual_override', false
  ));

  -- Sanity: the persisted setting must START at the shipped inert default.
  IF (SELECT setting_value::jsonb->>'enabled' FROM app_settings WHERE setting_key='fuel_surcharge') <> 'false'
     OR NULLIF(TRIM((SELECT setting_value::jsonb->>'rate' FROM app_settings WHERE setting_key='fuel_surcharge')), '') IS NOT NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: fuel_surcharge setting is not at the OFF/blank default — refusing to test';
  END IF;

  -- ── P1: DEFAULT OFF → no surcharge line, baseline total ────────────────────
  v_save := save_field_app_invoice(
    NULL,
    jsonb_build_object('invoice_date', CURRENT_DATE::text, 'header_notes', '[SMOKE] off'),
    v_locations, v_chemicals, v_admin, NULL, 'smoke-fuel-off-'||v_sfx
  );
  v_inv_off := ((v_save->'invoice_ids')->>0)::uuid;
  SELECT total_amount_cents INTO v_total_off FROM invoices WHERE id = v_inv_off;
  SELECT count(*) INTO v_surcharge_lines FROM invoice_items
   WHERE invoice_id = v_inv_off AND description = 'Fuel Surcharge';
  IF v_surcharge_lines <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL(P1): OFF default produced % fuel surcharge line(s) — should be 0', v_surcharge_lines;
  END IF;
  IF v_total_off <= 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL(P1 setup): baseline total non-positive (%)', v_total_off;
  END IF;
  RAISE NOTICE 'P1 OK: OFF total = % cents, 0 surcharge lines', v_total_off;

  -- ── P2: ENABLE + TEST RATE → one surcharge line, total += surcharge ─────────
  UPDATE app_settings
     SET setting_value = jsonb_build_object('enabled', true, 'basis', 'per_acre', 'rate', v_test_rate)::text
   WHERE setting_key = 'fuel_surcharge';

  v_save := save_field_app_invoice(
    NULL,
    jsonb_build_object('invoice_date', CURRENT_DATE::text, 'header_notes', '[SMOKE] on'),
    v_locations, v_chemicals, v_admin, NULL, 'smoke-fuel-on-'||v_sfx
  );
  v_inv_on := ((v_save->'invoice_ids')->>0)::uuid;
  SELECT total_amount_cents INTO v_total_on FROM invoices WHERE id = v_inv_on;
  SELECT count(*), COALESCE(SUM(extended_cents),0) INTO v_surcharge_lines, v_surcharge_cents
    FROM invoice_items
   WHERE invoice_id = v_inv_on AND description = 'Fuel Surcharge' AND is_application_fee = true;

  IF v_surcharge_lines <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL(P2): expected exactly 1 fuel surcharge line, got %', v_surcharge_lines;
  END IF;
  IF v_surcharge_cents <> v_expected_surcharge THEN
    RAISE EXCEPTION 'SMOKE_FAIL(P2): surcharge line = % cents, expected % (ROUND(2.50*100*80))', v_surcharge_cents, v_expected_surcharge;
  END IF;
  IF v_total_on <> v_total_off + v_expected_surcharge THEN
    RAISE EXCEPTION 'SMOKE_FAIL(P2): ON total % != OFF total % + surcharge % (drift!)', v_total_on, v_total_off, v_expected_surcharge;
  END IF;
  RAISE NOTICE 'P2 OK: ON total = % cents = OFF % + surcharge % (line cents %)', v_total_on, v_total_off, v_expected_surcharge, v_surcharge_cents;

  -- ── P3: surcharge flows into the customer share split ──────────────────────
  SELECT COALESCE(SUM(amount_cents),0) INTO v_share_sum FROM invoice_shares WHERE invoice_id = v_inv_on;
  IF v_share_sum <> v_total_on THEN
    RAISE EXCEPTION 'SMOKE_FAIL(P3): share sum % != ON total % (surcharge not in share split)', v_share_sum, v_total_on;
  END IF;
  RAISE NOTICE 'P3 OK: share split = % cents = ON total', v_share_sum;

  -- ── P4: ENABLED but BLANK rate → no line, total back to baseline ───────────
  UPDATE app_settings
     SET setting_value = jsonb_build_object('enabled', true, 'basis', 'per_acre', 'rate', '')::text
   WHERE setting_key = 'fuel_surcharge';

  v_save := save_field_app_invoice(
    NULL,
    jsonb_build_object('invoice_date', CURRENT_DATE::text, 'header_notes', '[SMOKE] blank'),
    v_locations, v_chemicals, v_admin, NULL, 'smoke-fuel-blank-'||v_sfx
  );
  v_inv_blank := ((v_save->'invoice_ids')->>0)::uuid;
  SELECT total_amount_cents INTO v_total_blank FROM invoices WHERE id = v_inv_blank;
  SELECT count(*) INTO v_surcharge_lines FROM invoice_items
   WHERE invoice_id = v_inv_blank AND description = 'Fuel Surcharge';
  IF v_surcharge_lines <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL(P4): enabled+blank-rate produced % surcharge line(s) — should be 0', v_surcharge_lines;
  END IF;
  IF v_total_blank <> v_total_off THEN
    RAISE EXCEPTION 'SMOKE_FAIL(P4): enabled+blank-rate total % != OFF total % (blank should be inert)', v_total_blank, v_total_off;
  END IF;
  RAISE NOTICE 'P4 OK: enabled+blank-rate total = % = OFF total, 0 surcharge lines', v_total_blank;

  RAISE NOTICE 'SMOKE OK: OFF=% ON=% (+%) shares=% blank=%', v_total_off, v_total_on, v_expected_surcharge, v_share_sum, v_total_blank;
  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END $smoke$;
