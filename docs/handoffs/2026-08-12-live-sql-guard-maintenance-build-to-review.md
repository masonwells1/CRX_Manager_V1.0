# Live SQL guard maintenance — build-to-review handoff

## WHERE

- Checkout: `C:\Users\mason\.codex\worktrees\weekly-audit-remediation\CRX_Manager`
- Branch: `codex/harness-maintenance-producer-20260812`
- Base verified before build: `origin/main` at `2837263d2a22eca71142bf77e449acbe2512e232`
- Repository: `masonwells1/CRX_Manager_V1.0`
- Production Supabase project: `rhyzpcqhnizqbxphqdkr` (no live write is part of this producer change)

## GOAL

Restore a governed way to repair the protected live SQL classifier without disabling or bypassing
its direct-write guard. Done means the one-use producer is independently reviewed at its exact head,
passes the protected PR pipeline, and lands before the classifier repair is activated on a new branch.

## PROVEN

- The current source blob is pinned to `c8bec70830c643e474831985f5e6c3bd16630386`.
- `node scripts/apply-live-testdata-maintenance-20260812.mjs --verify` produced pinned output blob
  `78a25a8b01635bf86d9bc7a857f703479f3be500`, matched all three snippet SHA-256 values, and passed a
  Node module syntax check without changing the repository target.
- `node scripts/apply-live-testdata-maintenance-20260812.test.mjs` executed 37 assertions against the
  generated module, including all nine defect classes found by the first four Sol reviews.
- The write mode refused the dirty build worktree even with Mason's dated token.
- Focused ESLint, TypeScript typecheck, agent-workflow tests, ledger check, and `git diff --check` passed.
- The guarded commit suite passed lint, typecheck, production build, correction-guard tests,
  documentation drift, dependency integrity, containment, and workflow-map generation.

## WRITTEN, NOT PROVEN

- The checked-in producer can write only the assembled protected target on a clean non-protected
  branch after exact hash checks and the dated approval token. Its real write mode has intentionally
  not run; it must not run until this producer itself is reviewed and merged.

## NOT STARTED

- Exact-head `gpt-5.6-sol` high review of this branch.
- Push, pull request, CodeRabbit/check review, merge, and post-merge verification.
- Follow-up branch that runs the producer, adds red-to-green classifier regressions, removes the
  temporary producer, and completes its own exact-head review/pipeline.
- Separate reconciliation of the two newer live-applied migration sources/schema registry and the
  six stale Wave A migration timestamps.

## APPROVAL STATE

Mason approved remediation of all weekly-audit findings on 2026-08-12. This handoff does not convey
permission to weaken a guard or apply a live migration. Normal reviewed PR delivery remains authorized;
any later live migration apply still requires the repository's current explicit apply gate.

## GATES AND BLOCKERS

- Direct file writes to the protected classifier remain correctly blocked.
- The producer branch must receive an exact-head clean Sol proof before push/merge.
- The first exact-head Sol review returned blockers (unsafe transaction control in a `DO` smoke and
  safe E2E writes re-blocked by the final deny loop); both were repaired and require a fresh review.
- The second exact-head Sol review returned four more blockers (conditional/caught aborts,
  literal-only E2E predicates, `VALUES`-invoked mutators, and CTE `SELECT INTO`); all four were
  reproduced, repaired, and require another fresh exact-head review.
- The third exact-head Sol review returned two more blocker classes (negated/misbound E2E identity
  and multiple DML operations hidden in one statement). The persistent raw-SQL E2E exemption was
  removed, every DML target is now enumerated, and a fresh exact-head review remains required.
- The fourth exact-head Sol review found that PostgreSQL escape strings could hide a following
  mutation from the scanner. Escape-string parsing and six destructive regressions were added; a
  fresh exact-head review remains required.
- GitHub checks and CodeRabbit must be complete and acceptable on the exact PR head.

## FIRST ACTION

Refresh `origin/main`, confirm this branch contains it and is clean, then run the exact-SHA Sol-high
review wrapper against the current branch head.

Verify current state from Git, disk, and connected services before trusting this handoff; it may be stale when read.
