## 2026-10-08 - Sol exemption: Luna round 6 fixes (wording and one test gap)

Luna's sixth review of the documentation-only Sol exemption raised one HIGH and three LOWs.

- **HIGH, not changed, left for Mason.** Luna again says `docs/manual/DECISION_LOG.md` should
  always need Sol. This is the round-2 disagreement. Mason's approved list makes all of
  `docs/manual/` eligible except `OWNER_PLAYBOOK.md`, so it stays eligible unless he decides
  otherwise.
- **LOW, fixed.** `AGENTS.md`'s autonomous-landing rule still listed a clean Sol review as a
  condition for every agent merge. It now says the documentation-only exception also satisfies
  it, and so does the Autonomous landing block in `docs/reference/agent-guardrails.md`.
- **LOW, fixed.** `docs/manual/DECISION_LOG.md` said the whole list is matched without regard to
  case. Only the never-eligible lists are; the eligible folders must match exactly.
- **LOW, fixed.** No test proved that GitHub's `ahead_by` must be a whole number. New cases (text
  `"2"`, `1.5`, missing) need Sol, and a new mutant that drops the whole-number check is caught.

### Proof observed

- `node .claude/hooks/sol-exempt-lib.test.mjs` passes 185 assertions with 52 mutants caught.
