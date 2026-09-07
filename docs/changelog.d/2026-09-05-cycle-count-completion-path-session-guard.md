## 2026-09-05 — guard the cycle-count COMPLETION path, the half the first fix missed

CodeRabbit's review of head `7e98858cb` raised one actionable finding, and it was correct: the
request-token guard added earlier on this branch covered `openDetail` and nothing else. The
completion path writes the same shared detail state, after its own awaits, from a different function.

**This is the same defect as the Major finding this branch already "closed", reached through a
function the guard never covered.** Guarding one entry point made the file read as protected — the
one-half-of-a-pairing shape that has now bitten this branch repeatedly, this time with the fix author
as the one who introduced it.

### The hole

`handleComplete` → `waitForAuthoritativeCountItems` → `refreshCountItems` ends in a bare
`setCountItems(rows)` after two awaits, with no currency check. The detail modal's close handler was
`onClose={() => setShowDetail(false)}` — it hid the modal without cancelling the in-flight completion.
So:

1. Open count A, click **Complete & Apply Adjustments**
2. Close the modal while its two authoritative reads are in flight
3. Open count B
4. A's refresh resolves last and paints **A's rows under B's heading**

`updateCountedQty` derives `p_item_id` from exactly that state, so the operator's next edit sends an
inventory adjustment for a product they are not looking at. `completionInFlightRef` blocks edits only
*during* completion; it clears in the `finally` while the stale rows are still on screen.

### The fix

The token is now a **detail session** rather than an `openDetail` request, and it is threaded from the
click through every await on the completion path:

- `refreshCountItems` takes `isCurrentSession` as a **required** parameter. A caller that cannot say
  which session it is refreshing for has no business painting rows, and making it required is what
  stops the next completion path from being added without a guard.
- `waitForAuthoritativeCountItems` takes the same predicate and re-checks after each await — before
  the toasts as well as the writes, since a superseded completion has no standing to report on a count
  the operator has left.
- `handleComplete` captures the session synchronously with the click and passes it down.
  `executeComplete` inherits it, or captures at entry for the confirmation dialog's `onConfirm`, which
  is itself a click.
- The `complete_cycle_count` RPC gets its own gate, because `runCriticalAction` adds an async boundary
  between the caller's check and the call. It **throws** rather than returns: returning is how
  `runCriticalAction` is told the work succeeded, so a silent return would fire the success toast and
  close the modal for a completion that never ran.

### What was deliberately NOT done, and why

The review asked for the session to be invalidated **when the modal closes** as well as when another
count opens. That half is declined, with reason: closing the modal mid-completion would then abort a
completion the operator had already asked for and tell them they "moved to a different cycle count"
when they had not. It is also unnecessary — the hazard is a superseded response painting over a
*different* count, and every route to a different count goes through `openDetail`, which bumps the
session (including reopening the same count, which an id comparison would miss). With the modal closed
there is nothing on screen to paint over.

`closeDetail` therefore exists to carry that reasoning next to the code, not to bump the session.

### Verification

`typecheck` 0, `lint` 0, `build` 0, and `npm run test` **360 files, 5062 passed, 123 skipped,
EXIT_CODE=0** with no `Errors` line — both signals checked, since they fail in opposite directions.

New runtime test `CycleCounts.completionRace.test.tsx` drives the real page: open A, complete A, close
the modal, open B, release A's completion refresh **last**. It asserts both halves — that `ALPHA
PRODUCT` is not on screen, and that no `complete_cycle_count` call was made for a count the operator
walked away from.

**Mutation-proven, and proven to cover NEW ground:** replacing the `refreshCountItems` gate with
`if (false)` fails the new test alone, on the `ALPHA PRODUCT` assertion, while
`CycleCounts.openDetailRace.test.tsx` stays green — which is the evidence that the existing guard and
its test never covered this path.

**Stated honestly:** the extra checks in `handleComplete` after its await and immediately before the
RPC are defence in depth on paths this test does not reach, so they are *not* mutation-proven. They
are kept because the RPC moves real stock, not because they are demonstrated.

`cycleCountCompletionRevision.test.ts` still passes; two of its source-text markers were updated for
the new `refreshCountItems` call form, leaving the ordering invariants themselves unchanged.
