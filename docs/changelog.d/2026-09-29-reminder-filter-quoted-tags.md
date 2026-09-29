## 2026-09-29 — reminder filter keeps Mason's words after a quoted envelope tag (Codex P2 on #836)

**Problem.** The Codex GitHub App's review of PR #836 found that `withoutOtherAgentText()`
treated a tag Mason merely quotes in inline code as a real unclosed envelope. For
"The literal `<agent-message>` tag is relevant. Build the page and ship it" it returned only
"The literal `", so all six reminder hooks went silent on his actual instruction.

**Change.** `withoutOtherAgentText()` in `.claude/hooks/prompt-source-lib.mjs` now runs a second
pass that hides closed code spans and fenced blocks behind placeholders before stripping envelopes,
then restores them. Anything either pass keeps counts. For an advisory reminder that errs toward
firing, never toward going silent on Mason.

**Proof observed.** On the previous library the example returned "The literal `"; now it keeps
"Build the page and ship it". New cases in `.claude/hooks/prompt-hooks.test.mjs`: each of the six
hooks still fires after an inline-code or fenced quote of the tag, and real reports (with inline
code, or unterminated) are still removed whole (324 assertions).

**Codex P1 on the same review (refuted with evidence).** It said a commit status's `url` is
`/statuses/<status-id>`, so the follow-up rule could never match. GitHub's real answer for PR #820's
head (`GET …/commits/970052fc…/statuses`) has `url` ending in the commit SHA. Running the rule on
#820's real, unmodified reviews and statuses: the approval-only rule refuses the head, the
follow-up rule clears it. `pr-merge-guard.test.mjs` now pins that real status object.
