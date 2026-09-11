## 2026-09-10 — Reset-order scanner masks comments before excusing a reset

CodeRabbit's review of PR #638 at `0e7ee9d4b` found that `classify()` in
`src/__tests__/idempotency-reset-order.test.ts` read its three look-back windows as RAW
source. The per-line `stripNoise()` cannot see a multi-line `/* … */` block, so comment
or string text could supply a recovery marker, `.throwOnError()` or `onClick=` and excuse
a reset that has no executable guard.

Its review at `00993da04` found the same hole through two more routes. The first fix
still blanked strings one line at a time and never blanked a regex literal, so a regex
on the line above a reset, or a template literal spanning lines, could supply that text.

`classify()` now reads every window through a new `maskNonCode()`. It masks comments,
string contents, template-literal text and regex-literal bodies across the whole file
prefix up to the reset, keeping line breaks, so a block or template opened above a window
still counts. A template's `${…}` interpolation stays code. A `/` opens a regex only where
an expression can start (after `(`, `=`, `,`, `=>`, `return` and similar), so division and
JSX closing tags stay code. An unclosed quote ends at the line break, so JSX text such as
`Don't` cannot mask the lines after it. The recovery, fire-and-forget and intent-rotation
windows, plus the same-line guard check, all read that masked text. Test-only: no
application code changed. `docs/manual/KNOWN_ISSUES.md` residual (h) and the scanner's own
comments say that only `aliasNames()` still reads raw source.

Proof observed:

- First fix: seven negative cases (four recovery-marker, one `.throwOnError()`, two
  intent-rotation, including a block comment opened above the 8-line window). Each one
  failed separately against the unfixed scanner in a soft-assert run.
- Second fix: seven more negative cases. There is a regex literal above the reset for
  each of the three excuses, a quote inside a regex followed by a block comment, and a
  multi-line template for each excuse. In a soft-assert run against the first fix's mask,
  all seven failed and nothing else did. Five positive controls pass on both masks:
  division with a second `/` on the line, code inside a template interpolation, an
  apostrophe in JSX text, a handler between two JSX closing tags, and a mutating call
  after a regex on the same line.
- After the fix, all 21 tests in the file pass. That includes the repo-wide sweep
  (no new offenders), the exact pins for known-unfixed files, and the stale-allowlist
  check. So no current site was being excused only by comment, string, template or regex
  text.
- `eslint --max-warnings=0` on the file and `npm run typecheck` are clean.

Not verified here: the full `vitest` suite, which CI runs. The mask is still a scanner,
not a lexer:

- a `/` after `)`, `]`, `}` or `<` is read as division, so a regex literal written there
  stays visible, which is the old behaviour
- a `//` inside JSX text masks the rest of its line
