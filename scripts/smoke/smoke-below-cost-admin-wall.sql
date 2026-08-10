-- Full rollback-only proof for 20260810180002_enforce_below_cost_admin_approval.
-- Run only after that migration exists in the current transaction/database.
-- The common trigger is reached through real create_direct_order,
-- update_order_items, create_rush_order, and price_order calls; catalog checks
-- prove the same wrapper is present on bulk_import_order, save_invoice, and
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
  v_result jsonb;
  v_cost numeric;
  v_cost_cents bigint;
  v_total numeric;
  v_profit numeric;
  v_audit_count integer;
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

  -- An admin is still denied when the same money write has no fresh reason.
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text,
    true
  );
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

  -- update_order_items must resolve a product swap cost on the server and use
  -- that one locked value for snapshot and profit math.
  SELECT public.update_order_items(
    p_order_id := v_order_id,
    p_items := jsonb_build_array(jsonb_build_object(
      'id', v_order_item_id,
      'product_id', v_product_b,
      'product_name', '[SMOKE] Below Cost B ' || v_sfx,
      'price_per_unit', 11.111,
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
  IF v_cost <> 12 OR v_cost_cents <> 1200 OR v_total <> 26.06 OR v_profit <> -2.08 THEN
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
