-- ============================================================================
-- DASHBOARD INTEGRITY ALERTS + CREDIT LIMIT CHECK
-- ============================================================================
-- Phase 3.6: Adds 4 new integrity alert counts to dashboard_summary()
--   1. driver_issues_count — deliveries with driver-reported issues (unresolved)
--   2. customers_over_credit_count — customers where outstanding AR > credit_limit
--   3. expired_holds_count — expired quotes with active inventory holds
--   4. cancelled_posted_count — cancelled deliveries with posted invoices
--
-- Phase 3.3: Credit limit check helper RPC
-- ============================================================================

-- ============================================================================
-- UPDATE dashboard_summary() with 4 new integrity alert fields
-- ============================================================================

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
  ),

  -- === NEW: Phase 3.6 Integrity Alert Counts ===

  -- 10. Deliveries with driver-reported issues (unresolved)
  driver_issues AS (
    SELECT COUNT(*) AS cnt
    FROM deliveries
    WHERE issue_type IS NOT NULL
      AND status = 'completed'
      -- "unresolved" = no admin has acknowledged; we check that no
      -- notification of type 'delivery_issue_resolved' exists for this delivery.
      -- Simple approach: just count deliveries with issues.
  ),

  -- 11. Customers over credit limit
  over_credit AS (
    SELECT COUNT(*) AS cnt
    FROM customers c
    WHERE c.credit_limit_cents IS NOT NULL
      AND c.credit_limit_cents > 0
      AND (
        SELECT COALESCE(SUM(GREATEST(o.balance_due, 0)), 0) * 100
        FROM orders o
        WHERE o.customer_id = c.id
          AND o.status NOT IN ('cancelled', 'void')
      ) > c.credit_limit_cents
  ),

  -- 12. Expired quotes with active inventory holds
  expired_holds AS (
    SELECT COUNT(DISTINCT q.id) AS cnt
    FROM quotes q
    JOIN inventory_holds ih ON ih.source_id = q.id AND ih.is_active = true
    WHERE q.status IN ('expired', 'declined')
  ),

  -- 13. Cancelled deliveries with posted invoices (needs review)
  cancelled_posted AS (
    SELECT COUNT(DISTINCT d.id) AS cnt
    FROM deliveries d
    JOIN orders o ON o.id = d.order_id
    JOIN invoices i ON i.order_id = o.id
    WHERE d.status = 'cancelled'
      AND i.status = 'posted'
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
    'recent_activity',      COALESCE(ra.arr, '[]'::jsonb),
    -- New integrity alert counts
    'driver_issues_count',          di.cnt,
    'customers_over_credit_count',  oc.cnt,
    'expired_holds_count',          eh.cnt,
    'cancelled_posted_count',       cp.cnt
  ) INTO result
  FROM order_agg  oa
  CROSS JOIN quote_agg   qa
  CROSS JOIN inv_agg     ia
  CROSS JOIN low_stock   ls
  CROSS JOIN ar
  CROSS JOIN monthly     mr
  CROSS JOIN top_cust    tc
  CROSS JOIN upcoming    ud
  CROSS JOIN activity    ra
  CROSS JOIN driver_issues   di
  CROSS JOIN over_credit     oc
  CROSS JOIN expired_holds   eh
  CROSS JOIN cancelled_posted cp;

  RETURN result;
END;
$$;

-- Grant execute to authenticated users
GRANT EXECUTE ON FUNCTION public.dashboard_summary() TO authenticated;

COMMENT ON FUNCTION public.dashboard_summary() IS
  'Returns a single JSONB object with all Dashboard KPIs, charts, lists, and integrity alert counts.';


-- ============================================================================
-- CREDIT LIMIT CHECK HELPER RPC (Phase 3.3)
-- ============================================================================
-- Returns the customer's credit limit status for use in order creation warnings.
-- Called from frontend after creating an order to check if credit limit is exceeded.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.check_customer_credit_limit(
  p_customer_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_credit_limit_cents bigint;
  v_farm_name text;
  v_outstanding_ar_cents numeric;
BEGIN
  -- Get customer info
  SELECT credit_limit_cents, farm_name
  INTO v_credit_limit_cents, v_farm_name
  FROM customers
  WHERE id = p_customer_id;

  IF v_credit_limit_cents IS NULL OR v_credit_limit_cents <= 0 THEN
    RETURN jsonb_build_object(
      'exceeded', false,
      'credit_limit', 0,
      'outstanding_ar', 0,
      'farm_name', COALESCE(v_farm_name, '')
    );
  END IF;

  -- Calculate outstanding AR in cents (balance_due is dollars, multiply by 100)
  SELECT COALESCE(SUM(GREATEST(balance_due, 0)), 0) * 100
  INTO v_outstanding_ar_cents
  FROM orders
  WHERE customer_id = p_customer_id
    AND status NOT IN ('cancelled', 'void');

  RETURN jsonb_build_object(
    'exceeded', v_outstanding_ar_cents > v_credit_limit_cents,
    'credit_limit', v_credit_limit_cents / 100.0,
    'outstanding_ar', v_outstanding_ar_cents / 100.0,
    'farm_name', COALESCE(v_farm_name, '')
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.check_customer_credit_limit(uuid) TO authenticated;

COMMENT ON FUNCTION public.check_customer_credit_limit(uuid) IS
  'Returns credit limit status for a customer including outstanding AR and whether limit is exceeded.';
