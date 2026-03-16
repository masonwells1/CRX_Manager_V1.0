# QA Testing Methodology

## Role-Based Testing Matrix

Test every feature as each role:

| Feature | Admin | Sales Rep | Driver | Applicator |
|---------|-------|-----------|--------|------------|
| Dashboard KPIs | Full view | Full view | Deliveries only | Jobs only |
| Products CRUD | Full | Read only | No access | Read only |
| Customers CRUD | Full | Own assigned | Via delivery only | Read only |
| Quotes CRUD | Full | Own only | No access | No access |
| Orders CRUD | Full | Create/Read | No access | No access |
| Inventory | Full | Read + holds | Read only | No access |
| Deliveries | Full | Create/Edit/Cancel | Own + confirm/complete/photos/issues/quick delivery | No access |
| Purchase Orders | Full | Read/Receive | No access | No access |
| Blend Tickets | Full | Upload/review | No access | No access |
| Jobs | Full | Create/Edit | No access | Own assigned + record applied info |
| Vehicles | Full | Read only | No access | Read only |
| Application Records | Full | Read | No access | Read |
| Invoices | Full | Read/Create | No access | No access |
| Payments | Full | Read/Create | No access | No access |
| Month-End Close | Full | No access | No access | No access |
| Commission Payments | Full | No access | No access | No access |
| Fields | Full | Own customer | No access | Read only |
| Reports | Full | Limited | No access | No access |
| Team Board | Full (own notes) | Full (own notes) | Full (own notes) | Full (own notes) |
| Settings | Full | No access | No access | No access |

## Workflow End-to-End Tests

### Quote to Delivery
1. Create customer with tier assignment
2. Create quote with product sections
3. Send quote (status -> sent)
4. Accept quote (status -> accepted)
5. Convert to order (creates order + order_items + commissions)
6. Create delivery from order
7. Assign driver
8. Confirm/start delivery (scheduled -> in_progress, inventory check warning)
9. Complete delivery (updates inventory, order fulfillment, creates remainders for partial)
10. Record payment (updates order balance_due)

### Quick Delivery (ad-hoc)
1. Open Quick Delivery modal (from Deliveries page or driver dashboard)
2. Search/select customer
3. Add products with quantities
4. Optionally assign driver, set date, add notes
5. Submit -> creates order + delivery + draft invoice atomically
6. Sales rep reviews and posts the draft invoice

### Purchase Order to Inventory
1. Create PO with product items
2. Submit PO (status -> submitted)
3. Receive partial shipment (updates PO item, inventory, cost if changed)
4. Receive remaining (PO -> fully_received)
5. Verify inventory levels updated
6. Verify cost_history created if cost changed

## Edge Case Testing
- Negative inventory (receive more than expected)
- Expired quotes (auto-expire logic)
- Zero-quantity orders
- Commission splits that don't sum to 100% — `save_customer()` now rejects server-side
- Concurrent hold creation exceeding available inventory
- Bulk imports with invalid data
- PDF generation with very long product names
- Delivery for cancelled order
- Quick delivery when inventory is insufficient — `create_quick_delivery()` pre-checks with `FOR UPDATE` locks
- Invoice posting in closed accounting period — `post_invoice()` calls `check_period_open()`, raises error
- Quote acceptance releases inventory holds (deactivates without restoring qty)
- Quote decline/expiry releases inventory holds AND restores `quantity_available`
- Silent RLS failures — `checkMutationResult()` catches 0-row mutations that Supabase doesn't flag as errors
- Offline sync conflict detection — stale `snapshotAt` vs server `updated_at` returns conflict warnings
- Reconciliation checks — cross-entity data integrity (order totals, inventory ledger, invoice payments, balance formula, commission splits)

## Reconciliation Checks (Sprint 5b)

Cross-entity data integrity tests via `src/lib/reconciliation.ts`:

| Check | What it verifies | Tolerance |
|-------|-----------------|-----------|
| Order Totals | `order.total_amount == SUM(qty × price)` across line items | ±1 cent |
| Inventory Ledger | `quantity_available == SUM(received) - SUM(delivered) + SUM(returned) ± adjustments` | ±0.01 |
| Invoice Payments | `paid_amount_cents == SUM(payment_allocations)` | ±1 cent |
| Invoice Balance | `balance_cents == total - paid - prepay` (GENERATED ALWAYS sanity) | ±1 cent |
| Commission Splits | Split percentages sum to exactly 100% per order | ±0.01% |

**Test pattern:** Pure functions take typed arrays and return `Discrepancy[]` — testable without DB mocks. DB wrapper `runReconciliationChecks()` is thin: fetch + delegate.

## Operational Metrics Testing (Sprint 5a)

- `src/lib/metrics.test.ts` — 10 tests for Sentry wrapper functions
- Uses `vi.mock('@sentry/react')` with individual `mockReset()` in `beforeEach`
- Important: `vi.clearAllMocks()` only clears call history, NOT mock implementations — must use `.mockReset()` on each mock individually

## Inventory & Delivery Improvements Tests

- `src/lib/loadSheetPdf.test.ts` — 6 tests: save filename, product summary table, quantity aggregation across stops, per-stop tables, custom filename, empty stops error
- `src/components/inventory/TransactionLedgerModal.test.ts` — 3 tests: running balance computation (positive, negative, mixed quantities)
- `src/components/inventory/BatchAdjustModal.test.ts` — 3 tests: RPC call creation per item, zero-delta filtering, reason inclusion
- jsPDF mock pattern: must use `function JsPDFMock() { return mockDoc; }` (not arrow functions — arrow functions can't be `new`'d)

---

## E2E Testing Guidelines (added Mar 2026 audit)

### Current State
- **81 E2E spec files** (down from 95 after March 2026 audit removed 21 redundant, then added new specs)
- Framework: Playwright with serial test suites for workflow specs
- Auth: shared admin account by default; role tests need dedicated accounts (see below)

### Rules to Prevent Test Redundancy

1. **One spec per feature depth** — When you write a detailed interaction spec (e.g., `invoice-detail-interactions.spec.ts`), DELETE the basic "page loads" spec (e.g., `invoices.spec.ts`). Basic specs become dead weight once detailed specs exist.
2. **Never write "page loads and shows heading" tests** — These add zero value. If a page doesn't load, the detailed spec will catch it.
3. **Check for existing specs before creating new ones** — Run `ls tests/e2e/*feature*` first. If a spec already covers the feature, extend it instead of creating a new file.
4. **Mega-workflow covers the happy path** — `mega-workflow.spec.ts` covers the full quote→order→deliver→invoice→pay→return cycle. Don't duplicate these steps in other specs.
5. **Quote Builder V2 E2E** — `quote-builder-v2.spec.ts` covers all 12 V2 sprints (versioning, templates, notes pipeline, forecasting, rollover, quick quote). Uses `safeRpc()`/`safeRest()` wrappers for migration resilience. 20 serial steps with full cleanup.

### DataTable Conditional Rendering (common failure cause)

`src/components/ui/DataTable.tsx` renders `<table>` ONLY when data rows exist. When empty, it renders `<EmptyState>` instead. This means:

- `page.locator('table')` will timeout on pages with no data
- **Always use the skip guard pattern** for tests that depend on table data:

```typescript
const table = page.locator('table').first();
const hasTable = await table.isVisible({ timeout: 10000 }).catch(() => false);
if (!hasTable) {
  test.skip(true, 'No data rows available — skipping');
  return;
}
```

- For helper functions that navigate to a specific row, return `null` when no table exists and have callers skip:

```typescript
async function goToFirstRow(page: Page): Promise<boolean> {
  const table = page.locator('table').first();
  const hasTable = await table.isVisible({ timeout: 10000 }).catch(() => false);
  if (!hasTable) return false;
  await table.locator('tbody tr').first().click();
  return true;
}

// In test:
const found = await goToFirstRow(page);
if (!found) { test.skip(true, 'No rows available'); return; }
```

### Route Rename Checklist

When ANY route changes (e.g., `/payment-allocation` → `/payments`):

1. **Grep all E2E files:** search `tests/e2e/` for the old route string
2. **Check role test arrays:** `allowedRoutes` and `blockedRoutes` in `role-*.spec.ts`
3. **Check workflow specs:** any `page.goto()` or `page.waitForURL()` calls
4. **Check navigation specs:** sidebar/nav link text expectations

Route renames silently break tests because Supabase auth redirects unknown routes to Dashboard — tests appear to "pass" but are testing the wrong page.

### Role-Based Test Accounts

Role tests (`role-sales-rep.spec.ts`, `role-applicator.spec.ts`, `role-security.spec.ts`) require **dedicated Supabase accounts** with the correct role assignment:

| Env Variable | Required Role | Notes |
|---|---|---|
| `SALES_REP_EMAIL` / `SALES_REP_PASSWORD` | `sales_rep` | Must NOT be admin |
| `APPLICATOR_EMAIL` / `APPLICATOR_PASSWORD` | `applicator` | Must NOT be admin |
| `DRIVER_EMAIL` / `DRIVER_PASSWORD` | `driver` | Must NOT be admin |

Without these, tests fall back to the admin account and skip role-specific assertions (blocked pages, sidebar visibility). To create accounts:

1. Use the `create-user` Edge Function or Supabase dashboard
2. Assign the correct role in `user_profiles.role`
3. Add credentials to `.env` and CI secrets

### Sidebar Navigation Test Expectations

The sidebar uses grouped sections (not a flat list). Role tests checking sidebar text must match the current structure:
- Admin sees all groups: Operations, Financial, Compliance, Settings, etc.
- Sales rep sees: Dashboard, Customers, Quotes, Orders, Deliveries, Invoices, Payments
- Driver sees: Dashboard, Deliveries
- Applicator sees: Dashboard, Jobs

When the sidebar structure changes, grep `tests/e2e/role-*.spec.ts` for sidebar text assertions.

### Serial vs Parallel Test Suites

- **Serial** (`test.describe.serial`): Use for workflow tests where steps depend on prior state (e.g., create order → then deliver it)
- **Parallel** (default): Use for independent feature tests
- Serial tests are fragile — if step N fails, steps N+1..end all fail. Use `test.skip()` guards for steps that depend on optional data.

### Dialog Handling in Serial Suites

Use `page.once('dialog')` (not `page.on`) in serial suites to prevent listener leaks between steps:

```typescript
page.once('dialog', dialog => dialog.accept());
await page.click('button:has-text("Delete")');
```

**Note:** As of March 2026, most `window.confirm()` calls have been replaced with the shared `ConfirmModal` component. For these, use standard Playwright button clicks instead of dialog handlers:

```typescript
// For ConfirmModal-based confirmations (most actions now):
await page.click('button:has-text("Confirm")');

// For any remaining browser-native dialogs:
page.once('dialog', dialog => dialog.accept());
```

Common confirmation triggers in the app:
- **Convert Quote to Order** — ConfirmModal for duplicate order warning
- **Post Invoice** — ConfirmModal before posting
- **Complete Delivery** — ConfirmModal with item summary
- **Delete/Void actions** — ConfirmModal for destructive actions

### Modal Close Button Exclusion

When clicking product selection buttons inside modals, exclude the modal's close button:

```typescript
// BAD — matches the modal's X close button too
await page.locator('button').first().click();

// GOOD — excludes close button by aria-label
await page.locator('button:not([aria-label="Close"]):not([disabled])').click();
```

### URL Assertion Patterns

Avoid overly broad URL patterns that match intermediate routes:

```typescript
// BAD — /quotes/.+/ matches /quotes/new (false positive)
await expect(page).toHaveURL(/\/quotes\/.+/);

// GOOD — UUID pattern ensures we're on an actual record
await expect(page).toHaveURL(/\/quotes\/[0-9a-f]{8}-/);
```

### Team Board V2 Test Coverage

**Test file:** `tests/e2e/team-board-v2.spec.ts` (26 tests, serial workflow)

| Test ID | What It Tests |
|---------|--------------|
| TBV2-01 | Setup — profile ID retrieval |
| TBV2-02–05 | Today's Deliveries section rendering, card content, click navigation, tomorrow preview |
| TBV2-06 | Yesterday's Recap section (visible or hidden based on data) |
| TBV2-07 | Create note with all fields (title, content, type, priority, due date) |
| TBV2-08 | Note card priority badge display |
| TBV2-09 | Detail modal with Comments/Activity tabs |
| TBV2-10 | Add comment in Comments tab |
| TBV2-11 | Activity tab shows creation log entry |
| TBV2-12 | Pin/unpin note |
| TBV2-13–14 | Complete note → verify on Completed tab → reopen via DB |
| TBV2-15 | Edit note (change title + priority) |
| TBV2-16–18 | My Tasks, Completed, and Activity tab views with filters |
| TBV2-19–20 | Search filtering + priority filter panel |
| TBV2-21 | Stats bar metric cards |
| TBV2-22–24 | QuickTaskModal + RelatedNotes on Order and Delivery detail pages |
| TBV2-25 | Delete note with confirmation modal |
| TBV2-26 | Cleanup test artifacts from DB |

**Key patterns:**
- Delivery tests (TBV2-03/04/05) skip gracefully when no deliveries are scheduled today
- Note lifecycle uses shared state (`S` object) across serial tests
- Completed tab notes render as plain `div` (not `NoteCard`) — no inline checkboxes
- Cleanup uses soft-delete (`deleted_at`) since RLS blocks hard DELETE on `team_notes`

### E2E Test Data Protocol (MANDATORY)

**Problem:** Before this protocol, every E2E run created random entities (`TierCust-1-PE-mmrwld6k`) that were never cleaned up. This polluted the production database with hundreds of fake records that had to be manually deleted.

**Solution:** ALL test-created entities must use the `[E2E]` prefix, and Playwright's `globalTeardown` automatically deletes everything with that prefix after each run.

#### The Rules

1. **ALL test entities MUST use `[E2E]` prefix** — customers, products, vendors, team notes, everything
2. **Reuse shared fixtures** — don't create new customers/products when the shared ones work
3. **If you need unique entities** (concurrency tests, etc.), use: `${E2E_PREFIX} DescriptiveName-${runId()}`
4. **Import from `tests/e2e/fixtures/e2e-constants.ts`** — never hardcode test names
5. **NEVER create test data without the prefix** — it won't get cleaned up

#### Shared Fixtures (created by `globalSetup`, reused by all tests)

| Entity | Name | Details |
|--------|------|---------|
| Customer A | `[E2E] Farm Alpha` | Tier 1, standard workflows |
| Customer B | `[E2E] Farm Beta` | Tier 3, tier-specific tests |
| Product 1 | `[E2E] Herbicide Alpha` | $50 cost, 30% margin |
| Product 2 | `[E2E] Adjuvant Beta` | $80 cost, 25% margin |
| Product 3 | `[E2E] Fertilizer Gamma` | $30 cost, 40% margin |
| Vendor | `[E2E] Test Vendor` | Default test vendor |

Each product starts with 500 units of inventory at "Main Warehouse".

#### Usage Example

```typescript
import { E2E_PREFIX, TEST_CUSTOMER_A, runId } from '../fixtures/e2e-constants';

// ✅ GOOD — reuse shared fixture
const customers = await supabaseRest(page, 'GET',
  `customers?farm_name=eq.${encodeURIComponent(TEST_CUSTOMER_A.farm_name)}&select=id`);
const custId = customers[0].id;

// ✅ GOOD — unique entity with prefix (will be auto-cleaned)
const RUN = runId();
await supabaseRest(page, 'POST', 'customers', {
  farm_name: `${E2E_PREFIX} ConcurrencyCust-${RUN}`,
  ...
});

// ❌ BAD — no prefix, won't get cleaned up!
await supabaseRest(page, 'POST', 'customers', {
  farm_name: `RaceCust-CO-${RUN}`,
  ...
});
```

#### How Cleanup Works

1. `globalSetup` (`tests/e2e/fixtures/setup-fixtures.ts`):
   - Runs before the test suite
   - Creates shared fixtures if they don't exist (idempotent)
   - Seeds inventory for test products

2. `globalTeardown` (`tests/e2e/fixtures/teardown-fixtures.ts`):
   - Runs after the test suite completes (even on failure)
   - Deletes ALL rows where name starts with `[E2E]`
   - Respects FK constraints — deletes children before parents
   - Handles team_notes via soft-delete (RLS blocks hard DELETE)

#### File Structure

```
tests/e2e/fixtures/
├── e2e-constants.ts      # Prefix, shared entity definitions, runId()
├── setup-fixtures.ts     # globalSetup — creates shared fixtures
└── teardown-fixtures.ts  # globalTeardown — deletes ALL [E2E] data
```

---

### Inventory-Aware Test Data

Workflow tests that create deliveries must account for available inventory:
- Check inventory baselines before scheduling quantities
- Use smaller delivery quantities (e.g., 1-2 units) to avoid exceeding available stock
- The `complete_delivery` RPC enforces positive inventory — it will fail if physical stock goes negative
