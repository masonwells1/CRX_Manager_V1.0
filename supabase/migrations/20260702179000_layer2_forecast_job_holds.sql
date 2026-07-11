-- Layer 2 · Part B · Cycle B4 — get_inventory_forecast: include job-hold demand,
-- bucketed by jobs.job_date (§4B.4)
-- ============================================================================
-- The live forecast reads ONLY crop_program holds and buckets them by
-- DATE_TRUNC('month', expires_at − 14 days). Job holds carry expires_at = NULL
-- (they release on the job lifecycle, not a timer — §6.3), so they are invisible
-- to the forecast AND unbucketable by expiry. Fix (§4B.4, decided): join jobs via
-- source_id and bucket job demand on jobs.job_date.
--
-- Structure change (rest matches the live definition, diffed against the live
-- catalog and typed explicitly — not cloned dynamically; plpgsql_check CLEAN):
--   • A `demand_rows` CTE UNIONs two sources into a common (product, source, customer,
--     quantity, kind, needed_month) shape:
--       - crop_program holds → needed_month = month(expires_at − 14d)  [unchanged rule]
--       - job holds          → JOIN jobs j ON j.id = ih.source_id,
--                              needed_month = month(j.job_date); j not deleted, dated,
--                              within the horizon.
--   • planned_demand = SUM over BOTH kinds (a product with only job demand now appears).
--   • NEW output column job_demand = the job-sourced subset of planned_demand (drives
--     the InventoryPage forecast "Jobs" column).
--   • quote_count stays quotes-only (FILTER kind='crop_program') so it keeps meaning;
--     customer_count unchanged (job holds carry no customer_id, so they don't inflate it).
-- Read-only RPC; same (integer) signature — CREATE OR REPLACE, no new overload.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_inventory_forecast(p_months_ahead integer DEFAULT 6)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  RETURN (
    SELECT COALESCE(jsonb_agg(row_to_json(r)), '[]'::jsonb)
    FROM (
      WITH demand_rows AS (
        -- crop_program holds bucketed by expiry − 14d (live behavior, unchanged)
        SELECT ih.product_id, ih.source_id, ih.customer_id, ih.quantity,
               'crop_program'::text AS kind,
               DATE_TRUNC('month', (ih.expires_at - INTERVAL '14 days'))::date AS needed_month
        FROM inventory_holds ih
        WHERE ih.is_active = true
          AND ih.hold_type = 'crop_program'
          AND ih.expires_at IS NOT NULL
          AND (ih.expires_at - INTERVAL '14 days') <= CURRENT_DATE + (p_months_ahead || ' months')::interval
        UNION ALL
        -- LAYER2: job holds bucketed by jobs.job_date (expires_at is NULL for job holds)
        SELECT ih.product_id, ih.source_id, ih.customer_id, ih.quantity,
               'job'::text AS kind,
               DATE_TRUNC('month', j.job_date)::date AS needed_month
        FROM inventory_holds ih
        JOIN jobs j ON j.id = ih.source_id
        WHERE ih.is_active = true
          AND ih.hold_type = 'job'
          AND j.deleted_at IS NULL
          AND j.job_date IS NOT NULL
          AND j.job_date <= (CURRENT_DATE + (p_months_ahead || ' months')::interval)::date
      )
      SELECT
        p.id AS product_id,
        p.product_name,
        p.sku,
        dr.needed_month,
        SUM(dr.quantity) AS planned_demand,
        COALESCE(SUM(dr.quantity) FILTER (WHERE dr.kind = 'job'), 0) AS job_demand,
        -- Codex A+B P2 #5: wrap the scalar subquery in COALESCE so a NO-ROW result
        -- (product with a job hold but no Main Warehouse inventory row) yields 0, not
        -- NULL — the inner COALESCE only guards a NULL column, not a missing row, and
        -- the frontend calls .toLocaleString() on these (would crash on null).
        COALESCE((SELECT i.quantity_available FROM inventory i WHERE i.product_id = p.id AND i.location = 'Main Warehouse' LIMIT 1), 0) AS current_available,
        COALESCE((SELECT i.quantity_prebooked FROM inventory i WHERE i.product_id = p.id AND i.location = 'Main Warehouse' LIMIT 1), 0) AS prebooked,
        (SELECT COALESCE(SUM(poi.quantity_ordered - poi.quantity_received), 0)
         FROM purchase_order_items poi
         JOIN purchase_orders po ON po.id = poi.purchase_order_id
         WHERE poi.product_id = p.id AND po.status IN ('submitted', 'partially_received')
        ) AS on_order,
        COUNT(DISTINCT dr.source_id) FILTER (WHERE dr.kind = 'crop_program') AS quote_count,
        COUNT(DISTINCT dr.customer_id) AS customer_count
      FROM demand_rows dr
      JOIN products p ON p.id = dr.product_id
      GROUP BY p.id, p.product_name, p.sku, dr.needed_month
      ORDER BY dr.needed_month, p.product_name
    ) r
  );
END;
$function$;
