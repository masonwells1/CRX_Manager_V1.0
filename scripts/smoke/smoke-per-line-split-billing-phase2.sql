-- Rollback-only hard proof for Phase 2 per-line split billing.
-- Runs only in the network-isolated disposable container created by
-- prove-per-line-split-billing-phase2.mjs. The terminal PASS exception rolls
-- back every fixture while leaving an unmistakable evidence marker.

BEGIN;

DO $proof$
DECLARE
  v_admin constant uuid := '10000000-0000-0000-0000-000000000001';
  v_applicator constant uuid := '10000000-0000-0000-0000-000000000002';
  v_a constant uuid := '20000000-0000-0000-0000-000000000001';
  v_b constant uuid := '20000000-0000-0000-0000-000000000002';
  v_c constant uuid := '20000000-0000-0000-0000-000000000003';
  v_field_50 constant uuid := '30000000-0000-0000-0000-000000000001';
  v_field_3 constant uuid := '30000000-0000-0000-0000-000000000002';
  v_field_fallback constant uuid := '30000000-0000-0000-0000-000000000003';
  v_field_mode_a constant uuid := '30000000-0000-0000-0000-000000000004';
  v_field_job constant uuid := '30000000-0000-0000-0000-000000000005';
  v_field_outside constant uuid := '30000000-0000-0000-0000-000000000006';
  v_field_convert constant uuid := '30000000-0000-0000-0000-000000000007';
  v_job constant uuid := '40000000-0000-0000-0000-000000000001';
  v_job_quote constant uuid := '40000000-0000-0000-0000-000000000002';
  v_job_customer_supplied constant uuid := '40000000-0000-0000-0000-000000000003';
  v_job_service constant uuid := '40000000-0000-0000-0000-000000000004';
  v_job_convert constant uuid := '40000000-0000-0000-0000-000000000005';
  v_job_subset constant uuid := '40000000-0000-0000-0000-000000000006';
  v_job_chem constant uuid := '41000000-0000-0000-0000-000000000001';
  v_job_chem_quote_a constant uuid := '41000000-0000-0000-0000-000000000002';
  v_job_chem_quote_b constant uuid := '41000000-0000-0000-0000-000000000003';
  v_job_chem_customer_supplied constant uuid := '41000000-0000-0000-0000-000000000004';
  v_job_chem_convert constant uuid := '41000000-0000-0000-0000-000000000005';
  v_job_chem_subset constant uuid := '41000000-0000-0000-0000-000000000006';
  v_product_quote constant uuid := '50000000-0000-0000-0000-000000000001';
  v_product_tier constant uuid := '50000000-0000-0000-0000-000000000002';
  v_product_gallon constant uuid := '50000000-0000-0000-0000-000000000003';
  v_service constant uuid := '60000000-0000-0000-0000-000000000001';
  v_service_other constant uuid := '60000000-0000-0000-0000-000000000002';
  v_plan jsonb;
  v_plan_again jsonb;
  v_lines jsonb;
  v_shares jsonb;
  v_err text;
  v_count integer;
  v_sum numeric;
BEGIN
  IF current_database() <> 'crx_per_line_p2_disposable' THEN
    RAISE EXCEPTION 'PROOF_SAFETY: refusing database %', current_database();
  END IF;

  INSERT INTO public.profiles (id, role) VALUES
    (v_admin, 'admin'), (v_applicator, 'applicator');
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);

  INSERT INTO public.customers (id, farm_name, assigned_tier) VALUES
    (v_a, 'A Farm', 1), (v_b, 'B Farm', 2), (v_c, 'C Farm', 3);
  INSERT INTO public.jobs (id, season) VALUES
    (v_job, 2026),
    (v_job_quote, 2026),
    (v_job_customer_supplied, 2026),
    (v_job_service, 2025),
    (v_job_convert, 2026),
    (v_job_subset, 2026);
  INSERT INTO public.fields (id, field_name, customer_id, total_acres) VALUES
    (v_field_50, 'Half Field', v_a, 1),
    (v_field_3, 'Thirds Field', v_a, 1),
    (v_field_fallback, 'Fallback Field', v_b, 1),
    (v_field_mode_a, 'Mode A Field', v_a, 1),
    (v_field_job, 'Snapshot Field', v_a, 1),
    (v_field_outside, 'Outside Job Field', v_a, 1),
    (v_field_convert, 'Unit Conversion Field', v_a, 100);
  INSERT INTO public.job_fields (job_id, field_id, acres_to_treat, sort_order) VALUES
    (v_job, v_field_job, 1, 1),
    (v_job_quote, v_field_50, 1, 1),
    (v_job_customer_supplied, v_field_50, 1, 1),
    (v_job_service, v_field_50, 1, 1),
    (v_job_convert, v_field_convert, 100, 1),
    (v_job_subset, v_field_job, 1, 1),
    (v_job_subset, v_field_outside, 1, 2);

  INSERT INTO public.field_billing_defaults
    (field_id, customer_id, split_pct, is_primary, price_override_cents)
  VALUES
    (v_field_50, v_a, 50, true, NULL),
    (v_field_50, v_b, 50, false, NULL),
    (v_field_3, v_a, 33.333334, true, NULL),
    (v_field_3, v_b, 33.333333, false, NULL),
    (v_field_3, v_c, 33.333333, false, NULL),
    (v_field_mode_a, v_a, 50, true, 1200),
    (v_field_mode_a, v_b, 50, false, NULL),
    (v_field_job, v_a, 50, true, NULL),
    (v_field_job, v_b, 50, false, NULL),
    (v_field_convert, v_a, 50, true, NULL),
    (v_field_convert, v_b, 50, false, NULL);
  INSERT INTO public.job_field_shares
    (job_id, field_id, customer_id, split_pct, is_primary)
  VALUES (v_job, v_field_job, v_c, 100, true);

  INSERT INTO public.products
    (id, product_name, inventory_unit, product_form, tier1_price, tier2_price, tier3_price)
  VALUES
    (v_product_quote, 'Quote Product', 'unit', 'liquid', 1.00, 2.00, 3.00),
    (v_product_tier, 'Tier Product', 'unit', 'liquid', 1.00, 2.00, 3.00),
    (v_product_gallon, 'Gallon Product', 'gl', 'liquid', 32.10, 32.10, 32.10);
  INSERT INTO public.job_chemicals (
    id, job_id, product_id, quantity, unit, rate_per_acre, rate_unit,
    cost_per_unit_cents, price_per_unit_cents, sort_order, customer_supplied
  ) VALUES
    (v_job_chem, v_job, v_product_tier, 1, 'unit', 1, 'unit', 50, 100, 0, false),
    (v_job_chem_quote_a, v_job_quote, v_product_quote, 2, 'unit', 2, 'unit', 50, 150, 0, false),
    (v_job_chem_quote_b, v_job_quote, v_product_quote, 3, 'unit', 3, 'unit', 60, 275, 1, false),
    (v_job_chem_customer_supplied, v_job_customer_supplied, v_product_tier, 4, 'unit', 4, 'unit', 999, 999, 0, true),
    (v_job_chem_convert, v_job_convert, v_product_gallon, 1600, 'oz', 16, 'oz', 10, 25, 0, false),
    (v_job_chem_subset, v_job_subset, v_product_tier, 2, 'unit', 1, 'unit', 50, 100, 0, false);
  INSERT INTO public.quote_sections (id, field_id) VALUES
    ('70000000-0000-0000-0000-000000000001', v_field_50),
    ('70000000-0000-0000-0000-000000000002', v_field_50);
  UPDATE public.jobs
     SET quote_section_id = '70000000-0000-0000-0000-000000000001'
   WHERE id = v_job_quote;
  INSERT INTO public.quote_items (id, section_id, product_id, price_per_unit)
  VALUES
    (
      '71000000-0000-0000-0000-000000000001',
      '70000000-0000-0000-0000-000000000001',
      v_product_quote,
      1.50
    ),
    (
      '70000000-0000-0000-0000-000000000001',
      '70000000-0000-0000-0000-000000000002',
      v_product_quote,
      9.99
    );
  INSERT INTO public.application_services
    (id, name, default_rate_per_acre_cents, cost_per_acre_cents, is_active)
  VALUES
    (v_service, 'Application', 10, 4, true),
    (v_service_other, 'Wrong Application', 99, 9, true);
  UPDATE public.jobs
     SET application_service_id = v_service
   WHERE id = v_job_service;
  INSERT INTO public.customer_application_rates
    (customer_id, application_service_id, rate_per_acre_cents, season)
  VALUES
    (v_b, v_service, 20, 2026),
    (v_b, v_service, 35, 2025);

  -- Feature OFF delegates byte-for-byte to the renamed legacy implementation.
  v_plan := public.preview_field_app_invoice_split(
    '[{"field_id":"sentinel","applied_acres":1}]'::jsonb,
    '[{"line_key":"sentinel"}]'::jsonb,
    NULL,
    NULL
  );
  IF v_plan->>'legacy_sentinel' <> 'unchanged'
     OR v_plan->'locations' <> '[{"field_id":"sentinel","applied_acres":1}]'::jsonb
     OR v_plan->'chemicals' <> '[{"line_key":"sentinel"}]'::jsonb THEN
    RAISE EXCEPTION 'P2_FAIL(feature_off): legacy preview was not returned unchanged: %', v_plan;
  END IF;

  UPDATE public.app_settings
     SET setting_value = 'true'
   WHERE setting_key = 'feature_per_line_split_billing';

  -- 50/50 same-price line. Global manual must beat the available $1.50 quote.
  v_plan := public.preview_field_app_invoice_split(
    jsonb_build_array(jsonb_build_object('field_id', v_field_50, 'applied_acres', 1)),
    jsonb_build_array(jsonb_build_object(
      'line_key', 'chemical:half', 'sort_order', 0, 'product_id', v_product_quote,
      'description', 'Half', 'rate_per_acre', 1, 'rate_unit', 'unit',
      'manual_override', true, 'unit_price_cents', 100
    )), NULL, NULL, NULL, '{}'::jsonb
  );
  v_lines := v_plan->'billing_lines';
  v_shares := v_lines#>'{0,shares}';
  IF v_plan->>'grand_total_cents' <> '100'
     OR v_lines#>>'{0,price_basis}' <> 'same_price'
     OR v_lines#>>'{0,source_amount_cents}' <> '100'
     OR v_shares#>>'{0,amount_cents}' <> '50'
     OR v_shares#>>'{1,amount_cents}' <> '50'
     OR v_shares#>>'{0,allocated_quantity}' <> '0.5000'
     OR v_shares#>>'{1,allocated_quantity}' <> '0.5000'
     OR v_shares#>>'{0,base_price_source}' <> 'global_manual' THEN
    RAISE EXCEPTION 'P2_FAIL(50_50/manual_precedence): %', v_plan;
  END IF;
  IF length(v_lines#>>'{0,calculation_hash}') <> 64
     OR length(v_lines#>>'{0,vector_hash}') <> 64 THEN
    RAISE EXCEPTION 'P2_FAIL(hashes): %', v_plan;
  END IF;
  v_plan_again := public.preview_field_app_invoice_split(
    jsonb_build_array(jsonb_build_object('field_id', v_field_50, 'applied_acres', 1)),
    jsonb_build_array(jsonb_build_object(
      'line_key', 'chemical:half', 'sort_order', 0, 'product_id', v_product_quote,
      'description', 'Half', 'rate_per_acre', 1, 'rate_unit', 'unit',
      'manual_override', true, 'unit_price_cents', 100
    )), NULL, NULL, NULL, '{}'::jsonb
  );
  IF v_plan->>'calculation_hash' IS DISTINCT FROM v_plan_again->>'calculation_hash' THEN
    RAISE EXCEPTION 'P2_FAIL(hash_stability): % vs %', v_plan, v_plan_again;
  END IF;

  -- Money rounds only after the full-precision converted quantity multiply.
  -- 1.00004 units x 12,500c = 12,500.5c => 12,501c. Prematurely rounding
  -- quantity to its 4dp storage value (1.0000) would silently lose that cent.
  v_plan := public.preview_field_app_invoice_split(
    jsonb_build_array(jsonb_build_object('field_id', v_field_50, 'applied_acres', 1)),
    jsonb_build_array(jsonb_build_object(
      'line_key', 'chemical:round-once', 'sort_order', 0, 'product_id', v_product_tier,
      'description', 'Round once', 'rate_per_acre', 1.00004, 'rate_unit', 'unit',
      'manual_override', true, 'unit_price_cents', 12500
    )), NULL, NULL, NULL, '{}'::jsonb
  );
  IF v_plan#>>'{billing_lines,0,source_quantity}' <> '1.0000'
     OR v_plan#>>'{billing_lines,0,source_amount_cents}' <> '12501'
     OR v_plan#>>'{billing_lines,0,shares,0,amount_cents}' <> '6251'
     OR v_plan#>>'{billing_lines,0,shares,1,amount_cents}' <> '6250'
     OR v_plan->>'grand_total_cents' <> '12501' THEN
    RAISE EXCEPTION 'P2_FAIL(single_final_money_round): %', v_plan;
  END IF;

  -- Job-backed chemicals are exact frozen rows, not product/quote guesses. Two
  -- rows intentionally use the same product at different snapshotted prices.
  -- Caller-provided rate/quantity/price drift must not replace either snapshot.
  v_plan := public.preview_field_app_invoice_split(
    jsonb_build_array(jsonb_build_object('field_id', v_field_50, 'applied_acres', 1)),
    jsonb_build_array(
      jsonb_build_object(
        'job_chemical_id', v_job_chem_quote_a, 'line_key', 'chemical:' || v_job_chem_quote_a::text,
        'sort_order', 99, 'product_id', v_product_tier, 'description', 'Tampered A',
        'quantity', 99, 'rate_per_acre', 99, 'rate_unit', 'unit',
        'manual_override', false, 'unit_price_cents', 99999
      ),
      jsonb_build_object(
        'job_chemical_id', v_job_chem_quote_b, 'line_key', 'chemical:' || v_job_chem_quote_b::text,
        'sort_order', 98, 'product_id', v_product_tier, 'description', 'Tampered B',
        'quantity', 98, 'rate_per_acre', 98, 'rate_unit', 'unit'
      )
    ), NULL, NULL, v_job_quote, '{}'::jsonb
  );
  IF jsonb_array_length(v_plan->'billing_lines') <> 2
     OR v_plan#>>'{billing_lines,0,source_job_chemical_id}' <> v_job_chem_quote_a::text
     OR v_plan#>>'{billing_lines,0,product_id}' <> v_product_quote::text
     OR v_plan#>>'{billing_lines,0,source_quantity}' <> '2.0000'
     OR v_plan#>>'{billing_lines,0,source_unit_price_cents}' <> '150'
     OR v_plan#>>'{billing_lines,0,source_amount_cents}' <> '300'
     OR v_plan#>>'{billing_lines,0,source_input,cost_cents}' <> '50'
     OR v_plan#>>'{billing_lines,0,shares,0,base_price_source}' <> 'job_snapshot'
     OR v_plan#>>'{billing_lines,1,source_job_chemical_id}' <> v_job_chem_quote_b::text
     OR v_plan#>>'{billing_lines,1,source_quantity}' <> '3.0000'
     OR v_plan#>>'{billing_lines,1,source_unit_price_cents}' <> '275'
     OR v_plan#>>'{billing_lines,1,source_amount_cents}' <> '825'
     OR v_plan#>>'{billing_lines,1,source_input,cost_cents}' <> '60'
     OR v_plan->>'grand_total_cents' <> '1125' THEN
    RAISE EXCEPTION 'P2_FAIL(exact_job_chemical_snapshots): %', v_plan;
  END IF;

  -- Without a source job there is no authoritative quote section. Do not guess
  -- from either quote attached to the field; fall back to each customer's tier.
  v_plan := public.preview_field_app_invoice_split(
    jsonb_build_array(jsonb_build_object('field_id', v_field_50, 'applied_acres', 1)),
    jsonb_build_array(jsonb_build_object(
      'line_key', 'chemical:no-job-quote', 'sort_order', 0, 'product_id', v_product_quote,
      'description', 'No job quote', 'rate_per_acre', 1, 'rate_unit', 'unit'
    )), NULL, NULL, NULL, '{}'::jsonb
  );
  IF v_plan#>>'{billing_lines,0,shares,0,base_unit_price_cents}' <> '100'
     OR v_plan#>>'{billing_lines,0,shares,0,base_price_source}' <> 'tier'
     OR v_plan#>>'{billing_lines,0,shares,1,base_unit_price_cents}' <> '200'
     OR v_plan#>>'{billing_lines,0,shares,1,base_price_source}' <> 'tier'
     OR v_plan->>'grand_total_cents' <> '150' THEN
    RAISE EXCEPTION 'P2_FAIL(no_job_quote_fallback): %', v_plan;
  END IF;

  -- Exact three-way even vector + one cent + 4dp quantity residual. The lowest
  -- customer UUID wins both the extra quantity tick and the extra cent.
  v_plan := public.preview_field_app_invoice_split(
    jsonb_build_array(jsonb_build_object('field_id', v_field_3, 'applied_acres', 1)),
    jsonb_build_array(jsonb_build_object(
      'line_key', 'chemical:thirds', 'sort_order', 0, 'product_id', v_product_tier,
      'description', 'Thirds', 'rate_per_acre', 1, 'rate_unit', 'unit',
      'manual_override', true, 'unit_price_cents', 1
    )), NULL, NULL, NULL,
    jsonb_build_object('lines', jsonb_build_array(jsonb_build_object(
      'line_key', 'chemical:thirds', 'split_mode', 'custom', 'vector_mode', 'even',
      'split_override_reason', 'Three-way proof'
    )))
  );
  v_shares := v_plan#>'{billing_lines,0,shares}';
  IF v_shares#>>'{0,split_micro_pct}' <> '33333334'
     OR v_shares#>>'{1,split_micro_pct}' <> '33333333'
     OR v_shares#>>'{2,split_micro_pct}' <> '33333333'
     OR v_shares#>>'{0,allocated_quantity}' <> '0.3334'
     OR v_shares#>>'{1,allocated_quantity}' <> '0.3333'
     OR v_shares#>>'{2,allocated_quantity}' <> '0.3333'
     OR v_shares#>>'{0,amount_cents}' <> '1'
     OR v_shares#>>'{1,amount_cents}' <> '0'
     OR v_shares#>>'{2,amount_cents}' <> '0' THEN
    RAISE EXCEPTION 'P2_FAIL(exact_three_way_one_cent): %', v_plan;
  END IF;

  -- Signed half-cent: PostgreSQL round(-12.5) = -13. Largest remainder on ABS
  -- produces -7/-6; preview total equals the exact Phase 3 plan total.
  v_plan := public.preview_field_app_invoice_split(
    jsonb_build_array(jsonb_build_object('field_id', v_field_50, 'applied_acres', 1)),
    jsonb_build_array(jsonb_build_object(
      'line_key', 'chemical:return', 'sort_order', 0, 'product_id', v_product_tier,
      'description', 'Return', 'rate_per_acre', -0.5, 'rate_unit', 'unit',
      'manual_override', true, 'unit_price_cents', 25
    )), NULL, NULL, NULL, '{}'::jsonb
  );
  v_shares := v_plan#>'{billing_lines,0,shares}';
  SELECT sum((entry->>'amount_cents')::bigint) INTO v_sum
  FROM jsonb_array_elements(v_shares) entry;
  IF v_plan->>'grand_total_cents' <> '-13'
     OR v_plan#>>'{billing_lines,0,source_amount_cents}' <> '-13'
     OR v_shares#>>'{0,amount_cents}' <> '-7'
     OR v_shares#>>'{1,amount_cents}' <> '-6'
     OR v_sum <> -13 THEN
    RAISE EXCEPTION 'P2_FAIL(negative_half_cent): %', v_plan;
  END IF;

  -- Different tier prices, then a one-person override layered on top.
  v_plan := public.preview_field_app_invoice_split(
    jsonb_build_array(jsonb_build_object('field_id', v_field_50, 'applied_acres', 1)),
    jsonb_build_array(jsonb_build_object(
      'line_key', 'chemical:person-price', 'sort_order', 0, 'product_id', v_product_tier,
      'description', 'Own price', 'rate_per_acre', 1, 'rate_unit', 'unit'
    )), NULL, NULL, NULL,
    jsonb_build_object('lines', jsonb_build_array(jsonb_build_object(
      'line_key', 'chemical:person-price',
      'price_overrides', jsonb_build_array(jsonb_build_object(
        'customer_id', v_b, 'unit_price_cents', 300, 'reason', 'Prepaid locked price'
      ))
    )))
  );
  v_shares := v_plan#>'{billing_lines,0,shares}';
  IF v_plan#>>'{billing_lines,0,price_basis}' <> 'per_person_price'
     OR v_plan#>>'{billing_lines,0,source_amount_cents}' IS NOT NULL
     OR v_shares#>>'{0,base_unit_price_cents}' <> '100'
     OR v_shares#>>'{0,amount_cents}' <> '50'
     OR v_shares#>>'{1,base_unit_price_cents}' <> '200'
     OR v_shares#>>'{1,unit_price_cents}' <> '300'
     OR v_shares#>>'{1,price_mode}' <> 'override'
     OR v_shares#>>'{1,amount_cents}' <> '150'
     OR v_plan->>'grand_total_cents' <> '200' THEN
    RAISE EXCEPTION 'P2_FAIL(per_person_price_override): %', v_plan;
  END IF;

  -- 100/0 service split keeps the zero customer row. Service base pricing
  -- resolves customer rate before the default service price.
  v_plan := public.preview_field_app_invoice_split(
    jsonb_build_array(jsonb_build_object('field_id', v_field_50, 'applied_acres', 1)),
    '[]'::jsonb, NULL, NULL, v_job_service,
    jsonb_build_object('lines', jsonb_build_array(jsonb_build_object(
      'line_key', 'service:' || v_service::text,
      'split_mode', 'custom', 'split_override_reason', 'Tenant pays service',
      'vector', jsonb_build_array(
        jsonb_build_object('customer_id', v_a, 'split_micro_pct', 100000000),
        jsonb_build_object('customer_id', v_b, 'split_micro_pct', 0)
      )
    )))
  );
  v_shares := v_plan#>'{billing_lines,0,shares}';
  IF jsonb_array_length(v_shares) <> 2
     OR v_shares#>>'{0,amount_cents}' <> '10'
     OR v_shares#>>'{1,amount_cents}' <> '0'
     OR v_shares#>>'{1,allocated_acres}' <> '0.0000'
     OR v_shares#>>'{1,base_unit_price_cents}' <> '35'
     OR v_shares#>>'{1,base_price_source}' <> 'customer_application_rates'
     OR v_plan#>>'{billing_lines,0,source_input,cost_per_acre_cents}' <> '4'
     OR v_plan#>>'{billing_lines,0,source_input,season}' <> '2025' THEN
    RAISE EXCEPTION 'P2_FAIL(service_100_0_job_season): %', v_plan;
  END IF;

  -- One-cent flat fee follows the same deterministic largest-remainder rule.
  v_plan := public.preview_field_app_invoice_split(
    jsonb_build_array(jsonb_build_object('field_id', v_field_50, 'applied_acres', 1)),
    '[]'::jsonb, NULL, NULL, NULL,
    jsonb_build_object('flat_fees', jsonb_build_array(jsonb_build_object(
      'line_key', 'flat_fee:proof', 'description', 'Proof fee',
      'source_amount_cents', 1, 'sort_order', 1
    )))
  );
  IF v_plan#>>'{billing_lines,0,shares,0,amount_cents}' <> '1'
     OR v_plan#>>'{billing_lines,0,shares,1,amount_cents}' <> '0'
     OR v_plan->>'grand_total_cents' <> '1' THEN
    RAISE EXCEPTION 'P2_FAIL(flat_fee_one_cent): %', v_plan;
  END IF;

  -- Job snapshot wins over the field's 50/50 default.
  v_plan := public.preview_field_app_invoice_split(
    jsonb_build_array(jsonb_build_object('field_id', v_field_job, 'applied_acres', 1)),
    jsonb_build_array(jsonb_build_object(
      'job_chemical_id', v_job_chem,
      'line_key', 'chemical:' || v_job_chem::text,
      'sort_order', 999, 'product_id', v_product_quote,
      'description', 'Tampered Job', 'rate_per_acre', 999, 'rate_unit', 'unit',
      'manual_override', true, 'unit_price_cents', 777
    )), NULL, NULL, v_job, '{}'::jsonb
  );
  IF v_plan->>'customer_count' <> '1'
     OR v_plan#>>'{billing_lines,0,shares,0,customer_id}' <> v_c::text
     OR v_plan#>>'{billing_lines,0,source_job_chemical_id}' <> v_job_chem::text
     OR v_plan#>>'{billing_lines,0,product_id}' <> v_product_tier::text
     OR v_plan#>>'{billing_lines,0,source_amount_cents}' <> '100'
     OR v_plan#>>'{billing_lines,0,shares,0,base_unit_price_cents}' <> '100'
     OR v_plan#>>'{billing_lines,0,shares,0,base_price_source}' <> 'job_snapshot'
     OR v_plan#>>'{shares_detail,rows,0,vector_source}' <> 'job_snapshot' THEN
    RAISE EXCEPTION 'P2_FAIL(job_snapshot_precedence): %', v_plan;
  END IF;

  -- Production permits a nullable frozen job price. Missing or negative prices
  -- must fail closed instead of becoming legitimate-looking zero-dollar lines.
  BEGIN
    UPDATE public.job_chemicals
       SET price_per_unit_cents = NULL
     WHERE id = v_job_chem;
    PERFORM public.preview_field_app_invoice_split(
      jsonb_build_array(jsonb_build_object('field_id', v_field_job, 'applied_acres', 1)),
      jsonb_build_array(jsonb_build_object('job_chemical_id', v_job_chem)),
      NULL, NULL, v_job, '{}'::jsonb
    );
    RAISE EXCEPTION 'P2_FAIL(missing_job_price): <no error>';
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err NOT LIKE '%PER_LINE_CHEMICAL_PRICE_REQUIRED%' THEN RAISE; END IF;
  END;

  BEGIN
    UPDATE public.job_chemicals
       SET price_per_unit_cents = -1
     WHERE id = v_job_chem;
    PERFORM public.preview_field_app_invoice_split(
      jsonb_build_array(jsonb_build_object('field_id', v_field_job, 'applied_acres', 1)),
      jsonb_build_array(jsonb_build_object('job_chemical_id', v_job_chem)),
      NULL, NULL, v_job, '{}'::jsonb
    );
    RAISE EXCEPTION 'P2_FAIL(negative_job_price): <no error>';
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err NOT LIKE '%PER_LINE_CHEMICAL_PRICE_REQUIRED%' THEN RAISE; END IF;
  END;

  -- A job's frozen service identity is authoritative. An active but unrelated
  -- browser-selected service must not change job-backed billing.
  v_err := NULL;
  BEGIN
    PERFORM public.preview_field_app_invoice_split(
      jsonb_build_array(jsonb_build_object('field_id', v_field_50, 'applied_acres', 1)),
      '[]'::jsonb, v_service_other, NULL, v_job_service, '{}'::jsonb
    );
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
  IF v_err NOT LIKE '%PER_LINE_APPLICATION_SERVICE_CONTEXT_MISMATCH%' THEN
    RAISE EXCEPTION 'P2_FAIL(job_application_service_identity): %', COALESCE(v_err, '<no error>');
  END IF;

  INSERT INTO public.invoices (
    id, customer_id, job_id, application_service_id, season,
    total_amount_cents, created_by
  ) VALUES (
    '83000000-0000-0000-0000-000000000099', v_a, v_job_service,
    v_service, 2025, 0, v_admin
  );
  v_err := NULL;
  BEGIN
    PERFORM public.preview_field_app_invoice_split(
      jsonb_build_array(jsonb_build_object('field_id', v_field_50, 'applied_acres', 1)),
      '[]'::jsonb, v_service_other,
      '83000000-0000-0000-0000-000000000099', NULL, '{}'::jsonb
    );
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
  IF v_err NOT LIKE '%PER_LINE_APPLICATION_SERVICE_CONTEXT_MISMATCH%' THEN
    RAISE EXCEPTION 'P2_FAIL(invoice_application_service_identity): %', COALESCE(v_err, '<no error>');
  END IF;

  -- A customer-supplied job chemical is always zero dollars, even when the
  -- browser tries to smuggle a manual price into its payload.
  v_plan := public.preview_field_app_invoice_split(
    jsonb_build_array(jsonb_build_object('field_id', v_field_50, 'applied_acres', 1)),
    jsonb_build_array(jsonb_build_object(
      'job_chemical_id', v_job_chem_customer_supplied,
      'line_key', 'chemical:' || v_job_chem_customer_supplied::text,
      'product_id', v_product_tier, 'quantity', 999,
      'manual_override', true, 'unit_price_cents', 777
    )), NULL, NULL, v_job_customer_supplied, '{}'::jsonb
  );
  IF v_plan#>>'{billing_lines,0,source_quantity}' <> '4.0000'
     OR v_plan#>>'{billing_lines,0,source_unit_price_cents}' <> '0'
     OR v_plan#>>'{billing_lines,0,source_amount_cents}' <> '0'
     OR v_plan#>>'{billing_lines,0,source_input,cost_cents}' <> '0'
     OR v_plan#>>'{billing_lines,0,shares,0,base_unit_price_cents}' <> '0'
     OR v_plan#>>'{billing_lines,0,shares,0,base_price_source}' <> 'job_customer_supplied'
     OR v_plan->>'grand_total_cents' <> '0' THEN
    RAISE EXCEPTION 'P2_FAIL(customer_supplied_zero): %', v_plan;
  END IF;

  v_err := NULL;
  BEGIN
    PERFORM public.preview_field_app_invoice_split(
      jsonb_build_array(jsonb_build_object('field_id', v_field_50, 'applied_acres', 1)),
      jsonb_build_array(jsonb_build_object(
        'job_chemical_id', v_job_chem_customer_supplied,
        'line_key', 'chemical:' || v_job_chem_customer_supplied::text
      )), NULL, NULL, v_job_customer_supplied,
      jsonb_build_object('lines', jsonb_build_array(jsonb_build_object(
        'line_key', 'chemical:' || v_job_chem_customer_supplied::text,
        'price_overrides', jsonb_build_array(jsonb_build_object(
          'customer_id', v_a, 'unit_price_cents', 777, 'reason', 'Must be rejected'
        ))
      )))
    );
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
  IF v_err NOT LIKE '%PER_LINE_CUSTOMER_SUPPLIED_PRICE_OVERRIDE_UNSUPPORTED%' THEN
    RAISE EXCEPTION 'P2_FAIL(customer_supplied_price_override): %', COALESCE(v_err, '<no error>');
  END IF;

  -- Job context is fail-closed: every selected field must belong to the job,
  -- and every chemical must carry an exact job_chemical_id from that job.
  v_err := NULL;
  BEGIN
    PERFORM public.preview_field_app_invoice_split(
      jsonb_build_array(jsonb_build_object('field_id', v_field_outside, 'applied_acres', 1)),
      jsonb_build_array(
        jsonb_build_object('job_chemical_id', v_job_chem_quote_a),
        jsonb_build_object('job_chemical_id', v_job_chem_quote_b)
      ), NULL, NULL, v_job_quote, '{}'::jsonb
    );
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
  IF v_err NOT LIKE '%PER_LINE_FIELD_NOT_IN_JOB%' THEN
    RAISE EXCEPTION 'P2_FAIL(job_field_membership): %', COALESCE(v_err, '<no error>');
  END IF;

  v_err := NULL;
  BEGIN
    PERFORM public.preview_field_app_invoice_split(
      jsonb_build_array(jsonb_build_object('field_id', v_field_job, 'applied_acres', 1)),
      jsonb_build_array(jsonb_build_object(
        'product_id', v_product_tier, 'quantity', 1, 'rate_unit', 'unit'
      )), NULL, NULL, v_job, '{}'::jsonb
    );
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
  IF v_err NOT LIKE '%PER_LINE_JOB_CHEMICAL_ID_REQUIRED%' THEN
    RAISE EXCEPTION 'P2_FAIL(job_chemical_identity_required): %', COALESCE(v_err, '<no error>');
  END IF;

  -- A job snapshot stores quantity and price in the same selected row unit.
  -- JobDetail reconciles both together (for example, per-gallon price becomes
  -- per-ounce price when it stores an ounce quantity). Billing must preserve that
  -- frozen pair instead of converting only quantity back to product inventory unit.
  v_plan := public.preview_field_app_invoice_split(
    jsonb_build_array(jsonb_build_object('field_id', v_field_convert, 'applied_acres', 100)),
    jsonb_build_array(jsonb_build_object('job_chemical_id', v_job_chem_convert)),
    NULL, NULL, v_job_convert, '{}'::jsonb
  );
  IF v_plan#>>'{billing_lines,0,source_quantity}' <> '1600.0000'
     OR v_plan#>>'{billing_lines,0,source_unit_price_cents}' <> '25'
     OR v_plan#>>'{billing_lines,0,source_amount_cents}' <> '40000'
     OR v_plan#>>'{billing_lines,0,source_input,snapshot_quantity}' <> '1600'
     OR v_plan#>>'{billing_lines,0,source_input,snapshot_unit}' <> 'oz'
     OR v_plan#>>'{billing_lines,0,source_input,pricing_unit}' <> 'oz' THEN
    RAISE EXCEPTION 'P2_FAIL(job_snapshot_unit_price_pair): %', v_plan;
  END IF;

  -- Full-job chemistry may not be reallocated over only a caller-selected subset
  -- of the job's fields. Without authoritative per-field chemical quantities the
  -- calculator must require the exact complete field set.
  v_err := NULL;
  BEGIN
    PERFORM public.preview_field_app_invoice_split(
      jsonb_build_array(jsonb_build_object('field_id', v_field_job, 'applied_acres', 1)),
      jsonb_build_array(jsonb_build_object('job_chemical_id', v_job_chem_subset)),
      NULL, NULL, v_job_subset, '{}'::jsonb
    );
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
  IF v_err NOT LIKE '%PER_LINE_JOB_FIELD_SET_INCOMPLETE%' THEN
    RAISE EXCEPTION 'P2_FAIL(job_field_set_incomplete): %', COALESCE(v_err, '<no error>');
  END IF;

  -- Field owner fallback when neither snapshot nor field defaults exist.
  v_plan := public.preview_field_app_invoice_split(
    jsonb_build_array(jsonb_build_object('field_id', v_field_fallback, 'applied_acres', 1)),
    jsonb_build_array(jsonb_build_object(
      'line_key', 'chemical:fallback', 'sort_order', 0, 'product_id', v_product_tier,
      'description', 'Fallback', 'rate_per_acre', 1, 'rate_unit', 'unit',
      'manual_override', true, 'unit_price_cents', 100
    )), NULL, NULL, NULL, '{}'::jsonb
  );
  IF v_plan#>>'{billing_lines,0,shares,0,customer_id}' <> v_b::text
     OR v_plan#>>'{shares_detail,rows,0,vector_source}' <> 'field_owner_fallback' THEN
    RAISE EXCEPTION 'P2_FAIL(field_owner_fallback): %', v_plan;
  END IF;

  -- Mode A rejects the entire feature before a plan can be returned.
  v_err := NULL;
  BEGIN
    PERFORM public.preview_field_app_invoice_split(
      jsonb_build_array(jsonb_build_object('field_id', v_field_mode_a, 'applied_acres', 1)),
      jsonb_build_array(jsonb_build_object(
        'line_key', 'chemical:mode-a', 'sort_order', 0, 'product_id', v_product_tier,
        'description', 'Mode A', 'rate_per_acre', 1, 'rate_unit', 'unit'
      )), NULL, NULL, NULL, '{}'::jsonb
    );
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
  IF v_err NOT LIKE '%PER_LINE_MODE_A_UNSUPPORTED%' THEN
    RAISE EXCEPTION 'P2_FAIL(mode_a_rejection): %', COALESCE(v_err, '<no error>');
  END IF;

  -- Incomplete custom vectors are rejected; zero rows must be explicit.
  v_err := NULL;
  BEGIN
    PERFORM public.preview_field_app_invoice_split(
      jsonb_build_array(jsonb_build_object('field_id', v_field_50, 'applied_acres', 1)),
      jsonb_build_array(jsonb_build_object(
        'line_key', 'chemical:bad-vector', 'sort_order', 0, 'product_id', v_product_tier,
        'description', 'Bad', 'rate_per_acre', 1, 'rate_unit', 'unit',
        'manual_override', true, 'unit_price_cents', 100
      )), NULL, NULL, NULL,
      jsonb_build_object('lines', jsonb_build_array(jsonb_build_object(
        'line_key', 'chemical:bad-vector', 'split_mode', 'custom',
        'split_override_reason', 'Invalid proof',
        'vector', jsonb_build_array(jsonb_build_object(
          'customer_id', v_a, 'split_micro_pct', 100000000
        ))
      )))
    );
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
  IF v_err NOT LIKE '%PER_LINE_CUSTOM_VECTOR_INCOMPLETE%' THEN
    RAISE EXCEPTION 'P2_FAIL(incomplete_vector_rejection): %', COALESCE(v_err, '<no error>');
  END IF;

  -- A duplicate customer cannot impersonate a complete vector, even when the
  -- row count and micro-percent sum look valid.
  v_err := NULL;
  BEGIN
    PERFORM public.preview_field_app_invoice_split(
      jsonb_build_array(jsonb_build_object('field_id', v_field_50, 'applied_acres', 1)),
      jsonb_build_array(jsonb_build_object(
        'line_key', 'chemical:duplicate-vector', 'sort_order', 0, 'product_id', v_product_tier,
        'description', 'Duplicate', 'rate_per_acre', 1, 'rate_unit', 'unit',
        'manual_override', true, 'unit_price_cents', 100
      )), NULL, NULL, NULL,
      jsonb_build_object('lines', jsonb_build_array(jsonb_build_object(
        'line_key', 'chemical:duplicate-vector', 'split_mode', 'custom',
        'split_override_reason', 'Invalid duplicate proof',
        'vector', jsonb_build_array(
          jsonb_build_object('customer_id', v_a, 'split_micro_pct', 50000000),
          jsonb_build_object('customer_id', v_a, 'split_micro_pct', 50000000)
        )
      )))
    );
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
  IF v_err NOT LIKE '%PER_LINE_CUSTOM_VECTOR_CUSTOMER_SET_MISMATCH%' THEN
    RAISE EXCEPTION 'P2_FAIL(duplicate_vector_rejection): %', COALESCE(v_err, '<no error>');
  END IF;

  -- Private calculator is not a browser RPC; public preview remains single-overload.
  SELECT count(*) INTO v_count
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'preview_field_app_invoice_split';
  IF v_count <> 1 OR has_function_privilege(
    'authenticated',
    'public._calculate_per_line_split_billing_plan(uuid,jsonb,jsonb,uuid,uuid,jsonb)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'P2_FAIL(private_or_overload_guard): preview %, private_execute %',
      v_count,
      has_function_privilege(
        'authenticated',
        'public._calculate_per_line_split_billing_plan(uuid,jsonb,jsonb,uuid,uuid,jsonb)',
        'EXECUTE'
      );
  END IF;

  -- A share cannot claim customer A while pointing at customer B's invoice item.
  -- This vector is arithmetically 100%, so Phase 1 alone accepted it; the
  -- relational follow-up migration must fail it closed.
  BEGIN
    INSERT INTO public.field_app_billing_sets (
      id, invoice_group_id, job_id, primary_customer_id, created_by
    ) VALUES (
      '80000000-0000-0000-0000-000000000001',
      '81000000-0000-0000-0000-000000000001', v_job, v_a, v_admin
    );
    INSERT INTO public.field_app_billing_lines (
      id, billing_set_id, line_kind, price_basis, description,
      source_quantity, source_amount_cents
    ) VALUES (
      '82000000-0000-0000-0000-000000000001',
      '80000000-0000-0000-0000-000000000001',
      'chemical', 'same_price', 'Invalid customer relationship', 1, 100
    );
    INSERT INTO public.invoices (
      id, customer_id, invoice_group_id, job_id, total_amount_cents, created_by
    ) VALUES (
      '83000000-0000-0000-0000-000000000001', v_b,
      '81000000-0000-0000-0000-000000000001', v_job, 100, v_admin
    );
    INSERT INTO public.invoice_items (
      id, invoice_id, quantity, unit_price_cents, extended_cents
    ) VALUES (
      '84000000-0000-0000-0000-000000000001',
      '83000000-0000-0000-0000-000000000001', 1, 100, 100
    );
    INSERT INTO public.invoice_line_shares (
      billing_line_id, invoice_item_id, customer_id, split_mode,
      split_micro_pct, allocated_quantity, base_unit_price_cents,
      base_price_source, price_mode, unit_price_cents, amount_cents,
      calculation_hash, vector_hash, created_by
    ) VALUES (
      '82000000-0000-0000-0000-000000000001',
      '84000000-0000-0000-0000-000000000001', v_a, 'field_default',
      100000000, 1, 100, 'job_snapshot', 'default', 100, 100,
      repeat('a', 64), repeat('b', 64), v_admin
    );
    SET CONSTRAINTS ALL IMMEDIATE;
    RAISE EXCEPTION 'P2_FAIL(share_customer_invoice_mismatch): <no error>';
  EXCEPTION
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
      IF v_err NOT LIKE '%PER_LINE_SHARE_CUSTOMER_INVOICE_MISMATCH%' THEN
        RAISE;
      END IF;
  END;

  -- Build one valid two-customer graph, force every deferred constraint, then
  -- prove each durable money/quantity/header relationship rejects corruption.
  INSERT INTO public.field_app_billing_sets (
    id, invoice_group_id, job_id, primary_customer_id, created_by
  ) VALUES (
    '80000000-0000-0000-0000-000000000010',
    '81000000-0000-0000-0000-000000000010', v_job, v_a, v_admin
  );
  INSERT INTO public.field_app_billing_lines (
    id, billing_set_id, line_kind, price_basis, description,
    product_id, source_quantity, source_acres, source_amount_cents
  ) VALUES (
    '82000000-0000-0000-0000-000000000010',
    '80000000-0000-0000-0000-000000000010',
    'chemical', 'same_price', 'Valid relational graph', v_product_tier, 1, 1, 100
  );
  INSERT INTO public.invoices (
    id, customer_id, invoice_group_id, job_id, total_amount_cents, created_by
  ) VALUES
    ('83000000-0000-0000-0000-000000000010', v_a,
     '81000000-0000-0000-0000-000000000010', v_job, 50, v_admin),
    ('83000000-0000-0000-0000-000000000011', v_b,
     '81000000-0000-0000-0000-000000000010', v_job, 50, v_admin);
  INSERT INTO public.invoice_items (
    id, invoice_id, product_id, quantity, acres, unit_price_cents, extended_cents
  ) VALUES
    ('84000000-0000-0000-0000-000000000010',
     '83000000-0000-0000-0000-000000000010', v_product_tier, 0.5, 0.50, 100, 50),
    ('84000000-0000-0000-0000-000000000011',
     '83000000-0000-0000-0000-000000000011', v_product_tier, 0.5, 0.50, 100, 50);
  INSERT INTO public.invoice_line_shares (
    id, billing_line_id, invoice_item_id, customer_id, split_mode,
    split_micro_pct, allocated_quantity, allocated_acres,
    base_unit_price_cents, base_price_source, price_mode,
    unit_price_cents, amount_cents, calculation_hash, vector_hash, created_by
  ) VALUES
    ('85000000-0000-0000-0000-000000000010',
     '82000000-0000-0000-0000-000000000010',
     '84000000-0000-0000-0000-000000000010', v_a, 'field_default',
     50000000, 0.5, 0.5, 100, 'job_snapshot', 'default', 100, 50,
     repeat('c', 64), repeat('d', 64), v_admin),
    ('85000000-0000-0000-0000-000000000011',
     '82000000-0000-0000-0000-000000000010',
     '84000000-0000-0000-0000-000000000011', v_b, 'field_default',
     50000000, 0.5, 0.5, 100, 'job_snapshot', 'default', 100, 50,
     repeat('c', 64), repeat('d', 64), v_admin);
  SET CONSTRAINTS ALL IMMEDIATE;

  -- A share cannot escape to a same-customer invoice outside its billing set's
  -- group. Customer and cents still match, so only relational membership catches it.
  INSERT INTO public.invoices (
    id, customer_id, invoice_group_id, job_id, total_amount_cents, created_by
  ) VALUES (
    '83000000-0000-0000-0000-000000000012', v_a,
    '81000000-0000-0000-0000-000000000012', v_job, 50, v_admin
  );
  INSERT INTO public.invoice_items (
    id, invoice_id, product_id, quantity, acres, unit_price_cents, extended_cents
  ) VALUES (
    '84000000-0000-0000-0000-000000000013',
    '83000000-0000-0000-0000-000000000012', v_product_tier, 0.5, 0.50, 100, 50
  );
  BEGIN
    UPDATE public.invoice_line_shares
       SET invoice_item_id = '84000000-0000-0000-0000-000000000013'
     WHERE id = '85000000-0000-0000-0000-000000000010';
    RAISE EXCEPTION 'P2_FAIL(share_invoice_set_mismatch): <no error>';
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err NOT LIKE '%PER_LINE_SHARE_INVOICE_SET_MISMATCH%' THEN RAISE; END IF;
  END;

  -- The audit share and the persisted item are one identity. Quantity, rounded
  -- invoice acres, effective price, and chemical product may not drift apart.
  BEGIN
    UPDATE public.invoice_items SET quantity = 0.4
     WHERE id = '84000000-0000-0000-0000-000000000010';
    RAISE EXCEPTION 'P2_FAIL(share_item_quantity_identity): <no error>';
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err NOT LIKE '%PER_LINE_SHARE_ITEM_IDENTITY_MISMATCH%' THEN RAISE; END IF;
  END;

  -- An ungrouped billing set is still one billing event for one recipient, so
  -- every line must persist on the same single child invoice.
  BEGIN
    SET CONSTRAINTS ALL DEFERRED;
    INSERT INTO public.field_app_billing_sets (
      id, job_id, primary_customer_id, created_by
    ) VALUES (
      '80000000-0000-0000-0000-000000000020', v_job, v_a, v_admin
    );
    INSERT INTO public.field_app_billing_lines (
      id, billing_set_id, line_kind, price_basis, product_id, description,
      source_quantity, source_acres, source_amount_cents
    ) VALUES
      ('82000000-0000-0000-0000-000000000020',
       '80000000-0000-0000-0000-000000000020',
       'chemical', 'same_price', v_product_tier, 'Ungrouped line A', 1, 1, 100),
      ('82000000-0000-0000-0000-000000000021',
       '80000000-0000-0000-0000-000000000020',
       'chemical', 'same_price', v_product_tier, 'Ungrouped line B', 1, 1, 100);
    INSERT INTO public.invoices (
      id, customer_id, job_id, total_amount_cents, created_by
    ) VALUES
      ('83000000-0000-0000-0000-000000000020', v_a, v_job, 100, v_admin),
      ('83000000-0000-0000-0000-000000000021', v_a, v_job, 100, v_admin);
    INSERT INTO public.invoice_items (
      id, invoice_id, product_id, quantity, acres, unit_price_cents, extended_cents
    ) VALUES
      ('84000000-0000-0000-0000-000000000020',
       '83000000-0000-0000-0000-000000000020', v_product_tier, 1, 1, 100, 100),
      ('84000000-0000-0000-0000-000000000021',
       '83000000-0000-0000-0000-000000000021', v_product_tier, 1, 1, 100, 100);
    INSERT INTO public.invoice_line_shares (
      id, billing_line_id, invoice_item_id, customer_id, split_mode,
      split_micro_pct, allocated_quantity, allocated_acres,
      base_unit_price_cents, base_price_source, price_mode,
      unit_price_cents, amount_cents, calculation_hash, vector_hash, created_by
    ) VALUES
      ('85000000-0000-0000-0000-000000000020',
       '82000000-0000-0000-0000-000000000020',
       '84000000-0000-0000-0000-000000000020', v_a, 'field_default',
       100000000, 1, 1, 100, 'job_snapshot', 'default', 100, 100,
       repeat('e', 64), repeat('f', 64), v_admin),
      ('85000000-0000-0000-0000-000000000021',
       '82000000-0000-0000-0000-000000000021',
       '84000000-0000-0000-0000-000000000021', v_a, 'field_default',
       100000000, 1, 1, 100, 'job_snapshot', 'default', 100, 100,
       repeat('e', 64), repeat('f', 64), v_admin);
    SET CONSTRAINTS ALL IMMEDIATE;
    RAISE EXCEPTION 'P2_FAIL(ungrouped_multiple_invoices): <no error>';
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err NOT LIKE '%PER_LINE_SHARE_INVOICE_SET_MISMATCH%' THEN RAISE; END IF;
  END;

  BEGIN
    UPDATE public.invoice_items SET acres = 0.40
     WHERE id = '84000000-0000-0000-0000-000000000010';
    RAISE EXCEPTION 'P2_FAIL(share_item_acres_identity): <no error>';
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err NOT LIKE '%PER_LINE_SHARE_ITEM_IDENTITY_MISMATCH%' THEN RAISE; END IF;
  END;

  BEGIN
    UPDATE public.invoice_items SET unit_price_cents = 99
     WHERE id = '84000000-0000-0000-0000-000000000010';
    RAISE EXCEPTION 'P2_FAIL(share_item_price_identity): <no error>';
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err NOT LIKE '%PER_LINE_SHARE_ITEM_IDENTITY_MISMATCH%' THEN RAISE; END IF;
  END;

  BEGIN
    UPDATE public.invoice_items SET product_id = v_product_quote
     WHERE id = '84000000-0000-0000-0000-000000000010';
    RAISE EXCEPTION 'P2_FAIL(share_item_product_identity): <no error>';
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err NOT LIKE '%PER_LINE_SHARE_ITEM_IDENTITY_MISMATCH%' THEN RAISE; END IF;
  END;

  -- Service logical lines bind to the frozen application service on every child
  -- invoice; a different active service is still the wrong service.
  BEGIN
    SET CONSTRAINTS ALL DEFERRED;
    UPDATE public.field_app_billing_lines
       SET line_kind = 'service', product_id = NULL, application_service_id = v_service
     WHERE id = '82000000-0000-0000-0000-000000000010';
    UPDATE public.invoice_items
       SET product_id = NULL
     WHERE id IN (
       '84000000-0000-0000-0000-000000000010',
       '84000000-0000-0000-0000-000000000011'
     );
    UPDATE public.invoices
       SET application_service_id = v_service
     WHERE id IN (
       '83000000-0000-0000-0000-000000000010',
       '83000000-0000-0000-0000-000000000011'
     );
    SET CONSTRAINTS ALL IMMEDIATE;
    UPDATE public.invoices
       SET application_service_id = v_service_other
     WHERE id = '83000000-0000-0000-0000-000000000010';
    RAISE EXCEPTION 'P2_FAIL(share_item_service_identity): <no error>';
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err NOT LIKE '%PER_LINE_SHARE_ITEM_IDENTITY_MISMATCH%' THEN RAISE; END IF;
  END;

  BEGIN
    SET CONSTRAINTS ALL DEFERRED;
    DELETE FROM public.invoice_line_shares
     WHERE id = '85000000-0000-0000-0000-000000000011';
    DELETE FROM public.invoice_items
     WHERE id = '84000000-0000-0000-0000-000000000011';
    UPDATE public.invoices SET total_amount_cents = 0
     WHERE id = '83000000-0000-0000-0000-000000000011';
    UPDATE public.invoice_line_shares
       SET split_micro_pct = 100000000,
           allocated_quantity = 1,
           allocated_acres = 1,
           amount_cents = 100
     WHERE id = '85000000-0000-0000-0000-000000000010';
    UPDATE public.invoice_items
       SET quantity = 1, acres = 1, extended_cents = 100
     WHERE id = '84000000-0000-0000-0000-000000000010';
    UPDATE public.invoices SET total_amount_cents = 100
     WHERE id = '83000000-0000-0000-0000-000000000010';
    SET CONSTRAINTS ALL IMMEDIATE;
    RAISE EXCEPTION 'P2_FAIL(group_customer_set_mismatch): <no error>';
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err NOT LIKE '%PER_LINE_SHARE_CUSTOMER_SET_MISMATCH%' THEN RAISE; END IF;
  END;

  BEGIN
    INSERT INTO public.invoice_items (
      id, invoice_id, quantity, acres, unit_price_cents, extended_cents
    ) VALUES (
      '84000000-0000-0000-0000-000000000012',
      '83000000-0000-0000-0000-000000000010', 0, 0, 0, 0
    );
    RAISE EXCEPTION 'P2_FAIL(unshared_invoice_item): <no error>';
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err NOT LIKE '%PER_LINE_UNSHARED_INVOICE_ITEM%' THEN RAISE; END IF;
  END;

  BEGIN
    UPDATE public.invoice_line_shares
       SET amount_cents = 49
     WHERE id = '85000000-0000-0000-0000-000000000010';
    RAISE EXCEPTION 'P2_FAIL(share_item_amount_mismatch): <no error>';
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err NOT LIKE '%PER_LINE_SHARE_ITEM_AMOUNT_MISMATCH%' THEN RAISE; END IF;
  END;

  BEGIN
    UPDATE public.field_app_billing_lines
       SET source_amount_cents = 99
     WHERE id = '82000000-0000-0000-0000-000000000010';
    RAISE EXCEPTION 'P2_FAIL(source_amount_mismatch): <no error>';
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err NOT LIKE '%PER_LINE_SOURCE_AMOUNT_MISMATCH%' THEN RAISE; END IF;
  END;

  BEGIN
    SET CONSTRAINTS ALL DEFERRED;
    UPDATE public.invoice_line_shares
       SET allocated_quantity = 0.4
     WHERE id = '85000000-0000-0000-0000-000000000010';
    UPDATE public.invoice_items
       SET quantity = 0.4
     WHERE id = '84000000-0000-0000-0000-000000000010';
    SET CONSTRAINTS ALL IMMEDIATE;
    RAISE EXCEPTION 'P2_FAIL(source_quantity_mismatch): <no error>';
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err NOT LIKE '%PER_LINE_SOURCE_QUANTITY_MISMATCH%' THEN RAISE; END IF;
  END;

  BEGIN
    SET CONSTRAINTS ALL DEFERRED;
    UPDATE public.invoice_line_shares
       SET allocated_acres = 0.4
     WHERE id = '85000000-0000-0000-0000-000000000010';
    UPDATE public.invoice_items
       SET acres = 0.40
     WHERE id = '84000000-0000-0000-0000-000000000010';
    SET CONSTRAINTS ALL IMMEDIATE;
    RAISE EXCEPTION 'P2_FAIL(source_acres_mismatch): <no error>';
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err NOT LIKE '%PER_LINE_SOURCE_ACRES_MISMATCH%' THEN RAISE; END IF;
  END;

  BEGIN
    UPDATE public.invoices
       SET total_amount_cents = 49
     WHERE id = '83000000-0000-0000-0000-000000000010';
    RAISE EXCEPTION 'P2_FAIL(invoice_header_mismatch): <no error>';
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err NOT LIKE '%PER_LINE_INVOICE_HEADER_TOTAL_MISMATCH%' THEN RAISE; END IF;
  END;

  -- Deferred checks permit an atomic rewrite, but the synchronous pre-post guard
  -- must still reject an invalid header before Phase 1 captures its snapshot.
  BEGIN
    SET CONSTRAINTS ALL DEFERRED;
    UPDATE public.invoices
       SET total_amount_cents = 49
     WHERE id = '83000000-0000-0000-0000-000000000010';
    UPDATE public.invoices
       SET status = 'posted', posted_at = now()
     WHERE id = '83000000-0000-0000-0000-000000000010';
    RAISE EXCEPTION 'P2_FAIL(pre_post_integrity_boundary): <no error>';
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err NOT LIKE '%PER_LINE_INVOICE_HEADER_TOTAL_MISMATCH%' THEN RAISE; END IF;
  END;

  -- Applicators cannot read private prices through the public SECURITY DEFINER preview.
  PERFORM set_config('request.jwt.claim.sub', v_applicator::text, true);
  v_err := NULL;
  BEGIN
    PERFORM public.preview_field_app_invoice_split(
      jsonb_build_array(jsonb_build_object('field_id', v_field_50, 'applied_acres', 1)),
      jsonb_build_array(jsonb_build_object(
        'line_key', 'chemical:denied', 'sort_order', 0, 'product_id', v_product_tier,
        'description', 'Denied', 'rate_per_acre', 1, 'rate_unit', 'unit'
      )), NULL, NULL, NULL, '{}'::jsonb
    );
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
  IF v_err NOT LIKE '%INSUFFICIENT_ROLE%' THEN
    RAISE EXCEPTION 'P2_FAIL(applicator_denied): %', COALESCE(v_err, '<no error>');
  END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK: phase2 per-line calculator proofs passed';
END;
$proof$;

ROLLBACK;
