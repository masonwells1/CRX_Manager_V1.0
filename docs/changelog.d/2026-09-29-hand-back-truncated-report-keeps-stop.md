## 2026-09-29 — the hold latch keeps a truncated hand-back, so Mason's indented stop under it still halts

Follow-up to `2026-09-25-subagent-hand-back-not-mason-authored.md`, on the same PR (#826).

**Finding (Sol exact-head review, `gpt-6-sol`, high, HIGH).** Sol passed `f022ec007`
clean. On `9aea10c51` (the same code plus a merge of `main`) it raised this HIGH. An
indented `  stop now` that Mason typed under a TRUNCATED subagent report (one with no
close tag) was read as report body, so `hold-latch-prompt.mjs` did not latch where
`main` did. Luna round 4 had refuted this case as an inherent ambiguity. Sol is right
that the halt has to win that ambiguity.

**Change (`.claude/hooks/prompt-source-lib.mjs`).** `stripSubagentReports()` takes a new
`keepTruncated` flag. It is set only in the non-strict strip orders, which is the hold
latch's `authoredByMason()`. With it set, a report with no close tag is kept whole
instead of stripped. The cost falls on the fail-safe side: a truncated report's own
"stop" can latch a spurious hold. Nothing else changes:
- The reminder hooks (`withoutSubagentReports()`) still strip a truncated report, so it
  cannot fire reminders or write `OVERNIGHT-INTENT.flag`.
- `hasAuthoredText()` still uses strict mode, so a truncated report cannot clear a hold.
- A CLOSED report is still stripped for the latch.

**Proof.**
- `prompt-hooks.test.mjs` passes with 604 assertions:
  - the SPELLINGS loop now expects the two truncated shapes to latch, in the unit checks and end to end;
  - new cases cover Mason's space- and tab-indented stop under a quiet truncated report;
  - a closed quiet report stays stripped;
  - a truncated report still cannot clear a hold.
- Reverting the library to `9aea10c51` turns the suite red.
- Driving the real `prompt-router.mjs`:
  - Sol's case (a quiet truncated report plus `  stop now`) latches;
  - a closed quiet report injects nothing and latches nothing;
  - the incident report still injects nothing;
  - a report saying "carry on" still does not clear Mason's pause.
- All `.claude/hooks/*.test.mjs` files pass, and so do `npm run test:agent-workflows` and the usage-report test.
