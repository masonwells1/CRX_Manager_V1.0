-- CONTAINER-ONLY rollback smoke for 20260819232000.
--
-- Proves that an active sales rep can still cover a colleague's live booking,
-- while an idempotency key is bound to the original actor, quote and canonical
-- ordered draws. The first draw executes the real tier-split money/inventory
-- implementation. Exact numeric replay returns its one saved order; changed
-- quantity and changed actor both fail closed without another business write.

DO $smoke$
DECLARE
  v_suffix text := substr(md5(random()::text), 1, 8);
  v_admin uuid := gen_random_uuid();
  v_rep_a uuid := gen_random_uuid();
  v_rep_b uuid := gen_random_uuid();
  v_customer uuid;
  v_quote uuid;
  v_deleted_quote uuid;
  v_section uuid;
  v_product uuid;
  v_idem_key text := 'smk-draw-intent-' || v_suffix;
  v_pricing_preview jsonb;
  v_first_result jsonb;
  v_replay_result jsonb;
  v_order_id uuid;
  v_count integer;
BEGIN
  INSERT INTO auth.users (id, email, raw_user_meta_data, created_at, updated_at)
  VALUES
    (
      v_admin, 'draw-intent-admin-' || v_suffix || '@example.invalid',
      '{"full_name":"[SMOKE] Draw Admin","role":"admin"}'::jsonb, now(), now()
    ),
    (
      v_rep_a, 'draw-intent-rep-a-' || v_suffix || '@example.invalid',
      '{"full_name":"[SMOKE] Draw Rep A","role":"sales_rep"}'::jsonb, now(), now()
    ),
    (
      v_rep_b, 'draw-intent-rep-b-' || v_suffix || '@example.invalid',
      '{"full_name":"[SMOKE] Draw Rep B","role":"sales_rep"}'::jsonb, now(), now()
    );

  INSERT INTO public.profiles (id, email, full_name, role, is_active)
  VALUES
    (v_admin, 'draw-intent-admin-' || v_suffix || '@example.invalid', '[SMOKE] Draw Admin', 'admin', true),
    (v_rep_a, 'draw-intent-rep-a-' || v_suffix || '@example.invalid', '[SMOKE] Draw Rep A', 'sales_rep', true),
    (v_rep_b, 'draw-intent-rep-b-' || v_suffix || '@example.invalid', '[SMOKE] Draw Rep B', 'sales_rep', true)
  ON CONFLICT (id) DO UPDATE
    SET email = EXCLUDED.email,
        full_name = EXCLUDED.full_name,
        role = EXCLUDED.role,
        is_active = true;

  INSERT INTO public.customers (farm_name)
  VALUES ('[SMOKE] Draw Intent Farm ' || v_suffix)
  RETURNING id INTO v_customer;

  INSERT INTO public.products (product_name, unit_size)
  VALUES ('[SMOKE] Draw Intent Product ' || v_suffix, 'gal')
  RETURNING id INTO v_product;

  -- Establish the current catalog cost through the governed pricing path so
  -- the real order-line cost guard remains enabled during the draw itself.
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text,
    true
  );
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  v_pricing_preview := public.preview_product_pricing_changes(
    'product_page', NULL,
    jsonb_build_array(jsonb_build_object(
      'product_id', v_product,
      'row_version', (SELECT pricing_version FROM public.products WHERE id = v_product),
      'pricing_mode', 'margin_driven',
      'new_cost', '5.00',
      'tier1_margin_percent', '20',
      'tier2_margin_percent', '25',
      'tier3_margin_percent', '30',
      'change_reason', 'Rollback smoke draw intent fixture setup'
    )),
    v_admin, 'smk-draw-price-preview-' || v_suffix
  );
  PERFORM public.apply_product_pricing_change_set(
    (v_pricing_preview->>'change_set_id')::uuid,
    v_pricing_preview->>'request_fingerprint',
    v_admin,
    'smk-draw-price-apply-' || v_suffix
  );

  -- Rep B owns both bookings. Rep A will execute the real successful draw,
  -- positively pinning the approved cross-representative coverage rule.
  INSERT INTO public.quotes (
    quote_number, customer_id, created_by, status, commission_split
  ) VALUES (
    'SMK-DRAW-IDM-' || v_suffix,
    v_customer,
    v_rep_b,
    'sent',
    jsonb_build_object(
      'splits',
      jsonb_build_array(jsonb_build_object(
        'recipient', '[SMOKE] Draw Rep A',
        'recipient_user_id', v_rep_a,
        'percentage', 100
      ))
    )
  ) RETURNING id INTO v_quote;

  INSERT INTO public.quote_sections (quote_id, section_name, sort_order)
  VALUES (v_quote, 'Idempotency intent binding', 0)
  RETURNING id INTO v_section;

  INSERT INTO public.quotes (
    quote_number, customer_id, created_by, status, commission_split, deleted_at
  ) VALUES (
    'SMK-DRAW-DEL-' || v_suffix, v_customer, v_rep_b, 'sent', '{"splits":[]}'::jsonb, now()
  ) RETURNING id INTO v_deleted_quote;

  -- Simulate an already-booked historical line. Bracket only fixture creation;
  -- every production trigger is enabled for the draw itself.
  ALTER TABLE public.quote_items DISABLE TRIGGER trg_snapshot_quote_item_cost;
  ALTER TABLE public.quote_items DISABLE TRIGGER zz_crx_below_cost_quote_items;
  INSERT INTO public.quote_items (
    quote_id, section_id, product_id, sort_order, price_per_unit,
    current_cost, total_units_needed, total_price, profit, net_margin, unit_size,
    cost_at_quote_cents
  ) VALUES (
    v_quote, v_section, v_product, 0, 10.00,
    5, 3, 30.00, 15.00, 50.00, 'gal', 500
  );
  ALTER TABLE public.quote_items ENABLE TRIGGER trg_snapshot_quote_item_cost;
  ALTER TABLE public.quote_items ENABLE TRIGGER zz_crx_below_cost_quote_items;

  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_rep_a, 'role', 'authenticated')::text,
    true
  );
  PERFORM set_config('request.jwt.claim.sub', v_rep_a::text, true);

  BEGIN
    PERFORM public.draw_down_quote(
      v_quote,
      jsonb_build_array(jsonb_build_object('product_id', v_product, 'quantity', 1)),
      v_rep_a, NULL, NULL
    );
    RAISE EXCEPTION 'SMOKE_FAIL: keyless draw reached the money implementation';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_KEY_REQUIRED:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: expected IDEMPOTENCY_KEY_REQUIRED, got: %', SQLERRM;
    END IF;
  END;

  BEGIN
    PERFORM public.draw_down_quote(
      v_quote,
      jsonb_build_array(jsonb_build_object('product_id', v_product, 'quantity', 1)),
      v_rep_a, E'smk-control\ncharacter', NULL
    );
    RAISE EXCEPTION 'SMOKE_FAIL: control-character key reached the money implementation';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_KEY_REQUIRED:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: expected control-character key refusal, got: %', SQLERRM;
    END IF;
  END;

  BEGIN
    PERFORM public.draw_down_quote(
      v_quote,
      jsonb_build_array(jsonb_build_object('product_id', v_product, 'quantity', 1)),
      v_rep_a, U&'smk-\2603', NULL
    );
    RAISE EXCEPTION 'SMOKE_FAIL: Unicode key reached the money implementation';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_KEY_REQUIRED:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: expected Unicode key refusal, got: %', SQLERRM;
    END IF;
  END;

  BEGIN
    PERFORM public.draw_down_quote(
      v_quote,
      jsonb_build_array(jsonb_build_object('product_id', v_product, 'quantity', 1)),
      v_rep_a, repeat('a', 201), NULL
    );
    RAISE EXCEPTION 'SMOKE_FAIL: overlength key reached the money implementation';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_KEY_REQUIRED:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: expected overlength key refusal, got: %', SQLERRM;
    END IF;
  END;

  v_first_result := public.draw_down_quote(
    v_quote,
    jsonb_build_array(jsonb_build_object('product_id', v_product, 'quantity', 1)),
    v_rep_a, v_idem_key, NULL
  );
  v_order_id := (v_first_result->>'order_id')::uuid;

  -- Numeric spelling and JSON object-key order are not mutation identity.
  -- Approval reason is metadata and deliberately does not alter exact replay.
  v_replay_result := public.draw_down_quote(
    v_quote,
    jsonb_build_array(jsonb_build_object('quantity', 1.00, 'product_id', v_product)),
    v_rep_a, v_idem_key, 'different retry metadata'
  );
  IF v_replay_result IS DISTINCT FROM v_first_result OR v_order_id IS NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL: exact draw retry did not return the committed receipt';
  END IF;

  BEGIN
    PERFORM public.draw_down_quote(
      v_quote,
      jsonb_build_array(jsonb_build_object('product_id', v_product, 'quantity', 2)),
      v_rep_a, v_idem_key, NULL
    );
    RAISE EXCEPTION 'SMOKE_FAIL: changed draw quantity replayed a stale order';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_INTENT_MISMATCH%' THEN
      RAISE EXCEPTION
        'SMOKE_FAIL: expected IDEMPOTENCY_INTENT_MISMATCH, got: %', SQLERRM;
    END IF;
  END;

  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_rep_b, 'role', 'authenticated')::text,
    true
  );
  PERFORM set_config('request.jwt.claim.sub', v_rep_b::text, true);
  BEGIN
    PERFORM public.draw_down_quote(
      v_quote,
      jsonb_build_array(jsonb_build_object('product_id', v_product, 'quantity', 1)),
      v_rep_b, v_idem_key, NULL
    );
    RAISE EXCEPTION 'SMOKE_FAIL: a second actor replayed the first actor receipt';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_ACTOR_MISMATCH%' THEN
      RAISE EXCEPTION
        'SMOKE_FAIL: expected IDEMPOTENCY_ACTOR_MISMATCH, got: %', SQLERRM;
    END IF;
  END;

  -- A committed receipt remains authoritative after the booking is hidden.
  -- This must not enter the money path or create a second business write.
  UPDATE public.quotes SET deleted_at = now() WHERE id = v_quote;
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_rep_a, 'role', 'authenticated')::text,
    true
  );
  PERFORM set_config('request.jwt.claim.sub', v_rep_a::text, true);
  v_replay_result := public.draw_down_quote(
    v_quote,
    jsonb_build_array(jsonb_build_object('product_id', v_product, 'quantity', 1)),
    v_rep_a, v_idem_key, NULL
  );
  IF v_replay_result IS DISTINCT FROM v_first_result THEN
    RAISE EXCEPTION
      'SMOKE_FAIL: soft-deleted booking retry did not return the committed receipt';
  END IF;

  SELECT count(*) INTO v_count FROM public.orders WHERE quote_id = v_quote;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: idempotency probes created % orders instead of 1', v_count;
  END IF;

  SELECT count(*) INTO v_count
  FROM public.quote_product_draws
  WHERE quote_id = v_quote AND product_id = v_product AND quantity_drawn = 1;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: draw ledger did not record exactly one unit once';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.order_items oi
    WHERE oi.order_id = v_order_id
      AND oi.product_id = v_product
      AND oi.total_units_needed = 1
      AND oi.price_per_unit = 10.00
      AND oi.cost_at_time_cents = 500
      AND oi.total_price = 10.00
      AND oi.profit = 5.00
      AND oi.quote_item_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: exact tier price/cost/profit line was not preserved';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.orders o
    WHERE o.id = v_order_id
      AND o.total_price = 10.00
      AND o.total_cost = 5.00
      AND o.total_profit = 5.00
      AND o.booking_draw IS TRUE
  ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: order header money does not match its tier line';
  END IF;

  SELECT count(*) INTO v_count
  FROM public.commissions c
  WHERE c.order_id = v_order_id
    AND c.customer_id = v_customer
    AND c.recipient_user_id = v_rep_a
    AND c.split_percentage = 100
    AND c.commission_amount = 5.00
    AND c.order_profit = 5.00
    AND c.status = 'pending';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: expected one exact $5 commission row, found %', v_count;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.inventory i
    WHERE i.product_id = v_product
      AND i.location = 'Main Warehouse'
      AND i.quantity_prebooked = 1
  ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: inventory was not prebooked exactly once';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.idempotency_keys
    WHERE idempotency_key = v_idem_key
      AND operation = 'draw_down_quote'
      AND request_actor_id = v_rep_a
      AND request_fingerprint IS NOT NULL
      AND result = v_first_result
  ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: draw receipt was not actor/intent/result bound';
  END IF;

  -- A first call against a deleted booking remains hidden after request
  -- validation and before any money or inventory logic.
  BEGIN
    PERFORM public.draw_down_quote(
      v_deleted_quote,
      jsonb_build_array(jsonb_build_object('product_id', v_product, 'quantity', 1)),
      v_rep_a, 'smk-deleted-' || v_suffix, NULL
    );
    RAISE EXCEPTION 'SMOKE_FAIL: deleted quote draw was allowed';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'Quote not found%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: expected Quote not found, got: %', SQLERRM;
    END IF;
  END;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END;
$smoke$;
