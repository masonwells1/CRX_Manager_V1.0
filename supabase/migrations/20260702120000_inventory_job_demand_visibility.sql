-- Layer 1 — inventory-aware scheduling (READ-ONLY). Surfaces which products the next
-- N days of scheduled/in-progress field JOBS will run short of, for the Office Cockpit
-- "Inventory Shortfalls" tile. Read-only, SECURITY DEFINER, search_path pinned,
-- office-role-gated. No tables, no DML, no reservation of inventory.
--
-- SCOPE NOTE: Layer 1 deliberately does NOT fold job demand into get_inventory_position /
-- get_inventory_forecast. Reconciling job demand against planned-quote holds is only exact
-- once Layer 2 gives jobs their own reservations, so this migration adds exactly ONE new
-- read-only RPC and leaves the existing inventory functions untouched.
--
-- job_chemicals.quantity is the per-job product demand (the field complete_job consumes).
-- jobs.deleted_at IS NULL skips soft-deleted jobs.
--
-- QUANTITY-AWARE dedup vs planned-quote holds: a job spawned from a planned quote
-- (jobs.quote_id) is partly/fully covered by that quote's active hold. We count only the
-- UNCOVERED portion (GREATEST(job_qty - hold_coverage, 0)) so the tile neither double-counts
-- a fully-reserved job nor hides the excess when a job is edited larger than its reservation.
-- (Known edge: multiple jobs sharing one quote+product hold can under-count the shared
-- coverage — precise per-job allocation lands with Layer 2 reservations.)

CREATE OR REPLACE FUNCTION public.get_job_inventory_shortfalls(p_days_ahead integer DEFAULT 7)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- Office-only surface: returns GLOBAL upcoming-job numbers + product shortfalls
  -- (SECURITY DEFINER bypasses job RLS) and the only caller is the admin/sales_rep Office
  -- Cockpit. Gate on that role boundary so the broad `authenticated` EXECUTE grant is not
  -- the real gate and no other role can read cross-customer job data.
  PERFORM require_admin_or_sales_rep();

  RETURN (
    WITH win_jobs AS (
      SELECT j.id, j.job_number, j.quote_id
      FROM jobs j
      WHERE j.status IN ('scheduled', 'in_progress')
        AND j.deleted_at IS NULL
        AND j.job_date >= CURRENT_DATE
        AND j.job_date <= (CURRENT_DATE + (p_days_ahead || ' days')::interval)::date
    ),
    -- Per-product UNCOVERED job demand: job need minus the parent planned-quote's active
    -- hold coverage for that product (quantity-aware, not all-or-nothing).
    demand AS (
      SELECT jc.product_id,
             SUM(GREATEST(jc.quantity - COALESCE(hc.covered, 0), 0)) AS needed_qty,
             COUNT(DISTINCT wj.id) FILTER (WHERE jc.quantity - COALESCE(hc.covered, 0) > 0) AS job_count,
             ARRAY_AGG(DISTINCT wj.job_number ORDER BY wj.job_number)
               FILTER (WHERE jc.quantity - COALESCE(hc.covered, 0) > 0) AS job_numbers
      FROM win_jobs wj
      JOIN job_chemicals jc ON jc.job_id = wj.id
      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(ih.quantity), 0) AS covered
        FROM inventory_holds ih
        WHERE ih.source_id = wj.quote_id
          AND ih.product_id = jc.product_id
          AND ih.is_active = true
          AND (ih.expires_at IS NULL OR ih.expires_at >= CURRENT_DATE)
      ) hc ON true
      WHERE jc.quantity > 0
      GROUP BY jc.product_id
    ),
    avail AS (
      SELECT i.product_id,
             COALESCE(SUM(i.quantity_available - i.quantity_prebooked), 0) AS avail_less_prebooked
      FROM inventory i
      GROUP BY i.product_id
    ),
    active_holds AS (
      SELECT ih.product_id, SUM(ih.quantity) AS holds_qty
      FROM inventory_holds ih
      WHERE ih.is_active = true
        AND (ih.expires_at IS NULL OR ih.expires_at >= CURRENT_DATE)
      GROUP BY ih.product_id
    )
    SELECT COALESCE(jsonb_agg(row_to_json(r) ORDER BY r.shortfall_qty DESC), '[]'::jsonb)
    FROM (
      SELECT
        d.product_id,
        p.product_name,
        p.inventory_unit,
        d.needed_qty,
        (COALESCE(a.avail_less_prebooked, 0) - COALESCE(ah.holds_qty, 0)) AS available_free,
        (d.needed_qty - (COALESCE(a.avail_less_prebooked, 0) - COALESCE(ah.holds_qty, 0))) AS shortfall_qty,
        d.job_count,
        d.job_numbers
      FROM demand d
      JOIN products p ON p.id = d.product_id
      LEFT JOIN avail a          ON a.product_id  = d.product_id
      LEFT JOIN active_holds ah  ON ah.product_id = d.product_id
      -- Only real uncovered demand that exceeds today's free stock.
      WHERE d.needed_qty > 0
        AND d.needed_qty > (COALESCE(a.avail_less_prebooked, 0) - COALESCE(ah.holds_qty, 0))
    ) r
  );
END;
$function$;

-- Revoke PUBLIC *and* anon explicitly: Supabase default privileges grant EXECUTE to anon
-- on new public functions, so REVOKE ... FROM PUBLIC alone leaves the direct anon grant in
-- place. Match the get_inventory_position / get_fields_geojson_by_ids acl (authenticated +
-- service_role only). The in-body require_admin_or_sales_rep() gate is the real boundary;
-- this keeps the grant honest and clears the Supabase advisor flag.
REVOKE ALL ON FUNCTION public.get_job_inventory_shortfalls(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_job_inventory_shortfalls(integer) TO authenticated, service_role;
