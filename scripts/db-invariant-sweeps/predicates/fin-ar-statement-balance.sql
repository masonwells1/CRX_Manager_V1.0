-- =============================================================================
-- fin-ar-statement-balance.sql — customer statement net vs invoices-table AR
-- C9 financial identity suite (docs/audits/2026-06-10-error-prevention-review.md §4)
--
-- TRANSCRIPTION SYNC (2026-06-10, CHIP task_25d25699): the statement-side CTEs
-- below transcribe get_customer_statement's line-source union AS FIXED BY
-- migration 20260611131549_customer_statement_blind_spots (applied live
-- 2026-06-11 in the same work unit as this file; post-fix run = 0 rows):
--   * invoice branch now status IN ('posted','paid','overdue')
--   * payments branch now LEFT JOIN orders + COALESCE customer attribution
--     + payments.deleted_at IS NULL
--   * NEW allocation-set branch (allocate_payment-path payments)
-- If you change the RPC, change this transcription IN THE SAME WORK UNIT.
--
-- IDENTITY
--   For every customer, the all-time net of get_customer_statement's line-source
--   union (transcribed below, date window removed) must equal
--   SUM(invoices.balance_cents) over that customer's posted/overdue/paid,
--   non-deleted invoices, PLUS the customer's write-offs (write-offs remain
--   invisible to the statement by design — they surface only in the detail
--   column here; accepted rows go to the FIN-README baseline). Decomposed
--   because the RPC is set-returning per customer and cannot be executed
--   inside a sweep predicate.
--
--   Statement side (transcription of the FIXED txns CTE, date window removed):
--     + SUM(total_amount_cents)            invoices, status IN ('posted','paid','overdue'),
--                                          deleted_at IS NULL (credit memos carry NEGATIVE
--                                          totals — issue_return_credit inserts
--                                          total_amount_cents = -v_total)
--     - SUM((amount * 100)::bigint)        payments LEFT JOIN orders ON orders.id = payments.order_id,
--                                          customer = COALESCE(orders.customer_id, payments.customer_id),
--                                          payments.deleted_at IS NULL
--     - SUM(total_allocated_cents)         allocation_sets, entity_type='payment',
--                                          is_active, total_allocated_cents > 0
--                                          (invoice-applied portion ONLY; the
--                                          overpayment remainder flows through
--                                          prepay_applications when applied —
--                                          the migration's DEDUP RULE)
--     - SUM(applied_amount_cents)          prepay_applications JOIN prepay_credits (customer via prepay_credits)
--
--   Invoices side: SUM(balance_cents) where status IN ('posted','overdue','paid')
--   AND deleted_at IS NULL. balance_cents is GENERATED AS
--   (total_amount_cents - paid_amount_cents - prepay_applied_cents - write_off_cents).
--
--   Second branch (the exact B2 double-count shape): a credit_memo invoice id
--   must be claimed by AT MOST ONE credited return (returns.credit_invoice_id),
--   and the credit must be conserved: returns.total_credit_cents ==
--   SUM(return_items.extended_cents) == -credit_memo.total_amount_cents.
--   A credit memo reachable through MORE than one line source (statement invoice
--   branch + a second return claiming it) is precisely how B2 double-counted
--   return credits on statements.
--
-- WOULD HAVE CAUGHT
--   B2 — get_customer_statement double-counting return credits (the same credit
--   memo flowing into the statement through two union branches). The four
--   blind spots this predicate previously flagged as standing drift
--   (allocate_payment-path payments invisible; 'overdue'/'paid' invoices
--   dropped; soft-deleted payments counted; NULL-order_id payments excluded)
--   are FIXED in the RPC as of customer_statement_blind_spots. Still caught:
--   soft-deleted payments whose invoices.paid_amount_cents was never reversed
--   (no DB function soft-deletes payments today; a frontend soft-delete
--   without reversal is a TRUE violation), allocation-set prepay remainders
--   double-spent, and any future producer that bumps paid_amount_cents
--   without a statement-visible source. Write-offs are statement-invisible BY
--   DESIGN, so the identity is stmt_net == ar_open + write_offs (folded into
--   the WHERE below — write-off customers no longer false-positive; the
--   write_offs_invisible diagnostic still prints when other drift fires).
--
-- EXPECTED RESULT
--   Zero rows. Every row is a violation. First column = stable identity key
--   ('customer:<uuid>' or 'credit_memo:<uuid>' or 'return:<uuid>').
--
-- KNOWN FALSE-POSITIVE MODES
--   * None for the credit-memo branches (those are hard identities).
--   * statement_balance_drift is now a hard identity too (write-offs are
--     folded into the expected side: stmt_net must equal ar_open +
--     write_offs). Any remaining row is a TRUE statement-vs-AR divergence —
--     triage with the diagnostic columns; move ACCEPTED rows (deliberate
--     design gaps only) to the baseline in FIN-README.md, do not silently
--     drop.
--   * Customers with zero activity on both sides produce no row by design.
--
-- SCHEMA FACTS (verified live 2026-06-10 against rhyzpcqhnizqbxphqdkr pg_catalog)
--   invoices(id, customer_id, invoice_type IN ('chemical_sale','field_application',
--     'misc_charge','credit_memo'), status IN ('draft','unposted','posted','paid',
--     'overdue','voided','cancelled'), total_amount_cents, paid_amount_cents,
--     prepay_applied_cents, write_off_cents, balance_cents GENERATED, deleted_at)
--   payments(id, order_id NULLABLE, customer_id NOT NULL, amount numeric DOLLARS, deleted_at)
--   allocation_sets(id, entity_type IN ('order','invoice','payment'), entity_id,
--     customer_id, total_payment_cents, total_allocated_cents, payment_date,
--     is_active — void_payment retires payment-sets via is_active=false)
--   prepay_applications(id, prepay_credit_id, invoice_id, applied_amount_cents)
--   prepay_credits(id, customer_id, ...)
--   returns(id, return_number, customer_id, status, total_credit_cents,
--     credit_invoice_id, deleted_at); return_items(return_id, extended_cents)
-- =============================================================================
WITH stmt_invoice_branch AS (
  -- branch 1 of the FIXED txns CTE (date window removed)
  SELECT i.customer_id, i.id AS invoice_id, i.invoice_type, i.total_amount_cents AS amt
  FROM invoices i
  WHERE i.status IN ('posted', 'paid', 'overdue')
    AND i.deleted_at IS NULL
),
stmt_payment_branch AS (
  -- branch 2 of the FIXED txns CTE: LEFT JOIN + COALESCE attribution +
  -- deleted_at IS NULL (all three are now part of the live body)
  SELECT COALESCE(o.customer_id, p.customer_id) AS customer_id,
         p.id AS payment_id,
         (p.amount * 100)::bigint AS amt
  FROM payments p
  LEFT JOIN orders o ON o.id = p.order_id
  WHERE p.deleted_at IS NULL
),
stmt_alloc_branch AS (
  -- branch 3 of the FIXED txns CTE: allocate_payment-path payments.
  -- total_allocated_cents (invoice-applied portion) ONLY — the overpayment
  -- remainder is counted by the prepay branch when applied (DEDUP RULE).
  -- customer_id IS NOT NULL mirrors the RPC's customer_id = p_customer_id
  -- equality (a NULL customer can never match).
  SELECT a.customer_id,
         a.id AS allocation_set_id,
         COALESCE(a.total_allocated_cents, 0) AS amt
  FROM allocation_sets a
  WHERE a.entity_type = 'payment'
    AND a.is_active = true
    AND a.customer_id IS NOT NULL
    AND COALESCE(a.total_allocated_cents, 0) > 0
),
stmt_prepay_branch AS (
  -- branch 4 of the FIXED txns CTE
  SELECT pc.customer_id, pa.id AS application_id, pa.applied_amount_cents AS amt
  FROM prepay_applications pa
  INNER JOIN prepay_credits pc ON pc.id = pa.prepay_credit_id
),
stmt_side AS (
  SELECT customer_id, SUM(amt)::bigint AS stmt_net_cents
  FROM (
    SELECT customer_id, amt        FROM stmt_invoice_branch
    UNION ALL
    SELECT customer_id, -amt       FROM stmt_payment_branch
    UNION ALL
    SELECT customer_id, -amt       FROM stmt_alloc_branch
    UNION ALL
    SELECT customer_id, -amt       FROM stmt_prepay_branch
  ) u
  GROUP BY customer_id
),
ar_side AS (
  SELECT
    i.customer_id,
    SUM(i.balance_cents)::bigint                                                       AS ar_open_cents,
    SUM(i.write_off_cents)::bigint                                                     AS write_offs_invisible_to_stmt_cents,
    SUM(i.paid_amount_cents)::bigint                                                   AS invoice_paid_amount_cents
  FROM invoices i
  WHERE i.status IN ('posted', 'overdue', 'paid')
    AND i.deleted_at IS NULL
  GROUP BY i.customer_id
),
pay_diag AS (
  SELECT
    customer_id,
    SUM(amt)::bigint AS stmt_payment_cents
  FROM stmt_payment_branch
  GROUP BY customer_id
),
alloc_diag AS (
  SELECT
    customer_id,
    SUM(amt)::bigint AS stmt_alloc_cents
  FROM stmt_alloc_branch
  GROUP BY customer_id
),
deleted_pay_diag AS (
  -- soft-deleted payments are EXCLUDED from the statement (by design); if
  -- their invoices.paid_amount_cents was never reversed, the drift shows up
  -- here as the likely culprit.
  SELECT
    COALESCE(o.customer_id, p.customer_id) AS customer_id,
    SUM((p.amount * 100)::bigint)::bigint  AS deleted_payments_excluded_cents
  FROM payments p
  LEFT JOIN orders o ON o.id = p.order_id
  WHERE p.deleted_at IS NOT NULL
  GROUP BY COALESCE(o.customer_id, p.customer_id)
),
balance_drift AS (
  SELECT
    'customer:' || COALESCE(s.customer_id, a.customer_id)::text                AS identity_key,
    'statement_balance_drift'::text                                            AS violation_type,
    COALESCE(s.customer_id, a.customer_id)                                     AS customer_id,
    COALESCE(a.ar_open_cents, 0) + COALESCE(a.write_offs_invisible_to_stmt_cents, 0) AS expected_cents,
    COALESCE(s.stmt_net_cents, 0)                                              AS actual_cents,
    'stmt_net - (ar_open + write_offs) = '
      || (COALESCE(s.stmt_net_cents, 0) - COALESCE(a.ar_open_cents, 0) - COALESCE(a.write_offs_invisible_to_stmt_cents, 0))::text
      || '; write_offs_invisible=' || COALESCE(a.write_offs_invisible_to_stmt_cents, 0)::text
      || '; paid_on_invoices_vs_stmt_payment_sources='
      || (COALESCE(a.invoice_paid_amount_cents, 0) - COALESCE(p.stmt_payment_cents, 0) - COALESCE(al.stmt_alloc_cents, 0))::text
      || '; stmt_payments=' || COALESCE(p.stmt_payment_cents, 0)::text
      || '; stmt_allocations=' || COALESCE(al.stmt_alloc_cents, 0)::text
      || '; deleted_payments_excluded=' || COALESCE(d.deleted_payments_excluded_cents, 0)::text AS detail
  FROM stmt_side s
  FULL OUTER JOIN ar_side a ON a.customer_id = s.customer_id
  LEFT JOIN pay_diag p          ON p.customer_id  = COALESCE(s.customer_id, a.customer_id)
  LEFT JOIN alloc_diag al       ON al.customer_id = COALESCE(s.customer_id, a.customer_id)
  LEFT JOIN deleted_pay_diag d  ON d.customer_id  = COALESCE(s.customer_id, a.customer_id)
  WHERE COALESCE(s.stmt_net_cents, 0)
        <> COALESCE(a.ar_open_cents, 0) + COALESCE(a.write_offs_invisible_to_stmt_cents, 0)
),
credit_memo_multi_source AS (
  -- B2 shape: one credit memo reachable via more than one return-credit line source
  SELECT
    'credit_memo:' || r.credit_invoice_id::text                                AS identity_key,
    'credit_memo_in_multiple_line_sources'::text                               AS violation_type,
    MIN(r.customer_id::text)::uuid                                             AS customer_id,
    1::bigint                                                                  AS expected_cents,   -- exactly one claiming return
    COUNT(*)::bigint                                                           AS actual_cents,     -- number of claiming returns
    'credit memo claimed by returns: ' || string_agg(r.return_number, ', ' ORDER BY r.return_number) AS detail
  FROM returns r
  WHERE r.credit_invoice_id IS NOT NULL
    AND r.status = 'credited'
    AND r.deleted_at IS NULL
  GROUP BY r.credit_invoice_id
  HAVING COUNT(*) > 1
),
credit_conservation AS (
  -- the dollar identity behind B2: return credit == its items == -credit memo total
  SELECT
    'return:' || r.id::text                                                    AS identity_key,
    'return_credit_not_conserved'::text                                        AS violation_type,
    r.customer_id                                                              AS customer_id,
    COALESCE(r.total_credit_cents, 0)                                          AS expected_cents,
    COALESCE(-i.total_amount_cents, 0)                                         AS actual_cents,
    'return ' || r.return_number
      || ': total_credit_cents=' || COALESCE(r.total_credit_cents, 0)::text
      || ', sum(return_items)=' || COALESCE(ri.items_cents, 0)::text
      || ', -credit_memo.total=' || COALESCE(-i.total_amount_cents, 0)::text
      || ', credit_memo=' || COALESCE(i.invoice_number, '<missing>')           AS detail
  FROM returns r
  LEFT JOIN invoices i ON i.id = r.credit_invoice_id
  LEFT JOIN (
    SELECT return_id, SUM(extended_cents)::bigint AS items_cents
    FROM return_items
    GROUP BY return_id
  ) ri ON ri.return_id = r.id
  WHERE r.status = 'credited'
    AND r.deleted_at IS NULL
    AND (
      i.id IS NULL
      OR COALESCE(r.total_credit_cents, 0) <> COALESCE(-i.total_amount_cents, 0)
      OR COALESCE(r.total_credit_cents, 0) <> COALESCE(ri.items_cents, 0)
    )
)
SELECT * FROM balance_drift
UNION ALL
SELECT * FROM credit_memo_multi_source
UNION ALL
SELECT * FROM credit_conservation
ORDER BY violation_type, identity_key;
