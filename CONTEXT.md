# CRX Manager V1.0 - Project Context

**Last Updated:** 2026-02-11
**Version:** 1.0
**Test User:** mason@croprxsolutions.com

---

## 1. Problem Statement

This application solves the operational challenges for **Crop RX Solutions**, an agricultural product distributor that sells crop protection chemicals, fertilizers, and related products to farmers.

### Core Problems Being Solved:
- **Manual Quote Creation**: Sales reps were manually creating quotes in spreadsheets, leading to pricing errors and inconsistent margins
- **Order Fulfillment Chaos**: No centralized system to track which orders were fulfilled, partially fulfilled, or pending delivery
- **Inventory Blind Spots**: No real-time visibility into what products are available, pre-booked, or on order from vendors
- **Pricing Complexity**: Managing 3-tier pricing (based on customer tier) across 598+ products with frequent cost changes
- **Team Communication**: Sales reps, drivers, and admin staff had no shared system for notes, tasks, and handoffs
- **Commission Tracking**: Manual calculation of split commissions between multiple sales reps
- **Delivery Management**: Drivers had no digital system for scheduled deliveries, signatures, or proof of delivery

### Business Context:
Crop RX Solutions serves farmers who need agricultural chemicals delivered to their farms. The company:
- Maintains a catalog of 598+ products (herbicides, fungicides, fertilizers, etc.)
- Uses tiered pricing (Tier 1, 2, 3) based on customer volume
- Splits commissions between multiple sales reps
- Tracks inventory across multiple locations
- Schedules deliveries with driver assignments
- Needs to maintain detailed records for regulatory compliance (EPA registrations, etc.)

---

## 2. Who the App is For

### Primary Users:

#### **Admin (Owner/Manager)**
- **Full system access** - can see and modify everything
- Creates and manages user accounts
- Manages product catalog and pricing
- Creates purchase orders to vendors
- Oversees all quotes, orders, and deliveries
- Runs reports and analytics
- Manages inventory across locations
- Configures app settings

#### **Sales Rep**
- **Customer-scoped access** - can only see customers assigned to them
- Creates and manages customers
- Builds quotes with multi-tier pricing
- Converts quotes to orders
- Tracks their own commissions
- Views product catalog (read-only for pricing)
- Receives notifications for their customers
- Can view inventory availability
- Cannot create purchase orders or manage drivers

#### **Driver**
- **Delivery-focused access** - can only see deliveries assigned to them
- Views scheduled deliveries
- Sees customer delivery addresses and notes
- Marks deliveries as in-progress or completed
- Captures delivery signatures
- Generates delivery receipts
- Cannot see quotes, orders, or financial data
- Cannot manage customers or products

### User Roles Summary:
```
admin         → Everything (all CRUD operations)
sales_rep     → Customers (assigned only), Quotes, Orders, Products (read-only)
driver        → Deliveries (assigned only), Customer addresses (read-only)
```

---

## 3. Core Features (Current State)

### Authentication & Access Control
- **Email/password authentication** via Supabase Auth
- **No email confirmation** (disabled for easier testing)
- **Auto-profile creation** when new user signs up
- **Role-based access control** (admin, sales_rep, driver)
- **Row Level Security (RLS)** enforced on all tables
- Persistent sessions across browser refreshes

### Customer Management
- Create, edit, view, delete customers (farm/grower accounts)
- Assign customers to sales reps
- Track customer tier (1, 2, 3) for pricing
- Multiple delivery addresses per customer
- Track total acres, crop types (corn, soybean, other)
- Payment terms and notes
- Commission split configuration per customer
- **Bulk CSV import** for customers

### Product Catalog
- 598+ products with SKU, category, vendor, manufacturer
- Container sizes and unit types
- **3-tier pricing** (Tier 1, 2, 3) with automatic margin calculation
- Cost history tracking (tracks every price change over 2 years)
- Rate per acre calculations
- EPA registration numbers for chemicals
- Active/inactive product status
- **Bulk CSV import** for products and pricing updates

### Quote Builder
- Create multi-section quotes (e.g., "Corn Program", "Soybean Program")
- Add products to sections with custom rates and acres
- **Automatic price calculation** based on customer tier
- **Real-time margin display** (shows profit and net margin percentage)
- Calculate total units needed based on acres and application rate
- Price per acre calculations
- Save as draft or send to customer
- Version history (snapshots when quote is sent)
- Convert accepted quotes to orders
- Quote expiration tracking (default 15 days)
- PDF generation
- **Bulk CSV import** for quotes

### Order Management
- Orders created from quotes or manually
- Track order items with fulfillment status
- See quantity delivered vs. quantity remaining
- Order status: confirmed, partially_fulfilled, fulfilled, cancelled
- Commission calculations with split tracking
- Links back to original quote
- **Bulk CSV import** for orders

### Delivery Management
- Schedule deliveries from orders
- Assign drivers to deliveries
- Select delivery address from customer's saved addresses
- Scheduled date and time
- Delivery status: scheduled, in_progress, completed, cancelled
- **Digital signature capture** on mobile/tablet
- Generate delivery receipt PDFs
- Track completion timestamp and signed-by name
- Delivery notes and special instructions

### Inventory Tracking
- Real-time inventory levels by product and location
- Quantity available, pre-booked, and on order
- **Inventory transactions** audit trail with types:
  - Received (from vendor)
  - Booked (reserved for order)
  - Delivered (to customer)
  - Returned (from customer)
  - Adjusted (manual count corrections)
  - Transferred (between locations)
- Links transactions to orders, deliveries, or purchase orders
- Last counted timestamp

### Purchase Orders
- Create POs to vendors for restocking
- Track PO items with quantity ordered vs. received
- PO status: draft, submitted, partially_received, fully_received, cancelled
- Expected delivery dates
- Automatic inventory increase when items are received
- Cost tracking

### Team Collaboration (Team Board)
- **Team notes** with types: note, todo, announcement
- Priority levels: low, medium, high, urgent
- Assign tasks to team members
- Due dates and completion tracking
- Pin important notes to top
- **Real-time comments** on notes
- **Activity feed** showing all system actions
- **Notifications panel** for assigned tasks and mentions

### Blend Tickets System
- Create blend tickets for custom chemical mixing
- Track blend formulations
- Upload supporting documents (PDFs, images)
- **Bulk CSV upload** for blend tickets
- Storage bucket integration

### Brand vs Generic Comparison
- Compare branded products to generic equivalents
- Ingredient mapping
- Cost savings analysis
- Identify generic alternatives with bulk availability

### Reports & Analytics
- Commission reports (by rep, by period)
- Sales reports by customer
- Product performance reports
- Inventory valuation
- Order fulfillment metrics
- Export to PDF

### Real-time Features
- **Real-time subscriptions** for notifications (using Supabase Realtime)
- Live activity feed updates
- Instant notification delivery
- Auto-refresh on data changes

### Bulk Import Features
- **CSV imports** for:
  - Customers
  - Products
  - Product pricing updates
  - Quotes
  - Orders
  - Blend tickets
- Validation and error reporting
- Preview before import

---

## 4. Architecture (Simple Overview)

### Frontend
- **Framework:** React 18 with TypeScript
- **Build Tool:** Vite (fast dev server and optimized production builds)
- **Styling:** Tailwind CSS (utility-first CSS framework)
- **Routing:** React Router v7
- **Icons:** Lucide React (consistent icon library)
- **State Management:** React Context API for auth state
- **PDF Generation:** jsPDF with autotable plugin
- **OCR/Document Processing:** Tesseract.js and PDF.js for bulk imports
- **Digital Signatures:** signature_pad library

### Backend & Database
- **Database:** Supabase (hosted PostgreSQL)
- **Authentication:** Supabase Auth (email/password)
- **File Storage:** Supabase Storage (for blend ticket documents, signatures, PDFs)
- **Real-time:** Supabase Realtime (WebSocket subscriptions)
- **Edge Functions:** Supabase Edge Functions (serverless TypeScript/Deno)

### Authentication Flow
1. User enters email/password on login page
2. Supabase Auth validates credentials
3. On successful auth, JWT token stored in browser
4. **Automatic profile creation**: When user signs up, a database trigger (`handle_new_user()`) automatically creates a profile record
5. Profile includes role (admin, sales_rep, driver)
6. All API calls include JWT in Authorization header
7. Session persists across page refreshes

### Row Level Security (RLS)
**CRITICAL:** RLS is enabled on all tables and enforces all access control.

- **Admins:** Can see and modify everything
- **Sales Reps:** Can only see/modify customers assigned to them (and related quotes/orders)
- **Drivers:** Can only see deliveries assigned to them

RLS policies use helper functions:
- `is_admin()` - checks if current user has admin role
- `is_sales_rep()` - checks if current user has sales_rep role
- `is_driver()` - checks if current user has driver role

Example: Sales reps can only view customers where `assigned_sales_rep = auth.uid()`

### Edge Functions
Three edge functions deployed:
1. **create-user**: Admin tool to create new users with specific roles
2. **seed-admin**: One-time setup to create initial admin user
3. **setup-blend-tickets-storage**: Sets up storage bucket for blend ticket files

### Environment Variables
```
VITE_SUPABASE_URL=<your-supabase-project-url>
VITE_SUPABASE_ANON_KEY=<your-supabase-anon-key>
```

All variables prefixed with `VITE_` to be accessible in frontend.

---

## 5. Data Model (All 25 Tables)

### Authentication & Users

**profiles** → User accounts with roles
- `id` (uuid, links to auth.users)
- `email`, `full_name`, `phone`
- `role` (admin | sales_rep | driver)
- `is_active` (boolean)
- **Relationships:** Referenced by almost every table as `created_by`, `assigned_to`, etc.

---

### Product Catalog

**products** → 598+ agricultural products
- `id`, `product_name`, `sku`, `category`, `vendor`, `manufacturer`
- `container_size`, `unit_size`
- `current_cost`, `cost_updated_date`
- `tier1_price`, `tier1_margin`, `tier2_price`, `tier2_margin`, `tier3_price`, `tier3_margin`
- `tier1_price_per_acre`, `tier2_price_per_acre`, `tier3_price_per_acre`
- `suggested_rate`, `rate_per_acre`, `rate_unit`
- `epa_registration` (for chemicals)
- `is_active`
- **Relationships:** Used by quote_items, order_items, inventory, purchase_order_items, delivery_items

**cost_history** → Audit trail for price changes
- `product_id` → products
- `changed_by` → profiles
- `old_cost`, `new_cost`
- `old_tier1_price`, `new_tier1_price` (etc. for all tiers)
- `change_note`, `changed_at`
- **Purpose:** Track pricing changes over time (2+ years of history)

---

### Customer Management

**customers** → Farm/grower accounts
- `id`, `farm_name`, `contact_name`, `phone`, `email`
- `billing_address`
- `assigned_tier` (1, 2, or 3) - determines which tier pricing they get
- `assigned_sales_rep` → profiles
- `total_acres`, `corn_acres`, `soybean_acres`, `other_acres`
- `payment_terms`, `default_commission_split` (jsonb)
- `is_active`
- **Relationships:** Has many customer_addresses, quotes, orders, deliveries, commissions

**customer_addresses** → Multiple delivery locations per customer
- `customer_id` → customers
- `label`, `address_line`, `city`, `state`, `zip`
- `delivery_notes`
- `is_default` (boolean)
- **Relationships:** Used by deliveries.delivery_address_id

---

### Quote Workflow

**quotes** → Price quotes for customers
- `quote_number` (unique)
- `customer_id` → customers
- `created_by` → profiles
- `tier` (1, 2, or 3) - which pricing tier to use
- `status` (draft | sent | revised | accepted | declined | expired)
- `commission_split` (jsonb)
- `total_price`, `total_cost`, `total_profit`, `total_margin_pct`
- `valid_days`, `expires_at`
- `header_notes`, `footer_notes`
- `sent_at`
- **Relationships:** Has many quote_sections, quote_versions; Creates one order when accepted

**quote_sections** → Groups of products within a quote
- `quote_id` → quotes
- `section_name` (e.g., "Corn Program", "Soybean Program")
- `sort_order`
- `section_notes`
- **Purpose:** Organize quote into logical sections
- **Relationships:** Has many quote_items

**quote_items** → Individual products in a quote
- `quote_id` → quotes
- `section_id` → quote_sections
- `product_id` → products
- `sort_order`
- `notes`
- `price_per_unit`, `current_cost`
- `suggested_rate`, `actual_rate`, `rate_unit`
- `oz_per_acre`, `price_per_acre`
- `acres`, `total_units_needed`, `unit_size`
- `profit`, `total_price`, `net_margin`
- **Purpose:** Calculate pricing and quantities based on acres and application rates

**quote_versions** → Snapshots of quotes when sent
- `quote_id` → quotes
- `version_number`
- `sent_by` → profiles
- `sent_at`, `sent_method`
- `snapshot_data` (jsonb - full quote data frozen in time)
- `pdf_url`
- **Purpose:** Maintain history of what customer saw in each version

---

### Order Management

**orders** → Confirmed customer orders
- `order_number` (unique)
- `quote_id` → quotes (nullable - orders can be created without quote)
- `customer_id` → customers
- `status` (confirmed | partially_fulfilled | fulfilled | cancelled)
- `commission_split` (jsonb)
- `total_price`, `total_cost`, `total_profit`, `total_margin_pct`
- `order_date`
- **Relationships:** Has many order_items, deliveries, commissions, inventory_transactions

**order_items** → Products in an order with fulfillment tracking
- `order_id` → orders
- `product_id` → products
- `quote_item_id` → quote_items (nullable - tracks origin)
- `section_name`, `product_name`
- `price_per_unit`, `cost_per_unit`
- `actual_rate`, `rate_unit`, `acres`
- `total_units_needed`, `unit_size`
- `total_price`, `profit`, `net_margin`
- `quantity_delivered`, `quantity_remaining`
- **Purpose:** Track how much has been delivered vs. how much is still pending

---

### Inventory

**inventory** → Current stock levels by product and location
- `product_id` → products
- `location` (e.g., "Main Warehouse", "Satellite Location")
- `quantity_available` (can be sold)
- `quantity_prebooked` (reserved for orders)
- `quantity_on_order` (incoming from vendor)
- `unit_size`
- `last_counted_at`
- **Relationships:** Updated by inventory_transactions

**inventory_transactions** → Audit trail of all inventory movements
- `product_id` → products
- `transaction_type` (received | booked | delivered | returned | adjusted | transferred)
- `quantity` (positive or negative)
- `from_location`, `to_location`
- `order_id` → orders (nullable)
- `purchase_order_id`, `delivery_id` (nullable)
- `performed_by` → profiles
- `notes`
- **Purpose:** Complete audit trail of every inventory change

---

### Procurement

**purchase_orders** → Orders to vendors for restocking
- `po_number` (unique)
- `vendor`
- `status` (draft | submitted | partially_received | fully_received | cancelled)
- `submitted_date`, `expected_delivery_date`
- `total_cost`
- `created_by` → profiles
- **Relationships:** Has many purchase_order_items

**purchase_order_items** → Products being ordered from vendor
- `purchase_order_id` → purchase_orders
- `product_id` → products
- `quantity_ordered`, `unit_cost`
- `quantity_received` (tracks partial receipts)
- `unit_size`
- **Purpose:** When received, creates inventory_transactions

---

### Delivery Management

**deliveries** → Scheduled shipments to customers
- `delivery_number` (unique)
- `order_id` → orders
- `customer_id` → customers
- `delivery_address_id` → customer_addresses
- `assigned_driver` → profiles
- `scheduled_date`, `scheduled_time`
- `status` (scheduled | in_progress | completed | cancelled)
- `delivery_notes`
- `completed_at`, `signature_url`, `signed_by`
- `receipt_pdf_url`
- `created_by` → profiles
- **Relationships:** Has many delivery_items

**delivery_items** → Products being delivered
- `delivery_id` → deliveries
- `order_item_id` → order_items
- `product_id` → products
- `quantity`, `unit_size`
- **Purpose:** Track what's on each truck load

---

### Financial

**commissions** → Commission calculations per order
- `order_id` → orders
- `customer_id` → customers
- `recipient` (sales rep name)
- `split_percentage`, `commission_amount`
- `order_profit`, `order_date`
- `status` (pending | paid)
- **Purpose:** Track who gets paid what for each order

---

### Team Collaboration

**team_notes** → Shared notes, tasks, announcements
- `title`, `content`
- `note_type` (note | todo | announcement)
- `priority` (low | medium | high | urgent)
- `is_completed`, `completed_by` → profiles, `completed_at`
- `due_date`
- `created_by` → profiles
- `assigned_to` → profiles
- `is_pinned` (keep at top)
- **Relationships:** Has many team_note_comments

**team_note_comments** → Discussion threads on notes
- `note_id` → team_notes
- `content`
- `created_by` → profiles

---

### Activity & Notifications

**activity_feed** → System-wide activity log
- `event_type`, `description`
- `performed_by` → profiles
- `related_entity_type` (e.g., "quote", "order", "delivery")
- `related_entity_id` (polymorphic - not enforced by FK)
- `customer_id` → customers (optional)
- **Purpose:** Shows "Sales Rep John created Quote Q-2024-001 for ABC Farms"

**notifications** → User-specific notifications
- `user_id` → profiles
- `title`, `message`
- `notification_type`
- `is_read`
- `related_entity_type`, `related_entity_id` (polymorphic)
- **Purpose:** "You were assigned to deliver Order O-2024-001"

---

### Blend Tickets System

**blend_tickets** → Custom chemical mixing instructions
- `ticket_number`, `customer_id` → customers
- `product_mix` (jsonb - array of products and quantities)
- `target_acres`, `application_rate`
- `status` (draft | approved | mixed | delivered)
- `created_by` → profiles
- `document_urls` (array of uploaded PDFs/images in Supabase Storage)
- **Purpose:** Track custom blends that aren't standard products

---

### Reference Data

**unit_conversions** → Conversion factors for different units
- `unit` (e.g., "Gal", "Qt", "Lb", "Oz")
- `factor_oz` (conversion factor to ounces)
- **Purpose:** Convert between gallons, quarts, pounds, etc. for rate calculations

**ingredient_map** → Maps brand names to generic equivalents
- `branded_ingredient` (e.g., "Roundup PowerMax")
- `generic_product_id` → products (e.g., links to "Glyphosate 48.8%")
- `generic_has_bulk` (boolean)
- `fallback_branded_product`
- **Purpose:** Help "Brand vs Generic" comparison feature

**app_settings** → Global configuration
- `setting_key` (unique), `setting_value`
- `updated_by` → profiles
- **Purpose:** Store things like default quote validity days, company info, etc.

---

## 6. What Has Been Completed & What is Next

### Completed Hardening (Tier 1-3)

All security and performance hardening work has been completed across three tiers:

#### Tier 1: Security Audit Fixes (commit c45f370)
- Atomic RPC functions for critical multi-table operations (quote-to-order conversion, delivery completion, inventory receiving)
- Database constraints and check constraints added
- Auth hardening (session validation improvements)
- RLS policy audit and fixes on all 25 tables
- Performance indexes on all foreign key columns

#### Tier 2: Additional Security & Performance (commit a41156e)
- File upload validation (type checking, size limits) for blend ticket images
- Signed URL generation for Supabase Storage (no public URLs)
- RLS mutation result checking via `checkMutationResult()` utility in `src/lib/db.ts`
- Silent RLS failure detection on all update/delete operations

#### Tier 3: Production Hardening (commit f7a0aa2)
- **T3-001 Offline Support:** IndexedDB-based offline queue (`src/lib/offlineQueue.ts`, `src/lib/offlineSync.ts`), online status hook (`src/hooks/useOnlineStatus.ts`), auto-sync when connection returns
- **T3-003 Idempotency Keys:** Key generator (`src/lib/idempotency.ts`) for critical operations to prevent double-submissions
- **T3-004 Image Compression:** Client-side image compression (`src/lib/imageCompression.ts`) before Supabase upload -- max 1920px, JPEG quality 0.8, max 1MB
- **T3-005 Activity & Notification Triggers:** Automated activity logging (`src/lib/activityLogger.ts`), notification triggers (`src/lib/notificationTriggers.ts`) including low-stock alerts, quote expiration checks, delivery assignment notifications

### NOT YET STARTED

#### T3-002: Comprehensive Test Coverage (10-15 day effort)
**This is the next major task.** Currently only 3 E2E test files exist:
- `tests/e2e/auth.spec.ts` (login/logout)
- `tests/e2e/customers.spec.ts` (customer CRUD)
- `tests/e2e/permissions.spec.ts` (role-based access)

Still needed:
- Unit tests for pricing/margin calculations
- Unit tests for rate-per-acre calculations
- E2E tests for quote builder workflow
- E2E tests for order creation and fulfillment
- E2E tests for delivery workflow (schedule, assign, complete, signature)
- E2E tests for inventory transactions
- E2E tests for purchase order workflow
- E2E tests for bulk CSV imports
- E2E tests for blend ticket upload and OCR processing

### Remaining Production Readiness Gaps (Not Part of Tiers)

These items from the original gap analysis are still relevant:

1. **Performance Optimization**
   - Code splitting is implemented (lazy routes in App.tsx) but bundle could be further optimized
   - Need pagination for large data sets (currently loads all records on some pages)
   - Some N+1 query patterns remain

2. **Mobile/Responsive Design**
   - App is desktop-first
   - Driver delivery management needs better mobile experience
   - Signature capture works on mobile but UI could be improved

3. **Email Notifications** -- Only in-app notifications exist currently

4. **Advanced Reporting** -- Current reports are basic, need customizable date ranges and charts

5. **Inventory Alerts** -- Low-stock notification triggers exist (T3-005) but no automatic PO creation

6. **Customer Portal** -- Customers cannot log in to view their own quotes/orders

7. **Multi-company Support** -- Single-tenant only

---

## 7. Assumptions Made During Development

### Business Logic Assumptions:

1. **Tier pricing is fixed per customer**
   - Assumed each customer is assigned one tier (1, 2, or 3) and always uses that tier
   - Reality check: Some customers might negotiate different tiers for different products
   - **Impact:** Quote builder only shows one tier at a time

2. **Commission splits are simple percentages**
   - Assumed commission splits are just percentages between reps (stored as jsonb)
   - Reality check: Commission structures might be more complex (tiered, performance-based, etc.)
   - **Impact:** Commission calculations might need refactoring for complex rules

3. **One order = one customer = one delivery address per shipment**
   - Assumed each delivery goes to one address
   - Reality check: Large farms might want to split one order across multiple field locations
   - **Impact:** Delivery model might need refactoring

4. **Inventory is tracked at location level, not bin/lot level**
   - Assumed simple location tracking (e.g., "Main Warehouse")
   - Reality check: Some products might need lot number tracking for recalls
   - **Impact:** Inventory system is not lot-aware

5. **All products use the same unit types**
   - Assumed flexible unit system (gallons, pounds, ounces, etc.)
   - Reality check: Works for liquids and granulars, but might not handle odd cases
   - **Impact:** Should work for 95% of cases

6. **Quotes expire after 15 days by default**
   - Assumed standard business practice
   - Reality check: Configurable in app_settings, but not enforced (no automatic status change)
   - **Impact:** Expired quotes don't automatically change status

7. **Email confirmation is disabled**
   - Assumed internal tool where admins create accounts
   - Reality check: Makes testing easier but less secure
   - **Impact:** Anyone with signup link can create account (need to disable public signups in production)

### Technical Assumptions:

8. **Single database instance**
   - Assumed Supabase free or pro tier is sufficient
   - Reality check: As data grows, might need connection pooling or read replicas
   - **Impact:** Performance might degrade with 100,000+ records

9. **Files stored in Supabase Storage**
   - Assumed Supabase Storage is sufficient for PDFs, signatures, blend ticket docs
   - Reality check: Works well, but costs increase with storage volume
   - **Impact:** Should be fine unless storing gigabytes of files

10. **Users manually refresh to see updates**
    - Assumed polling or manual refresh for most data
    - Reality check: Real-time subscriptions only used for notifications
    - **Impact:** Multiple users editing same quote won't see conflicts until save

11. **Browser-based signature capture**
    - Assumed drivers use tablets or smartphones with touch screens
    - Reality check: Works great on touch devices, awkward with mouse
    - **Impact:** Drivers MUST use touch devices for signatures

12. **All dates are stored in UTC**
    - Assumed server timezone is UTC, client handles display conversion
    - Reality check: Works but no timezone selection for users
    - **Impact:** All times displayed in browser's local timezone

### Data Assumptions:

13. **Product catalog is relatively stable**
    - Assumed products aren't added/removed constantly
    - Reality check: Agricultural products do change seasonally
    - **Impact:** No advanced product lifecycle management

14. **Sales reps are assigned to customers 1:1**
    - Assumed one primary sales rep per customer
    - Reality check: Some customers might have a team
    - **Impact:** Only one sales rep gets assigned in the data model

15. **No multi-currency support**
    - Assumed all prices in USD
    - Reality check: Fine for US-based company
    - **Impact:** International expansion would require refactoring

---

## Quick Reference: Key Files

### Entry Points
- `src/main.tsx` - React app entry
- `src/App.tsx` - Routes and auth context provider

### Authentication
- `src/contexts/AuthContext.tsx` - Auth state management
- `src/components/auth/LoginPage.tsx` - Login UI
- `src/components/auth/ProtectedRoute.tsx` - Route guards

### Database
- `src/lib/db.ts` - Supabase client singleton
- `supabase/migrations/` - All database migrations

### Pages (Main Features)
- `src/pages/QuoteBuilder.tsx` - Quote creation
- `src/pages/Orders.tsx` - Order list
- `src/pages/OrderDetail.tsx` - Order details
- `src/pages/Deliveries.tsx` - Delivery schedule
- `src/pages/InventoryPage.tsx` - Inventory management
- `src/pages/TeamBoard.tsx` - Team collaboration

### Edge Functions
- `supabase/functions/create-user/index.ts` - Admin user creation
- `supabase/functions/seed-admin/index.ts` - Initial admin setup

### Test Configuration
- `playwright.config.ts` - E2E test setup
- `tests/e2e/utils/auth.ts` - Test user credentials

---

## How to Get Started (New Developer)

1. **Read this CONTEXT.md file** (you're doing it!)
2. **Read DATABASE_RELATIONSHIPS.md** - understand how tables connect
3. **Read TESTING.md** - learn how to run tests
4. **Look at a migration** - see how RLS policies work
5. **Run the app locally** - follow README.md quick start
6. **Browse the pages** - see the UI in action
7. **Check test user credentials** - mason@croprxsolutions.com (see tests/e2e/utils/auth.ts)

---

## Common Questions

**Q: Why are there 25 tables?**
A: Agricultural distribution is complex. We need to track products, customers, quotes, orders, inventory, deliveries, commissions, and team collaboration. Each entity has child tables for flexibility (e.g., customer_addresses, quote_sections, etc.).

**Q: Why use Supabase instead of building a custom API?**
A: Supabase provides auth, database, storage, and real-time out of the box. For an MVP, it's faster and more secure than building everything from scratch. RLS policies provide database-level security.

**Q: Can I add a new field to a table?**
A: Yes, but you MUST create a migration using `mcp__supabase__apply_migration`. Never modify tables directly. See existing migrations for examples.

**Q: How do I test locally?**
A: You need a Supabase account, create a project, run migrations, create test user (mason@croprxsolutions.com), then run `npm run test:e2e`. See TESTING.md for details.

**Q: Is this production-ready?**
A: Getting close. Security hardening (Tier 1-3) is complete. Main remaining gap is comprehensive test coverage (T3-002, not started). See section 6 for full details.

**Q: Can this scale to 10,000 customers?**
A: Probably yes for customers, but you'll need pagination, caching, and database optimization. Current version loads all records into memory.

**Q: Why are there bulk import features?**
A: The client had existing spreadsheets with 500+ products and 200+ customers. Bulk import was essential for initial data migration and ongoing updates.

---

**End of Context Document**

For more technical details, see:
- SCHEMA_QUICK_REFERENCE.sql - Complete schema
- DATABASE_RELATIONSHIPS.md - Entity relationships
- TESTING.md - How to test
- DEPLOYMENT.md - How to deploy
- VERIFICATION.md - Setup verification
