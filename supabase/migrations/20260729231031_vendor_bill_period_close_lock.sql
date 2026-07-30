-- Accounting-period close/write serialization.
-- PARKED / DO NOT APPLY without Mason's explicit current-conversation approval
-- and the normal fresh exact-SHA migration review and live preflight.
--
-- Lock order: existing PO parent advisory lock 73492009 (when a PO path has
-- one) precedes this dedicated two-int month namespace 73492010.  Month keys
-- are deduplicated and acquired ascending before period checks.  This avoids a
-- close/write TOCTOU and reverse-direction vendor-bill update deadlocks.

SET LOCAL lock_timeout = '10s';

ALTER TABLE public.accounting_periods
  ADD CONSTRAINT accounting_periods_whole_calendar_month_check
  CHECK (
    period_start = date_trunc('month', period_start)::date
    AND period_end =
      (date_trunc('month', period_start) + INTERVAL '1 month - 1 day')::date
  );

CREATE OR REPLACE FUNCTION public._lock_accounting_months(
  p_dates date[],
  p_exclusive boolean DEFAULT false
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_month_key integer;
BEGIN
  FOR v_month_key IN
    SELECT DISTINCT
      (EXTRACT(YEAR FROM d)::integer * 12) + EXTRACT(MONTH FROM d)::integer - 1
    FROM unnest(p_dates) AS dates(d)
    WHERE d IS NOT NULL
    ORDER BY 1
  LOOP
    IF p_exclusive THEN
      PERFORM pg_advisory_xact_lock(73492010, v_month_key);
    ELSE
      PERFORM pg_advisory_xact_lock_shared(73492010, v_month_key);
    END IF;
  END LOOP;
END;
$function$;

CREATE OR REPLACE FUNCTION public.create_vendor_bill(
  p_vendor_id uuid, p_purchase_order_id uuid DEFAULT NULL, p_bill_number text DEFAULT '',
  p_bill_date date DEFAULT CURRENT_DATE, p_due_date date DEFAULT NULL,
  p_payment_terms text DEFAULT NULL, p_subtotal_cents bigint DEFAULT 0,
  p_adjustment_cents bigint DEFAULT 0, p_notes text DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $function$
DECLARE
  v_total bigint; v_bill_id uuid; v_terms_days integer; v_terms text;
  v_actor uuid; v_actor_role text; v_existing jsonb; v_vendor_name text;
  v_po_vendor text; v_po_status text; v_po_total_cents bigint;
  v_amount_drift_pct numeric;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  SELECT role INTO v_actor_role FROM public.profiles
  WHERE id = v_actor AND is_active = true;
  IF v_actor_role IS NULL OR v_actor_role <> 'admin' THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED: admin role required to create vendor bills';
  END IF;
  IF p_idempotency_key IS NOT NULL THEN
    v_existing := public.check_idempotency(p_idempotency_key, 'create_vendor_bill');
    IF v_existing IS NOT NULL THEN RETURN (v_existing->>'bill_id')::uuid; END IF;
  END IF;

  SELECT name INTO v_vendor_name FROM public.vendors
  WHERE id = p_vendor_id AND deleted_at IS NULL FOR UPDATE;
  IF v_vendor_name IS NULL THEN
    RAISE EXCEPTION 'VENDOR_NOT_FOUND: vendor % does not exist or is soft-deleted', p_vendor_id;
  END IF;
  IF p_subtotal_cents IS NULL OR p_subtotal_cents <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT: subtotal must be positive';
  END IF;
  v_total := p_subtotal_cents + COALESCE(p_adjustment_cents, 0);
  IF v_total <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT: bill total must be positive (got %)', v_total;
  END IF;

  IF p_purchase_order_id IS NOT NULL THEN
    SELECT vendor, status, total_cost_cents INTO v_po_vendor, v_po_status, v_po_total_cents
    FROM public.purchase_orders WHERE id = p_purchase_order_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'PO_NOT_FOUND: purchase order % does not exist', p_purchase_order_id; END IF;
    IF v_po_status NOT IN ('submitted', 'partially_received', 'fully_received') THEN
      RAISE EXCEPTION 'PO_NOT_BILLABLE: purchase order % has status %', p_purchase_order_id, v_po_status;
    END IF;
    IF lower(trim(v_po_vendor)) <> lower(trim(v_vendor_name)) THEN
      RAISE EXCEPTION 'VENDOR_PO_MISMATCH: bill vendor "%" does not match PO vendor "%"', v_vendor_name, v_po_vendor;
    END IF;
  END IF;

  -- Take this after required business row locks (vendor then optional PO), but
  -- before the authoritative period check, notification/audit/idempotency side
  -- effects, and the bill INSERT. check_period_open stays a narrow reader for
  -- its many existing callers; this governed writer owns its shared lock.
  PERFORM public._lock_accounting_months(ARRAY[p_bill_date], false);
  PERFORM public.check_period_open(p_bill_date);

  IF p_purchase_order_id IS NOT NULL AND v_po_total_cents > 0 THEN
    v_amount_drift_pct := ABS(v_total - v_po_total_cents)::numeric / v_po_total_cents::numeric;
    IF v_amount_drift_pct > 0.05 THEN
      INSERT INTO public.notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
      SELECT p.id, 'Vendor bill amount differs from PO',
        'Bill ' || COALESCE(NULLIF(p_bill_number, ''), 'pending') || ' for ' || v_vendor_name ||
        ' is $' || (v_total / 100.0)::numeric(12,2) || ' but PO total is $' ||
        (v_po_total_cents / 100.0)::numeric(12,2) || ' (' || ROUND(v_amount_drift_pct * 100, 1) || '% drift). Verify the bill matches the PO.',
        'vendor_bill_drift', 'purchase_order', p_purchase_order_id
      FROM public.profiles p WHERE p.role = 'admin' AND p.is_active = true;
    END IF;
  END IF;

  IF p_payment_terms IS NULL THEN
    SELECT default_payment_terms, default_payment_terms_days INTO v_terms, v_terms_days
    FROM public.vendors WHERE id = p_vendor_id;
  ELSE
    v_terms := p_payment_terms;
    v_terms_days := CASE WHEN p_payment_terms ILIKE '%90%' THEN 90 WHEN p_payment_terms ILIKE '%60%' THEN 60
      WHEN p_payment_terms ILIKE '%45%' THEN 45 WHEN p_payment_terms ILIKE '%30%' THEN 30
      WHEN p_payment_terms ILIKE '%15%' THEN 15 WHEN p_payment_terms ILIKE '%10%' THEN 10 ELSE 30 END;
  END IF;

  INSERT INTO public.vendor_bills (vendor_id, purchase_order_id, bill_number, bill_date, due_date, payment_terms, subtotal_cents, adjustment_cents, total_cents, paid_cents, status, notes, created_by)
  VALUES (p_vendor_id, p_purchase_order_id, p_bill_number, p_bill_date,
    COALESCE(p_due_date, p_bill_date + (COALESCE(v_terms_days, 30) || ' days')::interval),
    v_terms, p_subtotal_cents, COALESCE(p_adjustment_cents, 0), v_total, 0, 'unpaid', p_notes, v_actor)
  RETURNING id INTO v_bill_id;
  INSERT INTO public.financial_audit_log (operation_type, entity_type, entity_id, actor_user_id, actor_role, new_values, total_impact_cents, description)
  VALUES ('vendor_bill_created', 'vendor_bill', v_bill_id, v_actor, v_actor_role,
    jsonb_build_object('vendor_id', p_vendor_id, 'purchase_order_id', p_purchase_order_id,
      'bill_number', p_bill_number, 'bill_date', p_bill_date, 'total_cents', v_total,
      'po_total_cents', v_po_total_cents, 'drift_pct', v_amount_drift_pct), v_total,
    'Vendor bill ' || COALESCE(NULLIF(p_bill_number, ''), v_bill_id::text) ||
      ' created for $' || (v_total / 100.0)::numeric(12,2));
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM public.save_idempotency(p_idempotency_key, 'create_vendor_bill', jsonb_build_object('bill_id', v_bill_id));
  END IF;
  RETURN v_bill_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.update_vendor_bill(
  p_bill_id uuid, p_subtotal_cents bigint, p_adjustment_cents bigint,
  p_bill_date date, p_due_date date, p_notes text, p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid; v_actor_role text; v_bill record; v_active_payment_count integer;
  v_new_total_cents bigint; v_old_values jsonb; v_new_values jsonb; v_result jsonb; v_existing jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  SELECT role INTO v_actor_role FROM public.profiles WHERE id = v_actor AND is_active = true;
  IF v_actor_role IS NULL OR v_actor_role <> 'admin' THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED: only admins can edit vendor bills';
  END IF;
  IF p_idempotency_key IS NOT NULL THEN
    v_existing := public.check_idempotency(p_idempotency_key, 'update_vendor_bill');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;
  IF p_subtotal_cents IS NULL OR p_subtotal_cents <= 0 THEN RAISE EXCEPTION 'INVALID_AMOUNT: subtotal must be positive'; END IF;
  IF p_due_date < p_bill_date THEN RAISE EXCEPTION 'INVALID_DATE_RANGE: due_date cannot precede bill_date'; END IF;
  SELECT * INTO v_bill FROM public.vendor_bills WHERE id = p_bill_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'BILL_NOT_FOUND'; END IF;

  -- Lock both months once, in canonical order, before either period check.
  PERFORM public._lock_accounting_months(ARRAY[v_bill.bill_date, p_bill_date], false);
  PERFORM public.check_period_open(v_bill.bill_date);
  PERFORM public.check_period_open(p_bill_date);
  IF v_bill.status <> 'unpaid' THEN RAISE EXCEPTION 'BILL_NOT_EDITABLE: status is % (only unpaid bills can be edited)', v_bill.status; END IF;
  SELECT COUNT(*) INTO v_active_payment_count FROM public.vendor_payments WHERE vendor_bill_id = p_bill_id AND voided_at IS NULL;
  IF v_active_payment_count > 0 THEN RAISE EXCEPTION 'BILL_HAS_ACTIVE_PAYMENTS: void each payment first (% active)', v_active_payment_count; END IF;
  v_new_total_cents := p_subtotal_cents + COALESCE(p_adjustment_cents, 0);
  IF v_new_total_cents <= 0 THEN RAISE EXCEPTION 'INVALID_AMOUNT: bill total must be positive (got %)', v_new_total_cents; END IF;
  v_old_values := jsonb_build_object('subtotal_cents', v_bill.subtotal_cents, 'adjustment_cents', v_bill.adjustment_cents, 'total_cents', v_bill.total_cents, 'bill_date', v_bill.bill_date, 'due_date', v_bill.due_date, 'notes', v_bill.notes);
  UPDATE public.vendor_bills SET subtotal_cents = p_subtotal_cents, adjustment_cents = COALESCE(p_adjustment_cents, 0), total_cents = v_new_total_cents, bill_date = p_bill_date, due_date = p_due_date, notes = p_notes, updated_at = now() WHERE id = p_bill_id;
  v_new_values := jsonb_build_object('subtotal_cents', p_subtotal_cents, 'adjustment_cents', COALESCE(p_adjustment_cents, 0), 'total_cents', v_new_total_cents, 'bill_date', p_bill_date, 'due_date', p_due_date, 'notes', p_notes);
  INSERT INTO public.financial_audit_log (operation_type, entity_type, entity_id, actor_user_id, actor_role, old_values, new_values, total_impact_cents, description)
  VALUES ('vendor_bill_updated', 'vendor_bill', p_bill_id, v_actor, v_actor_role, v_old_values, v_new_values, v_new_total_cents - v_bill.total_cents,
    'Updated vendor bill ' || v_bill.bill_number || ' — total $' || (v_bill.total_cents / 100.0)::numeric(12,2) || ' → $' || (v_new_total_cents / 100.0)::numeric(12,2));
  INSERT INTO public.activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id)
  VALUES ('vendor_bill_updated', 'Updated vendor bill ' || v_bill.bill_number, v_actor, 'vendor_bill', p_bill_id);
  v_result := jsonb_build_object('success', true, 'bill_id', p_bill_id, 'old_total_cents', v_bill.total_cents, 'new_total_cents', v_new_total_cents);
  IF p_idempotency_key IS NOT NULL THEN PERFORM public.save_idempotency(p_idempotency_key, 'update_vendor_bill', v_result); END IF;
  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public._lock_accounting_months(date[], boolean)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.check_period_open(p_date date)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
-- Deliberate config-only hardening: the live function uses public, pg_temp;
-- this candidate pins an empty search path. The unchanged body below refers only
-- to public.accounting_periods and passed the disposable PostgreSQL 17 proof.
SET search_path = ''
AS $function$
DECLARE
  v_period record;
BEGIN
  SELECT id, period_start, period_end
    INTO v_period
    FROM public.accounting_periods
   WHERE status = 'closed'
     AND p_date BETWEEN period_start AND period_end
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'Date % falls in closed accounting period (% to %)',
      p_date, v_period.period_start, v_period.period_end;
  END IF;
END;
$function$;

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

-- Preserve the established public-RPC callable-role model explicitly whenever
-- these SECURITY DEFINER bodies are re-emitted: browser callers authenticate,
-- service jobs retain their route, and neither anon nor PUBLIC can execute.
REVOKE ALL ON FUNCTION public.create_vendor_bill(
  uuid, uuid, text, date, date, text, bigint, bigint, text, text
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_vendor_bill(
  uuid, uuid, text, date, date, text, bigint, bigint, text, text
) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.update_vendor_bill(
  uuid, bigint, bigint, date, date, text, text
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_vendor_bill(
  uuid, bigint, bigint, date, date, text, text
) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.check_period_open(date)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.check_period_open(date)
  TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.close_accounting_period(date, uuid, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.close_accounting_period(date, uuid, text)
  TO authenticated, service_role;

-- Apply-time ownership guard. The helper is SECURITY INVOKER and deliberately
-- non-public, so every SECURITY DEFINER caller's effective owner must retain
-- EXECUTE after the helper revoke. This catches a migration-runner/helper-owner
-- mismatch before the transaction can commit a broken close/write protocol.
SET LOCAL search_path = pg_catalog, public, pg_temp;

DO $period_close_postflight$
DECLARE
  v_helper_oid oid;
  v_function_name text;
  v_function_count integer;
  v_owner_oid oid;
  v_owner_name name;
  v_is_security_definer boolean;
  v_acl_bad_count integer;
BEGIN
  v_helper_oid := to_regprocedure('public._lock_accounting_months(date[],boolean)');
  IF v_helper_oid IS NULL THEN
    RAISE EXCEPTION 'PERIOD_CLOSE_POSTFLIGHT_HELPER_MISSING: public._lock_accounting_months(date[],boolean) is absent';
  END IF;

  FOREACH v_function_name IN ARRAY ARRAY[
    'create_vendor_bill',
    'update_vendor_bill',
    'close_accounting_period'
  ]
  LOOP
    SELECT count(*)
      INTO v_function_count
      FROM pg_catalog.pg_proc AS p
      JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = v_function_name;
    IF v_function_count <> 1 THEN
      RAISE EXCEPTION 'PERIOD_CLOSE_POSTFLIGHT_FUNCTION_COUNT: expected exactly one public.% function, found %',
        v_function_name, v_function_count;
    END IF;

    SELECT p.proowner, p.prosecdef
      INTO v_owner_oid, v_is_security_definer
      FROM pg_catalog.pg_proc AS p
      JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = v_function_name;
    IF NOT v_is_security_definer THEN
      RAISE EXCEPTION 'PERIOD_CLOSE_POSTFLIGHT_SECURITY_MODE: public.% must remain SECURITY DEFINER', v_function_name;
    END IF;

    SELECT r.rolname INTO v_owner_name FROM pg_catalog.pg_roles AS r WHERE r.oid = v_owner_oid;
    IF v_owner_name IS NULL OR NOT has_function_privilege(v_owner_oid, v_helper_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'PERIOD_CLOSE_POSTFLIGHT_HELPER_EXECUTE: owner role % of public.% lacks EXECUTE on public._lock_accounting_months(date[],boolean)',
        COALESCE(v_owner_name::text, v_owner_oid::text), v_function_name;
    END IF;
  END LOOP;

  -- The helper-owner check above applies only to its three callers. The four
  -- re-emitted public RPCs additionally preserve their exact API ACL model.
  SELECT count(*)
    INTO v_function_count
    FROM pg_catalog.pg_proc AS p
    JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = ANY (ARRAY[
       'create_vendor_bill', 'update_vendor_bill', 'check_period_open', 'close_accounting_period'
     ]);
  IF v_function_count <> 4 THEN
    RAISE EXCEPTION 'PERIOD_CLOSE_POSTFLIGHT_PUBLIC_FUNCTION_COUNT: expected exactly four re-emitted public RPCs, found %',
      v_function_count;
  END IF;

  SELECT count(*)
    INTO v_acl_bad_count
    FROM pg_catalog.pg_proc AS p
    JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = ANY (ARRAY[
       'create_vendor_bill', 'update_vendor_bill', 'check_period_open', 'close_accounting_period'
     ])
     AND (
       NOT p.prosecdef
       OR EXISTS (
         SELECT 1
           FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) AS acl
          WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
       )
       OR has_function_privilege('anon', p.oid, 'EXECUTE')
       OR NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
       OR NOT has_function_privilege('service_role', p.oid, 'EXECUTE')
     );
  IF v_acl_bad_count <> 0 THEN
    RAISE EXCEPTION 'PERIOD_CLOSE_POSTFLIGHT_EXECUTE_ACL: % re-emitted public RPC(s) do not deny PUBLIC/anon or retain authenticated/service_role EXECUTE',
      v_acl_bad_count;
  END IF;
END;
$period_close_postflight$;
