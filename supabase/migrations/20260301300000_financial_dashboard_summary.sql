-- ============================================================================
-- FINANCIAL DASHBOARD SUMMARY RPC
-- ============================================================================
-- Returns all financial KPIs for the Financial Dashboard page.
-- Admin-only page — RPC is SECURITY DEFINER so it runs with elevated privileges.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.financial_dashboard_summary()
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

  -- 3. Monthly revenue & profit for last 12 months
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

  -- 4. Top 5 customers by revenue
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

  -- 5. Open AR balance
  ar AS (
    SELECT COALESCE(SUM(GREATEST(balance_due, 0)), 0) AS balance
    FROM orders
  ),

  -- 6. Customers over credit limit
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

  -- === NEW FINANCIAL AGGREGATIONS ===

  -- 7. AR Aging buckets
  ar_aging AS (
    SELECT
      COALESCE(SUM(CASE WHEN age_days <= 30 THEN balance ELSE 0 END), 0) AS current_bucket,
      COALESCE(SUM(CASE WHEN age_days BETWEEN 31 AND 60 THEN balance ELSE 0 END), 0) AS days_31_60,
      COALESCE(SUM(CASE WHEN age_days BETWEEN 61 AND 90 THEN balance ELSE 0 END), 0) AS days_61_90,
      COALESCE(SUM(CASE WHEN age_days > 90 THEN balance ELSE 0 END), 0) AS days_90_plus
    FROM (
      SELECT
        GREATEST(i.balance_cents, 0) / 100.0 AS balance,
        EXTRACT(DAY FROM NOW() - i.invoice_date)::int AS age_days
      FROM invoices i
      WHERE i.status = 'posted'
        AND i.balance_cents > 0
    ) aged
  ),

  -- 8. Total unallocated prepay balance
  prepay_bal AS (
    SELECT COALESCE(SUM(prepay_balance_cents), 0) / 100.0 AS total_unallocated
    FROM customers
    WHERE prepay_balance_cents > 0
  ),

  -- 9. Total unpaid commissions
  commission_owed AS (
    SELECT COALESCE(SUM(commission_amount), 0) AS total_owed
    FROM commissions
    WHERE status = 'earned'
      AND paid_date IS NULL
  ),

  -- 10. Current accounting period
  period_info AS (
    SELECT
      COALESCE(TO_CHAR(period_start, 'Mon YYYY'), TO_CHAR(NOW(), 'Mon YYYY')) AS name,
      COALESCE(status, 'open') AS status,
      CASE
        WHEN period_end IS NOT NULL
          THEN GREATEST(EXTRACT(DAY FROM period_end - NOW())::int, 0)
        ELSE EXTRACT(DAY FROM (DATE_TRUNC('month', NOW()) + INTERVAL '1 month' - INTERVAL '1 day') - NOW())::int
      END AS days_remaining
    FROM accounting_periods
    WHERE status = 'open'
    ORDER BY period_start DESC
    LIMIT 1
  )

  SELECT jsonb_build_object(
    -- Financial KPIs (moved from dashboard_summary)
    'total_revenue',              oa.total_revenue,
    'total_profit',               oa.total_profit,
    'overall_margin',             CASE WHEN oa.total_revenue > 0
                                    THEN ROUND((oa.total_profit / oa.total_revenue) * 100, 1)
                                    ELSE 0
                                  END,
    'quote_counts',               jsonb_build_object(
                                    'draft',    qa.draft_count,
                                    'sent',     qa.sent_count,
                                    'accepted', qa.accepted_count
                                  ),
    'quote_pipeline_value',       qa.pipeline_value,
    'monthly_revenue',            COALESCE(mr.arr, '[]'::jsonb),
    'top_customers',              COALESCE(tc.arr, '[]'::jsonb),
    'open_ar_balance',            ar_total.balance,
    'customers_over_credit_count', oc.cnt,
    -- New financial aggregations
    'ar_aging_buckets',           jsonb_build_object(
                                    'current',      aa.current_bucket,
                                    'days_31_60',   aa.days_31_60,
                                    'days_61_90',   aa.days_61_90,
                                    'days_90_plus',  aa.days_90_plus
                                  ),
    'total_prepay_unallocated',   pb.total_unallocated,
    'total_commission_owed',      co.total_owed,
    'current_period',             jsonb_build_object(
                                    'name',           COALESCE(pi.name, TO_CHAR(NOW(), 'Mon YYYY')),
                                    'status',         COALESCE(pi.status, 'open'),
                                    'days_remaining', COALESCE(pi.days_remaining, 0)
                                  )
  ) INTO result
  FROM order_agg   oa
  CROSS JOIN quote_agg    qa
  CROSS JOIN monthly      mr
  CROSS JOIN top_cust     tc
  CROSS JOIN ar           ar_total
  CROSS JOIN over_credit  oc
  CROSS JOIN ar_aging     aa
  CROSS JOIN prepay_bal   pb
  CROSS JOIN commission_owed co
  LEFT JOIN  period_info  pi ON true;

  RETURN result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.financial_dashboard_summary() TO authenticated;

COMMENT ON FUNCTION public.financial_dashboard_summary() IS
  'Returns all financial KPIs for the Financial Dashboard: revenue, profit, margin, '
  'quote pipeline, AR aging buckets, prepay balances, commission owed, and period status.';
