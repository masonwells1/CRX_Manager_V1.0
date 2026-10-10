## 2026-10-09 - Sol exemption: AGENT_ONBOARDING.md and gotchas.md always need Sol

Sol's clean review of PR #888 left one MEDIUM suggestion: `AGENTS.md` sends agents to
`docs/manual/AGENT_ONBOARDING.md` and `docs/reference/gotchas.md` before they change code,
including security-sensitive code, so those pages work as instructions. Without this change, an
edit to them could skip the final Sol review. Mason agreed ("add those two", 2026-10-09).

- `.claude/hooks/sol-exempt-lib.mjs`: both paths join the never-eligible list. The match ignores
  case, like the rest of that list.
- `docs/reference/sol-exempt-paths.md` lists them and says why. The proposal's status line,
  `docs/manual/DECISION_LOG.md` and the main changelog entry name them among the
  stricter-than-proposal choices.

### Proof observed

- `node .claude/hooks/sol-exempt-lib.test.mjs` passes 194 assertions with 55 mutants caught.
  Each file (and the `Gotchas.md` spelling) brings Sol back, the readable list still matches the
  module, and dropping either entry is a mutant the tests catch.
- `node .codex/hooks/production-action-guard.test.mjs` passes: adding either file to a
  merge-ready docs-only PR brings the Sol requirement back, end to end.
