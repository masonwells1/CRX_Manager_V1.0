# CRX autonomy with hard boundaries — build-to-review handoff

## WHERE

- Checkout: `C:\Users\mason\.codex\worktrees\autonomy-with-hard-boundaries-20260827\CRX_Manager`
- Branch: `codex/autonomy-with-hard-boundaries-20260827`
- Base: `origin/main` at `0b3bc84cc407a35172623a13b94ac6e2b8a1f006`
- Repository: `masonwells1/CRX_Manager_V1.0`
- Global Codex configuration: `C:\Users\mason\.codex\config.toml`

## GOAL

Remove repeated approval requests for routine, reversible work and protected green-PR delivery without weakening the explicit gates for force-push/history rewrite, irreversible business-data deletion, secrets/auth/permissions/billing/domain changes, or bypassing failed safety checks. Done means routine plan → edit → test → feature-branch push → green PR → merge can continue without another Mason prompt, including in an armed unattended run, while mutation tests prove the hard denials remain.

## PROVEN

- Current Codex already uses `approval_policy = "never"`, `approvals_reviewer = "auto_review"`, and `sandbox_mode = "danger-full-access"`; the base platform setting is not the repeated-prompt source.
- Current source inspection identified three contradictory harness paths: the SessionStart onboarding reminder says to wait before multi-file/risky edits; global and CRX prompt nudges demand another confirmation for ordinary go-live/auto-delivery wording; armed autopilot denies every push and PR merge before the existing production guards can judge them.
- Existing production, push, merge, Bash-safety, migration, live-testdata, secret, and branch-protection guards remain available as the lower authoritative safety boundaries.
- Graphify was refreshed at the exact base, but `graphify explain autopilotDecision` and `graphify explain PUSH_POLICY` returned no matching nodes; focused source and tests are therefore the authoritative navigation for this harness-only change.
- The separate product-data-model lane and the existing migration-approval-gate branch were inspected read-only and do not overlap the intended file set.

## WRITTEN AND PROVEN

- Session onboarding now says to state a brief plan and begin authorized reversible work; the old blanket wait-before-multi-file/risky-edits sentence is gone.
- The CRX risky-phrase hook classifies auto-commit/push/merge as routine protected delivery, while every existing destructive phrase remains a fresh-approval match. Mixed prompts keep safe preparation moving and gate only the dangerous action.
- Armed autopilot lets ordinary feature-branch pushes, CLI protected PR merges, and GitHub MCP protected PR merges reach the existing production guards. Its force-push detector covers long flags, trailing `--force-with-lease`, combined short flags, and forced `+refspec` forms. Direct remote file writes, deploys, destructive lifecycle actions, secret paths, resets, hook bypasses, and the rest of the prior deny set remain denied.
- Mason's explicit stop/pause latch remains stronger than autopilot and still blocks every PR-merge spelling.
- The shared push policy, arming confirmation, intent reminder, Claude guidance, collaboration/coding references, guardrail reference, changelog, and owning test script now agree.
- Global `C:\Users\mason\.codex\hooks\global-risky-phrase-nudge.mjs` now makes the same distinction. Its independent 11-assertion test is green.
- `npm run test:correction-guards` passed, including 56 autopilot assertions, 167 hold/production guard assertions, 411 Bash-safety assertions, and the complete migration/live-data/review-proof suites.
- `npm run test:agent-workflows` passed, including 166 prompt-hook assertions, Codex/Claude adapter parity, production-action guard proof, and agent-guidance checks.
- `npm run check:docs`, `npm run typecheck`, and `npm run build` passed after installing the locked dependencies with `npm ci --ignore-scripts`; npm reported zero vulnerabilities.
- Mutation proof was observed in both directions: neutering the force-push regex failed `force push denied`, and reclassifying routine auto-delivery as approval-required failed `routine delivery does not demand another Mason confirmation`. Both mutations were restored and focused tests passed again.
- The first independent exact-head review of commit `413b0a16` returned BLOCKERS with one valid HIGH: enabling `--auto` while a PR was non-risky could let a later risky commit land without a fresh exact-head review. The remediation denies auto-merge for every main-bound PR in both Claude and Codex guards, updates `land-pr.mjs` to disable pre-existing auto-merge, and keeps autonomous delivery by waiting for checks then performing one immediate guarded merge. The new universal gate was mutation-proved load-bearing, and both owning guard suites plus the pinned live-maintenance producer test pass.

## NOT STARTED

- Commit the exact-head review remediation.
- Re-run the independent exact-head adversarial review and resolve any real finding.
- Push the feature branch, open the PR, read CodeRabbit, wait for required checks, merge, and verify the merged policy on `main`.

## APPROVAL STATE

Mason explicitly requested more Codex working room and authorized addressing unnecessary approval loops. That authorization covers this reversible harness change and ordinary protected delivery. It does not authorize force-push/history rewrite, irreversible business/customer-data deletion, secret/auth/permission/billing/domain/account changes, or bypassing a red/ambiguous safety gate.

## GATES AND BLOCKERS

- Do not edit product-data-model plans, migrations/RPCs, or product-model tests.
- Do not absorb the separate `codex/migration-approval-gate` worktree; live migration approval behavior is outside this tranche.
- Do not change branch protection or business safety rules.
- PR #511 changes `AGENTS.md`; avoid that file so the lanes stay mergeable.

## FIRST ACTION

Review the exact diff for accidental safety-rule removal, especially the autopilot deny set and mixed-prompt behavior. Then commit only the files named by this handoff and begin the protected delivery path.

Verify current state from Git, disk, and connected services before trusting this handoff; it may be stale when read.
