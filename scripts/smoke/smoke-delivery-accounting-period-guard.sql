-- Post-apply rollback-only proof for the delivery closed-period invariant.
-- Exercises the real complete_delivery and void_delivery RPCs, verifies that
-- rejected calls leak no partial side effects, proves authorization runs before
-- a cached completion replay, proves both open-period paths, and rolls back
-- every fixture through the terminal exception.
DO $smoke$
DECLARE
  v_admin uuid;
  v_unauthorized uuid;
  v_suffix text := substr(md5(random()::text), 1, 8);
  v_customer uuid;
  v_product uuid;
  v_order uuid;
  v_order_item uuid;
  v_delivery uuid;
  v_legacy_delivery uuid;
  v_delivery_item uuid;
  v_closed_period uuid;
  v_open_period uuid;
  v_closed_date date;
  v_open_date date;
  v_second_open_date date;
  v_closed_at timestamptz;
  v_open_at timestamptz;
  v_second_open_at timestamptz;
  v_status text;
  v_invoice_status text;
  v_completed_date date;
  v_legacy_scheduled_date date;
  v_available numeric;
  v_available_after_complete numeric;
  v_prebooked numeric;
  v_delivered numeric;
  v_count bigint;
  v_err text;
  v_complete_closed_key text := 'smk-delivery-closed-complete-' || v_suffix;
  v_complete_open_key text := 'smk-delivery-open-complete-' || v_suffix;
  v_void_closed_key text := 'smk-delivery-closed-void-' || v_suffix;
  v_void_open_key text := 'smk-delivery-open-void-' || v_suffix;
BEGIN
  SELECT id INTO v_admin
  FROM public.profiles
  WHERE role = 'admin' AND is_active = true
  ORDER BY created_at
  LIMIT 1;

  IF v_admin IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: active admin required';
  END IF;

  SELECT id INTO v_unauthorized
  FROM public.profiles
  WHERE is_active = true
    AND role NOT IN ('admin', 'sales_rep', 'driver')
  ORDER BY created_at
  LIMIT 1;

  IF v_unauthorized IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: active non-delivery profile required';
  END IF;

  -- Fixed, historical, disposable months prevent the proof from drifting as
  -- the calendar advances. Refuse to touch them if real historical data uses
  -- any one of the three months; the terminal exception rolls every fixture
  -- back, including the two smoke-only closed rows created below.
  v_closed_date := DATE '1990-01-15';
  v_open_date := DATE '1990-02-15';
  v_second_open_date := DATE '1990-03-15';

  IF EXISTS (
    SELECT 1
    FROM public.accounting_periods AS ap
    WHERE ap.period_start <= DATE '1990-03-31'
      AND ap.period_end >= DATE '1990-01-01'
  ) THEN
    RAISE EXCEPTION 'SMOKE_SETUP: fixed historical delivery-proof months are not isolated';
  END IF;

  v_closed_at := (v_closed_date::timestamp + time '12:00') AT TIME ZONE 'America/Chicago';
  v_open_at := (v_open_date::timestamp + time '12:00') AT TIME ZONE 'America/Chicago';
  v_second_open_at := (v_second_open_date::timestamp + time '12:00') AT TIME ZONE 'America/Chicago';

  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text,
    true
  );

  INSERT INTO public.accounting_periods (
    period_start, period_end, status, closed_by, closed_at, notes
  ) VALUES (
    date_trunc('month', v_closed_date)::date,
    (date_trunc('month', v_closed_date) + interval '1 month - 1 day')::date,
    'closed', v_admin, now(),
    '[SMOKE] complete_delivery closed-period guard'
  ) RETURNING id INTO v_closed_period;

  INSERT INTO public.customers (farm_name)
  VALUES ('[SMOKE] Delivery Period Farm ' || v_suffix)
  RETURNING id INTO v_customer;

  INSERT INTO public.products (
    product_name, unit_size, epa_registration, product_form
  ) VALUES (
    '[SMOKE] Delivery Period Product ' || v_suffix,
    'GL', '[SMOKE]-DEL-PERIOD-' || v_suffix, 'liquid'
  ) RETURNING id INTO v_product;

  INSERT INTO public.inventory (
    product_id, location, quantity_available, quantity_prebooked, unit_size
  ) VALUES (v_product, 'Main Warehouse', 100, 2, 'GL');

  INSERT INTO public.orders (
    order_number, customer_id, status, booking_draw
  ) VALUES (
    '[SMOKE] DEL-PERIOD-' || v_suffix, v_customer, 'confirmed', false
  ) RETURNING id INTO v_order;

  INSERT INTO public.order_items (
    order_id, product_id, product_name, price_per_unit, cost_per_unit,
    total_units_needed, total_price, profit, net_margin,
    quantity_delivered, quantity_remaining, pricing_pending
  ) VALUES (
    v_order, v_product, '[SMOKE] delivery period line', 0, 0,
    2, 0, 0, 0, 0, 2, true
  ) RETURNING id INTO v_order_item;

  INSERT INTO public.deliveries (
    delivery_number, order_id, customer_id, assigned_driver,
    scheduled_date, status, created_by
  ) VALUES (
    '[SMOKE] DEL-PERIOD-' || v_suffix, v_order, v_customer, NULL,
    v_open_date, 'scheduled', v_admin
  ) RETURNING id INTO v_delivery;

  INSERT INTO public.delivery_items (
    delivery_id, order_item_id, product_id, quantity,
    quantity_delivered, unit_size
  ) VALUES (v_delivery, v_order_item, v_product, 2, 0, 'GL')
  RETURNING id INTO v_delivery_item;

  UPDATE public.deliveries SET status = 'in_progress' WHERE id = v_delivery;

  -- Closed-period completion must fail before any caller side effect commits.
  BEGIN
    PERFORM public.complete_delivery(
      v_delivery,
      'Smoke Receiver',
      v_admin,
      jsonb_build_object(v_delivery_item::text, 2),
      NULL,
      NULL,
      v_complete_closed_key,
      v_closed_at
    );
    RAISE EXCEPTION 'SMOKE_FAIL: complete_delivery changed a closed period';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'Date % falls in closed accounting period %' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong closed-completion error: %', v_err;
    END IF;
  END;

  SELECT status INTO v_status FROM public.deliveries WHERE id = v_delivery;
  SELECT quantity_available, quantity_prebooked
    INTO v_available, v_prebooked
    FROM public.inventory
   WHERE product_id = v_product AND location = 'Main Warehouse';
  SELECT quantity_delivered INTO v_delivered
  FROM public.order_items WHERE id = v_order_item;
  SELECT count(*) INTO v_count
  FROM public.invoices
  WHERE order_id = v_order AND deleted_at IS NULL;

  IF v_status <> 'in_progress'
     OR v_available <> 100
     OR v_prebooked <> 2
     OR v_delivered <> 0
     OR v_count <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: closed completion leaked state status=% available=% prebooked=% delivered=% invoices=%',
      v_status, v_available, v_prebooked, v_delivered, v_count;
  END IF;

  SELECT count(*) INTO v_count
  FROM public.inventory_transactions
  WHERE delivery_id = v_delivery;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: closed completion leaked % inventory transactions', v_count;
  END IF;

  SELECT count(*) INTO v_count
  FROM public.idempotency_keys
  WHERE idempotency_key = v_complete_closed_key
    AND operation = 'complete_delivery';
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: closed completion cached an idempotency result';
  END IF;

  SELECT count(*) INTO v_count
  FROM public.activity_feed
  WHERE related_entity_id = v_delivery
    AND event_type = 'backdated_delivery_in_closed_period';
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: closed completion warning escaped the rejected transaction';
  END IF;

  -- The ordinary open-period completion path must remain available.
  PERFORM public.complete_delivery(
    v_delivery,
    'Smoke Receiver',
    v_admin,
    jsonb_build_object(v_delivery_item::text, 2),
    NULL,
    NULL,
    v_complete_open_key,
    v_open_at
  );

  SELECT status, (completed_at AT TIME ZONE 'America/Chicago')::date
    INTO v_status, v_completed_date
    FROM public.deliveries
   WHERE id = v_delivery;
  SELECT quantity_available INTO v_available_after_complete
  FROM public.inventory
  WHERE product_id = v_product AND location = 'Main Warehouse';
  SELECT count(*) INTO v_count
  FROM public.inventory_transactions
  WHERE delivery_id = v_delivery AND transaction_type = 'delivered';

  IF v_status <> 'completed'
     OR v_completed_date <> v_open_date
     OR v_available_after_complete <> 98
     OR v_count <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: open completion failed status=% date=% available=% delivered_rows=%',
      v_status, v_completed_date, v_available_after_complete, v_count;
  END IF;

  SELECT status INTO v_invoice_status
  FROM public.invoices
  WHERE order_id = v_order AND deleted_at IS NULL
  ORDER BY created_at
  LIMIT 1;
  IF v_invoice_status <> 'draft' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: open completion did not create its draft invoice: %', v_invoice_status;
  END IF;

  -- A valid key now has a committed result. A different active user must still
  -- pass current delivery authorization before that cached result is visible.
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_unauthorized, 'role', 'authenticated')::text,
    true
  );
  PERFORM set_config('request.jwt.claim.sub', v_unauthorized::text, true);

  BEGIN
    PERFORM public.complete_delivery(
      v_delivery,
      'Smoke Receiver',
      v_unauthorized,
      jsonb_build_object(v_delivery_item::text, 2),
      NULL,
      NULL,
      v_complete_open_key,
      v_open_at
    );
    RAISE EXCEPTION 'SMOKE_FAIL: unauthorized caller received cached completion result';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err <> 'Not authorized to complete this delivery' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong unauthorized-replay error: %', v_err;
    END IF;
  END;

  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text,
    true
  );
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);

  SELECT count(*) INTO v_count
  FROM public.idempotency_keys
  WHERE idempotency_key = v_complete_open_key
    AND operation = 'complete_delivery';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: unauthorized replay changed completion cache count to %', v_count;
  END IF;

  -- A browser-authorized direct rewrite cannot move a completed delivery into
  -- a closed period. This exercises the real enforce_delivery_accounting_period
  -- trigger path, not an RPC wrapper.
  BEGIN
    EXECUTE 'SET LOCAL ROLE authenticated';
    UPDATE public.deliveries
    SET completed_at = v_closed_at
    WHERE id = v_delivery;
    EXECUTE 'RESET ROLE';
    RAISE EXCEPTION 'SMOKE_FAIL: completed delivery moved into a closed period';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'Date % falls in closed accounting period %' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong completed new-date rewrite error: %', v_err;
    END IF;
  END;

  SELECT (completed_at AT TIME ZONE 'America/Chicago')::date
    INTO v_completed_date
    FROM public.deliveries
   WHERE id = v_delivery;
  IF v_completed_date <> v_open_date THEN
    RAISE EXCEPTION 'SMOKE_FAIL: rejected completed new-date rewrite changed date to %',
      v_completed_date;
  END IF;

  -- Legacy voided rows can lack completed_at and therefore use scheduled_date
  -- as their effective accounting date. Prove a scheduled_date-only table
  -- rewrite cannot move that history into a closed period.
  INSERT INTO public.deliveries (
    delivery_number, order_id, customer_id, assigned_driver,
    scheduled_date, status, completed_at, created_by
  ) VALUES (
    '[SMOKE] LEGACY-VOID-' || v_suffix, v_order, v_customer, NULL,
    v_open_date, 'voided', NULL, v_admin
  ) RETURNING id INTO v_legacy_delivery;

  BEGIN
    EXECUTE 'SET LOCAL ROLE authenticated';
    UPDATE public.deliveries
    SET scheduled_date = v_closed_date
    WHERE id = v_legacy_delivery;
    EXECUTE 'RESET ROLE';
    RAISE EXCEPTION 'SMOKE_FAIL: legacy voided delivery moved into a closed period';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'Date % falls in closed accounting period %' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong legacy voided new-date rewrite error: %', v_err;
    END IF;
  END;

  SELECT scheduled_date INTO v_legacy_scheduled_date
  FROM public.deliveries
  WHERE id = v_legacy_delivery;
  IF v_legacy_scheduled_date <> v_open_date THEN
    RAISE EXCEPTION 'SMOKE_FAIL: rejected legacy voided new-date rewrite changed date to %',
      v_legacy_scheduled_date;
  END IF;

  -- Freeze the completion date, then prove void_delivery is atomic too.
  INSERT INTO public.accounting_periods (
    period_start, period_end, status, closed_by, closed_at, notes
  ) VALUES (
    date_trunc('month', v_open_date)::date,
    (date_trunc('month', v_open_date) + interval '1 month - 1 day')::date,
    'closed', v_admin, now(),
    '[SMOKE] void_delivery closed-period guard'
  ) RETURNING id INTO v_open_period;

  -- Once the stored completion date is closed, it cannot be moved out to an
  -- otherwise-open date through the authenticated table update path.
  BEGIN
    EXECUTE 'SET LOCAL ROLE authenticated';
    UPDATE public.deliveries
    SET completed_at = v_second_open_at
    WHERE id = v_delivery;
    EXECUTE 'RESET ROLE';
    RAISE EXCEPTION 'SMOKE_FAIL: completed delivery moved out of a closed period';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'Date % falls in closed accounting period %' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong completed old-date rewrite error: %', v_err;
    END IF;
  END;

  SELECT (completed_at AT TIME ZONE 'America/Chicago')::date
    INTO v_completed_date
    FROM public.deliveries
   WHERE id = v_delivery;
  IF v_completed_date <> v_open_date THEN
    RAISE EXCEPTION 'SMOKE_FAIL: rejected completed old-date rewrite changed date to %',
      v_completed_date;
  END IF;

  BEGIN
    PERFORM public.void_delivery(
      v_delivery,
      'closed-period smoke rejection',
      v_admin,
      v_void_closed_key
    );
    RAISE EXCEPTION 'SMOKE_FAIL: void_delivery changed a closed period';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'Date % falls in closed accounting period %' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong closed-void error: %', v_err;
    END IF;
  END;

  SELECT status INTO v_status FROM public.deliveries WHERE id = v_delivery;
  SELECT quantity_available INTO v_available
  FROM public.inventory
  WHERE product_id = v_product AND location = 'Main Warehouse';
  SELECT quantity_delivered INTO v_delivered
  FROM public.order_items WHERE id = v_order_item;
  SELECT status INTO v_invoice_status
  FROM public.invoices
  WHERE order_id = v_order AND deleted_at IS NULL
  ORDER BY created_at
  LIMIT 1;
  SELECT count(*) INTO v_count
  FROM public.inventory_transactions
  WHERE delivery_id = v_delivery AND transaction_type = 'void_delivery_reversal';

  IF v_status <> 'completed'
     OR v_available <> v_available_after_complete
     OR v_delivered <> 2
     OR v_invoice_status <> 'draft'
     OR v_count <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: closed void leaked state status=% available=% delivered=% invoice=% reversals=%',
      v_status, v_available, v_delivered, v_invoice_status, v_count;
  END IF;

  SELECT count(*) INTO v_count
  FROM public.idempotency_keys
  WHERE idempotency_key = v_void_closed_key
    AND operation = 'void_delivery';
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: closed void cached an idempotency result';
  END IF;

  -- v_open_date is closed at this point. The same legacy row cannot move out
  -- of that frozen period through a scheduled_date-only authenticated update.
  BEGIN
    EXECUTE 'SET LOCAL ROLE authenticated';
    UPDATE public.deliveries
    SET scheduled_date = v_second_open_date
    WHERE id = v_legacy_delivery;
    EXECUTE 'RESET ROLE';
    RAISE EXCEPTION 'SMOKE_FAIL: legacy voided delivery moved out of a closed period';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'Date % falls in closed accounting period %' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong legacy voided old-date rewrite error: %', v_err;
    END IF;
  END;

  SELECT scheduled_date INTO v_legacy_scheduled_date
  FROM public.deliveries
  WHERE id = v_legacy_delivery;
  IF v_legacy_scheduled_date <> v_open_date THEN
    RAISE EXCEPTION 'SMOKE_FAIL: rejected legacy voided old-date rewrite changed date to %',
      v_legacy_scheduled_date;
  END IF;

  -- Reopen only the disposable smoke period and prove the normal void path.
  UPDATE public.accounting_periods
  SET status = 'open', closed_by = NULL, closed_at = NULL
  WHERE id = v_open_period;

  PERFORM public.void_delivery(
    v_delivery,
    'open-period smoke success',
    v_admin,
    v_void_open_key
  );

  SELECT status INTO v_status FROM public.deliveries WHERE id = v_delivery;
  SELECT quantity_available, quantity_prebooked
    INTO v_available, v_prebooked
    FROM public.inventory
   WHERE product_id = v_product AND location = 'Main Warehouse';
  SELECT quantity_delivered INTO v_delivered
  FROM public.order_items WHERE id = v_order_item;
  SELECT status INTO v_invoice_status
  FROM public.invoices
  WHERE order_id = v_order AND deleted_at IS NULL
  ORDER BY created_at
  LIMIT 1;
  SELECT count(*) INTO v_count
  FROM public.inventory_transactions
  WHERE delivery_id = v_delivery AND transaction_type = 'void_delivery_reversal';

  IF v_status <> 'voided'
     OR v_available <> 100
     OR v_prebooked <> 2
     OR v_delivered <> 0
     OR v_invoice_status <> 'cancelled'
     OR v_count <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: open void failed status=% available=% prebooked=% delivered=% invoice=% reversals=%',
      v_status, v_available, v_prebooked, v_delivered, v_invoice_status, v_count;
  END IF;

  -- A voided row is terminal history too; its date cannot be rewritten into
  -- the independently closed smoke period through authenticated table access.
  BEGIN
    EXECUTE 'SET LOCAL ROLE authenticated';
    UPDATE public.deliveries
    SET completed_at = v_closed_at
    WHERE id = v_delivery;
    EXECUTE 'RESET ROLE';
    RAISE EXCEPTION 'SMOKE_FAIL: voided delivery moved into a closed period';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'Date % falls in closed accounting period %' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong voided new-date rewrite error: %', v_err;
    END IF;
  END;

  SELECT (completed_at AT TIME ZONE 'America/Chicago')::date
    INTO v_completed_date
    FROM public.deliveries
   WHERE id = v_delivery;
  IF v_completed_date <> v_open_date THEN
    RAISE EXCEPTION 'SMOKE_FAIL: rejected voided rewrite changed date to %',
      v_completed_date;
  END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END $smoke$;
