-- STATUS: APPLIED LIVE 2026-09-03 (ledger version 20260903025249)
-- Gauntlet Section 7.3.4: the commissions table stores current payout status,
-- not immutable dated status history. Refuse historical cutoffs instead of
-- rewriting old liability reports after a later payout or void.

CREATE OR REPLACE FUNCTION public.get_commission_balance_report(p_as_of_date date)
RETURNS TABLE (
  recipient_id uuid,
  recipient_name text,
  total_earned numeric,
  total_paid numeric,
  outstanding_balance numeric,
  pending_count bigint,
  paid_count bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_today date := (transaction_timestamp() AT TIME ZONE 'America/Chicago')::date;
BEGIN
  PERFORM public.require_admin();
  IF p_as_of_date IS DISTINCT FROM v_today THEN
    RAISE EXCEPTION
      'HISTORICAL_COMMISSION_BALANCE_UNAVAILABLE: exact historical payout state is unavailable before an immutable payout event ledger exists';
  END IF;

  RETURN QUERY
  SELECT
    cm.recipient_user_id,
    COALESCE(p.full_name, cm.recipient),
    ROUND(SUM(CASE WHEN cm.status <> 'cancelled' THEN cm.commission_amount ELSE 0 END)::numeric, 2),
    ROUND(SUM(CASE WHEN cm.status = 'paid' THEN cm.commission_amount ELSE 0 END)::numeric, 2),
    ROUND(SUM(CASE WHEN cm.status = 'pending' THEN cm.commission_amount ELSE 0 END)::numeric, 2),
    COUNT(*) FILTER (WHERE cm.status = 'pending'),
    COUNT(*) FILTER (WHERE cm.status = 'paid')
  FROM public.commissions cm
  LEFT JOIN public.profiles p ON p.id = cm.recipient_user_id
  WHERE cm.order_date <= v_today::text
  GROUP BY cm.recipient_user_id, COALESCE(p.full_name, cm.recipient)
  ORDER BY SUM(CASE WHEN cm.status = 'pending' THEN cm.commission_amount ELSE 0 END) DESC;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_commission_balance_report(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_commission_balance_report(date) TO authenticated, service_role;

DO $verify$
DECLARE
  v_source text;
BEGIN
  SELECT p.prosrc INTO v_source
  FROM pg_proc p
  WHERE p.oid = 'public.get_commission_balance_report(date)'::regprocedure;

  IF v_source NOT LIKE '%HISTORICAL_COMMISSION_BALANCE_UNAVAILABLE%' THEN
    RAISE EXCEPTION 'historical commission fail-closed guard missing';
  END IF;
  IF has_function_privilege('anon', 'public.get_commission_balance_report(date)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anonymous commission balance execution remains';
  END IF;
END;
$verify$;
