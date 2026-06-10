-- =============================================================================
-- fin-ar-statement-balance.sql — customer statement net vs invoices-table AR
-- C9 financial identity suite (docs/audits/2026-06-10-error-prevention-review.md §4)
--
-- IDENTITY
--   For every customer, the all-time net of get_customer_statement's line-source
--   union (transcribed below from the LIVE function body, 2026-06-10) must equal
--   SUM(invoices.balance_cents) over that customer's posted/overdue/paid,
--   non-deleted invoices. Decomposed because the RPC is set-returning per
--   customer and cannot be executed inside a sweep predicate.
--
--   Statement side (transcription of get_customer_statement's txns CTE,
--   date window removed):
--     + SUM(total_amount_cents)            invoices, status='posted', deleted_at IS NULL
--                                          (credit memos carry NEGATIVE totals — issue_return_credit
--                                          inserts total_amount_cents = -v_total)
--     - SUM((amount * 100)::bigint)        payments INNER JOIN orders ON orders.id = payments.order_id
--                                          (NO deleted_at filter — transcribed as-is, that is the live body)
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
--   memo flowing into the statement through two union branches). Also catches,
--   as standing drift: payments recorded via allocate_payment (which writes
--   allocation_sets, NOT payments rows, and is therefore INVISIBLE to the
--   statement's payments-branch), 'overdue'/'paid'-status invoices silently
--   dropped from the statement's status='posted' filter, soft-deleted payments
--   still counted by the statement, and write-offs (absent from the statement
--   entirely).
--
-- EXPECTED RESULT
--   Zero rows. Every row is a violation. First column = stable identity key
--   ('customer:<uuid>' or 'credit_memo:<uuid>' or 'return:<uuid>').
--
-- KNOWN FALSE-POSITIVE MODES
--   * None for the credit-memo branches (those are hard identities).
--   * statement_balance_drift is a TRUE statement-vs-AR divergence, but the
--     root cause may be an intentional statement design gap rather than data
--     corruption (see WOULD HAVE CAUGHT list — e.g. the first allocate_payment
--     in production will flag every affected customer until the statement RPC
--     learns about allocation_sets). Triage with the diagnostic columns; move
--     accepted rows to the baseline in FIN-README.md, do not silently drop.
--   * Customers with zero activity on both sides produce no row by design.
--
-- SCHEMA FACTS (verified live 2026-06-10 against rhyzpcqhnizqbxphqdkr pg_catalog)
--   invoices(id, customer_id, invoice_type IN ('chemical_sale','field_application',
--     'misc_charge','credit_memo'), status IN ('draft','unposted','posted','paid',
--     'overdue','voided','cancelled'), total_amount_cents, paid_amount_cents,
--     prepay_applied_cents, write_off_cents, balance_cents GENERATED, deleted_at)
--   payments(id, order_id, customer_id, amount numeric DOLLARS, deleted_at)
--   prepay_applications(id, prepay_credit_id, invoice_id, applied_amount_cents)
--   prepay_credits(id, customer_id, ...)
--   returns(id, return_number, customer_id, status, total_credit_cents,
--     credit_invoice_id, deleted_at); return_items(return_id, extended_cents)
-- =============================================================================
WITH stmt_invoice_branch AS (
  -- branch 1 of the live txns CTE (date window removed)
  SELECT i.customer_id, i.id AS invoice_id, i.invoice_type, i.total_amount_cents AS amt
  FROM invoices i
  WHERE i.status = 'posted'
    AND i.deleted_at IS NULL
),
stmt_payment_branch AS (
  -- branch 2 of the live txns CTE (note: live body has NO payments.deleted_at filter)
  SELECT o.customer_id, p.id AS payment_id, (p.amount * 100)::bigint AS amt, p.deleted_at
  FROM payments p
  INNER JOIN orders o ON o.id = p.order_id
),
stmt_prepay_branch AS (
  -- branch 3 of the live txns CTE
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
    SELECT customer_id, -amt       FROM stmt_prepay_branch
  ) u
  GROUP BY customer_id
),
ar_side AS (
  SELECT
    i.customer_id,
    SUM(i.balance_cents)::bigint                                                       AS ar_open_cents,
    SUM(i.total_amount_cents) FILTER (WHERE i.status = 'overdue')::bigint              AS overdue_total_excluded_from_stmt_cents,
    SUM(i.total_amount_cents) FILTER (WHERE i.status = 'paid')::bigint                 AS paid_status_total_excluded_from_stmt_cents,
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
    SUM(amt)::bigint                                            AS stmt_payment_cents,
    SUM(amt) FILTER (WHERE deleted_at IS NOT NULL)::bigint      AS deleted_payments_in_stmt_cents
  FROM stmt_payment_branch
  GROUP BY customer_id
),
balance_drift AS (
  SELECT
    'customer:' || COALESCE(s.customer_id, a.customer_id)::text                AS identity_key,
    'statement_balance_drift'::text                                            AS violation_type,
    COALESCE(s.customer_id, a.customer_id)                                     AS customer_id,
    COALESCE(a.ar_open_cents, 0)                                               AS expected_cents,
    COALESCE(s.stmt_net_cents, 0)                                              AS actual_cents,
    'stmt_net - ar_open = ' || (COALESCE(s.stmt_net_cents, 0) - COALESCE(a.ar_open_cents, 0))::text
      || '; overdue_excluded=' || COALESCE(a.overdue_total_excluded_from_stmt_cents, 0)::text
      || '; paid_status_excluded=' || COALESCE(a.paid_status_total_excluded_from_stmt_cents, 0)::text
      || '; write_offs_invisible=' || COALESCE(a.write_offs_invisible_to_stmt_cents, 0)::text
      || '; paid_on_invoices_vs_stmt_payments=' || (COALESCE(a.invoice_paid_amount_cents, 0) - COALESCE(p.stmt_payment_cents, 0))::text
      || '; deleted_payments_counted=' || COALESCE(p.deleted_payments_in_stmt_cents, 0)::text AS detail
  FROM stmt_side s
  FULL OUTER JOIN ar_side a ON a.customer_id = s.customer_id
  LEFT JOIN pay_diag p ON p.customer_id = COALESCE(s.customer_id, a.customer_id)
  WHERE COALESCE(s.stmt_net_cents, 0) <> COALESCE(a.ar_open_cents, 0)
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
