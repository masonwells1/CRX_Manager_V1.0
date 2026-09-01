-- Correct AP aging to measure days past due from due_date, not bill age.
--
-- Current means not yet due (including bills due on the report date). Overdue
-- balances are split into explicit 1-30, 31-60, 61-90, and over-90 buckets.
-- The report remains intentionally current-only until durable historical bill
-- state is available.

DO $preflight$
DECLARE
  v_overload_count integer;
  v_actual_hash text;
  v_owner text;
  v_language text;
  v_security_definer boolean;
  v_config text[];
BEGIN
  SELECT count(*)
    INTO v_overload_count
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_ap_aging';
  IF v_overload_count <> 1
     OR to_regprocedure('public.get_ap_aging(date)') IS NULL THEN
    RAISE EXCEPTION 'AP_AGING_UNEXPECTED_PUBLIC_OVERLOADS: expected only public.get_ap_aging(date) but found % overload(s)',
      v_overload_count;
  END IF;

  SELECT encode(extensions.digest(convert_to(p.prosrc, 'UTF8'), 'sha256'), 'hex'),
         r.rolname, l.lanname, p.prosecdef, p.proconfig
    INTO v_actual_hash, v_owner, v_language, v_security_definer, v_config
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
    JOIN pg_catalog.pg_language l ON l.oid = p.prolang
   WHERE p.oid = 'public.get_ap_aging(date)'::regprocedure;
  IF v_actual_hash IS DISTINCT FROM '093bc502397c32eca1a2496dcd9e172254996a4a88bf7619ee97c0b37ea14842'
     OR v_owner IS DISTINCT FROM 'postgres'
     OR v_language IS DISTINCT FROM 'plpgsql'
     OR v_security_definer IS DISTINCT FROM true
     OR v_config IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[] THEN
    RAISE EXCEPTION 'AP_AGING_REVIEWED_CONTRACT_DRIFT';
  END IF;
END;
$preflight$;

DROP FUNCTION IF EXISTS public.get_ap_aging(date);

CREATE FUNCTION public.get_ap_aging(
  p_as_of_date date DEFAULT ((clock_timestamp() AT TIME ZONE 'America/Chicago')::date)
)
RETURNS TABLE(
  vendor_id uuid,
  vendor_name text,
  current_amount bigint,
  days_1_30 bigint,
  days_31_60 bigint,
  days_61_90 bigint,
  over_90 bigint,
  total_outstanding bigint,
  bill_count integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_today date := (clock_timestamp() AT TIME ZONE 'America/Chicago')::date;
BEGIN
  PERFORM public.require_admin();

  IF p_as_of_date IS DISTINCT FROM v_today THEN
    RAISE EXCEPTION
      'HISTORICAL_AP_UNAVAILABLE: exact AP history is unavailable before durable bill-state history exists';
  END IF;

  RETURN QUERY
  SELECT
    v.id AS vendor_id,
    v.name AS vendor_name,
    COALESCE(SUM(
      CASE
        WHEN vb.due_date >= p_as_of_date THEN vb.balance_cents
        ELSE 0
      END
    ), 0)::bigint AS current_amount,
    COALESCE(SUM(
      CASE
        WHEN (p_as_of_date - vb.due_date) BETWEEN 1 AND 30
          THEN vb.balance_cents
        ELSE 0
      END
    ), 0)::bigint AS days_1_30,
    COALESCE(SUM(
      CASE
        WHEN (p_as_of_date - vb.due_date) BETWEEN 31 AND 60
          THEN vb.balance_cents
        ELSE 0
      END
    ), 0)::bigint AS days_31_60,
    COALESCE(SUM(
      CASE
        WHEN (p_as_of_date - vb.due_date) BETWEEN 61 AND 90
          THEN vb.balance_cents
        ELSE 0
      END
    ), 0)::bigint AS days_61_90,
    COALESCE(SUM(
      CASE
        WHEN (p_as_of_date - vb.due_date) > 90 THEN vb.balance_cents
        ELSE 0
      END
    ), 0)::bigint AS over_90,
    COALESCE(SUM(vb.balance_cents), 0)::bigint AS total_outstanding,
    COUNT(vb.id)::integer AS bill_count
  FROM public.vendors v
  LEFT JOIN public.vendor_bills vb
    ON vb.vendor_id = v.id
   AND vb.status IN ('unpaid', 'partially_paid')
   AND vb.deleted_at IS NULL
   AND vb.bill_date <= p_as_of_date
  WHERE v.deleted_at IS NULL
  GROUP BY v.id, v.name
  HAVING COALESCE(SUM(vb.balance_cents), 0) > 0
  ORDER BY COALESCE(SUM(vb.balance_cents), 0) DESC;
END;
$function$;

ALTER FUNCTION public.get_ap_aging(date) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_ap_aging(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_ap_aging(date)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.get_ap_aging(date) IS
  'Current-only AP aging by due date: not due, 1-30, 31-60, 61-90, and over 90 days past due.';

DO $verify$
DECLARE
  v_source text;
  v_overload_count integer;
  v_owner text;
  v_language text;
  v_security_definer boolean;
  v_config text[];
BEGIN
  SELECT count(*)
    INTO v_overload_count
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_ap_aging';
  IF v_overload_count <> 1 THEN
    RAISE EXCEPTION 'AP_AGING_POSTFLIGHT_PUBLIC_OVERLOAD_DRIFT';
  END IF;

  SELECT p.prosrc, r.rolname, l.lanname, p.prosecdef, p.proconfig
    INTO v_source, v_owner, v_language, v_security_definer, v_config
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
    JOIN pg_catalog.pg_language l ON l.oid = p.prolang
   WHERE p.oid = 'public.get_ap_aging(date)'::regprocedure;

  IF v_owner IS DISTINCT FROM 'postgres'
     OR v_language IS DISTINCT FROM 'plpgsql'
     OR v_security_definer IS DISTINCT FROM true
     OR v_config IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
     OR position('p_as_of_date IS DISTINCT FROM v_today' IN v_source) = 0
     OR position('vb.due_date >= p_as_of_date' IN v_source) = 0
     OR position('BETWEEN 1 AND 30' IN v_source) = 0
     OR position('(p_as_of_date - vb.due_date) > 90' IN v_source) = 0
     OR position('p_as_of_date - vb.bill_date' IN v_source) > 0 THEN
    RAISE EXCEPTION 'get_ap_aging due-date bucket verification failed';
  END IF;
END;
$verify$;
