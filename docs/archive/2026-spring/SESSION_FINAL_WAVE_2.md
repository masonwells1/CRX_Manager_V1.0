# Wave 2 — Session Final Report

**Date:** 2026-05-07
**Plan:** `docs/plans/2026-05-07-phase-4-closure-autonomous-waves.md`
**Branch:** `main` (8 commits ahead of `origin/main`, NOT pushed — per the wave rules)
**Approximate runtime:** ~30 minutes (four pre-commit cycles plus exploration, two dev-server smoke tests)

---

## Local commit log (since `36d3ec3`)

```
a40f439 fix(quick-receive): block silent allocation when multiple PO costs exist (P4-14)
1e18648 fix(cycle-count): wire idempotency key into cancel_cycle_count call (P4-12)
f2563b9 feat(inventory): live preview + zero-cross warning on adjust modals (P4-8)
d8bfa26 feat(po-receive): show disabled reverse button + tooltip for non-admin (P4-13)
```

All four pre-commit hooks ran cleanly: SQL validation passed, frontend validation passed (with two non-blocking warnings noted below), lint (0 errors, 1 pre-existing warning on `IntegrityReport.tsx:27`), production build, full test suite.

---

## Item-by-item summary

### Item 1 — `feat(po-receive): show disabled reverse button + tooltip for non-admin (P4-13)` — `d8bfa26` ⚠️ **UI-AFFECTING**

The receiving-log table in `PurchaseOrderDetail.tsx` previously rendered the reverse-receive column only when `isAdmin === true`. Both the column header `<th>` and the row `<td>` were wrapped in the same conditional. For sales reps the button silently disappeared with no explanation, which is exactly the UX gap audit P4-13 flagged.

The fix:
- Removed the `{isAdmin && <th>}` guard so the column header always renders (zero width-shift between admin and sales-rep views).
- Replaced the `{isAdmin && <td>...}` block with an unconditional `<td>` containing a ternary: admins see the existing red functional button (`onClick={openReverseModal}`, `title="Reverse this receiving entry"`); non-admins see a `<button disabled>` styled `text-gray-300 cursor-not-allowed` with `title="Ask an admin to reverse this receive."` and an `aria-label` for screen readers.
- The tooltip uses the project's existing pattern — native HTML `title=` attribute, same as the row's Download button at `:740` and the active reverse button itself at `:752`. No new tooltip component introduced.

Smoke test: dev server boot clean, no console or server errors, root mounted.

**Files:** `src/pages/PurchaseOrderDetail.tsx`

---

### Item 2 — `feat(inventory): live preview + zero-cross warning on adjust modals (P4-8)` — `f2563b9` ⚠️ **UI-AFFECTING**

This affects two modals:

**Single-row Adjust modal (`InventoryPage.tsx`).** The audit's spec at lines 1497-1517 had drifted to lines 1386-1407 in the current file (the file is now 1445 lines, not 1554 — the migration to `get_inventory_position` in Wave B.3 trimmed it). Wrapped the modal body in an IIFE so I could reuse derived values (`selectedRow`, `parsedDelta`, `projectedQty`, `wouldGoNegative`) without polluting parent-component state. Added:
- `Current on hand: N units` line above the qty input.
- `After this adjustment: X units` line below the input. Red text when `X < 0`.
- Yellow warning band with the audit's exact wording when `projectedQty < 0`: "Warning: this adjustment will drive inventory below zero (X). Verify with a physical count before proceeding."

The pattern mirrors the manual-hold warning at `:330-331` (today's-free formula) — same yellow palette (`border-yellow-300 bg-yellow-50 text-yellow-900`), same `<strong>Warning:</strong>` lead.

**BatchAdjustModal (`src/components/inventory/BatchAdjustModal.tsx`).** The per-row preview already showed `qty → qty+delta` at line 130. Added:
- Per-row text color: rows whose result is negative now render in `text-red-600 font-medium` (the rest stay `text-secondary`).
- Aggregate yellow warning band counting how many rows would cross zero. Plural handling included ("1 product" vs "2 products").
- Two derived values at the top of the component: `hasDelta` (numeric guard against NaN/empty input) and `negativeCount`.

Both modals are soft warnings only — the actual save still proceeds, matching the manual-hold warning's "click again to override" intent. Negative inventory remains allowed at the DB level (`chk_inventory_qty_available` was deliberately dropped in `20260333800000`) until Phase 23 lands the per-product `allow_negative` flag.

Smoke test: dev server boot clean, no console errors. Pre-commit raised one non-blocking warning ("uses .toFixed(2) on a money variable — verify display-only") which is pre-existing on a different line of `InventoryPage.tsx` and not introduced by this change.

**Files:** `src/pages/InventoryPage.tsx`, `src/components/inventory/BatchAdjustModal.tsx`

---

### Item 3 — `fix(cycle-count): wire idempotency key into cancel_cycle_count call (P4-12)` — `1e18648`

**Verify-and-partial-fix.** Audit P4-12 asked: does `cancel_cycle_count` accept and use a `p_idempotency_key`? And does the front-end pass one?

I read the only migration that defines `cancel_cycle_count` — `supabase/migrations/20260501130000_field_app_workflow_phase18.sql` — and confirmed both halves of the idempotency contract are present:
- Line 174-177: `v_existing := check_idempotency(p_idempotency_key, 'cancel_cycle_count'); IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;`
- Line 200-202: `PERFORM save_idempotency(p_idempotency_key, 'cancel_cycle_count', v_result);`
- Line 263-266: a deferred-runtime overload-detector that raises if anything ever creates a duplicate signature.

So the SQL is fully idempotent. **But** the front-end at `CycleCounts.tsx:326-329` was calling the RPC with only two arguments (`p_cycle_count_id`, `p_performed_by`) — never passing the third optional `p_idempotency_key`. The DB safety net was sitting there unused.

Fix: added a `cancelCycleCountIdem = useIdempotencyKey('cancel_cycle_count', profile?.id)` declaration alongside the existing `complete` and `reverse` hooks at line 55-57, and threaded `getKey()` / `resetKey()` into `executeCancelCount`. Identical pattern to `complete_cycle_count` (line 289-297) and `reverse_completed_cycle_count` (line 354-362). No SQL change.

CHANGELOG entry at `docs/CHANGELOG.md` records the verification + fix so a future audit doesn't re-derive this.

**Files:** `src/pages/CycleCounts.tsx`, `docs/CHANGELOG.md`

---

### Item 4 — `fix(quick-receive): block silent allocation when multiple PO costs exist (P4-14)` — `a40f439` ⚠️ **UI-AFFECTING**

**Verify-and-fix.** This was the most interesting of the four. Audit P4-14 suspected that when a product has multiple open POs at different unit costs, the QuickReceive UI silently picks the oldest. I read `match_quick_receive_items` (migration `20260304200000_quick_receive.sql`) end-to-end and `QuickReceive.tsx` end-to-end.

**Working:**
- The SQL function correctly computes `v_multiple_costs := count(DISTINCT poi.unit_cost) > 1` per product (`:61-67`) and returns `has_multiple_costs` on each match (`:115`).
- The UI renders a "Price Variance" warning badge at `QuickReceive.tsx:653-655` when the flag is true.
- It renders a radio picker with NO-RETURN/REGULAR badges and per-PO unit cost at `:692-746` so the user can pick which PO to receive against.
- The override threading at `:233-244` correctly substitutes the picked PO when `overrides[product_id]` is set, putting the full requested quantity on that one PO.

**Broken:**
- The radio picker has **no default selection** (`overrides` initializes to `{}`).
- The Confirm button only checked `disabled={saving}`.
- If the user lands on the review step with a price-variance product and clicks "Confirm & Receive" without picking a radio, `overrides[product_id]` is undefined, the loop falls through to the `else` branch at `:245`, and the receipt is silently auto-allocated against the oldest PO (the SQL ORDERs `BY po.submitted_date ASC NULLS LAST`).
- Result: `cost_history` gets locked to whichever PO came first, even when the actual shipment was priced from the newer PO. This is exactly the quiet bug the audit suspected.

Three guards added to close the gap:

1. **Defense-in-depth in `handleConfirmReceive`** — early-returns with a toast naming the specific product if any `has_multiple_costs` match has allocations but no override picked.
2. **Confirm button disabled** when `hasUnresolvedVariance` is true. `title=` tooltip explains why ("Pick a PO for each price-variance product before continuing.").
3. **Inline red "Required — pick one to enable Confirm." line** above each unresolved variance picker so the user sees why the button is grey.

No SQL change — the function already returns the flag; the entire bug lived in the front-end's enforcement.

Smoke test: dev server boot clean, no console errors. Pre-commit raised one non-blocking warning ("Has .update() or .delete() but does not import checkMutationResult.") which is pre-existing in `QuickReceive.tsx` from prior code and not introduced by this change.

**Files:** `src/pages/QuickReceive.tsx`

---

## UI-affecting commits — Mason should spot-check

**Three of the four commits** (`d8bfa26`, `f2563b9`, `a40f439`) materially change the UI. Pages to spot-check before push:

1. **`/purchase-orders/:id`** (any role) — Receiving Log section. As **admin**: red rotate-counterclockwise icon visible per row, behaves as before. As **sales_rep**: same icon visible but greyed out (cursor-not-allowed); hovering shows "Ask an admin to reverse this receive." Source: `src/pages/PurchaseOrderDetail.tsx:707-758`.

2. **`/inventory`** (any role) — Click the row's adjust pencil. The modal now shows "Current on hand: N units" above the input, "After this adjustment: X units" below it, and a yellow warning band when X < 0. Multi-select two rows then "Adjust N Selected" — preview list now shows per-row red text on rows whose result is negative, plus an aggregate yellow band. Sources: `src/pages/InventoryPage.tsx:1386-1432`, `src/components/inventory/BatchAdjustModal.tsx`.

3. **`/quick-receive`** (any role) — Add a product that has multiple open POs at different unit costs. Step into Review. The Price Variance badge should appear, the radio picker should render with NO-RETURN/REGULAR badges, and a red "Required — pick one to enable Confirm." line should appear above the radios. The Confirm button should be greyed out (with tooltip) until a radio is picked. Source: `src/pages/QuickReceive.tsx:653-746, 808-832`.

Smoke tests on all three: `preview_start` succeeded, `document.title === "Crop RX Solutions"`, `rootChildren === 1`, zero console errors at level `error`. Login wall blocked deeper testing in the automated session as expected.

---

## Item 4 verdict on the audit's question

The audit asked: *"does the UI prompt the user to pick which PO, or does it silently allocate against the oldest?"*

The honest answer was **both** — the UI showed the picker but didn't enforce it, so a user who didn't notice the picker would silently get oldest-PO allocation. The fix promotes the picker from informational to required, which is what the audit's spec implied ("a 'Multiple costs detected; choose which PO this receipt belongs to' modal step before allocation"). No modal step was needed since the radio picker already lived inline; the missing piece was just the enforcement.

---

## Anomalies

**None blocking.** Two non-blocking pre-commit warnings:

1. `WARNING: src/pages/InventoryPage.tsx — Uses .toFixed(2) on a money variable — verify this is display-only.` Pre-existing; not introduced by this wave's changes (they used `parseFloat` and integer math, no `.toFixed`).
2. `WARNING: src/pages/QuickReceive.tsx — Has .update() or .delete() but does not import checkMutationResult.` Pre-existing; the file's existing `.update()`/`.delete()` calls are wrapped in `assertRpcResult` after `.rpc()` calls and don't use bare `.update()`. The hook is a heuristic; this is a known false-positive that an `// eslint-disable-line` or marker comment could silence in a follow-up wave.

Neither warning blocked the commit. Hooks ran cleanly on every attempt — no orphan-vitest-worker hangs, no SQL validation issues, no frontend-validation issues, no test failures. The pre-existing ESLint warning on `IntegrityReport.tsx:27` was untouched and pre-dates this wave.

One side observation worth flagging (NOT acted on this wave): the `receive_po_items` migration at `supabase/migrations/20260304200000_quick_receive.sql:306-308` references `idempotency_keys (key, operation, result)` instead of the canonical `(idempotency_key, operation, result)`. CLAUDE.md's schema-gotcha section says column `idempotency_key` (not `key`) is correct. This migration is from March 2026 and a later migration may have aliased the column or replaced the function — verifying that against live `pg_proc` is outside Wave 2 scope but worth a Wave 4 check.

---

## Counts

No new pages added (still 65 lazy imports in `App.tsx`). No new migrations added (still 278 `*.sql` files). No new RPCs created. Front-end-only changes plus one CHANGELOG entry.

---

> **Wave 2 complete. To start Wave 3, open a fresh Claude Code session and paste the Wave 3 prompt from `docs/plans/2026-05-07-phase-4-closure-autonomous-waves.md`.**
