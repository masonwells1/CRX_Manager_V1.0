-- NOT APPLIED — DO NOT APPLY without Mason's explicit in-chat approval.
-- Report each recipient group under the latest ledgered name at the requested
-- Chicago business-date cutoff, never the alphabetically smallest old name.
--
-- WHY: get_commission_balance_report historically used MIN(recipient_name) in
-- its earned and settlement aggregates. A salesperson with commissions before
-- and after a name change therefore appeared under whichever name sorted first.
-- The same defect affected a paid-only group because its label came solely from
-- the settlement aggregate.
--
-- Historical rule: the latest earned-state observation at the cutoff is the
-- canonical label for a recipient group. Settlement history is used only as a
-- fail-safe label source if a group somehow has settlement events without a
-- corresponding earned-state observation. Amount and count math is unchanged.
--
-- This is a forward-only function replacement. It changes no business rows,
-- table shape, RLS policy, or TypeScript return type. Rollback requires a new
-- migration re-emitting the prior reviewed function body.

DO $commission_recipient_label_preflight$
DECLARE
  v_named_count integer;
  v_contract_count integer;
BEGIN
  SELECT count(*)
    INTO v_named_count
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'get_commission_balance_report';

  SELECT count(*)
    INTO v_contract_count
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_language l ON l.oid = p.prolang
    JOIN pg_roles owner_role ON owner_role.oid = p.proowner
   WHERE n.nspname = 'public'
     AND p.proname = 'get_commission_balance_report'
     AND p.prokind = 'f'
     AND p.pronargs = 1
     AND p.pronargdefaults = 0
     AND p.proargdefaults IS NULL
     AND oidvectortypes(p.proargtypes) = 'date'
     AND p.proallargtypes IS NOT DISTINCT FROM ARRAY[
       'date'::regtype::oid,
       'uuid'::regtype::oid,
       'text'::regtype::oid,
       'numeric'::regtype::oid,
       'numeric'::regtype::oid,
       'numeric'::regtype::oid,
       'bigint'::regtype::oid,
       'bigint'::regtype::oid
     ]::oid[]
     AND p.proargmodes IS NOT DISTINCT FROM
       ARRAY['i', 't', 't', 't', 't', 't', 't', 't']::"char"[]
     AND p.proargnames IS NOT DISTINCT FROM ARRAY[
       'p_as_of_date', 'recipient_id', 'recipient_name', 'total_earned',
       'total_paid', 'outstanding_balance', 'pending_count', 'paid_count'
     ]::text[]
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
     AND p.proconfig IS NOT DISTINCT FROM
       ARRAY['search_path=public, pg_temp']::text[]
     AND owner_role.rolname = 'postgres'
     AND md5(p.prosrc) IN (
       '3edbcba030a9d5d0a106eeb9bf5a6635',
       'a302d0f87ca84794ceb9c815a073f77f'
     )
     AND p.prosrc LIKE '%PERFORM public.require_admin()%'
     AND p.proacl::text IS NOT DISTINCT FROM
       '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'
     AND obj_description(p.oid, 'pg_proc') IN (
       'Admin-only exact commission earned, paid, and outstanding balances from the immutable cutover''s first complete Chicago day through Chicago-today; earlier dates fail closed because pre-cutover earned-state history is unavailable.',
       'Admin-only exact commission earned, paid, and outstanding balances with the latest ledgered recipient label at the requested supported Chicago business-date cutoff.'
     );

  IF v_named_count <> 1 OR v_contract_count <> 1 THEN
    RAISE EXCEPTION
      'COMMISSION_RECIPIENT_LABEL_PREIMAGE_DRIFT: expected one exact reviewed balance-report contract';
  END IF;
END
$commission_recipient_label_preflight$;

CREATE OR REPLACE FUNCTION public.get_commission_balance_report(p_as_of_date date)
RETURNS TABLE(
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
  v_history_start_date date;
BEGIN
  PERFORM public.require_admin();
  SELECT first_supported_date INTO v_history_start_date
  FROM public.commission_history_cutover WHERE singleton;
  IF v_history_start_date IS NULL THEN
    RAISE EXCEPTION 'COMMISSION_HISTORY_CUTOVER_UNAVAILABLE';
  END IF;

  IF p_as_of_date IS NULL THEN
    RAISE EXCEPTION 'COMMISSION_HISTORY_DATE_REQUIRED: p_as_of_date is required';
  END IF;
  IF p_as_of_date < v_history_start_date THEN
    RAISE EXCEPTION
      'COMMISSION_HISTORY_BEFORE_LEDGER_START: exact history is available on or after %',
      v_history_start_date;
  END IF;
  IF p_as_of_date > v_today THEN
    RAISE EXCEPTION
      'COMMISSION_HISTORY_FUTURE_DATE_UNAVAILABLE: as-of date must be on or before %',
      v_today;
  END IF;

  RETURN QUERY
  WITH cutoff AS (
    SELECT ((p_as_of_date + 1)::timestamp AT TIME ZONE 'America/Chicago') AS at
  ), latest_state AS (
    SELECT DISTINCT ON (s.commission_id) s.*
    FROM public.commission_earned_state_ledger s
    CROSS JOIN cutoff c
    WHERE s.effective_at < c.at
    ORDER BY s.commission_id, s.effective_at DESC, s.id DESC
  ), latest_earned_label AS (
    SELECT DISTINCT ON (s.recipient_group_key)
      s.recipient_group_key,
      s.recipient_id,
      s.recipient_name
    FROM public.commission_earned_state_ledger s
    CROSS JOIN cutoff c
    WHERE s.effective_at < c.at
    ORDER BY s.recipient_group_key, s.effective_at DESC, s.id DESC
  ), latest_settlement_label AS (
    SELECT DISTINCT ON (se.recipient_group_key)
      se.recipient_group_key,
      se.recipient_id,
      se.recipient_name
    FROM public.commission_settlement_events se
    CROSS JOIN cutoff c
    WHERE se.effective_at < c.at
      AND se.payment_date <= p_as_of_date
    ORDER BY se.recipient_group_key, se.effective_at DESC, se.id DESC
  ), recipient_label AS (
    SELECT
      COALESCE(e.recipient_group_key, p.recipient_group_key) AS recipient_group_key,
      COALESCE(e.recipient_id, p.recipient_id) AS recipient_id,
      COALESCE(e.recipient_name, p.recipient_name) AS recipient_name
    FROM latest_earned_label e
    FULL OUTER JOIN latest_settlement_label p
      ON p.recipient_group_key = e.recipient_group_key
  ), settlement_by_commission_recipient AS (
    SELECT
      se.commission_id,
      se.recipient_group_key,
      SUM(se.amount_cents) AS paid_cents,
      SUM(CASE WHEN se.event_kind = 'posted' THEN 1 ELSE -1 END) AS active_settlement_count
    FROM public.commission_settlement_events se
    CROSS JOIN cutoff c
    WHERE se.effective_at < c.at
      AND se.payment_date <= p_as_of_date
    GROUP BY se.commission_id, se.recipient_group_key
  ), earned_by_recipient AS (
    SELECT
      s.recipient_group_key,
      SUM(s.amount_cents) AS earned_cents,
      COUNT(*) FILTER (
        WHERE COALESCE(p.active_settlement_count, 0) <= 0
           OR COALESCE(p.paid_cents, 0) < s.amount_cents
      ) AS pending_count,
      COUNT(*) FILTER (
        WHERE p.active_settlement_count > 0
          AND p.paid_cents >= s.amount_cents
      ) AS paid_count
    FROM latest_state s
    LEFT JOIN settlement_by_commission_recipient p
      ON p.commission_id = s.commission_id
     AND p.recipient_group_key = s.recipient_group_key
    WHERE s.is_earned
      AND s.order_date <= p_as_of_date
    GROUP BY s.recipient_group_key
  ), paid_by_recipient AS (
    SELECT
      p.recipient_group_key,
      SUM(p.paid_cents) AS paid_cents,
      SUM(p.active_settlement_count) AS active_settlement_count,
      COUNT(*) FILTER (
        WHERE p.active_settlement_count > 0
          AND NOT EXISTS (
            SELECT 1 FROM latest_state s
            WHERE s.commission_id = p.commission_id
              AND s.recipient_group_key = p.recipient_group_key
              AND s.is_earned
              AND s.order_date <= p_as_of_date
          )
      ) AS paid_only_count
    FROM settlement_by_commission_recipient p
    GROUP BY p.recipient_group_key
  )
  SELECT
    l.recipient_id,
    l.recipient_name,
    COALESCE(e.earned_cents, 0)::numeric / 100::numeric,
    COALESCE(p.paid_cents, 0)::numeric / 100::numeric,
    (COALESCE(e.earned_cents, 0) - COALESCE(p.paid_cents, 0))::numeric / 100::numeric,
    COALESCE(e.pending_count, 0),
    COALESCE(e.paid_count, 0) + COALESCE(p.paid_only_count, 0)
  FROM earned_by_recipient e
  FULL OUTER JOIN paid_by_recipient p
    ON p.recipient_group_key = e.recipient_group_key
  JOIN recipient_label l
    ON l.recipient_group_key = COALESCE(e.recipient_group_key, p.recipient_group_key)
  WHERE e.recipient_group_key IS NOT NULL OR p.active_settlement_count > 0
  ORDER BY (COALESCE(e.earned_cents, 0) - COALESCE(p.paid_cents, 0)) DESC,
           l.recipient_name;
END;
$function$;

ALTER FUNCTION public.get_commission_balance_report(date) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_commission_balance_report(date)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_commission_balance_report(date)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.get_commission_balance_report(date) IS
  'Admin-only exact commission earned, paid, and outstanding balances with the latest ledgered recipient label at the requested supported Chicago business-date cutoff.';

DO $commission_recipient_label_postflight$
DECLARE
  v_named_count integer;
  v_contract_count integer;
BEGIN
  SELECT count(*)
    INTO v_named_count
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'get_commission_balance_report';

  SELECT count(*)
    INTO v_contract_count
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_language l ON l.oid = p.prolang
    JOIN pg_roles owner_role ON owner_role.oid = p.proowner
   WHERE n.nspname = 'public'
     AND p.proname = 'get_commission_balance_report'
     AND p.prokind = 'f'
     AND p.pronargs = 1
     AND p.pronargdefaults = 0
     AND p.proargdefaults IS NULL
     AND oidvectortypes(p.proargtypes) = 'date'
     AND p.proallargtypes IS NOT DISTINCT FROM ARRAY[
       'date'::regtype::oid,
       'uuid'::regtype::oid,
       'text'::regtype::oid,
       'numeric'::regtype::oid,
       'numeric'::regtype::oid,
       'numeric'::regtype::oid,
       'bigint'::regtype::oid,
       'bigint'::regtype::oid
     ]::oid[]
     AND p.proargmodes IS NOT DISTINCT FROM
       ARRAY['i', 't', 't', 't', 't', 't', 't', 't']::"char"[]
     AND p.proargnames IS NOT DISTINCT FROM ARRAY[
       'p_as_of_date', 'recipient_id', 'recipient_name', 'total_earned',
       'total_paid', 'outstanding_balance', 'pending_count', 'paid_count'
     ]::text[]
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
     AND p.proconfig IS NOT DISTINCT FROM
       ARRAY['search_path=public, pg_temp']::text[]
     AND owner_role.rolname = 'postgres'
     AND md5(p.prosrc) = 'a302d0f87ca84794ceb9c815a073f77f'
     AND p.prosrc LIKE '%PERFORM public.require_admin()%'
     AND p.prosrc LIKE '%latest_earned_label%'
     AND p.prosrc LIKE '%latest_settlement_label%'
     AND p.prosrc LIKE '%recipient_label%'
     AND p.prosrc NOT LIKE '%MIN(%recipient_name%'
     AND p.proacl::text IS NOT DISTINCT FROM
       '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'
     AND obj_description(p.oid, 'pg_proc') IS NOT DISTINCT FROM
       'Admin-only exact commission earned, paid, and outstanding balances with the latest ledgered recipient label at the requested supported Chicago business-date cutoff.';

  IF v_named_count <> 1 OR v_contract_count <> 1 THEN
    RAISE EXCEPTION
      'COMMISSION_RECIPIENT_LABEL_POSTFLIGHT_DRIFT: balance-report contract was not installed exactly';
  END IF;
END
$commission_recipient_label_postflight$;
