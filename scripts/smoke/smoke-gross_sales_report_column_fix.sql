-- ============================================================================
-- SMOKE TEST (rolled back by design): get_gross_sales_report column fix
-- ----------------------------------------------------------------------------
-- Verifies scripts/.staging-migrations/gross_sales_report_column_fix.sql:
--   * the previously-42703 'salesman' branch (Reports.tsx sends
--     p_group_by='salesman', which lands in the function's ELSE branch)
--     returns rows for a seeded order+invoice — no 42703;
--   * sales-rep attribution resolves via the CORRECTED column
--     (orders.salesman_id -> profiles.full_name): the fixture order seeded
--     with salesman_id = <real active admin> comes back grouped under that
--     admin's full_name with the exact expected money figures;
--   * the DELTA-2 label: a second fixture order with salesman_id NULL comes
--     back as 'Unassigned' (not a blank/NULL group_name);
--   * the untouched 'product' and 'customer' branches still aggregate the
--     same fixtures correctly (regression guard on the verbatim sections).
--
-- The DO block ALWAYS ends in RAISE EXCEPTION — on success it raises
-- 'SMOKE_PASS_ROLLBACK' — so nothing here ever commits. Any other error = FAIL.
--
-- Auth: the function is invoker-rights (NOT SECDEF) with no in-body role gate;
-- RLS of the caller is the data gate. The smoke still sets
-- request.jwt.claims to a REAL active admin profile id (is_local => true, at
-- the top level of the DO body per the smoke template) so auth.uid() resolves
-- and the call mirrors the production caller context.
--
-- Fixtures: all [SMOKE]-prefixed, isolated in Jan 1999 (no live orders exist
-- in that window; assertions additionally pin exact totals). Sequence-backed
-- defaults are bypassed with explicit values (customers.account_number,
-- invoices.invoice_number) so a rollback leaves NO sequence gaps.
--
-- DRY-VALIDATED REFERENCES (every table/column/function below was checked
-- against the LIVE catalog on 2026-06-10 — the 42703 discipline):
--   profiles:    id, full_name, role, is_active, created_at
--   customers:   id, farm_name, account_number
--   products:    id, product_name   (only NOT-NULL-without-default column is
--                product_name; BEFORE triggers validate_product_units /
--                calculate_prices_from_margin no-op when unit/cost fields
--                are left at defaults)
--   orders:      id, order_number, customer_id, order_date, salesman_id,
--                status (default 'confirmed' IS in orders_status_check),
--                total_price, total_profit, deleted_at
--                (FK orders_salesman_id_fkey -> profiles.id)
--   order_items: order_id, product_id, product_name, price_per_unit,
--                cost_per_unit, total_units_needed, total_price, profit
--                (AFTER trigger after_order_items_change recalcs the parent
--                order's total_price/total_cost/total_profit from items;
--                BEFORE trigger _snapshot_order_item_cost only fills
--                cost_at_time_cents — both side-effect-safe here)
--   invoices:    invoice_number, order_id, customer_id, invoice_type
--                ('chemical_sale' IS in invoices_invoice_type_check),
--                status ('draft' IS in invoices_status_check; BEFORE INSERT
--                trigger trg_invoice_draft_insert ACCEPTS draft),
--                invoice_date, total_amount_cents (bigint cents), created_by
--                (no FK on created_by; balance_cents is GENERATED — never
--                inserted here)
--   functions:   public.get_gross_sales_report(date,date,text) — exactly 1
--                overload live (oid 29223); set_config / json_build_object
--                builtins
-- ============================================================================

DO $smoke$
DECLARE
  v_admin_id    uuid;
  v_admin_name  text;
  v_customer_id uuid;
  v_product_id  uuid;
  v_order1_id   uuid;
  v_order2_id   uuid;
  v_rows        int;
BEGIN
  -- --------------------------------------------------------------------
  -- 0. Real active admin profile (for jwt claims + salesman attribution)
  -- --------------------------------------------------------------------
  SELECT pr.id, pr.full_name INTO v_admin_id, v_admin_name
  FROM public.profiles pr
  WHERE pr.role = 'admin' AND pr.is_active = true
  ORDER BY pr.created_at
  LIMIT 1;
  IF v_admin_id IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: no active admin profile found';
  END IF;

  -- Top-level claims (transaction-local; rolled back with everything else).
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_admin_id, 'role', 'authenticated')::text, true);

  -- --------------------------------------------------------------------
  -- 1. Fixtures ([SMOKE] prefixed; Jan 1999 isolation window)
  -- --------------------------------------------------------------------
  INSERT INTO public.customers (farm_name, account_number)
  VALUES ('[SMOKE] GSR Farm', '[SMOKE]-GSR-ACCT-1')
  RETURNING id INTO v_customer_id;

  INSERT INTO public.products (product_name)
  VALUES ('[SMOKE] GSR Product')
  RETURNING id INTO v_product_id;

  -- Order 1: attributed to the admin rep (exercises the corrected column).
  INSERT INTO public.orders (order_number, customer_id, order_date, salesman_id)
  VALUES ('[SMOKE]-GSR-ORD-1', v_customer_id, DATE '1999-01-15', v_admin_id)
  RETURNING id INTO v_order1_id;

  -- Order 2: NO rep (exercises the DELTA-2 'Unassigned' label).
  INSERT INTO public.orders (order_number, customer_id, order_date, salesman_id)
  VALUES ('[SMOKE]-GSR-ORD-2', v_customer_id, DATE '1999-01-15', NULL)
  RETURNING id INTO v_order2_id;

  -- Items: the AFTER trigger recalcs each order's totals from these rows:
  --   order 1 -> total_price 1500.00, total_cost 1000.00, total_profit 500.00
  --   order 2 -> total_price  200.00, total_cost  150.00, total_profit  50.00
  INSERT INTO public.order_items
    (order_id, product_id, product_name, price_per_unit, cost_per_unit, total_units_needed, total_price, profit)
  VALUES
    (v_order1_id, v_product_id, '[SMOKE] GSR Product', 15.00, 10.00, 100, 1500.00, 500.00),
    (v_order2_id, v_product_id, '[SMOKE] GSR Product',  2.00,  1.50, 100,  200.00,  50.00);

  -- Invoice on order 1 (required scenario: order+invoice for the fixture
  -- customer; explicit invoice_number bypasses next_invoice_number()).
  INSERT INTO public.invoices
    (invoice_number, order_id, customer_id, invoice_type, status, invoice_date, total_amount_cents, created_by)
  VALUES
    ('[SMOKE]-GSR-INV-1', v_order1_id, v_customer_id, 'chemical_sale', 'draft', DATE '1999-01-15', 150000, v_admin_id);

  -- --------------------------------------------------------------------
  -- 2. Scenario A — the fixed 'salesman' branch (was 42703 on every call)
  -- --------------------------------------------------------------------
  SELECT count(*) INTO v_rows
  FROM public.get_gross_sales_report(DATE '1999-01-01', DATE '1999-01-31', 'salesman');
  IF v_rows < 2 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: salesman branch returned % row(s), expected >= 2 (rep + Unassigned)', v_rows;
  END IF;

  -- A1: attribution resolves via orders.salesman_id -> profiles.full_name.
  IF NOT EXISTS (
    SELECT 1
    FROM public.get_gross_sales_report(DATE '1999-01-01', DATE '1999-01-31', 'salesman') r
    WHERE r.group_name   = v_admin_name
      AND r.total_revenue = 1500.00
      AND r.total_cost    = 1000.00
      AND r.gross_profit  = 500.00
      AND r.order_count   = 1
  ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: rep attribution row for "%" (1500/1000/500, 1 order) not found', v_admin_name;
  END IF;

  -- A2: NULL-rep order is labelled 'Unassigned' (DELTA-2), not NULL/blank.
  IF NOT EXISTS (
    SELECT 1
    FROM public.get_gross_sales_report(DATE '1999-01-01', DATE '1999-01-31', 'salesman') r
    WHERE r.group_name    = 'Unassigned'
      AND r.total_revenue = 200.00
      AND r.gross_profit  = 50.00
      AND r.order_count   = 1
  ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: Unassigned (NULL salesman_id) row missing or mislabelled';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.get_gross_sales_report(DATE '1999-01-01', DATE '1999-01-31', 'salesman') r
    WHERE r.group_name IS NULL
  ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: NULL group_name row leaked from the salesman branch';
  END IF;

  -- --------------------------------------------------------------------
  -- 3. Scenario B — 'product' branch regression guard (verbatim section)
  -- --------------------------------------------------------------------
  IF NOT EXISTS (
    SELECT 1
    FROM public.get_gross_sales_report(DATE '1999-01-01', DATE '1999-01-31', 'product') r
    WHERE r.group_name    = '[SMOKE] GSR Product'
      AND r.total_revenue = 1700.00
      AND r.total_cost    = 1150.00
      AND r.gross_profit  = 550.00
      AND r.units_sold    = 200.00
      AND r.order_count   = 2
  ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: product branch row for [SMOKE] GSR Product (1700/1150/550, 200 units, 2 orders) not found';
  END IF;

  -- --------------------------------------------------------------------
  -- 4. Scenario C — 'customer' branch regression guard (verbatim section)
  -- --------------------------------------------------------------------
  IF NOT EXISTS (
    SELECT 1
    FROM public.get_gross_sales_report(DATE '1999-01-01', DATE '1999-01-31', 'customer') r
    WHERE r.group_name    = '[SMOKE] GSR Farm'
      AND r.total_revenue = 1700.00
      AND r.total_cost    = 1150.00
      AND r.gross_profit  = 550.00
      AND r.order_count   = 2
  ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: customer branch row for [SMOKE] GSR Farm (1700/1150/550, 2 orders) not found';
  END IF;

  -- --------------------------------------------------------------------
  -- All scenarios passed — roll everything back.
  -- --------------------------------------------------------------------
  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END $smoke$;
