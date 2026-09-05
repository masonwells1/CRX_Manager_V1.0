-- NOT APPLIED — DO NOT APPLY without Mason's explicit in-chat approval.
-- LOCAL CANDIDATE for the commission history replay guard.
-- Harden the already-applied commission history snapshot RPC against shadow
-- overloads and replay drift. This migration deliberately refuses unknown
-- function, owner, security, search-path, body, comment, or ACL state rather
-- than overwriting it on an ordinary CREATE OR REPLACE replay.

DO $commission_history_report_preflight$
DECLARE
  v_named_count integer;
  v_contract_count integer;
BEGIN
  SELECT count(*)
    INTO v_named_count
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'get_commission_history_report';

  IF v_named_count <> 1 THEN
    RAISE EXCEPTION
      'COMMISSION_HISTORY_REPORT_CONTRACT_DRIFT: expected exactly one get_commission_history_report overload, found %',
      v_named_count;
  END IF;

  SELECT count(*)
    INTO v_contract_count
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_language l ON l.oid = p.prolang
    JOIN pg_roles owner_role ON owner_role.oid = p.proowner
   WHERE n.nspname = 'public'
     AND p.proname = 'get_commission_history_report'
     AND p.prokind = 'f'
     AND p.pronargs = 1
     AND oidvectortypes(p.proargtypes) = 'date'
     AND p.proargnames IS NOT DISTINCT FROM ARRAY['p_as_of_date']::text[]
     AND p.prorettype = 'jsonb'::regtype
     AND l.lanname = 'sql'
     AND p.provolatile = 's'
     AND NOT p.prosecdef
     AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
     AND owner_role.rolname = 'postgres'
     AND md5(p.prosrc) = 'e66a3c6e9e13021f2858953cf327e1dd'
     AND p.proacl::text IS NOT DISTINCT FROM
       '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'
     AND obj_description(p.oid, 'pg_proc') IS NOT DISTINCT FROM
       'Admin-only commission balance and payment-detail arrays evaluated together in one stable SQL statement snapshot for the requested supported Chicago business date.';

  IF v_contract_count <> 1 THEN
    RAISE EXCEPTION
      'COMMISSION_HISTORY_REPORT_CONTRACT_DRIFT: get_commission_history_report(date) is not the exact reviewed implementation';
  END IF;
END
$commission_history_report_preflight$;

CREATE OR REPLACE FUNCTION public.get_commission_history_report(p_as_of_date date)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $function$
  SELECT jsonb_build_object(
    'as_of_date', p_as_of_date,
    'balance_rows', COALESCE(
      (
        SELECT jsonb_agg(to_jsonb(balance_row)
          ORDER BY balance_row.outstanding_balance DESC, balance_row.recipient_name)
        FROM public.get_commission_balance_report(p_as_of_date) AS balance_row
      ),
      '[]'::jsonb
    ),
    'payment_detail_rows', COALESCE(
      (
        SELECT jsonb_agg(to_jsonb(detail_row)
          ORDER BY detail_row.payment_date, detail_row.payment_number,
                   detail_row.commission_order_date, detail_row.commission_id)
        FROM public.get_commission_payment_detail_report(p_as_of_date) AS detail_row
      ),
      '[]'::jsonb
    )
  );
$function$;

ALTER FUNCTION public.get_commission_history_report(date) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.get_commission_history_report(date)
  FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
GRANT EXECUTE ON FUNCTION public.get_commission_history_report(date)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.get_commission_history_report(date) IS
  'Admin-only commission balance and payment-detail arrays evaluated together in one stable SQL statement snapshot for the requested supported Chicago business date.';

DO $commission_history_report_postflight$
DECLARE
  v_named_count integer;
  v_contract_count integer;
BEGIN
  SELECT count(*)
    INTO v_named_count
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'get_commission_history_report';

  SELECT count(*)
    INTO v_contract_count
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_language l ON l.oid = p.prolang
    JOIN pg_roles owner_role ON owner_role.oid = p.proowner
   WHERE n.nspname = 'public'
     AND p.proname = 'get_commission_history_report'
     AND p.prokind = 'f'
     AND p.pronargs = 1
     AND oidvectortypes(p.proargtypes) = 'date'
     AND p.proargnames IS NOT DISTINCT FROM ARRAY['p_as_of_date']::text[]
     AND p.prorettype = 'jsonb'::regtype
     AND l.lanname = 'sql'
     AND p.provolatile = 's'
     AND NOT p.prosecdef
     AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
     AND owner_role.rolname = 'postgres'
     AND md5(p.prosrc) = 'e66a3c6e9e13021f2858953cf327e1dd'
     AND p.proacl::text IS NOT DISTINCT FROM
       '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'
     AND obj_description(p.oid, 'pg_proc') IS NOT DISTINCT FROM
       'Admin-only commission balance and payment-detail arrays evaluated together in one stable SQL statement snapshot for the requested supported Chicago business date.';

  IF v_named_count <> 1 OR v_contract_count <> 1 THEN
    RAISE EXCEPTION
      'COMMISSION_HISTORY_REPORT_CONTRACT_POSTCONDITION_FAIL: exact overload, function, and ACL contract was not installed';
  END IF;
END
$commission_history_report_postflight$;
