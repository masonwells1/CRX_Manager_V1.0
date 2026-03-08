-- ============================================================================
-- EMAIL INFRASTRUCTURE
-- ============================================================================
-- Core email audit trail + AR reminder dedup tables + RPC.
-- Supports all email types: invoice, statement, order_confirmed,
-- delivery_completed, quote, ar_reminder, low_stock_alert, month_end_close.
-- ============================================================================

-- 1. email_type enum
DO $$ BEGIN
  CREATE TYPE public.email_type AS ENUM (
    'invoice',
    'statement',
    'order_confirmed',
    'delivery_completed',
    'quote',
    'ar_reminder',
    'low_stock_alert',
    'month_end_close'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 2. email_log — audit trail for every outbound email
CREATE TABLE IF NOT EXISTS public.email_log (
  id             uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  customer_id    uuid REFERENCES public.customers(id) ON DELETE SET NULL,
  recipient_email text NOT NULL,
  email_type     public.email_type NOT NULL,
  subject        text NOT NULL,
  html_body      text,
  attachment_name text,
  resend_message_id text,
  status         text NOT NULL DEFAULT 'sent'
    CHECK (status IN ('sent', 'failed', 'bounced')),
  error_message  text,
  idempotency_key text UNIQUE,
  created_by     uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at     timestamptz DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_email_log_customer   ON public.email_log (customer_id);
CREATE INDEX IF NOT EXISTS idx_email_log_type       ON public.email_log (email_type);
CREATE INDEX IF NOT EXISTS idx_email_log_created_at ON public.email_log (created_at DESC);

-- RLS: admin SELECT, service_role bypasses
ALTER TABLE public.email_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS email_log_admin_select ON public.email_log;
CREATE POLICY email_log_admin_select ON public.email_log
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin')
  );

DROP POLICY IF EXISTS email_log_admin_insert ON public.email_log;
CREATE POLICY email_log_admin_insert ON public.email_log
  FOR INSERT WITH CHECK (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin')
  );

-- 3. ar_reminder_tracking — dedup: max one reminder per customer per level per day
CREATE TABLE IF NOT EXISTS public.ar_reminder_tracking (
  id            uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  customer_id   uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  reminder_level int NOT NULL CHECK (reminder_level IN (30, 60, 90)),
  sent_date     date NOT NULL DEFAULT CURRENT_DATE,
  email_log_id  uuid REFERENCES public.email_log(id) ON DELETE SET NULL,
  created_at    timestamptz DEFAULT now(),
  UNIQUE (customer_id, reminder_level, sent_date)
);

ALTER TABLE public.ar_reminder_tracking ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ar_reminder_admin_select ON public.ar_reminder_tracking;
CREATE POLICY ar_reminder_admin_select ON public.ar_reminder_tracking
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin')
  );

-- 4. get_ar_reminder_candidates() — customers with 30+ day overdue invoices
CREATE OR REPLACE FUNCTION public.get_ar_reminder_candidates()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result jsonb;
  _role  text;
BEGIN
  _role := COALESCE(
    current_setting('request.jwt.claims', true)::jsonb ->> 'user_role',
    (SELECT role FROM public.profiles WHERE id = auth.uid())
  );
  IF _role IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'permission denied: admin role required';
  END IF;

  SELECT COALESCE(jsonb_agg(row_to_json(cust_agg)::jsonb), '[]'::jsonb)
  INTO result
  FROM (
    SELECT
      c.id AS customer_id,
      c.farm_name,
      c.email,
      MAX(EXTRACT(DAY FROM NOW() - i.invoice_date)::int) AS max_days_past_due,
      COALESCE(SUM(GREATEST(i.balance_cents, 0)), 0) / 100.0 AS total_balance,
      jsonb_agg(jsonb_build_object(
        'invoice_id', i.id,
        'invoice_number', i.invoice_number,
        'invoice_date', i.invoice_date,
        'balance_cents', i.balance_cents,
        'days_past_due', EXTRACT(DAY FROM NOW() - i.invoice_date)::int
      ) ORDER BY i.invoice_date) AS invoices
    FROM invoices i
    JOIN customers c ON c.id = i.customer_id
    WHERE i.status = 'posted'
      AND i.balance_cents > 0
      AND EXTRACT(DAY FROM NOW() - i.invoice_date)::int > 30
      AND c.email IS NOT NULL
      AND c.email <> ''
    GROUP BY c.id, c.farm_name, c.email
    ORDER BY max_days_past_due DESC
  ) cust_agg;

  RETURN result;
END;
$$;

COMMENT ON FUNCTION public.get_ar_reminder_candidates() IS
  'Returns customers with overdue invoices (30+ days) grouped by customer, '
  'with invoice details, total balance, and max days past due. '
  'Only includes customers with email addresses on file.';
