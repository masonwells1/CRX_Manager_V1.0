## 2026-09-04 - Close the two CodeRabbit findings on the merged #535 head

CodeRabbit reviewed `c5407c463` (the merge commit) at 15:17 UTC and returned CHANGES_REQUESTED with
two findings. Both were verified against current source before any change; both were real.

### 1. CycleCounts — the operator's own edit reported as a foreign change (Minor)

A successful `update_cycle_count_item` only **schedules** `setActiveCount`. `waitForAuthoritativeCountItems`
awaits the pending writes and then read its **captured** `activeCount` for `reviewedRevision`, so an
edit saved moments before clicking Complete left that value on the pre-write revision while the
server had already advanced. The `reviewedRevision !== countState.item_revision` check then reported
the operator's OWN edit as "someone changed a counted quantity", forcing a second review and click.

This is the stale-capture-across-an-`await` shape: state read after an await is not the state the
await produced. Fixed with `latestItemRevisionRef`, a cycle-count-keyed `Map` written **synchronously**
on write success and read in place of state at completion. A ref is not subject to React batching or
to a stale closure. Keyed per cycle count for the same reason the pending/failed write sets are —
this component outlives the detail modal, so an unkeyed value would let count A decide count B's
completion. Falls back to state when this client has acknowledged no write for the count.

The stale comment claiming "own edits keep this in sync" was the bug's own justification and has
been replaced.

### 2. PurchaseOrderDetail — the post-commit guard started one line too late (Major)

`await receiveIntent.resolveIntent()` sat immediately **above** the block whose comment says
post-commit work "must not be able to throw, whatever the notification helpers do later".
`resolveIntent()` writes to IndexedDB and can reject (quota, private window, corrupted store), so a
cleanup failure reported a **committed** receive as failed and skipped the damaged-goods alert, the
PDF and the refresh. Now wrapped in the same try/catch-into-Sentry shape the block below already
uses, with its reporter nested — a guard whose own error path can throw is not a guard.

**Correction to the review's stated consequence.** CodeRabbit's note implies the duplicate-receive
hazard. It does not apply here: if `resolveIntent()` rejects, the intent stays **pending**, so a
retry replays under the SAME key and reconciles against the committed receipt. The duplicate
scenario needs the key to have been *retired*. The fix therefore deliberately does **not** retire or
rotate the key on failure — leaving it pending is the safe direction, and clearing it is what would
let a retry mint a fresh key and receive the goods twice. The real cost was a committed receive
reported as failed, not double inventory.

### Verification

`typecheck`, `lint`, `test`, `build` all pass. **357 files, 5048 passed, 0 failed.**

The new contract test pins the fix as a **pair** — the synchronous ref write AND the read of that
ref — because pinning only the read is satisfied by a ref nothing writes to, and pinning only the
write leaves the completion path free to go back to reading state. Both halves were mutation-proven
independently: reverting the read → RED, removing the write → RED, restored → green.

While writing that test, `expectBefore` compared the wrong occurrence: `setActiveCount((previousCount) =`
is not unique in the file, so raw `indexOf` matched an earlier unrelated call and failed a correct
implementation. The ordering assertion is now scoped to the write-success region. A marker that is
not unique makes an ordering check answer a different question than its name claims.

**Not behaviourally verified, stated plainly:** neither fix was exercised in a browser. Both are
reachable only through states that are awkward to stage live — a write acknowledged but not yet
rendered, and an IndexedDB rejection during post-commit cleanup. The revision fix is pinned by a
source contract test, not a runtime one, and the `resolveIntent` fix has no test at all; it is a
try/catch matching the established pattern twenty lines below it.
