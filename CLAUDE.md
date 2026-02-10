# CRX Manager V1.0 - AI Dev/QA Reference

## Application Architecture

### Tech Stack
- **Frontend:** React 18 + TypeScript + Vite
- **Backend:** Supabase (PostgreSQL + Auth + Edge Functions + Realtime + Storage)
- **Styling:** Tailwind CSS with custom theme (crx-green brand color)
- **PDF Generation:** jsPDF (client-side)
- **OCR:** Tesseract.js (client-side, background polling)
- **Routing:** React Router v6 (lazy-loaded pages)

### User Roles
1. **admin** - Full CRUD on all tables. Manages users, products, costs, inventory, purchase orders, commissions.
2. **sales_rep** - Creates quotes, orders, deliveries. Manages own customers. Views own commissions. Cannot modify products/costs or purchase orders.
3. **driver** - Views assigned deliveries and related inventory. Updates delivery status. Cannot access quotes, orders, or financial data.

### Project Structure
```
src/
  pages/           # 26 page components
  components/
    auth/          # LoginPage, ProtectedRoute
    layout/        # AppLayout, Sidebar, TopBar
    ui/            # Badge, Button, Card, DataTable, Modal, Input, Select, Skeleton, Toast, etc.
    blendtickets/  # BulkTicketUpload
    customers/     # BulkCustomerImport
    orders/        # BulkOrderImport
    products/      # BulkProductImport, BulkPricingImport
    quotes/        # BulkQuoteImport
    team/          # ActivityFeed, CommentsSection, NotificationsPanel, TagsManager, TeamBoardFilters
  contexts/        # AuthContext (session, profile, role, signIn, signOut)
  hooks/           # useRealtimeSubscription, useOCRProcessor, usePageMeta
  lib/             # db, activityLogger, csvExport, deliveryPdf, quotePdf, ocrParser, notificationTriggers
  types/           # index.ts - all TypeScript interfaces
supabase/
  migrations/      # SQL migrations in chronological order
  functions/       # Edge functions: create-user, seed-admin, setup-blend-tickets-storage
```

### Pages (26 total)

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
| `/payments` | Payments | Payment tracking and AR balance |
| `/team-board` | TeamBoard | Kanban board: notes/todos/announcements, comments, real-time |
| `/notifications` | Notifications | User notification center |
| `/settings` | SettingsPage | Admin only: company settings, user management |

---

## Supabase Backend Reference

### Database Tables (28 total)

**Core Business:**
- `profiles` - Users (id refs auth.users, email, full_name, role, phone, is_active)
- `customers` - Farms (farm_name, assigned_sales_rep, assigned_tier 1-3, acreage, commission_split jsonb)
- `customer_addresses` - Multiple addresses per customer (label, address, delivery_notes, is_default)
- `products` - Product master (product_name, sku, category, vendor, tier1/2/3 pricing, rates)
- `cost_history` - Cost change audit log (product_id, old/new costs and prices, change_note)

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

**Config:**
- `app_settings` - Key-value settings (setting_key, setting_value)
- `ingredient_map` - Brand to generic product mapping
- `unit_conversions` - Unit conversion factors (unit, factor_oz)

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
- **blend-ticket-images** - Public bucket for OCR ticket images (10MB limit, JPEG/PNG only)

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

### Season Dates
- Season runs **July 1 to June 30**
- Delivered YTD calculated from season start
- Used in inventory calculations and reports

---

## Environment Variables

### Frontend (.env)
```
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key
```

### Edge Function Secrets (Supabase)
```
SUPABASE_URL          # Auto-set by Supabase
SUPABASE_ANON_KEY     # Auto-set by Supabase
SUPABASE_SERVICE_ROLE_KEY  # Auto-set by Supabase
ALLOWED_ORIGIN        # REQUIRED for production CORS (e.g. https://your-domain.com)
SEED_ADMIN_SECRET     # Required for seed-admin function only
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
| Team Board | Full | Full (own notes) | Full (own notes) |
| Settings | Full | No access | No access |
| User Management | Full | No access | No access |

### CRUD Verification
For each table, verify:
1. **Create** - Insert succeeds for authorized roles, fails for unauthorized
2. **Read** - Only authorized rows visible per RLS
3. **Update** - Only authorized rows modifiable
4. **Delete** - Only admin can delete (where applicable)

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

**Blend Ticket OCR:**
1. Upload ticket images
2. OCR processing queued and executed
3. Products extracted with confidence scores
4. Manual review and correction
5. Approve ticket

### Edge Case Testing
- Negative inventory (receive more than expected)
- Expired quotes (auto-expire logic)
- Zero-quantity orders
- Commission splits that don't sum to 100%
- Concurrent hold creation exceeding available inventory
- Virtual inventory rows (products on order but no inventory record)
- Bulk imports with invalid data
- PDF generation with very long product names
- Delivery for cancelled order

### Realtime Testing
- Open team board in two browser tabs, verify notes sync
- Create notification in one session, verify it appears in another
- Add comment to note, verify it appears live

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
- OCR processing is client-side (Tesseract.js) - can be slow on large images
- PDF generation is client-side - no server-side rendering
- No email sending capability (notifications are in-app only)
- Bulk imports process sequentially, not in parallel
- No audit trail for RLS policy violations (silent failures)
- `idempotency_keys` table exists in live DB with public ALL access - investigate origin
