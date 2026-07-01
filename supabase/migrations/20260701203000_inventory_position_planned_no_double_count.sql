-- 20260701203000_inventory_position_planned_no_double_count.sql
-- PARKED-007 (codex-driven hunt cycle 5). get_inventory_position() returns BOTH
-- holds_qty (SUM of active inventory_holds) and planned_qty (SUM of planned-quote
-- quote_items). Since the 2026-06-13 planned-holds sync, every planned-quote line
-- gets an active crop_program hold (source_id = quote id, same product + quantity) --
-- verified live: the one planned quote's 9 lines each have a matching active hold.
-- So planned_qty fully overlaps holds_qty, and any screen that adds them double-counts
-- the reserved/planned demand.
--
-- Fix: planned_qty now counts ONLY planned-quote demand NOT already covered by an
-- active linked hold. Holds remain the canonical reservation (they correctly reflect
-- partial draw-downs, which the raw quote total does not). ONLY change vs the current
-- live definition: the planned_quotes CTE gains a NOT EXISTS(active linked hold) filter.
-- net_position does NOT use planned_qty, so this is display-only (no stock-math change).

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
      SELECT ih.product_id, SUM(ih.quantity) AS qty
      FROM inventory_holds ih
      WHERE ih.is_active = true
        AND (ih.expires_at IS NULL OR ih.expires_at >= CURRENT_DATE)
      GROUP BY ih.product_id
    ),
    planned_quotes AS (
      SELECT qi.product_id, SUM(qi.total_units_needed) AS qty
      FROM quote_items qi
      JOIN quotes q ON q.id = qi.quote_id
      WHERE q.is_planned = true AND q.status IN ('draft', 'sent', 'revised')
        -- PARKED-007: exclude planned demand already reserved via an active linked
        -- hold (the 2026-06-13 sync creates one per planned-quote line, source_id =
        -- quote id). Prevents the holds_qty + planned_qty double-count. Holds stay
        -- canonical (they reflect partial draw-downs); an unheld line still shows here.
        AND NOT EXISTS (
          SELECT 1 FROM inventory_holds ih
          WHERE ih.source_id = qi.quote_id
            AND ih.product_id = qi.product_id
            AND ih.is_active = true
            AND (ih.expires_at IS NULL OR ih.expires_at >= CURRENT_DATE)
        )
      GROUP BY qi.product_id
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
