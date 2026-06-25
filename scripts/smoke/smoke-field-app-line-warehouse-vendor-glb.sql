-- ============================================================================
-- SMOKE TEST (rolled back by design): save_field_app_invoice persists per-line
--   Warehouse + Vendor + gallon/lb-equivalent of Total Applied
--   — migration 20260624212000 (field-app parity #25).
-- ----------------------------------------------------------------------------
-- Run AFTER applying 20260624212000. Proves:
--   M1  per-acre PRICING is unchanged & cents-correct: a tier-1 product at
--       $2.50/unit, rate 8 oz/ac over 10 applied acres -> quantity 80,
--       extended_cents = ROUND($2.50 -> 250c * 80) = 20000c. (safe_cents_qty)
--   M2  Warehouse + Vendor round-trip from the client payload onto the line.
--   M3  vendor FALLS BACK to products.vendor when the client omits it.
--   M4  Total Applied gallon/lb-equivalent is populated for a DRY product
--       (oz -> LB): total_applied=80 oz, total_applied_gl_lb = 80/16 = 5 LB.
--   M5  the invoice header total_amount_cents reconciles to the sole line
--       (no drift from the informational columns).
--
-- Ends in RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK' (everything rolls back).
-- ============================================================================
DO $smoke$
DECLARE
  v_admin   uuid;
  v_sfx     text := substr(gen_random_uuid()::text,1,8);
  v_cust    uuid;
  v_prod    uuid;
  v_field   uuid;
  v_res     jsonb;
  v_inv     uuid;
  v_ext     bigint;
  v_qty     numeric;
  v_wh      text;
  v_vendor  text;
  v_ta      numeric;
  v_ta_glb  numeric;
  v_glb_u   text;
  v_total   bigint;
  v_inv2    uuid;
  v_vendor2 text;
BEGIN
  SELECT id INTO v_admin FROM profiles WHERE role='admin' AND is_active=true ORDER BY created_at LIMIT 1;
  IF v_admin IS NULL THEN RAISE EXCEPTION 'SMOKE_SETUP: no admin'; END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role','authenticated')::text, true);

  INSERT INTO customers (farm_name, assigned_tier) VALUES ('[SMOKE] FA25 '||v_sfx, 1) RETURNING id INTO v_cust;

  -- DRY product, $2.50 tier-1, vendor on the product (for the M3 fallback case).
  -- inventory_unit must satisfy validate_product_units (dry catalog); the per-line
  -- rate_unit in the payload below is the free-form 'oz' that drives the conversion.
  INSERT INTO products (product_name, unit_size, inventory_unit, product_form, current_cost, tier1_price, vendor)
    VALUES ('[SMOKE] FA25P '||v_sfx, 'Lb', 'Lb', 'dry', 1.00, 2.50, 'ACME Ag Supply')
    RETURNING id INTO v_prod;

  INSERT INTO fields (customer_id, field_name, total_acres, is_active)
    VALUES (v_cust, '[SMOKE] FA25F '||v_sfx, 40, true) RETURNING id INTO v_field;
  INSERT INTO field_billing_defaults (field_id, customer_id, split_pct, is_primary)
    VALUES (v_field, v_cust, 100, true);

  -- ── CASE A: client supplies warehouse + vendor explicitly ──────────────────
  v_res := save_field_app_invoice(
    NULL,
    jsonb_build_object('invoice_date', CURRENT_DATE::text, 'salesman_id', v_admin::text),
    jsonb_build_array(jsonb_build_object(
      'field_id', v_field::text, 'map_number', 1,
      'total_acres', 40, 'planted_acres', 40, 'applied_acres', 10, 'sort_order', 0
    )),
    jsonb_build_array(jsonb_build_object(
      'product_id', v_prod::text, 'description', 'Test Chem',
      'rate_per_acre', 8, 'rate_unit', 'oz', 'unit_size', 'oz',
      'unit_price_cents', 250, 'cost_cents', 100, 'sort_order', 0,
      'warehouse', 'North Shed', 'vendor', 'Override Vendor', 'manual_override', false
    )),
    v_admin, NULL, NULL
  );

  v_inv := (v_res->'invoice_ids'->>0)::uuid;
  IF v_inv IS NULL THEN RAISE EXCEPTION 'SMOKE_FAIL: no invoice returned'; END IF;

  SELECT quantity, extended_cents, warehouse, vendor,
         total_applied, total_applied_gl_lb, gl_lb_unit
    INTO v_qty, v_ext, v_wh, v_vendor, v_ta, v_ta_glb, v_glb_u
    FROM invoice_items WHERE invoice_id = v_inv AND is_application_fee = false;

  -- M1: cents-correct pricing (quantity 8*10=80; 250c * 80 = 20000c).
  IF v_qty <> 80 THEN RAISE EXCEPTION 'SMOKE_FAIL M1 qty: % (exp 80 = 8/ac x 10 ac)', v_qty; END IF;
  IF v_ext <> 20000 THEN RAISE EXCEPTION 'SMOKE_FAIL M1 extended_cents: % (exp 20000 = 250c x 80)', v_ext; END IF;

  -- M2: warehouse + vendor round-trip.
  IF v_wh IS DISTINCT FROM 'North Shed' THEN RAISE EXCEPTION 'SMOKE_FAIL M2 warehouse: %', v_wh; END IF;
  IF v_vendor IS DISTINCT FROM 'Override Vendor' THEN RAISE EXCEPTION 'SMOKE_FAIL M2 vendor (client override lost): %', v_vendor; END IF;

  -- M4: gallon/lb-equivalent of Total Applied (dry oz -> LB; 80/16 = 5).
  IF v_ta <> 80 THEN RAISE EXCEPTION 'SMOKE_FAIL M4 total_applied: % (exp 80)', v_ta; END IF;
  IF v_glb_u IS DISTINCT FROM 'LB' THEN RAISE EXCEPTION 'SMOKE_FAIL M4 gl_lb_unit: % (exp LB for dry oz)', v_glb_u; END IF;
  IF round(v_ta_glb, 4) <> 5 THEN RAISE EXCEPTION 'SMOKE_FAIL M4 total_applied_gl_lb: % (exp 5 = 80 oz / 16)', v_ta_glb; END IF;

  -- M5: header reconciles to the single priced line.
  SELECT total_amount_cents INTO v_total FROM invoices WHERE id = v_inv;
  IF v_total <> 20000 THEN RAISE EXCEPTION 'SMOKE_FAIL M5 header total: % (exp 20000)', v_total; END IF;

  -- ── CASE B: client omits vendor -> falls back to products.vendor ───────────
  v_res := save_field_app_invoice(
    NULL,
    jsonb_build_object('invoice_date', CURRENT_DATE::text, 'salesman_id', v_admin::text),
    jsonb_build_array(jsonb_build_object(
      'field_id', v_field::text, 'map_number', 1,
      'total_acres', 40, 'planted_acres', 40, 'applied_acres', 5, 'sort_order', 0
    )),
    jsonb_build_array(jsonb_build_object(
      'product_id', v_prod::text, 'description', 'Test Chem',
      'rate_per_acre', 8, 'rate_unit', 'oz', 'unit_size', 'oz',
      'cost_cents', 100, 'sort_order', 0
      -- no warehouse, no vendor, no manual_override -> tier price + product vendor
    )),
    v_admin, NULL, NULL
  );
  v_inv2 := (v_res->'invoice_ids'->>0)::uuid;
  SELECT vendor INTO v_vendor2 FROM invoice_items WHERE invoice_id = v_inv2 AND is_application_fee = false;
  IF v_vendor2 IS DISTINCT FROM 'ACME Ag Supply' THEN
    RAISE EXCEPTION 'SMOKE_FAIL M3 vendor fallback: % (exp products.vendor ACME Ag Supply)', v_vendor2; END IF;
  -- and the tier price still drove the cents (no manual override): 250c x (8*5=40) = 10000c
  SELECT extended_cents INTO v_ext FROM invoice_items WHERE invoice_id = v_inv2 AND is_application_fee = false;
  IF v_ext <> 10000 THEN RAISE EXCEPTION 'SMOKE_FAIL M3 tier pricing: % (exp 10000 = tier 250c x 40)', v_ext; END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END $smoke$;
