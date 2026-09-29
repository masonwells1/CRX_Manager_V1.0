## 2026-09-29 — words after the peer preamble's colon are no longer dropped with a hand-back

Follow-up to `2026-09-25-subagent-hand-back-not-mason-authored.md`, on the same PR (#826).

**Finding (Sol exact-head review of `9fe6dad79`, `gpt-6-sol`, high, HIGH).** The
hand-back parser accepted an open tag on the line after `Another Claude session sent
a message:` even when words followed the colon, and then dropped that whole preamble
line with the report. So `Another Claude session sent a message: stop now` above a
framed report lost the stop, which `main` latched. The same shape hid a
`git push --force` from the danger warning.

**Change (`.claude/hooks/prompt-source-lib.mjs`, `reportOpenAt`).** The harness
preamble ends at its colon. Outside strict mode, a preamble line with anything after
the colon, other than an open tag on that same line, never starts a report. Such a
prompt is read as Mason's words, report included, which is the fail-safe side.
`hasAuthoredText()` (strict mode, the clearing path) is unchanged and still treats that
line as not Mason's, so it cannot clear a hold.

**Proof.**
- `prompt-hooks.test.mjs` passes with 607 assertions. The new cases:
  - the stop after the colon latches;
  - the `--force` after the colon reaches the reminder input;
  - a bare preamble line still starts a report.
- Reverting the library to `9fe6dad79` fails on the first new case.
- Driving the real `prompt-router.mjs`:
  - Sol's stop case latches the hold;
  - Sol's `--force` case fires the safety warning;
  - the incident report and a closed quiet report still inject nothing;
  - earlier cases are unchanged.
