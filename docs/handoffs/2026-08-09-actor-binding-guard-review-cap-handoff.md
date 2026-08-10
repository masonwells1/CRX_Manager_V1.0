# Actor-binding SQL reader — review-cap continuation handoff

## WHERE

- Repository: `C:\CRX_Manager` / `masonwells1/CRX_Manager_V1.0`
- Isolated checkout: `C:\Users\mason\.codex\worktrees\phase3c-new-branch-cap\CRX_Manager`
- Branch: `codex/harden-actor-binding-sql-reader`
- Prior blocked security-review SHA: `824119a526e1bb3370e064bcc094fc5e3d12dd54`
- Originally rebased onto verified remote `main` at `0b85b5e447381261f53629f031ce5e703c6cab5d`,
  then integrated current `origin/main` `8dcb82fb2570b693478abd5d0adb8643bddce614`
  through local merge commit `c50cfbcfef236ad747623ebead5c8e6d023f933d` on 2026-08-10.
- No remote branch and no pull request exist.
- Supabase project `rhyzpcqhnizqbxphqdkr` is context only; no database work occurred.

## GOAL

Port the hardened, fail-closed SQL reader into the actor-binding hook. This
unpublished continuation is ready only with mutation proof for every new guard
clause, real-process deny evidence, and a terminal exact-HEAD
`CODEX_PROOF_VERDICT: CLEAN`. Landing remains a separately authorized protected
PR workflow.

## PROVEN

- The actor-binding suite passes at 176 assertions; the idempotency reference
  suite remains green at 86 assertions.
- Fifty-four parser and decision clauses were each removed alone and made the
  suite fail before restoration.
- Eight continuation decisions were independently weakened or removed and each
  made the real hook-process suite fail before restoration: the trigger
  exception, complete trigger-call tail, direct-literal `USING`, direct-literal
  `INTO`, command-literal position, expression-tail refusal, clause ordering,
  and second-`EXECUTE` refusal.
- Seven follow-up `pg_cron` decisions were independently weakened or removed
  and each made the real hook-process suite fail before restoration: quoted
  schema recognition, `schedule_in_database`, `alter_job`, dollar-quoted data,
  single-quoted data, line-comment masking, and nested block-comment masking.
- Four final `pg_cron` decisions were independently removed and each exposed its
  corresponding search-path regression before restoration: unqualified API
  recognition, quoted unqualified recognition, `schedule_in_database`, and
  `alter_job`.
- Nine direct `cron.job.command` decisions were independently removed and each
  exposed its exact regression before restoration: runtime-boundary registration,
  UPDATE, INSERT, direct assignment, tuple assignment, quoted table identifiers,
  quoted `command`, `ONLY`, and unqualified search-path-resolved `job`.
- Four final legal-form decisions were independently weakened or removed and
  each exposed its exact regression before restoration: finding an UPDATE after
  a CTE, recognizing `MERGE INTO cron.job`, recognizing an executable call with
  a Unicode-escaped identifier, and recognizing a command-table write with a
  Unicode-escaped identifier.
- Thirteen staged-command decisions were independently weakened or removed and
  each exposed its corresponding regression or safe-control failure: the opaque
  call and table-write gates, named direct-command allowance, non-command
  `unschedule` allowance, direct and tuple assignment checks, `INSERT ... SELECT`,
  MERGE, direct VALUES allowance, omitted `alter_job` command allowance,
  INSERT-table/function-call disambiguation, opaque upsert handling, and COPY.
- Ordinary and event trigger declarations are allowed only when their
  executable clause is a complete `EXECUTE FUNCTION|PROCEDURE name(...)` call.
- Direct PL/pgSQL command literals may use `INTO [STRICT]` and `USING` without
  treating their data expressions as command builders.
- Real hook-process continuation probes allowed trigger, event-trigger,
  direct-literal `USING`, and direct-literal `INTO` controls. They denied
  variable, concatenated, `format(...)`-built, and second-`EXECUTE` controls.
- Ordinary `GRANT EXECUTE` and `REVOKE EXECUTE` function privileges are now
  accepted without weakening the indirect runtime-`EXECUTE` refusal.
- Post-body `LANGUAGE ... SECURITY DEFINER` attributes are inspected through the
  function statement terminator. A missing terminator fails closed, and a later
  statement cannot contaminate the attributes of an earlier function.
- Direct calls to any API in the `cron` schema are treated as runtime-SQL
  boundaries when a literal contains `CREATE FUNCTION`. The current command APIs
  are also recognized when unqualified or quoted-unqualified, closing
  `SET search_path = cron, public; SELECT schedule(...)` and its
  `schedule_in_database`/`alter_job` equivalents. Ordinary calls and cron-looking
  text inside data strings/comments remain allowed.
- Direct `UPDATE`, `INSERT`, and `MERGE` writes to `cron.job.command` are
  runtime-SQL boundaries too, including quoted identifiers, `ONLY`/alias and
  tuple UPDATEs, CTE-prefixed writes, search-path-resolved `job` INSERTs, and
  PostgreSQL Unicode-escaped identifiers. Harmless command strings, explicitly
  non-cron `schema.job` writes, and Unicode-looking data text remain allowed.
- Command-bearing pg_cron calls and table writes now require the stored command
  to be one directly inspectable plain or dollar-quoted literal. Subqueries,
  variables, DEFAULT, concatenation, `INSERT ... SELECT`, opaque upserts, and
  opaque tuple/MERGE expressions require the explicit exemption/manual-review
  path. Named direct commands and `cron.unschedule` remain allowed; COPY into
  `cron.job` is conservatively review-only.
- Real hook-process probes denied indirect variable execution, doubled-quote
  comment hiding, post-body actor forgery, and scheduled actor-function DDL. A
  complete bound function supplied directly as one dollar-quoted literal was allowed.
- The final `pg_cron` tree passed the full pre-commit barrier: containment, lint,
  type-check, build, all 323 Vitest files (4,304 passing tests and 123 intentional
  skips), workflow/guard suites, dependency integrity, documentation drift, and
  map generation. The first final-tree attempt hit two unrelated five-second
  migration-scan timeouts; those exact files passed 107/107 in isolation in
  2.23 seconds, then the unchanged full retry passed.
- The current-main integration commit passed the full pre-commit barrier. The
  similarly named shared checkout contains separate commission/containment work
  and was not modified.
- The exact-SHA review of `5cb6e4d74481b72408663dcf3f4cb48355e96bfe`
  found the unqualified search-path bypass. Its snapshot probe proved the
  approved base denied that SQL while the candidate allowed it. The real hook
  now denies that exact actor-DDL probe and allows the same unqualified schedule
  call when its command contains no function DDL.
- Blocker-fix commit `61ef9090` passed the complete barrier on current main: all
  323 Vitest files, 4,304 passing tests, 123 intentional skips, 144 actor-binding
  assertions, containment, lint, type-check, build, workflow/guard suites,
  documentation drift, dependency integrity, schema baseline, and map generation.
- The exact-SHA review of `f4da59bff52c1d6ee1cc4adfe28a1fd8b25a892b`
  found that direct writes to `cron.job.command` remained an executable sink. Its
  snapshot probe proved the approved base denied the UPDATE while the candidate
  allowed it. The real hook now denies that exact actor-DDL write and allows the
  same UPDATE when its command contains no function DDL.
- Direct-write fix commit `b4ae07bf` passed the complete barrier. Its first
  attempt had one unrelated five-second pricing-workbook timeout after 4,303
  tests passed; that exact file passed alone in 2.47 seconds, and the unchanged
  full retry passed all 323 files, 4,304 tests, and 152 actor-binding assertions.
- The exact-SHA review of `3c0f8e75357149522a828cde8482f5201067f4a5`
  found three remaining legal SQL variants: CTE-prefixed UPDATE, `MERGE INTO
  cron.job`, and a `U&"\\0063ron"` schema identifier. Snapshot probes proved the
  approved base denied all three while that candidate allowed them.
- Fix commit `879ef43210ff44d6df39fa3c58f2ac05a825da85` closes those
  three variants. Four focused mutation runs failed on their matching assertion
  before restoration; the restored actor suite passed 162 assertions and the
  idempotency reference suite passed 86. Separate real-hook subprocess probes
  denied unsafe CTE, MERGE, and Unicode-call forms while allowing their harmless
  controls. The commit completed the repository pre-commit barrier without a
  hook bypass.
- The exact-SHA review of `9c2552cafa10aa9ecd22a2e1a8d13c195a261315`
  found the staged-command data-flow bypass. Real snapshot probes proved the
  approved base denied staged subquery commands supplied to cron.schedule and
  cron.job UPDATE while that candidate allowed both.
- Fix commit `49e41d7aae888e66db69579dfc981d2479f1b779` closes that
  bypass across call, UPDATE, tuple, INSERT/UPSERT, MERGE, and COPY forms. The
  restored actor suite passed 176 assertions, the idempotency reference suite
  passed 86, real subprocess probes denied staged schedule/update/insert/MERGE
  controls and allowed direct safe commands, and the commit completed the full
  pre-commit barrier without a hook bypass.

## GOVERNED STATUS

- This document deliberately does not self-certify a review verdict. Resolve the
  current branch HEAD, then require the sanctioned review wrapper's output to
  match that exact HEAD and end in `CODEX_PROOF_VERDICT: CLEAN`.
- The old review capture is historical blocker evidence for `824119a5`; it
  cannot approve the continuation commit.
- The review of `8620ad17` returned one HIGH blocker for quoted and alternate
  pg_cron command APIs. That finding was reproduced and fixed locally, so its
  BLOCKERS verdict is evidence for the fix, not approval of the new HEAD.
- The review of `5cb6e4d7` returned one HIGH blocker for unqualified pg_cron APIs
  resolved through `search_path`. That finding was reproduced and fixed in
  `61ef9090`; its BLOCKERS verdict likewise does not approve the new HEAD.
- The review of `f4da59bf` returned one HIGH blocker for direct writes to
  `cron.job.command`. That finding was reproduced and fixed in `b4ae07bf`; its
  BLOCKERS verdict likewise does not approve the new HEAD.
- The review of `3c0f8e75` returned one HIGH blocker covering CTE-prefixed,
  MERGE, and Unicode-identifier variants. Those findings were reproduced and
  fixed in `879ef432`; its BLOCKERS verdict likewise does not approve the final
  documentation HEAD.
- The review of `9c2552ca` returned one HIGH blocker for staged command text
  supplied through subqueries or variables. It was reproduced and fixed in
  `49e41d7a`; its BLOCKERS verdict likewise does not approve the final
  documentation HEAD.

## REMAINING LANDING WORK

- Run the fresh governed exact-SHA review cycle on the final documentation commit.
- Only with a HEAD-matching CLEAN proof: push the branch, open the PR, wait for
  required checks and Vercel, resolve CodeRabbit, merge, and verify remote
  `main`. Publishing is outside this handoff's approval state.

## APPROVAL STATE

This handoff carries no push, merge, deployment, database, deletion, or other
outward-action approval into a receiving task. No database action is needed.

## GATES AND BLOCKERS

- The prior `/ship` review cycle reached its three-round cap. Its blocker and the
  later `8620ad17`, `5cb6e4d7`, `f4da59bf`, `3c0f8e75`, and `9c2552ca` pg_cron blockers have now been
  addressed locally, but the branch remains unpublished until a new exact-SHA
  governed review independently returns CLEAN.
- Historical blocker evidence:
  `C:\Users\mason\.codex\worktrees\phase3c-new-branch-cap\CRX_Manager\.claude\session-state\codex-review-latest.txt`.
- The shared `C:\CRX_Manager` checkout contains unrelated gauntlet changes owned
  by another session. Preserve them.

## FIRST ACTION

From the isolated checkout, verify the clean final HEAD, full barrier output,
and HEAD-bound Codex proof. If any of those are absent, stale, or non-CLEAN,
keep the branch parked. If all are current and CLEAN, the next separate action
is the protected branch/PR landing flow after confirming publication authority.

Verify current state from Git, disk, and connected services before trusting this handoff; it may be stale when read.
