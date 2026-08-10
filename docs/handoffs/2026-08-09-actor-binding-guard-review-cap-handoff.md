# Actor-binding SQL reader — review-cap continuation handoff

## WHERE

- Repository: `C:\CRX_Manager` / `masonwells1/CRX_Manager_V1.0`
- Isolated checkout: `C:\Users\mason\.codex\worktrees\phase3c-new-branch-cap\CRX_Manager`
- Branch: `codex/harden-actor-binding-sql-reader`
- Prior blocked security-review SHA: `824119a526e1bb3370e064bcc094fc5e3d12dd54`
- Rebased onto verified remote `main` on 2026-08-10: `0b85b5e4ed018c4abc93439ae48e7b3b00cc5d29`
- No remote branch and no pull request exist.
- Supabase project `rhyzpcqhnizqbxphqdkr` is context only; no database work occurred.

## GOAL

Port the hardened, fail-closed SQL reader into the actor-binding hook. This
unpublished continuation is ready only with mutation proof for every new guard
clause, real-process deny evidence, and a terminal exact-HEAD
`CODEX_PROOF_VERDICT: CLEAN`. Landing remains a separately authorized protected
PR workflow.

## PROVEN

- The actor-binding suite passes at 138 assertions; the idempotency reference
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
  boundaries when a literal contains `CREATE FUNCTION`. This covers quoted
  `"cron"."schedule"`, `schedule_in_database`, and `alter_job`, while ordinary
  cron calls and cron-looking text inside data strings/comments remain allowed.
- Real hook-process probes denied indirect variable execution, doubled-quote
  comment hiding, post-body actor forgery, and scheduled actor-function DDL. A
  complete bound function supplied directly as one dollar-quoted literal was allowed.
- One full pre-commit barrier passed before the `pg_cron` follow-up: containment,
  lint, type-check, build, all Vitest tests, workflow/guard suites, dependency
  integrity, and map generation. Two later amend attempts hit different random
  test timeouts; every timed-out test passed immediately in isolation. The full
  barrier must run again on the final `pg_cron` tree before closeout.
- The branch was rebased onto current `origin/main` at `0b85b5e4`; the similarly
  named shared checkout contains separate commission/containment work and was
  not modified.

## GOVERNED STATUS

- This document deliberately does not self-certify a review verdict. Resolve the
  current branch HEAD, then require the sanctioned review wrapper's output to
  match that exact HEAD and end in `CODEX_PROOF_VERDICT: CLEAN`.
- The old review capture is historical blocker evidence for `824119a5`; it
  cannot approve the continuation commit.
- The review of `8620ad17` returned one HIGH blocker for quoted and alternate
  pg_cron command APIs. That finding was reproduced and fixed locally, so its
  BLOCKERS verdict is evidence for the fix, not approval of the new HEAD.

## REMAINING LANDING WORK

- Confirm the full pre-commit barrier on the final tree and run the fresh
  governed exact-SHA review cycle.
- Only with a HEAD-matching CLEAN proof: push the branch, open the PR, wait for
  required checks and Vercel, resolve CodeRabbit, merge, and verify remote
  `main`. Publishing is outside this handoff's approval state.

## APPROVAL STATE

This handoff carries no push, merge, deployment, database, deletion, or other
outward-action approval into a receiving task. No database action is needed.

## GATES AND BLOCKERS

- The prior `/ship` review cycle reached its three-round cap. Its blocker and the
  later `8620ad17` pg_cron blocker have now been addressed locally, but the
  branch remains unpublished until a new exact-SHA governed review independently
  returns CLEAN.
- Historical blocker evidence:
  `C:\Users\mason\.codex\worktrees\phase3c-new-branch-cap\CRX_Manager\.claude\session-state\codex-review-latest.txt`.
- Unrelated nonblocking repo drift remains: four 2026-08-08 migrations are
  missing from the migration index, and two manual docs have 2026-08-07
  freshness stamps. Do not widen the hook fix into that work.
- The shared `C:\CRX_Manager` checkout contains unrelated gauntlet changes owned
  by another session. Preserve them.

## FIRST ACTION

From the isolated checkout, verify the clean final HEAD, full barrier output,
and HEAD-bound Codex proof. If any of those are absent, stale, or non-CLEAN,
keep the branch parked. If all are current and CLEAN, the next separate action
is the protected branch/PR landing flow after confirming publication authority.

Verify current state from Git, disk, and connected services before trusting this handoff; it may be stale when read.
