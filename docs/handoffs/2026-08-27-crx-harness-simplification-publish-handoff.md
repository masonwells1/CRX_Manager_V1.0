# CRX Harness Simplification - Publish Handoff

> **SUPERSEDED REVIEW STATE (2026-08-27):** The final-head refresh found CRX-SEC-1 HIGH:
> narrowing the Codex production guard excluded native Write/Edit/apply_patch protection for the
> harness files the guard owns. Publication is blocked until the matcher is restored to `*`, the
> reachability regression test passes, and a new exact-head review returns clean. The earlier clean
> verdict below is preserved as provenance, not as current approval.

## WHERE

- Worktree: `C:\Users\mason\.codex\worktrees\harness-simplification-20260827\CRX_Manager`
- Branch: `codex/simplify-harness-tranche1-20260827`
- Reviewed code commit: `2768918869f9da256cfedcd40e69194050c8a043`
- Base reviewed: `005f71c8c33bf96082d1fc8678c96c24e2d281b0`

## GOAL

Publish the proven first harness-simplification tranche through the protected pull-request path, then verify the merged automation and repository state.

## PROVEN

- Local router mutation, prompt, workflow, correction-guard, lint, typecheck, and build proofs are green; exact commands and results are recorded in the review handoff.
- Sol High review of code commit `27689188` completed at 2026-08-27T19:07:17Z with
  `CODEX_PROOF_VERDICT: CLEAN`, but the later final-head refresh found CRX-SEC-1 HIGH and superseded
  that approval.
- The reviewer independently matched all 5,653 sanitized snapshot files, parsed all changed scripts/configs, confirmed routing/blocking/agent-surface separation, found no active Patrol code/config references, and found no production code, migration, money, RLS, RPC, permission, or secret change.
- The CRX Live Foundation Gauntlet is PAUSED and retuned monthly/on-demand outside the repository.
- The product-data-model lane is separate and untouched.

## WRITTEN BUT NOT PROVEN

- This publish handoff is the only post-review repository addition. Because it changes the final head SHA, the exact-head proof must be refreshed before push.

## NOT STARTED

- Restore production-guard native-edit reachability and rerun the affected tests.
- Final exact-head proof including the correction.
- Feature-branch push and pull-request creation.
- Required GitHub/Vercel checks and CodeRabbit review.
- Merge and post-merge verification of `main` plus the paused automation configuration.

## APPROVAL STATE

Mason's original request and standing delivery authority cover the ordinary branch, pull request, green checks, merge, and verification path. No Mason-only destructive or account-setting gate is in scope.

## GATES

- Refresh exact-head Sol High proof after committing this handoff.
- Do not push if `origin/main` moved without refreshing the exact base/head binding.
- Read all automated review feedback on the final PR head.
- Merge only when protected required checks and Vercel are complete and acceptable.
- Do not change branch protection, business safety rules, product code, database state, or the product-data-model lane.

## FIRST ACTION

Commit this handoff, fetch `origin/main`, and rerun the repository-owned exact-head review wrapper before pushing.

Do not trust handoff claims without checking current Git, test, review, and service state first.
