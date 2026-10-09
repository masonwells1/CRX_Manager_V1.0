-- Rollback-only chain for 20261008120000_scope_order_invoices_to_rep (rep scoping for order
-- invoices, Mason 2026-10-06): a sales rep bills only customers assigned to them and only
-- under their own name; admins are unrestricted.
--
-- CONTAINER ONLY: it plants [E2E] users, customers, orders and fields, draws invoice numbers on
-- its allowed steps, and builds a delivery. Run it through
-- scripts/smoke/prove-order-invoice-rep-scope-real-schema.mjs, never against the live database.
--
-- FAIL-FIRST CONTRACT: against the pre-fix wrappers a sales rep's create_invoice_from_order on
-- another rep's customer SUCCEEDS and this chain raises its step-1 SMOKE_FAIL. Against the fix,
-- steps 1-7 refuse with NO invoice number drawn and nothing left behind; steps 8-9 (the rep's
-- own customer, with exact replay) still work; a replay after the customer is reassigned is
-- re-scoped by the pre-check (10); admins are unrestricted (11); and a rep completing the last
-- delivery of another rep's allocated order still completes it, with the auto-split falling
-- back to flag-and-notify instead of billing that customer (12), because the split wrapper
-- refuses that exact call with CUSTOMER_SCOPE_DENIED.
--
-- What this chain can and cannot show: each refused call runs in its own subtransaction, so
-- anything it wrote is rolled back before the "nothing left behind" check reads it - that
-- check cannot fail. The sequence counter is the real evidence ("no number drawn"). That the
-- checks run before any idempotency claim or order lock is proven by the prover's held-lock
-- step (prove-order-invoice-rep-scope-real-schema.mjs), not here.
--
-- Step 5b is the rep's own order with its line allocated to a field owned by another rep's
-- customer (no billing defaults), so only the split pre-check's fields.customer_id branch can
-- refuse it before a number is drawn; step 5 is refused only by its field_billing_defaults
-- branch.
-- Step 5a (another rep's single-owner allocated order) runs before step 5 (the rep's order with
-- a 50/50 landlord split): a mixed-owner split cannot create invoices for anyone today, because
-- trg_guard_invoice_terminal_order refuses an order invoice whose customer is not the order's
-- (INVOICE_ORDER_CUSTOMER_LINEAGE_INVALID, pre-existing - see KNOWN_ISSUES), so step 5a is the
-- step that shows a rep billing another rep's customer through the split engine.
--
-- For each refusal the invoice-number check runs before the error-text check, so a body that
-- refuses for the right reason but only after drawing a number fails on the number.
-- Every SMOKE_FAIL names its step, so the prover can tell which check caught a mutation.
-- One DO block, terminal exception -> nothing commits.
DO $smoke$
DECLARE
  v_suffix text := substr(md5(random()::text), 1, 8);
  v_today date := (now() AT TIME ZONE 'America/Chicago')::date;  -- the business date
  v_admin uuid;
  v_rep_a uuid;
  v_rep_b uuid;
  v_c_a uuid;
  v_c_b uuid;
  v_c_u uuid;
  v_product uuid;
  v_pricing jsonb;
  v_o_a uuid;
  v_o_a_other uuid;
  v_o_b uuid;
  v_o_u uuid;
  v_s_mixed uuid;
  v_s_own uuid;
  v_s_b uuid;
  v_s_deliver uuid;
  v_s_field_b uuid;
  v_f_mixed uuid;
  v_f_own uuid;
  v_f_b uuid;
  v_item uuid;
  v_delivery uuid;
  v_invoice uuid;
  v_replay uuid;
  v_ids uuid[];
  v_replay_ids uuid[];
  v_i integer;
  v_label text;
  v_kind text;
  v_order uuid;
  v_salesman uuid;
  v_type text;
  v_expect text;
  v_key text;
  v_seq_before text;
  v_seq_after text;
  v_err text;
  v_state text;
  v_result jsonb;
  v_count integer;
BEGIN
  SELECT id INTO v_admin
    FROM public.profiles
   WHERE role = 'admin' AND is_active = true
   ORDER BY created_at, id
   LIMIT 1;
  IF v_admin IS NULL THEN RAISE EXCEPTION 'SMOKE_SETUP: active admin required'; END IF;
  SELECT id INTO v_rep_a
    FROM public.profiles
   WHERE role = 'sales_rep' AND is_active = true
   ORDER BY created_at, id
   LIMIT 1;
  SELECT id INTO v_rep_b
    FROM public.profiles
   WHERE role = 'sales_rep' AND is_active = true
   ORDER BY created_at, id
   OFFSET 1 LIMIT 1;
  IF v_rep_a IS NULL THEN
    v_rep_a := gen_random_uuid();
    INSERT INTO auth.users (id, email, created_at, updated_at)
    VALUES (v_rep_a, 'e2e-rep-a-' || v_suffix || '@example.invalid', now(), now());
    INSERT INTO public.profiles (id, email, full_name, role, is_active)
    VALUES (v_rep_a, 'e2e-rep-a-' || v_suffix || '@example.invalid', '[E2E] Rep A', 'sales_rep', true);
  END IF;
  IF v_rep_b IS NULL THEN
    v_rep_b := gen_random_uuid();
    INSERT INTO auth.users (id, email, created_at, updated_at)
    VALUES (v_rep_b, 'e2e-rep-b-' || v_suffix || '@example.invalid', now(), now());
    INSERT INTO public.profiles (id, email, full_name, role, is_active)
    VALUES (v_rep_b, 'e2e-rep-b-' || v_suffix || '@example.invalid', '[E2E] Rep B', 'sales_rep', true);
  END IF;

  -- The "no number drawn" checks read the invoice-number sequences directly. With a session
  -- cache above 1 a draw could hide inside an already-cached block, so require CACHE 1.
  IF (SELECT count(*) FROM pg_sequences
       WHERE schemaname = 'public'
         AND sequencename IN ('invoice_number_seq', 'cs_invoice_number_seq',
                              'mc_invoice_number_seq', 'cm_invoice_number_seq')
         AND cache_size = 1) <> 4 THEN
    RAISE EXCEPTION 'SMOKE_SETUP: the four invoice-number sequences must exist with CACHE 1';
  END IF;

  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);

  -- Order lines need a positive cost basis (COST_BASIS_REQUIRED), and a product is born
  -- pricing-free, so price a fresh shell through the governed preview/apply path the app
  -- uses (the smoke-order-invoice-type-gate.sql pattern).
  INSERT INTO public.products (product_name, unit_size)
  VALUES ('[E2E] Rep Scope Product ' || v_suffix, 'GL') RETURNING id INTO v_product;
  v_pricing := public.preview_product_pricing_changes(
    'product_page',
    NULL,
    jsonb_build_array(jsonb_build_object(
      'product_id', v_product, 'row_version', 1, 'pricing_mode', 'price_driven',
      'new_cost', '5.00', 'tier1_price', '10.00', 'tier2_price', '10.00', 'tier3_price', '10.00'
    )),
    v_admin,
    'e2e-rep-scope-pricing-preview-' || v_suffix
  );
  IF v_pricing->>'status' IS DISTINCT FROM 'previewed'
     OR (v_pricing->>'apply_allowed')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'SMOKE_SETUP: governed product pricing preview failed: %', v_pricing;
  END IF;
  PERFORM public.apply_product_pricing_change_set(
    (v_pricing->>'change_set_id')::uuid,
    v_pricing->>'request_fingerprint',
    v_admin,
    'e2e-rep-scope-pricing-apply-' || v_suffix
  );
  IF (SELECT current_cost FROM public.products WHERE id = v_product) IS DISTINCT FROM 5.00::numeric THEN
    RAISE EXCEPTION 'SMOKE_SETUP: governed product pricing apply did not price the product';
  END IF;

  -- Customers: rep A's, rep B's, and an unassigned one.
  INSERT INTO public.customers (farm_name, assigned_sales_rep)
  VALUES ('[E2E] Rep Scope Farm A ' || v_suffix, v_rep_a) RETURNING id INTO v_c_a;
  INSERT INTO public.customers (farm_name, assigned_sales_rep)
  VALUES ('[E2E] Rep Scope Farm B ' || v_suffix, v_rep_b) RETURNING id INTO v_c_b;
  INSERT INTO public.customers (farm_name, assigned_sales_rep)
  VALUES ('[E2E] Rep Scope Farm U ' || v_suffix, NULL) RETURNING id INTO v_c_u;

  -- Fields: C_A's with a 50/50 C_A / C_B billing split, C_A's alone, and C_B's alone. The
  -- split-sum constraint trigger is deferred, so both split rows go in before it is checked.
  INSERT INTO public.fields (customer_id, field_name, crop_type, total_acres)
  VALUES (v_c_a, '[E2E] Rep Scope Mixed Field ' || v_suffix, 'corn', 100) RETURNING id INTO v_f_mixed;
  INSERT INTO public.field_billing_defaults (field_id, customer_id, split_pct, is_primary)
  VALUES (v_f_mixed, v_c_a, 50, true), (v_f_mixed, v_c_b, 50, false);
  INSERT INTO public.fields (customer_id, field_name, crop_type, total_acres)
  VALUES (v_c_a, '[E2E] Rep Scope Own Field ' || v_suffix, 'corn', 100) RETURNING id INTO v_f_own;
  INSERT INTO public.fields (customer_id, field_name, crop_type, total_acres)
  VALUES (v_c_b, '[E2E] Rep Scope Rep B Field ' || v_suffix, 'corn', 100) RETURNING id INTO v_f_b;

  -- Orders: O_A (C_A, no salesman), O_Aother (C_A, salesman B), O_B (C_B), O_U (C_U), and the
  -- allocated S_mixed (C_A, mixed field), S_own (C_A, own field), S_b (C_B, C_B's field) and
  -- S_deliver (C_B, C_B's field, with an in-progress delivery of every unit), and S_field_b
  -- (C_A, C_B's field). No salesman on any order except O_Aother.
  FOR v_i IN 1..9 LOOP
    INSERT INTO public.orders (order_number, customer_id, order_date, status, booking_draw, salesman_id)
    VALUES (
      'E2E-REP-SCOPE-' || v_i || '-' || v_suffix,
      (ARRAY[v_c_a, v_c_a, v_c_b, v_c_u, v_c_a, v_c_a, v_c_b, v_c_b, v_c_a])[v_i],
      v_today, 'confirmed', false,
      (ARRAY[NULL, v_rep_b, NULL, NULL, NULL, NULL, NULL, NULL, NULL]::uuid[])[v_i]
    ) RETURNING id INTO v_order;
    INSERT INTO public.order_items (
      order_id, product_id, product_name, price_per_unit, cost_per_unit,
      total_units_needed, total_price, profit, net_margin,
      quantity_delivered, quantity_remaining, unit_size
    ) VALUES (
      v_order, v_product, '[E2E] rep scope line ' || v_i, 10, 5,
      10, 100, 50, 50, 0, 10, 'GL'
    ) RETURNING id INTO v_item;
    CASE v_i
      WHEN 1 THEN v_o_a := v_order;
      WHEN 2 THEN v_o_a_other := v_order;
      WHEN 3 THEN v_o_b := v_order;
      WHEN 4 THEN v_o_u := v_order;
      WHEN 5 THEN
        v_s_mixed := v_order;
        INSERT INTO public.order_item_field_allocations (order_item_id, field_id, acres)
        VALUES (v_item, v_f_mixed, 10);
      WHEN 6 THEN
        v_s_own := v_order;
        INSERT INTO public.order_item_field_allocations (order_item_id, field_id, acres)
        VALUES (v_item, v_f_own, 10);
      WHEN 7 THEN
        v_s_b := v_order;
        INSERT INTO public.order_item_field_allocations (order_item_id, field_id, acres)
        VALUES (v_item, v_f_b, 10);
      WHEN 8 THEN
        v_s_deliver := v_order;
        INSERT INTO public.order_item_field_allocations (order_item_id, field_id, acres)
        VALUES (v_item, v_f_b, 10);
        -- Built while 'scheduled' (delivery_items lock once it leaves 'scheduled'), then
        -- moved to in_progress so complete_delivery can finish it.
        INSERT INTO public.deliveries (
          delivery_number, order_id, customer_id, assigned_driver, scheduled_date, status, created_by
        ) VALUES (
          'E2E-REP-SCOPE-DEL-' || v_suffix, v_order, v_c_b, NULL, v_today, 'scheduled', v_admin
        ) RETURNING id INTO v_delivery;
        INSERT INTO public.delivery_items (
          delivery_id, order_item_id, product_id, quantity, quantity_delivered, unit_size
        ) VALUES (v_delivery, v_item, v_product, 10, 0, 'GL');
        UPDATE public.deliveries SET status = 'in_progress' WHERE id = v_delivery;
      ELSE
        v_s_field_b := v_order;
        INSERT INTO public.order_item_field_allocations (order_item_id, field_id, acres)
        VALUES (v_item, v_f_b, 10);
    END CASE;
  END LOOP;

  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_rep_a, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_rep_a::text, true);

  -- Steps 1-7, as rep A: each is refused with no invoice number drawn and nothing left behind.
  FOR v_i IN 1..9 LOOP
    v_label := (ARRAY['1', '2', '3', '4', '5a', '5', '5b', '6', '7'])[v_i];
    v_kind := (ARRAY['cifo', 'cifo', 'cifo', 'cifo', 'split', 'split', 'split', 'split', 'split'])[v_i];
    v_order := (ARRAY[v_o_b, v_o_u, v_o_a, v_o_a_other, v_s_b, v_s_mixed, v_s_field_b, v_s_own, v_s_own])[v_i];
    v_salesman := (ARRAY[NULL, NULL, v_rep_b, NULL, v_rep_a, v_rep_a, NULL, v_rep_b, v_rep_a]::uuid[])[v_i];
    v_type := (ARRAY['chemical_sale', 'chemical_sale', 'chemical_sale', 'chemical_sale', 'chemical_sale',
                     'chemical_sale', 'chemical_sale', 'chemical_sale', 'field_application'])[v_i];
    v_expect := (ARRAY['CUSTOMER_SCOPE_DENIED', 'CUSTOMER_SCOPE_DENIED', 'SALESMAN_SCOPE_DENIED',
                       'SALESMAN_SCOPE_DENIED', 'CUSTOMER_SCOPE_DENIED', 'CUSTOMER_SCOPE_DENIED',
                       'CUSTOMER_SCOPE_DENIED', 'SALESMAN_SCOPE_DENIED', 'ORDER_INVOICE_TYPE_NOT_ALLOWED'])[v_i];
    v_key := 'e2e-rep-scope-step-' || v_label || '-' || v_suffix;
    SELECT string_agg(sequencename || '=' || COALESCE(last_value::text, 'none'), ',' ORDER BY sequencename)
      INTO v_seq_before
      FROM pg_sequences
     WHERE schemaname = 'public'
       AND sequencename IN ('invoice_number_seq', 'cs_invoice_number_seq',
                            'mc_invoice_number_seq', 'cm_invoice_number_seq');
    v_err := NULL;
    v_state := NULL;
    BEGIN
      IF v_kind = 'cifo' THEN
        PERFORM public.create_invoice_from_order(v_order, v_salesman, v_type, v_key);
      ELSE
        PERFORM public.create_split_invoices_from_order(v_order, v_salesman, v_type, v_key);
      END IF;
      RAISE EXCEPTION 'SMOKE_FAIL: step %: a sales rep created an order invoice the scope rule forbids (expected %)',
        v_label, v_expect;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT, v_state = RETURNED_SQLSTATE;
      IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    END;
    SELECT string_agg(sequencename || '=' || COALESCE(last_value::text, 'none'), ',' ORDER BY sequencename)
      INTO v_seq_after
      FROM pg_sequences
     WHERE schemaname = 'public'
       AND sequencename IN ('invoice_number_seq', 'cs_invoice_number_seq',
                            'mc_invoice_number_seq', 'cm_invoice_number_seq');
    IF v_seq_after IS DISTINCT FROM v_seq_before THEN
      RAISE EXCEPTION 'SMOKE_FAIL: step %: a refused call drew an invoice number (% -> %): %',
        v_label, v_seq_before, v_seq_after, v_err;
    END IF;
    IF (v_expect = 'ORDER_INVOICE_TYPE_NOT_ALLOWED'
          AND (v_err NOT LIKE 'ORDER_INVOICE_TYPE_NOT_ALLOWED:%' OR v_state <> '23514'))
       OR (v_expect <> 'ORDER_INVOICE_TYPE_NOT_ALLOWED'
          AND (v_err IS DISTINCT FROM v_expect OR v_state <> 'P0001')) THEN
      RAISE EXCEPTION 'SMOKE_FAIL: step %: wrong refusal, expected % (SQLSTATE %): %',
        v_label, v_expect, v_state, v_err;
    END IF;
    IF EXISTS (SELECT 1 FROM public.invoices WHERE order_id = v_order)
       OR EXISTS (SELECT 1 FROM public.idempotency_keys WHERE idempotency_key = v_key)
       OR EXISTS (SELECT 1 FROM public.split_invoice_creation_claims WHERE order_id = v_order) THEN
      RAISE EXCEPTION 'SMOKE_FAIL: step %: a refused call left an invoice, key or creation claim behind', v_label;
    END IF;
  END LOOP;

  -- 8. The rep's own customer, no salesman on the order: allowed, and the key replays exactly.
  v_invoice := public.create_invoice_from_order(v_o_a, NULL, 'chemical_sale', 'e2e-rep-scope-step-8-' || v_suffix);
  v_replay := public.create_invoice_from_order(v_o_a, NULL, 'chemical_sale', 'e2e-rep-scope-step-8-' || v_suffix);
  IF v_replay IS DISTINCT FROM v_invoice THEN
    RAISE EXCEPTION 'SMOKE_FAIL: step 8: the rep''s own order invoice did not replay exactly';
  END IF;
  IF (SELECT customer_id::text || '|' || COALESCE(salesman_id::text, 'none') || '|' || created_by::text
        FROM public.invoices WHERE id = v_invoice)
       IS DISTINCT FROM v_c_a::text || '|none|' || v_rep_a::text
     OR (SELECT count(*) FROM public.invoices WHERE order_id = v_o_a) <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: step 8: the rep''s own order invoice has the wrong customer, salesman or creator';
  END IF;

  -- 9. The rep's own allocated order, named salesman = the rep: allowed, exact replay.
  v_ids := public.create_split_invoices_from_order(v_s_own, v_rep_a, 'chemical_sale', 'e2e-rep-scope-step-9-' || v_suffix);
  v_replay_ids := public.create_split_invoices_from_order(v_s_own, v_rep_a, 'chemical_sale', 'e2e-rep-scope-step-9-' || v_suffix);
  IF v_replay_ids IS DISTINCT FROM v_ids THEN
    RAISE EXCEPTION 'SMOKE_FAIL: step 9: the rep''s own split did not replay exactly';
  END IF;
  IF COALESCE(cardinality(v_ids), 0) <> 1
     OR EXISTS (SELECT 1 FROM public.invoices i
                 WHERE i.id = ANY (v_ids)
                   AND (i.salesman_id IS DISTINCT FROM v_rep_a OR i.customer_id IS DISTINCT FROM v_c_a
                        OR i.invoice_group_id IS NULL)) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: step 9: the rep''s own split invoices have the wrong count, customer or salesman';
  END IF;

  -- 10. Replay re-scope: C_A is reassigned to rep B; rep A's exact replays are now refused.
  -- The PRE-check refuses these (the order's customer is no longer rep A's), before the
  -- idempotency lookup. The post-check's replay leg is defence in depth: under the current
  -- lineage guards a replayed invoice's customer is always the order's, so no fixture here
  -- reaches it with the pre-check passing.
  UPDATE public.customers SET assigned_sales_rep = v_rep_b WHERE id = v_c_a;
  BEGIN
    PERFORM public.create_invoice_from_order(v_o_a, NULL, 'chemical_sale', 'e2e-rep-scope-step-8-' || v_suffix);
    RAISE EXCEPTION 'SMOKE_FAIL: step 10: a replay returned an invoice for a customer no longer assigned to the rep';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT, v_state = RETURNED_SQLSTATE;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err IS DISTINCT FROM 'CUSTOMER_SCOPE_DENIED' OR v_state <> 'P0001' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: step 10: wrong replay re-scope refusal (SQLSTATE %): %', v_state, v_err;
    END IF;
  END;
  BEGIN
    PERFORM public.create_split_invoices_from_order(v_s_own, v_rep_a, 'chemical_sale', 'e2e-rep-scope-step-9-' || v_suffix);
    RAISE EXCEPTION 'SMOKE_FAIL: step 10: a split replay returned invoices for a customer no longer assigned to the rep';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT, v_state = RETURNED_SQLSTATE;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err IS DISTINCT FROM 'CUSTOMER_SCOPE_DENIED' OR v_state <> 'P0001' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: step 10: wrong split replay re-scope refusal (SQLSTATE %): %', v_state, v_err;
    END IF;
  END;
  UPDATE public.customers SET assigned_sales_rep = v_rep_a WHERE id = v_c_a;

  -- 11. Admins are unrestricted: another rep's customer with that rep as salesman, another
  -- rep's allocated order, and the mixed-owner order (which the scope rule never refuses for an
  -- admin; the pre-existing lineage guard may still refuse it, and nothing else may).
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  v_invoice := public.create_invoice_from_order(v_o_b, v_rep_b, 'chemical_sale', 'e2e-rep-scope-step-11-cifo-' || v_suffix);
  IF (SELECT customer_id::text || '|' || salesman_id::text FROM public.invoices WHERE id = v_invoice)
       IS DISTINCT FROM v_c_b::text || '|' || v_rep_b::text THEN
    RAISE EXCEPTION 'SMOKE_FAIL: step 11: an admin could not invoice another rep''s customer under that rep';
  END IF;
  v_ids := public.create_split_invoices_from_order(v_s_b, v_rep_b, 'chemical_sale', 'e2e-rep-scope-step-11-split-' || v_suffix);
  IF COALESCE(cardinality(v_ids), 0) <> 1
     OR EXISTS (SELECT 1 FROM public.invoices i
                 WHERE i.id = ANY (v_ids)
                   AND (i.customer_id IS DISTINCT FROM v_c_b OR i.salesman_id IS DISTINCT FROM v_rep_b)) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: step 11: an admin''s split of another rep''s allocated order did not bill that customer';
  END IF;
  BEGIN
    v_ids := public.create_split_invoices_from_order(v_s_mixed, v_admin, 'chemical_sale', 'e2e-rep-scope-step-11-mixed-' || v_suffix);
    IF COALESCE(cardinality(v_ids), 0) <> 2 THEN
      RAISE EXCEPTION 'SMOKE_FAIL: step 11: an admin''s mixed-owner split returned % invoices, expected 2',
        COALESCE(cardinality(v_ids), 0);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT, v_state = RETURNED_SQLSTATE;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'INVOICE_ORDER_CUSTOMER_LINEAGE_INVALID:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: step 11: an admin''s mixed-owner split was refused (SQLSTATE %): %', v_state, v_err;
    END IF;
  END;

  -- 12. Rep A completes the last delivery of rep B's allocated order today. The delivery
  -- completes; the auto-split is refused before any number, so complete_delivery falls back to
  -- flag + activity + one notification per active admin, and no invoice exists. The fallback
  -- records no error text, so the same call complete_delivery makes is then repeated directly
  -- and must be refused with CUSTOMER_SCOPE_DENIED (not some other error).
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_rep_a, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_rep_a::text, true);
  SELECT string_agg(sequencename || '=' || COALESCE(last_value::text, 'none'), ',' ORDER BY sequencename)
    INTO v_seq_before
    FROM pg_sequences
   WHERE schemaname = 'public'
     AND sequencename IN ('invoice_number_seq', 'cs_invoice_number_seq',
                          'mc_invoice_number_seq', 'cm_invoice_number_seq');
  v_result := public.complete_delivery(
    v_delivery, '[E2E] Rep Scope Receiver', v_rep_a, NULL, NULL, NULL,
    'e2e-rep-scope-step-12-' || v_suffix, NULL
  );
  IF EXISTS (SELECT 1 FROM public.invoices WHERE order_id = v_s_deliver) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: step 12: a rep''s delivery completion auto-billed another rep''s customer';
  END IF;
  IF (SELECT status FROM public.deliveries WHERE id = v_delivery) IS DISTINCT FROM 'completed' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: step 12: the rep''s delivery did not complete: %', v_result;
  END IF;
  SELECT string_agg(sequencename || '=' || COALESCE(last_value::text, 'none'), ',' ORDER BY sequencename)
    INTO v_seq_after
    FROM pg_sequences
   WHERE schemaname = 'public'
     AND sequencename IN ('invoice_number_seq', 'cs_invoice_number_seq',
                          'mc_invoice_number_seq', 'cm_invoice_number_seq');
  IF v_seq_after IS DISTINCT FROM v_seq_before THEN
    RAISE EXCEPTION 'SMOKE_FAIL: step 12: the refused auto-split drew an invoice number (% -> %)',
      v_seq_before, v_seq_after;
  END IF;
  SELECT count(*) INTO v_count
    FROM public.notifications
   WHERE related_entity_id = v_s_deliver AND notification_type = 'split_billing';
  IF (SELECT needs_split_billing FROM public.orders WHERE id = v_s_deliver) IS DISTINCT FROM true
     OR NOT EXISTS (SELECT 1 FROM public.activity_feed
                     WHERE related_entity_id = v_s_deliver AND event_type = 'order_needs_split_billing')
     OR v_count IS DISTINCT FROM (SELECT count(*)::integer FROM public.profiles
                                   WHERE role = 'admin' AND is_active = true) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: step 12: the refused auto-split did not fall back to flag, activity and admin notifications';
  END IF;
  BEGIN
    PERFORM public.create_split_invoices_from_order(
      v_s_deliver, NULL, 'chemical_sale', 'e2e-rep-scope-step-12-' || v_suffix || ':autosplit'
    );
    RAISE EXCEPTION 'SMOKE_FAIL: step 12: the auto-split call complete_delivery makes succeeded when repeated directly';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT, v_state = RETURNED_SQLSTATE;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err IS DISTINCT FROM 'CUSTOMER_SCOPE_DENIED' OR v_state <> 'P0001' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: step 12: the auto-split was refused for the wrong reason (SQLSTATE %): %', v_state, v_err;
    END IF;
  END;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END;
$smoke$;
