-- ============================================================================
-- SMOKE TEST (rolled back by design): the CANONICAL return->credit chain
-- ----------------------------------------------------------------------------
-- THE CHAIN (the exact one B1 was falsely declared "fixed" without, 2026-06-09):
--   authenticated direct returns INSERT -> 42501 (table path closed)
--   create_return (server derives product, quantity ceiling, and price from
--                  delivered order lines; caller price is ignored)
--     -> authenticated direct return_items UPDATE -> 42501 (lines RPC-owned)
--     -> approve_return        (requested -> approved)
--     -> receive_return        (approved -> received; restock + inventory txn)
--     -> issue_return_credit   (received -> credited; posted credit_memo
--                               invoice, credited_by stamped, 2 audit rows)
--     -> idempotent REPLAY of issue_return_credit (same key: cached result,
--                               NO second credit memo)
--     -> get_customer_statement (the credit appears EXACTLY ONCE - the B2
--                               double-count class)
--     -> void_invoice          (normal UI path; credit memo voided and return
--                               back to received;
--                               total_credit_cents back to 0 NOT NULL - the
--                               B1 null-write class; credited_by/at cleared)
--     -> statement returns to the 3 recognized sale rows (14,000 cents)
--     -> RE-ISSUE with a new key (received -> credited again works; statement
--                               has 4 rows / exactly one credit / -1,000 cents)
--
-- HOW TO RUN: CONTAINER ONLY through verify-return-credit-real-schema.mjs.
-- smoke-specs.json sets container_only=true, so run-smoke refuses live DB use.
-- Execute this whole file as a SINGLE statement in disposable PostgreSQL. The DO
-- block ALWAYS ends with RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK', so every
-- fixture, invoice, ledger and audit row created here is rolled back -
-- nothing persists. ANY other error text = a real failure.
--
-- Auth: SECURITY DEFINER RPCs derive the actor from auth.uid(), which reads
-- request.jwt.claims - injected via set_config(..., is_local => true) using a
-- REAL active admin profile id (3 exist live as of 2026-06-10). Direct
-- fixture INSERTs bypass RLS because we run as the table owner; the RPCs
-- under test still enforce their own auth/role gates.
--
-- Live-state preconditions (checked up front, raise SMOKE_SETUP if unmet):
--   * at least one active admin profile;
--   * CURRENT_DATE not inside a CLOSED accounting period
--     (issue_return_credit calls check_period_open(CURRENT_DATE)).
--
-- Known benign side effect: next_invoice_number('credit_memo') consumes
-- cm_invoice_number_seq values (sequences are non-transactional). Gaps in
-- CM numbering are harmless and expected; next_invoice_number self-heals
-- via its MAX()+setval reconciliation.
--
-- Every table/column/function referenced below was dry-validated against the
-- LIVE catalog on 2026-06-10 (pg_get_functiondef + information_schema +
-- pg_constraint + pg_trigger); see scripts/smoke/README.md for the discipline.
-- ============================================================================

DO $smoke$
DECLARE
  v_admin        uuid;
  v_admin2       uuid;
  v_sales_rep    uuid;
  v_suffix       text := substr(md5(random()::text), 1, 8);
  v_customer_id  uuid;
  v_other_customer_id uuid;
  v_product_id   uuid;
  v_inventory_id uuid;
  v_order_id     uuid;
  v_delivery_id  uuid;
  v_source_paid_id uuid;
  v_source_overdue_id uuid;
  v_source_posted_id uuid;
  v_order_item_1 uuid;
  v_order_item_2 uuid;
  v_order_item_3 uuid;
  v_order_item_4 uuid;
  v_followup_delivery_id uuid;
  v_backfill_delivery_id uuid;
  v_followup_invoice_id uuid;
  v_backfill_invoice_id uuid;
  v_return_id    uuid;
  v_sequential_return_id uuid;
  v_sequential_return_id2 uuid;
  v_legacy_return_id uuid;
  v_future_unlinked_return_id uuid;
  v_reject_return_id uuid;
  v_cancel_return_id uuid;
  v_target_invoice_id uuid;
  v_unlinked_credit_id uuid;
  v_target_invoice_item_id uuid;
  v_billing_set_id uuid;
  v_billing_line_id uuid;
  v_application_id uuid;
  v_credit_id    uuid;
  v_sequential_credit_id uuid;
  v_sequential_credit_id2 uuid;
  v_credit_id2   uuid;
  v_credit_num   text;
  v_credit_num2  text;
  v_res          jsonb;
  v_res2         jsonb;
  v_qty          numeric;
  v_inventory_before_receive numeric;
  v_n            int;
  v_credit_rows  int;
  v_total_rows   int;
  v_stmt_sum     bigint;
  v_status       text;
  v_cents        bigint;
  v_cogs         bigint;
  v_pnl_revenue_before bigint;
  v_pnl_cogs_before bigint;
  v_monthly_posted_before bigint;
  v_monthly_amount_before bigint;
  v_monthly_cost_before numeric;
  v_uuid         uuid;
  v_by           uuid;
  v_ts           timestamptz;
  v_reason       text;
  v_create_header jsonb;
  v_create_items jsonb;
  v_season integer := CASE WHEN EXTRACT(MONTH FROM CURRENT_DATE) >= 10
    THEN EXTRACT(YEAR FROM CURRENT_DATE)::integer + 1 ELSE EXTRACT(YEAR FROM CURRENT_DATE)::integer END;
  v_source_season integer := v_season - 1;
BEGIN
  -- --------------------------------------------------------------------
  -- 0. Preconditions + auth as a real active admin
  -- --------------------------------------------------------------------
  IF EXISTS (
    SELECT 1 FROM accounting_periods
    WHERE status = 'closed' AND CURRENT_DATE BETWEEN period_start AND period_end
  ) THEN
    RAISE EXCEPTION 'SMOKE_SETUP: CURRENT_DATE falls in a CLOSED accounting period - issue_return_credit cannot run today';
  END IF;

  SELECT id INTO v_admin FROM profiles
  WHERE role = 'admin' AND is_active = true
  ORDER BY created_at LIMIT 1;
  IF v_admin IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: no active admin profile found';
  END IF;
  SELECT id INTO v_admin2 FROM profiles
  WHERE role = 'admin' AND is_active = true AND id <> v_admin
  ORDER BY created_at LIMIT 1;
  IF v_admin2 IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: a second active admin is required for actor-binding proof';
  END IF;
  SELECT id INTO v_sales_rep FROM profiles
  WHERE role = 'sales_rep' AND is_active = true
  ORDER BY created_at LIMIT 1;
  IF v_sales_rep IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: an active sales rep is required for customer-scope proof';
  END IF;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);

  -- The report RPCs are company-wide. Capture their live baseline before the
  -- rollback-only fixture is inserted, then assert only the fixture's delta.
  -- Absolute totals would false-fail whenever real invoices share this date
  -- window with the smoke.
  SELECT COALESCE((
    SELECT ROUND(amount * 100)::bigint
    FROM get_bottom_line_pnl(CURRENT_DATE - 2, CURRENT_DATE)
    WHERE line_item = 'Revenue'
  ), 0) INTO v_pnl_revenue_before;
  SELECT COALESCE((
    SELECT ROUND(amount * 100)::bigint
    FROM get_bottom_line_pnl(CURRENT_DATE - 2, CURRENT_DATE)
    WHERE line_item = 'Cost of Goods Sold'
  ), 0) INTO v_pnl_cogs_before;
  v_res := get_monthly_summary(CURRENT_DATE - 2, CURRENT_DATE);
  v_monthly_posted_before := COALESCE((v_res #>> '{invoices,posted_count}')::bigint, 0);
  v_monthly_amount_before := COALESCE((v_res #>> '{invoices,total_amount_cents}')::bigint, 0);
  v_monthly_cost_before := COALESCE((v_res #>> '{invoices,total_cost_cents}')::numeric, 0);

  -- --------------------------------------------------------------------
  -- 1. Synthetic fixtures (txn-local; rolled back at the end)
  -- --------------------------------------------------------------------
  INSERT INTO customers (farm_name)
  VALUES ('[SMOKE] Return Credit Farm ' || v_suffix)
  RETURNING id INTO v_customer_id;
  UPDATE customers SET assigned_sales_rep = v_sales_rep WHERE id = v_customer_id;
  INSERT INTO customers (farm_name)
  VALUES ('[SMOKE] Wrong Return Credit Farm ' || v_suffix)
  RETURNING id INTO v_other_customer_id;

  -- Create a pricing-free product shell, then establish its cost through the
  -- same governed preview/apply RPC path used by the app. This keeps the smoke
  -- independent of live catalog contents without disabling product triggers or
  -- touching an existing business row. Everything remains rollback-scoped.
  INSERT INTO products (product_name)
  VALUES ('[SMOKE] RCC Governed Product ' || v_suffix)
  RETURNING id INTO v_product_id;

  v_res := public.preview_product_pricing_changes(
    'product_page',
    NULL,
    jsonb_build_array(jsonb_build_object(
      'product_id', v_product_id,
      'row_version', 1,
      'pricing_mode', 'price_driven',
      'new_cost', '5.00',
      'tier1_price', '10.00',
      'tier2_price', '10.00',
      'tier3_price', '10.00'
    )),
    v_admin,
    'smoke-rcc-pricing-preview-' || v_suffix
  );
  IF v_res->>'status' IS DISTINCT FROM 'previewed'
     OR (v_res->>'apply_allowed')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'SMOKE_SETUP: governed product pricing preview failed: %', v_res;
  END IF;

  v_res2 := public.apply_product_pricing_change_set(
    (v_res->>'change_set_id')::uuid,
    v_res->>'request_fingerprint',
    v_admin,
    'smoke-rcc-pricing-apply-' || v_suffix
  );
  SELECT current_cost INTO v_qty FROM products WHERE id = v_product_id;
  IF v_qty IS DISTINCT FROM 5.00::numeric THEN
    RAISE EXCEPTION 'SMOKE_SETUP: governed product pricing apply failed: %', v_res2;
  END IF;

  -- Delivery completion needs an inventory row. We deliberately remove it
  -- after completion below so receive_return must recreate usable stock rather
  -- than silently marking the return received with restocked=false.
  INSERT INTO inventory (product_id, location, quantity_available)
  VALUES (v_product_id, 'Main Warehouse', 100)
  RETURNING id INTO v_inventory_id;

  -- Minimal order so issue_return_credit exercises its salesman_id lookup
  -- branch and the credit memo carries order_id (orders.status defaults to
  -- 'confirmed'; only order_number + customer_id are required).
  INSERT INTO orders (order_number, customer_id, salesman_id)
  VALUES ('SMK-RCC-' || v_suffix, v_customer_id, v_admin)
  RETURNING id INTO v_order_id;

  INSERT INTO order_items (
    order_id, product_id, product_name, price_per_unit, total_units_needed,
    unit_size, total_price, quantity_delivered, quantity_remaining
  ) VALUES (
    v_order_id, v_product_id, '[SMOKE] RCC Herbicide ' || v_suffix,
    10, 10, 'gal', 100, 10, 0
  ) RETURNING id INTO v_order_item_1;
  INSERT INTO order_items (
    order_id, product_id, product_name, price_per_unit, total_units_needed,
    unit_size, total_price, quantity_delivered, quantity_remaining
  ) VALUES (
    v_order_id, v_product_id, '[SMOKE] RCC Herbicide ' || v_suffix,
    10, 6, 'gal', 60, 6, 0
  ) RETURNING id INTO v_order_item_2;
  INSERT INTO order_items (
    order_id, product_id, product_name, price_per_unit, cost_per_unit,
    total_units_needed, unit_size, total_price, quantity_delivered, quantity_remaining
  ) VALUES (
    v_order_id, v_product_id, '[SMOKE] RCC Follow-up Herbicide ' || v_suffix,
    25, 5, 1, 'gal', 25, 0, 1
  ) RETURNING id INTO v_order_item_3;
  INSERT INTO order_items (
    order_id, product_id, product_name, price_per_unit, cost_per_unit,
    total_units_needed, unit_size, total_price, quantity_delivered, quantity_remaining
  ) VALUES (
    v_order_id, v_product_id, '[SMOKE] RCC Backfill Herbicide ' || v_suffix,
    25, 5, 1, 'gal', 25, 1, 0
  ) RETURNING id INTO v_order_item_4;

  -- Keep the order's delivered totals backed by exact completed-delivery
  -- history so the governed cancel path reaches the received-return guard.
  INSERT INTO deliveries (
    delivery_number, order_id, customer_id, scheduled_date, status, created_by
  ) VALUES (
    'SMK-RCC-D-' || v_suffix, v_order_id, v_customer_id,
    current_date, 'scheduled', v_admin
  ) RETURNING id INTO v_delivery_id;
  INSERT INTO delivery_items (
    delivery_id, order_item_id, product_id, quantity,
    quantity_delivered, unit_size
  ) VALUES
    (v_delivery_id, v_order_item_1, v_product_id, 10, 10, 'gal'),
    (v_delivery_id, v_order_item_2, v_product_id, 6, 6, 'gal');
  UPDATE deliveries SET status = 'in_progress' WHERE id = v_delivery_id;
  -- Use the canonical completion boundary. The later completed-delivery posting
  -- guard makes this mandatory and deliberately rejects a direct status write;
  -- running the real RPC also exercises its inventory/order/audit reconciliation.
  v_res := public.complete_delivery(
    v_delivery_id, '[SMOKE] RCC Receiver', v_admin,
    NULL, NULL, NULL, 'smk-rcc-complete-' || v_suffix, now()
  );
  IF v_res->>'delivery_id' IS DISTINCT FROM v_delivery_id::text THEN
    RAISE EXCEPTION 'SMOKE_SETUP: canonical complete_delivery returned an unexpected receipt: %', v_res;
  END IF;
  DELETE FROM inventory WHERE id = v_inventory_id;
  SELECT count(*) INTO v_n FROM inventory
  WHERE product_id = v_product_id AND location = 'Main Warehouse';
  IF v_n <> 0 THEN RAISE EXCEPTION 'SMOKE_SETUP: missing-row receive fixture was not created'; END IF;
  v_inventory_before_receive := 0;

  -- Three recognized source invoices pin the durable accounting predicate and
  -- the noncontiguous repeated-cost FIFO rule. The customer returned 15 units.
  -- Item 1 has only 8 invoiced units at $5 cost, leaving 2 zero-cost units.
  -- Item 2 has a PAID 1-unit $5 lot, then an OVERDUE 2-unit $6 lot, then
  -- POSTED lots of 2 units at $5 and 1 unit at $5.01. Returning 5 must consume
  -- 1@$5 + 2@$6 + 2@$5, not collapse both $5 lots ahead of the intervening
  -- $6 lot. Exact COGS is therefore 4000 + 500 + 1200 + 1000 = 6700 cents,
  -- leaving the fractional-return oracle's final 501-cent unit untouched.
  INSERT INTO invoices (
    invoice_number, customer_id, order_id, delivery_id, invoice_type, status,
    season, invoice_date, due_date, total_amount_cents, total_cost_cents, created_by
  ) VALUES (
    'SMK-RCC-PAID-' || v_suffix, v_customer_id, v_order_id, v_delivery_id,
    'chemical_sale', 'draft', v_source_season, current_date - 2, current_date - 2, 9000, 4500, v_admin
  ) RETURNING id INTO v_source_paid_id;
  INSERT INTO invoice_items (
    invoice_id, order_item_id, product_id, description, quantity,
    unit_price_cents, extended_cents, cost_cents, unit_size
  ) VALUES
  (
    v_source_paid_id, v_order_item_1, v_product_id, '[SMOKE] paid source',
    8, 1000, 8000, 500, 'gal'
  ),
  (
    v_source_paid_id, v_order_item_2, v_product_id, '[SMOKE] first repeated-cost source',
    1, 1000, 1000, 500, 'gal'
  );
  UPDATE invoices
     SET status = 'posted', posted_at = now(), posted_by = v_admin
   WHERE id = v_source_paid_id;
  UPDATE invoices
     SET status = 'paid', paid_amount_cents = 9000
   WHERE id = v_source_paid_id;

  INSERT INTO invoices (
    invoice_number, customer_id, order_id, delivery_id, invoice_type, status,
    season, invoice_date, due_date, total_amount_cents, total_cost_cents, created_by
  ) VALUES (
    'SMK-RCC-OVERDUE-' || v_suffix, v_customer_id, v_order_id, v_delivery_id,
    'chemical_sale', 'draft', v_source_season, current_date - 1, current_date - 2, 2000, 1200, v_admin
  ) RETURNING id INTO v_source_overdue_id;
  INSERT INTO invoice_items (
    invoice_id, order_item_id, product_id, description, quantity,
    unit_price_cents, extended_cents, cost_cents, unit_size
  ) VALUES (
    v_source_overdue_id, v_order_item_2, v_product_id, '[SMOKE] overdue source',
    2, 1000, 2000, 600, 'gal'
  );
  UPDATE invoices
     SET status = 'posted', posted_at = now(), posted_by = v_admin
   WHERE id = v_source_overdue_id;
  UPDATE invoices SET status = 'overdue' WHERE id = v_source_overdue_id;

  INSERT INTO invoices (
    invoice_number, customer_id, order_id, delivery_id, invoice_type, status,
    season, invoice_date, due_date, total_amount_cents, total_cost_cents, created_by
  ) VALUES (
    'SMK-RCC-POSTED-' || v_suffix, v_customer_id, v_order_id, v_delivery_id,
    'chemical_sale', 'draft', v_source_season, current_date, current_date, 3000, 1501, v_admin
  ) RETURNING id INTO v_source_posted_id;
  INSERT INTO invoice_items (
    invoice_id, order_item_id, product_id, description, quantity,
    unit_price_cents, extended_cents, cost_cents, unit_size, created_at
  ) VALUES
  (
    v_source_posted_id, v_order_item_2, v_product_id, '[SMOKE] posted source',
    2, 1000, 2000, 500, 'gal', now() - interval '1 second'
  ),
  (
    v_source_posted_id, v_order_item_2, v_product_id, '[SMOKE] fractional source',
    1, 1000, 1000, 501, 'gal', now()
  );
  UPDATE invoices
     SET status = 'posted', posted_at = now(), posted_by = v_admin
   WHERE id = v_source_posted_id;

  -- The migration closes both layers: there is no INSERT/FOR ALL RLS policy,
  -- and authenticated has no inherited direct INSERT table privilege.
  IF EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polrelid = 'public.returns'::regclass
      AND polcmd IN ('a', '*')
  ) OR has_table_privilege('authenticated', 'public.returns', 'INSERT')
     OR has_table_privilege('anon', 'public.returns', 'INSERT') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: public.returns direct INSERT catalog boundary is open';
  END IF;
  IF NOT has_function_privilege(
    'authenticated', 'public.create_return(jsonb,jsonb,text)', 'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: authenticated lost canonical create_return EXECUTE';
  END IF;

  -- A real active admin JWT still cannot bypass create_return with PostgREST's
  -- authenticated database role. Keep the role switch outside the denial block
  -- so a runner that cannot assume `authenticated` fails instead of passing for
  -- the wrong reason.
  SET LOCAL ROLE authenticated;
  IF current_user <> 'authenticated' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: SET LOCAL ROLE authenticated did not take effect (current_user=%)', current_user;
  END IF;
  BEGIN
    INSERT INTO public.returns (
      return_number, customer_id, order_id, reason, requested_by, status
    ) VALUES (
      'SMK-DIRECT-' || v_suffix, v_customer_id, v_order_id,
      'overstock', v_admin, 'requested'
    );
    RAISE EXCEPTION 'SMOKE_FAIL: authenticated direct return header INSERT was allowed';
  EXCEPTION
    WHEN insufficient_privilege THEN
      NULL;
    WHEN OTHERS THEN
      IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
      RAISE EXCEPTION 'SMOKE_FAIL: expected direct returns INSERT 42501, got % (%)', SQLERRM, SQLSTATE;
  END;
  RESET ROLE;

  -- A void already restores delivered inventory. The return path must reject
  -- that order or receiving the return could restore the same stock twice.
  PERFORM set_config('app.admin_override', 'true', true);
  UPDATE orders SET status = 'voided' WHERE id = v_order_id;
  PERFORM set_config('app.admin_override', 'false', true);
  BEGIN
    PERFORM create_return(
      jsonb_build_object(
        'customer_id', v_customer_id, 'order_id', v_order_id,
        'reason', 'overstock'
      ),
      jsonb_build_array(jsonb_build_object(
        'order_item_id', v_order_item_1, 'quantity', 1,
        'condition', 'unopened', 'restock', true
      )),
      'smk-rcc-' || v_suffix || '-voided-create'
    );
    RAISE EXCEPTION 'SMOKE_FAIL: return was created from a voided order';
  EXCEPTION WHEN OTHERS THEN
    v_reason := SQLERRM;
    IF v_reason LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_reason NOT LIKE 'RETURN_SOURCE_ORDER_INACTIVE%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: expected inactive-order create rejection, got %', v_reason;
    END IF;
  END;
  PERFORM set_config('app.admin_override', 'true', true);
  UPDATE orders SET status = 'confirmed' WHERE id = v_order_id;
  PERFORM set_config('app.admin_override', 'false', true);

  -- Caller-supplied product/price fields are deliberately false. The RPC must
  -- ignore them and derive two restockable lines worth $150 from the order.
  v_create_header := jsonb_build_object(
    'customer_id', v_customer_id, 'order_id', v_order_id,
    'reason', 'overstock'
  );
  v_create_items := jsonb_build_array(
      jsonb_build_object(
        'order_item_id', v_order_item_1, 'product_id', gen_random_uuid(),
        'quantity', 10, 'unit_price_cents', 1,
        'condition', 'unopened', 'restock', true, 'sort_order', 0
      ),
      jsonb_build_object(
        'order_item_id', v_order_item_2, 'product_id', gen_random_uuid(),
        'quantity', 5, 'unit_price_cents', 1,
        'condition', 'unopened', 'restock', true, 'sort_order', 1
      )
    );
  v_res := create_return(
    v_create_header,
    v_create_items,
    'smk-rcc-' || v_suffix || '-create'
  );
  v_return_id := (v_res->>'return_id')::uuid;
  IF v_return_id IS NULL OR COALESCE((v_res->>'item_count')::int, 0) <> 2 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: create_return returned %', v_res;
  END IF;
  SELECT count(*) INTO v_n
  FROM return_items
  WHERE return_id = v_return_id
    AND product_id = v_product_id
    AND unit_price_cents = 1000
    AND extended_cents IN (10000, 5000)
    AND order_item_id IN (v_order_item_1, v_order_item_2);
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: create_return did not preserve authoritative order-line source (rows=%)', v_n;
  END IF;

  -- Exact create retry represents a committed request whose response was lost.
  -- It must return the same receipt without another header or line set.
  v_res2 := create_return(v_create_header, v_create_items, 'smk-rcc-' || v_suffix || '-create');
  IF (v_res2->>'return_id')::uuid IS DISTINCT FROM v_return_id THEN
    RAISE EXCEPTION 'SMOKE_FAIL: exact create retry returned a different return: %', v_res2;
  END IF;
  SELECT count(*) INTO v_n FROM returns WHERE customer_id = v_customer_id AND order_id = v_order_id;
  IF v_n <> 1 THEN RAISE EXCEPTION 'SMOKE_FAIL: exact create retry produced % return headers', v_n; END IF;

  BEGIN
    PERFORM create_return(
      v_create_header || jsonb_build_object('notes', 'changed payload'),
      v_create_items,
      'smk-rcc-' || v_suffix || '-create'
    );
    RAISE EXCEPTION 'SMOKE_FAIL: changed create payload reused a committed key';
  EXCEPTION WHEN OTHERS THEN
    v_reason := SQLERRM;
    IF v_reason LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_reason NOT LIKE 'IDEMPOTENCY_INTENT_MISMATCH%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: changed create payload raised %, expected IDEMPOTENCY_INTENT_MISMATCH', v_reason;
    END IF;
  END;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin2, 'role', 'authenticated')::text, true);
  BEGIN
    PERFORM create_return(v_create_header, v_create_items, 'smk-rcc-' || v_suffix || '-create');
    RAISE EXCEPTION 'SMOKE_FAIL: another actor reused a committed create key';
  EXCEPTION WHEN OTHERS THEN
    v_reason := SQLERRM;
    IF v_reason LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_reason NOT LIKE 'IDEMPOTENCY_ACTOR_MISMATCH%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: changed actor raised %, expected IDEMPOTENCY_ACTOR_MISMATCH', v_reason;
    END IF;
  END;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);

  IF EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polrelid = 'public.return_items'::regclass
      AND polcmd IN ('a', 'w', 'd', '*')
  ) OR has_table_privilege('authenticated', 'public.return_items', 'INSERT')
     OR has_table_privilege('authenticated', 'public.return_items', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.return_items', 'DELETE')
     OR has_table_privilege('anon', 'public.return_items', 'INSERT')
     OR has_table_privilege('anon', 'public.return_items', 'UPDATE')
     OR has_table_privilege('anon', 'public.return_items', 'DELETE') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: public.return_items direct mutation catalog boundary is open';
  END IF;

  SET LOCAL ROLE authenticated;
  IF current_user <> 'authenticated' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: SET LOCAL ROLE authenticated did not take effect (current_user=%)', current_user;
  END IF;
  BEGIN
    UPDATE public.return_items
       SET notes = 'direct authenticated bypass'
     WHERE return_id = v_return_id;
    RAISE EXCEPTION 'SMOKE_FAIL: authenticated direct return_items UPDATE was allowed';
  EXCEPTION
    WHEN insufficient_privilege THEN
      NULL;
    WHEN OTHERS THEN
      IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
      RAISE EXCEPTION 'SMOKE_FAIL: expected direct return_items UPDATE 42501, got % (%)', SQLERRM, SQLSTATE;
  END;
  RESET ROLE;

  BEGIN
    UPDATE returns SET customer_id = v_other_customer_id WHERE id = v_return_id;
    RAISE EXCEPTION 'SMOKE_FAIL: return customer source was mutable';
  EXCEPTION WHEN OTHERS THEN
    v_reason := SQLERRM;
    IF v_reason LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_reason NOT LIKE 'RETURN_SOURCE_IMMUTABLE%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: expected immutable return-source rejection, got %', v_reason;
    END IF;
  END;
  SELECT customer_id INTO v_uuid FROM returns WHERE id = v_return_id;
  IF v_uuid IS DISTINCT FROM v_customer_id THEN
    RAISE EXCEPTION 'SMOKE_FAIL: rejected customer retarget changed return source to %', v_uuid;
  END IF;

  -- --------------------------------------------------------------------
  -- 2. approve_return: requested -> approved
  -- --------------------------------------------------------------------
  v_res := approve_return(v_return_id, v_admin, 'smk-rcc-' || v_suffix || '-approve');
  IF COALESCE((v_res->>'success')::boolean, false) IS NOT TRUE
     OR v_res->>'status' IS DISTINCT FROM 'approved' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: approve_return returned %', v_res;
  END IF;
  SELECT status INTO v_status FROM returns WHERE id = v_return_id;
  IF v_status <> 'approved' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: return status after approve = %, expected approved', v_status;
  END IF;
  v_res2 := approve_return(v_return_id, v_admin, 'smk-rcc-' || v_suffix || '-approve');
  IF v_res2 IS DISTINCT FROM v_res THEN RAISE EXCEPTION 'SMOKE_FAIL: approve exact replay changed result'; END IF;
  BEGIN
    PERFORM approve_return(gen_random_uuid(), v_admin, 'smk-rcc-' || v_suffix || '-approve');
    RAISE EXCEPTION 'SMOKE_FAIL: approve key accepted another return';
  EXCEPTION WHEN OTHERS THEN
    v_reason := SQLERRM;
    IF v_reason LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_reason NOT LIKE 'IDEMPOTENCY_INTENT_MISMATCH%' THEN RAISE EXCEPTION 'SMOKE_FAIL: approve mismatch raised %', v_reason; END IF;
  END;

  -- Exercise the two other requested-stage wrappers without bypassing their
  -- public transition paths. These synthetic headers are transaction-local.
  PERFORM set_config('app.return_rpc', 'true', true);
  INSERT INTO returns (return_number, customer_id, order_id, reason, requested_by, status)
  VALUES ('SMK-REJECT-' || v_suffix, v_customer_id, v_order_id, 'overstock', v_admin, 'requested')
  RETURNING id INTO v_reject_return_id;
  INSERT INTO returns (return_number, customer_id, order_id, reason, requested_by, status)
  VALUES ('SMK-CANCEL-' || v_suffix, v_customer_id, v_order_id, 'overstock', v_admin, 'requested')
  RETURNING id INTO v_cancel_return_id;
  PERFORM set_config('app.return_rpc', 'false', true);

  v_res := reject_return(v_reject_return_id, v_admin, 'smk-rcc-' || v_suffix || '-reject');
  v_res2 := reject_return(v_reject_return_id, v_admin, 'smk-rcc-' || v_suffix || '-reject');
  IF v_res2 IS DISTINCT FROM v_res THEN RAISE EXCEPTION 'SMOKE_FAIL: reject exact replay changed result'; END IF;
  BEGIN
    PERFORM reject_return(v_cancel_return_id, v_admin, 'smk-rcc-' || v_suffix || '-reject');
    RAISE EXCEPTION 'SMOKE_FAIL: reject key accepted another return';
  EXCEPTION WHEN OTHERS THEN
    v_reason := SQLERRM;
    IF v_reason LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_reason NOT LIKE 'IDEMPOTENCY_INTENT_MISMATCH%' THEN RAISE EXCEPTION 'SMOKE_FAIL: reject mismatch raised %', v_reason; END IF;
  END;

  v_res := cancel_return(v_cancel_return_id, 'exact smoke reason', v_admin, 'smk-rcc-' || v_suffix || '-cancel');
  v_res2 := cancel_return(v_cancel_return_id, 'exact smoke reason', v_admin, 'smk-rcc-' || v_suffix || '-cancel');
  IF v_res2 IS DISTINCT FROM v_res THEN RAISE EXCEPTION 'SMOKE_FAIL: cancel exact replay changed result'; END IF;
  BEGIN
    PERFORM cancel_return(v_cancel_return_id, 'changed reason', v_admin, 'smk-rcc-' || v_suffix || '-cancel');
    RAISE EXCEPTION 'SMOKE_FAIL: cancel key accepted changed reason';
  EXCEPTION WHEN OTHERS THEN
    v_reason := SQLERRM;
    IF v_reason LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_reason NOT LIKE 'IDEMPOTENCY_INTENT_MISMATCH%' THEN RAISE EXCEPTION 'SMOKE_FAIL: cancel mismatch raised %', v_reason; END IF;
  END;

  PERFORM set_config('app.admin_override', 'true', true);
  UPDATE orders SET status = 'partially_fulfilled' WHERE id = v_order_id;
  PERFORM set_config('app.admin_override', 'false', true);

  -- --------------------------------------------------------------------
  -- 3. receive_return: approved -> received; restock 15 units
  -- --------------------------------------------------------------------
  v_res := receive_return(v_return_id, v_admin, 'smk-rcc-' || v_suffix || '-receive');
  IF COALESCE((v_res->>'success')::boolean, false) IS NOT TRUE
     OR v_res->>'status' IS DISTINCT FROM 'received'
     OR COALESCE((v_res->>'restocked_count')::int, -1) <> 2
     OR COALESCE((v_res->>'skipped_count')::int, -1) <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: receive_return returned % (expected received, 2 restocked, 0 skipped)', v_res;
  END IF;

  SELECT quantity_available INTO v_qty FROM inventory
  WHERE product_id = v_product_id AND location = 'Main Warehouse';
  IF v_qty IS DISTINCT FROM v_inventory_before_receive + 15 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: inventory after restock = %, expected baseline % + 15',
      v_qty, v_inventory_before_receive;
  END IF;
  SELECT count(*) INTO v_n FROM inventory_transactions
  WHERE product_id = v_product_id AND transaction_type = 'returned';
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: expected 2 ''returned'' inventory_transactions, found %', v_n;
  END IF;
  SELECT received_by INTO v_by FROM returns WHERE id = v_return_id;
  IF v_by IS DISTINCT FROM v_admin THEN
    RAISE EXCEPTION 'SMOKE_FAIL: received return actor = %, expected %', v_by, v_admin;
  END IF;
  SELECT count(*) INTO v_n FROM inventory_transactions
  WHERE product_id = v_product_id
    AND transaction_type = 'returned'
    AND performed_by IS DISTINCT FROM v_admin;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: % returned inventory transaction(s) lost actor attribution', v_n;
  END IF;

  v_res2 := receive_return(v_return_id, v_admin, 'smk-rcc-' || v_suffix || '-receive');
  IF v_res2 IS DISTINCT FROM v_res THEN RAISE EXCEPTION 'SMOKE_FAIL: receive exact replay changed result'; END IF;
  BEGIN
    PERFORM receive_return(gen_random_uuid(), v_admin, 'smk-rcc-' || v_suffix || '-receive');
    RAISE EXCEPTION 'SMOKE_FAIL: receive key accepted another return';
  EXCEPTION WHEN OTHERS THEN
    v_reason := SQLERRM;
    IF v_reason LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_reason NOT LIKE 'IDEMPOTENCY_INTENT_MISMATCH%' THEN RAISE EXCEPTION 'SMOKE_FAIL: receive mismatch raised %', v_reason; END IF;
  END;
  SELECT count(*) INTO v_n FROM return_items
  WHERE return_id = v_return_id AND restocked = false;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: % return_items still flagged restocked=false after receive', v_n;
  END IF;

  -- Terminal order paths must refuse every received return, even if line flags
  -- say non-restockable/not-restocked. Otherwise void restores delivered stock
  -- or cancel strands the return without a valid credit source.
  UPDATE return_items
     SET restock = false, restocked = false
   WHERE return_id = v_return_id;
  BEGIN
    PERFORM void_order(
      v_order_id, v_admin, 'smoke restocked-return guard',
      'smk-rcc-' || v_suffix || '-void-after-receive'
    );
    RAISE EXCEPTION 'SMOKE_FAIL: order with a received non-restock return was voided';
  EXCEPTION WHEN OTHERS THEN
    v_reason := SQLERRM;
    IF v_reason LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_reason NOT LIKE 'ORDER_HAS_RECEIVED_RETURN%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: expected received-return void rejection, got %', v_reason;
    END IF;
  END;
  BEGIN
    PERFORM cancel_order(
      v_order_id, v_admin, 'smk-rcc-' || v_suffix || '-cancel-after-receive'
    );
    RAISE EXCEPTION 'SMOKE_FAIL: order with a received non-restock return was cancelled';
  EXCEPTION WHEN OTHERS THEN
    v_reason := SQLERRM;
    IF v_reason LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_reason NOT LIKE 'ORDER_HAS_RECEIVED_RETURN%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: expected received-return cancel rejection, got %', v_reason;
    END IF;
  END;
  UPDATE return_items
     SET restock = true, restocked = true
   WHERE return_id = v_return_id;
  UPDATE orders SET status = 'fulfilled' WHERE id = v_order_id;
  SELECT quantity_available INTO v_qty FROM inventory
  WHERE product_id = v_product_id AND location = 'Main Warehouse';
  IF v_qty IS DISTINCT FROM v_inventory_before_receive + 15 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: rejected order void changed inventory to %, expected baseline % + 15',
      v_qty, v_inventory_before_receive;
  END IF;

  -- A return may be received before its source order is later voided. Credit
  -- issuance must re-check the order and refuse that now-invalid money path.
  PERFORM set_config('app.admin_override', 'true', true);
  UPDATE orders SET status = 'voided' WHERE id = v_order_id;
  PERFORM set_config('app.admin_override', 'false', true);
  BEGIN
    PERFORM issue_return_credit(v_return_id, v_admin, 'smk-rcc-' || v_suffix || '-voided-credit');
    RAISE EXCEPTION 'SMOKE_FAIL: return credit was issued after source order void';
  EXCEPTION WHEN OTHERS THEN
    v_reason := SQLERRM;
    IF v_reason LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_reason NOT LIKE 'RETURN_SOURCE_ORDER_INACTIVE%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: expected inactive-order credit rejection, got %', v_reason;
    END IF;
  END;
  PERFORM set_config('app.admin_override', 'true', true);
  UPDATE orders SET status = 'fulfilled' WHERE id = v_order_id;
  PERFORM set_config('app.admin_override', 'false', true);

  -- A legacy/service-role price mutation must be caught before the credit RPC
  -- delegates to the historical implementation that sums extended_cents.
  UPDATE return_items
     SET unit_price_cents = 1, extended_cents = 10
   WHERE return_id = v_return_id AND order_item_id = v_order_item_1;
  BEGIN
    PERFORM issue_return_credit(v_return_id, v_admin, 'smk-rcc-' || v_suffix || '-tampered');
    RAISE EXCEPTION 'SMOKE_FAIL: tampered return price was credited';
  EXCEPTION WHEN OTHERS THEN
    v_reason := SQLERRM;
    IF v_reason LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_reason NOT LIKE 'RETURN_SOURCE_NOT_VERIFIED%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: expected RETURN_SOURCE_NOT_VERIFIED, got %', v_reason;
    END IF;
  END;
  UPDATE return_items
     SET unit_price_cents = 1000, extended_cents = 10000
   WHERE return_id = v_return_id AND order_item_id = v_order_item_1;

  -- The return is a reversal of a historical sale, not a new sale at today's
  -- price. Raise today's catalog cost above the historical $10 price to prove
  -- the scoped credit-line path does not trip the below-cost approval wall.
  v_res := public.preview_product_pricing_changes(
    'product_page',
    NULL,
    jsonb_build_array(jsonb_build_object(
      'product_id', v_product_id,
      'row_version', (SELECT pricing_version FROM products WHERE id = v_product_id),
      'pricing_mode', 'price_driven',
      'new_cost', '20.00',
      'tier1_price', '25.00',
      'tier2_price', '25.00',
      'tier3_price', '25.00'
    )),
    v_admin,
    'smoke-rcc-pricing-recost-preview-' || v_suffix
  );
  IF v_res->>'status' IS DISTINCT FROM 'previewed'
     OR (v_res->>'apply_allowed')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'SMOKE_SETUP: governed product recost preview failed: %', v_res;
  END IF;
  v_res2 := public.apply_product_pricing_change_set(
    (v_res->>'change_set_id')::uuid,
    v_res->>'request_fingerprint',
    v_admin,
    'smoke-rcc-pricing-recost-apply-' || v_suffix
  );
  SELECT current_cost INTO v_qty FROM products WHERE id = v_product_id;
  IF v_qty IS DISTINCT FROM 20.00::numeric THEN
    RAISE EXCEPTION 'SMOKE_SETUP: governed product recost apply failed: %', v_res2;
  END IF;

  -- Ordinary non-credit sale lines remain fail-closed below current cost. The
  -- next credit is exempt only by the transaction-local server context.
  BEGIN
    INSERT INTO invoices (invoice_number, customer_id, order_id, invoice_type, status, invoice_date, due_date, total_amount_cents, created_by)
    VALUES ('SMK-RCC-BELOW-' || v_suffix, v_customer_id, v_order_id, 'chemical_sale', 'draft', current_date, current_date, 1000, v_admin)
    RETURNING id INTO v_target_invoice_id;
    INSERT INTO invoice_items (invoice_id, order_item_id, product_id, description, quantity, unit_price_cents, extended_cents, cost_cents, unit_size)
    VALUES (v_target_invoice_id, v_order_item_1, v_product_id, '[SMOKE] ordinary below cost', 1, 1000, 1000, 500, 'gal');
    RAISE EXCEPTION 'SMOKE_FAIL: ordinary below-cost invoice line was accepted';
  EXCEPTION WHEN OTHERS THEN
    v_reason := SQLERRM;
    IF v_reason LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_reason NOT LIKE 'BELOW_COST_CONTEXT_REQUIRED%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: ordinary below-cost guard raised %', v_reason;
    END IF;
  END;

  -- A costed credit without order-item lineage is ambiguous: consuming it as
  -- a prior lot could steal an unrelated return, while ignoring it could
  -- reverse the same source cost twice. The governed return credit must fail
  -- closed. Trigger bypass below is fixture construction only and rolls back
  -- with this nested block.
  BEGIN
    SET LOCAL session_replication_role = replica;
    INSERT INTO invoices (
      invoice_number, customer_id, order_id, invoice_type, status,
      invoice_date, due_date, posted_at, total_amount_cents, total_cost_cents, created_by
    ) VALUES (
      'SMK-RCC-UNLINKED-' || v_suffix, v_customer_id, v_order_id,
      'credit_memo', 'posted', current_date, current_date, now(), -1000, -500, v_admin
    ) RETURNING id INTO v_unlinked_credit_id;
    INSERT INTO invoice_items (
      invoice_id, order_item_id, product_id, description, quantity,
      unit_price_cents, extended_cents, cost_cents, unit_size
    ) VALUES (
      v_unlinked_credit_id, NULL, v_product_id, '[SMOKE] ambiguous unlinked cost credit',
      -1, 1000, -1000, 500, 'gal'
    );
    SET LOCAL session_replication_role = origin;
    BEGIN
      PERFORM issue_return_credit(v_return_id, v_admin, 'smk-rcc-' || v_suffix || '-unlinked-cost');
      RAISE EXCEPTION 'SMOKE_FAIL: unlinked cost credit was ignored by return issuance';
    EXCEPTION WHEN OTHERS THEN
      v_reason := SQLERRM;
      IF v_reason LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
      IF v_reason IS DISTINCT FROM 'RETURN_CREDIT_UNLINKED_COST_LINE' THEN
        RAISE EXCEPTION 'SMOKE_FAIL: unlinked cost credit raised %', v_reason;
      END IF;
    END;
    RAISE EXCEPTION 'SMOKE_UNLINKED_FIXTURE_ROLLBACK';
  EXCEPTION WHEN OTHERS THEN
    v_reason := SQLERRM;
    IF v_reason IS DISTINCT FROM 'SMOKE_UNLINKED_FIXTURE_ROLLBACK' THEN RAISE; END IF;
  END;

  -- --------------------------------------------------------------------
  -- 4. issue_return_credit: received -> credited; posted credit_memo
  -- --------------------------------------------------------------------
  v_res := issue_return_credit(v_return_id, v_admin, 'smk-rcc-' || v_suffix || '-issue');
  IF COALESCE((v_res->>'success')::boolean, false) IS NOT TRUE
     OR COALESCE((v_res->>'credit_amount_cents')::bigint, 0) <> 15000
     OR COALESCE((v_res->>'cogs_reversed_cents')::bigint, -1) <> 6700 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: RETURN_COGS_EXPECTED_6700 got %', v_res;
  END IF;
  v_credit_id  := (v_res->>'credit_invoice_id')::uuid;
  v_credit_num := v_res->>'credit_invoice_number';

  -- the credit memo invoice: posted, negative total, carries order + salesman
  SELECT status, total_amount_cents, balance_cents, order_id, salesman_id,
         total_cost_cents, season
  INTO v_status, v_cents, v_stmt_sum, v_uuid, v_by, v_cogs, v_n
  FROM invoices WHERE id = v_credit_id AND invoice_type = 'credit_memo';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SMOKE_FAIL: credit memo invoice % not found / wrong type', v_credit_id;
  END IF;
  IF v_status <> 'posted' OR v_cents <> -15000 OR v_stmt_sum <> -15000
     OR v_cogs <> -6700
     OR v_n IS DISTINCT FROM v_season
     OR v_uuid IS DISTINCT FROM v_order_id OR v_by IS DISTINCT FROM v_admin THEN
    RAISE EXCEPTION 'SMOKE_FAIL: credit memo wrong: status=%, total=%, balance=%, cost=%, season=%, order=%, salesman=%',
      v_status, v_cents, v_stmt_sum, v_cogs, v_n, v_uuid, v_by;
  END IF;
  RAISE NOTICE 'CURRENT_SEASON_CREDIT_ATTRIBUTION_PROVEN';

  -- A posted return credit is order-linked and deliberately has no delivery_id.
  -- It must not count as an order-level sales invoice and suppress either the
  -- ordinary auto-invoice path or the completed-delivery backfill path.
  PERFORM set_config('app.admin_override', 'true', true);
  UPDATE orders SET status = 'partially_fulfilled' WHERE id = v_order_id;
  PERFORM set_config('app.admin_override', 'false', true);

  -- A soft-deleted order-level sales draft is also not active billing coverage.
  -- The complete-delivery helper must ignore it independently of the credit memo.
  INSERT INTO invoices (
    invoice_number, customer_id, order_id, invoice_type, status,
    invoice_date, due_date, total_amount_cents, total_cost_cents, created_by,
    deleted_at
  ) VALUES (
    'SMK-RCC-DELETED-' || v_suffix, v_customer_id, v_order_id,
    'chemical_sale', 'draft', current_date, current_date, 0, 0, v_admin, now()
  );

  INSERT INTO deliveries (
    delivery_number, order_id, customer_id, scheduled_date, status, created_by
  ) VALUES (
    'SMK-RCC-FOLLOWUP-D-' || v_suffix, v_order_id, v_customer_id,
    current_date, 'scheduled', v_admin
  ) RETURNING id INTO v_followup_delivery_id;
  INSERT INTO delivery_items (
    delivery_id, order_item_id, product_id, quantity,
    quantity_delivered, unit_size
  ) VALUES (
    v_followup_delivery_id, v_order_item_3, v_product_id, 1, 0, 'gal'
  );
  UPDATE deliveries SET status = 'in_progress' WHERE id = v_followup_delivery_id;
  v_res := public.complete_delivery(
    v_followup_delivery_id, '[SMOKE] RCC Follow-up Receiver', v_admin,
    NULL, NULL, NULL, 'smk-rcc-followup-complete-' || v_suffix, now()
  );
  v_followup_invoice_id := (v_res #>> '{auto_invoice,invoice_id}')::uuid;
  IF v_followup_invoice_id IS NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL: posted return credit suppressed the follow-up delivery auto-invoice: %', v_res;
  END IF;
  SELECT status, total_amount_cents, total_cost_cents
    INTO v_status, v_cents, v_cogs
    FROM invoices
   WHERE id = v_followup_invoice_id
     AND delivery_id = v_followup_delivery_id
     AND order_id = v_order_id
     AND invoice_type = 'chemical_sale';
  IF NOT FOUND OR v_status <> 'draft' OR v_cents <> 2500 OR v_cogs <> 500 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: follow-up auto-invoice wrong: id=%, status=%, total=%, cost=%',
      v_followup_invoice_id, v_status, v_cents, v_cogs;
  END IF;
  SELECT count(*) INTO v_n FROM invoices
   WHERE delivery_id = v_followup_delivery_id
     AND status NOT IN ('voided', 'cancelled')
     AND deleted_at IS NULL;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: follow-up delivery produced % active invoices', v_n;
  END IF;
  RAISE NOTICE 'RETURN_CREDIT_FOLLOWUP_AUTO_INVOICE_PROVEN';

  SET LOCAL session_replication_role = replica;
  INSERT INTO deliveries (
    delivery_number, order_id, customer_id, scheduled_date, status,
    completed_at, signed_by, created_by
  ) VALUES (
    'SMK-RCC-BACKFILL-D-' || v_suffix, v_order_id, v_customer_id,
    current_date, 'completed', now(), '[SMOKE] RCC Historical Receiver', v_admin
  ) RETURNING id INTO v_backfill_delivery_id;
  INSERT INTO delivery_items (
    delivery_id, order_item_id, product_id, quantity,
    quantity_delivered, unit_size
  ) VALUES (
    v_backfill_delivery_id, v_order_item_4, v_product_id, 1, 1, 'gal'
  );
  SET LOCAL session_replication_role = origin;
  v_res2 := public.get_dashboard_action_items(50);
  IF NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(v_res2->'unbilled_deliveries') item
    WHERE item->>'id' = v_backfill_delivery_id::text
  ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: posted return credit suppressed the dashboard unbilled-delivery action';
  END IF;
  RAISE NOTICE 'RETURN_CREDIT_DASHBOARD_UNBILLED_PROVEN';
  BEGIN
    v_res2 := public.create_invoice_for_unbilled_delivery(
      v_backfill_delivery_id, v_admin, 'smk-rcc-backfill-' || v_suffix
    );
  EXCEPTION WHEN OTHERS THEN
    v_reason := SQLERRM;
    IF v_reason LIKE 'This delivery already has an active invoice%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: posted return credit suppressed the unbilled-delivery backfill: %', v_reason;
    END IF;
    RAISE;
  END;
  v_backfill_invoice_id := (v_res2->>'invoice_id')::uuid;
  IF v_backfill_invoice_id IS NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL: posted return credit suppressed the unbilled-delivery backfill: %', v_res2;
  END IF;
  SELECT status, total_amount_cents, total_cost_cents
    INTO v_status, v_cents, v_cogs
    FROM invoices
   WHERE id = v_backfill_invoice_id
     AND delivery_id = v_backfill_delivery_id
     AND order_id = v_order_id
     AND invoice_type = 'chemical_sale';
  IF NOT FOUND OR v_status <> 'draft' OR v_cents <> 2500 OR v_cogs <> 500 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: unbilled-delivery backfill invoice wrong: id=%, status=%, total=%, cost=%',
      v_backfill_invoice_id, v_status, v_cents, v_cogs;
  END IF;
  RAISE NOTICE 'RETURN_CREDIT_UNBILLED_BACKFILL_PROVEN';

  BEGIN
    UPDATE invoices
       SET total_amount_cents = total_amount_cents - 1,
           total_cost_cents = total_cost_cents - 1
     WHERE id = v_credit_id;
    RAISE EXCEPTION 'SMOKE_FAIL: active return-credit header ledger was mutated';
  EXCEPTION WHEN OTHERS THEN
    v_reason := SQLERRM;
    IF v_reason LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_reason IS DISTINCT FROM 'RETURN_CREDIT_HEADER_IMMUTABLE' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: return-credit header ledger guard raised %', v_reason;
    END IF;
  END;

  BEGIN
    UPDATE invoices SET season = season + 1 WHERE id = v_credit_id;
    RAISE EXCEPTION 'SMOKE_FAIL: active return-credit season was mutated';
  EXCEPTION WHEN OTHERS THEN
    v_reason := SQLERRM;
    IF v_reason LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_reason IS DISTINCT FROM 'RETURN_CREDIT_HEADER_IMMUTABLE' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: return-credit season guard raised %', v_reason;
    END IF;
  END;

  BEGIN
    DELETE FROM invoices WHERE id = v_credit_id;
    RAISE EXCEPTION 'SMOKE_FAIL: active return-credit header was hard-deleted';
  EXCEPTION WHEN OTHERS THEN
    v_reason := SQLERRM;
    IF v_reason LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_reason IS DISTINCT FROM 'RETURN_CREDIT_HEADER_IMMUTABLE' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: return-credit header hard-delete guard raised %', v_reason;
    END IF;
  END;
  RAISE NOTICE 'RETURN_CREDIT_HEADER_DELETE_GUARD_PROVEN';

  BEGIN
    DELETE FROM returns WHERE id = v_return_id;
    RAISE EXCEPTION 'SMOKE_FAIL: recognized return-credit parent was deleted';
  EXCEPTION WHEN OTHERS THEN
    v_reason := SQLERRM;
    IF v_reason LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_reason IS DISTINCT FROM 'RETURN_CREDIT_PARENT_IMMUTABLE' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: return-credit parent guard raised %', v_reason;
    END IF;
  END;

  -- The below-cost bypass is statement-scoped in practice, not merely
  -- transaction-local. A later negative line in this same transaction must
  -- hit the ordinary guard after issue_return_credit clears its flag.
  BEGIN
    INSERT INTO invoices (invoice_number, customer_id, order_id, invoice_type, status, invoice_date, due_date, total_amount_cents, created_by)
    VALUES ('SMK-RCC-AFTER-' || v_suffix, v_customer_id, v_order_id, 'chemical_sale', 'draft', current_date, current_date, 0, v_admin)
    RETURNING id INTO v_target_invoice_id;
    INSERT INTO invoice_items (invoice_id, order_item_id, product_id, description, quantity, unit_price_cents, extended_cents, cost_cents, unit_size)
    VALUES (v_target_invoice_id, v_order_item_1, v_product_id, '[SMOKE] post-credit below cost', -1, 1000, -1000, 500, 'gal');
    RAISE EXCEPTION 'SMOKE_FAIL: return-credit lineage flag remained active after its insert';
  EXCEPTION WHEN OTHERS THEN
    v_reason := SQLERRM;
    IF v_reason LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_reason NOT LIKE 'BELOW_COST_CONTEXT_REQUIRED%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: post-credit below-cost guard raised %', v_reason;
    END IF;
  END;

  -- The active credit depends on its source sale remaining recognized. A
  -- source may be voided/soft-deleted only after this credit is unapplied.
  BEGIN
    UPDATE invoices SET deleted_at = now() WHERE id = v_source_paid_id;
    RAISE EXCEPTION 'SMOKE_FAIL: source sale with an active return credit was soft-deleted';
  EXCEPTION WHEN OTHERS THEN
    v_reason := SQLERRM;
    IF v_reason LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_reason IS DISTINCT FROM 'RETURN_CREDIT_SOURCE_RECOGNITION_REQUIRED' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: source-recognition guard raised %', v_reason;
    END IF;
  END;

  BEGIN
    DELETE FROM invoices WHERE id = v_source_paid_id;
    RAISE EXCEPTION 'SMOKE_FAIL: source sale with an active return credit was hard-deleted';
  EXCEPTION WHEN OTHERS THEN
    v_reason := SQLERRM;
    IF v_reason LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_reason IS DISTINCT FROM 'RETURN_CREDIT_SOURCE_RECOGNITION_REQUIRED' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: source hard-delete guard raised %', v_reason;
    END IF;
  END;

  BEGIN
    -- Simulate the narrow internal context that bypasses the sale-only
    -- below-cost trigger. The independent ledger guard must still refuse an
    -- edit to an already-recognized return-credit cost line.
    PERFORM set_config('app.crx_return_credit_lineage', '1', true);
    UPDATE invoice_items
       SET cost_cents = cost_cents + 1
     WHERE id = (
       SELECT id FROM invoice_items
       WHERE invoice_id = v_credit_id AND quantity < 0 AND cost_cents > 0
       ORDER BY id LIMIT 1
     );
    PERFORM set_config('app.crx_return_credit_lineage', '0', true);
    RAISE EXCEPTION 'SMOKE_FAIL: active return-credit cost line was mutated';
  EXCEPTION WHEN OTHERS THEN
    v_reason := SQLERRM;
    PERFORM set_config('app.crx_return_credit_lineage', '0', true);
    IF v_reason LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_reason IS DISTINCT FROM 'RETURN_CREDIT_LEDGER_IMMUTABLE' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: return-credit ledger guard raised %', v_reason;
    END IF;
  END;

  BEGIN
    -- Re-parenting a recognized cost-credit line would hide it from the
    -- prior-credit ledger and let a later return consume the same source cost.
    UPDATE invoice_items
       SET invoice_id = v_source_paid_id
     WHERE id = (
       SELECT id FROM invoice_items
       WHERE invoice_id = v_credit_id AND quantity < 0 AND cost_cents > 0
       ORDER BY id LIMIT 1
     );
    RAISE EXCEPTION 'SMOKE_FAIL: active return-credit cost line was reparented';
  EXCEPTION WHEN OTHERS THEN
    v_reason := SQLERRM;
    IF v_reason LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_reason IS DISTINCT FROM 'RETURN_CREDIT_LEDGER_IMMUTABLE' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: return-credit invoice lineage guard raised %', v_reason;
    END IF;
  END;

  BEGIN
    -- Zero-cost remainder lines are still authoritative return-credit ledger
    -- rows. They must not be editable into a later positive COGS reversal.
    PERFORM set_config('app.crx_return_credit_lineage', '1', true);
    UPDATE invoice_items
       SET cost_cents = 1
     WHERE id = (
       SELECT id FROM invoice_items
       WHERE invoice_id = v_credit_id AND quantity < 0 AND cost_cents = 0
       ORDER BY id LIMIT 1
     );
    PERFORM set_config('app.crx_return_credit_lineage', '0', true);
    RAISE EXCEPTION 'SMOKE_FAIL: active zero-cost return-credit line was costed later';
  EXCEPTION WHEN OTHERS THEN
    v_reason := SQLERRM;
    PERFORM set_config('app.crx_return_credit_lineage', '0', true);
    IF v_reason LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_reason IS DISTINCT FROM 'RETURN_CREDIT_LEDGER_IMMUTABLE' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: zero-cost return-credit guard raised %', v_reason;
    END IF;
  END;

  BEGIN
    -- Revenue fields on a recognized credit line must remain in sync with the
    -- posted credit header and customer/product reporting.
    PERFORM set_config('app.crx_return_credit_lineage', '1', true);
    UPDATE invoice_items
       SET unit_price_cents = unit_price_cents + 1,
           extended_cents = extended_cents - 1
     WHERE id = (
       SELECT id FROM invoice_items
       WHERE invoice_id = v_credit_id AND quantity < 0
       ORDER BY id LIMIT 1
     );
    PERFORM set_config('app.crx_return_credit_lineage', '0', true);
    RAISE EXCEPTION 'SMOKE_FAIL: active return-credit revenue fields were mutated';
  EXCEPTION WHEN OTHERS THEN
    v_reason := SQLERRM;
    PERFORM set_config('app.crx_return_credit_lineage', '0', true);
    IF v_reason LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_reason IS DISTINCT FROM 'RETURN_CREDIT_LEDGER_IMMUTABLE' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: return-credit revenue guard raised %', v_reason;
    END IF;
  END;

  SELECT count(*),
         count(*) FILTER (WHERE cost_cents > 0),
         count(*) FILTER (WHERE cost_cents = 0),
         ROUND(COALESCE(sum(quantity), 0))::bigint,
         COALESCE(sum(extended_cents), 0),
         ROUND(COALESCE(sum(cost_cents * quantity), 0))::bigint
  INTO v_total_rows, v_credit_rows, v_n, v_qty, v_cents, v_cogs
  FROM invoice_items
  WHERE invoice_id = v_credit_id;
  IF v_total_rows <> 5 OR v_credit_rows <> 4 OR v_n <> 1
     OR v_qty <> -15 OR v_cents <> -15000 OR v_cogs <> -6700 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: COGS lines rows=% cost_rows=% zero_rows=% qty=% revenue=% cogs=%',
      v_total_rows, v_credit_rows, v_n, v_qty, v_cents, v_cogs;
  END IF;
  SELECT count(*) INTO v_n FROM pg_constraint
  WHERE conrelid = 'public.return_items'::regclass
    AND conname = 'return_items_return_order_item_unique';
  IF v_n <> 1 THEN RAISE EXCEPTION 'SMOKE_FAIL: duplicate return-line constraint is absent'; END IF;

  -- the return: credited, amount + linkage + credited_by stamped (the
  -- missing-credited_by-column class that broke B1 end-to-end)
  SELECT status, total_credit_cents, credit_invoice_id, credited_by, credited_at
  INTO v_status, v_cents, v_uuid, v_by, v_ts
  FROM returns WHERE id = v_return_id;
  IF v_status <> 'credited' OR v_cents <> 15000 OR v_uuid IS DISTINCT FROM v_credit_id
     OR v_by IS DISTINCT FROM v_admin OR v_ts IS NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL: return after issue: status=%, credit_cents=%, invoice=%, credited_by=%, credited_at=%',
      v_status, v_cents, v_uuid, v_by, v_ts;
  END IF;

  -- both financial_audit_log rows landed
  SELECT count(*) INTO v_n FROM financial_audit_log
  WHERE operation_type = 'credit_memo_created' AND entity_type = 'credit_memo' AND entity_id = v_credit_id;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: credit_memo_created audit rows = % (expected 1)', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM financial_audit_log
  WHERE operation_type = 'return_credit_issued' AND entity_type = 'return' AND entity_id = v_return_id;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: return_credit_issued audit rows = % (expected 1)', v_n;
  END IF;

  -- --------------------------------------------------------------------
  -- 5. Idempotent REPLAY: same key returns the cache, no second memo
  -- --------------------------------------------------------------------
  v_res2 := issue_return_credit(v_return_id, v_admin, 'smk-rcc-' || v_suffix || '-issue');
  IF (v_res2->>'credit_invoice_id')::uuid IS DISTINCT FROM v_credit_id THEN
    RAISE EXCEPTION 'SMOKE_FAIL: idempotent replay returned a DIFFERENT credit memo: % vs %',
      v_res2->>'credit_invoice_id', v_credit_id;
  END IF;
  SELECT count(*) INTO v_n FROM invoices
  WHERE customer_id = v_customer_id AND invoice_type = 'credit_memo';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: replay created a duplicate credit memo (count = %)', v_n;
  END IF;
  BEGIN
    PERFORM issue_return_credit(gen_random_uuid(), v_admin, 'smk-rcc-' || v_suffix || '-issue');
    RAISE EXCEPTION 'SMOKE_FAIL: issue-credit key accepted another return';
  EXCEPTION WHEN OTHERS THEN
    v_reason := SQLERRM;
    IF v_reason LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_reason NOT LIKE 'IDEMPOTENCY_INTENT_MISMATCH%' THEN RAISE EXCEPTION 'SMOKE_FAIL: issue-credit mismatch raised %', v_reason; END IF;
  END;

  -- --------------------------------------------------------------------
  -- 6. Report controls: paid and overdue source sales must remain in the
  -- customer year-end invoice set. The posted credit memo belongs to the
  -- current credit season, leaving the prior customer summary unchanged. The
  -- detailed statement keeps the same credit in its open-credit disclosure.
  -- A sales rep can read the assigned customer but neither an unassigned
  -- customer nor a mixed batch. The admin path remains unrestricted.
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_sales_rep, 'role', 'authenticated')::text, true);
  v_res := public.get_customer_year_end_summary(v_customer_id, v_source_season);
  IF v_res #>> '{customer,id}' IS DISTINCT FROM v_customer_id::text THEN
    RAISE EXCEPTION 'SMOKE_FAIL: assigned sales rep could not read assigned year-end summary: %', v_res;
  END IF;
  v_res := public.get_batch_year_end_summaries(ARRAY[v_customer_id], v_source_season);
  IF jsonb_array_length(v_res) <> 1
     OR v_res #>> '{0,customer,id}' IS DISTINCT FROM v_customer_id::text THEN
    RAISE EXCEPTION 'SMOKE_FAIL: assigned-only sales-rep year-end batch returned %', v_res;
  END IF;
  BEGIN
    PERFORM public.get_customer_year_end_summary(v_other_customer_id, v_season);
    RAISE EXCEPTION 'SMOKE_FAIL: unassigned sales rep read another customer year-end summary';
  EXCEPTION WHEN OTHERS THEN
    v_reason := SQLERRM;
    IF v_reason LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_reason IS DISTINCT FROM 'CUSTOMER_SCOPE_DENIED' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: unassigned year-end scope raised %', v_reason;
    END IF;
  END;
  BEGIN
    PERFORM public.get_batch_year_end_summaries(ARRAY[v_customer_id, v_other_customer_id], v_season);
    RAISE EXCEPTION 'SMOKE_FAIL: mixed authorized/unauthorized year-end batch was accepted';
  EXCEPTION WHEN OTHERS THEN
    v_reason := SQLERRM;
    IF v_reason LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_reason IS DISTINCT FROM 'CUSTOMER_SCOPE_DENIED' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: mixed year-end batch scope raised %', v_reason;
    END IF;
  END;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM public.get_customer_year_end_summary(v_other_customer_id, v_season);
  v_res := public.get_customer_year_end_summary(v_customer_id, v_source_season);
  SELECT count(*) INTO v_n
  FROM jsonb_array_elements(v_res->'invoices') AS invoice_row
  WHERE invoice_row->>'invoice_number' IN (
    'SMK-RCC-PAID-' || v_suffix,
    'SMK-RCC-OVERDUE-' || v_suffix
  );
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: source-season year-end omitted recognized paid/overdue sales (rows=%): %', v_n, v_res;
  END IF;
  SELECT count(*) INTO v_n
  FROM jsonb_array_elements(v_res->'invoices') AS invoice_row
  WHERE invoice_row->>'invoice_number' = v_credit_num;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: current-season return credit restated the source-season year-end summary';
  END IF;
  SELECT COALESCE(SUM((usage_row->>'total_quantity')::numeric), 0),
         COALESCE(SUM((usage_row->>'total_cost_cents')::bigint), 0)
    INTO v_qty, v_cents
    FROM jsonb_array_elements(v_res->'product_usage') AS usage_row
   WHERE usage_row->>'product_name' = (SELECT product_name FROM products WHERE id = v_product_id);
  IF v_qty IS DISTINCT FROM 14::numeric OR v_cents IS DISTINCT FROM 14000::bigint THEN
    RAISE EXCEPTION 'SMOKE_FAIL: source-season usage changed quantity=% value=% (expected 14/14000)',
      v_qty, v_cents;
  END IF;

  -- Mason chose simple current-season recognition. This fixture deliberately
  -- returns one more unit than appeared on recognized sale lines, so the
  -- current season truthfully shows the credit by itself: -15 units/-15000
  -- cents. Negative current-season usage is the accepted tradeoff for never
  -- restating a previously generated customer year-end summary.
  v_res2 := public.get_customer_year_end_summary(v_customer_id, v_season);
  SELECT count(*) INTO v_n
  FROM jsonb_array_elements(v_res2->'invoices') AS invoice_row
  WHERE invoice_row->>'invoice_number' = v_credit_num;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: current-season year-end omitted posted return credit (rows=%): %', v_n, v_res2;
  END IF;
  SELECT COALESCE(SUM((usage_row->>'total_quantity')::numeric), 0),
         COALESCE(SUM((usage_row->>'total_cost_cents')::bigint), 0)
    INTO v_qty, v_cents
    FROM jsonb_array_elements(v_res2->'product_usage') AS usage_row
   WHERE usage_row->>'product_name' = (SELECT product_name FROM products WHERE id = v_product_id);
  IF v_qty IS DISTINCT FROM -15::numeric OR v_cents IS DISTINCT FROM -15000::bigint THEN
    RAISE EXCEPTION 'SMOKE_FAIL: current-season credit usage quantity=% value=% (expected -15/-15000)',
      v_qty, v_cents;
  END IF;
  v_res := public.get_detailed_statement_data(v_customer_id, CURRENT_DATE, 'detailed');
  IF COALESCE((v_res->>'open_credit_cents')::bigint, 0) <> 15000 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: detailed statement open-credit disclosure is wrong: %', v_res;
  END IF;
  SELECT count(*) INTO v_n
  FROM jsonb_array_elements(v_res->'transactions') AS statement_row
  WHERE statement_row->>'invoice_number' = v_credit_num;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: detailed statement unexpectedly rendered % credit_memo transaction rows', v_n;
  END IF;
  SELECT count(*) INTO v_n
  FROM jsonb_array_elements(v_res->'transactions') AS statement_row
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(statement_row->'items', '[]'::jsonb)) AS statement_item
  WHERE statement_row->>'invoice_number' = v_credit_num;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: detailed statement unexpectedly rendered % credit_memo items', v_n;
  END IF;

  -- 7. Two fractional returns consume the final 501-cent source unit without
  -- double-rounding it. The first half receives 251 cents and the second gets
  -- the remaining 250 cents; together every recognized source cent is reversed
  -- exactly once.
  v_res := create_return(
    jsonb_build_object('customer_id', v_customer_id, 'order_id', v_order_id, 'reason', 'overstock'),
    jsonb_build_array(jsonb_build_object(
      'order_item_id', v_order_item_2, 'quantity', 0.5,
      'condition', 'unopened', 'restock', true, 'sort_order', 0
    )),
    'smk-rcc-' || v_suffix || '-fractional-a-create'
  );
  v_sequential_return_id := (v_res->>'return_id')::uuid;
  IF v_sequential_return_id IS NULL THEN RAISE EXCEPTION 'SMOKE_FAIL: fractional return A create returned %', v_res; END IF;
  PERFORM approve_return(v_sequential_return_id, v_admin, 'smk-rcc-' || v_suffix || '-fractional-a-approve');
  v_res := receive_return(v_sequential_return_id, v_admin, 'smk-rcc-' || v_suffix || '-fractional-a-receive');
  IF v_res->>'status' IS DISTINCT FROM 'received' THEN RAISE EXCEPTION 'SMOKE_FAIL: fractional receive A returned %', v_res; END IF;
  v_res := issue_return_credit(v_sequential_return_id, v_admin, 'smk-rcc-' || v_suffix || '-fractional-a-issue');
  v_sequential_credit_id := (v_res->>'credit_invoice_id')::uuid;
  IF v_sequential_credit_id IS NULL OR COALESCE((v_res->>'cogs_reversed_cents')::bigint, 0) <> 251 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: FRACTIONAL_COGS_EXPECTED_251 got %', v_res;
  END IF;
  v_res2 := public.get_customer_year_end_summary(v_customer_id, v_season);
  SELECT count(*) INTO v_n
  FROM jsonb_array_elements(v_res2->'invoices') AS invoice_row
  WHERE invoice_row->>'invoice_number' = v_credit_num;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: return credit was not retained in the current credit season';
  END IF;
  SELECT amount * 100 INTO v_qty
  FROM get_bottom_line_pnl(CURRENT_DATE - 2, CURRENT_DATE)
  WHERE line_item = 'Cost of Goods Sold';
  IF v_qty - v_pnl_cogs_before <> 250::numeric THEN
    RAISE EXCEPTION 'SMOKE_FAIL: fractional credit A PNL COGS delta=% (expected 250 whole cents)',
      v_qty - v_pnl_cogs_before;
  END IF;
  v_res2 := get_monthly_summary(CURRENT_DATE - 2, CURRENT_DATE);
  IF (v_res2 #>> '{invoices,total_cost_cents}')::numeric - v_monthly_cost_before <> 250::numeric THEN
    RAISE EXCEPTION 'SMOKE_FAIL: fractional credit A monthly COGS delta=% (expected 250 whole cents)',
      (v_res2 #>> '{invoices,total_cost_cents}')::numeric - v_monthly_cost_before;
  END IF;

  v_res := create_return(
    jsonb_build_object('customer_id', v_customer_id, 'order_id', v_order_id, 'reason', 'overstock'),
    jsonb_build_array(jsonb_build_object(
      'order_item_id', v_order_item_2, 'quantity', 0.5,
      'condition', 'unopened', 'restock', true, 'sort_order', 0
    )),
    'smk-rcc-' || v_suffix || '-fractional-b-create'
  );
  v_sequential_return_id2 := (v_res->>'return_id')::uuid;
  IF v_sequential_return_id2 IS NULL THEN RAISE EXCEPTION 'SMOKE_FAIL: fractional return B create returned %', v_res; END IF;
  PERFORM approve_return(v_sequential_return_id2, v_admin, 'smk-rcc-' || v_suffix || '-fractional-b-approve');
  v_res := receive_return(v_sequential_return_id2, v_admin, 'smk-rcc-' || v_suffix || '-fractional-b-receive');
  IF v_res->>'status' IS DISTINCT FROM 'received' THEN RAISE EXCEPTION 'SMOKE_FAIL: fractional receive B returned %', v_res; END IF;
  v_res := issue_return_credit(v_sequential_return_id2, v_admin, 'smk-rcc-' || v_suffix || '-fractional-b-issue');
  v_sequential_credit_id2 := (v_res->>'credit_invoice_id')::uuid;
  IF v_sequential_credit_id2 IS NULL OR COALESCE((v_res->>'cogs_reversed_cents')::bigint, 0) <> 250 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: FRACTIONAL_COGS_EXPECTED_250 got %', v_res;
  END IF;
  SELECT -COALESCE(SUM(ii.cost_cents * ii.quantity), 0)::bigint INTO v_cogs
  FROM invoice_items ii
  JOIN invoices i ON i.id = ii.invoice_id
  WHERE i.invoice_type = 'credit_memo' AND i.customer_id = v_customer_id
    AND i.status IN ('posted', 'overdue', 'paid') AND i.deleted_at IS NULL
    AND ii.order_item_id = v_order_item_2;
  IF v_cogs <> 3201 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: fractional credits over- or under-reversed item 2 COGS: % (expected 3201)', v_cogs;
  END IF;
  -- Keep the legacy statement/unapply portion below isolated to its original
  -- one-credit contract after proving both independent fractional receipts.
  SELECT batch_void_invoices(
    ARRAY[v_sequential_credit_id2],
    '[SMOKE] fractional B batch-void proof cleanup',
    v_admin,
    'smk-rcc-' || v_suffix || '-fractional-b-batch-void'
  ) INTO v_n;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: batch void did not route the return credit through void_invoice (count %)', v_n;
  END IF;
  PERFORM unapply_credit_memo(v_sequential_credit_id, '[SMOKE] fractional A proof cleanup', v_admin,
    'smk-rcc-' || v_suffix || '-fractional-a-unapply');

  -- 8. Statement: the credit appears EXACTLY ONCE (the B2 double-count class)
  --    Three recognized sale rows plus one credit row pin the row count,
  --    single-credit count, and running balance together.
  -- --------------------------------------------------------------------
  SELECT count(*) FILTER (WHERE transaction_type = 'credit' AND reference_number = v_credit_num),
         count(*),
         COALESCE(SUM(amount_cents), 0)
  INTO v_credit_rows, v_total_rows, v_stmt_sum
  FROM get_customer_statement(v_customer_id, (CURRENT_DATE - 7)::date, CURRENT_DATE);
  IF v_credit_rows <> 1 OR v_total_rows <> 4 OR v_stmt_sum <> -1000 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: statement after issue: credit_rows=%, total_rows=%, sum=% (expected 1/4/-1000 - credit must appear EXACTLY once)',
      v_credit_rows, v_total_rows, v_stmt_sum;
  END IF;

  -- --------------------------------------------------------------------
  -- 9. void_invoice: prove the normal invoice-detail UI path can atomically
  --    void the memo and revert the return to received.
  -- --------------------------------------------------------------------
  PERFORM void_invoice(v_credit_id, '[SMOKE] chain void',
                       'smk-rcc-' || v_suffix || '-void');

  SELECT status, voided_by, void_reason INTO v_status, v_by, v_reason
  FROM invoices WHERE id = v_credit_id;
  IF v_status <> 'voided' OR v_by IS DISTINCT FROM v_admin OR v_reason IS NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL: memo after void: status=%, voided_by=%, reason=%', v_status, v_by, v_reason;
  END IF;

  -- the B1 regression surface: total_credit_cents must be 0 (NOT NULL col),
  -- linkage + credited_by/at cleared, status legally back to received
  SELECT status, total_credit_cents, credit_invoice_id, credited_by, credited_at
  INTO v_status, v_cents, v_uuid, v_by, v_ts
  FROM returns WHERE id = v_return_id;
  IF v_status <> 'received' OR v_cents IS DISTINCT FROM 0 OR v_uuid IS NOT NULL
     OR v_by IS NOT NULL OR v_ts IS NOT NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL: return after void: status=%, credit_cents=%, invoice=%, credited_by=%, credited_at=%',
      v_status, v_cents, v_uuid, v_by, v_ts;
  END IF;

  SELECT count(*) INTO v_n FROM financial_audit_log
  WHERE operation_type = 'invoice_voided' AND entity_type = 'invoice' AND entity_id = v_credit_id;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: return-credit invoice_voided audit rows = % (expected 1)', v_n;
  END IF;

  -- The voided memo drops out while all three recognized sale statuses remain.
  SELECT count(*), COALESCE(SUM(amount_cents), 0)
  INTO v_total_rows, v_stmt_sum
  FROM get_customer_statement(v_customer_id, (CURRENT_DATE - 7)::date, CURRENT_DATE);
  IF v_total_rows <> 3 OR v_stmt_sum <> 14000 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: statement after void rows=% sum=% (expected 3/14000)',
      v_total_rows, v_stmt_sum;
  END IF;

  -- --------------------------------------------------------------------
  -- 10. RE-ISSUE after void (received -> credited again must be legal);
  --    statement has four rows with exactly one credit
  -- --------------------------------------------------------------------
  v_res := issue_return_credit(v_return_id, v_admin, 'smk-rcc-' || v_suffix || '-reissue');
  IF COALESCE((v_res->>'success')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'SMOKE_FAIL: re-issue after void failed: %', v_res;
  END IF;
  v_credit_id2  := (v_res->>'credit_invoice_id')::uuid;
  v_credit_num2 := v_res->>'credit_invoice_number';
  IF v_credit_id2 IS NOT DISTINCT FROM v_credit_id THEN
    RAISE EXCEPTION 'SMOKE_FAIL: re-issue reused the voided credit memo id %', v_credit_id;
  END IF;

  SELECT count(*) FILTER (WHERE transaction_type = 'credit' AND reference_number = v_credit_num2),
         count(*),
         COALESCE(SUM(amount_cents), 0)
  INTO v_credit_rows, v_total_rows, v_stmt_sum
  FROM get_customer_statement(v_customer_id, (CURRENT_DATE - 7)::date, CURRENT_DATE);
  IF v_credit_rows <> 1 OR v_total_rows <> 4 OR v_stmt_sum <> -1000 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: statement after re-issue: credit_rows=%, total_rows=%, sum=% (expected 1/4/-1000)',
      v_credit_rows, v_total_rows, v_stmt_sum;
  END IF;

  SELECT ROUND(amount * 100)::bigint INTO v_cents
  FROM get_bottom_line_pnl(CURRENT_DATE - 2, CURRENT_DATE)
  WHERE line_item = 'Revenue';
  SELECT ROUND(amount * 100)::bigint INTO v_cogs
  FROM get_bottom_line_pnl(CURRENT_DATE - 2, CURRENT_DATE)
  WHERE line_item = 'Cost of Goods Sold';
  IF v_cents - v_pnl_revenue_before <> -1000
     OR v_cogs - v_pnl_cogs_before <> 501 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: durable PNL predicate delta revenue=% cogs=% (expected -1000/501)',
      v_cents - v_pnl_revenue_before, v_cogs - v_pnl_cogs_before;
  END IF;

  v_res := get_monthly_summary(CURRENT_DATE - 2, CURRENT_DATE);
  IF (v_res #>> '{invoices,posted_count}')::bigint - v_monthly_posted_before <> 4
     OR (v_res #>> '{invoices,total_amount_cents}')::bigint - v_monthly_amount_before <> -1000
     OR (v_res #>> '{invoices,total_cost_cents}')::numeric - v_monthly_cost_before <> 501 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: durable monthly predicate delta posted=% amount=% cost=% (expected 4/-1000/501)',
      (v_res #>> '{invoices,posted_count}')::bigint - v_monthly_posted_before,
      (v_res #>> '{invoices,total_amount_cents}')::bigint - v_monthly_amount_before,
      (v_res #>> '{invoices,total_cost_cents}')::numeric - v_monthly_cost_before;
  END IF;

  -- --------------------------------------------------------------------
  -- 8b. Apply Credit lost-response replay + both shared reversal callers.
  -- The first exact retry stands in for "commit succeeded, response lost".
  -- --------------------------------------------------------------------
  INSERT INTO field_app_billing_sets (created_by)
  VALUES (v_admin)
  RETURNING id INTO v_billing_set_id;
  INSERT INTO field_app_billing_lines (
    billing_set_id, line_kind, description, source_quantity,
    source_unit_price_cents, source_line_cents
  ) VALUES (
    v_billing_set_id, 'chemical', '[SMOKE] reversal snapshot sentinel', 1, 5000, 5000
  ) RETURNING id INTO v_billing_line_id;
  INSERT INTO invoices (
    invoice_number, customer_id, invoice_type, status, invoice_date, due_date,
    total_amount_cents, created_by, field_app_billing_set_id
  ) VALUES (
    'SMK-RCC-TARGET-' || v_suffix, v_customer_id, 'chemical_sale', 'draft',
    CURRENT_DATE, CURRENT_DATE - 1, 5000, v_admin, v_billing_set_id
  ) RETURNING id INTO v_target_invoice_id;
  INSERT INTO invoice_items (
    invoice_id, product_id, description, quantity, unit_price_cents,
    extended_cents, cost_cents, billing_line_id
  ) VALUES (
    v_target_invoice_id, v_product_id, '[SMOKE] reversal snapshot sentinel',
    1, 5000, 5000, 0, v_billing_line_id
  ) RETURNING id INTO v_target_invoice_item_id;
  INSERT INTO invoice_line_shares (
    billing_line_id, invoice_item_id, customer_id, split_mode,
    split_micro_pct, allocated_quantity, base_unit_price_cents,
    base_price_source, price_mode, unit_price_cents, amount_cents,
    calculation_hash, vector_hash, created_by
  ) VALUES (
    v_billing_line_id, v_target_invoice_item_id, v_customer_id, 'field_default',
    100000000, 1, 5000, 'manual', 'default', 5000, 5000,
    'smoke-calculation', 'smoke-vector', v_admin
  );
  UPDATE invoices SET status = 'posted', posted_at = now() WHERE id = v_target_invoice_id;
  SELECT count(*) INTO v_n FROM invoice_line_share_snapshots WHERE invoice_id = v_target_invoice_id;
  IF v_n <> 1 THEN RAISE EXCEPTION 'SMOKE_FAIL: initial post produced % split snapshots, expected 1', v_n; END IF;

  v_application_id := apply_credit_memo_to_invoice(
    v_credit_id2, v_target_invoice_id, 5000, v_admin,
    'smk-rcc-' || v_suffix || '-apply-lost-response'
  );
  v_uuid := apply_credit_memo_to_invoice(
    v_credit_id2, v_target_invoice_id, 5000, v_admin,
    'smk-rcc-' || v_suffix || '-apply-lost-response'
  );
  IF v_uuid IS DISTINCT FROM v_application_id THEN
    RAISE EXCEPTION 'SMOKE_FAIL: lost-response Apply Credit retry returned another application';
  END IF;
  SELECT count(*) INTO v_n FROM credit_memo_applications
   WHERE credit_memo_id = v_credit_id2 AND target_invoice_id = v_target_invoice_id;
  IF v_n <> 1 THEN RAISE EXCEPTION 'SMOKE_FAIL: lost-response Apply Credit retry created % applications', v_n; END IF;

  v_res := reverse_credit_memo_application(
    v_application_id, '[SMOKE] explicit reversal', v_admin,
    'smk-rcc-' || v_suffix || '-reverse-application'
  );
  SELECT status INTO v_status FROM invoices WHERE id = v_target_invoice_id;
  IF v_status <> 'overdue' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: explicit reversal restored past-due invoice to %, expected overdue', v_status;
  END IF;
  SELECT count(*) INTO v_n FROM invoice_line_share_snapshots WHERE invoice_id = v_target_invoice_id;
  IF v_n <> 1 THEN RAISE EXCEPTION 'SMOKE_FAIL: reversal created an extra post snapshot (count %)', v_n; END IF;

  -- A corrected-forward due date makes overdue -> posted a valid re-derivation.
  -- The helper must cross the existing transition trigger only through its
  -- narrowly scoped trusted override, then restore that setting immediately.
  v_application_id := apply_credit_memo_to_invoice(
    v_credit_id2, v_target_invoice_id, 5000, v_admin,
    'smk-rcc-' || v_suffix || '-apply-before-forward-due-reversal'
  );
  UPDATE invoices
     SET due_date = CURRENT_DATE + 7,
         status = 'overdue'
   WHERE id = v_target_invoice_id;
  v_res := reverse_credit_memo_application(
    v_application_id, '[SMOKE] corrected-forward due date', v_admin,
    'smk-rcc-' || v_suffix || '-reverse-forward-due'
  );
  SELECT status INTO v_status FROM invoices WHERE id = v_target_invoice_id;
  IF v_status <> 'posted' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: corrected-forward reversal restored invoice to %, expected posted', v_status;
  END IF;
  SELECT count(*) INTO v_n FROM invoice_line_share_snapshots WHERE invoice_id = v_target_invoice_id;
  IF v_n <> 1 THEN RAISE EXCEPTION 'SMOKE_FAIL: corrected-forward reversal created an extra post snapshot (count %)', v_n; END IF;

  UPDATE invoices SET due_date = CURRENT_DATE - 1 WHERE id = v_target_invoice_id;
  v_application_id := apply_credit_memo_to_invoice(
    v_credit_id2, v_target_invoice_id, 5000, v_admin,
    'smk-rcc-' || v_suffix || '-apply-before-unapply'
  );
  v_res := unapply_credit_memo(
    v_credit_id2, '[SMOKE] unapply with active application', v_admin,
    'smk-rcc-' || v_suffix || '-unapply-with-application'
  );
  SELECT status INTO v_status FROM invoices WHERE id = v_target_invoice_id;
  IF v_status <> 'overdue' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: unapply restored past-due invoice to %, expected overdue', v_status;
  END IF;
  SELECT count(*) INTO v_n FROM credit_memo_applications
   WHERE credit_memo_id = v_credit_id2 AND reversed_at IS NULL;
  IF v_n <> 0 THEN RAISE EXCEPTION 'SMOKE_FAIL: unapply left % active credit applications', v_n; END IF;

  SELECT count(*) INTO v_n
    FROM idempotency_keys
   WHERE request_actor_id = v_admin
     AND request_fingerprint ~ '^[0-9a-f]{64}$'
     AND (idempotency_key, operation) IN (
       ('smk-rcc-' || v_suffix || '-create', 'create_return'),
       ('smk-rcc-' || v_suffix || '-approve', 'approve_return'),
       ('smk-rcc-' || v_suffix || '-reject', 'reject_return'),
       ('smk-rcc-' || v_suffix || '-cancel', 'cancel_return'),
       ('smk-rcc-' || v_suffix || '-receive', 'receive_return'),
       ('smk-rcc-' || v_suffix || '-issue', 'issue_return_credit')
     );
  IF v_n <> 6 THEN RAISE EXCEPTION 'SMOKE_FAIL: only % of six return receipts carry actor+fingerprint binding', v_n; END IF;

  -- --------------------------------------------------------------------
  -- 11. One-time legacy compatibility is pinned to the exact production RMA
  --    and immutable line values. Any other source-free row -- even one
  --    backdated before the hardening boundary -- must remain blocked.
  -- --------------------------------------------------------------------
  v_legacy_return_id := '0cb556ed-467a-4949-866d-8d9edbb09522'::uuid;
  IF NOT EXISTS (
    SELECT 1 FROM returns
    WHERE id = v_legacy_return_id AND status = 'approved' AND order_id IS NULL
  ) THEN
    RAISE EXCEPTION 'SMOKE_SETUP: exact legacy RMA is not in the expected approved state';
  END IF;

  v_res := receive_return(
    v_legacy_return_id, v_admin, 'smk-rcc-' || v_suffix || '-legacy-receive'
  );
  IF v_res->>'status' IS DISTINCT FROM 'received' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: legacy receive returned %', v_res;
  END IF;
  v_res := issue_return_credit(
    v_legacy_return_id, v_admin, 'smk-rcc-' || v_suffix || '-legacy-credit'
  );
  IF COALESCE((v_res->>'credit_amount_cents')::bigint, 0) <> 113955 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: legacy credit returned % (expected 113955 cents)', v_res;
  END IF;

  PERFORM set_config('app.return_rpc', 'true', true);
  INSERT INTO returns (
    return_number, customer_id, order_id, reason, requested_by, status,
    approved_by, approved_at, created_at
  ) VALUES (
    'SMK-FORGED-LEGACY-' || v_suffix, v_customer_id, NULL, 'overstock', v_admin,
    'approved', v_admin, now(), timestamptz '2026-04-30 20:48:18+00'
  ) RETURNING id INTO v_future_unlinked_return_id;
  INSERT INTO return_items (
    return_id, order_item_id, product_id, product_name, quantity, unit,
    unit_price_cents, extended_cents, condition, restock
  ) VALUES (
    v_future_unlinked_return_id, NULL, v_product_id, '[SMOKE] forbidden source-free line',
    1, 'gal', 7597, 7597, 'unopened', true
  );
  BEGIN
    PERFORM receive_return(
      v_future_unlinked_return_id, v_admin, 'smk-rcc-' || v_suffix || '-forged-legacy-unlinked'
    );
    RAISE EXCEPTION 'SMOKE_FAIL: new source-free return was received';
  EXCEPTION WHEN OTHERS THEN
    v_reason := SQLERRM;
    IF v_reason LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_reason NOT LIKE 'RETURN_SOURCE_NOT_VERIFIED%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: expected source-free receive rejection, got %', v_reason;
    END IF;
  END;

  -- --------------------------------------------------------------------
  -- Full chain passed - force rollback of everything above.
  -- --------------------------------------------------------------------
  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END $smoke$;
