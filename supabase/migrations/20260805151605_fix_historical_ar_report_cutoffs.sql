-- Fix the two Section 2 historical-report contracts.
--
-- get_ar_aging(date) and get_customer_balance_listing(date) previously accepted
-- a cutoff date while reading today's mutable invoice, payment, prepay, write-off,
-- and credit state. The listing also admitted `unposted` invoices and omitted
-- `overdue` invoices. Reuse the ledger-backed statement helpers introduced by
-- 20260803221244: reconstruct credit applications at the cutoff and fail closed
-- when later activity destroyed the evidence needed for a truthful old balance.
--
-- No tables or business rows change. Both public reports become deliberately
-- gated SECURITY DEFINER functions because their historical proof depends on
-- private statement helpers and the admin-only financial audit ledger. Sales reps
-- retain their current-date Customer Balance Listing with the same customer and
-- invoice scope previously enforced by RLS; historical listing is admin-only.

DO $preflight$
DECLARE
  v_count integer;
  v_hash text;
BEGIN
  SELECT count(*), min(md5(p.prosrc))
    INTO v_count, v_hash
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname = 'get_ar_aging';
  IF v_count <> 1 OR v_hash <> '76d3f22c915ffa4949a8c39f70ab511f' THEN
    RAISE EXCEPTION 'PREFLIGHT_FAILED: get_ar_aging drifted (count %, hash %)', v_count, v_hash;
  END IF;

  SELECT count(*), min(md5(p.prosrc))
    INTO v_count, v_hash
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname = 'get_customer_balance_listing';
  IF v_count <> 1 OR v_hash <> '73bceadefc332a5282b38185a509c1d2' THEN
    RAISE EXCEPTION 'PREFLIGHT_FAILED: get_customer_balance_listing drifted (count %, hash %)', v_count, v_hash;
  END IF;

  IF to_regprocedure('public.statement_invoice_was_posted_as_of(uuid,timestamp with time zone,date)') IS NULL
     OR to_regprocedure('public.statement_customer_has_later_balance_activity(uuid,date)') IS NULL
     OR to_regprocedure('public.require_admin()') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_FAILED: required statement or authorization helper is missing';
  END IF;

  SELECT count(*) INTO v_count
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname = 'assert_customer_balance_reconstructable_as_of';
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'PREFLIGHT_FAILED: assert_customer_balance_reconstructable_as_of already exists';
  END IF;
END;
$preflight$;

CREATE FUNCTION public.assert_customer_balance_reconstructable_as_of(
  p_customer_id uuid,
  p_as_of_date date
)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF p_customer_id IS NULL OR p_as_of_date IS NULL THEN
    RAISE EXCEPTION 'INVALID_HISTORICAL_REPORT_INPUT';
  END IF;

  -- Generic void_invoice zeroes mutable money columns. Its audit snapshot does
  -- not retain a complete invoice-scoped event history, so do not guess.
  IF EXISTS (
    SELECT 1
      FROM public.invoices i
     WHERE i.customer_id = p_customer_id
       AND i.invoice_date <= p_as_of_date
       AND public.statement_invoice_was_posted_as_of(i.id, i.posted_at, p_as_of_date)
       AND (i.voided_at AT TIME ZONE 'America/Chicago')::date > p_as_of_date
       AND EXISTS (
         SELECT 1
           FROM public.financial_audit_log fal
          WHERE fal.entity_type = 'invoice'
            AND fal.entity_id = i.id
            AND fal.operation_type = 'invoice_voided'
       )
  ) THEN
    RAISE EXCEPTION 'HISTORICAL_VOID_RECONSTRUCTION_UNAVAILABLE: a later generic invoice void prevents a trustworthy report at this cutoff';
  END IF;

  -- A later unpost makes the row editable again; the posting ledger proves the
  -- interval but cannot prove the former mutable header and line values.
  IF EXISTS (
    SELECT 1
      FROM public.invoices i
     WHERE i.customer_id = p_customer_id
       AND i.invoice_date <= p_as_of_date
       AND public.statement_invoice_was_posted_as_of(i.id, i.posted_at, p_as_of_date)
       AND EXISTS (
         SELECT 1
           FROM public.financial_audit_log fal
          WHERE fal.entity_type = 'invoice'
            AND fal.entity_id = i.id
            AND fal.operation_type = 'invoice_unposted'
            AND (fal.created_at AT TIME ZONE 'America/Chicago')::date > p_as_of_date
       )
  ) THEN
    RAISE EXCEPTION 'HISTORICAL_UNPOST_RECONSTRUCTION_UNAVAILABLE: a later invoice unpost prevents a trustworthy report at this cutoff';
  END IF;

  IF public.statement_customer_has_later_balance_activity(p_customer_id, p_as_of_date) THEN
    RAISE EXCEPTION 'HISTORICAL_BALANCE_RECONSTRUCTION_UNAVAILABLE: later payment, prepay, or write-off activity prevents a trustworthy report at this cutoff';
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public.assert_customer_balance_reconstructable_as_of(uuid, date)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_ar_aging(
  p_as_of_date date DEFAULT CURRENT_DATE
)
RETURNS TABLE(
  customer_id uuid,
  farm_name text,
  current_amount numeric,
  days_30 numeric,
  days_60 numeric,
  days_90 numeric,
  over_90 numeric,
  total_outstanding numeric,
  prepay_balance_cents bigint,
  open_credit_cents bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_customer_id uuid;
BEGIN
  PERFORM public.require_admin();
  IF p_as_of_date IS NULL THEN
    RAISE EXCEPTION 'INVALID_HISTORICAL_REPORT_INPUT';
  END IF;

  FOR v_customer_id IN
    SELECT DISTINCT i.customer_id
      FROM public.invoices i
     WHERE i.invoice_date <= p_as_of_date
       AND public.statement_invoice_was_posted_as_of(i.id, i.posted_at, p_as_of_date)
  LOOP
    PERFORM public.assert_customer_balance_reconstructable_as_of(v_customer_id, p_as_of_date);
  END LOOP;

  RETURN QUERY
  WITH eligible_invoices AS (
    SELECT
      i.id,
      i.customer_id,
      COALESCE(i.due_date, i.invoice_date)::date AS aging_date,
      (
        i.balance_cents
        + i.credit_applied_cents
        - credit_at_cutoff.applied_cents
      )::bigint AS statement_balance_cents
    FROM public.invoices i
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
    WHERE ci.invoice_type = 'credit_memo'
      AND ci.invoice_date <= p_as_of_date
      AND public.statement_invoice_was_posted_as_of(ci.id, ci.posted_at, p_as_of_date)
      AND (ci.voided_at IS NULL OR (ci.voided_at AT TIME ZONE 'America/Chicago')::date > p_as_of_date)
      AND (ci.deleted_at IS NULL OR (ci.deleted_at AT TIME ZONE 'America/Chicago')::date > p_as_of_date)
    GROUP BY ci.customer_id
  )
  SELECT
    c.id,
    c.farm_name,
    (COALESCE(sum(CASE WHEN p_as_of_date - ei.aging_date <= 29 THEN ei.statement_balance_cents ELSE 0 END), 0)::numeric / 100.0),
    (COALESCE(sum(CASE WHEN p_as_of_date - ei.aging_date BETWEEN 30 AND 59 THEN ei.statement_balance_cents ELSE 0 END), 0)::numeric / 100.0),
    (COALESCE(sum(CASE WHEN p_as_of_date - ei.aging_date BETWEEN 60 AND 89 THEN ei.statement_balance_cents ELSE 0 END), 0)::numeric / 100.0),
    (COALESCE(sum(CASE WHEN p_as_of_date - ei.aging_date BETWEEN 90 AND 119 THEN ei.statement_balance_cents ELSE 0 END), 0)::numeric / 100.0),
    (COALESCE(sum(CASE WHEN p_as_of_date - ei.aging_date >= 120 THEN ei.statement_balance_cents ELSE 0 END), 0)::numeric / 100.0),
    (COALESCE(sum(ei.statement_balance_cents), 0)::numeric / 100.0),
    c.prepay_balance_cents,
    COALESCE(oc.credit_cents, 0)::bigint
  FROM public.customers c
  JOIN eligible_invoices ei
    ON ei.customer_id = c.id
   AND ei.statement_balance_cents > 0
  LEFT JOIN open_credits oc ON oc.customer_id = c.id
  GROUP BY c.id, c.farm_name, c.prepay_balance_cents, oc.credit_cents
  HAVING sum(ei.statement_balance_cents) > 0
  ORDER BY sum(ei.statement_balance_cents) DESC;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_ar_aging(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_ar_aging(date) TO authenticated, service_role;

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

  -- The financial audit and write-off ledgers needed to prove an old cutoff are
  -- admin-only. A sales rep receives a deliberate error instead of a fabricated
  -- historical result, while retaining the current-date report under prior RLS scope.
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
    round(COALESCE(sum(ei.total_amount_cents) FILTER (WHERE ei.statement_balance_cents > 0), 0) / 100.0, 2),
    round(COALESCE(sum(ei.paid_amount_cents) FILTER (WHERE ei.statement_balance_cents > 0), 0) / 100.0, 2),
    round(COALESCE(sum(ei.prepay_applied_cents) FILTER (WHERE ei.statement_balance_cents > 0), 0) / 100.0, 2),
    round(COALESCE(sum(ei.statement_balance_cents) FILTER (WHERE ei.statement_balance_cents > 0), 0) / 100.0, 2),
    round(COALESCE(oc.credit_cents, 0) / 100.0, 2),
    count(ei.id) FILTER (WHERE ei.statement_balance_cents > 0),
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
  v_count integer;
  v_def text;
BEGIN
  SELECT count(*) INTO v_count
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname IN (
       'assert_customer_balance_reconstructable_as_of',
       'get_ar_aging',
       'get_customer_balance_listing'
     );
  IF v_count <> 3 THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAILED: expected exactly three target function overloads, found %', v_count;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_proc p
     WHERE p.oid IN (
       'public.assert_customer_balance_reconstructable_as_of(uuid,date)'::regprocedure,
       'public.get_ar_aging(date)'::regprocedure,
       'public.get_customer_balance_listing(date)'::regprocedure
     )
       AND (
         p.prosecdef IS DISTINCT FROM true
         OR NOT COALESCE(p.proconfig @> ARRAY['search_path=public, pg_temp'], false)
       )
  ) THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAILED: SECURITY DEFINER/search_path contract missing';
  END IF;

  IF has_function_privilege('anon', 'public.get_ar_aging(date)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.get_customer_balance_listing(date)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.assert_customer_balance_reconstructable_as_of(uuid,date)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.assert_customer_balance_reconstructable_as_of(uuid,date)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.get_ar_aging(date)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.get_customer_balance_listing(date)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAILED: function grants do not match the reviewed contract';
  END IF;

  SELECT p.prosrc
    INTO v_def
    FROM pg_proc p
   WHERE p.oid = 'public.get_ar_aging(date)'::regprocedure;
  IF v_def NOT LIKE '%i.invoice_date <= p_as_of_date%'
     OR v_def NOT LIKE '%public.statement_invoice_was_posted_as_of%'
     OR v_def NOT LIKE '%public.assert_customer_balance_reconstructable_as_of%'
     OR v_def LIKE '%i.status IN (''posted'', ''overdue'')%' THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAILED: get_ar_aging historical contract missing';
  END IF;

  SELECT p.prosrc
    INTO v_def
    FROM pg_proc p
   WHERE p.oid = 'public.get_customer_balance_listing(date)'::regprocedure;
  IF v_def NOT LIKE '%Admin access required for historical customer balance report%'
     OR v_def NOT LIKE '%public.statement_invoice_was_posted_as_of%'
     OR v_def NOT LIKE '%public.assert_customer_balance_reconstructable_as_of%'
     OR v_def LIKE '%i.status IN (''posted'', ''unposted'')%' THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAILED: get_customer_balance_listing historical or role contract missing';
  END IF;
END;
$postflight$;
