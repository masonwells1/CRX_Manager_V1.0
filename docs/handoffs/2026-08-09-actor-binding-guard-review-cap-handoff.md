# Actor-binding SQL reader — parked review-cap handoff

## WHERE

- Repository: `C:\CRX_Manager` / `masonwells1/CRX_Manager_V1.0`
- Isolated checkout: `C:\Users\mason\.codex\worktrees\phase3c-new-branch-cap\CRX_Manager`
- Branch: `codex/harden-actor-binding-sql-reader`
- Last security-reviewed code SHA: `b7f6af4c3c15bcc0ea30c81c251a85974d74a9a1`
- Verified remote `main` on 2026-08-09: `c43fb92a397694f121157aebfe76a2fc2daaaa4f`
- No remote branch and no pull request exist.
- Supabase project `rhyzpcqhnizqbxphqdkr` is context only; no database work occurred.

## GOAL

Port the hardened, fail-closed SQL reader into the actor-binding hook. Done
requires mutation proof for every guard clause, real-process deny evidence, a
terminal `CODEX_PROOF_VERDICT: CLEAN`, and landing through a green protected PR.

## PROVEN

- The actor-binding suite passes at 99 assertions; the idempotency reference
  suite remains green at 86 assertions.
- Forty-three original port clauses plus the resumed indirect-`EXECUTE`, nested
  quote, and scheduled-string clauses were each removed alone and made the suite
  fail before restoration.
- Real hook-process probes denied indirect variable execution, doubled-quote
  comment hiding, and `cron.schedule` actor-forgery SQL. A complete bound function
  supplied directly as one dollar-quoted literal was allowed.
- The full pre-commit barrier passed repeatedly: containment, lint, type-check,
  build, all Vitest tests, workflow/guard suites, dependency integrity, and map
  generation. Intermittent workbook timeouts passed immediately in isolation
  and the successful reruns completed the full suite.
- The branch was rebased onto the current upstream dependency correction, so the
  unrelated `undici` change is not part of this branch's diff.

## WRITTEN, NOT PROVEN

- The complete hardening work is committed locally through `b7f6af4c`.
- It does not have a CLEAN exact-SHA push proof. The final mandatory review
  returned `CODEX_PROOF_VERDICT: BLOCKERS`, so no proof file was minted.

## NOT STARTED

- Distinguish procedural runtime `EXECUTE` from ordinary PostgreSQL privilege
  syntax: `GRANT EXECUTE ON FUNCTION ...` and `REVOKE EXECUTE ON FUNCTION ...`.
- Add regressions proving both privilege statements and a complete secure
  `SECURITY DEFINER` migration are allowed, while indirect procedural execution
  remains denied. Mutation-test that distinction.
- Run the full barrier and start a fresh governed exact-SHA review cycle.
- Only after CLEAN: push the branch, open the PR, wait for required checks and
  Vercel, resolve CodeRabbit, merge, and verify remote `main`.

## APPROVAL STATE

This handoff carries no push, merge, deployment, database, deletion, or other
outward-action approval into a receiving task. No database action is needed.

## GATES AND BLOCKERS

- `/ship` reached its hard cap of three fix/re-review rounds. The branch must
  remain parked and unpublished from this task.
- Final blocker: `.claude/hooks/actor-binding-check.mjs` treats every visible
  `EXECUTE` token as runtime SQL, so it wrongly denies required `GRANT EXECUTE`
  and `REVOKE EXECUTE` privilege statements. The exemption marker is not an
  acceptable default because it disables the actor guard for the whole file.
- Exact evidence:
  `C:\Users\mason\.codex\worktrees\phase3c-new-branch-cap\CRX_Manager\.claude\session-state\codex-review-latest.txt`.
- Unrelated nonblocking repo drift remains: four 2026-08-08 migrations are
  missing from the migration index, and two manual docs have 2026-08-07
  freshness stamps. Do not widen the hook fix into that work.
- The shared `C:\CRX_Manager` checkout contains unrelated gauntlet changes owned
  by another session. Preserve them.

## FIRST ACTION

From the isolated checkout, verify GitHub `main` again, then add the smallest
context-aware distinction that exempts only `GRANT/REVOKE EXECUTE` privilege
syntax from the procedural-runtime refusal. Add the three exact allow/deny
regressions before any broader test or review.

Verify current state from Git, disk, and connected services before trusting this handoff; it may be stale when read.
