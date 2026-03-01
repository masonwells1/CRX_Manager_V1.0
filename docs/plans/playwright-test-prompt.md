# Playwright E2E Test Prompt — Full Coverage Sprint

**Generated:** 2026-03-01
**Context:** Analysis of 2 merged feature branches (go-live-hardening PR#18 + audit-remediation PR#19) plus 25 pages with zero dedicated E2E test files.

---

## Prompt for Claude Code Desktop

Copy everything below the line and paste it into Claude Code Desktop:

---

## Task: Write Comprehensive Playwright E2E Tests

You are adding Playwright E2E tests for CRX Manager V1.0. The codebase already has 61 test files in `tests/e2e/` with 424+ tests. You are writing **new test files only** — do NOT modify existing tests.

### Setup & Conventions

**Config:** `playwright.config.ts` — sequential execution, 1 worker, Chromium, base URL `http://localhost:5173`

**Auth helper:** `tests/e2e/utils/auth.ts`
```typescript
import { login } from './utils/auth';
// login(page) logs in as admin (mason@croprxsolutions.com)
// login(page, email, password) logs in as a specific role
```

**Math helpers:** `tests/e2e/utils/math-helpers.ts` — `parseDollars()`, `parseQuantity()`, `assertCentsEqual()`, `waitForPageStable()`, `getColumnMap()`, `cellText()`, `allTexts()`

**Test pattern to follow:**
```typescript
import { test, expect } from '@playwright/test';
import { login } from './utils/auth';

const RUN_ID = Date.now().toString(36);
const waitForPage = (page: import('@playwright/test').Page, ms: number) => page.waitForTimeout(ms);

test.describe('Feature Name', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('T1: descriptive test name', async ({ page }) => {
    await page.goto('/route');
    await waitForPage(page, 2000);
    // assertions...
  });
});
```

**Key selectors used across the codebase:**
- Headings: `h1, h2, [role="heading"]`
- Modals: `[role="dialog"], .modal`
- Tables: `table tbody tr`, `thead th`
- Buttons: `button:has-text("Text")`
- Tabs: `button:has-text("Tab Name"), [role="tab"]:has-text("Tab Name")`
- Forms: `select`, `input[type="email"]`, `page.getByLabel(/Label/i)`

**Rules:**
- Use `await waitForPage(page, 2000)` after navigation, not `waitForLoadState`
- Use `.catch(() => false)` for optional element visibility checks
- Use `RUN_ID` suffix for any test data you create (e.g., `Test-${RUN_ID}`)
- No `@ts-ignore` or `any` types
- Tests must be resilient — handle empty states gracefully
- Each test file should have 5-15 tests
- Put all files in `tests/e2e/`

---

### PART 1: New Features That Need Testing (Changed Since Last Test Suite Update)

These features were added in the **audit-remediation** branch (PR#19) and the **go-live-hardening** branch (PR#18) but have NO E2E coverage for the new functionality.

#### File 1: `tests/e2e/prepayment-manager-crud.spec.ts`
**Page:** `/prepayments` — PrepaymentManager.tsx
**What's new:** Split Check modal, prepay bucket system, batch apply, allocate navigation
**Tests to write:**
1. Page loads with heading and customer table
2. Table shows columns: Customer, Prepay Balance, Unpaid Invoices, Unpaid Balance, Actions
3. "New Check" / "Split Check" button opens modal
4. Split Check modal has fields: Customer dropdown, Check #, Total Amount, bucket splits (label + amount)
5. Validate split amounts must sum to check total (submit with mismatch → error)
6. Create a split check with 2 buckets → verify success (no error toast)
7. "Allocate" button navigates to PrepayWorkspace with customer parameter
8. "Apply" (Zap icon) button triggers auto-apply (verify no crash)
9. "Batch Apply All" button triggers batch operation with confirmation
10. CSV export button works

#### File 2: `tests/e2e/prepay-workspace.spec.ts`
**Page:** `/prepay-workspace` — PrepayWorkspace.tsx (NEW PAGE)
**What it does:** Split-panel allocator — prepay buckets on left, unpaid invoices on right
**Tests to write:**
1. Page loads with heading ("Prepay Workspace" or similar)
2. Customer dropdown is visible and populated
3. Selecting a customer loads their prepay buckets (left panel)
4. Selecting a customer loads their unpaid invoices (right panel)
5. If customer has no prepay balance → shows empty state message
6. Allocate button exists for each bucket
7. "Save Allocations" button visible in toolbar
8. "Reset" button clears pending allocations
9. Navigate from PrepaymentManager "Allocate" link → customer pre-selected
10. Page handles no-data state gracefully (no crash)

#### File 3: `tests/e2e/tote-tracking.spec.ts`
**What's new:** Tote number field added to NewDelivery items, displayed on DeliveryDetail, shown in ReceivingLog with non-returnable badge, included in InvoiceDetail/PDF
**Tests to write (cross-page feature):**
1. NewDelivery (`/deliveries/new`): tote number input field visible on delivery items
2. NewDelivery: can type a tote number (e.g., "T-001") into the field
3. DeliveryDetail (`/deliveries/:id`): tote number column displays in items table
4. ReceivingLog (`/receiving`): page loads and shows table with receiving records
5. ReceivingLog: non-returnable badge ("Non-Returnable") displays for flagged items (or empty state is fine)
6. ReceivingLog: condition filter dropdown works (good/damaged/short/wrong_product/mixed)
7. InvoiceDetail (`/invoices/:id`): tote number field visible on line items (if invoice has items)
8. InvoiceDetail: "Print" / "Download PDF" button is clickable

#### File 4: `tests/e2e/rup-compliance-warnings.spec.ts`
**What's new:** RUP compliance warnings on QuoteBuilder, NewDelivery, and DeliveryDetail when customer lacks applicator license for restricted-use pesticides
**Tests to write:**
1. Compliance page (`/compliance`): RUP Products tab shows products or empty state
2. QuoteBuilder (`/quotes/new`): page loads, customer selector works
3. QuoteBuilder: adding a product shows product in line items (RUP warning may or may not appear depending on data)
4. NewDelivery (`/deliveries/new`): page loads with order selector
5. DeliveryDetail: page loads and shows delivery items with status
6. Compliance page: "Expiring" filter shows licenses expiring within 30 days (or empty)
7. Compliance page: expiry badge colors are correct (verify class contains color indicator)

#### File 5: `tests/e2e/finance-charge-fix.spec.ts`
**What's new:** Finance charges no longer compound on prior finance charges, billing splits locked
**Tests to write:**
1. AR Aging page (`/ar-aging`) loads with heading and aging table
2. AR Aging: "As Of Date" picker is functional
3. AR Aging: aging buckets display (0-30, 31-60, 61-90, 90+ columns)
4. AR Aging: "Finance Charge Preview" button exists (admin only)
5. AR Aging: clicking Finance Charge Preview opens modal/dialog
6. AR Aging: Statement tab loads customer statement view
7. AR Aging: Season Comparison tab loads (if present)
8. AR Aging: CSV export button works

---

### PART 2: Pages With ZERO E2E Test Coverage

These 25 pages exist in the app but have no dedicated test file. Some get partial coverage through workflow tests, but they need their own spec files.

#### File 6: `tests/e2e/ar-aging.spec.ts`
**Page:** `/ar-aging` — ARaging.tsx
**Tests to write:**
1. Page loads with "AR Aging" or "Accounts Receivable" heading
2. Aging table displays with customer rows (or empty state)
3. Date picker ("As Of Date") is visible and functional
4. Tab navigation: Aging → Statement → Season Comparison
5. Statement tab: customer dropdown visible
6. Statement tab: date range pickers (start/end) visible
7. Batch statements button visible (admin)
8. CSV/PDF export buttons functional
9. Finance charge preview modal opens
10. No console errors on page load

#### File 7: `tests/e2e/application-records.spec.ts`
**Page:** `/application-records` — ApplicationRecords.tsx
**Tests to write:**
1. Page loads with "Application Records" heading
2. Table displays with columns (date, customer, applicator, product, field, etc.)
3. Date range filter: start and end date pickers visible
4. Preset date buttons work ("This Season", "Last Season", "Last 30 Days")
5. Customer dropdown filter is visible
6. CSV download button is functional
7. Empty state displays gracefully when filters return no data
8. Table has correct column headers

#### File 8: `tests/e2e/commission-payments-crud.spec.ts`
**Page:** `/commission-payments` — CommissionPayments.tsx (Admin only)
**Tests to write:**
1. Page loads with heading
2. Tabs visible: "Unposted" and "Posted"
3. "Create Payment" button visible
4. Create Payment modal opens with recipient dropdown
5. Table columns: payment number, recipient, total, method, reference, date, status
6. CSV export button functional
7. Posted tab shows historical payments (or empty state)
8. Page is admin-only (test with admin login)

#### File 9: `tests/e2e/crop-programs.spec.ts`
**Page:** `/crop-programs` — CropPrograms.tsx
**Tests to write:**
1. Page loads with "Crop Programs" heading
2. "Create Program" button visible
3. Create Program modal opens with name, crop type, season fields
4. Program cards/list displays (or empty state)
5. Program expand/collapse works (shows items inside)
6. Copy Program button visible per program
7. Delete with confirmation works

#### File 10: `tests/e2e/cycle-counts.spec.ts`
**Page:** `/cycle-counts` — CycleCounts.tsx
**Tests to write:**
1. Page loads with heading
2. "New Count" button visible
3. Summary cards show open/completed count totals
4. Status filter dropdown works
5. New Count modal opens with warehouse dropdown
6. Table shows count records with correct columns
7. Clicking a count opens detail modal with item list

#### File 11: `tests/e2e/delivery-remainders.spec.ts`
**Page:** `/delivery-remainders` — DeliveryRemainders.tsx
**Tests to write:**
1. Page loads with heading
2. Table displays remainder items (or empty state)
3. Columns: customer, product, quantity remaining, unit, delivery #, order #, status
4. Status filter dropdown (default: "pending")
5. Customer filter dropdown works
6. "Create Follow-up Delivery" button visible per row (if data exists)

#### File 12: `tests/e2e/customer-transactions.spec.ts` (ENHANCE — file exists but may not cover new features)
**Page:** `/customer-transactions` — CustomerTransactionReview.tsx
**Tests to write (if not already covered):**
1. Page loads with heading
2. Customer dropdown is populated
3. Date range pickers visible (start/end)
4. Selecting customer + dates loads transaction table
5. Table columns: date, type, reference, description, debit, credit, running balance
6. CSV export button works
7. PDF export button works

#### File 13: `tests/e2e/quick-receive.spec.ts`
**Page:** `/receiving/quick` — QuickReceive.tsx
**Tests to write:**
1. Page loads with step 1 heading ("Add Items" or similar)
2. Vendor dropdown visible and populated
3. Storage location dropdown visible
4. "Add Item" button visible
5. Adding an item shows product search
6. Per-item fields: quantity, unit cost, condition dropdown, lot #, notes
7. "Review & Receive" button advances to step 2
8. Step 2 shows read-only review of all items
9. Remove item button works

#### File 14: `tests/e2e/returns-crud.spec.ts`
**Page:** `/returns` — Returns.tsx
**Tests to write:**
1. Page loads with heading
2. "Create Return" button visible
3. Status filter dropdown (requested/approved/received/credited/rejected)
4. Table columns: return #, customer, order #, status, requester, reason, items, date
5. Create Return modal opens with customer/order dropdowns
6. Bulk select checkboxes visible
7. Bulk approve/reject buttons visible when rows selected
8. CSV/PDF export buttons functional

#### File 15: `tests/e2e/rebates-page.spec.ts`
**Page:** `/rebates` — Rebates.tsx (Admin only)
**Tests to write:**
1. Page loads with heading
2. Table or card layout displays rebate programs
3. Create button visible
4. Rebate detail view accessible
5. Status indicators visible

#### File 16: `tests/e2e/new-delivery-page.spec.ts`
**Page:** `/deliveries/new` — NewDelivery.tsx
**Tests to write:**
1. Page loads with heading
2. Order selector dropdown visible
3. Selecting an order populates customer and items
4. Delivery item table shows product, quantity, tote number, unit size
5. Driver selector dropdown visible
6. Date/time pickers visible
7. Delivery notes textarea visible
8. Save/Create button visible

#### File 17: `tests/e2e/new-order-page.spec.ts`
**Page:** `/orders/new` — NewOrder.tsx
**Tests to write:**
1. Page loads with heading
2. Customer selector visible
3. Product add section visible
4. Line items table builds as products added
5. Save/Create button visible

#### File 18: `tests/e2e/new-purchase-order.spec.ts`
**Page:** `/purchase-orders/new` — NewPurchaseOrder.tsx
**Tests to write:**
1. Page loads with heading
2. Vendor selector dropdown visible
3. Product search/add section visible
4. Line items table with quantity, unit cost columns
5. Save/Submit button visible

#### File 19: `tests/e2e/purchase-order-detail.spec.ts`
**Page:** `/purchase-orders/:id` — PurchaseOrderDetail.tsx
**Tests to write:**
1. Navigate from PO list → click first PO → detail loads
2. PO header shows number, vendor, status badge
3. Items table shows products with quantities
4. Receive button visible for open POs
5. Status transitions visible (submit, cancel)

#### File 20: `tests/e2e/invoice-list-page.spec.ts`
**Page:** `/invoices` — Invoices.tsx
**Tests to write:**
1. Page loads with heading
2. Invoice table displays with correct columns
3. Status filter tabs (unposted/posted) or dropdown
4. Quick delivery filter works
5. Batch print button visible
6. Batch void button visible (admin)
7. Click invoice row → navigates to detail

#### File 21: `tests/e2e/field-detail.spec.ts`
**Page:** `/fields/:id` — FieldDetail.tsx
**Tests to write:**
1. Navigate from fields list → click first field → detail loads
2. Field name and customer displayed
3. Map component renders (Mapbox container visible)
4. Edit button visible
5. Save button visible in edit mode

#### File 22: `tests/e2e/job-detail.spec.ts`
**Page:** `/jobs/:id` — JobDetail.tsx
**Tests to write:**
1. Navigate from jobs list → click first job → detail loads
2. Job header shows number, customer, status
3. Fields section visible (may include map)
4. Chemicals/products section visible
5. Vehicle and applicator dropdowns visible
6. Complete button visible for in-progress jobs
7. Transfer to Invoice button visible for completed jobs

#### File 23: `tests/e2e/vehicle-detail.spec.ts`
**Page:** `/vehicles/:id` — VehicleDetail.tsx
**Tests to write:**
1. Navigate from vehicles list → click first vehicle → detail loads
2. Vehicle name/type displayed
3. Edit form fields: name, type (ground/air), capacity, registration
4. Save button visible
5. Delete button visible

#### File 24: `tests/e2e/inventory-page.spec.ts`
**Page:** `/inventory` — InventoryPage.tsx
**Tests to write:**
1. Page loads with heading
2. Inventory table displays with product rows
3. Columns include: product, quantity available, quantity on hand, reorder point
4. Low stock indicators visible for products below reorder point
5. Search/filter functionality works
6. Cost valuation summary visible
7. CSV export button functional

---

### PART 3: Execution Instructions

1. **Create all test files** in `tests/e2e/` directory
2. **Follow the exact patterns** shown above (imports, `RUN_ID`, `waitForPage`, `beforeEach` with `login()`)
3. **Be resilient** — use `.catch(() => false)` for optional checks, handle empty data gracefully
4. **Do NOT modify existing test files** — only create new ones
5. **Do NOT add `@ts-ignore` or `any` types**
6. **Test each file compiles** by running: `npx tsc --noEmit tests/e2e/NEW_FILE.spec.ts` (or just ensure no TS errors)
7. **Run the full suite** after all files are created: `npx playwright test --reporter=list`
8. **Target: 19 new test files, ~170-200 new tests total**

### File Summary

| # | File | Route | Tests |
|---|------|-------|-------|
| 1 | `prepayment-manager-crud.spec.ts` | `/prepayments` | ~10 |
| 2 | `prepay-workspace.spec.ts` | `/prepay-workspace` | ~10 |
| 3 | `tote-tracking.spec.ts` | multi-page | ~8 |
| 4 | `rup-compliance-warnings.spec.ts` | multi-page | ~7 |
| 5 | `finance-charge-fix.spec.ts` | `/ar-aging` | ~8 |
| 6 | `ar-aging.spec.ts` | `/ar-aging` | ~10 |
| 7 | `application-records.spec.ts` | `/application-records` | ~8 |
| 8 | `commission-payments-crud.spec.ts` | `/commission-payments` | ~8 |
| 9 | `crop-programs.spec.ts` | `/crop-programs` | ~7 |
| 10 | `cycle-counts.spec.ts` | `/cycle-counts` | ~7 |
| 11 | `delivery-remainders.spec.ts` | `/delivery-remainders` | ~6 |
| 12 | `customer-transactions.spec.ts` | `/customer-transactions` | ~7 |
| 13 | `quick-receive.spec.ts` | `/receiving/quick` | ~9 |
| 14 | `returns-crud.spec.ts` | `/returns` | ~8 |
| 15 | `rebates-page.spec.ts` | `/rebates` | ~5 |
| 16 | `new-delivery-page.spec.ts` | `/deliveries/new` | ~8 |
| 17 | `new-order-page.spec.ts` | `/orders/new` | ~5 |
| 18 | `new-purchase-order.spec.ts` | `/purchase-orders/new` | ~5 |
| 19 | `purchase-order-detail.spec.ts` | `/purchase-orders/:id` | ~5 |
| 20 | `invoice-list-page.spec.ts` | `/invoices` | ~7 |
| 21 | `field-detail.spec.ts` | `/fields/:id` | ~5 |
| 22 | `job-detail.spec.ts` | `/jobs/:id` | ~7 |
| 23 | `vehicle-detail.spec.ts` | `/vehicles/:id` | ~5 |
| 24 | `inventory-page.spec.ts` | `/inventory` | ~7 |
| **Total** | **24 new files** | | **~170+** |

**Note:** File 5 (finance-charge-fix) and File 6 (ar-aging) both test `/ar-aging` — consider merging them into one file if the test count gets too high. File 12 (customer-transactions) already exists — check the existing file first and only add tests for uncovered functionality.
