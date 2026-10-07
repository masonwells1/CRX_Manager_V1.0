## 2026-10-06 — guard cleanup, part 2: the unwired reminder files are deleted

Completes the removal recorded in `2026-10-04-guard-cleanup-part-2.md`.

**Removed**

- `dangerous-phrase-warning.mjs`, `codex-gauntlet-reminder.mjs`, `agent-pair-review-reminder.mjs`, `codex-to-claude-handoff-reminder.mjs` and `autopilot-intent-reminder.mjs` under `.claude/hooks/`, with their tests and `overnight-intent-clear.test.mjs`. Nothing loaded them since part 1 unwired them.

**Proof observed**

- Mason ran the `git rm` on 2026-10-06, because the main checkout's older review-proof guard refuses an agent's shell delete under `.claude/hooks`.
- A repository search afterwards found no remaining import, wiring or test entry, only history notes. `npm run test:correction-guards`, `npm run test:agent-workflows`, `npm run check:docs` and `npm run agent-health` passed after the deletion.
