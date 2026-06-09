# Phase 7 — Reports, PDFs, and Exports

**Date:** 2026-05-04
**Auditor:** Claude (Opus 4.7, 1M context)
**Scope:** Read-only. All paths/lines verified against the working tree.
**Mantra:** Documents are the customer-facing face of the business. A wrong PDF is a relationship and revenue risk.

---

## Plain-English Summary

Most of the documents Mason needs already exist and look professional: invoices have three branded layouts, statements come in two modes with a tear-off remittance stub, deliveries have receipts with embedded signatures, and there are PDFs for quotes, pick lists, order summaries, receiving receipts, load sheets, and year-end customer summaries. Statements and invoices both have working "Email" buttons that go through the locked-down Edge Function with PDF attachments and a real-time audit log, and that path is already hardened against arbitrary-recipient abuse.

There are still four problems that a customer would notice:

1. **The "Print" button on the field-application invoice screen is a do-nothing TODO** (`src/pages/FieldApplicationInvoice.tsx:522`). This is the single most product-shaped piece of the app for Mason — a sprayer goes to the field, comes back with a blend ticket, the office turns it into a multi-grower split invoice, and then the print button doesn't print. Field-app invoices CAN be printed today by routing through the regular Invoices page, but a user looking at the field-app screen has no way to know that.
2. **The company address on the PDF letterhead is inconsistent.** Half the documents say "Martinsville, IL" and the other half say "Robinson, IL". A grower who gets an invoice from Martinsville and a delivery slip from Robinson will reasonably wonder whether they're dealing with the same company.
3. **There is no sprayer / applicator print packet.** Job, Blend Ticket, and Application Record screens all lack a Print/PDF button. The sprayer cab still has nothing to take to the field that shows the product list, EPA numbers, rates, and field map for the day.
4. **PO, Job, Blend Ticket, and Application Record have no PDF at all.** The Purchase Order Detail page only knows how to print a *receiving* receipt — it cannot send a PO PDF to a vendor. Blend Tickets and Jobs have no print path either.

Beyond those, there are smaller drift and accuracy issues — `Reports.tsx` claims "Generic CSV/PDF export" but only ever calls CSV (PDF was never wired), the load-sheet PDF generator (`src/lib/loadSheetPdf.ts`) is built and tested but only callable from `Deliveries.tsx` (not from a route or a multi-stop dispatch view), and `Compliance.tsx` imports `downloadReportPdf` but never calls it.

The good news: the underlying generator code is well-organized, branded, type-safe, and fully unit-tested. Closing the gaps is mostly a wiring exercise, not an architecture exercise.

---

## Evidence Reviewed

| File | Lines | Purpose |
|---|---|---|
| `CLAUDE.md` | full | Schema gotchas (extended_cents, balance_cents, total_paid dropped) |
| `docs/audits/2026-05-04-phase-0-current-state-audit.md` | full | Baseline + the known TODO flag |
| `src/lib/invoicePdf.ts` | 1–816 | 3 invoice layouts |
| `src/lib/statementPdf.ts` | 1–822 | summary + detailed statement, remittance stub, batch |
| `src/lib/deliveryPdf.ts` | 1–290 | delivery receipt with signature image |
| `src/lib/quotePdf.ts` | 1–338 | quote PDF + batch |
| `src/lib/loadSheetPdf.ts` | 1–310 | load sheet (product summary + per-stop pages) |
| `src/lib/orderPickListPdf.ts` | 1–281 | pick list with shortage warnings |
| `src/lib/orderSummaryPdf.ts` | 1–222 | customer-facing order summary (no cost/margin) |
| `src/lib/receivingPdf.ts` | 1–245 | receiving receipt |
| `src/lib/yearEndSummaryPdf.ts` | 1–640 | year-end season summary |
| `src/lib/reportPdf.ts` | 1–158 | generic tabular report PDF |
| `src/lib/csvExport.ts` | 1–65 | CSV utility (`exportToCSV`, `fmtCSV`, `fmtDateCSV`) |
| `src/lib/emailService.ts` | 1–126 | Resend Edge wrapper, `pdfToBase64`, `buildEmailHtml` |
| `supabase/functions/send-email/index.ts` | 1–362 | hardened email Edge Function |
| `src/pages/InvoiceDetail.tsx` | scanned | Print/Email handlers (17–18, 110–126, 542, 608–673, 755–770, 1314–1320) |
| `src/pages/Invoices.tsx` | scanned | Batch print, batch email, CSV (14, 18, 84–89, 215–367, 528–578, 707–713) |
| `src/pages/FieldApplicationInvoice.tsx` | 490–550 | **TODO Print button at 522** |
| `src/pages/OrderDetail.tsx` | 8–32, 110–340, 830–850 | Order summary + pick list print |
| `src/pages/DeliveryDetail.tsx` | scanned | delivery PDF + email (21, 23, 858–945, 1525, 1560) |
| `src/pages/PurchaseOrderDetail.tsx` | scanned | only receiving PDF (285, 321) — no PO print |
| `src/pages/Reports.tsx` | full | 5 categories; CSV-only export despite "PDF" comment at 527 |
| `src/pages/SalesReports.tsx` | 1–150 + grep | uses `downloadReportPdf` at lines 293 and 312 |
| `src/pages/ARaging.tsx` | scanned | statement print/email + CSV (18–22, 264–270, 376–675, 932–998) |
| `src/pages/Compliance.tsx` | full | RUP CSV + Field/FSA CSV. `downloadReportPdf` imported but never used (line 11) |
| `src/pages/JobDetail.tsx` | 1–50 + grep | **no Print/PDF anywhere** |
| `src/pages/IntegrityReport.tsx` | grep | no Print/PDF |

---

## Documents Inventory

| # | Document | Source file | Status | Where it's wired up |
|---|---|---|---|---|
| 1 | Invoice — field application | `src/lib/invoicePdf.ts:348–564` | Working | InvoiceDetail Print, Invoices batch print |
| 2 | Invoice — chemical sale | `src/lib/invoicePdf.ts:568–707` | Working | same |
| 3 | Invoice — misc charge | `src/lib/invoicePdf.ts:711–748` | Working | same |
| 4 | Invoice batch download | `src/lib/invoicePdf.ts:762–815` | Quirky — saves N separate files | `Invoices.tsx:215–340` |
| 5 | Statement — summary mode | `src/lib/statementPdf.ts:228–295` | Working | ARaging Print/Email/Batch (376–675) |
| 6 | Statement — detailed mode | `src/lib/statementPdf.ts:299–483` | Working | same |
| 7 | Statement remittance stub | `src/lib/statementPdf.ts:646–763` | Working | rendered on every statement |
| 8 | Delivery receipt (with signature) | `src/lib/deliveryPdf.ts:51–244` | Working | DeliveryDetail line 1525, batch via `Deliveries.tsx` |
| 9 | Load sheet (multi-stop pick + per-stop) | `src/lib/loadSheetPdf.ts:60–309` | **Partial — only callable from Deliveries.tsx**; no Dispatch Board entry | `Deliveries.tsx` |
| 10 | Quote PDF | `src/lib/quotePdf.ts:89–337` | Working | QuoteBuilder, Quotes page |
| 11 | Order Summary PDF (no cost/margin) | `src/lib/orderSummaryPdf.ts:48–222` | Working | OrderDetail "Print Summary" |
| 12 | Order Pick List PDF (shortage warnings) | `src/lib/orderPickListPdf.ts:48–280` | Working | OrderDetail "Print Pick List" |
| 13 | Receiving Receipt | `src/lib/receivingPdf.ts:50–245` | Working | QuickReceive, PurchaseOrderDetail receiving history |
| 14 | Year-End / Season Summary | `src/lib/yearEndSummaryPdf.ts:70–640` | Working | Reports → Year-End Summaries |
| 15 | Generic Report PDF | `src/lib/reportPdf.ts:40–157` | **Partial — only used by SalesReports**; imported but unused in Compliance | SalesReports lines 293/312 |
| 16 | **Field Application Invoice "Print"** | `src/pages/FieldApplicationInvoice.tsx:522` | **MISSING — dead TODO** | n/a |
| 17 | **Sprayer / applicator field packet** | — | **MISSING** | n/a |
| 18 | **Purchase Order PDF (vendor outbound)** | — | **MISSING** | n/a |
| 19 | **Job sheet / work order print** | — | **MISSING** | n/a |
| 20 | **Blend ticket print** | — | **MISSING** | n/a |
| 21 | **Compliance / RUP register PDF** | — | **MISSING — CSV only** | Compliance.tsx 666–696 |
| 22 | Reports CSV-only (P&L, gross sales, customer balance, commissions, chemical history, inventory cost, price list) | `Reports.tsx:489–601` | CSV works; no PDF despite "CSV/PDF" comment at 527 | n/a |
| 23 | AR Aging CSV | `ARaging.tsx:799–814` | Working | n/a |
| 24 | Customer transaction CSV | `ARaging.tsx:984–998` | Working | n/a |
| 25 | Field listing / FSA CSV | `Compliance.tsx:780–805` | Working | n/a |
| 26 | RUP sales register CSV | `Compliance.tsx:666–696` | Working | n/a |
| 27 | Email path: invoice + PDF attachment | `InvoiceDetail.tsx:628–673` → `emailService.ts:41–67` → `send-email/index.ts:80–360` | Working, JWT-validated, recipient = customer email, 50/hr rate limit | n/a |
| 28 | Email path: statement + PDF attachment | `ARaging.tsx:516–675` | Working, single + batch | n/a |
| 29 | Email path: delivery completion | `DeliveryDetail.tsx:858–945` | Working, opt-out checkbox | n/a |

---

## Findings

### P7-1 — Field Application Invoice "Print" is a dead TODO

**Business risk:** HIGH. Field application is the workflow Mason cares most about. After a sprayer comes back from the field, the office opens the field-app invoice screen, posts it, and then can't print from that screen. They must navigate away to the regular Invoices list to print. A new staff member won't discover that workaround on their own and will tell a customer "we'll mail it later" that day.

**Evidence:**
- `src/pages/FieldApplicationInvoice.tsx:522` —
  ```tsx
  <Button variant="secondary" size="sm" icon={<Printer className="w-4 h-4" />} onClick={() => { /* TODO: print */ }}>
    Print
  </Button>
  ```
- This button is rendered for any non-new invoice (`!isNew`, line 521), so it's visible on every saved field-app invoice.

**Fix direction:** Wire the existing `downloadInvoicePdf()` from `src/lib/invoicePdf.ts:752`. The data shape (`InvoicePdfData` with shares + per-acre + EPA) is already exactly what this screen has in state. Match the pattern at `InvoiceDetail.tsx:608–625` — including the `InvoicePrintDialog` so the user can toggle shares / $ per acre / EPA columns on the way out. Bonus: when `invoiceGroupId` is set, allow a "Print group (N)" that batches all sibling invoices, reusing `generateBatchInvoicePdf()` at `invoicePdf.ts:762`.

**Likely files:** `src/pages/FieldApplicationInvoice.tsx`; reuse `src/components/invoices/InvoicePrintDialog.tsx`.

---

### P7-2 — Company address on letterhead is inconsistent (Martinsville vs Robinson)

**Business risk:** HIGH. Customer-facing brand. A grower receiving a Martinsville invoice and a Robinson delivery ticket has reasonable cause to question whether one is real, especially since invoices include a remit-to address (`PO Box 123, Martinsville, IL 62442`, `statementPdf.ts:48`). Two addresses on two pieces of mail to the same farm is worse than one wrong address everywhere.

**Evidence — Martinsville (the "remit-to" reality):**
- `src/lib/invoicePdf.ts:158` — `'Agricultural Input Solutions  •  Martinsville, IL  •  618-843-0413'`
- `src/lib/statementPdf.ts:47` — same tagline
- `src/lib/statementPdf.ts:48` — `COMPANY_REMIT_ADDRESS = 'Crop RX Solutions, Inc.\nPO Box 123\nMartinsville, IL 62442'`
- `src/lib/yearEndSummaryPdf.ts:38` — same tagline

**Evidence — Robinson (everywhere else):**
- `src/lib/deliveryPdf.ts:243` — `'Crop RX Solutions  •  Robinson, IL  •  Thank you for your business!'`
- `src/lib/loadSheetPdf.ts:53` — Robinson, IL footer
- `src/lib/orderSummaryPdf.ts:179` — Robinson, IL
- `src/lib/orderPickListPdf.ts:238` — Robinson, IL (Internal Use Only)
- `src/lib/quotePdf.ts:107` — Robinson, IL header
- `src/lib/receivingPdf.ts:200` — Robinson, IL
- `src/lib/reportPdf.ts:62` — Robinson, IL

**Fix direction:** Pick one. Mason needs to confirm whether the business mailing address today is Martinsville or Robinson (the remit-to in `statementPdf.ts:48` is the strongest signal — that's where customers are told to send checks). Then move the strings into one shared module (`src/lib/companyInfo.ts` with `COMPANY_NAME`, `COMPANY_ADDRESS`, `COMPANY_TAGLINE`, `COMPANY_PHONE`, `REMIT_TO_ADDRESS`, `WEBSITE`) and import everywhere. Same module should hold the email-template footer text used in `emailService.ts:82–124` so HTML emails match the PDFs.

**Likely files:** new `src/lib/companyInfo.ts`; update all 9 PDF generators + `emailService.ts:buildEmailHtml`.

---

### P7-3 — No sprayer / applicator field packet exists

**Business risk:** HIGH for safety and recordkeeping. When a sprayer leaves the shop they need a paper they can drop on the truck dash that shows: customer, fields, total acres, the blend (every product, EPA registration, signal word, rate per acre, total to mix), any RUP product flagged, the customer's restricted-use cert number if applicable, and a signature line for the applicator and the customer. Today the Job Detail page (`src/pages/JobDetail.tsx:1–50` + grep) has no Print/PDF button. Blend Ticket Detail likewise has none. Application Records has only "Export CSV" (`ApplicationRecords.tsx:264`).

This is also a **state regulatory liability** in IL — applicators are expected to keep a written record of restricted-use applications and the field packet is the natural source-of-truth for that.

**Evidence:**
- `src/pages/JobDetail.tsx` — grep for `Print|Pdf|print|sprayer|JobSheet|packet` returns no matches
- `src/pages/BlendTicketDetail.tsx` — grep for `Print|Pdf|print` returns no matches
- `src/pages/ApplicationRecords.tsx:11,122,264` — only `exportToCSV`, no PDF
- `src/lib/yearEndSummaryPdf.ts` is the closest relative but it's an annual customer-facing recap, not a field packet

**Fix direction:** Build `src/lib/fieldPacketPdf.ts` that takes a job_id (or a blend_ticket_id, or a posted application_record id), and produces a portrait packet:
- Header: customer, field name(s), county, total acres, applicator name, vehicle, scheduled date
- Product table: product, EPA reg, signal word badge (Caution/Warning/Danger), rate per acre, total to mix, units, RUP flag
- Customer license info if any product is RUP (cross-reference `applicator_licenses`)
- Notes / mix order / re-entry interval / pre-harvest interval (PHI/REI) if those are tracked on the product row
- Two signature lines (applicator + customer/representative)
Wire a Print button on JobDetail, BlendTicketDetail, and ApplicationRecords. The data is already in those screens.

**Likely files:** new `src/lib/fieldPacketPdf.ts`; updates to `JobDetail.tsx`, `BlendTicketDetail.tsx`, `ApplicationRecords.tsx`.

---

### P7-4 — Purchase Order has no PDF (cannot be sent to vendor from the app)

**Business risk:** MEDIUM-HIGH. POs are an outbound vendor document. Today the only PDF the PurchaseOrderDetail screen knows how to make is a *receiving* receipt (`src/pages/PurchaseOrderDetail.tsx:285,321`). Mason cannot click "Email this PO to UPL" — he has to copy the line items into Outlook by hand, which is exactly the kind of friction this app was supposed to remove.

**Evidence:**
- `src/pages/PurchaseOrderDetail.tsx` — grep matches only `downloadReceivingPdf` (twice). No PO PDF, no email button.
- `send-email/index.ts:48–57` — `email_type` allowlist has `order_confirmed` (customer-facing) but no `purchase_order` type. The Edge Function would also need to allow vendor recipients, since today it enforces "to" matches `customers.email` (lines 154–174). Vendors are in a different table.

**Fix direction:** Build `src/lib/purchaseOrderPdf.ts` (model after `quotePdf.ts`); add a "Print PO" and "Email PO" button on `PurchaseOrderDetail.tsx`. For email, extend the Edge Function to support `purchase_order` type with vendor-email validation against `vendors.email` (currently `customer_id` is the only option in `send-email/index.ts:153–174`). This is a non-trivial server-side change — flag for explicit Mason approval before writing the migration / Edge change.

**Likely files:** new `src/lib/purchaseOrderPdf.ts`, updates to `PurchaseOrderDetail.tsx`, `supabase/functions/send-email/index.ts`, `emailService.ts` types.

---

### P7-5 — `Reports.tsx` advertises CSV/PDF but only does CSV

**Business risk:** LOW-MEDIUM. The comment at `src/pages/Reports.tsx:527` says `// ─── Generic CSV/PDF export for financial/operational ───`, and the page never wires a PDF export button. SalesReports.tsx already does both (`SalesReports.tsx:11, 251, 266, 293, 312`), proving the wiring is easy. P&L, gross sales, customer balance, commission balance, chemical history, inventory cost, price list, and posted applications would all benefit from a printable PDF version (Mason hands a PDF P&L to his accountant, not a CSV).

**Evidence:**
- `src/pages/Reports.tsx:527` — comment claims PDF
- `src/pages/Reports.tsx:806–809` — only one button: `Export CSV`
- `src/pages/SalesReports.tsx:11,293,312` — proof that `downloadReportPdf` works fine for tabular reports

**Fix direction:** Add a second button ("Export PDF") next to "Export CSV" in `dateFilterBar()` (line 754). Reuse `downloadReportPdf` from `src/lib/reportPdf.ts:151`. Map each tab's columns + data exactly the way the CSV export does. Same column definitions can be shared between the CSV and PDF passes.

**Likely files:** `src/pages/Reports.tsx`.

---

### P7-6 — Compliance: RUP Sales Register and Field/FSA listing have no PDF (and dead import)

**Business risk:** MEDIUM. State agencies prefer PDF for compliance submissions. The RUP Sales Register is the document IL Department of Agriculture would ask for in an audit; today Mason can only export it as CSV (`Compliance.tsx:666–696`).

Also worth noting: `Compliance.tsx:11` imports `downloadReportPdf, fmtCurrency` from `reportPdf.ts` but `downloadReportPdf` is never called anywhere in the file (verified via grep — the symbol appears 0 times in the body). That's a dead import, possibly a half-finished feature from an earlier sprint.

**Evidence:**
- `src/pages/Compliance.tsx:11` — `import { downloadReportPdf, fmtCurrency } from '../lib/reportPdf';`
- grep on `Compliance.tsx` for `downloadReportPdf` — only the import line; never called.
- `Compliance.tsx:666–696` — the RUP CSV export (no PDF sibling)
- `Compliance.tsx:780–805` — the FSA CSV export (no PDF sibling)

**Fix direction:** Either finish the PDF wiring (one button next to each "Export CSV") or remove the dead imports. Finishing is preferred — Mason has explicitly mentioned regulatory reporting in past conversations.

**Likely files:** `src/pages/Compliance.tsx`.

---

### P7-7 — Load Sheet PDF is built but only invokable from one screen

**Business risk:** MEDIUM. `src/lib/loadSheetPdf.ts:60–309` aggregates all stops for a day, shows a per-driver "Total to Load" page, then prints one signature page per stop — exactly what a delivery driver wants in the cab. Today only `Deliveries.tsx` calls it; the **Dispatch Board** (`/dispatch`, the screen a dispatcher actually sits on) has no "Print today's load sheet" button at all.

**Evidence:**
- grep `generateLoadSheetPdf|loadSheetPdf|LoadSheet` finds only `src/pages/Deliveries.tsx` and the lib + tests.

**Fix direction:** Add a "Print Load Sheet" button to `DispatchBoard.tsx` filtered by selected driver and date. Same data shape as `Deliveries.tsx` already builds.

**Likely files:** `src/pages/DispatchBoard.tsx`.

---

### P7-8 — `generateBatchInvoicePdf` saves N separate files instead of one combined PDF

**Business risk:** MEDIUM (UX). Today selecting 12 invoices and clicking "Print Selected" downloads 12 separate `.pdf` files using a `requestAnimationFrame` loop (`src/lib/invoicePdf.ts:780–814`). Mason then has to merge them by hand, or fight the printer. By comparison, `deliveryPdf.ts:264–289`, `receivingPdf.ts:221–243`, `orderPickListPdf.ts:259–280`, and `orderSummaryPdf.ts:200–221` all *do* combine into one file via `doc.addPage()`. Statements (`statementPdf.ts:811–821`) have the same N-file problem, with a 200ms `setTimeout` between downloads.

The author's comment at `invoicePdf.ts:758–760` and `statementPdf.ts:794–805` explicitly says "jsPDF doesn't support page-level merging" — but the other generators already prove it does, when each generator can render into a *shared* `doc` (the trick is to extract a `renderInvoicePage(doc, data, autoTable)` like `deliveryPdf.ts:51–244` did, then call it in a loop).

**Evidence:**
- `src/lib/invoicePdf.ts:758–814` — comment says merging isn't possible; loop saves N files
- `src/lib/statementPdf.ts:793–821` — same pattern, 200ms delay
- `src/lib/deliveryPdf.ts:264–289` — combined-file pattern that works
- `src/lib/orderPickListPdf.ts:259–280` — combined-file pattern that works
- `src/lib/orderSummaryPdf.ts:200–221` — combined-file pattern that works

**Fix direction:** Refactor invoice + statement generators to extract a `renderXPage(doc, data, autoTable)` and have the batch wrapper call `doc.addPage()` between iterations. One file out, one print job.

**Likely files:** `src/lib/invoicePdf.ts`, `src/lib/statementPdf.ts`.

---

### P7-9 — Reports CSV: a few "cents" columns are exported as raw integers

**Business risk:** LOW-MEDIUM. CSVs handed to an accountant must be in dollars. Most exports get this right (`fmtCSV((v as number) / 100)` pattern, e.g. `Compliance.tsx:681`, `ARaging.tsx:991`), but `Reports.tsx` has a couple of places where money columns appear to come from RPCs returning whole-dollar numerics (`get_bottom_line_pnl`, `get_gross_sales_report`) and use `fmtCSV(v)` directly without `/100`. That's correct *if* the RPC truly returns dollars — but I cannot verify that without reading the SQL, and the type names (`amount`, `total_revenue`, `total_cost`, `gross_profit`) don't carry a `_cents` suffix. **This is a high-risk place for silent drift** — a future migration could change one of these RPCs to return cents, and the CSV would silently start under-reporting by 100x.

**Evidence:**
- `src/pages/Reports.tsx:530–562` — money columns formatted as `fmtCSV` without `/100`
- compare to `ARaging.tsx:991` which does `fmtCSV((Number(v) || 0) / 100)`
- compare to `Compliance.tsx:681` which does `fmtCSV((v as number) / 100)`

**Fix direction:** Confirm with the SQL definitions (`get_bottom_line_pnl`, `get_gross_sales_report`, `get_customer_balance_listing`, `get_commission_balance_report`) which units they return. If any are in cents, fix the CSV formatter; if all are in dollars, add a unit-asserting comment in `Reports.tsx` and a unit test that locks the contract.

**Likely files:** verify RPC definitions in `supabase/migrations/`; possibly `src/pages/Reports.tsx:528–601`.

---

### P7-10 — Email-template HTML doesn't reflect Mason's branding standard

**Business risk:** LOW. `emailService.ts:82–124` `buildEmailHtml()` uses `#16a34a` (Tailwind `green-600`) for the header background, but the brand color is `#28A26A` (CRX_GREEN, used in every PDF). The footer text says `croprxsolutions.app` (the app URL) rather than the customer-facing `croprxsolutions.com` (used in `quotePdf.ts:290`). Customers will associate the email and the PDF as a single piece — they should match.

**Evidence:**
- `src/lib/emailService.ts:96` — `background-color:#16a34a` (Tailwind green-600 ≠ CRX brand green)
- `src/lib/emailService.ts:112` — `croprxsolutions.app` (app domain)
- `src/lib/quotePdf.ts:290` — `www.croprxsolutions.com` (marketing domain)
- `src/lib/invoicePdf.ts:22` — `CRX_GREEN: [40, 162, 106]` = `#28A26A`

**Fix direction:** When you make the `companyInfo.ts` shared module (P7-2), pull brand color and domains in there too and reference from `buildEmailHtml`.

**Likely files:** `src/lib/emailService.ts`.

---

### P7-11 — No print preview anywhere — user has to commit to a download

**Business risk:** LOW-MEDIUM. There is no on-screen preview before clicking Print. `InvoicePrintDialog` only exposes 3 toggles (shares, $/acre, EPA — `src/components/invoices/InvoicePrintDialog.tsx:32–34`); the user clicks Print and the file is on disk. For invoices with many products this means generating, opening, scrolling, deciding "no, EPA off", regenerating. The PDF generators all return a `doc` object that can do `doc.output('bloburl')` — feasible to embed in an iframe modal for preview before committing.

**Evidence:**
- `src/components/invoices/InvoicePrintDialog.tsx:32–34` — only 3 toggles
- `src/lib/invoicePdf.ts:122–344` — generator returns a `doc` instance
- No `<iframe>`-based preview anywhere in the codebase (grep confirms)

**Fix direction:** Defer. Add iframe preview only after P7-1, P7-3 are done.

**Likely files:** `src/components/invoices/InvoicePrintDialog.tsx`, `src/components/statements/StatementPrintDialog.tsx`.

---

### P7-12 — Statement remittance stub overwrites content if statement is short

**Business risk:** LOW. `statementPdf.ts:646–763` `drawRemittanceStub()` is positioned at `pageH - stubH - 15` on whatever the *current* page happens to be. The comment at lines 658–661 admits the stub will draw over content if the prior content is taller than expected ("we rely on the caller to leave space or we'll draw over content (acceptable for tear-off)"). For most customers this is fine because the transaction list is long; for a customer with one open invoice this could overlap the totals row.

**Evidence:**
- `src/lib/statementPdf.ts:656–667` — stub positioned absolutely; comment acknowledges overlap risk
- compare with the `ensureSpace()` pattern at `yearEndSummaryPdf.ts:104–111` which page-breaks gracefully

**Fix direction:** Adopt the `ensureSpace()` pattern from `yearEndSummaryPdf.ts:104–111` — if `y + stubH > pageH - margin`, `addPage()` first.

**Likely files:** `src/lib/statementPdf.ts:646–763`.

---

### P7-13 — Edge Function attachment cap may bite future "all open statements as one mail" feature

**Business risk:** LOW-MEDIUM. `send-email/index.ts:67–69` caps attachments at 5 files / 10 MB total decoded. Statements with full detailed mode + many invoices can easily exceed 1 MB each in PDF; sending statements to 12 customers sequentially is fine (each call is its own email), but a future "email me all my open statements as one mail" feature would hit the cap fast. Worth surfacing in the Mason UX before that feature ships.

**Evidence:**
- `supabase/functions/send-email/index.ts:67–69`, `225–230`

**Fix direction:** Document the cap in CLAUDE.md (Schema Gotchas section) and gate any future single-email-multi-statement feature on a UI warning.

---

### P7-14 — Page numbers in statement footer reset across batches but not single-statement page-2+

**Business risk:** LOW. `statementPdf.ts:71–84` increments `pageNum` from a closure; the count is correct for a single statement but `generateBatchStatementsPdf` (lines 795–809) only generates the first one and a TODO comment says merging is unsupported. So the "Page X" footer in a batch context is currently moot, but if the merge is ever fixed (P7-8), the page counter must reset per-customer or the second customer's first page reads "Page 5".

**Evidence:**
- `src/lib/statementPdf.ts:67–84, 795–809`

**Fix direction:** Tie to P7-8.

---

## What's Already Working

These are good and shouldn't be undone:

1. **Invoice PDF has three type-aware layouts** — field application, chemical sale, misc charge — and a working `InvoicePrintDialog` for column toggles. (`src/lib/invoicePdf.ts:262–268`)
2. **Status-color badge in invoice header** including overdue red. (`src/lib/invoicePdf.ts:168–185`)
3. **Statement two-mode design (summary + detailed) plus tear-off remittance stub** — this is professional-grade and matches what a Chemical-Man / AgVance customer expects to receive. (`src/lib/statementPdf.ts:50–224`, 646–763)
4. **Aging summary bar across the top of every statement.** (`src/lib/statementPdf.ts:174–208`)
5. **Delivery PDF embeds the captured signature image** when available, falls back to a blank line. (`src/lib/deliveryPdf.ts:205–221`)
6. **Pick list PDF highlights inventory shortages in red/amber** with a dedicated warnings section. (`src/lib/orderPickListPdf.ts:163–207`)
7. **Year-end summary is the strongest document in the app** — financial boxes, year-over-year comparison, product usage by category, acreage breakdown, invoice history with totals row, grower shares. Each section uses `ensureSpace()` to page-break gracefully. (`src/lib/yearEndSummaryPdf.ts:104–608`)
8. **Email Edge Function is genuinely hardened** — recipient must equal `customers.email`, role/email_type allowlist, drivers can only send `delivery_completed` for deliveries they're assigned to, 50/hr per-user rate limit, idempotency replay, append-only `email_log` audit, Sentry on send failures. (`supabase/functions/send-email/index.ts:80–360`)
9. **Driver-scoped email permission** — drivers can only send delivery_completed for their own assigned delivery, and the customer_id has to match. (`send-email/index.ts:177–205`)
10. **Order summary PDF deliberately omits cost/margin** — keeps internal financials internal even when a customer asks for "the order paperwork". (`src/lib/orderSummaryPdf.ts:122` comment)
11. **`exportToCSV` is small and consistent** — every page that uses it formats the same way (`fmtCSV`, `fmtDateCSV`). (`src/lib/csvExport.ts:11–47`)
12. **Receiving receipt color-codes the condition column** (good = green, damaged = red, other = amber) so a stack of receiving receipts can be triaged at a glance. (`src/lib/receivingPdf.ts:124–131`)

---

## Open Questions for Mason

These need a human answer before P7-1..P7-7 are scheduled.

1. **Address — Martinsville or Robinson?** The remit-to in the statement says PO Box 123, Martinsville, IL 62442. Half the documents say Martinsville, the other half Robinson. Which one is correct? Are both valid (one for mail, one for walk-in) and we should print both? (P7-2)
2. **Do you have a sample sprayer / applicator field packet** from a competitor (Chem-Man, AgVance, AgWorld), an old Excel template, or a paper form your dad used to use? Match-the-look is much faster than design-from-scratch. (P7-3)
3. **Do you have a sample invoice and statement** (from an old system or a peer dealer) you want me to match more closely than the current design? Particularly the line-item formatting on field-app invoices. (P7-1, P7-8)
4. **What's the exact list of state-required fields on a RUP sales record** for Illinois? The current CSV (Compliance.tsx:666–696) covers the common fields but I want to confirm before building a PDF that says "official register". (P7-6)
5. **Do you want a PO PDF that's branded to your company,** or do most of your vendors prefer a plain-text email with line items pasted in? (P7-4 — affects how much polish to put into the PO PDF)
6. **For batched invoice/statement printing, do you usually want one big PDF you can send to the print queue once,** or separate files for filing? (P7-8)
7. **How do you want to handle a sprayer that goes to 4 fields for the same grower in one day?** One field packet per field, or one packet listing all four? Affects P7-3 design.
8. **Compliance reporting frequency — annually, by season, on demand?** Affects whether the RUP-register PDF should carry a "Reporting period" header. (P7-6)

---

## Recommended Fix Order Within Phase 7

Smallest-risk-first; each step is independently shippable.

1. **P7-1 (Field App Print TODO).** 10 minutes of wiring; eliminates a bug Mason will see every day. Reuse `downloadInvoicePdf` and `InvoicePrintDialog`.
2. **P7-2 (One company-info module).** 30 minutes; eliminates a customer-perceptible inconsistency. Touches 9 PDF files but every change is mechanical.
3. **P7-5 (Reports.tsx PDF export).** 30 minutes; mirrors what `SalesReports.tsx` already does. Just add an "Export PDF" button to `dateFilterBar`.
4. **P7-6 (Compliance PDF buttons + remove dead imports).** 30 minutes. Either finish the wiring or delete the unused imports — no in-between.
5. **P7-7 (Load sheet on Dispatch Board).** 1 hour. Reuses everything in `loadSheetPdf.ts`.
6. **P7-8 (Combined batch invoice/statement files).** Half-day. Refactor to `renderXPage(doc, data, autoTable)` and call `doc.addPage()` between. Add a unit test for batch.
7. **P7-12 (Statement stub overflow).** Half-hour. Adopt `ensureSpace()` pattern.
8. **P7-9 (Reports CSV cents-vs-dollars audit).** Half-day. Read 4 SQL RPCs, add unit-test contracts, fix any formatters that drift.
9. **P7-10 (Email HTML brand match).** 15 minutes once P7-2 is done.
10. **P7-3 (Sprayer field packet).** 1–2 days, blocked on Mason providing a sample (Open Question #2). Highest business value of the remaining items.
11. **P7-4 (Purchase Order PDF + email-to-vendor).** 1–2 days, blocked on Mason approving the Edge-Function change for vendor recipients.
12. **P7-11 (Print preview iframe).** 1 day, lowest priority — only attempt after the missing documents exist.

---

*End of Phase 7. Documents are working in most of the obvious places; the gaps are in the field-application loop (P7-1, P7-3), in vendor outbound (P7-4), and in print-once/print-batched UX (P7-8).*
