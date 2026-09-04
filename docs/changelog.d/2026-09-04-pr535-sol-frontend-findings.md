## 2026-09-04 - PR #535: close the Codex Sol frontend findings on the frozen candidate

Adversarial `gpt-5.6-sol` review (high reasoning effort) of the `src/` half of PR #535 at frozen
candidate `b07351a677de6d6407bd6993629125586b8774a1` returned 17 findings: 1 BLOCKER, 1 HIGH,
7 MEDIUM, 5 LOW, 3 QUESTION. Each was verified against current source before acting. 13 were
confirmed and fixed; 4 were disproved and are recorded below so they are not re-raised.

The six #535 migrations were applied live on 2026-09-03 and are immutable. Everything here is
frontend-only: no SQL, no schema, no data.

## Confirmed and fixed

- **BLOCKER — cycle count completion adopted another client's quantities silently.**
  `p_expected_item_revision` fails closed only for a change landing DURING completion. A change that
  landed BEFORE the operator clicked Complete was refreshed into the snapshot and committed
  immediately: the screen showed 10, another tab set 100, and completion applied an inventory
  adjustment for 100 that nobody reviewed. `waitForAuthoritativeCountItems()` now captures the
  reviewed revision before refreshing, and refuses the completion with a refreshed list and an
  explanation when it differs; the next click completes what is on screen. `openDetail()` seeds the
  reviewed baseline from the server so a stale list row does not warn spuriously.
- **HIGH — a post-commit notification failure could cause a double receive.**
  In `PurchaseOrderDetail`, the damaged-receiving notification is awaited after `receive_po_items`
  has committed and `resolveIntent()` has retired the retry lock. A rejection there reported the
  whole action as failed, and the operator's retry minted a fresh key against the retired intent —
  receiving the same goods twice. The post-commit block is now non-throwing, and
  `logNotificationFailure()` can no longer propagate a failure from Sentry reporting itself
  (protecting all 14 notify* call sites).
- **MEDIUM — a thrown cycle-count item write left no failed marker.** Only returned `{ error }` was
  recorded; a transport rejection or `assertRpcResult()` failure escaped the queued task, and the
  rejected promise was then dropped from the pending set — so the next completion attempt saw a
  clean set and committed the stale quantity, discarding the operator's edit.
- **MEDIUM — non-finite counted quantities.** `parseFloat("1e309")` is `Infinity`, which
  `JSON.stringify` canonicalizes to `null`, making a garbage entry byte-identical to a deliberate
  "clear this count" intent and silently clearing the quantity. Rejected at the input boundary.
- **MEDIUM — bulk receiving reversal hid committed work after a partial failure.** Each row commits
  independently, but the refresh only ran from `onSuccess`, so rows already reversed stayed on
  screen. The log now refreshes on partial failure and reports where the run stopped; retained keys
  are left intact so an unchanged retry replays and continues.
- **MEDIUM — a guard test that could not fail.** `gauntletFrontendSafetyGuards` asserted
  `'if (uploadInFlightRef.current) return;'` against the whole file; that string is the *dismissal*
  guard in `handleClose`, while the upload guard reads
  `'if (!profile || uploadInFlightRef.current) return;'`. Deleting the upload guard left the test
  green. Both halves are now pinned separately, the upload half anchored to the handler's first
  line. Mutation-tested: removing the guard turns the test red.
- **MEDIUM — the overage test asserted a contract that does not exist.** It stubbed `hasRpcCode` as
  `error.code === '22023'`, but the real helper matches on the error MESSAGE and the real constant is
  the semantic string. The test now uses the real helpers (mocking only the Supabase client) and a
  production-shaped error.
- **LOW — damaged-goods alert silently skipped.** `QuickReceivePanel` gated the notification on
  `receiving_record_ids`, so a contract regression would record damaged stock with no admin alert and
  no failed-notification row. It now falls back to the receipt's idempotency key, matching
  `PurchaseOrderDetail`. The key is captured before `resolveIntent()` retires the intent.
- **LOW — `fingerprintIntentPayload` doc overclaimed.** It said the server's intent binding remains
  authoritative, but `adjust_inventory` and `retire_inventory_item` replay on the key alone, so the
  64-bit digest is the only payload distinction there. Documented honestly, with a rule against
  widening its use to a new key-only RPC.
- **LOW — two tests renamed/rewritten to match what they prove.** "does not throw on an unserializable
  payload" only ever passed `undefined`; circular and BigInt payloads do throw, and that is now pinned
  explicitly as deliberate (a lossy fallback would let two payloads share a fingerprint). The
  "drops the overage confirmation" test passed the already-unconfirmed survivor in and asserted it was
  unconfirmed — tautological; it now builds confirmed args and exercises the call site's selection.
- **QUESTION — money could exceed exact integer range.** `isWholeCentDollarInput` bounded decimal
  places but not magnitude, so `90071992547409.93` parses to 9007199254740993 cents, past
  `Number.MAX_SAFE_INTEGER`, and would reach a money RPC silently rounded. Now rejected, with the
  boundary case below it still accepted.
- **QUESTION — stale-revision refusal was unexplained.** `CYCLE_COUNT_STALE_REVISION` fell through to
  the generic sanitized exception with no refreshed list. Registered in `RpcErrorCodes` and handled:
  refresh the authoritative rows and tell the operator plainly what happened.

## Disproved — do not re-raise

- **"Entering 0 wedges the Create Bill button."** The early return sits inside the `try` whose
  `finally` calls `setSaving(false)`. The button resets correctly.
- **"Two differing corrections can run concurrently in IntegrityCleanupPanel."** `Button` sets
  `disabled={disabled || loading}`, so the second click cannot fire while the first is in flight; a
  same-tick double click carries an unchanged payload and is caught by the scope guard. The related
  *stale tab overwriting an absolute quantity* concern is real but needs an expected-revision
  parameter on `reconcile_negative_inventory` — forward-migration backlog, not fixable in frontend.
- **"`complete_cycle_count` / `notify_damaged_receiving` violate the assertRpcResult rule."** Both
  RETURN void, so `assertRpcResult` (which asserts a non-null result) cannot apply. The
  `.throwOnError()` fire-and-forget form is the deliberate documented convention and is what the
  coverage check expects.
- **"The reason-required refusal has no branch and whitespace can reach the RPC."** `ReasonModal`
  trims before validating and passes the trimmed value, with `minLength={5}`, so a blank or
  whitespace-only reason cannot reach `create_vendor_bill`.

## Verification

`npm run typecheck`, `npm run lint`, `npm run test` (354 files, 4992 passed, 0 failed — three tests
added), and `npm run build` all pass locally on this tree.
