## 2026-10-02 - proposal to skip the Sol review for documentation-only changes (draft, not in effect)

Mason asked for a draft rule letting some merges skip the final Sol review. Sol needs the
Codex program, which only Mason's computer has, so cloud sessions stall at the last step.
`docs/plans/2026-10-02-sol-skip-for-low-risk-changes.md` proposes:
- **Scope:** the exemption covers documentation-only PRs, which still need CodeRabbit's
  approval and green checks.
- **Exclusions:** code, migrations and the agent safety layer, including `.claude/hooks/`,
  keep Sol.
- **Rejected:** it explains why a "small agent-tool changes" exemption would be unsafe.
- **Mason's part:** it lists the guard and test work an adoption would need and gives the
  exact `AGENTS.md` wording for Mason to apply himself.
- **Recommendation:** give cloud sessions a Codex login instead, if Codex supports it.

Nothing changed in `AGENTS.md`, the hooks or the merge guard. The decision is Mason's.

### Proof observed

- `npm run check-doc-drift` passes.

### Not verified

- Whether Codex supports a non-interactive login that a cloud session could use (the
  recommended alternative) was not checked.
- The guard changes the proposal describes were not written or tested.
