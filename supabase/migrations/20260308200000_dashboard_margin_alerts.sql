-- ============================================================================
-- FINANCIAL DASHBOARD: MARGIN ALERTS
-- ============================================================================
-- Extends financial_dashboard_summary() with 3 new metrics:
--   14. bottom_products_by_margin  — Bottom 10 products by margin % this season
--   15. bottom_customers_by_margin — Bottom 10 customers by margin % this season
--   16. monthly_margin_trend       — Last 12 months of margin % trend
-- ============================================================================

CREATE OR REPLACE FUNCTION public.financial_dashboard_summary()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result jsonb;
  _role  text;
BEGIN
  -- Admin-only guard
  _role := COALESCE(
    current_setting('request.jwt.claims', true)::jsonb ->> 'user_role',
    (SELECT role FROM public.profiles WHERE id = auth.uid())
  );
  IF _role IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'permission denied: admin role required';
  END IF;

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

  -- 5. Open AR balance (from posted invoices — source of truth)
  ar AS (
    SELECT COALESCE(SUM(GREATEST(balance_cents, 0)), 0) / 100.0 AS balance
    FROM invoices
    WHERE status = 'posted'
  ),

  -- 6. Customers over credit limit (from posted invoices — source of truth)
  over_credit AS (
    SELECT COUNT(*) AS cnt
    FROM customers c
    WHERE c.credit_limit_cents IS NOT NULL
      AND c.credit_limit_cents > 0
      AND (
        SELECT COALESCE(SUM(GREATEST(i.balance_cents, 0)), 0)
        FROM invoices i
        WHERE i.customer_id = c.id
          AND i.status = 'posted'
      ) > c.credit_limit_cents
  ),

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
    WHERE status = 'pending'
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
  ),

  -- === INVENTORY POSITION ===

  -- 11. Value of unreceived PO items (submitted or partially_received POs)
  po_unreceived AS (
    SELECT COALESCE(SUM(
      (poi.quantity_ordered - COALESCE(poi.quantity_received, 0)) * poi.unit_cost
    ), 0) AS value
    FROM purchase_order_items poi
    JOIN purchase_orders po ON po.id = poi.purchase_order_id
    WHERE po.status IN ('submitted', 'partially_received')
  ),

  -- 12. Floor inventory value (quantity_available * product cost)
  floor_inv AS (
    SELECT
      COALESCE(SUM(inv.quantity_available * COALESCE(p.current_cost, 0)), 0) AS total_value,
      COALESCE(SUM(
        GREATEST(inv.quantity_available - inv.quantity_prebooked, 0) * COALESCE(p.current_cost, 0)
      ), 0) AS free_value
    FROM inventory inv
    JOIN products p ON p.id = inv.product_id
    WHERE inv.quantity_available > 0
  ),

  -- 13. Committed order value (confirmed/partially_fulfilled, undelivered items at cost)
  committed_orders AS (
    SELECT COALESCE(SUM(
      oi.quantity_remaining * oi.cost_per_unit
    ), 0) AS value
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    WHERE o.status IN ('confirmed', 'partially_fulfilled')
      AND o.deleted_at IS NULL
      AND oi.quantity_remaining > 0
  ),

  -- === MARGIN ALERTS ===

  -- 14. Bottom 10 products by margin % this season
  bottom_products AS (
    SELECT jsonb_agg(row_to_json(bp)::jsonb ORDER BY bp.margin_pct ASC) AS arr
    FROM (
      SELECT
        p.product_name,
        COALESCE(SUM(oi.total_units_needed * oi.price_per_unit), 0) AS total_revenue,
        COALESCE(SUM(oi.total_units_needed * oi.cost_per_unit), 0) AS total_cost,
        ROUND(
          CASE WHEN SUM(oi.total_units_needed * oi.price_per_unit) > 0
            THEN ((SUM(oi.total_units_needed * oi.price_per_unit) - SUM(oi.total_units_needed * oi.cost_per_unit))
                  / NULLIF(SUM(oi.total_units_needed * oi.price_per_unit), 0)) * 100
            ELSE 0
          END, 1
        ) AS margin_pct,
        COALESCE(SUM(oi.total_units_needed), 0) AS units_sold
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      JOIN products p ON p.id = oi.product_id
      WHERE o.deleted_at IS NULL
        AND o.status NOT IN ('cancelled', 'draft')
        AND compute_season(COALESCE(o.order_date, o.created_at::date)) = compute_season(CURRENT_DATE)
      GROUP BY p.id, p.product_name
      HAVING SUM(oi.total_units_needed * oi.price_per_unit) > 0
      ORDER BY margin_pct ASC
      LIMIT 10
    ) bp
  ),

  -- 15. Bottom 10 customers by margin % this season
  bottom_customers AS (
    SELECT jsonb_agg(row_to_json(bc)::jsonb ORDER BY bc.margin_pct ASC) AS arr
    FROM (
      SELECT
        c.farm_name,
        COALESCE(SUM(o.total_price), 0) AS total_revenue,
        COALESCE(SUM(o.total_cost), 0) AS total_cost,
        ROUND(
          CASE WHEN SUM(o.total_price) > 0
            THEN ((SUM(o.total_price) - SUM(o.total_cost))
                  / NULLIF(SUM(o.total_price), 0)) * 100
            ELSE 0
          END, 1
        ) AS margin_pct,
        COUNT(*)::int AS order_count
      FROM orders o
      JOIN customers c ON c.id = o.customer_id
      WHERE o.deleted_at IS NULL
        AND o.status NOT IN ('cancelled', 'draft')
        AND compute_season(COALESCE(o.order_date, o.created_at::date)) = compute_season(CURRENT_DATE)
      GROUP BY c.id, c.farm_name
      HAVING SUM(o.total_price) > 0
      ORDER BY margin_pct ASC
      LIMIT 10
    ) bc
  ),

  -- 16. Monthly margin trend (last 12 months)
  monthly_margin AS (
    SELECT jsonb_agg(row_to_json(mm)::jsonb ORDER BY mm.month) AS arr
    FROM (
      SELECT
        TO_CHAR(COALESCE(order_date, created_at::date), 'YYYY-MM') AS month,
        COALESCE(SUM(total_price), 0) AS revenue,
        COALESCE(SUM(total_cost), 0) AS cost,
        ROUND(
          CASE WHEN SUM(total_price) > 0
            THEN ((SUM(total_price) - SUM(total_cost))
                  / NULLIF(SUM(total_price), 0)) * 100
            ELSE 0
          END, 1
        ) AS margin_pct
      FROM orders
      WHERE deleted_at IS NULL
        AND status NOT IN ('cancelled', 'draft')
      GROUP BY 1
      ORDER BY 1 DESC
      LIMIT 12
    ) mm
  )

  SELECT jsonb_build_object(
    -- Financial KPIs
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
                                  ),
    -- Inventory position
    'po_unreceived_value',        pour.value,
    'floor_inventory_value',      fi.total_value,
    'floor_free_value',           fi.free_value,
    'committed_order_value',      co2.value,
    -- Margin alerts
    'bottom_products_by_margin',  COALESCE(bpm.arr, '[]'::jsonb),
    'bottom_customers_by_margin', COALESCE(bcm.arr, '[]'::jsonb),
    'monthly_margin_trend',       COALESCE(mmt.arr, '[]'::jsonb)
  ) INTO result
  FROM order_agg      oa
  CROSS JOIN quote_agg       qa
  CROSS JOIN monthly         mr
  CROSS JOIN top_cust        tc
  CROSS JOIN ar              ar_total
  CROSS JOIN over_credit     oc
  CROSS JOIN ar_aging        aa
  CROSS JOIN prepay_bal      pb
  CROSS JOIN commission_owed co
  CROSS JOIN po_unreceived   pour
  CROSS JOIN floor_inv       fi
  CROSS JOIN committed_orders co2
  CROSS JOIN bottom_products  bpm
  CROSS JOIN bottom_customers bcm
  CROSS JOIN monthly_margin   mmt
  LEFT JOIN  period_info     pi ON true;

  RETURN result;
END;
$$;

COMMENT ON FUNCTION public.financial_dashboard_summary() IS
  'Returns all financial KPIs for the Financial Dashboard: revenue, profit, margin, '
  'quote pipeline, AR aging buckets, prepay balances, commission owed, period status, '
  'inventory position (PO unreceived, floor value, committed orders), '
  'and margin alerts (bottom products/customers by margin, monthly margin trend).';
