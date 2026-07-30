-- Close-accounting-period same-key replay after month serialization.
-- APPLIED LIVE 2026-07-30 as Supabase ledger version 20260730124308
-- (submitted as 20260730121951_close_accounting_period_idempotency_recheck).
--
-- Re-emits the live 20260730114102 function byte-for-byte except for the
-- second idempotency lookup immediately after its exclusive month lock. A
-- concurrent same-key close that passed the first lookup before the first
-- caller committed must replay after waiting, not fail "already closed".

CREATE OR REPLACE FUNCTION public.close_accounting_period(p_period_end date, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_actor uuid; v_period_start date; v_unposted_count integer; v_period_id uuid; v_summary jsonb; v_existing jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'Actor mismatch';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.profiles
    WHERE id = v_actor AND role = 'admin' AND is_active = true) THEN
    RAISE EXCEPTION 'Only admin users can close accounting periods';
  END IF;

  IF p_period_end IS NULL
     OR p_period_end <> (date_trunc('month', p_period_end) + INTERVAL '1 month - 1 day')::date THEN
    RAISE EXCEPTION 'Period end % must be the last day of a calendar month', p_period_end;
  END IF;
  IF p_period_end >= (now() AT TIME ZONE 'America/Chicago')::date THEN
    RAISE EXCEPTION 'Cannot close period ending %: the period has not ended yet', p_period_end;
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'close_accounting_period');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  v_period_start := date_trunc('month', p_period_end)::date;
  PERFORM public._lock_accounting_months(ARRAY[v_period_start], true);

  -- The first caller may have saved this same key while this caller waited for
  -- the exclusive month lock. Recheck before the already-closed refusal.
  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'close_accounting_period');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  SELECT count(*) INTO v_unposted_count FROM public.invoices
  WHERE invoice_date BETWEEN v_period_start AND p_period_end
    AND status IN ('draft', 'unposted') AND deleted_at IS NULL;
  IF v_unposted_count > 0 THEN
    RAISE EXCEPTION 'Cannot close period: % unposted invoice(s) exist between % and %',
      v_unposted_count, v_period_start, p_period_end;
  END IF;

  IF EXISTS (SELECT 1 FROM public.accounting_periods
    WHERE period_start = v_period_start AND period_end = p_period_end AND status = 'closed') THEN
    RAISE EXCEPTION 'Period % to % is already closed', v_period_start, p_period_end;
  END IF;

  INSERT INTO public.accounting_periods (period_start, period_end, status, closed_by, closed_at)
  VALUES (v_period_start, p_period_end, 'closed', v_actor, now())
  ON CONFLICT (period_start, period_end)
  DO UPDATE SET status = 'closed', closed_by = v_actor, closed_at = now(), updated_at = now()
  RETURNING id INTO v_period_id;

  SELECT jsonb_build_object('period_id', v_period_id,
    'period_start', v_period_start, 'period_end', p_period_end,
    'invoices_posted', (SELECT count(*) FROM public.invoices
      WHERE invoice_date BETWEEN v_period_start AND p_period_end
        AND status = 'posted' AND deleted_at IS NULL),
    'total_invoiced_cents', COALESCE((SELECT sum(total_amount_cents) FROM public.invoices
      WHERE invoice_date BETWEEN v_period_start AND p_period_end
        AND status = 'posted' AND deleted_at IS NULL), 0),
    'payments_received_cents', COALESCE((SELECT (sum(amount) * 100)::bigint FROM public.payments
      WHERE payment_date BETWEEN v_period_start AND p_period_end), 0),
    'orders_count', (SELECT count(*) FROM public.orders
      WHERE order_date BETWEEN v_period_start AND p_period_end AND deleted_at IS NULL),
    'deliveries_count', (SELECT count(*) FROM public.deliveries
      WHERE scheduled_date BETWEEN v_period_start AND p_period_end AND deleted_at IS NULL))
  INTO v_summary;

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'close_accounting_period', v_summary);
  END IF;
  RETURN v_summary;
END;
$function$;

-- Reassert the established public RPC ACL rather than inheriting defaults.
REVOKE ALL ON FUNCTION public.close_accounting_period(date, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.close_accounting_period(date, uuid, text)
  TO authenticated, service_role;

SET LOCAL search_path = pg_catalog, public, pg_temp;

DO $period_close_idempotency_recheck_postflight$
DECLARE
  v_function_count integer;
  v_owner name;
  v_security_definer boolean;
  v_config text[];
  v_return_type regtype;
  v_helper_oid oid;
  v_owner_oid oid;
BEGIN
  SELECT count(*) INTO v_function_count
    FROM pg_catalog.pg_proc AS p
    JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'close_accounting_period';

  IF v_function_count <> 1 THEN
    RAISE EXCEPTION 'PERIOD_CLOSE_IDEMPOTENCY_RECHECK_FUNCTION_COUNT: expected one close_accounting_period, found %', v_function_count;
  END IF;

  SELECT r.rolname, p.prosecdef, p.proconfig, p.prorettype::regtype, p.proowner
    INTO v_owner, v_security_definer, v_config, v_return_type, v_owner_oid
    FROM pg_catalog.pg_proc AS p
    JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
    JOIN pg_catalog.pg_roles AS r ON r.oid = p.proowner
   WHERE n.nspname = 'public'
     AND p.proname = 'close_accounting_period';

  IF v_owner <> 'postgres' OR NOT v_security_definer
     OR v_return_type <> 'jsonb'::regtype
     OR v_config IS NULL OR NOT (v_config @> ARRAY['search_path=public, pg_temp']::text[]) THEN
    RAISE EXCEPTION 'PERIOD_CLOSE_IDEMPOTENCY_RECHECK_SIGNATURE_OR_OWNER_DRIFT';
  END IF;

  v_helper_oid := to_regprocedure('public._lock_accounting_months(date[],boolean)');
  IF v_helper_oid IS NULL OR NOT has_function_privilege(v_owner_oid, v_helper_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'PERIOD_CLOSE_IDEMPOTENCY_RECHECK_HELPER_DRIFT';
  END IF;

  IF EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS p
       JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
       CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) AS acl
       WHERE n.nspname = 'public'
         AND p.proname = 'close_accounting_period'
         AND acl.grantee = 0
         AND acl.privilege_type = 'EXECUTE'
     )
     OR has_function_privilege('anon', 'public.close_accounting_period(date,uuid,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.close_accounting_period(date,uuid,text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.close_accounting_period(date,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'PERIOD_CLOSE_IDEMPOTENCY_RECHECK_ACL_DRIFT';
  END IF;
END;
$period_close_idempotency_recheck_postflight$;
