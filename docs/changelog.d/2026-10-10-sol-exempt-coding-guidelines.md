## 2026-10-10 - Sol exemption: coding-guidelines.md always needs Sol (Codex review on #888)

The Codex GitHub App's review of PR #888 (P1) found that `docs/reference/coding-guidelines.md` was
still eligible. `AGENTS.md` sends agents to it, together with `docs/reference/gotchas.md`, before
any code change, so it works as instructions. Mason already made `gotchas.md` always need Sol
("add those two", 2026-10-09), and this is the same kind of page.

- `.claude/hooks/sol-exempt-lib.mjs` and `docs/reference/sol-exempt-paths.md`: the page joins the
  never-eligible list. The proposal's status line and `docs/manual/DECISION_LOG.md` name it.
- `docs/reference/sol-exempt-paths.md` now states where the line is, so reviewers can check a
  page against a rule instead of one page at a time: a page `AGENTS.md` sends agents to as rules
  for changing code needs Sol (onboarding, coding guidelines, gotchas, `docs/workflows/`); a page
  that describes the system or records history stays eligible (`ARCHITECTURE.md`,
  `DECISION_LOG.md`, `KNOWN_ISSUES.md`, `CURRENT_STATE.md`).

### Proof observed

- `node .claude/hooks/sol-exempt-lib.test.mjs` passes 200 assertions with 57 mutants caught: the
  page brings Sol back, the readable list still matches the module, and dropping the entry is a
  mutant the tests catch.
