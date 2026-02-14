-- Sprint 10: Accounting Periods + Month-End Close
-- New table: accounting_periods
-- New RPCs: close_accounting_period, generate_batch_statements, get_monthly_summary, check_period_open

-- ─── accounting_periods table ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.accounting_periods (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  period_start date NOT NULL,
  period_end   date NOT NULL,
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  closed_by    uuid REFERENCES public.profiles(id),
  closed_at    timestamptz,
  notes        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE(period_start, period_end),
  CHECK (period_end >= period_start)
);

ALTER TABLE public.accounting_periods ENABLE ROW LEVEL SECURITY;

CREATE POLICY "accounting_periods_select_admin"
  ON public.accounting_periods FOR SELECT
  TO authenticated
  USING ((SELECT role FROM public.profiles WHERE id = auth.uid()) = 'admin');

CREATE POLICY "accounting_periods_insert_admin"
  ON public.accounting_periods FOR INSERT
  TO authenticated
  WITH CHECK ((SELECT role FROM public.profiles WHERE id = auth.uid()) = 'admin');

CREATE POLICY "accounting_periods_update_admin"
  ON public.accounting_periods FOR UPDATE
  TO authenticated
  USING ((SELECT role FROM public.profiles WHERE id = auth.uid()) = 'admin');

-- ─── check_period_open(p_date) ───────────────────────────────────────────────
-- Raises exception if the date falls in a closed period.
-- Used as guard in invoice posting, payment recording, etc.
CREATE OR REPLACE FUNCTION public.check_period_open(p_date date)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
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
$$;

-- ─── close_accounting_period ─────────────────────────────────────────────────
-- Validates no unposted invoices exist, then marks the period closed.
CREATE OR REPLACE FUNCTION public.close_accounting_period(
  p_period_end   date,
  p_performed_by uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_period_start date;
  v_unposted_count integer;
  v_period_id uuid;
  v_summary jsonb;
BEGIN
  -- Period is the calendar month ending on p_period_end
  v_period_start := date_trunc('month', p_period_end)::date;

  -- Check for unposted invoices in this period
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

  -- Check not already closed
  IF EXISTS (
    SELECT 1 FROM public.accounting_periods
     WHERE period_start = v_period_start AND period_end = p_period_end AND status = 'closed'
  ) THEN
    RAISE EXCEPTION 'Period % to % is already closed', v_period_start, p_period_end;
  END IF;

  -- Upsert accounting period
  INSERT INTO public.accounting_periods (period_start, period_end, status, closed_by, closed_at)
  VALUES (v_period_start, p_period_end, 'closed', p_performed_by, now())
  ON CONFLICT (period_start, period_end)
  DO UPDATE SET status = 'closed', closed_by = p_performed_by, closed_at = now(), updated_at = now()
  RETURNING id INTO v_period_id;

  -- Build summary
  SELECT jsonb_build_object(
    'period_id', v_period_id,
    'period_start', v_period_start,
    'period_end', p_period_end,
    'invoices_posted', (SELECT count(*) FROM public.invoices WHERE invoice_date BETWEEN v_period_start AND p_period_end AND status = 'posted' AND deleted_at IS NULL),
    'total_invoiced_cents', COALESCE((SELECT sum(total_amount_cents) FROM public.invoices WHERE invoice_date BETWEEN v_period_start AND p_period_end AND status = 'posted' AND deleted_at IS NULL), 0),
    'payments_received_cents', COALESCE((SELECT sum(amount_cents) FROM public.payments WHERE payment_date BETWEEN v_period_start AND p_period_end), 0),
    'orders_count', (SELECT count(*) FROM public.orders WHERE order_date BETWEEN v_period_start AND p_period_end AND deleted_at IS NULL),
    'deliveries_count', (SELECT count(*) FROM public.deliveries WHERE delivery_date BETWEEN v_period_start AND p_period_end AND deleted_at IS NULL)
  ) INTO v_summary;

  RETURN v_summary;
END;
$$;

-- ─── get_monthly_summary ─────────────────────────────────────────────────────
-- Aggregated report for a period: invoices, payments, orders, deliveries, applications, AR
CREATE OR REPLACE FUNCTION public.get_monthly_summary(
  p_period_start date,
  p_period_end   date
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_result jsonb;
BEGIN
  SELECT jsonb_build_object(
    'period_start', p_period_start,
    'period_end', p_period_end,
    'invoices', jsonb_build_object(
      'posted_count', (SELECT count(*) FROM public.invoices WHERE invoice_date BETWEEN p_period_start AND p_period_end AND status = 'posted' AND deleted_at IS NULL),
      'total_amount_cents', COALESCE((SELECT sum(total_amount_cents) FROM public.invoices WHERE invoice_date BETWEEN p_period_start AND p_period_end AND status = 'posted' AND deleted_at IS NULL), 0),
      'total_cost_cents', COALESCE((SELECT sum(total_cost_cents) FROM public.invoices WHERE invoice_date BETWEEN p_period_start AND p_period_end AND status = 'posted' AND deleted_at IS NULL), 0),
      'draft_count', (SELECT count(*) FROM public.invoices WHERE invoice_date BETWEEN p_period_start AND p_period_end AND status IN ('draft','unposted') AND deleted_at IS NULL),
      'voided_count', (SELECT count(*) FROM public.invoices WHERE invoice_date BETWEEN p_period_start AND p_period_end AND status = 'voided' AND deleted_at IS NULL)
    ),
    'payments', jsonb_build_object(
      'count', (SELECT count(*) FROM public.payments WHERE payment_date BETWEEN p_period_start AND p_period_end),
      'total_cents', COALESCE((SELECT sum(amount_cents) FROM public.payments WHERE payment_date BETWEEN p_period_start AND p_period_end), 0)
    ),
    'orders', jsonb_build_object(
      'count', (SELECT count(*) FROM public.orders WHERE order_date BETWEEN p_period_start AND p_period_end AND deleted_at IS NULL),
      'total_cents', COALESCE((SELECT sum(total_price_cents) FROM public.orders WHERE order_date BETWEEN p_period_start AND p_period_end AND deleted_at IS NULL), 0)
    ),
    'deliveries', jsonb_build_object(
      'count', (SELECT count(*) FROM public.deliveries WHERE delivery_date BETWEEN p_period_start AND p_period_end AND deleted_at IS NULL),
      'completed_count', (SELECT count(*) FROM public.deliveries WHERE delivery_date BETWEEN p_period_start AND p_period_end AND status = 'completed' AND deleted_at IS NULL)
    ),
    'applications', jsonb_build_object(
      'count', (SELECT count(*) FROM public.application_records WHERE application_date BETWEEN p_period_start AND p_period_end),
      'total_acres', COALESCE((SELECT sum(total_acres) FROM public.application_records WHERE application_date BETWEEN p_period_start AND p_period_end), 0)
    ),
    'commissions', jsonb_build_object(
      'earned_cents', COALESCE((SELECT sum(commission_amount) FROM public.commissions WHERE order_date BETWEEN p_period_start AND p_period_end), 0),
      'paid_count', (SELECT count(*) FROM public.commissions WHERE order_date BETWEEN p_period_start AND p_period_end AND status = 'paid')
    ),
    'ar_balance_cents', COALESCE((SELECT sum(balance_cents) FROM public.invoices WHERE status = 'posted' AND balance_cents > 0 AND deleted_at IS NULL), 0)
  ) INTO v_result;

  RETURN v_result;
END;
$$;

-- ─── generate_batch_statements ───────────────────────────────────────────────
-- Returns JSONB array of customer statement data for PDF generation
CREATE OR REPLACE FUNCTION public.generate_batch_statements(
  p_as_of_date   date,
  p_performed_by uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_customers jsonb;
BEGIN
  SELECT COALESCE(jsonb_agg(stmt ORDER BY stmt->>'farm_name'), '[]'::jsonb)
    INTO v_customers
    FROM (
      SELECT jsonb_build_object(
        'customer_id', c.id,
        'farm_name', c.farm_name,
        'contact_name', c.contact_name,
        'email', c.email,
        'phone', c.phone,
        'address', c.address,
        'city', c.city,
        'state', c.state,
        'zip', c.zip,
        'outstanding_balance_cents', COALESCE(sum(i.balance_cents), 0),
        'transactions', COALESCE(
          jsonb_agg(
            jsonb_build_object(
              'invoice_number', i.invoice_number,
              'invoice_date', i.invoice_date,
              'due_date', i.due_date,
              'total_amount_cents', i.total_amount_cents,
              'paid_amount_cents', i.paid_amount_cents,
              'prepay_applied_cents', i.prepay_applied_cents,
              'balance_cents', i.balance_cents,
              'status', i.status,
              'invoice_type', i.invoice_type
            ) ORDER BY i.invoice_date
          ) FILTER (WHERE i.id IS NOT NULL),
          '[]'::jsonb
        )
      ) AS stmt
      FROM public.customers c
      INNER JOIN public.invoices i
        ON i.customer_id = c.id
        AND i.status = 'posted'
        AND i.balance_cents > 0
        AND i.deleted_at IS NULL
        AND i.invoice_date <= p_as_of_date
      WHERE c.is_active = true
      GROUP BY c.id, c.farm_name, c.contact_name, c.email, c.phone, c.address, c.city, c.state, c.zip
      HAVING sum(i.balance_cents) > 0
    ) sub;

  RETURN v_customers;
END;
$$;
