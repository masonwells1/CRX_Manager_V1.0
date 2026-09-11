## 2026-09-10 — Reset-order scanner masks comments before excusing a reset

CodeRabbit's review of PR #638 at `0e7ee9d4b` found that `classify()` in
`src/__tests__/idempotency-reset-order.test.ts` read its three look-back windows as RAW
source. The per-line `stripNoise()` cannot see a multi-line `/* … */` block, so comment
or string text could supply a recovery marker, `.throwOnError()` or `onClick=` and excuse
a reset that has no executable guard.

`classify()` now masks comments across the whole file prefix up to the reset with the
existing `stripCommentsOnly()`, so a block opened above a window still counts. It then
blanks each line's string literals with `stripNoise()`. The recovery, fire-and-forget and
intent-rotation windows, plus the same-line guard check, all read that masked text.
Test-only: no application code changed. `docs/manual/KNOWN_ISSUES.md` residual (h) and
the scanner's own comments now say that only `aliasNames()` still reads raw source.

Proof observed:

- Seven new negative cases (four recovery-marker, one `.throwOnError()`, two
  intent-rotation, including a block comment opened above the 8-line window). Each
  one failed separately against the unfixed scanner in a soft-assert run.
- After the fix, all 20 tests in the file pass. That includes the repo-wide sweep
  (no new offenders), the exact pins for known-unfixed files, and the stale-allowlist
  check. So no current site was being excused only by comment text.
- `eslint --max-warnings=0` on the file and `npm run typecheck` are clean.

Not verified here: the full `vitest` suite, which CI runs. The mask is still a scanner,
not a lexer:

- a regex literal containing a quote leaves later comments unmasked, which is the old
  raw behaviour
- a regex literal containing `/*` can blank real code
- a multi-line template body still reads as code
