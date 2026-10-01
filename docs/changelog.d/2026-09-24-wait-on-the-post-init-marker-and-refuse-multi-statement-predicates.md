## 2026-09-24 — the receipt-gate prover waits on the post-init marker, buildSweepQuery refuses anything that is not one SELECT, and two applied-status conflicts are recorded rather than papered over

PR #789 review round (CodeRabbit: one Major, two Minor). All three addressed. No migration SQL and
no product code changed.

## Major — the new prover could wait on the wrong server

`prove-generic-field-cutover-receipt-gate.mjs` waited for `database system is ready to accept
connections`. Measured on `postgres:17-alpine`, that line is logged **twice**: the entrypoint's
throwaway `initdb` server logs it, then `shutting down`, then `PostgreSQL init process complete;
ready for start up.`, and only then does the real server log it again. Waiting on the first
occurrence races a server that is about to stop.

It now waits on the post-init marker, matching `prove-actor-allowlist.mjs`, and reads **both** Docker
streams.

**The reported mechanism was not the defect.** The finding said PostgreSQL emits the line on stderr
only, so `execFileSync` — which returns stdout — would never see it and the prover would abort before
any case ran. That is not what happens on this image: measured with
`docker logs c 2>/dev/null | grep -c` and `docker logs c 2>&1 >/dev/null | grep -c`, the line appears
on **both** streams, which is why the prover has been passing. The fix is still right, for the
init-server reason above, and reading both streams removes the dependence on an undocumented detail.

`RECEIPT_GATE_NARROWING_PROOF_PASS` re-observed after the change.

## Minor — buildSweepQuery inlined whatever it was given

`buildSweepQuery` strips a trailing semicolon and inlines the predicate into `FROM (...)`, which only
holds for a single `SELECT`. A `CREATE OR REPLACE FUNCTION pg_temp…;` prelude, or a comment after the
final `;` (which the trailing-strip regex cannot reach), would be pasted in and produce invalid SQL
against the live database instead of a clear refusal.

Measured first: **0 of the 29 shipped predicates** hit this today, so it is latent, not a current
break. A new exported `hasStatementBreak()` now refuses such input up front.

The scan has to be comment- and literal-aware, and the first version of this check was not: a naive
`includes(';')` flagged **27 of 29** real predicates, because they carry semicolons inside
explanatory `--` prose. `hasStatementBreak` skips line comments, nested block comments, single- and
double-quoted spans and dollar-quoted strings, and only counts a semicolon in executable position.
The tests assert both directions, and additionally build **every shipped predicate** so the guard
cannot become too strict to live with.

`ACTOR_ALLOWLIST_MATCH_PASS` — **541 assertions** (was 502).

## Minor — two migrations are recorded as both applied and pending

The boundary block and row 935 report `20260914100500` (ledger version `20260922015509`) and
`20260914100600` (`20260922020038`) as applied live on 2026-09-22, while rows 920 and 922 still carry
a pending token. Verified by running `localCandidateMigrationPathsFromHistory()` against the file:
the worktree guard reads **both** files as pending candidates.

**The status tokens are deliberately left alone.** Retiring them removes those migrations from the
pending guard, and this lane has not read the live ledger — only prose in the same file. If the
boundary block were the stale half, retiring the tokens would silently drop a genuinely pending
migration, which is the stranding the guard exists to prevent. Pending is the fail-closed reading: it
can delay an apply, never skip one, and only the owning commission lane's own post-apply live
verification may retire a token, as row 929 did.

So the conflict is now *recorded* in both rows and in the seven-parked-candidates paragraph, each
naming the authority and telling an operator to re-read `supabase_migrations.schema_migrations`
read-only before ordering an apply. A reader can no longer compute an order from a statement that
silently disagrees with another one on the same page. Re-ran the guard afterwards: still
`state=known`, 9 candidates, both rows intentionally still pending.

## Proof

- `node scripts/smoke/prove-generic-field-cutover-receipt-gate.mjs` →
  **`RECEIPT_GATE_NARROWING_PROOF_PASS`**.
- `node scripts/db-invariant-sweeps/prove-actor-allowlist.mjs` →
  **`ACTOR_ALLOWLIST_DISPOSABLE_PROOF_PASS` 34 checks**.
- `ACTOR_ALLOWLIST_MATCH_PASS` **541 assertions**; `--adjudicate` over the full 29-predicate capture
  still reports `ok: true, complete: true`.
- `typecheck`, `lint`, `npx vitest run` (**5,448 passed** / 123 skipped), `build`,
  `test:correction-guards`, `test:agent-workflows`, `check:docs` all green.

## Live impact

**None.** All four field-season candidates remain LOCAL CANDIDATE / UNAPPLIED, and rows 920/922 keep
their conservative pending status.
