-- ============================================================================
-- customer_statement_blind_spots — get_customer_statement: close the 4 AR
-- blind spots (CHIP task_25d25699, production money bug)
-- ----------------------------------------------------------------------------
-- STAGED DRAFT (DRAFT role, 2026-06-10). Lives in scripts/.staging-migrations/
-- per the race guard — only the APPLY role moves this under supabase/migrations/
-- post-review, stamped with the MCP-assigned version.
--
-- BUG (4 blind spots in the LIVE body, all verified against the live catalog
-- 2026-06-10 on rhyzpcqhnizqbxphqdkr):
--   (1) allocate_payment-path payments are INVISIBLE. allocate_payment writes
--       allocation_sets (entity_type='payment', entity_id=customer_id) +
--       invoice_line_allocations + an overpayment prepay_credit — it NEVER
--       inserts a payments row. The statement reads only payments, so every
--       payment recorded through PaymentAllocation's allocate_payment path
--       drops a charge-only line set on the statement: the customer looks
--       perpetually unpaid.
--   (2) Invoice branch filters status = 'posted' ONLY. record_invoice_payment
--       and allocate_payment both flip a fully-paid invoice posted->'paid'
--       (and mark_overdue_invoices flips posted->'overdue'), so the moment an
--       invoice is paid its +charge line VANISHES while its -payment lines
--       remain -> orphan negative running balance.
--   (3) No payments.deleted_at IS NULL filter — soft-deleted payments still
--       count against the customer.
--   (4) INNER JOIN orders ON o.id = p.order_id excludes NULL-order_id
--       payments. record_invoice_payment copies invoices.order_id, which is
--       NULL for order-less invoices (e.g. transfer_job_to_invoice's
--       field_application invoices) -> those payments are invisible too.
--
-- LIVE EVIDENCE (read 2026-06-10 via pg_get_functiondef / pg_catalog):
--   * Baseline md5(prosrc) of public.get_customer_statement(uuid,date,date):
--       c3b4056129d56cf97f3739269e6571fa
--     (exactly 1 overload; STABLE SECURITY DEFINER; search_path
--     'public','pg_temp'; live ACL: PUBLIC/anon/authenticated/postgres/
--     service_role EXECUTE.)
--   * payments and allocation_sets are BOTH EMPTY live (0 rows each) — this
--     fix is forward-looking; no historical statement output changes besides
--     the (2) status-filter widening for existing paid/overdue invoices.
--   * invoices_status_check: status IN ('draft','unposted','posted','paid',
--     'overdue','voided','cancelled') — 'posted','paid','overdue' are all in
--     the CHECK set (status-literal rule satisfied).
--   * payments.amount is numeric DOLLARS (legacy); the live body's
--     -(p.amount * 100)::bigint cents conversion is kept verbatim. All other
--     amounts are bigint cents (total_amount_cents, total_allocated_cents,
--     applied_amount_cents). No float math anywhere.
--   * Writer disjointness (the DEDUP foundation): record_invoice_payment is
--     the ONLY function inserting into payments (full pg_proc prosrc scan);
--     allocate_payment is the ONLY producer of entity_type='payment'
--     allocation_sets rows; neither writes the other's table, and there is no
--     FK/linkage between payments and allocation_sets. void_payment retires an
--     allocation-set payment by setting is_active=false (and reverses the
--     invoices' paid_amount_cents), so is_active=true is the liveness filter
--     for that branch — exactly parallel to payments.deleted_at IS NULL.
--
-- DEDUP RULE (documented per task; how the union avoids double-counting):
--   * payments-table branch vs allocation-set branch: DISJOINT BY
--     CONSTRUCTION (see writer disjointness above). A payment exists in
--     exactly one of the two tables, so the UNION ALL of the two branches
--     counts each payment exactly once. Verified live: zero heuristic
--     overlaps (same customer+date+amount) — trivially, both tables are
--     empty.
--   * allocation-set branch vs prepay branch (the REAL double-count risk):
--     allocate_payment splits p_total_cents into total_allocated_cents
--     (applied to invoices NOW) + an overpayment remainder routed to
--     prepay_credits. The statement already counts prepay money when it is
--     APPLIED (prepay_applications branch). The allocation-set line therefore
--     uses total_allocated_cents — NOT total_payment_cents — so the prepay
--     remainder is counted exactly once, later, by the existing prepay
--     branch when it is applied to an invoice. (Counting total_payment_cents
--     would double-count the remainder: once at receipt + once at
--     application.) This also matches the legacy branch's semantics:
--     record_invoice_payment rows are 100% invoice-applied by construction
--     (amount <= balance enforced in-function).
--   * Sets with total_allocated_cents = 0 (everything went to prepay) emit
--     no line — the money surfaces via the prepay branch on application.
--
-- BODY: reproduced VERBATIM from the live prosrc (baseline md5 above — the
-- LIVE text, which carries no inline comments; NOT the 20260609191504 disk
-- text, whose comments were stripped at apply time). Deltas, EXHAUSTIVELY,
-- each bracketed by [CSB-DELTA-n BEGIN]/[CSB-DELTA-n END] sentinels:
--   DELTA-1 (invoice branch): i.status = 'posted'
--           -> i.status IN ('posted', 'paid', 'overdue').
--           Fixes blind spot (2). voided/cancelled/draft/unposted stay
--           excluded (unchanged).
--   DELTA-2 (payments branch): INNER JOIN orders -> LEFT JOIN orders, and
--           WHERE o.customer_id = p_customer_id ->
--           WHERE COALESCE(o.customer_id, p.customer_id) = p_customer_id.
--           Fixes blind spot (4). Conservative attribution: order-linked
--           payments keep the legacy o.customer_id attribution byte-for-byte;
--           p.customer_id (NOT NULL) is consulted only when order_id IS NULL.
--           Live check: 0 payments rows where o.customer_id <> p.customer_id.
--   DELTA-3 (payments branch): added AND p.deleted_at IS NULL.
--           Fixes blind spot (3).
--   DELTA-4 (new UNION ALL branch): allocation-set payments. Fixes blind
--           spot (1). entity_type='payment' AND is_active = true AND
--           customer_id = p_customer_id; amount = -total_allocated_cents
--           (see DEDUP RULE); txn_type 'payment' (same as the legacy branch —
--           the UI renders both identically); ref =
--           COALESCE(reference_number, check_number, '') mirroring
--           void_payment's display preference; descr guards NULL
--           payment_method with COALESCE(..,'other') ('other' is in
--           payments_payment_method_check — familiar vocabulary, though this
--           text column is unconstrained); date =
--           COALESCE(payment_date, created_at::date) because
--           allocate_payment's p_payment_date parameter can be passed NULL
--           explicitly (DEFAULT only covers omission) and an invisible-when-
--           NULL-date payment would recreate blind spot (1).
--   NO other text changed. Declared RETURN TABLE shape is byte-identical
--   (running_balance bigint + the (SUM(..) OVER ..)::bigint cast retained —
--   the 42804 lesson; every branch's amt is bigint, incl.
--   -COALESCE(a.total_allocated_cents, 0)).
--
-- KNOWN GAPS LEFT IN PLACE (out of scope, conservative fix only):
--   * write_offs are still invisible to the statement (statement net vs
--     SUM(invoices.balance_cents) diverges by write_off_cents — flagged by
--     the fin-ar-statement-balance sweep's diagnostic column, baseline per
--     FIN-README).
--   * anon/PUBLIC EXECUTE on this fn is the accepted grant-debt class (the
--     in-body admin/sales_rep gate is the control) — posture unchanged here.
--
-- CO-CHANGE (same work unit — MUST land together):
--   scripts/db-invariant-sweeps/predicates/fin-ar-statement-balance.sql
--   transcribes this function's line-source union; its transcription is
--   updated in this same change set to the post-DELTA body. Do not apply one
--   without the other or the predicate false-positives/negatives forever.
--
-- SMOKE: scripts/smoke/smoke-customer_statement_blind_spots.sql (rolled-back
-- chain; legacy + NULL-order + allocation payments each exactly once,
-- paid/overdue invoices included, soft-deleted payment excluded, credit memo
-- single-count, prepay remainder NOT pre-counted, running balance never
-- negative, idempotent allocate_payment replay does not double-count).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_customer_statement(p_customer_id uuid, p_start_date date DEFAULT ((CURRENT_DATE - '90 days'::interval))::date, p_end_date date DEFAULT CURRENT_DATE)
 RETURNS TABLE(transaction_date date, transaction_type text, reference_number text, description text, amount_cents bigint, running_balance bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = auth.uid() AND is_active = true AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'Access denied: admin or sales_rep role required';
  END IF;

  RETURN QUERY
  WITH txns AS (
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
      -- [CSB-DELTA-1 BEGIN] paid/overdue invoices must keep their charge line
      AND i.status IN ('posted', 'paid', 'overdue')
      -- [CSB-DELTA-1 END]
      AND i.deleted_at IS NULL
      AND i.invoice_date::date BETWEEN p_start_date AND p_end_date

    UNION ALL

    SELECT
      p.payment_date::date AS txn_date,
      'payment' AS txn_type,
      COALESCE(p.reference_number, '') AS ref_num,
      'Payment - ' || p.payment_method AS descr,
      -(p.amount * 100)::bigint AS amt
    FROM payments p
    -- [CSB-DELTA-2 BEGIN] NULL-order_id payments (order-less invoices) included
    LEFT JOIN orders o ON o.id = p.order_id
    WHERE COALESCE(o.customer_id, p.customer_id) = p_customer_id
      -- [CSB-DELTA-2 END]
      -- [CSB-DELTA-3 BEGIN] soft-deleted payments excluded
      AND p.deleted_at IS NULL
      -- [CSB-DELTA-3 END]
      AND p.payment_date::date BETWEEN p_start_date AND p_end_date

    UNION ALL

    -- [CSB-DELTA-4 BEGIN] allocate_payment-path payments (allocation_sets,
    -- never payments rows). Amount = invoice-applied portion ONLY
    -- (total_allocated_cents); the overpayment remainder is counted by the
    -- prepay branch below when applied — see header DEDUP RULE.
    SELECT
      COALESCE(a.payment_date, a.created_at::date) AS txn_date,
      'payment' AS txn_type,
      COALESCE(a.reference_number, a.check_number, '') AS ref_num,
      'Payment - ' || COALESCE(a.payment_method, 'other') AS descr,
      -COALESCE(a.total_allocated_cents, 0) AS amt
    FROM allocation_sets a
    WHERE a.entity_type = 'payment'
      AND a.is_active = true
      AND a.customer_id = p_customer_id
      AND COALESCE(a.total_allocated_cents, 0) > 0
      AND COALESCE(a.payment_date, a.created_at::date) BETWEEN p_start_date AND p_end_date
    -- [CSB-DELTA-4 END]

    UNION ALL

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

-- ----------------------------------------------------------------------------
-- Grants: RESTATED VERBATIM from the live ACL — no posture change.
-- caller-analysis: get_customer_statement — read-only statement RPC; frontend
-- callers reach it via supabase.rpc('get_customer_statement') (customer
-- statement views/PDF). Live ACL already grants EXECUTE to PUBLIC, anon,
-- authenticated, service_role; anon/PUBLIC EXECUTE is the documented accepted
-- grant-debt class (CLAUDE.md Schema Gotchas) — the in-body admin/sales_rep
-- gate is the control. CREATE OR REPLACE preserves the existing ACL; these
-- grants restate it so a from-scratch rebuild converges to the same posture.
-- ----------------------------------------------------------------------------
GRANT EXECUTE ON FUNCTION public.get_customer_statement(uuid, date, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_customer_statement(uuid, date, date) TO anon;
GRANT EXECUTE ON FUNCTION public.get_customer_statement(uuid, date, date) TO service_role;

-- ----------------------------------------------------------------------------
-- Self-verification
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  v_count int;
  v_src   text;
  v_ret   text;
BEGIN
  -- Exactly one overload
  SELECT count(*) INTO v_count
  FROM pg_proc
  WHERE proname = 'get_customer_statement' AND pronamespace = 'public'::regnamespace;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'get_customer_statement overload count = %, expected 1', v_count;
  END IF;

  SELECT prosrc INTO v_src
  FROM pg_proc
  WHERE proname = 'get_customer_statement' AND pronamespace = 'public'::regnamespace;

  -- All four sentinel-delimited deltas present in the deployed body
  IF v_src NOT LIKE '%[CSB-DELTA-1 BEGIN]%' OR v_src NOT LIKE '%[CSB-DELTA-1 END]%'
     OR v_src NOT LIKE '%[CSB-DELTA-2 BEGIN]%' OR v_src NOT LIKE '%[CSB-DELTA-2 END]%'
     OR v_src NOT LIKE '%[CSB-DELTA-3 BEGIN]%' OR v_src NOT LIKE '%[CSB-DELTA-3 END]%'
     OR v_src NOT LIKE '%[CSB-DELTA-4 BEGIN]%' OR v_src NOT LIKE '%[CSB-DELTA-4 END]%' THEN
    RAISE EXCEPTION 'get_customer_statement: a CSB-DELTA sentinel pair is missing from prosrc';
  END IF;

  -- Delta substance present
  IF v_src NOT LIKE '%i.status IN (''posted'', ''paid'', ''overdue'')%' THEN
    RAISE EXCEPTION 'get_customer_statement: DELTA-1 status-set widening missing';
  END IF;
  IF v_src NOT LIKE '%LEFT JOIN orders o ON o.id = p.order_id%'
     OR v_src NOT LIKE '%COALESCE(o.customer_id, p.customer_id) = p_customer_id%' THEN
    RAISE EXCEPTION 'get_customer_statement: DELTA-2 LEFT JOIN / attribution missing';
  END IF;
  IF v_src NOT LIKE '%p.deleted_at IS NULL%' THEN
    RAISE EXCEPTION 'get_customer_statement: DELTA-3 payments.deleted_at filter missing';
  END IF;
  IF v_src NOT LIKE '%FROM allocation_sets a%'
     OR v_src NOT LIKE '%a.entity_type = ''payment''%'
     OR v_src NOT LIKE '%a.is_active = true%'
     OR v_src NOT LIKE '%-COALESCE(a.total_allocated_cents, 0) AS amt%' THEN
    RAISE EXCEPTION 'get_customer_statement: DELTA-4 allocation-set branch missing/incomplete';
  END IF;

  -- The legacy INNER JOIN must be gone (only orders join in this fn)
  IF v_src LIKE '%INNER JOIN orders%' THEN
    RAISE EXCEPTION 'get_customer_statement: legacy INNER JOIN orders still present';
  END IF;

  -- 42804 regression guard: the window-sum bigint cast must survive
  IF v_src NOT LIKE '%(SUM(t.amt) OVER (ORDER BY t.txn_date, t.txn_type))::bigint%' THEN
    RAISE EXCEPTION 'get_customer_statement: running_balance bigint cast missing (42804 class)';
  END IF;

  -- SECDEF + search_path + STABLE retained
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE proname = 'get_customer_statement' AND pronamespace = 'public'::regnamespace
      AND prosecdef AND provolatile = 's'
      AND array_to_string(proconfig, ',') LIKE '%search_path%'
  ) THEN
    RAISE EXCEPTION 'get_customer_statement must be STABLE SECURITY DEFINER with search_path';
  END IF;

  -- Declared return shape unchanged (bigint money columns)
  SELECT pg_get_function_result(oid) INTO v_ret
  FROM pg_proc
  WHERE proname = 'get_customer_statement' AND pronamespace = 'public'::regnamespace;
  IF v_ret <> 'TABLE(transaction_date date, transaction_type text, reference_number text, description text, amount_cents bigint, running_balance bigint)' THEN
    RAISE EXCEPTION 'get_customer_statement return shape changed: %', v_ret;
  END IF;

  -- ACL preserved (live posture: authenticated + anon + service_role EXECUTE)
  IF NOT has_function_privilege('authenticated', 'public.get_customer_statement(uuid,date,date)', 'EXECUTE') THEN
    RAISE EXCEPTION 'get_customer_statement: authenticated lost EXECUTE';
  END IF;
  IF NOT has_function_privilege('anon', 'public.get_customer_statement(uuid,date,date)', 'EXECUTE') THEN
    RAISE EXCEPTION 'get_customer_statement: anon EXECUTE dropped — live posture was anon-executable (accepted grant-debt); a posture change must go through the grant gate deliberately, not as a side effect';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.get_customer_statement(uuid,date,date)', 'EXECUTE') THEN
    RAISE EXCEPTION 'get_customer_statement: service_role lost EXECUTE';
  END IF;
END $$;
