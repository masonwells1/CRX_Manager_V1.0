-- CodeRabbit closeout correction: customer transaction review must advance its
-- running balance once per returned row. The previous default RANGE frame
-- grouped same-date/type/reference payment allocations as peers, so every peer
-- displayed the balance after the whole group. This forward-only re-emission
-- adds a hidden stable UUID tie-breaker and an explicit ROWS frame. Stored money
-- and the public return shape are unchanged.

DO $preflight$
DECLARE
  v_source text;
BEGIN
  SELECT p.prosrc
    INTO v_source
    FROM pg_proc p
   WHERE p.oid = 'public.get_customer_transaction_review(uuid,date,date)'::regprocedure;

  IF md5(v_source) <> 'ca016ab0f94d0d809efd3be1094a3a84'
     OR NOT (SELECT p.prosecdef
               FROM pg_proc p
              WHERE p.oid = 'public.get_customer_transaction_review(uuid,date,date)'::regprocedure)
     OR ('search_path=public, pg_temp' = ANY (
          SELECT unnest(p.proconfig)
            FROM pg_proc p
           WHERE p.oid = 'public.get_customer_transaction_review(uuid,date,date)'::regprocedure
        )) IS NOT TRUE
     OR has_function_privilege('anon', 'public.get_customer_transaction_review(uuid,date,date)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.get_customer_transaction_review(uuid,date,date)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.get_customer_transaction_review(uuid,date,date)', 'EXECUTE') THEN
    RAISE EXCEPTION 'PRECONDITION: get_customer_transaction_review live contract drifted';
  END IF;
END;
$preflight$;

CREATE OR REPLACE FUNCTION public.get_customer_transaction_review(
  p_customer_id uuid,
  p_start_date date,
  p_end_date date
)
RETURNS TABLE(
  transaction_date date,
  transaction_type text,
  reference_number text,
  description text,
  debit_cents bigint,
  credit_cents bigint,
  running_balance_cents bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  PERFORM public.require_admin();
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
           0::bigint AS credit,
           i.id AS source_row_id
      FROM public.invoices i
     WHERE i.customer_id = p_customer_id
       AND i.status IN ('posted', 'paid', 'overdue')
       AND i.deleted_at IS NULL
       AND i.invoice_date BETWEEN p_start_date AND p_end_date

    UNION ALL

    SELECT als.payment_date,
           'Payment',
           COALESCE(als.reference_number, als.check_number, 'PMT-' || LEFT(als.id::text, 8)),
           COALESCE(als.payment_method, 'Payment') ||
             CASE WHEN als.check_number IS NOT NULL THEN ' #' || als.check_number ELSE '' END ||
             COALESCE(' — ' || als.notes, ''),
           0::bigint,
           ila.amount_cents,
           ila.id
      FROM public.allocation_sets als
      JOIN public.invoice_line_allocations ila ON ila.allocation_set_id = als.id
     WHERE als.customer_id = p_customer_id
       AND als.entity_type = 'payment'
       AND als.is_active = true
       AND als.payment_date BETWEEN p_start_date AND p_end_date

    UNION ALL

    SELECT pa.applied_at::date,
           'Prepay Applied',
           'PP-' || LEFT(pa.id::text, 8),
           'Prepay credit applied',
           0::bigint,
           pa.applied_amount_cents,
           pa.id
      FROM public.prepay_applications pa
      JOIN public.invoices i ON i.id = pa.invoice_id
     WHERE i.customer_id = p_customer_id
       AND i.deleted_at IS NULL
       AND pa.applied_at::date BETWEEN p_start_date AND p_end_date

    UNION ALL

    SELECT w.created_at::date,
           'Write-Off',
           'WO-' || LEFT(w.id::text, 8),
           COALESCE(w.reason, 'Write-off'),
           0::bigint,
           w.amount_cents,
           w.id
      FROM public.write_offs w
     WHERE w.customer_id = p_customer_id
       AND w.reversed_at IS NULL
       AND w.created_at::date BETWEEN p_start_date AND p_end_date
  )
  SELECT t.tx_date,
         t.tx_type,
         t.ref_num,
         t.descr,
         t.debit,
         t.credit,
         (SUM(t.debit - t.credit) OVER (
           ORDER BY t.tx_date, t.tx_type, t.ref_num, t.source_row_id
           ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
         ))::bigint
    FROM all_transactions t
   ORDER BY t.tx_date, t.tx_type, t.ref_num, t.source_row_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_customer_transaction_review(uuid, date, date)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_customer_transaction_review(uuid, date, date)
  TO authenticated, service_role;

DO $postflight$
DECLARE
  v_source text;
BEGIN
  SELECT p.prosrc
    INTO v_source
    FROM pg_proc p
   WHERE p.oid = 'public.get_customer_transaction_review(uuid,date,date)'::regprocedure;

  IF md5(v_source) <> 'ed2b798d1a16221b4d886bd6944eb762'
     OR v_source NOT LIKE '%ila.id%'
     OR v_source NOT LIKE '%ORDER BY t.tx_date, t.tx_type, t.ref_num, t.source_row_id%'
     OR v_source NOT LIKE '%ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW%'
     OR NOT (SELECT p.prosecdef
               FROM pg_proc p
              WHERE p.oid = 'public.get_customer_transaction_review(uuid,date,date)'::regprocedure)
     OR ('search_path=public, pg_temp' = ANY (
          SELECT unnest(p.proconfig)
            FROM pg_proc p
           WHERE p.oid = 'public.get_customer_transaction_review(uuid,date,date)'::regprocedure
        )) IS NOT TRUE
     OR has_function_privilege('anon', 'public.get_customer_transaction_review(uuid,date,date)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.get_customer_transaction_review(uuid,date,date)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.get_customer_transaction_review(uuid,date,date)', 'EXECUTE')
     OR (SELECT count(*)
           FROM pg_proc p
          WHERE p.pronamespace = 'public'::regnamespace
            AND p.proname = 'get_customer_transaction_review') <> 1 THEN
    RAISE EXCEPTION 'POSTFLIGHT: deterministic transaction review contract missing';
  END IF;
END;
$postflight$;
