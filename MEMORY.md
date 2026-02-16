# CRX Manager V1.0 — Complete Project Reference

> **Last updated:** February 16, 2026
> **Purpose:** Comprehensive reference for any AI agent working on this codebase.

---

## 1. Project Identity

- **Repo:** `C:\Users\mason\CRX_Manager_V1.0` (GitHub: `masonwells1/CRX_Manager_V1.0`)
- **GitHub user:** `masonwells1`
- **Auth:** HTTPS via `gh` CLI (`v2.86.0`)
- **Git identity:** `Mason Wells` / `253580866+masonwells1@users.noreply.github.com`
- **Latest commit:** `91c3e97` — Add bulk field import with shapefile, KML, and GeoJSON support
- **Branch:** `main` (clean, up to date with origin)

## 2. What CRX Manager Is

CRX Manager is a **full-stack agricultural chemical supply & distribution management system** built for a crop-input retailer. It replaces a legacy DOS-based system called "CheMan" (Chemical Manager). The application manages the entire lifecycle of agricultural chemical sales: product catalog, tiered pricing, customer management, field mapping, quoting, order processing, inventory, purchasing, deliveries, blend ticket processing (OCR), invoicing, payments, commissions, job scheduling, application recordkeeping, regulatory compliance reporting, and financial workflows.

**Domain:** Agricultural chemical distribution (crop inputs — herbicides, insecticides, fungicides, fertilizers, adjuvants, seed treatments).

**Users:** Admin, Sales Reps, Drivers (delivery), Applicators (licensed chemical applicators).

**Season model:** July 1 to June 30 crop year (e.g., season 2026 = July 2025 through June 2026).

## 3. Environment & Setup

### Prerequisites
- Windows OS, Git Bash shell
- Node.js `v24.13.0` + npm `11.6.2` at `/c/Program Files/nodejs/`
- Git `v2.53.0` with credential.helper=manager
- `gh` CLI at `/c/Program Files/GitHub CLI/gh.exe`

### PATH Setup (needed in new shell sessions)
```bash
export PATH="$PATH:/c/Program Files/GitHub CLI"
export PATH="$PATH:/c/Program Files/nodejs"
```

### Notes
- `tail` command not available in Git Bash on this machine — don't pipe to tail

### .env Setup (not in Git — recreate per machine)
When user says "set up my .env", create `CRX_Manager_V1.0/.env` with:
```
VITE_SUPABASE_URL=https://rhyzpcqhnizqbxphqdkr.supabase.co
VITE_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJoeXpwY3Fobml6cWJ4cGhxZGtyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzAzOTM2NDAsImV4cCI6MjA4NTk2OTY0MH0.WR0vAi_KeGF0OoJ8_dFH7uW6ael9M5xnm6OUo2IZy7U
VITE_MAPBOX_TOKEN=pk.eyJ1IjoibWFzb253ZWxscyIsImEiOiJjbWxsZGE4dTgwNXoyM2VxODR0dHF3ZXYxIn0.JubjJcu7eYRERoywCEXVLQ
```
All three are publishable client-side keys (safe in browser).

## 4. Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18, TypeScript, Vite, Tailwind CSS |
| Backend | Supabase (PostgreSQL 15, Auth, RLS, Edge Functions) |
| Supabase Project ID | `rhyzpcqhnizqbxphqdkr` |
| Maps | Mapbox GL JS (satellite imagery, field polygons via Mapbox Draw) |
| PDF Generation | jsPDF (quotes, deliveries, invoices, statements, reports) |
| OCR | Supabase Edge Function + OpenAI Vision API (blend ticket processing) |
| Signature Capture | signature_pad v5 |
| Testing | Vitest (91 unit tests), Playwright (E2E specs) |
| Offline Support | Service worker queue + sync |
| Routing | React Router v6 (createBrowserRouter) |
| State | React Context (AuthContext) + local component state |
| Code Splitting | Vite vendor splitting + React.lazy() for all 45 pages |

## 5. Architecture Patterns

### Money
All money values stored as **bigint cents** (e.g., `total_amount_cents`, `balance_cents`, `cost_per_unit_cents`). Display divides by 100.

### Sequential Numbers
Race-free generation via PostgreSQL advisory locks:
- `next_delivery_number()` → DEL-YYYY-NNNN
- `next_po_number()` → PO-YYYY-NNNN
- `next_application_record_number()` → APP-YYYY-NNNN
- `next_job_number()` → JOB-YYYY-NNNN
- `next_commission_payment_number()` → CP-YYYY-NNNN

### Atomic Operations
Complex multi-table writes use PostgreSQL RPCs with `FOR UPDATE` row locks:
- `save_quote()`, `save_job()`, `save_customer()`, `save_blend_ticket()`
- `save_purchase_order()`, `delete_purchase_order()`
- `convert_quote_to_order()`, `create_direct_order()`
- `complete_delivery()`, `complete_job()`
- `transfer_job_to_invoice()`

### Security
- Row Level Security (RLS) on every table
- `SECURITY DEFINER` functions with `SET search_path = public`
- Role helper functions: `is_admin()`, `is_sales_rep()`, `is_driver()`, `is_applicator()`
- Edge Functions for user creation (bypasses client-side auth limitations)

### Error Handling
- `checkMutationResult()` wired into 35+ mutations across 16 files
- Toast notifications for success/error feedback
- Confirmation dialogs for destructive actions

### Soft Deletes
- Products: `is_active` boolean (NOT `deleted_at`)
- Invoices, Jobs: `deleted_at` timestamptz
- Team notes: `deleted_at` timestamptz

## 6. User Roles & Permissions

| Role | Can Do |
|------|--------|
| `admin` | Everything. CRUD all entities, manage users, close periods, write-offs, commission payments, settings. |
| `sales_rep` | View/create/edit quotes, orders, customers, fields, jobs, invoices, blend tickets, application records. Cannot delete or manage users. |
| `driver` | View assigned deliveries, update delivery status, record signatures. Limited read access to customers/products. |
| `applicator` | View assigned jobs, record applied info (weather, gallons), view customers/products/fields/recipes. Cannot create jobs. |

## 7. All Pages (45 total)

### Core Sales Workflow
| Route | Page | Description |
|-------|------|-------------|
| `/` | Dashboard | KPI cards, today's jobs summary, recent activity |
| `/products` | Products | Product catalog with search/filter, bulk import |
| `/products/:id` | ProductDetail | Product CRUD form (pricing tiers, EPA info, RUP status) |
| `/customers` | Customers | Customer list with search/filter, bulk import |
| `/customers/:id` | CustomerDetail | Customer edit, credit limit, finance charge rate, transaction review link, prepayment apply |
| `/fields` | Fields | Field list with Mapbox map view |
| `/fields/:id` | FieldDetail | Field CRUD with polygon drawing on satellite map |
| `/quotes` | Quotes | Quote list with status filters |
| `/quotes/new` | QuoteBuilder | **Largest component (~52KB)**. Multi-line quote with tiered pricing, rate calc, commission splits, PDF generation |
| `/quotes/:id` | QuoteBuilder | Edit existing quote |
| `/orders` | Orders | Order list with status badges |
| `/orders/new` | NewOrder | Direct order creation (bypasses quote) |
| `/orders/:id` | OrderDetail | Order detail with status transitions, convert to invoice |

### Inventory & Purchasing
| Route | Page | Description |
|-------|------|-------------|
| `/inventory` | InventoryPage | Inventory levels, low-stock alerts, cost valuation |
| `/purchase-orders` | PurchaseOrders | PO list with status filters |
| `/purchase-orders/new` | NewPurchaseOrder | Create PO from vendor catalog |
| `/purchase-orders/:id` | PurchaseOrderDetail | PO detail, receive items, track deliveries |
| `/cycle-counts` | CycleCounts | Physical inventory count reconciliation |
| `/returns` | Returns | RMA/returns processing |

### Delivery
| Route | Page | Description |
|-------|------|-------------|
| `/deliveries` | Deliveries | Delivery list with status filters |
| `/deliveries/new` | NewDelivery | Create delivery from order |
| `/deliveries/:id` | DeliveryDetail | Delivery detail, partial delivery support, signature capture |

### Blend Tickets & Recipes
| Route | Page | Description |
|-------|------|-------------|
| `/blend-tickets` | BlendTickets | Blend ticket list (OCR-processed from uploaded images) |
| `/blend-tickets/:id` | BlendTicketDetail | Ticket review, approve/reject, create application record |
| `/recipes` | BlendRecipes | Reusable blend recipe management, create job from recipe |

### Invoicing & Payments
| Route | Page | Description |
|-------|------|-------------|
| `/invoices` | Invoices | Invoice list (unposted/posted), batch print, period-closed warnings |
| `/invoices/:id` | InvoiceDetail | Invoice detail, post/unpost, print PDF, write-off button |
| `/payments` | Payments | Payment recording and listing |
| `/ar-aging` | ARaging | Accounts receivable aging report, generate finance charges button |

### Job Scheduling (Sprint 8)
| Route | Page | Description |
|-------|------|-------------|
| `/jobs` | Jobs | Job list with date/status/customer filters, status badges |
| `/jobs/:id` | JobDetail | Full job editor: fields on map, chemical/recipe loading, vehicle/applicator assignment, applied info, loader worksheet, complete, transfer to invoice |

### Vehicles & Application Records (Sprint 7)
| Route | Page | Description |
|-------|------|-------------|
| `/vehicles` | Vehicles | Vehicle CRUD (ground/air), capacity, registration, status |
| `/vehicles/:id` | VehicleDetail | Single vehicle edit form |
| `/application-records` | ApplicationRecords | Read-only list of all chemical applications (from jobs + blend tickets) |

### Financial Workflows (Sprints 10-11)
| Route | Page | Description |
|-------|------|-------------|
| `/month-end` | MonthEndClose | Admin-only. Period status, checklist, batch statements, "Roll the Month" |
| `/commission-payments` | CommissionPayments | Admin-only. Create from unpaid commissions, post workflow |
| `/customer-transactions` | CustomerTransactionReview | Admin-only. Full per-customer transaction history with running balance |
| `/prepayments` | PrepaymentManager | Admin-only. Prepay balances, auto-apply to oldest invoices |

### Reporting (Sprint 9)
| Route | Page | Description |
|-------|------|-------------|
| `/reports` | Reports | Multi-category report framework: Logbook (4 variants), P&L, Gross Sales, Customer Balance, Commission Balance, Chemical History, Inventory Cost, Posted Applications, Chemical Sales, Price List, Field Locations |

### Team & Admin
| Route | Page | Description |
|-------|------|-------------|
| `/team-board` | TeamBoard | Internal notes, activity feed, comments, tags |
| `/notifications` | Notifications | Notification center |
| `/settings` | SettingsPage | Admin-only. User management (create with role), system settings |
| `/brand-vs-generic` | BrandVsGeneric | Brand vs generic product comparison |
| `/crop-programs` | CropPrograms | Crop program management |
| `/compliance` | Compliance | EPA/RUP compliance tracking |
| `/rebates` | Rebates | Vendor rebate tracking |

## 8. Component Library (41 components)

### UI Primitives (`src/components/ui/`)
Badge, Button, Card, Input, Select, Skeleton, Modal, Toast, EmptyState, SplitHeading, OfflineBanner, DataTable, UnsavedChangesModal, SignatureCanvas, CommissionSplitEditor

### Layout (`src/components/layout/`)
AppLayout, Sidebar, TopBar

### Auth (`src/components/auth/`)
LoginPage, ProtectedRoute

### Map (`src/components/map/`)
MapContainer, DrawControl, FieldMarkers

### Reports (`src/components/reports/`)
ReportShell (reusable date range + season presets + CSV/PDF export wrapper), LogbookReport (4 sub-tabs: by Customer/Applicator/Field/FAA)

### Fields (`src/components/fields/`)
BulkFieldImport (shapefile/KML/GeoJSON import wizard), AttributeMappingStep, ImportPreviewMap

### Bulk Imports (`src/components/*/Bulk*.tsx`)
BulkProductImport, BulkCustomerImport, BulkOrderImport, BulkPOImport, BulkQuoteImport, BulkPricingImport, BulkTicketUpload

### Team (`src/components/team/`)
ActivityFeed, CommentsSection, NotificationsPanel, TeamBoardFilters, TagsManager

### Invoices (`src/components/invoices/`)
WriteOffModal

### Root-level
EnvCheck, ErrorBoundary

## 9. Library Files (`src/lib/` — 23 files)

| File | Purpose |
|------|---------|
| `db.ts` | Supabase client initialization |
| `quoteCalc.ts` | Pure math: getTierPrice, getConversionFactor, recalcItem, computeQuoteTotals, validateCommissionSplits |
| `quotePdf.ts` | Quote PDF generation (jsPDF) |
| `deliveryPdf.ts` | Delivery ticket PDF |
| `invoicePdf.ts` | Invoice PDF (Sprint 10) |
| `statementPdf.ts` | Customer statement PDF (Sprint 10) |
| `reportPdf.ts` | Generic report PDF generator (Sprint 9) |
| `csvExport.ts` | CSV export utility |
| `ocrParser.ts` | Blend ticket OCR result parser |
| `blendMathValidator.ts` | Blend math validation logic |
| `activityLogger.ts` | Activity logging to team board |
| `notificationTriggers.ts` | Notification triggers (order status, large orders) |
| `idempotency.ts` | Idempotency key management |
| `imageCompression.ts` | Image compression for uploads |
| `offlineQueue.ts` | Offline action queue |
| `offlineSync.ts` | Offline sync manager |
| `quoteCalc.test.ts` | 29 unit tests for quote calculations |
| `blendMathValidator.test.ts` | 11 unit tests for blend math |
| `ocrParser.test.ts` | 23 unit tests for OCR parsing |
| `rpcContracts.test.ts` | 19 RPC contract tests |
| `paymentAllocation.test.ts` | 9 payment allocation tests |
| `fieldImportParser.ts` | Shapefile/KML/GeoJSON parsing, coordinate projection (proj4), attribute extraction |

## 10. Custom Hooks (`src/hooks/` — 6 hooks)

| Hook | Purpose |
|------|---------|
| `useSupabaseQuery` | Data fetching with AbortController, loading, error, refetch |
| `useUnsavedChanges` | Warns before navigating away from dirty forms |
| `useOnlineStatus` | Tracks online/offline state |
| `usePageMeta` | Sets page title and meta tags |
| `useRealtimeSubscription` | Supabase realtime channel subscription |
| `useOCRProcessor` | Manages blend ticket OCR processing state |

## 11. Edge Functions (4 functions)

| Function | Purpose |
|----------|---------|
| `create-user` | Creates new Supabase auth user + profile. Accepts admin/sales_rep/driver/applicator roles. |
| `process-blend-ticket` | OCR processing via OpenAI Vision API. Extracts product data from uploaded blend ticket images. |
| `seed-admin` | Seeds initial admin user for fresh deployments. |
| `setup-blend-tickets-storage` | Creates Supabase storage bucket for blend ticket images. |

## 12. Database Schema (67 tables)

### Core Business Tables
| Table | Description |
|-------|-------------|
| `profiles` | User profiles (extends Supabase auth.users). Roles: admin, sales_rep, driver, applicator. Columns include applicator_license_number, faa_certificate_number. |
| `products` | Product catalog. Tiered pricing (4 tiers), EPA registration, RUP status, signal word, product form (liquid/dry). Uses `is_active` boolean for soft delete. |
| `customers` | Customer records. Farm name, billing/shipping addresses, tax exempt status, prepay balance, credit limit, finance charge rate. |
| `fields` | Geographic field locations. Linked to customers. Mapbox polygon geometry, legal description, FSA details. |
| `vehicles` | Ground/air application equipment. Type, capacity, registration (FAA N-number or DOT#), status. |

### Quoting & Orders
| Table | Description |
|-------|-------------|
| `quotes` | Quote headers. Status: draft/sent/approved/rejected/converted. Links to customer, sales rep. |
| `quote_items` | Quote line items. Product, quantity, rate/acre, tier pricing, commission splits. |
| `quote_commission_splits` | Commission split percentages per quote item. |
| `orders` | Order headers. Status: pending/confirmed/processing/shipped/delivered/cancelled. |
| `order_items` | Order line items with cost and price tracking. |

### Inventory & Purchasing
| Table | Description |
|-------|-------------|
| `inventory` | Current stock levels per product. UNIQUE constraint on product_id. |
| `inventory_transactions` | Audit trail of all inventory movements (receipts, shipments, adjustments). |
| `purchase_orders` | PO headers. Status: draft/submitted/partial/received/cancelled. |
| `purchase_order_items` | PO line items with quantity ordered/received tracking. |
| `cycle_count_sessions` / `cycle_count_items` | Physical inventory count management. |

### Deliveries
| Table | Description |
|-------|-------------|
| `deliveries` | Delivery headers. Status: pending/in_transit/delivered/cancelled. Supports partial delivery. |
| `delivery_items` | Delivery line items with quantity_delivered for partial support. |

### Blend Tickets & Recipes
| Table | Description |
|-------|-------------|
| `blend_tickets` | OCR-processed blend ticket headers. Review status: pending/approved/rejected. |
| `blend_ticket_products` | Parsed product lines from blend tickets. |
| `blend_recipes` | Reusable blend recipe templates. |
| `blend_recipe_items` | Recipe line items with rates and products. |

### Invoicing & Payments
| Table | Description |
|-------|-------------|
| `invoices` | Invoice headers. Types: chemical_sale, field_application, misc_charge. Status: unposted/posted. Bigint cents for amounts. |
| `invoice_items` | Invoice line items. |
| `payments` | Payment records linked to invoices. |
| `prepayments` | Customer prepayment deposits. |

### Job Scheduling (Sprint 8)
| Table | Description |
|-------|-------------|
| `jobs` | Job headers. Status: scheduled/in_progress/completed/cancelled/invoiced. Links to customer, applicator, vehicle, recipe. |
| `job_fields` | Fields assigned to a job (many-to-many with sort order). |
| `job_chemicals` | Chemicals/products for a job with rates and pricing. |
| `job_applied_info` | Recorded data when job is completed: actual times, weather, gallons applied. |

### Application Records (Sprint 7)
| Table | Description |
|-------|-------------|
| `application_records` | **Single source of truth** for "what was applied, where, when, by whom." Fed from completed jobs AND approved blend tickets. Product data stored as JSONB. Weather conditions JSONB. |

### Financial (Sprints 10-11)
| Table | Description |
|-------|-------------|
| `accounting_periods` | Month-end close tracking. Status: open/closed. |
| `commissions` | Earned commissions per order/invoice. |
| `commission_payments` | Commission payment headers. Status: unposted/posted. |
| `commission_payment_items` | Individual commissions included in a payment. |
| `write_offs` | Invoice write-off records with reason and approval. |
| `finance_charges` | Interest charges on overdue invoices. |

### Supporting Tables
| Table | Description |
|-------|-------------|
| `activity_log` | Audit trail for all business operations. |
| `notifications` | In-app notification system. |
| `team_notes` | Internal team collaboration notes. |
| `comments` | Comments on various entities. |
| `tags` / `entity_tags` | Tagging system for notes/entities. |
| `returns` / `return_items` | RMA/returns processing. |
| `crop_programs` / `crop_program_items` | Crop program management. |
| `compliance_records` | EPA/RUP compliance tracking. |
| `rebates` / `rebate_items` | Vendor rebate tracking. |
| `settings` | System-wide key/value settings. |
| `brand_vs_generic` | Product comparison data. |

## 13. Key RPC Functions (~90 total)

### Atomic Save/Delete RPCs
- `save_quote(p_quote, p_items, p_splits, p_performed_by)` — atomic quote save
- `save_job(p_job, p_fields, p_chemicals, p_performed_by)` — atomic job save
- `save_customer(p_customer, p_performed_by)` — atomic customer save
- `save_blend_ticket(p_ticket, p_products, p_performed_by)` — atomic blend ticket save
- `save_purchase_order(p_po, p_items, p_performed_by)` — atomic PO save
- `delete_purchase_order(p_po_id)` — atomic PO delete with items
- `duplicate_quote(p_quote_id, p_performed_by)` — deep-copy quote

### Order & Delivery RPCs
- `convert_quote_to_order(p_quote_id, p_performed_by)` — quote→order conversion with FOR UPDATE locks
- `create_direct_order(p_order, p_items, p_performed_by)` — direct order creation
- `complete_delivery(p_delivery_id, p_quantities, p_performed_by)` — partial delivery support, inventory deduction

### Job Scheduling RPCs
- `complete_job(p_job_id, p_applied_info, p_performed_by)` — marks completed, creates application_record, deducts inventory
- `transfer_job_to_invoice(p_job_id, p_performed_by)` — creates invoice from job, sets status='invoiced'
- `load_recipe_into_job(p_job_id, p_recipe_id)` — copies recipe items into job chemicals

### Application Record RPCs
- `create_application_record_from_blend_ticket(p_blend_ticket_id, p_performed_by)` — approved blend ticket → application record

### Sequential Number RPCs
- `next_delivery_number()`, `next_po_number()`, `next_application_record_number()`, `next_job_number()`, `next_commission_payment_number()`

### Reporting RPCs (Sprint 9 — 10 RPCs)
- `get_logbook_by_customer(p_customer_id, p_start_date, p_end_date)`
- `get_logbook_by_applicator(p_applicator_id, p_start_date, p_end_date)`
- `get_logbook_by_field(p_field_id, p_start_date, p_end_date)`
- `get_logbook_faa(p_start_date, p_end_date)` — aerial only
- `get_bottom_line_pnl(p_start_date, p_end_date)`
- `get_gross_sales_report(p_start_date, p_end_date, p_group_by)`
- `get_customer_balance_listing(p_as_of_date)`
- `get_chemical_history(p_product_id, p_start_date, p_end_date)`
- `get_commission_balance_report(p_as_of_date)`
- `get_inventory_cost_report()`

### Financial RPCs (Sprints 10-11)
- `close_accounting_period(p_period_end, p_performed_by)` — validates & closes period
- `check_period_open(p_date)` — raises exception if date in closed period
- `generate_batch_statements(p_as_of_date, p_performed_by)` — customer statement data
- `get_monthly_summary(p_period_start, p_period_end)` — aggregated monthly report
- `create_commission_payment(p_commission_ids[], ...)` — atomic commission payment
- `post_commission_payment(p_payment_id, p_performed_by)`
- `apply_write_off(p_invoice_id, p_amount_cents, p_reason, p_performed_by)`
- `generate_finance_charges(p_as_of_date, p_performed_by)`
- `get_customer_transaction_review(p_customer_id, p_start_date, p_end_date)`
- `apply_remaining_prepayments(p_customer_id, p_performed_by)`

### Dashboard
- `dashboard_summary()` — 8 queries consolidated into 1 RPC

## 14. Migration Files (50 total)

### Original Schema (19 migrations, Feb 6-9)
Foundation tables, RLS policies, security fixes, team board, blend tickets, inventory, gap analysis fixes.

### Audit Sprints 0-5 (10 migrations, Feb 11)
```
20260211200000_sprint0_emergency_fixes.sql
20260211210000_atomic_quote_save.sql
20260211220000_sprint1_data_integrity.sql
20260211230000_atomic_customer_blend_quote_dup.sql
20260211240000_normalize_net_margin.sql
20260211250000_sprint2_validation_fixes.sql
20260211260000_number_generation_sequences.sql
20260211270000_dashboard_summary_rpc.sql
20260211280000_commission_recipient_fk.sql
20260211290000_partial_delivery_support.sql
```

### Feature Expansion (13 migrations, Feb 13-14)
Fields foundation, billing architecture, blend ticket/order linkage, blend recipes, inventory enhancements, returns/RMA, reporting/compliance/rebates, Mapbox integration.

### Sprints 7-11 (8 migrations, Feb 14-18)
```
20260214200000_vehicles_table.sql
20260214210000_applicator_role_expansion.sql
20260214220000_application_records_table.sql
20260215200000_job_scheduling_tables.sql
20260216200000_reporting_rpcs.sql
20260217200000_accounting_periods.sql
20260217210000_commission_payments.sql
20260218200000_financial_workflows.sql
```

**All 50 migrations have been applied to the remote Supabase database.**

## 15. Testing

### Unit Tests (91 tests via Vitest + jsdom)
- `quoteCalc.test.ts` — 29 tests: tier pricing, conversion factors, recalcItem, quote totals, commission validation
- `blendMathValidator.test.ts` — 11 tests: blend math validation
- `ocrParser.test.ts` — 23 tests: OCR result parsing
- `rpcContracts.test.ts` — 19 tests: RPC contract validation for 13+ RPCs
- `paymentAllocation.test.ts` — 9 tests: payment allocation logic

### E2E Tests (Playwright)
8 spec files: navigation, dashboard, products, quotes, orders, inventory, deliveries, POs, reports.

### Running Tests
```bash
cd CRX_Manager_V1.0
npx vitest run          # Unit tests
npx playwright test     # E2E tests
npm run build           # TypeScript compilation check
```

## 16. Development History

### Phase 1: Initial Build (Feb 6-9, 2026)
19 migrations, core schema, basic CRUD for all entities.

### Phase 2: 109-Defect Audit (Feb 11, 2026) — Sprints 0-6
Forensic audit identified 109 defects. Fixed across 7 sprints:
- **S0:** Emergency fixes — race conditions, FOR UPDATE locks, atomic RPCs
- **S1:** Data integrity — audit logging, notification triggers, atomic saves
- **S2:** Validation — rate_unit validation, numeric constraints, commission validation, CORS fix
- **S3:** Performance — query limits, dashboard RPC consolidation, code splitting (405KB→35KB bundle)
- **S4:** Accessibility — ARIA, focus traps, keyboard navigation, skip nav
- **S5:** Feature gaps — partial deliveries, signature capture, inventory alerts, commission FK
- **S6:** Test coverage — 82 unit tests + Playwright E2E specs

### Phase 3: Feature Expansion (Feb 13-14, 2026)
Fields with Mapbox polygon mapping, billing architecture, blend recipes, inventory enhancements, returns/RMA, reporting/compliance/rebates.

### Phase 4: CheMan Gap Closure (Feb 14-18, 2026) — Sprints 7-11
Closed the biggest gaps vs. the legacy CheMan system:
- **S7:** Vehicles, applicator role, application records
- **S8:** Job scheduling (create→assign→complete→invoice)
- **S9:** Reporting engine (14 reports: 4 logbook, 6 financial, 4 operational)
- **S10:** Month-end close, invoice/statement PDFs, commission payment lifecycle
- **S11:** Financial workflows (write-offs, finance charges, prepayment application, transaction review)

### Phase 5: Bulk Field Import (Feb 16, 2026)
- Shapefile (.shp/.dbf/.shx), KML, and GeoJSON import wizard on Fields page
- 3-step flow: upload files → map attributes to field columns → preview on map → bulk insert
- Coordinate reprojection via proj4 (handles non-WGS84 shapefiles)
- New deps: shapefile, proj4, togeojson-with-extended-style, @turf/bbox

## 17. Key Files for Quick Reference

| File | Why It Matters |
|------|---------------|
| `src/types/index.ts` | **All TypeScript interfaces** — start here to understand data shapes |
| `src/App.tsx` | **All routes** — 45 lazy-loaded pages with role guards |
| `src/components/layout/Sidebar.tsx` | **Navigation structure** — what each role sees |
| `src/pages/QuoteBuilder.tsx` | **Largest component (~52KB)** — core pricing logic |
| `src/lib/quoteCalc.ts` | **Pure math functions** — extracted from QuoteBuilder |
| `src/lib/db.ts` | **Supabase client** — single instance |
| `src/contexts/AuthContext.tsx` | **Auth state** — role, profile, loading |
| `src/hooks/useSupabaseQuery.ts` | **Data fetching pattern** — used across all pages |

## 18. Current Capabilities Summary

| Capability | Status |
|-----------|--------|
| Product catalog with tiered pricing | Complete |
| Customer management with fields/mapping | Complete |
| Quote builder with commission splits | Complete |
| Order processing (from quote or direct) | Complete |
| Inventory management with alerts | Complete |
| Purchase order lifecycle | Complete |
| Delivery management (partial support) | Complete |
| Blend ticket OCR processing | Complete |
| Blend recipe management | Complete |
| Invoice generation & posting | Complete |
| Payment recording | Complete |
| Vehicle management (ground/air) | Complete |
| Job scheduling (create→complete→invoice) | Complete |
| Application recordkeeping | Complete |
| Logbook reports (4 variants, regulatory) | Complete |
| Financial reports (P&L, Gross Sales, etc.) | Complete |
| Month-end close with period locking | Complete |
| Commission payment lifecycle | Complete |
| Write-offs & finance charges | Complete |
| Prepayment application | Complete |
| Customer transaction review | Complete |
| PDF generation (quotes, invoices, statements, reports) | Complete |
| CSV export | Complete |
| Offline support | Complete |
| Accessibility (ARIA, keyboard nav) | Complete |
| Bulk field import (shapefile/KML/GeoJSON) | Complete |
| 91 unit tests + E2E specs | Complete |

### Deferred to Post-Pilot
- Aerial-specific entities (obstructions, airport strips, ground crews, pests)
- Flight/Tach, Fuel Usage, Application Time reports
- Data comparison graphs (sales/acres by month with charts)
- Invoice email sending (requires email service integration)
- Customer discount balance
- Batch invoice unpost/repost
- Job batching and mass edit
- Dispatch view (real-time applicator tracking)

## 19. Commits (Major)

| Hash | Description |
|------|-------------|
| `9860e29` | Sprint 0-2: 29 files, 2121+/525- |
| `bb2bc45` | Sprint 3: 18 files, 372+/132- |
| `b7af6c8` | Sprint 4: 20 files, 117+/17- |
| `8213c04` | Sprint 5: 9 files, 775+/25- |
| `de8b708` | Sprint 6: 17 files, 4080+/233- |
| `fda6700` | Sprints 7-11: Vehicles, Job Scheduling, Reporting, Month-End, Financial Workflows |
| `e0c920d` | Sprints 13-17: Billing upgrade — finance charges, grower shares, batch ops, payment allocation, year-end |
| `cfd8d37` | Fix invoice PDF print handler firing multiple times per click |
| `91c3e97` | Add bulk field import with shapefile, KML, and GeoJSON support |
