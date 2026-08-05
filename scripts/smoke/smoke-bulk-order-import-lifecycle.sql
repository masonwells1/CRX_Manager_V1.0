-- ============================================================================
-- smoke-bulk-order-import-lifecycle.sql
-- Chain for 20260805204716_harden_bulk_order_import_lifecycle.sql.
--
-- Proves that a bulk import cannot forge a partial/terminal lifecycle state and
-- that a confirmed import atomically creates its order lines, inventory booking,
-- booked ledger row, commission, activity event, and idempotency receipt.
-- The terminal SMOKE_PASS_ROLLBACK exception aborts every synthetic write.
-- ============================================================================
DO $$
DECLARE
  v_sfx text := substr(md5(gen_random_uuid()::text), 1, 8);
  v_actor uuid;
  v_actor_name text;
  v_customer_id uuid;
  v_product_id uuid;
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
  v_item_count integer;
  v_quantity_delivered numeric;
  v_quantity_remaining numeric;
  v_item_total numeric;
  v_item_profit numeric;
  v_item_margin numeric;
  v_prebooked numeric;
  v_count integer;
BEGIN
  SELECT id, full_name
    INTO v_actor, v_actor_name
  FROM public.profiles
  WHERE role IN ('admin', 'sales_rep')
    AND is_active = true
  ORDER BY CASE role WHEN 'sales_rep' THEN 0 ELSE 1 END, id
  LIMIT 1;

  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: no active admin or sales_rep profile';
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

  INSERT INTO public.products (
    product_name,
    unit_size
  ) VALUES (
    '[SMOKE] Canonical Product ' || v_sfx,
    '2.5 gal'
  )
  RETURNING id INTO v_product_id;

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
    '2.5 gal'
  );

  v_items := jsonb_build_array(jsonb_build_object(
    'product_id', v_product_id,
    'product_name', '[SMOKE] Caller-Supplied Name',
    'price_per_unit', 10,
    'unit_cost', 6,
    'total_units_needed', 5,
    'unit_size', '2.5 gal',
    'sort_order', 1
  ));

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

  -- Deliberately pass false totals. The RPC must recompute 50/30/20/40.
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
     OR v_total_cost <> 30
     OR v_total_profit <> 20
     OR v_total_margin <> 40 THEN
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
     OR v_item_profit <> 20
     OR v_item_margin <> 40 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: imported line bookkeeping mismatch';
  END IF;

  SELECT quantity_prebooked
    INTO v_prebooked
  FROM public.inventory
  WHERE product_id = v_product_id
    AND location = 'Main Warehouse';
  IF v_prebooked <> 5 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: inventory prebooked %, expected 5', v_prebooked;
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
  WHERE order_id = v_order_id;
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
    p_total_cost := 30,
    p_total_profit := 20,
    p_total_margin_pct := 40,
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
