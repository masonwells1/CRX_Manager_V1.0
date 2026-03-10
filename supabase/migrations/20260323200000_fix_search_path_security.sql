-- ============================================================================
-- Migration: 20260323200000_fix_search_path_security.sql
-- Date: 2026-03-10
-- Description: Fix 7 functions flagged by Supabase security advisor for
--              mutable search_path. Adds SET search_path = public to each
--              function to prevent search_path injection attacks.
--
-- Functions fixed:
--   1. _is_admin_override()
--   2. compute_season(date)
--   3. current_season()
--   4. get_ar_aging(date)
--   5. get_season_comparison(integer, integer)
--   6. season_end_date(integer)
--   7. season_start_date(integer)
-- ============================================================================

-- 1. _is_admin_override
CREATE OR REPLACE FUNCTION public._is_admin_override()
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SET search_path = public
AS $function$
  SELECT current_setting('app.admin_override', true) = 'true';
$function$;

-- 2. compute_season
CREATE OR REPLACE FUNCTION public.compute_season(p_date date)
  RETURNS integer
  LANGUAGE sql
  IMMUTABLE PARALLEL SAFE
  SET search_path = public
AS $function$
  SELECT CASE WHEN extract(month FROM p_date) >= 10
    THEN extract(year FROM p_date)::integer + 1
    ELSE extract(year FROM p_date)::integer END;
$function$;

-- 3. current_season
CREATE OR REPLACE FUNCTION public.current_season()
  RETURNS integer
  LANGUAGE sql
  STABLE
  SET search_path = public
AS $function$
  SELECT compute_season(CURRENT_DATE);
$function$;

-- 4. get_ar_aging
CREATE OR REPLACE FUNCTION public.get_ar_aging(p_as_of_date date DEFAULT CURRENT_DATE)
  RETURNS TABLE(
    customer_id uuid,
    farm_name text,
    current_amount numeric,
    days_30 numeric,
    days_60 numeric,
    days_90 numeric,
    over_90 numeric,
    total_outstanding numeric
  )
  LANGUAGE plpgsql
  STABLE SECURITY DEFINER
  SET search_path = public
AS $function$
BEGIN
  RETURN QUERY
  SELECT
    c.id AS customer_id,
    c.farm_name,
    COALESCE(SUM(CASE WHEN age_days BETWEEN 0 AND 29 THEN balance END), 0) AS current_amount,
    COALESCE(SUM(CASE WHEN age_days BETWEEN 30 AND 59 THEN balance END), 0) AS days_30,
    COALESCE(SUM(CASE WHEN age_days BETWEEN 60 AND 89 THEN balance END), 0) AS days_60,
    COALESCE(SUM(CASE WHEN age_days BETWEEN 90 AND 119 THEN balance END), 0) AS days_90,
    COALESCE(SUM(CASE WHEN age_days >= 120 THEN balance END), 0) AS over_90,
    COALESCE(SUM(balance), 0) AS total_outstanding
  FROM customers c
  INNER JOIN (
    SELECT
      i.customer_id,
      (i.balance_cents::numeric / 100) AS balance,
      (p_as_of_date - i.invoice_date::date) AS age_days
    FROM invoices i
    WHERE i.status = 'posted'
      AND i.balance_cents > 0
      AND i.deleted_at IS NULL
  ) ar ON ar.customer_id = c.id
  GROUP BY c.id, c.farm_name
  HAVING SUM(balance) > 0
  ORDER BY SUM(balance) DESC;
END;
$function$;

-- 5. get_season_comparison
CREATE OR REPLACE FUNCTION public.get_season_comparison(p_season_a integer, p_season_b integer)
  RETURNS TABLE(
    metric text,
    season_a_val numeric,
    season_b_val numeric,
    change_pct numeric
  )
  LANGUAGE plpgsql
  STABLE SECURITY DEFINER
  SET search_path = public
AS $function$
DECLARE
  v_a_start date;
  v_a_end date;
  v_b_start date;
  v_b_end date;
  v_a_revenue numeric;
  v_b_revenue numeric;
  v_a_profit numeric;
  v_b_profit numeric;
  v_a_orders int;
  v_b_orders int;
  v_a_customers int;
  v_b_customers int;
BEGIN
  v_a_start := season_start_date(p_season_a);
  v_a_end   := season_end_date(p_season_a);
  v_b_start := season_start_date(p_season_b);
  v_b_end   := season_end_date(p_season_b);

  SELECT COALESCE(SUM(total_price), 0), COALESCE(SUM(total_profit), 0), COUNT(*), COUNT(DISTINCT customer_id)
  INTO v_a_revenue, v_a_profit, v_a_orders, v_a_customers
  FROM orders
  WHERE order_date BETWEEN v_a_start AND v_a_end
    AND status <> 'cancelled';

  SELECT COALESCE(SUM(total_price), 0), COALESCE(SUM(total_profit), 0), COUNT(*), COUNT(DISTINCT customer_id)
  INTO v_b_revenue, v_b_profit, v_b_orders, v_b_customers
  FROM orders
  WHERE order_date BETWEEN v_b_start AND v_b_end
    AND status <> 'cancelled';

  RETURN QUERY VALUES
    ('Revenue'::text, v_a_revenue, v_b_revenue,
      CASE WHEN v_b_revenue > 0 THEN ROUND((v_a_revenue - v_b_revenue) / v_b_revenue * 100, 1) ELSE NULL END),
    ('Profit'::text, v_a_profit, v_b_profit,
      CASE WHEN v_b_profit > 0 THEN ROUND((v_a_profit - v_b_profit) / v_b_profit * 100, 1) ELSE NULL END),
    ('Orders'::text, v_a_orders::numeric, v_b_orders::numeric,
      CASE WHEN v_b_orders > 0 THEN ROUND((v_a_orders - v_b_orders)::numeric / v_b_orders * 100, 1) ELSE NULL END),
    ('Active Customers'::text, v_a_customers::numeric, v_b_customers::numeric,
      CASE WHEN v_b_customers > 0 THEN ROUND((v_a_customers - v_b_customers)::numeric / v_b_customers * 100, 1) ELSE NULL END);
END;
$function$;

-- 6. season_end_date
CREATE OR REPLACE FUNCTION public.season_end_date(p_season integer)
  RETURNS date
  LANGUAGE sql
  IMMUTABLE PARALLEL SAFE
  SET search_path = public
AS $function$
  SELECT make_date(p_season, 9, 30);
$function$;

-- 7. season_start_date
CREATE OR REPLACE FUNCTION public.season_start_date(p_season integer)
  RETURNS date
  LANGUAGE sql
  IMMUTABLE PARALLEL SAFE
  SET search_path = public
AS $function$
  SELECT make_date(p_season - 1, 10, 1);
$function$;
