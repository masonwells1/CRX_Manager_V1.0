## 2026-09-04 — Sol round 2: the findings the first pass left on the table

The previous commit closed the 2 HIGH and 1 MEDIUM from the `gpt-5.6-sol` gate on `862cd144d` and
left the other findings unadjudicated. This closes that gap: every remaining finding is either fixed
with a runtime regression test or adjudicated here with its reasoning.

### MEDIUM — the receiving warning promised a form reopen that could not happen

When the post-commit durable-intent cleanup rejects, the warning toast told the operator the
receiving form "reopens showing this same receipt". It does not. The recovery effect is
**edge-triggered** on the identity of `unresolvedIntent`, and a failed `resolveIntent()` never calls
`applyRecord`, so the very same object stays in place and nothing re-runs the effect. The
post-commit corridor then called `setReceiveOpen(false)` and closed the form. The operator read a
promise, watched the form close, and was left with an expiring toast.

Fixed with a **local** `cleanupFailed` flag — not a re-read of the effect's state, which is the thing
that cannot be trusted here — so the form stays open and the sentence is true. The recovery routes
that already worked (clicking Receive again, or reloading) are unchanged.

### MEDIUM — a replayed receipt regenerated a receiving slip with the wrong time and receiver

The PDF block was not gated on `completedElsewhere`, but it stamps `new Date()` and the CURRENT
operator's name. A replay answers for a receipt that committed EARLIER, possibly in another tab or
by another person, so the regenerated slip stated a receiving time and a receiver that never
happened — on a document that goes into a vendor file. The damaged-goods alert (deduplicated by
receipt-derived key) and the over-receive alert (already scoped to a first commit) were both
correct; only the PDF was missed.

Now scoped to a first, non-replay commit. Nothing is lost: receiving history's own download button
(`handleDownloadHistoryPdf`) prints from the STORED record and carries the real `received_at` and
`received_by_name`.

### MEDIUM — the session counter was mutated during render

`editSessionRef` was incremented in the component body. React may render a screen and then discard
it — this app wraps its lazy routes in `<Suspense>` (`App.tsx`), so an interrupted navigation does
exactly that — and React does not roll back a ref written by an abandoned render. The counter
advanced for a bill the operator never moved to, and a legitimate in-flight save for the bill still
on screen was then judged stale: the wrong "an earlier edit finished" warning, and a re-save writing
a second activity row for one edit.

Moved into a **layout effect** with `currentBillIdRef`. That is the commit-phase middle: it runs
synchronously before paint, so it is no later than the render-phase write from the operator's point
of view, and React never runs it for a render it throws away. A passive `useEffect` would reopen the
deferred-past-paint gap that Sol's round-1 HIGH was about.

### Adjudicated, deliberately not changed

- **LOW, no reentrancy guard on `handleEditBill`.** Real but benign: `Button` sets
  `disabled={disabled || loading}`, and two submissions that beat the re-render share the SAME
  idempotency key, so the server returns one result rather than applying two. The worst outcome is a
  duplicate success toast. A ref-based guard would have to release correctly on every one of the
  handler's early returns; that is a larger chance of introducing a defect than the one it removes.
- **INFO, `Number.MAX_SAFE_INTEGER` on the session counter.** Requires ~9×10^15 route changes or
  editor opens within a single mount.
- **INFO, truncated review context.** A process finding against the reviewer packet, not the code:
  two findings could only be returned CONDITIONAL because the excerpts stopped short. The next gate
  gets whole files.

### Verification

`typecheck`, `lint`, `test`, `build` pass. **358 files, 5057 passed, 0 failed** (up from 357/5052).

Both new behaviours have **runtime** tests that render the real page and drive the real sequence, in
a new `PurchaseOrderDetail.receivingReplay.test.tsx` — the receiving flow had no page-level test at
all before this. Both are mutation-proven: ungating the PDF fails the replay test, and closing the
form unconditionally fails the cleanup-failure test, each with no other test affected. A third test
pins the ordinary path where cleanup succeeds, so "keeps the form open" cannot pass against a page
that simply never closes it.

**Mutation testing found a defect in the existing tests, not just the code.** Deleting the
route-change session bump left every route test GREEN: the A → B → A test reopens the editor, and
`openEditModal` bumps the session by itself, so the route bump was carried by its partner and pinned
by nothing. The case only it can catch — the same round trip WITHOUT reopening the editor, where a
stale refusal raises the overage prompt on a page that has no editor open — is now a test, and it
fails alone under that mutation.

Two further test gaps from the gate are closed: a stale **success** landing on a replacement editor
(previously every test released a refusal, leaving that half of the session check unpinned), and the
fixed `setTimeout(resolve, 50)` waits, which asserted an absence after an arbitrary delay and would
start passing for the wrong reason the moment anything deferred that work. Each now waits on a
positive sentinel proving the late response actually reached and finished the handler.
