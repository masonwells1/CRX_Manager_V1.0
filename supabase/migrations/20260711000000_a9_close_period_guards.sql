-- Migration: A9 close period guards
-- Adds server-side protections so accounting periods can only be closed for a
-- complete calendar month that has already ended.

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

  -- A9 guard 1: a period must be exactly one whole calendar month.
  -- date_trunc() silently accepts a mid-month end date, which would insert a SECOND,
  -- overlapping closed row alongside the full-month row (unique key is start+end).
  IF p_period_end IS NULL
     OR p_period_end <> (date_trunc('month', p_period_end) + INTERVAL '1 month - 1 day')::date THEN
    RAISE EXCEPTION 'Period end % must be the last day of a calendar month', p_period_end;
  END IF;

  -- A9 guard 2: a period may only be closed AFTER it has ended (owner rule 2026-07-10).
  -- The business day is America/Chicago; the DB session is UTC, so CURRENT_DATE would
  -- be about five hours ahead of the Crop RX accounting day during Central evening.
  IF p_period_end >= (now() AT TIME ZONE 'America/Chicago')::date THEN
    RAISE EXCEPTION 'Cannot close period ending %: the period has not ended yet', p_period_end;
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'close_accounting_period');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  v_period_start := date_trunc('month', p_period_end)::date;

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
