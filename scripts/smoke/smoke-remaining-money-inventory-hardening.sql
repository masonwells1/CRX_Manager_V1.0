-- Rolled-back business proof for the final 2026-07-14 money/inventory hardening.
-- Product fixtures bypass the unrelated governed-pricing write trigger inside
-- this transaction; the terminal pass exception restores it with all fixtures.
BEGIN;
ALTER TABLE public.products DISABLE TRIGGER USER;

DO $smoke$
DECLARE
  v_admin uuid;
  v_sales uuid;
  v_customer uuid;
  v_product uuid;
  v_order uuid;
  v_po uuid;
  v_po_item uuid;
  v_before_dashboard jsonb;
  v_after_dashboard jsonb;
  v_dashboard_key text;
  v_group_by text;
  v_group_key text;
  v_profit record;
  v_before_month_revenue numeric := 0;
  v_before_month_cost numeric := 0;
  v_before_month_profit numeric := 0;
  v_before_month_margin numeric := 0;
  v_before_month_orders bigint := 0;
  v_before_month_units numeric := 0;
  v_after_month_revenue numeric := 0;
  v_after_month_cost numeric := 0;
  v_after_month_profit numeric := 0;
  v_after_month_margin numeric := 0;
  v_after_month_orders bigint := 0;
  v_after_month_units numeric := 0;
  v_qty numeric;
  v_received numeric;
  v_count bigint;
  v_err text;
  v_suffix text := substr(md5(random()::text), 1, 8);
BEGIN
  SELECT id INTO v_admin FROM profiles
  WHERE role = 'admin' AND is_active = true ORDER BY created_at LIMIT 1;
  SELECT id INTO v_sales FROM profiles
  WHERE role = 'sales_rep' AND is_active = true ORDER BY created_at LIMIT 1;
  IF v_admin IS NULL OR v_sales IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: active admin and sales_rep required';
  END IF;

  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);

  SELECT financial_dashboard_summary()
    INTO v_before_dashboard;

  -- The month bucket is shared with real current-date orders. Capture its
  -- exact baseline so this smoke proves only the fixture's delta and never
  -- assumes an otherwise empty production month.
  SELECT
    COALESCE(MAX(total_revenue), 0),
    COALESCE(MAX(total_cost), 0),
    COALESCE(MAX(total_profit), 0),
    COALESCE(MAX(margin_pct), 0),
    COALESCE(MAX(order_count), 0),
    COALESCE(MAX(units_sold), 0)
  INTO
    v_before_month_revenue,
    v_before_month_cost,
    v_before_month_profit,
    v_before_month_margin,
    v_before_month_orders,
    v_before_month_units
  FROM get_profitability_report('month', CURRENT_DATE, CURRENT_DATE)
  WHERE group_key = to_char(CURRENT_DATE, 'YYYY-MM');

  INSERT INTO customers (farm_name)
  VALUES ('[SMOKE] Voided Sales ' || v_suffix) RETURNING id INTO v_customer;
  INSERT INTO products (product_name, category, current_cost)
  VALUES ('[SMOKE] Voided Product ' || v_suffix, 'Herbicide', 40)
  RETURNING id INTO v_product;
  INSERT INTO orders (
    order_number, customer_id, salesman_id, order_date, status,
    total_price, total_profit
  ) VALUES (
    'SMK-VOID-' || v_suffix, v_customer, v_sales, CURRENT_DATE, 'confirmed',
    1000, 600
  ) RETURNING id INTO v_order;
  INSERT INTO order_items (
    order_id, product_id, product_name, price_per_unit, cost_per_unit,
    total_units_needed, unit_size, total_price, profit, quantity_remaining
  ) VALUES (
    v_order, v_product, '[SMOKE] Voided Product ' || v_suffix, 100, 40,
    10, 'gal', 1000, 600, 10
  );
  -- Use the real lifecycle path: confirmed -> fulfilled, then the audited void RPC.
  UPDATE orders SET status = 'fulfilled' WHERE id = v_order;

  -- Positive control for the new canonical profitability RPC. Every grouping
  -- must settle the same line revenue/cost basis before the void exclusion is
  -- tested below; a query that simply returns no rows must not pass this smoke.
  FOREACH v_group_by IN ARRAY ARRAY['customer', 'product'] LOOP
    v_group_key := CASE v_group_by
      WHEN 'customer' THEN '[SMOKE] Voided Sales ' || v_suffix
      WHEN 'product' THEN '[SMOKE] Voided Product ' || v_suffix
    END;
    SELECT * INTO v_profit
    FROM get_profitability_report(v_group_by, CURRENT_DATE, CURRENT_DATE)
    WHERE group_key = v_group_key;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'SMOKE_FAIL: profitability % grouping omitted active control row %',
        v_group_by, v_group_key;
    END IF;
    IF ROW(
         v_profit.total_revenue,
         v_profit.total_cost,
         v_profit.total_profit,
         v_profit.margin_pct,
         v_profit.order_count,
         v_profit.units_sold
       ) IS DISTINCT FROM ROW(
         1000::numeric,
         400::numeric,
         600::numeric,
         60.0::numeric,
         1::bigint,
         10::numeric
       ) THEN
      RAISE EXCEPTION 'SMOKE_FAIL: profitability % grouping returned wrong money/count/units: %',
        v_group_by, row_to_json(v_profit);
    END IF;
  END LOOP;

  SELECT * INTO v_profit
  FROM get_profitability_report('month', CURRENT_DATE, CURRENT_DATE)
  WHERE group_key = to_char(CURRENT_DATE, 'YYYY-MM');
  IF NOT FOUND OR ROW(
       v_profit.total_revenue,
       v_profit.total_cost,
       v_profit.total_profit,
       v_profit.margin_pct,
       v_profit.order_count,
       v_profit.units_sold
     ) IS DISTINCT FROM ROW(
       v_before_month_revenue + 1000,
       v_before_month_cost + 400,
       v_before_month_profit + 600,
       ROUND(
         ((v_before_month_profit + 600) / NULLIF(v_before_month_revenue + 1000, 0)) * 100,
         1
       ),
       v_before_month_orders + 1,
       v_before_month_units + 10
     ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: profitability month grouping returned wrong fixture delta: %',
      row_to_json(v_profit);
  END IF;

  PERFORM void_order(
    v_order,
    v_admin,
    'SMOKE report exclusion',
    'smk-void-report-' || v_suffix
  );

  SELECT count(*) INTO v_count
  FROM get_sales_detail_report(
    CURRENT_DATE, CURRENT_DATE, NULL, ARRAY[v_customer], NULL, NULL, NULL
  );
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: voided order appeared in sales detail';
  END IF;

  SELECT count(*) INTO v_count
  FROM get_sales_summary_report(
    'customer', CURRENT_DATE, CURRENT_DATE, NULL, ARRAY[v_customer], NULL, NULL, NULL
  );
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: voided order appeared in sales summary';
  END IF;

  SELECT count(*) INTO v_count
  FROM get_gross_sales_report(CURRENT_DATE, CURRENT_DATE, 'product')
  WHERE group_name = '[SMOKE] Voided Product ' || v_suffix;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: voided order appeared in gross sales';
  END IF;

  FOREACH v_group_by IN ARRAY ARRAY['customer', 'product'] LOOP
    v_group_key := CASE v_group_by
      WHEN 'customer' THEN '[SMOKE] Voided Sales ' || v_suffix
      WHEN 'product' THEN '[SMOKE] Voided Product ' || v_suffix
    END;
    SELECT count(*) INTO v_count
    FROM get_profitability_report(v_group_by, CURRENT_DATE, CURRENT_DATE)
    WHERE group_key = v_group_key;
    IF v_count <> 0 THEN
      RAISE EXCEPTION 'SMOKE_FAIL: voided order appeared in profitability % grouping',
        v_group_by;
    END IF;
  END LOOP;

  SELECT
    COALESCE(MAX(total_revenue), 0),
    COALESCE(MAX(total_cost), 0),
    COALESCE(MAX(total_profit), 0),
    COALESCE(MAX(margin_pct), 0),
    COALESCE(MAX(order_count), 0),
    COALESCE(MAX(units_sold), 0)
  INTO
    v_after_month_revenue,
    v_after_month_cost,
    v_after_month_profit,
    v_after_month_margin,
    v_after_month_orders,
    v_after_month_units
  FROM get_profitability_report('month', CURRENT_DATE, CURRENT_DATE)
  WHERE group_key = to_char(CURRENT_DATE, 'YYYY-MM');
  IF ROW(
       v_after_month_revenue,
       v_after_month_cost,
       v_after_month_profit,
       v_after_month_margin,
       v_after_month_orders,
       v_after_month_units
     ) IS DISTINCT FROM ROW(
       v_before_month_revenue,
       v_before_month_cost,
       v_before_month_profit,
       v_before_month_margin,
       v_before_month_orders,
       v_before_month_units
     ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: voided order changed profitability month baseline';
  END IF;

  SELECT financial_dashboard_summary()
    INTO v_after_dashboard;
  FOREACH v_dashboard_key IN ARRAY ARRAY[
    'total_revenue',
    'total_profit',
    'overall_margin',
    'monthly_revenue',
    'top_customers',
    'bottom_products_by_margin',
    'bottom_customers_by_margin',
    'monthly_margin_trend'
  ] LOOP
    IF (v_after_dashboard -> v_dashboard_key)
       IS DISTINCT FROM (v_before_dashboard -> v_dashboard_key) THEN
      RAISE EXCEPTION 'SMOKE_FAIL: voided order changed dashboard key % from % to %',
        v_dashboard_key,
        v_before_dashboard -> v_dashboard_key,
        v_after_dashboard -> v_dashboard_key;
    END IF;
  END LOOP;

  -- A token for a now-inactive profile is rejected by both inventory and reports.
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  UPDATE profiles SET is_active = false WHERE id = v_sales;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_sales, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_sales::text, true);
  BEGIN
    PERFORM receive_po_items('[]'::jsonb, v_sales, 'smk-po-inactive-' || v_suffix, false);
    RAISE EXCEPTION 'SMOKE_FAIL: inactive sales_rep received inventory';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'Only admin or sales_rep can receive PO items%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong inactive receive error: %', v_err;
    END IF;
  END;
  BEGIN
    PERFORM get_gross_sales_report(CURRENT_DATE, CURRENT_DATE, 'product');
    RAISE EXCEPTION 'SMOKE_FAIL: inactive sales_rep read gross sales';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'Access denied: active admin or sales_rep role required%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong inactive report error: %', v_err;
    END IF;
  END;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  UPDATE profiles SET is_active = true WHERE id = v_sales;

  -- Positive control: an active admin can deliberately receive 11 against 10.
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  INSERT INTO inventory (
    product_id, location, quantity_available, quantity_on_order, quantity_prebooked, unit_size
  ) VALUES (v_product, 'Main Warehouse', 0, 10, 0, 'gal');
  INSERT INTO purchase_orders (po_number, vendor, status, created_by)
  VALUES ('SMK-PO-' || v_suffix, '[SMOKE] Vendor', 'submitted', v_admin)
  RETURNING id INTO v_po;
  INSERT INTO purchase_order_items (
    purchase_order_id, product_id, quantity_ordered, quantity_received, unit_cost, unit_size
  ) VALUES (v_po, v_product, 10, 0, 40, 'gal')
  RETURNING id INTO v_po_item;

  -- A sales rep cannot authorize a real over-receipt even with a reason.
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_sales, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_sales::text, true);
  BEGIN
    PERFORM receive_po_items(
      jsonb_build_array(jsonb_build_object(
        'po_item_id', v_po_item,
        'quantity', 11,
        'over_receive_reason', 'SMOKE sales must not authorize'
      )),
      v_sales,
      'smk-po-sales-over-' || v_suffix,
      true
    );
    RAISE EXCEPTION 'SMOKE_FAIL: sales_rep authorized over-receive';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'OVER_RECEIVE_ADMIN_REQUIRED%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong sales over-receive error: %', v_err;
    END IF;
  END;

  -- NULL must behave like false, not bypass both boolean guards through SQL's
  -- three-valued logic. A sales rep still cannot over-receive.
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_sales, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_sales::text, true);
  BEGIN
    PERFORM receive_po_items(
      jsonb_build_array(jsonb_build_object(
        'po_item_id', v_po_item,
        'quantity', 11
      )),
      v_sales,
      'smk-po-sales-null-' || v_suffix,
      NULL
    );
    RAISE EXCEPTION 'SMOKE_FAIL: sales_rep bypassed over-receive with NULL';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'Cannot receive more than ordered for item %' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong NULL over-receive error: %', v_err;
    END IF;
  END;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);

  PERFORM receive_po_items(
    jsonb_build_array(jsonb_build_object(
      'po_item_id', v_po_item,
      'quantity', 11,
      'condition', 'good',
      'notes', 'SMOKE admin-authorized vendor over-shipment',
      'over_receive_reason', 'SMOKE vendor shipped one extra unit'
    )),
    v_admin,
    'smk-po-admin-' || v_suffix,
    true
  );
  SELECT quantity_available INTO v_qty
  FROM inventory WHERE product_id = v_product AND location = 'Main Warehouse';
  SELECT quantity_received INTO v_received
  FROM purchase_order_items WHERE id = v_po_item;
  IF v_qty <> 11 OR v_received <> 11 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: admin over-receive produced inventory/item %/%',
      v_qty, v_received;
  END IF;

  -- Direct payment-table writes are no longer an authenticated path.
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'payments'
      AND cmd IN ('INSERT', 'UPDATE', 'DELETE', 'ALL')
  ) OR has_table_privilege('authenticated', 'public.payments', 'INSERT')
     OR has_table_privilege('authenticated', 'public.payments', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.payments', 'DELETE')
     OR has_table_privilege('authenticated', 'public.payments', 'TRUNCATE') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: direct authenticated payment write path remains';
  END IF;
  IF has_function_privilege(
       'anon',
       'public.get_gross_sales_report(date,date,text)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: anonymous gross-sales execution remains';
  END IF;
  IF has_function_privilege(
       'anon',
       'public.get_profitability_report(text,date,date)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: anonymous profitability execution remains';
  END IF;

  UPDATE profiles SET is_active = false WHERE id = v_admin;
  BEGIN
    PERFORM financial_dashboard_summary();
    RAISE EXCEPTION 'SMOKE_FAIL: inactive admin read financial dashboard';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'permission denied: admin role required%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong inactive dashboard error: %', v_err;
    END IF;
  END;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END $smoke$;
