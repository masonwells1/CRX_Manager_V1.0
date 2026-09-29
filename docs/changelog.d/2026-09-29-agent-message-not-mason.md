## 2026-09-29 — subagent hand-back reports are no longer read as Mason typing

**Problem (handoff item 5).** A subagent's report arrives wrapped in `<agent-message …>`.
`.claude/hooks/prompt-source-lib.mjs` did not recognise that envelope, so the UserPromptSubmit
phrase hooks (gauntlet reminder, ship-intent reminder, `hold-latch-prompt.mjs`) reacted to the
subagent's words as if Mason had typed them. Worst case: a report containing "pause" or "stop"
latched `hold.json` and blocked approved work.

**Change (Mason approved, 2026-09-28: "I grant them all").** `agent-message` joins
`cross-session-message` in `NON_AUTHORED_TAG_NAMES`: the block is stripped as data inside
`authoredByMason()` / `hasAuthoredText()`, and whatever Mason typed around it is still matched.
It is deliberately **not** added to `MACHINE_TAG_NAMES`, which would make his own words in the same
prompt inert (the 2026-08-26 decision for peer messages).

**Proof observed.** With the previous library, a report reading "pause the rollout and stop the
loop" latched the hold and counted as Mason speaking; with this change it does neither, and
"stop everything" typed after the report still latches. New unit and end-to-end cases in
`.claude/hooks/prompt-hooks.test.mjs` (289 assertions pass), including the real hook process
writing (or not writing) `hold.json`.

**Not verified here.** No Luna round or Sol proof (no Codex CLI in this cloud session). It rides
PR #836, which Mason merges by hand.
