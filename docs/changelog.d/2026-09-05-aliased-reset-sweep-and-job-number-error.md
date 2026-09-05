## 2026-09-05 - Finish F1 for the RENAMED idempotency resets, and stop JobDetail swallowing a job-number failure

PR #584 fixed F1 — *verify the server's reply before retiring the idempotency key* — at every site
that calls the reset by its literal name, `resetKey()`. Components that DESTRUCTURE the hook rename
that method (`const { resetKey: resetSaveQuoteIdempotencyKey } = useIdempotencyKey(...)`), so the
literal sweep never saw them and two defects stayed live on `main`. This closes them.

## Why the ordering matters

A mutating RPC that answers `{ data: null, error: null }` is **ambiguous**: nothing failed, but the
payload is empty, so the screen cannot tell whether the row committed. `assertRpcResult` exists to
reject exactly that reply. Retiring the key *before* that check sends the operator's retry under a
brand-new key — one the server has never seen and therefore cannot replay — so the work is applied
a second time. On these two screens that means a duplicate quote or a duplicate customer.

## The sweep

The alias set was enumerated structurally rather than by name: find every destructuring of
`useIdempotencyKey`, capture the local identifier each one binds, then search for that identifier.
A name-based grep is what under-reported the first time. All 14 files that bind a renamed reset
were resolved and every call site read in context.

Result: **3 defects, 2 files.** Everything else in the alias class is correct and stays untouched —
including the resets that live in a recovery branch (a reset after a lookup PROVES the row does not
exist is right, because it lets a retry mint a fresh key), the route-change rotations, and the
intent-rotation resets in `ProductDetail`, `PurchaseOrderDetail`, `JobDetail`'s notice keys,
`BulkTicketUpload` and `ManualTicketCreate`.

## Fixed

- **`src/pages/QuoteBuilder.tsx`** — `save_quote` retired its key one line before the assert that
  verifies the reply. Reordered.
- **`src/pages/CustomerDetail.tsx`** — `save_customer` had the same reset-before-assert. Reordered.
- **`src/pages/CustomerDetail.tsx`**, route-changed-mid-flight branch — released the key on `!error`
  alone, which does not rule out an empty reply. This branch cannot assert (it must return quietly
  rather than throw into a customer that is no longer on screen), so it now applies the same
  emptiness test inline: `!error && data != null`.
- **`src/pages/JobDetail.tsx`** — `next_job_number` was called as `if (!error && data)`, which
  discarded BOTH failure shapes and left the job-number field blank with no toast and no Sentry
  event. Harmless while the RPC could not fail; not harmless since the F2 number-generator gate
  applied live on 2026-09-04, which raises `INSUFFICIENT_ROLE` for a deactivated or out-of-role
  profile. That user now gets a message naming the cause instead of an empty box.

## Proof

Every test below was confirmed to FAIL against the unfixed source before it passed — including by
mounting the real screens, not only by reading the source.

- `QuoteBuilder.test.tsx` and `CustomerDetail.test.tsx` each drive their real save handler with an
  empty-but-error-free reply and assert the key is not retired AND that a retry carries the SAME
  key. Both bind the pair; asserting only "the key survived" would pass if the retry minted a fresh
  key some other way.
- `JobDetail.billingHazard.test.tsx` mounts `/jobs/new` and asserts a toast for both failure shapes
  — a raised `INSUFFICIENT_ROLE` and an empty reply.
- `src/__tests__/idempotency-reset-order.test.ts` gains source-order pins for the aliased class.
  They assert ORDER, not proximity: "an assert appears near this reset" is satisfied *by the bug*,
  because the buggy order still has the assert — one line below.

### A stubbed guard that hid the defect class

Three test harnesses mocked `assertRpcResult` as `vi.fn((d) => d)` — a passthrough that never
throws. That stub DELETES the ambiguous-reply path from every test in those files, so a screen that
retires its key before checking the reply stayed green no matter what. `QuoteBuilder.test.tsx`,
`CustomerDetail.test.tsx` and `JobDetail.billingHazard.test.tsx` now import the real function, which
is what made behavioural proof possible at all. `JobDetail.billingHazard.test.tsx` was also missing
`hasRpcCode` and `RpcErrorCodes` from its `../lib/db` mock.

## Known-unfixed list

`KNOWN_UNFIXED_SITES` shrinks accordingly: `QuoteBuilder`'s aliased entry is gone, and
`CustomerDetail` drops from two entries to one. The remaining `CustomerDetail` entry is the
route-changed branch — now correct, but still reported by a scanner that reads LINE ORDER and cannot
see an inline emptiness test. It stays pinned so the scan stays honest, and its fix is separately
bound by a test that fails if the `data != null` check is deleted.

## Found, NOT fixed — reported rather than silently widened

An independent scan of ALL 274 reset call sites (literal, aliased and `idem.resetKey()` member
form) flags **28 further reset-before-assert sites** in the member-call form, across ~20 files
including money paths (`allocate_payment`, `batch_apply_prepayments`, `draw_down_quote`,
`transfer_job_to_invoice`). These are NOT new: every one is already pinned in
`KNOWN_UNFIXED_SITES`, which is asserted to equal the scanner's output, so none can drift
unnoticed. Four of them (`DeliveryDetail` complete/cancel/void, `OrderDetail` void) carry in-code
notes explaining that a reorder alone is insufficient — they send mutable payload fields and need
PR #535's `fingerprintIntentPayload`. Widening this PR to ~20 files would collide with the parallel
sessions holding several of them. Flagged for a scoping decision instead.
