-- PARKED-005 (codex-driven hunt cycle 3) — DRAFT, NOT APPLIED.
-- get_ar_reminder_candidates() filters WHERE i.status = 'posted', but
-- mark_overdue_invoices() flips posted -> 'overdue' once due_date < CURRENT_DATE.
-- Result: the MOST delinquent invoices (already auto-marked 'overdue') are
-- EXCLUDED from AR reminder emails — the opposite of intent. Fix: include both
-- 'posted' and 'overdue'. ('paid' has balance 0 and is excluded by balance_cents>0;
-- 'voided'/'cancelled' should not be chased.)
--
-- Zero impact today (0 posted/overdue invoices live — operationally empty), but a
-- latent logic bug that bites as soon as real billing + the overdue job run.
-- Only change vs live: the WHERE status predicate (one line). Everything else is
-- the current live definition verbatim.

CREATE OR REPLACE FUNCTION public.get_ar_reminder_candidates()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
    WHERE i.status IN ('posted', 'overdue')   -- PARKED-005: was = 'posted' (excluded auto-marked overdue invoices)
      AND i.balance_cents > 0
      AND EXTRACT(DAY FROM NOW() - i.invoice_date)::int > 30
      AND c.email IS NOT NULL
      AND c.email <> ''
    GROUP BY c.id, c.farm_name, c.email
    ORDER BY max_days_past_due DESC
  ) cust_agg;

  RETURN result;
END;
$function$;
