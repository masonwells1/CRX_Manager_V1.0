-- =============================================================================
-- fin-vendor-bill-balance-identity.sql — AP mirror of the AR balance identity
-- C9 financial identity suite (docs/audits/2026-06-10-error-prevention-review.md §4)
--
-- WHY THIS GAP EXISTED
--   The fin-* suite covered the money we are OWED (invoice balance, allocations,
--   AR statement, prepay, commission splits, quote overrides) but nothing on the
--   money we OWE. vendor_bills carries the same cached-component shape as
--   invoices — a GENERATED balance over a cached paid_cents whose ledger lives in
--   another table — so it carries the same drift class, unchecked until now.
--
-- IDENTITY
--   vendor_bills.balance_cents is GENERATED ALWAYS AS
--     (total_cents - COALESCE(paid_cents, 0))
--   so the generated column cannot drift — but its inputs can. For every
--   non-deleted, non-voided bill:
--     1. paid_cents  == SUM(vendor_payments.amount_cents WHERE voided_at IS NULL)
--     2. total_cents == subtotal_cents + COALESCE(adjustment_cents, 0)
--        (a DB CHECK enforces this today; the predicate is the standing proof it
--        is still enforced after any future migration relaxes the constraint)
--     3. balance_cents >= 0 — a vendor bill is never overpaid
--     4. status is the function of the balance:
--          balance <= 0            -> 'paid'
--          paid_cents = 0          -> 'unpaid'
--          otherwise               -> 'partially_paid'
--   And, across the void boundary:
--     5. a voided or soft-deleted bill has no live (unvoided) vendor_payments
--     6. a live vendor_payment is strictly positive
--
-- WOULD HAVE CAUGHT
--   The AP counterpart of the AR cached-component class: record_vendor_payment /
--   void_vendor_payment / void_vendor_bill / update_vendor_bill bumping
--   paid_cents without its vendor_payments row (or vice versa), a void that
--   reverses only one side, or a status left at 'unpaid' on a fully-paid bill
--   (which would silently hide the bill from AP aging).
--
-- EXPECTED RESULT
--   Zero rows. Verified live 2026-08-07 against rhyzpcqhnizqbxphqdkr:
--   6 vendor_bills in population, 0 violations on all six identities.
--   First column = stable identity key 'vendor_bill:<uuid>:<component>'.
--
-- KNOWN FALSE-POSITIVE MODES
--   * If an AP credit/debit-memo lever is ever added (the AP analogue of
--     credit_memo_applications), paid_cents will legitimately diverge from
--     vendor_payments alone and this predicate must learn the new ledger —
--     extend the reconstruction, do NOT allowlist the rows.
--   * Voided bills are out of the paid/status population (void_vendor_bill
--     rewrites the components wholesale) but stay IN population for identity 5.
--
-- SCHEMA FACTS (verified live 2026-08-07 against rhyzpcqhnizqbxphqdkr pg_catalog)
--   vendor_bills(id, vendor_id, bill_number, subtotal_cents, adjustment_cents,
--     total_cents, paid_cents, status CHECK IN
--     ('unpaid','partially_paid','paid','voided'),
--     balance_cents GENERATED = total_cents - COALESCE(paid_cents,0),
--     deleted_at, voided_at)
--   vendor_payments(id, vendor_bill_id, amount_cents, voided_at, voided_by)
--   paid_cents writers: record_vendor_payment, void_vendor_payment,
--     void_vendor_bill (create_vendor_bill / update_vendor_bill set the
--     subtotal/adjustment/total side only)
-- =============================================================================
WITH population AS (
  SELECT vb.id, vb.bill_number, vb.vendor_id, vb.status,
         vb.subtotal_cents, vb.adjustment_cents, vb.total_cents,
         COALESCE(vb.paid_cents, 0) AS paid_cents, vb.balance_cents
  FROM vendor_bills vb
  WHERE vb.deleted_at IS NULL
    AND vb.status <> 'voided'
),
payment_ledger AS (
  SELECT vp.vendor_bill_id, SUM(vp.amount_cents)::bigint AS cents
  FROM vendor_payments vp
  WHERE vp.voided_at IS NULL
  GROUP BY vp.vendor_bill_id
)

SELECT
  'vendor_bill:' || p.id::text || ':paid'                     AS identity_key,
  'paid_cents_drift'::text                                    AS violation_type,
  p.vendor_id,
  COALESCE(pl.cents, 0)                                       AS expected_cents,  -- ledger truth
  p.paid_cents                                                AS actual_cents,    -- cached column
  'bill ' || p.bill_number || ' (' || p.status || '): cached paid_cents='
    || p.paid_cents::text || ' but SUM(unvoided vendor_payments)='
    || COALESCE(pl.cents, 0)::text                            AS detail,
  'vendor_bill:' || p.id::text || ':paid'                     AS violation_key
FROM population p
LEFT JOIN payment_ledger pl ON pl.vendor_bill_id = p.id
WHERE p.paid_cents <> COALESCE(pl.cents, 0)

UNION ALL

SELECT
  'vendor_bill:' || p.id::text || ':total',
  'total_cents_drift'::text,
  p.vendor_id,
  p.subtotal_cents + COALESCE(p.adjustment_cents, 0),
  p.total_cents,
  'bill ' || p.bill_number || ': total_cents=' || p.total_cents::text
    || ' but subtotal+adjustment='
    || (p.subtotal_cents + COALESCE(p.adjustment_cents, 0))::text,
  'vendor_bill:' || p.id::text || ':total'
FROM population p
WHERE p.total_cents <> p.subtotal_cents + COALESCE(p.adjustment_cents, 0)

UNION ALL

SELECT
  'vendor_bill:' || p.id::text || ':overpaid',
  'negative_balance'::text,
  p.vendor_id,
  0::bigint,
  p.balance_cents,
  'bill ' || p.bill_number || ' is overpaid: balance_cents='
    || p.balance_cents::text || ' (paid_cents=' || p.paid_cents::text
    || ' exceeds total_cents=' || p.total_cents::text || ')',
  'vendor_bill:' || p.id::text || ':overpaid'
FROM population p
WHERE p.balance_cents < 0

UNION ALL

SELECT
  'vendor_bill:' || p.id::text || ':status',
  'status_drift'::text,
  p.vendor_id,
  NULL::bigint,
  p.balance_cents,
  'bill ' || p.bill_number || ': status=' || p.status
    || ' but balance_cents=' || p.balance_cents::text
    || ' / paid_cents=' || p.paid_cents::text || ' implies '
    || CASE WHEN p.balance_cents <= 0 THEN 'paid'
            WHEN p.paid_cents = 0    THEN 'unpaid'
            ELSE 'partially_paid' END,
  'vendor_bill:' || p.id::text || ':status'
FROM population p
WHERE p.status IS DISTINCT FROM
      CASE WHEN p.balance_cents <= 0 THEN 'paid'
           WHEN p.paid_cents = 0    THEN 'unpaid'
           ELSE 'partially_paid' END

UNION ALL

-- Void boundary: a voided/soft-deleted bill must carry no live payment. (Out of
-- `population` on purpose — population excludes exactly these bills.)
SELECT
  'vendor_bill:' || vb.id::text || ':dead_bill_live_payment',
  'voided_bill_with_live_payment'::text,
  vb.vendor_id,
  0::bigint,
  SUM(vp.amount_cents)::bigint,
  'bill ' || vb.bill_number || ' is voided/deleted but still has '
    || count(*)::text || ' unvoided vendor_payment row(s) totalling '
    || SUM(vp.amount_cents)::text || ' cents',
  'vendor_bill:' || vb.id::text || ':dead_bill_live_payment'
FROM vendor_bills vb
JOIN vendor_payments vp ON vp.vendor_bill_id = vb.id AND vp.voided_at IS NULL
WHERE vb.status = 'voided' OR vb.deleted_at IS NOT NULL
GROUP BY vb.id, vb.bill_number, vb.vendor_id

UNION ALL

SELECT
  'vendor_payment:' || vp.id::text || ':amount',
  'non_positive_payment'::text,
  vb.vendor_id,
  NULL::bigint,
  vp.amount_cents,
  'live vendor_payment on bill ' || vb.bill_number
    || ' has non-positive amount_cents=' || vp.amount_cents::text,
  'vendor_payment:' || vp.id::text || ':amount'
FROM vendor_payments vp
JOIN vendor_bills vb ON vb.id = vp.vendor_bill_id
WHERE vp.voided_at IS NULL
  AND vp.amount_cents <= 0

ORDER BY violation_type, identity_key;
