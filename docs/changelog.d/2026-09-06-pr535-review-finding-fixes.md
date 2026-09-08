## 2026-09-06 - Close the remaining CodeRabbit review findings on PR #535 (Section 9 gauntlet fixes)

Follow-up to `2026-09-06-pr535-merge-main-and-close-review-findings.md`, which covered the
`origin/main` merge. This entry covers the review findings themselves.

### Fixed

- **`src/pages/PurchaseOrderDetail.tsx` - a lost reversal response reported a phantom failure.**
  `handleReverseReceiving`'s catch discarded the committed receipt and rotated the idempotency key,
  so a reversal that actually succeeded on the server surfaced as an error and the retry then failed
  with "Receiving record not found". It now recovers the receipt with
  `getIdempotencyMismatchResult(err, 'reverse_receiving_record')`, compares its `record_id` against
  the record being reversed, and refreshes the PO instead of re-reversing. This mirrors the
  receipt-recovery pattern already used for `receive_po_items` in the same file. A *proven* binding
  rejection still resets the key; an unproven one keeps it, so the retry can still land.

- **`src/components/integrity/IntegrityCleanupPanel.tsx` - a reconciled row could be re-reconciled.**
  (a) The reconciled row is now dropped from local state immediately after
  `reconcileIdem.resetKeyFor(scope)`, before and independently of the refresh. Previously a failed
  refresh left the row on screen, and a second click minted a fresh key and re-applied an absolute
  `quantity_available`. (b) `fetchAll` now has an `else` branch on the negatives query: a normal
  Supabase failure arrives *fulfilled* as `{ data: null, error }`, so the rejected-only Sentry loop
  above it never saw one. The failure is now reported and the list cleared rather than silently
  showing stale rows. Mirrors the existing `unbilledRes` handling.

- **`src/lib/gauntletFrontendSafetyGuards.test.ts` - a guard that passed by being absent.**
  The crawl-ordering assertion compared two `indexOf` results without checking either was found.
  `indexOf` returns `-1` for a missing marker, and `-1` is less than any real index, so deleting the
  `network-errors` classification outright would have left the assertion green. Both markers are now
  asserted present before their order is compared. This is the same class CodeRabbit had fixed in
  `cycleCountCompletionRevision.test.ts`; this site was left behind. Mutation-proven: removing the
  marker from `tests/crawl/route-crawl.spec.ts` failed with
  `expected -1 to be greater than or equal to 0`, and the file was restored and re-verified green.

- **`scripts/db-invariant-sweeps/predicates/section9-po-ap-controls.sql` - two arms claimed controls
  they never asserted.** The `create_vendor_bill` arm's violation reason names a cumulative billing
  guard and intent binding, but asserted only delegation-by-name, the two `FOR UPDATE` locks, and the
  billable-status list on the delegated impl - both financial controls could have been deleted from
  the wrapper with the sweep still returning zero rows. It now asserts `check_idempotency_intent`,
  `IDEMPOTENCY_RECEIPT_MISSING`, both `PO_CUMULATIVE_BILLING_*` exception tokens, and - so the guard
  cannot be satisfied by a condition that never fires - the arithmetic that decides when they fire:
  the sum source, the cumulative composition, and the 105%-of-PO threshold. The `update_vendor_bill`
  arm's reason names intent binding and likewise never asserted it; it now requires
  `check_idempotency_intent`, the `request_actor_id = v_actor` receipt stamp, and
  `IDEMPOTENCY_RECEIPT_MISSING`. Every literal was verified against the applied bodies of
  `20260831161000` and `20260831233000`. `strpos(..., 'lit') = 0` is used rather than
  `NOT LIKE '%lit%'` because `_` is a LIKE single-character wildcard and these token names are
  underscore-heavy.

- **`scripts/smoke/prove-supplier-pricing-phase3-return-policy-concurrency.mjs` - the smoke proof
  could never reach its behavioural checks.** Its `v_expected` identity baseline still carried the
  pre-overage signatures of `create_vendor_bill` and `update_vendor_bill`, so every run raised
  `SECTION9_AP_ROUTINE_IDENTITY_DRIFTED` before any assertion ran. Both signatures now include
  `p_confirm_po_overage` and `p_po_overage_reason`, with a comment naming the migrations that added
  them. `get_ap_aging` already matched.

### Not changed, and why

- The `create_inventory_hold` finding on `src/pages/InventoryPage.tsx` is already owned by branch
  `claude/inventory-idempotency-key-reset-888161` (frontend `50acce02a` plus migration
  `20260905210000`), parked at the Codex proof gate until credits return. Fixing it here would
  collide with another PR's branch.
- Five findings sit inside already-applied migrations (`20260830212415`, `20260831161000`,
  `20260831160000`, `20260830235900`). Applied migrations are immutable; these need a forward
  migration, not an edit.
- Findings left open with reasons on the PR: the CycleCounts "replay a committed completion" UX gap
  (no double-apply risk - the impl raises on a non-`in_progress` status either way; the fix needs a
  new `hasKeyFor` probe on the shared money-path idempotency hook), the BulkFieldImport `fieldIndex`
  scope question (parked in a prior round as Mason's call), the BlendRecipes duplicate-intent routing
  (same hook change), the `src/lib/idempotency.ts` FNV-collision binding (server half needs a
  migration), and the Reports.tsx server-derived commission date (needs a migration).

### Proof

`npm run typecheck`, `npm run lint`, `npm run test` (367 files, 5150 passed / 123 skipped) and
`npm run build` all green on this working tree.
