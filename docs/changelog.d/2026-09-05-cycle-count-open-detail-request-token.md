## 2026-09-05 — guard the cycle-count detail load, a race this branch made worse

CodeRabbit's review of frozen head `de2c43a83` raised a Major data-integrity finding in
`CycleCounts.tsx`: opening count A then count B lets A's slower item query resolve last and paint
A's rows while `activeCount` is B. `updateCountedQty` derives `p_item_id` from exactly that state, so
an inventory adjustment could be sent against a different count's item than the one on screen.

**This was initially routed to the purchase-order-race session as pre-existing, on the claim that
#535 did not touch this path. That claim was wrong**, and the correction came from that session. The
record matters more than the fix:

- `git diff --numstat origin/main...` shows **408 added / 51 removed** in `CycleCounts.tsx`. Not
  untouched.
- **This branch WIDENED the window.** `main` reaches `setCountItems` after ONE await. The revision
  seed read added here put a second await ahead of the items query.
- **The guard was on the wrong write.** `setActiveCount` was guarded by id; `setCountItems` and
  `setLoadingItems` were not. `setCountItems` is the one that puts another count's rows on screen.
  A single guarded write made the function *read* as protected — the same one-half-of-a-pairing shape
  this branch has been finding elsewhere throughout.

So this is not a deferred pre-existing defect. Part of it is ours, and it is fixed here.

### The fix

`openDetailRequestRef` identifies the newest `openDetail` call. Every response-derived write is gated
on still being that call: the revision seed (both the `delete` and the `set`/`setActiveCount` pair),
and a single `if (!isCurrentRequest()) return;` after the items query covering the error toast,
`setCountItems`, and `setLoadingItems`.

`setLoadingItems(false)` is deliberately inside the gate. The newest call owns that flag; letting a
superseded one clear it would drop the spinner while the current count is still loading.

An id comparison would not have been sufficient. Reopening the **same** count twice produces two
calls whose ids match, and the older response would still be adopted. The token distinguishes calls,
not records.

### Verification

`typecheck` 0, `lint` 0, `build` 0, and `npm run test` **359 files, 5061 passed, EXIT_CODE=0** with no
`Errors` line — both signals checked, since they fail in opposite directions.

New runtime test `CycleCounts.openDetailRace.test.tsx` renders the real page, clicks count A then
count B, and releases A's held query LAST. **Mutation-proven:** replacing the gate with `if (false)`
fails that test alone, on the assertion that `ALPHA PRODUCT` must not be on screen — the exact
operator-visible symptom.

The existing `cycleCountCompletionRevision.test.ts` invariant still passes: the revision `set` and its
paired `setActiveCount` remain adjacent and carry the same revision expression.
