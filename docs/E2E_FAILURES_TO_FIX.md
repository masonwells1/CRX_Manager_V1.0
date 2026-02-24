# Pre-Existing E2E Test Failures (42 total)

**Date:** 2026-02-24
**Full suite:** 424 tests | 370 passed | 42 failed | 12 did not run | 33.5 minutes
**Our new bulk-operations tests:** 31/31 passed (not part of the failures)

---

## Category 1: Missing Role Test Accounts (31 failures)

**Root Cause:** No `sales_rep`, `applicator`, or `driver` test accounts exist in Supabase Auth. All tests redirect to `/login` because authentication fails.

**Fix:** Create test users in Supabase Auth with correct roles in the `profiles` table:
1. Create a `sales_rep` user (e.g., `salesrep-test@croprxsolutions.com`) with role `sales_rep` in profiles
2. Create a `driver` user (e.g., `driver-test@croprxsolutions.com`) with role `driver` in profiles
3. Create an `applicator` user (e.g., `applicator-test@croprxsolutions.com`) with role `applicator` in profiles
4. Add credentials to `.env` as `E2E_SALESREP_EMAIL`/`E2E_SALESREP_PASSWORD`, etc.
5. Update the spec files to use those credentials

### role-sales-rep.spec.ts (28 failures)

| # | Test Name | Error |
|---|-----------|-------|
| 1 | can access Dashboard (/) | Redirects to /login — no sales_rep account |
| 2 | can access Products (/products) | Same |
| 3 | can access Customers (/customers) | Same |
| 4 | can access Fields (/fields) | Same |
| 5 | can access Quotes (/quotes) | Same |
| 6 | can access New Quote (/quotes/new) | Same |
| 7 | can access Orders (/orders) | Same |
| 8 | can access Invoices (/invoices) | Same |
| 9 | can access Inventory (/inventory) | Same |
| 10 | can access Purchase Orders (/purchase-orders) | Same |
| 11 | can access Receiving (/receiving) | Same |
| 12 | can access Blend Tickets (/blend-tickets) | Same |
| 13 | can access Blend Recipes (/recipes) | Same |
| 14 | can access Returns (/returns) | Same |
| 15 | can access Deliveries (/deliveries) | Same |
| 16 | can access Jobs (/jobs) | Same |
| 17 | can access Delivery Remainders (/delivery-remainders) | Same |
| 18 | can access Application Records (/application-records) | Same |
| 19 | can access Reports (/reports) | Same |
| 20 | can access Compliance (/compliance) | Same |
| 21 | can access Brand vs Generic (/brand-vs-generic) | Same |
| 22 | can access Crop Programs (/crop-programs) | Same |
| 23 | can access Payment Allocation (/payment-allocation) | Same |
| 24 | sidebar shows sales_rep-accessible items | Same |
| 25 | sidebar shows correct role label | Same |
| 26 | Create New Delivery page is accessible | Same |
| 27 | Quick Delivery button IS visible to sales_rep | Same |
| 28 | (one additional allowed page test) | Same |

### role-security.spec.ts (3 failures)

| # | Test Name | Error |
|---|-----------|-------|
| 1 | should display navigation sidebar with role-appropriate links | Needs non-admin role login |
| 2 | applicator routes should include jobs page | Needs applicator login |
| 3 | sidebar only shows allowed nav items for driver | Needs driver login |

---

## Category 2: Page Heading Selector Mismatches (10 failures)

**Root Cause:** Tests use `page.locator('h1').first()` expecting page titles like "Invoices", but the first `h1` on the page is actually the app name "Crop RX Solutions" in the sidebar/header. The actual page heading is in an `h2` or uses a different element.

**Fix:** Update selectors to match the actual DOM structure. Options:
- Use `page.locator('h2').first()` instead of `h1`
- Use `page.getByRole('heading', { name: /Invoice/i })` for more specific targeting
- Add `data-testid="page-title"` to page headings for reliable selection

### workflow-quote-to-cash.spec.ts (3 failures)

| # | Test Name | Error |
|---|-----------|-------|
| 1 | invoices list page loads | `h1` contains "Crop RX Solutions", not "Invoice" |
| 2 | payment allocation page loads with customer selector | Same heading issue |
| 3 | invoice exists with balance and can be found after posting | Same heading issue |

### workflow-credit-limit.spec.ts (3 failures)

| # | Test Name | Error |
|---|-----------|-------|
| 1 | should load new order page with customer selector | Page structure mismatch |
| 2 | should navigate from dashboard credit alert to customers page | Same |
| 3 | should display AR aging page with customer balances | Same |

### workflow-cancellation-cascade.spec.ts (1 failure)

| # | Test Name | Error |
|---|-----------|-------|
| 1 | invoices page loads and shows void capability for posted invoices | `h1` heading mismatch |

### workflow-driver-permissions.spec.ts (1 failure)

| # | Test Name | Error |
|---|-----------|-------|
| 1 | admin should access invoices page (driver should not) | `h1` heading mismatch |

### workflow-po-receiving.spec.ts (1 failure)

| # | Test Name | Error |
|---|-----------|-------|
| 1 | should load receiving log page | Page heading selector mismatch |

### workflow-quick-delivery.spec.ts (1 failure)

| # | Test Name | Error |
|---|-----------|-------|
| 1 | invoices page shows CS- prefixed chemical sale invoices | `h1` heading mismatch |

---

## Category 3: UI Interaction / Timing (1 failure)

### workflow-admin-full-lifecycle.spec.ts (1 failure)

| # | Test Name | Error |
|---|-----------|-------|
| 1 | T3: Convert quote to order redirects to order detail | UI interaction timing during quote conversion |

**Fix:** Add `waitForURL` or increase timeout after the conversion action.

---

## Category 4: Business Logic Validation (1 failure)

### edge-cases.spec.ts (1 failure)

| # | Test Name | Error |
|---|-----------|-------|
| 1 | zero-quantity: new order page should validate item quantities | Zero-quantity validation not triggered as expected |

**Fix:** Investigate whether the order page validates zero quantities client-side or server-side, and update the test accordingly.

---

## Priority Order for Fixing

1. **Category 2 (heading selectors)** — Quick fix, 10 tests. Just update `h1` → `h2` or use `getByRole`.
2. **Category 3 + 4 (timing + validation)** — 2 tests. Small targeted fixes.
3. **Category 1 (role accounts)** — 31 tests. Requires creating test users in Supabase Auth + updating E2E env vars + updating spec files to use per-role credentials.

**After fixing all:** Expected result = 424/424 passing (100%)
