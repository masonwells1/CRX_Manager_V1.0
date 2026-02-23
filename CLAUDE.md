# CLAUDE.md - CRX Manager V1.0 Project Instructions

## Project Identity
- **Name:** CRX Manager V1.0 (Crop RX Solutions)
- **Repo:** https://github.com/masonwells1/CRX_Manager_V1.0
- **What it does:** Agricultural product distribution management system -- quotes, orders, deliveries, inventory, purchase orders, team collaboration, blend tickets, reports
- **Who it's for:** Crop RX Solutions (admin, sales reps, drivers)
- **Owner:** masonwells1 (beginner, 0 code experience -- explain things simply)

## Current State (as of 2026-02-23)
- **All hardening & features:** COMPLETE through Sprint 20 + Bulk Field Import + Safety Audit + Quick Receive + Codebase Audit + Lint Cleanup
- **Deployed to:** Vercel → **https://croprxsolutions.app** (live)
- **Test coverage:** 766 unit tests (Vitest, 45 test files) + 31 Playwright E2E spec files
- **77 migrations** applied to remote Supabase, **72+ tables**, **~110 RPC functions**
- **49 pages**, 50+ components
- **ESLint:** 0 errors (fully lint-clean as of 2026-02-23)
- **Latest commit:** `af90ebf` on main (pushed) — update this after each commit
- **T3-002 test coverage:** Phases 1-5 COMPLETE (see Development History)
- **Pre-commit hook:** `npm run lint` + `npm run build` + `npx vitest run` run automatically before every commit
- **GitHub CI:** ESLint → TypeScript (non-blocking) → Vitest → Build — [status badge](https://github.com/masonwells1/CRX_Manager_V1.0/actions/workflows/ci.yml) ✅ green
- **Multi-computer workflow:** Owner works from multiple machines — repo is single source of truth
- **Supabase Project ID:** `rhyzpcqhnizqbxphqdkr`

## Architecture Rules -- Follow These
1. **Database changes MUST use migrations** -- create files in `supabase/migrations/`, never modify tables directly
2. **All tables MUST have RLS policies** -- no exceptions
3. **Use `checkMutationResult()`** after every `.update()` or `.delete()` call to catch silent RLS failures
4. **Lazy-load all pages** -- follow the pattern in `App.tsx` with `lazy()` and `Suspense`
5. **Use Lucide React icons** -- do not install other icon packages
6. **Tailwind CSS only** -- no other CSS frameworks. Brand color is `crx-green` (#28A26A)
7. **Keep types in `src/types/index.ts`** -- all shared interfaces go there
8. **Use the Supabase client from `src/lib/db.ts`** -- never create additional clients
9. **Activity logging:** Call `logActivity()` from `src/lib/activityLogger.ts` for important user actions
10. **Idempotency:** Use `generateIdempotencyKey()` for critical write operations (order creation, delivery completion, etc.)
11. **Keep docs accurate** -- When adding/changing features, update these files before committing:
    - `CLAUDE.md` → Current State (page/test/migration counts), Feature Inventory table, Pages table, Database Tables, RPC list, Edge Functions, Documentation Index
    - `README.md` → Features section, Current State stats
    - `TESTING.md` → Quick Facts (test counts), "What Unit Tests Cover" list (if adding test files)
    - `DEPLOYMENT.md` → Environment variables (if adding new env vars), Edge Function list (if adding functions)

---

## Hard Red Lines — Do NOT Break These

These are critical rules that protect the app's integrity. **Never bypass, weaken, or remove these.**

### Data Safety
- **NEVER delete or modify existing migration files** — only add new ones. Old migrations are history.
- **NEVER remove RLS policies from any table** — every table must have RLS. Adding new tables = adding RLS policies.
- **NEVER expose `service_role` key in frontend code** — only use `anon` key in the browser.
- **NEVER modify `financial_audit_log` records** — this table is append-only by design (no UPDATE, no DELETE).
- **NEVER store money as floating point** — all money values use `bigint` cents (e.g., `balance_cents`). Display divides by 100.

### Business Logic
- **NEVER skip the delivery confirm→complete flow** — deliveries MUST go `scheduled → in_progress → completed`. No shortcuts.
- **NEVER allow editing delivery item quantities** — items are locked to the original order. Only driver/date/window/address/priority/notes can be edited.
- **NEVER create invoices without an order** — invoices always link to an order (even quick deliveries create an order first).
- **NEVER bypass `check_period_open()`** — closed accounting periods must prevent backdated transactions.
- **NEVER allow non-admin users to access month-end close, commission payments, or settings** — these are admin-only.
- **Season runs July 1 to June 30** — do not change this. All YTD calculations, reports, and season comparisons use this date range.

### Code Quality
- **NEVER remove the pre-commit hook** — it runs `npm run lint` + `npm run build` + `npm test` and blocks broken commits.
- **NEVER commit with `--no-verify`** — the pre-commit hook exists for a reason.
- **NEVER add `@ts-ignore` or `any` types** — the codebase is fully typed (0 ESLint errors). Keep it that way.
- **NEVER install additional CSS frameworks** — Tailwind CSS only. Brand color is `crx-green` (#28A26A).
- **NEVER install additional icon libraries** — Lucide React only.
- **NEVER create a second Supabase client** — use the one from `src/lib/db.ts`.

### Deployment
- **NEVER commit `.env` files** — they contain secrets. `.gitignore` already blocks them.
- **NEVER deploy without setting `ALLOWED_ORIGIN`** — Edge Functions will fail with CORS errors.
- **NEVER push directly to production** — use Vercel's preview deployments first.

---

## Feature Inventory (Quick Reference)

Use this table to check **"does this feature already exist?"** before building anything new.

| Domain | Pages | Key Capabilities |
|--------|-------|-----------------|
| **Dashboard** | `/` | KPIs, today's jobs, recent activity, integrity alerts |
| **Customers** | `/customers`, `/customers/:id` | Master list, tiered pricing (1-4), addresses, credit limits, finance charge settings, season summary, bulk import |
| **Products** | `/products`, `/products/:id` | Catalog with 3-tier pricing, EPA registration, RUP status, signal words, unit conversions, cost history, bulk import/pricing import |
| **Quotes** | `/quotes`, `/quotes/new`, `/quotes/:id` | Multi-section builder, tiered pricing, commission splits, margin calcs, PDF generation, versioning, convert to order, bulk import |
| **Orders** | `/orders`, `/orders/new`, `/orders/:id` | Direct creation or from quote, line-item management, fulfillment tracking, credit limit alerts, bulk import |
| **Deliveries** | `/deliveries`, `/deliveries/new`, `/deliveries/:id`, `/delivery-remainders` | Driver assignment, confirm→complete flow, signature capture, photo upload (10 max), GPS, partial delivery remainders, quick delivery (atomic order+delivery+invoice), batch cancel, driver dashboard |
| **Receiving** | `/receiving`, `/receiving/quick` | PO receiving with per-item condition/lot/notes, receiving dashboard with summary cards, quick receive (auto-match to oldest POs), photo attachments |
| **Inventory** | `/inventory`, `/cycle-counts` | Real-time stock levels, low stock alerts, holds, adjustments, warehouse tracking, cycle counts with variance |
| **Purchase Orders** | `/purchase-orders`, `/purchase-orders/new`, `/purchase-orders/:id` | Vendor PO creation, two-step receive modal, receiving history, auto-cost update |
| **Invoices** | `/invoices`, `/invoices/:id` | Auto-generate from deliveries, 3 PDF layouts, batch print, batch void, write-off, post/unpost |
| **Payments** | `/payments`, `/payment-allocation`, `/prepayments` | Check recording, unified allocation across invoices, prepay credits, auto-apply |
| **AR & Finance** | `/ar-aging`, `/month-end`, `/commission-payments`, `/customer-transactions` | Aging buckets (current/30/60/90+), finance charges, statements, period close, commission posting, transaction review |
| **Jobs** | `/jobs`, `/jobs/:id` | Application scheduling, applicator/vehicle assignment, recipe loading, complete→application record, transfer to invoice |
| **Blend Tickets** | `/blend-tickets`, `/blend-tickets/:id` | OCR upload (Google Vision AI + Tesseract.js), manual creation, product extraction, approve/reject, link to orders |
| **Recipes** | `/recipes` | Reusable blend recipe templates, product ratios, create job from recipe |
| **Fields** | `/fields`, `/fields/:id` | Mapbox satellite maps, polygon draw tools, bulk import (shapefile/KML/GeoJSON with proj4 reprojection) |
| **Compliance** | `/compliance` | Applicator license tracking, RUP product flags, expiry alerts |
| **Returns** | `/returns` | RMA workflow (request→approve→receive→credit), restocking, credit memos |
| **Vehicles** | `/vehicles`, `/vehicles/:id` | Ground/air equipment CRUD, capacity, registration, FAA/DOT numbers |
| **Reports** | `/reports` | 14 reports: logbook (4 views), P&L, gross sales, commission balance, chemical history, inventory cost, year-end summary. CSV/PDF export. |
| **Team Board** | `/team-board` | Kanban: notes/todos/announcements, comments, tags, real-time updates |
| **Other** | `/notifications`, `/settings`, `/application-records`, `/brand-vs-generic`, `/crop-programs`, `/rebates` | Notification center, admin settings/user management, application records log, ingredient mapping, crop programs, rebate claims |

---

## Application Architecture

### Tech Stack
- **Frontend:** React 18 + TypeScript + Vite
- **Backend:** Supabase (PostgreSQL + Auth + Edge Functions + Realtime + Storage)
- **Styling:** Tailwind CSS with custom theme (crx-green brand color)
- **Testing:** Vitest (766 unit tests, 45 files) + Playwright (31 E2E spec files in `tests/e2e/`)
- **Deployment:** Vercel → https://croprxsolutions.app (live), configured via `vercel.json`
- **Mapping:** Mapbox GL JS + react-map-gl + @mapbox/mapbox-gl-draw + @turf/area + @turf/centroid + @turf/bbox
- **Geo Import:** shapefile (parse .shp/.dbf/.shx), proj4 (coordinate reprojection), togeojson-with-extended-style (KML→GeoJSON)
- **PDF Generation:** jsPDF + jspdf-autotable (client-side)
- **OCR:** Tesseract.js + PDF.js (client-side), Google Vision AI (server-side Edge Function)
- **Signatures:** signature_pad
- **Icons:** Lucide React (do not install other icon libraries)

### Key Commands
```bash
npm run dev          # Start dev server (http://localhost:5173)
npm run build        # Production build
npx vitest run       # Run 766 unit tests (45 test files)
npm run typecheck    # TypeScript error check
npm run lint         # ESLint
npm run test:e2e     # Run Playwright E2E tests
npm run test:e2e:ui  # Interactive Playwright UI
```
**Note:** Pre-commit hook automatically runs `npm run lint` + `npm run build` + `npx vitest run` before every commit. GitHub CI runs the same checks on push to main.

### User Roles
1. **admin** - Full CRUD on all tables. Manages users, products, costs, inventory, purchase orders, commissions, month-end close, write-offs, settings.
2. **sales_rep** - Creates quotes, orders, deliveries, jobs, invoices, blend tickets, application records. Manages own customers/fields. Views own commissions.
3. **driver** - Views assigned deliveries and related inventory. Confirms/starts deliveries, completes with signature/photos, reports issues. Can self-assign available deliveries, create quick deliveries. Cannot access quotes or financial data.
4. **applicator** - Views assigned jobs. Records applied info (weather, gallons, times). Views customers/products/fields/recipes. Cannot create jobs or access financial data.

### Project Structure
```
src/
  App.tsx              # Routes (lazy-loaded), auth provider, error boundary
  main.tsx             # Entry point
  contexts/
    AuthContext.tsx     # Auth state (login, logout, session, role)
  lib/
    db.ts              # Supabase client + checkMutationResult() utility
    activityLogger.ts  # Activity feed + notification helpers
    notificationTriggers.ts  # Automated notification checks
    idempotency.ts     # Idempotency key generator
    offlineQueue.ts    # IndexedDB offline queue
    offlineSync.ts     # Auto-sync on reconnect
    imageCompression.ts # Client-side image compression
    quotePdf.ts        # Quote PDF generation
    deliveryPdf.ts     # Delivery receipt PDF (batch + partial display)
    receivingPdf.ts    # Receiving receipt PDF (condition color-coding + batch)
    invoicePdf.ts      # Invoice PDF (3 layouts)
    statementPdf.ts    # Customer statement PDF (dual-mode)
    reportPdf.ts       # Generic report PDF generator
    yearEndSummaryPdf.ts # Year-end customer summary PDF
    csvExport.ts       # CSV export utility
    ocrParser.ts       # OCR text parsing for blend tickets
    blendMathValidator.ts # Blend recipe math validation
    quoteCalc.ts       # Quote calculation helpers
    fieldImportParser.ts # Shapefile/KML/GeoJSON parsing & coordinate reprojection
    paymentAllocation.test.ts # 9 payment allocation tests
  hooks/
    useOnlineStatus.ts     # Online/offline detection
    useRealtimeSubscription.ts # Supabase realtime wrapper
    usePageMeta.ts         # Page title/meta
    useOCRProcessor.ts     # OCR processing hook
  pages/               # 48 page components (lazy-loaded from App.tsx)
  components/
    auth/              # LoginPage, ProtectedRoute
    layout/            # AppLayout, Sidebar, TopBar
    ui/                # Badge, Button, Card, DataTable, Modal, Input, Select, Skeleton, Toast, etc.
    map/               # MapContainer, DrawControl, FieldMarkers (Mapbox satellite maps)
    fields/            # BulkFieldImport (shapefile/KML/GeoJSON wizard), AttributeMappingStep, ImportPreviewMap
    blendtickets/      # BulkTicketUpload
    customers/         # BulkCustomerImport
    orders/            # BulkOrderImport
    products/          # BulkProductImport, BulkPricingImport
    quotes/            # BulkQuoteImport
    deliveries/        # BatchCancelModal, StartDeliveryModal, QuickDeliveryModal
    invoices/          # BatchVoidModal, FinanceChargePreviewModal, InvoicePrintDialog, WriteOffModal
    reports/           # ReportShell, LogbookReport, YearEndSummaryDialog
    statements/        # StatementPrintDialog
    team/              # ActivityFeed, CommentsSection, NotificationsPanel, TagsManager, TeamBoardFilters
  types/
    index.ts           # All TypeScript interfaces and types
  assets/              # Logo images
supabase/
  migrations/          # All database migrations (SQL, chronological order)
  functions/           # Edge Functions: create-user, process-blend-ticket, process-document, seed-admin, setup-blend-tickets-storage
tests/
  e2e/                 # 31 Playwright E2E spec files (all pages covered)
```

### Pages (49 total)

| Route | Page | Description |
|-------|------|-------------|
| `/` | Dashboard | KPIs, today's jobs, recent activity |
| `/products` | Products | Product catalog with search/filter, bulk import |
| `/products/:id` | ProductDetail | Product CRUD (pricing tiers, EPA info, RUP status) |
| `/customers` | Customers | Customer list with search/filter, bulk import |
| `/customers/:id` | CustomerDetail | Profile, addresses, credit limit, transaction review, finance charge settings, season summary |
| `/quotes` | Quotes | Quote list with status filters |
| `/quotes/new` | QuoteBuilder | Multi-line quote with tiered pricing, commission splits, PDF |
| `/quotes/:id` | QuoteBuilder | Edit existing quote |
| `/orders` | Orders | Order list with status badges |
| `/orders/new` | NewOrder | Direct order creation (bypasses quote) |
| `/orders/:id` | OrderDetail | Order detail with status transitions, convert to invoice |
| `/inventory` | InventoryPage | Inventory levels, low-stock alerts, cost valuation |
| `/deliveries` | Deliveries | Delivery management + driver dashboard + batch actions + quick delivery (~900 lines) |
| `/deliveries/new` | NewDelivery | Create delivery from order |
| `/deliveries/:id` | DeliveryDetail | Full lifecycle: confirm, edit, cancel, photos, issues, remainders, order context (~1350 lines) |
| `/delivery-remainders` | DeliveryRemainders | Pending remainder items across all customers |
| `/blend-tickets` | BlendTickets | OCR ticket processing with image upload |
| `/blend-tickets/:id` | BlendTicketDetail | Ticket review, approve/reject, create application record |
| `/purchase-orders` | PurchaseOrders | PO list with status filters |
| `/purchase-orders/new` | NewPurchaseOrder | Create PO from vendor catalog |
| `/purchase-orders/:id` | PurchaseOrderDetail | PO detail with two-step receive modal + receiving history (~823 lines) |
| `/receiving` | ReceivingLog | Receiving dashboard with summary cards, filters, searchable log |
| `/receiving/quick` | QuickReceive | 3-step wizard: vendor+products → auto-match to oldest open POs → confirm |
| `/jobs` | Jobs | Job list with date/status/customer filters |
| `/jobs/:id` | JobDetail | Full job editor: fields on map, chemicals, vehicle/applicator, complete, transfer to invoice |
| `/vehicles` | Vehicles | Vehicle CRUD (ground/air), capacity, registration |
| `/vehicles/:id` | VehicleDetail | Single vehicle edit form |
| `/application-records` | ApplicationRecords | Read-only list of all chemical applications (from jobs + blend tickets) |
| `/invoices` | Invoices | Invoice list (unposted/posted), batch print, batch void, quick delivery filter |
| `/invoices/:id` | InvoiceDetail | Invoice detail, post/unpost, print PDF, write-off |
| `/payments` | Payments | Payment recording and listing |
| `/payment-allocation` | PaymentAllocation | Unified payment allocation to invoices |
| `/ar-aging` | ARaging | AR aging report, generate finance charges |
| `/month-end` | MonthEndClose | Admin-only. Period status, checklist, batch statements, "Roll the Month" |
| `/commission-payments` | CommissionPayments | Admin-only. Create from unpaid commissions, post workflow |
| `/customer-transactions` | CustomerTransactionReview | Admin-only. Per-customer transaction history with running balance |
| `/prepayments` | PrepaymentManager | Admin-only. Prepay balances, auto-apply to oldest invoices |
| `/reports` | Reports | 14 reports: 4 logbook, 6 financial, 4 operational. CSV/PDF export. |
| `/fields` | Fields | Field list with Mapbox map view + bulk import (shapefile/KML/GeoJSON) |
| `/fields/:id` | FieldDetail | Field CRUD with polygon drawing on satellite map |
| `/recipes` | BlendRecipes | Reusable blend recipe management, create job from recipe |
| `/cycle-counts` | CycleCounts | Inventory cycle counting with variance tracking |
| `/returns` | Returns | Returns/RMA workflow (request → approve → receive → credit) |
| `/brand-vs-generic` | BrandVsGeneric | Ingredient mapping: branded vs generic |
| `/crop-programs` | CropPrograms | Seasonal crop program management |
| `/compliance` | Compliance | Applicator license tracking, RUP product list |
| `/rebates` | Rebates | Manufacturer rebate programs and claim management |
| `/team-board` | TeamBoard | Kanban board: notes/todos/announcements, comments, real-time |
| `/notifications` | Notifications | User notification center |
| `/settings` | SettingsPage | Admin only: company settings, user management |

---

## Supabase Backend Reference

### Database Tables (72 total)

**Core Business:**
- `profiles` - Users (id refs auth.users, email, full_name, role, phone, is_active, applicator_license_number, faa_certificate_number)
- `customers` - Farms (farm_name, assigned_sales_rep, assigned_tier 1-4, credit_limit, finance_charge_rate, prepay_balance)
- `customer_addresses` - Multiple addresses per customer (label, address, delivery_notes, is_default)
- `products` - Product master (product_name, sku, category, vendor, tier1-4 pricing, EPA reg, RUP status, signal_word, product_form)
- `cost_history` - Cost change audit log (product_id, old/new costs and prices, change_note)
- `fields` - Farm fields (customer_id, field_name, county, acres, FSA numbers, Mapbox polygon geometry)
- `field_billing_defaults` - Per-field billing splits (field_id, customer_id, split_pct)
- `vehicles` - Ground/air application equipment (type, capacity, registration, FAA N-number or DOT#, status)

**Quotes & Orders:**
- `quotes` - Quote headers (quote_number, customer_id, status, tier, totals, is_planned, expires_at)
- `quote_sections` - Sections within a quote (section_name, sort_order)
- `quote_items` - Line items (product_id, section_id, pricing, rates, acres, totals)
- `quote_versions` - Frozen snapshots of sent quotes (version_number, snapshot_data jsonb)
- `orders` - Confirmed orders (order_number, status, totals, total_paid, balance_due, order_date)
- `order_items` - Order line items (quantity_delivered, quantity_remaining)
- `payments` - AR tracking (order_id, amount, payment_method, reference_number)
- `commissions` - Per-order per-recipient (split_percentage, commission_amount, status, paid_date)

**Inventory:**
- `inventory` - Stock per product per location (quantity_available, quantity_prebooked, quantity_on_order, reorder_point, min_stock_level)
- `inventory_transactions` - Audit trail (transaction_type: received/booked/delivered/returned/adjusted/transferred)
- `inventory_holds` - Reserved inventory (quantity, hold_type: manual/crop_program, expires_at, is_active)
- `purchase_orders` - Supplier POs (po_number, vendor, status, total_cost)
- `purchase_order_items` - PO line items (quantity_ordered, quantity_received, unit_cost)

**Deliveries:**
- `deliveries` - Delivery headers (delivery_number, order_id, assigned_driver, scheduled_date, status, signature_url, priority, delivery_window_start/end, cancelled_at/by, cancel_reason, issue_type, issue_notes, is_quick_delivery)
- `delivery_items` - Items on delivery (order_item_id, product_id, quantity)
- `delivery_photos` - Driver-uploaded delivery photos (delivery_id, storage_path, image_url, uploaded_by)
- `delivery_remainders` - Partial delivery remainder items (delivery_id, order_item_id, product_id, remainder_quantity, status: pending/scheduled/delivered/cancelled)

**Receiving:**
- `receiving_records` - Per-event receiving records (po_id, po_item_id, product_id, quantity_received, condition, lot_number, notes, storage_location, received_by)
- `receiving_photos` - Photos attached to receiving events (receiving_record_id, storage_path, image_url)

**Job Scheduling:**
- `jobs` - Job headers (status: scheduled/in_progress/completed/cancelled/invoiced, customer, applicator, vehicle, recipe)
- `job_fields` - Fields assigned to a job (many-to-many with sort order)
- `job_chemicals` - Chemicals/products for a job with rates and pricing
- `job_applied_info` - Recorded data when completed: actual times, weather, gallons applied

**Application Records:**
- `application_records` - Single source of truth for "what was applied, where, when, by whom." Fed from completed jobs AND approved blend tickets. JSONB for products and weather.

**OCR / Blend Tickets:**
- `blend_tickets` - OCR ticket records (ticket_number, status, review_status, ocr_confidence_score, raw_ocr_text)
- `blend_ticket_products` - Extracted products (product_name, quantity, confidence_score, manually_corrected)
- `blend_ticket_images` - Uploaded images (storage_path, image_url, file_size)
- `ocr_processing_queue` - Background queue (status, priority, retry_count)

**Collaboration:**
- `team_notes` - Notes/todos/announcements (note_type, priority, assigned_to, is_completed, is_pinned, deleted_at)
- `team_note_comments` - Comments (note_id, content, deleted_at)
- `activity_feed` - Auto-generated event log (event_type, description, related_entity_type/id)
- `notifications` - Per-user notifications (user_id, title, message, notification_type, is_read)

**Billing / Invoices:**
- `invoices` - Invoice headers (invoice_number, order_id, customer_id, status: draft/posted/void, balance_cents bigint, due_date)
- `invoice_items` - Invoice line items (invoice_id, order_item_id, product_id, quantity, unit_price_cents, line_total_cents)
- `allocation_sets` - Payment-to-invoice allocation groups (payment_id, allocated_at)
- `order_line_allocations` - Payment portions applied to order items
- `invoice_line_allocations` - Payment portions applied to invoice items
- `prepay_credits` - Prepayment credits (customer_id, original_amount_cents, remaining_cents, source_payment_id)
- `prepay_applications` - Prepay credit applications to invoices (credit_id, invoice_id, applied_cents)
- `financial_audit_log` - Immutable audit trail (entity_type, entity_id, action, old_data/new_data jsonb, performed_by)

**Financial:**
- `accounting_periods` - Month-end close tracking (status: open/closed)
- `commission_payments` - Commission payment headers (status: unposted/posted)
- `commission_payment_items` - Individual commissions included in a payment
- `write_offs` - Invoice write-off records with reason and approval
- `finance_charges` - Interest charges on overdue invoices
- `prepayments` - Customer prepayment deposits

**Blend Recipes:**
- `blend_recipes` - Saved blend recipe templates (recipe_name, recipe_number, category, total_cost, total_weight, status)
- `blend_recipe_items` - Recipe ingredients (recipe_id, product_id, quantity, unit, sort_order)
- `blend_ticket_to_order_item` - Links blend tickets to order items (ticket_id, order_item_id)

**Warehouses & Cycle Counts:**
- `warehouses` - Storage locations (warehouse_name, code, address, is_active, is_default)
- `cycle_counts` - Count sessions (count_number, warehouse_id, status: in_progress/completed/cancelled, counted_by)
- `cycle_count_items` - Individual count lines (cycle_count_id, product_id, expected_qty, counted_qty, variance, variance_pct, resolved)

**Returns:**
- `returns` - Return/RMA headers (return_number, order_id, customer_id, status: requested/approved/received/credited/rejected, return_type, reason_category)
- `return_items` - Return line items (return_id, order_item_id, product_id, quantity, unit_price, restocked, sort_order)

**Compliance:**
- `applicator_licenses` - Applicator license tracking (customer_id, license_number, license_type: private/commercial/public, holder_name, state, expiry_date, certification_categories text[])

**Rebates:**
- `rebate_programs` - Manufacturer rebate programs (program_name, manufacturer, season, product_id, rebate_type, rebate_amount, start_date, end_date, status)
- `rebate_claims` - Rebate claims (program_id, claim_number, quantity, claim_amount_cents, status: pending/submitted/approved/paid/rejected)

**Config:**
- `app_settings` - Key-value settings (setting_key, setting_value)
- `ingredient_map` - Brand to generic product mapping
- `unit_conversions` - Unit conversion factors (unit, factor_oz)

### RPC Functions (~110 total — key ones listed)

**Atomic Save/Delete:**
- `save_quote()`, `save_job()`, `save_customer()`, `save_blend_ticket()`, `save_purchase_order()`, `delete_purchase_order()`, `duplicate_quote()`

**Order & Delivery:**
- `convert_quote_to_order()`, `create_direct_order()`, `cancel_order()`, `update_order_items()`
- `confirm_delivery()` — scheduled → in_progress transition
- `complete_delivery()` — requires in_progress, creates remainder rows for partial deliveries
- `edit_delivery()` — logistics only, items param ignored (locked to order)
- `cancel_delivery()`, `batch_cancel_deliveries()`, `reassign_delivery()`
- `create_followup_delivery()`, `get_customer_delivery_remainders()`
- `create_quick_delivery()` — atomic order + delivery + draft invoice in one transaction

**Inventory & Receiving:**
- `adjust_inventory()`, `receive_po_items()` — per-item condition/lot/notes/storage, creates receiving_records
- `complete_cycle_count()`
- `get_receiving_log()` — paginated, filterable receiving history
- `get_receiving_summary()` — dashboard stats (expected_today, pending_receipt, received_this_week, items_ytd, damaged_this_week)
- `match_quick_receive_items()` — auto-allocate products to oldest open POs for Quick Receive

**Job Scheduling:**
- `complete_job()` — marks completed, creates application_record, deducts inventory
- `transfer_job_to_invoice()` — creates invoice from job, sets status='invoiced'
- `load_recipe_into_job()` — copies recipe items into job chemicals

**Sequential Numbers (advisory locks):**
- `next_delivery_number()` → DEL-YYYY-NNNN, `next_po_number()` → PO-YYYY-NNNN
- `next_application_record_number()` → APP-YYYY-NNNN, `next_job_number()` → JOB-YYYY-NNNN
- `next_commission_payment_number()` → CP-YYYY-NNNN

**Reporting (10 RPCs):**
- `get_logbook_by_customer()`, `get_logbook_by_applicator()`, `get_logbook_by_field()`, `get_logbook_faa()`
- `get_bottom_line_pnl()`, `get_gross_sales_report()`, `get_customer_balance_listing()`
- `get_chemical_history()`, `get_commission_balance_report()`, `get_inventory_cost_report()`

**Financial:**
- `close_accounting_period()`, `check_period_open()`, `generate_batch_statements()`, `get_monthly_summary()`
- `create_commission_payment()`, `post_commission_payment()`
- `apply_write_off()`, `generate_finance_charges()`
- `get_customer_transaction_review()`, `apply_remaining_prepayments()`

**Geo / Maps:**
- `get_fields_with_geojson()`, `get_field_geojson()`, `save_field_geometry()` — use `SET search_path = public, extensions` for PostGIS

**Dashboard:**
- `dashboard_summary()` — 8 queries consolidated into 1 RPC

### Helper Functions (SQL)
```sql
is_admin()      -- SECURITY DEFINER STABLE
is_sales_rep()  -- SECURITY DEFINER STABLE
is_driver()     -- SECURITY DEFINER STABLE
is_applicator() -- SECURITY DEFINER STABLE
```

### Database Trigger
- **`on_auth_user_created`** - After INSERT on `auth.users`, calls `handle_new_user()` which auto-creates a `profiles` row using `raw_user_meta_data` (full_name, role defaults to 'sales_rep').

### RLS Policy Matrix (Final Effective State)

| Table | SELECT | INSERT | UPDATE | DELETE |
|-------|--------|--------|--------|--------|
| profiles | All authenticated | Own/Admin | Own/Admin | - |
| products | All authenticated | Admin | Admin | Admin |
| cost_history | Admin | Admin | - | - |
| customers | Admin / Sales Rep (assigned) / Driver (has delivery) | Admin / Sales Rep | Admin / Sales Rep (assigned) | Admin |
| customer_addresses | All authenticated | Admin / Sales Rep (own customer) | Admin / Sales Rep (own customer) | Admin |
| quotes | Admin / Sales Rep | Admin / Sales Rep (own) | Admin / Sales Rep (own) | Admin |
| quote_sections | All authenticated | Admin / Sales Rep (quote owner) | Admin / Sales Rep (quote owner) | Admin / Sales Rep (quote owner) |
| quote_items | All authenticated | Admin / Sales Rep (quote owner) | Admin / Sales Rep (quote owner) | Admin / Sales Rep (quote owner) |
| quote_versions | All authenticated | Admin / Sales Rep (quote owner) | - | - |
| orders | Admin / Sales Rep | Admin / Sales Rep | Admin | Admin |
| order_items | Admin / Sales Rep | Admin / Sales Rep | Admin | Admin |
| inventory | Admin / Sales Rep / Driver | Admin | Admin | Admin |
| inventory_transactions | Admin / Sales Rep | Admin / Sales Rep | - | - |
| inventory_holds | Admin / Sales Rep | Admin / Sales Rep | Admin | Admin |
| purchase_orders | Admin / Sales Rep | Admin | Admin | Admin |
| purchase_order_items | Admin / Sales Rep | Admin | Admin | Admin |
| receiving_records | Admin / Sales Rep | Admin / Sales Rep | - | Admin |
| receiving_photos | Admin / Sales Rep | Admin / Sales Rep | - | Admin |
| deliveries | Admin / Sales Rep / Driver (assigned) | Admin / Sales Rep | Admin / Sales Rep / Driver (assigned) | Admin |
| delivery_items | Admin / Sales Rep / Driver (via delivery) | Admin / Sales Rep | Admin / Sales Rep | Admin / Sales Rep |
| delivery_photos | Admin / Sales Rep / Driver | Admin / Sales Rep / Driver | - | Admin |
| delivery_remainders | Admin / Sales Rep / Driver | Admin / Sales Rep | Admin / Sales Rep | Admin |
| commissions | Admin / Sales Rep (own recipient) | Admin | Admin | - |
| payments | Admin / Sales Rep | Admin / Sales Rep | Admin | Admin |
| team_notes | All authenticated | Own created_by | Own created_by / Admin | Admin |
| team_note_comments | All authenticated | Own created_by | - | - |
| activity_feed | All authenticated | Own performed_by | - | - |
| notifications | Own user_id | All authenticated | Own user_id | - |
| app_settings | All authenticated | Admin | Admin | - |
| blend_tickets | All authenticated | Own uploaded_by | Own uploaded_by / Admin | - |
| ingredient_map | All authenticated | Admin | Admin | Admin |
| unit_conversions | All authenticated | Admin | Admin | - |
| invoices | Admin / Sales Rep | Admin / Sales Rep | Admin | Admin |
| invoice_items | Admin / Sales Rep | Admin / Sales Rep | Admin | Admin |
| allocation_sets | Admin / Sales Rep | Admin / Sales Rep | - | Admin |
| order_line_allocations | Admin / Sales Rep | Admin / Sales Rep | - | Admin |
| invoice_line_allocations | Admin / Sales Rep | Admin / Sales Rep | - | Admin |
| prepay_credits | Admin / Sales Rep | Admin / Sales Rep | Admin | - |
| prepay_applications | Admin / Sales Rep | Admin / Sales Rep | - | Admin |
| financial_audit_log | Admin | All authenticated | - | - |
| blend_recipes | All authenticated | Admin / Sales Rep | Admin / Sales Rep | Admin |
| blend_recipe_items | All authenticated | Admin / Sales Rep | Admin / Sales Rep | Admin / Sales Rep |
| blend_ticket_to_order_item | All authenticated | Admin / Sales Rep | - | Admin |
| warehouses | All authenticated | Admin | Admin | Admin |
| cycle_counts | Admin | Admin | Admin | Admin |
| cycle_count_items | Admin | Admin | Admin | Admin |
| fields | Admin / Sales Rep (assigned customer) | Admin / Sales Rep | Admin / Sales Rep | Admin |
| field_billing_defaults | Admin / Sales Rep | Admin / Sales Rep | Admin / Sales Rep | Admin / Sales Rep |
| returns | Admin / Sales Rep | Admin / Sales Rep | Admin | Admin |
| return_items | Admin / Sales Rep | Admin / Sales Rep | Admin | Admin |
| applicator_licenses | Admin / Sales Rep | Admin | Admin | Admin |
| rebate_programs | Admin | Admin | Admin | Admin |
| rebate_claims | Admin | Admin | Admin | Admin |

### Migration History
Migrations are in `supabase/migrations/` ordered by timestamp prefix. Key migrations:
1. `20260206172436` - Full schema creation (all tables, indexes, RLS)
2. `20260206174345` - Security & performance fixes (consolidated RLS, auth.uid() optimization)
3. `20260206174743` - Profile auto-creation trigger
4. `20260206191309` - Automatic price calculation
5. `20260206191700` - Gross margin display fields
6. `20260206192224` - Fix margin terminology
7. `20260206195903` - EPA registration field
8. `20260206201328` - Team board collaboration features
9. `20260206203908` - Blend tickets system
10. `20260207000001` - Fix customer RLS for sales_rep
11. `20260207_gap_analysis_fixes` - Payments table, reorder_point, commission paid fields, etc.
12. `20260207_gap_analysis_fixes_2` - Additional gap fixes
13. `20260208194203` - Soft delete for team notes
14. `20260209040254` - Fix soft delete activity logging
15. `20260209040325` - Fix payment RLS policies
16. `20260209143537` - Inventory overhaul (holds, is_planned)
17. `20260210_fix_rls_critical_issues` - Sales rep INSERT permissions for orders/deliveries/inventory_transactions, profiles SELECT for all, notifications INSERT for all
18. `20260211190000` - Billing & invoicing system (invoices, invoice_items, allocation_sets, prepay_credits, financial_audit_log)
19. `20260212000000` - Fields & geospatial (fields, field_billing_defaults)
20. `20260212100000` - Blend recipes system (blend_recipes, blend_recipe_items, blend_ticket_to_order_item)
21. `20260213000000` - Inventory enhancements (warehouses, cycle_counts, cycle_count_items, inventory warehouse_id FK)
22. `20260213100000` - Returns/RMA system (returns, return_items, inventory restocking support)
23. `20260213200000` - Reporting, compliance & rebates (applicator_licenses, rebate_programs, rebate_claims, AR aging/statement/season RPCs, products is_rup & signal_word)
24. `20260214000000` - Phase 4B Mapbox integration (geo RPCs, PostGIS)
25. `20260214200000` - Vehicles table
26. `20260214210000` - Applicator role expansion (license fields on profiles)
27. `20260214220000` - Application records table + RPCs
28. `20260215200000` - Job scheduling tables (jobs, job_fields, job_chemicals, job_applied_info)
29. `20260216200000` - Reporting RPCs (10 report functions)
30. `20260217200000` - Accounting periods (month-end close)
31. `20260217210000` - Commission payments
32. `20260218200000` - Financial workflows (write-offs, finance charges, prepayments, transaction review)
33. `20260219200000` - Invoice/statement enrichment
34. `20260219210000` - Invoice/statement RPCs
35. `20260220200000` - Finance charge intelligence
36. `20260221200000` - Grower share pricing
37. `20260222200000` - Batch operations
38. `20260223200000` - Payment allocation
39. `20260224200000` - Year-end summary
40. `20260225200000` - Delivery system enhancements (delivery_photos, delivery_remainders, edit/cancel/batch/reassign/followup RPCs, driver issue reporting)
41. `20260226200000` - Receiving system enhancements (receiving_records, receiving_photos, per-item condition/lot/notes, receiving log/summary RPCs)
42. `20260227200000` - Delivery integrity & quick delivery (confirm_delivery, items locked to order, complete requires in_progress, create_quick_delivery atomic RPC, is_quick_delivery flags)
43. Safety audit hardening (page permissions, notification triggers, business logic)
44. User page permissions
45. Business logic enhancements
46. Dashboard integrity alerts
47. Quick Receive (match_quick_receive_items RPC, receive_po_items p_allow_over_receive)

### Edge Functions (5 total in `supabase/functions/`)
- **create-user** - Admin-only: creates a new auth user with role metadata
- **process-blend-ticket** - OCR processing via Google Vision AI (requires GOOGLE_VISION_API_KEY secret)
- **process-document** - Document processing Edge Function
- **seed-admin** - One-time: creates initial admin user (requires SEED_ADMIN_SECRET header)
- **setup-blend-tickets-storage** - Returns storage bucket configuration instructions

All edge functions require `ALLOWED_ORIGIN` env var for production CORS.

### Realtime Subscriptions
Generic hook: `useRealtimeSubscription({ table, event, filter, onInsert, onUpdate, onDelete })`
Used for:
- `team_notes` - Live updates on team board
- `team_note_comments` - Live comments filtered by note_id
- `notifications` - Live notifications filtered by user_id
- `note_activity_log` - Live activity on notes

### Storage Buckets
- **blend-ticket-images** - Private bucket for blend ticket images (RLS-protected)
- **delivery-photos** - Private bucket for delivery photos (driver uploads, RLS-protected)
- **receiving-photos** - Private bucket for receiving event photos (RLS-protected)
- **Admin user:** mason@croprxsolutions.com (UUID: 22c1fc50-4d2a-4baa-8ff8-341c0c7edd4f)

---

## Business Logic Rules

### Quote Lifecycle
`draft` -> `sent` -> `revised` -> `accepted` -> `declined` -> `expired`
- Quotes have `valid_days` and `expires_at`
- `is_planned` flag reserves inventory through holds
- Accepted quotes can be converted to orders
- Quotes support multi-section structure with sorted items
- PDF generation includes Crop RX branding and tier pricing

### Order Lifecycle
`confirmed` -> `partially_fulfilled` -> `fulfilled` -> `cancelled`
- Created from accepted quotes or manually
- `total_paid` and `balance_due` track AR
- `order_items` track `quantity_delivered` and `quantity_remaining`
- Commission records created per order per recipient

### Delivery Lifecycle
`scheduled` -> `in_progress` -> `completed` -> `cancelled`
- Created from orders with item selection, or via Quick Delivery (atomic order + delivery + draft invoice)
- Assigned to a driver with priority, delivery window, and notes
- **Two-step flow:** Must `confirm_delivery()` (scheduled → in_progress) before completing. Shows inventory check warning.
- **Items locked to order:** Delivery item quantities cannot be edited — always match the order
- **Order context columns:** Items display shows Ordered / Prev. Delivered / This Delivery / Remaining After
- Completion triggers inventory transactions (type: 'delivered'), creates remainder rows for partial deliveries
- Signature capture, photo upload (up to 10), driver issue reporting
- PDF receipt generation with batch support + partial delivery display
- Edit mode: driver, date/time, window, address, priority, notes (not item quantities)
- Cancel with reason, batch cancel, reassign driver, follow-up delivery from remainders

### Purchase Order Lifecycle
`draft` -> `submitted` -> `partially_received` -> `fully_received` -> `cancelled`
- Receiving updates PO item quantities and inventory levels via two-step receive modal (fill details → review → confirm)
- Per-item receiving: condition (good/damaged/short/wrong_item), lot number, notes, storage location
- Creates `receiving_records` for per-event tracking with photo attachments
- Auto-updates product cost if PO unit_cost differs
- Creates cost_history entries on cost changes
- Creates inventory_transaction (type: 'received')
- Receiving dashboard at `/receiving` with summary cards and filterable log

### Inventory Calculations
- **Total on Floor** = quantity_available + quantity_prebooked
- **Planned** = active holds + planned quote items
- **Net Position (Free)** = quantity_available - planned - quantity_prebooked
- **On Order** = sum of (quantity_ordered - quantity_received) from open POs
- **Delivered YTD** = sum of delivered transactions since season start
- **Low Stock** = quantity_available <= reorder_point (when reorder_point > 0)

### Commission Logic
- `commission_split` stored as JSONB on customers and quotes: `{ splits: [{ recipient, percentage }] }`
- Commissions calculated per order based on split percentages applied to order_profit
- Status: `pending` -> `paid` (with paid_date and paid_note)

### Tier Pricing
- Customers assigned tier 1, 2, or 3
- Products have tier1_price, tier2_price, tier3_price with corresponding margins
- Price per acre calculated from rate and tier price
- Quotes inherit customer tier but can be overridden

### Invoice Lifecycle
`draft` -> `posted` -> `void`
- Created from orders (manual or auto-generate)
- Posted invoices lock amounts and start AR aging
- balance_cents tracks remaining balance after payments/credits
- Prepay credits can be applied to reduce invoice balance
- All financial changes logged to `financial_audit_log`

### Return/RMA Lifecycle
`requested` -> `approved` -> `received` -> `credited` -> `rejected`
- Created against an order with item selection
- Reason categories: damaged, wrong_product, quality, overshipment, other
- Return types: refund, credit, exchange
- Receiving triggers optional inventory restocking
- Credit creates payment record against original order

### Rebate Claim Lifecycle
`pending` -> `submitted` -> `approved` -> `paid` -> `rejected`
- Claims linked to rebate programs, optionally to customer/order/product
- Claim numbers auto-generated: `RC-{year}-{sequential 4-digit}`
- Amounts stored as cents (bigint) for precision

### Job Lifecycle
`scheduled` -> `in_progress` -> `completed` -> `cancelled` -> `invoiced`
- Created with customer, fields, chemicals (from recipe or manual)
- Assigned to applicator + vehicle
- Completion records applied_info (weather, gallons, times), creates application_record, deducts inventory
- Transfer to invoice creates invoice from job line items

### Commission Payment Lifecycle
`unposted` -> `posted`
- Created from selected unpaid commissions for a sales rep
- Posting locks amounts and marks individual commissions as paid

### Month-End Close
- Periods track open/closed status per month
- Closing validates all invoices posted, runs checklist
- Closed periods prevent backdated transactions (`check_period_open()` raises exception)
- Batch statement generation for all customers with activity

### Season Dates
- Season runs **July 1 to June 30**
- Delivered YTD calculated from season start
- Used in inventory calculations, reports, and season comparison

---

## Environment Variables

### Frontend (.env)
```
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key
VITE_MAPBOX_TOKEN=pk.your-mapbox-token  # Required for satellite maps (free at mapbox.com)
```
See `.env.example` for template. Never commit `.env`.

### Edge Function Secrets (Supabase)
```
SUPABASE_URL          # Auto-set by Supabase
SUPABASE_ANON_KEY     # Auto-set by Supabase
SUPABASE_SERVICE_ROLE_KEY  # Auto-set by Supabase
ALLOWED_ORIGIN        # REQUIRED for production CORS — set to https://croprxsolutions.app
SEED_ADMIN_SECRET     # Required for seed-admin function only
```

---

## Common Patterns

### Adding a new page
1. Create page component in `src/pages/`
2. Add lazy import in `src/App.tsx`
3. Add Route inside the protected route block
4. Add navigation link in `src/components/layout/AppLayout.tsx`

### Adding a database column
1. Create migration file in `supabase/migrations/` with timestamp prefix
2. Update TypeScript interface in `src/types/index.ts`
3. Update any affected components

### Supabase queries
```typescript
import { supabase, checkMutationResult } from '../lib/db';

// Read
const { data, error } = await supabase.from('customers').select('*');

// Write (always check result)
const result = await supabase.from('customers').update({ farm_name: 'New Name' }).eq('id', customerId).select();
checkMutationResult(result, 'Update customer');
```

---

## QA Testing Methodology

### Role-Based Testing Matrix
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
| Team Board | Full | Full (own notes) | Full (own notes) | Full (own notes) |
| Settings | Full | No access | No access | No access |

### Workflow End-to-End Tests

**Quote to Delivery:**
1. Create customer with tier assignment
2. Create quote with product sections
3. Send quote (status -> sent)
4. Accept quote (status -> accepted)
5. Convert to order (creates order + order_items + commissions)
6. Create delivery from order
7. Assign driver
8. Confirm/start delivery (scheduled → in_progress, inventory check warning)
9. Complete delivery (updates inventory, order fulfillment, creates remainders for partial)
10. Record payment (updates order balance_due)

**Quick Delivery (ad-hoc):**
1. Open Quick Delivery modal (from Deliveries page or driver dashboard)
2. Search/select customer
3. Add products with quantities
4. Optionally assign driver, set date, add notes
5. Submit → creates order + delivery + draft invoice atomically
6. Sales rep reviews and posts the draft invoice

**Purchase Order to Inventory:**
1. Create PO with product items
2. Submit PO (status -> submitted)
3. Receive partial shipment (updates PO item, inventory, cost if changed)
4. Receive remaining (PO -> fully_received)
5. Verify inventory levels updated
6. Verify cost_history created if cost changed

### Edge Case Testing
- Negative inventory (receive more than expected)
- Expired quotes (auto-expire logic)
- Zero-quantity orders
- Commission splits that don't sum to 100%
- Concurrent hold creation exceeding available inventory
- Bulk imports with invalid data
- PDF generation with very long product names
- Delivery for cancelled order

---

## Common Pitfalls & Maintenance

### RLS Debugging
- If a query returns empty results unexpectedly, check RLS policies for the user's role
- Use `(select auth.uid())` not bare `auth.uid()` in policies for performance
- Test policies in Supabase SQL editor with `SET request.jwt.claims = '{"sub":"user-id"}'`
- The `profiles_select` policy uses `USING (true)` - this is intentional for CRM name lookups

### Migration Ordering
- Always name migrations with timestamp prefix: `YYYYMMDDHHMMSS_description.sql`
- Run `supabase db push` or apply via Supabase Dashboard SQL editor
- DROP POLICY IF EXISTS before CREATE POLICY to make migrations idempotent
- Check for existing triggers with `IF NOT EXISTS` guard

### TypeScript Types
- `src/types/index.ts` must match database columns
- When adding DB columns, always update the corresponding TypeScript interface
- Optional/nullable DB columns should be typed as `field: type | null`
- Relation fields (joined data) are optional: `customer?: Customer`

### Inventory Holds
- Holds reduce "free" inventory but don't change quantity_available
- Expired holds (expires_at < today) are excluded from calculations
- Release hold sets `is_active = false` rather than deleting

### CORS in Production
- All 3 edge functions default to `http://localhost:5173` for CORS
- Set `ALLOWED_ORIGIN` secret in Supabase: `supabase secrets set ALLOWED_ORIGIN=https://croprxsolutions.app`
- Without this, edge function calls will fail with CORS errors in production

### Offline Support
- **What it does:** When the browser loses connection, critical driver actions (delivery completion) queue in IndexedDB and auto-sync when reconnected.
- **Key files:** `src/lib/offlineQueue.ts` (IndexedDB queue), `src/lib/offlineSync.ts` (auto-retry on reconnect), `src/hooks/useOnlineStatus.ts` (online/offline detection), `src/components/ui/OfflineBanner.tsx` (yellow banner in AppLayout)
- **Scope:** Currently used in `DeliveryDetail.tsx` for delivery completion. Other pages do NOT have offline support — they simply show the OfflineBanner and block actions.
- **Status:** Built and unit-tested, but not heavily battle-tested with real field conditions. Consider this a "safety net" feature, not a full offline-first architecture.

### Known Limitations
- OCR processing uses Google Vision AI via Edge Function (requires GOOGLE_VISION_API_KEY secret)
- PDF generation is client-side - no server-side rendering
- No email sending capability (notifications are in-app only)
- Bulk imports process sequentially, not in parallel
- No audit trail for RLS policy violations (silent failures)

---

## AI Dev Memory / Quick Reference

### Code Patterns
- Bulk imports use a 3-state modal pattern: file selection -> validation/review -> results
- Bulk import components live in `src/components/{domain}/Bulk*.tsx`
- PDF text extraction uses `pdfjs-dist` (already installed), see `BulkOrderImport.tsx` for reference
- Product fuzzy matching via `fuzzyMatchProduct()` in `src/lib/ocrParser.ts` (0.7 threshold)
- PO number format: `PO-{YEAR}-{sequential 4-digit}` via count query
- Activity logging via `logActivity()` from `src/lib/activityLogger.ts`
- Product search modal pattern reused from `NewPurchaseOrder.tsx:400-453`
- Modal component accepts `size="large"` prop
- Commission split editor: `src/components/ui/CommissionSplitEditor.tsx`
- Blend math validator: `src/lib/blendMathValidator.ts`
- Manual ticket creation: `src/components/blendtickets/ManualTicketCreate.tsx`
- Admin user edit via `admin_update_profile` RPC (SECURITY DEFINER)
- Invoice number format: `INV-{YYYY}-{sequential 4-digit}` via count query
- Return number format: `RMA-{YYYY}-{sequential 4-digit}` via count query
- Claim number format: `RC-{YYYY}-{sequential 4-digit}` via count query
- Cycle count number format: `CC-{YYYY}-{sequential 4-digit}` via count query
- AR aging uses Supabase RPC `get_ar_aging()` — handles both invoiced and uninvoiced orders
- Customer statement uses RPC `get_customer_statement()` — running balance via window function
- Season comparison uses RPC `get_season_comparison()` — YoY metrics (July 1-June 30 seasons)
- Financial audit log: immutable append-only table, logged via `financial_audit_log` inserts
- Tab-based page layout pattern used in: ARaging (3 tabs), Compliance (2 tabs), Rebates (2 tabs), InventoryPage, BlendRecipes
- Job number format: `JOB-{YYYY}-{sequential 4-digit}` via `next_job_number()` RPC
- Application record number format: `APP-{YYYY}-{sequential 4-digit}` via `next_application_record_number()`
- Commission payment number format: `CP-{YYYY}-{sequential 4-digit}` via `next_commission_payment_number()`
- ReportShell component: reusable date range + season presets + CSV/PDF export wrapper (`src/components/reports/ReportShell.tsx`)
- LogbookReport component: 4 sub-tabs (by Customer/Applicator/Field/FAA) (`src/components/reports/LogbookReport.tsx`)
- Invoice PDF: 3 layouts via `src/lib/invoicePdf.ts` (756 lines)
- Statement PDF: dual-mode via `src/lib/statementPdf.ts` (818 lines)
- Year-end summary PDF: `src/lib/yearEndSummaryPdf.ts` (633 lines)
- Money pattern: all cents as bigint — display divides by 100, store multiplied by 100
- Atomic operations: PostgreSQL RPCs with `FOR UPDATE` row locks for race-free multi-table writes
- Field import: 3-step wizard (upload → attribute mapping → preview map → insert). Parser in `src/lib/fieldImportParser.ts`. Supports .shp/.dbf/.shx, .kml, .geojson. Uses proj4 for coordinate reprojection.
- ParsedImportField type in `src/types/index.ts` — includes boundary_geojson, centroid_geojson, calculated_acres, raw_properties, errors[], isValid
- Delivery enhancements (S18): edit/cancel/reassign deliveries, driver issue reporting (damaged/shortage/refused/wrong_product/access_issue/other), photo uploads (up to 10, compressed), delivery remainders with follow-up creation, batch cancel with reason
- Receiving system (S19): two-step receive modal (fill details → review summary → confirm), per-item condition/lot/notes/storage_location, receiving dashboard at /receiving with summary cards + DataTable, receiving receipt PDF with condition color-coding
- Delivery integrity (S20): two-step confirm→complete flow (StartDeliveryModal with inventory check warning), items locked to order (read-only in edit mode), order context columns (Ordered/Prev. Delivered/This Delivery/Remaining After), quick delivery modal (customer search + product picker → atomic order+delivery+invoice), is_quick_delivery flag on deliveries + invoices
- Delivery PDF: `src/lib/deliveryPdf.ts` — batch support, delivered vs planned columns, partial delivery amber highlight
- Receiving PDF: `src/lib/receivingPdf.ts` — CRX green header, condition color-coding, batch support

### Build & Type Checking
- `npm run build` for full build verification (pre-commit hook runs this automatically)
- `npx vitest run` for 766 unit tests (pre-commit hook runs this automatically)
- `npx tsc --noEmit` for type checking only
- `db.ts` uses fallback placeholder URL/key so `createClient()` doesn't crash in CI test environments (unit tests mock Supabase)
- Known warning: vendor-mapbox chunk is ~1,680KB (>500KB limit) — Mapbox is large, this is expected
- react-map-gl v8: import from `'react-map-gl/mapbox'`, NOT bare `'react-map-gl'`
- react-map-gl can't go in Vite manualChunks — only put `mapbox-gl`

### Key Files
- Types: `src/types/index.ts`
- DB client: `src/lib/db.ts`
- Auth context: `src/contexts/AuthContext.tsx` (provides `profile`, `role`)
- Deliveries page: `src/pages/Deliveries.tsx` (~900 lines, driver dashboard + batch actions + quick delivery)
- Delivery detail: `src/pages/DeliveryDetail.tsx` (~1350 lines, full lifecycle)
- Delivery components: `src/components/deliveries/` (BatchCancelModal, StartDeliveryModal, QuickDeliveryModal)
- Receiving log: `src/pages/ReceivingLog.tsx` (dashboard with summary cards + DataTable)
- PO detail: `src/pages/PurchaseOrderDetail.tsx` (~823 lines, two-step receive modal + receiving history)
- OCR Edge Function: `supabase/functions/process-blend-ticket/index.ts`
- User creation Edge Function: `supabase/functions/create-user/index.ts`

### Supabase Secrets Required
- `ALLOWED_ORIGIN` - CORS origin for production
- `GOOGLE_VISION_API_KEY` - Google Cloud Vision API key for OCR

## Development History

| Sprint | What | When |
|--------|------|------|
| S0-S6 | 109-defect audit fix | Feb 11 |
| S7-S11 | Vehicles, Jobs, Reports, Month-End, Finance | Feb 14-18 |
| S12 | Invoice & Statement PDF redesign (Chem-Man match) | Feb 19 |
| S13 | Finance Charge Intelligence (preview, grace periods, opt-out) | Feb 20 |
| S14 | Grower Share Transparency (per-grower $/acre pricing) | Feb 21 |
| S15 | Batch Operations (void, print, statements, apply prepayments) | Feb 22 |
| S16 | Unified Payment Allocation (new page, auto-allocate, prepay) | Feb 23 |
| S17 | Year-End Customer Summary (PDF: financials, products, acreage, YoY) | Feb 24 |
| S18 | Delivery System Enhancement (edit, batch, driver dashboard, remainders, photos) | Feb 25 |
| S19 | Receiving System Enhancement (event tracking, dashboard, PDF receipts) | Feb 26 |
| S20 | Delivery Integrity & Quick Delivery (confirm flow, locked items, ad-hoc deliveries) | Feb 27 |
| — | Bulk Field Import (shapefile/KML/GeoJSON wizard with proj4 reprojection) | Feb 16 |
| T3-002 | Comprehensive test coverage: 766 unit tests (45 files) + 31 E2E spec files | Feb 17 |
| — | OCR Parser Overhaul & Edge Function v4 (multi-line fields, look-behind values) | Feb 17 |
| — | Safety Audit & Business Logic Hardening (page permissions, notifications, E2E) | Feb 28-Mar 3 |
| — | Quick Receive Feature (vendor+product receiving without PO numbers) | Mar 4 |

---

## Documentation Index
- `CLAUDE.md` (this file) -- Complete project reference: architecture, schema, RPCs, business logic, feature inventory
- `README.md` -- Project overview, quick start, tech stack, feature summary
- `TESTING.md` -- Testing guide (beginner-friendly): setup, running unit & E2E tests, troubleshooting
- `DEPLOYMENT.md` -- Deployment instructions: Vercel/Netlify setup, env vars, Edge Function secrets, rollback
- `ENV_SETUP.md` -- Environment variable setup guide (gitignored)
