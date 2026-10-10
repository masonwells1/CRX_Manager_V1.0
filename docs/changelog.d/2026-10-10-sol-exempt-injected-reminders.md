## 2026-10-10 - The injected landing reminders name the documentation-only Sol exception (Codex review on #888)

The Codex GitHub App's review of PR #888 (P2) found that the two reminders hooks inject into an
agent's context still stated the Sol proof without the new exception. An agent shipping a
documentation-only change could follow them, run Sol for nothing, or stop when Sol is unavailable.

- `.claude/hooks/prompt-source-lib.mjs` `PUSH_POLICY` (the LANDING POLICY that
  `ship-intent-reminder.mjs` injects): the step "exact-SHA Sol proof LAST" now reads "(except a
  documentation-only change, docs/reference/sol-exempt-paths.md)".
- `.claude/hooks/session-context-reminder.mjs` (session start): adds "A documentation-only change
  (docs/reference/sol-exempt-paths.md) needs no Sol proof; the merge gates check its file list."
- `.claude/hooks/autopilot-intent-reminder.mjs` (the arm-autopilot reminder) restated the landing
  rule the same way; a sweep of every hook's agent-facing text found it, and it now names the
  exception too. The other hook strings that mention Sol are the merge and migration gates' own
  denials, which only demand Sol once the exemption has already said no, and the migration rules.
- `prompt-hooks.test.mjs` and `session-context-reminder.test.mjs` now pin the exception in the
  LANDING POLICY and session-start reminders.

No guard decision changed.

### Proof observed

- `node .claude/hooks/prompt-hooks.test.mjs` (626 assertions), `node
  .claude/hooks/session-context-reminder.test.mjs` and `node .claude/hooks/hook-router.test.mjs`
  (60 assertions) pass. `npm run test:correction-guards`, `npm run test:agent-workflows` and
  `npm run agent-health` pass.
