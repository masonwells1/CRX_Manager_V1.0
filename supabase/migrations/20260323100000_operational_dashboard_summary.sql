-- ============================================================================
-- OPERATIONAL DASHBOARD SUMMARY RPC
-- ============================================================================
-- Returns comprehensive operational metrics for the Operational Dashboard.
-- Accessible by all authenticated users (drivers see limited data on frontend).
-- Does NOT replace dashboard_summary() — new function alongside it.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.operational_dashboard_summary()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result       jsonb;
  _season_start date;
  _season_end   date;
BEGIN
  -- Calculate season boundaries (Oct 1 – Sep 30)
  IF EXTRACT(MONTH FROM CURRENT_DATE) >= 10 THEN
    _season_start := MAKE_DATE(EXTRACT(YEAR FROM CURRENT_DATE)::int, 10, 1);
    _season_end   := MAKE_DATE(EXTRACT(YEAR FROM CURRENT_DATE)::int + 1, 9, 30);
  ELSE
    _season_start := MAKE_DATE(EXTRACT(YEAR FROM CURRENT_DATE)::int - 1, 10, 1);
    _season_end   := MAKE_DATE(EXTRACT(YEAR FROM CURRENT_DATE)::int, 9, 30);
  END IF;

  WITH
  -- ═══════════════════════════════════════════════════════════════
  -- SECTION 1: TOP KPI ROW
  -- ═══════════════════════════════════════════════════════════════

  -- 1. Active orders (confirmed + partially_fulfilled)
  active_orders AS (
    SELECT COUNT(*) AS cnt
    FROM orders
    WHERE status IN ('confirmed', 'partially_fulfilled')
      AND deleted_at IS NULL
  ),

  -- 2. Open quotes (draft + sent counts)
  open_quotes AS (
    SELECT
      COUNT(*) FILTER (WHERE status = 'draft') AS draft_cnt,
      COUNT(*) FILTER (WHERE status = 'sent')  AS sent_cnt
    FROM quotes
  ),

  -- 3. Pending deliveries (scheduled + in_progress)
  pending_deliveries AS (
    SELECT COUNT(*) AS cnt
    FROM deliveries
    WHERE status IN ('scheduled', 'in_progress')
  ),

  -- 4. Open POs (submitted + partially_received)
  open_pos AS (
    SELECT COUNT(*) AS cnt
    FROM purchase_orders
    WHERE status IN ('submitted', 'partially_received')
  ),

  -- ═══════════════════════════════════════════════════════════════
  -- SECTION 3: INVENTORY POSITION (units, not dollars)
  -- ═══════════════════════════════════════════════════════════════

  -- 5. Inventory totals
  inv_agg AS (
    SELECT
      COALESCE(SUM(quantity_available), 0) AS total_available,
      COALESCE(SUM(quantity_prebooked), 0) AS total_prebooked
    FROM inventory
  ),

  -- 6. Units on order (from open POs)
  on_order_units AS (
    SELECT
      COALESCE(SUM(poi.quantity_ordered - COALESCE(poi.quantity_received, 0)), 0) AS units,
      COUNT(DISTINCT po.id) AS po_count
    FROM purchase_order_items poi
    JOIN purchase_orders po ON po.id = poi.purchase_order_id
    WHERE po.status IN ('submitted', 'partially_received')
  ),

  -- 7. Units committed (on confirmed orders, not yet delivered)
  committed_units AS (
    SELECT
      COALESCE(SUM(oi.quantity_remaining), 0) AS units,
      COUNT(DISTINCT o.id) AS order_count
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    WHERE o.status IN ('confirmed', 'partially_fulfilled')
      AND o.deleted_at IS NULL
      AND oi.quantity_remaining > 0
  ),

  -- ═══════════════════════════════════════════════════════════════
  -- SECTION 4: DELIVERY COMMAND CENTER
  -- ═══════════════════════════════════════════════════════════════

  -- 8. Next 10 upcoming deliveries
  upcoming AS (
    SELECT jsonb_agg(row_to_json(ud)::jsonb ORDER BY ud.scheduled_date ASC) AS arr
    FROM (
      SELECT
        d.id,
        d.delivery_number,
        d.scheduled_date::text AS scheduled_date,
        d.status,
        cust.farm_name AS customer_name,
        drv.full_name  AS driver_name,
        d.assigned_driver
      FROM deliveries d
      LEFT JOIN customers cust ON cust.id = d.customer_id
      LEFT JOIN profiles  drv  ON drv.id  = d.assigned_driver
      WHERE d.status IN ('scheduled', 'in_progress')
      ORDER BY d.scheduled_date ASC
      LIMIT 10
    ) ud
  ),

  -- 9. Delivery stats
  delivery_stats AS (
    SELECT
      COUNT(*) FILTER (WHERE d.scheduled_date = CURRENT_DATE)                                AS today_count,
      COUNT(*) FILTER (WHERE d.scheduled_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 6)     AS this_week_count,
      COUNT(*) FILTER (WHERE d.assigned_driver IS NULL)                                       AS unassigned_count
    FROM deliveries d
    WHERE d.status IN ('scheduled', 'in_progress')
  ),

  -- 10. Pending delivery remainders
  remainder_count AS (
    SELECT COUNT(*) AS cnt
    FROM delivery_remainders
    WHERE status = 'pending'
  ),

  -- ═══════════════════════════════════════════════════════════════
  -- SECTION 5: SALES PIPELINE SNAPSHOT
  -- ═══════════════════════════════════════════════════════════════

  -- 11. Quote pipeline (draft / sent / accepted)
  quote_pipeline AS (
    SELECT
      COUNT(*) FILTER (WHERE status = 'draft')    AS draft_cnt,
      COUNT(*) FILTER (WHERE status = 'sent')     AS sent_cnt,
      COUNT(*) FILTER (WHERE status = 'accepted') AS accepted_cnt
    FROM quotes
  ),

  -- 12. Orders this season + this month
  orders_ytd AS (
    SELECT
      COUNT(*) AS season_total,
      COUNT(*) FILTER (
        WHERE DATE_TRUNC('month', COALESCE(order_date, created_at::date)) = DATE_TRUNC('month', CURRENT_DATE)
      ) AS this_month
    FROM orders
    WHERE COALESCE(order_date, created_at::date) >= _season_start
      AND deleted_at IS NULL
  ),

  -- 13. Deliveries completed this season + this month
  deliveries_completed AS (
    SELECT
      COUNT(*) AS season_total,
      COUNT(*) FILTER (
        WHERE DATE_TRUNC('month', completed_at) = DATE_TRUNC('month', CURRENT_DATE)
      ) AS this_month
    FROM deliveries
    WHERE status = 'completed'
      AND completed_at >= _season_start
  ),

  -- ═══════════════════════════════════════════════════════════════
  -- SECTION 6: OPERATIONAL ALERTS
  -- ═══════════════════════════════════════════════════════════════

  -- 14. Low stock
  low_stock AS (
    SELECT COUNT(*) AS cnt
    FROM inventory
    WHERE reorder_point > 0
      AND quantity_available <= reorder_point
  ),

  -- 15. Driver issues
  driver_issues AS (
    SELECT COUNT(*) AS cnt
    FROM deliveries
    WHERE issue_type IS NOT NULL
      AND status = 'completed'
  ),

  -- 16. Expired quote holds
  expired_holds AS (
    SELECT COUNT(DISTINCT q.id) AS cnt
    FROM quotes q
    JOIN inventory_holds ih ON ih.source_id = q.id AND ih.is_active = true
    WHERE q.status IN ('expired', 'declined')
  ),

  -- 17. Cancelled deliveries with posted invoices
  cancelled_posted AS (
    SELECT COUNT(DISTINCT d.id) AS cnt
    FROM deliveries d
    JOIN orders o ON o.id = d.order_id
    JOIN invoices i ON i.order_id = o.id
    WHERE d.status = 'cancelled'
      AND i.status = 'posted'
  ),

  -- 18. Quotes expiring within 3 days
  expiring_quotes AS (
    SELECT COUNT(*) AS cnt
    FROM quotes
    WHERE status IN ('draft', 'sent')
      AND expires_at IS NOT NULL
      AND expires_at BETWEEN CURRENT_DATE AND CURRENT_DATE + 3
  ),

  -- 19. Overdue deliveries (past scheduled date, still open)
  overdue_deliveries AS (
    SELECT COUNT(*) AS cnt
    FROM deliveries
    WHERE scheduled_date < CURRENT_DATE
      AND status IN ('scheduled', 'in_progress')
  ),

  -- 20. POs expected today
  pos_expected_today AS (
    SELECT COUNT(*) AS cnt
    FROM purchase_orders
    WHERE expected_delivery_date = CURRENT_DATE
      AND status IN ('submitted', 'partially_received')
  ),

  -- 21. Expiring applicator licenses (within 30 days)
  expiring_licenses AS (
    SELECT COUNT(*) AS cnt
    FROM applicator_licenses
    WHERE is_active = true
      AND expiry_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 30
  ),

  -- ═══════════════════════════════════════════════════════════════
  -- SECTION 7: MONTHLY ACTIVITY CHART (last 12 months)
  -- ═══════════════════════════════════════════════════════════════

  -- 22. Monthly activity triple-bar data
  monthly_activity AS (
    SELECT jsonb_agg(row_to_json(ma)::jsonb ORDER BY ma.month) AS arr
    FROM (
      SELECT
        m.month,
        COALESCE(oc.cnt, 0) AS orders_created,
        COALESCE(dc.cnt, 0) AS deliveries_completed,
        COALESCE(pr.cnt, 0) AS pos_received
      FROM (
        SELECT TO_CHAR(d, 'YYYY-MM') AS month
        FROM generate_series(
          DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '11 months',
          DATE_TRUNC('month', CURRENT_DATE),
          '1 month'::interval
        ) d
      ) m
      LEFT JOIN (
        SELECT TO_CHAR(COALESCE(order_date, created_at::date), 'YYYY-MM') AS month, COUNT(*) AS cnt
        FROM orders WHERE deleted_at IS NULL GROUP BY 1
      ) oc ON oc.month = m.month
      LEFT JOIN (
        SELECT TO_CHAR(completed_at, 'YYYY-MM') AS month, COUNT(*) AS cnt
        FROM deliveries WHERE status = 'completed' AND completed_at IS NOT NULL GROUP BY 1
      ) dc ON dc.month = m.month
      LEFT JOIN (
        SELECT TO_CHAR(received_at, 'YYYY-MM') AS month, COUNT(*) AS cnt
        FROM receiving_records GROUP BY 1
      ) pr ON pr.month = m.month
      ORDER BY m.month
    ) ma
  ),

  -- ═══════════════════════════════════════════════════════════════
  -- SECTION 8: SEASON & PERIOD INFO
  -- ═══════════════════════════════════════════════════════════════

  -- 23. Current accounting period
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

  -- ═══════════════════════════════════════════════════════════════
  -- SECTION 9: RECENT ACTIVITY (15 items)
  -- ═══════════════════════════════════════════════════════════════

  -- 24. Last 15 activity feed items
  activity AS (
    SELECT jsonb_agg(row_to_json(af)::jsonb ORDER BY af.created_at DESC) AS arr
    FROM (
      SELECT id, event_type, description, created_at
      FROM activity_feed
      ORDER BY created_at DESC
      LIMIT 15
    ) af
  ),

  -- ═══════════════════════════════════════════════════════════════
  -- SECTION 2: TEAM BOARD ACTION ITEMS
  -- ═══════════════════════════════════════════════════════════════

  -- 25. Team action items (pinned, urgent/high, overdue, or assigned to current user)
  team_action_items AS (
    SELECT jsonb_agg(row_to_json(ti)::jsonb) AS arr
    FROM (
      SELECT
        tn.id,
        tn.title,
        tn.priority,
        tn.due_date::text AS due_date,
        tn.note_type,
        tn.is_pinned,
        tn.assigned_to,
        p.full_name AS assignee_name
      FROM team_notes tn
      LEFT JOIN profiles p ON p.id = tn.assigned_to
      WHERE tn.is_completed = false
        AND tn.deleted_at IS NULL
        AND (
          tn.is_pinned = true
          OR tn.priority IN ('urgent', 'high')
          OR (tn.due_date IS NOT NULL AND tn.due_date < CURRENT_DATE)
          OR tn.assigned_to = auth.uid()
        )
      ORDER BY
        CASE WHEN tn.is_pinned THEN 0 ELSE 1 END,
        CASE tn.priority
          WHEN 'urgent' THEN 0
          WHEN 'high'   THEN 1
          WHEN 'medium' THEN 2
          ELSE 3
        END,
        tn.due_date NULLS LAST
      LIMIT 10
    ) ti
  )

  -- ═══════════════════════════════════════════════════════════════
  -- BUILD RESULT OBJECT
  -- ═══════════════════════════════════════════════════════════════

  SELECT jsonb_build_object(
    -- Section 1: KPIs
    'active_orders_count',        ao.cnt,
    'open_quotes_draft',          oq.draft_cnt,
    'open_quotes_sent',           oq.sent_cnt,
    'pending_deliveries_count',   pd.cnt,
    'open_pos_count',             op.cnt,

    -- Section 2: Team Board
    'team_action_items',          COALESCE(tai.arr, '[]'::jsonb),

    -- Section 3: Inventory Position
    'inventory_available',        ia.total_available,
    'inventory_prebooked',        ia.total_prebooked,
    'on_order_units',             oou.units,
    'on_order_po_count',          oou.po_count,
    'committed_units',            cu.units,
    'committed_order_count',      cu.order_count,

    -- Section 4: Delivery Command Center
    'upcoming_deliveries',        COALESCE(ud.arr, '[]'::jsonb),
    'delivery_today',             ds.today_count,
    'delivery_this_week',         ds.this_week_count,
    'delivery_unassigned',        ds.unassigned_count,
    'delivery_remainders_count',  rc.cnt,

    -- Section 5: Sales Pipeline
    'quote_pipeline_draft',       qp.draft_cnt,
    'quote_pipeline_sent',        qp.sent_cnt,
    'quote_pipeline_accepted',    qp.accepted_cnt,
    'orders_ytd_total',           oytd.season_total,
    'orders_this_month',          oytd.this_month,
    'deliveries_completed_total', dcomp.season_total,
    'deliveries_completed_this_month', dcomp.this_month,

    -- Section 6: Alerts
    'low_stock_count',            ls.cnt,
    'driver_issues_count',        di.cnt,
    'expired_holds_count',        eh.cnt,
    'cancelled_posted_count',     cp.cnt,
    'expiring_quotes_count',      eq.cnt,
    'overdue_deliveries_count',   od.cnt,
    'pos_expected_today_count',   pet.cnt,
    'expiring_licenses_count',    el.cnt,

    -- Section 7: Monthly Chart
    'monthly_activity',           COALESCE(mact.arr, '[]'::jsonb),

    -- Section 8: Season & Period
    'season_label',               CASE WHEN EXTRACT(MONTH FROM CURRENT_DATE) >= 10
                                    THEN EXTRACT(YEAR FROM CURRENT_DATE)::int || '-' || (EXTRACT(YEAR FROM CURRENT_DATE)::int + 1)
                                    ELSE (EXTRACT(YEAR FROM CURRENT_DATE)::int - 1) || '-' || EXTRACT(YEAR FROM CURRENT_DATE)::int
                                  END,
    'season_days_remaining',      (_season_end - CURRENT_DATE),
    'season_days_elapsed',        (CURRENT_DATE - _season_start),
    'period_name',                COALESCE(pi.name, TO_CHAR(NOW(), 'Mon YYYY')),
    'period_status',              COALESCE(pi.status, 'open'),
    'period_days_remaining',      COALESCE(pi.days_remaining, 0),

    -- Section 9: Recent Activity
    'recent_activity',            COALESCE(act.arr, '[]'::jsonb)
  ) INTO result
  FROM active_orders       ao
  CROSS JOIN open_quotes        oq
  CROSS JOIN pending_deliveries pd
  CROSS JOIN open_pos           op
  CROSS JOIN inv_agg            ia
  CROSS JOIN on_order_units     oou
  CROSS JOIN committed_units    cu
  CROSS JOIN upcoming           ud
  CROSS JOIN delivery_stats     ds
  CROSS JOIN remainder_count    rc
  CROSS JOIN quote_pipeline     qp
  CROSS JOIN orders_ytd         oytd
  CROSS JOIN deliveries_completed dcomp
  CROSS JOIN low_stock          ls
  CROSS JOIN driver_issues      di
  CROSS JOIN expired_holds      eh
  CROSS JOIN cancelled_posted   cp
  CROSS JOIN expiring_quotes    eq
  CROSS JOIN overdue_deliveries od
  CROSS JOIN pos_expected_today pet
  CROSS JOIN expiring_licenses  el
  CROSS JOIN monthly_activity   mact
  CROSS JOIN activity           act
  CROSS JOIN team_action_items  tai
  LEFT JOIN  period_info        pi ON true;

  RETURN result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.operational_dashboard_summary() TO authenticated;

COMMENT ON FUNCTION public.operational_dashboard_summary() IS
  'Returns comprehensive operational dashboard data: KPIs (orders, quotes, deliveries, POs), '
  'inventory position (floor, on-order, committed), delivery command center, sales pipeline, '
  'operational alerts (9 types), monthly activity chart, season/period info, '
  'recent activity, and team board action items.';
