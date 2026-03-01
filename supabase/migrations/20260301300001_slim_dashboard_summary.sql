-- ============================================================================
-- SLIM DOWN dashboard_summary() — Remove financial fields
-- ============================================================================
-- Phase 1 Dashboard Split: This RPC now returns only operational data.
-- Financial data is served by financial_dashboard_summary() instead.
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
  -- 1. Inventory totals
  inv_agg AS (
    SELECT
      COALESCE(SUM(quantity_available), 0)  AS total_available,
      COALESCE(SUM(quantity_prebooked), 0)  AS total_prebooked
    FROM inventory
  ),

  -- 2. Low stock count
  low_stock AS (
    SELECT COUNT(*) AS cnt
    FROM inventory
    WHERE reorder_point > 0
      AND quantity_available <= reorder_point
  ),

  -- 3. Next 5 upcoming deliveries
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

  -- 4. Last 10 activity feed items
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

  -- 5. Driver issues count
  driver_issues AS (
    SELECT COUNT(*) AS cnt
    FROM deliveries
    WHERE issue_type IS NOT NULL
      AND status = 'completed'
  ),

  -- 6. Expired quote holds
  expired_holds AS (
    SELECT COUNT(DISTINCT q.id) AS cnt
    FROM quotes q
    JOIN inventory_holds ih ON ih.source_id = q.id AND ih.is_active = true
    WHERE q.status IN ('expired', 'declined')
  ),

  -- 7. Cancelled deliveries with posted invoices
  cancelled_posted AS (
    SELECT COUNT(DISTINCT d.id) AS cnt
    FROM deliveries d
    JOIN orders o ON o.id = d.order_id
    JOIN invoices i ON i.order_id = o.id
    WHERE d.status = 'cancelled'
      AND i.status = 'posted'
  )

  SELECT jsonb_build_object(
    'inventory_available',  ia.total_available,
    'inventory_prebooked',  ia.total_prebooked,
    'low_stock_count',      ls.cnt,
    'upcoming_deliveries',  COALESCE(ud.arr, '[]'::jsonb),
    'recent_activity',      COALESCE(ra.arr, '[]'::jsonb),
    'driver_issues_count',          di.cnt,
    'expired_holds_count',          eh.cnt,
    'cancelled_posted_count',       cp.cnt
  ) INTO result
  FROM inv_agg     ia
  CROSS JOIN low_stock   ls
  CROSS JOIN upcoming    ud
  CROSS JOIN activity    ra
  CROSS JOIN driver_issues   di
  CROSS JOIN expired_holds   eh
  CROSS JOIN cancelled_posted cp;

  RETURN result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.dashboard_summary() TO authenticated;

COMMENT ON FUNCTION public.dashboard_summary() IS
  'Returns operational Dashboard KPIs: inventory, deliveries, activity, and integrity alerts. '
  'Financial data moved to financial_dashboard_summary().';
