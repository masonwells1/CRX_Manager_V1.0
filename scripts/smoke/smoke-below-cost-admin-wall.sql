-- Full rollback-only proof for 20260810180002_enforce_below_cost_admin_approval.
-- Run only after that migration exists in the current transaction/database.
-- The common trigger is reached through real create_direct_order,
-- update_order_items, create_rush_order, price_order, and save_invoice calls;
-- catalog checks prove the same wrapper is present on bulk_import_order and
-- save_quote. The terminal exception rolls back every synthetic row.
-- Product fixtures bypass the unrelated supplier-pricing write guard exactly
-- as the established split-order rollback harness does. This disable is inside
-- the same explicit transaction, so the terminal exception rolls it back too.
BEGIN;
ALTER TABLE public.products DISABLE TRIGGER USER;

DO $$
DECLARE
  v_sfx text := substr(md5(gen_random_uuid()::text), 1, 8);
  v_admin uuid;
  v_sales uuid;
  v_customer uuid;
  v_product_a uuid;
  v_product_b uuid;
  v_order_id uuid;
  v_rush_order_id uuid;
  v_order_item_id uuid;
  v_delivery_id uuid;
  v_delivery_item_id uuid;
  v_invoice_id uuid;
  v_misc_invoice_id uuid;
  v_invoice_item_id uuid;
  v_result jsonb;
  v_cost numeric;
  v_cost_cents bigint;
  v_total numeric;
  v_profit numeric;
  v_audit_count integer;
  v_audit_before integer;
  v_quantity numeric;
  v_status text;
  v_name text;
  v_role text;
  v_table text;
  v_privilege text;
BEGIN
  SELECT id INTO v_admin FROM public.profiles
  WHERE role = 'admin' AND is_active = true ORDER BY id LIMIT 1;
  SELECT id INTO v_sales FROM public.profiles
  WHERE role = 'sales_rep' AND is_active = true ORDER BY id LIMIT 1;
  IF v_admin IS NULL THEN RAISE EXCEPTION 'SMOKE_SETUP: no active admin'; END IF;
  IF v_sales IS NULL THEN RAISE EXCEPTION 'SMOKE_SETUP: no active sales rep'; END IF;

  INSERT INTO public.customers (farm_name, assigned_sales_rep)
  VALUES ('[SMOKE] Below Cost ' || v_sfx, v_sales)
  RETURNING id INTO v_customer;

  INSERT INTO public.products (product_name, current_cost)
  VALUES ('[SMOKE] Below Cost A ' || v_sfx, 10.00)
  RETURNING id INTO v_product_a;
  INSERT INTO public.products (product_name, current_cost)
  VALUES ('[SMOKE] Below Cost B ' || v_sfx, 12.00)
  RETURNING id INTO v_product_b;

  INSERT INTO public.inventory (
    product_id, location, quantity_available, quantity_prebooked,
    quantity_on_order, unit_size
  ) VALUES
    (v_product_a, 'Main Warehouse', 1000, 0, 0, 'gal'),
    (v_product_b, 'Main Warehouse', 1000, 0, 0, 'gal');

  -- A sales rep cannot convert a browser reason into authority.
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_sales, 'role', 'authenticated')::text,
    true
  );
  PERFORM set_config('request.jwt.claim.sub', v_sales::text, true);
  BEGIN
    PERFORM public.create_direct_order(
      p_customer_id := v_customer,
      p_order_date := CURRENT_DATE,
      p_notes := 'Below-cost approved: sales rep must not authorize',
      p_items := jsonb_build_array(jsonb_build_object(
        'product_id', v_product_a,
        'product_name', '[SMOKE] Below Cost A ' || v_sfx,
        'quantity', 2,
        'price_per_unit', 9,
        'unit_cost', 0.01,
        'unit_size', 'gal'
      )),
      p_performed_by := v_sales,
      p_idempotency_key := 'smoke-below-rep-' || v_sfx
    );
    RAISE EXCEPTION 'SMOKE_FAIL: sales rep below-cost order committed';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'BELOW_COST_ADMIN_REQUIRED:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: expected admin-required denial, got %', SQLERRM;
    END IF;
  END;

  -- A null-product line is not a free bypass. save_invoice accepts caller cost
  -- for classified fees/miscellaneous lines, so positive stored cost must be
  -- compared with stored total revenue even though no catalog Product exists.
  v_misc_invoice_id := public.save_invoice(
    jsonb_build_object(
      'customer_id', v_customer,
      'invoice_type', 'misc_charge',
      'status', 'draft',
      'invoice_date', CURRENT_DATE,
      'salesman_id', v_sales
    ),
    jsonb_build_array(jsonb_build_object(
      'product_id', NULL,
      'description', '[SMOKE] Zero Cost Application Fee ' || v_sfx,
      'quantity', 1,
      'unit_price_cents', 900,
      'extended_cents', 900,
      'cost_cents', 0,
      'is_application_fee', true
    )),
    'smoke-zero-cost-invoice-rep-' || v_sfx
  );
  SELECT count(*) INTO v_audit_count
  FROM public.below_cost_approvals
  WHERE entity_type = 'invoice' AND entity_id = v_misc_invoice_id;
  IF v_audit_count <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: zero-cost non-product fee wrote an approval';
  END IF;

  BEGIN
    PERFORM public.save_invoice(
      jsonb_build_object(
        'customer_id', v_customer,
        'invoice_type', 'misc_charge',
        'status', 'draft',
        'invoice_date', CURRENT_DATE,
        'salesman_id', v_sales
      ),
      jsonb_build_array(jsonb_build_object(
        'product_id', NULL,
        'description', '[SMOKE] Below Cost Application Fee ' || v_sfx,
        'quantity', 1,
        'unit_price_cents', 900,
        'extended_cents', 900,
        'cost_cents', 1000,
        'is_application_fee', true,
        'notes', 'Below-cost approved: sales rep cannot approve null product'
      )),
      'smoke-below-invoice-rep-' || v_sfx
    );
    RAISE EXCEPTION 'SMOKE_FAIL: sales rep null-product below-cost invoice committed';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'BELOW_COST_ADMIN_REQUIRED:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: expected null-product admin denial, got %', SQLERRM;
    END IF;
  END;

  -- An admin is still denied when the same money write has no fresh reason.
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text,
    true
  );
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  BEGIN
    PERFORM public.save_invoice(
      jsonb_build_object(
        'customer_id', v_customer,
        'invoice_type', 'misc_charge',
        'status', 'draft',
        'invoice_date', CURRENT_DATE,
        'salesman_id', v_sales
      ),
      jsonb_build_array(jsonb_build_object(
        'product_id', NULL,
        'description', '[SMOKE] Below Cost Application Fee ' || v_sfx,
        'quantity', 1,
        'unit_price_cents', 900,
        'extended_cents', 900,
        'cost_cents', 1000,
        'is_application_fee', true
      )),
      'smoke-below-invoice-noreason-' || v_sfx
    );
    RAISE EXCEPTION 'SMOKE_FAIL: reasonless null-product below-cost invoice committed';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'BELOW_COST_REASON_REQUIRED:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: expected null-product reason denial, got %', SQLERRM;
    END IF;
  END;

  v_misc_invoice_id := public.save_invoice(
    jsonb_build_object(
      'customer_id', v_customer,
      'invoice_type', 'misc_charge',
      'status', 'draft',
      'invoice_date', CURRENT_DATE,
      'salesman_id', v_sales
    ),
    jsonb_build_array(jsonb_build_object(
      'product_id', NULL,
      'description', '[SMOKE] Below Cost Application Fee ' || v_sfx,
      'quantity', 1,
      'unit_price_cents', 900,
      'extended_cents', 900,
      'cost_cents', 1000,
      'is_application_fee', true,
      'notes', 'Below-cost approved: null product invoice approval'
    )),
    'smoke-below-invoice-admin-' || v_sfx
  );
  SELECT count(*) INTO v_audit_count
  FROM public.below_cost_approvals
  WHERE operation = 'save_invoice'
    AND entity_type = 'invoice'
    AND entity_id = v_misc_invoice_id
    AND product_id IS NULL
    AND actor_user_id = v_admin
    AND reason = 'null product invoice approval'
    AND unit_price_cents = 900
    AND locked_unit_cost_cents = 1000
    AND total_shortfall_cents = 100;
  IF v_audit_count <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: expected one null-product invoice approval, got %', v_audit_count;
  END IF;

  BEGIN
    PERFORM public.create_direct_order(
      p_customer_id := v_customer,
      p_order_date := CURRENT_DATE,
      p_items := jsonb_build_array(jsonb_build_object(
        'product_id', v_product_a,
        'product_name', '[SMOKE] Below Cost A ' || v_sfx,
        'quantity', 2,
        'price_per_unit', 9,
        'unit_cost', 0.01,
        'unit_size', 'gal'
      )),
      p_performed_by := v_admin,
      p_idempotency_key := 'smoke-below-noreason-' || v_sfx
    );
    RAISE EXCEPTION 'SMOKE_FAIL: reasonless admin below-cost order committed';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'BELOW_COST_REASON_REQUIRED:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: expected reason-required denial, got %', SQLERRM;
    END IF;
  END;

  -- Admin + fresh reason succeeds, ignores the forged browser cost, and writes
  -- one immutable audit row atomically with the order.
  SELECT public.create_direct_order(
    p_customer_id := v_customer,
    p_order_date := CURRENT_DATE,
    p_notes := 'Below-cost approved: rollback smoke approved',
    p_items := jsonb_build_array(jsonb_build_object(
      'product_id', v_product_a,
      'product_name', '[SMOKE] Below Cost A ' || v_sfx,
      'quantity', 2,
      'price_per_unit', 9,
      'unit_cost', 0.01,
      'unit_size', 'gal'
    )),
    p_performed_by := v_admin,
    p_idempotency_key := 'smoke-below-admin-' || v_sfx
  ) INTO v_result;
  v_order_id := (v_result->>'order_id')::uuid;
  SELECT id, cost_per_unit, cost_at_time_cents
    INTO v_order_item_id, v_cost, v_cost_cents
  FROM public.order_items WHERE order_id = v_order_id;
  IF v_cost <> 10 OR v_cost_cents <> 1000 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: create_direct_order trusted caller cost (cost %, cents %)', v_cost, v_cost_cents;
  END IF;
  SELECT count(*) INTO v_audit_count
  FROM public.below_cost_approvals
  WHERE operation = 'create_direct_order'
    AND entity_id = v_order_id
    AND actor_user_id = v_admin
    AND reason = 'rollback smoke approved';
  IF v_audit_count <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: expected one atomic create approval, got %', v_audit_count;
  END IF;

  BEGIN
    UPDATE public.below_cost_approvals
    SET reason = 'tampered'
    WHERE entity_id = v_order_id;
    RAISE EXCEPTION 'SMOKE_FAIL: approval audit was mutable';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'BELOW_COST_APPROVAL_IMMUTABLE%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: expected immutable audit denial, got %', SQLERRM;
    END IF;
  END;

  -- A fractional-cent unit price must fail before cent comparison. Otherwise
  -- 9.999 and a 10.00 cost both round to 1000 cents while a large quantity can
  -- still create a material unapproved loss.
  BEGIN
    PERFORM public.update_order_items(
      p_order_id := v_order_id,
      p_items := jsonb_build_array(jsonb_build_object(
        'id', v_order_item_id,
        'product_id', v_product_b,
        'product_name', '[SMOKE] Below Cost B ' || v_sfx,
        'price_per_unit', 11.111,
        'cost_per_unit', 0.01,
        'total_units_needed', 2.345,
        'unit_size', 'gal',
        'below_cost_reason', 'fractional price must still be rejected'
      )),
      p_performed_by := v_admin,
      p_idempotency_key := 'smoke-below-fractional-' || v_sfx
    );
    RAISE EXCEPTION 'SMOKE_FAIL: fractional-cent unit price committed';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'INVALID_UNIT_PRICE_CENTS' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: expected fractional-cent denial, got %', SQLERRM;
    END IF;
  END;

  -- update_order_items must resolve a product swap cost on the server and use
  -- that one locked value for snapshot and profit math.
  SELECT public.update_order_items(
    p_order_id := v_order_id,
    p_items := jsonb_build_array(jsonb_build_object(
      'id', v_order_item_id,
      'product_id', v_product_b,
      'product_name', '[SMOKE] Below Cost B ' || v_sfx,
      'price_per_unit', 11.11,
      'cost_per_unit', 0.01,
      'total_units_needed', 2.345,
      'unit_size', 'gal',
      'below_cost_reason', 'product swap rollback approval'
    )),
    p_performed_by := v_admin,
    p_idempotency_key := 'smoke-below-update-' || v_sfx
  ) INTO v_result;
  SELECT cost_per_unit, cost_at_time_cents, total_price, profit
    INTO v_cost, v_cost_cents, v_total, v_profit
  FROM public.order_items WHERE id = v_order_item_id;
  IF v_cost <> 12 OR v_cost_cents <> 1200 OR v_total <> 26.05 OR v_profit <> -2.09 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: product swap cents disagreed (cost %, cents %, total %, profit %)',
      v_cost, v_cost_cents, v_total, v_profit;
  END IF;
  SELECT count(*) INTO v_audit_count
  FROM public.below_cost_approvals
  WHERE operation = 'update_order_items'
    AND line_id = v_order_item_id
    AND reason = 'product swap rollback approval';
  IF v_audit_count <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: update_order_items atomic approval count %', v_audit_count;
  END IF;

  -- The approval belongs to the pricing decision, not every later bookkeeping
  -- write. Exercise the real delivery RPC against the approved below-cost line
  -- with no fresh below-cost context. It updates quantity_delivered and
  -- quantity_remaining only and must not demand or manufacture another approval.
  PERFORM set_config('app.crx_below_cost_operation', '', true);
  PERFORM set_config('app.crx_below_cost_reason', '', true);
  SELECT count(*) INTO v_audit_before
  FROM public.below_cost_approvals WHERE line_id = v_order_item_id;

  INSERT INTO public.deliveries (
    delivery_number, order_id, customer_id, scheduled_date, status, created_by
  ) VALUES (
    '[SMOKE] BELOW-COST-DELIVERY-' || v_sfx,
    v_order_id, v_customer, CURRENT_DATE, 'scheduled', v_admin
  ) RETURNING id INTO v_delivery_id;
  INSERT INTO public.delivery_items (
    delivery_id, order_item_id, product_id, quantity, quantity_delivered, unit_size
  ) VALUES (
    v_delivery_id, v_order_item_id, v_product_b, 1, 0, 'gal'
  ) RETURNING id INTO v_delivery_item_id;
  UPDATE public.deliveries SET status = 'in_progress' WHERE id = v_delivery_id;

  SELECT public.complete_delivery(
    p_delivery_id := v_delivery_id,
    p_signed_by := 'Below Cost Lifecycle Smoke',
    p_performed_by := v_admin,
    p_quantities := jsonb_build_object(v_delivery_item_id::text, 1),
    p_idempotency_key := 'smoke-below-delivery-' || v_sfx,
    p_completed_at := clock_timestamp()
  ) INTO v_result;
  SELECT quantity_delivered, status
    INTO v_quantity, v_status
  FROM public.order_items oi
  JOIN public.orders o ON o.id = oi.order_id
  WHERE oi.id = v_order_item_id;
  IF v_quantity <> 1 OR v_status <> 'partially_fulfilled' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: approved below-cost delivery lifecycle failed (qty %, status %)',
      v_quantity, v_status;
  END IF;
  SELECT count(*) INTO v_audit_count
  FROM public.below_cost_approvals WHERE line_id = v_order_item_id;
  IF v_audit_count <> v_audit_before THEN
    RAISE EXCEPTION 'SMOKE_FAIL: delivery bookkeeping wrote a fresh approval (% -> %)',
      v_audit_before, v_audit_count;
  END IF;

  -- The delivery RPC also materializes a draft invoice from the governed order
  -- line. That exact lineage insert must be usable without a second approval.
  -- Partial-delivery adjustment and tote copy likewise reduce exposure or touch
  -- bookkeeping only, while a later quantity increase still fails closed.
  SELECT ii.invoice_id, ii.id
    INTO v_invoice_id, v_invoice_item_id
  FROM public.invoice_items ii
  JOIN public.invoices i ON i.id = ii.invoice_id
  WHERE i.order_id = v_order_id
    AND ii.order_item_id = v_order_item_id
  ORDER BY ii.created_at, ii.id
  LIMIT 1;
  IF v_invoice_item_id IS NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL: delivery did not materialize governed invoice lineage';
  END IF;
  SELECT count(*) INTO v_audit_before
  FROM public.below_cost_approvals
  WHERE entity_type = 'invoice' AND entity_id = v_invoice_id;
  IF v_audit_before <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: lifecycle-derived invoice duplicated approval, got %', v_audit_before;
  END IF;

  PERFORM set_config('app.crx_below_cost_operation', '', true);
  PERFORM set_config('app.crx_below_cost_reason', '', true);
  UPDATE public.invoice_items
  SET tote_number = 'SMOKE-TOTE', updated_at = clock_timestamp()
  WHERE id = v_invoice_item_id;
  UPDATE public.invoice_items
  SET quantity = 0.5, extended_cents = 556
  WHERE id = v_invoice_item_id;
  SELECT count(*) INTO v_audit_count
  FROM public.below_cost_approvals
  WHERE entity_type = 'invoice' AND entity_id = v_invoice_id;
  IF v_audit_count <> v_audit_before THEN
    RAISE EXCEPTION 'SMOKE_FAIL: invoice lifecycle wrote a fresh approval (% -> %)',
      v_audit_before, v_audit_count;
  END IF;
  BEGIN
    UPDATE public.invoice_items
    SET quantity = 2, extended_cents = 2222
    WHERE id = v_invoice_item_id;
    RAISE EXCEPTION 'SMOKE_FAIL: context-free invoice exposure increase committed';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'BELOW_COST_CONTEXT_REQUIRED:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: expected invoice context denial, got %', SQLERRM;
    END IF;
  END;

  -- price_order is the other path that previously committed before a
  -- best-effort browser log. Its reason now travels in the RPC payload and the
  -- same transaction stores the approval.
  SELECT public.create_rush_order(
    p_customer_id := v_customer,
    p_items := jsonb_build_array(jsonb_build_object(
      'product_id', v_product_a,
      'qty', 2
    )),
    p_notes := '[SMOKE] price later',
    p_performed_by := v_admin,
    p_idempotency_key := 'smoke-below-rush-' || v_sfx
  ) INTO v_result;
  v_rush_order_id := (v_result->>'order_id')::uuid;
  SELECT id INTO v_order_item_id
  FROM public.order_items WHERE order_id = v_rush_order_id;

  SELECT public.price_order(
    p_order_id := v_rush_order_id,
    p_items := jsonb_build_array(jsonb_build_object(
      'order_item_id', v_order_item_id,
      'price', 9,
      'below_cost_reason', 'price-order rollback approval'
    )),
    p_performed_by := v_admin,
    p_idempotency_key := 'smoke-below-price-' || v_sfx
  ) INTO v_result;
  SELECT cost_per_unit, cost_at_time_cents
    INTO v_cost, v_cost_cents
  FROM public.order_items WHERE id = v_order_item_id;
  IF v_cost <> 10 OR v_cost_cents <> 1000 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: price_order did not use locked current cost';
  END IF;
  SELECT count(*) INTO v_audit_count
  FROM public.below_cost_approvals
  WHERE operation = 'price_order'
    AND line_id = v_order_item_id
    AND reason = 'price-order rollback approval';
  IF v_audit_count <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: price_order atomic approval count %', v_audit_count;
  END IF;

  -- The real cancel path zeroes quantity_remaining after delegating to the
  -- mature cancellation implementation. That fulfillment-only update must not
  -- re-open an already-approved pricing decision.
  PERFORM set_config('app.crx_below_cost_operation', '', true);
  PERFORM set_config('app.crx_below_cost_reason', '', true);
  SELECT public.cancel_order(
    v_rush_order_id, v_admin, 'smoke-below-cancel-' || v_sfx
  ) INTO v_result;
  SELECT o.status, oi.quantity_remaining
    INTO v_status, v_quantity
  FROM public.orders o
  JOIN public.order_items oi ON oi.order_id = o.id
  WHERE o.id = v_rush_order_id;
  IF v_status <> 'cancelled' OR v_quantity <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: approved below-cost cancellation failed (status %, remaining %)',
      v_status, v_quantity;
  END IF;

  -- All seven public RPCs must have one SECURITY DEFINER overload routed
  -- through the same context setter; this is the shared choke point proven by
  -- the real calls above.
  FOREACH v_name IN ARRAY ARRAY[
    'create_direct_order', 'create_rush_order', 'bulk_import_order',
    'update_order_items', 'price_order', 'save_invoice', 'save_quote'
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p
      WHERE p.pronamespace = 'public'::regnamespace
        AND p.proname = v_name
        AND p.prosecdef = true
        AND position('_begin_below_cost_money_write' in p.prosrc) > 0
    ) THEN
      RAISE EXCEPTION 'SMOKE_FAIL: % does not route through the server wall', v_name;
    END IF;
  END LOOP;

  -- The server wall is only complete if PostgREST callers cannot skip every
  -- governed RPC and write the line collections directly.
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role']
  LOOP
    FOREACH v_table IN ARRAY ARRAY['order_items', 'invoice_items', 'quote_items']
    LOOP
      FOREACH v_privilege IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE']
      LOOP
        IF has_table_privilege(v_role, 'public.' || v_table, v_privilege) THEN
          RAISE EXCEPTION 'SMOKE_FAIL: %.% retains % for %',
            'public', v_table, v_privilege, v_role;
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END $$;
