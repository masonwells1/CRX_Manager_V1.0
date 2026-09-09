## 2026-09-04 - PR #535: close the open CodeRabbit findings, including a cross-bill overage authorization

CodeRabbit's 06:34 review of `be4863f9c` left five findings unaddressed, and its 11:13 review of
`37b488b16` added a sixth. Five are fixed here; one is answered and stays parked.

### Fixed

- **`VendorBillDetail.tsx` — a PO-overage refusal for one bill could authorize an overage on
  another (Major, money).** This is the most serious item on the list. `handleEditBill` awaits the
  `update_vendor_bill` RPC, and this page stays MOUNTED across `/accounts-payable/bills/:id`
  changes, so nothing cancels a handler whose route moved underneath it. If bill A's save was still
  in flight when the operator opened bill B, A's refusal set `editOverageMessage` again and
  `ReasonModal` reopened over B. Confirming it calls `handleEditBill(true, reason)`, which reads the
  CURRENT `bill` — submitting **bill B** with `p_confirm_po_overage=true` and A's justification.
  B's own cumulative total was never the thing the server objected to.

  The existing entry guard does not catch this and could not: by the time the late answer lands,
  `bill`, `id` and `editModalBillId` have all legitimately advanced to B, so every identity check
  passes. The only stale thing is which bill the answer is *about*. Fixed with a route-generation
  ref captured before the RPC and checked after it; a late answer now reports to Sentry and touches
  no UI. `editIdem.resetKey()` still runs on the committed path — that is a fact about the request,
  not about the screen — and `setEditing(false)` moved into a `finally` so the early returns cannot
  strand the page mid-save.

- **`PurchaseOrderDetail.tsx` — damaged-goods alerts were dropped on a replay (Major).** The
  damaged-item notification sat inside `if (po && !completedElsewhere)`. When a receive is retried
  and the server reports it already committed — including the common case where the first attempt
  succeeded but its response never came back — inventory was recorded while the damage alert was
  never sent. Moved out of that guard; re-alerting is prevented by the receipt-derived idempotency
  key, which falls back to the request's own key when the replay carried no `receiving_record_ids`.
  The over-receive notification deliberately STAYS gated: it carries no idempotency key, and the
  remaining quantity it reports is computed from in-memory `items` that a replay has already moved
  past, so on a replay it would send a duplicate alert quoting wrong numbers.

- **`CycleCounts.tsx` — completing one count could hang on another (Major).**
  `pendingItemWritesRef` was component-wide and outlives the detail modal, so
  `waitForAuthoritativeCountItems` awaited a stalled save belonging to a different count, with
  nothing to time it out. Each pending write now carries its `cycle_count_id` and completion waits
  only on its own — matching how failed writes were already scoped. Both sets have to be scoped or
  the wedge just moves from one to the other.

- **`prove-gauntlet-write-boundary-concurrency.mjs` — an assertion weaker than its own message
  (Minor).** It claimed the trigger "locks the parent count row" while testing only
  `indexOf('FOR UPDATE;') >= 0`, which any lock on any table satisfies. Now matches the table, the
  parent predicate and the lock as one pattern.

- **`NewVendorBill.overage.test.tsx` — the test replaced the guard it stood next to (Minor).**
  `assertRpcResult` was stubbed as an identity function, so a null `data` — what a silent RLS denial
  looks like from PostgREST — would have flowed into the success path while production threw.
  Un-stubbed. Un-stubbing alone changed nothing measurable, because the existing cases assert on
  `mockRpc.mock.calls`, captured before the guard runs; a third case now drives a null result and
  requires an error toast, no success toast and no navigation.

### Answered, still parked

- **`idempotency.ts` — bind `adjust_inventory` / `retire_inventory_item` receipts to the request
  (Major).** Accepted as real and unchanged. The server-side half needs a migration, and the six
  #535 migrations were applied to production on 2026-09-03 and are immutable. Forward-migration
  backlog, not a #535 blocker.

Two of the three parked request-identity items from the round-3 Sol proof remain parked: overlapping
`CycleCounts` detail loads, and the un-awaited reconciliation refresh in the committed-edit branch.

### Verification

Every fix here is mutation-proven — reverted, observed red, restored:

- The cross-bill overage race is reproduced in a RUNNING page.
  `VendorBillDetail.routeReset.test.tsx` holds the RPC open across a real route change, opens bill
  B's editor, then releases A's refusal. Without the guard: `expected <textarea …></textarea> to be
  null` — the overage prompt reappears over bill B. With it, green.
- The un-stubbed `assertRpcResult`: reinstating the identity stub turns the new case red.
- The cycle-count scoping: reverting to the component-wide await turns the source guard red.
- The trigger-lock assertion: against a mutant locking a DIFFERENT table, and one with the parent
  predicate removed, the old assertion PASSED and the new one fails; both accept the real trigger.

`npm run typecheck`, `npm run lint`, `npm run test` and `npm run build` all pass.

The `PurchaseOrderDetail` replay path is the one fix here that is NOT behaviourally exercised —
provoking it needs a server that reports an already-committed receipt. It is a guard removal on an
existing, tested notification call rather than new logic, but it is stated as an open gap rather
than claimed as proven.
