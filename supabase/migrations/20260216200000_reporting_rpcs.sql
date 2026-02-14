-- Sprint 9: Reporting RPCs
-- 10 server-side reporting functions that query existing tables
-- No new tables needed — reports aggregate existing data

-- ============================================================
-- 1. get_logbook_by_customer
-- Application records for a specific customer within date range
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_logbook_by_customer(
  p_customer_id uuid,
  p_start_date date,
  p_end_date date
)
RETURNS TABLE (
  record_id uuid,
  record_number text,
  application_date date,
  application_time time,
  customer_name text,
  applicator_name text,
  field_name text,
  field_legal_description text,
  total_acres numeric,
  total_volume numeric,
  total_volume_unit text,
  vehicle_name text,
  vehicle_type text,
  vehicle_registration text,
  weather_conditions jsonb,
  product_data jsonb,
  invoice_number text,
  season integer,
  source_type text,
  created_at timestamptz
)
LANGUAGE sql STABLE
SET search_path = ''
AS $$
  SELECT
    ar.id,
    ar.record_number,
    ar.application_date,
    ar.application_time,
    c.farm_name,
    p.full_name,
    f.field_name,
    f.legal_description,
    ar.total_acres,
    ar.total_volume,
    ar.total_volume_unit,
    v.vehicle_name,
    v.vehicle_type,
    v.registration,
    ar.weather_conditions,
    ar.product_data,
    inv.invoice_number,
    ar.season,
    ar.source_type,
    ar.created_at
  FROM public.application_records ar
  LEFT JOIN public.customers c ON c.id = ar.customer_id
  LEFT JOIN public.profiles p ON p.id = ar.applicator_id
  LEFT JOIN public.fields f ON f.id = ar.field_id
  LEFT JOIN public.vehicles v ON v.id = ar.vehicle_id
  LEFT JOIN public.invoices inv ON inv.id = ar.invoice_id
  WHERE ar.customer_id = p_customer_id
    AND ar.application_date >= p_start_date
    AND ar.application_date <= p_end_date
  ORDER BY ar.application_date DESC, ar.application_time DESC NULLS LAST;
$$;

-- ============================================================
-- 2. get_logbook_by_applicator
-- Application records for a specific applicator within date range
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_logbook_by_applicator(
  p_applicator_id uuid,
  p_start_date date,
  p_end_date date
)
RETURNS TABLE (
  record_id uuid,
  record_number text,
  application_date date,
  application_time time,
  customer_name text,
  applicator_name text,
  field_name text,
  field_legal_description text,
  total_acres numeric,
  total_volume numeric,
  total_volume_unit text,
  vehicle_name text,
  vehicle_type text,
  vehicle_registration text,
  weather_conditions jsonb,
  product_data jsonb,
  invoice_number text,
  season integer,
  source_type text,
  created_at timestamptz
)
LANGUAGE sql STABLE
SET search_path = ''
AS $$
  SELECT
    ar.id,
    ar.record_number,
    ar.application_date,
    ar.application_time,
    c.farm_name,
    p.full_name,
    f.field_name,
    f.legal_description,
    ar.total_acres,
    ar.total_volume,
    ar.total_volume_unit,
    v.vehicle_name,
    v.vehicle_type,
    v.registration,
    ar.weather_conditions,
    ar.product_data,
    inv.invoice_number,
    ar.season,
    ar.source_type,
    ar.created_at
  FROM public.application_records ar
  LEFT JOIN public.customers c ON c.id = ar.customer_id
  LEFT JOIN public.profiles p ON p.id = ar.applicator_id
  LEFT JOIN public.fields f ON f.id = ar.field_id
  LEFT JOIN public.vehicles v ON v.id = ar.vehicle_id
  LEFT JOIN public.invoices inv ON inv.id = ar.invoice_id
  WHERE ar.applicator_id = p_applicator_id
    AND ar.application_date >= p_start_date
    AND ar.application_date <= p_end_date
  ORDER BY ar.application_date DESC, ar.application_time DESC NULLS LAST;
$$;

-- ============================================================
-- 3. get_logbook_by_field
-- Application records for a specific field within date range
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_logbook_by_field(
  p_field_id uuid,
  p_start_date date,
  p_end_date date
)
RETURNS TABLE (
  record_id uuid,
  record_number text,
  application_date date,
  application_time time,
  customer_name text,
  applicator_name text,
  field_name text,
  field_legal_description text,
  total_acres numeric,
  total_volume numeric,
  total_volume_unit text,
  vehicle_name text,
  vehicle_type text,
  vehicle_registration text,
  weather_conditions jsonb,
  product_data jsonb,
  invoice_number text,
  season integer,
  source_type text,
  created_at timestamptz
)
LANGUAGE sql STABLE
SET search_path = ''
AS $$
  SELECT
    ar.id,
    ar.record_number,
    ar.application_date,
    ar.application_time,
    c.farm_name,
    p.full_name,
    f.field_name,
    f.legal_description,
    ar.total_acres,
    ar.total_volume,
    ar.total_volume_unit,
    v.vehicle_name,
    v.vehicle_type,
    v.registration,
    ar.weather_conditions,
    ar.product_data,
    inv.invoice_number,
    ar.season,
    ar.source_type,
    ar.created_at
  FROM public.application_records ar
  LEFT JOIN public.customers c ON c.id = ar.customer_id
  LEFT JOIN public.profiles p ON p.id = ar.applicator_id
  LEFT JOIN public.fields f ON f.id = ar.field_id
  LEFT JOIN public.vehicles v ON v.id = ar.vehicle_id
  LEFT JOIN public.invoices inv ON inv.id = ar.invoice_id
  WHERE ar.field_id = p_field_id
    AND ar.application_date >= p_start_date
    AND ar.application_date <= p_end_date
  ORDER BY ar.application_date DESC, ar.application_time DESC NULLS LAST;
$$;

-- ============================================================
-- 4. get_logbook_faa
-- Aerial-only application records (vehicle_type = 'air')
-- Includes aircraft registration + pilot certificate
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_logbook_faa(
  p_start_date date,
  p_end_date date
)
RETURNS TABLE (
  record_id uuid,
  record_number text,
  application_date date,
  application_time time,
  customer_name text,
  applicator_name text,
  applicator_license text,
  faa_certificate text,
  field_name text,
  field_legal_description text,
  field_county text,
  field_state text,
  total_acres numeric,
  total_volume numeric,
  total_volume_unit text,
  vehicle_name text,
  vehicle_registration text,
  vehicle_category text,
  weather_conditions jsonb,
  product_data jsonb,
  invoice_number text,
  season integer,
  created_at timestamptz
)
LANGUAGE sql STABLE
SET search_path = ''
AS $$
  SELECT
    ar.id,
    ar.record_number,
    ar.application_date,
    ar.application_time,
    c.farm_name,
    p.full_name,
    p.applicator_license_number,
    p.faa_certificate_number,
    f.field_name,
    f.legal_description,
    f.county,
    f.state,
    ar.total_acres,
    ar.total_volume,
    ar.total_volume_unit,
    v.vehicle_name,
    v.registration,
    v.category,
    ar.weather_conditions,
    ar.product_data,
    inv.invoice_number,
    ar.season,
    ar.created_at
  FROM public.application_records ar
  INNER JOIN public.vehicles v ON v.id = ar.vehicle_id AND v.vehicle_type = 'air'
  LEFT JOIN public.customers c ON c.id = ar.customer_id
  LEFT JOIN public.profiles p ON p.id = ar.applicator_id
  LEFT JOIN public.fields f ON f.id = ar.field_id
  LEFT JOIN public.invoices inv ON inv.id = ar.invoice_id
  WHERE ar.application_date >= p_start_date
    AND ar.application_date <= p_end_date
  ORDER BY ar.application_date DESC, ar.application_time DESC NULLS LAST;
$$;

-- ============================================================
-- 5. get_bottom_line_pnl
-- Revenue, COGS, gross profit, commissions, net profit
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_bottom_line_pnl(
  p_start_date date,
  p_end_date date
)
RETURNS TABLE (
  line_item text,
  amount numeric,
  pct_of_revenue numeric
)
LANGUAGE plpgsql STABLE
SET search_path = ''
AS $$
DECLARE
  v_revenue numeric := 0;
  v_cogs numeric := 0;
  v_gross_profit numeric := 0;
  v_commissions numeric := 0;
  v_net_profit numeric := 0;
BEGIN
  -- Revenue + COGS from posted invoices
  SELECT
    COALESCE(SUM(i.total_amount_cents), 0) / 100.0,
    COALESCE(SUM(
      (SELECT COALESCE(SUM(ii.cost_cents * ii.quantity), 0) FROM public.invoice_items ii WHERE ii.invoice_id = i.id)
    ), 0) / 100.0
  INTO v_revenue, v_cogs
  FROM public.invoices i
  WHERE i.status = 'posted'
    AND i.invoice_date >= p_start_date
    AND i.invoice_date <= p_end_date
    AND i.deleted_at IS NULL;

  v_gross_profit := v_revenue - v_cogs;

  -- Commissions from orders in date range
  SELECT COALESCE(SUM(commission_amount), 0)
  INTO v_commissions
  FROM public.commissions
  WHERE order_date >= p_start_date::text
    AND order_date <= p_end_date::text;

  v_net_profit := v_gross_profit - v_commissions;

  RETURN QUERY VALUES
    ('Revenue'::text, v_revenue, 100.0::numeric),
    ('Cost of Goods Sold', v_cogs, CASE WHEN v_revenue > 0 THEN ROUND(v_cogs / v_revenue * 100, 1) ELSE 0 END),
    ('Gross Profit', v_gross_profit, CASE WHEN v_revenue > 0 THEN ROUND(v_gross_profit / v_revenue * 100, 1) ELSE 0 END),
    ('Commissions', v_commissions, CASE WHEN v_revenue > 0 THEN ROUND(v_commissions / v_revenue * 100, 1) ELSE 0 END),
    ('Net Profit', v_net_profit, CASE WHEN v_revenue > 0 THEN ROUND(v_net_profit / v_revenue * 100, 1) ELSE 0 END);
END;
$$;

-- ============================================================
-- 6. get_gross_sales_report
-- Grouped by product, customer, or salesman
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_gross_sales_report(
  p_start_date date,
  p_end_date date,
  p_group_by text DEFAULT 'product' -- 'product' | 'customer' | 'salesman'
)
RETURNS TABLE (
  group_name text,
  total_revenue numeric,
  total_cost numeric,
  gross_profit numeric,
  margin_pct numeric,
  units_sold numeric,
  order_count bigint
)
LANGUAGE plpgsql STABLE
SET search_path = ''
AS $$
BEGIN
  IF p_group_by = 'product' THEN
    RETURN QUERY
      SELECT
        oi.product_name,
        ROUND(SUM(oi.total_price)::numeric, 2),
        ROUND(SUM(oi.cost_per_unit * oi.total_units_needed)::numeric, 2),
        ROUND(SUM(oi.profit)::numeric, 2),
        CASE WHEN SUM(oi.total_price) > 0
          THEN ROUND((SUM(oi.profit) / SUM(oi.total_price) * 100)::numeric, 1)
          ELSE 0 END,
        ROUND(SUM(oi.total_units_needed)::numeric, 2),
        COUNT(DISTINCT oi.order_id)
      FROM public.order_items oi
      INNER JOIN public.orders o ON o.id = oi.order_id
      WHERE o.order_date >= p_start_date::text
        AND o.order_date <= p_end_date::text
        AND o.deleted_at IS NULL
      GROUP BY oi.product_name
      ORDER BY SUM(oi.total_price) DESC;

  ELSIF p_group_by = 'customer' THEN
    RETURN QUERY
      SELECT
        c.farm_name,
        ROUND(SUM(o.total_price)::numeric, 2),
        ROUND(SUM(o.total_price - o.total_profit)::numeric, 2),
        ROUND(SUM(o.total_profit)::numeric, 2),
        CASE WHEN SUM(o.total_price) > 0
          THEN ROUND((SUM(o.total_profit) / SUM(o.total_price) * 100)::numeric, 1)
          ELSE 0 END,
        0::numeric,
        COUNT(o.id)
      FROM public.orders o
      LEFT JOIN public.customers c ON c.id = o.customer_id
      WHERE o.order_date >= p_start_date::text
        AND o.order_date <= p_end_date::text
        AND o.deleted_at IS NULL
      GROUP BY c.farm_name
      ORDER BY SUM(o.total_price) DESC;

  ELSE -- salesman
    RETURN QUERY
      SELECT
        p.full_name,
        ROUND(SUM(o.total_price)::numeric, 2),
        ROUND(SUM(o.total_price - o.total_profit)::numeric, 2),
        ROUND(SUM(o.total_profit)::numeric, 2),
        CASE WHEN SUM(o.total_price) > 0
          THEN ROUND((SUM(o.total_profit) / SUM(o.total_price) * 100)::numeric, 1)
          ELSE 0 END,
        0::numeric,
        COUNT(o.id)
      FROM public.orders o
      LEFT JOIN public.profiles p ON p.id = o.sales_rep_id
      WHERE o.order_date >= p_start_date::text
        AND o.order_date <= p_end_date::text
        AND o.deleted_at IS NULL
      GROUP BY p.full_name
      ORDER BY SUM(o.total_price) DESC;
  END IF;
END;
$$;

-- ============================================================
-- 7. get_customer_balance_listing
-- All customers with outstanding invoice balances
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_customer_balance_listing(
  p_as_of_date date
)
RETURNS TABLE (
  customer_id uuid,
  farm_name text,
  total_invoiced numeric,
  total_paid numeric,
  prepay_applied numeric,
  outstanding_balance numeric,
  invoice_count bigint,
  oldest_unpaid_date date
)
LANGUAGE sql STABLE
SET search_path = ''
AS $$
  SELECT
    c.id,
    c.farm_name,
    ROUND(COALESCE(SUM(i.total_amount_cents), 0) / 100.0, 2),
    ROUND(COALESCE(SUM(i.paid_amount_cents), 0) / 100.0, 2),
    ROUND(COALESCE(SUM(i.prepay_applied_cents), 0) / 100.0, 2),
    ROUND(COALESCE(SUM(i.balance_cents), 0) / 100.0, 2),
    COUNT(i.id),
    MIN(CASE WHEN i.balance_cents > 0 THEN i.invoice_date::date END)
  FROM public.customers c
  LEFT JOIN public.invoices i ON i.customer_id = c.id
    AND i.status IN ('posted', 'unposted')
    AND i.deleted_at IS NULL
    AND i.invoice_date <= p_as_of_date
  GROUP BY c.id, c.farm_name
  HAVING COALESCE(SUM(i.balance_cents), 0) != 0
  ORDER BY COALESCE(SUM(i.balance_cents), 0) DESC;
$$;

-- ============================================================
-- 8. get_chemical_history
-- All transactions for a specific product
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_chemical_history(
  p_product_id uuid,
  p_start_date date,
  p_end_date date
)
RETURNS TABLE (
  transaction_date text,
  transaction_type text,
  reference_number text,
  customer_name text,
  quantity numeric,
  unit text,
  unit_price numeric,
  total_amount numeric,
  notes text
)
LANGUAGE sql STABLE
SET search_path = ''
AS $$
  -- Orders (sales)
  SELECT
    o.order_date,
    'Sale'::text,
    o.order_number,
    c.farm_name,
    oi.total_units_needed,
    oi.unit_size,
    oi.price_per_unit,
    oi.total_price,
    NULL::text
  FROM public.order_items oi
  INNER JOIN public.orders o ON o.id = oi.order_id
  LEFT JOIN public.customers c ON c.id = o.customer_id
  WHERE oi.product_id = p_product_id
    AND o.order_date >= p_start_date::text
    AND o.order_date <= p_end_date::text
    AND o.deleted_at IS NULL

  UNION ALL

  -- Purchase orders (receiving)
  SELECT
    COALESCE(po.submitted_date, po.created_at::text)::text,
    'Purchase'::text,
    po.po_number,
    po.vendor,
    poi.quantity_received,
    poi.unit_size,
    poi.unit_cost,
    poi.unit_cost * poi.quantity_received,
    poi.notes
  FROM public.purchase_order_items poi
  INNER JOIN public.purchase_orders po ON po.id = poi.purchase_order_id
  WHERE poi.product_id = p_product_id
    AND COALESCE(po.submitted_date, po.created_at::text) >= p_start_date::text
    AND COALESCE(po.submitted_date, po.created_at::text) <= p_end_date::text

  ORDER BY transaction_date DESC;
$$;

-- ============================================================
-- 9. get_commission_balance_report
-- Earned / paid / balance per salesperson
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_commission_balance_report(
  p_as_of_date date
)
RETURNS TABLE (
  recipient_id uuid,
  recipient_name text,
  total_earned numeric,
  total_paid numeric,
  outstanding_balance numeric,
  pending_count bigint,
  paid_count bigint
)
LANGUAGE sql STABLE
SET search_path = ''
AS $$
  SELECT
    cm.recipient_user_id,
    COALESCE(p.full_name, cm.recipient),
    ROUND(SUM(cm.commission_amount)::numeric, 2),
    ROUND(SUM(CASE WHEN cm.status = 'paid' THEN cm.commission_amount ELSE 0 END)::numeric, 2),
    ROUND(SUM(CASE WHEN cm.status = 'pending' THEN cm.commission_amount ELSE 0 END)::numeric, 2),
    COUNT(*) FILTER (WHERE cm.status = 'pending'),
    COUNT(*) FILTER (WHERE cm.status = 'paid')
  FROM public.commissions cm
  LEFT JOIN public.profiles p ON p.id = cm.recipient_user_id
  WHERE cm.order_date <= p_as_of_date::text
  GROUP BY cm.recipient_user_id, COALESCE(p.full_name, cm.recipient)
  ORDER BY SUM(CASE WHEN cm.status = 'pending' THEN cm.commission_amount ELSE 0 END) DESC;
$$;

-- ============================================================
-- 10. get_inventory_cost_report
-- Current inventory with cost valuation
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_inventory_cost_report()
RETURNS TABLE (
  product_id uuid,
  product_name text,
  sku text,
  category text,
  vendor text,
  quantity_available numeric,
  quantity_prebooked numeric,
  net_available numeric,
  unit_cost numeric,
  total_cost_value numeric,
  reorder_point numeric,
  below_reorder boolean
)
LANGUAGE sql STABLE
SET search_path = ''
AS $$
  SELECT
    pr.id,
    pr.product_name,
    pr.sku,
    pr.category,
    pr.vendor,
    COALESCE(inv.quantity_available, 0),
    COALESCE(inv.quantity_prebooked, 0),
    COALESCE(inv.quantity_available, 0) - COALESCE(inv.quantity_prebooked, 0),
    COALESCE(pr.current_cost, 0),
    ROUND((COALESCE(inv.quantity_available, 0) * COALESCE(pr.current_cost, 0))::numeric, 2),
    COALESCE(inv.reorder_point, 0),
    COALESCE(inv.quantity_available, 0) < COALESCE(inv.reorder_point, 0)
  FROM public.products pr
  LEFT JOIN public.inventory inv ON inv.product_id = pr.id
  WHERE pr.deleted_at IS NULL
  ORDER BY pr.product_name;
$$;

-- ============================================================
-- Indexes for report performance
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_application_records_customer_date
  ON public.application_records(customer_id, application_date);

CREATE INDEX IF NOT EXISTS idx_application_records_applicator_date
  ON public.application_records(applicator_id, application_date);

CREATE INDEX IF NOT EXISTS idx_application_records_field_date
  ON public.application_records(field_id, application_date);

CREATE INDEX IF NOT EXISTS idx_invoices_customer_date
  ON public.invoices(customer_id, invoice_date)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_orders_date
  ON public.orders(order_date)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_commissions_order_date
  ON public.commissions(order_date);
