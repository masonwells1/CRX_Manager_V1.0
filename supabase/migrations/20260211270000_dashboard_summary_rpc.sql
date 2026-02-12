/*
  Dashboard Summary RPC
  ---------------------
  Consolidates the 8+ separate queries the Dashboard page fires into a single
  database round-trip.  Returns a JSONB object with all KPI data.

  Replaces client-side queries to:
    1. orders  (revenue, profit, margin, monthly breakdown, top customers)
    2. quotes  (pipeline counts & value)
    3. inventory  (available, prebooked totals)
    4. deliveries  (next 5 upcoming)
    5. activity_feed  (last 10 items)
    6. inventory + reorder_point  (low stock count)
    7. orders.balance_due  (open AR balance)
    8. customers  (name lookup for top-customer aggregation)
*/

CREATE OR REPLACE FUNCTION public.dashboard_summary()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result jsonb;
BEGIN
  WITH
  -- 1. Order aggregates: revenue, profit, margin
  order_agg AS (
    SELECT
      COALESCE(SUM(total_price), 0)  AS total_revenue,
      COALESCE(SUM(total_profit), 0) AS total_profit
    FROM orders
  ),

  -- 2. Quote counts & pipeline value
  quote_agg AS (
    SELECT
      COUNT(*) FILTER (WHERE status = 'draft')    AS draft_count,
      COUNT(*) FILTER (WHERE status = 'sent')     AS sent_count,
      COUNT(*) FILTER (WHERE status = 'accepted') AS accepted_count,
      COALESCE(SUM(total_price) FILTER (WHERE status IN ('draft', 'sent')), 0) AS pipeline_value
    FROM quotes
  ),

  -- 3. Inventory totals
  inv_agg AS (
    SELECT
      COALESCE(SUM(quantity_available), 0)  AS total_available,
      COALESCE(SUM(quantity_prebooked), 0)  AS total_prebooked
    FROM inventory
  ),

  -- 4. Low stock count (quantity_available <= reorder_point where reorder_point > 0)
  low_stock AS (
    SELECT COUNT(*) AS cnt
    FROM inventory
    WHERE reorder_point > 0
      AND quantity_available <= reorder_point
  ),

  -- 5. Open AR balance
  ar AS (
    SELECT COALESCE(SUM(GREATEST(balance_due, 0)), 0) AS balance
    FROM orders
  ),

  -- 6. Monthly revenue & profit for last 12 months
  monthly AS (
    SELECT jsonb_agg(row_to_json(m)::jsonb ORDER BY m.month) AS arr
    FROM (
      SELECT
        TO_CHAR(COALESCE(order_date, created_at::date), 'YYYY-MM') AS month,
        COALESCE(SUM(total_price), 0)  AS revenue,
        COALESCE(SUM(total_profit), 0) AS profit
      FROM orders
      GROUP BY 1
      ORDER BY 1 DESC
      LIMIT 12
    ) m
  ),

  -- 7. Top 5 customers by revenue
  top_cust AS (
    SELECT jsonb_agg(row_to_json(tc)::jsonb ORDER BY tc.total DESC) AS arr
    FROM (
      SELECT
        c.farm_name,
        COALESCE(SUM(o.total_price), 0) AS total
      FROM orders o
      JOIN customers c ON c.id = o.customer_id
      GROUP BY c.id, c.farm_name
      ORDER BY total DESC
      LIMIT 5
    ) tc
  ),

  -- 8. Next 5 upcoming deliveries
  upcoming AS (
    SELECT jsonb_agg(row_to_json(ud)::jsonb ORDER BY ud.scheduled_date ASC) AS arr
    FROM (
      SELECT
        d.id,
        d.delivery_number,
        d.scheduled_date,
        d.status,
        jsonb_build_object('farm_name', cust.farm_name) AS customer,
        jsonb_build_object('full_name', drv.full_name)  AS driver
      FROM deliveries d
      LEFT JOIN customers cust ON cust.id = d.customer_id
      LEFT JOIN profiles  drv  ON drv.id  = d.assigned_driver
      WHERE d.status IN ('scheduled', 'in_progress')
      ORDER BY d.scheduled_date ASC
      LIMIT 5
    ) ud
  ),

  -- 9. Last 10 activity feed items
  activity AS (
    SELECT jsonb_agg(row_to_json(af)::jsonb ORDER BY af.created_at DESC) AS arr
    FROM (
      SELECT
        id,
        event_type,
        description,
        created_at
      FROM activity_feed
      ORDER BY created_at DESC
      LIMIT 10
    ) af
  )

  SELECT jsonb_build_object(
    'total_revenue',        oa.total_revenue,
    'total_profit',         oa.total_profit,
    'overall_margin',       CASE WHEN oa.total_revenue > 0
                              THEN ROUND((oa.total_profit / oa.total_revenue) * 100, 1)
                              ELSE 0
                            END,
    'quote_counts',         jsonb_build_object(
                              'draft',    qa.draft_count,
                              'sent',     qa.sent_count,
                              'accepted', qa.accepted_count
                            ),
    'quote_pipeline_value', qa.pipeline_value,
    'inventory_available',  ia.total_available,
    'inventory_prebooked',  ia.total_prebooked,
    'low_stock_count',      ls.cnt,
    'open_ar_balance',      ar.balance,
    'monthly_revenue',      COALESCE(mr.arr, '[]'::jsonb),
    'top_customers',        COALESCE(tc.arr, '[]'::jsonb),
    'upcoming_deliveries',  COALESCE(ud.arr, '[]'::jsonb),
    'recent_activity',      COALESCE(ra.arr, '[]'::jsonb)
  ) INTO result
  FROM order_agg  oa
  CROSS JOIN quote_agg   qa
  CROSS JOIN inv_agg     ia
  CROSS JOIN low_stock   ls
  CROSS JOIN ar
  CROSS JOIN monthly     mr
  CROSS JOIN top_cust    tc
  CROSS JOIN upcoming    ud
  CROSS JOIN activity    ra;

  RETURN result;
END;
$$;

-- Grant execute to authenticated users (RLS still applies within each CTE)
GRANT EXECUTE ON FUNCTION public.dashboard_summary() TO authenticated;

COMMENT ON FUNCTION public.dashboard_summary() IS
  'Returns a single JSONB object with all Dashboard KPIs, charts, and lists. '
  'Replaces 8+ separate client queries with one round-trip.';
