## 2026-09-04 - PR #535: close three post-commit boundary holes found by the round-3 Sol proof

Third `gpt-5.6-sol` high-effort review, frozen candidate `f8687e734`, prompted with the two newest
commits named as prime suspects and all six previously-rejected claims listed for challenge.
Result: **0 BLOCKER**, 4 HIGH, 2 MEDIUM, 2 LOW, 0 QUESTION. None of the six rejections was
overturned.

This commit fixes the three findings that share one root cause — **work that runs after a mutation
has committed and its idempotency key has been retired, but still inside the mutation's error
boundary**. An exception there reports a committed write as failed; the operator's retry then mints
a fresh key and can apply the write twice.

### Fixed

- **`PurchaseOrderDetail.tsx` — the post-commit notification guard could itself throw (HIGH).** The
  round-1 fix wrapped the notification block, but its `catch` called `Sentry.captureException`
  unprotected. The *same diff* had already established that the reporter can throw — that is exactly
  why `logNotificationFailure` wraps its own Sentry calls — so this guard was inconsistent with its
  own rationale. A guard whose error path can throw is not a guard. An exception here reported a
  committed receipt as failed and let a fresh-key retry receive the goods twice.
- **`CycleCounts.tsx` — the same hole in the completion activity-log catch (MEDIUM).**
  `complete_cycle_count` has committed and its key is retired; an unguarded reporter exception in
  the `logActivity` catch presented a committed inventory adjustment as a failure.
- **`IntegrityCleanupPanel.tsx` — the reconcile refresh sat inside the mutation boundary (HIGH).**
  `await fetchAll()` ran inside the same `try` as the RPC, after `resetKeyFor` had retired the
  receipt. A refresh rejection was therefore reported as a FAILED reconciliation, and a retry minted
  a fresh key and re-applied an ABSOLUTE inventory quantity — overwriting any legitimate stock
  movement in between. The success boundary now ends at the proven RPC; a refresh failure says only
  that the refresh failed.

### Parked — real, but needing a design pattern rather than a 2am patch

- **HIGH `VendorBillDetail.tsx` — the route reset does not invalidate an edit already in flight.**
  If bill A's save is pending when the route changes to B, the old handler can resume and reopen A's
  overage prompt on B, alter B's modal/loading state, or refresh with A's data. Correctly noted:
  the new `routeReset` test does not cover this, because it navigates only after the refusal has
  already arrived. Needs a route-generation token checked after every await.
- **HIGH `CycleCounts.tsx` — overlapping detail loads can display and mutate the wrong count.** The
  revision update checks the count id, but the later items result and `setLoadingItems(false)` are
  unconditional, so a slow load for count A finishing after B is opened leaves B active with A's
  rows on screen; editing one then mutates A. Needs the same request-token treatment.
- **MEDIUM `VendorBillDetail.tsx` — the committed-edit reconciliation branch does not await its
  refresh**, so the operator can reopen Edit Bill against stale pre-commit money values.
- **LOW — FNV-1a as the sole payload separation for key-only RPCs.** Unchanged documented residual;
  the structural fix is a collision-resistant digest or the full canonical payload as the local scope.
- **LOW `CycleCounts.tsx` — the stale-revision branch double-reports** and leaves the refused
  revision's completion key cached.

These four route/request-identity items are one coherent pattern applied across several pages, on
money and inventory paths. Doing that unattended at 02:00 is how the incident it prevents gets
caused; they are Mason's call.

### Verification

`npm run typecheck`, `npm run lint`, `npm run test` (355 files, 4993 passed, 0 failed) and
`npm run build` all pass. These three changes are error-path hardening and are **not**
behaviourally proven — provoking them requires making the Sentry transport and a refresh query throw
on demand. Recorded as an open gap, consistent with the rest of this branch.
