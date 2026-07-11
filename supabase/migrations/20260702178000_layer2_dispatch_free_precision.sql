-- Layer 2 · Part B · Cycle B3 — dedicated dispatch stock-light RPC that excludes
-- a job's OWN reservation from its free stock (§4B.3)
-- ============================================================================
-- DispatchBoard's Layer 1 light computes free = available − prebooked − ALL active
-- holds (client-side, from get_inventory_position's product-level holds_qty). Once
-- jobs hold their own stock (Part A), that ALL-holds subtraction includes the job's
-- OWN hold, so a job fully backed by its own reservation shows "tight/short" — the
-- dispatch analog of the B1 phantom-shortfall. get_inventory_position can't fix this:
-- holds_qty (and B2's job_holds_qty) are PRODUCT-level, but the light needs per-(job,
-- product) attribution to subtract only *this* job's own hold.
--
-- NEW RPC get_dispatch_stock_status(p_job_ids uuid[]) → jsonb rows
--   { job_id, product_id, demand_qty, has_inventory, free_excluding_own_hold, reorder_point }
-- computed entirely server-side:
--   • demand_qty  = job_chemicals converted to inventory units via
--                   field_app_priced_quantity (raw fallback) — mirrors
--                   get_job_inventory_shortfalls / complete_job, so the light no
--                   longer needs the client-side unit conversion.
--   • free_excluding_own_hold = SUM(available − prebooked)
--                   − (ALL active non-expired holds − THIS job's own active job hold).
--     A job's own reservation is added back, so it never warns against itself; every
--     OTHER program's hold still counts (stays conservative — never falsely "ok").
--   • has_inventory = whether any inventory row exists for the product (frontend
--     treats missing inventory as a real 'short', matching Layer 1).
-- Role-gated (require_admin_or_sales_rep) — the dispatch overlay is office-only, and
-- this is defense-in-depth vs get_inventory_position's UI-only gate (§1). Anon EXECUTE
-- revoked explicitly. Read-only; no idempotency key needed.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_dispatch_stock_status(p_job_ids uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  PERFORM require_admin_or_sales_rep();

  IF p_job_ids IS NULL OR array_length(p_job_ids, 1) IS NULL THEN
    RETURN '[]'::jsonb;
  END IF;

  RETURN (
    WITH jobs_in AS (
      SELECT j.id
      FROM jobs j
      WHERE j.id = ANY(p_job_ids)
        AND j.deleted_at IS NULL
        AND j.status IN ('scheduled', 'in_progress')
    ),
    demand AS (
      SELECT ji.id AS job_id, jc.product_id,
             SUM(COALESCE(
               field_app_priced_quantity(jc.quantity, jc.unit, p.inventory_unit, p.product_form),
               jc.quantity
             )) AS demand_qty
      FROM jobs_in ji
      JOIN job_chemicals jc ON jc.job_id = ji.id
      JOIN products p ON p.id = jc.product_id
      WHERE jc.quantity > 0
      GROUP BY ji.id, jc.product_id
    ),
    avail AS (
      SELECT i.product_id,
             SUM(i.quantity_available - i.quantity_prebooked) AS free_base,
             MAX(i.reorder_point) AS reorder_point
      FROM inventory i
      GROUP BY i.product_id
    ),
    total_holds AS (
      SELECT ih.product_id, SUM(ih.quantity) AS holds_qty
      FROM inventory_holds ih
      WHERE ih.is_active = true
        AND (ih.expires_at IS NULL OR ih.expires_at >= CURRENT_DATE)
      GROUP BY ih.product_id
    ),
    own_hold AS (
      SELECT ih.source_id AS job_id, ih.product_id, SUM(ih.quantity) AS own_qty
      FROM inventory_holds ih
      WHERE ih.hold_type = 'job'
        AND ih.is_active = true
        AND (ih.expires_at IS NULL OR ih.expires_at >= CURRENT_DATE)
        AND ih.source_id = ANY(p_job_ids)
      GROUP BY ih.source_id, ih.product_id
    )
    SELECT COALESCE(jsonb_agg(row_to_json(r)), '[]'::jsonb)
    FROM (
      SELECT
        d.job_id,
        d.product_id,
        d.demand_qty,
        (a.product_id IS NOT NULL) AS has_inventory,
        (COALESCE(a.free_base, 0) - (COALESCE(th.holds_qty, 0) - COALESCE(oh.own_qty, 0)))
          AS free_excluding_own_hold,
        COALESCE(a.reorder_point, 0) AS reorder_point
      FROM demand d
      LEFT JOIN avail a        ON a.product_id  = d.product_id
      LEFT JOIN total_holds th ON th.product_id = d.product_id
      LEFT JOIN own_hold oh    ON oh.job_id = d.job_id AND oh.product_id = d.product_id
    ) r
  );
END;
$function$;

-- Anon EXECUTE revoked explicitly (a fresh function defaults to PUBLIC EXECUTE, and
-- Supabase grants anon directly — REVOKE FROM PUBLIC alone does not de-anon).
REVOKE ALL ON FUNCTION public.get_dispatch_stock_status(uuid[]) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.get_dispatch_stock_status(uuid[]) TO authenticated;
