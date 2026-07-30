-- APPLIED LIVE 2026-07-30 as Supabase ledger version 20260730140808
-- (submitted as 20260730140000_accounting_period_immutable_date_math).
-- Make accounting-period calendar-month math explicitly time-zone independent.
--
-- PostgreSQL resolves date_trunc(text, date) through the timestamptz overload.
-- The existing expressions are safe for current rows, but the constraint and
-- close RPC should not depend on the session TimeZone. This forward migration
-- selects the IMMUTABLE timestamp-without-time-zone overload explicitly.
--
-- SET LOCAL affects only this migration transaction. Runtime advisory-lock
-- waits remain bounded by the calling request's statement timeout.

SET LOCAL lock_timeout = '10s';

DO $accounting_period_immutable_date_math_preflight$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.accounting_periods
     WHERE period_start <>
             pg_catalog.date_trunc(
               'month',
               period_start::timestamp without time zone
             )::date
        OR period_end <>
             (
               pg_catalog.date_trunc(
                 'month',
                 period_start::timestamp without time zone
               ) + INTERVAL '1 month - 1 day'
             )::date
  ) THEN
    RAISE EXCEPTION 'ACCOUNTING_PERIOD_IMMUTABLE_DATE_MATH_PREFLIGHT: non-whole-month row exists';
  END IF;
END;
$accounting_period_immutable_date_math_preflight$;

ALTER TABLE public.accounting_periods
  DROP CONSTRAINT accounting_periods_whole_calendar_month_check;

ALTER TABLE public.accounting_periods
  ADD CONSTRAINT accounting_periods_whole_calendar_month_check
  CHECK (
    period_start =
      pg_catalog.date_trunc(
        'month',
        period_start::timestamp without time zone
      )::date
    AND period_end =
      (
        pg_catalog.date_trunc(
          'month',
          period_start::timestamp without time zone
        ) + INTERVAL '1 month - 1 day'
      )::date
  );

CREATE OR REPLACE FUNCTION public.close_accounting_period(
  p_period_end date,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid;
  v_period_start date;
  v_unposted_count integer;
  v_period_id uuid;
  v_summary jsonb;
  v_existing jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.profiles
     WHERE id = v_actor
       AND role = 'admin'
       AND is_active = true
  ) THEN
    RAISE EXCEPTION 'Only admin users can close accounting periods';
  END IF;

  IF p_period_end IS NULL
     OR p_period_end <>
          (
            pg_catalog.date_trunc(
              'month',
              p_period_end::timestamp without time zone
            ) + INTERVAL '1 month - 1 day'
          )::date THEN
    RAISE EXCEPTION 'Period end % must be the last day of a calendar month', p_period_end;
  END IF;
  IF p_period_end >= (now() AT TIME ZONE 'America/Chicago')::date THEN
    RAISE EXCEPTION 'Cannot close period ending %: the period has not ended yet', p_period_end;
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'close_accounting_period');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  v_period_start :=
    pg_catalog.date_trunc(
      'month',
      p_period_end::timestamp without time zone
    )::date;
  PERFORM public._lock_accounting_months(ARRAY[v_period_start], true);

  -- Redundant defense in depth: the canonical helper already serializes this
  -- key at the first lookup, but retain a post-month-lock replay check.
  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'close_accounting_period');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  SELECT count(*)
    INTO v_unposted_count
    FROM public.invoices
   WHERE invoice_date BETWEEN v_period_start AND p_period_end
     AND status IN ('draft', 'unposted')
     AND deleted_at IS NULL;
  IF v_unposted_count > 0 THEN
    RAISE EXCEPTION 'Cannot close period: % unposted invoice(s) exist between % and %',
      v_unposted_count, v_period_start, p_period_end;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.accounting_periods
     WHERE period_start = v_period_start
       AND period_end = p_period_end
       AND status = 'closed'
  ) THEN
    RAISE EXCEPTION 'Period % to % is already closed', v_period_start, p_period_end;
  END IF;

  INSERT INTO public.accounting_periods (
    period_start,
    period_end,
    status,
    closed_by,
    closed_at
  )
  VALUES (v_period_start, p_period_end, 'closed', v_actor, now())
  ON CONFLICT (period_start, period_end)
  DO UPDATE SET
    status = 'closed',
    closed_by = v_actor,
    closed_at = now(),
    updated_at = now()
  RETURNING id INTO v_period_id;

  SELECT jsonb_build_object(
    'period_id', v_period_id,
    'period_start', v_period_start,
    'period_end', p_period_end,
    'invoices_posted', (
      SELECT count(*)
        FROM public.invoices
       WHERE invoice_date BETWEEN v_period_start AND p_period_end
         AND status = 'posted'
         AND deleted_at IS NULL
    ),
    'total_invoiced_cents', COALESCE((
      SELECT sum(total_amount_cents)
        FROM public.invoices
       WHERE invoice_date BETWEEN v_period_start AND p_period_end
         AND status = 'posted'
         AND deleted_at IS NULL
    ), 0),
    'payments_received_cents', COALESCE((
      SELECT (sum(amount) * 100)::bigint
        FROM public.payments
       WHERE payment_date BETWEEN v_period_start AND p_period_end
    ), 0),
    'orders_count', (
      SELECT count(*)
        FROM public.orders
       WHERE order_date BETWEEN v_period_start AND p_period_end
         AND deleted_at IS NULL
    ),
    'deliveries_count', (
      SELECT count(*)
        FROM public.deliveries
       WHERE scheduled_date BETWEEN v_period_start AND p_period_end
         AND deleted_at IS NULL
    )
  )
  INTO v_summary;

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(
      p_idempotency_key,
      'close_accounting_period',
      v_summary
    );
  END IF;
  RETURN v_summary;
END;
$function$;

REVOKE ALL ON FUNCTION public.close_accounting_period(date, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.close_accounting_period(date, uuid, text)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.check_period_open(date) IS
  'SECURITY DEFINER with deliberately empty search_path; all relation references must remain explicitly schema-qualified.';
COMMENT ON FUNCTION public.close_accounting_period(date, uuid, text) IS
  'Closes one whole accounting month; advisory-lock waits use the calling request statement timeout.';

SET LOCAL search_path = pg_catalog, public, pg_temp;

DO $accounting_period_immutable_date_math_postflight$
DECLARE
  v_constraint_definition text;
  v_function_count integer;
  v_owner name;
  v_security_definer boolean;
  v_config text[];
  v_return_type regtype;
  v_body text;
BEGIN
  SELECT pg_catalog.pg_get_constraintdef(c.oid, true)
    INTO v_constraint_definition
    FROM pg_catalog.pg_constraint AS c
   WHERE c.conrelid = 'public.accounting_periods'::regclass
     AND c.conname = 'accounting_periods_whole_calendar_month_check'
     AND c.contype = 'c'
     AND c.convalidated;

  IF v_constraint_definition IS NULL
     OR pg_catalog.regexp_count(
          v_constraint_definition,
          'timestamp without time zone'
        ) <> 2 THEN
    RAISE EXCEPTION 'ACCOUNTING_PERIOD_IMMUTABLE_DATE_MATH_CONSTRAINT_DRIFT';
  END IF;

  SELECT count(*)
    INTO v_function_count
    FROM pg_catalog.pg_proc AS p
    JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'close_accounting_period';

  IF v_function_count <> 1 THEN
    RAISE EXCEPTION 'ACCOUNTING_PERIOD_IMMUTABLE_DATE_MATH_FUNCTION_COUNT: expected one close_accounting_period, found %',
      v_function_count;
  END IF;

  SELECT r.rolname,
         p.prosecdef,
         p.proconfig,
         p.prorettype::regtype,
         p.prosrc
    INTO v_owner,
         v_security_definer,
         v_config,
         v_return_type,
         v_body
    FROM pg_catalog.pg_proc AS p
    JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
    JOIN pg_catalog.pg_roles AS r ON r.oid = p.proowner
   WHERE n.nspname = 'public'
     AND p.proname = 'close_accounting_period';

  IF v_owner <> 'postgres'
     OR NOT v_security_definer
     OR v_return_type <> 'jsonb'::regtype
     OR v_config IS NULL
     OR NOT (v_config @> ARRAY['search_path=public, pg_temp']::text[])
     OR pg_catalog.regexp_count(
          v_body,
          'p_period_end::timestamp without time zone'
        ) <> 2 THEN
    RAISE EXCEPTION 'ACCOUNTING_PERIOD_IMMUTABLE_DATE_MATH_FUNCTION_DRIFT';
  END IF;

  IF EXISTS (
       SELECT 1
         FROM pg_catalog.pg_proc AS p
         JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
         CROSS JOIN LATERAL
           aclexplode(
             COALESCE(p.proacl, acldefault('f', p.proowner))
           ) AS acl
        WHERE n.nspname = 'public'
          AND p.proname = 'close_accounting_period'
          AND acl.grantee = 0
          AND acl.privilege_type = 'EXECUTE'
     )
     OR has_function_privilege(
          'anon',
          'public.close_accounting_period(date,uuid,text)',
          'EXECUTE'
        )
     OR NOT has_function_privilege(
          'authenticated',
          'public.close_accounting_period(date,uuid,text)',
          'EXECUTE'
        )
     OR NOT has_function_privilege(
          'service_role',
          'public.close_accounting_period(date,uuid,text)',
          'EXECUTE'
        ) THEN
    RAISE EXCEPTION 'ACCOUNTING_PERIOD_IMMUTABLE_DATE_MATH_ACL_DRIFT';
  END IF;
END;
$accounting_period_immutable_date_math_postflight$;
