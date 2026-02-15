# CLAUDE.md - CRX Manager V1.0 Project Instructions

## Project Identity
- **Name:** CRX Manager V1.0 (Crop RX Solutions)
- **Repo:** https://github.com/masonwells1/CRX_Manager_V1.0
- **What it does:** Agricultural product distribution management system -- quotes, orders, deliveries, inventory, purchase orders, team collaboration, blend tickets, reports
- **Who it's for:** Crop RX Solutions (admin, sales reps, drivers)
- **Owner:** masonwells1 (beginner, 0 code experience -- explain things simply)

## Current State (as of 2026-02-15)
- **Tier 1-3 hardening:** COMPLETE (security, performance, offline support, idempotency, image compression, activity triggers)
- **Phases 4A-7:** COMPLETE (invoicing, fields, blend recipes, warehouses, cycle counts, returns/RMA, AR aging, compliance, rebates)
- **Phase 4B:** COMPLETE (Mapbox satellite maps: field boundary drawing, acreage auto-calc, map/list toggle, customer field mini-maps)
- **Sprints 7-11:** COMPLETE (Vehicles, Job Scheduling, Reporting, Month-End Close, Financial Workflows)
- **Sprint 12:** COMPLETE (Invoice & Statement PDF redesign — 3 invoice layouts, dual-mode statements, remittance stubs)
- **Sprints 13-17:** COMPLETE (Billing System Upgrade — finance charge intelligence, grower share transparency, batch operations, unified payment allocation, year-end customer summaries)
- **Deployed to:** Vercel (private preview/staging)
- **Test coverage:** 91 unit tests (Vitest) + 3 E2E test files (Playwright)
- **57 migrations** applied to remote Supabase
- **46 pages**, **46 components**, **~105 RPC functions**
- **See CONTEXT.md** for full business context and data model details
- **See `.claude/projects/C--/memory/`** for detailed topic files (MEMORY.md, rpc-reference.md, pages-and-components.md, migration-history.md, sprint12-pdf-system.md, sprints13-17-billing-upgrade.md)

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

---

## Application Architecture

### Tech Stack
- **Frontend:** React 18 + TypeScript + Vite
- **Backend:** Supabase (PostgreSQL + Auth + Edge Functions + Realtime + Storage)
- **Styling:** Tailwind CSS with custom theme (crx-green brand color)
- **Testing:** Playwright (E2E only, tests in `tests/e2e/`)
- **Deployment:** Vercel (private preview/staging), configured via `vercel.json`
- **Mapping:** Mapbox GL JS + react-map-gl + @mapbox/mapbox-gl-draw + @turf/area + @turf/centroid
- **PDF Generation:** jsPDF + jspdf-autotable (client-side)
- **OCR:** Tesseract.js + PDF.js (client-side), Google Vision AI (server-side Edge Function)
- **Signatures:** signature_pad
- **Icons:** Lucide React (do not install other icon libraries)

### Key Commands
```bash
npm run dev          # Start dev server (http://localhost:5173)
npm run build        # Production build
npm run preview      # Preview production build
npm run typecheck    # TypeScript error check
npm run lint         # ESLint
npm run test:e2e     # Run Playwright E2E tests
npm run test:e2e:ui  # Interactive Playwright UI
```

### User Roles
1. **admin** - Full CRUD on all tables. Manages users, products, costs, inventory, purchase orders, commissions.
2. **sales_rep** - Creates quotes, orders, deliveries. Manages own customers. Views own commissions. Cannot modify products/costs or purchase orders.
3. **driver** - Views assigned deliveries and related inventory. Updates delivery status. Cannot access quotes, orders, or financial data.

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
    deliveryPdf.ts     # Delivery receipt PDF generation
    csvExport.ts       # CSV export utility
    ocrParser.ts       # OCR text parsing for blend tickets
    blendMathValidator.ts # Blend recipe math validation
    quoteCalc.ts       # Quote calculation helpers
  hooks/
    useOnlineStatus.ts     # Online/offline detection
    useRealtimeSubscription.ts # Supabase realtime wrapper
    usePageMeta.ts         # Page title/meta
    useOCRProcessor.ts     # OCR processing hook
  pages/               # 34 page components (lazy-loaded from App.tsx)
  components/
    auth/              # LoginPage, ProtectedRoute
    layout/            # AppLayout, Sidebar, TopBar
    ui/                # Badge, Button, Card, DataTable, Modal, Input, Select, Skeleton, Toast, etc.
    map/               # MapContainer, DrawControl, FieldMarkers (Mapbox satellite maps)
    blendtickets/      # BulkTicketUpload
    customers/         # BulkCustomerImport
    orders/            # BulkOrderImport
    products/          # BulkProductImport, BulkPricingImport
    quotes/            # BulkQuoteImport
    team/              # ActivityFeed, CommentsSection, NotificationsPanel, TagsManager, TeamBoardFilters
  types/
    index.ts           # All TypeScript interfaces and types
  assets/              # Logo images
supabase/
  migrations/          # All database migrations (SQL, chronological order)
  functions/           # Edge Functions: create-user, seed-admin, setup-blend-tickets-storage
tests/
  e2e/                 # Playwright E2E tests (auth, customers, permissions)
```

### Pages (34 total)

| Route | Page | Description |
|-------|------|-------------|
| `/` | Dashboard | KPIs, revenue chart, upcoming deliveries, low stock alerts, open AR |
| `/products` | Products | Product master with tier pricing, bulk import |
| `/products/:id` | ProductDetail | Single product edit, cost history |
| `/customers` | Customers | Customer list with tier filtering, bulk import |
| `/customers/:id` | CustomerDetail | Customer profile, addresses, acreage, commission splits |
| `/quotes` | Quotes | Quote list with status filtering, duplication |
| `/quotes/new` | QuoteBuilder | Create quote with sections, rate calc, PDF generation |
| `/quotes/:id` | QuoteBuilder | Edit existing quote |
| `/orders` | Orders | Order list with fulfillment tracking |
| `/orders/new` | NewOrder | Manual order or quote conversion |
| `/orders/:id` | OrderDetail | Order detail with items, payments, deliveries |
| `/inventory` | InventoryPage | Stock levels, holds, receive/adjust, low stock |
| `/deliveries` | Deliveries | Delivery list with driver/date filtering |
| `/deliveries/new` | NewDelivery | Create delivery from order |
| `/deliveries/:id` | DeliveryDetail | Delivery detail, signature capture, PDF receipt |
| `/blend-tickets` | BlendTickets | OCR ticket processing with image upload |
| `/blend-tickets/:id` | BlendTicketDetail | OCR results, product extraction, review workflow |
| `/purchase-orders` | PurchaseOrders | Supplier PO list |
| `/purchase-orders/new` | NewPurchaseOrder | Create PO from inventory/products |
| `/purchase-orders/:id` | PurchaseOrderDetail | PO detail with receiving |
| `/brand-vs-generic` | BrandVsGeneric | Ingredient mapping: branded vs generic |
| `/reports` | Reports | Customer profitability, product profitability, commissions, monthly revenue. CSV export. |
| `/crop-programs` | CropPrograms | Seasonal crop program management |
| `/invoices` | Invoices | Invoice management with posting workflow |
| `/invoices/:id` | InvoiceDetail | Invoice detail with items, allocations, payments |
| `/fields` | Fields | Farm field management with map/list toggle (geospatial, FSA numbers) |
| `/fields/:id` | FieldDetail | Field detail with satellite map, boundary drawing, auto-acreage |
| `/recipes` | BlendRecipes | Saved blend recipe management (create, duplicate, edit) |
| `/cycle-counts` | CycleCounts | Inventory cycle counting with variance tracking |
| `/returns` | Returns | Returns/RMA workflow (request → approve → receive → credit) |
| `/payments` | Payments | Payment tracking and AR balance |
| `/ar-aging` | ARaging | AR aging buckets, customer statements, season comparison |
| `/compliance` | Compliance | Applicator license tracking, RUP product list |
| `/rebates` | Rebates | Manufacturer rebate programs and claim management |
| `/team-board` | TeamBoard | Kanban board: notes/todos/announcements, comments, real-time |
| `/notifications` | Notifications | User notification center |
| `/settings` | SettingsPage | Admin only: company settings, user management |

---

## Supabase Backend Reference

### Database Tables (40+ total)

**Core Business:**
- `profiles` - Users (id refs auth.users, email, full_name, role, phone, is_active)
- `customers` - Farms (farm_name, assigned_sales_rep, assigned_tier 1-3, acreage, commission_split jsonb)
- `customer_addresses` - Multiple addresses per customer (label, address, delivery_notes, is_default)
- `products` - Product master (product_name, sku, category, vendor, tier1/2/3 pricing, rates, is_rup, signal_word)
- `cost_history` - Cost change audit log (product_id, old/new costs and prices, change_note)
- `fields` - Farm fields (customer_id, field_name, county, acres, FSA numbers, crop_type, soil_type)
- `field_billing_defaults` - Per-field billing splits (field_id, customer_id, split_pct)

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
- `deliveries` - Scheduled deliveries (delivery_number, order_id, assigned_driver, scheduled_date, status, signature_url)
- `delivery_items` - Items on delivery (order_item_id, product_id, quantity)

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

### RPC Functions (SQL)
```sql
get_ar_aging(p_as_of_date date)           -- AR aging buckets by customer (current, 30, 60, 90, 120+ days)
get_customer_statement(p_customer_id, p_start_date, p_end_date) -- Chronological transactions with running balance
get_season_comparison(p_season_a, p_season_b) -- YoY revenue, profit, orders, active customers
get_fields_with_geojson(p_customer_id uuid DEFAULT NULL) -- Fields with centroid/boundary as GeoJSON text (for map markers)
get_field_geojson(p_field_id uuid)        -- Single field's centroid/boundary as GeoJSON text
save_field_geometry(p_field_id, p_centroid_geojson, p_boundary_geojson) -- Save PostGIS geo data from GeoJSON strings
```
AR/statement/season RPCs are `SECURITY DEFINER STABLE`. Geo RPCs use `SET search_path = public, extensions` for PostGIS access.

### Helper Functions (SQL)
```sql
is_admin()     -- SELECT EXISTS(profiles WHERE id = auth.uid() AND role = 'admin')
is_sales_rep() -- SELECT EXISTS(profiles WHERE id = auth.uid() AND role = 'sales_rep')
is_driver()    -- SELECT EXISTS(profiles WHERE id = auth.uid() AND role = 'driver')
```
All three are `SECURITY DEFINER STABLE`.

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
| purchase_orders | Admin | Admin | Admin | Admin |
| purchase_order_items | Admin | Admin | Admin | Admin |
| deliveries | Admin / Sales Rep / Driver (assigned) | Admin / Sales Rep (own) | Admin / Driver (assigned) | Admin |
| delivery_items | Admin / Sales Rep / Driver (via delivery) | Admin / Sales Rep | Admin | Admin |
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
24. `20260214000000` - Phase 4B Mapbox integration (customer_addresses lat/lng, get_fields_with_geojson, get_field_geojson, save_field_geometry RPCs)

### Edge Functions
- **create-user** - Admin-only: creates a new auth user with role metadata
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
- Created from orders with item selection
- Assigned to a driver
- Completion triggers inventory transactions (type: 'delivered')
- Signature capture and PDF receipt generation

### Purchase Order Lifecycle
`draft` -> `submitted` -> `partially_received` -> `fully_received` -> `cancelled`
- Receiving updates PO item quantities and inventory levels
- Auto-updates product cost if PO unit_cost differs
- Creates cost_history entries on cost changes
- Creates inventory_transaction (type: 'received')

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
ALLOWED_ORIGIN        # REQUIRED for production CORS (e.g. https://your-domain.com)
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

| Feature | Admin | Sales Rep | Driver |
|---------|-------|-----------|--------|
| Dashboard KPIs | Full view | Full view (no driver section) | Deliveries only |
| Products CRUD | Full | Read only | No access |
| Customers CRUD | Full | Own assigned only | Via delivery only |
| Quotes CRUD | Full | Own only | No access |
| Orders CRUD | Full | Create/Read | No access |
| Inventory | Full + receive/adjust | Read + holds | Read only |
| Deliveries | Full | Create/Read | Own assigned + update status |
| Purchase Orders | Full | No access | No access |
| Blend Tickets | Full | Upload/review | No access |
| Commissions | Full | Own only | No access |
| Payments | Full | Read/Create | No access |
| Invoices | Full | Read/Create | No access |
| Fields | Full | Own customer fields | No access |
| Blend Recipes | Full | Create/Edit | No access |
| Cycle Counts | Full | No access | No access |
| Returns/RMA | Full | Create/Read | No access |
| AR Aging | Full | No access | No access |
| Compliance | Full | Read only | No access |
| Rebates | Full | No access | No access |
| Team Board | Full | Full (own notes) | Full (own notes) |
| Settings | Full | No access | No access |
| User Management | Full | No access | No access |

### Workflow End-to-End Tests

**Quote to Delivery:**
1. Create customer with tier assignment
2. Create quote with product sections
3. Send quote (status -> sent)
4. Accept quote (status -> accepted)
5. Convert to order (creates order + order_items + commissions)
6. Create delivery from order
7. Assign driver
8. Complete delivery (updates inventory, order fulfillment)
9. Record payment (updates order balance_due)

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
- Set `ALLOWED_ORIGIN` secret in Supabase: `supabase secrets set ALLOWED_ORIGIN=https://your-domain.com`
- Without this, edge function calls will fail with CORS errors in production

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

### Build & Type Checking
- `npx tsc --noEmit` for type checking (no tsconfig issues)
- `npx vite build` for full build verification
- Product type has `is_active`, `current_cost`, `unit_size`, `sku`, `vendor` fields

### Key Files
- Types: `src/types/index.ts`
- DB client: `src/lib/db.ts`
- Auth context: `src/contexts/AuthContext.tsx` (provides `profile`, `role`)
- OCR Edge Function: `supabase/functions/process-blend-ticket/index.ts`
- User creation Edge Function: `supabase/functions/create-user/index.ts`

### Supabase Secrets Required
- `ALLOWED_ORIGIN` - CORS origin for production
- `GOOGLE_VISION_API_KEY` - Google Cloud Vision API key for OCR

## Documentation Index
- `CONTEXT.md` -- Full business context, features, data model, assumptions (READ THIS FIRST for deep understanding)
- `DATABASE_RELATIONSHIPS.md` -- Entity relationship diagrams and FK details
- `SCHEMA_QUICK_REFERENCE.sql` -- Complete SQL schema (may be outdated -- check migrations for latest)
- `TESTING.md` -- Testing guide (beginner-friendly)
- `DEPLOYMENT.md` -- Deployment to Vercel/Netlify
- `VERIFICATION.md` -- Setup verification and known issues
- `TEST_CHECKLIST.md` -- Pre-deployment checklist
