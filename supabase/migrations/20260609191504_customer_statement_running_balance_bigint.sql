-- Fix (found by the end-to-end return-credit smoke test): get_customer_statement crashes
-- with SQLSTATE 42804 "Returned type numeric does not match expected type bigint in column 6"
-- whenever the statement has any rows.
--
-- Root cause (PRE-EXISTING — present in the live body before today's de-dup migration
-- 20260609150200; not introduced by it): the function declares `running_balance bigint`, but
-- `SUM(t.amt) OVER (...)` over bigint input returns NUMERIC in Postgres. With 0 rows the
-- structural type check never fires, so it went unnoticed (the DB has very few invoices and the
-- frontend swallows the error in a try/catch -> "Failed to load customer statement"). The
-- credit-memo created by issue_return_credit gives the statement a row, surfacing it.
--
-- Fix: cast the window SUM to bigint. amt is always whole-cent bigint (total_amount_cents,
-- -(amount*100)::bigint, -applied_amount_cents), so the cast is exact (no fractional loss).
-- Also carries the de-dup + credit_memo relabel from 20260609150200 (this supersedes that
-- function version). Read-only STABLE SECDEF; role guard unchanged. Reversible.

CREATE OR REPLACE FUNCTION public.get_customer_statement(p_customer_id uuid, p_start_date date DEFAULT ((CURRENT_DATE - '90 days'::interval))::date, p_end_date date DEFAULT CURRENT_DATE)
 RETURNS TABLE(transaction_date date, transaction_type text, reference_number text, description text, amount_cents bigint, running_balance bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- Role guard: admin or sales_rep
  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = auth.uid() AND is_active = true AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'Access denied: admin or sales_rep role required';
  END IF;

  RETURN QUERY
  WITH txns AS (
    -- Posted invoices (includes credit memos, which carry a negative total — counted ONCE here;
    -- the separate returns-credit branch was removed in 20260609150200 to fix a double-count).
    SELECT
      i.invoice_date::date AS txn_date,
      CASE WHEN i.invoice_type = 'credit_memo' THEN 'credit' ELSE 'invoice' END AS txn_type,
      i.invoice_number AS ref_num,
      CASE WHEN i.invoice_type = 'credit_memo'
           THEN 'Credit Memo ' || i.invoice_number
           ELSE 'Invoice ' || i.invoice_number END AS descr,
      i.total_amount_cents AS amt
    FROM invoices i
    WHERE i.customer_id = p_customer_id
      AND i.status = 'posted'
      AND i.deleted_at IS NULL
      AND i.invoice_date::date BETWEEN p_start_date AND p_end_date

    UNION ALL

    -- Payments (amount is numeric dollars, convert to cents)
    SELECT
      p.payment_date::date AS txn_date,
      'payment' AS txn_type,
      COALESCE(p.reference_number, '') AS ref_num,
      'Payment - ' || p.payment_method AS descr,
      -(p.amount * 100)::bigint AS amt
    FROM payments p
    INNER JOIN orders o ON o.id = p.order_id
    WHERE o.customer_id = p_customer_id
      AND p.payment_date::date BETWEEN p_start_date AND p_end_date

    UNION ALL

    -- Prepay applications
    SELECT
      pa.applied_at::date AS txn_date,
      'prepay' AS txn_type,
      '' AS ref_num,
      'Prepay Applied' AS descr,
      -pa.applied_amount_cents AS amt
    FROM prepay_applications pa
    INNER JOIN prepay_credits pc ON pc.id = pa.prepay_credit_id
    WHERE pc.customer_id = p_customer_id
      AND pa.applied_at::date BETWEEN p_start_date AND p_end_date
  )
  SELECT
    t.txn_date AS transaction_date,
    t.txn_type AS transaction_type,
    t.ref_num AS reference_number,
    t.descr AS description,
    t.amt AS amount_cents,
    (SUM(t.amt) OVER (ORDER BY t.txn_date, t.txn_type))::bigint AS running_balance
  FROM txns t
  ORDER BY t.txn_date, t.txn_type;
END;
$function$;
