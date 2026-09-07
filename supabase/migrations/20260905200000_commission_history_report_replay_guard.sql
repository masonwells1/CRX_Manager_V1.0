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
  v_child_named_count integer;
  v_child_contract_count integer;
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
    INTO v_child_named_count
    FROM (
      SELECT p.proname
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname IN (
           'get_commission_balance_report',
           'get_commission_payment_detail_report'
         )
       GROUP BY p.proname
      HAVING count(*) = 1
    ) exact_child_name;

  IF v_child_named_count <> 2 THEN
    RAISE EXCEPTION
      'COMMISSION_HISTORY_REPORT_DEPENDENCY_DRIFT: expected exactly one overload of each privileged child report';
  END IF;

  WITH expected(
    function_name,
    body_md5,
    all_arg_types,
    arg_modes,
    arg_names,
    function_comment
  ) AS (
    VALUES
      (
        'get_commission_balance_report',
        '3edbcba030a9d5d0a106eeb9bf5a6635',
        ARRAY[
          'date'::regtype::oid,
          'uuid'::regtype::oid,
          'text'::regtype::oid,
          'numeric'::regtype::oid,
          'numeric'::regtype::oid,
          'numeric'::regtype::oid,
          'bigint'::regtype::oid,
          'bigint'::regtype::oid
        ]::oid[],
        ARRAY['i', 't', 't', 't', 't', 't', 't', 't']::"char"[],
        ARRAY[
          'p_as_of_date', 'recipient_id', 'recipient_name', 'total_earned',
          'total_paid', 'outstanding_balance', 'pending_count', 'paid_count'
        ]::text[],
        'Admin-only exact commission earned, paid, and outstanding balances from the immutable cutover''s first complete Chicago day through Chicago-today; earlier dates fail closed because pre-cutover earned-state history is unavailable.'
      ),
      (
        'get_commission_payment_detail_report',
        'c81b83a9175cc2398f348761d72929af',
        ARRAY[
          'date'::regtype::oid,
          'uuid'::regtype::oid,
          'text'::regtype::oid,
          'date'::regtype::oid,
          'uuid'::regtype::oid,
          'text'::regtype::oid,
          'uuid'::regtype::oid,
          'text'::regtype::oid,
          'text'::regtype::oid,
          'text'::regtype::oid,
          'date'::regtype::oid,
          'numeric'::regtype::oid
        ]::oid[],
        ARRAY['i', 't', 't', 't', 't', 't', 't', 't', 't', 't', 't', 't']::"char"[],
        ARRAY[
          'p_as_of_date', 'payment_id', 'payment_number', 'payment_date',
          'recipient_id', 'recipient_name', 'commission_id', 'source_type',
          'source_number', 'customer_name', 'commission_order_date', 'settled_amount'
        ]::text[],
        'Admin-only payment and settled-commission reconciliation detail from the immutable cutover''s first complete Chicago day through Chicago-today.'
      )
  )
  SELECT count(*)
    INTO v_child_contract_count
    FROM expected e
    JOIN pg_proc p ON p.proname = e.function_name
    JOIN pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_language l ON l.oid = p.prolang
    JOIN pg_roles owner_role ON owner_role.oid = p.proowner
   WHERE n.nspname = 'public'
     AND p.prokind = 'f'
     AND p.pronargs = 1
     AND p.pronargdefaults = 0
     AND p.proargdefaults IS NULL
     AND oidvectortypes(p.proargtypes) = 'date'
     AND p.proallargtypes IS NOT DISTINCT FROM e.all_arg_types
     AND p.proargmodes IS NOT DISTINCT FROM e.arg_modes
     AND p.proargnames IS NOT DISTINCT FROM e.arg_names
     AND p.prorettype = 'record'::regtype
     AND p.proretset
     AND l.lanname = 'plpgsql'
     AND p.provolatile = 's'
     AND p.prosecdef
     AND NOT p.proisstrict
     AND NOT p.proleakproof
     AND p.proparallel = 'u'
     AND p.procost = 100
     AND p.prorows = 1000
     AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
     AND owner_role.rolname = 'postgres'
     AND md5(p.prosrc) = e.body_md5
     AND p.prosrc LIKE '%PERFORM public.require_admin()%'
     AND p.proacl::text IS NOT DISTINCT FROM
       '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'
     AND obj_description(p.oid, 'pg_proc') IS NOT DISTINCT FROM e.function_comment;

  IF v_child_contract_count <> 2 THEN
    RAISE EXCEPTION
      'COMMISSION_HISTORY_REPORT_DEPENDENCY_DRIFT: privileged child report contract differs from the reviewed implementation';
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
     AND p.pronargdefaults = 0
     AND p.proargdefaults IS NULL
     AND oidvectortypes(p.proargtypes) = 'date'
     AND p.proargnames IS NOT DISTINCT FROM ARRAY['p_as_of_date']::text[]
     AND p.prorettype = 'jsonb'::regtype
     AND NOT p.proretset
     AND l.lanname = 'sql'
     AND p.provolatile = 's'
     AND NOT p.prosecdef
     AND NOT p.proisstrict
     AND NOT p.proleakproof
     AND p.proparallel = 'u'
     AND p.procost = 100
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
  v_child_named_count integer;
  v_child_contract_count integer;
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
     AND p.pronargdefaults = 0
     AND p.proargdefaults IS NULL
     AND oidvectortypes(p.proargtypes) = 'date'
     AND p.proargnames IS NOT DISTINCT FROM ARRAY['p_as_of_date']::text[]
     AND p.prorettype = 'jsonb'::regtype
     AND NOT p.proretset
     AND l.lanname = 'sql'
     AND p.provolatile = 's'
     AND NOT p.prosecdef
     AND NOT p.proisstrict
     AND NOT p.proleakproof
     AND p.proparallel = 'u'
     AND p.procost = 100
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

  SELECT count(*)
    INTO v_child_named_count
    FROM (
      SELECT p.proname
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname IN (
           'get_commission_balance_report',
           'get_commission_payment_detail_report'
         )
       GROUP BY p.proname
      HAVING count(*) = 1
    ) exact_child_name;

  WITH expected(
    function_name,
    body_md5,
    all_arg_types,
    arg_modes,
    arg_names,
    function_comment
  ) AS (
    VALUES
      (
        'get_commission_balance_report',
        '3edbcba030a9d5d0a106eeb9bf5a6635',
        ARRAY[
          'date'::regtype::oid,
          'uuid'::regtype::oid,
          'text'::regtype::oid,
          'numeric'::regtype::oid,
          'numeric'::regtype::oid,
          'numeric'::regtype::oid,
          'bigint'::regtype::oid,
          'bigint'::regtype::oid
        ]::oid[],
        ARRAY['i', 't', 't', 't', 't', 't', 't', 't']::"char"[],
        ARRAY[
          'p_as_of_date', 'recipient_id', 'recipient_name', 'total_earned',
          'total_paid', 'outstanding_balance', 'pending_count', 'paid_count'
        ]::text[],
        'Admin-only exact commission earned, paid, and outstanding balances from the immutable cutover''s first complete Chicago day through Chicago-today; earlier dates fail closed because pre-cutover earned-state history is unavailable.'
      ),
      (
        'get_commission_payment_detail_report',
        'c81b83a9175cc2398f348761d72929af',
        ARRAY[
          'date'::regtype::oid,
          'uuid'::regtype::oid,
          'text'::regtype::oid,
          'date'::regtype::oid,
          'uuid'::regtype::oid,
          'text'::regtype::oid,
          'uuid'::regtype::oid,
          'text'::regtype::oid,
          'text'::regtype::oid,
          'text'::regtype::oid,
          'date'::regtype::oid,
          'numeric'::regtype::oid
        ]::oid[],
        ARRAY['i', 't', 't', 't', 't', 't', 't', 't', 't', 't', 't', 't']::"char"[],
        ARRAY[
          'p_as_of_date', 'payment_id', 'payment_number', 'payment_date',
          'recipient_id', 'recipient_name', 'commission_id', 'source_type',
          'source_number', 'customer_name', 'commission_order_date', 'settled_amount'
        ]::text[],
        'Admin-only payment and settled-commission reconciliation detail from the immutable cutover''s first complete Chicago day through Chicago-today.'
      )
  )
  SELECT count(*)
    INTO v_child_contract_count
    FROM expected e
    JOIN pg_proc p ON p.proname = e.function_name
    JOIN pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_language l ON l.oid = p.prolang
    JOIN pg_roles owner_role ON owner_role.oid = p.proowner
   WHERE n.nspname = 'public'
     AND p.prokind = 'f'
     AND p.pronargs = 1
     AND p.pronargdefaults = 0
     AND p.proargdefaults IS NULL
     AND oidvectortypes(p.proargtypes) = 'date'
     AND p.proallargtypes IS NOT DISTINCT FROM e.all_arg_types
     AND p.proargmodes IS NOT DISTINCT FROM e.arg_modes
     AND p.proargnames IS NOT DISTINCT FROM e.arg_names
     AND p.prorettype = 'record'::regtype
     AND p.proretset
     AND l.lanname = 'plpgsql'
     AND p.provolatile = 's'
     AND p.prosecdef
     AND NOT p.proisstrict
     AND NOT p.proleakproof
     AND p.proparallel = 'u'
     AND p.procost = 100
     AND p.prorows = 1000
     AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
     AND owner_role.rolname = 'postgres'
     AND md5(p.prosrc) = e.body_md5
     AND p.prosrc LIKE '%PERFORM public.require_admin()%'
     AND p.proacl::text IS NOT DISTINCT FROM
       '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'
     AND obj_description(p.oid, 'pg_proc') IS NOT DISTINCT FROM e.function_comment;

  IF v_child_named_count <> 2 OR v_child_contract_count <> 2 THEN
    RAISE EXCEPTION
      'COMMISSION_HISTORY_REPORT_DEPENDENCY_POSTCONDITION_FAIL: privileged child report contract changed during replay';
  END IF;
END
$commission_history_report_postflight$;
