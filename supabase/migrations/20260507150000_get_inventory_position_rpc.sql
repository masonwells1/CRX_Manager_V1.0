-- Wave B.3 — Move inventory position math from React to one read-only RPC.
-- Replaces 4 separate fetches + JS reduce in InventoryPage with a single round-trip.
-- Fixes audit findings P4-1 (browser-side math) and P4-2 (three different "free"
-- formulas on the same page). Reference: docs/audits/2026-05-04-phase-4-inventory-purchasing-audit.md
--
-- Net Position = quantity_available - quantity_prebooked + quantity_on_order
-- Holds and planned-quote demand are RETURNED separately so the existing
-- "Planned" column on InventoryPage keeps working — they are no longer mixed
-- into the Net Position number itself.
--
-- Read-only: no idempotency key, follows the get_inventory_forecast precedent
-- in 20260316800000_inventory_forecasting.sql.

CREATE OR REPLACE FUNCTION public.get_inventory_position()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_season_start date;
BEGIN
  -- Season runs Oct 1 -> Sep 30. If we are in Jan-Sep, season started last Oct.
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
      -- Hide products with no inventory row AND no on-order. Matches the spirit
      -- of the old missing-product fallback: synthesize a virtual row only when
      -- there is a real reason to show one.
      WHERE b.inventory_id IS NOT NULL OR COALESCE(oo.qty, 0) > 0
    ) r
  );
END;
$$;

GRANT EXECUTE ON FUNCTION get_inventory_position() TO authenticated;

COMMENT ON FUNCTION public.get_inventory_position() IS
  'Wave B.3. Returns one row per (product, location) for active products with quantity_available, quantity_prebooked, quantity_on_order, holds_qty, planned_qty, delivered_ytd (season-to-date), net_position (= available - prebooked + on_order), reorder_point, min_stock_level, is_low_stock, plus product metadata (name, unit, container, vendor, current_cost). Read-only; replaces 4 separate fetches in InventoryPage.';
