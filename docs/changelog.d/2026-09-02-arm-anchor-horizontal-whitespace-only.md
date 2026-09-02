## 2026-09-02 - Arm anchor matches horizontal whitespace only, not CR/LF

Codex (`gpt-5.6-sol`, exact-SHA review) Low finding on an otherwise clean verdict. Fixed
rather than deferred.

## The defect

`ARM_CMD_RE` used `\s`, which matches CR and LF — shell command separators. The anchor
therefore accepted multiline forms of the arm command.

**Not exploitable as written:** the end anchor `\s*$` cannot match an appended command, so
`--off\nnpm run build` was already refused. The accepted multiline forms were only odd
spellings of the arm command itself.

## Why fix it anyway

The identical `\s`-swallows-newlines mistake produced a *real* bypass in
`review-proof-guard.mjs`'s cd scanner, where a whitespace separator merged two `cd`
invocations into one and only the first target was ever checked. That guard now uses
`[^\S\r\n]` for exactly this reason. Matching it here means the anchor's safety no longer
depends on the end-anchor holding forever against future edits.

## The fix

Every `\s` in `ARM_CMD_RE` is now `[^\S\r\n]` — horizontal whitespace only.

## Verification

84 unit assertions pass, including four new cases: a newline between `node` and the script,
a newline before the flag, and a newline- and CRLF-appended second command. All denied. The
10 end-to-end checks still pass.
