-- Customer 360 summary RPC
-- Returns KPIs for CustomerDetail summary bar

CREATE OR REPLACE FUNCTION public.get_customer_summary(
  p_customer_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_result jsonb;
  v_ar_balance bigint;
  v_order_count int;
  v_delivery_count int;
  v_credit_tier int;
  v_last_activity timestamptz;
  v_season_start date;
  v_season_end date;
BEGIN
  -- Current season: Oct 1 to Sep 30
  IF extract(month FROM current_date) >= 10 THEN
    v_season_start := make_date(extract(year FROM current_date)::int, 10, 1);
    v_season_end := make_date(extract(year FROM current_date)::int + 1, 9, 30);
  ELSE
    v_season_start := make_date(extract(year FROM current_date)::int - 1, 10, 1);
    v_season_end := make_date(extract(year FROM current_date)::int, 9, 30);
  END IF;

  -- AR Balance (sum of unpaid invoice balances)
  SELECT COALESCE(sum(balance_cents), 0)
  INTO v_ar_balance
  FROM invoices
  WHERE customer_id = p_customer_id
    AND status IN ('posted', 'overdue');

  -- Orders this season
  SELECT count(*)
  INTO v_order_count
  FROM orders
  WHERE customer_id = p_customer_id
    AND order_date >= v_season_start
    AND order_date <= v_season_end
    AND status NOT IN ('cancelled', 'voided');

  -- Completed deliveries this season
  SELECT count(*)
  INTO v_delivery_count
  FROM deliveries
  WHERE customer_id = p_customer_id
    AND status = 'completed'
    AND completed_at >= v_season_start
    AND completed_at <= v_season_end;

  -- Credit tier
  SELECT assigned_tier
  INTO v_credit_tier
  FROM customers
  WHERE id = p_customer_id;

  -- Last activity
  SELECT max(created_at)
  INTO v_last_activity
  FROM activity_feed
  WHERE customer_id = p_customer_id;

  v_result := jsonb_build_object(
    'ar_balance_cents', v_ar_balance,
    'order_count', v_order_count,
    'delivery_count', v_delivery_count,
    'credit_tier', v_credit_tier,
    'last_activity', v_last_activity
  );

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_customer_summary(uuid) TO authenticated;
