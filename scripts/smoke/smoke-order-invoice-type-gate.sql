-- Post-apply rollback-only chain for 20261006200000_refuse_field_invoice_through_order_rpcs
-- (CRX-LIFE-001): the order pipeline may create only chemical_sale or misc_charge invoices.
--
-- FAIL-FIRST CONTRACT: against the pre-fix wrapper the sales rep's field_application call
-- SUCCEEDS (an order-backed field invoice) and this chain raises SMOKE_FAIL. Against the
-- fix every disallowed type is ORDER_INVOICE_TYPE_NOT_ALLOWED (SQLSTATE 23514) with nothing
-- written, a reused key cannot replay past the gate, the table refuses an order-backed
-- field_application row from the owner, and the ordinary chemical_sale (with its exact
-- replay) and misc_charge paths still work. The split engine's field_application refusal is
-- in smoke-backfill-refuse-split-billing.sql, which already builds an allocated order.
--
-- Fixtures: [E2E]-marked customer and orders; an existing priced product is borrowed (order
-- lines need a cost basis, and product prices may only be written through the governed
-- pricing path). One DO block, terminal exception -> nothing commits.
DO $smoke$
DECLARE
  v_suffix text := substr(md5(random()::text), 1, 8);
  v_admin uuid;
  v_rep uuid;
  v_customer uuid;
  v_product uuid;
  v_order uuid;
  v_misc_order uuid;
  v_invoice uuid;
  v_replay uuid;
  v_type text;
  v_key text;
  v_i integer;
  v_err text;
  v_state text;
  v_constraint text;
BEGIN
  SELECT id INTO v_admin
    FROM public.profiles
   WHERE role = 'admin' AND is_active = true
   ORDER BY created_at
   LIMIT 1;
  IF v_admin IS NULL THEN RAISE EXCEPTION 'SMOKE_SETUP: active admin required'; END IF;
  SELECT id INTO v_rep
    FROM public.profiles
   WHERE role = 'sales_rep' AND is_active = true
   ORDER BY created_at
   LIMIT 1;
  IF v_rep IS NULL THEN
    v_rep := gen_random_uuid();
    INSERT INTO auth.users (id, email, created_at, updated_at)
    VALUES (v_rep, 'smoke-rep-' || v_suffix || '@example.invalid', now(), now());
    INSERT INTO public.profiles (id, email, full_name, role, is_active)
    VALUES (v_rep, 'smoke-rep-' || v_suffix || '@example.invalid', '[SMOKE] Sales Rep', 'sales_rep', true);
  END IF;
  SELECT id INTO v_product
    FROM public.products
   WHERE current_cost > 0
     AND current_cost = round(current_cost, 2)
     AND current_cost < 1000
   ORDER BY created_at
   LIMIT 1;
  IF v_product IS NULL THEN RAISE EXCEPTION 'SMOKE_SETUP: a product with a positive whole-cent cost is required'; END IF;

  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);

  INSERT INTO public.customers (farm_name)
  VALUES ('[E2E] Order Type Farm ' || v_suffix) RETURNING id INTO v_customer;
  INSERT INTO public.orders (order_number, customer_id, order_date, status, booking_draw)
  VALUES ('E2E-ORDER-TYPE-' || v_suffix, v_customer, current_date, 'confirmed', false)
  RETURNING id INTO v_order;
  INSERT INTO public.order_items (
    order_id, product_id, product_name, price_per_unit, cost_per_unit,
    total_units_needed, total_price, profit, net_margin,
    quantity_delivered, quantity_remaining
  ) VALUES (
    v_order, v_product, '[E2E] order type line', 1000, 999,
    1, 1000, 1, 0.1, 0, 1
  );
  INSERT INTO public.orders (order_number, customer_id, order_date, status, booking_draw)
  VALUES ('E2E-ORDER-TYPE-MISC-' || v_suffix, v_customer, current_date, 'confirmed', false)
  RETURNING id INTO v_misc_order;
  INSERT INTO public.order_items (
    order_id, product_id, product_name, price_per_unit, cost_per_unit,
    total_units_needed, total_price, profit, net_margin,
    quantity_delivered, quantity_remaining
  ) VALUES (
    v_misc_order, v_product, '[E2E] order type misc line', 1000, 999,
    1, 1000, 1, 0.1, 0, 1
  );

  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_rep, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_rep::text, true);

  -- 0. The wrapper's existing key requirement is unchanged and still comes first.
  FOR v_i IN 1..4 LOOP
    v_type := (ARRAY['chemical_sale', 'chemical_sale', 'field_application', 'field_application'])[v_i];
    v_key := (ARRAY[NULL, '   ', NULL, '   '])[v_i];
    BEGIN
      PERFORM public.create_invoice_from_order(v_order, NULL, v_type, v_key);
      RAISE EXCEPTION 'SMOKE_FAIL: create_invoice_from_order accepted a % idempotency key (%)',
        COALESCE(NULLIF(v_key, '   '), 'blank'), v_type;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT, v_state = RETURNED_SQLSTATE;
      IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
      IF v_err NOT LIKE 'IDEMPOTENCY_KEY_REQUIRED:%' OR v_state <> '22023' THEN
        RAISE EXCEPTION 'SMOKE_FAIL: wrong missing-key refusal for % (SQLSTATE %): %', v_type, v_state, v_err;
      END IF;
    END;
  END LOOP;

  -- 1. A sales rep asking for field_application, credit_memo or no type is refused.
  FOREACH v_type IN ARRAY ARRAY['field_application', 'credit_memo', NULL]::text[] LOOP
    BEGIN
      PERFORM public.create_invoice_from_order(
        v_order, NULL, v_type, 'e2e-order-type-' || COALESCE(v_type, 'null') || '-' || v_suffix
      );
      RAISE EXCEPTION 'SMOKE_FAIL: a sales rep created a % invoice from an order',
        COALESCE(v_type, 'NULL-typed');
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT, v_state = RETURNED_SQLSTATE;
      IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
      IF v_err NOT LIKE 'ORDER_INVOICE_TYPE_NOT_ALLOWED:%' OR v_state <> '23514' THEN
        RAISE EXCEPTION 'SMOKE_FAIL: wrong rep order-invoice type refusal for % (SQLSTATE %): %',
          COALESCE(v_type, 'NULL'), v_state, v_err;
      END IF;
    END;
  END LOOP;

  -- 2. The rep's ordinary order invoice still works, and its key replays exactly.
  v_invoice := public.create_invoice_from_order(
    v_order, NULL, 'chemical_sale', 'e2e-order-type-chemical-' || v_suffix
  );
  v_replay := public.create_invoice_from_order(
    v_order, NULL, 'chemical_sale', 'e2e-order-type-chemical-' || v_suffix
  );
  IF v_replay IS DISTINCT FROM v_invoice THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the chemical_sale key did not replay its exact invoice';
  END IF;
  -- The type gate runs before the replay lookup: the same key cannot be reused to
  -- reach the idempotency layer with a disallowed type.
  BEGIN
    PERFORM public.create_invoice_from_order(
      v_order, NULL, 'field_application', 'e2e-order-type-chemical-' || v_suffix
    );
    RAISE EXCEPTION 'SMOKE_FAIL: a reused chemical_sale key accepted field_application';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT, v_state = RETURNED_SQLSTATE;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'ORDER_INVOICE_TYPE_NOT_ALLOWED:%' OR v_state <> '23514' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong reused-key type refusal (SQLSTATE %): %', v_state, v_err;
    END IF;
  END;

  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  IF (SELECT count(*) FROM public.invoices WHERE order_id = v_order) <> 1
     OR (SELECT invoice_type || '|' || created_by::text FROM public.invoices WHERE id = v_invoice)
          IS DISTINCT FROM 'chemical_sale|' || v_rep::text THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the order should carry exactly the rep''s one chemical_sale invoice';
  END IF;

  -- 3. An admin is refused too, and an admin's misc_charge still works.
  BEGIN
    PERFORM public.create_invoice_from_order(
      v_misc_order, v_admin, 'field_application', 'e2e-order-type-admin-field-' || v_suffix
    );
    RAISE EXCEPTION 'SMOKE_FAIL: an admin created a field_application invoice from an order';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT, v_state = RETURNED_SQLSTATE;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'ORDER_INVOICE_TYPE_NOT_ALLOWED:%' OR v_state <> '23514' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong admin order-invoice type refusal (SQLSTATE %): %', v_state, v_err;
    END IF;
  END;
  v_invoice := public.create_invoice_from_order(
    v_misc_order, v_admin, 'misc_charge', 'e2e-order-type-admin-misc-' || v_suffix
  );
  IF (SELECT invoice_type FROM public.invoices WHERE id = v_invoice) IS DISTINCT FROM 'misc_charge' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: an admin''s misc_charge order invoice was not created';
  END IF;

  -- 4. The table CHECK refuses an order-backed field_application row from any writer
  --    (this chain runs as the owner, like every SECURITY DEFINER creator).
  BEGIN
    INSERT INTO public.invoices (
      invoice_number, order_id, customer_id, invoice_type, status,
      invoice_date, due_date, total_amount_cents, created_by
    ) VALUES (
      'E2E-ORDER-TYPE-DIRECT-' || v_suffix, v_order, v_customer,
      'field_application', 'draft', current_date, current_date + 30, 0, v_admin
    );
    RAISE EXCEPTION 'SMOKE_FAIL: invoices accepted an order-backed field_application row';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT, v_state = RETURNED_SQLSTATE,
                            v_constraint = CONSTRAINT_NAME;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_state <> '23514' OR v_constraint IS DISTINCT FROM 'invoices_field_application_has_no_order' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong order-backed field invoice refusal (SQLSTATE %, constraint %): %',
        v_state, v_constraint, v_err;
    END IF;
  END;
  IF EXISTS (SELECT 1 FROM public.invoices
              WHERE order_id IN (v_order, v_misc_order) AND invoice_type = 'field_application') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: an order-backed field_application invoice exists after the refusals';
  END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END;
$smoke$;
