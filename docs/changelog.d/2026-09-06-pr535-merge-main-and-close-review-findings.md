## 2026-09-06 - Bring PR #535 current with `main` and resolve the two merge conflicts by content

PR #535 (`codex/gauntlet-s9-safety-20260831`) had sat `DIRTY`/`CONFLICTING` since 2026-09-05, which
blocks the CodeRabbit gate outright — a conflicting PR cannot even receive a review. `origin/main`
was merged in at `8cff940ce`. Two files conflicted; both were resolved by reading what each side
means, not by taking a side.

### `src/components/fields/BulkFieldImport.tsx` — three hunks, all "keep both"

Both branches edited `handleUpload`, for unrelated reasons.

- **The loop header.** The branch changed `for (const pf of validFields)` to
  `for (const [fieldIndex, pf] of validFields.entries())` so each row's idempotency scope can carry
  its ordinal. `main` added a per-row `saveOutcome` state machine
  (`'not-sent' | 'committed' | 'rejected' | 'unknown'`) declared at the top of the loop body. The two
  changes are orthogonal: the resolution keeps the destructured loop header **and** the
  `saveOutcome` declaration. Taking either side alone loses a real behaviour — `fieldIndex` would be
  undefined, or every row's outcome would go back to being reported as safe to re-import.
- **The `save_field` call.** The branch replaced `p_idempotency_key: crypto.randomUUID()` with a
  scoped, payload-fingerprinted `saveFieldIdem.getKeyFor(intentScope)` so a retry of the same row
  replays instead of double-creating. `main` added `status: saveStatus` to the destructure and set
  `saveOutcome = 'unknown'` immediately before the call, so a lost response is never reported as a
  rollback. Resolution keeps the branch's `intentScope` computation, then `main`'s pessimistic
  `saveOutcome = 'unknown'` assignment and its `saveStatus` destructure, then the branch's scoped key
  in the argument list. `intentScope` is pure, so computing it before the assignment does not widen
  the window the assignment protects.
- **The end of `handleUpload`.** The branch's tail was
  `uploadInFlightRef.current = false; if (success > 0) { onSuccess(); }`. `main` deleted the trailing
  `onSuccess()` because it moved the parent refresh **earlier** and widened its condition to
  `success > 0 || created > 0 || unknownOutcome > 0`, awaited it, and reports a failed refresh to the
  operator — the point being that a row with an unknown outcome must also refresh the list behind the
  modal. `uploadInFlightRef` does not exist on `main` at all; it is the branch's double-submit latch,
  and this is its only reset site. Resolution: drop the duplicate `onSuccess()` (keeping it would
  double-refresh and re-introduce the narrow `success > 0` gate `main` deliberately removed), keep
  the latch reset. Dropping the latch reset instead would have wedged `handleUpload` and
  `handleClose` for the life of the modal.

### `docs/manual/KNOWN_ISSUES.md` — an append collision, not a disagreement

Both sides added a new section immediately after the file header. The branch added the OPEN
2026-09-05 wrong-purchase-order receiving entry; `main` added the CLOSED 2026-09-05 maintenance
producer retirement. They document unrelated issues, so both are kept, in that order, with the
separator convention each side's own file uses.

### Proof

`npm run typecheck` clean on the merged tree. Both conflicted files' tests pass (3 files, 42 tests).
The **incoming** branch's own tests were run separately rather than relying on the full suite —
all 10 test files `main` added or changed since the merge base pass (165 tests) — and so did the 21
test files this branch owns (337 tests).
