# CRX Manager V1.0 — Development Changelog

All significant development milestones, in reverse chronological order.

---

## 2026-04-04 — Blend Ticket Enhancement Suite (E1–E10)

### E1+E10: Per-Product Confidence Display + Low-Confidence Highlight
- Products with confidence < 70% get yellow background + "Low confidence — verify" pill
- Products with 70-89% show yellow "review" pill with progress bar
- High confidence shows green pill; manually corrected products show green "Verified" badge

### E2: Raw OCR Text Viewer
- Collapsible "Raw OCR Text" panel at bottom of BlendTicketDetail
- Shows the full extracted text in monospace for debugging bad OCR

### E4: One-Click Order Linking from Suggestion Banner
- Suggestion banner now includes a "Link" button for instant order linking
- No need to open the link modal — single click directly from the suggestion

### E6: Duplicate Ticket Detection
- "Dup" badge on BlendTickets list page for tickets sharing a ticket_number
- Detail page warning now includes a clickable link to the duplicate ticket

### E7: Reprocess OCR Available on Any Ticket
- Relaxed guard from `source === 'ocr' && review_status === 'unreviewed'` to `source === 'ocr'`
- Can now re-run OCR on already-approved/rejected tickets

### E8: Blend Math Validation (already existed)
### E9: Quick Filter Chips
- "Needs Review (N)" / "Low Confidence (N)" / "Duplicates (N)" filter chips above table
- "Clear Filters" button to reset all filters at once

---

## 2026-04-04 — F14 + E3: Alert→Task + Batch Reject Blend Tickets

### F14: Alert → Task Conversion
- One-click "Create Task" button on every Action Queue item
- Opens QuickTaskModal pre-filled with alert context (entity type, ID, title)
- Auto-assigns to current user, priority set to 'high' for overdue/cancelled items
- Added 'invoice' and 'product' to LinkedEntityType union

### E3: Batch Reject Blend Tickets
- New "Batch Reject" button in BlendTickets bulk action bar (next to existing Batch Approve)
- New RPC: `batch_reject_blend_tickets()` mirrors approve pattern with idempotency
- ConfirmModal confirmation before rejecting
- Activity logging for batch rejections

---

## 2026-04-04 — Tier 1: Office Speed + Money Visibility

### Feature 1: Global Command Palette
- Added `Ctrl+K` / `Cmd+K` global command palette for instant search
- Searches across pages (fuzzy), customers, orders, invoices, deliveries, products
- Tracks recent page visits in localStorage for quick access
- New RPC: `global_search()` for server-side entity search
- New components: `CommandPalette.tsx`, integrated into `AppLayout.tsx`

### Feature 2: Transaction Thread Cross-Links
- New `TransactionThread` component shows full pipeline: Quote → Order → Delivery → Invoice
- Integrated into OrderDetail, QuoteBuilder, DeliveryDetail, InvoiceDetail
- Each step is clickable; current page is highlighted in crx-green
- Multiple deliveries/invoices show as dropdown with count
- No new migrations — uses existing FK relationships

### Feature 3: Workflow Guardrails
- Credit limit soft-block on NewOrder and InvoiceDetail (uses existing `credit_limit_cents`)
- Stale quote warning on QuoteBuilder conversion (>30 days old)
- Overloaded driver warning on NewDelivery (5+ deliveries on same date)
- New hook: `useGuardrails.ts` with `useCreditLimitCheck`, `useStaleQuoteCheck`, `useOverloadedDriverCheck`
- New component: `GuardrailBanner.tsx` — reusable warning/danger banner with dismiss
- All warnings are soft blocks — admin can always proceed

### Feature 4: Customer 360 View Enhancement
- New `CustomerSummaryBar` component: 5 KPI cards (AR balance, orders, deliveries, tier, last activity)
- New Timeline tab on CustomerDetail showing chronological activity feed
- Quick action buttons: New Quote, New Order, Sched. Delivery (pre-fills customer)
- New RPC: `get_customer_summary()` returns all 5 KPIs in one call
- Season-aware counts (Oct 1 – Sep 30)

### Feature 5: Dashboard Action Queue
- New `ActionQueue` component replaces passive Operational Alerts on Dashboard
- Each item is specific and clickable — shows entity number, customer, and details
- Collapsible categories: Overdue Invoices, Cancelled+Posted, Overdue Deliveries, Low Stock, Expiring Quotes, Unassigned Deliveries
- "Dismiss for today" per item (sessionStorage, resets on reload)
- New RPC: `get_dashboard_action_items()` returns specific entity details per category

---

## 2026-03-31 — Workflow Gaps Remediation: Broken Connections + Billing Splits + Dispatch

### Summary
Five-phase migration session fixing workflow gaps across blend tickets, invoicing, field billing, dispatch, and crop history tracking. Adds a new Dispatch Board page.

### New Page
- **DispatchBoard** (`/dispatch`) — Map-based dispatch view for job scheduling with applicator assignment

### New Table
- **field_crop_history** — Tracks multi-year crop rotation per field per season with auto-snapshot trigger

### New RPCs
- `create_invoice_from_blend_ticket(p_blend_ticket_id, p_created_by, p_idempotency_key)` — creates draft invoice from approved blend ticket
- `get_field_billing_splits_for_order(p_order_id)` — returns billing splits for order fields
- `get_field_billing_splits_for_blend_ticket(p_blend_ticket_id)` — returns billing splits for blend ticket fields
- `create_split_invoices_from_order(p_order_id, p_salesman_id, p_invoice_type, p_idempotency_key)` — creates proportional split invoices

### Modified RPCs
- `create_application_record_from_blend_ticket` — now returns `uuid[]` (one record per field) instead of single `uuid`

### New Triggers
- `sync_blend_ticket_payment_status()` — auto-syncs payment_status when invoice voided
- `snapshot_field_crop_history()` — auto-snapshots crop_type changes to field_crop_history

### New Columns
- `blend_ticket_products.unit_cost_cents`, `blend_ticket_products.unit_price_cents`
- `blend_tickets.job_id` (FK to jobs)
- `quote_sections.field_id` (FK to fields)
- `invoices.invoice_group_id` (groups split invoices)
- `jobs.priority`, `jobs.estimated_hours`

### Migrations (5)
- `20260335000000` — Phase 1: broken connections (blend ticket cost/price, multi-field app records, job linkage)
- `20260335100000` — Phase 2: blend ticket invoicing + payment status sync trigger
- `20260335200000` — Phase 3: field billing splits + split invoice creation
- `20260335300000` — Phase 4: dispatch columns (priority + estimated hours on jobs)
- `20260335400000` — Phase 5: crop history table + auto-snapshot trigger

### Stats
- Page count: 58 → 59
- Migration count: 226 → 231
- RPC count: ~148 → ~153
- Table count: 88 → 89

---

## 2026-03-30 — Field Management V2: Dashboard + Map Layer System

### Summary
Major field management upgrade implementing Approach 2 from the brainstorm: reusable CRXMap component with pluggable layer architecture, new Field Dashboard page, and Fields list improvements.

### New Components (7 map components)
- **CRXMap** — reusable map wrapper with base layer switching (satellite/roads/hybrid/terrain), GPS locate, print mode
- **LayerToggle** — layer picker UI for CRXMap
- **LocateMe** — GPS button using browser Geolocation API
- **AddressSearch** — Mapbox geocoding search bar for address/coordinate lookup
- **FieldBoundaryLayer** — filled polygon overlay for field boundaries with labels
- **FieldMarkerLayer** — centroid markers for fields without boundaries (filters out fields with boundaries)
- **DrawLayer** — wrapper around DrawControl with auto-acreage calculation via turf.js

### New Page
- **FieldDashboard** (`/fields/:id/dashboard`) — read-only field profile with 4 tabs:
  - Overview: season summary cards (total apps, acres treated, products) + activity timeline
  - Applications: full history table with weather details, expandable rows, CSV export
  - Billing: visual split bar + per-grower details with price overrides
  - Details: FSA numbers, legal description, notes, timestamps, activity log

### New RPC
- **get_field_dashboard(p_field_id, p_season)** — aggregates field data, application records, season stats, and activity feed in a single server-side query

### Fields List Improvements
- Upgraded from MapContainer+FieldMarkers to CRXMap+FieldBoundaryLayer+FieldMarkerLayer
- Added customer and active/inactive status filter dropdowns
- Added stats bar (field count, total acres, boundary count)
- Enabled layer toggle and GPS locate on map view
- Row/marker click now navigates to Field Dashboard

### Stats
- Page count: 57 → 58
- Migration count: 224 → 225
- RPC count: ~146 → ~147
- Tests: 1,719 passing (111 files)

---

## 2026-03-29 — Blend Ticket Phase 1: OCR Bridge

### Summary
Phase 1 implementation for the blend ticket system — aligning the existing schema with the full lifecycle data model, adding multi-field/multi-customer support, configurable OCR thresholds, and several UX improvements for the OCR review workflow.

### Schema Changes (6 migrations)
- **app_settings** — Extended with `description` and `created_at` columns; seeded OCR confidence threshold
- **blend_ticket_fields** — New table for per-field application tracking with multi-customer billing support
- **blend_tickets** — Added `applicator_id` (FK→profiles), `vehicle_id` (FK→vehicles), `source` enum
- **batch_approve_blend_tickets** — New RPC for bulk ticket approval
- **check_duplicate_blend_ticket** — New RPC for duplicate detection
- **save_blend_ticket_fields** — New RPC for saving field assignments (pending subagent)

### Frontend Changes
- **Configurable OCR thresholds** — `useOCRThresholds` hook + `OCRThresholdSettings` component on Settings page; replaces hardcoded 70/50 values
- **Per-field confidence badges** — Color-coded dots (green/yellow/red) next to each product's confidence score
- **Raw OCR text viewer** — Collapsible `<details>` section showing raw Google Vision output
- **Re-process OCR button** — Allows re-running OCR on ticket images with ConfirmModal
- **Duplicate detection** — Yellow warning banner when another ticket with same number+date exists
- **Auto-suggest order match** — Blue info banner suggesting matching confirmed orders based on shared products
- **Batch approve** — Checkbox selection + batch approve from list page (subagent)
- **Multi-field entry UI** — Field assignments with customer override and planned acres (subagent)

### Types
- Added `BlendTicketSource`, `BlendTicketField`, extended `AppSetting` and `BlendTicket` interfaces

### Context
- All 10 open questions from the 2026-03-23 brainstorm answered
- Key decisions: no mixer role (all roles can mix), single ticket with per-field customer assignments (Q6-B), skip Chem Man detection for Phase 1
- Full plan: `docs/plans/2026-03-29-blend-ticket-phase1-implementation.md`

---

## 2026-03-26 — Full Documentation Sweep

### Summary
Systematic audit and fix of all project documentation. Compared every doc file against the actual codebase and fixed all discrepancies found.

### Fixes Applied
- **CLAUDE.md** — Edge Functions 6→7 (added `reset-user-password`), updated date, fixed E2E count (82→83), added missing statuses to all lifecycles (quote: `cancelled`, order: `voided`, invoice: `unposted`/`cancelled`), corrected "Tables WITHOUT updated_at" list (removed 8 tables that actually have the column), updated `orders.total_paid`/`balance_due` note from "DEPRECATED" to "DROPPED"
- **UI_PATTERNS.md** — Fixed `logActivity()` example from wrong positional args to correct object parameter format, updated page count (56→57)
- **QUOTE_TO_DELIVERY.md** — Added missing statuses: quote `cancelled`, order `voided`, invoice `unposted` and `cancelled`
- **SAFE_DEVELOPMENT_RULES.md** — Updated page count (56→57)
- **migration-history.md** — Added 6 missing entries (#198-203), renumbered entries #204-219 to match
- **project-details.md** — Updated page count (48→57)
- **TEST_COVERAGE_ANALYSIS.md** — Updated test counts (104→110 files, 1629→1713 tests, 82→83 E2E)

---

## 2026-03-26 — Fix TypeScript/DB Type Mismatches (A16)

### Summary
Removed deprecated `balance_due` and `total_paid` fields from the `Order` TypeScript interface. These columns were dropped from the database in migration `20260332100000` but the TypeScript type still included them. Also confirmed that 4 of the original 6 reported mismatches (WriteOff.reversed_by, InvoiceLineAllocation.invoice_id, Commission.season nullable) had already been fixed in prior sessions. Updated ROADMAP to mark A16 and A17 as complete.

### Changes
- `src/types/index.ts` — Removed `balance_due: number` and `total_paid: number` from `Order` interface
- `docs/ROADMAP.md` — Marked A16 and A17 as Done

---

## 2026-03-23 — Edit Scheduled Delivery Items

### Summary
Added the ability to edit delivery items (add, remove, adjust quantities) while a delivery is still in the `scheduled` status. Previously, items were permanently locked to the original order, requiring cancellation and recreation if any product couldn't be delivered. Now sales reps can quickly swap out unavailable products without losing the rest of the delivery.

### How It Works
- **Scheduled deliveries**: Full item editing — +/- quantity buttons, remove item (red X), "Add item from order" dropdown
- **In-progress deliveries**: Items remain locked (no change to existing behavior)
- **Removed items**: Stay on the order's `quantity_remaining` and appear automatically for future deliveries
- **Validation**: Backend validates quantities against `order_items.quantity_remaining` minus what other active deliveries have scheduled

### Changed Files
- **`supabase/migrations/20260334200000_edit_delivery_items_when_scheduled.sql`** — Replaces `edit_delivery()` RPC to process `p_items` when scheduled
- **`src/pages/DeliveryDetail.tsx`** — Edit mode now shows interactive item controls for scheduled deliveries
- **`CLAUDE.md`** — Updated Hard Red Line and delivery lifecycle to reflect new rule
- **`docs/workflows/SAFE_DEVELOPMENT_RULES.md`** — Updated business logic rule
- **`docs/workflows/QUOTE_TO_DELIVERY.md`** — Updated delivery rules section

### Business Rule Change
- **Old rule**: "NEVER allow editing delivery item quantities — locked to original order"
- **New rule**: "Items editable while scheduled; locked once in_progress or beyond"

---

## 2026-03-21 — Order Print Feature: Order Summary + Pick List PDFs

### Summary
Added print functionality for orders — both a customer-facing Order Summary and a warehouse Pick List with inventory shortage warnings. Eliminates the workaround of creating/cancelling deliveries just to get a printable product list.

### New Files
- **`src/lib/orderSummaryPdf.ts`** — Customer-facing order summary PDF (order details, items with pricing, excludes internal cost/margin)
- **`src/lib/orderSummaryPdf.test.ts`** — 21 unit tests
- **`src/lib/orderPickListPdf.ts`** — Warehouse pick list PDF with ordered/delivered/remaining columns, inventory availability, and shortage warnings highlighted in red
- **`src/lib/orderPickListPdf.test.ts`** — 23 unit tests

### Modified Files
- **`src/pages/OrderDetail.tsx`** — Added "Print Summary" and "Print Pick List" buttons in action bar (available for all order statuses)
- **`src/pages/Orders.tsx`** — Added "Print Summaries" and "Print Pick Lists" bulk actions (select multiple orders, generate multi-page PDFs)

### Bug Fix
- **`save_customer` FK violation** — Applied migration to fix `save_customer` RPC that crashed when editing customers with deliveries (FK constraint on `customer_addresses`). Now uses smart upsert instead of delete-all.

### Stats
- 1,713 unit tests (110 files), all passing
- 0 lint errors, build clean

---

## 2026-03-20 — Mega Logic Audit Phase 1 & 2 Fixes (12 RPCs + 6 Frontend)

### Summary
Comprehensive logic audit found 105+ issues across 8 domains. Phase 1 (Critical) and Phase 2 (High) fixes applied — 12 RPC functions fixed and 6 frontend files corrected.

### SQL Fixes (12 RPCs)
- **get_ar_aging** (FIN-1): Include `overdue` invoices in AR aging, not just `posted`
- **get_monthly_summary** (FIN-5): Fix commission cents conversion (`commission_amount * 100`), include overdue in AR, add order status/deleted filters
- **financial_dashboard_summary** (FIN-1/12/13): Include overdue AR, filter cancelled/deleted orders from revenue/profitability, add deleted_at filter to AR queries
- **apply_prepay_to_invoice** (XD-2): Update `customers.prepay_balance_cents` when applying prepay, allow overdue invoices, auto-pay when balance reaches 0
- **cancel_delivery** (DEL-1): Add missing `save_idempotency()` call — was checking but never saving
- **generate_finance_charges** (XD-3): Fix season calculation from `>= 7` to `>= 10` (October, not July)
- **allocate_payment** (XD-6): Add `financial_audit_log` entry for payment allocations
- **convert_quote_to_order** (INV-1): Release inventory holds (`is_active = false`) when converting planned quote to order
- **create_invoice_from_order** (FIN-4): Filter out already-invoiced order items, delete empty invoices
- **update_order_items** (ORD-3/4): Recalculate cost_per_unit, profit, net_margin on same-product edits + order-level totals
- **save_quote** (QTE-1): Preserve `is_planned` and `section_header_notes` in both UPDATE and INSERT paths
- **void_invoice** (FIN-6): Cancel pending commissions when no active invoices remain for the order

### Frontend Fixes (6 files)
- **Returns.tsx** (FE-1): CSV export divides `total_credit_cents` by 100 for dollars
- **Invoices.tsx** (FE-2): CSV export divides `total_amount_cents` and `balance_cents` by 100
- **Orders.tsx** (XD-5/7, FE-11): Add `.is('deleted_at', null)` filter, change hard delete to soft delete, fix regex replace for status badges
- **Quotes.tsx** (XD-9): Add `.is('deleted_at', null)` filter
- **CustomerDetail.tsx** (XD-5): Add `.is('deleted_at', null)` to both order queries

### Migrations
- `20260333800000_drop_inventory_qty_available_check.sql` — Drop CHECK constraint blocking negative inventory (INV-4)
- `20260333900000_mega_audit_phase1_fixes.sql` — 7 full RPC definitions + documentation for 5 large RPCs applied directly

### Stats
- 2 new migrations (213 → 215), 12 RPCs fixed, 6 frontend files modified
- 1,653 unit tests passing, 0 lint/TS errors, CI green

### Audit Reference
- Full audit: `docs/audits/2026-03-20-mega-logic-audit.md` (105+ issues found)
- Phase 3 (Medium) fixes applied in same session (see below)

---

## 2026-03-20 — Mega Logic Audit Phase 3 Fixes (26 Frontend Files)

### Summary
Phase 3 (Medium priority) sweeps across 6 categories, fixing consistency issues found in the mega logic audit. All frontend-only changes — no new SQL migrations.

### Soft Delete Filtering Sweep (8 files)
Added `.is('deleted_at', null)` to queries that were missing it:
- **Reports.tsx** — Customer profitability + revenue queries (also added status filter for confirmed/fulfilled)
- **NewDelivery.tsx** — Orders lookup
- **Rebates.tsx** — Orders lookup
- **NewOrder.tsx** — Duplicate order check
- **Returns.tsx** — Customer orders query
- **QuoteBuilder.tsx** — Duplicate order warning
- **Customers.tsx** — Open invoices check (also added `overdue` status)
- **CustomerContextCard.tsx** — Orders count

### CSV Export Formatting Sweep (4 files)
Used `fmtCSV()` for proper dollar formatting in CSV exports:
- **PrepaymentManager.tsx** — prepay_balance_cents, unpaid_balance_cents
- **CommissionPayments.tsx** — total_amount (dollars, not cents)
- **PaymentHistory.tsx** — amount_cents
- **ARaging.tsx** — statement export amount_cents, running_balance

### parseDollarsToCents Sweep (7 files)
Replaced `Math.round(parseFloat(x) * 100)` with `parseDollarsToCents()` to avoid floating-point bugs:
- **CustomerDetail.tsx**, **FieldDetail.tsx**, **InvoiceDetail.tsx**, **NewVendorBill.tsx** (3 instances), **PrepaymentManager.tsx** (3 instances), **Rebates.tsx**, **VendorBillDetail.tsx**

### Missing logActivity Sweep (4 files, 6 critical operations)
Added audit logging to 6 critical financial operations that were missing it:
- **MonthEndClose.tsx** — `close_accounting_period`, `reopen_accounting_period`
- **Deliveries.tsx** — `batch_cancel_deliveries`, `batch_reschedule_deliveries`, `reassign_delivery`
- **WriteOffModal.tsx** — `apply_write_off`
- **FinanceChargePreviewModal.tsx** — `generate_finance_charges`

### Reconciliation Function Fix (2 files)
- **reconciliation.ts** — Fixed `checkInventoryLedger` to handle all 11 transaction types (was only handling 6). Fixed `booked` incorrectly subtracting from `quantity_available` (it only affects `quantity_prebooked`). Added: `job_applied`, `cancelled_delivery_reversal`, `void_delivery_reversal`, `prebooked`, `released`.
- **reconciliation.test.ts** — 8 new tests for all transaction type behaviors including comprehensive combined test

### Stats
- 0 new migrations, 26 files modified, 1,658 unit tests passing (was 1,653)
- 0 lint/TS errors, build clean

---

## 2026-03-19 — Transaction Ledger Fix + Outstanding PO Tab + HelpTip Expansion (Night Session)

### Changes
- **Transaction Ledger sign logic fix** (`TransactionLedgerModal.tsx`): The `computeRunningBalance()` function was summing raw positive quantities instead of applying sign based on transaction type. Booked/delivered/prebooked/job_applied now correctly shown as negative (subtracts from inventory), while received/returned/released/reversals show as positive. New `signedQuantity()` function matches `reconciliation.ts` logic. Running balance now accurately reflects inventory position.
- **Outstanding PO Items tab** (`PurchaseOrders.tsx`): New "Outstanding Items" tab showing all PO line items not yet fully received across all vendors. Grouped by vendor with columns: PO#, Product, Ordered, Received, Remaining, Value, PO Status, Expected Date. Overdue items highlighted in red. Summary cards for total items, qty, value, vendor count, and overdue count. Vendor filter dropdown. CSV and PDF export.
- **HelpTip expansion**: Added contextual help tooltips to 8 more pages: InventoryPage, Products, PurchaseOrderDetail, QuickReceive, ReceivingLog, CycleCounts, CropPrograms, DeliveryRemainders
- **Getting Started page major expansion**: From 3 section cards to 9 expandable guide sections covering: Quote Building (6 steps), Planned Programs & Inventory Holds, Managing Orders, Deliveries (two-step flow), Supplier POs, Inventory Management, Invoicing & Payments, Reports & Analytics, Common Mistakes, Pro Tips, and Roles & Permissions matrix. Role-aware (drivers see simplified version).
- **Updated tests**: TransactionLedgerModal tests rewritten for new sign logic — 20 tests covering all 11 transaction types, real-world scenario matching screenshot data, and edge cases

### Stats
- 0 new migrations, 0 new RPCs, 0 new tables
- 12 files modified, 1653 unit tests passing, build clean

---

## 2026-03-19 — Launch Readiness UX (Evening Session)

### Changes
- **HelpTip component** (`src/components/ui/HelpTip.tsx`): Reusable click-to-show contextual help popover with HelpCircle icon
- **Getting Started page** (`/getting-started`): Role-aware workflow guide — admin/sales see Quote→Order→Deliver stepper, drivers see Dashboard→Deliver stepper. Sidebar link with BookOpen icon
- **Enhanced empty states**: Quotes, Orders, Deliveries, and TeamBoard pages now show workflow guidance and action buttons when empty
- **~26 contextual help tips** across QuoteBuilder (8), OrderDetail (4), DeliveryDetail (6), TeamBoard (4), and list pages (3) — business-process explanations for planned programs, delivery completion, signatures, invoicing, etc.
- **DataTable column headers**: Now accept ReactNode (not just string) to support inline HelpTip components
- **RLS security fix**: Deny-all policy on `rate_limit_log` table (migration `20260333700000`)
- **New migration:** `20260333700000_rate_limit_log_rls.sql`

### Stats
- 1 new page, 1 new component, 3 new tests, 1 migration
- 12 files modified across pages and components

---

## 2026-03-19 — Pre-Production Audit Fixes (7 Issues)

### Changes
- **Fix broken routes**: Added `/customers/new` and `/fields/new` routes in App.tsx — both were navigating to non-existent routes, silently redirecting to dashboard
- **QuickDeliveryModal error handling**: Added try/catch + Sentry logging to product/driver fetch — was silently showing empty lists on network error
- **ManualTicketCreate validation**: Added customer_id required check before save — was allowing blend tickets with null customer
- **BulkProductImport margin bug**: Removed broken `num > 1 ? num/100 : num` auto-normalization heuristic — was corrupting margins like 1.5 (150%). Now stores raw value and shows warnings for values > 1
- **BulkProductImport tier validation**: Added non-blocking warnings for inverted tier pricing (tier1 > tier2) and below-cost pricing
- **QuickDeliveryModal optional invoice**: Added "Create draft invoice" checkbox (ON by default) + confirmation dialog before submit. Previously auto-created invoice with no user choice and no confirmation
- **Migration 20260333600000**: Updated `create_quick_delivery` RPC with `p_skip_invoice boolean DEFAULT false`, fixed missing `save_idempotency()` call (idempotency was check-only, never saved), fixed `search_path` missing `pg_temp`

### Files Modified
- `src/App.tsx` — 2 new route entries
- `src/components/deliveries/QuickDeliveryModal.tsx` — error handling, checkbox, confirm dialog
- `src/components/blendtickets/ManualTicketCreate.tsx` — customer validation
- `src/components/products/BulkProductImport.tsx` — margin fix + tier warnings
- `supabase/migrations/20260333600000_quick_delivery_optional_invoice.sql` — new migration

---

## 2026-03-18 — Fix 5 RPCs Missing p_idempotency_key (PostgREST Schema Cache Errors)

### Root Cause
Five RPCs were created AFTER the idempotency injection (20260306200000) and consolidation (20260331600000) migrations, so neither pass added `p_idempotency_key` to their signatures. The frontend sends this parameter on every call, and PostgREST matches by exact parameter names — causing "Could not find function in schema cache" errors.

### Migration: 20260333300000_fix_missing_idempotency_params.sql
- **reverse_receiving_record** — Added `p_idempotency_key`, restored `set_config('app.reversal_rpc_active')` for trigger safety
- **void_payment** — Added `p_idempotency_key` with full idempotency check/save
- **edit_prepay_credit** — Added `p_idempotency_key` with full idempotency check/save
- **delete_prepay_credit** — Added `p_idempotency_key` with full idempotency check/save
- **batch_post_invoices** — Recreated entirely (was dropped in 20260311200000 and never recreated). Now returns `jsonb` with `{ success, count, total_cents }`
- All functions: `SET search_path = public, pg_temp` for security
- Verification block ensures exactly 1 overload per function

### Audit Methodology
- Searched all `supabase.rpc()` calls passing `p_idempotency_key` in frontend (71 call sites)
- Cross-referenced with latest SQL function definitions in migrations
- Filtered out RPCs already handled by the consolidation migration (20260331600000)
- Identified 5 RPCs created post-consolidation that were never swept into any fix pass

---

## 2026-03-18 — Full Sales Cycle Live UI Test + Bug Fixes

### Live Browser Test (Playwright)
- Tested complete sales cycle: Quote → Order → Delivery → Invoice → Payment → Partial Return
- Used [E2E] test fixtures only — no real data touched
- All financial integrity verified: inventory tracking, invoice balance, payment allocation
- All test data cleaned up after completion

### Bug Fix: Returns Product Select (Returns.tsx)
- **Bug:** Product select `onChange` handler called `updateItem()` 3 times sequentially, each spreading from stale closure `newItems`. React 18 batching meant only the last `setNewItems` won, losing `product_id` and `product_name`
- **Fix:** Batched all field updates into a single `setNewItems` call
- **Impact:** Product selection in New Return modal was silently failing — selected product would revert to empty

### Migration: Fix save_quote Idempotency + Activity Feed Columns (20260333100000)
- Fixed `save_quote()` RPC with wrong `idempotency_keys` column names (`key`→`idempotency_key`, `entity_type`/`entity_id`→`operation`/`result`)
- Fixed `v_server_totals` field aliases (`.sum`→`.total_price`)
- Fixed `activity_feed` column names (`action`→`event_type`, `entity_type`→`related_entity_type`, `entity_id`→`related_entity_id`)
- Added `pg_temp` to search_path

---

## 2026-03-17 — Code Quality Enforcement (Phase 1-4)

### assertRpcResult Final Sweep (28+ violations → 0)
- Added assertRpcResult() to all remaining RPC data casts across 30+ files
- Files: ARaging, CustomerDetail, Compliance, FieldDetail, Fields, InventoryPage,
  NewOrder, QuoteBuilder, ReceivingLog, SalesReports, ManualTicketCreate,
  FinanceChargePreviewModal, LogbookReport, TodaysDeliveries, YesterdayRecap,
  WorkloadView, RelatedNotes, CustomerContextCard, BulkTicketUpload,
  BulkFieldImport, CustomerTransactionReview, CycleCounts, Dashboard,
  MonthEndClose, NewDelivery, NewPurchaseOrder, OrderDetail,
  PurchaseOrderDetail, Reports, Returns

### Idempotency Key Gaps (5 → 0)
- Added p_idempotency_key to: BulkFieldImport (save_field, save_field_geometry),
  ReceivingLog (reverse_receiving_record), notificationTriggers
  (log_failed_notification, notify_damaged_receiving)

### Local ESLint Plugin (2 rules)
- `require-assert-rpc-result`: blocks .rpc() data usage without assertRpcResult()
- `no-direct-sentry-import`: blocks direct @sentry/react imports
- `no-console` tightened: console.warn no longer allowed
- Lives in `eslint-local-rules/` — works on all machines via git pull

### logActivity Type Safety
- Refactored from 6 positional string params to single typed object (LogActivityParams)
- Updated all 57 call sites across 23 files
- TypeScript compiler now catches parameter-shift bugs

### Safety-Net Unit Tests (+3 tests)
- assertRpcCoverage.test.ts — scans for .rpc() data usage without assertRpcResult
- sentryImportEnforcement.test.ts — scans for direct @sentry/react imports
- logActivitySignature.test.ts — verifies logActivity uses typed object params

---

## 2026-03-17 — Code Audit Phase 2: assertRpcResult + Sentry + Safety Fixes (7 files)

### assertRpcResult Coverage (Phase 2 — 7 more files, ~20 RPC calls)
- Added `assertRpcResult()` to read & mutation RPCs that were casting `data` without null guard
- **Dashboard.tsx** — `operational_dashboard_summary`
- **FinancialDashboard.tsx** — `financial_dashboard_summary`
- **QuickReceive.tsx** — `match_quick_receive_items` + `receive_po_items`
- **AccountsPayable.tsx** — `get_ap_dashboard_summary` + `get_ap_aging`
- **Reports.tsx** — 8 RPCs: `get_bottom_line_pnl`, `get_gross_sales_report`, `get_customer_balance_listing`, `get_commission_balance_report`, `get_chemical_history`, `get_inventory_cost_report`, `get_batch_year_end_summaries`, `get_customer_year_end_summary`
- **QuoteBuilder.tsx** — `save_quote` + `create_quote_version` (×2 locations)
- **MonthEndClose.tsx** — `get_monthly_summary` + `get_batch_year_end_summaries`

---

## 2026-03-17 — Comprehensive Code Audit & Hardening (29 files, +1053/-107)

### assertRpcResult Coverage (~30 RPC calls)
- Added `assertRpcResult()` to mutation RPC calls across 18 pages/components to catch silent RLS permission denial (data=null). Carefully excluded void-returning RPCs that would false-positive
- Files: NewOrder, NewPurchaseOrder, NewVendorBill, QuickDeliveryModal, JobDetail, Invoices, InvoiceDetail, Deliveries, DeliveryDetail, CommissionPayments, PaymentHistory, PrepayWorkspace, PrepaymentManager, FinanceChargePreviewModal, OrderDetail, FieldDetail, SettingsPage, CustomerDetail

### ConfirmModal Replacement (9 pages)
- Replaced all bare `confirm()`/`window.confirm()` calls with proper `ConfirmModal` component per project rules
- Files: DeliveryDetail (2), OrderDetail (1), CycleCounts (3), Rebates (2), ARaging (2), CommissionPayments (1), InvoiceDetail (1), JobDetail (3), PaymentAllocation (1)

### Idempotency Key Wiring (15 RPC calls)
- Added `useIdempotencyKey` hooks and `p_idempotency_key` params to 15 frontend RPC calls
- Files: FieldDetail (save_field, save_field_geometry), SettingsPage (admin_update_profile), OrderDetail (void_order), JobDetail (load_recipe_into_job), CustomerDetail (save_customer), QuoteBuilder (create_planned_holds, save_quote_template, create_quote_from_template, rollover_quote_to_season, create_quote_version ×2, restore_quote_version), DeliveryDetail (reassign_delivery)

### DB Migration: `20260320100000_add_idempotency_to_remaining_rpcs.sql`
- Added `p_idempotency_key text DEFAULT NULL` to 5 RPCs: save_field, save_field_geometry, admin_update_profile, void_order, load_recipe_into_job
- Each function explicitly rewritten (no pg_get_functiondef + regex anti-pattern)
- DROP old signature → CREATE new → GRANT → verify no overloads

### Bug Fixes
- **Returns.tsx** — Removed references to non-existent `updated_at` column on `returns` table (lines 314, 343)
- **teardown-fixtures.ts** — Fixed reference to non-existent `entity_id` column on `idempotency_keys` table
- **Rebates.tsx** — Fixed `keyof ProgramRow` type error (strict tsconfig.app.json compatibility)

### Infrastructure
- **eslint.config.js** — Added `CRX_Manager_V1.0` to ignores to exclude stale nested directory copy that was causing 100+ false lint errors
- **Test mocks** — Added `assertRpcResult` to test mocks for FinanceChargePreviewModal and QuickDeliveryModal

### Audit Findings (logged for future sessions)
- ~50 mutation handlers across 21 files missing `logActivity()` audit trail calls
- 6 TypeScript/DB type mismatches: Order has dropped columns (balance_due, total_paid, created_by), WriteOff missing reversed_by, InvoiceLineAllocation missing invoice_id, Commission.season should be nullable
- `rate_limit_log` table should get explicit deny-all RLS policy for consistency

---

## 2026-03-16 — Code Quality Session: Sentry Migration, A11y, Safety-Net Tests

### Error Reporting
- **Sentry migration** — Migrated ~30 remaining `console.error` calls to `Sentry.captureException` across components, hooks, edge functions, and contexts. Now all production errors route to Sentry for visibility
- **Test update** — Updated `useOCRProcessor.test.tsx` to mock `@sentry/react` instead of `console.error` (ESM-compatible `vi.hoisted` pattern)

### Accessibility
- **click-events-have-key-events** — Fixed all 13 remaining jsx-a11y warnings with `role="button"`, `tabIndex={0}`, and `onKeyDown` handlers (BulkFieldImport, CustomerContextCard, CropPrograms, Deliveries, Products, QuoteBuilder, TeamBoard, BulkPOImport, YesterdayRecap, DeliveryDetail)

### Safety-Net Tests
- **Function overload detection contracts** — 42 critical functions listed; validates no duplicates, all snake_case, all mutating RPCs covered
- **Mutating RPC idempotency contracts** — 28 RPCs that must accept `p_idempotency_key`; validates critical business RPCs are covered
- **SECURITY DEFINER pg_temp contracts** — 38 functions requiring `pg_temp` in search_path; validates overlap with mutating RPCs

### Commission Audit Trail
- **Reports.tsx** — Replaced direct `.update()` commission mark-paid with `create_commission_payment` RPC for proper audit trail (creates payment record, payment items, updates status, logs to `financial_audit_log`)

---

## 2026-03-16 — Overnight Session: DB Security, Code Quality, Delivery Features

### Phase A: Database Housekeeping
- **A1: pg_temp search_path fix** — Migration `20260332800000` uses `ALTER FUNCTION` to add `pg_temp` to search_path on ALL SECURITY DEFINER functions. Verification block confirms zero functions remain unpatched. Prevents temp schema hijacking attacks
- **A2: Data validation & cleanup** — Migration `20260332900000` fixes negative inventory quantities, recalculates prebooked from actual pending orders, verifies commission splits sum to 100%, checks invoice paid_amount_cents integrity, fixes invalid commission statuses. All checks passed clean on production

### Phase B: Code Quality Sprint
- **B1: runCriticalAction migration** — Migrated ~47 pages from bare `try/catch + console.error` to centralized `runCriticalAction()` pattern (toast + Sentry.captureException). Also replaced `console.error` with `Sentry.captureException` in 3 lib files (activityLogger, notificationTriggers, imageCompression)
- **B2: Skeleton loading states** — Added animated skeleton placeholders to 10 high-traffic list pages (Orders, Deliveries, Invoices, Products, Customers, Quotes, PurchaseOrders, Returns, ARaging, InventoryPage)
- **B3: Firefox E2E** — Added Firefox project to `playwright.config.ts`, updated CI to install both Chromium and Firefox browsers
- **B4: CSP tightening** — SKIPPED: Mapbox GL JS and Google Fonts both inject inline styles; `unsafe-inline` must stay in `style-src`
- **Accessibility lint** — Added `eslint-plugin-jsx-a11y` with 18 cherry-picked rules at `warn` level (avoided `recommended` spread due to minimatch compatibility crash with flat ESLint config)
- **ESLint no-console tightened** — Removed `'error'` from allowed console methods; only `console.warn` now permitted

### Phase C: Delivery Features
- **C1: Delivery Calendar View** — New `DeliveryCalendar.tsx` component using `@fullcalendar/react` with dayGrid + interaction plugins. Status-based color coding (blue=scheduled, amber=in_progress, green=completed, gray=cancelled). List/Calendar toggle on Deliveries page
- **C2: Email opt-out** — Added checkbox "Email delivery receipt to customer" (default: checked) to both driver (dark theme) and admin (light theme) completion UIs in DeliveryDetail. Email sending gated by checkbox state
- **C3: In-app notifications** — New `notifyDeliveryCompleted()` function in `notificationTriggers.ts`. Notifies admins, assigned driver, and sales reps from linked order commissions. Deduplicates notifications

### Phase D: Stretch Goals
- **D1: Request correlation IDs** — Custom fetch wrapper in `db.ts` adds unique `X-Request-ID` header to every Supabase request. Sentry breadcrumbs recorded with requestId for full request tracing
- New dependencies: `@fullcalendar/react`, `@fullcalendar/daygrid`, `@fullcalendar/interaction`, `eslint-plugin-jsx-a11y`

---

## 2026-03-16 — Team Board V2 Phase 2 (Escalation, Context, Workload)

- **F5: Escalation Engine** — `StaleTasksAlert` component surfaces overdue tasks with 3 visual tiers: amber (1-3d), red (3-7d), critical (7d+ with pulse animation). Collapsible summary with counts. Sorted most overdue first
- **F9: Customer Context Cards** — `CustomerContextCard` on customer-linked notes shows tier, AR aging, open orders, and last delivery date. Module-level `Map` cache prevents N+1 queries
- **F7: Workload Visibility tab** — new "Workload" tab on Team Board calls `get_team_workload()` RPC. Color-coded cards (green/amber/red) with expandable detail grid per team member
- Migration: `20260316950000_team_board_phase2.sql` — adds `last_escalated_at` to `team_notes`, creates `get_team_workload()` RPC
- New files: `StaleTasksAlert.tsx`, `CustomerContextCard.tsx`, `WorkloadView.tsx`
- Updated `TeamBoard.tsx` with new tab + escalation alert on Board view
- Updated `NoteCard.tsx` to render customer context inline
- Added `last_escalated_at` to `TeamNote` TypeScript interface

---

## 2026-03-16 — Infrastructure Hardening (Quick Wins)

- **A1: Unhandled rejection safety net** — `window.addEventListener('unhandledrejection', ...)` in `main.tsx` catches async errors that bypass React ErrorBoundary, reports to Sentry
- **A7: ESLint `no-console` rule** — warns on `console.log`/`info`/`debug`, allows `error`/`warn`. Zero existing violations, purely preventive
- **A3: Sentry sourcemap uploads** — installed `@sentry/vite-plugin`, `sourcemap: 'hidden'` generates maps without exposing to users. Plugin uploads to Sentry then deletes from `dist/`. Only active when `SENTRY_AUTH_TOKEN` env var is set (Vercel CI)
- **A5: Per-route error boundaries** — enhanced `ErrorBoundary` with `inline` prop for compact in-page error UI. Added `RouteShell` wrapper in `App.tsx` so page crashes don't take down sidebar navigation. 2 new unit tests
- Design doc: `docs/plans/2026-03-16-infrastructure-hardening-design.md`

---

## 2026-03-16 — Forensic Audit & Idempotency Fix Round 3

- **Forensic audit** — 6-agent parallel audit of entire codebase: RPC column names, migration ordering, frontend-DB alignment, TypeScript types, table headers, RPC parameters
- **CRITICAL FIX: Idempotency column references (round 3)** — 58 broken references across 16 migration files. Migrations created after the round 1 fix re-introduced `key` (should be `idempotency_key`), `entity_type`/`entity_id` (should be `operation`/`result`), and `result_id` (should be `result`). New migration `20260332700000` fixes all with safety-net scan + self-testing verification block.
- **FIX: Quotes.tsx CSV/PDF export** — `customer_name` key changed to `customer` to match Supabase join shape
- **FIX: SalesReports.tsx PDF header** — "Price" changed to "Unit Price" to match CSV and DataTable headers
- **FIX: TypeScript type drift** — Added `program_notes`, `balance_due`, `total_paid` to Order interface; `pdf_template_id`, `pdf_columns_override` to Quote interface; new `ArReminderTracking` interface
- **Prevention: 3-layer defense** — Pre-commit hook validates SQL for wrong idempotency patterns, full audit script (`scripts/validate-sql-migrations.sh`), Claude Code PreToolUse hook blocks bad patterns at write-time
- Migration: `20260332700000_fix_idempotency_column_refs_round3.sql`

---

## 2026-03-16 — Quote Builder V2 E2E Test Suite

- **New E2E spec** `tests/e2e/quote-builder-v2.spec.ts` — 20 serial steps covering all 12 V2 sprints
- Tests: quote creation, versioning, section header notes, planned programs, PDF templates, quote templates, notes pipeline flow, inventory forecasting, seasonal rollover, "New from Last Quote" quick create
- Uses `safeRpc()`/`safeRest()` wrappers for resilience against unapplied V2 migrations
- Full cleanup in Step 20 — deletes all created quotes, orders, and templates
- All 20/20 tests passing, 2.5 min runtime

---

## 2026-03-16 — Quote Builder V2 (Sprints 8-12: Notes Flow, Forecasting, Rollover, Quick Quote)

- **Sprint 8: Notes Pipeline Flow** — Notes now flow through the full quote→order→delivery pipeline. `order_items.notes` column added for per-line product notes copied from quote_items. `orders.program_notes` column added for aggregated section header notes. Load sheet PDF shows notes column when present. Migration: `20260316700000_notes_pipeline_flow.sql`
- **Sprint 9: Customer Detail Quotes Tab** — Enhanced with planned programs filter and `is_planned` badge for easy identification of crop programs vs one-off quotes
- **Sprint 10: Inventory Forecasting** — New Inventory Forecasting tab on Inventory page showing planned demand vs supply with gap alerts. New `get_inventory_forecast()` RPC aggregates planned demand by product/month. Migration: `20260316800000_inventory_forecasting.sql`
- **Sprint 11: Seasonal Program Rollover** — `rollover_quote_to_season()` RPC duplicates a quote with updated pricing for a new season. "Roll Over" button added to QuoteBuilder for quick season transitions. Migration: `20260316900000_seasonal_rollover.sql`
- **Sprint 12: Quick Quote from Customer** — "New from Last Quote" button on Customer page creates a new quote pre-populated from the customer's most recent quote. `customer_id` URL param on QuoteBuilder auto-sets the customer on load

---

## 2026-03-16 — Quote Builder V2 (Sprint 1: Product Internal Notes)

- **New `internal_notes` column** on `products` table — internal-only notes, never shown to growers
- **Relabeled "Notes"** to **"Grower Description"** on ProductDetail page with helper text
- **New "Internal Notes"** textarea on ProductDetail page with helper text ("Internal only — never shown to growers")
- Existing `notes` data auto-copied to `internal_notes` during migration — zero breaking changes
- 3 new unit tests for the internal notes field
- Migration: `20260316100000_product_internal_notes.sql`

---

## 2026-03-16 — New Order: Per-Line Margin Calculation + Editable Price Override

- **Per-line margin display** on New Order page — each line item shows Total, Profit ($), and Margin (%) with color-coded thresholds (green ≥20%, amber 10-20%, red <10%)
- **Editable price per unit** with override detection — amber highlight and "price overridden" indicator when price differs from customer tier
- **Reset to tier price** button (RotateCcw icon) — appears on overridden items, tooltip shows the tier price it resets to
- **Order Totals summary card** — aggregate total, profit, and margin for the entire order
- **Customer swap recalculates all prices** — clears overrides and recalculates to the new customer's tier
- **Product swap clears override** — fresh start with the new product's tier price
- No DB migration needed — `order_items.price_per_unit` already stores the effective price
- Mirrors the exact pattern from the Quote Builder editable price feature

---

## 2026-03-16 — Quote Builder Editable Price/Unit with Auto Margin Recalc

- **Editable price/unit** in Quote Builder — price input is now a number field instead of static text
- **Price override detection** — typing a price different from the tier price highlights the field amber and shows a reset button
- **Auto margin recalc** — profit, margin %, $/acre, and quote totals all update instantly when price is overridden
- **Reset to tier price** button (RotateCcw icon) appears on overridden items, tooltip shows the tier price
- **Override sticks** through rate/acres changes but resets on product swap or customer tier change
- **Existing quote detection** — loading a saved quote detects overridden prices by comparing saved price vs tier price
- No DB migration needed — `quote_items.price_per_unit` already stores the effective price

---

## 2026-03-15 — Bug Sweep Branch Review & Type Drift Fixes

### TypeScript Type Drift (verified against DB schema)
- **InvoiceStatus**: added `paid` | `overdue` to match DB CHECK constraint (from `20260312100000`)
- **CommissionPayment.status**: added `voided` to match DB CHECK constraint (from `20260331120000`)
- **Invoice badge maps**: added `paid` (info) and `overdue` (error) entries in `InvoiceDetail.tsx` and `Invoices.tsx`

### Idempotency Column Fix Round 2 (migration `20260332200000`)
- 10 RPCs had wrong `idempotency_keys` column names re-introduced by March 31 migrations
- Fix: `key` to `idempotency_key`, `result_id` to `result` (with jsonb cast), `entity_type`/`entity_id` to `operation`/`result`

### Branch Review Findings (claude/final-bug-sweep-RnKBF)
- **Rejected**: Deleting E2E fixture files, removing CLAUDE.md rules, search_path fixes (not needed), ConfirmModal doc reverts

---

## 2026-03-16 — Fix Commission Payment RPCs (migration `20260332600000`)

- Fixed `create_commission_payment` and `void_commission_payment` RPCs crashing due to non-existent `updated_at` column on `commissions` table (found by deep audit). Added SQL validation pre-commit hook and Claude Code PreToolUse hook to prevent similar bugs.

---

## 2026-03-16 — Fix receive_po_items Crash + Expand Audit Log CHECK Constraints (migration `20260332500000`)

### receive_po_items RPC — crash on UPDATE
- `receive_po_items` was crashing because it referenced `updated_at` on `purchase_order_items`, which does not have that column
- Fix: removed `updated_at = now()` from the UPDATE statement

### financial_audit_log — missing operation_type values
- CHECK constraint was missing 5 values used by existing code: `invoice_marked_overdue`, `prepay_reconciliation`, `batch_prepay_apply`, `blend_ticket_linked`, `blend_ticket_unlinked`
- Any INSERT using these values would throw a constraint violation
- Fix: expanded operation_type CHECK constraint to include all 5 missing values

### financial_audit_log — missing entity_type value
- `blend_ticket` was absent from the entity_type CHECK constraint
- Fix: added `blend_ticket` to entity_type CHECK constraint

---

## 2026-03-16 — Comprehensive Audit Log & Admin Override Fix (migration `20260332400000`)

### cancel_delivery — admin_override ordering bug
- `SET LOCAL app.admin_override = 'true'` was positioned AFTER the order status re-evaluation block
- Reverse transitions (e.g. `fulfilled → confirmed`) were blocked by `_enforce_order_status_transition` trigger
- Fix: moved admin_override to BEFORE any status updates

### mark_overdue_invoices — wrong column names + NULL actor
- Used `event_type`, `performed_by`, `metadata` instead of `operation_type`, `actor_user_id`, `new_values`
- Passed NULL for actor (cron context), violating NOT NULL constraint on `actor_user_id`
- Fix: correct column names + explicit system admin UUID for cron context

### link/unlink_blend_ticket — wrong column names
- Same wrong column pattern as mark_overdue_invoices (`event_type`/`performed_by`/`metadata`)
- Fix: rewritten with correct `operation_type`/`actor_user_id`/`new_values` columns

### Safety-net trigger for 20 other functions
- 20 additional RPCs omit `actor_user_id` from financial_audit_log INSERTs
- They rely on `DEFAULT auth.uid()` which works from frontend but fails from pg_cron/direct SQL
- Fix: BEFORE INSERT trigger `trg_fill_audit_actor` on financial_audit_log fills NULL actor_user_id with auth.uid() or admin fallback

---

## 2026-03-16 — void_delivery Fix & Fake Data Cleanup

### void_delivery RPC — 4 bugs fixed (migration `20260332300000`)
- **Bug 1**: `quantity` column reference → `total_units_needed` (column was renamed in earlier migration but void_delivery never updated)
- **Bug 2**: Missing `app.admin_override` for reverse status transitions (fulfilled→confirmed blocked by trigger)
- **Bug 3**: `financial_audit_log` INSERT missing `actor_user_id` (NOT NULL violation under SECURITY DEFINER)
- **Bug 4**: `idempotency_keys` wrong column names (`key`→`idempotency_key`, `result_id`→`result`)
- All 4 bugs masked each other — Bug 1 failed first, hiding bugs 2-4

### Fake Data Cleanup
- Removed "A9 Test Farm CSV" customer and all child records (2 orders, 2 deliveries, 18 jobs, 6 applicator licenses, 8 rebate claims, 5 application records)
- Inventory corrected: Start Right 2.0 Tote (+265 available released), Start Right 2.0 2.5G (+10 available released)

---

## 2026-03-16 — Audit Remediation, Idempotency Fixes, Overdue Detection

### Audit Triage & Branch Cleanup
- Verified 24 audit findings across 3 reports — 17 were already fixed or false positives
- Deleted stale branches: `claude/final-bug-sweep-RnKBF`, `claude/analyze-test-coverage-eb1h9`, plus 20 additional stale remote branches
- Realtime null-filter finding: FALSE POSITIVE (guarded by `disabled` flag)
- Commission recipients hardcoding: LOW priority (has "Other..." workaround)

### confirm_delivery Idempotency Fix (migration `20260316300000`)
- Consolidation migration added `p_idempotency_key` parameter but never wired up `check_idempotency`/`save_idempotency` logic
- Frontend was already passing the key (DeliveryDetail.tsx:550) but server ignored it
- Drivers on mobile with spotty connections could create duplicate activity_feed + notification entries

### Invoice Overdue Auto-Detection (migration `20260316115721`)
- New `mark_overdue_invoices()` batch function: scans posted invoices past due_date → transitions to 'overdue'
- Logs each transition to `financial_audit_log` with invoice details
- Naturally idempotent — safe to call from cron/scheduler repeatedly

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

## 2026-03-15 — UX Polish, ConfirmModal, Parallelized Queries, Coverage Reporting

### Replace window.confirm() with ConfirmModal (PRs merged)
- All `window.confirm()` and `confirm()` calls across the app replaced with the shared `ConfirmModal` component
- Provides consistent styled confirmation dialogs instead of browser-native popups
- Covers: Convert Quote to Order, Post Invoice, Complete Delivery, Delete/Void actions

### Parallelize Database Queries (PR merged)
- Orders page and Deliveries page now run independent Supabase queries in parallel instead of sequentially
- Reduces page load time for data-heavy list views

### Accessibility: Aria-labels on Product Filters (PR merged)
- Added `aria-label` attributes to category and vendor filter `<select>` elements on Products page

### Vitest V8 Coverage Reporting
- Added Vitest V8 coverage provider for visibility-only reporting (no enforcement gates)

### 4 Quick-Win Bug Fixes from Branch Audit
- Various small fixes discovered during orphaned branch audit

### E2E Test Suite Hardening
- Eliminated all remaining E2E test skips and fixed 12 failing tests
- Fixed `useToast()` destructuring in team board components

---

## 2026-03-15 — Team Board V2: Delivery Bulletin, Entity Linking, Photo Attachments

### Database (Migration 20260315200000)
- Added `linked_entity_type` + `linked_entity_id` to `team_notes` for entity linking
- New `team_note_attachments` table with RLS policies
- New `team-note-attachments` storage bucket with upload/view/delete policies
- 3 new RPCs: `get_team_board_deliveries()` (role-aware), `get_yesterday_delivery_recap()`, `get_notes_for_entity()`

### Frontend — 8 New Components in `src/components/team/`
- `TodaysDeliveries.tsx` — role-aware delivery bulletin (today + tomorrow preview, unassigned alert)
- `YesterdayRecap.tsx` — completion summary with issue cards (auto-expands when issues exist)
- `NoteCard.tsx` — extracted from TeamBoard monolith, priority/overdue badges, entity badge
- `EntityBadge.tsx` — clickable pill badge linking to 6 entity types (delivery, order, customer, job, PO, quote)
- `QuickTaskModal.tsx` — create entity-linked tasks from any detail page
- `RelatedNotes.tsx` — collapsible card showing linked notes on detail pages
- `NotePhotoUpload.tsx` — camera capture + multi-file upload to Supabase storage
- `NoteAttachments.tsx` — thumbnail grid with view/delete support

### Integration — QuickTaskModal + RelatedNotes on 5 Detail Pages
- OrderDetail, DeliveryDetail, JobDetail, CustomerDetail, PurchaseOrderDetail
- "Create Task" button + "Team Notes" collapsible section on each page

### TeamBoard.tsx Updates
- Board tab now shows: Today's Deliveries → Your Tasks → Pinned & Announcements → Yesterday's Recap → three-column grid
- Entity linking fields in create/edit modal
- Photo attachments in detail modal
- Entity badges on note cards

### E2E Tests
- `tests/e2e/team-board-v2.spec.ts` — 26 serial tests covering all V2 features
- 23 passing, 3 skip gracefully when no deliveries scheduled

---

## 2026-03-09 — Fix: Tab-Switch No Longer Resets Page Data

### AuthContext (`src/contexts/AuthContext.tsx`)
- `onAuthStateChange` now filters by event type — `TOKEN_REFRESHED` silently updates the session without setting `loading: true`
- `INITIAL_SESSION` events are skipped (already handled by `getSession()` on mount)
- Only real auth changes (`SIGNED_IN`, `SIGNED_OUT`) trigger the full loading state
- `signIn` and `signOut` wrapped in `useCallback` for stable references
- Context value wrapped in `useMemo` to prevent unnecessary child re-renders

### Why
- Supabase's JS client automatically refreshes tokens when the browser tab regains focus
- The old code set `loading: true` on every auth event, which caused `ProtectedRoute` to unmount the entire page tree
- This destroyed all unsaved form data, scroll position, and local component state
- Now only actual sign-in/sign-out events cause a full reload — token refreshes are invisible to the user

---

## 2026-03-09 — Farm Group Labels on Orders & Deliveries

### Orders List Page (`src/pages/Orders.tsx`)
- Customer column now shows blue "Farm Group: [Parent Name]" label for linked customers
- Expanded Supabase query to fetch `parent_customer_id`, batch-resolves parent farm names
- Search bar includes `farm_group_name` so staff can search by parent farm

### Deliveries List Page (`src/pages/Deliveries.tsx`)
- Same farm group label on Customer column in admin data table
- DriverCard (mobile driver view) shows blue farm group label under customer name
- Unassigned delivery cards also display the label
- Search bar includes `farm_group_name` for filtering
- Both main and unassigned delivery queries fetch parent customer info

### Why
- `parent_customer_id` existed on `customers` table but was only used in Sales Reports
- Warehouse staff had no visual way to know which orders/deliveries belong to the same farm group
- This is a read-only display change — no logic or billing changes

---

## 2026-03-09 — Product Setup UX Improvements

### New: Combobox Component (`src/components/ui/Combobox.tsx`)
- Reusable dropdown with type-to-filter + accept new values (no external dependencies)
- Keyboard navigation (ArrowUp/Down/Enter/Escape), click-outside-to-close, ARIA attributes
- Matches Input.tsx styling; uses `onMouseDown` with `preventDefault()` to prevent blur/click race

### ProductDetail Page Restructure
- **Combobox dropdowns** for Vendor, Manufacturer, Category — fetches distinct values from existing products on mount, still accepts free-text new entries
- **Removed `unit_size`** from form — legacy field replaced by `container_size` + `container_unit` (data preserved in DB)
- **Grouped sections** with dividers and helper text: Product Form → Container (size+unit+type in one row) → Inventory Unit → Application Rates
- No SQL migration needed (UI-only changes)

---

## 2026-03-08 — Order Editing, Admin Corrections, Transaction Ledger Expansion

### Add Products to Existing Orders in Edit Mode
- Admin can now add new products to an existing order via the product modal in edit mode
- Handles inventory prebooked adjustments correctly when swapping products

### Admin Corrections & Reversal Capabilities (Phases 1-3)
- Admin-only capabilities for correcting and reversing posted transactions
- Multi-phase rollout for safe, auditable corrections

### Transaction Ledger Expansion
- Transaction ledger now shows customer name, reference info, and full notes per transaction
- Added missing FK constraints for transaction ledger joins

### Orders Page Improvements
- Fixed fulfillment progress bar showing 0% for all orders
- Added "Planned" / "Committed" label to orders
- Fixed customer search on Orders page

### Bug Fixes
- `cancel_order` used invalid transaction_type `cancelled_order_release` — fixed
- `cancel_delivery` used invalid transaction_type `prebook_released` — fixed
- `update_order_items` used `quantity_prebooked` instead of `quantity_remaining` — fixed
- `create_direct_order` calling non-existent `next_order_number()` — fixed
- `create_direct_order` using wrong column name `commission_split` — fixed
- Clamped `commission_amount` to 0 when order profit is negative
- `complete_delivery` pre-check + PO edit on partially received orders — fixed

---

## 2026-03-08 — Track A: Complete Email Integration

### Email Infrastructure (built earlier same day)
- `email_log` table (audit trail with idempotency), `ar_reminder_tracking` table (dedup)
- `get_ar_reminder_candidates()` RPC, `email_type` enum (8 types)
- Edge Function: `supabase/functions/send-email/index.ts` — Resend-powered, JWT auth, idempotency guard, base64 PDF attachments
- Frontend email service: `src/lib/emailService.ts` — `sendEmail()`, `pdfToBase64()`, `buildEmailHtml()` (CRX-branded HTML template)
- Invoice Email button on `InvoiceDetail.tsx` (admin, posted invoices only)
- Financial Dashboard margin alerts (bottom 10 products/customers, monthly trend chart)
- Migrations: `20260308100000_email_infrastructure.sql`, `20260308200000_dashboard_margin_alerts.sql`

### Track A: Wire Email Into All Customer Touchpoints (A1–A6)
- **A1: Resend DNS** — SPF/DKIM setup instructions for `croprxsolutions.app` (manual step)
- **A2: Quote Email** (`QuoteBuilder.tsx`) — auto-emails quote PDF to customer on send. Generates same PDF as download, converts to base64, attaches to branded HTML email. Falls back gracefully if customer has no email or send fails
- **A3: Order Confirmed Email** (`OrderDetail.tsx`) — auto-emails customer when order status → confirmed. Includes order number, date, item summary table (up to 10 items). Email failure doesn't block status change
- **A4: Delivery Completed Email** (`DeliveryDetail.tsx`) — auto-emails customer on delivery completion. Includes delivered items table, partial delivery note, signature info, photo count. Email failure doesn't block completion
- **A5: AR Reminders** (`ARaging.tsx`) — "Send AR Reminders" admin button. Calls `get_ar_reminder_candidates()` RPC, determines reminder level (30/60/90 day), checks dedup via `ar_reminder_tracking` table, sends urgency-colored HTML email with overdue invoice table. Logs activity
- **A6: Batch Email Statements** (`ARaging.tsx`) — "Email Statements (N)" button (visible when customers are selected). For each selected customer: generates statement PDF, converts to base64, sends branded HTML email with PDF attachment. Logs activity
- **Pattern**: All email sends use graceful degradation — email failure never blocks the core business action
- **No new migration** — all DB objects already existed from earlier same-day migration

---

## 2026-03-07 — Sales & Chemical History Reporting

### New: Sales Reports Page (`/sales-reports`)
- **5 report tabs**: Sales Detail (line-item), By Product, By Customer, By Month, By Sales Rep
- **6 filters**: Date Range (with presets: This Season, Last Season, YTD, Last 30/90d), Product, Customer (multi-select), Sales Rep, Category, Season
- **Customer View toggle** — hides cost, profit, margin, and sales rep columns for customer-facing exports
- **Multi-customer selection** with searchable dropdown and chip-based display
- **Farm group support** — auto-detects `parent_customer_id` links, "Include linked farms" toggle groups landlords + main farm into one report
- **Summary cards**: Total Revenue, Total Profit (hidden in Customer View), Units Sold, Orders
- **CSV + PDF export** — respects Customer View visibility (internal data excluded when toggled)
- 3 new RPCs: `get_sales_detail_report()` (LATERAL JOIN to invoices), `get_sales_summary_report()` (CTE-based GROUP BY dimension), `get_customer_farm_group()` (recursive CTE for parent/child farm grouping)
- Migration: `20260307200000_sales_reports.sql`
- Route: `/sales-reports`, roles: admin + sales_rep
- Sidebar: under Finance category between Reports and Compliance

---

## 2026-03-07 — Accounts Payable Module + RUP Sales Reporting

### New: Accounts Payable (AP) Module
- **Vendors table** — proper vendor entity with contact info, default payment terms (backfilled from existing PO/product data)
- **Vendor Bills** — track bills from suppliers with payment terms, due dates, aging (unpaid/partially_paid/paid/voided)
- **Vendor Payments** — record payments against bills (check/ACH/wire/credit card), auto-update balance and status
- 5 RPCs: `create_vendor_bill()`, `record_vendor_payment()`, `void_vendor_bill()`, `get_ap_aging()`, `get_ap_dashboard_summary()`
- 4 new pages: AP Dashboard (`/accounts-payable`), Vendor Bills list, New Vendor Bill form, Vendor Bill Detail with payment recording
- Admin-only sidebar section under Finance
- Migration: `20260307100000_accounts_payable_and_rup_reporting.sql`

### New: RUP Sales Register (Compliance)
- **`rup_sales_records` table** — auto-generated from invoices containing Restricted Use Pesticides
- `generate_rup_sales_records()` — called automatically by `post_invoice()` for RUP line items, snapshots product/customer/license data
- `get_rup_sales_register()` — filterable query for state reporting (date range, product, customer, compliance status)
- Compliance status flagging: compliant (valid license), warning (expired), non_compliant (no license)
- New "RUP Sales Register" tab on Compliance page with CSV export
- All FIFRA Section 12 required fields captured

### E2E Tests
- `tests/e2e/accounts-payable.spec.ts` — 8 tests covering AP dashboard, bill lifecycle, void workflow, KPI cards, RUP compliance tab

---

## 2026-03-06 — Operational Dashboard Rebuild

### New: Operational Dashboard (10-Section Command Center)
- Complete rewrite of `src/pages/Dashboard.tsx` (~750 lines) — replaces basic 4-section dashboard with comprehensive operational command center
- New RPC `operational_dashboard_summary()` — 25-CTE Supabase function returning all dashboard data in a single round-trip
- Migration: `20260323100000_operational_dashboard_summary.sql`

### Dashboard Sections
1. **Quick Actions** (5 buttons) — New Order, New PO, Schedule Delivery, Inventory, Receiving
2. **KPI Row** (4 cards) — Active Orders, Open Quotes, Pending Deliveries, Open POs
3. **Team Board Preview** — Pinned/urgent/overdue/assigned action items (max 10)
4. **Inventory Position** (3 cards) — Floor Stock, On Order, Committed (all in units)
5. **Delivery Command Center** — 10 upcoming deliveries + 4 stat mini-cards (Today, This Week, Unassigned, Remainders)
6. **Sales Pipeline** (3 cards) — Quote Pipeline, Orders (Season), Delivered (Season)
7. **Operational Alerts** — 9 alert types with "All Clear" state when empty
8. **Monthly Activity Chart** — 12-month triple-bar (Orders, Deliveries, POs Received)
9. **Season Progress** — Progress bar (Oct 1–Sep 30) + Accounting Period status
10. **Recent Activity** — 15 items with colored dots by type + relative timestamps

### Navigation Updates
- Sidebar label: "Dashboard" → "Operations"
- Page header: "Operational Dashboard"
- `usePageMeta` updated for `/` route
- Financial Dashboard back-button text corrected

### Role Visibility
- Admin + Sales: all 10 sections
- Drivers: Team Board, Deliveries, Alerts, Activity only

---

## 2026-03-05 — Financial Dashboard, Payment History, PO Improvements, Bug Fixes (PRs #31–#39)

### New: PaymentHistory Page
- `src/pages/PaymentHistory.tsx` — full payment history table with per-invoice allocation breakdown
- Double-cast `Record → InvoiceAllocation` TypeScript fix

### Financial Dashboard Enhancements
- Inventory position cards added to dashboard
- Prepay bucket edit/delete capability
- New migrations: `20260321100000_dashboard_inventory_position.sql`, `20260321200000_prepay_edit_delete.sql`, `20260321300000_void_payment.sql`

### Submit PO Button (PR #39)
- Added "Submit PO" action button on `PurchaseOrderDetail.tsx`

### MG/g Inventory Units + Jar Container (PRs #37/#38)
- New inventory units: `MG` (milligrams) and `g` (grams)
- New container type: `Jar`
- Migration: `20260304210000_add_mg_g_units_and_jar_container.sql`

### Inventory Floor Calculation + Order Product Selector (PR #32)
- Fixed floor calculation that was underreporting available inventory
- Customer tier price now shown in order product selector dropdown

### Manual Inventory No-Cost Override Fix (PR #36)
- Manual inventory add no longer overwrites existing product unit cost
- Migration: `20260320210000_manual_inventory_no_cost_override.sql`

### BulkPOImport PDF Extraction (PRs #33/#34)
- Position-aware text reconstruction for more accurate supplier invoice parsing
- Strategy 3 parser added to handle supplier order confirmation format

### TypeScript + Misc Fixes (PR #35)
- Decimal quantities on POs
- Duplicate PO save prevention
- Edit permissions corrected

### Workflow Quote/Order/Invoice Fixes
- Migration `20260320100000_workflow_quote_order_invoice_fixes.sql` (576-line comprehensive fix)
- Migrations for close period payments column, record_invoice_payment column, delivery date, trigger search paths

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
