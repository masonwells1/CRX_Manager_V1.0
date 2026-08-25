-- Container-only commit proof for the deferred order_items.quote_item_id FK.
-- This is intentionally NOT a live smoke and NOT a rollback-marker chain. The
-- disposable network-disabled prover runs it only after restoring the full
-- schema and applying the candidate, then destroys the whole container.
--
-- The production QuoteBuilder omits quote-item IDs from save_quote payloads.
-- First prove that two prior rows for the same product fail closed at the
-- existing QUOTE_ITEM_AMBIGUOUS_COST guard. Then prove the supported id-less
-- multi-line shape (two products in two sections) preserves both drawn-row
-- bindings all the way through COMMIT, where the initially deferred foreign
-- key is actually checked.

BEGIN;

DO $proof$
DECLARE
  v_admin uuid := '66666666-6666-6666-6666-666666666666';
  v_customer uuid;
  v_product uuid;
  v_product_two uuid;
  v_quote uuid;
  v_early uuid;
  v_late uuid;
  v_result jsonb;
  v_payload jsonb;
  v_sections jsonb;
  v_row_version bigint;
  v_order_lines integer;
  v_bound_lines integer;
  v_distinct_items integer;
  v_suffix text := substr(md5(random()::text), 1, 8);
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = v_admin AND role = 'admin' AND is_active = true
  ) THEN
    RAISE EXCEPTION 'COMMIT_PROOF_SETUP: registered smoke admin is missing';
  END IF;

  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text,
    true
  );
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);

  INSERT INTO public.customers (farm_name)
  VALUES ('[COMMIT PROOF] Id-less Duplicate ' || v_suffix)
  RETURNING id INTO v_customer;

  INSERT INTO public.products (product_name, unit_size)
  VALUES ('[COMMIT PROOF] Product ' || v_suffix, 'gal')
  RETURNING id INTO v_product;
  INSERT INTO public.products (product_name, unit_size)
  VALUES ('[COMMIT PROOF] Product Two ' || v_suffix, 'gal')
  RETURNING id INTO v_product_two;

  v_result := public.preview_product_pricing_changes(
    'product_page',
    NULL,
    jsonb_build_array(
      jsonb_build_object(
        'product_id', v_product,
        'row_version', (
          SELECT pricing_version FROM public.products WHERE id = v_product
        ),
        'pricing_mode', 'margin_driven',
        'new_cost', '6.00',
        'tier1_margin_percent', '20',
        'tier2_margin_percent', '25',
        'tier3_margin_percent', '30',
        'change_reason', 'Container-only id-less duplicate commit proof'
      )
    ),
    v_admin,
    'commit-proof-price-preview-' || v_suffix
  );
  PERFORM public.apply_product_pricing_change_set(
    (v_result ->> 'change_set_id')::uuid,
    v_result ->> 'request_fingerprint',
    v_admin,
    'commit-proof-price-apply-' || v_suffix
  );

  INSERT INTO public.quotes (
    quote_number, customer_id, created_by, status, commission_split
  )
  VALUES (
    '[COMMIT PROOF] IDL-' || v_suffix,
    v_customer,
    v_admin,
    'sent',
    '{"splits": []}'::jsonb
  )
  RETURNING id INTO v_quote;

  INSERT INTO public.quote_sections (quote_id, section_name, sort_order)
  VALUES (v_quote, 'Early', 0)
  RETURNING id INTO v_early;
  INSERT INTO public.quote_sections (quote_id, section_name, sort_order)
  VALUES (v_quote, 'Late', 1)
  RETURNING id INTO v_late;

  INSERT INTO public.quote_items (
    quote_id, section_id, product_id, price_per_unit, current_cost,
    total_units_needed, unit_size, sort_order, calc_mode
  )
  VALUES
    (v_quote, v_early, v_product, 10, 6, 200, 'gal', 0, 'units_direct'),
    (v_quote, v_late, v_product, 12, 6, 200, 'gal', 0, 'units_direct');

  v_result := public.draw_down_quote(
    v_quote,
    jsonb_build_array(
      jsonb_build_object('product_id', v_product, 'quantity', 300)
    ),
    v_admin,
    'commit-proof-draw-' || v_suffix
  );
  IF COALESCE((v_result ->> 'success')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'COMMIT_PROOF_FAIL: draw failed: %', v_result;
  END IF;

  SELECT count(*), count(oi.quote_item_id), count(DISTINCT oi.quote_item_id)
  INTO v_order_lines, v_bound_lines, v_distinct_items
  FROM public.order_items oi
  JOIN public.orders o ON o.id = oi.order_id
  WHERE o.quote_id = v_quote;
  IF v_order_lines <> 2 OR v_bound_lines <> 2 OR v_distinct_items <> 2 THEN
    RAISE EXCEPTION
      'COMMIT_PROOF_FAIL: expected two distinct quote-item-bound order lines, got lines=% bound=% distinct=%',
      v_order_lines, v_bound_lines, v_distinct_items;
  END IF;

  SELECT (to_jsonb(q) ->> 'row_version')::bigint
  INTO STRICT v_row_version
  FROM public.quotes q
  WHERE q.id = v_quote;

  v_payload := jsonb_build_object(
    'quote_number', '[COMMIT PROOF] IDL-' || v_suffix,
    'customer_id', v_customer,
    'status', 'sent',
    'tier', 1,
    'row_version_expected', v_row_version
  );
  -- Deliberately omit every quote-item `id`, matching QuoteBuilder production.
  v_sections := jsonb_build_array(
    jsonb_build_object(
      'section_name', 'Early',
      'sort_order', 0,
      'items', jsonb_build_array(
        jsonb_build_object(
          'product_id', v_product,
          'calc_mode', 'units_direct',
          'total_units_needed', 200,
          'price_per_unit', 10,
          'current_cost', 6,
          'sort_order', 0
        )
      )
    ),
    jsonb_build_object(
      'section_name', 'Late',
      'sort_order', 1,
      'items', jsonb_build_array(
        jsonb_build_object(
          'product_id', v_product,
          'calc_mode', 'units_direct',
          'total_units_needed', 200,
          'price_per_unit', 12,
          'current_cost', 6,
          'sort_order', 0
        )
      )
    )
  );

  BEGIN
    v_result := public.save_quote(
      v_quote, v_payload, v_sections, v_admin, NULL
    );
    RAISE EXCEPTION
      'COMMIT_PROOF_FAIL: duplicate-product id-less save bypassed the ambiguity guard';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'COMMIT_PROOF_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'QUOTE_ITEM_AMBIGUOUS_COST%' THEN
      RAISE EXCEPTION
        'COMMIT_PROOF_FAIL: expected QUOTE_ITEM_AMBIGUOUS_COST, got: %', SQLERRM;
    END IF;
  END;

  -- The refused save ran in a PL/pgSQL exception subtransaction, so its DELETE
  -- was rolled back. Confirm both duplicate-product provenance links survived.
  SELECT count(*)
  INTO v_bound_lines
  FROM public.order_items oi
  JOIN public.orders o ON o.id = oi.order_id
  JOIN public.quote_items qi
    ON qi.id = oi.quote_item_id
   AND qi.quote_id = v_quote
   AND qi.product_id = v_product
  WHERE o.quote_id = v_quote;
  IF v_bound_lines <> 2 THEN
    RAISE EXCEPTION
      'COMMIT_PROOF_FAIL: refused duplicate save preserved only % of 2 bindings',
      v_bound_lines;
  END IF;

  -- Now exercise the production-supported id-less shape with two independently
  -- identifiable products. Both quote-item rows are deleted and reinserted by
  -- save_quote, and both stamped order lines must still resolve at COMMIT.
  v_result := public.preview_product_pricing_changes(
    'product_page',
    NULL,
    jsonb_build_array(
      jsonb_build_object(
        'product_id', v_product_two,
        'row_version', (
          SELECT pricing_version FROM public.products WHERE id = v_product_two
        ),
        'pricing_mode', 'margin_driven',
        'new_cost', '7.00',
        'tier1_margin_percent', '20',
        'tier2_margin_percent', '25',
        'tier3_margin_percent', '30',
        'change_reason', 'Container-only supported id-less commit proof'
      )
    ),
    v_admin,
    'commit-proof-price-two-preview-' || v_suffix
  );
  PERFORM public.apply_product_pricing_change_set(
    (v_result ->> 'change_set_id')::uuid,
    v_result ->> 'request_fingerprint',
    v_admin,
    'commit-proof-price-two-apply-' || v_suffix
  );

  INSERT INTO public.quotes (
    quote_number, customer_id, created_by, status, commission_split
  )
  VALUES (
    '[COMMIT PROOF] SUP-' || v_suffix,
    v_customer,
    v_admin,
    'sent',
    '{"splits": []}'::jsonb
  )
  RETURNING id INTO v_quote;

  INSERT INTO public.quote_sections (quote_id, section_name, sort_order)
  VALUES (v_quote, 'Early', 0)
  RETURNING id INTO v_early;
  INSERT INTO public.quote_sections (quote_id, section_name, sort_order)
  VALUES (v_quote, 'Late', 1)
  RETURNING id INTO v_late;

  INSERT INTO public.quote_items (
    quote_id, section_id, product_id, price_per_unit, current_cost,
    total_units_needed, unit_size, sort_order, calc_mode
  )
  VALUES
    (v_quote, v_early, v_product, 10, 6, 200, 'gal', 0, 'units_direct'),
    (v_quote, v_late, v_product_two, 12, 7, 200, 'gal', 0, 'units_direct');

  v_result := public.draw_down_quote(
    v_quote,
    jsonb_build_array(
      jsonb_build_object('product_id', v_product, 'quantity', 100),
      jsonb_build_object('product_id', v_product_two, 'quantity', 100)
    ),
    v_admin,
    'commit-proof-supported-draw-' || v_suffix
  );
  IF COALESCE((v_result ->> 'success')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'COMMIT_PROOF_FAIL: supported draw failed: %', v_result;
  END IF;

  SELECT count(*), count(oi.quote_item_id), count(DISTINCT oi.quote_item_id)
  INTO v_order_lines, v_bound_lines, v_distinct_items
  FROM public.order_items oi
  JOIN public.orders o ON o.id = oi.order_id
  WHERE o.quote_id = v_quote;
  IF v_order_lines <> 2 OR v_bound_lines <> 2 OR v_distinct_items <> 2 THEN
    RAISE EXCEPTION
      'COMMIT_PROOF_FAIL: supported draw expected two distinct bindings, got lines=% bound=% distinct=%',
      v_order_lines, v_bound_lines, v_distinct_items;
  END IF;

  SELECT (to_jsonb(q) ->> 'row_version')::bigint
  INTO STRICT v_row_version
  FROM public.quotes q
  WHERE q.id = v_quote;

  v_payload := jsonb_build_object(
    'quote_number', '[COMMIT PROOF] SUP-' || v_suffix,
    'customer_id', v_customer,
    'status', 'sent',
    'tier', 1,
    'row_version_expected', v_row_version
  );
  v_sections := jsonb_build_array(
    jsonb_build_object(
      'section_name', 'Early',
      'sort_order', 0,
      'items', jsonb_build_array(
        jsonb_build_object(
          'product_id', v_product,
          'calc_mode', 'units_direct',
          'total_units_needed', 200,
          'price_per_unit', 10,
          'current_cost', 6,
          'sort_order', 0
        )
      )
    ),
    jsonb_build_object(
      'section_name', 'Late',
      'sort_order', 1,
      'items', jsonb_build_array(
        jsonb_build_object(
          'product_id', v_product_two,
          'calc_mode', 'units_direct',
          'total_units_needed', 200,
          'price_per_unit', 12,
          'current_cost', 7,
          'sort_order', 0
        )
      )
    )
  );

  v_result := public.save_quote(
    v_quote, v_payload, v_sections, v_admin, NULL
  );
  IF v_result ->> 'status' IS DISTINCT FROM 'saved' THEN
    RAISE EXCEPTION 'COMMIT_PROOF_FAIL: supported id-less save failed: %', v_result;
  END IF;

  SELECT count(*)
  INTO v_bound_lines
  FROM public.order_items oi
  JOIN public.orders o ON o.id = oi.order_id
  JOIN public.quote_items qi
    ON qi.id = oi.quote_item_id
   AND qi.quote_id = v_quote
  WHERE o.quote_id = v_quote;
  IF v_bound_lines <> 2 THEN
    RAISE EXCEPTION
      'COMMIT_PROOF_FAIL: supported id-less save preserved only % of 2 bindings',
      v_bound_lines;
  END IF;
END
$proof$;

-- The deferred FK is checked here. The pass marker is intentionally after it.
COMMIT;
SELECT 'FULL_SCHEMA_IDLESS_DUPLICATE_COMMIT_PASS';
