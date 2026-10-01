## 2026-10-01 — field-application invoice tests no longer depend on the real date

On 2026-10-01, CI started failing every PR and `main` with two tests in
`src/pages/FieldApplicationInvoice.test.tsx`:
- "discards a rendered preview when the transaction date changes"
- "drops a preview response that arrives after the transaction date changed"

The app itself is unchanged and was not broken.

**Cause.** The page defaults its transaction date to `todayInBusinessTz()`, which is today in
Chicago. Both tests "move" the date to `2026-10-01` and expect the preview to reset. From midnight
Chicago time on Oct 1, that date equals the default, so no change happens and the old preview
stays on screen.

**Fix (test-only).** The test file mocks `todayInBusinessTz()` to return `2026-09-15`, a fixed
date inside the season the tests were written for. Every other export of `src/lib/dateUtils` keeps
its real behaviour. No product code changed.

**Proof.**
- Without the fix, on today's clock: 2 tests fail and 42 pass in this file.
- With it: all 44 pass.
- The full suite passes: 381 files, 5,452 tests, 123 skipped.
- `npm run typecheck` and eslint on the file pass.

**Not verified:** no Codex Luna round or Sol proof has run on this change. Other test files were not
audited for the same kind of dependency on the real date; they all pass today.
