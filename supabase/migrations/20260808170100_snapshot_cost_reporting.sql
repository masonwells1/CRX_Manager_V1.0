-- 20260808170100 — snapshot-cost report unification
--
-- WHY: report surfaces disagreed on what a line "cost". Some RPCs read the
-- MUTABLE order_items.cost_per_unit (drifts when a product cost is edited
-- after the sale), the dashboard's customer/month margin CTEs read the stored
-- orders.total_cost/total_profit header columns, and Reports.tsx did its own
-- client-side grouping over those same stored header numbers. The immutable
-- as-of-sale snapshot has existed since 20260513050000:
-- order_items.cost_at_time_cents (bigint cents, trigger-filled, backfilled).
--
-- THIS MIGRATION: every ORDER-BASIS report RPC rewritten here (the surfaces
-- listed in the numbered sections below) now derives line cost from ONE
-- canonical expression — the snapshot with a legacy fallback:
--
--     COALESCE(oi.cost_at_time_cents / 100.0, oi.cost_per_unit, 0)
--
-- and derives profit/margin from that same cost (revenue - snapshot cost)
-- instead of the stored oi.profit / order header columns. The rewritten RPCs
-- go fully item-level; the stored order header columns are left unchanged.
-- Floor inventory valuation intentionally stays on live products.current_cost
-- (correct for on-hand value). Also adds get_profitability_report so
-- Reports.tsx profitability tabs read the same canonical numbers instead of
-- re-implementing the math client-side.
--
-- TWO-BASIS REALITY (deliberate, not unified here): the INVOICE-basis RPCs —
-- get_bottom_line_pnl, get_monthly_summary, and field profitability — still
-- derive cost from invoice_items.cost_cents (invoice cost), and they carry
-- the credit-memo COGS reversal added by sibling 20260808170000. The
-- order-basis surfaces rewritten here never read invoices and exclude
-- returns by design, so the two report families can legitimately differ for
-- periods containing returns or invoice/order cost divergence. Unifying the
-- invoice-basis family onto the snapshot expression is an explicit follow-up,
-- out of scope for this migration.
--
-- Signatures, guards, volatility, security modes, and grants of the replaced
-- functions are preserved exactly.
--
-- caller-analysis: get_gross_sales_report :: REVOKE here only re-emits the exact 20260714223000 boundary (REVOKE PUBLIC/anon, then GRANT authenticated + service_role in this same migration); the sole UI caller src/pages/Reports.tsx:265 runs as authenticated and keeps EXECUTE, so no caller loses access.
-- caller-analysis: get_profitability_report :: new function created in this migration; its only caller is the new authenticated Reports.tsx callsite added in this same branch, and authenticated + service_role are granted EXECUTE below.

-- -----------------------------------------------------------------------------
-- 0. Keep the snapshot honest across a product swap.
--
-- trg_snapshot_order_item_cost (20260513050000) only fires BEFORE INSERT, so a
-- line whose product is swapped later keeps the previous product's cost. That
-- was tolerable while the reports read cost_per_unit; once the reports below
-- make cost_at_time_cents the canonical basis, a valid mid-order product swap
-- would silently report the old product's cost. update_order_items performs the
-- swap as an in-place UPDATE of product_id + cost_per_unit, so the re-stamp
-- belongs on the table where every path is covered, not in that one RPC.
--
-- The re-stamp only fires when the caller left the snapshot alone; a caller that
-- deliberately supplies a new snapshot (e.g. a vendor invoice cost) still wins,
-- matching the INSERT trigger's "only if not pre-populated" contract.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._resnapshot_order_item_cost_on_product_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.cost_at_time_cents IS NOT DISTINCT FROM OLD.cost_at_time_cents
     AND NEW.product_id IS NOT NULL THEN
    -- COALESCE, not a bare assignment. A product whose current_cost is NULL
    -- would otherwise erase a previously valid snapshot, and every report in
    -- this migration would silently fall back to the mutable cost_per_unit,
    -- which is the exact drift this migration exists to remove. Keeping the
    -- prior snapshot is imprecise for the new product but far better than
    -- destroying the cost basis outright.
    SELECT COALESCE(ROUND(current_cost * 100)::bigint, OLD.cost_at_time_cents)
      INTO NEW.cost_at_time_cents
    FROM public.products WHERE id = NEW.product_id;
  END IF;
  RETURN NEW;
END;
$$;

-- caller-analysis: _resnapshot_order_item_cost_on_product_change :: brand-new trigger-only helper created in this migration; no rpc callsites exist, trigger execution does not require caller EXECUTE.
REVOKE ALL ON FUNCTION public._resnapshot_order_item_cost_on_product_change() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_resnapshot_order_item_cost ON public.order_items;
CREATE TRIGGER trg_resnapshot_order_item_cost
  BEFORE UPDATE ON public.order_items
  FOR EACH ROW
  -- WHEN, so the function body does not run on every order_items UPDATE. The
  -- product-change test lives here rather than inside the function.
  WHEN (NEW.product_id IS DISTINCT FROM OLD.product_id)
  EXECUTE FUNCTION public._resnapshot_order_item_cost_on_product_change();

-- -----------------------------------------------------------------------------
-- 1. get_sales_detail_report: cost/profit/margin from the snapshot cost.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_sales_detail_report(
  p_start_date date DEFAULT NULL,
  p_end_date date DEFAULT NULL,
  p_product_id uuid DEFAULT NULL,
  p_customer_ids uuid[] DEFAULT NULL,
  p_sales_rep_id uuid DEFAULT NULL,
  p_category text DEFAULT NULL,
  p_season integer DEFAULT NULL
)
RETURNS TABLE (
  order_date date,
  order_number text,
  customer_name text,
  customer_id uuid,
  product_name text,
  product_id uuid,
  sku text,
  category text,
  quantity numeric,
  unit text,
  unit_price numeric,
  total_price numeric,
  cost numeric,
  profit numeric,
  margin_pct numeric,
  sales_rep_name text,
  invoice_number text,
  season integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.profiles
    WHERE id = auth.uid()
      AND is_active = true
      AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'Access denied: admin or sales_rep role required';
  END IF;

  RETURN QUERY
  SELECT
    o.order_date,
    o.order_number,
    c.farm_name AS customer_name,
    o.customer_id,
    oi.product_name,
    oi.product_id,
    p.sku,
    p.category,
    oi.total_units_needed AS quantity,
    oi.unit_size AS unit,
    oi.price_per_unit AS unit_price,
    oi.total_price,
    ROUND(COALESCE(oi.cost_at_time_cents / 100.0, oi.cost_per_unit, 0) * oi.total_units_needed, 2) AS cost,
    ROUND(oi.total_price - COALESCE(oi.cost_at_time_cents / 100.0, oi.cost_per_unit, 0) * oi.total_units_needed, 2) AS profit,
    CASE
      WHEN oi.total_price > 0 THEN ROUND(
        ((oi.total_price - COALESCE(oi.cost_at_time_cents / 100.0, oi.cost_per_unit, 0) * oi.total_units_needed)
          / oi.total_price) * 100, 1)
      ELSE 0::numeric
    END AS margin_pct,
    COALESCE(rep.full_name, 'Unassigned') AS sales_rep_name,
    inv.invoice_number,
    o.season
  FROM public.order_items oi
  JOIN public.orders o ON o.id = oi.order_id
  JOIN public.customers c ON c.id = o.customer_id
  JOIN public.products p ON p.id = oi.product_id
  LEFT JOIN public.profiles rep ON rep.id = o.salesman_id
  LEFT JOIN LATERAL (
    SELECT ii.invoice_id, i2.invoice_number
    FROM public.invoice_items ii
    JOIN public.invoices i2 ON i2.id = ii.invoice_id
    WHERE ii.order_item_id = oi.id
      AND i2.status NOT IN ('voided', 'cancelled')
      AND i2.invoice_type <> 'credit_memo'
      AND i2.deleted_at IS NULL
    ORDER BY i2.created_at DESC
    LIMIT 1
  ) inv ON true
  WHERE o.deleted_at IS NULL
    AND o.status NOT IN ('cancelled', 'voided')
    AND (p_start_date IS NULL OR o.order_date >= p_start_date)
    AND (p_end_date IS NULL OR o.order_date <= p_end_date)
    AND (p_product_id IS NULL OR oi.product_id = p_product_id)
    AND (p_customer_ids IS NULL OR o.customer_id = ANY(p_customer_ids))
    AND (p_sales_rep_id IS NULL OR o.salesman_id = p_sales_rep_id)
    AND (p_category IS NULL OR p.category = p_category)
    AND (p_season IS NULL OR o.season = p_season)
  ORDER BY o.order_date DESC, c.farm_name, oi.product_name;
END;
$$;

-- -----------------------------------------------------------------------------
-- 2. get_sales_summary_report: snapshot cost + derived profit in the line CTE.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_sales_summary_report(
  p_group_by text DEFAULT 'product',
  p_start_date date DEFAULT NULL,
  p_end_date date DEFAULT NULL,
  p_product_id uuid DEFAULT NULL,
  p_customer_ids uuid[] DEFAULT NULL,
  p_sales_rep_id uuid DEFAULT NULL,
  p_category text DEFAULT NULL,
  p_season integer DEFAULT NULL
)
RETURNS TABLE (
  group_key text,
  group_id uuid,
  total_quantity numeric,
  total_revenue numeric,
  total_cost numeric,
  total_profit numeric,
  margin_pct numeric,
  order_count bigint,
  line_count bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.profiles
    WHERE id = auth.uid()
      AND is_active = true
      AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'Access denied: admin or sales_rep role required';
  END IF;

  RETURN QUERY
  WITH filtered AS (
    SELECT
      oi.product_id,
      oi.product_name,
      o.customer_id,
      c.farm_name,
      o.salesman_id,
      COALESCE(rep.full_name, 'Unassigned') AS rep_name,
      p.category,
      o.order_date,
      o.id AS order_id,
      oi.total_units_needed AS quantity,
      oi.total_price AS revenue,
      ROUND(COALESCE(oi.cost_at_time_cents / 100.0, oi.cost_per_unit, 0) * oi.total_units_needed, 2) AS cost,
      ROUND(oi.total_price - COALESCE(oi.cost_at_time_cents / 100.0, oi.cost_per_unit, 0) * oi.total_units_needed, 2) AS profit
    FROM public.order_items oi
    JOIN public.orders o ON o.id = oi.order_id
    JOIN public.customers c ON c.id = o.customer_id
    JOIN public.products p ON p.id = oi.product_id
    LEFT JOIN public.profiles rep ON rep.id = o.salesman_id
    WHERE o.deleted_at IS NULL
      AND o.status NOT IN ('cancelled', 'voided')
      AND (p_start_date IS NULL OR o.order_date >= p_start_date)
      AND (p_end_date IS NULL OR o.order_date <= p_end_date)
      AND (p_product_id IS NULL OR oi.product_id = p_product_id)
      AND (p_customer_ids IS NULL OR o.customer_id = ANY(p_customer_ids))
      AND (p_sales_rep_id IS NULL OR o.salesman_id = p_sales_rep_id)
      AND (p_category IS NULL OR p.category = p_category)
      AND (p_season IS NULL OR o.season = p_season)
  )
  SELECT
    CASE p_group_by
      WHEN 'product' THEN f.product_name
      WHEN 'customer' THEN f.farm_name
      WHEN 'sales_rep' THEN f.rep_name
      WHEN 'month' THEN TO_CHAR(f.order_date, 'YYYY-MM')
      WHEN 'category' THEN COALESCE(f.category, 'Uncategorized')
      ELSE f.product_name
    END AS group_key,
    CASE p_group_by
      WHEN 'product' THEN f.product_id
      WHEN 'customer' THEN f.customer_id
      WHEN 'sales_rep' THEN f.salesman_id
      ELSE NULL
    END AS group_id,
    SUM(f.quantity) AS total_quantity,
    SUM(f.revenue) AS total_revenue,
    SUM(f.cost) AS total_cost,
    SUM(f.profit) AS total_profit,
    CASE
      WHEN SUM(f.revenue) > 0 THEN ROUND((SUM(f.profit) / SUM(f.revenue)) * 100, 1)
      ELSE 0::numeric
    END AS margin_pct,
    COUNT(DISTINCT f.order_id) AS order_count,
    COUNT(*) AS line_count
  FROM filtered f
  GROUP BY
    CASE p_group_by
      WHEN 'product' THEN f.product_name
      WHEN 'customer' THEN f.farm_name
      WHEN 'sales_rep' THEN f.rep_name
      WHEN 'month' THEN TO_CHAR(f.order_date, 'YYYY-MM')
      WHEN 'category' THEN COALESCE(f.category, 'Uncategorized')
      ELSE f.product_name
    END,
    CASE p_group_by
      WHEN 'product' THEN f.product_id
      WHEN 'customer' THEN f.customer_id
      WHEN 'sales_rep' THEN f.salesman_id
      ELSE NULL
    END
  ORDER BY SUM(f.revenue) DESC;
END;
$$;

-- -----------------------------------------------------------------------------
-- 3. get_gross_sales_report: all three branches aggregate order_items with the
--    snapshot cost, so product/customer/salesman views agree on COGS. The
--    customer/salesman branches previously read the stored orders.total_cost /
--    total_profit header columns and reported units_sold = 0; item-level
--    aggregation gives them real units too. Security mode (invoker),
--    search_path, guard, signature, and return shape unchanged.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_gross_sales_report(
  p_start_date date,
  p_end_date date,
  p_group_by text DEFAULT 'product'::text
)
RETURNS TABLE (
  group_name text,
  total_revenue numeric,
  total_cost numeric,
  gross_profit numeric,
  margin_pct numeric,
  units_sold numeric,
  order_count bigint
)
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $function$
BEGIN
  IF NOT (public.is_admin() OR public.is_sales_rep()) THEN
    RAISE EXCEPTION 'Access denied: active admin or sales_rep role required';
  END IF;

  IF p_group_by = 'product' THEN
    RETURN QUERY
    SELECT
      oi.product_name,
      ROUND(SUM(oi.total_price)::numeric, 2),
      ROUND(SUM(COALESCE(oi.cost_at_time_cents / 100.0, oi.cost_per_unit, 0) * oi.total_units_needed)::numeric, 2),
      ROUND(SUM(oi.total_price - COALESCE(oi.cost_at_time_cents / 100.0, oi.cost_per_unit, 0) * oi.total_units_needed)::numeric, 2),
      CASE
        WHEN SUM(oi.total_price) > 0
          THEN ROUND((SUM(oi.total_price - COALESCE(oi.cost_at_time_cents / 100.0, oi.cost_per_unit, 0) * oi.total_units_needed)
                      / SUM(oi.total_price) * 100)::numeric, 1)
        ELSE 0
      END,
      ROUND(SUM(oi.total_units_needed)::numeric, 2),
      COUNT(DISTINCT oi.order_id)
    FROM public.order_items oi
    JOIN public.orders o ON o.id = oi.order_id
    WHERE o.order_date >= p_start_date
      AND o.order_date <= p_end_date
      AND o.deleted_at IS NULL
      AND o.status NOT IN ('cancelled', 'voided')
    GROUP BY oi.product_name
    ORDER BY SUM(oi.total_price) DESC;
  ELSIF p_group_by = 'customer' THEN
    RETURN QUERY
    SELECT
      c.farm_name,
      ROUND(SUM(oi.total_price)::numeric, 2),
      ROUND(SUM(COALESCE(oi.cost_at_time_cents / 100.0, oi.cost_per_unit, 0) * oi.total_units_needed)::numeric, 2),
      ROUND(SUM(oi.total_price - COALESCE(oi.cost_at_time_cents / 100.0, oi.cost_per_unit, 0) * oi.total_units_needed)::numeric, 2),
      CASE
        WHEN SUM(oi.total_price) > 0
          THEN ROUND((SUM(oi.total_price - COALESCE(oi.cost_at_time_cents / 100.0, oi.cost_per_unit, 0) * oi.total_units_needed)
                      / SUM(oi.total_price) * 100)::numeric, 1)
        ELSE 0
      END,
      ROUND(SUM(oi.total_units_needed)::numeric, 2),
      COUNT(DISTINCT oi.order_id)
    FROM public.order_items oi
    JOIN public.orders o ON o.id = oi.order_id
    LEFT JOIN public.customers c ON c.id = o.customer_id
    WHERE o.order_date >= p_start_date
      AND o.order_date <= p_end_date
      AND o.deleted_at IS NULL
      AND o.status NOT IN ('cancelled', 'voided')
    GROUP BY c.farm_name
    ORDER BY SUM(oi.total_price) DESC;
  ELSE
    RETURN QUERY
    SELECT
      COALESCE(p.full_name, 'Unassigned'),
      ROUND(SUM(oi.total_price)::numeric, 2),
      ROUND(SUM(COALESCE(oi.cost_at_time_cents / 100.0, oi.cost_per_unit, 0) * oi.total_units_needed)::numeric, 2),
      ROUND(SUM(oi.total_price - COALESCE(oi.cost_at_time_cents / 100.0, oi.cost_per_unit, 0) * oi.total_units_needed)::numeric, 2),
      CASE
        WHEN SUM(oi.total_price) > 0
          THEN ROUND((SUM(oi.total_price - COALESCE(oi.cost_at_time_cents / 100.0, oi.cost_per_unit, 0) * oi.total_units_needed)
                      / SUM(oi.total_price) * 100)::numeric, 1)
        ELSE 0
      END,
      ROUND(SUM(oi.total_units_needed)::numeric, 2),
      COUNT(DISTINCT oi.order_id)
    FROM public.order_items oi
    JOIN public.orders o ON o.id = oi.order_id
    LEFT JOIN public.profiles p ON p.id = o.salesman_id
    WHERE o.order_date >= p_start_date
      AND o.order_date <= p_end_date
      AND o.deleted_at IS NULL
      AND o.status NOT IN ('cancelled', 'voided')
    GROUP BY p.full_name
    ORDER BY SUM(oi.total_price) DESC;
  END IF;
END;
$function$;

-- -----------------------------------------------------------------------------
-- 4. financial_dashboard_summary: snapshot cost in committed_orders and
--    bottom_products; the headline order_agg (total_revenue/total_profit/
--    overall_margin), bottom_customers and monthly_margin rewritten as
--    item-level aggregations (they previously read orders.total_cost /
--    total_profit, so the headline disagreed with the sections below it).
--    monthly_revenue moves with the headline for the same reason.
--    Floor inventory valuation intentionally stays on products.current_cost.
--    JSON keys, guard, and all non-margin behavior unchanged.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.financial_dashboard_summary()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  result jsonb;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'permission denied: admin role required';
  END IF;

  WITH
  -- HEADLINE (Codex P2-C): revenue/profit are aggregated item-level from the
  -- SAME canonical snapshot expression the lower CTEs use, instead of the
  -- stored orders.total_price / total_profit header columns. Those header
  -- columns drift from the snapshot basis, so the one RPC used to return a
  -- headline profit that disagreed with its own bottom_products /
  -- bottom_customers / monthly_margin sections (FinancialDashboard.tsx and
  -- FinanceSnapshotCard.tsx read the headline). Filters (deleted_at, status)
  -- and the emitted JSON keys are unchanged.
  order_agg AS (
    SELECT
      COALESCE(SUM(oi.total_price), 0) AS total_revenue,
      COALESCE(SUM(
        oi.total_price
        - COALESCE(oi.cost_at_time_cents / 100.0, oi.cost_per_unit, 0) * oi.total_units_needed
      ), 0) AS total_profit
    FROM public.order_items oi
    JOIN public.orders o ON o.id = oi.order_id
    WHERE o.deleted_at IS NULL
      AND o.status NOT IN ('cancelled', 'voided', 'draft')
  ),
  quote_agg AS (
    SELECT
      COUNT(*) FILTER (WHERE status = 'draft') AS draft_count,
      COUNT(*) FILTER (WHERE status = 'sent') AS sent_count,
      COUNT(*) FILTER (WHERE status = 'accepted') AS accepted_count,
      COALESCE(SUM(total_price) FILTER (WHERE status IN ('draft', 'sent')), 0) AS pipeline_value
    FROM public.quotes
  ),
  -- monthly_revenue rides on the same headline basis (P2-C): it is the revenue
  -- /profit trend shown beside the headline totals, so it is aggregated
  -- item-level from the canonical snapshot expression too. Keys (month,
  -- revenue, profit), ordering, and the 12-month window are unchanged.
  monthly AS (
    SELECT jsonb_agg(row_to_json(m)::jsonb ORDER BY m.month) AS arr
    FROM (
      SELECT
        TO_CHAR(COALESCE(o.order_date, o.created_at::date), 'YYYY-MM') AS month,
        COALESCE(SUM(oi.total_price), 0) AS revenue,
        COALESCE(SUM(
          oi.total_price
          - COALESCE(oi.cost_at_time_cents / 100.0, oi.cost_per_unit, 0) * oi.total_units_needed
        ), 0) AS profit
      FROM public.order_items oi
      JOIN public.orders o ON o.id = oi.order_id
      WHERE o.deleted_at IS NULL
        AND o.status NOT IN ('cancelled', 'voided', 'draft')
      GROUP BY 1
      ORDER BY 1 DESC
      LIMIT 12
    ) m
  ),
  top_cust AS (
    SELECT jsonb_agg(row_to_json(tc)::jsonb ORDER BY tc.total DESC) AS arr
    FROM (
      -- Item-level revenue, matching order_agg and monthly above. Reading
      -- orders.total_price here would let the top-customers panel disagree with
      -- the headline and the trend in this same payload.
      SELECT c.farm_name, COALESCE(SUM(oi.total_price), 0) AS total
      FROM public.order_items oi
      JOIN public.orders o ON o.id = oi.order_id
      JOIN public.customers c ON c.id = o.customer_id
      WHERE o.deleted_at IS NULL
        AND o.status NOT IN ('cancelled', 'voided', 'draft')
      GROUP BY c.id, c.farm_name
      ORDER BY total DESC
      LIMIT 5
    ) tc
  ),
  ar AS (
    SELECT COALESCE(SUM(GREATEST(balance_cents, 0)), 0) / 100.0 AS balance
    FROM public.invoices
    WHERE status IN ('posted', 'overdue')
      AND deleted_at IS NULL
  ),
  over_credit AS (
    SELECT COUNT(*) AS cnt
    FROM public.customers c
    WHERE c.credit_limit_cents IS NOT NULL
      AND c.credit_limit_cents > 0
      AND (
        SELECT COALESCE(SUM(GREATEST(i.balance_cents, 0)), 0)
        FROM public.invoices i
        WHERE i.customer_id = c.id
          AND i.status IN ('posted', 'overdue')
          AND i.deleted_at IS NULL
      ) > c.credit_limit_cents
  ),
  ar_aging AS (
    SELECT
      COALESCE(SUM(CASE WHEN age_days <= 30 THEN balance ELSE 0 END), 0) AS current_bucket,
      COALESCE(SUM(CASE WHEN age_days BETWEEN 31 AND 60 THEN balance ELSE 0 END), 0) AS days_31_60,
      COALESCE(SUM(CASE WHEN age_days BETWEEN 61 AND 90 THEN balance ELSE 0 END), 0) AS days_61_90,
      COALESCE(SUM(CASE WHEN age_days > 90 THEN balance ELSE 0 END), 0) AS days_90_plus
    FROM (
      SELECT
        GREATEST(i.balance_cents, 0) / 100.0 AS balance,
        EXTRACT(DAY FROM NOW() - COALESCE(i.due_date, i.invoice_date))::int AS age_days
      FROM public.invoices i
      WHERE i.status IN ('posted', 'overdue')
        AND i.balance_cents > 0
        AND i.deleted_at IS NULL
    ) aged
  ),
  prepay_bal AS (
    SELECT COALESCE(SUM(prepay_balance_cents), 0) / 100.0 AS total_unallocated
    FROM public.customers
    WHERE prepay_balance_cents > 0
  ),
  commission_owed AS (
    SELECT COALESCE(SUM(commission_amount), 0) AS total_owed
    FROM public.commissions
    WHERE status = 'pending'
      AND paid_date IS NULL
  ),
  period_info AS (
    SELECT
      COALESCE(TO_CHAR(period_start, 'Mon YYYY'), TO_CHAR(NOW(), 'Mon YYYY')) AS name,
      COALESCE(status, 'open') AS status,
      CASE
        WHEN period_end IS NOT NULL
          THEN GREATEST(EXTRACT(DAY FROM period_end - NOW())::int, 0)
        ELSE EXTRACT(DAY FROM (DATE_TRUNC('month', NOW()) + INTERVAL '1 month' - INTERVAL '1 day') - NOW())::int
      END AS days_remaining
    FROM public.accounting_periods
    WHERE status = 'open'
    ORDER BY period_start DESC
    LIMIT 1
  ),
  po_unreceived AS (
    SELECT COALESCE(SUM(
      (poi.quantity_ordered - COALESCE(poi.quantity_received, 0)) * poi.unit_cost
    ), 0) AS value
    FROM public.purchase_order_items poi
    JOIN public.purchase_orders po ON po.id = poi.purchase_order_id
    WHERE po.status IN ('submitted', 'partially_received')
  ),
  floor_inv AS (
    SELECT
      COALESCE(SUM(inv.quantity_available * COALESCE(p.current_cost, 0)), 0) AS total_value,
      COALESCE(SUM(
        GREATEST(inv.quantity_available - inv.quantity_prebooked, 0) * COALESCE(p.current_cost, 0)
      ), 0) AS free_value
    FROM public.inventory inv
    JOIN public.products p ON p.id = inv.product_id
    WHERE inv.quantity_available > 0
  ),
  committed_orders AS (
    SELECT COALESCE(SUM(
      oi.quantity_remaining * COALESCE(oi.cost_at_time_cents / 100.0, oi.cost_per_unit, 0)
    ), 0) AS value
    FROM public.order_items oi
    JOIN public.orders o ON o.id = oi.order_id
    WHERE o.status IN ('confirmed', 'partially_fulfilled')
      AND o.deleted_at IS NULL
      AND oi.quantity_remaining > 0
  ),
  bottom_products AS (
    SELECT jsonb_agg(row_to_json(bp)::jsonb ORDER BY bp.margin_pct ASC) AS arr
    FROM (
      SELECT
        p.product_name,
        COALESCE(SUM(oi.total_units_needed * oi.price_per_unit), 0) AS total_revenue,
        COALESCE(SUM(oi.total_units_needed * COALESCE(oi.cost_at_time_cents / 100.0, oi.cost_per_unit, 0)), 0) AS total_cost,
        ROUND(
          CASE
            WHEN SUM(oi.total_units_needed * oi.price_per_unit) > 0 THEN
              ((SUM(oi.total_units_needed * oi.price_per_unit) -
                SUM(oi.total_units_needed * COALESCE(oi.cost_at_time_cents / 100.0, oi.cost_per_unit, 0))) /
                NULLIF(SUM(oi.total_units_needed * oi.price_per_unit), 0)) * 100
            ELSE 0
          END,
          1
        ) AS margin_pct,
        COALESCE(SUM(oi.total_units_needed), 0) AS units_sold
      FROM public.order_items oi
      JOIN public.orders o ON o.id = oi.order_id
      JOIN public.products p ON p.id = oi.product_id
      WHERE o.deleted_at IS NULL
        AND o.status NOT IN ('cancelled', 'voided', 'draft')
        AND public.compute_season(COALESCE(o.order_date, o.created_at::date)) =
            public.compute_season(CURRENT_DATE)
      GROUP BY p.id, p.product_name
      HAVING SUM(oi.total_units_needed * oi.price_per_unit) > 0
      ORDER BY margin_pct ASC
      LIMIT 10
    ) bp
  ),
  bottom_customers AS (
    SELECT jsonb_agg(row_to_json(bc)::jsonb ORDER BY bc.margin_pct ASC) AS arr
    FROM (
      SELECT
        c.farm_name,
        COALESCE(SUM(oi.total_price), 0) AS total_revenue,
        COALESCE(SUM(COALESCE(oi.cost_at_time_cents / 100.0, oi.cost_per_unit, 0) * oi.total_units_needed), 0) AS total_cost,
        ROUND(
          CASE
            WHEN SUM(oi.total_price) > 0 THEN
              ((SUM(oi.total_price) -
                SUM(COALESCE(oi.cost_at_time_cents / 100.0, oi.cost_per_unit, 0) * oi.total_units_needed)) /
                NULLIF(SUM(oi.total_price), 0)) * 100
            ELSE 0
          END,
          1
        ) AS margin_pct,
        COUNT(DISTINCT o.id)::int AS order_count
      FROM public.order_items oi
      JOIN public.orders o ON o.id = oi.order_id
      JOIN public.customers c ON c.id = o.customer_id
      WHERE o.deleted_at IS NULL
        AND o.status NOT IN ('cancelled', 'voided', 'draft')
        AND public.compute_season(COALESCE(o.order_date, o.created_at::date)) =
            public.compute_season(CURRENT_DATE)
      GROUP BY c.id, c.farm_name
      HAVING SUM(oi.total_price) > 0
      ORDER BY margin_pct ASC
      LIMIT 10
    ) bc
  ),
  monthly_margin AS (
    SELECT jsonb_agg(row_to_json(mm)::jsonb ORDER BY mm.month) AS arr
    FROM (
      SELECT
        TO_CHAR(COALESCE(o.order_date, o.created_at::date), 'YYYY-MM') AS month,
        COALESCE(SUM(oi.total_price), 0) AS revenue,
        COALESCE(SUM(COALESCE(oi.cost_at_time_cents / 100.0, oi.cost_per_unit, 0) * oi.total_units_needed), 0) AS cost,
        ROUND(
          CASE
            WHEN SUM(oi.total_price) > 0 THEN
              ((SUM(oi.total_price) -
                SUM(COALESCE(oi.cost_at_time_cents / 100.0, oi.cost_per_unit, 0) * oi.total_units_needed)) /
                NULLIF(SUM(oi.total_price), 0)) * 100
            ELSE 0
          END,
          1
        ) AS margin_pct
      FROM public.order_items oi
      JOIN public.orders o ON o.id = oi.order_id
      WHERE o.deleted_at IS NULL
        AND o.status NOT IN ('cancelled', 'voided', 'draft')
      GROUP BY 1
      ORDER BY 1 DESC
      LIMIT 12
    ) mm
  )
  SELECT jsonb_build_object(
    'total_revenue', oa.total_revenue,
    'total_profit', oa.total_profit,
    'overall_margin', CASE
      WHEN oa.total_revenue > 0 THEN ROUND((oa.total_profit / oa.total_revenue) * 100, 1)
      ELSE 0
    END,
    'quote_counts', jsonb_build_object(
      'draft', qa.draft_count,
      'sent', qa.sent_count,
      'accepted', qa.accepted_count
    ),
    'quote_pipeline_value', qa.pipeline_value,
    'monthly_revenue', COALESCE(mr.arr, '[]'::jsonb),
    'top_customers', COALESCE(tc.arr, '[]'::jsonb),
    'open_ar_balance', ar_total.balance,
    'customers_over_credit_count', oc.cnt,
    'ar_aging_buckets', jsonb_build_object(
      'current', aa.current_bucket,
      'days_31_60', aa.days_31_60,
      'days_61_90', aa.days_61_90,
      'days_90_plus', aa.days_90_plus
    ),
    'total_prepay_unallocated', pb.total_unallocated,
    'total_commission_owed', co.total_owed,
    'current_period', jsonb_build_object(
      'name', COALESCE(pi.name, TO_CHAR(NOW(), 'Mon YYYY')),
      'status', COALESCE(pi.status, 'open'),
      'days_remaining', COALESCE(pi.days_remaining, 0)
    ),
    'po_unreceived_value', pour.value,
    'floor_inventory_value', fi.total_value,
    'floor_free_value', fi.free_value,
    'committed_order_value', co2.value,
    'bottom_products_by_margin', COALESCE(bpm.arr, '[]'::jsonb),
    'bottom_customers_by_margin', COALESCE(bcm.arr, '[]'::jsonb),
    'monthly_margin_trend', COALESCE(mmt.arr, '[]'::jsonb)
  ) INTO result
  FROM order_agg oa
  CROSS JOIN quote_agg qa
  CROSS JOIN monthly mr
  CROSS JOIN top_cust tc
  CROSS JOIN ar ar_total
  CROSS JOIN over_credit oc
  CROSS JOIN ar_aging aa
  CROSS JOIN prepay_bal pb
  CROSS JOIN commission_owed co
  CROSS JOIN po_unreceived pour
  CROSS JOIN floor_inv fi
  CROSS JOIN committed_orders co2
  CROSS JOIN bottom_products bpm
  CROSS JOIN bottom_customers bcm
  CROSS JOIN monthly_margin mmt
  LEFT JOIN period_info pi ON true;

  RETURN result;
END;
$function$;

-- -----------------------------------------------------------------------------
-- 5. get_profitability_report: new read-only RPC backing the Reports.tsx
--    profitability tabs (customer / product / revenue-by-month), replacing
--    client-side grouping over stored order header columns. Read-only:
--    no idempotency key, matching sibling report RPCs.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_profitability_report(
  p_group_by text,
  p_start_date date DEFAULT NULL,
  p_end_date date DEFAULT NULL
)
RETURNS TABLE (
  group_key text,
  total_revenue numeric,
  total_cost numeric,
  total_profit numeric,
  margin_pct numeric,
  order_count bigint,
  units_sold numeric
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.profiles
    WHERE id = auth.uid()
      AND is_active = true
      AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'Access denied: admin or sales_rep role required';
  END IF;

  IF p_group_by NOT IN ('customer', 'product', 'month') THEN
    RAISE EXCEPTION 'Invalid p_group_by: % (expected customer, product, or month)', p_group_by;
  END IF;

  RETURN QUERY
  WITH filtered AS (
    SELECT
      CASE p_group_by
        WHEN 'customer' THEN COALESCE(c.farm_name, 'Unknown')
        WHEN 'product' THEN oi.product_name
        ELSE TO_CHAR(COALESCE(o.order_date, o.created_at::date), 'YYYY-MM')
      END AS grp,
      o.id AS order_id,
      oi.total_units_needed AS quantity,
      oi.total_price AS revenue,
      COALESCE(oi.cost_at_time_cents / 100.0, oi.cost_per_unit, 0) * oi.total_units_needed AS cost
    FROM public.order_items oi
    JOIN public.orders o ON o.id = oi.order_id
    LEFT JOIN public.customers c ON c.id = o.customer_id
    WHERE o.deleted_at IS NULL
      -- Same inclusion rule as every other order-basis report in this
      -- migration. An allowlist here would silently disagree with the sales
      -- reports and the dashboard whenever a new order status is introduced.
      AND o.status NOT IN ('cancelled', 'voided', 'draft')
      -- Same effective date the month grouping uses. Filtering on the raw
      -- o.order_date while grouping on the COALESCE would drop every order with
      -- a NULL order_date the moment a caller supplies a date range, so those
      -- orders would appear in the unfiltered report and silently vanish from a
      -- filtered one.
      AND (p_start_date IS NULL OR COALESCE(o.order_date, o.created_at::date) >= p_start_date)
      AND (p_end_date IS NULL OR COALESCE(o.order_date, o.created_at::date) <= p_end_date)
  )
  SELECT
    f.grp AS group_key,
    ROUND(SUM(f.revenue)::numeric, 2) AS total_revenue,
    ROUND(SUM(f.cost)::numeric, 2) AS total_cost,
    ROUND(SUM(f.revenue - f.cost)::numeric, 2) AS total_profit,
    CASE
      WHEN SUM(f.revenue) > 0 THEN ROUND((SUM(f.revenue - f.cost) / SUM(f.revenue)) * 100, 1)
      ELSE 0::numeric
    END AS margin_pct,
    COUNT(DISTINCT f.order_id) AS order_count,
    ROUND(SUM(f.quantity)::numeric, 2) AS units_sold
  FROM filtered f
  GROUP BY f.grp
  ORDER BY SUM(f.revenue) DESC;
END;
$$;

-- -----------------------------------------------------------------------------
-- Grants: preserve existing callable boundaries; new RPC mirrors the sibling
-- report convention (no public/anon execute; authenticated + service_role).
-- See caller-analysis markers in the header for the two REVOKE targets.
-- -----------------------------------------------------------------------------
-- caller-analysis: get_sales_detail_report :: UI callsite src/pages/SalesReports.tsx:168 runs as authenticated, which is re-granted on the next line — REVOKE targets only PUBLIC/anon, callers unaffected.
REVOKE ALL ON FUNCTION public.get_sales_detail_report(date, date, uuid, uuid[], uuid, text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_sales_detail_report(date, date, uuid, uuid[], uuid, text, integer) TO authenticated;
-- caller-analysis: get_sales_summary_report :: UI callsite src/pages/SalesReports.tsx:176 runs as authenticated, re-granted on the next line — REVOKE targets only PUBLIC/anon, callers unaffected.
REVOKE ALL ON FUNCTION public.get_sales_summary_report(text, date, date, uuid, uuid[], uuid, text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_sales_summary_report(text, date, date, uuid, uuid[], uuid, text, integer) TO authenticated;
REVOKE ALL ON FUNCTION public.get_gross_sales_report(date, date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_gross_sales_report(date, date, text) TO authenticated, service_role;
-- caller-analysis: financial_dashboard_summary :: UI callsites (DailyBrief.tsx:48, FinanceSnapshotCard.tsx:38, FinancialDashboard.tsx:185) all run as authenticated, re-granted on the next line — REVOKE targets only PUBLIC/anon, callers unaffected.
REVOKE ALL ON FUNCTION public.financial_dashboard_summary() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.financial_dashboard_summary() TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_profitability_report(text, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_profitability_report(text, date, date) TO authenticated, service_role;

-- Deployment-time assertions: fail closed if the unification drifts.
DO $verify$
DECLARE
  v_name text;
  v_src text;
BEGIN
  FOREACH v_name IN ARRAY ARRAY[
    'get_sales_detail_report', 'get_sales_summary_report',
    'get_gross_sales_report', 'financial_dashboard_summary',
    'get_profitability_report'
  ] LOOP
    IF (SELECT count(*) FROM pg_proc
        WHERE pronamespace = 'public'::regnamespace AND proname = v_name) <> 1 THEN
      RAISE EXCEPTION 'report RPC % overload count drifted', v_name;
    END IF;
    SELECT prosrc INTO v_src
    FROM pg_proc
    WHERE pronamespace = 'public'::regnamespace AND proname = v_name;
    IF v_src NOT LIKE '%cost_at_time_cents / 100.0%' THEN
      RAISE EXCEPTION 'report RPC % does not read the snapshot cost', v_name;
    END IF;
  END LOOP;

  -- Preserve the 20260714223000 dashboard guard assertions.
  SELECT prosrc INTO v_src
  FROM pg_proc
  WHERE oid = 'public.financial_dashboard_summary()'::regprocedure;
  IF v_src NOT LIKE '%status NOT IN (''cancelled'', ''voided'', ''draft'')%'
     OR v_src NOT LIKE '%IF NOT public.is_admin() THEN%' THEN
    RAISE EXCEPTION 'financial dashboard status/active-admin guards missing';
  END IF;

  -- P2-C: the headline (and its monthly trend) must derive profit from the
  -- canonical snapshot expression, not from the stored orders.total_profit
  -- header column, so the headline agrees with bottom_products /
  -- bottom_customers / monthly_margin in this same RPC.
  IF v_src LIKE '%SUM(total_profit)%' THEN
    RAISE EXCEPTION 'financial dashboard still aggregates orders.total_profit';
  END IF;
  IF v_src NOT LIKE '%order_agg AS (%public.order_items%' THEN
    RAISE EXCEPTION 'financial dashboard headline is not item-level';
  END IF;

  IF has_function_privilege('anon', 'public.get_profitability_report(text,date,date)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anonymous has profitability report execution';
  END IF;

  -- Every report above treats cost_at_time_cents as the canonical basis, which
  -- only holds while the re-snapshot trigger keeps that column correct across a
  -- product swap. Assert the trigger is actually attached.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.order_items'::regclass
       AND tgname = 'trg_resnapshot_order_item_cost'
       AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'order_items product swap re-snapshot trigger missing';
  END IF;
END;
$verify$;
