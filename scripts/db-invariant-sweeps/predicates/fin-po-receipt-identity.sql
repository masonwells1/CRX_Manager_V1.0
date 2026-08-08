-- =============================================================================
-- fin-po-receipt-identity.sql — purchase-order received-vs-ordered arithmetic
-- C9 financial identity suite (docs/audits/2026-06-10-error-prevention-review.md §4)
--
-- WHY THIS GAP EXISTED
--   section9-po-ap-controls checks that inventory.quantity_on_order equals the
--   open PO remainder — but it computes that remainder as
--   GREATEST(quantity_ordered - quantity_received, 0). That clamp makes the
--   on-order check PASS no matter how far quantity_received exceeds
--   quantity_ordered, so over-receipt is invisible to every existing predicate.
--   Over-receipt is a money event: received quantity drives the inventory
--   cost pool and what the vendor bill is matched against.
--
-- IDENTITIES (per purchase order / item)
--   1. quantity_received <= quantity_ordered on every line (no over-receipt)
--   2. status 'fully_received' => every line has received >= ordered
--   3. status 'partially_received' => at least one line received > 0
--      AND at least one line not yet complete
--   4. status 'draft' or 'submitted' => no line has been received at all
--   5. total_cost_cents == SUM(round(quantity_ordered * unit_cost_cents))
--      over the PO's items, for any non-cancelled PO
--
-- WOULD HAVE CAUGHT
--   A receive path that adds to quantity_received without bounding it against
--   quantity_ordered, and a status transition that runs ahead of (or behind) the
--   line-level receipt state — the two ways a PO's on-order remainder and its
--   AP three-way match can silently disagree with the physical receipt.
--
-- EXPECTED RESULT
--   ZERO rows is the contract. LIVE STATE 2026-08-07 IS NOT ZERO — this predicate
--   returns 22 rows on rhyzpcqhnizqbxphqdkr today, all pre-existing data:
--     * 15 over_receipt lines (identity 1) on PO-2026-0008/0009/0012/0028
--       (created 2026-03-05 .. 2026-03-21). Twelve are +0.5-unit or small
--       overages; three are large (Ammonium Sulfate 60537 ordered / 73450
--       received, Gen Liberty 3643 / 4082, Miravis Top 137 / 180).
--     * 7 fully_received_incomplete lines (identity 2), all on PO-2026-0008,
--       where the PO was closed out with lines still at 0 received.
--   DISPOSITION (Mason, in-chat 2026-08-07): accept-and-baseline. All 22 rows are
--   allowlisted per-key in allowlist.json with the live ordered/received figures
--   recorded in each justification. The identity itself stays armed: any NEW
--   over-receipt or premature close-out appears under a different violation_key
--   and fails the sweep. Identities 3, 4 and 5 return zero rows live.
--
-- KNOWN FALSE-POSITIVE MODES
--   * Legitimate vendor overage (a supplier ships a full pallet against a
--     partial-pallet order) is a real business event that this predicate reports
--     as over_receipt. If the business accepts overage, the fix is a bounded
--     tolerance in the receive RPC plus a recorded baseline here — not a blanket
--     allowlist of the identity.
--   * A cancelled PO may legitimately retain partial receipts, so cancelled POs
--     are out of population for identities 2-4 (and their total identity is not
--     asserted, since cancel_purchase_order may zero the cost).
--
-- SCHEMA FACTS (verified live 2026-08-07 against rhyzpcqhnizqbxphqdkr pg_catalog)
--   purchase_orders(id, po_number, status CHECK IN
--     ('draft','submitted','partially_received','fully_received','cancelled'),
--     total_cost, total_cost_cents GENERATED)
--   purchase_order_items(id, purchase_order_id, product_id, product_name,
--     quantity_ordered numeric CHECK >= 0, quantity_received numeric CHECK >= 0,
--     unit_cost, unit_cost_cents GENERATED)
--   There is NO CHECK constraint bounding quantity_received by quantity_ordered.
-- =============================================================================
WITH po AS (
  SELECT p.id, p.po_number, p.status
  FROM purchase_orders p
),
item_rollup AS (
  SELECT i.purchase_order_id,
         count(*)                                                          AS line_count,
         count(*) FILTER (WHERE COALESCE(i.quantity_received, 0) > 0)      AS lines_with_receipts,
         count(*) FILTER (WHERE COALESCE(i.quantity_received, 0)
                                < i.quantity_ordered)                      AS lines_incomplete,
         SUM(round(i.quantity_ordered * i.unit_cost_cents))::bigint        AS expected_cost_cents
  FROM purchase_order_items i
  GROUP BY i.purchase_order_id
)

-- 1. over-receipt: a line received beyond what was ordered
SELECT
  'po_item:' || i.id::text || ':over_receipt'                  AS identity_key,
  'over_receipt'::text                                         AS violation_type,
  po.po_number,
  i.quantity_ordered                                           AS expected_qty,
  i.quantity_received                                          AS actual_qty,
  'PO ' || po.po_number || ' (' || po.status || ') line "'
    || COALESCE(i.product_name, i.product_id::text) || '": received '
    || i.quantity_received::text || ' against ordered '
    || i.quantity_ordered::text                                AS detail,
  'po_item:' || i.id::text || ':over_receipt'                  AS violation_key
FROM purchase_order_items i
JOIN po ON po.id = i.purchase_order_id
WHERE COALESCE(i.quantity_received, 0) > i.quantity_ordered

UNION ALL

-- 2. fully_received PO with a line that is not fully received
SELECT
  'po_item:' || i.id::text || ':fully_received_incomplete',
  'fully_received_incomplete'::text,
  po.po_number,
  i.quantity_ordered,
  i.quantity_received,
  'PO ' || po.po_number || ' is fully_received but line "'
    || COALESCE(i.product_name, i.product_id::text) || '" has received '
    || COALESCE(i.quantity_received, 0)::text || ' of '
    || i.quantity_ordered::text,
  'po_item:' || i.id::text || ':fully_received_incomplete'
FROM purchase_order_items i
JOIN po ON po.id = i.purchase_order_id
WHERE po.status = 'fully_received'
  AND COALESCE(i.quantity_received, 0) < i.quantity_ordered

UNION ALL

-- 3. partially_received PO whose lines are all-zero or all-complete
SELECT
  'po:' || po.id::text || ':partial_status',
  'partial_status_drift'::text,
  po.po_number,
  r.lines_with_receipts::numeric,
  r.lines_incomplete::numeric,
  'PO ' || po.po_number || ' is partially_received but '
    || CASE WHEN r.lines_with_receipts = 0
              THEN 'no line has any receipt'
            ELSE 'every line is already complete' END,
  'po:' || po.id::text || ':partial_status'
FROM po
JOIN item_rollup r ON r.purchase_order_id = po.id
WHERE po.status = 'partially_received'
  AND r.line_count > 0
  AND (r.lines_with_receipts = 0 OR r.lines_incomplete = 0)

UNION ALL

-- 4. unreceivable status (draft/submitted) that already carries receipts
SELECT
  'po:' || po.id::text || ':receipts_before_status',
  'receipts_before_status'::text,
  po.po_number,
  0::numeric,
  r.lines_with_receipts::numeric,
  'PO ' || po.po_number || ' has status ' || po.status || ' but '
    || r.lines_with_receipts::text || ' line(s) already carry receipts',
  'po:' || po.id::text || ':receipts_before_status'
FROM po
JOIN item_rollup r ON r.purchase_order_id = po.id
WHERE po.status IN ('draft', 'submitted')
  AND r.lines_with_receipts > 0

UNION ALL

-- 5. PO header cost vs its own line arithmetic
SELECT
  'po:' || po.id::text || ':total_cost',
  'po_total_cost_drift'::text,
  po.po_number,
  COALESCE(r.expected_cost_cents, 0)::numeric,
  p2.total_cost_cents::numeric,
  'PO ' || po.po_number || ': header total_cost_cents='
    || p2.total_cost_cents::text || ' but SUM(round(qty * unit_cost_cents))='
    || COALESCE(r.expected_cost_cents, 0)::text,
  'po:' || po.id::text || ':total_cost'
FROM po
JOIN purchase_orders p2 ON p2.id = po.id
LEFT JOIN item_rollup r ON r.purchase_order_id = po.id
WHERE po.status <> 'cancelled'
  AND p2.total_cost_cents IS DISTINCT FROM COALESCE(r.expected_cost_cents, 0)

ORDER BY violation_type, identity_key;
