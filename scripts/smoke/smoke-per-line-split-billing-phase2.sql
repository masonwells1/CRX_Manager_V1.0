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
  v_job constant uuid := '40000000-0000-0000-0000-000000000001';
  v_product_quote constant uuid := '50000000-0000-0000-0000-000000000001';
  v_product_tier constant uuid := '50000000-0000-0000-0000-000000000002';
  v_service constant uuid := '60000000-0000-0000-0000-000000000001';
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
  INSERT INTO public.jobs (id) VALUES (v_job);
  INSERT INTO public.fields (id, field_name, customer_id, total_acres) VALUES
    (v_field_50, 'Half Field', v_a, 1),
    (v_field_3, 'Thirds Field', v_a, 1),
    (v_field_fallback, 'Fallback Field', v_b, 1),
    (v_field_mode_a, 'Mode A Field', v_a, 1),
    (v_field_job, 'Snapshot Field', v_a, 1);

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
    (v_field_job, v_b, 50, false, NULL);
  INSERT INTO public.job_field_shares
    (job_id, field_id, customer_id, split_pct, is_primary)
  VALUES (v_job, v_field_job, v_c, 100, true);

  INSERT INTO public.products
    (id, inventory_unit, product_form, tier1_price, tier2_price, tier3_price)
  VALUES
    (v_product_quote, 'unit', 'liquid', 1.00, 2.00, 3.00),
    (v_product_tier, 'unit', 'liquid', 1.00, 2.00, 3.00);
  INSERT INTO public.quote_sections (id, field_id)
  VALUES ('70000000-0000-0000-0000-000000000001', v_field_50);
  INSERT INTO public.quote_items (id, section_id, product_id, price_per_unit)
  VALUES (
    '71000000-0000-0000-0000-000000000001',
    '70000000-0000-0000-0000-000000000001',
    v_product_quote,
    1.50
  );
  INSERT INTO public.application_services
    (id, name, default_rate_per_acre_cents, is_active)
  VALUES (v_service, 'Application', 10, true);
  INSERT INTO public.customer_application_rates
    (customer_id, application_service_id, rate_per_acre_cents, season)
  VALUES (v_b, v_service, 20, 2026);

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

  -- Quote must beat tier when no global manual price is present.
  v_plan := public.preview_field_app_invoice_split(
    jsonb_build_array(jsonb_build_object('field_id', v_field_50, 'applied_acres', 1)),
    jsonb_build_array(jsonb_build_object(
      'line_key', 'chemical:quote', 'sort_order', 0, 'product_id', v_product_quote,
      'description', 'Quote', 'rate_per_acre', 1, 'rate_unit', 'unit'
    )), NULL, NULL, NULL, '{}'::jsonb
  );
  IF v_plan#>>'{billing_lines,0,shares,0,base_unit_price_cents}' <> '150'
     OR v_plan#>>'{billing_lines,0,shares,0,base_price_source}' <> 'quote' THEN
    RAISE EXCEPTION 'P2_FAIL(quote_precedence): %', v_plan;
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
    '[]'::jsonb, v_service, NULL, NULL,
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
     OR v_shares#>>'{1,base_unit_price_cents}' <> '20'
     OR v_shares#>>'{1,base_price_source}' <> 'customer_application_rates' THEN
    RAISE EXCEPTION 'P2_FAIL(service_100_0_zero_row): %', v_plan;
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
      'line_key', 'chemical:job', 'sort_order', 0, 'product_id', v_product_tier,
      'description', 'Job', 'rate_per_acre', 1, 'rate_unit', 'unit',
      'manual_override', true, 'unit_price_cents', 100
    )), NULL, NULL, v_job, '{}'::jsonb
  );
  IF v_plan->>'customer_count' <> '1'
     OR v_plan#>>'{billing_lines,0,shares,0,customer_id}' <> v_c::text
     OR v_plan#>>'{shares_detail,rows,0,vector_source}' <> 'job_snapshot' THEN
    RAISE EXCEPTION 'P2_FAIL(job_snapshot_precedence): %', v_plan;
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
