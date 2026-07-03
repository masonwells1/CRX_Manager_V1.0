-- Layer 2 · Part B · Cycle B2 — get_inventory_position: break out job holds +
-- make the planned-quote dedup quantity-aware (§4B.2)
-- ============================================================================
-- TWO changes vs the live function (each marked LAYER2<<< / >>>LAYER2); the rest
-- is a verbatim reproduction of the live definition (diffed against the live
-- catalog and typed out explicitly here — not cloned dynamically; plpgsql_check
-- CLEAN):
--
-- (1) HOLDS SPLIT BY TYPE. The `holds` CTE now also emits `job_qty` (the job-type
--     subset) alongside the existing total `qty`. A new output column
--     `job_holds_qty` surfaces it. `holds_qty` is UNCHANGED — it still sums ALL
--     active holds (incl. job), so DispatchBoard / InventoryPage / ReceivingHub /
--     ToShip keep their current semantics; `job_holds_qty` is an informational
--     breakout (a subset already inside holds_qty, so no double-count in totals).
--     Dispatch-light own-hold precision is handled by the dedicated B3 RPC.
--
-- (2) QUANTITY-AWARE PLANNED DEDUP. The live dedup is EXISTENCE-based: a planned
--     line is dropped from planned_qty entirely if ANY active hold links to it
--     (source_id = quote_id). That resurfaces a FULLY-drawn line's demand: when a
--     line is fully drawn (esp. to a JOB, which never flips the quote to
--     'accepted'), `_sync_planned_holds` inserts NO hold row (computed hold = 0),
--     so no linked hold exists -> the line's full booking reappears in planned_qty
--     while the draw is ALSO counted (job hold in holds_qty). Fix: compute the
--     genuinely-unreserved remainder per line =
--         GREATEST(total_units_needed - linked_hold - order_drawn - job_drawn, 0)
--     where linked_hold = active holds with source_id = quote_id (the crop_program
--     reservation; job holds carry source_id = job_id so they never match here),
--     order_drawn = SUM(quote_product_draws), job_drawn = SUM(job_product_draws).
--     Because the A2 sync keeps linked_hold = booking - order_drawn - job_drawn,
--     this is 0 whenever holds are synced (no double-count vs holds_qty) and
--     equals the true unreserved booking when a hold is missing (still surfaces
--     an unheld line, matching the old behavior). Read-only RPC.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_inventory_position()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_season_start date;
BEGIN
  IF EXTRACT(MONTH FROM CURRENT_DATE) >= 10 THEN
    v_season_start := DATE_TRUNC('year', CURRENT_DATE)::date + INTERVAL '9 months';
  ELSE
    v_season_start := (DATE_TRUNC('year', CURRENT_DATE) - INTERVAL '1 year')::date + INTERVAL '9 months';
  END IF;

  RETURN (
    WITH on_order AS (
      SELECT poi.product_id, SUM(poi.quantity_ordered - poi.quantity_received) AS qty
      FROM purchase_order_items poi
      JOIN purchase_orders po ON po.id = poi.purchase_order_id
      WHERE po.status IN ('submitted', 'partially_received')
      GROUP BY poi.product_id
    ),
    holds AS (
      SELECT ih.product_id,
             SUM(ih.quantity) AS qty,
             -- LAYER2<<< job-type subset broken out as its own column (§4B.2 #1)
             SUM(ih.quantity) FILTER (WHERE ih.hold_type = 'job') AS job_qty
             -- >>>LAYER2
      FROM inventory_holds ih
      WHERE ih.is_active = true
        AND (ih.expires_at IS NULL OR ih.expires_at >= CURRENT_DATE)
      GROUP BY ih.product_id
    ),
    planned_quotes AS (
      -- LAYER2<<< quantity-aware dedup (§4B.2 #2): unreserved remainder per booking line.
      -- Codex A+B round-2 P2: AGGREGATE the booking per (quote, product) FIRST, THEN
      -- subtract the product-level hold/draws ONCE. Subtracting them inside a per-line
      -- SUM over-deducts when a product appears on multiple quote lines (two 50-unit
      -- lines with a 60-unit job draw and no hold would report 0 instead of 40 unreserved).
      SELECT pq.product_id, SUM(pq.remainder) AS qty
      FROM (
        SELECT b.quote_id, b.product_id,
               GREATEST(
                 b.booked
                   - COALESCE(lh.linked_hold, 0)
                   - COALESCE(od.order_drawn, 0)
                   - COALESCE(jd.job_drawn, 0),
                 0) AS remainder
        FROM (
          SELECT qi.quote_id, qi.product_id, SUM(COALESCE(qi.total_units_needed, 0)) AS booked
          FROM quote_items qi
          JOIN quotes q ON q.id = qi.quote_id
          WHERE q.is_planned = true AND q.status IN ('draft', 'sent', 'revised')
          GROUP BY qi.quote_id, qi.product_id
        ) b
        LEFT JOIN LATERAL (
          SELECT COALESCE(SUM(ih.quantity), 0) AS linked_hold
          FROM inventory_holds ih
          WHERE ih.source_id = b.quote_id
            AND ih.product_id = b.product_id
            AND ih.is_active = true
            AND (ih.expires_at IS NULL OR ih.expires_at >= CURRENT_DATE)
        ) lh ON true
        LEFT JOIN LATERAL (
          SELECT COALESCE(SUM(qpd.quantity_drawn), 0) AS order_drawn
          FROM quote_product_draws qpd
          WHERE qpd.quote_id = b.quote_id
            AND qpd.product_id = b.product_id
        ) od ON true
        LEFT JOIN LATERAL (
          SELECT COALESCE(SUM(jpd.quantity_drawn), 0) AS job_drawn
          FROM job_product_draws jpd
          WHERE jpd.quote_id = b.quote_id
            AND jpd.product_id = b.product_id
        ) jd ON true
      ) pq
      GROUP BY pq.product_id
      -- >>>LAYER2
    ),
    delivered_ytd AS (
      SELECT it.product_id, SUM(it.quantity) AS qty
      FROM inventory_transactions it
      WHERE it.transaction_type = 'delivered' AND it.created_at >= v_season_start
      GROUP BY it.product_id
    ),
    base AS (
      SELECT
        p.id AS product_id, p.product_name, p.inventory_unit,
        p.container_size, p.container_type, p.vendor, p.current_cost,
        i.id AS inventory_id, i.location, i.unit_size,
        COALESCE(i.quantity_available, 0) AS quantity_available,
        COALESCE(i.quantity_prebooked, 0) AS quantity_prebooked,
        COALESCE(i.reorder_point, 0) AS reorder_point,
        COALESCE(i.min_stock_level, 0) AS min_stock_level
      FROM products p
      LEFT JOIN inventory i ON i.product_id = p.id
      WHERE p.is_active = true
    )
    SELECT COALESCE(jsonb_agg(row_to_json(r) ORDER BY r.product_name), '[]'::jsonb)
    FROM (
      SELECT
        b.inventory_id, b.product_id, b.product_name, b.inventory_unit,
        b.container_size, b.container_type, b.vendor, b.current_cost,
        b.location, b.unit_size,
        b.quantity_available, b.quantity_prebooked,
        COALESCE(oo.qty, 0) AS quantity_on_order,
        COALESCE(h.qty, 0)  AS holds_qty,
        COALESCE(h.job_qty, 0) AS job_holds_qty,   -- LAYER2: new column
        COALESCE(pq.qty, 0) AS planned_qty,
        COALESCE(dy.qty, 0) AS delivered_ytd,
        (b.quantity_available - b.quantity_prebooked + COALESCE(oo.qty, 0)) AS net_position,
        b.reorder_point, b.min_stock_level,
        (b.reorder_point > 0 AND b.quantity_available <= b.reorder_point) AS is_low_stock
      FROM base b
      LEFT JOIN on_order       oo ON oo.product_id = b.product_id
      LEFT JOIN holds          h  ON h.product_id  = b.product_id
      LEFT JOIN planned_quotes pq ON pq.product_id = b.product_id
      LEFT JOIN delivered_ytd  dy ON dy.product_id = b.product_id
      WHERE b.inventory_id IS NOT NULL OR COALESCE(oo.qty, 0) > 0
    ) r
  );
END;
$function$;
