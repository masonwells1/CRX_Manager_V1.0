## 2026-10-01 — field-application invoice tests no longer fail on October 1 (date bomb)

On 2026-10-01 two tests in `src/pages/FieldApplicationInvoice.test.tsx` started failing on main:
"discards a rendered preview when the transaction date changes" and "drops a preview response that
arrives after the transaction date changed". Both change the transaction date to 2026-10-01 and
expect the on-screen preview to be thrown away. The page defaults that date to today in Chicago,
so on October 1 itself the "change" set the field to the value it already had, nothing happened,
and the tests failed. The app was not at fault; only the tests depended on the calendar.

- Both tests now pin the clock (Date only; timers stay real) to noon Chicago on 2026-09-30, the
  last day of season 2026. The move to 2026-10-01 is then a real change across the season
  boundary, which is what the tests' own comments describe.
- Each test now asserts the starting date is 2026-09-30 before changing it, so a future clock
  problem fails with a clear message instead of a confusing one.

Proof: the file's 44 tests pass. With the pinned clock deliberately moved to 2026-10-01, both
tests fail at the new 2026-09-30 check; that change was reverted. Not verified: no production
behavior changed, and none was exercised; this is a test-only change.
