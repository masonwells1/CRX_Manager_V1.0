# Actor-binding recovery review-cap handoff — 2026-08-13

## WHERE

- Repository/worktree: `C:\Users\mason\.codex\worktrees\df6d\CRX_Manager`
- Branch: `codex/actor-binding-mixed-notation-repair-20260810`
- Functional repair head before this documentation commit: `66e6a013fa3083e232913389656343d99b95b9d9`
- Documentation-only handoff commit: `4a20885cbebc502ed562e353e0f2920cc55c9164`; it created this file and is intentionally excluded from the pre-documentation functional proof snapshot below.
- Current fetched `origin/main`: `73af6f19941b3c428e41bf0654870a5f09b839ac`
- Delivery PR: [#373](https://github.com/masonwells1/CRX_Manager_V1.0/pull/373), still draft; its remote head is `e652f723` and its base is the old `a44fc2f`.
- Production service: `https://croprxsolutions.app`; Supabase project: `rhyzpcqhnizqbxphqdkr`.

## GOAL

Land the actor-binding parser repair only after the exact current branch head has a clean independent review, all protected PR checks and CodeRabbit are acceptable, and the normal merge/deployment verification completes. No parked migration is to be applied in this work.

## PROVEN

- At this handoff's capture point the worktree was clean at `66e6a013`; `git diff --check origin/main...HEAD` passed. The branch was one commit behind and 102 commits ahead of current `origin/main`.
- Final scoped migration and compliance reviews at `f3e9341c` found no HIGH/BLOCKER. They verified the three August migration files remain explicitly parked and only carry documented hook-exemption comments.
- The final RLS/application review found a real stale Offline Work Review resolution path. `b7f0f62` clears selected resolution state and its idempotency key before every queue refresh, disables resolution controls while loading/error, and adds a deferred-refresh regression. The focused UI test passed 8 assertions; typecheck and lint passed.
- The governed review of exact `b7f0f62` found a real HIGH private-helper ACL bypass: revoking only `PUBLIC`/`authenticated` could leave `anon`, and a later schema-wide grant was not seen. Its capture is `.claude/session-state/codex-review-latest.txt`; it is blocker evidence for `b7f0f62`, not approval for the current head.
- `66e6a013` repairs that bypass: the compatibility path requires explicit `PUBLIC`, `anon`, and `authenticated` revocation; fails closed for schema-wide, quoted, Unicode, or unrecognized-role grants; and permits only `postgres`/`service_role` regrants. The new regressions cover the `anon`, schema-wide, and arbitrary-role cases.
- The focused actor-binding suite passed 383 assertions on the repaired worktree. All 38 August migration files returned `allow` through the repaired reader, with zero denials. Typecheck, lint, the focused Offline Work Review test, and `git diff --check` passed before the final commit. The mandatory pre-commit barrier completed before Git created `66e6a013`.
- Read-only live migration ledger evidence in this recovery reported 970 rows with high-water `20260813011751` (`20260813070000_pin_return_idempotency_helper_contract`); Wave A `20260813010000` through `20260813060000` are absent and remain unapplied. No live data or migration was changed.

## WRITTEN, NOT PROVEN

- `66e6a013` has not received an independent exact-SHA CLEAN proof. The preceding review is intentionally stale because it reviewed `b7f0f62` and returned BLOCKERS.
- PR #373 has not been updated, readied, checked, merged, deployed, or production-verified in this recovery.

## NOT STARTED

- A new governed exact-head review cycle for `66e6a013` after integrating current `origin/main`.
- Safe fast-forward publication to the existing PR #373, protected GitHub/Vercel checks, CodeRabbit classification, merge, and post-merge production verification.

## APPROVAL STATE

Mason authorized this recovery and ordinary reversible repairs. This handoff carries no authority to push, merge, deploy, apply migrations, mutate live data, delete data, or change permissions. The next worker must use current repository policy and current Mason authority before outward actions.

## GATES AND BLOCKERS

- The recovery review cycle has used its three exact-head rounds: procedure/callable-boundary review, Unicode grant/application-state review, and `b7f0f62` private-helper ACL review. The last finding was fixed in `66e6a013`, but the three-round cap means do not self-certify or start a fourth review in this cycle.
- Do not push or merge without a fresh governed CLEAN proof bound to the exact head and current base. Do not reuse `.claude/session-state/codex-review-latest.txt`.
- Current `origin/main` moved to `73af6f19`; the branch must be refreshed without force before any future exact-head proof or PR publication.
- PR #373 remains safely draft with stale remote head/base. No CodeRabbit, Vercel, or PR check result for the repaired head exists.
- The six Wave A migrations remain parked; do not apply them or regenerate the schema registry as though they had been applied.

## FIRST ACTION

After a new review cycle is explicitly authorized, fetch `origin/main`, merge its current head into this clean worktree without rewriting history, rerun the full owning proof, and begin round 1 of that new exact-SHA review cycle. Do not push until it returns CLEAN.

Verify current state from Git, disk, and connected services before trusting this handoff; it may be stale when read.
