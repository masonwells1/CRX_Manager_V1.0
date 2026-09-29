## 2026-09-29 — the six reminder hooks ignore subagent reports too

**Problem.** The first handoff-item-5 fix (`2026-09-29-agent-message-not-mason.md`) only reached
`hold-latch-prompt.mjs`. The six advisory reminders — ship-intent, Codex gauntlet, autopilot,
Codex-to-Claude handoff, agent pair-review and dangerous-phrase — still matched the raw prompt, and
a subagent's `<agent-message>` hand-back report fired the ship-intent reminder in the same session
right after that fix landed.

**Change.** New `withoutOtherAgentText()` in `.claude/hooks/prompt-source-lib.mjs` removes only
other-agent envelopes (peer messages, subagent reports, harness blocks). Unlike `authoredByMason()`
it leaves Mason's code, inline code and blockquotes in place, so the reminders' recall on what he
types is unchanged. All six reminder hooks now match on it; the hold latch keeps the stricter
`authoredByMason()`.

**Proof observed.** The previous ship-intent hook fired on a report reading "fix it and ship it";
the new one stays silent. 18 new end-to-end cases in `.claude/hooks/prompt-hooks.test.mjs` run each
hook as a real process: it fires on Mason's own trigger phrase, stays silent on the same words
inside a report, and fires again when he types them after one (307 assertions).
`npm run test:correction-guards`, `npm run test:agent-workflows`, `npm run lint` and
`scripts/check-doc-drift.mjs` pass.

**Not verified here.** No Luna round or Sol proof (no Codex CLI in this cloud session). Rides PR
#836, which Mason merges by hand.
