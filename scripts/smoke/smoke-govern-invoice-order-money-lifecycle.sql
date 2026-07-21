-- Rollback-only chain for 20260721010000_govern_invoice_order_money_lifecycle.
-- Exercises the partially delivered short-close, invoice recovery, retry binding,
-- terminal-order guards, and direct invoice-table DML revocation in one statement.
DO $smoke$
DECLARE
  v_suffix text := substr(md5(random()::text), 1, 8);
  v_admin uuid := gen_random_uuid();
  v_customer uuid;
  v_other_customer uuid;
  v_product uuid;
  v_other_product uuid;
  v_order uuid;
  v_other_order uuid;
  v_blocked_order uuid;
  v_blocked_item uuid;
  v_corrupt_order uuid;
  v_corrupt_item uuid;
  v_corrupt_delivery uuid;
  v_foreign_order uuid;
  v_foreign_item uuid;
  v_tiny_order uuid;
  v_tiny_item uuid;
  v_tiny_delivery uuid;
  v_swap_order uuid;
  v_swap_item uuid;
  v_swap_delivery uuid;
  v_bound_order uuid;
  v_bound_item uuid;
  v_bound_invoice uuid;
  v_bound_replay_invoice uuid;
  v_bound_other_invoice uuid;
  v_invoiced_order uuid;
  v_invoiced_item uuid;
  v_invoiced_delivery uuid;
  v_order_level_invoice uuid;
  v_deleted_order uuid;
  v_deleted_item uuid;
  v_deleted_delivery uuid;
  v_deleted_recovery_invoice uuid;
  v_draw_quote uuid;
  v_draw_order uuid;
  v_draw_item uuid;
  v_draw_delivery uuid;
  v_order_item uuid;
  v_delivery uuid;
  v_other_delivery uuid;
  v_result jsonb;
  v_replay jsonb;
  v_invoice_id uuid;
  v_surviving_invoice uuid;
  v_terminal_invoice_item uuid;
  v_commission uuid;
  v_commission_payment uuid;
  v_err text;
  v_count integer;
  v_numeric numeric;
  v_numeric_2 numeric;
  v_can_bypass_triggers boolean := COALESCE((
    SELECT r.rolsuper FROM pg_roles r WHERE r.rolname = current_user
  ), false);
BEGIN
  -- Disposable-database mode has no users. Live mode reuses an active admin.
  SELECT id INTO v_admin
    FROM public.profiles
   WHERE role = 'admin' AND is_active = true
   ORDER BY created_at
   LIMIT 1;
  IF v_admin IS NULL THEN
    v_admin := gen_random_uuid();
    INSERT INTO auth.users (id, email, created_at, updated_at)
    VALUES (v_admin, 'smoke-' || v_suffix || '@example.invalid', now(), now());
    INSERT INTO public.profiles (id, email, full_name, role, is_active)
    VALUES (v_admin, 'smoke-' || v_suffix || '@example.invalid', '[SMOKE] Admin', 'admin', true);
  END IF;

  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text,
    true
  );

  INSERT INTO public.customers (farm_name)
  VALUES ('[E2E] Lifecycle Farm ' || v_suffix)
  RETURNING id INTO v_customer;
  INSERT INTO public.customers (farm_name)
  VALUES ('[E2E] Other Lifecycle Farm ' || v_suffix)
  RETURNING id INTO v_other_customer;

  INSERT INTO public.products (product_name, unit_size)
  VALUES ('[E2E] Lifecycle Product ' || v_suffix, 'GL')
  RETURNING id INTO v_product;
  INSERT INTO public.products (product_name, unit_size)
  VALUES ('[E2E] Lifecycle Other Product ' || v_suffix, 'GL')
  RETURNING id INTO v_other_product;

  INSERT INTO public.inventory (
    product_id, location, quantity_available, quantity_prebooked, unit_size
  ) VALUES (v_product, 'Main Warehouse', 50, 10, 'GL');
  INSERT INTO public.inventory (
    product_id, location, quantity_available, quantity_prebooked, unit_size
  ) VALUES (v_other_product, 'Main Warehouse', 50, 0, 'GL');

  -- The normal order-edit RPC may not swap a product after that item is linked
  -- to a scheduled delivery. The failed RPC must roll back its earlier inventory
  -- release/prebook writes as well as preserve both sides of the lineage.
  INSERT INTO public.orders (
    order_number, customer_id, order_date, status, booking_draw
  ) VALUES (
    'E2E-LIFE-SWAP-' || v_suffix, v_customer, current_date, 'confirmed', false
  ) RETURNING id INTO v_swap_order;
  INSERT INTO public.order_items (
    order_id, product_id, product_name, price_per_unit, cost_per_unit,
    total_units_needed, total_price, profit, net_margin,
    quantity_delivered, quantity_remaining
  ) VALUES (
    v_swap_order, v_product, '[E2E] swap lineage', 10, 6,
    2, 20, 8, 40, 0, 2
  ) RETURNING id INTO v_swap_item;
  INSERT INTO public.deliveries (
    delivery_number, order_id, customer_id, scheduled_date, status, created_by
  ) VALUES (
    'E2E-LIFE-SWAP-D-' || v_suffix, v_swap_order, v_customer,
    current_date, 'scheduled', v_admin
  ) RETURNING id INTO v_swap_delivery;
  INSERT INTO public.delivery_items (
    delivery_id, order_item_id, product_id, quantity, quantity_delivered, unit_size
  ) VALUES (v_swap_delivery, v_swap_item, v_product, 2, 0, 'GL');
  SELECT quantity_prebooked INTO v_numeric
    FROM public.inventory
   WHERE product_id = v_product AND location = 'Main Warehouse';
  SELECT quantity_prebooked INTO v_numeric_2
    FROM public.inventory
   WHERE product_id = v_other_product AND location = 'Main Warehouse';
  SELECT count(*) INTO v_count
    FROM public.inventory_transactions
   WHERE order_id = v_swap_order;
  BEGIN
    PERFORM public.update_order_items(
      v_swap_order,
      jsonb_build_array(jsonb_build_object(
        'id', v_swap_item,
        'product_id', v_other_product,
        'product_name', '[E2E] forbidden swap target',
        'unit_size', 'GL',
        'cost_per_unit', 5,
        'price_per_unit', 9,
        'total_units_needed', 2
      )),
      v_admin,
      'e2e-life-forbidden-swap-' || v_suffix
    );
    RAISE EXCEPTION 'SMOKE_FAIL: order edit swapped a product linked to a scheduled delivery';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'ORDER_ITEM_DELIVERY_LINEAGE_LOCKED:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong linked-product swap error: %', v_err;
    END IF;
  END;
  IF (SELECT product_id FROM public.order_items WHERE id = v_swap_item)
       IS DISTINCT FROM v_product
     OR (SELECT product_id FROM public.delivery_items
          WHERE delivery_id = v_swap_delivery AND order_item_id = v_swap_item)
       IS DISTINCT FROM v_product
     OR (SELECT quantity_prebooked FROM public.inventory
          WHERE product_id = v_product AND location = 'Main Warehouse')
       IS DISTINCT FROM v_numeric
     OR (SELECT quantity_prebooked FROM public.inventory
          WHERE product_id = v_other_product AND location = 'Main Warehouse')
       IS DISTINCT FROM v_numeric_2
     OR (SELECT count(*) FROM public.inventory_transactions WHERE order_id = v_swap_order)
       IS DISTINCT FROM v_count THEN
    RAISE EXCEPTION 'SMOKE_FAIL: rejected product swap leaked an order, delivery, inventory, or ledger change';
  END IF;

  -- Valid backend sequence: create the whole-order draft first, then partially
  -- deliver. Closing remainder must refuse before shrinking any order/inventory
  -- state, because that draft still bills the original full quantity.
  INSERT INTO public.orders (
    order_number, customer_id, order_date, status, booking_draw
  ) VALUES (
    'E2E-LIFE-INVOICED-' || v_suffix, v_customer, current_date, 'confirmed', false
  ) RETURNING id INTO v_invoiced_order;
  INSERT INTO public.order_items (
    order_id, product_id, product_name, price_per_unit, cost_per_unit,
    total_units_needed, total_price, profit, net_margin,
    quantity_delivered, quantity_remaining
  ) VALUES (
    v_invoiced_order, v_product, '[E2E] invoice-first line', 10, 6,
    3, 30, 12, 40, 0, 3
  ) RETURNING id INTO v_invoiced_item;
  v_order_level_invoice := public.create_invoice_from_order(
    v_invoiced_order, v_admin, 'chemical_sale',
    'e2e-life-invoice-first-' || v_suffix
  );
  INSERT INTO public.deliveries (
    delivery_number, order_id, customer_id, scheduled_date, status, created_by
  ) VALUES (
    'E2E-LIFE-INVOICED-D-' || v_suffix, v_invoiced_order, v_customer,
    current_date, 'scheduled', v_admin
  ) RETURNING id INTO v_invoiced_delivery;
  INSERT INTO public.delivery_items (
    delivery_id, order_item_id, product_id, quantity, quantity_delivered, unit_size
  ) VALUES (v_invoiced_delivery, v_invoiced_item, v_product, 1, 1, 'GL');
  UPDATE public.deliveries SET status = 'in_progress' WHERE id = v_invoiced_delivery;
  UPDATE public.deliveries
     SET status = 'completed', completed_at = now(), signed_by = '[E2E] Invoice-first Receiver'
   WHERE id = v_invoiced_delivery;
  UPDATE public.order_items
     SET quantity_delivered = 1, quantity_remaining = 2
   WHERE id = v_invoiced_item;
  UPDATE public.orders SET status = 'partially_fulfilled'
   WHERE id = v_invoiced_order;
  SELECT quantity_prebooked INTO v_numeric
    FROM public.inventory
   WHERE product_id = v_product AND location = 'Main Warehouse';
  BEGIN
    PERFORM public.cancel_order(
      v_invoiced_order, v_admin, 'e2e-life-invoice-first-close-' || v_suffix
    );
    RAISE EXCEPTION 'SMOKE_FAIL: remainder close succeeded under an active whole-order invoice';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'ORDER_LEVEL_INVOICE_ACTIVE:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong active whole-order invoice error: %', v_err;
    END IF;
  END;
  IF (SELECT total_units_needed FROM public.order_items WHERE id = v_invoiced_item)
       IS DISTINCT FROM 3::numeric
     OR (SELECT status FROM public.invoices WHERE id = v_order_level_invoice)
       IS DISTINCT FROM 'draft'
     OR (SELECT total_amount_cents FROM public.invoices WHERE id = v_order_level_invoice)
       IS DISTINCT FROM 3000::bigint
     OR (SELECT quantity_prebooked FROM public.inventory
          WHERE product_id = v_product AND location = 'Main Warehouse')
       IS DISTINCT FROM v_numeric
     OR EXISTS (
       SELECT 1 FROM public.inventory_transactions
        WHERE order_id = v_invoiced_order AND transaction_type = 'released'
     ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: rejected invoice-first remainder close leaked state';
  END IF;

  INSERT INTO public.orders (
    order_number, customer_id, order_date, status, booking_draw
  ) VALUES (
    'E2E-LIFE-' || v_suffix, v_customer, current_date,
    'partially_fulfilled', false
  ) RETURNING id INTO v_order;

  INSERT INTO public.order_items (
    order_id, product_id, product_name, price_per_unit, cost_per_unit,
    total_units_needed, total_price, profit, net_margin,
    quantity_delivered, quantity_remaining
  ) VALUES (
    v_order, v_product, '[E2E] lifecycle line', 10, 6,
    10, 100, 40, 40, 4, 6
  ) RETURNING id INTO v_order_item;

  INSERT INTO public.deliveries (
    delivery_number, order_id, customer_id, scheduled_date,
    status, completed_at, signed_by, created_by
  ) VALUES (
    'E2E-LIFE-D-' || v_suffix, v_order, v_customer, current_date,
    'scheduled', NULL, NULL, v_admin
  ) RETURNING id INTO v_delivery;

  INSERT INTO public.delivery_items (
    delivery_id, order_item_id, product_id, quantity,
    quantity_delivered, unit_size
  ) VALUES (v_delivery, v_order_item, v_product, 4, 4, 'GL');

  UPDATE public.deliveries
  SET status = 'in_progress'
  WHERE id = v_delivery;

  UPDATE public.deliveries
  SET status = 'completed',
      completed_at = now(),
      signed_by = '[E2E] Lifecycle Receiver'
  WHERE id = v_delivery;

  -- Represent the canonical post-completion stock state: four delivered units
  -- have already consumed four of the ten prebooked units.
  UPDATE public.inventory
     SET quantity_prebooked = 6
   WHERE product_id = v_product AND location = 'Main Warehouse';

  INSERT INTO public.commissions (
    order_id, customer_id, recipient, split_percentage,
    commission_amount, order_profit, order_date, status
  ) VALUES
    (v_order, v_customer, '[E2E] lifecycle rep A', 33.33, 13.33, 40, current_date, 'pending'),
    (v_order, v_customer, '[E2E] lifecycle rep B', 66.67, 26.67, 40, current_date, 'pending');

  v_result := public.cancel_order(
    v_order, v_admin, 'e2e-life-cancel-' || v_suffix
  );
  IF v_result->>'mode' IS DISTINCT FROM 'remainder_closed'
     OR v_result->>'status' IS DISTINCT FROM 'fulfilled'
     OR (v_result->>'released_quantity')::numeric IS DISTINCT FROM 6::numeric THEN
    RAISE EXCEPTION 'SMOKE_FAIL: wrong remainder-close result: %', v_result;
  END IF;
  IF COALESCE(current_setting('app.admin_override', true), 'false') = 'true' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: remainder close leaked the admin override GUC';
  END IF;

  IF (SELECT status FROM public.orders WHERE id = v_order) IS DISTINCT FROM 'fulfilled'
     OR (SELECT total_units_needed FROM public.order_items WHERE id = v_order_item) IS DISTINCT FROM 4::numeric
     OR (SELECT quantity_remaining FROM public.order_items WHERE id = v_order_item) IS DISTINCT FROM 0::numeric
     OR (SELECT total_price FROM public.orders WHERE id = v_order) IS DISTINCT FROM 40::numeric
     OR (SELECT total_profit FROM public.orders WHERE id = v_order) IS DISTINCT FROM 16::numeric THEN
    RAISE EXCEPTION 'SMOKE_FAIL: delivered-only order totals/status are wrong';
  END IF;

  SELECT quantity_prebooked INTO v_numeric
    FROM public.inventory
   WHERE product_id = v_product AND location = 'Main Warehouse';
  IF v_numeric IS DISTINCT FROM 0::numeric THEN
    RAISE EXCEPTION 'SMOKE_FAIL: undelivered inventory release wrong (prebooked=%)', v_numeric;
  END IF;
  SELECT SUM(commission_amount) INTO v_numeric
    FROM public.commissions
   WHERE order_id = v_order AND deleted_at IS NULL;
  IF v_numeric IS DISTINCT FROM 16::numeric THEN
    RAISE EXCEPTION 'SMOKE_FAIL: delivered-profit commission total wrong (amount=%)', v_numeric;
  END IF;
  SELECT commission_amount INTO v_numeric
    FROM public.commissions
   WHERE order_id = v_order AND recipient = '[E2E] lifecycle rep A';
  SELECT commission_amount INTO v_numeric_2
    FROM public.commissions
   WHERE order_id = v_order AND recipient = '[E2E] lifecycle rep B';
  IF v_numeric IS DISTINCT FROM 5.33::numeric
     OR v_numeric_2 IS DISTINCT FROM 10.67::numeric THEN
    RAISE EXCEPTION 'SMOKE_FAIL: penny reconciliation wrong (A=%, B=%)', v_numeric, v_numeric_2;
  END IF;

  v_replay := public.cancel_order(
    v_order, v_admin, 'e2e-life-cancel-' || v_suffix
  );
  IF v_replay IS DISTINCT FROM v_result THEN
    RAISE EXCEPTION 'SMOKE_FAIL: identical cancel retry did not replay exact response';
  END IF;
  IF (SELECT quantity_prebooked FROM public.inventory
       WHERE product_id = v_product AND location = 'Main Warehouse') IS DISTINCT FROM 0::numeric THEN
    RAISE EXCEPTION 'SMOKE_FAIL: retry released inventory twice';
  END IF;

  -- Four equal splits of two cents must remain nonnegative and sum exactly to
  -- two cents. A "last row gets the difference" algorithm makes it -$0.01.
  UPDATE public.inventory
     SET quantity_prebooked = 1
   WHERE product_id = v_product AND location = 'Main Warehouse';
  INSERT INTO public.orders (
    order_number, customer_id, order_date, status, booking_draw
  ) VALUES (
    'E2E-LIFE-TINY-' || v_suffix, v_customer, current_date,
    'partially_fulfilled', false
  ) RETURNING id INTO v_tiny_order;
  INSERT INTO public.order_items (
    order_id, product_id, product_name, price_per_unit, cost_per_unit,
    total_units_needed, total_price, profit, net_margin,
    quantity_delivered, quantity_remaining
  ) VALUES (
    v_tiny_order, v_product, '[E2E] tiny profit line', 0.02, 0,
    2, 0.04, 0.04, 100, 1, 1
  ) RETURNING id INTO v_tiny_item;
  INSERT INTO public.deliveries (
    delivery_number, order_id, customer_id, scheduled_date, status, created_by
  ) VALUES (
    'E2E-LIFE-TINY-D-' || v_suffix, v_tiny_order, v_customer,
    current_date, 'scheduled', v_admin
  ) RETURNING id INTO v_tiny_delivery;
  INSERT INTO public.delivery_items (
    delivery_id, order_item_id, product_id, quantity,
    quantity_delivered, unit_size
  ) VALUES (v_tiny_delivery, v_tiny_item, v_product, 1, 1, 'GL');
  UPDATE public.deliveries SET status = 'in_progress' WHERE id = v_tiny_delivery;
  UPDATE public.deliveries
     SET status = 'completed', completed_at = now(), signed_by = '[E2E] Tiny Receiver'
   WHERE id = v_tiny_delivery;
  INSERT INTO public.commissions (
    order_id, customer_id, recipient, split_percentage,
    commission_amount, order_profit, order_date, status
  ) VALUES
    (v_tiny_order, v_customer, '[E2E] tiny A', 25, 0.01, 0.04, current_date, 'pending'),
    (v_tiny_order, v_customer, '[E2E] tiny B', 25, 0.01, 0.04, current_date, 'pending'),
    (v_tiny_order, v_customer, '[E2E] tiny C', 25, 0.01, 0.04, current_date, 'pending'),
    (v_tiny_order, v_customer, '[E2E] tiny D', 25, 0.01, 0.04, current_date, 'pending');
  PERFORM public.cancel_order(
    v_tiny_order, v_admin, 'e2e-life-tiny-close-' || v_suffix
  );
  SELECT SUM(commission_amount), MIN(commission_amount)
    INTO v_numeric, v_numeric_2
    FROM public.commissions
   WHERE order_id = v_tiny_order AND deleted_at IS NULL;
  IF v_numeric IS DISTINCT FROM 0.02::numeric OR v_numeric_2 < 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: tiny-profit commission allocation is not penny-exact/nonnegative (sum=%, min=%)',
      v_numeric, v_numeric_2;
  END IF;

  -- Exact argument-bound retry proofs for the three invoice wrappers. Each
  -- identical retry replays; the same key with changed target/reason/type fails.
  INSERT INTO public.orders (
    order_number, customer_id, order_date, status, booking_draw
  ) VALUES (
    'E2E-LIFE-BOUND-' || v_suffix, v_customer, current_date,
    'confirmed', false
  ) RETURNING id INTO v_bound_order;
  INSERT INTO public.order_items (
    order_id, product_id, product_name, price_per_unit, cost_per_unit,
    total_units_needed, total_price, profit, net_margin,
    quantity_delivered, quantity_remaining
  ) VALUES (
    v_bound_order, v_product, '[E2E] bound invoice line', 10, 6,
    1, 10, 4, 40, 0, 1
  ) RETURNING id INTO v_bound_item;

  v_bound_invoice := public.create_invoice_from_order(
    v_bound_order, v_admin, 'chemical_sale', 'e2e-life-create-bound-' || v_suffix
  );
  v_bound_replay_invoice := public.create_invoice_from_order(
    v_bound_order, v_admin, 'chemical_sale', 'e2e-life-create-bound-' || v_suffix
  );
  IF v_bound_replay_invoice IS DISTINCT FROM v_bound_invoice THEN
    RAISE EXCEPTION 'SMOKE_FAIL: create_invoice_from_order identical retry did not replay exact invoice';
  END IF;
  BEGIN
    PERFORM public.create_invoice_from_order(
      v_bound_order, v_admin, 'misc_charge', 'e2e-life-create-bound-' || v_suffix
    );
    RAISE EXCEPTION 'SMOKE_FAIL: create_invoice_from_order retry key accepted a different invoice type';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'IDEMPOTENCY_ARGUMENT_MISMATCH:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong create-invoice binding error: %', v_err;
    END IF;
  END;

  INSERT INTO public.invoices (
    invoice_number, customer_id, invoice_type, status,
    invoice_date, due_date, total_amount_cents, created_by
  ) VALUES (
    'E2E-LIFE-BOUND-OTHER-' || v_suffix, v_customer, 'misc_charge', 'draft',
    current_date, current_date + 30, 0, v_admin
  ) RETURNING id INTO v_bound_other_invoice;

  PERFORM public.post_invoice(v_bound_invoice, 'e2e-life-post-bound-' || v_suffix);
  PERFORM public.post_invoice(v_bound_invoice, 'e2e-life-post-bound-' || v_suffix);
  BEGIN
    PERFORM public.post_invoice(v_bound_other_invoice, 'e2e-life-post-bound-' || v_suffix);
    RAISE EXCEPTION 'SMOKE_FAIL: post_invoice retry key accepted a different invoice';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'IDEMPOTENCY_ARGUMENT_MISMATCH:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong post-invoice binding error: %', v_err;
    END IF;
  END;

  PERFORM public.void_invoice(
    v_bound_invoice, '[E2E] bound void', 'e2e-life-void-bound-' || v_suffix
  );
  PERFORM public.void_invoice(
    v_bound_invoice, '[E2E] bound void', 'e2e-life-void-bound-' || v_suffix
  );
  BEGIN
    PERFORM public.void_invoice(
      v_bound_other_invoice, '[E2E] changed void', 'e2e-life-void-bound-' || v_suffix
    );
    RAISE EXCEPTION 'SMOKE_FAIL: void_invoice retry key accepted different invoice/reason arguments';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'IDEMPOTENCY_REQUEST_MISMATCH:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong void-invoice binding error: %', v_err;
    END IF;
  END;

  BEGIN
    UPDATE public.orders SET deleted_at = now() WHERE id = v_order;
    RAISE EXCEPTION 'SMOKE_FAIL: active delivered order was soft-deleted';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err <> 'ORDER_MUST_BE_TERMINAL_BEFORE_DELETE' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong delivered-order soft-delete error: %', v_err;
    END IF;
  END;

  -- Matching corrupted totals are still unsafe: the order-item aggregate and
  -- delivery history agree at two, but the completed delivery planned only one.
  -- The exception block rolls this entire corrupt fixture back before continuing.
  BEGIN
    INSERT INTO public.orders (
      order_number, customer_id, order_date, status, booking_draw
    ) VALUES (
      'E2E-LIFE-CORRUPT-' || v_suffix, v_customer, current_date,
      'partially_fulfilled', false
    ) RETURNING id INTO v_corrupt_order;
    INSERT INTO public.order_items (
      order_id, product_id, product_name, price_per_unit, cost_per_unit,
      total_units_needed, total_price, profit, net_margin,
      quantity_delivered, quantity_remaining
    ) VALUES (
      v_corrupt_order, v_product, '[E2E] corrupt delivery line', 10, 6,
      3, 30, 12, 40, 2, 1
    ) RETURNING id INTO v_corrupt_item;
    INSERT INTO public.deliveries (
      delivery_number, order_id, customer_id, scheduled_date, status, created_by
    ) VALUES (
      'E2E-LIFE-CORRUPT-D-' || v_suffix, v_corrupt_order, v_customer,
      current_date, 'scheduled', v_admin
    ) RETURNING id INTO v_corrupt_delivery;
    INSERT INTO public.delivery_items (
      delivery_id, order_item_id, product_id, quantity,
      quantity_delivered, unit_size
    ) VALUES (v_corrupt_delivery, v_corrupt_item, v_product, 1, 2, 'GL');
    UPDATE public.deliveries SET status = 'in_progress' WHERE id = v_corrupt_delivery;
    UPDATE public.deliveries
       SET status = 'completed', completed_at = now(), signed_by = '[E2E] Corrupt Receiver'
     WHERE id = v_corrupt_delivery;

    PERFORM public.cancel_order(
      v_corrupt_order, v_admin, 'e2e-life-corrupt-delivery-' || v_suffix
    );
    RAISE EXCEPTION 'SMOKE_FAIL: over-delivered history was accepted for remainder close';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'ORDER_DELIVERY_QUANTITY_DRIFT:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong corrupt-delivery error: %', v_err;
    END IF;
  END;

  -- A completed delivery may not smuggle a line from another order. The own
  -- line still reconciles exactly, so only the explicit lineage guard catches it.
  BEGIN
    INSERT INTO public.orders (order_number, customer_id, order_date, status)
    VALUES ('E2E-LIFE-LINE-A-' || v_suffix, v_customer, current_date, 'partially_fulfilled')
    RETURNING id INTO v_corrupt_order;
    INSERT INTO public.order_items (
      order_id, product_id, product_name, price_per_unit, cost_per_unit,
      total_units_needed, total_price, profit, net_margin,
      quantity_delivered, quantity_remaining
    ) VALUES (
      v_corrupt_order, v_product, '[E2E] lineage own', 10, 6,
      2, 20, 8, 40, 1, 1
    ) RETURNING id INTO v_corrupt_item;
    INSERT INTO public.orders (order_number, customer_id, order_date, status)
    VALUES ('E2E-LIFE-LINE-B-' || v_suffix, v_customer, current_date, 'confirmed')
    RETURNING id INTO v_foreign_order;
    INSERT INTO public.order_items (
      order_id, product_id, product_name, price_per_unit, cost_per_unit,
      total_units_needed, total_price, profit, net_margin,
      quantity_delivered, quantity_remaining
    ) VALUES (
      v_foreign_order, v_product, '[E2E] lineage foreign', 10, 6,
      1, 10, 4, 40, 0, 1
    ) RETURNING id INTO v_foreign_item;
    INSERT INTO public.deliveries (
      delivery_number, order_id, customer_id, scheduled_date, status, created_by
    ) VALUES (
      'E2E-LIFE-LINE-D-' || v_suffix, v_corrupt_order, v_customer,
      current_date, 'scheduled', v_admin
    ) RETURNING id INTO v_corrupt_delivery;
    INSERT INTO public.delivery_items (
      delivery_id, order_item_id, product_id, quantity, quantity_delivered, unit_size
    ) VALUES (v_corrupt_delivery, v_corrupt_item, v_product, 1, 1, 'GL');
    BEGIN
      INSERT INTO public.delivery_items (
        delivery_id, order_item_id, product_id, quantity, quantity_delivered, unit_size
      ) VALUES (v_corrupt_delivery, v_foreign_item, v_product, 1, 0, 'GL');
      RAISE EXCEPTION 'SMOKE_FAIL: scheduled delivery accepted another order''s item';
    EXCEPTION WHEN OTHERS THEN
      v_err := SQLERRM;
      IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
      IF v_err NOT LIKE 'DELIVERY_ITEM_LINEAGE_INVALID:%' THEN
        RAISE EXCEPTION 'SMOKE_FAIL: wrong scheduled cross-order line error: %', v_err;
      END IF;
    END;
    BEGIN
      INSERT INTO public.delivery_items (
        delivery_id, order_item_id, product_id, quantity, quantity_delivered, unit_size
      ) VALUES (v_corrupt_delivery, v_corrupt_item, v_other_product, 1, 0, 'GL');
      RAISE EXCEPTION 'SMOKE_FAIL: scheduled delivery accepted a mismatched product';
    EXCEPTION WHEN OTHERS THEN
      v_err := SQLERRM;
      IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
      IF v_err NOT LIKE 'DELIVERY_ITEM_LINEAGE_INVALID:%' THEN
        RAISE EXCEPTION 'SMOKE_FAIL: wrong scheduled product-lineage error: %', v_err;
      END IF;
    END;
    -- Seed one historical corrupt row through the narrowly bracketed internal
    -- override so the short-close helper's defense-in-depth check is exercised.
    PERFORM set_config('app.admin_override', 'true', true);
    INSERT INTO public.delivery_items (
      delivery_id, order_item_id, product_id, quantity, quantity_delivered, unit_size
    ) VALUES (v_corrupt_delivery, v_foreign_item, v_product, 1, 0, 'GL');
    PERFORM set_config('app.admin_override', 'false', true);
    UPDATE public.deliveries SET status = 'in_progress' WHERE id = v_corrupt_delivery;
    UPDATE public.deliveries
       SET status = 'completed', completed_at = now(), signed_by = '[E2E] Lineage Receiver'
     WHERE id = v_corrupt_delivery;
    PERFORM public.cancel_order(
      v_corrupt_order, v_admin, 'e2e-life-lineage-' || v_suffix
    );
    RAISE EXCEPTION 'SMOKE_FAIL: cross-order completed delivery line was accepted';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'ORDER_DELIVERY_LINEAGE_INVALID:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong cross-order delivery-line error: %', v_err;
    END IF;
  END;

  -- Historical rows can predate the write-time lineage trigger. A completed
  -- delivery for the right order and item but the wrong customer must still be
  -- rejected by the short-close helper before it changes any money or stock.
  BEGIN
    INSERT INTO public.orders (order_number, customer_id, order_date, status)
    VALUES ('E2E-LIFE-CUSTOMER-' || v_suffix, v_customer, current_date, 'partially_fulfilled')
    RETURNING id INTO v_corrupt_order;
    INSERT INTO public.order_items (
      order_id, product_id, product_name, price_per_unit, cost_per_unit,
      total_units_needed, total_price, profit, net_margin,
      quantity_delivered, quantity_remaining
    ) VALUES (
      v_corrupt_order, v_product, '[E2E] customer lineage', 10, 6,
      2, 20, 8, 40, 1, 1
    ) RETURNING id INTO v_corrupt_item;
    PERFORM set_config('app.admin_override', 'true', true);
    INSERT INTO public.deliveries (
      delivery_number, order_id, customer_id, scheduled_date, status, created_by
    ) VALUES (
      'E2E-LIFE-CUSTOMER-D-' || v_suffix, v_corrupt_order, v_other_customer,
      current_date, 'scheduled', v_admin
    ) RETURNING id INTO v_corrupt_delivery;
    INSERT INTO public.delivery_items (
      delivery_id, order_item_id, product_id, quantity, quantity_delivered, unit_size
    ) VALUES (v_corrupt_delivery, v_corrupt_item, v_product, 1, 1, 'GL');
    UPDATE public.deliveries SET status = 'in_progress' WHERE id = v_corrupt_delivery;
    UPDATE public.deliveries
       SET status = 'completed', completed_at = now(), signed_by = '[E2E] Customer Lineage Receiver'
     WHERE id = v_corrupt_delivery;
    PERFORM set_config('app.admin_override', 'false', true);
    PERFORM public.cancel_order(
      v_corrupt_order, v_admin, 'e2e-life-customer-lineage-' || v_suffix
    );
    RAISE EXCEPTION 'SMOKE_FAIL: completed delivery with another customer was accepted';
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('app.admin_override', 'false', true);
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'ORDER_DELIVERY_LINEAGE_INVALID:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong delivery-customer lineage error: %', v_err;
    END IF;
  END;

  -- booking_draw without a quote is malformed and must fail before any release.
  BEGIN
    INSERT INTO public.orders (
      order_number, customer_id, order_date, status, booking_draw, quote_id
    ) VALUES (
      'E2E-LIFE-NOQUOTE-' || v_suffix, v_customer, current_date,
      'partially_fulfilled', true, NULL
    ) RETURNING id INTO v_corrupt_order;
    INSERT INTO public.order_items (
      order_id, product_id, product_name, price_per_unit, cost_per_unit,
      total_units_needed, total_price, profit, net_margin,
      quantity_delivered, quantity_remaining
    ) VALUES (
      v_corrupt_order, v_product, '[E2E] missing quote line', 10, 6,
      2, 20, 8, 40, 1, 1
    ) RETURNING id INTO v_corrupt_item;
    INSERT INTO public.deliveries (
      delivery_number, order_id, customer_id, scheduled_date, status, created_by
    ) VALUES (
      'E2E-LIFE-NOQUOTE-D-' || v_suffix, v_corrupt_order, v_customer,
      current_date, 'scheduled', v_admin
    ) RETURNING id INTO v_corrupt_delivery;
    INSERT INTO public.delivery_items (
      delivery_id, order_item_id, product_id, quantity, quantity_delivered, unit_size
    ) VALUES (v_corrupt_delivery, v_corrupt_item, v_product, 1, 1, 'GL');
    UPDATE public.deliveries SET status = 'in_progress' WHERE id = v_corrupt_delivery;
    UPDATE public.deliveries
       SET status = 'completed', completed_at = now(), signed_by = '[E2E] No Quote Receiver'
     WHERE id = v_corrupt_delivery;
    PERFORM public.cancel_order(
      v_corrupt_order, v_admin, 'e2e-life-noquote-' || v_suffix
    );
    RAISE EXCEPTION 'SMOKE_FAIL: booking-draw order without a quote was closed';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'BOOKING_DRAW_QUOTE_MISSING:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong missing booking quote error: %', v_err;
    END IF;
  END;

  INSERT INTO public.orders (order_number, customer_id, order_date, status)
  VALUES ('E2E-LIFE-OTHER-' || v_suffix, v_customer, current_date, 'confirmed')
  RETURNING id INTO v_other_order;
  BEGIN
    UPDATE public.orders SET status = 'cancelled' WHERE id = v_other_order;
    RAISE EXCEPTION 'SMOKE_FAIL: direct undelivered-order cancellation bypassed canonical RPC';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'ORDER_TERMINAL_TRANSITION_USE_RPC:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong direct cancellation guard error: %', v_err;
    END IF;
  END;
  BEGIN
    UPDATE public.orders
       SET status = 'cancelled', deleted_at = now()
     WHERE id = v_other_order;
    RAISE EXCEPTION 'SMOKE_FAIL: simultaneous cancel-and-delete bypassed canonical RPC';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err <> 'ORDER_MUST_BE_TERMINAL_BEFORE_DELETE' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong simultaneous cancel-delete error: %', v_err;
    END IF;
  END;
  BEGIN
    PERFORM public.cancel_order(
      v_other_order, v_admin, 'e2e-life-cancel-' || v_suffix
    );
    RAISE EXCEPTION 'SMOKE_FAIL: cancel retry key accepted a different order';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'IDEMPOTENCY_REQUEST_MISMATCH:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong cancel retry mismatch error: %', v_err;
    END IF;
  END;

  INSERT INTO public.invoices (
    invoice_number, customer_id, order_id, invoice_type,
    status, invoice_date, due_date, total_amount_cents, created_by
  ) VALUES (
    'E2E-LIFE-SURVIVE-' || v_suffix, v_customer, v_other_order,
    'chemical_sale', 'draft', current_date, current_date + 30, 0, v_admin
  ) RETURNING id INTO v_surviving_invoice;
  INSERT INTO public.invoice_items (
    invoice_id, product_id, description, quantity,
    unit_price_cents, extended_cents, cost_cents
  ) VALUES (
    v_surviving_invoice, v_product, '[E2E] surviving line', 1,
    1000, 1000, 600
  ) RETURNING id INTO v_terminal_invoice_item;
  UPDATE public.invoices SET status = 'posted' WHERE id = v_surviving_invoice;

  -- The untouched path still delegates to the mature full-cancel behavior.
  v_result := public.cancel_order(
    v_other_order, v_admin, 'e2e-life-full-cancel-' || v_suffix
  );
  IF v_result->>'mode' IS DISTINCT FROM 'full_cancel'
     OR v_result->>'status' IS DISTINCT FROM 'cancelled'
     OR (SELECT status FROM public.orders WHERE id = v_other_order) IS DISTINCT FROM 'cancelled' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: untouched order did not use the full-cancel path: %', v_result;
  END IF;
  v_replay := public.cancel_order(
    v_other_order, v_admin, 'e2e-life-full-cancel-' || v_suffix
  );
  IF v_replay IS DISTINCT FROM v_result THEN
    RAISE EXCEPTION 'SMOKE_FAIL: full-cancel retry did not replay the exact augmented response';
  END IF;
  UPDATE public.invoices
     SET due_date = due_date + 1
   WHERE id = v_surviving_invoice;
  IF (SELECT due_date FROM public.invoices WHERE id = v_surviving_invoice)
       IS DISTINCT FROM current_date + 31 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: safe accounting update on surviving posted invoice was blocked';
  END IF;

  -- Paid commission history must block a partial close before inventory, item,
  -- order, or commission state can change.
  INSERT INTO public.orders (
    order_number, customer_id, order_date, status, booking_draw
  ) VALUES (
    'E2E-LIFE-PAID-' || v_suffix, v_customer, current_date,
    'partially_fulfilled', false
  ) RETURNING id INTO v_blocked_order;
  INSERT INTO public.order_items (
    order_id, product_id, product_name, price_per_unit, cost_per_unit,
    total_units_needed, total_price, profit, net_margin,
    quantity_delivered, quantity_remaining
  ) VALUES (
    v_blocked_order, v_product, '[E2E] paid commission line', 10, 6,
    2, 20, 8, 40, 1, 1
  ) RETURNING id INTO v_blocked_item;
  INSERT INTO public.deliveries (
    delivery_number, order_id, customer_id, scheduled_date, status, created_by
  ) VALUES (
    'E2E-LIFE-BLOCK-D-' || v_suffix, v_blocked_order, v_customer,
    current_date, 'scheduled', v_admin
  ) RETURNING id INTO v_other_delivery;
  INSERT INTO public.delivery_items (
    delivery_id, order_item_id, product_id, quantity,
    quantity_delivered, unit_size
  ) VALUES (v_other_delivery, v_blocked_item, v_product, 1, 1, 'GL');
  UPDATE public.deliveries SET status = 'in_progress' WHERE id = v_other_delivery;
  UPDATE public.deliveries
     SET status = 'completed', completed_at = now(), signed_by = '[E2E] Block Receiver'
   WHERE id = v_other_delivery;

  BEGIN
    UPDATE public.orders SET status = 'cancelled' WHERE id = v_blocked_order;
    RAISE EXCEPTION 'SMOKE_FAIL: partially delivered order bypassed the cancellation guard';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'ORDER_TERMINAL_TRANSITION_USE_RPC:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong partial delivered-order cancellation error: %', v_err;
    END IF;
  END;
  INSERT INTO public.commissions (
    order_id, customer_id, recipient, split_percentage,
    commission_amount, order_profit, order_date, status
  ) VALUES (
    v_blocked_order, v_customer, '[E2E] paid lifecycle rep', 100,
    8, 8, current_date, 'paid'
  ) RETURNING id INTO v_commission;
  BEGIN
    PERFORM public.cancel_order(
      v_blocked_order, v_admin, 'e2e-life-paid-block-' || v_suffix
    );
    RAISE EXCEPTION 'SMOKE_FAIL: partial close changed an order with a paid commission';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err <> 'ORDER_COMMISSIONS_PAID_VOID_BATCH_FIRST' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong paid-commission close error: %', v_err;
    END IF;
  END;
  IF (SELECT status FROM public.orders WHERE id = v_blocked_order) IS DISTINCT FROM 'partially_fulfilled'
     OR (SELECT total_units_needed FROM public.order_items WHERE id = v_blocked_item) IS DISTINCT FROM 2::numeric
     OR (SELECT quantity_remaining FROM public.order_items WHERE id = v_blocked_item) IS DISTINCT FROM 1::numeric
     OR (SELECT status FROM public.commissions WHERE order_id = v_blocked_order AND deleted_at IS NULL) IS DISTINCT FROM 'paid'
     OR (SELECT quantity_prebooked FROM public.inventory
          WHERE product_id = v_product AND location = 'Main Warehouse') IS DISTINCT FROM 0::numeric THEN
    RAISE EXCEPTION 'SMOKE_FAIL: paid-commission rejection leaked a state change';
  END IF;

  UPDATE public.commissions
     SET status = 'pending'
   WHERE id = v_commission;
  INSERT INTO public.commission_payments (
    payment_number, recipient_id, total_amount, status, created_by
  ) VALUES (
    'E2E-LIFE-CP-' || v_suffix, v_admin, 8, 'unposted', v_admin
  ) RETURNING id INTO v_commission_payment;
  INSERT INTO public.commission_payment_items (
    commission_payment_id, commission_id, amount
  ) VALUES (v_commission_payment, v_commission, 8);
  BEGIN
    PERFORM public.cancel_order(
      v_blocked_order, v_admin, 'e2e-life-batch-block-' || v_suffix
    );
    RAISE EXCEPTION 'SMOKE_FAIL: partial close changed an order with a batched commission';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err <> 'ORDER_HAS_BATCHED_COMMISSIONS' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong batched-commission close error: %', v_err;
    END IF;
  END;
  IF (SELECT status FROM public.orders WHERE id = v_blocked_order) IS DISTINCT FROM 'partially_fulfilled'
     OR (SELECT status FROM public.commissions WHERE id = v_commission) IS DISTINCT FROM 'pending' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: batched-commission rejection leaked a state change';
  END IF;

  -- A booking draw must never clamp a deficient draw ledger to zero after
  -- writing a larger release. The whole short-close must roll back instead.
  INSERT INTO public.quotes (
    quote_number, customer_id, created_by, status, commission_split
  ) VALUES (
    'E2E-LIFE-DRAW-Q-' || v_suffix, v_customer, v_admin,
    'accepted', '{"splits": []}'::jsonb
  ) RETURNING id INTO v_draw_quote;
  INSERT INTO public.quote_product_draws (quote_id, product_id, quantity_drawn)
  VALUES (v_draw_quote, v_product, 0.5);
  INSERT INTO public.orders (
    order_number, customer_id, quote_id, order_date, status, booking_draw
  ) VALUES (
    'E2E-LIFE-DRAW-O-' || v_suffix, v_customer, v_draw_quote,
    current_date, 'partially_fulfilled', true
  ) RETURNING id INTO v_draw_order;
  INSERT INTO public.order_items (
    order_id, product_id, product_name, price_per_unit, cost_per_unit,
    total_units_needed, total_price, profit, net_margin,
    quantity_delivered, quantity_remaining
  ) VALUES (
    v_draw_order, v_product, '[E2E] draw underflow line', 10, 6,
    2, 20, 8, 40, 1, 1
  ) RETURNING id INTO v_draw_item;
  INSERT INTO public.deliveries (
    delivery_number, order_id, customer_id, scheduled_date, status, created_by
  ) VALUES (
    'E2E-LIFE-DRAW-D-' || v_suffix, v_draw_order, v_customer,
    current_date, 'scheduled', v_admin
  ) RETURNING id INTO v_draw_delivery;
  INSERT INTO public.delivery_items (
    delivery_id, order_item_id, product_id, quantity,
    quantity_delivered, unit_size
  ) VALUES (v_draw_delivery, v_draw_item, v_product, 1, 1, 'GL');
  UPDATE public.deliveries SET status = 'in_progress' WHERE id = v_draw_delivery;
  UPDATE public.deliveries
     SET status = 'completed', completed_at = now(), signed_by = '[E2E] Draw Receiver'
   WHERE id = v_draw_delivery;
  UPDATE public.inventory
     SET quantity_prebooked = 1
   WHERE product_id = v_product AND location = 'Main Warehouse';
  BEGIN
    PERFORM public.cancel_order(
      v_draw_order, v_admin, 'e2e-life-draw-underflow-' || v_suffix
    );
    RAISE EXCEPTION 'SMOKE_FAIL: booking-draw underflow was clamped and committed';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'QUOTE_DRAW_UNDERFLOW:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong booking-draw underflow error: %', v_err;
    END IF;
  END;
  IF (SELECT status FROM public.orders WHERE id = v_draw_order) IS DISTINCT FROM 'partially_fulfilled'
     OR (SELECT quantity_prebooked FROM public.inventory
          WHERE product_id = v_product AND location = 'Main Warehouse') IS DISTINCT FROM 1::numeric
     OR (SELECT quantity_drawn FROM public.quote_product_draws
          WHERE quote_id = v_draw_quote AND product_id = v_product) IS DISTINCT FROM 0.5::numeric
     OR EXISTS (
       SELECT 1 FROM public.inventory_transactions
        WHERE order_id = v_draw_order AND transaction_type = 'released'
     ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: booking-draw underflow leaked a state change';
  END IF;

  BEGIN
    UPDATE public.orders SET status = 'cancelled' WHERE id = v_order;
    RAISE EXCEPTION 'SMOKE_FAIL: direct delivered-order cancellation bypassed the trigger';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'ORDER_TERMINAL_TRANSITION_USE_RPC:%'
       AND v_err NOT LIKE 'Invalid order status transition:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong delivered-order cancellation error: %', v_err;
    END IF;
  END;

  -- A fulfilled short-close remains live, so the canonical completed-delivery
  -- recovery writer can create the delivered invoice without an exception table.
  v_result := public.create_invoice_for_unbilled_delivery(
    v_delivery, v_admin, 'e2e-life-backfill-' || v_suffix
  );
  v_invoice_id := NULLIF(v_result->>'invoice_id', '')::uuid;
  IF v_invoice_id IS NULL
     OR (SELECT status FROM public.invoices WHERE id = v_invoice_id) IS DISTINCT FROM 'draft'
     OR (SELECT total_amount_cents FROM public.invoices WHERE id = v_invoice_id) IS DISTINCT FROM 4000::bigint THEN
    RAISE EXCEPTION 'SMOKE_FAIL: delivered invoice recovery failed after short-close: %', v_result;
  END IF;
  v_replay := public.create_invoice_for_unbilled_delivery(
    v_delivery, v_admin, 'e2e-life-backfill-' || v_suffix
  );
  IF v_replay IS DISTINCT FROM v_result THEN
    RAISE EXCEPTION 'SMOKE_FAIL: identical delivery-backfill retry did not replay exact response';
  END IF;
  BEGIN
    PERFORM public.create_invoice_for_unbilled_delivery(
      v_other_delivery, v_admin, 'e2e-life-backfill-' || v_suffix
    );
    RAISE EXCEPTION 'SMOKE_FAIL: delivery-backfill retry key accepted a different delivery';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'IDEMPOTENCY_ARGUMENT_MISMATCH:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong delivery-backfill mismatch error: %', v_err;
    END IF;
  END;

  -- Existing production history includes completed unbilled deliveries whose
  -- otherwise fulfilled parent orders were soft-deleted. Only the canonical
  -- writer/poster may recover that exact delivered quantity; no capability may
  -- remain after either wrapper returns.
  INSERT INTO public.orders (
    order_number, customer_id, order_date, status, booking_draw, deleted_at
  ) VALUES (
    'E2E-LIFE-DELETED-' || v_suffix, v_customer, current_date,
    'fulfilled', false, now()
  ) RETURNING id INTO v_deleted_order;
  INSERT INTO public.order_items (
    order_id, product_id, product_name, price_per_unit, cost_per_unit,
    total_units_needed, total_price, profit, net_margin,
    quantity_delivered, quantity_remaining
  ) VALUES (
    v_deleted_order, v_product, '[E2E] deleted recovery line', 10, 6,
    2, 20, 8, 40, 2, 0
  ) RETURNING id INTO v_deleted_item;
  INSERT INTO public.deliveries (
    delivery_number, order_id, customer_id, scheduled_date,
    status, completed_at, signed_by, created_by
  ) VALUES (
    'E2E-LIFE-DELETED-D-' || v_suffix, v_deleted_order, v_customer,
    current_date, 'scheduled', NULL, NULL, v_admin
  ) RETURNING id INTO v_deleted_delivery;
  INSERT INTO public.delivery_items (
    delivery_id, order_item_id, product_id, quantity, quantity_delivered, unit_size
  ) VALUES (v_deleted_delivery, v_deleted_item, v_product, 2, 2, 'GL');
  UPDATE public.deliveries SET status = 'in_progress'
   WHERE id = v_deleted_delivery;
  UPDATE public.deliveries
     SET status = 'completed', completed_at = now(), signed_by = '[E2E] Historical Receiver'
   WHERE id = v_deleted_delivery;

  -- The trusted writer must reject corrupt historical quantity even if a
  -- privileged test fixture bypasses the normal completed-delivery immutability
  -- trigger. The subtransaction rolls the synthetic corruption back. Hosted
  -- live smoke roles cannot change session_replication_role, so this privileged
  -- corruption probe runs only in the disposable superuser proof.
  IF v_can_bypass_triggers THEN
  BEGIN
    PERFORM set_config('session_replication_role', 'replica', true);
    UPDATE public.delivery_items
       SET quantity_delivered = quantity + 1
     WHERE delivery_id = v_deleted_delivery;
    PERFORM set_config('session_replication_role', 'origin', true);
    PERFORM public.create_invoice_for_unbilled_delivery(
      v_deleted_delivery, v_admin, 'e2e-life-deleted-corrupt-write-' || v_suffix
    );
    RAISE EXCEPTION 'SMOKE_FAIL: deleted delivery recovery writer accepted over-delivered history';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    PERFORM set_config('session_replication_role', 'origin', true);
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'DELETED_DELIVERY_RECOVERY_ITEMS_INVALID:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong corrupt recovery writer error: %', v_err;
    END IF;
  END;
  END IF;

  v_result := public.create_invoice_for_unbilled_delivery(
    v_deleted_delivery, v_admin, 'e2e-life-deleted-recovery-' || v_suffix
  );
  v_deleted_recovery_invoice := NULLIF(v_result->>'invoice_id', '')::uuid;
  IF v_deleted_recovery_invoice IS NULL
     OR (SELECT status FROM public.invoices WHERE id = v_deleted_recovery_invoice)
       IS DISTINCT FROM 'draft'
     OR (SELECT total_amount_cents FROM public.invoices WHERE id = v_deleted_recovery_invoice)
       IS DISTINCT FROM 2000::bigint
     OR EXISTS (
       SELECT 1 FROM public.invoice_delivery_recovery_capabilities
        WHERE transaction_id = txid_current()
     ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: deleted fulfilled delivery recovery draft/capability state is wrong: %', v_result;
  END IF;

  BEGIN
    UPDATE public.orders SET customer_id = v_other_customer
     WHERE id = v_deleted_order;
    RAISE EXCEPTION 'SMOKE_FAIL: order customer changed after recovery provenance existed';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'ORDER_CUSTOMER_LINEAGE_LOCKED:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong order-customer lineage error: %', v_err;
    END IF;
  END;
  IF v_can_bypass_triggers THEN
  BEGIN
    PERFORM set_config('session_replication_role', 'replica', true);
    UPDATE public.orders SET customer_id = v_other_customer
     WHERE id = v_deleted_order;
    PERFORM set_config('session_replication_role', 'origin', true);
    PERFORM public.post_invoice(
      v_deleted_recovery_invoice,
      'e2e-life-post-customer-drift-' || v_suffix
    );
    RAISE EXCEPTION 'SMOKE_FAIL: recovery poster accepted order/customer drift';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    PERFORM set_config('session_replication_role', 'origin', true);
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'DELETED_DELIVERY_RECOVERY_CUSTOMER_LINEAGE_INVALID:%'
       AND v_err NOT LIKE 'INVOICE_ORDER_CUSTOMER_LINEAGE_INVALID:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong recovery customer-drift error: %', v_err;
    END IF;
  END;
  END IF;

  IF v_can_bypass_triggers THEN
  BEGIN
    PERFORM set_config('session_replication_role', 'replica', true);
    UPDATE public.delivery_items
       SET quantity_delivered = quantity + 1
     WHERE delivery_id = v_deleted_delivery;
    PERFORM set_config('session_replication_role', 'origin', true);
    PERFORM public.post_invoice(
      v_deleted_recovery_invoice,
      'e2e-life-post-corrupt-deleted-recovery-' || v_suffix
    );
    RAISE EXCEPTION 'SMOKE_FAIL: recovery poster accepted over-delivered history';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    PERFORM set_config('session_replication_role', 'origin', true);
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'DELETED_DELIVERY_RECOVERY_ITEMS_INVALID:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong corrupt recovery poster error: %', v_err;
    END IF;
  END;
  END IF;

  BEGIN
    PERFORM public.delete_invoices(
      ARRAY[v_deleted_recovery_invoice], v_admin,
      'e2e-life-delete-recovery-' || v_suffix
    );
    PERFORM public.post_invoice(
      v_deleted_recovery_invoice,
      'e2e-life-post-deleted-draft-' || v_suffix
    );
    RAISE EXCEPTION 'SMOKE_FAIL: soft-deleted recovery draft was posted';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'INVOICE_DELETED:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong soft-deleted recovery post error: %', v_err;
    END IF;
  END;
  IF (SELECT deleted_at FROM public.invoices WHERE id = v_deleted_recovery_invoice) IS NOT NULL
     OR (SELECT status FROM public.invoices WHERE id = v_deleted_recovery_invoice)
       IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: rejected soft-delete/post subtransaction leaked invoice state';
  END IF;

  PERFORM public.post_invoice(
    v_deleted_recovery_invoice,
    'e2e-life-post-deleted-recovery-' || v_suffix
  );
  IF (SELECT status FROM public.invoices WHERE id = v_deleted_recovery_invoice)
       IS DISTINCT FROM 'posted'
     OR EXISTS (
       SELECT 1 FROM public.invoice_delivery_recovery_capabilities
        WHERE transaction_id = txid_current()
     ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: deleted fulfilled delivery recovery posting/capability cleanup failed';
  END IF;
  BEGIN
    UPDATE public.invoice_items
       SET description = description || ' forbidden direct edit'
     WHERE invoice_id = v_deleted_recovery_invoice;
    RAISE EXCEPTION 'SMOKE_FAIL: deleted-order recovery invoice items remained directly editable';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'ORDER_INVOICE_TERMINAL:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong deleted recovery item guard error: %', v_err;
    END IF;
  END;

  -- Reversed write-offs remain historical rows but must not appear as active
  -- customer credits in transaction review.
  INSERT INTO public.write_offs (
    invoice_id, customer_id, amount_cents, reason,
    approved_by, created_by, reversed_at, reversed_reason, reversed_by
  ) VALUES (
    v_invoice_id, v_customer, 250,
    '[E2E] reversed lifecycle write-off',
    v_admin, v_admin, now(), '[E2E] reversed for proof', v_admin
  );
  SELECT count(*) INTO v_count
    FROM public.get_customer_transaction_review(
      v_customer, current_date, current_date
    )
   WHERE transaction_type = 'Write-Off';
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: reversed write-off leaked into transaction review';
  END IF;

  BEGIN
    DELETE FROM public.invoice_items WHERE id = v_terminal_invoice_item;
    RAISE EXCEPTION 'SMOKE_FAIL: terminal-order invoice line was deleted directly';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'ORDER_INVOICE_TERMINAL:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong terminal invoice-line delete error: %', v_err;
    END IF;
  END;
  BEGIN
    UPDATE public.invoice_items
       SET invoice_id = v_invoice_id
     WHERE id = v_terminal_invoice_item;
    RAISE EXCEPTION 'SMOKE_FAIL: terminal-order invoice line moved to another invoice';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'INVOICE_ITEM_LINEAGE_IMMUTABLE:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong invoice-line move error: %', v_err;
    END IF;
  END;
  BEGIN
    UPDATE public.invoice_items
       SET description = '[E2E] forbidden terminal edit'
     WHERE id = v_terminal_invoice_item;
    RAISE EXCEPTION 'SMOKE_FAIL: terminal-order invoice line was edited';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'ORDER_INVOICE_TERMINAL:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong terminal invoice-line update error: %', v_err;
    END IF;
  END;
  BEGIN
    INSERT INTO public.invoice_items (
      invoice_id, product_id, description, quantity,
      unit_price_cents, extended_cents, cost_cents
    ) VALUES (
      v_surviving_invoice, v_product, '[E2E] forbidden terminal insert', 1,
      100, 100, 50
    );
    RAISE EXCEPTION 'SMOKE_FAIL: terminal-order invoice line was inserted';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'ORDER_INVOICE_TERMINAL:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong terminal invoice-line insert error: %', v_err;
    END IF;
  END;
  IF NOT EXISTS (
    SELECT 1 FROM public.invoice_items
     WHERE id = v_terminal_invoice_item AND invoice_id = v_surviving_invoice
  ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: rejected terminal invoice-line changes leaked state';
  END IF;

  -- The cleanup override is not a general bypass: it cannot delete a line
  -- from a surviving posted invoice. Only a terminal invoice may use it.
  PERFORM set_config('app.admin_override', 'true', true);
  BEGIN
    DELETE FROM public.invoice_items WHERE id = v_terminal_invoice_item;
    RAISE EXCEPTION 'SMOKE_FAIL: admin override deleted a line from a posted invoice';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'ORDER_INVOICE_TERMINAL:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong posted-invoice override error: %', v_err;
    END IF;
  END;
  PERFORM set_config('app.admin_override', 'false', true);

  UPDATE public.invoices
     SET status = 'voided'
   WHERE id = v_surviving_invoice;
  PERFORM set_config('app.admin_override', 'true', true);
  DELETE FROM public.invoice_items WHERE id = v_terminal_invoice_item;
  PERFORM set_config('app.admin_override', 'false', true);
  IF EXISTS (SELECT 1 FROM public.invoice_items WHERE id = v_terminal_invoice_item)
     OR COALESCE(current_setting('app.admin_override', true), 'false') = 'true' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: terminal invoice cleanup or override reset failed';
  END IF;

  -- The same invoice cannot be moved onto a terminal order, and new invoice
  -- lines cannot be inserted for a terminal-order invoice.
  BEGIN
    INSERT INTO public.invoices (
      invoice_number, customer_id, order_id, invoice_type,
      status, invoice_date, total_amount_cents, created_by
    ) VALUES (
      'E2E-LIFE-TERM-' || v_suffix, v_customer, v_other_order,
      'chemical_sale', 'draft', current_date, 0, v_admin
    );
    RAISE EXCEPTION 'SMOKE_FAIL: invoice attached to terminal order';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'ORDER_INVOICE_TERMINAL:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong terminal invoice error: %', v_err;
    END IF;
  END;

  -- Real table privilege proof: authenticated keeps SELECT, while neither a
  -- browser role nor the service role can bypass governed RPCs by mutating
  -- invoice headers, lines, or append-only financial evidence directly.
  IF NOT has_table_privilege('authenticated', 'public.invoices', 'SELECT')
     OR has_table_privilege('authenticated', 'public.invoices', 'INSERT')
     OR has_table_privilege('authenticated', 'public.invoices', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.invoices', 'DELETE')
     OR has_table_privilege('authenticated', 'public.invoice_items', 'INSERT')
     OR has_table_privilege('authenticated', 'public.invoice_items', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.invoice_items', 'DELETE')
     OR has_table_privilege('authenticated', 'public.invoice_items', 'TRUNCATE')
     OR has_table_privilege('service_role', 'public.invoices', 'INSERT')
     OR has_table_privilege('service_role', 'public.invoices', 'UPDATE')
     OR has_table_privilege('service_role', 'public.invoices', 'DELETE')
     OR has_table_privilege('service_role', 'public.invoices', 'TRUNCATE')
     OR has_table_privilege('service_role', 'public.invoice_items', 'INSERT')
     OR has_table_privilege('service_role', 'public.invoice_items', 'UPDATE')
     OR has_table_privilege('service_role', 'public.invoice_items', 'DELETE')
     OR has_table_privilege('service_role', 'public.invoice_items', 'TRUNCATE')
     OR has_table_privilege('authenticated', 'public.financial_audit_log', 'INSERT')
     OR has_table_privilege('authenticated', 'public.financial_audit_log', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.financial_audit_log', 'DELETE')
     OR has_table_privilege('authenticated', 'public.financial_audit_log', 'TRUNCATE')
     OR has_table_privilege('service_role', 'public.financial_audit_log', 'INSERT')
     OR has_table_privilege('service_role', 'public.financial_audit_log', 'UPDATE')
     OR has_table_privilege('service_role', 'public.financial_audit_log', 'DELETE')
     OR has_table_privilege('service_role', 'public.financial_audit_log', 'TRUNCATE') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: invoice table privilege contract is wrong';
  END IF;

  BEGIN
    SET LOCAL ROLE authenticated;
    INSERT INTO public.invoices (
      invoice_number, customer_id, invoice_type, status,
      invoice_date, total_amount_cents, created_by
    ) VALUES (
      'E2E-LIFE-DML-' || v_suffix, v_customer,
      'misc_charge', 'draft', current_date, 0, v_admin
    );
    RESET ROLE;
    RAISE EXCEPTION 'SMOKE_FAIL: authenticated direct invoice insert succeeded';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    RESET ROLE;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'permission denied for table invoices%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong direct invoice DML error: %', v_err;
    END IF;
  END;

  BEGIN
    SET LOCAL ROLE service_role;
    INSERT INTO public.invoices (
      invoice_number, customer_id, invoice_type, status,
      invoice_date, total_amount_cents, created_by
    ) VALUES (
      'E2E-LIFE-SERVICE-DML-' || v_suffix, v_customer,
      'misc_charge', 'draft', current_date, 0, v_admin
    );
    RESET ROLE;
    RAISE EXCEPTION 'SMOKE_FAIL: service-role direct invoice insert succeeded';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    RESET ROLE;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'permission denied for table invoices%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong service-role invoice DML error: %', v_err;
    END IF;
  END;

  BEGIN
    SET LOCAL ROLE service_role;
    INSERT INTO public.financial_audit_log (
      operation_type, entity_type, entity_id, actor_role, description
    ) VALUES (
      'invoice_voided', 'invoice', v_invoice_id, 'admin',
      '[E2E] direct financial audit insert must be denied'
    );
    RESET ROLE;
    RAISE EXCEPTION 'SMOKE_FAIL: service-role direct financial audit insert succeeded';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    RESET ROLE;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'permission denied for table financial_audit_log%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong service-role audit DML error: %', v_err;
    END IF;
  END;

  SELECT count(*) INTO v_count
    FROM public.inventory_transactions
   WHERE order_id = v_order AND transaction_type = 'released';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: expected one inventory release ledger row, got %', v_count;
  END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END;
$smoke$;
