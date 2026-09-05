## 2026-09-05 - Reports date presets follow the Chicago business day, not the viewer's clock

Round-4 landing fix for PR #592, from finding 3 of the exact-SHA `gpt-5.6-sol` review of
`554934e7a`.

## The defect

Every date preset on the Reports page (`This Season`, `Last Season`, `YTD`, `Last 30d`, `Last 90d`)
derived "now" from `new Date()` — the *viewer's* clock. Crop RX's business day is
America/Chicago, and the commission history RPC already refuses a future Chicago date, so any admin
whose own timezone is ahead of Central got a range that disagreed with the company's books:

- **The end date silently lost a day.** At 11:30 p.m. Mountain on September 4 — already September 5
  in Chicago — `YTD`/`Last 30d`/`Last 90d` ended September 4, and both the report and its CSV
  omitted September 5 Chicago activity.
- **On September 30 it moved the whole season.** This is the worse half and it was not in the
  original finding. `computeSeason()` reads the anchor date's month, and the crop season rolls at
  October 1. For a viewer whose local clock had already reached October 1 while Chicago was still on
  September 30, `This Season` opened on season 2027 — the season that had just *closed* — so the
  final selling day of the year fell outside every preset range. `Last Season` was off by a year in
  the same instant.

## The fix

`getPresetDates()` now anchors to `parseLocalDate(todayInBusinessTz())`: the Chicago business date,
rebuilt at local midnight so the existing season helpers and `formatLocalDate()` round-trip that same
day. `todayInBusinessTz()` uses `Intl.DateTimeFormat` with an explicit zone, so it is independent of
the host's own timezone.

The 30/90-day offsets also moved off millisecond subtraction (`now - 30 * 86400000`) onto
`setDate()`. Across a local DST spring-forward the millisecond form lands at 23:00 on the previous
day, and `formatLocalDate()` then reports a start date one day early.

## Proof

New case in `src/pages/Reports.commissionHistory.test.tsx` pins the absolute instant
`2026-10-01T02:00:00Z` (2026-09-30 21:00 Chicago) and asserts all five presets. It is pinned as an
absolute instant, never a local-midnight `Date`, so its meaning does not change with the host
timezone.

- `TZ=UTC` (a viewer already on October 1): passes with the fix; **fails without it** —
  `expected '2026-10-01' to be '2025-10-01'`, i.e. the old code opened the wrong season. The
  mutation was run by reverting the single anchor line and re-running.
- Default Central host: passes.
- Real browser (Vite dev server, `javascript_tool` against the real `dateUtils`/`season` modules):
  the Chicago anchor and all five derived ranges match the values the test asserts.
- Full suite: 352 files / 5017 tests pass; typecheck, lint, and production build clean.

## Not changed here

`fetchCustomerBalance()` still falls back to `localToday()` for the customer-balance (AR) cutoff.
That is the same class of defect on a different report, outside this PR's commission scope, and is
left as a tracked follow-up rather than widened into a money PR mid-landing.
