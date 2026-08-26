# Pre-push containment performance handoff

**Written:** 2026-08-26

## WHERE

- Repository: `https://github.com/masonwells1/CRX_Manager_V1.0`
- Worktree: `C:\Users\mason\.codex\worktrees\prepush-containment-perf-20260826\CRX_Manager`
- Branch: `codex/prepush-containment-perf-20260826`
- Verified base: `origin/main` at `14378963c4c2188844757c07da4ca0f38e4944f3`
- Production: `https://croprxsolutions.app`

## GOAL

Reduce the real pre-push private-artifact containment time materially without weakening fail-closed coverage. Done requires retained before/after timing, mutation-tested deny paths, the full containment suite, exact-SHA adversarial review, protected PR delivery, and post-merge verification.

## PROVEN

- PR #484 merged at `14378963c4c2188844757c07da4ca0f38e4944f3`; main CI, CodeQL, Vercel, and production HTTP 200 were green at closeout.
- The isolated worktree began clean and exactly even with `origin/main` at the verified base above.
- The shared `C:\CRX_Manager` checkout is dirty with a separate Claude cleanup sweep and is not this task's writer lane.
- No open PR owns this containment-performance scope.
- This worktree's inherited absolute `core.hooksPath` was corrected locally to `.husky/_`; `core.fsmonitor` is unset.
- PR #484 measured the remaining push scan at 52,276 paths, 52,279 candidates, 788,073,950 logical bytes, and roughly 8-9 minutes before typecheck/build.
- The same-worktree instrumented baseline measured 50,801 paths, 48,006 ignored paths, 50,802 candidates, 661,279,697 logical bytes, 405,535 ms in the worktree scan, and 434,901 ms total.
- The narrow implementation excludes descendants of only the explicit top-level tool-owned ignored roots from ignored-file enumeration. Git-visible/index/history content, nested lookalikes, exact root endpoint files, candidate scanning, and double-read race closure remain in scope.
- The focused containment suite is green after the change.
- Mutation proof is red as required: removing the new top-level exclusions fails at `node_modules/fflate/private-packet.json`; restoring them returns the full suite to green.
- The same-worktree post-change benchmark measured 2,812 paths, 17 ignored paths, 2,815 candidates, 92,649,224 logical bytes, 220 ms in the worktree scan, and 37,468 ms total.
- `check:docs`, `test:agent-workflows`, lint, TypeScript, and the production build are green. The build emitted only its existing non-blocking large-chunk warnings.

## WRITTEN, NOT PROVEN

- The implementation, regression contract, changelog, and decision-log entry are written and locally proven, but are not yet committed or independently reviewed at an exact SHA.

## NOT STARTED

- Commit and capture the real hook-driven pre-push timing.
- Obtain independent exact-SHA adversarial review.
- Push the reviewed exact SHA, open the protected PR, resolve automated review, merge only with all exact-head gates green, and verify `main` plus production.

## APPROVAL STATE

Mason explicitly asked Codex on 2026-08-26 to perform this narrow optimization pass. Ordinary isolated-branch implementation, testing, PR delivery, reviewed merge, and normal Vercel verification are covered by standing authorization. No live data, migration, secret, permission, or destructive action is in scope.

## GATES AND BLOCKERS

- Fail closed on missing roots, setup failures, changing candidates, untrusted remotes, divergent push URLs, malformed metadata, and unexplained ancestry.
- Keep ignored operator-controlled packet candidates visible; do not convert the prior narrow tool-owned `ENOENT` exception into a broad skip.
- Retain output, actual exit status, elapsed time, and unchanged-input evidence for performance claims.
- Any rejected exact SHA is permanently rejected; fix narrowly and restart exact-head review.
- Graphify's skill is unavailable in this session. The refreshed PR #484 graph report was used only for navigation; current source and executable proof remain authoritative.

## FIRST ACTION

Run the broader local gates, inspect the complete diff and ledger, then commit the smallest complete slice for exact-SHA adversarial review.

Verify current state from Git, disk, and connected services before trusting this handoff; it may be stale when read.
