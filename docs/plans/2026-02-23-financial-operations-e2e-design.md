# Financial Operations E2E Gate Test Design

> **Date:** 2026-02-23
> **Purpose:** Pre-launch gate test — exercises every critical financial workflow action (payment allocation, invoice posting/voiding, prepayments, finance charges, PO receiving, cycle counts, month-end close, commission payments) that had only superficial "page loads" coverage.

## Architecture

- **File:** `tests/e2e/workflow-financial-operations.spec.ts`
- **Runner:** Playwright with `test.describe.serial()` — tests run sequentially, each depending on the previous
- **Data strategy:** Hybrid — Suite 1 creates fresh order/invoice data; Suite 2 consumes prepay credit from Suite 1; Suites 3-4 use existing PO/inventory/commission seed data
- **Auth:** Admin login (`mason@croprxsolutions.com` via `E2E_TEST_EMAIL`)
- **Viewport:** 1280x720
- **Dialog handling:** `page.on('dialog')` for CycleCounts (2 confirm() dialogs) and PaymentAllocation (1 confirm() when full prepay)

## Key Technical Notes

1. **No native confirm()** on most financial pages — PaymentAllocation, Payments, PrepaymentManager, ARaging, MonthEndClose, CommissionPayments, InvoiceDetail all use custom `<Modal>` components
2. **CycleCounts has TWO native confirm() dialogs** — complete (uncounted items warning) and cancel
3. **PaymentAllocation has ONE native confirm()** — only when entire check amount goes to prepay with zero allocations
4. **CycleCounts counted qty inputs fire immediate DB writes** — no save button, onChange triggers Supabase update
5. **QuickReceive product search** uses a custom fixed overlay (not Modal)
6. **PO Receive is two-step modal**: fill details → review → "Confirm & Receive"
7. **QuickReceive is three-step**: add_items → review (PO matching) → success

## Four Test Suites (~25 tests)

### Suite 1: Invoice Payment Lifecycle (F1-F8)

Creates a fresh order → invoice, then exercises the complete payment lifecycle.

| # | Test | Action | Verification |
|---|------|--------|-------------|
| F1 | Create order + invoice | `/orders/new` → create direct order → navigate to invoice | Invoice visible with correct amount, status=Draft/Editable |
| F2 | Post invoice | Click "Post" button on InvoiceDetail | Status changes to Posted |
| F3 | Record partial payment | Click "Record Payment" on InvoiceDetail → fill $50 partial → submit | Payment recorded, balance reduced, status still Posted |
| F4 | Verify payment in history | `/payments` → Payment History tab | Payment row visible with correct amount/method |
| F5 | Allocate remaining via PA | `/payment-allocation` → search customer → enter check amount → auto-allocate → Apply Payment | Success banner "Payment Applied Successfully" |
| F6 | Verify invoice fully paid | Navigate back to invoice detail | Status=Paid, balance=0 |
| F7 | Void second invoice | Create second order+invoice → post → click "Void" → enter reason → confirm | Status=Voided |
| F8 | Overpay to create prepay | Create third order+invoice → post → record payment > invoice total | Prepay credit created for customer |

### Suite 2: Prepayment & Finance Charges (P1-P5)

Uses the prepay credit created in F8.

| # | Test | Action | Verification |
|---|------|--------|-------------|
| P1 | Verify PrepaymentManager loads | `/prepayments` | Table or empty state visible, page loads without error |
| P2 | Apply prepay to customer | Find customer row → click "Apply" → confirm in modal | Prepay balance reduced, invoice(s) updated |
| P3 | Navigate to AR Aging | `/ar-aging` | "AR Aging & Statements" heading visible, AR Aging tab active |
| P4 | Preview finance charges | Click "Preview Finance Charges" → modal opens | Finance charge preview table visible with customer rows |
| P5 | Generate finance charges | Select customer(s) → click "Generate Selected" or "Generate All" | Success toast, FC invoice(s) created |

### Suite 3: PO Receiving & Cycle Counts (R1-R7)

Uses existing PO and inventory data.

| # | Test | Action | Verification |
|---|------|--------|-------------|
| R1 | Navigate to PO detail | `/purchase-orders` → click first PO with receivable items | PO detail page loads with line items |
| R2 | Receive items (two-step modal) | Click "Receive Items" → fill qty for first item → set storage location → click "Review" → click "Confirm & Receive" | Success toast "Items received and inventory updated" |
| R3 | Verify receiving history | Check Receiving History tab/section on PO detail | New receiving event row visible |
| R4 | Quick Receive (step 1) | `/receiving/quick` → enter vendor → add product → enter qty | Product row visible with entered qty |
| R5 | Quick Receive (step 2+3) | Click "Review & Match" → review matching results → click "Confirm & Receive" | Success state "Shipment Received!" visible |
| R6 | Create new cycle count | `/cycle-counts` → click "New Cycle Count" → select warehouse → save | Cycle count row created with CC-XXXX number |
| R7 | Enter counts and complete | Open cycle count → enter counted qty → click "Complete & Apply Adjustments" → accept confirm() | Cycle count status=Completed, inventory adjustments applied |

### Suite 4: Month-End & Commission Operations (M1-M5)

| # | Test | Action | Verification |
|---|------|--------|-------------|
| M1 | Month-End checklist verification | `/month-end` | Checklist items visible with check/alert icons |
| M2 | Create commission payment | `/commission-payments` → click "New Payment" → select recipient → select commissions → fill details → create | Commission payment row visible |
| M3 | Post commission payment | Click "Post" on unposted payment row | Status changes to Posted |
| M4 | Verify Month-End close state | `/month-end` → check which checklist items pass | Updated checklist reflects commission review completion |
| M5 | Generate statements from Month-End | Click "Generate Statements" header button | Statement generation initiated (dialog/page visible) |

## Shared State Object

```typescript
const state = {
  // Suite 1: Invoice Payment Lifecycle
  orderUrl: '',
  invoiceUrl: '',
  invoiceNumber: '',
  customerName: '',
  invoiceAmountCents: 0,

  // Suite 1: Second + Third invoices
  invoice2Url: '',
  invoice3Url: '',

  // Suite 2: Prepayment
  prepayCustomerName: '',

  // Suite 3: PO Receiving
  poUrl: '',
  cycleCountNumber: '',

  // Suite 4: Commission
  commissionPaymentId: '',
};
```

## Playwright Patterns Used

- **Serial suites**: `test.describe.serial()` for dependent test chains
- **Dialog handler**: `page.on('dialog', d => d.accept())` before CycleCounts and PaymentAllocation prepay actions
- **Modal interaction**: Click trigger button → wait for modal visible → fill fields → click action button → wait for modal to close or success state
- **Two-step modal**: Fill step → "Review" button → Review step → "Confirm" button
- **Toast verification**: `page.locator('text=/success|applied|received/i').first()` with timeout
- **Async data waits**: `waitForPage()` helper + `toBeVisible({ timeout: 10000 })` for data-dependent elements
