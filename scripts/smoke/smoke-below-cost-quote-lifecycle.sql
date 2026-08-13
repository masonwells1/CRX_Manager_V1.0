-- Rollback-only proof that every app-reachable Quote lifecycle line writer is
-- routed through the PostgreSQL below-cost wall. PASS is the terminal
-- SMOKE_PASS_ROLLBACK exception; the transaction retains no fixtures.
BEGIN;
ALTER TABLE public.products DISABLE TRIGGER USER;

DO $smoke$
DECLARE
  v_sfx text := substr(md5(gen_random_uuid()::text), 1, 8);
  v_admin uuid;
  v_sales uuid;
  v_customer uuid;
  v_product uuid;
  v_product_unknown uuid;
  v_quote_convert uuid;
  v_quote_draw uuid;
  v_quote_multi_price uuid;
  v_quote_restore uuid;
  v_quote_unknown uuid;
  v_section_unknown uuid;
  v_section_multi_price uuid;
  v_version uuid;
  v_order_id uuid;
  v_row_version bigint;
  v_result jsonb;
  v_sections jsonb;
  v_operation text;
  v_audit_count integer;
  v_multi_price_order_one uuid;
  v_multi_price_order_two uuid;
BEGIN
  SELECT id INTO v_admin FROM public.profiles
  WHERE role = 'admin' AND is_active = true ORDER BY id LIMIT 1;
  SELECT id INTO v_sales FROM public.profiles
  WHERE role = 'sales_rep' AND is_active = true ORDER BY id LIMIT 1;
  IF v_admin IS NULL OR v_sales IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: active admin and sales rep required';
  END IF;

  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text,
    true
  );
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);

  INSERT INTO public.customers (farm_name, assigned_sales_rep)
  VALUES ('[SMOKE] Quote lifecycle ' || v_sfx, v_sales)
  RETURNING id INTO v_customer;

  INSERT INTO public.products (
    product_name, current_cost, tier1_price, tier2_price, tier3_price, unit_size
  ) VALUES (
    '[SMOKE] Quote lifecycle product ' || v_sfx,
    10, 11, 11, 11, 'gal'
  ) RETURNING id INTO v_product;

  INSERT INTO public.products (
    product_name, current_cost, tier1_price, tier2_price, tier3_price, unit_size
  ) VALUES (
    '[SMOKE] Unknown cost product ' || v_sfx,
    NULL, 11, 11, 11, 'gal'
  ) RETURNING id INTO v_product_unknown;

  INSERT INTO public.inventory (
    product_id, location, quantity_available, quantity_prebooked,
    quantity_on_order, unit_size
  ) VALUES (v_product, 'Main Warehouse', 1000, 0, 0, 'gal');

  v_sections := jsonb_build_array(jsonb_build_object(
    'section_name', 'Lifecycle',
    'sort_order', 0,
    'items', jsonb_build_array(jsonb_build_object(
      'product_id', v_product,
      'calc_mode', 'units_direct',
      'total_units_needed', 10,
      'price_per_unit', 11,
      'price_override', 11,
      'current_cost', 10,
      'unit_size', 'gal',
      'sort_order', 0
    ))
  ));

  -- Build three independent sent bookings while price 11 is above live cost 10.
  FOREACH v_operation IN ARRAY ARRAY['convert', 'draw', 'restore']
  LOOP
    v_result := public.save_quote(
      NULL,
      jsonb_build_object(
        'quote_number', '[SMOKE] Q-' || v_operation || '-' || v_sfx,
        'customer_id', v_customer,
        'status', 'draft',
        'tier', 1,
        'is_planned', true,
        'commission_split', jsonb_build_object(
          'splits', jsonb_build_array(jsonb_build_object(
            'recipient', 'Below Cost Admin', 'percentage', 100
          ))
        )
      ),
      v_sections,
      v_admin,
      'smoke-q-create-' || v_operation || '-' || v_sfx
    );

    IF v_operation = 'convert' THEN
      v_quote_convert := (v_result->>'quote_id')::uuid;
    ELSIF v_operation = 'draw' THEN
      v_quote_draw := (v_result->>'quote_id')::uuid;
    ELSE
      v_quote_restore := (v_result->>'quote_id')::uuid;
    END IF;

    v_row_version := (v_result->>'row_version')::bigint;
    v_result := public.save_quote(
      (v_result->>'quote_id')::uuid,
      jsonb_build_object(
        'quote_number', '[SMOKE] Q-' || v_operation || '-' || v_sfx,
        'customer_id', v_customer,
        'status', 'sent',
        'tier', 1,
        'row_version_expected', v_row_version
      ),
      v_sections,
      v_admin,
      'smoke-q-sent-' || v_operation || '-' || v_sfx
    );
  END LOOP;

  SELECT row_version INTO v_row_version
  FROM public.quotes WHERE id = v_quote_restore;
  v_result := public.create_quote_version(
    v_quote_restore, v_admin, 'manual',
    'smoke-q-version-' || v_sfx, v_row_version
  );
  v_version := (v_result->>'version_id')::uuid;

  -- Mutation proof for the post-20260810151000 whole-cent constraints. A
  -- historical JSON snapshot can predate those constraints even though every
  -- current quote row is clean. Restore must normalize the replay boundary,
  -- not fail the CHECK or reintroduce fractional stored money.
  UPDATE public.quote_versions
  SET snapshot_data = jsonb_set(
    jsonb_set(
      jsonb_set(
        jsonb_set(snapshot_data, '{quote,total_price}', '110.005'::jsonb),
        '{quote,total_profit}', '10.005'::jsonb
      ),
      '{sections,0,items,0,total_price}', '110.005'::jsonb
    ),
    '{sections,0,items,0,profit}', '10.005'::jsonb
  )
  WHERE id = v_version;

  -- Regression fixture: the same Product is booked at two distinct cent prices.
  -- The draw RPC accepts only Product + quantity, so the implementation must
  -- allocate the aggregate draw without inventing a fractional-cent unit price.
  INSERT INTO public.quotes (
    quote_number, customer_id, created_by, tier, status,
    commission_split, total_price, total_cost, total_profit,
    total_margin_pct, valid_days, expires_at
  ) VALUES (
    '[SMOKE] Q-multi-price-' || v_sfx,
    v_customer,
    v_admin,
    1,
    'sent',
    '{"splits":[]}'::jsonb,
    20.01,
    20,
    0.01,
    0.05,
    15,
    CURRENT_DATE + 15
  ) RETURNING id INTO v_quote_multi_price;
  INSERT INTO public.quote_sections (quote_id, section_name, sort_order)
  VALUES (v_quote_multi_price, 'Multi-price draw', 0)
  RETURNING id INTO v_section_multi_price;
  INSERT INTO public.quote_items (
    quote_id, section_id, product_id, sort_order, price_per_unit,
    current_cost, total_units_needed, total_price, profit, net_margin,
    cost_at_quote_cents, unit_size
  ) VALUES
    (
      v_quote_multi_price, v_section_multi_price, v_product, 0, 10,
      10, 1, 10, 0, 0, 1000, 'gal'
    ),
    (
      v_quote_multi_price, v_section_multi_price, v_product, 1, 10.01,
      10, 1, 10.01, 0.01, 0.1, 1000, 'gal'
    );

  -- The same customer prices are now below the fresh catalog cost. Every path
  -- must deny a blank reason, then atomically approve and audit an admin retry.
  UPDATE public.products SET current_cost = 12 WHERE id = v_product;

  -- save_quote has a transient INSERT followed by one authoritative UPDATE.
  -- The final settled line must be governed while producing exactly one audit
  -- row, never one for each internal write phase.
  v_sections := jsonb_set(
    v_sections,
    '{0,items,0,below_cost_reason}',
    to_jsonb('save quote final state approval'::text),
    true
  );
  SELECT row_version INTO v_row_version
  FROM public.quotes WHERE id = v_quote_restore;
  v_result := public.save_quote(
    v_quote_restore,
    jsonb_build_object(
      'quote_number', '[SMOKE] Q-restore-' || v_sfx,
      'customer_id', v_customer,
      'status', 'sent',
      'tier', 1,
      'row_version_expected', v_row_version
    ),
    v_sections,
    v_admin,
    'smoke-q-below-save-' || v_sfx
  );
  SELECT count(*) INTO v_audit_count
  FROM public.below_cost_approvals
  WHERE operation = 'save_quote'
    AND entity_id = v_quote_restore
    AND actor_user_id = v_admin;
  IF v_audit_count <> 1 THEN
    RAISE EXCEPTION
      'SMOKE_FAIL: save_quote wrote % approval audits instead of exactly one',
      v_audit_count;
  END IF;

  -- Simulate one pre-migration legacy quote whose historical basis was unknown.
  -- Current writes cannot create this row because the snapshot trigger rejects
  -- it, so bracket only the fixture insert. Conversion itself must still refuse
  -- instead of turning NULL into zero-cost order profit.
  INSERT INTO public.quotes (
    quote_number, customer_id, created_by, tier, status,
    commission_split, total_price, total_cost, total_profit,
    total_margin_pct, valid_days, expires_at
  ) VALUES (
    '[SMOKE] Q-unknown-' || v_sfx, v_customer, v_admin, 1, 'sent',
    '{"splits":[]}'::jsonb, 11, 0, 11, 100, 15, CURRENT_DATE + 15
  ) RETURNING id INTO v_quote_unknown;
  INSERT INTO public.quote_sections (quote_id, section_name, sort_order)
  VALUES (v_quote_unknown, 'Unknown cost', 0)
  RETURNING id INTO v_section_unknown;
  ALTER TABLE public.quote_items DISABLE TRIGGER trg_snapshot_quote_item_cost;
  ALTER TABLE public.quote_items DISABLE TRIGGER zz_crx_below_cost_quote_items;
  INSERT INTO public.quote_items (
    quote_id, section_id, product_id, sort_order, price_per_unit,
    current_cost, total_units_needed, total_price, profit, net_margin,
    cost_at_quote_cents
  ) VALUES (
    v_quote_unknown, v_section_unknown, v_product_unknown, 0, 11,
    0, 1, 11, 11, 100, NULL
  );
  ALTER TABLE public.quote_items ENABLE TRIGGER trg_snapshot_quote_item_cost;
  ALTER TABLE public.quote_items ENABLE TRIGGER zz_crx_below_cost_quote_items;

  SELECT row_version INTO v_row_version
  FROM public.quotes WHERE id = v_quote_unknown;
  BEGIN
    PERFORM public.convert_quote_to_order(
      v_quote_unknown, v_admin, 'smoke-q-unknown-' || v_sfx,
      v_row_version, 'must not make unknown cost zero'
    );
    RAISE EXCEPTION 'SMOKE_FAIL: unknown-cost conversion committed';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'COST_BASIS_REQUIRED:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: unknown-cost conversion denial was %', SQLERRM;
    END IF;
  END;

  BEGIN
    PERFORM public.duplicate_quote(
      v_quote_convert, v_admin, 'smoke-q-duplicate-deny-' || v_sfx, NULL
    );
    RAISE EXCEPTION 'SMOKE_FAIL: reasonless duplicate committed';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'BELOW_COST_REASON_REQUIRED:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: duplicate denial was %', SQLERRM;
    END IF;
  END;
  PERFORM public.duplicate_quote(
    v_quote_convert, v_admin, 'smoke-q-duplicate-ok-' || v_sfx,
    'duplicate lifecycle approval'
  );

  SELECT row_version INTO v_row_version
  FROM public.quotes WHERE id = v_quote_restore;
  BEGIN
    PERFORM public.restore_quote_version(
      v_quote_restore, v_version, v_admin,
      'smoke-q-restore-deny-' || v_sfx, v_row_version, NULL
    );
    RAISE EXCEPTION 'SMOKE_FAIL: reasonless restore committed';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'BELOW_COST_REASON_REQUIRED:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: restore denial was %', SQLERRM;
    END IF;
  END;
  PERFORM public.restore_quote_version(
    v_quote_restore, v_version, v_admin,
    'smoke-q-restore-ok-' || v_sfx, v_row_version,
    'restore lifecycle approval'
  );
  IF EXISTS (
    SELECT 1 FROM public.quotes q
    WHERE q.id = v_quote_restore
      AND (q.total_price <> ROUND(q.total_price, 2)
        OR q.total_profit <> ROUND(q.total_profit, 2))
  ) OR EXISTS (
    SELECT 1 FROM public.quote_items qi
    WHERE qi.quote_id = v_quote_restore
      AND (qi.total_price <> ROUND(qi.total_price, 2)
        OR qi.profit <> ROUND(qi.profit, 2))
  ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: historical restore retained fractional money';
  END IF;

  SELECT row_version INTO v_row_version
  FROM public.quotes WHERE id = v_quote_convert;
  BEGIN
    PERFORM public.convert_quote_to_order(
      v_quote_convert, v_admin, 'smoke-q-convert-deny-' || v_sfx,
      v_row_version, NULL
    );
    RAISE EXCEPTION 'SMOKE_FAIL: reasonless conversion committed';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'BELOW_COST_REASON_REQUIRED:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: conversion denial was %', SQLERRM;
    END IF;
  END;
  v_result := public.convert_quote_to_order(
    v_quote_convert, v_admin, 'smoke-q-convert-ok-' || v_sfx,
    v_row_version, 'conversion lifecycle approval'
  );
  v_order_id := (v_result->>'order_id')::uuid;
  SELECT count(*) INTO v_audit_count
  FROM public.commissions c
  JOIN public.orders o ON o.id = c.order_id
  WHERE o.id = v_order_id
    AND c.order_profit IS DISTINCT FROM o.total_profit;
  IF v_audit_count <> 0 OR NOT EXISTS (
    SELECT 1 FROM public.commissions WHERE order_id = v_order_id
  ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: conversion commission basis drifted from canonical order profit';
  END IF;

  BEGIN
    PERFORM public.draw_down_quote(
      v_quote_draw,
      jsonb_build_array(jsonb_build_object('product_id', v_product, 'quantity', 2)),
      v_admin, 'smoke-q-draw-deny-' || v_sfx, NULL
    );
    RAISE EXCEPTION 'SMOKE_FAIL: reasonless draw-down committed';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'BELOW_COST_REASON_REQUIRED:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: draw-down denial was %', SQLERRM;
    END IF;
  END;
  PERFORM public.draw_down_quote(
    v_quote_draw,
    jsonb_build_array(jsonb_build_object('product_id', v_product, 'quantity', 2)),
    v_admin, 'smoke-q-draw-ok-' || v_sfx,
    'draw lifecycle approval'
  );

  FOREACH v_operation IN ARRAY ARRAY[
    'duplicate_quote', 'restore_quote_version',
    'convert_quote_to_order', 'draw_down_quote'
  ]
  LOOP
    SELECT count(*) INTO v_audit_count
    FROM public.below_cost_approvals
    WHERE operation = v_operation
      AND actor_user_id = v_admin;
    IF v_audit_count <> 1 THEN
      RAISE EXCEPTION
        'SMOKE_FAIL: % wrote % approval audits instead of exactly one',
        v_operation, v_audit_count;
    END IF;
  END LOOP;

  -- Two one-unit partial draws must both succeed, keep cent-representable unit
  -- prices, and telescope to the exact $20.01 booked total. The pre-fix
  -- weighted-average implementation attempted to insert $10.005 and rolled the
  -- first transaction back at the whole-cent/below-cost trigger.
  v_result := public.draw_down_quote(
    v_quote_multi_price,
    jsonb_build_array(jsonb_build_object('product_id', v_product, 'quantity', 1)),
    v_admin,
    'smoke-q-multi-price-one-' || v_sfx,
    'multi-price first partial draw approval'
  );
  v_multi_price_order_one := (v_result->>'order_id')::uuid;
  IF COALESCE((v_result->>'fully_drawn')::boolean, true) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: first multi-price partial draw closed the booking';
  END IF;

  v_result := public.draw_down_quote(
    v_quote_multi_price,
    jsonb_build_array(jsonb_build_object('product_id', v_product, 'quantity', 1)),
    v_admin,
    'smoke-q-multi-price-two-' || v_sfx,
    'multi-price final partial draw approval'
  );
  v_multi_price_order_two := (v_result->>'order_id')::uuid;
  IF NOT COALESCE((v_result->>'fully_drawn')::boolean, false) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: final multi-price partial draw left the booking open';
  END IF;

  SELECT count(*) INTO v_audit_count
  FROM public.order_items oi
  WHERE oi.order_id IN (v_multi_price_order_one, v_multi_price_order_two)
    AND oi.product_id = v_product
    AND oi.price_per_unit = round(oi.price_per_unit, 2);
  IF v_audit_count <> 2 THEN
    RAISE EXCEPTION
      'SMOKE_FAIL: multi-price partial draws wrote % cent-exact lines instead of 2',
      v_audit_count;
  END IF;

  IF (
    SELECT COALESCE(sum(oi.total_price), 0)
    FROM public.order_items oi
    WHERE oi.order_id IN (v_multi_price_order_one, v_multi_price_order_two)
  ) <> 20.01 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: multi-price partial draws did not preserve $20.01';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.orders o
    JOIN public.order_items oi ON oi.order_id = o.id
    WHERE o.id IN (v_multi_price_order_one, v_multi_price_order_two)
      AND o.total_price IS DISTINCT FROM oi.total_price
  ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: multi-price draw header drifted from its line';
  END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END
$smoke$;
