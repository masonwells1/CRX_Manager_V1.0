-- ============================================================================
-- smoke-bulk-order-import-lifecycle.sql
-- Chain for 20260805211951_harden_bulk_order_import_lifecycle.sql and
-- 20260805220757_reject_nonfinite_bulk_import_values.sql and
-- 20260805224819_snapshot_bulk_import_product_cost.sql and
-- 20260806000752_authorize_bulk_import_product_cost.sql.
--
-- Proves that a bulk import cannot forge a partial/terminal lifecycle state and
-- that a confirmed import atomically creates its order lines, inventory booking,
-- booked ledger row, commission, activity event, and idempotency receipt. It
-- also proves NaN/+Infinity/-Infinity are rejected for every imported numeric
-- field without residue, sub-cent prices are normalized, omitted cost snapshots
-- the Product cost, malformed cost fails without residue, and an active sales
-- rep cannot inflate commission profit with an explicit zero/lower cost.
-- The terminal SMOKE_PASS_ROLLBACK exception aborts every synthetic write.
-- ============================================================================
DO $$
DECLARE
  v_sfx text := substr(md5(gen_random_uuid()::text), 1, 8);
  v_actor uuid;
  v_actor_name text;
  v_customer_id uuid;
  v_product_id uuid;
  v_product_name text;
  v_product_unit_size text;
  v_product_cost numeric;
  v_order_id uuid;
  v_replay_order_id uuid;
  v_result jsonb;
  v_items jsonb;
  v_order_number text := '[SMOKE]-BIO-' || v_sfx;
  v_key text := 'smoke-bulk-import-' || v_sfx;
  v_status text;
  v_total_price numeric;
  v_total_cost numeric;
  v_total_profit numeric;
  v_total_margin numeric;
  v_expected_cost numeric;
  v_expected_profit numeric;
  v_expected_margin numeric;
  v_item_count integer;
  v_quantity_delivered numeric;
  v_quantity_remaining numeric;
  v_item_total numeric;
  v_item_profit numeric;
  v_item_margin numeric;
  v_prebooked numeric;
  v_prebooked_baseline numeric;
  v_count integer;
  v_invalid text;
  v_field text;
  v_bad_token text;
  v_bad_order_number text;
  v_bad_key text;
  v_bad_items jsonb;
  v_inventory_tx_baseline integer;
  v_commission_baseline integer;
  v_activity_baseline integer;
  v_receipt_baseline integer;
BEGIN
  SELECT id, full_name
    INTO v_actor, v_actor_name
  FROM public.profiles
  WHERE role = 'sales_rep'
    AND is_active = true
  ORDER BY id
  LIMIT 1;

  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: no active sales_rep profile';
  END IF;

  INSERT INTO public.customers (
    farm_name,
    default_commission_split
  ) VALUES (
    '[SMOKE] Bulk Import Customer ' || v_sfx,
    jsonb_build_object(
      'splits',
      jsonb_build_array(jsonb_build_object(
        'recipient', v_actor_name,
        'recipient_user_id', v_actor,
        'percentage', 100
      ))
    )
  )
  RETURNING id INTO v_customer_id;

  SELECT id, product_name, unit_size, current_cost
    INTO v_product_id, v_product_name, v_product_unit_size, v_product_cost
  FROM public.products
  WHERE is_active = true
    AND current_cost IS NOT NULL
    AND current_cost::text NOT IN ('NaN', 'Infinity', '-Infinity')
    AND current_cost > 0
  ORDER BY id
  LIMIT 1;

  IF v_product_id IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: no active Product with a finite positive current_cost';
  END IF;

  INSERT INTO public.inventory (
    product_id,
    location,
    quantity_available,
    quantity_prebooked,
    quantity_on_order,
    unit_size
  ) VALUES (
    v_product_id,
    'Main Warehouse',
    100,
    0,
    0,
    v_product_unit_size
  ) ON CONFLICT (product_id, location) DO NOTHING;

  SELECT quantity_prebooked
    INTO v_prebooked_baseline
  FROM public.inventory
  WHERE product_id = v_product_id
    AND location = 'Main Warehouse';

  v_items := jsonb_build_array(jsonb_build_object(
    'product_id', v_product_id,
    'product_name', v_product_name,
    'price_per_unit', 10.004,
    -- Deliberately hostile caller cost: Product current_cost must win.
    'unit_cost', 0,
    'total_units_needed', 5,
    'unit_size', v_product_unit_size,
    'sort_order', 1
  ));

  v_expected_cost := round(5 * round(v_product_cost, 2), 2);
  v_expected_profit := 50 - v_expected_cost;
  v_expected_margin := (v_expected_profit / 50) * 100;

  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_actor, 'role', 'authenticated')::text,
    true
  );

  -- A terminal imported status must fail before writing any lifecycle rows.
  BEGIN
    PERFORM public.bulk_import_order(
      p_order_number := v_order_number || '-BAD',
      p_customer_id := v_customer_id,
      p_status := 'fulfilled',
      p_total_price := 50,
      p_total_cost := 30,
      p_total_profit := 20,
      p_total_margin_pct := 40,
      p_order_date := CURRENT_DATE,
      p_items := v_items,
      p_idempotency_key := v_key || '-bad'
    );
    RAISE EXCEPTION 'SMOKE_FAIL: fulfilled import was accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'INVALID_IMPORT_STATUS:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: expected INVALID_IMPORT_STATUS, got %', SQLERRM;
    END IF;
  END;

  SELECT count(*)
    INTO v_count
  FROM public.orders
  WHERE order_number = v_order_number || '-BAD';
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: rejected terminal import wrote an order';
  END IF;

  SELECT count(*) INTO v_inventory_tx_baseline
  FROM public.inventory_transactions
  WHERE product_id = v_product_id;

  SELECT count(*) INTO v_commission_baseline
  FROM public.commissions
  WHERE customer_id = v_customer_id;

  SELECT count(*) INTO v_activity_baseline
  FROM public.activity_feed
  WHERE customer_id = v_customer_id;

  SELECT count(*) INTO v_receipt_baseline
  FROM public.idempotency_keys
  WHERE operation = 'bulk_import_order'
    AND idempotency_key LIKE v_key || '-numeric-%';

  -- PostgreSQL numeric accepts NaN and +/-Infinity. Every caller-controlled
  -- numeric field must reject all three before any lifecycle write.
  FOREACH v_field IN ARRAY ARRAY['total_units_needed', 'price_per_unit', 'unit_cost']
  LOOP
    FOREACH v_invalid IN ARRAY ARRAY['NaN', 'Infinity', '-Infinity']
    LOOP
      v_bad_token := lower(replace(v_invalid, '-', 'neg'));
      v_bad_order_number := v_order_number || '-NUMERIC-' || v_field || '-' || v_bad_token;
      v_bad_key := v_key || '-numeric-' || v_field || '-' || v_bad_token;
      v_bad_items := jsonb_set(v_items, ARRAY['0', v_field], to_jsonb(v_invalid), false);

      BEGIN
        PERFORM public.bulk_import_order(
          p_order_number := v_bad_order_number,
          p_customer_id := v_customer_id,
          p_status := 'confirmed',
          p_total_price := 50,
          p_total_cost := 30,
          p_total_profit := 20,
          p_total_margin_pct := 40,
          p_order_date := CURRENT_DATE,
          p_items := v_bad_items,
          p_idempotency_key := v_bad_key
        );
        RAISE EXCEPTION 'SMOKE_FAIL: % accepted for %', v_invalid, v_field;
      EXCEPTION WHEN OTHERS THEN
        IF SQLERRM NOT LIKE 'ITEM_INVALID:%' THEN
          RAISE EXCEPTION
            'SMOKE_FAIL: expected ITEM_INVALID for % %, got %',
            v_field, v_invalid, SQLERRM;
        END IF;
      END;

      SELECT count(*) INTO v_count
      FROM public.orders
      WHERE order_number = v_bad_order_number;
      IF v_count <> 0 THEN
        RAISE EXCEPTION 'SMOKE_FAIL: rejected numeric import wrote an order';
      END IF;

      SELECT quantity_prebooked INTO v_prebooked
      FROM public.inventory
      WHERE product_id = v_product_id
        AND location = 'Main Warehouse';
      IF v_prebooked IS DISTINCT FROM v_prebooked_baseline THEN
        RAISE EXCEPTION 'SMOKE_FAIL: rejected numeric import changed inventory';
      END IF;

      SELECT count(*) INTO v_count
      FROM public.inventory_transactions
      WHERE product_id = v_product_id;
      IF v_count <> v_inventory_tx_baseline THEN
        RAISE EXCEPTION 'SMOKE_FAIL: rejected numeric import wrote inventory ledger';
      END IF;

      SELECT count(*) INTO v_count
      FROM public.commissions
      WHERE customer_id = v_customer_id;
      IF v_count <> v_commission_baseline THEN
        RAISE EXCEPTION 'SMOKE_FAIL: rejected numeric import wrote commission';
      END IF;

      SELECT count(*) INTO v_count
      FROM public.activity_feed
      WHERE customer_id = v_customer_id;
      IF v_count <> v_activity_baseline THEN
        RAISE EXCEPTION 'SMOKE_FAIL: rejected numeric import wrote activity';
      END IF;

      SELECT count(*) INTO v_count
      FROM public.idempotency_keys
      WHERE operation = 'bulk_import_order'
        AND idempotency_key = v_bad_key;
      IF v_count <> v_receipt_baseline THEN
        RAISE EXCEPTION 'SMOKE_FAIL: rejected numeric import wrote idempotency receipt';
      END IF;
    END LOOP;
  END LOOP;

  -- An omitted cost snapshots Product current_cost rather than silently using
  -- zero. The sentinel exception rolls the successful proof call back locally
  -- so the main lifecycle assertions below retain a clean baseline.
  BEGIN
    SELECT public.bulk_import_order(
      p_order_number := v_order_number || '-OMITTED-COST',
      p_customer_id := v_customer_id,
      p_status := 'confirmed',
      p_total_price := 9999,
      p_total_cost := 0,
      p_total_profit := 9999,
      p_total_margin_pct := 100,
      p_order_date := CURRENT_DATE,
      p_items := v_items #- ARRAY['0', 'unit_cost'],
      p_idempotency_key := v_key || '-omitted-cost'
    ) INTO v_result;

    v_order_id := (v_result->>'order_id')::uuid;
    SELECT total_cost, total_profit
      INTO v_total_cost, v_total_profit
    FROM public.orders
    WHERE id = v_order_id;
    IF v_total_cost <> round(5 * round(v_product_cost, 2), 2)
       OR v_total_profit <> 50 - round(5 * round(v_product_cost, 2), 2) THEN
      RAISE EXCEPTION
        'SMOKE_FAIL: omitted cost did not snapshot Product cost; cost=% profit=%',
        v_total_cost, v_total_profit;
    END IF;

    SELECT count(*) INTO v_count
    FROM public.commissions
    WHERE order_id = v_order_id
      AND order_profit = 50 - round(5 * round(v_product_cost, 2), 2);
    IF v_count <> 1 THEN
      RAISE EXCEPTION 'SMOKE_FAIL: omitted-cost commission used wrong profit';
    END IF;

    RAISE EXCEPTION 'SMOKE_OMITTED_COST_ROLLBACK';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'SMOKE_OMITTED_COST_ROLLBACK' THEN
      RAISE;
    END IF;
  END;

  SELECT quantity_prebooked INTO v_prebooked
  FROM public.inventory
  WHERE product_id = v_product_id
    AND location = 'Main Warehouse';
  IF v_prebooked IS DISTINCT FROM v_prebooked_baseline THEN
    RAISE EXCEPTION 'SMOKE_FAIL: omitted-cost proof left inventory residue';
  END IF;

  -- Malformed explicit cost must fail before every lifecycle side effect.
  v_bad_order_number := v_order_number || '-MALFORMED-COST';
  v_bad_key := v_key || '-malformed-cost';
  v_bad_items := jsonb_set(v_items, ARRAY['0', 'unit_cost'], '"not-a-number"'::jsonb, false);
  BEGIN
    PERFORM public.bulk_import_order(
      p_order_number := v_bad_order_number,
      p_customer_id := v_customer_id,
      p_status := 'confirmed',
      p_total_price := 50,
      p_total_cost := 30,
      p_total_profit := 20,
      p_total_margin_pct := 40,
      p_order_date := CURRENT_DATE,
      p_items := v_bad_items,
      p_idempotency_key := v_bad_key
    );
    RAISE EXCEPTION 'SMOKE_FAIL: malformed unit_cost was accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'ITEM_INVALID:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: expected ITEM_INVALID for malformed cost, got %', SQLERRM;
    END IF;
  END;

  SELECT count(*) INTO v_count
  FROM public.orders
  WHERE order_number = v_bad_order_number;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: malformed-cost import wrote an order';
  END IF;

  SELECT quantity_prebooked INTO v_prebooked
  FROM public.inventory
  WHERE product_id = v_product_id
    AND location = 'Main Warehouse';
  IF v_prebooked IS DISTINCT FROM v_prebooked_baseline THEN
    RAISE EXCEPTION 'SMOKE_FAIL: malformed-cost import changed inventory';
  END IF;

  SELECT count(*) INTO v_count
  FROM public.inventory_transactions
  WHERE product_id = v_product_id;
  IF v_count <> v_inventory_tx_baseline THEN
    RAISE EXCEPTION 'SMOKE_FAIL: malformed-cost import wrote inventory ledger';
  END IF;

  SELECT count(*) INTO v_count
  FROM public.commissions
  WHERE customer_id = v_customer_id;
  IF v_count <> v_commission_baseline THEN
    RAISE EXCEPTION 'SMOKE_FAIL: malformed-cost import wrote commission';
  END IF;

  SELECT count(*) INTO v_count
  FROM public.activity_feed
  WHERE customer_id = v_customer_id;
  IF v_count <> v_activity_baseline THEN
    RAISE EXCEPTION 'SMOKE_FAIL: malformed-cost import wrote activity';
  END IF;

  SELECT count(*) INTO v_count
  FROM public.idempotency_keys
  WHERE operation = 'bulk_import_order'
    AND idempotency_key = v_bad_key;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: malformed-cost import wrote idempotency receipt';
  END IF;

  -- Deliberately pass false totals, a sub-cent item price, and caller cost 0.
  -- The RPC must normalize price, ignore caller cost, and derive Product cost.
  SELECT public.bulk_import_order(
    p_order_number := v_order_number,
    p_customer_id := v_customer_id,
    p_status := 'confirmed',
    p_total_price := 9999,
    p_total_cost := 1,
    p_total_profit := 9998,
    p_total_margin_pct := 99,
    p_order_date := CURRENT_DATE,
    p_items := v_items,
    p_notes := '[SMOKE] lifecycle parity',
    p_idempotency_key := v_key
  ) INTO v_result;

  v_order_id := (v_result->>'order_id')::uuid;
  IF v_order_id IS NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL: import returned no order_id (%)', v_result;
  END IF;

  SELECT status, total_price, total_cost, total_profit, total_margin_pct
    INTO v_status, v_total_price, v_total_cost, v_total_profit, v_total_margin
  FROM public.orders
  WHERE id = v_order_id;

  IF v_status <> 'confirmed'
     OR v_total_price <> 50
     OR v_total_cost <> v_expected_cost
     OR v_total_profit <> v_expected_profit
     OR v_total_margin <> v_expected_margin THEN
    RAISE EXCEPTION
      'SMOKE_FAIL: order state/totals mismatch status=% totals=%/%/%/%',
      v_status, v_total_price, v_total_cost, v_total_profit, v_total_margin;
  END IF;

  SELECT count(*), min(quantity_delivered), min(quantity_remaining),
         min(total_price), min(profit), min(net_margin)
    INTO v_item_count, v_quantity_delivered, v_quantity_remaining,
         v_item_total, v_item_profit, v_item_margin
  FROM public.order_items
  WHERE order_id = v_order_id;

  IF v_item_count <> 1
     OR v_quantity_delivered <> 0
     OR v_quantity_remaining <> 5
     OR v_item_total <> 50
     OR v_item_profit <> v_expected_profit
     OR v_item_margin <> ((10 - round(v_product_cost, 2)) / 10) * 100 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: imported line bookkeeping mismatch';
  END IF;

  SELECT quantity_prebooked
    INTO v_prebooked
  FROM public.inventory
  WHERE product_id = v_product_id
    AND location = 'Main Warehouse';
  IF v_prebooked <> v_prebooked_baseline + 5 THEN
    RAISE EXCEPTION
      'SMOKE_FAIL: inventory prebooked %, expected %',
      v_prebooked, v_prebooked_baseline + 5;
  END IF;

  SELECT count(*) INTO v_count
  FROM public.inventory_transactions
  WHERE order_id = v_order_id
    AND product_id = v_product_id
    AND transaction_type = 'booked'
    AND quantity = 5;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: expected one booked inventory transaction, got %', v_count;
  END IF;

  SELECT count(*) INTO v_count
  FROM public.commissions
  WHERE order_id = v_order_id
    AND order_profit = v_expected_profit;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: expected one imported-order commission, got %', v_count;
  END IF;

  SELECT count(*) INTO v_count
  FROM public.activity_feed
  WHERE related_entity_type = 'order'
    AND related_entity_id = v_order_id
    AND event_type = 'order_created';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: expected one atomic order activity event, got %', v_count;
  END IF;

  SELECT public.bulk_import_order(
    p_order_number := v_order_number,
    p_customer_id := v_customer_id,
    p_status := 'confirmed',
    p_total_price := 50,
    p_total_cost := v_expected_cost,
    p_total_profit := v_expected_profit,
    p_total_margin_pct := v_expected_margin,
    p_order_date := CURRENT_DATE,
    p_items := v_items,
    p_idempotency_key := v_key
  ) INTO v_result;

  v_replay_order_id := (v_result->>'order_id')::uuid;
  IF v_replay_order_id IS DISTINCT FROM v_order_id THEN
    RAISE EXCEPTION 'SMOKE_FAIL: idempotency replay returned a different order';
  END IF;

  SELECT count(*) INTO v_count
  FROM public.orders
  WHERE customer_id = v_customer_id;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: idempotency replay created duplicate orders';
  END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END $$;
