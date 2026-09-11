## 2026-09-04 - invoice-date defaults follow the Chicago BUSINESS timezone, not the browser

Round-2 review fixes on PR #599, from the Codex GitHub App review of `c6bf11698`.

- **`localToday()` -> `todayInBusinessTz()` at all four invoice-date defaults** (P2, two threads).
  The first cut of this fix replaced a UTC `toISOString()` default with `localToday()`, which
  returns the *browser's* calendar date. An invoice date is a company-wide accounting fact that
  decides the season, so it must follow Crop RX's business timezone regardless of where the user
  is sitting. Sites changed:
  - `src/pages/FieldApplicationInvoice.tsx:224` - `transactionDate` initial state
  - `src/pages/FieldApplicationInvoice.tsx:2036` - cleared-input fallback for the due-date base
  - `src/pages/InvoiceDetail.tsx:137` - new-invoice `invoice_date`
  - `src/pages/InvoiceDetail.tsx:1245` - print/PDF fallback
  `todayInBusinessTz()` already existed (`src/lib/dateUtils.ts:66`, used by `MonthEndClose.tsx`);
  this reuses it rather than adding a second helper.

- **Proof, two independent runs** (not just "the tests pass"):
  - Differential run of the REAL `src/lib/dateUtils.ts` in 7 browser timezones x 2 boundary
    instants, clock pinned, TypeScript stripped by the repo's own esbuild.
    `todayInBusinessTz()` returned Chicago's business date in **14 of 14**; `localToday()` returned
    the wrong season-determining date in **5 of 14**, and it fails in BOTH directions -
    `2026-10-01T00:30:00Z` (19:30 Chicago 09-30) breaks UTC/Berlin/Auckland, while
    `2026-10-01T05:30:00Z` (00:30 Chicago 10-01) breaks Los Angeles and Denver, the realistic
    case of a salesman west of Chicago. The run self-fails as INCONCLUSIVE if the old helper never
    misbehaves, so a green result cannot come from an inert test.
  - Real pages rendered in the stub harness with the clock pinned: FieldApplicationInvoice and
    InvoiceDetail both pre-filled `2026-09-30` at `00:30Z` and `2026-10-01` at `05:30Z`, tracking
    the Chicago business day across the boundary in both directions. Console clean.
    Host timezone is `America/Chicago`, so the browser alone cannot distinguish the old helper from
    the new one - that dimension is what the differential run above covers.

- **`InvoiceDetail.test.tsx` mock updated.** The file mocks `../lib/dateUtils` wholesale, so the new
  import failed 31 tests with "No `todayInBusinessTz` export is defined". Pinned to the same date as
  the existing `localToday` stub so no existing date assertion shifts; the timezone behaviour itself
  is covered by `dateUtils.test.ts`, deliberately not by this mock.

- **NOT fixed here, newly tracked:** `preview_field_app_invoice_split` still prices from the UTC
  clock while save now prices from the invoice date (Codex P1). Verified live: the two save bodies
  carry 0 season-helper refs and 4 America/Chicago refs, the preview body 1 and 0. Display-only -
  `previewData` never reaches the save payload - but it needs a new migration (the live function has
  no date or season parameter), so it cannot be fixed in this PR's frontend scope and holding this
  PR would not un-ship it. Recorded in `docs/manual/KNOWN_ISSUES.md` with a recommended
  2026-09-30 target.
