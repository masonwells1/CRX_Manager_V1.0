-- Layer 2 · Part B · Cycle B1 — get_job_inventory_shortfalls: don't double-count
-- a job's own reservation (§4B.1)
-- ============================================================================
-- Layer 1's get_job_inventory_shortfalls predates job holds. Its `active_holds`
-- CTE subtracts ALL active holds from free stock — but post-A4 that now includes
-- the window jobs' OWN 'job' holds, which ARE the demand being sized here. So a
-- job that reserved its own 60 units has that 60 subtracted from free AND counted
-- as demand → a phantom shortfall whenever free < ~2× its demand.
--
-- FIX (the ONLY change vs live, marked LAYER2<<< / >>>LAYER2): exclude the window
-- jobs' own `job` holds from `active_holds`. Their demand is already accounted for
-- in the `demand` CTE (net of the parent quote's crop_program coverage), so their
-- reservation must not also reduce free. Read-only RPC; verbatim reproduction of
-- the live function otherwise (incl. its field_app_priced_quantity unit handling,
-- which A4's reserve engine now matches).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_job_inventory_shortfalls(p_days_ahead integer DEFAULT 7)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
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
    demand AS (
      -- Codex A+B P2 #3: needed = FULL job demand when the job HAS its own 'job' hold
      -- (that hold is excluded from active_holds below, so free isn't reduced by it);
      -- the leftover quote crop_program hold covers the UN-drawn booking, NOT this job,
      -- so subtracting it too would double-discount and hide real shortfalls (e.g.
      -- 100-booked quote, 60-unit job -> 40 crop hold; with 50 free the true shortfall
      -- is 60 - (50-40) = 50).
      -- Codex round-3 P2: BUT a PRE-EXISTING scheduled/in-progress job (one that
      -- existed before Layer 2 — A4 does no backfill, §6.6) has no own 'job' hold yet,
      -- so nothing is excluded from active_holds; falling through to full demand while
      -- the crop hold is still subtracted from free would report a PHANTOM shortfall.
      -- So: cover = 0 when the job has its own hold; otherwise fall back to the parent
      -- quote's crop coverage (the Layer-1 behavior) until the job is reserved.
      SELECT jc.product_id,
             SUM(GREATEST(cq.demand_qty - cov.covered, 0)) AS needed_qty,
             COUNT(DISTINCT wj.id) FILTER (WHERE cq.demand_qty - cov.covered > 0) AS job_count,
             ARRAY_AGG(DISTINCT wj.job_number ORDER BY wj.job_number)
               FILTER (WHERE cq.demand_qty - cov.covered > 0) AS job_numbers
      FROM win_jobs wj
      JOIN job_chemicals jc ON jc.job_id = wj.id
      JOIN products p ON p.id = jc.product_id
      CROSS JOIN LATERAL (
        SELECT COALESCE(
                 field_app_priced_quantity(jc.quantity, jc.unit, p.inventory_unit, p.product_form),
                 jc.quantity
               ) AS demand_qty
      ) cq
      CROSS JOIN LATERAL (
        SELECT CASE
                 WHEN EXISTS (
                   SELECT 1 FROM inventory_holds ih
                   WHERE ih.source_id = wj.id AND ih.hold_type = 'job'
                     AND ih.product_id = jc.product_id AND ih.is_active = true
                     AND (ih.expires_at IS NULL OR ih.expires_at >= CURRENT_DATE)
                 ) THEN 0
                 ELSE COALESCE((
                   SELECT SUM(ih.quantity) FROM inventory_holds ih
                   WHERE ih.source_id = wj.quote_id
                     AND ih.product_id = jc.product_id AND ih.is_active = true
                     AND (ih.expires_at IS NULL OR ih.expires_at >= CURRENT_DATE)
                 ), 0)
               END AS covered
      ) cov
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
        -- LAYER2<<< don't subtract the window jobs' OWN job holds from free —
        -- their demand is already sized above, so counting their reservation
        -- here too would report a phantom shortfall (§4B.1).
        AND NOT (ih.hold_type = 'job' AND ih.source_id IN (SELECT id FROM win_jobs))
        -- >>>LAYER2
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
      WHERE d.needed_qty > 0
        AND d.needed_qty > (COALESCE(a.avail_less_prebooked, 0) - COALESCE(ah.holds_qty, 0))
    ) r
  );
END;
$function$;
