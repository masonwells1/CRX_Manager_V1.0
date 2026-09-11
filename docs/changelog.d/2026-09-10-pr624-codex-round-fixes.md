## 2026-09-10 — PR #624: Codex round on `42d335d01` (2 fixed)

The exact-SHA Codex review (`gpt-5.6-sol`, high effort) of `42d335d01` returned BLOCKERS with two
findings. Both are fixed. On Mason's instruction for this PR, the fixes were not sent back to Codex
for another round.

- **Retrying a lost admin-override hold (High).** Suppose an admin forced a hold past the stock
  check and the reply was lost. The dialog's only way forward, "Retry Exact Hold", then re-sent the
  request with `force=false` and no reason. The durable-intent coordinator fingerprints both
  fields, so the retry read as a different request and was refused before it reached the server.
  A committed override could not be reconciled, and the lock stayed until it expired.
  `handleCreateHold` now re-sends the frozen `force` and `forceReason` whenever the intent is
  locked. A new test in `InventoryPage.uncertainRetry.test.tsx` drives the rendered page through
  stock refusal, override, lost reply and retry. It requires the same key with `p_force=true` and
  the same reason. With the fix reverted it fails with `expected [...] to have a length of 3 but got
  2`, because the retry never reached the server.
- **Wrapper line-ending normalization (Low).** The re-run preflight in the parked migration
  `20260908130000` normalized line endings with two literal newlines, so its effect depended on the
  checkout. On an LF checkout it did nothing, which is harmless because there is nothing to
  normalize. On a full CRLF checkout it also did nothing, and the drift-pin check would then refuse
  a valid re-run. It now uses explicit CRLF and LF escapes. The real-schema container prover passed
  on an all-CRLF working copy, including `rerun=PASS`, the stage that recomputes the wrapper hash
  against its pin. The pin value is unchanged.

Proof:

- 81/81 tests pass across the six related suites.
- `npm run typecheck` and ESLint are clean on the changed files.
- The prover prints `CREATE_INVENTORY_HOLD_INTENT_REAL_SCHEMA_PASS ... rerun=PASS`.

No live database change: the migration is still parked and unapplied.
