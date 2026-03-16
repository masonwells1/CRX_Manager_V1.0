-- Sprint 10: Inventory Forecasting Dashboard
-- Aggregates planned demand from inventory_holds vs supply by product and month

CREATE OR REPLACE FUNCTION public.get_inventory_forecast(
  p_months_ahead integer DEFAULT 6
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN (
    SELECT COALESCE(jsonb_agg(row_to_json(r)), '[]'::jsonb)
    FROM (
      SELECT
        p.id AS product_id,
        p.product_name,
        p.sku,
        DATE_TRUNC('month', (ih.expires_at - INTERVAL '14 days'))::date AS needed_month,
        SUM(ih.quantity) AS planned_demand,
        (SELECT COALESCE(i.quantity_available, 0) FROM inventory i WHERE i.product_id = p.id AND i.location = 'Main Warehouse' LIMIT 1) AS current_available,
        (SELECT COALESCE(i.quantity_prebooked, 0) FROM inventory i WHERE i.product_id = p.id AND i.location = 'Main Warehouse' LIMIT 1) AS prebooked,
        (SELECT COALESCE(SUM(poi.quantity_ordered - poi.quantity_received), 0)
         FROM purchase_order_items poi
         JOIN purchase_orders po ON po.id = poi.purchase_order_id
         WHERE poi.product_id = p.id AND po.status IN ('submitted', 'partially_received')
        ) AS on_order,
        COUNT(DISTINCT ih.source_id) AS quote_count,
        COUNT(DISTINCT ih.customer_id) AS customer_count
      FROM inventory_holds ih
      JOIN products p ON p.id = ih.product_id
      WHERE ih.is_active = true
        AND ih.hold_type = 'crop_program'
        AND (ih.expires_at - INTERVAL '14 days') <= CURRENT_DATE + (p_months_ahead || ' months')::interval
      GROUP BY p.id, p.product_name, p.sku,
        DATE_TRUNC('month', (ih.expires_at - INTERVAL '14 days'))
      ORDER BY needed_month, p.product_name
    ) r
  );
END;
$$;

GRANT EXECUTE ON FUNCTION get_inventory_forecast(integer) TO authenticated;
