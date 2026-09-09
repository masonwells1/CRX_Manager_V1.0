## 2026-09-08 — a frozen screen stayed frozen after the server said no

`useUnresolvedIntent` froze a scope whose outcome was unknown and lifted that freeze only
on a confirmed success or a reload. A faithful retry that came back with a positive server
refusal left the scope frozen, so the operator was stranded on a screen that would refuse
every edit until they reloaded — even though the refusal had already answered the question.

Raised as a P2 by the Codex reviewer against `08e8cead9`.

### Why a refusal is an answer

A faithful retry carries the **same** idempotency key. If the first attempt had committed,
the server would have replayed its stored receipt rather than evaluating the request again.
So an error at all proves no replay happened, and a business refusal — `INSUFFICIENT_HOLD_INVENTORY`,
say — proves the work did not apply. The scope is settled and the operator may edit and
resend without reloading.

### The hole that had to be closed with it

`isDefinitiveRpcRejection` does not exclude every idempotency binding rejection. It filters
`IDEMPOTENCY_INTENT_MISMATCH`, `IDEMPOTENCY_RESULT_INVALID` and `IDEMPOTENCY_RECEIPT_MISSING`
by message, but an **actor** mismatch still reads as a definitive `P0001`. That error is
raised precisely BECAUSE an earlier request under that key committed — so unfreezing on it
would be the exact mistake the freeze exists to prevent. `markIfUncertain` therefore checks
`getIdempotencyBindingRejection(error)` as well, and returns without settling for any of
them. Taking the reviewer's fix at face value would have introduced that hole.

### Proof

Three tests added to `src/hooks/useUnresolvedIntent.test.tsx` (10 total): a refusal settles
the frozen scope; a binding rejection does NOT, for both the actor mismatch and a
message-filtered mismatch; and settling one scope leaves another frozen scope alone.

Mutation-proven, each against the test that owns it — removing the binding-rejection check
fails only "does NOT lift a freeze on an idempotency binding rejection", and reverting to a
bare early return fails only "lifts a freeze when a faithful retry is positively refused".

`tsc` clean, lint clean, `npm run test:correction-guards` exit 0, `check-doc-drift` clean,
full vitest suite 372 files / 5225 passed / 123 skipped / 0 failed.
