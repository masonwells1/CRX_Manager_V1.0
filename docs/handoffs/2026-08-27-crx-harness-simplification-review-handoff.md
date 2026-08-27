# CRX Harness Simplification - Review Handoff

## WHERE

- Worktree: `C:\Users\mason\.codex\worktrees\harness-simplification-20260827\CRX_Manager`
- Branch: `codex/simplify-harness-tranche1-20260827`
- Base: `005f71c8c33bf96082d1fc8678c96c24e2d281b0` (verified equal to `origin/main` at build start)
- Review target: the exact commit created from the scoped diff described below.

## GOAL

Adversarially verify that the first harness-simplification tranche reduces process overhead and retires Patrol without weakening, skipping, or changing any business safety rule or branch-protection setting.

## PROVEN

- Claude configured hook commands changed from 39 to 29; Codex changed from 30 to 24.
- Both `UserPromptSubmit` and `PostToolUse` now have one configured router process per agent surface.
- Each existing prompt/PostToolUse rule remains in its original module. The router supplies the same parsed payload and captures the module's original JSON/exit behavior.
- The PostToolUse router loads edit rules only for Write/Edit, apply lifecycle rules only for `apply_migration`, and the worktree heartbeat only for Claude.
- Codex migration-apply, MCP-tool, and live-testdata guards now match only `mcp__.*`; the production action guard matches only Bash, PowerShell, and MCP actions. Review-proof and hold-latch remain all-tool guards.
- Patrol's command, generated skill adapter, runtime, monitor, classifier, renderer, trusted-exec layer, and dedicated tests are removed. No Patrol scheduled task or running Patrol process exists on the workstation.
- The CRX Live Foundation Gauntlet is PAUSED outside the repository and retuned to monthly/on-demand, read-only, report-only review. A prevention mechanism is requested only for reproducible BLOCKER/HIGH recurrence and must consolidate an existing mechanism before adding a hook.
- `node .claude/hooks/hook-router.test.mjs`: 44 assertions passed, including each registered rule family, stateful hold/autopilot behavior, apply lifecycle behavior, agent-surface exclusions, manifest command counts, and Codex matcher scope.
- `node .claude/hooks/prompt-hooks.test.mjs`: 154 assertions passed.
- `npm run test:agent-workflows`: passed.
- `npm run test:correction-guards`: passed, including the original migration, MCP, SQL, actor, grant, registry, ledger, and schema guards.
- `npm run lint`: passed.
- `npm run typecheck`: passed after locked dependencies were installed with `npm ci`.
- `npm run build`: passed after locked dependencies were installed with `npm ci`.
- Ten harmless prompt events measured about 2607.4 ms across the former seven-process path and 394.9 ms through the router, a 6.6x local process-startup improvement.
- `node scripts/sync-agent-workflows.mjs --write` and `--check`: 37 generated Codex workflow files are synchronized.

## WRITTEN BUT NOT PROVEN

- No live Claude/Codex desktop event has yet exercised the merged router configuration from `main`; the executable contract is proven locally and will be exercised naturally after merge.
- CI timing reduction is inferred from process-count and local benchmark evidence; hosted CI is not affected by this tranche.

## NOT STARTED

- Exact-head Sol High adversarial review.
- Protected pull request, CodeRabbit reading, required GitHub/Vercel checks, merge, and post-merge verification.

## APPROVAL STATE

Mason explicitly authorized this tranche and the normal reviewed delivery path. He explicitly prohibited business-safety-rule and branch-protection changes; the diff must be rejected if it crosses either boundary.

## GATES

- Treat any lost module, swallowed block/deny output, incorrect matcher narrowing, agent-surface leak, or router fail-open as BLOCKER/HIGH.
- Confirm deleted Patrol files have no active references outside clearly labeled historical documentation.
- Confirm the product-data-model lane remains untouched: no `docs/plans/product-data-model*`, product migration/RPC, or product-model-test changes.
- Confirm no branch-protection, GitHub workflow, production app, Supabase, money, inventory, RLS, authorization, or customer-data change.
- Review must bind to the exact final commit and end with an unambiguous clean verdict before push/merge.

## FIRST ACTION

Read the exact base-to-head diff and mutation-test the router aggregation/selection assumptions before evaluating style or documentation.

Do not trust handoff claims without checking current Git, test, review, and service state first.
