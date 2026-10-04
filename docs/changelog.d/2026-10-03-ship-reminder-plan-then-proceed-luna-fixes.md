## 2026-10-03 — Ship reminder says plan-then-proceed; Luna round 1 restores slimmed details

Follow-up to `2026-10-03-slim-agent-guidance.md` on the same PR; it closes that entry's "Not done here" item.

- `.claude/hooks/ship-intent-reminder.mjs`: the per-prompt ship reminder now says "Claude and Codex
  post the plan and proceed". Mason approved this file in chat after the auto-mode classifier refused
  the first attempt as self-modification.
- A Luna review round (8 findings, all accepted) restored details the first slimming pass dropped:
  - the `SECURITY DEFINER` fully-qualified search-path exception still needs its proof;
  - a workflow's round cap is a ceiling;
  - reviews and plans keep their own definitions of done;
  - parked work also updates the docs.
  `CLAUDE.md` again separates the review workflows and states Graphify's verification limits.
  `AGENTS.md` is now ~9,200 bytes and `CLAUDE.md` ~2,200.
- `scripts/check-agent-guidance.mjs`: the CodeRabbit pin now also requires the positive rule that
  "the agent posts `@coderabbitai review` once".

**Proof observed:**
- `node scripts/check-agent-guidance.mjs`: all PASS.
- `prompt-hooks.test.mjs`: 609 assertions passed.
- `session-context-reminder.test.mjs`: passed.
- `check-doc-drift` and `test:agent-workflows`: exit 0.
- The hook's real output shows the new wording.
- Negative control: with the CodeRabbit sentence deleted, the new pin fails.
