## 2026-09-04 — Stop purchase-order receiving from booking goods against the wrong PO

### What was wrong

`src/pages/PurchaseOrderDetail.tsx` could show one purchase order's number above a
different purchase order's line items, and receive goods against the wrong one.

React Router reuses this component when only the `:id` in the URL changes, so the
previous PO's header, lines and receiving history stayed in React state while the next
PO loaded. `fetchPO` awaited the header query, called `setPo`, then awaited a *second*
query for the line items and called `setItems` — with no check that the URL still
pointed at the PO it had started loading. Nothing cleared `po` / `items` /
`receivingHistory` on a route change either; the route effect only reset the submit key
and closed the receive modal.

Open PO A, navigate to PO B, let B load, and then let A's slower line-item query land:
`items` is overwritten with PO A's lines while the header still reads PO B. An operator
who clicks **Receive Items** from that screen submits PO A's `po_item_id` values.
`receive_po_items` derives the affected PO from the submitted item ids alone — there is
no expected-PO parameter — so the goods are recorded against PO A and the operator is
told it succeeded.

This was **pre-existing on `main` and live in production**, not a regression. It was
found by a `gpt-5.6-sol` adversarial gate while reviewing PR #535; the function is
byte-identical on `origin/main`.

### What changed

Three guards in `src/pages/PurchaseOrderDetail.tsx`:

1. **Ticketed fetches.** `fetchPO` and `fetchReceivingHistory` each take a ticket from a
   ref counter and re-check it after *every* await. A superseded fetch writes no state.
   Deliberately unlike the `VendorBillDetail.tsx` precedent this follows: there, the
   guarded early return leaves the shared `loading` flag true and can wedge the page on
   a spinner. Here the loading flags belong to whichever fetch still holds the newest
   ticket, so every early return leaves them consistent.
2. **Blank on route change.** A `useLayoutEffect` on `[id]` clears `po`, `items` and
   `receivingHistory` and raises both loading flags before the load effect runs, so a
   stale render cannot mix two POs even for one frame.
3. **Submit ownership check.** `handleReceive` refuses, with an operator-facing message,
   if any line on screen carries a `purchase_order_id` other than the routed `id`.

A missing PO now also clears `po`/`items` instead of leaving the previously loaded PO's
lines on screen.

### Proof observed

Ran in a real browser against a throwaway Vite harness that stubs only
`@supabase/supabase-js`, so the real `db.ts`, `sanitizeError` and `assertRpcResult` all
execute. Held PO A's line-item query open, navigated to PO B, released A's query last —
same harness, same clicks, only the source file swapped:

| | unfixed (`origin/main`) | fixed |
|---|---|---|
| on screen | `PO-B-2002` header + PO A's Atrazine line; PO B's line gone | `PO-B-2002` + Roundup only |
| receive 4 units → RPC | `po_item_id: item-a1` (**PO A**) | `po_item_id: item-b1` (PO B) |
| toast | "Items received and inventory updated" | same |

The unfixed run books goods against the wrong PO and reports success. Reverted to
`main`, reproduced the defect, restored the fix, re-verified. Console is clean.

### Automated coverage, and proof the tests can fail

`src/pages/PurchaseOrderDetail.routeRace.test.tsx` renders the real page, drives an
A-then-B navigation with each query released under test control, and asserts the page
never presents B's header with A's lines — and that a receive submitted from that state
cannot carry A's item ids. 7 tests; full suite green (350 files, 4983 passed, exit 0).

Each guard was then removed **on its own** and the suite re-run, because a guard whose
failure is carried by a neighbour is not actually tested:

| Guard disabled (alone) | Test that went red |
|---|---|
| `fetchPO` token check after the line-items await | drops PO A's line items |
| `fetchPO` token check after the header await | drops PO A's header |
| `fetchReceivingHistory` after the records await | drops PO A's receiving history |
| `fetchReceivingHistory` after the receiver-name await | drops PO A's receiver-name lookup |
| `useLayoutEffect` route-change clear | never renders B's header above A's items |
| `handleReceive` foreign-line refusal | refuses a receive from another PO |

Every mutation was caught, each by exactly one distinct test, confirmed by exit code.

Two defects in the tests themselves were found this way and fixed:

- The receiver-name lookup guard was **not caught** by the first version of the suite.
  `fetchReceivingHistory` awaits twice, and only the first await was covered; the fixture
  left `received_by` null so the second query never ran. A seventh test now drives it.
- The suite passed in isolation but failed in the full run. An effect that runs more than
  once parks the same query twice; the harness released only the first, resolving a
  superseded fetch that correctly writes nothing and leaves the loading flag to the newer
  fetch — which stayed parked, so the page sat on its skeleton. The harness now drains
  every query parked under a key.

Also found while proving it: the mixed render is **not only a race**. Because `fetchPO`
set the new header before awaiting the new lines and nothing raised `loading` on a route
change, PO B's number rendered over PO A's lines on *every* PO→PO navigation,
deterministically — the race only decided which lines won afterwards.

### Not verified

- Every surface that deep-links to `/purchase-orders/:id` was not enumerated;
  `EntityBadge` and `StaleTasksAlert` are two confirmed ones.
- No server-side change was made. `receive_po_items` still derives the PO from the
  submitted item ids. Adding a `p_purchase_order_id` cross-check so the database itself
  rejects item ids from another PO is the strongest fix and would survive a frontend
  refactor, but it is a new migration against an applied money/inventory RPC and is
  recommended to Mason rather than written here.
