-- Make bounded customer statements carry their opening balance and produce a
-- deterministic line-by-line running balance. The public customer-scope wrapper
-- remains unchanged; only its directly non-executable implementation is re-emitted.

CREATE OR REPLACE FUNCTION public._get_customer_statement_scoped_impl(
  p_customer_id uuid,
  p_start_date date DEFAULT ((CURRENT_DATE - '90 days'::interval))::date,
  p_end_date date DEFAULT CURRENT_DATE
)
RETURNS TABLE(
  transaction_date date,
  transaction_type text,
  reference_number text,
  description text,
  amount_cents bigint,
  running_balance bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM public.profiles
     WHERE id = auth.uid()
       AND is_active = true
       AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'Access denied: admin or sales_rep role required';
  END IF;

  IF p_start_date > p_end_date THEN
    RAISE EXCEPTION 'INVALID_STATEMENT_DATE_RANGE';
  END IF;

  RETURN QUERY
  WITH all_txns AS (
    SELECT
      i.invoice_date::date AS txn_date,
      CASE WHEN i.invoice_type = 'credit_memo' THEN 'credit' ELSE 'invoice' END AS txn_type,
      i.invoice_number AS ref_num,
      CASE WHEN i.invoice_type = 'credit_memo'
           THEN 'Credit Memo ' || i.invoice_number
           ELSE 'Invoice ' || i.invoice_number END AS descr,
      i.total_amount_cents AS amt,
      10 AS source_rank,
      i.id AS sort_id
    FROM public.invoices i
    WHERE i.customer_id = p_customer_id
      AND i.status IN ('posted', 'paid', 'overdue')
      AND i.deleted_at IS NULL

    UNION ALL

    SELECT
      p.payment_date::date,
      'payment',
      COALESCE(p.reference_number, ''),
      'Payment - ' || p.payment_method,
      -(p.amount * 100)::bigint,
      20,
      p.id
    FROM public.payments p
    LEFT JOIN public.orders o ON o.id = p.order_id
    WHERE COALESCE(o.customer_id, p.customer_id) = p_customer_id
      AND p.deleted_at IS NULL

    UNION ALL

    SELECT
      COALESCE(a.payment_date, a.created_at::date),
      'payment',
      COALESCE(a.reference_number, a.check_number, ''),
      'Payment - ' || COALESCE(a.payment_method, 'other'),
      -COALESCE(a.total_allocated_cents, 0),
      21,
      a.id
    FROM public.allocation_sets a
    WHERE a.entity_type = 'payment'
      AND a.is_active = true
      AND a.customer_id = p_customer_id
      AND COALESCE(a.total_allocated_cents, 0) > 0

    UNION ALL

    SELECT
      pa.applied_at::date,
      'prepay',
      '',
      'Prepay Applied',
      -pa.applied_amount_cents,
      30,
      pa.id
    FROM public.prepay_applications pa
    INNER JOIN public.prepay_credits pc ON pc.id = pa.prepay_credit_id
    WHERE pc.customer_id = p_customer_id

    UNION ALL

    SELECT
      (wo.created_at AT TIME ZONE 'America/Chicago')::date,
      'write_off',
      i.invoice_number,
      'Write-off - ' || wo.reason,
      -wo.amount_cents,
      40,
      wo.id
    FROM public.write_offs wo
    INNER JOIN public.invoices i ON i.id = wo.invoice_id
    WHERE wo.customer_id = p_customer_id
      AND wo.reversed_at IS NULL
  ),
  opening AS (
    SELECT COALESCE(SUM(a.amt), 0)::bigint AS amt
      FROM all_txns a
     WHERE a.txn_date < p_start_date
  ),
  statement_txns AS (
    SELECT
      p_start_date AS txn_date,
      'opening_balance'::text AS txn_type,
      ''::text AS ref_num,
      'Opening Balance'::text AS descr,
      o.amt,
      0 AS source_rank,
      '00000000-0000-0000-0000-000000000000'::uuid AS sort_id
    FROM opening o
    WHERE o.amt <> 0

    UNION ALL

    SELECT a.txn_date, a.txn_type, a.ref_num, a.descr, a.amt,
           a.source_rank, a.sort_id
      FROM all_txns a
     WHERE a.txn_date BETWEEN p_start_date AND p_end_date
  )
  SELECT
    t.txn_date,
    t.txn_type,
    t.ref_num,
    t.descr,
    t.amt,
    SUM(t.amt) OVER (
      ORDER BY t.txn_date, t.source_rank, t.sort_id
      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    )::bigint
  FROM statement_txns t
  ORDER BY t.txn_date, t.source_rank, t.sort_id;
END;
$function$;

REVOKE ALL ON FUNCTION public._get_customer_statement_scoped_impl(uuid, date, date)
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public._get_customer_statement_scoped_impl(uuid, date, date)
  IS 'Internal customer statement reader with opening-balance carry-forward and deterministic running order. Direct execution is revoked; use public.get_customer_statement.';

DO $verify$
DECLARE
  v_src text;
  v_config text[];
BEGIN
  IF to_regprocedure('public.get_customer_statement(uuid,date,date)') IS NULL
     OR to_regprocedure('public._get_customer_statement_scoped_impl(uuid,date,date)') IS NULL THEN
    RAISE EXCEPTION 'Customer statement wrapper/implementation identity missing';
  END IF;

  SELECT prosrc, proconfig
    INTO v_src, v_config
    FROM pg_proc
   WHERE oid = 'public._get_customer_statement_scoped_impl(uuid,date,date)'::regprocedure;

  IF v_config IS DISTINCT FROM ARRAY['search_path=public, pg_temp'] THEN
    RAISE EXCEPTION 'Internal statement function must keep fixed public, pg_temp search_path';
  END IF;
  IF v_src NOT LIKE '%Opening Balance%'
     OR v_src NOT LIKE '%ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW%'
     OR v_src NOT LIKE '%source_rank%'
     OR v_src NOT LIKE '%INVALID_STATEMENT_DATE_RANGE%' THEN
    RAISE EXCEPTION 'Statement opening-balance/deterministic-order contract missing';
  END IF;
  IF has_function_privilege('anon', 'public._get_customer_statement_scoped_impl(uuid,date,date)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._get_customer_statement_scoped_impl(uuid,date,date)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public._get_customer_statement_scoped_impl(uuid,date,date)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Internal statement implementation must not be directly executable';
  END IF;
END
$verify$;
