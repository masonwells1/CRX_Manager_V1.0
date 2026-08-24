# PR #364 shutdown continuation handoff

Status captured: 2026-08-24, America/Chicago.

## WHERE

- Repository: `masonwells1/CRX_Manager_V1.0`
- Isolated checkout: `C:\Users\mason\.codex\worktrees\pr364-landing\CRX_Manager`
- Branch: `claude/session-orchestration-setup-d73e6c`
- Pull request: #364
- Remote head: `8fe223e24d0bb7768999f591da0f0d2b6cca2d28`
- Reviewed base: `56321c0d083e958d445854c3310878b916aa971a`
- Preserve the unrelated dirty primary checkout at `C:\CRX_Manager`.

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
- No live migration, database write, edge-function rollout, secret change, permission change, or data mutation occurred.

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
- No app source, migration SQL, live database, production data, secret, or permission changed.

## REMAINING DELIVERY WORK

1. Commit only this scoped repair, changelog, and continuation record. Refresh trigger evidence again
   if its 24-hour window could expire before push.
2. Fetch current `origin/main`; integrate if it moved. Run the canonical exact-SHA Sol review workflow
   on the final commit with the larger approved timeout if needed.
3. Push normally, wait for every current-head GitHub check, and read current CodeRabbit feedback.
4. Merge only when every gate is green/acceptable and no real finding remains, then verify ancestry
   and the live app.

## APPROVAL STATE

- Mason approved repairing all findings and completing the normal protected branch-to-PR delivery path in the originating conversation.
- This handoff grants no new irreversible authority. Re-verify current conversation approval and `AGENTS.md` before any outward or irreversible action.
- No live migration belongs to this repair. Any future interactive live migration, edge-function rollout, deletion, secret/auth/permission change, or history rewrite keeps its own current gate.

## GATES AND BLOCKERS

- **PR #364 remains HOLD and unsafe to merge at this checkpoint.** The three valid P1 bypasses are
  repaired locally with focused proof, but the repair is not committed, exact-SHA reviewed, pushed,
  or covered by fresh remote checks yet:
  - CTAS `AS TABLE` stored-view execution: discussion `r3840364070`.
  - Stored column default fired by a later insert: discussion `r3840893868`.
  - Implicit checked-domain coercion on insert: discussion `r3840893874`.
- The clean exact-SHA proof for `8fe223e2` does not approve this dirty patch or any future repair commit. A new final proof is mandatory.
- Current remote checks apply only to `8fe223e2`, not the unfinished local work.
- A broad database sweep was blocked by a false-positive read-only connector guard on `pg_get_function_identity_arguments()`. Do not claim it ran. The exact live trigger-evidence generator did complete read-only.

## NEXT ACTION

Continue from `C:\Users\mason\.codex\worktrees\pr364-landing\CRX_Manager` with the broad local
pipeline. Do not publish until the final commit has fresh exact-SHA proof and every current-head PR
gate is green or an explicitly expected neutral result.

Verify current state from Git, disk, and connected services before trusting this handoff; it may be stale when read.
