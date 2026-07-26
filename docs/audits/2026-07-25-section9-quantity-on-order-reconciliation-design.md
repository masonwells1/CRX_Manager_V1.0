# Section 9 `quantity_on_order` Reconciliation Design

**Date:** 2026-07-25 (America/Chicago)

**Scope:** design and read-only evidence only

**Verdict:** **DO NOT CREATE A RECONCILIATION MIGRATION.** The reported 77
rows are a query-null-semantics false positive, not 77 incorrect cached
quantities. The current production mismatch count is zero.

## Owner summary

`inventory.quantity_on_order` is a cache: its authoritative source is the
remaining quantity on Purchase Order lines whose Purchase Order is
`submitted` or `partially_received`.

The reported count of 77 is exactly reproducible when the diagnostic compares:

```text
stored zero  versus  no aggregate row
```

as `0 IS DISTINCT FROM NULL`. In business terms, an absent open-PO aggregate
means zero, so that comparison is wrong. All 77 reported rows have:

- a Main Warehouse inventory row;
- stored `quantity_on_order = 0`; and
- no Purchase Order product group in an open on-order status.

The canonical pending Section 9 migration already uses the correct rule:
`COALESCE(expected, 0)`. On the final read-only production recheck at
`2026-07-26 03:31:24 UTC` (`2026-07-25 22:31:24 America/Chicago`):

- canonical migration preflight mismatches: **0**;
- standing invariant mismatches: **0**;
- total stored Main Warehouse on-order quantity: **14,715**;
- total authoritative open-PO remainder: **14,715**.

Writing 77 rows would therefore replace correct zeros with the same zeros and
create needless production-data risk. The correct next database action is to
apply the already-reviewed canonical Section 9 migration only after its normal
fresh proof and approval gates. If a fresh true mismatch appears before that
apply, stop and use the contingency design in this packet; do not convert this
point-in-time zero result into standing authority to write.

## Scope boundaries and provenance

This packet:

- was prepared from exact fresh `origin/main`
  `25363345adeabb5b2b08a3772a0de3f0edcb3952`;
- used Graphify build commit `25363345` from
  `graphify-out/GRAPH_REPORT.md`;
- used exact Graphify queries:
  - `graphify explain "public._recompute_po_on_order_for_products()"`;
  - `graphify affected "public._recompute_po_on_order_for_products()" --depth 3`;
  - `graphify query "which purchase order and receiving routines change inventory.quantity_on_order and how does migration 20260722222742 replace delta maintenance?" --budget 1600`;
- verified material behavior in current source and read-only production SQL;
- inspected the canonical migration, its rollback-only smoke, standing
  invariant, network-isolated concurrency proof, contract tests, migration
  history, original Section 9 audit, and PR #218 review history.

No migration was created or edited. No application/shared registry, migration
history, smoke registry, map, Supplier/Product/Phase 3 file, live row, live
function, live trigger, grant, or policy was changed.

The active Supplier worktrees and other lanes had no tracked overlap with this
packet or the Section 9 remediation files at the start of this work.

## Authoritative definition

For each Product, the authoritative Main Warehouse on-order value is:

```sql
SUM(
  GREATEST(
    purchase_order_items.quantity_ordered
      - COALESCE(purchase_order_items.quantity_received, 0),
    0
  )
)
```

over Purchase Orders in:

```sql
('submitted', 'partially_received')
```

An absent aggregate row means zero. Over-received lines contribute zero, never
a negative remainder. Only the `Main Warehouse` inventory row is this cache;
other inventory locations must not be included or modified.

This is the same formula in:

- `supabase/migrations/20260722222742_section9_po_ap_high_remediation.sql`;
- `scripts/db-invariant-sweeps/predicates/section9-po-ap-controls.sql`;
- `scripts/smoke/smoke-section9-po-ap-high-remediation.sql`.

## Exact current mismatch query

This is the canonical migration-preflight comparison, isolated as a read-only
query. It deliberately preserves `actual IS DISTINCT FROM expected` so a
missing Main Warehouse row with a positive expected value fails closed, while
coalescing a missing open-PO aggregate to business zero.

```sql
WITH expected AS (
  SELECT
    poi.product_id,
    SUM(GREATEST(
      poi.quantity_ordered - COALESCE(poi.quantity_received, 0),
      0
    ))::numeric AS quantity_on_order
  FROM public.purchase_order_items poi
  JOIN public.purchase_orders po
    ON po.id = poi.purchase_order_id
  WHERE po.status IN ('submitted', 'partially_received')
  GROUP BY poi.product_id
),
comparison AS (
  SELECT
    COALESCE(i.product_id, expected.product_id) AS product_id,
    i.quantity_on_order::numeric AS actual,
    COALESCE(expected.quantity_on_order, 0)::numeric AS expected
  FROM expected
  FULL JOIN (
    SELECT product_id, quantity_on_order
    FROM public.inventory
    WHERE location = 'Main Warehouse'
  ) i ON i.product_id = expected.product_id
)
SELECT
  COUNT(*) AS mismatch_count,
  COUNT(*) FILTER (WHERE actual IS NULL) AS missing_main_row_count,
  COUNT(*) FILTER (WHERE COALESCE(actual, 0) > expected)
    AS actual_above_expected_count,
  COUNT(*) FILTER (WHERE COALESCE(actual, 0) < expected)
    AS actual_below_expected_count,
  COALESCE(SUM(COALESCE(actual, 0) - expected), 0)
    AS signed_delta,
  COALESCE(SUM(ABS(COALESCE(actual, 0) - expected)), 0)
    AS absolute_delta
FROM comparison
WHERE actual IS DISTINCT FROM expected;
```

Current bounded result:

| Measure | Result |
| --- | ---: |
| `mismatch_count` | 0 |
| Missing Main Warehouse rows among mismatches | 0 |
| Actual above expected | 0 |
| Actual below expected | 0 |
| Signed delta | 0 |
| Absolute delta | 0 |

The standing invariant uses an equally valid cache-equivalence comparison:

```sql
COALESCE(actual, 0) IS DISTINCT FROM COALESCE(expected, 0)
```

It also returned zero.

## Exact 77-row reproducer

The following read-only diagnostic reproduces 77 by intentionally retaining
NULL on the expected side:

```sql
WITH expected AS (
  SELECT
    poi.product_id,
    SUM(GREATEST(
      poi.quantity_ordered - COALESCE(poi.quantity_received, 0),
      0
    ))::numeric AS expected
  FROM public.purchase_order_items poi
  JOIN public.purchase_orders po
    ON po.id = poi.purchase_order_id
  WHERE po.status IN ('submitted', 'partially_received')
  GROUP BY poi.product_id
),
actual AS (
  SELECT product_id, quantity_on_order::numeric AS actual
  FROM public.inventory
  WHERE location = 'Main Warehouse'
),
comparison AS (
  SELECT
    COALESCE(actual.product_id, expected.product_id) AS product_id,
    actual.actual,
    expected.expected
  FROM expected
  FULL JOIN actual ON actual.product_id = expected.product_id
)
SELECT
  COUNT(*) FILTER (WHERE actual IS DISTINCT FROM expected)
    AS raw_null_sensitive_mismatch_count,
  COUNT(*) FILTER (WHERE actual = 0 AND expected IS NULL)
    AS zero_actual_without_open_po_count,
  COUNT(*) FILTER (
    WHERE COALESCE(actual, 0) IS DISTINCT FROM COALESCE(expected, 0)
  ) AS business_truth_mismatch_count
FROM comparison;
```

Current result:

```text
raw_null_sensitive_mismatch_count = 77
zero_actual_without_open_po_count = 77
business_truth_mismatch_count = 0
```

The 77 value is therefore the number of correct zero cache rows whose Products
have no matching open-PO aggregate row. It is not a quantity discrepancy count.

## Bounded production result summary

No Product names, business contacts, payment identifiers, vendor details, or
row identifiers were selected.

| Measure | Result |
| --- | ---: |
| Main Warehouse inventory rows | 117 |
| Product groups on submitted/partially-received POs | 40 |
| Groups with a positive remainder | 18 |
| Groups with a zero remainder | 22 |
| Zero cache rows with no open-PO group | 77 |
| Positive cache rows with no open-PO group | 0 |
| Open-PO groups missing a Main Warehouse row | 0 |
| Stored Main Warehouse on-order total | 14,715 |
| Authoritative open-PO remainder total | 14,715 |
| Canonical preflight mismatch count | 0 |
| Standing invariant mismatch count | 0 |

Production catalog state at the same pass:

- migration `20260722222742_section9_po_ap_high_remediation` has **0** applied
  ledger rows;
- the new `_recompute_po_on_order_for_products`,
  `trg_po_items_recompute_on_order`, and
  `trg_po_status_recompute_on_order` functions are absent live;
- legacy `trg_po_submitted_on_order` remains enabled;
- live migration high-water is `20260723193312`,
  `20260722222743_product_families_return_policy_foundation`.

The zero mismatch result does **not** mean all Section 9 work is live. The
bounded aggregate form of the registered Section 9 predicate still returned
one current violation in each of these control classes:

- authenticated browser role retains direct vendor mutation privilege;
- a vendor browser-write policy remains;
- `create_vendor_bill` lacks the reviewed PO lock/status serialization;
- `get_ap_aging` lacks the reviewed current-only fail-closed behavior;
- `update_vendor_bill` lacks the reviewed lock-before-both-period-check shape.

Those are the other canonical migration responsibilities and remain reasons to
apply the existing reviewed migration; they are not reasons to write a
quantity reconciliation migration.

## Root-cause classification

### Confirmed cause of the reported 77

**Diagnostic false positive — NULL was treated as a value instead of business
zero.**

An aggregate grouped by Product has no row when a Product has no qualifying
Purchase Order. A `FULL JOIN` exposes that absence as NULL. Comparing the
stored zero directly with NULL reports a difference even though both mean
"nothing is on order."

The evidence is exact, not approximate:

- `117 Main rows - 40 aggregate groups = 77 absent aggregate matches`;
- all 77 stored values are zero;
- none of the 77 stored values is positive;
- coalescing both sides reduces 77 to zero;
- aggregate quantity totals already tie exactly.

### True mismatch classes (none currently present)

If the canonical query later returns rows, classify them before any write:

| Class | Observable shape | Likely cause | Safe disposition |
| --- | --- | --- | --- |
| Stale positive | `actual > 0`, `expected = 0` | cancellation, full receipt, deletion, or edit did not zero a delta-maintained cache | Absolute recompute to zero |
| Overstated cache | `actual > expected > 0` | missed receive/decrease or duplicate positive delta | Absolute recompute to expected |
| Understated cache | `0 <= actual < expected` | missed submit/increase, excessive decrement, or product reassignment | Absolute recompute to expected |
| Missing cache row | `actual IS NULL`, `expected > 0` | open PO exists without Main Warehouse inventory row | Insert safe zero row, then set absolute expected |
| Invalid source | negative/null/non-finite source inputs or an unsupported PO status | source data does not satisfy the formula's assumptions | **Park for owner/source evidence; do not reconcile** |

No current row falls into these classes.

## Decision: park the data migration, proceed only with the canonical control migration

The three candidate dispositions are:

1. **Absolute recomputation of all Main Warehouse rows:** rejected now because
   all values already tie and it would write 117 rows without benefit.
2. **Targeted forward reconciliation migration:** rejected now because there
   are zero true target rows.
3. **Park for evidence:** selected for the reconciliation lane. Preserve this
   design as the contingency, rerun the exact canonical query immediately
   before apply, and create a forward migration only if true mismatches appear.

This decision does not park canonical migration
`20260722222742_section9_po_ap_high_remediation.sql`. That migration supplies
the going-forward recomputation, locking, vendor, bill, aging, and
closed-period controls. Its apply remains a separate live approval action.

## Invariants

Any implementation or apply must preserve all of these:

1. **Single source:** open PO remainder is derived only from
   `purchase_order_items` joined to qualifying `purchase_orders`.
2. **Status scope:** only `submitted` and `partially_received` contribute.
3. **Nonnegative line remainder:**
   `GREATEST(quantity_ordered - COALESCE(quantity_received, 0), 0)`.
4. **Business zero:** a Product absent from the aggregate has expected value
   zero.
5. **Location scope:** only `inventory.location = 'Main Warehouse'` is the
   on-order cache authority.
6. **No location bleed:** alternate locations are never read as cache truth
   and never updated by reconciliation.
7. **Absolute values:** write the recomputed expected value, never apply a
   compensating delta.
8. **Missing-row behavior:** create a Main Warehouse row only when expected is
   positive; do not manufacture zero-only inventory rows.
9. **Transactional equality:** before commit, the canonical query returns zero
   and total actual equals total expected.
10. **No source mutation:** reconciliation must not change POs, PO lines,
    receiving records, quantities ordered/received, statuses, or physical
    stock.
11. **No negative cache:** a reconciliation result is never negative.
12. **Forward authority:** after canonical Section 9 applies, line/status
    triggers plus the governed wrapper lock are the only maintenance design.

## Fail-closed preconditions

If a future true mismatch forces a targeted migration, the migration must
abort before writing unless all conditions hold:

1. The exact canonical mismatch query is positive and returns a bounded,
   reviewed aggregate summary.
2. Every mismatch maps to one of the four safe cache-shape classes above; any
   source-data anomaly parks the migration.
3. `inventory.quantity_on_order`,
   `purchase_order_items.quantity_ordered`, and
   `purchase_order_items.quantity_received` retain compatible numeric types.
4. The inventory uniqueness boundary still supports one
   `(product_id, location)` row.
5. The qualifying PO status constraint still contains the exact reviewed
   values.
6. Canonical Section 9 is still unapplied and its file hash/body is unchanged.
7. No sibling migration or active lane also writes the same PO/inventory
   authority.
8. The live migration ledger contains neither the canonical migration nor a
   prior reconciliation with equivalent purpose.
9. The transaction can acquire the required table locks and advisory lock
   within a bounded timeout; timeout or deadlock aborts.
10. The candidate target count after locks equals the reviewed preflight count,
    or the migration aborts for fresh investigation.
11. The post-update canonical query returns exactly zero before commit.
12. Same-session migration-review and independent SQL/money review proofs bind
    to the exact migration content.

## Contingency forward-migration algorithm (not authorized or needed now)

If a future preflight finds true mismatches, use a **targeted absolute
recomputation**, not a compensating delta and not a blanket update.

Pseudocode:

```sql
-- One migration-runner transaction.
SET LOCAL lock_timeout = '<reviewed bounded duration>';
SET LOCAL statement_timeout = '<reviewed bounded duration>';

-- Legacy write paths do not yet take the Section 9 advisory lock. Block their
-- table writes before deriving a repair snapshot.
LOCK TABLE public.purchase_orders
  IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.purchase_order_items
  IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.inventory
  IN SHARE ROW EXCLUSIVE MODE;

-- Match the canonical future authority.
SELECT pg_advisory_xact_lock(73492009);

CREATE TEMP TABLE pg_temp.section9_expected ON COMMIT DROP AS
SELECT
  poi.product_id,
  SUM(GREATEST(
    poi.quantity_ordered - COALESCE(poi.quantity_received, 0),
    0
  ))::numeric AS expected
FROM public.purchase_order_items poi
JOIN public.purchase_orders po ON po.id = poi.purchase_order_id
WHERE po.status IN ('submitted', 'partially_received')
GROUP BY poi.product_id;

CREATE TEMP TABLE pg_temp.section9_targets ON COMMIT DROP AS
SELECT
  COALESCE(i.product_id, e.product_id) AS product_id,
  i.quantity_on_order::numeric AS actual,
  COALESCE(e.expected, 0)::numeric AS expected
FROM pg_temp.section9_expected e
FULL JOIN (
  SELECT product_id, quantity_on_order
  FROM public.inventory
  WHERE location = 'Main Warehouse'
) i ON i.product_id = e.product_id
WHERE i.quantity_on_order IS DISTINCT FROM COALESCE(e.expected, 0);

-- Abort if target count or shape differs from the reviewed precondition.
-- Abort on invalid source data or any unexpected location/uniqueness state.

INSERT INTO public.inventory (
  product_id,
  location,
  quantity_available,
  quantity_prebooked,
  quantity_on_order
)
SELECT product_id, 'Main Warehouse', 0, 0, 0
FROM pg_temp.section9_targets
WHERE actual IS NULL AND expected > 0
ON CONFLICT (product_id, location) DO NOTHING;

UPDATE public.inventory i
SET quantity_on_order = t.expected,
    updated_at = now()
FROM pg_temp.section9_targets t
WHERE i.product_id = t.product_id
  AND i.location = 'Main Warehouse'
  AND i.quantity_on_order IS DISTINCT FROM t.expected;

-- Re-run the canonical query. RAISE if mismatch_count <> 0.
-- Re-run aggregate total equality. RAISE if totals differ.
```

The target table must contain only true canonical mismatches. It must not use
the raw `actual IS DISTINCT FROM expected` comparison with an uncoalesced
expected value.

## Concurrency and lock order

The canonical migration uses transaction advisory lock `73492009` before any
governed PO mutation reaches its mature implementation or the recomputation
trigger. Its recompute function then reads open PO truth and updates the Main
Warehouse row. The network-isolated proof covers:

- create-vendor-bill wins versus cancel-PO;
- cancel-PO wins versus create-vendor-bill;
- simultaneous updates for the same Product do not lose an on-order update;
- opposite Product update order does not deadlock.

A pre-canonical reconciliation has an extra problem: legacy PO/receiving
functions do not yet acquire advisory lock `73492009`. The contingency
migration therefore must acquire write-conflicting table locks first. The
required order is:

1. `purchase_orders`;
2. `purchase_order_items`;
3. `inventory`;
4. advisory transaction lock `73492009`;
5. derive targets;
6. insert missing positive-target rows;
7. update target cache rows;
8. verify zero;
9. commit.

The same order must be used in the disposable proof. Failure to acquire any
lock within the reviewed timeout is a normal fail-closed abort, not a reason to
weaken locks or retry variants against production.

There is still a transaction boundary between a hypothetical reconciliation
migration and the canonical migration. The canonical migration's own
fail-closed preflight is the guard against drift in that window: if a legacy
write reintroduces a true mismatch, canonical apply aborts and nothing from
that migration commits.

## Rollback and forward-fix posture

- **Current design:** no data write, so no rollback is needed.
- **Migration failure:** the migration runner transaction must roll back every
  target-row write and temporary object.
- **After a successful true reconciliation:** do not restore known-stale cache
  values. A later defect is corrected by another forward absolute
  recomputation from then-current PO truth.
- **Canonical migration failure:** it is transactional; fix the cause, rerun
  review on exact content as required, and reapply through the guard. Never
  edit an applied migration.
- **Historical source ambiguity:** if PO quantities/statuses themselves are
  disputed, cache reconciliation is forbidden. Park for owner/receiving
  evidence because recomputation cannot decide which source row is true.

## Proof plan

### Required before canonical Section 9 apply

1. Fetch current `origin/main` and verify the migration is unchanged and still
   pending in the live ledger.
2. Rerun the exact canonical mismatch query and bounded summary.
3. Require:
   - canonical mismatch count `0`;
   - standing invariant mismatch count `0`;
   - stored total equals expected total;
   - no positive cache row without qualifying PO truth;
   - no positive expected remainder without a Main Warehouse row.
4. Rerun focused static contracts:
   `src/lib/section9PoApRemediation.test.ts` and RPC contracts.
5. Rerun the network-isolated concurrency proof to
   `SECTION9_PO_AP_CONCURRENCY_PASS`.
6. Rerun the registered linked rollback-only smoke and require
   `SMOKE_PASS_ROLLBACK`.
7. Run the registered Section 9 predicate and full invariant sweep.
8. Produce fresh exact-content migration-review and independent Codex proof.

### Required after apply

1. Verify live migration-ledger identity and any required B7 disk rename.
2. Verify the legacy delta trigger is absent and both new recomputation
   triggers are enabled.
3. Verify the recompute/helper/wrapper functions, search paths, grants, and
   revoked internal execute boundaries.
4. Run the exact mismatch query: zero rows.
5. Run `section9-po-ap-controls`: zero rows.
6. Run the full invariant sweep: zero unallowlisted findings.
7. Run the rollback-only business smoke: `SMOKE_PASS_ROLLBACK`.
8. Run the concurrency proof again against the final checked-in source
   markers.
9. Refresh live-derived schema/registry/history artifacts only through their
   owning governed workflow.

### Additional proof if a contingency reconciliation becomes necessary

1. Disposable real-schema proof with fixtures for all four true mismatch
   shapes.
2. Negative control showing 77-style zero/NULL pairs produce zero targets.
3. Two-session proof that a legacy PO/receive write cannot interleave after
   table locks are acquired.
4. Lock-timeout proof: migration aborts without partial mutation.
5. Post-update zero-query and total-equality assertions inside the same
   transaction.
6. A rollback-only live smoke of the exact reconciliation SQL before any
   permanent apply.

## Apply order and approval gates

### Current evidence: recommended order

1. **No reconciliation migration.**
2. Fresh read-only zero-mismatch preflight immediately before apply.
3. Fresh exact-content migration-review and independent Codex verdict.
4. Obtain the authorization required by `AGENTS.md`:
   - ordinary interactive run: Mason's explicit in-chat approval;
   - pre-authorized hands-free run: only the documented armed-autopilot
     exception with every proof gate satisfied;
   - any destructive/data-deleting expansion: always stop for fresh approval.
5. Apply canonical migration
   `20260722222742_section9_po_ap_high_remediation.sql`.
6. Perform the post-apply proof plan before declaring Section 9 live.

### If a future true mismatch appears

1. Stop canonical apply.
2. Prepare a new forward-only targeted reconciliation migration from the
   contingency design; never edit canonical migration `20260722222742`.
3. Independently review and prove that exact new file.
4. Obtain explicit live-apply authorization.
5. Apply the reconciliation migration first.
6. Immediately rerun the canonical preflight.
7. Apply canonical Section 9 only if the count remains zero.
8. Complete both migrations' postflight and ledger closeout.

The explicit application sequence is authoritative even if the new forward
migration's filename timestamp sorts after the older pending canonical file.
Migration history already distinguishes ledger entry order from filename
timestamp order. Never use a bulk push that applies unreviewed pending files.

## Honest blocked questions and residual risk

- The prior readiness ledger describes 77 as output from the canonical
  fail-closed preflight, but no archived exact SQL/output for that run was found
  in `origin/main`. Current production reproduces 77 only when expected NULL is
  left uncoalesced; the checked-in canonical preflight returns zero. Treat the
  old wording as contradicted, not as current apply evidence.
- Live data can change after this packet. Zero is point-in-time evidence, so
  the immediate pre-apply recheck is mandatory.
- The other Section 9 controls remain absent live. This packet clears only the
  alleged need for a 77-row data repair; it does not certify the pending
  canonical migration as applied or the whole Section 9 lane as live.
- No owner/business evidence is needed for the current 77 because no true
  quantity discrepancy exists. Owner evidence becomes mandatory only if a
  future source-data anomaly makes the PO rows themselves disputable.

## Final design verdict

**PARK THE RECONCILIATION MIGRATION AS UNNECESSARY.**

The 77 figure is a NULL-versus-zero query artifact. Current production cache
truth is exact: zero canonical mismatches and equal totals. Preserve the
fail-closed contingency design, rerun the canonical query immediately before
apply, and move the already-reviewed Section 9 control migration through its
normal proof and live-approval gates without a preceding data rewrite.
