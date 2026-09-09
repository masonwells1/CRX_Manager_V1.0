## 2026-09-04 - PR #535: behavioural proof for the vendor-bill route-reset fix

Adds `src/pages/VendorBillDetail.routeReset.test.tsx`, which drives the REAL page through a real
route change with the PO-overage confirmation open, rather than asserting on source text.

**Why it navigates instead of re-rendering.** `VendorBillDetail` stays MOUNTED across
`/accounts-payable/bills/:id` changes — that is the whole precondition of the bug. A fresh render
would reset state by itself and prove nothing, so the test renders a navigation control OUTSIDE
`<Routes>` and clicks it, leaving the page mounted exactly as production does.

**The first version of this test was vacuous, and mutation testing caught it.** It asserted the
prompt was gone immediately after navigation — but the `[id]` effect sets `loading`, and while
loading the page renders a spinner instead of the modal tree, so the prompt leaves the DOM whether
or not `editOverageMessage` was cleared. It passed with the fix deleted. It now waits for the NEXT
bill to finish rendering before asserting, which is the only point where the two cases differ.

**Proof performed:** with `setEditOverageMessage(null)` removed from the `[id]` effect the test
FAILS (`expected <textarea …> to be null` — the previous bill's overage prompt is still on screen);
with it restored the test PASSES. The source was then confirmed byte-identical to the committed
version (`git diff` empty).

**Scope of this proof.** It covers the `VendorBillDetail` route-reset fix only. The sibling
CycleCounts confirmation-identity fix from the same review round is still verified by typecheck,
lint, the full suite and build — not by executing that flow — because driving it needs a completion
confirmation and an active-count switch. That remains an open verification gap, consistent with how
the rest of this branch's UI work is recorded.
