# PR #364 shutdown continuation handoff

Status captured: 2026-08-24, America/Chicago.

## WHERE

- Repository: `masonwells1/CRX_Manager_V1.0`
- Isolated checkout: the Codex worktree currently attached to PR #364 (resolve it with `git worktree list`)
- Branch: `claude/session-orchestration-setup-d73e6c`
- Pull request: #364
- Remote head: `5193864fa757067420f250d2fdaa8c9afcf272d6`
- Last reviewed base: `4b8ef10f4c6610b4c4d33a3607419e03e076a2ec`
- Current base after resume refresh: `8760b614` (being integrated by the final merge commit)
- Preserve the unrelated dirty primary checkout; do not use it for this PR.

## GOAL

Repair every valid merge blocker on PR #364, prove the fail-closed deny paths, clear all protected-PR gates, merge, and verify the live app. Done means no required finding or gate remains.

## PROVEN

- The optional-`INTO` PostgreSQL `MERGE` bypass was repaired in `aedd3150`.
- Its focused proof passed: apply-time analyzer 308 assertions, migration-apply guard 347 assertions, and approved-set validator 212 adversarial cases.
- The committed branch passed lint, typecheck, build/PWA, 338 Vitest files, 4,688 passing tests, 123 intentional skips, workflow tests, correction guards, docs checks, and containment.
- Live read-only trigger evidence was refreshed in `8fe223e2`: 157 tables, 442 cascade edges, 158 opaque source tables, 6 event triggers, and 0 custom-routine CHECK dependencies.
- The first final exact-SHA Sol review timed out after 1,200 seconds and wrote no proof. The approved 2,400-second retry returned clean and bound its proof to head `8fe223e2` and base `56321c0d`.
- The branch was pushed. Pre-push proof passed Phase 3C containment over 52,319 paths and four commits, typecheck, build, and Graphify refresh.
- At capture time, CodeQL, Vercel, Vercel Preview Comments, and CodeRabbit were green for remote head `8fe223e2`; the two Phase 3C containment jobs were still running.
- No additional live migration, database write, edge-function rollout, secret change, permission change, or data mutation occurred during this repair.

## RESUME REPAIR — PROVEN LOCALLY

- The executable-query matcher now includes `CREATE TABLE ... AS TABLE view`, so the stored view
  query enters the existing fixed point and its protected write is visible.
- Stored callable column defaults are bound to their relation. A later insert folds the default
  expression and same-file routine body, fails closed for an opaque resident routine, and reports
  the exact executable identity. A definition without a firing insert remains deferred.
- Inserts into a checked-domain column now reify the implicit PostgreSQL assignment coercion through
  the existing cast/domain analyzer. Definition-only domains and unrelated inserts remain deferred.
- Direct proof after the power-loss restart:
  - `apply-time-dml-lib.test.mjs`: 314 assertions passed.
  - `validate-sql-migrations-approved-set.test.mjs`: 217 mutation cases passed.
  - `migration-apply-guard.test.mjs`: 347 assertions passed.
  - Lint, typecheck, production build/PWA, 338 Vitest files with 4,688 passing tests and 123
    intentional skips, agent-workflow tests, correction guards, docs checks, and containment passed.
- Sol/high returned `CLEAN` for repair commit `d8495eb0`, but `origin/main` advanced to `14bdb2fd`
  during the review. The wrapper correctly refused to mint proof against the moved base. The branch
  now includes that base and requires a fresh exact-SHA review after the merge commit.
- No additional live migration, database write, edge-function rollout, secret change, permission change, or data mutation occurred during this repair.

## REMAINING DELIVERY WORK

1. Commit only this scoped repair, changelog, and continuation record. Refresh trigger evidence again
   if its 24-hour window could expire before push.
2. Fetch current `origin/main`; integrate if it moved. Run the canonical exact-SHA Sol review workflow
   on the final commit with the larger approved timeout if needed.
3. Push normally, wait for every current-head GitHub check, and read current CodeRabbit feedback.
4. Merge only when every gate is green/acceptable and no real finding remains, then verify ancestry
   and the live app.

## SECOND RESUME REPAIR — PROVEN LOCALLY

- A fresh exact-head automated review on `8040521e` found that a trigger `WHEN (...)` condition could
  call a mutating routine while the analyzer followed only the trigger's main function.
- Trigger attachments now preserve the deferred condition and fold it into the executable frontier
  only when the migration writes the trigger relation. Separate conditions sharing one main trigger
  function retain separate internal identities.
- The validator now receives a dedicated trigger-condition evidence channel and reports the exact
  callable identity instead of allowing the condition effect to disappear between the analyzer and
  the shell gate.
- Focused proof after this repair:
  - `apply-time-dml-lib.test.mjs`: 319 assertions passed.
  - `validate-sql-migrations-approved-set.test.mjs`: 219 mutation cases passed, including the real
    deny path and an unfired safe control.
- PR #364 remains HOLD. The prior exact-SHA proof and GitHub checks do not approve this new local
  repair; commit hooks, a fresh exact-SHA Sol review, push, and current-head remote checks remain
  mandatory before merge.

## APPROVAL STATE

- Mason approved repairing all findings and completing the normal protected branch-to-PR delivery path in the originating conversation.
- This handoff grants no new irreversible authority. Re-verify current conversation approval and `AGENTS.md` before any outward or irreversible action.
- No live migration belongs to this repair. Any future interactive live migration, edge-function rollout, deletion, secret/auth/permission change, or history rewrite keeps its own current gate.

## THIRD RESUME REPAIR — PROVEN LOCALLY

- The exact-SHA review of commit `65a0c21b` found two additional fail-open cases before push:
  unsupported procedural languages could hide DML behind language-specific APIs, and
  `REFRESH MATERIALIZED VIEW` could execute a stored query absent from the proof packet.
- Anonymous unsupported-language blocks now fail closed immediately. Same-file SQL/PLpgSQL bodies
  remain analyzable; unsupported-language routine definitions stay deferred until invoked, then
  fail closed through a dedicated validator reason.
- Materialized-view refreshes now carry a dedicated fail-closed reason instead of depending on
  linked event-trigger state. Ordinary reads remain unaffected.
- Focused proof after this repair:
  - `apply-time-dml-lib.test.mjs`: 325 assertions passed.
  - `validate-sql-migrations-approved-set.test.mjs`: 223 mutation cases passed, including both real
    deny paths and their safe deferred/read controls.
  - `migration-apply-guard.test.mjs`: 347 assertions passed.
- PR #364 remains HOLD. These edits still require the broad pipeline, a scoped commit, fresh
  exact-SHA Sol review, push, and current-head GitHub/CodeRabbit checks before merge.

## GATES AND BLOCKERS

- **PR #364 remains HOLD and unsafe to merge at this checkpoint.** The CTAS stored-view,
  callable-default, checked-domain, trigger-condition, procedural-language, materialized-view
  refresh, stored-default baseline, and ordering-snapshot issues are repaired and proven locally.
  The latest repair is committed as `a214c8e6`, but its current-main merge commit is not yet
  exact-SHA reviewed, pushed, or covered by fresh remote checks.
- Every earlier clean exact-SHA proof is stale for this patch. A new final proof is mandatory.
- Current remote checks cover only `5193864f`, not the latest local work.
- A broad database sweep was blocked by a false-positive read-only connector guard on `pg_get_function_identity_arguments()`. Do not claim it ran. The exact live trigger-evidence generator did complete read-only.

## FOURTH RESUME REPAIR — PROVEN LOCALLY

- Remote full-corpus CI on `5193864f` reported 75 findings against the fixed allowance of 61. The
  14 new findings were isolated rather than hidden by raising the allowance:
  - 12 ordinary stored defaults using only PostgreSQL core `now()` or `gen_random_uuid()`;
  - 2 already-applied nested-delimiter DO repairs newly refused by the unsupported-language check.
- Fired stored defaults now receive scoped trust only for those two zero-argument pg_catalog
  routines, and only while the migration leaves `search_path` implicit, defines no same-name
  routine, and performs no identity transition. All other unqualified builtin-looking calls remain
  fail-closed. The two immutable historical files have one exact-LF-hash-pinned finding each; the
  aggregate baseline remains 61.
- CodeRabbit's exact-head review then identified a real ordering mismatch: the snapshot producer
  prefixed `version` when an authored timestamp appeared away from the start of `name`, while the
  parser prefers the authored timestamp. The producer now preserves any timestamp-bearing name and
  falls back to `version` only for timestamp-less names, with leading and non-leading regressions.
- Current proof:
  - apply-time analyzer: 328 assertions passed;
  - approved-set validator: 225 mutation cases passed;
  - migration-apply guard: 347 assertions passed;
  - snapshot/fan-out/replay producer suites: 24 / 29 / 25 assertions passed;
  - correction guards, agent workflows, lint, typecheck, docs, production build/PWA, and all 338
    Vitest files passed (4,688 tests passed; 123 intentional skips).
- No additional live migration, database write, edge-function rollout, secret change, permission
  change, or data mutation occurred during this repair.

## NEXT ACTION

Commit the fifth repair through hooks, rerun the exact-SHA Sol review, and push normally. Do not
merge the PR until the remote full-corpus SQL audit confirms the locked 61 baseline and every other
current-head gate is green or an explicitly expected neutral result.

## FIFTH RESUME REPAIR — PROVEN LOCALLY

- Remote SQL validation on merge commit 5e93d36a reported 62 non-exempt findings against the
  locked baseline of 61. The exact log proved the two historical unsupported-DO exemptions were
  behaving correctly; the sole excess finding was
  20260722015019_supplier_cost_basis_phase2.sql.
- That migration defines now()/gen_random_uuid() column defaults before later executable code
  calls set_config for application-specific flags. The analyzer incorrectly withdrew trust based
  on any later migration-wide path signal even though PostgreSQL had already resolved and stored
  each default's function identity.
- Column effects now retain definition-time ordering. A path mutation before the DDL remains
  fail-closed; a later explicit path change or application set_config cannot retroactively retarget
  an already-bound default. DDL reached through dynamic/invoked code remains conservative when
  outer ordering is not provable.
- Current proof for this delta:
  - apply-time analyzer: 330 assertions passed;
  - approved-set validator: 225 mutation cases passed;
  - migration-apply guard: 347 assertions passed;
  - complete correction-guard bundle passed;
  - lint, typecheck, and production build/PWA passed.
- The audit allowance was not raised. No migration SQL or live state changed.

## SIXTH RESUME REPAIR — LOCAL SELF-ATTESTATION REMOVED

- Exact-SHA review of commit 264927d3 returned CRX-SEC-001: High. The apply guard accepted
  locally self-attested migration-ledger and trigger-fan-out JSON. An external helper could import
  the exported producers, inject fake command results, and mint internally consistent
  production-labelled files without running the fixed live query.
- The production guard now performs the fixed applied-ledger and trigger/fan-out linked reads
  itself and consumes both results in memory. Local caches are ignored by production.
- Regression fixtures use a separately named test entry. Neither hook manifest may reference it,
  and the production entry accepts no arguments or caller-selected evidence mode.
- Local proof:
  - production local-cache forgery is denied;
  - production fixed-read smoke ran both real read-only Supabase queries successfully;
  - migration apply guard: 352 assertions passed;
  - trigger-fanout, snapshot, and replay producer suites: 29 / 24 / 25 assertions passed;
  - complete correction guards, workflow parity, documentation drift, lint, typecheck, and the
    production build/PWA passed.
- Live verification found current issue_pg_graphql_access event-trigger behavior differs from the
  older checked-in capture and performs catalog DDL conditionally. The guard correctly blocks all
  migration applies until that exact live behavior is modeled/reviewed or changed through a
  separate reviewed path. No live mutation was performed.
- PR #364 remains HOLD. Broad gates, a new commit, fresh exact-SHA Sol review, push, current-head
  CodeRabbit/GitHub checks, merge, and production verification still remain.

## SEVENTH RESUME REPAIR — APPLYING-SESSION CATALOG GAP CLOSED FAIL-CLOSED

- Exact-head Sol/high review of 9ac446d4 returned one High: six enabled event triggers use
  unqualified catalog helpers through the applying session's unresolved search_path. The
  read-only evidence capture and later MCP apply are separate database sessions, so ordinary DDL
  could previously pass without proving the trigger's eventual catalog binding.
- Runtime now refuses every migration whenever any enabled trigger is marked
  session_catalog_required. CI likewise refuses every candidate migration in that state; neither
  lane limits the block to explicit search_path changes or unresolved SQL.
- Mutation controls use ordinary COMMENT ON TABLE DDL and retain the safe control for an enabled
  trigger whose exact routine body has a pinned, complete no-write proof.
- Test isolation then exposed ALTER DOMAIN VALIDATE CONSTRAINT had been passing one expected-red
  case only because the old session-trigger condition also fired. It now has its own direct
  stored-CHECK refusal. The shared baseline and bootstrap hash-pin fixtures use safe/empty event
  state, while the dedicated session-dependent mutation explicitly restores the unsafe trigger.
- Proof: migration apply guard 352 assertions; apply-time analyzer 330 assertions; approved-set
  validator 225 mutation cases; targeted bootstrap hash-pin mutations passed; lint, typecheck,
  docs, and production build/PWA passed.
- The live database and Supabase-managed triggers were not changed. This deliberately keeps live
  migration apply blocked until the trigger behavior or applying-session binding is separately
  modeled and reviewed.

## EIGHTH RESUME REPAIR — DATE-DEPENDENT TEST FIXTURE UNBLOCKED

- The protected commit hook crossed midnight UTC on 2026-08-25 and exposed a pre-existing fixed
  QuoteBuilder fixture timestamp that had just aged beyond the 30-day validity window. The stale
  quote guard correctly intercepted conversion, so the expected save-protection warning was never
  reached; the failure reproduced in isolation.
- General QuoteBuilder fixtures now derive a recent, midnight-anchored timestamp. This is test data
  only and matches the independently prepared repair on PR #465 without modifying that sibling
  checkout or branch.
- All 36 QuoteBuilder tests pass after the repair. The complete protected commit hook still must be
  rerun before this handoff can be closed.

Verify current state from Git, disk, and connected services before trusting this handoff; it may be stale when read.
