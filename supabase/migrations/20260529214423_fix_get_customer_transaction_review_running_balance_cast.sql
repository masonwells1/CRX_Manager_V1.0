-- 20260529130000_fix_get_customer_transaction_review_running_balance_cast.sql
--
-- Bug fix (workflow review 2026-05-28 + Codex 2026-05-29, live-verified, SQLSTATE 42804).
--
-- WHAT / WHY:
--   get_customer_transaction_review declares RETURNS TABLE(... running_balance_cents bigint),
--   but its final SELECT computes that column as a window SUM:
--       SUM(t.debit - t.credit) OVER (ORDER BY ...)
--   In Postgres, sum() over a bigint argument returns NUMERIC. numeric -> bigint is an
--   ASSIGNMENT-only cast (not implicit), and RETURN QUERY requires implicit/binary
--   coercibility, so the function raises 42804 ("structure of query does not match function
--   result type ... Returned type numeric does not match expected type bigint in column 7")
--   on EVERY call, regardless of data. The function is therefore 100% broken for all callers.
--
-- FIX: cast the window-sum result back to bigint. Single overload exists, so CREATE OR
--   REPLACE is safe. Body is otherwise byte-faithful to the live definition.
--
-- NOTE: anon EXECUTE on this function is revoked in companion migration
--   20260529120000_revoke_anon_execute_on_report_dashboard_secdef.sql (it exposes per-customer
--   financial history). Fixing the crash without that revoke would turn a crashing function
--   into a working anon data leak — both migrations are required together.

CREATE OR REPLACE FUNCTION public.get_customer_transaction_review(p_customer_id uuid, p_start_date date, p_end_date date)
 RETURNS TABLE(transaction_date date, transaction_type text, reference_number text, description text, debit_cents bigint, credit_cents bigint, running_balance_cents bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  RETURN QUERY
  WITH all_transactions AS (
    SELECT i.invoice_date AS tx_date,
           'Invoice' AS tx_type,
           i.invoice_number AS ref_num,
           CASE i.invoice_type
             WHEN 'chemical_sale' THEN 'Chemical Sale'
             WHEN 'field_application' THEN 'Field Application'
             WHEN 'misc_charge' THEN 'Misc Charge'
             ELSE COALESCE(i.invoice_type, 'Invoice')
           END AS descr,
           i.total_amount_cents AS debit,
           0::bigint AS credit
      FROM public.invoices i
     WHERE i.customer_id = p_customer_id
       AND i.status IN ('posted', 'paid', 'overdue')
       AND i.deleted_at IS NULL
       AND i.invoice_date BETWEEN p_start_date AND p_end_date

    UNION ALL

    SELECT als.payment_date AS tx_date,
           'Payment' AS tx_type,
           COALESCE(als.reference_number, als.check_number, 'PMT-' || LEFT(als.id::text, 8)) AS ref_num,
           COALESCE(als.payment_method, 'Payment') ||
             CASE WHEN als.check_number IS NOT NULL THEN ' #' || als.check_number ELSE '' END ||
             COALESCE(' — ' || als.notes, '') AS descr,
           0::bigint AS debit,
           ila.amount_cents AS credit
      FROM public.allocation_sets als
      JOIN public.invoice_line_allocations ila ON ila.allocation_set_id = als.id
     WHERE als.customer_id = p_customer_id
       AND als.payment_date BETWEEN p_start_date AND p_end_date

    UNION ALL

    SELECT pa.applied_at::date AS tx_date,
           'Prepay Applied' AS tx_type,
           'PP-' || LEFT(pa.id::text, 8) AS ref_num,
           'Prepay credit applied' AS descr,
           0::bigint AS debit,
           pa.applied_amount_cents AS credit
      FROM public.prepay_applications pa
      JOIN public.invoices i ON i.id = pa.invoice_id
     WHERE i.customer_id = p_customer_id
       AND i.deleted_at IS NULL
       AND pa.applied_at::date BETWEEN p_start_date AND p_end_date

    UNION ALL

    SELECT w.created_at::date AS tx_date,
           'Write-Off' AS tx_type,
           'WO-' || LEFT(w.id::text, 8) AS ref_num,
           COALESCE(w.reason, 'Write-off') AS descr,
           0::bigint AS debit,
           w.amount_cents AS credit
      FROM public.write_offs w
     WHERE w.customer_id = p_customer_id
       AND w.created_at::date BETWEEN p_start_date AND p_end_date
  )
  SELECT t.tx_date AS transaction_date,
         t.tx_type AS transaction_type,
         t.ref_num AS reference_number,
         t.descr AS description,
         t.debit AS debit_cents,
         t.credit AS credit_cents,
         (SUM(t.debit - t.credit) OVER (ORDER BY t.tx_date, t.tx_type, t.ref_num))::bigint AS running_balance_cents
    FROM all_transactions t
   ORDER BY t.tx_date, t.tx_type, t.ref_num;
END;
$function$;
