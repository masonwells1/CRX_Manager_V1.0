## 2026-09-25 — a subagent's hand-back report is no longer read as Mason's words

**Incident.** A background subagent's final report reached its parent session as
`Another Claude session sent a message:` followed by a `<\~agent-message from="…">` …
`<\~/agent-message>` block. The UserPromptSubmit hooks did not recognise either part, so
the report was judged as text Mason typed: a "stop" in it latched `hold.json` (blocking
source edits until he replied), a quoted `--no-verify` fired `dangerous-phrase-warning`,
and the autopilot, gauntlet and ship reminders fired. Reproduced on `main` before the fix:
a report containing "going to bed" also wrote `OVERNIGHT-INTENT.flag`, the 45-minute
freeze.

**Second defect found while reproducing.** The same preamble line precedes every
`<cross-session-message>` too, and it counted as Mason's text. So `hasAuthoredText()` was
true for a real peer-only message, and a sibling session's message could CLEAR a hold
Mason had latched. That is the direction the 2026-08-26 design said must never happen.

**Change (`.claude/hooks/prompt-source-lib.mjs`).**
- A hand-back is recognised by LINE STRUCTURE, and this runs first in both strip orders.
  It starts at the harness preamble, with the open tag (`<~agent-message …>`, any number
  of leading backslashes, the name ending at whitespace or `>`) on the same line or the
  next non-blank line, and the `[Subagent hand-back]` frame line after that. It runs
  through the blank, indented, `[Subagent hand-back]` or
  `[harness` lines after the open tag, plus a column-zero close tag directly after them.
  The harness indents every report line, so a close tag the report QUOTES cannot end it
  early. A wrapper typed without the preamble is Mason's text, and a truncated report
  ends at his next column-zero line.
- `hasAuthoredText()` alone strips in STRICT mode: everything from a hand-back to the end of
  the prompt, and every other preamble line whole. This follows the existing
  union (latch) / intersection (clear) split: an ambiguous span can halt but never counts
  as Mason speaking.
- The preamble phrase `Another Claude session sent a message:` is removed at the start of
  a line in both strip orders. Only the phrase goes, so anything typed after it on the same
  line is still read.
- New `withoutSubagentReports()` for the six intent-reminder hooks: it removes only
  hand-back blocks and the preamble. Code spans, blockquotes and cross-session messages
  stay visible to the reminders, so Mason's own `` `git push --no-verify` `` still warns
  and a sibling's request is unchanged.
- `dangerous-phrase-warning`, `ship-intent-reminder`, `autopilot-intent-reminder`,
  `codex-gauntlet-reminder`, `agent-pair-review-reminder` and
  `codex-to-claude-handoff-reminder` now match on `withoutSubagentReports(prompt)`.
- `scripts/claude-usage-report.mjs`: a bare hand-back fell back to its raw text and was
  counted as a human prompt (and could become a `--titles` title). Its peer-envelope
  check now also recognises the harness preamble line.
- Comments in `hold-latch-prompt.mjs` and `hold-latch-lib.mjs` name the new spans.

**Review round (independent Claude reviewer, 2026-09-25).** The first cut paired the tags
like the other envelopes (`<tag …>` … `</tag>`, an unclosed one stripped to the end of the
prompt). The reviewer reproduced two defects in it, and both drove the line-structure
design above:
- HIGH, fail-open versus `main`: a tag Mason merely mentioned swallowed the "stop" he typed
  after it. Examples: `why did the <\~agent-message> wrapper latch? stop and explain`,
  `check <agent-message-log> then stop`, or a pasted report top followed by `ok stop`.
  `main` latched all of these; the first cut latched none.
- MED: a report that quotes its own close tag (bare, in backticks or in a fence) ended
  early. The rest was read as Mason's, so it latched, wrote the freeze flag, fired every
  reminder, and could clear his hold. `main` had the same defect.
- A truncated report, and Mason's backticked tag mention above a real report, no longer
  mislead the reminders.

All of these are now pinned in `prompt-hooks.test.mjs`. A scratch comparison confirmed
each case against all three versions: `main`, the first cut, and the final code.

**Luna review (`gpt-5.6-luna`, xhigh, 2026-09-26), 4 findings.**
- BLOCKER, fixed: a wrapper typed at column zero with indented text under it was taken
  for a report even without the preamble, so Mason's own `stop` inside it was stripped.
  Blocks now require the harness preamble.
- HIGH, fixed: an open tag on the preamble's own line, or indented, was not recognised,
  so the report's "carry on" could clear a hold. Both shapes are now handled. A closed
  report with an unindented line can no longer clear a hold (strict mode). It can still
  latch one, which is the fail-safe direction.
- HIGH, deferred by design: sibling cross-session text still reaches the reminder hooks
  (see below).
- MED, refuted in substance but tightened anyway: the usage report's prefix check. The
  cited input was not actually lost, because `authoredByMason` keeps a non-report line.
  The check now keys on the preamble line instead of a tag.

**Luna review round 2 (2026-09-26), 1 finding.** BLOCKER, fixed. The fix above for an
unindented report line stripped through the next close tag, so a truncated report
followed by Mason's `stop now` and then a close tag swallowed his stop. The two shapes
cannot be told apart, so they are now split by direction. Latching and the reminders end
the report at his line, so the stop halts. `hasAuthoredText()` strips through the close
tag, so the span cannot clear a hold.

**Luna review round 3 (2026-09-26), 4 findings.**
- HIGH, fixed: the open tag accepted prose after it, so
  `<agent-message> stop now </agent-message>` on the preamble line swallowed the stop.
  The tag must now be alone on its line.
- HIGH, fixed: with indented open and close tags, an indented `stop now` after the close
  was swallowed. An indented close tag now ends a report whose open tag was indented.
- HIGH, part fixed: a truncated report with an unindented line could clear a hold. Strict
  mode now runs a truncated report to the next preamble. The rest of the finding (an
  unindented line inside a report reaching the reminders) is refuted: the harness indents
  every report line and says so in its own frame text, which was observed in this
  session. Such a line is read as Mason's, the fail-safe direction.
- LOW, refuted: the usage report does not drop Mason's words beside a peer block, because
  `masonWords()` returns the authored remainder whenever it is non-empty and consults the
  preamble check only when nothing of his is left.

**Luna review round 4 (2026-09-26), 3 findings.**
- HIGH, fixed: an indented preamble QUOTED inside a report ended the strict scan, so the
  rest of the report counted as Mason speaking and could clear a hold. Only a column-zero
  preamble now starts a message.
- HIGH, refuted as a non-harness shape, fail-safe: with an INDENTED open tag, a close tag
  the report quotes on its own indented line ends the report early, and the rest reaches
  the latch and reminders. The harness writes the open tag at column zero. The leak can
  only add a pause or a reminder; it cannot drop Mason's stop or clear his hold, because
  strict mode ignores indented close tags.
- HIGH, refuted as an inherent ambiguity: indented lines Mason types after a TRUNCATED
  report are read as report body. A truncated hand-back has not been observed, Mason types
  unindented text, and those lines cannot be told apart from the report's own. Keeping
  them would let truncated reports fire reminders and the 45-minute freeze, which the
  first review flagged.

**Luna review round 5 (2026-09-26), 3 findings.**
- BLOCKER, fixed: a report with a stray unindented `Another Claude session sent a
  message: carry on` line ended the strict scan, and "carry on" counted as Mason
  speaking. In strict mode every such line now counts as not his. A peer envelope tag
  opening on that line is kept, so it still pairs with its close.
- HIGH, fixed: a wrapper Mason types with the preamble but without the harness's
  `[Subagent hand-back]` frame line was stripped. The latch and the reminders now
  require the frame line (or a `[harness` line) directly after the open tag, so only the
  exact harness shape is taken away from him. Strict mode does not require it, so a
  frameless report still cannot clear a hold.
- HIGH, refuted: a hand-back Mason pastes inside a code fence no longer triggers the
  danger warning for a `git push --force` inside it. Those are the subagent's words
  quoted back, not a request from Mason, which is what the change intends.

**Luna review round 6 (2026-09-26), 3 findings.**
- HIGH, fixed: strict mode stopped at the first column-zero close tag, so a close tag a
  report quoted unindented (not a harness shape) let the rest count as Mason speaking.
  Strict mode now runs to the LAST close tag before the next preamble.
- HIGH, fixed: an indented `[Subagent hand-back]` line under a column-zero open tag was
  accepted as the frame. The frame must now sit at the open tag's own indentation.
- LOW, accepted trade-off: Mason literally typing `Another Claude session sent a
  message: continue` latches nothing and does not clear a hold (strict mode drops the
  line). He can clear it with his next message; the conservative direction is deliberate.

**Luna review round 7 (2026-09-26), 3 findings.**
- BLOCKER ×2, fixed as a class: a column-zero preamble inside a report, or a quoted close
  tag in a truncated report, again ended the strict scan early, so report text could
  clear a hold. Rounds 4 to 7 each found another such layout, none of them a real harness
  shape. Strict mode now treats everything from a hand-back to the end of the prompt as
  not Mason's. The accepted cost, pinned by a test: his words typed after a hand-back in
  the same prompt cannot clear a hold, though his next message does. Words before it
  still count, and a stop after it still latches.
- LOW, accepted: a prompt that is only an orphan close-tag line does not clear a hold.

**Deliberately unchanged / known residuals.**
- Cross-session messages still reach the reminder hooks. That includes
  `autopilot-intent-reminder`, so a sibling session writing "going to bed" can still set
  the 45-minute freeze flag, as on `main`. Mason approved leaving this in the plan for this
  change; changing it is his call, per the note on `MACHINE_TAG_NAMES`.
- A hand-back without the harness preamble is not recognised. It is then read as Mason's
  words, which is the fail-safe direction and the pre-fix behaviour.
- No real `<agent-message>` record exists in the local transcripts, so the exact bytes come
  from the incident report and from a live subagent hand-back seen in this session, not
  from a captured payload.

**Proof.**
- Real hook processes, run against a verbatim-shape report (the preamble plus
  `<\~agent-message>`), before and after. Before: the danger warning fired, autopilot fired
  and wrote the freeze flag, and `hasAuthoredText` was true for a real-shape peer message.
  After: all seven hooks were silent, with no hold, no flag, and `hasAuthoredText` false.
- `prompt-hooks.test.mjs` (597 assertions after rebasing onto #802, including every real
  Luna case above). `hasAuthoredText()` keeps #802's third, pre-#794 check alongside the
  strict hand-back stripping, and all three must keep text before a prompt clears a hold. It covers 13 report shapes end to end: the
  escaped, bare-sigil, no-sigil and double-backslash spellings, CRLF, truncated, quoting
  the close tag three ways, an unclosed fence, an open tag on the preamble line, and
  indented tags. It also covers Luna's typed-wrapper case and the ambiguous
  truncated-then-stop-then-close case (latches, reaches the reminders, and a closed
  report with an unindented line cannot clear a hold). A control run proves every phrase hook fires on
  the unwrapped body. It also covers the reviewer's mention cases, Mason's words beside a
  report (still fire), his innocuous line beside a report (fires nothing), and that
  neither a report nor a preamble-plus-peer message clears his hold, while his own reply
  does.
- Mutation checks: reverting the library to `main`, to the first cut, or to either
  pre-Luna-round commit turns the suite red, and so does reverting each reminder hook to `main`. Reverting the usage-report line
  makes its test count 3 human prompts instead of 2.
- All `.claude/hooks/*.test.mjs` pass, `npm run test:agent-workflows` passes, and
  typecheck, lint, build, `npm test` and the doc-drift check are green.
