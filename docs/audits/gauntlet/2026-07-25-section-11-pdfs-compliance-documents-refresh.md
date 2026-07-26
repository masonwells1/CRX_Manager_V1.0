# Section 11 Refresh — PDFs and Compliance Documents

**Date:** 2026-07-25
**Audit mode:** Read-only source, test, and local-rendering review
**Audited commit:** `25363345adeabb5b2b08a3772a0de3f0edcb3952` (`origin/main` at audit start)
**Verdict:** **SOLID WITH FOLLOW-UPS** — no confirmed PDF or compliance-document defect was found in this refresh. Two automated-coverage gaps and one blocked real-output proof remain.

## Scope and exclusions

This refresh covers invoice PDFs, the WPS pre-application notice, the Chemical Application Report, the shared report PDF renderer, their required-field behavior, and their narrow automated output tests.

It does not change source, generated artifacts, migrations, live data, or production. In particular, it does not touch Supplier Pricing/Product files, shared types, Phase 3 artifacts, gauntlet tracker files, manual current-state/known-issues files, migration history, smoke registry, or the app workflow map.

## Result summary

| Category | Count | Result |
|---|---:|---|
| Confirmed defects | 0 | None proven. |
| Coverage gaps | 2 | Directly evidenced below; neither proves broken output. |
| Blocked real-output proof | 1 | A logged-in browser download against a safe record was not available in this read-only local audit. |

## What changed since the prior Section 11 result

The June 17 consolidated gauntlet carried MED-5 because `src/lib/wpsNoticePdf.test.ts` did not exist. That is now closed: commit `c4cfd172` added the dedicated test, and it is present at this audited commit. The old WPS-test-gap finding must not be carried forward as an open defect.

The current WPS output test has 16 cases. It asserts the WPS title and 40 CFR citation, required REI/posting/retention language, the non-substitute label callout, customer/applicator/job identity, EPA number, signal word, rate, REI, PHI, missing-value fallbacks, multiple rows, and filename behavior (`src/lib/wpsNoticePdf.test.ts:115-239`).

## Confirmed current behavior

### Invoices

- `generateInvoicePdf` has narrow unit coverage for all three layouts (field application, chemical sale, and misc. charge), current and legacy printing, write-off reconciliation, and optional PO/terms fields (`src/lib/invoicePdf.test.ts:116-340`, `434-515`).
- The list-print data builder re-fetches invoice-level billing fields omitted from lightweight list rows and preserves caller-supplied/explicitly-cleared values (`src/lib/buildInvoicePdfDataFromRow.test.ts:85-180`). This protects the prior silent omission class for discount, terms, PO reference, due date, and notes.

### WPS pre-application notice

- The generator includes treated-area data and product EPA registration, signal word, rate, REI, and PHI; absent label values are displayed as label-directed fallbacks rather than invented values (`src/lib/wpsNoticePdf.ts:132-146`). It also contains the stated WPS notice and retention language (`src/lib/wpsNoticePdf.ts:165-185`).
- The Job Detail action refuses to print while the form is dirty, refuses failed product-label lookups, and refuses a job whose selected product has no resolved label row (`src/pages/JobDetail.tsx:815-893`).

### Chemical Application Report and shared reports

- The compliance report’s output test verifies job/customer/applicator/field identity and EPA/rate/total/gal-or-lb/REI/PHI cells, including safe dash fallbacks and download naming (`src/lib/chemicalApplicationReportPdf.test.ts:85-143`). Its pure data test also protects rate-unit formatting, product preservation, totals, and absent-value rendering (`src/lib/chemicalApplicationReportData.test.ts:49-178`).
- The Job Detail compliance path refuses to create the Chemical Application Report when product-label or billed-customer resolution is incomplete (`src/pages/JobDetail.tsx:910-950`, `1096-1115`).
- The shared report renderer has output tests for headers, data rows, empty reports, formatting, totals, footer notes, wide-column wrapping, and filenames (`src/lib/reportPdf.test.ts:92-300`).

## Coverage gaps — not confirmed defects

### COV-11-1 — WPS Job Detail gate has no component-level regression test (MED)

**Evidence:** `src/lib/wpsNoticePdf.test.ts` checks generator output and `src/lib/jobSaveHelpers.test.ts` checks only the pure dirty-form predicate. The actual Job Detail handler performs the label query and aborts on a query error or missing selected-product row (`src/pages/JobDetail.tsx:815-893`), but no `src/pages/JobDetail*.test.*` file exists in this checkout.

**Risk:** A later edit could accidentally bypass the dirty-record, failed-query, or missing-label abort without failing the existing WPS PDF unit test.

**Prevention:** Add a focused mocked Job Detail action test that proves no PDF/stamp is attempted for each abort condition and that a resolved path invokes the generator once. This is a future test recommendation, not a finding of current broken behavior.

### COV-11-2 — Four specialized PDF generators have no matching direct output test (MED)

**Evidence:** The current `src/lib/*Pdf.ts` inventory has direct same-basename tests for 13 of 17 generators. The four exceptions are `chemicalSummaryReportPdf.ts`, `invoiceSummaryPdf.ts`, `masterMixSummaryPdf.ts`, and `projectedUseReportPdf.ts`; no matching `*.test.ts` file exists for any of them. This is a file-presence coverage observation, not a claim that their output is incorrect.

**Risk:** Changes to one of these report layouts can regress its generated rows, fallbacks, pagination, or filename without a direct renderer assertion.

**Prevention:** Add small jsPDF/autoTable-mocked tests per generator, following the existing WPS, Chemical Application Report, and shared-report patterns. Prioritize the chemical-facing summary and projected-use documents if a report-printing change is planned.

## Blocked real-output proof

### BLOCKED-11-1 — No authenticated browser/download fixture was used

The 112 focused tests use mocked jsPDF/autoTable calls; they prove the generators receive and render the asserted text/table cells but do not inspect a binary PDF in a browser viewer. This audit did not use a logged-in staging or production record because the lane is read-only and no safe authenticated fixture was supplied. Therefore, visual pagination, download behavior, and runtime data retrieval in the real UI remain unproven here.

This is also not an independent legal certification of the WPS document. The review confirms the app’s documented required-field and fallback behavior only.

## Verification evidence

- Refreshed Graphify at audited commit `25363345`; `graphify-out/GRAPH_REPORT.md` records that commit. Queries used: `graphify explain "wpsNoticePdf"`, `graphify affected "generateWpsNoticePdf" --depth 3`, and `graphify query "what connects invoices, WPS notices, PDF output, and compliance reports?" --budget 1200`. The resulting Job Detail and WPS-test edges were confirmed in current source above.
- Installed the locked local dependencies with `npm ci` because this isolated worktree initially had no `vitest` binary.
- Passed: `npm run test -- src/lib/wpsNoticePdf.test.ts src/lib/jobSaveHelpers.test.ts src/lib/chemicalApplicationReportPdf.test.ts src/lib/chemicalApplicationReportData.test.ts src/lib/invoicePdf.test.ts src/lib/buildInvoicePdfDataFromRow.test.ts src/lib/reportPdf.test.ts`.
  - Result: **7 files passed, 112 tests passed**.
- Ran `git diff --check` before writing this report; no whitespace error was reported. A final `git diff --check` is required after staging the report.

## Recommended next step

Keep the two coverage gaps as follow-up test work. Before any compliance-PDF change is merged, run a safe authenticated browser download/visual check in the approved non-production environment in addition to the focused unit suite.
