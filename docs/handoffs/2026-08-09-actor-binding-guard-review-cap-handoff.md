# Actor-binding SQL reader — parked review-cap handoff

## WHERE

- Repository: `C:\CRX_Manager` / `masonwells1/CRX_Manager_V1.0`
- Isolated checkout: `C:\Users\mason\.codex\worktrees\phase3c-new-branch-cap\CRX_Manager`
- Branch: `codex/harden-actor-binding-sql-reader`
- Last security-reviewed code SHA: `824119a526e1bb3370e064bcc094fc5e3d12dd54`
- Verified remote `main` on 2026-08-09: `122d9b6602ba230469de512bf2a82bc5c3f9ee2c`
- No remote branch and no pull request exist.
- Supabase project `rhyzpcqhnizqbxphqdkr` is context only; no database work occurred.

## GOAL

Port the hardened, fail-closed SQL reader into the actor-binding hook. Done
requires mutation proof for every guard clause, real-process deny evidence, a
terminal `CODEX_PROOF_VERDICT: CLEAN`, and landing through a green protected PR.

## PROVEN

- The actor-binding suite passes at 115 assertions; the idempotency reference
  suite remains green at 86 assertions.
- Fifty-four parser and decision clauses were each removed alone and made the
  suite fail before restoration.
- Ordinary `GRANT EXECUTE` and `REVOKE EXECUTE` function privileges are now
  accepted without weakening the indirect runtime-`EXECUTE` refusal.
- Post-body `LANGUAGE ... SECURITY DEFINER` attributes are inspected through the
  function statement terminator. A missing terminator fails closed, and a later
  statement cannot contaminate the attributes of an earlier function.
- Top-level `SELECT cron.schedule(...)` function DDL now fails closed while
  ordinary scheduled calls without function DDL remain allowed.
- Real hook-process probes denied indirect variable execution, doubled-quote
  comment hiding, post-body actor forgery, and scheduled actor-function DDL. A
  complete bound function supplied directly as one dollar-quoted literal was allowed.
- The full pre-commit barrier passed repeatedly: containment, lint, type-check,
  build, all Vitest tests, workflow/guard suites, dependency integrity, and map
  generation. Intermittent workbook timeouts passed immediately in isolation
  and the successful reruns completed the full suite.
- The branch was rebased onto the current upstream dependency correction, so the
  unrelated `undici` change is not part of this branch's diff.

## WRITTEN, NOT PROVEN

- The currently implemented hardening is committed locally through `824119a5`.
- It does not have a CLEAN exact-SHA push proof. The final mandatory review
  returned `CODEX_PROOF_VERDICT: BLOCKERS`, so no proof file was minted.

## NOT STARTED

- Distinguish runtime dynamic SQL from ordinary trigger syntax:
  `CREATE [EVENT] TRIGGER ... EXECUTE FUNCTION ...`.
- Support safe direct-literal PL/pgSQL `EXECUTE '...' USING ...` and
  `EXECUTE '...' INTO ...` forms without allowing variable, concatenated, or
  `format(...)`-built SQL.
- Add exact allow regressions for trigger creation and both parameterized direct
  literal forms, retain the hostile runtime-builder denies, and mutation-test
  each distinction independently.
- Run the full barrier and start a fresh governed exact-SHA review cycle.
- Only after CLEAN: push the branch, open the PR, wait for required checks and
  Vercel, resolve CodeRabbit, merge, and verify remote `main`.

## APPROVAL STATE

This handoff carries no push, merge, deployment, database, deletion, or other
outward-action approval into a receiving task. No database action is needed.

## GATES AND BLOCKERS

- `/ship` reached its hard cap of three fix/re-review rounds. The branch must
  remain parked and unpublished from this task.
- Final blocker: `.claude/hooks/actor-binding-check.mjs` still treats every
  remaining visible `EXECUTE` token as opaque runtime SQL. It therefore wrongly
  denies ordinary `CREATE [EVENT] TRIGGER ... EXECUTE FUNCTION ...` statements,
  including a current CRX migration pattern, and direct parameterized
  PL/pgSQL `EXECUTE '...' USING ...` / `EXECUTE '...' INTO ...` forms. The
  file-level exemption is not an acceptable default because it disables actor
  protection for the whole migration.
- Exact evidence:
  `C:\Users\mason\.codex\worktrees\phase3c-new-branch-cap\CRX_Manager\.claude\session-state\codex-review-latest.txt`.
- Unrelated nonblocking repo drift remains: four 2026-08-08 migrations are
  missing from the migration index, and two manual docs have 2026-08-07
  freshness stamps. Do not widen the hook fix into that work.
- The shared `C:\CRX_Manager` checkout contains unrelated gauntlet changes owned
  by another session. Preserve them.

## FIRST ACTION

From the isolated checkout, verify GitHub `main` again, then add the smallest
statement-shape distinction for `CREATE [EVENT] TRIGGER ... EXECUTE FUNCTION`.
Add exact trigger allow and hostile second-`EXECUTE` deny controls before
handling the direct-literal `USING`/`INTO` forms. Mutation-test every decision,
run the full barrier, and start a fresh governed exact-SHA review cycle.

Verify current state from Git, disk, and connected services before trusting this handoff; it may be stale when read.
