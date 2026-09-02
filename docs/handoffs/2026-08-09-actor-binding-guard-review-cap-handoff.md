# Actor-binding SQL reader — review-cap continuation handoff

> **SUPERSEDED — historical record.** This document belongs to PR #373, which was **closed
> unmerged**. Actor-binding hardening continued and is live work as of 2026-09-02 in **open PR #449**
> (`codex/actor-binding-mixed-notation-repair-20260810`); that PR, not this handoff, is the current
> state. The three migrations referenced here are staged on `main` under
> `scripts/.staging-migrations/` and are **not applied**. Preserved for its review-cap reasoning.

## WHERE

- Repository: `C:\CRX_Manager` / `masonwells1/CRX_Manager_V1.0`
- Isolated checkout: `C:\Users\mason\.codex\worktrees\phase3c-new-branch-cap\CRX_Manager`
- Branch: `codex/harden-actor-binding-sql-reader`
- Prior blocked security-review SHA: `824119a526e1bb3370e064bcc094fc5e3d12dd54`
- Originally rebased onto verified remote `main` at `0b85b5e447381261f53629f031ce5e703c6cab5d`,
  then integrated current `origin/main` `8dcb82fb2570b693478abd5d0adb8643bddce614`
  through local merge commit `c50cfbcfef236ad747623ebead5c8e6d023f933d` on 2026-08-10.
- Historical handoff state: no remote branch or pull request existed when this
  packet was written. Current ship state on 2026-08-10 is PR `#373`; re-verify
  GitHub before any further landing action and do not create a duplicate PR.
- Supabase project `rhyzpcqhnizqbxphqdkr` is context only; no database work occurred.

## GOAL

Port the hardened, fail-closed SQL reader into the actor-binding hook. This
unpublished continuation is ready only with mutation proof for every new guard
clause, real-process deny evidence, and a terminal exact-HEAD
`CODEX_PROOF_VERDICT: CLEAN`. Landing remains a separately authorized protected
PR workflow.

## PROVEN

- The actor-binding suite passes at 204 assertions; the idempotency reference
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
- Four Unicode extractor decisions were independently weakened or removed and
  each exposed its matching regression or safe-control failure: unqualified
  Unicode API registration, Unicode named-argument refusal, optional UESCAPE
  parsing, and direct-safe-literal allowance for an otherwise opaque API name.
- The mixed-branch MERGE decision was independently removed and exposed the
  exact staged INSERT-branch regression before restoration.
- The columnless MERGE INSERT spelling was independently narrowed back to the
  column-list-only check and exposed its own regression before restoration.
- Five legacy-executor decisions were independently weakened or broadened and
  each exposed its exact regression or safe-control failure: direct recursive
  recognition, narrow callable scoping, named `sql_query` recognition, opaque
  executor-expression refusal, and direct-safe-literal allowance.
- Four function-name grammar decisions were independently weakened and each
  exposed its matching regression: quoted names, Unicode identifiers,
  whitespace around qualification dots, and recursive quoted-header detection.
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
- The exact-SHA review of `f221c2839b070d7062d81e051b043fe1d7193a43`
  found two Unicode extractor gaps: unqualified Unicode API names and Unicode
  `command` argument names could carry staged SQL even though the broader sink
  detector recognized the calls. Snapshot probes proved the approved base
  denied both packets while that candidate allowed them.
- Fix commit `572d31aa9843f28532d6652d3522a183f83f7308` aligns the
  extractor with the sink detector, including custom UESCAPE syntax. The
  restored actor suite passed 181 assertions, the idempotency reference suite
  passed 86, exact real-process Unicode probes denied staged SQL and allowed a
  direct safe command, and the commit completed the full pre-commit barrier
  without a hook bypass.
- The exact-SHA review of `7e7c67c6c8a340fd58c8585a54fc1c533da7252a`
  found that a safe direct `WHEN MATCHED ... UPDATE` command could hide an
  opaque staged command in `WHEN NOT MATCHED ... INSERT`. Its real snapshot
  probe proved the approved base denied the packet while that candidate allowed
  it, and every companion SQL safety hook also allowed the candidate packet.
- Fix commit `1fbcc103c2d9445e4fe8edf7561fdd04acb3ec56` makes pg_cron
  job MERGE INSERT branches with explicit column lists review-only while
  preserving the direct update-only safe control. The restored actor suite passed 182
  assertions, idempotency remained green at 86, the exact mixed-branch
  subprocess probe denied, and the commit completed the full pre-commit barrier
  without a hook bypass.
- Follow-up commit `3f9d04d7bc8ce1fc3d5e9e24602b93b74b4cf471` extends the
  same rule to legal columnless INSERT actions. Its mutation failed the new
  regression before restoration, the restored actor suite passed 183
  assertions, and the commit completed the full pre-commit barrier without a
  hook bypass.
- The exact-SHA review of `eb958374c64afb9e237c07dfe8e71277e19b3ad4`
  found that CRX's legacy SECURITY DEFINER `execute_sql_readonly(text)` can
  execute a SELECT containing cron.schedule while the outer SQL literal was
  masked as data. Its snapshot probe proved the approved base denied that
  delayed actor-DDL packet while the candidate allowed it.
- Fix commit `04bc67f868fa7b144ab1c9e3b3e8968407338069` recursively
  inspects direct function-bearing SQL for that exact executor and refuses
  opaque/staged executor expressions. The restored actor suite passed 189
  assertions, idempotency remained green at 86, real subprocess probes denied
  direct nested and staged unsafe SQL while allowing a direct harmless query
  and an unrelated documentation callable, and the commit completed the full
  pre-commit barrier without a hook bypass.
- The exact-SHA review of `fee382774295cb7634c5bf8997f300f7d51e38d8`
  found that direct EXECUTE accepted a quoted qualified function definition but
  the final actor scanner recognized only unquoted names. Its real probe created
  an unsafe mutating SECURITY DEFINER function with a quoted name and proved the
  candidate hook allowed it.
- Fix commit `0b5c896ab115c69afefc06dea31e713ddac5858b` gives the
  recursive header detector and final actor scanner one shared identifier
  grammar for quoted, doubled-quote, whitespace-around-dot, and Unicode forms.
  The restored actor suite passed 194 assertions, idempotency remained green at
  86, real subprocess probes denied unsafe quoted direct/nested definitions and
  allowed the bound quoted control, and the commit completed the full
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
- The review of `f221c283` returned one HIGH blocker covering Unicode API and
  argument names. It was reproduced and fixed in `572d31aa`; its BLOCKERS
  verdict likewise does not approve the final documentation HEAD.
- The review of `7e7c67c6` returned one HIGH blocker for a mixed-branch MERGE.
  It was reproduced and fixed in `1fbcc103`; its BLOCKERS verdict likewise does
  not approve the final documentation HEAD.
- The review of `eb958374` returned one HIGH blocker for nested pg_cron SQL
  passed through `execute_sql_readonly`. It was reproduced and fixed in
  `04bc67f8`; its BLOCKERS verdict likewise does not approve the final
  documentation HEAD.
- The review of `fee38277` returned one HIGH blocker for quoted function names.
  It was reproduced and fixed in `0b5c896a`; its BLOCKERS verdict likewise does
  not approve the final documentation HEAD.
- CodeRabbit's publication review of PR `#373` found that a CTE-prefixed cron
  UPDATE scanned its assignment tail from the wrong offset and that this packet's
  no-PR status had become stale. Both findings were reproduced and fixed in
  `d74a5399`; that review applies only to the prior PR head.
- The governed exact-SHA review of `d74a5399` returned one HIGH blocker for a
  rename-call-restore alias of `execute_sql_readonly`. The bypass was reproduced
  and fixed in the current continuation by refusing non-allowlisted callables
  receiving function SQL and blocking identity changes to the known executor.
  Its BLOCKERS verdict does not approve the new HEAD.
- The governed exact-SHA review of `697aa6ac` returned one HIGH blocker because
  the first callable-boundary fix inspected only a direct first argument. The
  bypass was reproduced and fixed by walking every enclosing callable across
  later positional/named and cast/parenthesized arguments. Its BLOCKERS verdict
  does not approve the new HEAD.

## REMAINING LANDING WORK

- Re-verify the current branch and PR state before acting. PR `#373` is the
  protected landing lane; do not push or open a duplicate branch/PR.
- Only with a HEAD-matching CLEAN proof: wait for required checks and Vercel,
  resolve CodeRabbit, merge the verified PR, and verify remote `main`.
  Publishing is outside this handoff's own approval state.

## APPROVAL STATE

This handoff carries no push, merge, deployment, database, deletion, or other
outward-action approval into a receiving task. No database action is needed.

## GATES AND BLOCKERS

- The prior `/ship` review cycle reached its three-round cap. Its blocker and the
  later `8620ad17`, `5cb6e4d7`, `f4da59bf`, `3c0f8e75`, `9c2552ca`, `f221c283`, `7e7c67c6`, `eb958374`, and `fee38277` blockers have now been
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

---

# 2026-08-12 fresh repair cycle — parked after round 3

## WHERE

- Repository: `masonwells1/CRX_Manager_V1.0`.
- Isolated checkout: `C:\Users\mason\.codex\worktrees\df6d\CRX_Manager`.
- Local branch: `codex/actor-binding-mixed-notation-repair-20260810`.
- Parked local source HEAD: `6b835feb208b5f270c6b1ac6f87af291c332162c`.
- Protected landing lane: PR `#373`, branch
  `codex/harden-actor-binding-sql-reader`.
- Concurrently observed remote PR HEAD on 2026-08-12:
  `bd31f84ad45c9c96a3e145461e0bb30f29c551f3`. The local and remote heads
  diverged by 25 local-only commits and one remote-only main-merge commit. Do
  not force-push or overwrite that remote head; re-integrate it before any
  future publication attempt.
- Supabase project `rhyzpcqhnizqbxphqdkr` was used only for focused read-only
  catalog evidence. No migration was applied and no live data was changed.

## GOAL

Finish the actor-binding SQL reader so every supported route that can persist
or execute function-bearing SQL is inspected fail-closed. Done requires the
full repository gate, real mutation/reproduction evidence, and a terminal
exact-HEAD `CODEX_PROOF_VERDICT: CLEAN` before PR publication or merge.

## PROVEN

- Early `RETURN`, `EXIT`, and `CONTINUE` before the legacy actor guard are
  rejected; focused mutation proof failed before restoration and passed after.
- Quoted and Unicode-qualified actor-variable rebinding is rejected.
- User-defined PostgreSQL operators wrapping `execute_sql_readonly(text)` and
  function-bearing SQL embedded in `COPY ... TO PROGRAM` are rejected. Both
  concrete exploits were red before the repair and green after it.
- The final local source HEAD passed the complete mandatory gate: 327 test
  files, 4,466 passing tests, 123 intentional skips, 333 actor-binding
  assertions, lint, typecheck, build, workflow/guard suites, documentation,
  dependency, and containment checks.
- All 36 August migration files were inspected by the actor-binding hook with
  zero denials and zero internal errors. Three Wave A migrations carry explicit
  manual-review exemptions for intentionally indirect SQL; they remain parked
  and unapplied.
- Focused live read-only evidence confirmed no current PostgreSQL operator
  points to `execute_sql_readonly`. Broader database sweeps were inaccessible
  through the available narrow connector guard and are not claimed as passed.

## WRITTEN, NOT PROVEN

- Commits through `6b835feb` are clean and preserved locally, but the exact-HEAD
  security proof did not return CLEAN. Passing local tests do not approve this
  source for push or merge.
- This appended parking record describes the state after that source review; it
  is not part of the reviewed `6b835feb` source HEAD.

## NOT STARTED

- Add fail-closed handling or complete identity tracking for temporary identity
  changes to `cron.job` and `cron.job.command`.
- Add real-process regressions for table rename/restore, schema move/restore,
  and command-column rename/restore bypasses, with harmless controls and
  mutation proof.
- Run the complete repository gate on the resulting commit.
- Start a new governed review cycle and require a terminal CLEAN proof.
- Only then integrate the current remote PR head without force, push PR `#373`,
  wait for required checks and Vercel, read and resolve CodeRabbit, merge, and
  verify production.

## APPROVAL STATE

Mason authorized this session to repair, commit, push, update PR `#373`, merge
through the protected green workflow, and verify production. The review gate
blocked publication, so none of the parked local repair commits were pushed or
merged by this session. This handoff itself does not carry approval into a new
task; the receiving task must verify current authority and state.

## GATES AND BLOCKERS

- Review round 1 found quoted function/block qualifiers; fixed in `bd1466f6`.
- Review round 2 found PostgreSQL operator aliases and `COPY ... PROGRAM` as
  alternate SQL sinks; fixed in `6b835feb`.
- Final review round 3 returned `CODEX_PROOF_VERDICT: BLOCKERS` with
  `SEC-01 — HIGH`: temporarily renaming `cron.job`, moving it to another schema,
  or renaming its `command` column lets delayed actor-function SQL bypass the
  scheduler write detector. The reviewer reproduced all three shapes: the
  approved base denied them and candidate `6b835feb` allowed them.
- The three-round cap is exhausted. Do not self-certify, push, or merge this
  source head. The exact review capture is at
  `C:\Users\mason\.codex\worktrees\df6d\CRX_Manager\.claude\session-state\codex-review-latest.txt`.
- The schema-registry warning is expected for written-but-unapplied Wave A
  migrations. Do not regenerate the live registry as though those migrations
  were applied.

## FIRST ACTION

From a fresh repair task, fetch `origin/main` and PR `#373`, preserve both the
parked local commits and the concurrent remote merge, then reproduce the three
`cron.job` identity-change bypasses in the real hook test harness before making
the smallest fail-closed repair.

Verify current state from Git, disk, and connected services before trusting this handoff; it may be stale when read.
