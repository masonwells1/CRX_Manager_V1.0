-- Follow-up: preserve fully paid invoices in Customer Balance Listing's cumulative
-- Invoiced, Paid, Prepay Applied, and invoice-count fields. Only the open
-- balance and oldest-unpaid fields are limited to positive-balance invoices.

CREATE OR REPLACE FUNCTION public.get_customer_balance_listing(
  p_as_of_date date
)
RETURNS TABLE(
  customer_id uuid,
  farm_name text,
  total_invoiced numeric,
  total_paid numeric,
  prepay_applied numeric,
  outstanding_balance numeric,
  open_credit numeric,
  invoice_count bigint,
  oldest_unpaid_date date
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_role text;
  v_is_admin boolean;
  v_customer_id uuid;
BEGIN
  IF v_actor IS NULL OR p_as_of_date IS NULL THEN
    RAISE EXCEPTION 'INVALID_HISTORICAL_REPORT_INPUT';
  END IF;

  SELECT p.role
    INTO v_role
    FROM public.profiles p
   WHERE p.id = v_actor
     AND p.is_active = true;
  IF v_role IS NULL OR v_role NOT IN ('admin', 'sales_rep') THEN
    RAISE EXCEPTION 'Permission denied: requires admin or sales_rep role';
  END IF;
  v_is_admin := v_role = 'admin';

  IF NOT v_is_admin
     AND p_as_of_date < (now() AT TIME ZONE 'America/Chicago')::date THEN
    RAISE EXCEPTION 'Admin access required for historical customer balance report';
  END IF;

  FOR v_customer_id IN
    SELECT DISTINCT i.customer_id
      FROM public.invoices i
      JOIN public.customers c ON c.id = i.customer_id
     WHERE i.invoice_date <= p_as_of_date
       AND (v_is_admin OR c.assigned_sales_rep = v_actor)
       AND (v_is_admin OR i.created_by = v_actor OR i.salesman_id = v_actor)
       AND public.statement_invoice_was_posted_as_of(i.id, i.posted_at, p_as_of_date)
  LOOP
    PERFORM public.assert_customer_balance_reconstructable_as_of(v_customer_id, p_as_of_date);
  END LOOP;

  RETURN QUERY
  WITH eligible_invoices AS (
    SELECT
      i.id,
      i.customer_id,
      i.invoice_date::date,
      i.total_amount_cents,
      i.paid_amount_cents,
      i.prepay_applied_cents,
      (
        i.balance_cents
        + i.credit_applied_cents
        - credit_at_cutoff.applied_cents
      )::bigint AS statement_balance_cents
    FROM public.invoices i
    JOIN public.customers scoped_customer ON scoped_customer.id = i.customer_id
    CROSS JOIN LATERAL (
      SELECT COALESCE(sum(cma.amount_cents), 0)::bigint AS applied_cents
        FROM public.credit_memo_applications cma
       WHERE cma.target_invoice_id = i.id
         AND (cma.applied_at AT TIME ZONE 'America/Chicago')::date <= p_as_of_date
         AND (
           cma.reversed_at IS NULL
           OR (cma.reversed_at AT TIME ZONE 'America/Chicago')::date > p_as_of_date
         )
    ) credit_at_cutoff
    WHERE i.invoice_type <> 'credit_memo'
      AND i.invoice_date <= p_as_of_date
      AND (v_is_admin OR scoped_customer.assigned_sales_rep = v_actor)
      AND (v_is_admin OR i.created_by = v_actor OR i.salesman_id = v_actor)
      AND public.statement_invoice_was_posted_as_of(i.id, i.posted_at, p_as_of_date)
      AND (i.voided_at IS NULL OR (i.voided_at AT TIME ZONE 'America/Chicago')::date > p_as_of_date)
      AND (i.deleted_at IS NULL OR (i.deleted_at AT TIME ZONE 'America/Chicago')::date > p_as_of_date)
  ),
  open_credits AS (
    SELECT
      ci.customer_id,
      COALESCE(sum(
        greatest(
          -ci.total_amount_cents - COALESCE((
            SELECT sum(cma.amount_cents)
              FROM public.credit_memo_applications cma
             WHERE cma.credit_memo_id = ci.id
               AND (cma.applied_at AT TIME ZONE 'America/Chicago')::date <= p_as_of_date
               AND (
                 cma.reversed_at IS NULL
                 OR (cma.reversed_at AT TIME ZONE 'America/Chicago')::date > p_as_of_date
               )
          ), 0),
          0::bigint
        )
      ), 0)::bigint AS credit_cents
    FROM public.invoices ci
    JOIN public.customers scoped_customer ON scoped_customer.id = ci.customer_id
    WHERE ci.invoice_type = 'credit_memo'
      AND ci.invoice_date <= p_as_of_date
      AND (v_is_admin OR scoped_customer.assigned_sales_rep = v_actor)
      AND (v_is_admin OR ci.created_by = v_actor OR ci.salesman_id = v_actor)
      AND public.statement_invoice_was_posted_as_of(ci.id, ci.posted_at, p_as_of_date)
      AND (ci.voided_at IS NULL OR (ci.voided_at AT TIME ZONE 'America/Chicago')::date > p_as_of_date)
      AND (ci.deleted_at IS NULL OR (ci.deleted_at AT TIME ZONE 'America/Chicago')::date > p_as_of_date)
    GROUP BY ci.customer_id
  )
  SELECT
    c.id,
    c.farm_name,
    round(COALESCE(sum(ei.total_amount_cents), 0) / 100.0, 2),
    round(COALESCE(sum(ei.paid_amount_cents), 0) / 100.0, 2),
    round(COALESCE(sum(ei.prepay_applied_cents), 0) / 100.0, 2),
    round(COALESCE(sum(ei.statement_balance_cents) FILTER (WHERE ei.statement_balance_cents > 0), 0) / 100.0, 2),
    round(COALESCE(oc.credit_cents, 0) / 100.0, 2),
    count(ei.id),
    min(ei.invoice_date) FILTER (WHERE ei.statement_balance_cents > 0)
  FROM public.customers c
  LEFT JOIN eligible_invoices ei ON ei.customer_id = c.id
  LEFT JOIN open_credits oc ON oc.customer_id = c.id
  WHERE v_is_admin OR c.assigned_sales_rep = v_actor
  GROUP BY c.id, c.farm_name, oc.credit_cents
  HAVING COALESCE(sum(ei.statement_balance_cents) FILTER (WHERE ei.statement_balance_cents > 0), 0) > 0
      OR COALESCE(oc.credit_cents, 0) > 0
  ORDER BY COALESCE(sum(ei.statement_balance_cents) FILTER (WHERE ei.statement_balance_cents > 0), 0) DESC;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_customer_balance_listing(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_customer_balance_listing(date) TO authenticated, service_role;

DO $postflight$
DECLARE
  v_def text;
BEGIN
  IF (
    SELECT count(*)
      FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.proname = 'get_customer_balance_listing'
  ) <> 1 THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAILED: expected one get_customer_balance_listing overload';
  END IF;

  SELECT p.prosrc
    INTO v_def
    FROM pg_proc p
   WHERE p.oid = 'public.get_customer_balance_listing(date)'::regprocedure;

  IF v_def NOT LIKE '%sum(ei.total_amount_cents)%'
     OR v_def NOT LIKE '%sum(ei.paid_amount_cents)%'
     OR v_def NOT LIKE '%sum(ei.prepay_applied_cents)%'
     OR v_def NOT LIKE '%count(ei.id)%'
     OR v_def LIKE '%sum(ei.total_amount_cents) FILTER%'
     OR v_def LIKE '%sum(ei.paid_amount_cents) FILTER%'
     OR v_def LIKE '%sum(ei.prepay_applied_cents) FILTER%'
     OR v_def LIKE '%count(ei.id) FILTER%'
     OR v_def NOT LIKE '%min(ei.invoice_date) FILTER (WHERE ei.statement_balance_cents > 0)%'
     OR v_def NOT LIKE '%sum(ei.statement_balance_cents) FILTER (WHERE ei.statement_balance_cents > 0)%' THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAILED: cumulative and open-balance aggregation boundaries are not preserved';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_proc p
     WHERE p.oid = 'public.get_customer_balance_listing(date)'::regprocedure
       AND (
         p.prosecdef IS DISTINCT FROM true
         OR NOT COALESCE(p.proconfig @> ARRAY['search_path=public, pg_temp'], false)
       )
  )
     OR has_function_privilege('anon', 'public.get_customer_balance_listing(date)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.get_customer_balance_listing(date)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAILED: security or grant contract regressed';
  END IF;
END;
$postflight$;
