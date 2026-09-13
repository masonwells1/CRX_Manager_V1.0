## 2026-09-04 - a FIFTH invoice-date default, plus the stale records shipping beside it

Round-4 fixes on PR #599, from two adversarial Opus reviews Mason commissioned after asking
"make sure you are correct". Both reviewers independently found the same missed site. Worth
recording that three automated reviewers (CodeRabbit, the Codex GitHub App twice) and the author all
missed it, and that the one request which would have caught it — a Codex re-review explicitly asked
to "confirm I did not miss a fifth site" — was the request that hit the usage limit and was then
waved off as redundant.

### The fifth site (the only one of the five that can pick a wrong RATE)

`src/pages/FieldAppSplitInvoiceEditor.tsx:214` still defaulted its invoice date with `localToday()`
— the browser's calendar date — and sends it unconditionally at `:712` as `p_invoice.invoice_date`
to `save_field_app_split_invoice`. That is the very body this PR held up as the correct model:
`_save_field_app_split_invoice_impl` sets
`v_season := COALESCE(v_job.season, compute_season(COALESCE(payload invoice_date, chicago_today)))`
and then uses `v_season` for BOTH the `customer_application_rates` rate lookup AND the invoice's
season stamp. A source job is optional, so on the common path the client-supplied date alone decides
the season — and therefore the price.

Failure: a salesman in Denver at 23:30 on 2026-09-30 (00:30 Chicago on 2026-10-01) sends
`2026-09-30`, so the invoice is charged the season-2026 per-acre rate and lands on the 2026 year-end
statement while the business day is season 2027. It fails the other way too, from any browser east
of Chicago at 19:30 on 2026-09-30.

The comment above that line was the tell: *"Local date (not toISOString, which rolls to tomorrow
after ~6-7 PM Central)"*. This page had received exactly the `toISOString()` -> `localToday()`
half-fix that the round-3 review rejected as insufficient on the other two pages. Now
`todayInBusinessTz()`.

**Reachability, checked read-only against live rather than trusted from a six-week-old doc:**
`app_settings.per_line_split_billing_enabled` is `true` in production, but `field_app_billing_sets`,
`split_invoice_provenance`, `split_invoice_creation_claims` and `split_invoice_mutation_claims` all
hold **0 rows**. So the page is live and reachable from the sidebar but has never been used — a real
bug, not an actively firing one.

**The sweep is now exhaustive**, stated as two checkable claims. (An earlier draft of this file
conflated them into one wrong sentence — it called PDF builders "save payloads" and omitted the one
site that is actually a clock-derived default. Corrected after a second review caught it.)

*Five clock-derived invoice-date DEFAULTS, all now `todayInBusinessTz()`:*
`FieldApplicationInvoice.tsx:228` (initial `transactionDate`) and `:2043` (cleared-input fallback
for the PDF due-date base); `InvoiceDetail.tsx:141` (new-invoice `invoice_date`) and `:1256` (PDF
fallback); `FieldAppSplitInvoiceEditor.tsx:214` (initial `invoiceDate`).

*Three sites that put `invoice_date` into a SAVE payload,* each fed by one of the above:
`FieldApplicationInvoice.tsx:1528` (from `transactionDate`), `FieldAppSplitInvoiceEditor.tsx:712`
(from `invoiceDate`), `InvoiceDetail.tsx:754` (from `invoice.invoice_date`, initialised at `:141`).
`FieldApplicationInvoice.tsx:2003` and `InvoiceDetail.tsx:1256` are PDF data builders, not saves.

Every other `invoice_date` in `src/` is a read of a database row, a type declaration, or a test
fixture; no sixth clock-derived default exists.

### CI coverage for the boundary that actually matters

`src/lib/dateUtils.test.ts` had four cases and covered **neither** the October 1 season boundary nor
either DST transition — the boundary evidence lived only in ad-hoc runs and a Docker-gated smoke
script, neither of which runs in CI. Added 7 cases (11 total): both sides of the Oct 1 boundary, the
exact Central-midnight roll, both 2026 DST transitions, the CDT-vs-CST offset at a fixed UTC hour,
and zero-padding.

Mutation-tested rather than assumed, because a green test proves nothing until it has been seen to
fail:

| mutant | result |
|---|---|
| `BUSINESS_TIMEZONE` -> `'UTC'` | **6 of 11 fail** |
| `BUSINESS_TIMEZONE` -> `'Etc/GMT+6'` (hardcoded -6, no DST) | **4 of 11 fail**, including the fall-back DST case |

**Honest limitation, and a correction.** A first draft of this table claimed the offset mutant killed
"both DST cases". It does not: the **spring-forward** test is killed by neither mutant. It asserts
that the calendar date does not move across a 02:00 local transition, which is true under any fixed
offset too, so it is a regression guard rather than a discriminating one. It is kept for that
purpose and is now labelled as such rather than credited with more than it does.

The same review also caught the **fall-back test not straddling its own transition**: it asserted
`05:59:59Z`/`06:00:00Z`, but Chicago falls back at 02:00 CDT = **07:00Z**, so both instants sat on
the CDT side and crossed nothing. Corrected to `06:59:59Z`/`07:00:00Z` (the repeated hour), plus
`04:59:59Z`/`05:00:00Z` to pin the midnight roll on the 25-hour day. That corrected test is one of
the four the offset mutant now kills — before the fix it was dead weight that read as coverage.

Verified TZ-independent, since CI runners are UTC and this machine is on Chicago time: 11/11 pass
under the default clock and under `TZ=UTC` (confirmed effective — vitest's own start stamp shifted
14:00 -> 19:00). The helper was restored to `America/Chicago` and re-verified green afterwards.

### Records that were shipping false

All of these described an **already-applied production migration** as pending, or described the
shipped frontend as using a helper it no longer uses:

- `docs/changelog.d/2026-09-04-invoice-season-follows-invoice-date.md` - `:199` stated flatly "The
  migration remains NOT APPLIED" (applied 15:22 UTC that day); `:174-176` and `:180` described the
  shipped fix as `localToday()`.
- `docs/reference/migration-history.md` row 912 - same stale `localToday()` sentence, in the
  authoritative record of what shipped alongside an applied migration.
- `docs/reference/migration-history.md:7` - the header block instructs readers to trust it
  exclusively ("do not treat any older dated block as the latest") while itself being **two applies
  stale** (993 rows / `20260903150000`). Replaced with a fresh read-only capture: **998 rows**,
  `max(version)` `20260904152221`, effective ordering high-water `20260904180000`. The old block is
  demoted to "superseded, kept for provenance" rather than deleted.
- `docs/manual/KNOWN_ISSUES.md:315` - "FIXED IN CODE 2026-09-04, MIGRATION PENDING LIVE APPLY",
  contradicting its own "(a) CLOSED ... applied live" 16 lines above. `:278`'s heading carried the
  same stale "MIGRATION PENDING LIVE APPLY".

`npm run check:docs` passes on all of these both before and after — it verifies counts and freshness
stamps, not prose. Its green never covered any of this.

### Also corrected

- `src/pages/FieldApplicationInvoice.tsx:2043` - a comment claiming a cleared date input "falls back
  to today [because] the server stamps invoice_date with the America/Chicago business date", which
  contradicted the comment this same PR wrote 1800 lines above it. The input has no `required` and
  no blank guard, so an empty box sends `invoice_date: ''`; `''` is not SQL NULL, so the `COALESCE`
  never fires and the `::date` cast raises. Fail-closed, but an error, not a Chicago default.
- `docs/manual/KNOWN_ISSUES.md` - new note that client-side season READS (`src/utils/season.ts:14`
  and six report defaults) still follow the browser clock. Reporting filters only, nothing stored;
  tracked so the invoice-date sweep is not mistaken for a whole-app one.

### Known and deliberately not changed

`BlendTicketDetail.test.tsx:85`, `OrderDetail.test.tsx:84` and `QuoteBuilder.test.tsx:190` each
replace `../lib/dateUtils` wholesale without `todayInBusinessTz`. They pass today because their
component trees never reach it, but any future import fails with the same "No export is defined"
that cost 31 tests in this PR. `JobDetail.billingHazard.test.tsx:72` uses the
`async (orig) => ({ ...actual })` spread form and is immune - that is the pattern the other three
should adopt when someone next touches them.
