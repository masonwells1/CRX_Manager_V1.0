-- Close the remaining money/inventory findings from the 2026-07-14 deep audit.
-- Every RPC below is an explicit re-emit of the current single overload. Public
-- signatures, return shapes, volatility, security mode, and search paths are preserved.

-- -----------------------------------------------------------------------------
-- Sales reports: terminal voided orders are not sales.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_sales_detail_report(
  p_start_date date DEFAULT NULL,
  p_end_date date DEFAULT NULL,
  p_product_id uuid DEFAULT NULL,
  p_customer_ids uuid[] DEFAULT NULL,
  p_sales_rep_id uuid DEFAULT NULL,
  p_category text DEFAULT NULL,
  p_season integer DEFAULT NULL
)
RETURNS TABLE (
  order_date date,
  order_number text,
  customer_name text,
  customer_id uuid,
  product_name text,
  product_id uuid,
  sku text,
  category text,
  quantity numeric,
  unit text,
  unit_price numeric,
  total_price numeric,
  cost numeric,
  profit numeric,
  margin_pct numeric,
  sales_rep_name text,
  invoice_number text,
  season integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.profiles
    WHERE id = auth.uid()
      AND is_active = true
      AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'Access denied: admin or sales_rep role required';
  END IF;

  RETURN QUERY
  SELECT
    o.order_date,
    o.order_number,
    c.farm_name AS customer_name,
    o.customer_id,
    oi.product_name,
    oi.product_id,
    p.sku,
    p.category,
    oi.total_units_needed AS quantity,
    oi.unit_size AS unit,
    oi.price_per_unit AS unit_price,
    oi.total_price,
    ROUND(oi.cost_per_unit * oi.total_units_needed, 2) AS cost,
    oi.profit,
    CASE
      WHEN oi.total_price > 0 THEN ROUND((oi.profit / oi.total_price) * 100, 1)
      ELSE 0::numeric
    END AS margin_pct,
    COALESCE(rep.full_name, 'Unassigned') AS sales_rep_name,
    inv.invoice_number,
    o.season
  FROM public.order_items oi
  JOIN public.orders o ON o.id = oi.order_id
  JOIN public.customers c ON c.id = o.customer_id
  JOIN public.products p ON p.id = oi.product_id
  LEFT JOIN public.profiles rep ON rep.id = o.salesman_id
  LEFT JOIN LATERAL (
    SELECT ii.invoice_id, i2.invoice_number
    FROM public.invoice_items ii
    JOIN public.invoices i2 ON i2.id = ii.invoice_id
    WHERE ii.order_item_id = oi.id
      AND i2.status NOT IN ('void', 'voided')
      AND i2.deleted_at IS NULL
    ORDER BY i2.created_at DESC
    LIMIT 1
  ) inv ON true
  WHERE o.deleted_at IS NULL
    AND o.status NOT IN ('cancelled', 'voided')
    AND (p_start_date IS NULL OR o.order_date >= p_start_date)
    AND (p_end_date IS NULL OR o.order_date <= p_end_date)
    AND (p_product_id IS NULL OR oi.product_id = p_product_id)
    AND (p_customer_ids IS NULL OR o.customer_id = ANY(p_customer_ids))
    AND (p_sales_rep_id IS NULL OR o.salesman_id = p_sales_rep_id)
    AND (p_category IS NULL OR p.category = p_category)
    AND (p_season IS NULL OR o.season = p_season)
  ORDER BY o.order_date DESC, c.farm_name, oi.product_name;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_sales_summary_report(
  p_group_by text DEFAULT 'product',
  p_start_date date DEFAULT NULL,
  p_end_date date DEFAULT NULL,
  p_product_id uuid DEFAULT NULL,
  p_customer_ids uuid[] DEFAULT NULL,
  p_sales_rep_id uuid DEFAULT NULL,
  p_category text DEFAULT NULL,
  p_season integer DEFAULT NULL
)
RETURNS TABLE (
  group_key text,
  group_id uuid,
  total_quantity numeric,
  total_revenue numeric,
  total_cost numeric,
  total_profit numeric,
  margin_pct numeric,
  order_count bigint,
  line_count bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.profiles
    WHERE id = auth.uid()
      AND is_active = true
      AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'Access denied: admin or sales_rep role required';
  END IF;

  RETURN QUERY
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
      oi.total_price AS revenue,
      ROUND(oi.cost_per_unit * oi.total_units_needed, 2) AS cost,
      oi.profit
    FROM public.order_items oi
    JOIN public.orders o ON o.id = oi.order_id
    JOIN public.customers c ON c.id = o.customer_id
    JOIN public.products p ON p.id = oi.product_id
    LEFT JOIN public.profiles rep ON rep.id = o.salesman_id
    WHERE o.deleted_at IS NULL
      AND o.status NOT IN ('cancelled', 'voided')
      AND (p_start_date IS NULL OR o.order_date >= p_start_date)
      AND (p_end_date IS NULL OR o.order_date <= p_end_date)
      AND (p_product_id IS NULL OR oi.product_id = p_product_id)
      AND (p_customer_ids IS NULL OR o.customer_id = ANY(p_customer_ids))
      AND (p_sales_rep_id IS NULL OR o.salesman_id = p_sales_rep_id)
      AND (p_category IS NULL OR p.category = p_category)
      AND (p_season IS NULL OR o.season = p_season)
  )
  SELECT
    CASE p_group_by
      WHEN 'product' THEN f.product_name
      WHEN 'customer' THEN f.farm_name
      WHEN 'sales_rep' THEN f.rep_name
      WHEN 'month' THEN TO_CHAR(f.order_date, 'YYYY-MM')
      WHEN 'category' THEN COALESCE(f.category, 'Uncategorized')
      ELSE f.product_name
    END AS group_key,
    CASE p_group_by
      WHEN 'product' THEN f.product_id
      WHEN 'customer' THEN f.customer_id
      WHEN 'sales_rep' THEN f.salesman_id
      ELSE NULL
    END AS group_id,
    SUM(f.quantity) AS total_quantity,
    SUM(f.revenue) AS total_revenue,
    SUM(f.cost) AS total_cost,
    SUM(f.profit) AS total_profit,
    CASE
      WHEN SUM(f.revenue) > 0 THEN ROUND((SUM(f.profit) / SUM(f.revenue)) * 100, 1)
      ELSE 0::numeric
    END AS margin_pct,
    COUNT(DISTINCT f.order_id) AS order_count,
    COUNT(*) AS line_count
  FROM filtered f
  GROUP BY
    CASE p_group_by
      WHEN 'product' THEN f.product_name
      WHEN 'customer' THEN f.farm_name
      WHEN 'sales_rep' THEN f.rep_name
      WHEN 'month' THEN TO_CHAR(f.order_date, 'YYYY-MM')
      WHEN 'category' THEN COALESCE(f.category, 'Uncategorized')
      ELSE f.product_name
    END,
    CASE p_group_by
      WHEN 'product' THEN f.product_id
      WHEN 'customer' THEN f.customer_id
      WHEN 'sales_rep' THEN f.salesman_id
      ELSE NULL
    END
  ORDER BY SUM(f.revenue) DESC;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_gross_sales_report(
  p_start_date date,
  p_end_date date,
  p_group_by text DEFAULT 'product'::text
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
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $function$
BEGIN
  IF NOT (public.is_admin() OR public.is_sales_rep()) THEN
    RAISE EXCEPTION 'Access denied: active admin or sales_rep role required';
  END IF;

  IF p_group_by = 'product' THEN
    RETURN QUERY
    SELECT
      oi.product_name,
      ROUND(SUM(oi.total_price)::numeric, 2),
      ROUND(SUM(oi.cost_per_unit * oi.total_units_needed)::numeric, 2),
      ROUND(SUM(oi.profit)::numeric, 2),
      CASE
        WHEN SUM(oi.total_price) > 0
          THEN ROUND((SUM(oi.profit) / SUM(oi.total_price) * 100)::numeric, 1)
        ELSE 0
      END,
      ROUND(SUM(oi.total_units_needed)::numeric, 2),
      COUNT(DISTINCT oi.order_id)
    FROM public.order_items oi
    JOIN public.orders o ON o.id = oi.order_id
    WHERE o.order_date >= p_start_date
      AND o.order_date <= p_end_date
      AND o.deleted_at IS NULL
      AND o.status NOT IN ('cancelled', 'voided')
    GROUP BY oi.product_name
    ORDER BY SUM(oi.total_price) DESC;
  ELSIF p_group_by = 'customer' THEN
    RETURN QUERY
    SELECT
      c.farm_name,
      ROUND(SUM(o.total_price)::numeric, 2),
      ROUND(SUM(o.total_price - o.total_profit)::numeric, 2),
      ROUND(SUM(o.total_profit)::numeric, 2),
      CASE
        WHEN SUM(o.total_price) > 0
          THEN ROUND((SUM(o.total_profit) / SUM(o.total_price) * 100)::numeric, 1)
        ELSE 0
      END,
      0::numeric,
      COUNT(o.id)
    FROM public.orders o
    LEFT JOIN public.customers c ON c.id = o.customer_id
    WHERE o.order_date >= p_start_date
      AND o.order_date <= p_end_date
      AND o.deleted_at IS NULL
      AND o.status NOT IN ('cancelled', 'voided')
    GROUP BY c.farm_name
    ORDER BY SUM(o.total_price) DESC;
  ELSE
    RETURN QUERY
    SELECT
      COALESCE(p.full_name, 'Unassigned'),
      ROUND(SUM(o.total_price)::numeric, 2),
      ROUND(SUM(o.total_price - o.total_profit)::numeric, 2),
      ROUND(SUM(o.total_profit)::numeric, 2),
      CASE
        WHEN SUM(o.total_price) > 0
          THEN ROUND((SUM(o.total_profit) / SUM(o.total_price) * 100)::numeric, 1)
        ELSE 0
      END,
      0::numeric,
      COUNT(o.id)
    FROM public.orders o
    LEFT JOIN public.profiles p ON p.id = o.salesman_id
    WHERE o.order_date >= p_start_date
      AND o.order_date <= p_end_date
      AND o.deleted_at IS NULL
      AND o.status NOT IN ('cancelled', 'voided')
    GROUP BY p.full_name
    ORDER BY SUM(o.total_price) DESC;
  END IF;
END;
$function$;

-- -----------------------------------------------------------------------------
-- Financial dashboard: active-admin gate and voided-order exclusion in all six
-- order aggregations. All non-order financial behavior and JSON keys are unchanged.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.financial_dashboard_summary()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  result jsonb;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'permission denied: admin role required';
  END IF;

  WITH
  order_agg AS (
    SELECT
      COALESCE(SUM(total_price), 0) AS total_revenue,
      COALESCE(SUM(total_profit), 0) AS total_profit
    FROM public.orders
    WHERE deleted_at IS NULL
      AND status NOT IN ('cancelled', 'voided', 'draft')
  ),
  quote_agg AS (
    SELECT
      COUNT(*) FILTER (WHERE status = 'draft') AS draft_count,
      COUNT(*) FILTER (WHERE status = 'sent') AS sent_count,
      COUNT(*) FILTER (WHERE status = 'accepted') AS accepted_count,
      COALESCE(SUM(total_price) FILTER (WHERE status IN ('draft', 'sent')), 0) AS pipeline_value
    FROM public.quotes
  ),
  monthly AS (
    SELECT jsonb_agg(row_to_json(m)::jsonb ORDER BY m.month) AS arr
    FROM (
      SELECT
        TO_CHAR(COALESCE(order_date, created_at::date), 'YYYY-MM') AS month,
        COALESCE(SUM(total_price), 0) AS revenue,
        COALESCE(SUM(total_profit), 0) AS profit
      FROM public.orders
      WHERE deleted_at IS NULL
        AND status NOT IN ('cancelled', 'voided', 'draft')
      GROUP BY 1
      ORDER BY 1 DESC
      LIMIT 12
    ) m
  ),
  top_cust AS (
    SELECT jsonb_agg(row_to_json(tc)::jsonb ORDER BY tc.total DESC) AS arr
    FROM (
      SELECT c.farm_name, COALESCE(SUM(o.total_price), 0) AS total
      FROM public.orders o
      JOIN public.customers c ON c.id = o.customer_id
      WHERE o.deleted_at IS NULL
        AND o.status NOT IN ('cancelled', 'voided', 'draft')
      GROUP BY c.id, c.farm_name
      ORDER BY total DESC
      LIMIT 5
    ) tc
  ),
  ar AS (
    SELECT COALESCE(SUM(GREATEST(balance_cents, 0)), 0) / 100.0 AS balance
    FROM public.invoices
    WHERE status IN ('posted', 'overdue')
      AND deleted_at IS NULL
  ),
  over_credit AS (
    SELECT COUNT(*) AS cnt
    FROM public.customers c
    WHERE c.credit_limit_cents IS NOT NULL
      AND c.credit_limit_cents > 0
      AND (
        SELECT COALESCE(SUM(GREATEST(i.balance_cents, 0)), 0)
        FROM public.invoices i
        WHERE i.customer_id = c.id
          AND i.status IN ('posted', 'overdue')
          AND i.deleted_at IS NULL
      ) > c.credit_limit_cents
  ),
  ar_aging AS (
    SELECT
      COALESCE(SUM(CASE WHEN age_days <= 30 THEN balance ELSE 0 END), 0) AS current_bucket,
      COALESCE(SUM(CASE WHEN age_days BETWEEN 31 AND 60 THEN balance ELSE 0 END), 0) AS days_31_60,
      COALESCE(SUM(CASE WHEN age_days BETWEEN 61 AND 90 THEN balance ELSE 0 END), 0) AS days_61_90,
      COALESCE(SUM(CASE WHEN age_days > 90 THEN balance ELSE 0 END), 0) AS days_90_plus
    FROM (
      SELECT
        GREATEST(i.balance_cents, 0) / 100.0 AS balance,
        EXTRACT(DAY FROM NOW() - COALESCE(i.due_date, i.invoice_date))::int AS age_days
      FROM public.invoices i
      WHERE i.status IN ('posted', 'overdue')
        AND i.balance_cents > 0
        AND i.deleted_at IS NULL
    ) aged
  ),
  prepay_bal AS (
    SELECT COALESCE(SUM(prepay_balance_cents), 0) / 100.0 AS total_unallocated
    FROM public.customers
    WHERE prepay_balance_cents > 0
  ),
  commission_owed AS (
    SELECT COALESCE(SUM(commission_amount), 0) AS total_owed
    FROM public.commissions
    WHERE status = 'pending'
      AND paid_date IS NULL
  ),
  period_info AS (
    SELECT
      COALESCE(TO_CHAR(period_start, 'Mon YYYY'), TO_CHAR(NOW(), 'Mon YYYY')) AS name,
      COALESCE(status, 'open') AS status,
      CASE
        WHEN period_end IS NOT NULL
          THEN GREATEST(EXTRACT(DAY FROM period_end - NOW())::int, 0)
        ELSE EXTRACT(DAY FROM (DATE_TRUNC('month', NOW()) + INTERVAL '1 month' - INTERVAL '1 day') - NOW())::int
      END AS days_remaining
    FROM public.accounting_periods
    WHERE status = 'open'
    ORDER BY period_start DESC
    LIMIT 1
  ),
  po_unreceived AS (
    SELECT COALESCE(SUM(
      (poi.quantity_ordered - COALESCE(poi.quantity_received, 0)) * poi.unit_cost
    ), 0) AS value
    FROM public.purchase_order_items poi
    JOIN public.purchase_orders po ON po.id = poi.purchase_order_id
    WHERE po.status IN ('submitted', 'partially_received')
  ),
  floor_inv AS (
    SELECT
      COALESCE(SUM(inv.quantity_available * COALESCE(p.current_cost, 0)), 0) AS total_value,
      COALESCE(SUM(
        GREATEST(inv.quantity_available - inv.quantity_prebooked, 0) * COALESCE(p.current_cost, 0)
      ), 0) AS free_value
    FROM public.inventory inv
    JOIN public.products p ON p.id = inv.product_id
    WHERE inv.quantity_available > 0
  ),
  committed_orders AS (
    SELECT COALESCE(SUM(oi.quantity_remaining * oi.cost_per_unit), 0) AS value
    FROM public.order_items oi
    JOIN public.orders o ON o.id = oi.order_id
    WHERE o.status IN ('confirmed', 'partially_fulfilled')
      AND o.deleted_at IS NULL
      AND oi.quantity_remaining > 0
  ),
  bottom_products AS (
    SELECT jsonb_agg(row_to_json(bp)::jsonb ORDER BY bp.margin_pct ASC) AS arr
    FROM (
      SELECT
        p.product_name,
        COALESCE(SUM(oi.total_units_needed * oi.price_per_unit), 0) AS total_revenue,
        COALESCE(SUM(oi.total_units_needed * oi.cost_per_unit), 0) AS total_cost,
        ROUND(
          CASE
            WHEN SUM(oi.total_units_needed * oi.price_per_unit) > 0 THEN
              ((SUM(oi.total_units_needed * oi.price_per_unit) -
                SUM(oi.total_units_needed * oi.cost_per_unit)) /
                NULLIF(SUM(oi.total_units_needed * oi.price_per_unit), 0)) * 100
            ELSE 0
          END,
          1
        ) AS margin_pct,
        COALESCE(SUM(oi.total_units_needed), 0) AS units_sold
      FROM public.order_items oi
      JOIN public.orders o ON o.id = oi.order_id
      JOIN public.products p ON p.id = oi.product_id
      WHERE o.deleted_at IS NULL
        AND o.status NOT IN ('cancelled', 'voided', 'draft')
        AND public.compute_season(COALESCE(o.order_date, o.created_at::date)) =
            public.compute_season(CURRENT_DATE)
      GROUP BY p.id, p.product_name
      HAVING SUM(oi.total_units_needed * oi.price_per_unit) > 0
      ORDER BY margin_pct ASC
      LIMIT 10
    ) bp
  ),
  bottom_customers AS (
    SELECT jsonb_agg(row_to_json(bc)::jsonb ORDER BY bc.margin_pct ASC) AS arr
    FROM (
      SELECT
        c.farm_name,
        COALESCE(SUM(o.total_price), 0) AS total_revenue,
        COALESCE(SUM(o.total_cost), 0) AS total_cost,
        ROUND(
          CASE
            WHEN SUM(o.total_price) > 0 THEN
              ((SUM(o.total_price) - SUM(o.total_cost)) /
                NULLIF(SUM(o.total_price), 0)) * 100
            ELSE 0
          END,
          1
        ) AS margin_pct,
        COUNT(*)::int AS order_count
      FROM public.orders o
      JOIN public.customers c ON c.id = o.customer_id
      WHERE o.deleted_at IS NULL
        AND o.status NOT IN ('cancelled', 'voided', 'draft')
        AND public.compute_season(COALESCE(o.order_date, o.created_at::date)) =
            public.compute_season(CURRENT_DATE)
      GROUP BY c.id, c.farm_name
      HAVING SUM(o.total_price) > 0
      ORDER BY margin_pct ASC
      LIMIT 10
    ) bc
  ),
  monthly_margin AS (
    SELECT jsonb_agg(row_to_json(mm)::jsonb ORDER BY mm.month) AS arr
    FROM (
      SELECT
        TO_CHAR(COALESCE(order_date, created_at::date), 'YYYY-MM') AS month,
        COALESCE(SUM(total_price), 0) AS revenue,
        COALESCE(SUM(total_cost), 0) AS cost,
        ROUND(
          CASE
            WHEN SUM(total_price) > 0 THEN
              ((SUM(total_price) - SUM(total_cost)) /
                NULLIF(SUM(total_price), 0)) * 100
            ELSE 0
          END,
          1
        ) AS margin_pct
      FROM public.orders
      WHERE deleted_at IS NULL
        AND status NOT IN ('cancelled', 'voided', 'draft')
      GROUP BY 1
      ORDER BY 1 DESC
      LIMIT 12
    ) mm
  )
  SELECT jsonb_build_object(
    'total_revenue', oa.total_revenue,
    'total_profit', oa.total_profit,
    'overall_margin', CASE
      WHEN oa.total_revenue > 0 THEN ROUND((oa.total_profit / oa.total_revenue) * 100, 1)
      ELSE 0
    END,
    'quote_counts', jsonb_build_object(
      'draft', qa.draft_count,
      'sent', qa.sent_count,
      'accepted', qa.accepted_count
    ),
    'quote_pipeline_value', qa.pipeline_value,
    'monthly_revenue', COALESCE(mr.arr, '[]'::jsonb),
    'top_customers', COALESCE(tc.arr, '[]'::jsonb),
    'open_ar_balance', ar_total.balance,
    'customers_over_credit_count', oc.cnt,
    'ar_aging_buckets', jsonb_build_object(
      'current', aa.current_bucket,
      'days_31_60', aa.days_31_60,
      'days_61_90', aa.days_61_90,
      'days_90_plus', aa.days_90_plus
    ),
    'total_prepay_unallocated', pb.total_unallocated,
    'total_commission_owed', co.total_owed,
    'current_period', jsonb_build_object(
      'name', COALESCE(pi.name, TO_CHAR(NOW(), 'Mon YYYY')),
      'status', COALESCE(pi.status, 'open'),
      'days_remaining', COALESCE(pi.days_remaining, 0)
    ),
    'po_unreceived_value', pour.value,
    'floor_inventory_value', fi.total_value,
    'floor_free_value', fi.free_value,
    'committed_order_value', co2.value,
    'bottom_products_by_margin', COALESCE(bpm.arr, '[]'::jsonb),
    'bottom_customers_by_margin', COALESCE(bcm.arr, '[]'::jsonb),
    'monthly_margin_trend', COALESCE(mmt.arr, '[]'::jsonb)
  ) INTO result
  FROM order_agg oa
  CROSS JOIN quote_agg qa
  CROSS JOIN monthly mr
  CROSS JOIN top_cust tc
  CROSS JOIN ar ar_total
  CROSS JOIN over_credit oc
  CROSS JOIN ar_aging aa
  CROSS JOIN prepay_bal pb
  CROSS JOIN commission_owed co
  CROSS JOIN po_unreceived pour
  CROSS JOIN floor_inv fi
  CROSS JOIN committed_orders co2
  CROSS JOIN bottom_products bpm
  CROSS JOIN bottom_customers bcm
  CROSS JOIN monthly_margin mmt
  LEFT JOIN period_info pi ON true;

  RETURN result;
END;
$function$;

-- -----------------------------------------------------------------------------
-- Receiving: active profiles only; over-receive is an active-admin exception.
-- Parent/item locks and the rest of the inventory mutation remain unchanged.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.receive_po_items(
  p_items jsonb,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL::text,
  p_allow_over_receive boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_item jsonb;
  v_po_item record;
  v_existing jsonb;
  v_result jsonb;
  v_recv_id uuid;
  v_receiving_record_ids jsonb := '[]'::jsonb;
  v_qty numeric;
  v_actor uuid;
  v_actor_role text;
  v_affected_po_ids uuid[] := '{}';
  v_unique_po_id uuid;
  v_condition text;
  v_lot_number text;
  v_notes text;
  v_storage_location text;
  v_total_ordered numeric;
  v_total_received numeric;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'p_performed_by does not match authenticated user';
  END IF;

  SELECT role INTO v_actor_role
  FROM public.profiles
  WHERE id = v_actor AND is_active = true;
  IF v_actor_role IS NULL OR v_actor_role NOT IN ('admin', 'sales_rep') THEN
    RAISE EXCEPTION 'Only an active admin or sales_rep can receive PO items';
  END IF;
  IF COALESCE(p_allow_over_receive, false) AND v_actor_role IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'Only an active admin can authorize PO over-receiving';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := public.check_idempotency(p_idempotency_key, 'receive_po_items');
    IF v_existing IS NOT NULL THEN
      RETURN v_existing;
    END IF;
  END IF;

  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'No items provided for receiving';
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_qty := COALESCE((v_item->>'quantity')::numeric, 0);
    IF v_qty <= 0 THEN
      CONTINUE;
    END IF;

    SELECT poi.*, po.po_number, po.id AS po_parent_id, po.status AS po_status
    INTO v_po_item
    FROM public.purchase_order_items poi
    JOIN public.purchase_orders po ON po.id = poi.purchase_order_id
    WHERE poi.id = (v_item->>'po_item_id')::uuid
    FOR UPDATE OF poi, po;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'PO item not found: %', v_item->>'po_item_id';
    END IF;
    IF v_po_item.po_status IN ('draft', 'cancelled') THEN
      RAISE EXCEPTION 'Cannot receive against PO % -- status is % (draft/cancelled cannot be received)',
        v_po_item.po_number, v_po_item.po_status;
    END IF;
    IF NOT COALESCE(p_allow_over_receive, false)
       AND (COALESCE(v_po_item.quantity_received, 0) + v_qty) > v_po_item.quantity_ordered THEN
      RAISE EXCEPTION 'Cannot receive more than ordered for item %. Ordered: %, Already received: %, Attempting: %',
        v_po_item.id,
        v_po_item.quantity_ordered,
        COALESCE(v_po_item.quantity_received, 0),
        v_qty;
    END IF;

    v_condition := COALESCE(v_item->>'condition', 'good');
    v_lot_number := v_item->>'lot_number';
    v_notes := v_item->>'notes';
    v_storage_location := COALESCE(v_item->>'storage_location', 'Main Warehouse');

    UPDATE public.inventory
    SET quantity_available = quantity_available + v_qty,
        quantity_on_order = GREATEST(COALESCE(quantity_on_order, 0) - v_qty, 0),
        updated_at = now()
    WHERE product_id = v_po_item.product_id
      AND location = v_storage_location;

    IF NOT FOUND THEN
      INSERT INTO public.inventory (
        product_id, location, quantity_available, quantity_on_order,
        quantity_prebooked, unit_size
      ) VALUES (
        v_po_item.product_id, v_storage_location, v_qty, 0, 0, v_po_item.unit_size
      );
    END IF;

    INSERT INTO public.inventory_transactions (
      product_id, transaction_type, quantity, to_location,
      purchase_order_id, performed_by, notes
    ) VALUES (
      v_po_item.product_id,
      'received',
      v_qty,
      v_storage_location,
      v_po_item.po_parent_id,
      v_actor,
      'Received ' || v_qty || ' units via PO ' || COALESCE(v_po_item.po_number, '')
    );

    INSERT INTO public.receiving_records (
      purchase_order_id, po_item_id, product_id, quantity_received,
      received_by, notes, condition, lot_number, storage_location, unit_size
    ) VALUES (
      v_po_item.po_parent_id,
      v_po_item.id,
      v_po_item.product_id,
      v_qty,
      v_actor,
      v_notes,
      v_condition,
      v_lot_number,
      v_storage_location,
      v_po_item.unit_size
    ) RETURNING id INTO v_recv_id;

    v_receiving_record_ids := v_receiving_record_ids || to_jsonb(v_recv_id::text);
    IF NOT v_po_item.po_parent_id = ANY(v_affected_po_ids) THEN
      v_affected_po_ids := v_affected_po_ids || v_po_item.po_parent_id;
    END IF;

    UPDATE public.purchase_order_items
    SET quantity_received = COALESCE(quantity_received, 0) + v_qty
    WHERE id = v_po_item.id;
  END LOOP;

  FOREACH v_unique_po_id IN ARRAY (
    SELECT ARRAY(SELECT DISTINCT unnest(v_affected_po_ids))
  )
  LOOP
    SELECT COALESCE(SUM(quantity_ordered), 0), COALESCE(SUM(quantity_received), 0)
    INTO v_total_ordered, v_total_received
    FROM public.purchase_order_items
    WHERE purchase_order_id = v_unique_po_id;

    IF v_total_received >= v_total_ordered THEN
      UPDATE public.purchase_orders
      SET status = 'fully_received', updated_at = now()
      WHERE id = v_unique_po_id AND status != 'fully_received';
    ELSIF v_total_received > 0 THEN
      UPDATE public.purchase_orders
      SET status = 'partially_received', updated_at = now()
      WHERE id = v_unique_po_id
        AND status NOT IN ('partially_received', 'fully_received');
    END IF;
  END LOOP;

  v_result := jsonb_build_object(
    'status', 'received',
    'receiving_record_ids', v_receiving_record_ids
  );
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM public.save_idempotency(
      p_idempotency_key, 'receive_po_items', v_result
    );
  END IF;
  RETURN v_result;
END;
$function$;

-- -----------------------------------------------------------------------------
-- Payment ledger: authenticated clients read through RLS but mutate only through
-- the audited SECURITY DEFINER payment RPCs.
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS payments_insert ON public.payments;
DROP POLICY IF EXISTS payments_update ON public.payments;
DROP POLICY IF EXISTS payments_delete ON public.payments;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.payments FROM authenticated;

-- Preserve the existing callable boundaries explicitly.
GRANT EXECUTE ON FUNCTION public.get_sales_detail_report(date, date, uuid, uuid[], uuid, text, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_sales_summary_report(text, date, date, uuid, uuid[], uuid, text, integer) TO authenticated;
REVOKE ALL ON FUNCTION public.get_gross_sales_report(date, date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_gross_sales_report(date, date, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.financial_dashboard_summary() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.receive_po_items(jsonb, uuid, text, boolean) TO authenticated, service_role;

-- Deployment-time assertions: fail closed if a signature or safeguard drifts.
DO $verify$
DECLARE
  v_src text;
BEGIN
  IF (SELECT count(*) FROM pg_proc
      WHERE pronamespace = 'public'::regnamespace
        AND proname IN (
          'get_sales_detail_report', 'get_sales_summary_report',
          'get_gross_sales_report', 'financial_dashboard_summary',
          'receive_po_items'
        )) <> 5 THEN
    RAISE EXCEPTION 'money/inventory RPC overload count drifted';
  END IF;

  SELECT prosrc INTO v_src
  FROM pg_proc
  WHERE oid = 'public.receive_po_items(jsonb,uuid,text,boolean)'::regprocedure;
  IF v_src NOT LIKE '%is_active = true%'
     OR v_src NOT LIKE '%COALESCE(p_allow_over_receive, false)%'
     OR v_src NOT LIKE '%Only an active admin can authorize PO over-receiving%' THEN
    RAISE EXCEPTION 'receive_po_items active/admin over-receive guards missing';
  END IF;

  SELECT prosrc INTO v_src
  FROM pg_proc
  WHERE oid = 'public.financial_dashboard_summary()'::regprocedure;
  IF v_src NOT LIKE '%status NOT IN (''cancelled'', ''voided'', ''draft'')%'
     OR v_src NOT LIKE '%IF NOT public.is_admin() THEN%' THEN
    RAISE EXCEPTION 'financial dashboard status/active-admin guards missing';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'payments'
      AND cmd IN ('INSERT', 'UPDATE', 'DELETE', 'ALL')
  ) THEN
    RAISE EXCEPTION 'payments still exposes a direct write policy';
  END IF;
  IF has_table_privilege('authenticated', 'public.payments', 'INSERT')
     OR has_table_privilege('authenticated', 'public.payments', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.payments', 'DELETE')
     OR has_table_privilege('authenticated', 'public.payments', 'TRUNCATE') THEN
    RAISE EXCEPTION 'authenticated still has direct payments write privileges';
  END IF;
  IF has_function_privilege(
       'anon',
       'public.get_gross_sales_report(date,date,text)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'anonymous still has gross-sales report execution';
  END IF;
END;
$verify$;
