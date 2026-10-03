## 2026-10-03 — Luna round 3: last agent-guidance details restored

Third follow-up to `2026-10-03-slim-agent-guidance.md`, on the same PR. Luna round 3 found no BLOCKER
or HIGH and 4 MED/LOW findings, all accepted and fixed:

- `AGENTS.md`: the delivery chain says a migration is applied BEFORE the merge.
- `AGENTS.md`: a Luna round must never run through the proof wrapper, which unlinks the existing proof
  for that HEAD.
- `CLAUDE.md`: never copy hook implementations into `.codex/`.
- `session-context-reminder.test.mjs`: also asserts the "or repeated pauses" wording.

**Proof observed:** `check-agent-guidance` all PASS, the reminder test passes, and `check-doc-drift`
and `test:agent-workflows` exit 0.
