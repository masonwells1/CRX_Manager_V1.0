## 2026-09-04 - Close the two standing HIGH findings from the Sol gate

`gpt-5.6-sol` (high effort, frozen head `c127bd535`) returned 0 BLOCKER / 4 HIGH. Two HIGHs were
refuted against source — the money one was explicitly conditional on a float-based parser body the
frozen diff did not expose, and the real parser assembles digit strings with `parseInt`; the
CycleCounts one described the revision and item reads in the opposite order to the code. The two
that stood are fixed here.

### HIGH 1 — a late vendor-bill response is adopted by a LATER edit of the same bill

`isStillCurrentBill()` compared only the route id. Leaving bill A and returning to it — or simply
closing and reopening A's editor with different figures — makes `currentBillIdRef.current ===
targetBillId` true again, so a stale in-flight response was treated as answering the CURRENT editing
session. On success it closed the new editor and discarded unsaved figures; on a PO-overage refusal
it opened the reason prompt over them, and confirming that prompt calls
`handleEditBill(true, reason)`, which reads the CURRENT form — submitting the new figures carrying a
justification collected for the old ones.

The record was never the right identity; the SESSION is. `editSessionRef` advances on every route
change and every editor open, is captured before the RPC, and is compared after it alongside the
route id. `A -> B -> A` and `open -> close -> open` are now both distinguishable from never having
left.

Two supporting details:

- The counter advances **during render**, not in an effect. `currentBillIdRef` is written by an
  effect, which runs after render, so a response landing in that gap read the OLD id and passed a
  check that should already have failed. Deriving the change during render closes that window.
- `openEditModal` now clears `editOverageMessage`. The route-change effect already did; a same-bill
  reopen did not, so a prompt raised for the previous session could survive into the new one.

The committed-path `editIdem.resetKey()` stays unconditional — that is a fact about the request, not
about the screen.

### HIGH 2 — a swallowed cleanup failure silently wedges the next receipt

The previous commit stopped a failed post-commit `resolveIntent()` from reporting a COMMITTED goods
receipt as failed, and reasoned that retaining the key is safe because a retry replays and
reconciles. That reasoning is correct about double-receiving and **silent about liveness**, which is
what Sol attacked.

Verified in source: `PurchaseOrderDetail` has a `useEffect` on `receiveIntent.unresolvedIntent` that
force-reopens the receive modal with the unresolved payload restored, and `handleReceive` replays
the frozen `lockedRequest` when one exists. So an unresolved intent genuinely blocks receiving a
DIFFERENT shipment until it clears — and the swallow made that state arrive with a success message,
leaving the operator to discover the reopened modal as a mystery.

The receipt still commits, the key is still deliberately NOT retired, and the post-commit flow still
runs. What changed is that the failure is now surfaced: the operator is told the goods WERE
recorded, that the form will reopen showing the same receipt, that submitting it again is safe and
will not double-receive, and that other shipments cannot be received until it clears. That is the
real recovery path — the replay reconciles through the `completedElsewhere` branch.

Telemetry alone was the defect, not the nesting: the nested `try/catch` around Sentry is correct in a
must-not-throw corridor and stays.

### Verification

`typecheck`, `lint`, `test`, `build` pass. **357 files, 5051 passed, 0 failed.**

HIGH 1 has a **runtime** regression test, not a source-text pin:
`VendorBillDetail.routeReset.test.tsx` renders the page, submits an edit on bill A, navigates
A -> B -> A, reopens the editor, then releases A's overage refusal. Mutation-proven — reverting
`isStillCurrentBill` to the route-id-only check fails that test while both pre-existing route tests
still pass, which is exactly the gap the old guard had.

**Not behaviourally verified:** HIGH 2 has no test. Reaching it requires an IndexedDB rejection
during post-commit cleanup, which is not staged anywhere in this suite. The change is a toast plus
telemetry on a path whose surrounding pattern is unchanged; the liveness claim it describes was
verified by reading the recovery effect and the `lockedRequest` replay, not by executing them.
