## 2026-10-23 — Fix the four defects the readability report found (B1-B4)

The read-only readability report (`docs/audits/2026-10-23-readability-report.md`, PR #1076)
recorded four small defects. This change fixes only those four; it is not a refactor.

- **B1, delivery receipt email.** All three copies of the receipt (DeliveryDetail completion,
  DeliveryDetail resend, and the Field Mode completion in `src/lib/deliveryCompletionEmail.ts`,
  which the report did not list) now share one `buildDeliveryReceiptHtml()`
  (`src/lib/deliveryReceiptEmail.ts`), which escapes product names, the contact name and the
  "Signed by" name with the exported `escapeHtml`.
- **B2, product and customer search.** `InvoiceDetail` (Add Product), `FieldAppChemicalEntry`
  and `PaymentAllocation` now build their `.or(...)` filter with `ilikeOrPattern`, so names
  with commas such as "2,4-D" or "Smith, John" search correctly.
- **B3, invoice PDF.** `buildInvoicePdfData` now stops Print and Email with a toast when the
  `invoice_items` read fails, instead of producing a PDF with no lines.
- **B4, delivery edit carry-over.** `deliveries/:id` now renders `DeliveryDetailRoute`, which
  keys `DeliveryDetail` by the delivery id (as `JobDetailRoute` does). The page's own reset
  effects are kept. `src/routeBaseline.json` changed only in the page's element name.

**Proof.** Local app against a local fake database (no live data): the resend email HTML
showed `&lt;`/`&amp;` for a product `2,4-D Amine <4L> & Co`, contact `Tom & <Jerry>` and signer
`Pat <O'Brien> & Sons`; all three searches sent quoted patterns and found the comma names;
Print with a failed line read showed the new message and made no PDF, and Print with a working
read downloaded it; on old code an open edit on DEL-FAKE-2 stayed open with its rows on
DEL-FAKE-3, and with the fix it closed. New tests: `deliveryReceiptEmail.test.ts`,
`DeliveryDetailRoute.test.tsx`.

**Not verified.** The two completion-time receipt emails (desktop and Field Mode) were not
clicked through in the browser (each needs the full completion flow); they use the same builder
as the resend, which was, and their unit tests and the existing completion tests pass.

**Left for a follow-up (same defect as B3, outside the report's list).**
`buildInvoicePdfDataFromRow` (`src/lib/invoicePdf.ts`, used by the field-invoice list and panels)
and the batch print in `src/pages/Invoices.tsx` also ignore a failed `invoice_items` read.
