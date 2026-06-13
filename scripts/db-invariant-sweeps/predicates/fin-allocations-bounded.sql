-- =============================================================================
-- fin-allocations-bounded.sql — payment allocations bounded by payment amount
-- C9 financial identity suite (docs/audits/2026-06-10-error-prevention-review.md §4)
--
-- IDENTITY
--   For every payment allocation set (allocation_sets.entity_type = 'payment'):
--     1. SUM(invoice_line_allocations.amount_cents) <= total_payment_cents
--        (allocate_payment routes any remainder to a prepay credit, so the sum
--        can be LESS than the payment, never more);
--     2. the cached allocation_sets.total_allocated_cents equals
--        SUM(invoice_line_allocations.amount_cents) exactly;
--     3. every allocation row under a payment set targets an invoice
--        (invoice_id IS NOT NULL — allocate_payment always writes it).
--
-- WOULD HAVE CAUGHT
--   The C9 "Σ allocations ≤ payment" live AR invariant (error-prevention review
--   §4). An over-allocated payment is the standing-data shape of the money-loss
--   bugs Codex caught in review: a loop that applies more cents to invoices
--   than the customer actually paid. The cache check catches partial-failure
--   writes (allocations inserted, summary UPDATE missed) — the same
--   silently-divergent-cache class as P1A.
--
-- EXPECTED RESULT
--   Zero rows. Every row is a violation. First column = stable identity key
--   'allocation_set:<uuid>' (one row per set per violated sub-identity).
--
-- KNOWN FALSE-POSITIVE MODES
--   * Voided sets (is_active = false) keep their allocation rows by design
--     (void_payment only flips is_active and reverses invoices); the bound and
--     the cache identity still hold for them, so they are NOT excluded. If a
--     future void path starts deleting allocation rows without zeroing
--     total_allocated_cents, the cache check will fire — that is a real drift,
--     not a false positive.
--   * entity_type 'order'/'invoice' sets are bill-to splits with a different
--     contract (split_percentage / invoice_item_id) and are excluded here.
--
-- SCHEMA FACTS (verified live 2026-06-10 against rhyzpcqhnizqbxphqdkr pg_catalog)
--   allocation_sets(id, entity_type CHECK IN ('order','invoice','payment'),
--     entity_id, customer_id, total_payment_cents, total_allocated_cents,
--     is_active, payment_method, reference_number, check_number, payment_date)
--   invoice_line_allocations(id, allocation_set_id, invoice_id, invoice_item_id,
--     amount_cents, bill_to_customer_id, split_percentage, split_invoice_id)
--   Writer: allocate_payment (inserts set + per-invoice rows, updates
--     total_allocated_cents after the loop). Reverser: void_payment.
-- =============================================================================
WITH payment_sets AS (
  SELECT
    s.id,
    s.customer_id,
    s.is_active,
    s.payment_date,
    COALESCE(s.reference_number, s.check_number, '')         AS payment_ref,
    s.total_payment_cents,
    s.total_allocated_cents,
    COALESCE(a.alloc_sum_cents, 0)                           AS alloc_sum_cents,
    COALESCE(a.null_invoice_rows, 0)                         AS null_invoice_rows
  FROM allocation_sets s
  LEFT JOIN (
    SELECT
      allocation_set_id,
      SUM(amount_cents)::bigint                              AS alloc_sum_cents,
      COUNT(*) FILTER (WHERE invoice_id IS NULL)::bigint     AS null_invoice_rows
    FROM invoice_line_allocations
    GROUP BY allocation_set_id
  ) a ON a.allocation_set_id = s.id
  WHERE s.entity_type = 'payment'
)
SELECT
  'allocation_set:' || ps.id::text                           AS identity_key,
  'over_allocated_payment'::text                             AS violation_type,
  ps.customer_id,
  ps.total_payment_cents                                     AS expected_cents,   -- upper bound
  ps.alloc_sum_cents                                         AS actual_cents,
  'allocated ' || ps.alloc_sum_cents::text || ' > payment ' || ps.total_payment_cents::text
    || ' (ref=' || ps.payment_ref || ', date=' || ps.payment_date::text
    || ', is_active=' || ps.is_active::text || ')'           AS detail
FROM payment_sets ps
WHERE ps.alloc_sum_cents > ps.total_payment_cents

UNION ALL

SELECT
  'allocation_set:' || ps.id::text,
  'allocated_cache_drift'::text,
  ps.customer_id,
  ps.alloc_sum_cents                                         AS expected_cents,   -- ledger truth
  COALESCE(ps.total_allocated_cents, 0)                      AS actual_cents,
  'cached total_allocated_cents=' || COALESCE(ps.total_allocated_cents, 0)::text
    || ' but SUM(invoice_line_allocations)=' || ps.alloc_sum_cents::text
    || ' (ref=' || ps.payment_ref || ', is_active=' || ps.is_active::text || ')'
FROM payment_sets ps
WHERE COALESCE(ps.total_allocated_cents, 0) <> ps.alloc_sum_cents

UNION ALL

SELECT
  'allocation_set:' || ps.id::text,
  'payment_allocation_missing_invoice'::text,
  ps.customer_id,
  0                                                          AS expected_cents,
  ps.null_invoice_rows                                       AS actual_cents,
  ps.null_invoice_rows::text || ' allocation row(s) under a payment set with NULL invoice_id'
FROM payment_sets ps
WHERE ps.null_invoice_rows > 0

ORDER BY violation_type, identity_key;
