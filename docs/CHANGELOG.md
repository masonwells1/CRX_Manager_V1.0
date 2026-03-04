# CRX Manager V1.0 — Development Changelog

All significant development milestones, in reverse chronological order.

---

## 2026-03-04 — Math Test Suite: All 22 Tests Passing (PR #31)

### Problem
3 tests were failing/skipping in the math E2E suite (`math-invoice-verification.spec.ts`, `math-quote-pricing.spec.ts`): IV1 (skip), IV5 (fail), IV12 (skip), QP3 (skip), QP6 (skip).

### Root Causes & Fixes

**1. InvoiceDetail loading-race (IV1, IV5, IV12)**
`InvoiceDetail.tsx` returns a pure spinner while `loading=true`. `waitForLoadState('networkidle')` fires after the Supabase fetch but before React re-renders, so tests read empty DOM and get `$0.00` for summary values. Fix: scope iteration to non-voided CS- rows + add explicit `text=Subtotal` waitFor before reading summary values.

**2. `isVisible()` vs `count()` on off-screen rows (IV1)**
CS-2026-0048 at DOM index 14 is below the scroll fold in a fixed-height table — `isVisible()` returned false even though the row was in the DOM. Fix: use `(await locator.count()) > 0`.

**3. Playwright `.or()` DOM-order pitfall (QP6)**
`text=Margin` matched `<th>Margin</th>` column header before `<p>Overall Margin</p>` in document order, causing `marginPct = 0` and QP6 to skip. Fix: use `.locator('text=Overall Margin').or(...'Avg Margin')` only.

**4. QuoteBuilder `Units Needed` input (QP3)**
Cell renders `<input type="number">` not plain text; `textContent()` returned `''`. Fix: use `inputValue()` on the input element.

### Files Changed
- `tests/e2e/math-invoice-verification.spec.ts` — IV1/IV5/IV12 fixes
- `tests/e2e/math-quote-pricing.spec.ts` — QP3/QP6 fixes
- `tests/e2e/00-seed-test-data.spec.ts` — seed spec (new)
- `docs/2026-03-03-math-test-investigation.md` — full investigation findings

### Migration
- `20260319000000_fix_trigger_functions_search_path.sql`: adds `SET search_path TO 'public'` to 11 trigger functions so `_is_admin_override()` resolves correctly when fired from security-definer RPCs

### Result
All 22 math tests pass: 12 invoice verification (IV1–IV12) + 10 quote pricing (QP1–QP10).

---

## 2026-03-03 — E2E Suite Expansion + DB Schema Fixes

### New E2E Spec Files (37 tests)
- `pricing-edge-cases.spec.ts` (12 tests): tier pricing, bulk price breaks, margin/cost validation, zero-cost guard rails
- `concurrent-operations.spec.ts` (13 tests): race conditions, double-submit prevention, RLS tenant isolation, inventory ledger consistency
- `period-close-accounting.spec.ts` (12 tests): period-close workflow, partial payments, commission tracking, balance accuracy

### DB Fixes (required to unblock tests)
- `record_invoice_payment`: rewrote to use `payments` table — `allocation_sets` had `entity_type/entity_id NOT NULL` with no defaults + `UNIQUE(entity_type, entity_id, version)` that silently broke all multi-payment scenarios
- `close_accounting_period`: fixed `delivery_date` → `scheduled_date` column reference in deliveries subquery
- `close_accounting_period`: fixed payments column reference (`amount_cents`)
- `record_invoice_payment`: fixed column name mismatch (`amount_cents`)

### Full Suite Result
- 999 passed, 30 pre-existing failures (unrelated to DB changes), 21 skipped
- 1,443 unit tests (93 files) + 626 E2E tests (102 spec files)

---

## 2026-03-02 — Quote Builder, Order Creation & PDF Fixes

### Quote Builder Improvements
- **Auto-fill rate & unit**: selecting a product now auto-populates `actual_rate` and `rate_unit` from product setup
- **Bidirectional calc mode**: new `calc_mode` toggle — `rate_acres` (rate × acres → units) vs `units_direct` (type units directly)
- **Editable Units Needed**: column is now an editable input; editing it switches to `units_direct` mode (green border indicator)
- **Price unit override**: per-item dropdown to change display price unit (e.g., price per Gal vs per Qt)
- **52 unit tests** including 24D Ester regression test verifying $3.26/acre at 16 oz/acre on 500 acres

### Order Creation Fixes
- **Auto-fill pricing**: selecting a product now pulls tier price from customer's assigned tier (tier1/2/3_price)
- **Auto-generated order numbers**: removed manual order number input; `create_direct_order()` RPC now calls `generate_order_number()` server-side
- **Order name field**: new optional "Order Name" field (e.g., "Corn Burndown") for easy identification

### Quote PDF
- **Removed profit/margin** from customer-facing PDF output
- **Updated footer** with website URL (www.croprxsolutions.com)
- **Price unit labels** shown in Price/Unit column

### Migrations (3)
- `20260302100000` — `quote_items.calc_mode` + `quote_items.price_unit` columns
- `20260302110000` — `orders.order_name` column + updated `create_direct_order()` RPC
- `20260302120000` — updated `save_quote()` RPC with bidirectional calc_mode support

---

## 2026-03-16 — Additional Audit Gap Remediation

### RPC Hardening (migration `20260316200000`)
- `apply_write_off`: added `p_idempotency_key` parameter with `check_idempotency`/`save_idempotency` guards
- `batch_apply_prepayments`: added `p_idempotency_key` parameter with idempotency guards
- `generate_finance_charges`: added admin role check (`profiles.role = 'admin'`) at RPC entry

### Frontend Fixes
- **WriteOffModal**: replaced `parseFloat` with `parseDollarsToCents()` for IEEE 754-safe money handling; passes idempotency key to RPC
- **PrepayWorkspace**: replaced `parseFloat * 100` with `parseDollarsToCents()`; passes idempotency key to `batch_apply_prepayments`
- **BulkTicketUpload**: added error checks on two fire-and-forget inserts (`blend_ticket_images`, `ocr_processing_queue`)
- **ReceivingLog**: added `checkMutationResult()` to bulk delete with `.select()` validation
- **Invoices**: added error/null check on `.single()` customer fetch in batch PDF print

---

## 2026-03-01 — Inventory & Delivery Improvements (branch `feature/inventory-delivery-improvements`)

### Load Sheet / Pick List PDF
- New `src/lib/loadSheetPdf.ts` — generates warehouse pick list PDF for scheduled deliveries
- Product summary table aggregates quantities across all stops by product name
- Per-stop tables show delivery number, customer, items with quantities and tote numbers
- "Load Sheet" button added to Deliveries page header
- 6 unit tests in `loadSheetPdf.test.ts`

### Inventory Transaction Ledger
- New `src/components/inventory/TransactionLedgerModal.tsx` — full transaction history per product
- Shows date, type (received/delivered/adjusted/returned/transferred/booked), quantity, running balance, performer, notes
- Color-coded type icons and positive/negative quantity formatting
- Inline FileText icon button next to each product name in inventory table
- `computeRunningBalance()` pure function with 3 unit tests

### Batch Inventory Adjustments
- New `src/components/inventory/BatchAdjustModal.tsx` — apply uniform adjustment to selected products
- Checkbox column added to inventory table for multi-selection
- "Adjust N Selected" button appears in header when items selected
- Preview list shows current → new quantities before confirmation
- Uses `adjust_inventory` RPC with idempotency keys per item
- `buildAdjustmentCalls()` pure function with 3 unit tests

### Vendor-Grouped Reorder Alerts
- Low-stock section redesigned: "ACTION REQUIRED" heading with vendor grouping
- Products grouped by vendor using `Map<string, InventoryRow[]>`
- Shows available qty, reorder point, on-order, and shortfall per product
- "Needs Reorder" filter chip with count badge filters table to low-stock items only

### Inventory Valuation Display
- New "Inventory Value" summary card (7th card) showing `SUM(qty × unit_cost)` with currency format
- "Unit Cost" and "Value" columns added to inventory table (admin-only)
- `current_cost` field added to inventory query from products table

- Net result: 1,433 unit tests (92 files), all passing
- Commits: `8b84db9` through `9785041` (5 commits)

---

## 2026-03-01 — E2E Coverage Sprint (branch `claude/add-playwright-tests-DjMo6`)

- Added 23 new Playwright E2E spec files with 165 test cases, all passing
- **Part 1 — New Feature Coverage (5 files, 43 tests):**
  - `prepayment-manager-crud.spec.ts` (10): Split Check modal, bucket system, batch apply
  - `prepay-workspace.spec.ts` (10): Split-panel allocator, customer selection, two-phase commit
  - `tote-tracking.spec.ts` (8): Cross-page tote # on NewDelivery, DeliveryDetail, ReceivingLog, InvoiceDetail
  - `rup-compliance-warnings.spec.ts` (7): RUP banners on QuoteBuilder, NewDelivery, DeliveryDetail, Compliance
  - `finance-charge-fix.spec.ts` (8): Non-compounding finance charges on AR Aging
- **Part 2 — Previously Uncovered Pages (18 files, 122 tests):**
  - ar-aging, application-records, commission-payments-crud, crop-programs, cycle-counts, delivery-remainders, quick-receive, returns-crud, rebates-page, new-delivery-page, new-order-page, new-purchase-order, purchase-order-detail, invoice-list-page, field-detail, job-detail, vehicle-detail, inventory-page
- Net result: 84 E2E spec files, 589 total E2E tests, 1,380 unit tests (88 files at that time)
- Commits: `88b6086` (tests), `99c4d2d` (audit prompt), `61f38df` (test plan)

---

## 2026-02-28 — Audit Remediation (4 phases, 21 tasks, branch `feature/audit-remediation`)

### Phase 0: Finance Charge + Billing Split Fixes
- Fixed finance charge compounding to exclude prior finance charges from the base amount
- Added `FOR UPDATE` row-level locking on billing splits to prevent concurrent modification

### Phase 1: Tote Tracking (Tasks 2-8)
- Added `tote_number` and `is_non_returnable` columns to `delivery_items` schema
- Threaded tote number through `complete_delivery` and `create_quick_delivery` RPCs
- Added tote # input on NewDelivery, display on DeliveryDetail with non-returnable badge
- Added Tote # column to delivery PDF export

### Phase 2: RUP Compliance (Tasks 9-14)
- Built `rupCompliance.ts` helper with 6 unit tests — checks license expiry, certification type, product registration
- Added amber RUP warning banners to QuoteBuilder, NewOrder, NewDelivery, DeliveryDetail
- Added RUP audit logging to `financial_audit_log` on order/delivery creation
- Enhanced Compliance page filter chips with count badges and red "Overdue" highlighting

### Phase 3: Prepay Bucket System (Tasks 15-20)
- Added `bucket_label` column to `prepay_credits` with 8 seeded categories
- Created `apply_prepay_to_invoice()` and `batch_apply_prepayments()` RPCs with `FOR UPDATE` locking
- Built PrepayWorkspace page — split-panel allocator with two-phase commit pattern
- Added Split Check modal to PrepaymentManager for bucket-based check entry
- Added sidebar nav + route for PrepayWorkspace
- Net result: 50 pages, 92 migrations, 1,380 unit tests (88 files), all passing
- Commits: `6beef0c` through `e6c3477` (10 commits)

---

## 2026-02-28 — Go-Live Hardening (5 sprints, branch `feature/go-live-hardening`)

### Sprint 1: Foundation Hardening
- **1a:** `crypto.randomUUID` for idempotency keys (replaces Math.random fallback), retry-safe `useIdempotentAction` hook, `db.ts` multi-tab session recovery via `detectSessionFromOtherTabs()`
- **1b:** Server-authoritative quote math — `calculate_quote_totals()` RPC using `NUMERIC(15,4)`, client calculation is display-only hint
- Commits: `c80bc3d`, `28b8a4e`

### Sprint 2: Error Handling & Notifications
- Notification failure tracking: `failed_at` + `retry_count` columns on notifications table
- Read-path error handling: silent fallback prevents cascading UI crashes
- Commit: `22b930b`

### Sprint 3: Security & Testing Infrastructure
- **3a:** Delivery signature privacy — `create_signed_url()` RPC for time-limited access, no public bucket URLs
- **3b:** RLS integration contract tests — per-role verification (admin, sales_rep, driver, applicator) for orders, invoices, deliveries, commissions
- **3c:** Schema integrity live DB tests — FK constraints, enum values, generated columns, RLS enabled check
- Commits: `f421869`, `7640636`, `e5d70eb`

### Sprint 4: Code Quality & CI
- **4a:** Shared `runCriticalAction()` helper — consistent try/catch/toast pattern replacing scattered error handling
- **4b:** Fixed all `react-hooks/exhaustive-deps` ESLint warnings
- **4c:** E2E smoke tests added to CI workflow, fixed TDZ declaration ordering issues
- Commits: `322e2aa`, `5994e2c`, `33ff198`

### Sprint 5: Observability & Data Integrity
- **5a:** Operational metrics via `src/lib/metrics.ts` — Sentry user context on login/logout, navigation tracking via headless `NavigationTracker` component, business event tracking (order_created, quote_created, quote_converted_to_order)
- **5b:** Cross-entity reconciliation checks via `src/lib/reconciliation.ts` — 5 pure check functions (order totals, inventory ledger, invoice payments, invoice balance formula, commission splits) + DB wrapper `runReconciliationChecks()`
- Net result: 1,374 unit tests (87 files), all passing. Build clean.
- Commits: `7e33267`, `91314c4`

---

## 2026-02-27 — Business Logic Audit Fixes
- SQL migration `20260312200000`: inventory hold auto-release trigger (declined/expired/accepted), `post_invoice()` period enforcement, `save_customer()` commission split validation, `create_quick_delivery()` inventory pre-check with FOR UPDATE locks, `convert_quote_to_order()` explicit hold release
- Added `checkMutationResult()` silent RLS failure detection on 13 pages
- Offline sync conflict detection via `snapshotAt` / `entityTable` / `entityId` fields
- Realtime subscription `disabled` prop — prevents null-filter subscriptions
- InventoryPage `freeQty` formula fix (subtracts prebooked from available)
- Updated 3 test files (offlineSync, useRealtimeSubscription, businessLogicEnhancements) — 1,121 tests all passing
- Commits: `f1278ab`

## 2026-02-25 — Test Suite Audit & Coverage Expansion
- Audited all 67 unit test files — zero stale imports, zero dead tests
- Removed duplicate `pdfGeneration.test.ts` (894 lines, duplicated by 3 individual PDF test files)
- Added 11 new unit test files: SignatureCanvas, ActivityFeed, CommentsSection, 8 bulk import components
- Net result: 80 test files, 1,121 unit tests (all passing)
- 60 math & business logic verification E2E tests
- 95 real UI interaction E2E tests across 10 pages
- 14 new test files closing coverage gaps (47 unit + 68 E2E tests)
- Fixed 41 of 42 pre-existing E2E test failures
- Commits: `fdaa08c`, `5bc6213`, `447576f`, `7527206`

## 2026-02-24 — Test Coverage Gap Closure (8 sprints)
- Sprint 1: reportPdf.test.ts + deliveryPdf.test.ts (35 tests)
- Sprint 2: offlineQueue.test.ts (30 tests, fake-indexeddb)
- Sprint 3: useUnsavedChanges, useRealtimeSubscription, useOCRProcessor hooks (40 tests)
- Sprint 4: AuthContext.test.tsx (30 tests)
- Sprint 5-6: 9 modal test files (90 tests)
- Sprint 7: imageCompression + sentry (25 tests)
- Sprint 8: bulk-operations.spec.ts E2E (31 tests)
- Fixed login() helper in tests/e2e/utils/auth.ts for session persistence
- Commit: `6fe06a0`

## 2026-02-24 — useRowSelection Bug Fix
- Fixed infinite re-render loop — useEffect compared data by reference (always new)
- Removed broken useEffect, derived selectedCount from selectedRows.length
- Commit: `12ec850`

## 2026-02-24 — Bulk Select/Delete/CSV/PDF Export
- Session 1 (6 pages): Products, Customers, Jobs, Quotes, PurchaseOrders, BlendTickets
- Session 2 (9 pages): Orders, Vehicles, Fields, Returns, ReceivingLog, InventoryPage, Invoices, Deliveries, Payments
- Pattern: useRowSelection → createCheckboxColumn → BulkActionBar → BulkDeleteConfirmModal
- Soft delete for Returns/Invoices, hard delete for others
- 12 files changed, 824 insertions, 111 deletions
- Commits: `d52d910`, `f571196`

## 2026-02-23 — TypeScript Strict Type Cleanup
- Fixed all 148 TypeScript strict type errors → 0 remaining
- Key fixes: Supabase join casts, jsPDF types, React Router v7 Blocker, DataTable generics
- Removed `continue-on-error: true` from CI — typecheck now enforced
- Commit: `6a98a92`

## 2026-02-23 — CI Pipeline Fix
- Fixed 47 ESLint errors blocking CI
- Updated ESLint config: `varsIgnorePattern: '^_'`
- Fixed Vitest CI crash with Supabase env var fallbacks
- Added `npm run lint` to pre-commit hook
- CI now GREEN — all 4 steps pass
- Commits: `73d779e`, `a97882d`, `af90ebf`

## 2026-02-23 — Documentation Cleanup
- Removed 17 stale .md files from repo
- Rewrote README.md with accurate stats
- Added Feature Inventory table to CLAUDE.md
- Fixed stale references across CLAUDE.md, TESTING.md, DEPLOYMENT.md

## 2026-02-23 — Lint Cleanup
- Eliminated all 507 ESLint errors → 0 remaining
- 95 files changed: catch(err: any) → catch(err: unknown), typed all `any`, removed unused imports
- Commit: `22f9c86`

## 2026-02-23 — Codebase Audit & Hardening
- Sprint A: 4 new test files + 17 convertToGlLb tests
- Sprint B: Defensive null guards in quoteCalc, deliveryPdf, invoicePdf, etc.
- Sprint C: 7 uncaught promise chains fixed, AuthContext session hardening
- Sprint D: Security hardening in pagePermissions, notificationTriggers, realtime, queries
- Sprint E: Lint/formatting cleanup
- 24 files changed, 1,267 lines added/changed
- Commit: `9b3d70b`

## 2026-03-04 — Quick Receive Feature
- 3-step wizard: vendor+products → auto-match to oldest open POs → confirm
- `match_quick_receive_items()` RPC

## 2026-02-28 to 2026-03-03 — Safety Audit & Business Logic Hardening
- Page permissions, notification triggers, E2E gate tests

## 2026-02-27 — Sprint 20: Delivery Integrity & Quick Delivery
- Two-step confirm→complete flow, items locked to order, quick delivery modal
- `create_quick_delivery()` atomic RPC

## 2026-02-26 — Sprint 19: Receiving System Enhancement
- Per-item receiving (condition/lot/notes), receiving dashboard, receiving PDF

## 2026-02-25 — Sprint 18: Delivery System Enhancement
- Edit/cancel/reassign, driver issue reporting, photos (10 max), delivery remainders, batch cancel

## 2026-02-24 — Sprint 17: Year-End Customer Summary
- PDF: financials, products, acreage, YoY comparison

## 2026-02-23 — Sprint 16: Unified Payment Allocation
- New PaymentAllocation page, auto-allocate, prepay application

## 2026-02-22 — Sprint 15: Batch Operations
- Batch void, batch print, batch statements, auto-apply prepayments

## 2026-02-21 — Sprint 14: Grower Share Transparency
- Per-grower $/acre pricing in quote builder

## 2026-02-20 — Sprint 13: Finance Charge Intelligence
- Preview, grace periods, opt-out per customer

## 2026-02-19 — Sprint 12: Invoice & Statement PDF Redesign
- 3 invoice layouts, dual-mode statements, matching Chem-Man format

## 2026-02-17 — T3-002: Comprehensive Test Coverage
- 766 unit tests (45 files) + 31 E2E spec files

## 2026-02-17 — OCR Parser Overhaul & Edge Function v4
- Multi-line field support, look-behind value matching

## 2026-02-16 — Bulk Field Import
- Shapefile/KML/GeoJSON wizard with proj4 reprojection

## 2026-02-14 to 2026-02-18 — Sprints 7-11: CheMan Gap Closure
- Vehicles, Jobs, Application Records, Reports (14 total), Month-End Close, Commission Payments, Financial Workflows

## 2026-02-13 — Phase 4B: Mapbox Maps
- Satellite imagery, field polygon drawing, acreage auto-calc

## 2026-02-11 — 109-Defect Forensic Audit Fix (Sprints 0-6)
- Fixed all 109 defects from Claude forensic audit

## Earlier — Foundation
- Tier 1-3 hardening complete
- ChatGPT audit (18 issues) complete
- Initial build by Bolt, then claimed by user
