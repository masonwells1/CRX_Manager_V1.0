-- ============================================================================
-- Fix close_accounting_period: deliveries.delivery_date does not exist
--
-- Bug: The function references delivery_date in the deliveries_count subquery
-- but the actual column in the deliveries table is scheduled_date.
-- This caused every call to close_accounting_period to throw a PostgreSQL
-- "column delivery_date does not exist" error, returning error JSON instead
-- of the expected summary object.
-- Fix: Replace delivery_date with scheduled_date.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.close_accounting_period(
  p_period_end      date,
  p_performed_by    uuid,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor          uuid;
  v_period_start   date;
  v_unposted_count integer;
  v_period_id      uuid;
  v_summary        jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by <> v_actor THEN
    RAISE EXCEPTION 'Actor mismatch';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = v_actor AND role = 'admin' AND is_active = true
  ) THEN
    RAISE EXCEPTION 'Only admin users can close accounting periods';
  END IF;

  v_period_start := date_trunc('month', p_period_end)::date;

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
    SELECT 1 FROM public.accounting_periods
     WHERE period_start = v_period_start AND period_end = p_period_end AND status = 'closed'
  ) THEN
    RAISE EXCEPTION 'Period % to % is already closed', v_period_start, p_period_end;
  END IF;

  INSERT INTO public.accounting_periods (period_start, period_end, status, closed_by, closed_at)
  VALUES (v_period_start, p_period_end, 'closed', v_actor, now())
  ON CONFLICT (period_start, period_end)
  DO UPDATE SET status = 'closed', closed_by = v_actor, closed_at = now(), updated_at = now()
  RETURNING id INTO v_period_id;

  SELECT jsonb_build_object(
    'period_id',              v_period_id,
    'period_start',           v_period_start,
    'period_end',             p_period_end,
    'invoices_posted', (
      SELECT count(*) FROM public.invoices
      WHERE invoice_date BETWEEN v_period_start AND p_period_end
        AND status = 'posted' AND deleted_at IS NULL
    ),
    'total_invoiced_cents', COALESCE((
      SELECT sum(total_amount_cents) FROM public.invoices
      WHERE invoice_date BETWEEN v_period_start AND p_period_end
        AND status = 'posted' AND deleted_at IS NULL
    ), 0),
    'payments_received_cents', COALESCE((
      -- payments.amount stored as numeric dollars; multiply by 100 for cents
      SELECT (sum(amount) * 100)::bigint FROM public.payments
      WHERE payment_date BETWEEN v_period_start AND p_period_end
    ), 0),
    'orders_count', (
      SELECT count(*) FROM public.orders
      WHERE order_date BETWEEN v_period_start AND p_period_end
        AND deleted_at IS NULL
    ),
    'deliveries_count', (
      -- FIX: deliveries uses scheduled_date, not delivery_date
      SELECT count(*) FROM public.deliveries
      WHERE scheduled_date BETWEEN v_period_start AND p_period_end
        AND deleted_at IS NULL
    )
  ) INTO v_summary;

  RETURN v_summary;
END;
$$;

GRANT EXECUTE ON FUNCTION public.close_accounting_period(date, uuid, text) TO authenticated;
