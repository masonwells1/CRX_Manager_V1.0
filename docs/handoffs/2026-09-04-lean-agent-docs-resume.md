# Lean Agent Instructions - Resume Note

## Goal

Make Codex and Claude easier for Mason to use as a non-coder: keep always-loaded instructions lean, route detail to task-specific documents, favor simple code, continue autonomously within scope, and clearly report blockers and next actions.

## Safe stopping state

- Branch: `codex/lean-agent-docs-20260904`
- Worktree: `C:\Users\mason\.codex\worktrees\lean-agent-docs-20260904\CRX_Manager`
- Implementation commit before this handoff note: `ea532e5e97951e94d7c6fde4ab1c85e3a0d9c50b`
- Base at the stop: `origin/main` at `8629e708b24676724dfa37016b9c00369eb488ef`
- The branch is committed, rebased, and intentionally unpushed. No PR exists.
- No production deploy, live database change, or customer-facing change occurred.
- The unrelated main-checkout draft `docs/handoffs/2026-09-04-pr584-consolidate-scope-resume.md` was preserved and not touched.

## Completed

- Reduced the repository `AGENTS.md` to a concise shared contract and made `CLAUDE.md` Claude-specific.
- Replaced `.cursorrules` with a small router instead of another policy copy.
- Moved coding style, collaboration, model tuning, research, and workflow detail into task-specific documents.
- Added explicit guidance that Mason cannot review code and needs plain-English outcomes, risks, choices, and next steps.
- Added simple-code rules: smallest safe change, short focused functions, reuse before adding abstractions, and no unrelated cleanup.
- Updated the startup reminder and guidance checks so the lean structure cannot silently regress.
- Updated the user-level Codex and Claude guidance; those local behavior improvements are already active.

## Proof already completed

- `npm run test:agent-workflows` - passed.
- `npm run check:agent-guidance` - passed.
- `npm run agent-health` - passed, aside from the expected dirty-worktree warning before commit.
- `npm run check:docs` - passed.
- `npm run lint` - passed.
- `npm run typecheck` - passed.
- `npm run build` - passed.
- Full `npm run test` after the implementation rebase - 347 files passed; 4,960 tests passed and 123 skipped.
- Two independent Claude reviews were run. Every blocker and high-severity finding from them was corrected. A third review was intentionally not purchased because usage credits were nearly exhausted.

The final rebase added only the unrelated migration-history documentation commit from PR #598 after the full test run; it did not change application code or these agent-document edits.

## Resume next week

1. Open this worktree and confirm `git status --short --branch` is clean.
2. Run `git fetch origin main` and compare `origin/main...HEAD`. Rebase safely if `main` moved.
3. Rerun the focused guidance, docs, lint, typecheck, and build checks. Rerun the full suite only if the base or implementation changed.
4. Review the exact diff, then push this branch and open the PR.
5. Wait for CI and the normal Codex GitHub App review. Fix real findings.
6. Freeze the green candidate, request the one CodeRabbit review through the normal label gate, and resolve its findings.
7. Merge the exact reviewed head and verify the production deployment.

## Separate follow-ups, not blockers

- Claude's global settings currently warn about unsupported `Write(...)` permission-rule syntax. Permission changes were outside this task and remain intentionally untouched.
- The locally reported Codex versions differ (`0.147` on PATH versus `0.153` detected by agent health). This pre-existing setup issue did not block the documentation work.

Recommended next action: resume with the current-state check in step 1, then let Codex own the PR-through-production delivery pipeline.
