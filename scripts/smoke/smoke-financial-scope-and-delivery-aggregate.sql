-- Rollback-only proof for financial customer scope and aggregate delivery stock warnings.
DO $smoke$
DECLARE
  v_admin uuid;
  v_sales uuid;
  v_suffix text := substr(md5(random()::text), 1, 8);
  v_owned_customer uuid;
  v_other_customer uuid;
  v_owned_invoice uuid;
  v_other_invoice uuid;
  v_product uuid;
  v_order uuid;
  v_order_item_a uuid;
  v_order_item_b uuid;
  v_delivery uuid;
  v_delivery_item_a uuid;
  v_delivery_item_b uuid;
  v_open_date date;
  v_completed_at timestamptz;
  v_result jsonb;
  v_replay jsonb;
  v_cached jsonb;
  v_available numeric;
  v_count bigint;
  v_notification_count bigint;
  v_err text;
  v_other_key text := 'smk-fin-scope-other-' || v_suffix;
  v_owned_key text := 'smk-fin-scope-owned-' || v_suffix;
  v_delivery_key text := 'smk-delivery-aggregate-' || v_suffix;
BEGIN
  SELECT id
    INTO v_admin
    FROM public.profiles
   WHERE role = 'admin'
     AND is_active = true
   ORDER BY created_at
   LIMIT 1;

  SELECT id
    INTO v_sales
    FROM public.profiles
   WHERE role = 'sales_rep'
     AND is_active = true
   ORDER BY created_at
   LIMIT 1;

  IF v_admin IS NULL OR v_sales IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: active admin and sales_rep required';
  END IF;

  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text,
    true
  );

  INSERT INTO public.customers (farm_name, assigned_sales_rep)
  VALUES ('[SMOKE] Owned Financial Customer ' || v_suffix, v_sales)
  RETURNING id INTO v_owned_customer;

  INSERT INTO public.customers (farm_name, assigned_sales_rep)
  VALUES ('[SMOKE] Other Financial Customer ' || v_suffix, NULL)
  RETURNING id INTO v_other_customer;

  -- Admin establishes an unassigned-customer invoice and cached response.
  v_other_invoice := public.save_invoice(
    jsonb_build_object(
      'customer_id', v_other_customer,
      'invoice_type', 'misc_charge',
      'status', 'draft',
      'invoice_date', CURRENT_DATE,
      'header_notes', '[SMOKE] other customer'
    ),
    '[]'::jsonb,
    v_other_key
  );

  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_sales, 'role', 'authenticated')::text,
    true
  );

  -- Assigned-customer create and replay remain available to sales reps.
  v_owned_invoice := public.save_invoice(
    jsonb_build_object(
      'customer_id', v_owned_customer,
      'invoice_type', 'misc_charge',
      'status', 'draft',
      'salesman_id', v_sales,
      'invoice_date', CURRENT_DATE,
      'header_notes', '[SMOKE] assigned customer'
    ),
    '[]'::jsonb,
    v_owned_key
  );

  IF public.save_invoice(
       jsonb_build_object(
         'customer_id', v_owned_customer,
         'invoice_type', 'misc_charge',
         'status', 'draft',
         'salesman_id', v_sales,
         'invoice_date', CURRENT_DATE,
         'header_notes', '[SMOKE] assigned customer'
       ),
       '[]'::jsonb,
       v_owned_key
     ) IS DISTINCT FROM v_owned_invoice THEN
    RAISE EXCEPTION 'SMOKE_FAIL: assigned-customer invoice replay changed identity';
  END IF;

  PERFORM *
    FROM public.get_customer_statement(
      v_owned_customer,
      CURRENT_DATE - 1,
      CURRENT_DATE + 1
    );

  BEGIN
    PERFORM *
      FROM public.get_customer_statement(
        v_other_customer,
        CURRENT_DATE - 1,
        CURRENT_DATE + 1
      );
    RAISE EXCEPTION 'SMOKE_FAIL: sales_rep read an unassigned customer statement';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err <> 'CUSTOMER_SCOPE_DENIED' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong statement scope error: %', v_err;
    END IF;
  END;

  -- This call reuses a committed key. Scope must fail before the internal
  -- implementation can return the admin's cached invoice ID.
  BEGIN
    PERFORM public.save_invoice(
      jsonb_build_object(
        'customer_id', v_other_customer,
        'invoice_type', 'misc_charge',
        'status', 'draft',
        'invoice_date', CURRENT_DATE,
        'header_notes', '[SMOKE] other customer'
      ),
      '[]'::jsonb,
      v_other_key
    );
    RAISE EXCEPTION 'SMOKE_FAIL: sales_rep replayed an unassigned invoice result';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err <> 'CUSTOMER_SCOPE_DENIED' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong invoice replay scope error: %', v_err;
    END IF;
  END;

  BEGIN
    PERFORM public.save_invoice(
      jsonb_build_object(
        'id', v_other_invoice,
        'customer_id', v_other_customer,
        'invoice_type', 'misc_charge',
        'status', 'draft',
        'invoice_date', CURRENT_DATE,
        'header_notes', '[SMOKE] forbidden edit'
      ),
      '[]'::jsonb,
      'smk-fin-scope-edit-' || v_suffix
    );
    RAISE EXCEPTION 'SMOKE_FAIL: sales_rep edited an unassigned invoice';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err <> 'CUSTOMER_SCOPE_DENIED' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong invoice edit scope error: %', v_err;
    END IF;
  END;

  -- Inactive sales profiles must lose both scoped endpoints immediately.
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text,
    true
  );
  UPDATE public.profiles SET is_active = false WHERE id = v_sales;
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_sales, 'role', 'authenticated')::text,
    true
  );
  BEGIN
    PERFORM *
      FROM public.get_customer_statement(
        v_owned_customer,
        CURRENT_DATE - 1,
        CURRENT_DATE + 1
      );
    RAISE EXCEPTION 'SMOKE_FAIL: inactive sales_rep read a statement';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err <> 'INSUFFICIENT_ROLE' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong inactive statement error: %', v_err;
    END IF;
  END;

  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text,
    true
  );
  UPDATE public.profiles SET is_active = true WHERE id = v_sales;

  -- Build two delivery lines for the same product. Each line (6) is below
  -- on-hand (10), but their aggregate (12) is short by 2.
  SELECT gs::date
    INTO v_open_date
    FROM generate_series(CURRENT_DATE, CURRENT_DATE - 365, interval '-1 day') AS gs
   WHERE NOT EXISTS (
     SELECT 1
       FROM public.accounting_periods ap
      WHERE gs::date BETWEEN ap.period_start AND ap.period_end
   )
   ORDER BY gs DESC
   LIMIT 1;

  IF v_open_date IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: no open accounting date available';
  END IF;

  v_completed_at := CASE
    WHEN v_open_date = CURRENT_DATE THEN clock_timestamp() - interval '1 minute'
    ELSE (v_open_date::timestamp + time '12:00') AT TIME ZONE 'America/Chicago'
  END;

  INSERT INTO public.products (
    product_name, unit_size, current_cost, epa_registration, product_form
  ) VALUES (
    '[SMOKE] Aggregate Stock Product ' || v_suffix,
    'GL', 6, '[SMOKE]-AGG-' || v_suffix, 'liquid'
  ) RETURNING id INTO v_product;

  INSERT INTO public.inventory (
    product_id, location, quantity_available, quantity_prebooked, unit_size
  ) VALUES (v_product, 'Main Warehouse', 10, 12, 'GL');

  INSERT INTO public.orders (
    order_number, customer_id, salesman_id, order_date, status, booking_draw
  ) VALUES (
    '[SMOKE] AGG-' || v_suffix,
    v_owned_customer,
    v_sales,
    v_open_date,
    'confirmed',
    false
  ) RETURNING id INTO v_order;

  INSERT INTO public.order_items (
    order_id, product_id, product_name, price_per_unit, cost_per_unit,
    total_units_needed, total_price, profit, net_margin,
    quantity_delivered, quantity_remaining
  ) VALUES (
    v_order, v_product, '[SMOKE] aggregate line A', 10, 6,
    6, 60, 24, 40, 0, 6
  ) RETURNING id INTO v_order_item_a;

  INSERT INTO public.order_items (
    order_id, product_id, product_name, price_per_unit, cost_per_unit,
    total_units_needed, total_price, profit, net_margin,
    quantity_delivered, quantity_remaining
  ) VALUES (
    v_order, v_product, '[SMOKE] aggregate line B', 10, 6,
    6, 60, 24, 40, 0, 6
  ) RETURNING id INTO v_order_item_b;

  INSERT INTO public.deliveries (
    delivery_number, order_id, customer_id, assigned_driver,
    scheduled_date, status, created_by
  ) VALUES (
    '[SMOKE] AGG-' || v_suffix,
    v_order,
    v_owned_customer,
    NULL,
    v_open_date,
    'scheduled',
    v_admin
  ) RETURNING id INTO v_delivery;

  INSERT INTO public.delivery_items (
    delivery_id, order_item_id, product_id, quantity,
    quantity_delivered, unit_size
  ) VALUES (
    v_delivery, v_order_item_a, v_product, 6, 0, 'GL'
  ) RETURNING id INTO v_delivery_item_a;

  INSERT INTO public.delivery_items (
    delivery_id, order_item_id, product_id, quantity,
    quantity_delivered, unit_size
  ) VALUES (
    v_delivery, v_order_item_b, v_product, 6, 0, 'GL'
  ) RETURNING id INTO v_delivery_item_b;

  UPDATE public.deliveries SET status = 'in_progress' WHERE id = v_delivery;

  v_result := public.complete_delivery(
    v_delivery,
    'Aggregate Smoke Receiver',
    v_admin,
    jsonb_build_object(
      v_delivery_item_a::text, 6,
      v_delivery_item_b::text, 6
    ),
    NULL,
    NULL,
    v_delivery_key,
    v_completed_at
  );

  IF COALESCE((v_result->>'stock_warning')::boolean, false) IS DISTINCT FROM true
     OR COALESCE((v_result->>'short_stock_count')::integer, 0) <> 1
     OR jsonb_array_length(COALESCE(v_result->'warnings', '[]'::jsonb)) <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: aggregate warning result was incomplete: %', v_result;
  END IF;

  SELECT quantity_available
    INTO v_available
    FROM public.inventory
   WHERE product_id = v_product
     AND location = 'Main Warehouse';

  IF v_available <> -2 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: WARN-NOT-BLOCK inventory result expected -2, got %', v_available;
  END IF;

  SELECT count(*)
    INTO v_count
    FROM public.inventory_transactions
   WHERE delivery_id = v_delivery
     AND product_id = v_product
     AND transaction_type = 'delivered'
     AND requires_review = true
     AND notes LIKE '%[SHORT STOCK — review required]%';

  IF v_count <> 2 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: expected both repeated-product ledger rows flagged, got %', v_count;
  END IF;

  SELECT count(*)
    INTO v_count
    FROM public.activity_feed
   WHERE related_entity_id = v_delivery
     AND event_type = 'delivery_short_stock';

  IF v_count <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: expected one aggregate stock activity, got %', v_count;
  END IF;

  SELECT result
    INTO v_cached
    FROM public.idempotency_keys
   WHERE idempotency_key = v_delivery_key
     AND operation = 'complete_delivery';

  IF v_cached IS DISTINCT FROM v_result THEN
    RAISE EXCEPTION 'SMOKE_FAIL: cached aggregate result differs: cached=% returned=%',
      v_cached, v_result;
  END IF;

  SELECT count(*)
    INTO v_notification_count
    FROM public.notifications
   WHERE related_entity_id = v_delivery
     AND notification_type = 'stock_warning';

  v_replay := public.complete_delivery(
    v_delivery,
    'Aggregate Smoke Receiver',
    v_admin,
    jsonb_build_object(
      v_delivery_item_a::text, 6,
      v_delivery_item_b::text, 6
    ),
    NULL,
    NULL,
    v_delivery_key,
    v_completed_at
  );

  IF v_replay IS DISTINCT FROM v_result THEN
    RAISE EXCEPTION 'SMOKE_FAIL: aggregate replay changed result: first=% replay=%',
      v_result, v_replay;
  END IF;

  SELECT count(*)
    INTO v_count
    FROM public.notifications
   WHERE related_entity_id = v_delivery
     AND notification_type = 'stock_warning';

  IF v_count <> v_notification_count THEN
    RAISE EXCEPTION 'SMOKE_FAIL: replay duplicated stock notifications: before=% after=%',
      v_notification_count, v_count;
  END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END
$smoke$;
