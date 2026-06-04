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

**Batch 3c-3** (`fmt`/`fmtCurrency` was `(cents) => …format(cents / 100)`) — commit `9713c2b`:
- `src/pages/AccountsPayable.tsx` (`fmt`)
- `src/pages/Compliance.tsx` (`fmtCurrency`)
- `src/pages/VendorBills.tsx` (`fmt`)
- `src/pages/NewVendorBill.tsx` (`fmt`)
- `src/pages/VendorBillDetail.tsx` (`fmt`)
- `src/components/deliveries/QuickDeliveryModal.tsx` (`fmtCurrency`, 2-deep → `../../lib/money`)

**Batch 3c-4 (ARaging — MIXED cents+dollars)** — commit `f132968`:
- `src/pages/ARaging.tsx` — 4 local formatters → one combined import
  `{ formatCents as fmtCents, formatUSD as fmt }`. Removed: component `fmt` (DOLLARS),
  component `fmtCents = fmt(cents/100)` (CENTS), and TWO handler-scope `fmtCents` (CENTS).
  ⚠️ The prior ledger said "two inner `fmtCents`"; code review found **three** `fmtCents` total
  (it missed the component-scope one). All callsites verified: `fmt(...)` takes dollar values,
  `fmtCents(...)` takes `*_cents`/`running_balance`. Green (build + 1924 tests).

**Cents consolidation: COMPLETE.** No cents-based local formatters remain (outside the
"deliberately left local" custom-option list below).

### DOLLARS → `formatUSD`  (alias kept as original local name; callsites untouched)
_None converted yet._ **TODO** (`fmt`/`fmtCurrency` was `(n) => …format(n)` — NO `/100`):
- `src/pages/CustomerDetail.tsx` (also has inline `NumberFormat().format(total_spent)` on history rows — leave those inline ones)
- `src/pages/Orders.tsx`, `src/pages/Products.tsx`, `src/pages/Quotes.tsx`
- `src/pages/PurchaseOrders.tsx`, `src/pages/PurchaseOrderDetail.tsx`, `src/pages/NewPurchaseOrder.tsx`
- `src/pages/CommissionPayments.tsx`, `src/pages/Rebates.tsx`, `src/pages/QuickReceive.tsx`
- `src/components/purchase-orders/BulkPOImport.tsx`
- `src/lib/reportPdf.ts` (`fmtCurrency`)
- `src/pages/BrandVsGeneric.tsx` (ternary shape `n != null ? format(n) : '-'` — verify before converting)

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

## Resume instructions (next session — pick up cold)

**Branch:** `chore/safe-cleanup-2026-06-03` — 6 commits ahead of `origin/main`, all green, **NOT pushed**.
`main` is clean at `origin/main`. `src/lib/money.ts` already exists with `formatCents` + `formatUSD`.

**Proven, behavior-preserving pattern** — for each remaining file: delete the local
`const fmt/fmtCents/fmtCurrency = (x) => new Intl.NumberFormat(...).format(...)` and add a
**top-of-file** aliased import that keeps the SAME local name (so no callsite changes):
- helper divided by `/ 100`  →  `import { formatCents as <name> } from '<path>/money';`
- helper did NOT divide       →  `import { formatUSD  as <name> } from '<path>/money';`

Paths: pages → `../lib/money`, components (2 deep) → `../../lib/money`, lib → `./money`.
⚠️ This project's ESLint does NOT auto-hoist a mid-file import — put it in the TOP import
block (anchor on an existing import line); don't leave it where the `const` was.

**Remaining work, in order:**
1. ✅ **DONE — Batch 3c-3 (commit `9713c2b`):** Cents (→ `formatCents`): AccountsPayable, Compliance,
   VendorBills, NewVendorBill, VendorBillDetail, QuickDeliveryModal. typecheck+lint+build+1924 tests green.
2. ✅ **DONE — Batch 3c-4 (commit `f132968`):** ARaging.tsx mixed file. Removed component `fmt`
   (DOLLARS→formatUSD) + THREE `fmtCents` (CENTS→formatCents: one component-scope + two
   handler-scope — prior ledger had undercounted to two). Single combined import added. Green.
3. **Dollars** (→ `formatUSD`): the TODO list under "DOLLARS" above.
4. Then the other contained report consolidations: `companyInfo` company-name (8 PDF files),
   `resolveProfileNames` (13 pages). NOTE `getPresetDates` is **DRIFTING** (the 5 copies differ) —
   needs a canonical-behavior decision from Mason, do NOT blind-merge.

**After EACH batch:** `npm run typecheck && npm run lint && npm run build && npm run test` must be
green, then commit to the branch and update this ledger.

---

## Review checklist (do BEFORE merging to main)
- [ ] Codex review of EVERY money-touching change in this branch (per Mason)
- [ ] Full ultra review of the cleanup branch
- [ ] Spot-check a rendered invoice/statement PDF + an AR screen for correct dollar amounts
- [ ] Confirm no dollars-based callsite was converted to `formatCents` (or vice-versa)
