-- =============================================================================
-- fin-prepay-balance.sql — prepay cached balances vs derivable ledger sums
-- C9 financial identity suite (docs/audits/2026-06-10-error-prevention-review.md §4)
--
-- IDENTITY
--   Two cached-balance identities on the prepay subsystem:
--     1. customer cache: customers.prepay_balance_cents ==
--        SUM(prepay_credits.balance_cents) for that customer (0 when none).
--     2. credit ledger:  prepay_credits.balance_cents ==
--        original_amount_cents - SUM(prepay_applications.applied_amount_cents).
--   Identity 2 is actively maintained by the _recompute_prepay_credit_balance
--   trigger on prepay_applications, so any drift means a path mutated
--   balance_cents directly without an application row.
--
-- WOULD HAVE CAUGHT
--   The silently-divergent-cache class behind P1A (a cached money column the
--   write path forgets or rewrites). Concretely live today: void_payment zeroes
--   an overpayment credit by matching prepay_credits.source_reference =
--   <allocation_set_id>::text, but allocate_payment WRITES source_reference as
--   'From payment ' || COALESCE(reference, check, set_id) — the lookup can
--   never match, so voiding a payment strands the overpayment credit AND
--   customers.prepay_balance_cents. The first production void of an
--   overpaying payment will surface here as customer_prepay_cache_drift
--   (cache too high vs nothing reversed) or as a stranded live credit.
--
-- EXPECTED RESULT
--   Zero rows. Every row is a violation. First column = stable identity key
--   ('customer:<uuid>' or 'prepay_credit:<uuid>').
--
-- KNOWN FALSE-POSITIVE MODES
--   * Credits zeroed by void_payment legitimately violate identity 2 (balance
--     forced to 0 with no application rows). Those rows are excluded by the
--     marker void_payment writes: notes containing '[VOIDED:' AND balance = 0.
--     This is a TEXT marker — if the void path's note format changes, voided
--     credits will reappear as violations (re-baseline, then fix the marker).
--     Note: because of the source_reference bug above, this exclusion currently
--     never matches anything in practice.
--   * edit_prepay_credit / delete_prepay_credit adjust original_amount_cents
--     and the customer cache together; a half-applied edit (one side updated)
--     is a REAL violation, not a false positive.
--
-- SCHEMA FACTS (verified live 2026-06-10 against rhyzpcqhnizqbxphqdkr pg_catalog)
--   customers(id, farm_name, prepay_balance_cents bigint NULLable)
--   prepay_credits(id, customer_id, original_amount_cents, balance_cents
--     CHECK >= 0, source_type, source_reference, notes)
--   prepay_applications(id, prepay_credit_id, invoice_id, applied_amount_cents)
--     — immutable after insert (_guard_prepay_applications_immutable) except
--     under app.bypass_ledger_immutability (used by void_invoice restore path).
--   Writers of customers.prepay_balance_cents: allocate_payment (+ overpayment),
--     apply_prepay_to_invoice (-, GREATEST 0 clamp), void_payment (- reversal,
--     GREATEST 0 clamp), edit/delete_prepay_credit.
-- =============================================================================
WITH credit_sums AS (
  SELECT
    pc.id,
    pc.customer_id,
    pc.original_amount_cents,
    pc.balance_cents,
    pc.source_type,
    pc.notes,
    COALESCE(pa.applied_cents, 0) AS applied_cents
  FROM prepay_credits pc
  LEFT JOIN (
    SELECT prepay_credit_id, SUM(applied_amount_cents)::bigint AS applied_cents
    FROM prepay_applications
    GROUP BY prepay_credit_id
  ) pa ON pa.prepay_credit_id = pc.id
),
customer_ledger AS (
  SELECT customer_id, SUM(balance_cents)::bigint AS ledger_balance_cents
  FROM prepay_credits
  GROUP BY customer_id
)

SELECT
  'customer:' || c.id::text                                  AS identity_key,
  'customer_prepay_cache_drift'::text                        AS violation_type,
  c.id                                                       AS customer_id,
  COALESCE(cl.ledger_balance_cents, 0)                       AS expected_cents,  -- ledger truth
  COALESCE(c.prepay_balance_cents, 0)                        AS actual_cents,    -- cached column
  'customer ' || c.farm_name
    || ': cached prepay_balance_cents=' || COALESCE(c.prepay_balance_cents, 0)::text
    || ' but SUM(prepay_credits.balance_cents)=' || COALESCE(cl.ledger_balance_cents, 0)::text AS detail
FROM customers c
LEFT JOIN customer_ledger cl ON cl.customer_id = c.id
WHERE COALESCE(c.prepay_balance_cents, 0) <> COALESCE(cl.ledger_balance_cents, 0)

UNION ALL

SELECT
  'prepay_credit:' || cs.id::text,
  'credit_ledger_drift'::text,
  cs.customer_id,
  cs.original_amount_cents - cs.applied_cents                AS expected_cents,  -- derivable ledger value
  cs.balance_cents                                           AS actual_cents,
  'credit (source_type=' || COALESCE(cs.source_type, '?')
    || '): balance_cents=' || cs.balance_cents::text
    || ' but original ' || cs.original_amount_cents::text
    || ' - applied ' || cs.applied_cents::text
    || ' = ' || (cs.original_amount_cents - cs.applied_cents)::text
FROM credit_sums cs
WHERE cs.balance_cents <> (cs.original_amount_cents - cs.applied_cents)
  -- documented exclusion: credits zeroed by void_payment (see header)
  AND NOT (cs.balance_cents = 0 AND cs.notes LIKE '%[VOIDED:%')

ORDER BY violation_type, identity_key;
