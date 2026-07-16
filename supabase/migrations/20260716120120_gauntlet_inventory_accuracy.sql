-- Money/inventory gauntlet: make inventory position totals conservative and reversal-aware.
-- Built from the live function definition inspected 2026-07-15. No data changes.

-- The season-boundary pairing below deliberately treats an order-level void as
-- reversing every delivered row for that order/product. Refuse the migration if
-- the canonical implementation ever drifts into a partial or delivery-scoped
-- order void; get_inventory_position must be redesigned alongside that change.
DO $guard$
DECLARE
  v_void_body text;
BEGIN
  SELECT p.prosrc
    INTO v_void_body
  FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace
    AND p.proname = '_void_order_impl_20260714';

  IF v_void_body IS NULL
     OR v_void_body NOT LIKE '%FROM public.order_items%WHERE order_id = p_order_id%COALESCE(quantity_delivered, 0) > 0%'
     OR v_void_body NOT LIKE '%INSERT INTO public.inventory_transactions%void_delivery_reversal%'
     OR v_void_body LIKE '%delivery_id%'
  THEN
    RAISE EXCEPTION 'ORDER_VOID_REVERSAL_CONTRACT_DRIFT: expected whole-order/product reversal without delivery_id';
  END IF;
END;
$guard$;

CREATE OR REPLACE FUNCTION public.get_inventory_position()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_season_start date;
BEGIN
  PERFORM require_admin_or_sales_rep();

  IF EXTRACT(MONTH FROM CURRENT_DATE) >= 10 THEN
    v_season_start := DATE_TRUNC('year', CURRENT_DATE)::date + INTERVAL '9 months';
  ELSE
    v_season_start := (DATE_TRUNC('year', CURRENT_DATE) - INTERVAL '1 year')::date + INTERVAL '9 months';
  END IF;

  RETURN (
    WITH on_order AS (
      SELECT poi.product_id, SUM(GREATEST(poi.quantity_ordered - COALESCE(poi.quantity_received, 0), 0)) AS qty
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
    order_voided_products AS (
      -- void_order records one product-level reversal for the entire order and
      -- intentionally has no delivery_id. Pair that row back to all delivery
      -- events for the same order/product so its later ledger timestamp cannot
      -- move old delivered volume across season boundaries.
      SELECT DISTINCT it.order_id, it.product_id
      FROM inventory_transactions it
      WHERE it.transaction_type = 'void_delivery_reversal'
        AND it.delivery_id IS NULL
        AND it.order_id IS NOT NULL
    ),
    delivered_ytd AS (
      SELECT it.product_id,
             GREATEST(SUM(
               CASE
                 WHEN it.transaction_type = 'delivered' THEN ABS(it.quantity)
                 WHEN it.transaction_type IN ('cancelled_delivery_reversal', 'void_delivery_reversal')
                   THEN -ABS(it.quantity)
                 ELSE 0
               END
              ), 0) AS qty
      FROM inventory_transactions it
      JOIN deliveries d ON d.id = it.delivery_id
      LEFT JOIN order_voided_products ovp
        ON ovp.order_id = it.order_id
       AND ovp.product_id = it.product_id
      WHERE it.transaction_type IN ('delivered', 'cancelled_delivery_reversal', 'void_delivery_reversal')
        -- Delivery-specific reversals retain delivery_id, so they use the
        -- original delivery business date. Order-level voids are excluded by
        -- the paired order/product key above instead of their reversal date.
        AND (COALESCE(d.completed_at, it.created_at) AT TIME ZONE 'America/Chicago')::date >= v_season_start
        AND ovp.order_id IS NULL
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
        -- U18 #90: negative on-hand is always a stock problem, reorder_point set or not.
        ((b.reorder_point > 0 AND b.quantity_available <= b.reorder_point) OR b.quantity_available < 0) AS is_low_stock
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

REVOKE EXECUTE ON FUNCTION public.get_inventory_position()
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_inventory_position()
  TO authenticated, service_role;
