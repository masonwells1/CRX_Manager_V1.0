-- ============================================================
-- Migration: Sales & Chemical History Reporting RPCs
-- Created: 2026-03-07
-- Purpose: 3 RPCs powering the new /sales-reports page
--   1. get_sales_detail_report  — line-item sales detail
--   2. get_sales_summary_report — aggregated by dimension
--   3. get_customer_farm_group  — parent + child customers
-- ============================================================

-- 1. Line-item sales detail report
CREATE OR REPLACE FUNCTION public.get_sales_detail_report(
  p_start_date  date     DEFAULT NULL,
  p_end_date    date     DEFAULT NULL,
  p_product_id  uuid     DEFAULT NULL,
  p_customer_ids uuid[]  DEFAULT NULL,
  p_sales_rep_id uuid   DEFAULT NULL,
  p_category    text     DEFAULT NULL,
  p_season      integer  DEFAULT NULL
)
RETURNS TABLE (
  order_date      date,
  order_number    text,
  customer_name   text,
  customer_id     uuid,
  product_name    text,
  product_id      uuid,
  sku             text,
  category        text,
  quantity        numeric,
  unit            text,
  unit_price      numeric,
  total_price     numeric,
  cost            numeric,
  profit          numeric,
  margin_pct      numeric,
  sales_rep_name  text,
  invoice_number  text,
  season          integer
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    o.order_date,
    o.order_number,
    c.farm_name                             AS customer_name,
    o.customer_id,
    oi.product_name,
    oi.product_id,
    p.sku,
    p.category,
    oi.total_units_needed                   AS quantity,
    oi.unit_size                            AS unit,
    oi.price_per_unit                       AS unit_price,
    oi.total_price,
    ROUND(oi.cost_per_unit * oi.total_units_needed, 2) AS cost,
    oi.profit,
    CASE WHEN oi.total_price > 0
         THEN ROUND((oi.profit / oi.total_price) * 100, 1)
         ELSE 0 END                         AS margin_pct,
    COALESCE(rep.full_name, 'Unassigned')   AS sales_rep_name,
    inv.invoice_number,
    o.season
  FROM order_items oi
  JOIN orders o    ON o.id = oi.order_id
  JOIN customers c ON c.id = o.customer_id
  JOIN products p  ON p.id = oi.product_id
  LEFT JOIN profiles rep ON rep.id = o.salesman_id
  LEFT JOIN LATERAL (
    SELECT ii.invoice_id, i2.invoice_number
    FROM invoice_items ii
    JOIN invoices i2 ON i2.id = ii.invoice_id
    WHERE ii.order_item_id = oi.id
      AND i2.status <> 'void'
      AND i2.deleted_at IS NULL
    ORDER BY i2.created_at DESC
    LIMIT 1
  ) inv ON TRUE
  WHERE o.deleted_at IS NULL
    AND o.status NOT IN ('cancelled')
    AND (p_start_date  IS NULL OR o.order_date >= p_start_date)
    AND (p_end_date    IS NULL OR o.order_date <= p_end_date)
    AND (p_product_id  IS NULL OR oi.product_id = p_product_id)
    AND (p_customer_ids IS NULL OR o.customer_id = ANY(p_customer_ids))
    AND (p_sales_rep_id IS NULL OR o.salesman_id = p_sales_rep_id)
    AND (p_category    IS NULL OR p.category = p_category)
    AND (p_season      IS NULL OR o.season = p_season)
  ORDER BY o.order_date DESC, c.farm_name, oi.product_name;
$$;

COMMENT ON FUNCTION public.get_sales_detail_report IS
  'Line-item sales detail with all optional filters for the Sales Reports page.';


-- 2. Aggregated sales summary grouped by dimension
CREATE OR REPLACE FUNCTION public.get_sales_summary_report(
  p_group_by     text     DEFAULT 'product',
  p_start_date   date     DEFAULT NULL,
  p_end_date     date     DEFAULT NULL,
  p_product_id   uuid     DEFAULT NULL,
  p_customer_ids uuid[]   DEFAULT NULL,
  p_sales_rep_id uuid     DEFAULT NULL,
  p_category     text     DEFAULT NULL,
  p_season       integer  DEFAULT NULL
)
RETURNS TABLE (
  group_key      text,
  group_id       uuid,
  total_quantity  numeric,
  total_revenue   numeric,
  total_cost      numeric,
  total_profit    numeric,
  margin_pct      numeric,
  order_count     bigint,
  line_count      bigint
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  WITH filtered AS (
    SELECT
      oi.product_id,
      oi.product_name,
      o.customer_id,
      c.farm_name,
      o.salesman_id,
      COALESCE(rep.full_name, 'Unassigned') AS rep_name,
      p.category,
      o.order_date,
      o.id AS order_id,
      oi.total_units_needed AS quantity,
      oi.total_price        AS revenue,
      ROUND(oi.cost_per_unit * oi.total_units_needed, 2) AS cost,
      oi.profit
    FROM order_items oi
    JOIN orders o    ON o.id = oi.order_id
    JOIN customers c ON c.id = o.customer_id
    JOIN products p  ON p.id = oi.product_id
    LEFT JOIN profiles rep ON rep.id = o.salesman_id
    WHERE o.deleted_at IS NULL
      AND o.status NOT IN ('cancelled')
      AND (p_start_date   IS NULL OR o.order_date >= p_start_date)
      AND (p_end_date     IS NULL OR o.order_date <= p_end_date)
      AND (p_product_id   IS NULL OR oi.product_id = p_product_id)
      AND (p_customer_ids IS NULL OR o.customer_id = ANY(p_customer_ids))
      AND (p_sales_rep_id IS NULL OR o.salesman_id = p_sales_rep_id)
      AND (p_category     IS NULL OR p.category = p_category)
      AND (p_season       IS NULL OR o.season = p_season)
  )
  SELECT
    CASE p_group_by
      WHEN 'product'   THEN f.product_name
      WHEN 'customer'  THEN f.farm_name
      WHEN 'sales_rep' THEN f.rep_name
      WHEN 'month'     THEN TO_CHAR(f.order_date, 'YYYY-MM')
      WHEN 'category'  THEN COALESCE(f.category, 'Uncategorized')
      ELSE f.product_name
    END                                      AS group_key,
    CASE p_group_by
      WHEN 'product'   THEN f.product_id
      WHEN 'customer'  THEN f.customer_id
      WHEN 'sales_rep' THEN f.salesman_id
      ELSE NULL
    END                                      AS group_id,
    SUM(f.quantity)                           AS total_quantity,
    SUM(f.revenue)                            AS total_revenue,
    SUM(f.cost)                               AS total_cost,
    SUM(f.profit)                             AS total_profit,
    CASE WHEN SUM(f.revenue) > 0
         THEN ROUND((SUM(f.profit) / SUM(f.revenue)) * 100, 1)
         ELSE 0 END                          AS margin_pct,
    COUNT(DISTINCT f.order_id)               AS order_count,
    COUNT(*)                                  AS line_count
  FROM filtered f
  GROUP BY
    CASE p_group_by
      WHEN 'product'   THEN f.product_name
      WHEN 'customer'  THEN f.farm_name
      WHEN 'sales_rep' THEN f.rep_name
      WHEN 'month'     THEN TO_CHAR(f.order_date, 'YYYY-MM')
      WHEN 'category'  THEN COALESCE(f.category, 'Uncategorized')
      ELSE f.product_name
    END,
    CASE p_group_by
      WHEN 'product'   THEN f.product_id
      WHEN 'customer'  THEN f.customer_id
      WHEN 'sales_rep' THEN f.salesman_id
      ELSE NULL
    END
  ORDER BY SUM(f.revenue) DESC;
$$;

COMMENT ON FUNCTION public.get_sales_summary_report IS
  'Aggregated sales summary grouped by product/customer/sales_rep/month/category.';


-- 3. Customer farm group (parent + children)
CREATE OR REPLACE FUNCTION public.get_customer_farm_group(
  p_customer_id uuid
)
RETURNS TABLE (
  id         uuid,
  farm_name  text,
  is_parent  boolean
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  -- Find the root parent (if selected customer IS a child, go up)
  WITH RECURSIVE root AS (
    SELECT c.id, c.farm_name, c.parent_customer_id
    FROM customers c WHERE c.id = p_customer_id
    UNION ALL
    SELECT p.id, p.farm_name, p.parent_customer_id
    FROM customers p
    JOIN root r ON r.parent_customer_id = p.id
  )
  -- The topmost customer is the parent
  , top_parent AS (
    SELECT id FROM root WHERE parent_customer_id IS NULL
    LIMIT 1
  )
  -- Return parent + all direct children
  SELECT c.id, c.farm_name,
         (c.id = tp.id) AS is_parent
  FROM customers c
  CROSS JOIN top_parent tp
  WHERE c.id = tp.id
     OR c.parent_customer_id = tp.id
  ORDER BY (c.id = tp.id) DESC, c.farm_name;
$$;

COMMENT ON FUNCTION public.get_customer_farm_group IS
  'Returns the farm group: parent customer + all child customers linked via parent_customer_id.';
