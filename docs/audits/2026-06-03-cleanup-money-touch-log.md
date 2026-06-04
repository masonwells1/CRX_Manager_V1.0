# Money-Touch Ledger — 2026-06-03 cleanup branch (`chore/safe-cleanup-2026-06-03`)

**Purpose:** Mason requested that every change touching money display be logged here for a
mandatory **Codex review of money-touching changes** + a full **ultra review** once the
cleanup is complete. Nothing below has been merged to `main` or deployed.

---

## Key finding (why this needed care)

The original ultra-review report rated "consolidate the ~60 cents→USD formatters" as **LOW
risk**. That was **wrong**. Surveying every local formatter revealed they are **two different
functions sharing the name `fmt`**:

- **CENTS-based** — `(cents) => Intl.NumberFormat(...).format(cents / 100)`  (~22 files)
- **DOLLARS-based** — `(n) => Intl.NumberFormat(...).format(n)` (no `/100`)   (~13 files)

A blind "consolidate into one `formatCents`" would have made every **dollars-based** call
divide by 100 — e.g. a real invoice total of **$1,234.56 would render as $12.35**. A silent
money bug. So the consolidation splits into two clearly-named helpers in `src/lib/money.ts`:
`formatCents(cents)` and `formatUSD(dollars)`. Each callsite is classified by whether its
original local helper divided by 100, and aliased to the original local name so **no call-site
logic changes** (`import { formatCents as fmt }`).

`src/lib/money.ts` reuses a single cached `Intl.NumberFormat` — formatting output is identical
to the per-call instances it replaces.

---

## Conversions (to be Codex-reviewed)

### CENTS → `formatCents`  (alias kept as original local name; callsites untouched)
**Batch 3c-1** (`fmt` was `(cents) => …format(cents / 100)` in each):
- `src/lib/statementPdf.ts`
- `src/lib/yearEndSummaryPdf.ts`
- `src/pages/Invoices.tsx`
- `src/pages/InvoiceDetail.tsx`
- `src/pages/MonthEndClose.tsx`
- `src/pages/CustomerTransactionReview.tsx`
- `src/pages/PrepayWorkspace.tsx`

**Batch 3c-2** (`fmt`/`fmtCents` was `(cents) => …format(cents / 100)`):
- `src/components/field-app/FieldAppChemicalEntry.tsx`
- `src/components/field-app/ApplicationServicePicker.tsx`
- `src/components/field-app/CustomerSharesTable.tsx`
- `src/components/invoices/WriteOffModal.tsx`
- `src/components/invoices/FinanceChargePreviewModal.tsx`
- `src/pages/DeliveryDetail.tsx`

**Still TODO (cents):** AccountsPayable, Compliance, VendorBills, NewVendorBill,
VendorBillDetail, QuickDeliveryModal, ARaging (2 inner-scope `fmtCents`).

### DOLLARS → `formatUSD`
_(log updated as each batch lands)_

### Deliberately LEFT LOCAL (custom options — NOT consolidated)
These use non-default options, so they are NOT equivalent to formatCents/formatUSD:
- `NewOrder.tsx` — `fmtUsd` with `maximumFractionDigits: 0` (whole dollars) and a second with explicit `minimumFractionDigits: 2`
- `SalesReports.tsx` — `fmt` with `maximumFractionDigits: 0`; `fmtDec`/`fmtQty` (non-currency)
- `Reports.tsx` — `fmt` with `maximumFractionDigits: 0`
- `QuoteBuilder.tsx` — `fmtCl` (`maximumFractionDigits: 0`) + `fmt` (multi-line custom options)
- `FinancialDashboard.tsx` — `fmt` / `fmtDecimal` (custom options)
- `statementPdf.ts` — `fmtNum` (configurable decimals, non-currency)
- `yearEndSummaryPdf.ts` — `fmtAcres` / `fmtQty` (non-currency)
- Inline `Intl.NumberFormat(...).format(...)` usages (e.g. `CustomerDetail.tsx` history rows) — left as-is for now

---

## Review checklist (do BEFORE merging to main)
- [ ] Codex review of EVERY money-touching change in this branch (per Mason)
- [ ] Full ultra review of the cleanup branch
- [ ] Spot-check a rendered invoice/statement PDF + an AR screen for correct dollar amounts
- [ ] Confirm no dollars-based callsite was converted to `formatCents` (or vice-versa)
