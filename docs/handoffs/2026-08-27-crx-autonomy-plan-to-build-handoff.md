# CRX autonomy with hard boundaries — build-to-review handoff

## WHERE

- Checkout: `C:\Users\mason\.codex\worktrees\autonomy-with-hard-boundaries-20260827\CRX_Manager`
- Branch: `codex/autonomy-with-hard-boundaries-20260827`
- Base: `origin/main` at `63839dbbc4d5a24d226830aa2cfa448f0f2f8187`
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
- The shared push policy, arming confirmation, intent reminder, Claude guidance, collaboration/coding references, guardrail reference, per-change changelog fragment, and owning test script now agree.
- Global `C:\Users\mason\.codex\hooks\global-risky-phrase-nudge.mjs` now makes the same distinction. Its independent 11-assertion test is green.
- `npm run test:correction-guards` passed, including 56 autopilot assertions, 167 hold/production guard assertions, 411 Bash-safety assertions, and the complete migration/live-data/review-proof suites.
- `npm run test:agent-workflows` passed, including 166 prompt-hook assertions, Codex/Claude adapter parity, production-action guard proof, and agent-guidance checks.
- `npm run check:docs`, `npm run typecheck`, and `npm run build` passed after installing the locked dependencies with `npm ci --ignore-scripts`; npm reported zero vulnerabilities.
- Mutation proof was observed in both directions: neutering the force-push regex failed `force push denied`, and reclassifying routine auto-delivery as approval-required failed `routine delivery does not demand another Mason confirmation`. Both mutations were restored and focused tests passed again.
- The first independent exact-head review of commit `413b0a16` returned BLOCKERS with one valid HIGH: enabling `--auto` while a PR was non-risky could let a later risky commit land without a fresh exact-head review. The remediation denies auto-merge for every main-bound PR in both Claude and Codex guards, updates `land-pr.mjs` to disable pre-existing auto-merge, and keeps autonomous delivery by waiting for checks then performing one immediate guarded merge. The new universal gate was mutation-proved load-bearing, and both owning guard suites plus the pinned live-maintenance producer test pass.
- A later GitHub Codex review of commit `1bcb583e` found three valid delivery issues: GraphQL could still arm auto-merge, the printed immediate merge command was not pinned to the inspected head, and the ledger entry was in the shared changelog instead of `docs/changelog.d/`. The GraphQL routes now fail closed in both guards, both printed commands use `--match-head-commit`, regression tests cover those paths, and the ledger is a new per-change fragment. The protected producer input/output hashes were re-pinned to the tested source, and all affected producer/guard/workflow suites pass.
- The fresh independent review of `50a71d9f` correctly refused proof with one HIGH and one MEDIUM: the guards suggested but did not require the expected-head SHA, and `auto deploy` was mistakenly treated as routine delivery. CLI and REST merges now require an atomic SHA equal to `headRefOid`; MCP merge tools deny because their installed schemas cannot supply that precondition. Auto-deploy wording again retains the existing out-of-band production approval gate. Missing/mismatched CLI pins, missing REST SHA, MCP denial, and deployment classification all have regression coverage.
- GitHub's review of `22314108` found one P1 and one P2 before merge: file-backed GraphQL could hide an auto-merge mutation, and the ship/rollback instructions still emitted unpinned merges. Uninspectable GraphQL bodies now deny closed, both command producers read and require the literal inspected SHA, and regression tests cover `--input` plus `-F query=@file`.
- The next exact-head review found the final asynchronous bypass: auto-merge could already be armed before a later feature push, allowing GitHub to merge that new head after CI without an immediate merge command. Both push guards now enumerate explicitly named feature destinations, query open main-bound PRs for `autoMergeRequest`, fail closed on missing/ambiguous/API state, and give the agent a no-Mason recovery path (`node scripts/land-pr.mjs <number> --once`, then retry). Parser and Codex action-guard regressions cover inactive, active, malformed, API-failure, alternate-destination, and bare-push cases.
- The exact-head review of `e7c347398` found two remaining parser evasions: wildcard refspecs collapsed to the literal `*` lookup, and `$verb='merge'; gh pr $verb ... --auto` hid an auto-merge action after a pushed commit. Feature pushes now require one standalone command and exactly one literal valid branch destination; wildcard, multi-ref, bare/config-directed, and chained push forms fail closed. Shell-expanded GitHub CLI actions are denied by autopilot and both Claude/Codex merge guards, with focused regressions for the demonstrated shapes.
- The exact-head review of `064f1691` found a compound selectorless merge context race: `git switch <other> && gh pr merge --squash` could inspect the pre-switch branch but execute against the post-switch branch. Both guards now require exactly one standalone merge command with an explicit numeric PR, `--repo owner/repo`, and exact 40-character head SHA; GH_REPO/GH_HOST/GH_CONFIG_DIR/GITHUB_API_URL overrides deny closed. Ship, rollback, and `land-pr` command producers now emit the complete context-bound form.

## REMAINING DELIVERY

- Commit and push the final secure-transport remediation.
- Re-run the independent exact-head adversarial review on the new commit and resolve any real finding.
- Wait for refreshed PR checks and exact-head CodeRabbit review, merge with `--match-head-commit`, and verify the merged policy on `main` plus production health.

## APPROVAL STATE

Mason explicitly requested more Codex working room and authorized addressing unnecessary approval loops. That authorization covers this reversible harness change and ordinary protected delivery. It does not authorize force-push/history rewrite, irreversible business/customer-data deletion, secret/auth/permission/billing/domain/account changes, or bypassing a red/ambiguous safety gate.

## GATES AND BLOCKERS

- Exact-head review of `01147bea` found that a GitHub REST merge could combine a visible SHA with an uninspected file-backed body that overrides it. REST merges now deny unconditionally; autonomous delivery retains only the standalone, explicit `gh pr merge ... --match-head-commit ...` path.
- Exact-head review of `6836076d` found PowerShell `&gh` could evade the merge parser and unattended pushes still admitted remote branch deletion. The parser now recognizes shell separators/call operators, while `--delete`, `-d`, and empty-source deletion refspecs deny before any push.
- Exact-head review of `86155cb4` found `--disable-auto` could be consumed as body text while hiding a real `--auto`, and empty quote pairs could compose executable/subcommand tokens after inspection. Auto flags are now parsed positionally, mixed intent denies, and quote-composed GitHub words fail closed.
- Exact-head review of `f990bc02` found the protected `land-pr.mjs` helper path could be quote- or escape-spliced around its guard. Command-path classification now evaluates raw, dequoted, and shell-escape-collapsed views for both execution and mutation, with focused regressions for PowerShell, POSIX, cmd-caret, and backtick spellings.
- Exact-head review of `a8fef393` found armed unattended approval could authorize editing its own merge guard before a later delivery action. Autopilot now has a non-auto-approvable integrity boundary around Claude/Codex hook sources and manifests across file tools, patches, redirects, and shell mutators, while ordinary app-file edits remain automatic.
- Exact-head review of `f69ae3a5` found feature pushes queried CRX even when another remote was targeted, and non-branch refs could pass outside the intended lane. Push URLs now resolve to the exact GitHub repository used in the lookup, and unattended pushes require one explicit `refs/heads` destination; tags, notes, follow-tags, ambiguity, and multi-repository destinations deny.
- Exact-head review of `1ad8e0bd` found unquoted `#` comments could hide the real end of a merge command while fake repository/head flags were inspected. GitHub CLI commands with unquoted comment markers now fail closed before parsing; quoted hashes remain data.
- Exact-head review of `bd547ab9` found that armed unattended approval could still edit a trusted delivery wrapper and then execute that modified proof or landing logic. The protected boundary now includes proof producers, landing helpers, maintenance executors, hook manifests, and their registration surface. Wrapper execution proceeds automatically only when every boundary file is tracked and Git-unchanged from the current HEAD; clean and dirty `land-pr` plus push-proof paths have end-to-end regressions.
- Exact-head GitHub review of `b37ecfe3` found that dot-segment spellings such as `scripts/./land-pr.mjs` and `.claude/foo/../hooks/pr-merge-guard.mjs` still reached the same protected files without matching the integrity boundary. CodeRabbit also demonstrated grouped PowerShell paths and a missing trusted-CLI fail-closed catch, then identified inaccurate recovery text in the landing helper and rollback runbook. Protected file-tool paths are now canonicalized, shell grouping boundaries and explicit inline-interpreter writes are recognized without blocking read-only searches, trusted executable resolution fails closed, integrity/update-branch errors name their real recovery, and the runbook passes the explicit PR number. The non-main `baseRefOid` difference is documented rather than tightened because only protected-main merges consume that SHA; no business safety rule changed.
- Exact-head local review of `c1c1057f` found that `pushGitHubRepository()` accepted custom helpers and cleartext GitHub URLs after canonicalizing away the transport. Effective feature-push URLs now have to match the existing secure GitHub HTTPS/SSH allowlist before repository identity is considered. Library regressions cover helper, cleartext, Git, file, nonstandard-port, and non-Git-user spellings; end-to-end Codex and Claude guard tests prove the demonstrated helper and cleartext routes deny before GitHub lookup.
- Exact-head local review of `8ebe5573` found that grouping normalization recognized only a bare `gh`, so a quoted absolute `/usr/bin/gh` API mutation inside POSIX grouping or process substitution passed all three command guards. The shared action matcher now recognizes bare and absolute GitHub CLI spellings consistently after grouping normalization; the demonstrated merge/ref-write commands are pinned as denials in the shared parser, armed autopilot, Claude merge guard, and Codex production guard.
- Exact-head local review of `b4506c96` found that `--delete-branch` was parsed but omitted from the merge request object while `land-pr.mjs` printed it for every autonomous merge. The option is now rejected before PR lookup for all head names and fork ownership, removed from the landing helper, and documented as a separate destructive lifecycle action rather than an unattended merge side effect.

- Do not edit product-data-model plans, migrations/RPCs, or product-model tests.
- Do not absorb the separate `codex/migration-approval-gate` worktree; live migration approval behavior is outside this tranche.
- Do not change branch protection or business safety rules.
- PR #511 changes `AGENTS.md`; avoid that file so the lanes stay mergeable.

## FIRST ACTION

Commit only the late review remediation, push it, and run a fresh exact-head adversarial review before the protected merge.

Verify current state from Git, disk, and connected services before trusting this handoff; it may be stale when read.
