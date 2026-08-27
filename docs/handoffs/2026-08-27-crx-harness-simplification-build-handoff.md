# CRX Harness Simplification - Build Handoff

## WHERE

- Repository: `C:\Users\mason\.codex\worktrees\harness-simplification-20260827\CRX_Manager`
- Branch: `codex/simplify-harness-tranche1-20260827`
- Starting commit: `005f71c8c33bf96082d1fc8678c96c24e2d281b0`
- Starting point verified equal to live `origin/main` on 2026-08-27.
- The shared checkout at `C:\CRX_Manager` is intentionally excluded because it contains unrelated uncommitted work.

## GOAL

Reduce CRX harness maintenance and per-action process overhead without removing or weakening any business safety rule and without changing GitHub branch protection.

## PROVEN

- The prior read-only audit found repeated independent process launches, not excessive business invariants, to be the main local overhead.
- Claude currently launches seven separate `UserPromptSubmit` programs and five separate `PostToolUse` programs across two matcher groups.
- Codex runs migration, MCP, and live-testdata guards under broader matchers than Claude, causing irrelevant launches.
- Patrol is a standalone interactive queue monitor with its own command, skill adapter, runtime, tests, and maintenance surface.
- The CRX Live Foundation Gauntlet has been paused and retuned outside the repository to a monthly, read-only, report-only audit. A new prevention mechanism is now proposed only for a reproducible BLOCKER/HIGH recurrence, with consolidation required before adding a hook.

## WRITTEN BUT NOT PROVEN

- This handoff only. No repository harness behavior has been changed yet.

## NOT STARTED

- Consolidate the seven prompt registrations behind one router while preserving every existing prompt rule.
- Consolidate PostToolUse dispatch behind one path-aware router while preserving migration, registry, snapshot, heartbeat, and lint behavior unless measurement supports moving lint in a later tranche.
- Align Codex MCP-only matcher scope with Claude.
- Remove Patrol command, skill adapter, runtime, tests, and active documentation references.
- Regenerate Claude-to-Codex workflow adapters and manifest outputs.
- Run focused mutation tests, full agent-workflow tests, typecheck/build as required by the repository, and exact-head adversarial review.
- Deliver through a protected pull request and verify the merged state.

## APPROVAL STATE

Mason explicitly authorized this first tranche, including pausing/retuning the gauntlet and retiring Patrol. He explicitly excluded changes to business safety rules and branch protection.

## GATES

- No business guard may be removed, weakened, or silently skipped.
- Matcher changes must only eliminate irrelevant launches and must preserve fail-closed behavior on applicable tools.
- Router tests must mutation-test each registered rule and verify blocking/output propagation.
- Claude remains the workflow source of truth; generated adapters must be synchronized and parity-tested.
- The exact final commit must receive a separate adversarial review with no unresolved BLOCKER/HIGH finding.
- Required GitHub and Vercel checks must be green or explicitly expected neutral/skipped before merge.

## FIRST ACTION

Inventory each prompt and PostToolUse hook's input/output/exit behavior, then build routers that preserve those contracts before changing registrations.

Do not trust handoff claims without checking current Git, test, review, and service state first.
