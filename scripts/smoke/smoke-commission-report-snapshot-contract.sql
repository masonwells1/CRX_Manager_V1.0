-- Companion assertions for prove-commission-report-snapshot-contract.mjs.
-- This file is deliberately read-only: the Node harness owns the disposable
-- database and runs the destructive mutation probes in rolled-back sessions.
\set ON_ERROR_STOP on
\pset format unaligned
\pset tuples_only on

-- The wrapper must expose the requested business date and both report arrays.
SELECT CASE
  WHEN jsonb_typeof(result.r) = 'object'
   AND result.r ? 'as_of_date'
   AND result.r ? 'balance_rows'
   AND result.r ? 'payment_detail_rows'
   AND jsonb_typeof(result.r->'balance_rows') = 'array'
   AND jsonb_typeof(result.r->'payment_detail_rows') = 'array'
   AND result.r->>'as_of_date' = :'as_of_date'
  THEN 'COMMISSION_REPORT_SNAPSHOT_RESULT_PASS'
  ELSE 'COMMISSION_REPORT_SNAPSHOT_RESULT_FAIL'
END
FROM (SELECT public.get_commission_history_report(:'as_of_date'::date) AS r) AS result;

-- One wrapper call must agree byte-for-byte with the two underlying reports.
WITH wrapper AS (
  SELECT public.get_commission_history_report(:'as_of_date'::date) AS value
), expected AS (
  SELECT jsonb_build_object(
    'as_of_date', :'as_of_date'::date,
    'balance_rows', COALESCE((
      SELECT jsonb_agg(to_jsonb(x)
        ORDER BY x.outstanding_balance DESC, x.recipient_name)
      FROM public.get_commission_balance_report(:'as_of_date'::date) AS x
    ), '[]'::jsonb),
    'payment_detail_rows', COALESCE((
      SELECT jsonb_agg(to_jsonb(x)
        ORDER BY x.payment_date, x.payment_number,
                 x.commission_order_date, x.commission_id)
      FROM public.get_commission_payment_detail_report(:'as_of_date'::date) AS x
    ), '[]'::jsonb)
  ) AS value
)
SELECT CASE WHEN wrapper.value = expected.value
  THEN 'COMMISSION_REPORT_SNAPSHOT_RECONCILIATION_PASS'
  ELSE 'COMMISSION_REPORT_SNAPSHOT_RECONCILIATION_FAIL'
END
FROM wrapper CROSS JOIN expected;

DO $catalog$
DECLARE
  v_kind "char";
  v_stable boolean;
  v_security_definer boolean;
  v_search_path text[];
  v_sql_statement_terminators integer;
BEGIN
  SELECT p.prokind, p.provolatile = 's', p.prosecdef, p.proconfig
    INTO v_kind, v_stable, v_security_definer, v_search_path
    FROM pg_proc p
   WHERE p.oid = 'public.get_commission_history_report(date)'::regprocedure;
  IF v_kind IS DISTINCT FROM 'f' OR NOT v_stable OR v_security_definer
     OR v_search_path IS DISTINCT FROM ARRAY['search_path=public, pg_temp'] THEN
    RAISE EXCEPTION 'COMMISSION_REPORT_SNAPSHOT_CATALOG_FAIL: function trust/volatility/search_path';
  END IF;
  -- `prosrc` is the SQL-language function body. This exact contract has no
  -- semicolons inside SQL literals, so a second statement necessarily adds a
  -- second terminator. The migration review remains authoritative for parsing.
  SELECT regexp_count(p.prosrc, ';') INTO v_sql_statement_terminators
   FROM pg_proc p
   WHERE p.oid = 'public.get_commission_history_report(date)'::regprocedure
     AND p.prolang = (SELECT oid FROM pg_language WHERE lanname = 'sql');
  IF v_sql_statement_terminators IS DISTINCT FROM 1
     OR NOT has_function_privilege('authenticated', 'public.get_commission_history_report(date)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.get_commission_history_report(date)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.get_commission_history_report(date)', 'EXECUTE') THEN
    RAISE EXCEPTION 'COMMISSION_REPORT_SNAPSHOT_CATALOG_FAIL: language or ACL';
  END IF;
  RAISE NOTICE 'COMMISSION_REPORT_SNAPSHOT_CATALOG_PASS language=sql stable=true security_invoker=true';
END
$catalog$;
