## 2026-10-01 — FieldApplicationInvoice date-change tests pin the business day

Two tests in `src/pages/FieldApplicationInvoice.test.tsx` failed all day on 2026-10-01, on main
and on every PR:

- "discards a rendered preview when the transaction date changes"
- "drops a preview response that arrives after the transaction date changed"

A new invoice's Transaction Date starts on today's Chicago date (`todayInBusinessTz()`). Both tests
then "changed" it to the hard-coded `2026-10-01`. On 2026-10-01 that is the value already in the
field, so no change happened and the stale preview was never discarded. Test code only; the page is
unchanged.

**Fix.** A `pinBusinessDay()` helper fakes only `Date`, so testing-library's real timers keep
working. It sets the clock to 12:00 CDT on 2026-09-30, and a top-level `afterEach` restores the real
clock. Each test now also asserts that the field starts on `2026-09-30`. The change to `2026-10-01`
is therefore always a real change across the Oct 1 season boundary, which is what the race test's
comment says it covers. If the starting date ever drifts again, the test fails loudly instead of
silently becoming a no-op.

**Proof (2026-10-01).** Before the fix, the file failed 2 of 44 tests. After it, the file passes
44/44, and the full `npm run test` run passed 381 files (5452 passed, 123 skipped). Backwards check:
with `invalidatePreview`'s version bump and clear temporarily removed from
`FieldApplicationInvoice.tsx`, both tests failed, so they still guard the real behaviour. The page
was then restored, and `git diff` showed it clean. Lint and typecheck pass.
