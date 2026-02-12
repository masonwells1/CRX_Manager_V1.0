# CRX Manager V2.0 — Feature Implementation Roadmap

> **Purpose:** This document is a comprehensive implementation guide for building all missing features in CRX Manager. It is designed to be fed to Claude Code phase-by-phase. Each phase is self-contained with database migrations, TypeScript types, page components, business logic, and verification steps.
>
> **How to use:** Copy a single phase section (e.g., "## PHASE 1") into a Claude Code session and say "Implement Phase 1." Each phase builds on the previous one, so execute them in order.

---

# SECTION 1: CURRENT APPLICATION STATE

## Business Context

CRX Manager is an ERP for **Crop RX Solutions**, an agricultural product **distributor + custom applicator**. The company:
- Sells crop protection products (herbicides, fungicides, insecticides, fertilizers) to farmers
- Operates 1-3 spray rigs that apply product to customer fields
- Runs seasonal crop programs (pre-emerge, post-emerge, fungicide passes) that drive spray job scheduling
- Has field boundary data in John Deere Operations Center, Climate FieldView, SMS Advanced, and shapefiles
- Needs full control of logistics, field application tracking, inventory, payments, and compliance

## Tech Stack

- **Frontend:** React 18 + TypeScript + Vite + Tailwind CSS
- **Backend:** Supabase (PostgreSQL + Auth + RLS + Edge Functions + Storage)
- **PDF:** jsPDF (client-side generation)
- **Testing:** Vitest + jsdom (unit), Playwright (E2E)
- **Deployment:** Vercel (not yet deployed)

## Existing Database Tables (34 migrations, 28+ tables)

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| `profiles` | User accounts (admin, sales_rep, driver) | id (FK auth.users), email, full_name, role, is_active |
| `products` | Product catalog with 3-tier pricing | product_name, current_cost, tier1/2/3_price, rate_per_acre, rate_unit, epa_registration |
| `cost_history` | Audit trail of product cost changes | product_id, old_cost, new_cost, changed_by |
| `customers` | Farm/grower CRM records | farm_name, assigned_tier, assigned_sales_rep, total_acres, payment_terms, default_commission_split |
| `customer_addresses` | Multiple delivery addresses per customer | customer_id, label, address_line, city, state, zip, delivery_notes, is_default |
| `quotes` | Quote headers with pipeline status | quote_number (UNIQUE), customer_id, tier, status (draft/sent/revised/accepted/declined/expired), total_price/cost/profit |
| `quote_sections` | Program groups within quotes (Pre-Emerge, etc.) | quote_id, section_name, sort_order |
| `quote_items` | Product line items on quotes | quote_id, section_id, product_id, price_per_unit, actual_rate, rate_unit, acres, total_units_needed, profit, net_margin |
| `quote_versions` | Frozen snapshots of sent quotes | quote_id, version_number, snapshot_data (JSONB) |
| `orders` | Confirmed orders from quotes or manual | order_number (UNIQUE), customer_id, status (confirmed/partially_fulfilled/fulfilled/cancelled), total_paid, balance_due |
| `order_items` | Order line items with fulfillment tracking | order_id, product_id, total_units_needed, quantity_delivered, quantity_remaining |
| `inventory` | Stock levels per product per location | product_id, location, quantity_available, quantity_prebooked, reorder_point, min_stock_level, last_counted_at |
| `inventory_transactions` | Audit trail of all stock movements | product_id, transaction_type (received/booked/delivered/returned/adjusted/transferred), quantity, performed_by |
| `inventory_holds` | Manual + crop program inventory reservations | product_id, customer_id, quantity, hold_type, expires_at, is_active |
| `purchase_orders` | Orders to suppliers/vendors | po_number (UNIQUE), vendor, status, expected_delivery_date, total_cost |
| `purchase_order_items` | PO line items | purchase_order_id, product_id, quantity_ordered, unit_cost, quantity_received |
| `deliveries` | Scheduled customer deliveries | delivery_number (UNIQUE), order_id, customer_id, assigned_driver, scheduled_date, status, signature_url |
| `delivery_items` | Products on each delivery | delivery_id, order_item_id, product_id, quantity, quantity_delivered |
| `commissions` | Earned commissions per order per recipient | order_id, recipient, recipient_user_id, split_percentage, commission_amount, status (pending/paid) |
| `blend_tickets` | OCR-processed application records | ticket_number, customer_id, status, review_status, ocr_confidence_score, driver_name, applicator_name, mixer_name, total_acres, application_rate |
| `blend_ticket_products` | Extracted products from blend tickets | blend_ticket_id, product_id, product_name, quantity, lot_number, rate_per_acre |
| `blend_ticket_images` | Uploaded ticket images | blend_ticket_id, storage_path, image_url |
| `ocr_processing_queue` | OCR job queue | blend_ticket_id, status, retry_count |
| `ingredient_map` | Brand to generic product lookup | branded_ingredient, generic_product_id |
| `unit_conversions` | Unit conversion factors (oz, qt, gal, etc.) | unit, factor_oz, unit_type |
| `team_notes` | Shared notes/todos/announcements | title, note_type, priority, assigned_to, is_completed, is_pinned |
| `team_note_comments` | Comments on team notes | note_id, content, created_by |
| `activity_feed` | Auto-generated action log | event_type, description, performed_by, related_entity_type/id, customer_id |
| `notifications` | In-app alerts per user | user_id, title, message, notification_type, is_read |
| `app_settings` | Global config (key-value) | setting_key, setting_value |

## Existing Pages & Routes (from `src/App.tsx`)

| Route | Page Component | Domain |
|-------|---------------|--------|
| `/` | Dashboard | KPI cards, pipeline, revenue chart, recent activity |
| `/products`, `/products/:id` | Products, ProductDetail | Product CRUD, tier pricing, cost history |
| `/customers`, `/customers/:id` | Customers, CustomerDetail | Customer CRM, addresses, history tabs |
| `/quotes`, `/quotes/new`, `/quotes/:id` | Quotes, QuoteBuilder | Quote pipeline, builder with sections/items, PDF |
| `/orders`, `/orders/new`, `/orders/:id` | Orders, NewOrder, OrderDetail | Order management, fulfillment tracking |
| `/inventory` | InventoryPage | Stock levels, receive, adjust, holds, low stock alerts |
| `/deliveries`, `/deliveries/new`, `/deliveries/:id` | Deliveries, NewDelivery, DeliveryDetail | Delivery scheduling, partial delivery, signature capture |
| `/blend-tickets`, `/blend-tickets/:id` | BlendTickets, BlendTicketDetail | OCR upload, extraction review, approve/reject |
| `/purchase-orders`, `/purchase-orders/new`, `/purchase-orders/:id` | PurchaseOrders, NewPurchaseOrder, PurchaseOrderDetail | Vendor PO management, receiving |
| `/brand-vs-generic` | BrandVsGeneric | Product cost comparison tool |
| `/reports` | Reports | Customer/product profitability, commissions, monthly revenue |
| `/crop-programs` | CropPrograms | Reusable seasonal program templates (stored in app_settings JSON) |
| `/payments` | Payments | AR tracking, payment recording, payment history |
| `/team-board` | TeamBoard | Kanban notes/todos, real-time collaboration |
| `/notifications` | Notifications | In-app alert center |
| `/settings` | SettingsPage | Company info, user management, defaults (admin only) |

## Existing SQL RPCs (atomic multi-step operations)

| RPC | Purpose |
|-----|---------|
| `save_quote(...)` | Atomic quote save (header + sections + items in one transaction) |
| `convert_quote_to_order(...)` | Quote → Order with FOR UPDATE locks, commission creation |
| `create_direct_order(...)` | Manual order creation with locks |
| `complete_delivery(...)` | Delivery completion with optional partial quantities (p_quantities JSONB) |
| `receive_po_items(...)` | PO receiving with inventory + cost updates |
| `save_purchase_order(...)` | Atomic PO save |
| `delete_purchase_order(...)` | Atomic PO deletion |
| `save_customer(...)` | Atomic customer save with addresses |
| `save_blend_ticket(...)` | Atomic blend ticket save with products |
| `duplicate_quote(...)` | Clone quote with new number |
| `next_delivery_number()` | Race-free sequential delivery number |
| `next_po_number()` | Race-free sequential PO number |
| `dashboard_summary()` | Consolidated dashboard data (8 queries → 1) |
| `admin_update_profile(...)` | SECURITY DEFINER profile update with is_active check |
| `record_payment(...)` | Atomic payment recording with AR update |

## Existing User Roles & Permissions

| Role | Can Do | Cannot Do |
|------|--------|-----------|
| `admin` | Everything: CRUD all entities, manage users, settings, bulk imports, financial data | — |
| `sales_rep` | Own quotes/orders, view all customers, create deliveries, receive inventory, record payments | Manage users, change product costs, delete POs |
| `driver` | View/complete assigned deliveries, view products/customers via delivery | See quotes, orders, payments, financial data |

## Existing UI Component Patterns

- **Sidebar navigation:** `src/components/layout/Sidebar.tsx` — `navItems[]` array with `{ path, label, icon, roles? }`
- **Page layout:** `src/components/layout/AppLayout.tsx` — Sidebar + TopBar + `<main id="main-content"><Outlet /></main>`
- **Modal:** `src/components/ui/Modal.tsx` — focus trap, Escape-to-close, aria-modal, aria-labelledby
- **Toast:** `src/components/ui/Toast.tsx` — `useToast()` hook, `toast('success'|'error', message)`
- **Card:** `src/components/ui/Card.tsx` — wrapper component
- **Button:** `src/components/ui/Button.tsx` — variant prop
- **Input:** `src/components/ui/Input.tsx` — form input
- **Badge:** `src/components/ui/Badge.tsx` — status badges
- **DataTable pattern:** sortable columns, search, filters (used in most list pages)

---

# SECTION 2: CODING STANDARDS & PATTERNS

**Every feature you build MUST follow these patterns. Read this section before implementing anything.**

## 2.1 Database Migration Pattern

File naming: `supabase/migrations/YYYYMMDDHHMMSS_description.sql`

```sql
-- Always use IF NOT EXISTS for tables
CREATE TABLE IF NOT EXISTS new_table (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- FK references with ON DELETE CASCADE where appropriate
  parent_id uuid NOT NULL REFERENCES parent_table(id) ON DELETE CASCADE,
  -- Status columns with CHECK constraints
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'completed')),
  -- Standard audit columns
  created_by uuid NOT NULL REFERENCES profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Always add indexes on FK columns, status, and date fields
CREATE INDEX IF NOT EXISTS idx_new_table_parent ON new_table(parent_id);
CREATE INDEX IF NOT EXISTS idx_new_table_status ON new_table(status);

-- Always enable RLS
ALTER TABLE new_table ENABLE ROW LEVEL SECURITY;

-- Standard RLS policies per role
CREATE POLICY "Admin full access" ON new_table FOR ALL
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin' AND is_active = true));

CREATE POLICY "Sales rep read" ON new_table FOR SELECT
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'sales_rep' AND is_active = true));

-- SECURITY DEFINER functions must SET search_path
CREATE OR REPLACE FUNCTION my_rpc(...)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$ ... $$;
```

## 2.2 TypeScript Type Pattern

Add all new interfaces to `src/types/index.ts`:

```typescript
// Status types as union literals
export type WorkOrderStatus = 'draft' | 'scheduled' | 'mixing' | 'in_progress' | 'completed' | 'verified';

// Interface with optional joined relations
export interface WorkOrder {
  id: string;
  work_order_number: string;
  customer_id: string;
  // ... fields match DB columns exactly ...
  created_at: string;
  updated_at: string;
  // Optional joined data (populated by .select('*, customer:customers(*)'))
  customer?: Customer;
}
```

## 2.3 Page Component Pattern

New pages go in `src/pages/`. Register in `src/App.tsx` as lazy imports:

```typescript
// In App.tsx — add lazy import
const WorkOrders = lazy(() => import('./pages/WorkOrders'));
const WorkOrderDetail = lazy(() => import('./pages/WorkOrderDetail'));

// In router children array — add routes
{ path: 'work-orders', element: <WorkOrders /> },
{ path: 'work-orders/:id', element: <WorkOrderDetail /> },
```

Add to sidebar navigation in `src/components/layout/Sidebar.tsx`:

```typescript
// In navItems array
{ path: '/work-orders', label: 'Work Orders', icon: <ClipboardCheck className="w-5 h-5" />, roles: ['admin', 'sales_rep'] },
```

## 2.4 Data Fetching Pattern

Use `useSupabaseQuery` hook from `src/hooks/useSupabaseQuery.ts`:

```typescript
const { data: items, loading, error, refetch } = useSupabaseQuery<MyType[]>({
  queryFn: async (signal) => {
    return supabase
      .from('my_table')
      .select('*, related:related_table(*)')
      .order('created_at', { ascending: false })
      .limit(500)
      .abortSignal(signal);
  },
  onError: (err) => toast('error', `Failed to load: ${err.message}`),
});
```

## 2.5 Mutation Pattern

Always use `checkMutationResult` from `src/lib/db.ts`:

```typescript
import { supabase, checkMutationResult } from '../lib/db';

const result = await supabase
  .from('my_table')
  .update({ status: 'completed' })
  .eq('id', itemId)
  .select();

checkMutationResult(result, 'Update my_table');
toast('success', 'Item updated');
refetch();
```

## 2.6 Activity Logging Pattern

Always call `logActivity` from `src/lib/activityLogger.ts` after CRUD:

```typescript
import { logActivity } from '../lib/activityLogger';

await logActivity(
  'work_order_created',                    // event_type
  `Work Order WO-2026-0001 created for Smith Farms`,  // description
  profile.id,                              // performed_by
  'work_order',                            // related_entity_type
  workOrder.id,                            // related_entity_id
  workOrder.customer_id                    // customer_id (optional)
);
```

## 2.7 Atomic RPC Pattern

For multi-step writes, create PostgreSQL RPCs:

```sql
CREATE OR REPLACE FUNCTION save_work_order(
  p_work_order JSONB,
  p_items JSONB
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  -- Upsert header
  INSERT INTO work_orders (id, ...)
  VALUES (COALESCE((p_work_order->>'id')::uuid, gen_random_uuid()), ...)
  ON CONFLICT (id) DO UPDATE SET ...
  RETURNING id INTO v_id;

  -- Delete + re-insert items (idempotent)
  DELETE FROM work_order_items WHERE work_order_id = v_id;
  INSERT INTO work_order_items (work_order_id, ...)
  SELECT v_id, ...
  FROM jsonb_array_elements(p_items) AS item;

  RETURN v_id;
END;
$$;
```

## 2.8 Notification Pattern

Extend `src/lib/notificationTriggers.ts` for new alert types:

```typescript
import { createNotification, notifyAdmins } from './activityLogger';

export async function notifyWorkOrderAssigned(workOrderId: string, applicatorId: string, workOrderNumber: string) {
  await createNotification(
    applicatorId,
    'New Work Order Assigned',
    `Work Order ${workOrderNumber} has been assigned to you.`,
    'work_order_assigned',
    'work_order',
    workOrderId
  );
}
```

## 2.9 PDF Generation Pattern

Follow existing pattern in `src/lib/quotePdf.ts` and `src/lib/deliveryPdf.ts`:

```typescript
// Dynamic import to keep main bundle small (Vite code-splitting)
const generateInvoicePdf = async (invoice: Invoice, items: InvoiceItem[]) => {
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF();
  // ... build PDF ...
  doc.save(`Invoice-${invoice.invoice_number}.pdf`);
};
```

## 2.10 Testing Pattern

- **Unit tests** for pure business logic: `src/lib/*.test.ts` (Vitest + jsdom)
- **RPC contract tests**: `src/lib/rpcContracts.test.ts`
- **E2E tests**: `e2e/*.spec.ts` (Playwright)

```typescript
// Unit test example
import { describe, it, expect } from 'vitest';
import { calculateAgingBuckets } from './invoiceCalc';

describe('calculateAgingBuckets', () => {
  it('puts 45-day-old invoice in 30-60 bucket', () => {
    const result = calculateAgingBuckets([{ balance: 1000, daysSinceInvoice: 45 }]);
    expect(result.bucket30to60).toBe(1000);
  });
});
```

---

# PHASE 1: WORK ORDERS & FIELD APPLICATION TRACKING

> **Priority:** TOP — This is the #1 pain point. The owner cannot track what was sprayed, where, by whom, or when.
>
> **Dependency:** None — this phase introduces new tables and pages with no conflicts.
>
> **Estimated scope:** 6 new database tables, 5 new pages, 3 new RPCs, ~15 new TypeScript types

## 1.1 Customer Field Management

### What
Every customer has named fields (farm parcels) with known acreage. These fields are the target of spray applications. Fields can be imported from John Deere Operations Center, Climate FieldView, SMS Advanced, or shapefiles — but the initial implementation is manual entry + CSV/GeoJSON import.

### Database

```sql
-- New table: customer_fields
CREATE TABLE IF NOT EXISTS customer_fields (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  field_name text NOT NULL,
  legal_description text,            -- e.g., "NW Quarter Section 14, Township 22N"
  acres numeric NOT NULL DEFAULT 0,
  crop_type text,                    -- current crop: Corn, Soybeans, Wheat, etc.
  gps_lat numeric,                   -- center point latitude
  gps_lng numeric,                   -- center point longitude
  boundary_geojson jsonb,            -- GeoJSON polygon (imported from JD/FieldView/shapefile)
  soil_type text,                    -- optional: sandy loam, clay, etc.
  county text,
  state text,
  notes text,
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL REFERENCES profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_customer_fields_customer ON customer_fields(customer_id);
CREATE INDEX IF NOT EXISTS idx_customer_fields_crop ON customer_fields(crop_type);
-- RLS: same as customer_addresses (admin full, sales_rep read, driver read via delivery)
```

### TypeScript Types (add to `src/types/index.ts`)

```typescript
export interface CustomerField {
  id: string;
  customer_id: string;
  field_name: string;
  legal_description: string | null;
  acres: number;
  crop_type: string | null;
  gps_lat: number | null;
  gps_lng: number | null;
  boundary_geojson: any | null;
  soil_type: string | null;
  county: string | null;
  state: string | null;
  notes: string | null;
  is_active: boolean;
  created_by: string;
  created_at: string;
  updated_at: string;
  customer?: Customer;
}
```

### UI

- **CustomerDetail.tsx** — Add a new "Fields" tab alongside existing Quotes/Orders/Deliveries/Activity tabs
  - Table of fields: field_name, acres, crop_type, county, GPS coordinates (if set)
  - "Add Field" button → modal with form: field_name*, acres*, crop_type (dropdown: Corn/Soybeans/Wheat/Cotton/Hay/Other), legal_description, county, state, soil_type, GPS lat/lng, notes
  - Edit/delete inline per field row
  - "Import Fields" button → modal accepting:
    - CSV file with columns: field_name, acres, crop_type, county, state, gps_lat, gps_lng
    - GeoJSON file (parse features → extract name from `properties.name` or `properties.field_name`, acres from `properties.acres` or calculate from polygon area)
  - Show total acres across all fields (compare to customer.total_acres)

### Business Rules
- Field name must be unique per customer
- Acres must be > 0
- Crop type dropdown values: `['Corn', 'Soybeans', 'Wheat', 'Cotton', 'Hay/Forage', 'Alfalfa', 'Other']`
- When importing GeoJSON, parse `FeatureCollection` → for each `Feature` with `Polygon` geometry, create a customer_field with boundary_geojson set
- Log activity: "Field {name} ({acres} ac) added to {farm_name}"

---

## 1.2 Work Order Model

### What
A work order is the central entity for field application. It represents a job: "Go spray [customer]'s [field] with [these products] at [these rates]." Work orders are created from crop programs or manually, and flow through a status pipeline.

### Database

```sql
-- New table: work_orders
CREATE TABLE IF NOT EXISTS work_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_order_number text NOT NULL UNIQUE,
  customer_id uuid NOT NULL REFERENCES customers(id),
  order_id uuid REFERENCES orders(id),              -- optional link to sales order
  crop_program_id text,                              -- optional link to crop program (stored in app_settings)
  assigned_applicator uuid REFERENCES profiles(id),  -- who will spray
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'scheduled', 'mixing', 'in_progress', 'completed', 'verified', 'cancelled')),
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  scheduled_date date,
  scheduled_time text,                               -- e.g., "6:00 AM" (early morning for low wind)
  target_acres numeric NOT NULL DEFAULT 0,           -- total planned acres
  actual_acres_applied numeric,                      -- filled on completion
  application_method text,                           -- 'ground_spray', 'aerial', 'spreader', 'chemigation'
  -- Weather conditions at time of application
  wind_speed_mph numeric,
  wind_direction text,
  temperature_f numeric,
  humidity_pct numeric,
  weather_notes text,
  -- Completion
  started_at timestamptz,
  completed_at timestamptz,
  verified_by uuid REFERENCES profiles(id),
  verified_at timestamptz,
  -- References
  blend_ticket_id uuid REFERENCES blend_tickets(id), -- link to proof-of-completion
  notes text,
  created_by uuid NOT NULL REFERENCES profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_work_orders_customer ON work_orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_work_orders_status ON work_orders(status);
CREATE INDEX IF NOT EXISTS idx_work_orders_scheduled ON work_orders(scheduled_date);
CREATE INDEX IF NOT EXISTS idx_work_orders_applicator ON work_orders(assigned_applicator);

-- New table: work_order_fields (which fields to spray)
CREATE TABLE IF NOT EXISTS work_order_fields (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_order_id uuid NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  customer_field_id uuid NOT NULL REFERENCES customer_fields(id),
  planned_acres numeric NOT NULL DEFAULT 0,
  actual_acres numeric,                              -- filled on completion
  notes text
);

CREATE INDEX IF NOT EXISTS idx_wo_fields_work_order ON work_order_fields(work_order_id);

-- New table: work_order_products (what products to apply at what rates)
CREATE TABLE IF NOT EXISTS work_order_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_order_id uuid NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id),
  target_rate numeric NOT NULL DEFAULT 0,            -- e.g., 2
  rate_unit text NOT NULL DEFAULT 'oz/acre',         -- e.g., "oz/acre", "qt/acre", "lb/acre"
  total_quantity_needed numeric,                     -- calculated: target_rate * target_acres / conversion
  actual_quantity_used numeric,                      -- filled on completion
  unit_size text,
  cost_per_unit numeric,                             -- from product.current_cost at time of WO creation
  lot_number text,                                   -- track which lot was used (ties to Phase 2 lot tracking)
  notes text,
  sort_order integer NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_wo_products_work_order ON work_order_products(work_order_id);
```

### TypeScript Types

```typescript
export type WorkOrderStatus = 'draft' | 'scheduled' | 'mixing' | 'in_progress' | 'completed' | 'verified' | 'cancelled';
export type WorkOrderPriority = 'low' | 'normal' | 'high' | 'urgent';
export type ApplicationMethod = 'ground_spray' | 'aerial' | 'spreader' | 'chemigation';

export interface WorkOrder {
  id: string;
  work_order_number: string;
  customer_id: string;
  order_id: string | null;
  crop_program_id: string | null;
  assigned_applicator: string | null;
  status: WorkOrderStatus;
  priority: WorkOrderPriority;
  scheduled_date: string | null;
  scheduled_time: string | null;
  target_acres: number;
  actual_acres_applied: number | null;
  application_method: string | null;
  wind_speed_mph: number | null;
  wind_direction: string | null;
  temperature_f: number | null;
  humidity_pct: number | null;
  weather_notes: string | null;
  started_at: string | null;
  completed_at: string | null;
  verified_by: string | null;
  verified_at: string | null;
  blend_ticket_id: string | null;
  notes: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  customer?: Customer;
  applicator?: Profile;
  verifier?: Profile;
  fields?: WorkOrderField[];
  products?: WorkOrderProduct[];
}

export interface WorkOrderField {
  id: string;
  work_order_id: string;
  customer_field_id: string;
  planned_acres: number;
  actual_acres: number | null;
  notes: string | null;
  field?: CustomerField;
}

export interface WorkOrderProduct {
  id: string;
  work_order_id: string;
  product_id: string;
  target_rate: number;
  rate_unit: string;
  total_quantity_needed: number | null;
  actual_quantity_used: number | null;
  unit_size: string | null;
  cost_per_unit: number | null;
  lot_number: string | null;
  notes: string | null;
  sort_order: number;
  product?: Product;
}
```

### RPC: `save_work_order`

```sql
CREATE OR REPLACE FUNCTION save_work_order(
  p_work_order JSONB,
  p_fields JSONB,
  p_products JSONB
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
  v_number text;
BEGIN
  -- Generate work order number if new
  IF p_work_order->>'id' IS NULL OR p_work_order->>'id' = '' THEN
    SELECT 'WO-' || EXTRACT(YEAR FROM NOW())::text || '-' || LPAD((COALESCE(MAX(
      NULLIF(REGEXP_REPLACE(work_order_number, '^WO-\d{4}-', ''), '')::integer
    ), 0) + 1)::text, 4, '0')
    INTO v_number
    FROM work_orders
    WHERE work_order_number LIKE 'WO-' || EXTRACT(YEAR FROM NOW())::text || '-%';

    INSERT INTO work_orders (
      work_order_number, customer_id, order_id, crop_program_id, assigned_applicator,
      status, priority, scheduled_date, scheduled_time, target_acres,
      application_method, notes, created_by
    )
    VALUES (
      v_number,
      (p_work_order->>'customer_id')::uuid,
      NULLIF(p_work_order->>'order_id', '')::uuid,
      NULLIF(p_work_order->>'crop_program_id', ''),
      NULLIF(p_work_order->>'assigned_applicator', '')::uuid,
      COALESCE(p_work_order->>'status', 'draft'),
      COALESCE(p_work_order->>'priority', 'normal'),
      NULLIF(p_work_order->>'scheduled_date', '')::date,
      NULLIF(p_work_order->>'scheduled_time', ''),
      COALESCE((p_work_order->>'target_acres')::numeric, 0),
      NULLIF(p_work_order->>'application_method', ''),
      NULLIF(p_work_order->>'notes', ''),
      (p_work_order->>'created_by')::uuid
    )
    RETURNING id INTO v_id;
  ELSE
    v_id := (p_work_order->>'id')::uuid;
    UPDATE work_orders SET
      customer_id = (p_work_order->>'customer_id')::uuid,
      assigned_applicator = NULLIF(p_work_order->>'assigned_applicator', '')::uuid,
      status = COALESCE(p_work_order->>'status', status),
      priority = COALESCE(p_work_order->>'priority', priority),
      scheduled_date = NULLIF(p_work_order->>'scheduled_date', '')::date,
      scheduled_time = NULLIF(p_work_order->>'scheduled_time', ''),
      target_acres = COALESCE((p_work_order->>'target_acres')::numeric, target_acres),
      application_method = NULLIF(p_work_order->>'application_method', ''),
      notes = NULLIF(p_work_order->>'notes', ''),
      updated_at = now()
    WHERE id = v_id;
  END IF;

  -- Replace fields
  DELETE FROM work_order_fields WHERE work_order_id = v_id;
  INSERT INTO work_order_fields (work_order_id, customer_field_id, planned_acres, notes)
  SELECT v_id,
         (f->>'customer_field_id')::uuid,
         COALESCE((f->>'planned_acres')::numeric, 0),
         NULLIF(f->>'notes', '')
  FROM jsonb_array_elements(p_fields) AS f;

  -- Replace products
  DELETE FROM work_order_products WHERE work_order_id = v_id;
  INSERT INTO work_order_products (
    work_order_id, product_id, target_rate, rate_unit, total_quantity_needed,
    unit_size, cost_per_unit, lot_number, notes, sort_order
  )
  SELECT v_id,
         (p->>'product_id')::uuid,
         COALESCE((p->>'target_rate')::numeric, 0),
         COALESCE(p->>'rate_unit', 'oz/acre'),
         NULLIF(p->>'total_quantity_needed', '')::numeric,
         NULLIF(p->>'unit_size', ''),
         NULLIF(p->>'cost_per_unit', '')::numeric,
         NULLIF(p->>'lot_number', ''),
         NULLIF(p->>'notes', ''),
         COALESCE((p->>'sort_order')::integer, 0)
  FROM jsonb_array_elements(p_products) AS p;

  RETURN v_id;
END;
$$;
```

### RPC: `complete_work_order`

```sql
CREATE OR REPLACE FUNCTION complete_work_order(
  p_work_order_id uuid,
  p_actual_acres numeric,
  p_field_actuals JSONB,       -- [{ work_order_field_id, actual_acres }]
  p_product_actuals JSONB,     -- [{ work_order_product_id, actual_quantity_used, lot_number }]
  p_weather JSONB,             -- { wind_speed_mph, wind_direction, temperature_f, humidity_pct, weather_notes }
  p_completed_by uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Lock the work order row
  PERFORM id FROM work_orders WHERE id = p_work_order_id FOR UPDATE;

  -- Update header
  UPDATE work_orders SET
    status = 'completed',
    actual_acres_applied = p_actual_acres,
    wind_speed_mph = NULLIF(p_weather->>'wind_speed_mph', '')::numeric,
    wind_direction = NULLIF(p_weather->>'wind_direction', ''),
    temperature_f = NULLIF(p_weather->>'temperature_f', '')::numeric,
    humidity_pct = NULLIF(p_weather->>'humidity_pct', '')::numeric,
    weather_notes = NULLIF(p_weather->>'weather_notes', ''),
    completed_at = now(),
    updated_at = now()
  WHERE id = p_work_order_id;

  -- Update field actuals
  UPDATE work_order_fields wof SET
    actual_acres = (fa->>'actual_acres')::numeric
  FROM jsonb_array_elements(p_field_actuals) AS fa
  WHERE wof.id = (fa->>'work_order_field_id')::uuid
    AND wof.work_order_id = p_work_order_id;

  -- Update product actuals
  UPDATE work_order_products wop SET
    actual_quantity_used = (pa->>'actual_quantity_used')::numeric,
    lot_number = COALESCE(NULLIF(pa->>'lot_number', ''), wop.lot_number)
  FROM jsonb_array_elements(p_product_actuals) AS pa
  WHERE wop.id = (pa->>'work_order_product_id')::uuid
    AND wop.work_order_id = p_work_order_id;

  -- Create inventory transactions for each product used (type = 'applied')
  INSERT INTO inventory_transactions (product_id, transaction_type, quantity, performed_by, notes)
  SELECT wop.product_id,
         'adjusted',
         -1 * COALESCE(wop.actual_quantity_used, 0),
         p_completed_by,
         'Applied via Work Order ' || wo.work_order_number
  FROM work_order_products wop
  JOIN work_orders wo ON wo.id = wop.work_order_id
  WHERE wop.work_order_id = p_work_order_id
    AND COALESCE(wop.actual_quantity_used, 0) > 0;

  -- Deduct from inventory
  UPDATE inventory inv SET
    quantity_available = inv.quantity_available - COALESCE(wop.actual_quantity_used, 0),
    updated_at = now()
  FROM work_order_products wop
  WHERE wop.work_order_id = p_work_order_id
    AND inv.product_id = wop.product_id
    AND COALESCE(wop.actual_quantity_used, 0) > 0
    AND inv.location = 'Main Warehouse';
END;
$$;
```

### RPC: `next_work_order_number`

```sql
CREATE OR REPLACE FUNCTION next_work_order_number()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_year text := EXTRACT(YEAR FROM NOW())::text;
  v_seq integer;
BEGIN
  SELECT COALESCE(MAX(
    NULLIF(REGEXP_REPLACE(work_order_number, '^WO-\d{4}-', ''), '')::integer
  ), 0) + 1
  INTO v_seq
  FROM work_orders
  WHERE work_order_number LIKE 'WO-' || v_year || '-%';

  RETURN 'WO-' || v_year || '-' || LPAD(v_seq::text, 4, '0');
END;
$$;
```

### UI Pages

#### WorkOrders.tsx (list page — `/work-orders`)
- Table columns: work_order_number, customer (farm_name), status (badge), assigned_applicator (name), scheduled_date, target_acres, priority (badge), application_method
- Status badge colors: draft=gray, scheduled=blue, mixing=orange, in_progress=yellow, completed=green, verified=emerald, cancelled=red
- Priority badge colors: low=gray, normal=blue, high=orange, urgent=red
- Filters: status dropdown, applicator dropdown, date range, customer search
- "New Work Order" button → `/work-orders/new`
- Click row → `/work-orders/:id`

#### WorkOrderDetail.tsx (create/edit — `/work-orders/new`, `/work-orders/:id`)
- **Header section:**
  - Customer dropdown (auto-load their fields when selected)
  - Status display (with transition buttons based on current status)
  - Assigned applicator dropdown (filter profiles to role = 'driver' or 'admin')
  - Priority dropdown
  - Scheduled date + time
  - Application method dropdown
  - Link to order (optional, dropdown of customer's open orders)
  - Link to crop program (optional, dropdown of active programs)
  - Notes

- **Fields section:**
  - "Add Field" button → select from customer's fields (checkbox multi-select modal)
  - Table: field_name, planned_acres (editable, defaults to field.acres), actual_acres (editable on completion), notes
  - Total planned acres (sum) and total actual acres (sum)

- **Products section:**
  - "Add Product" button → product search modal
  - Table: product_name, target_rate, rate_unit (dropdown), total_quantity_needed (auto-calculated), actual_quantity_used (editable on completion), cost_per_unit, lot_number, notes
  - Auto-calculate total_quantity_needed: `target_rate * target_acres / conversion_factor`
  - Total cost estimate: sum of (total_quantity_needed * cost_per_unit)

- **Tank Mix Record section** (visible when status >= 'mixing'):
  - Water volume (gallons)
  - Mix sequence (ordered list of products as they were added to tank)
  - Mixer name (who physically mixed the tank)
  - Mix date + time
  - Tank number / vehicle info
  - This data is stored as a JSONB column `tank_mix_record` on the work_order:

```sql
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS tank_mix_record JSONB;
-- Structure: { water_volume_gal: number, mixer_name: string, mix_datetime: string, tank_number: string, vehicle_info: string, mix_sequence: [{ product_id, product_name, quantity, unit, order }] }
```

- **Weather section** (visible when status >= 'in_progress'):
  - Wind speed (mph), wind direction (dropdown: N/NE/E/SE/S/SW/W/NW), temperature (F), humidity (%), weather notes

- **Completion section** (visible when status = 'in_progress'):
  - Per-field actual acres inputs
  - Per-product actual quantity used inputs
  - "Complete Work Order" button with confirmation dialog
  - Calls `complete_work_order` RPC

- **Verification section** (visible when status = 'completed'):
  - "Verify" button (admin/sales_rep only) → sets status='verified', verified_by, verified_at
  - "Link Blend Ticket" button → select from unlinked blend tickets for this customer

- **Status transition buttons:**
  - draft → scheduled (requires: customer, at least 1 field, at least 1 product, scheduled_date)
  - scheduled → mixing (requires: assigned_applicator)
  - mixing → in_progress (requires: tank_mix_record filled)
  - in_progress → completed (requires: actual_acres, product actuals, weather data)
  - completed → verified (admin/sales_rep only)
  - Any status → cancelled (with confirmation)

### Business Rules
- Work order number format: `WO-{YEAR}-{4-digit seq}` (e.g., WO-2026-0001)
- Cannot complete a work order without weather data (wind, temp at minimum)
- Completing a work order deducts product from inventory (via `complete_work_order` RPC)
- Activity logging on every status change
- Notify assigned applicator when work order is scheduled or reassigned

---

## 1.3 Work Order Scheduling Board

### What
A calendar/board view showing all work orders by date, so the operations manager can see what's scheduled, drag to reschedule, and identify capacity gaps.

### UI
- New page: **WorkOrderCalendar.tsx** (`/work-orders/calendar`) OR a toggle view on the WorkOrders list page
- **Weekly view** (default): 7 columns (Mon-Sun), each column shows work orders for that day as cards
  - Card shows: customer name, target acres, priority color stripe, applicator avatar, status badge
  - Click card → navigate to `/work-orders/:id`
- **Daily view**: Single day expanded, showing all work orders with full detail rows
- **List view**: Toggle back to the table view (WorkOrders.tsx)
- Filters: applicator dropdown, status, priority
- Color coding by status (same as list page badges)
- Summary bar at top: "This week: X work orders, Y total acres, Z assigned to you"

### Implementation
- Use a simple custom calendar grid (no external dependency needed — just CSS grid with 7 columns)
- Data source: `useSupabaseQuery` on `work_orders` table with date range filter
- Group work orders by `scheduled_date` into a `Map<string, WorkOrder[]>`

---

## 1.4 Crop Program → Work Order Generation

### What
Auto-generate work orders from a crop program template for a customer. When a sales rep "applies" a crop program to a customer, the system creates one work order per program section (e.g., one WO for Pre-Emerge, one for Post-Emerge, one for Fungicide).

### UI Addition to CropPrograms.tsx
- Add "Generate Work Orders" button on each active crop program card
- Modal workflow:
  1. Select customer (dropdown)
  2. Select customer fields (checkbox multi-select — from customer_fields)
  3. For each program section (e.g., Pre-Emerge, Post-Emerge), show a row with:
     - Section name
     - Scheduled date picker (default: blank, user fills in)
     - Assigned applicator (dropdown, default: blank)
  4. "Generate" button → creates N work orders (one per section)
  - Each WO:
    - customer_id = selected customer
    - crop_program_id = program ID
    - target_acres = sum of selected field acres
    - products = program items for that section
    - fields = all selected fields
    - status = 'draft' (or 'scheduled' if date is set)

### Business Rules
- Generated WOs are linked to the crop program via `crop_program_id`
- Each product in the WO inherits rate + rate_unit from the crop program item
- Activity log: "Generated 3 work orders from '2026 Corn Full Program' for Smith Farms"

---

## 1.5 Application History Per Field

### What
For any customer field, show a complete history of everything that has been applied to it — across all work orders and seasons.

### UI Addition to CustomerDetail.tsx (Fields tab)
- Click a field row → expands to show application history table:
  - Date | Work Order # | Products Applied | Rate | Acres | Applicator | Status
- Data source: JOIN `work_order_fields` → `work_orders` → `work_order_products` WHERE `customer_field_id = field.id` AND `work_orders.status IN ('completed', 'verified')`
- Sort by date descending
- Show season totals: "2026 Season: 3 applications, 450 total acres treated"

---

## 1.6 Work Order Reports

### What
New report tab(s) in Reports.tsx for field application analytics.

### UI Addition to Reports.tsx
Add new tabs:

**Tab: "Application Summary"**
- Table: Applicator | Total Work Orders | Total Acres Applied | Products Used (count) | Avg Acres/Day
- Date range filter (same presets as existing reports)
- CSV export

**Tab: "Field Application History"**
- Table: Customer | Field Name | Acres | Applications (count) | Products Applied (list) | Last Application Date
- Filter by customer, crop type, date range
- CSV export

**Tab: "Product Usage"**
- Table: Product Name | Total Quantity Applied | Total Acres Treated | Avg Rate/Acre | Total Cost | Work Orders (count)
- Date range filter
- CSV export

---

## 1.7 Blend Ticket → Work Order Link

### What
Blend tickets become proof-of-completion for work orders. When a blend ticket is approved, it can be linked to a work order.

### Changes to BlendTicketDetail.tsx
- Add "Link to Work Order" dropdown (shows unlinked work orders for the same customer in 'completed' or 'in_progress' status)
- When linked: work_orders.blend_ticket_id is set
- Display linked work order info on the blend ticket detail page (WO number, customer, acres, products)

### Changes to WorkOrderDetail.tsx
- In the verification section, show linked blend ticket if one exists
- Display blend ticket images + OCR data inline for quick review
- "Unlink Blend Ticket" button if admin

---

## Phase 1 Verification Checklist

After implementing Phase 1, verify:
- [ ] `customer_fields` table created with RLS
- [ ] `work_orders`, `work_order_fields`, `work_order_products` tables created with RLS
- [ ] `save_work_order`, `complete_work_order`, `next_work_order_number` RPCs work
- [ ] WorkOrders list page with filters, status badges
- [ ] WorkOrderDetail page with full CRUD: create, edit, status transitions, fields, products, tank mix, weather, completion
- [ ] Fields tab on CustomerDetail with add/edit/delete/import
- [ ] Scheduling board/calendar view with weekly view
- [ ] Crop program → work order generation
- [ ] Application history per field on CustomerDetail
- [ ] Work order reports (application summary, field history, product usage)
- [ ] Blend ticket ↔ work order linking
- [ ] Sidebar updated with Work Orders nav item (icon: ClipboardCheck from lucide-react)
- [ ] Activity logging on all WO CRUD actions
- [ ] Notifications: applicator notified on WO assignment
- [ ] `npm run build` passes with no TypeScript errors
- [ ] `npx vitest run` passes (add unit tests for WO number generation, acres calculation)

---

# PHASE 2: INVENTORY INTELLIGENCE

> **Priority:** HIGH — Owner's #2 pain point: inventory accuracy and stockout prevention
>
> **Dependency:** Phase 1 (work orders deduct inventory; lot tracking ties into WO products)
>
> **Estimated scope:** 3 new tables, alter 3 existing tables, 4 new RPCs, 2 new pages

## 2.1 Lot Tracking & Traceability

### What
Track product lots from PO receipt → inventory storage → delivery/application. When a lot is recalled or has a quality issue, trace every customer/field that received it.

### Database Changes

```sql
-- New table: inventory_lots (tracks individual lot quantities within inventory)
CREATE TABLE IF NOT EXISTS inventory_lots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES products(id),
  location text NOT NULL DEFAULT 'Main Warehouse',
  lot_number text NOT NULL,
  quantity numeric NOT NULL DEFAULT 0,
  purchase_order_id uuid REFERENCES purchase_orders(id),  -- which PO brought this lot in
  received_date date,
  manufacture_date date,
  expiration_date date,
  unit_cost numeric,                                       -- cost for this specific lot
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(product_id, location, lot_number)
);

CREATE INDEX IF NOT EXISTS idx_inventory_lots_product ON inventory_lots(product_id);
CREATE INDEX IF NOT EXISTS idx_inventory_lots_expiry ON inventory_lots(expiration_date);

-- Add lot_number to delivery_items for outbound traceability
ALTER TABLE delivery_items ADD COLUMN IF NOT EXISTS lot_number text;

-- Add lot_number to inventory_transactions for full audit chain
ALTER TABLE inventory_transactions ADD COLUMN IF NOT EXISTS lot_number text;
```

### TypeScript Types

```typescript
export interface InventoryLot {
  id: string;
  product_id: string;
  location: string;
  lot_number: string;
  quantity: number;
  purchase_order_id: string | null;
  received_date: string | null;
  manufacture_date: string | null;
  expiration_date: string | null;
  unit_cost: number | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  product?: Product;
}
```

### UI Changes
- **InventoryPage.tsx**: Add a "Lots" column or expandable row showing lot breakdown per product
  - Click product row → expand to show lots: lot_number, quantity, expiration_date, received_date, PO#
- **PO Receiving modal**: Add lot_number input + expiration_date input per item when receiving
  - Receiving creates/updates `inventory_lots` row
- **DeliveryDetail.tsx**: Add lot_number selection dropdown per delivery item (FEFO: first-expiring-first-out suggested)
- **WorkOrderDetail.tsx**: lot_number field on products already exists — connect to inventory_lots
- **New: Lot Trace Report** (Reports.tsx tab):
  - Enter lot number → shows: which PO received it, current inventory qty, which deliveries shipped it, which work orders applied it, to which customers/fields

### Business Rules
- When receiving PO items, lot_number is required (cannot receive without a lot)
- When delivering or applying product, lot selection defaults to FEFO (earliest expiration date first)
- Lot quantities must stay >= 0
- `receive_po_items` RPC must be updated to create/update `inventory_lots` rows

---

## 2.2 Expiration Date Management

### What
Track shelf life. Alert when products are nearing expiration. Prevent delivery/application of expired product.

### UI Changes
- **InventoryPage.tsx**: Add expiration warning badges on lots expiring within 90 days (yellow) or 30 days (red)
- **Notification trigger**: `checkExpiringLots()` in `notificationTriggers.ts` — fires daily, alerts admins for lots expiring within 30 days
- **Delivery/WO product selection**: Show warning if selected lot is expired or expiring within 7 days
- **Reports tab: "Expiring Inventory"**: Table of lots sorted by expiration_date ascending, with columns: product, lot#, qty remaining, expiration date, days until expiry, location

### Business Rules
- Block delivery/application of expired lots (soft block — warning with admin override)
- Expiring lots notification: once per lot per day (dedup like low_stock)
- FEFO (First Expired, First Out) — when auto-suggesting lots, always pick earliest expiration

---

## 2.3 Cycle Counting

### What
Structured physical inventory count process: generate count sheets, record counts, calculate variances, approve adjustments.

### Database

```sql
-- New table: cycle_counts
CREATE TABLE IF NOT EXISTS cycle_counts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  count_number text NOT NULL UNIQUE,
  location text NOT NULL DEFAULT 'Main Warehouse',
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'in_progress', 'pending_approval', 'approved', 'cancelled')),
  count_date date NOT NULL DEFAULT CURRENT_DATE,
  counted_by uuid REFERENCES profiles(id),
  approved_by uuid REFERENCES profiles(id),
  approved_at timestamptz,
  notes text,
  created_by uuid NOT NULL REFERENCES profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- New table: cycle_count_items
CREATE TABLE IF NOT EXISTS cycle_count_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_count_id uuid NOT NULL REFERENCES cycle_counts(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id),
  system_quantity numeric NOT NULL DEFAULT 0,     -- snapshot of inventory.quantity_available at count time
  counted_quantity numeric,                       -- physical count entered by user
  variance numeric GENERATED ALWAYS AS (COALESCE(counted_quantity, 0) - system_quantity) STORED,
  variance_pct numeric GENERATED ALWAYS AS (
    CASE WHEN system_quantity = 0 THEN NULL
    ELSE ROUND(((COALESCE(counted_quantity, 0) - system_quantity) / system_quantity * 100), 2)
    END
  ) STORED,
  notes text
);

CREATE INDEX IF NOT EXISTS idx_cycle_count_items_count ON cycle_count_items(cycle_count_id);
```

### TypeScript Types

```typescript
export type CycleCountStatus = 'draft' | 'in_progress' | 'pending_approval' | 'approved' | 'cancelled';

export interface CycleCount {
  id: string;
  count_number: string;
  location: string;
  status: CycleCountStatus;
  count_date: string;
  counted_by: string | null;
  approved_by: string | null;
  approved_at: string | null;
  notes: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  counter?: Profile;
  approver?: Profile;
  items?: CycleCountItem[];
}

export interface CycleCountItem {
  id: string;
  cycle_count_id: string;
  product_id: string;
  system_quantity: number;
  counted_quantity: number | null;
  variance: number;
  variance_pct: number | null;
  notes: string | null;
  product?: Product;
}
```

### UI
- **InventoryPage.tsx**: Add "Cycle Count" button → creates a new cycle count
  - Modal: select location, select products to count (default: all products at that location, or select specific)
  - Generate count sheet: snapshots current `inventory.quantity_available` into `cycle_count_items.system_quantity`
- **CycleCountDetail.tsx** (`/inventory/cycle-count/:id`):
  - Table: product_name, system_qty, counted_qty (editable input), variance, variance_pct, notes
  - Color code variances: green (0), yellow (< 5%), red (> 5%)
  - "Submit for Approval" button → status = 'pending_approval'
  - "Approve" button (admin) → status = 'approved', creates inventory adjustments for all non-zero variances
  - "Reject" button (admin) → back to 'in_progress' for recount

### RPC: `approve_cycle_count`

```sql
-- When approved: adjust inventory for each variance
CREATE OR REPLACE FUNCTION approve_cycle_count(
  p_cycle_count_id uuid,
  p_approved_by uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_item RECORD;
  v_location text;
BEGIN
  SELECT location INTO v_location FROM cycle_counts WHERE id = p_cycle_count_id;

  -- Lock cycle count
  UPDATE cycle_counts SET
    status = 'approved', approved_by = p_approved_by, approved_at = now(), updated_at = now()
  WHERE id = p_cycle_count_id AND status = 'pending_approval';

  -- Adjust inventory for each item with variance
  FOR v_item IN
    SELECT cci.product_id, cci.variance
    FROM cycle_count_items cci
    WHERE cci.cycle_count_id = p_cycle_count_id AND cci.variance != 0
  LOOP
    UPDATE inventory SET
      quantity_available = quantity_available + v_item.variance,
      last_counted_at = now(),
      updated_at = now()
    WHERE product_id = v_item.product_id AND location = v_location;

    INSERT INTO inventory_transactions (product_id, transaction_type, quantity, performed_by, notes)
    VALUES (v_item.product_id, 'adjusted', v_item.variance, p_approved_by,
            'Cycle count adjustment');
  END LOOP;

  -- Update last_counted_at for all counted products
  UPDATE inventory SET last_counted_at = now()
  FROM cycle_count_items cci
  WHERE cci.cycle_count_id = p_cycle_count_id
    AND inventory.product_id = cci.product_id
    AND inventory.location = v_location;
END;
$$;
```

---

## 2.4 Auto-Reorder Triggers

### What
When a product's available quantity drops to or below the reorder point, auto-generate a draft PO to the preferred vendor.

### Database Changes

```sql
-- Add preferred vendor + reorder quantity to inventory
ALTER TABLE inventory ADD COLUMN IF NOT EXISTS preferred_vendor text;
ALTER TABLE inventory ADD COLUMN IF NOT EXISTS reorder_quantity numeric NOT NULL DEFAULT 0;
```

### Logic (in `notificationTriggers.ts`)

```typescript
export async function checkAutoReorder() {
  // Find products at or below reorder point that don't have an open draft PO
  const { data: lowStock } = await supabase
    .from('inventory')
    .select('*, product:products(product_name, vendor)')
    .gt('reorder_point', 0)
    .filter('quantity_available', 'lte', 'reorder_point');

  if (!lowStock) return;

  for (const item of lowStock) {
    // Check if a draft PO already exists for this product
    const { data: existingPO } = await supabase
      .from('purchase_order_items')
      .select('purchase_order_id, purchase_orders!inner(status)')
      .eq('product_id', item.product_id)
      .eq('purchase_orders.status', 'draft')
      .limit(1);

    if (existingPO && existingPO.length > 0) continue; // already have a draft PO

    // Create draft PO (or add to existing vendor draft PO)
    // ... create PO with reorder_quantity at current_cost ...
    // Notify admins
  }
}
```

### Business Rules
- Only creates draft POs — admin must review and submit
- Groups items by vendor into single PO where possible
- Uses `inventory.preferred_vendor` (falls back to `products.vendor`)
- Reorder quantity defaults to `reorder_quantity` field (or `min_stock_level - quantity_available` if not set)
- Dedup: only one draft PO per product at a time

---

## 2.5 Inventory Transfers Between Locations

### UI Addition to InventoryPage.tsx
- "Transfer" button → modal:
  - Product (dropdown)
  - From location (dropdown)
  - To location (dropdown)
  - Quantity
  - Notes
- Creates paired inventory_transactions (one negative at from_location, one positive at to_location)
- Updates both inventory rows atomically

### RPC: `transfer_inventory`

```sql
CREATE OR REPLACE FUNCTION transfer_inventory(
  p_product_id uuid,
  p_from_location text,
  p_to_location text,
  p_quantity numeric,
  p_performed_by uuid,
  p_notes text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Lock source
  PERFORM id FROM inventory WHERE product_id = p_product_id AND location = p_from_location FOR UPDATE;

  -- Validate
  IF NOT EXISTS (SELECT 1 FROM inventory WHERE product_id = p_product_id AND location = p_from_location AND quantity_available >= p_quantity) THEN
    RAISE EXCEPTION 'Insufficient quantity at source location';
  END IF;

  -- Deduct from source
  UPDATE inventory SET quantity_available = quantity_available - p_quantity, updated_at = now()
  WHERE product_id = p_product_id AND location = p_from_location;

  -- Add to destination (upsert)
  INSERT INTO inventory (product_id, location, quantity_available)
  VALUES (p_product_id, p_to_location, p_quantity)
  ON CONFLICT (product_id, location) DO UPDATE SET
    quantity_available = inventory.quantity_available + p_quantity,
    updated_at = now();

  -- Log transactions
  INSERT INTO inventory_transactions (product_id, transaction_type, quantity, from_location, to_location, performed_by, notes)
  VALUES (p_product_id, 'transferred', p_quantity, p_from_location, p_to_location, p_performed_by, p_notes);
END;
$$;
```

---

## 2.6 Demand Forecasting

### What
Simple demand forecast based on historical usage + open pipeline (accepted quotes not yet ordered, confirmed orders not yet delivered).

### UI Addition to InventoryPage.tsx or Reports.tsx
- New panel or report tab: "Demand Forecast"
- Per product: Current Stock | On Order (open POs) | Pipeline Demand (open quotes + unfulfilled orders) | Projected Shortfall | Days of Supply
- `Pipeline Demand` = sum of total_units_needed from quotes (status='accepted') + order_items (quantity_remaining > 0)
- `Projected Shortfall` = quantity_available + on_order - pipeline_demand (negative = shortfall)
- `Days of Supply` = quantity_available / (average daily usage over last 90 days)
- Color code: green (> 30 days), yellow (15-30 days), red (< 15 days)

### Business Rules
- "Average daily usage" = total quantity delivered/applied in last 90 days / 90
- Seasonal adjustment: compare to same period last year if data exists
- This is a read-only analytics view — no new tables needed, just aggregate queries

---

## 2.7 Waste / Spoilage Tracking

### Database Changes

```sql
-- Add reason_code to inventory adjustments
ALTER TABLE inventory_transactions ADD COLUMN IF NOT EXISTS reason_code text;
-- Allowed values: 'cycle_count', 'spoilage', 'damage', 'spill', 'return', 'correction', 'other'
```

### UI Changes
- **InventoryPage.tsx "Adjust" modal**: Add reason_code dropdown (required for adjustments)
  - Options: Cycle Count, Spoilage/Expiration, Damage, Spill, Customer Return, Correction, Other
- **Reports.tsx**: New "Waste & Spoilage" report tab
  - Table: Product | Reason | Quantity Lost | Value Lost (qty * current_cost) | Date | Performed By
  - Subtotals by reason code
  - Date range filter

---

## 2.8 Dead Stock Identification

### UI Addition to InventoryPage.tsx
- New panel or modal: "Dead Stock Analysis"
- Query: products with quantity_available > 0 but no inventory_transactions in last 90/180 days
- Table: Product | Location | Qty | Last Movement Date | Days Since Movement | Value (qty * cost)
- Configurable threshold: 90/180/365 days
- Helps identify products to discount, return to vendor, or write off

---

## 2.9 Inventory Valuation

### What
Weighted average cost method: track the average cost of inventory based on all purchase lots.

### UI Addition (Reports.tsx tab: "Inventory Valuation")
- Table: Product | Location | Qty Available | Weighted Avg Cost | Total Value | % of Total Inventory Value
- Total row at bottom: sum of all values
- Weighted avg cost = sum(lot.quantity * lot.unit_cost) / sum(lot.quantity) from inventory_lots
- CSV export

---

## 2.10 Inventory Turnover Report

### UI Addition (Reports.tsx tab: "Inventory Turnover")
- Table: Product | Beginning Inventory | Received | Delivered/Applied | Ending Inventory | Turnover Rate | Days of Supply
- Turnover Rate = COGS / Average Inventory Value
- Date range filter (default: current season July-June)
- ABC classification: A = top 80% revenue, B = next 15%, C = bottom 5%
- CSV export

---

## Phase 2 Verification Checklist

- [ ] `inventory_lots` table created with RLS
- [ ] `cycle_counts` + `cycle_count_items` tables created with RLS
- [ ] Lot tracking on PO receipt, delivery, and work order completion
- [ ] Expiration date management with alerts and FEFO suggestion
- [ ] Cycle count workflow: create → count → submit → approve → auto-adjust
- [ ] Auto-reorder trigger creates draft POs
- [ ] Inventory transfer between locations (atomic RPC)
- [ ] Demand forecast panel with pipeline + historical usage
- [ ] Waste/spoilage reason codes on adjustments + report
- [ ] Dead stock identification panel
- [ ] Inventory valuation report (weighted average)
- [ ] Inventory turnover + ABC classification report
- [ ] `npm run build` passes
- [ ] `npx vitest run` passes (add tests for forecast calc, turnover calc, aging bucket logic)

---

# PHASE 3: FINANCIAL FOUNDATION

> **Priority:** HIGH — Business needs proper invoicing before launch
>
> **Dependency:** Phase 2 (lot tracking feeds into COGS/valuation), but can be built in parallel
>
> **Estimated scope:** 3 new tables, 1 altered table, 3 new RPCs, 2 new pages, 1 Edge Function

## 3.1 Invoice Generation

### What
Generate proper invoices from orders. Invoice includes: invoice number, invoice date, payment terms, line items, tax, total due, and a professional PDF.

### Database

```sql
CREATE TABLE IF NOT EXISTS invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_number text NOT NULL UNIQUE,
  order_id uuid NOT NULL REFERENCES orders(id),
  customer_id uuid NOT NULL REFERENCES customers(id),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'paid', 'partial', 'overdue', 'void')),
  invoice_date date NOT NULL DEFAULT CURRENT_DATE,
  due_date date NOT NULL,
  payment_terms text,                        -- "Net 30", "2/10 Net 30", etc.
  subtotal numeric NOT NULL DEFAULT 0,
  tax_rate numeric NOT NULL DEFAULT 0,       -- percentage (e.g., 7.5 for 7.5%)
  tax_amount numeric NOT NULL DEFAULT 0,
  discount_amount numeric NOT NULL DEFAULT 0,
  total_amount numeric NOT NULL DEFAULT 0,
  amount_paid numeric NOT NULL DEFAULT 0,
  balance_due numeric NOT NULL DEFAULT 0,
  tax_exempt boolean NOT NULL DEFAULT false,
  tax_exempt_number text,
  notes text,
  internal_notes text,
  sent_at timestamptz,
  sent_to_email text,
  pdf_url text,
  created_by uuid NOT NULL REFERENCES profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_invoices_order ON invoices(order_id);
CREATE INDEX IF NOT EXISTS idx_invoices_customer ON invoices(customer_id);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);
CREATE INDEX IF NOT EXISTS idx_invoices_due_date ON invoices(due_date);

-- Invoice line items (may differ from order items if partial invoicing)
CREATE TABLE IF NOT EXISTS invoice_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  order_item_id uuid REFERENCES order_items(id),
  product_id uuid REFERENCES products(id),
  description text NOT NULL,
  quantity numeric NOT NULL DEFAULT 0,
  unit_price numeric NOT NULL DEFAULT 0,
  total numeric NOT NULL DEFAULT 0,
  sort_order integer NOT NULL DEFAULT 0
);

-- Add credit_limit and tax_exempt to customers
ALTER TABLE customers ADD COLUMN IF NOT EXISTS credit_limit numeric;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS tax_exempt boolean NOT NULL DEFAULT false;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS tax_exempt_number text;
```

### TypeScript Types

```typescript
export type InvoiceStatus = 'draft' | 'sent' | 'paid' | 'partial' | 'overdue' | 'void';

export interface Invoice {
  id: string;
  invoice_number: string;
  order_id: string;
  customer_id: string;
  status: InvoiceStatus;
  invoice_date: string;
  due_date: string;
  payment_terms: string | null;
  subtotal: number;
  tax_rate: number;
  tax_amount: number;
  discount_amount: number;
  total_amount: number;
  amount_paid: number;
  balance_due: number;
  tax_exempt: boolean;
  tax_exempt_number: string | null;
  notes: string | null;
  internal_notes: string | null;
  sent_at: string | null;
  sent_to_email: string | null;
  pdf_url: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  customer?: Customer;
  order?: Order;
  items?: InvoiceItem[];
}

export interface InvoiceItem {
  id: string;
  invoice_id: string;
  order_item_id: string | null;
  product_id: string | null;
  description: string;
  quantity: number;
  unit_price: number;
  total: number;
  sort_order: number;
  product?: Product;
}
```

### UI

#### Invoices.tsx (new page — `/invoices`)
- Table: invoice_number, customer, status (badge), invoice_date, due_date, total_amount, balance_due, days_overdue (calculated)
- Status badges: draft=gray, sent=blue, partial=yellow, paid=green, overdue=red, void=gray-strikethrough
- Filters: status dropdown, customer search, date range
- "Create Invoice" button → InvoiceDetail (new)
- Search by invoice number, customer name

#### InvoiceDetail.tsx (new page — `/invoices/new`, `/invoices/:id`)
- **Create from order**: Select order → auto-populate line items from order_items
- Header: customer info (from order), invoice_date, due_date (auto-calculated from payment_terms)
- Payment terms dropdown: Net 15, Net 30, Net 60, 2/10 Net 30, Due on Receipt, Custom
- Line items table: description, quantity, unit_price, total (editable)
- Tax calculation: if customer.tax_exempt → tax_rate = 0, else → configurable default rate from app_settings
- Subtotal → Tax → Discount → Total
- Notes (printed on invoice), Internal notes (not printed)
- "Save Draft" button
- "Send Invoice" button → generates PDF, sends via email (Phase 3.2), sets status='sent'
- "Download PDF" button → client-side jsPDF (branded invoice template)
- "Record Payment" button → opens payment modal (ties to existing Payments system)
- "Void" button (admin) with confirmation

### Invoice PDF Template (`src/lib/invoicePdf.ts`)
- Company logo + name + address (from app_settings)
- "INVOICE" header
- Invoice number, date, due date, payment terms
- Bill To: customer name, billing address
- Line items table: Description | Qty | Unit Price | Total
- Subtotal, Tax, Discount, **Total Due** (bold)
- Payment instructions / bank info (from app_settings)
- Footer: "Thank you for your business"

### Business Rules
- Invoice number format: `INV-{YEAR}-{4-digit seq}` (e.g., INV-2026-0001)
- Due date auto-calculated: invoice_date + payment_terms days
- For "2/10 Net 30": if paid within 10 days, 2% discount applies
- One order can have multiple invoices (partial invoicing)
- Recording a payment against an invoice updates: invoice.amount_paid, invoice.balance_due, invoice.status
- Also updates order.total_paid, order.balance_due (keep in sync)
- When balance_due = 0 → status = 'paid'
- Overdue detection: daily check → if due_date < today AND balance_due > 0 → status = 'overdue'

---

## 3.2 Email Integration

### What
Send invoices and quotes as PDF attachments via email using a Supabase Edge Function with Resend (or SendGrid).

### Edge Function: `send-email`

```typescript
// supabase/functions/send-email/index.ts
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

Deno.serve(async (req: Request) => {
  const { to, subject, html, attachments } = await req.json();
  // attachments: [{ filename, content (base64), contentType }]

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${Deno.env.get('RESEND_API_KEY')}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: Deno.env.get('FROM_EMAIL') || 'invoices@croprxsolutions.com',
      to: [to],
      subject,
      html,
      attachments,
    }),
  });

  const data = await res.json();
  return new Response(JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json' },
  });
});
```

### Frontend Integration
- "Send Invoice" on InvoiceDetail.tsx:
  1. Generate PDF (jsPDF) → get base64 content
  2. Call Edge Function `send-email` with: to=customer.email, subject="Invoice INV-2026-0001 from Crop RX Solutions", html=email template, attachments=[{filename, content, contentType}]
  3. On success: set invoice.sent_at, invoice.sent_to_email, invoice.status='sent'
  4. Toast: "Invoice sent to customer@email.com"

- "Send Quote" on QuoteBuilder.tsx (modify existing):
  1. Generate quote PDF → base64
  2. Call `send-email` Edge Function
  3. Set quote.sent_at, quote.status='sent'

### Business Rules
- Require customer email before sending (validate, show error if missing)
- Store sent_at timestamp and sent_to_email for audit trail
- Activity log: "Invoice INV-2026-0001 emailed to john@smithfarms.com"
- Do not auto-send — always require user click to send

---

## 3.3 AR Aging Report

### What
30/60/90/120+ day aging buckets for all outstanding invoices.

### Business Logic (`src/lib/invoiceCalc.ts`)

```typescript
export interface AgingBucket {
  current: number;      // 0-30 days
  days30: number;       // 31-60 days
  days60: number;       // 61-90 days
  days90: number;       // 91-120 days
  days120plus: number;  // 120+ days
  total: number;
}

export function calculateAgingBuckets(invoices: { balance_due: number; invoice_date: string; due_date: string }[]): AgingBucket {
  const today = new Date();
  const buckets: AgingBucket = { current: 0, days30: 0, days60: 0, days90: 0, days120plus: 0, total: 0 };

  for (const inv of invoices) {
    if (inv.balance_due <= 0) continue;
    const daysPastDue = Math.floor((today.getTime() - new Date(inv.due_date).getTime()) / 86400000);

    if (daysPastDue <= 0) buckets.current += inv.balance_due;
    else if (daysPastDue <= 30) buckets.days30 += inv.balance_due;
    else if (daysPastDue <= 60) buckets.days60 += inv.balance_due;
    else if (daysPastDue <= 90) buckets.days90 += inv.balance_due;
    else buckets.days120plus += inv.balance_due;

    buckets.total += inv.balance_due;
  }
  return buckets;
}
```

### UI (Payments.tsx — new "Aging" tab or replace existing AR tab)
- Summary cards at top: Current | 1-30 | 31-60 | 61-90 | 91-120 | 120+ | Total
- Customer-level aging table: Customer | Current | 1-30 | 31-60 | 61-90 | 91-120 | 120+ | Total
- Click customer row → expand to show individual invoices in each bucket
- Sort by total (desc) to prioritize collection calls
- CSV export

---

## 3.4 Credit Limits & Credit Hold

### What
Set credit limits per customer. Block new order creation when customer exceeds limit.

### UI Changes
- **CustomerDetail.tsx**: Add `credit_limit` field (numeric input, admin only)
- **NewOrder.tsx / QuoteBuilder "Convert to Order"**: Before creating order, check:
  - `customer.credit_limit > 0 AND (orders.balance_due_total + new_order.total_price) > customer.credit_limit`
  - If exceeded: show warning modal "Customer has exceeded their credit limit of $X. Current outstanding: $Y. This order would bring total to $Z. Proceed anyway?" (admin can override, sales_rep cannot)
- **Customers.tsx list**: Show "Credit Hold" badge on customers where outstanding > credit_limit
- **Dashboard**: Widget showing customers on credit hold (count + total exposure)

---

## 3.5 Customer Statements

### What
Generate a statement PDF showing all invoices, payments, and running balance for a customer over a period.

### UI
- **CustomerDetail.tsx**: Add "Generate Statement" button
  - Date range picker (default: last 30 days)
  - Generate PDF (jsPDF) with:
    - Customer name + address
    - Statement period
    - Table: Date | Type (Invoice/Payment/Credit) | Reference # | Amount | Balance
    - Running balance per line
    - Summary: Opening Balance | Charges | Payments | Ending Balance
  - "Send Statement" button → emails PDF to customer

### Business Rules
- Statements include ALL invoices and payments in the period, not just unpaid
- Opening balance = sum of all unpaid invoices before the period start date
- Can generate for a single customer or batch for all customers with balance > 0

---

## 3.6 Refunds & Credit Memos

### Database

```sql
CREATE TABLE IF NOT EXISTS credit_memos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  credit_memo_number text NOT NULL UNIQUE,
  customer_id uuid NOT NULL REFERENCES customers(id),
  invoice_id uuid REFERENCES invoices(id),       -- optional: which invoice is being credited
  order_id uuid REFERENCES orders(id),
  reason text NOT NULL,                           -- 'return', 'price_adjustment', 'damage', 'billing_error', 'other'
  amount numeric NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'applied', 'void')),
  applied_to_invoice_id uuid REFERENCES invoices(id),  -- which invoice the credit was applied to
  notes text,
  created_by uuid NOT NULL REFERENCES profiles(id),
  approved_by uuid REFERENCES profiles(id),
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
```

### UI
- **Payments.tsx**: New "Credit Memos" tab
  - Table: credit_memo_number, customer, reason, amount, status, created_at
  - "Create Credit Memo" button → modal: customer, reason dropdown, amount, invoice reference (optional), notes
  - "Approve" button (admin) → status = 'approved'
  - "Apply to Invoice" button → select open invoice, deduct credit amount from invoice balance
- Credit memo number format: `CM-{YEAR}-{4-digit seq}`

---

## 3.7 Early Payment Discounts & Late Fees

### What
Structured payment terms with discount/penalty logic.

### Database Changes

```sql
-- Add structured payment terms to customers
ALTER TABLE customers ADD COLUMN IF NOT EXISTS payment_terms_days integer DEFAULT 30;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS early_discount_pct numeric DEFAULT 0;     -- e.g., 2.0 for 2%
ALTER TABLE customers ADD COLUMN IF NOT EXISTS early_discount_days integer DEFAULT 0;    -- e.g., 10 for "2/10"
ALTER TABLE customers ADD COLUMN IF NOT EXISTS late_fee_pct numeric DEFAULT 0;           -- monthly late fee %
```

### Business Rules
- When recording a payment on an invoice:
  - If payment_date <= invoice_date + early_discount_days AND early_discount_pct > 0:
    - Apply discount: effective_amount = payment_amount / (1 - early_discount_pct/100)
    - Show discount applied on payment record
- Late fee calculation (optional, manual trigger):
  - If invoice.due_date < today AND balance_due > 0:
    - Late fee = balance_due * late_fee_pct / 100 * months_overdue
    - Add as new invoice line item or separate charge

---

## 3.8 Tax Calculation

### What
Configurable tax rates with agricultural exemptions.

### Database Changes

```sql
-- Add default_tax_rate to app_settings (or use existing key-value)
-- customer.tax_exempt already added in 3.1
-- customer.tax_exempt_number already added in 3.1
```

### Business Rules
- Default tax rate stored in app_settings (key: 'default_tax_rate', value: '0' — many ag products are exempt)
- If customer.tax_exempt = true → tax_rate = 0 on all invoices
- If not exempt → use default_tax_rate from settings
- Tax exempt number displayed on invoices for compliance
- Admin can override tax rate per invoice

---

## Phase 3 Verification Checklist

- [ ] `invoices` + `invoice_items` tables created with RLS
- [ ] `credit_memos` table created with RLS
- [ ] `credit_limit`, `tax_exempt`, `tax_exempt_number` columns on customers
- [ ] Invoice CRUD: create from order, edit, void
- [ ] Invoice PDF generation with branded template
- [ ] Email sending Edge Function (send-email) working
- [ ] Send invoice + send quote via email
- [ ] AR aging report with 30/60/90/120 day buckets
- [ ] Credit limit enforcement on order creation
- [ ] Customer statement PDF generation + email
- [ ] Credit memos: create, approve, apply to invoice
- [ ] Early payment discount logic on payment recording
- [ ] Tax calculation with exemption support
- [ ] Sidebar: add "Invoices" nav item (icon: Receipt from lucide-react)
- [ ] `npm run build` passes
- [ ] `npx vitest run` passes (add tests for aging bucket calculation, tax calculation, discount logic)

---

# PHASE 4: LOGISTICS & DELIVERY ENHANCEMENT

> **Priority:** MEDIUM — Improves delivery operations efficiency
>
> **Dependency:** Phases 1-3 (work orders, inventory lots, invoices exist)

## 4.1 Delivery Calendar View

### UI
- New view toggle on Deliveries.tsx: List | Calendar
- Weekly calendar grid (Mon-Sun) showing delivery cards per day
- Card: customer name, item count, driver avatar, status badge
- Click card → navigate to delivery detail
- Filter by driver, status
- Summary: "This week: X deliveries, Y to schedule"
- Implementation: CSS grid with 7 columns, same pattern as work order calendar (Phase 1.3)

## 4.2 Vehicle / Fleet Management

### Database

```sql
CREATE TABLE IF NOT EXISTS vehicles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_name text NOT NULL,               -- "Truck 1", "Sprayer 2", etc.
  vehicle_type text NOT NULL DEFAULT 'truck' CHECK (vehicle_type IN ('truck', 'sprayer', 'trailer', 'spreader', 'other')),
  license_plate text,
  vin text,
  year integer,
  make text,
  model text,
  weight_capacity_lbs numeric,
  volume_capacity_gal numeric,
  is_active boolean NOT NULL DEFAULT true,
  current_odometer numeric,
  last_service_date date,
  next_service_date date,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Link vehicles to deliveries and work orders
ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS vehicle_id uuid REFERENCES vehicles(id);
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS vehicle_id uuid REFERENCES vehicles(id);
```

### UI
- **Settings page or new /fleet page**: Vehicle CRUD (admin only)
- **NewDelivery.tsx**: Add vehicle dropdown
- **WorkOrderDetail.tsx**: Add vehicle dropdown
- **Dashboard**: Vehicle utilization widget (deliveries/work orders per vehicle this week)

## 4.3 Load Planning & Capacity

### UI Addition to NewDelivery.tsx
- When vehicle is selected, show capacity: "Truck 1: 40,000 lbs / 500 gal capacity"
- Calculate load weight/volume from delivery items (product.container_size * quantity)
- Show load bar: "Load: 75% capacity (30,000 / 40,000 lbs)"
- Warning if load exceeds capacity

## 4.4 Delivery Time Windows

### Database Changes

```sql
ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS delivery_window_start text;  -- "8:00 AM"
ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS delivery_window_end text;    -- "12:00 PM"
ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS estimated_duration_min integer;
```

### UI Changes
- **NewDelivery.tsx**: Add time window inputs (start/end time)
- **DeliveryDetail.tsx**: Display time window
- **Customer delivery preferences**: Add to customer_addresses: preferred_days (JSONB), preferred_window_start, preferred_window_end, requires_appointment (boolean)

## 4.5 Return / Damage Handling (RMA)

### Database

```sql
CREATE TABLE IF NOT EXISTS returns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  return_number text NOT NULL UNIQUE,
  customer_id uuid NOT NULL REFERENCES customers(id),
  order_id uuid REFERENCES orders(id),
  delivery_id uuid REFERENCES deliveries(id),
  reason text NOT NULL CHECK (reason IN ('defective', 'wrong_product', 'overship', 'damaged', 'customer_request', 'other')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'received', 'restocked', 'credited', 'rejected')),
  total_value numeric NOT NULL DEFAULT 0,
  notes text,
  created_by uuid NOT NULL REFERENCES profiles(id),
  approved_by uuid REFERENCES profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS return_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  return_id uuid NOT NULL REFERENCES returns(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id),
  quantity numeric NOT NULL DEFAULT 0,
  unit_price numeric NOT NULL DEFAULT 0,
  condition text DEFAULT 'sellable' CHECK (condition IN ('sellable', 'damaged', 'expired')),
  restock boolean NOT NULL DEFAULT true,
  lot_number text,
  notes text
);
```

### UI
- **Returns.tsx** (new page — `/returns`): List returns with status
- **ReturnDetail.tsx** (`/returns/new`, `/returns/:id`): Create return from order/delivery, select items, set quantities and condition
- On approval: if restock=true → add back to inventory; create credit memo for customer
- Activity logging on all return status changes

## 4.6 Driver Performance Metrics

### UI Addition to Reports.tsx (new tab: "Driver Performance")
- Table: Driver | Total Deliveries | Total Work Orders | Acres Applied | On-Time Rate | Avg Completion Time
- On-Time Rate = deliveries completed on scheduled_date / total deliveries
- Date range filter
- CSV export

## 4.7 Route Optimization / Multi-Stop Planning

### What
Group multiple deliveries into a single route (trip) for a driver on a given day.

### Database

```sql
CREATE TABLE IF NOT EXISTS delivery_routes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  route_date date NOT NULL,
  assigned_driver uuid NOT NULL REFERENCES profiles(id),
  vehicle_id uuid REFERENCES vehicles(id),
  status text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'in_progress', 'completed')),
  total_stops integer NOT NULL DEFAULT 0,
  notes text,
  created_by uuid NOT NULL REFERENCES profiles(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS delivery_route_stops (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  route_id uuid NOT NULL REFERENCES delivery_routes(id) ON DELETE CASCADE,
  delivery_id uuid NOT NULL REFERENCES deliveries(id),
  stop_order integer NOT NULL DEFAULT 0,
  estimated_arrival text,
  actual_arrival timestamptz,
  notes text
);
```

### UI
- **Route Planner** (new page or modal from delivery calendar):
  - Select date + driver
  - Drag deliveries from "unassigned" pool into the route
  - Reorder stops by drag-and-drop
  - Show: customer name, address, item count per stop
  - Save route → creates delivery_route + stops
- **Driver view**: See today's route as an ordered stop list

---

## Phase 4 Verification Checklist

- [ ] Delivery calendar view working
- [ ] Vehicles table + CRUD
- [ ] Vehicle assignment on deliveries + work orders
- [ ] Load capacity display + warning
- [ ] Delivery time windows
- [ ] Returns CRUD: create, approve, receive, restock/credit
- [ ] Driver performance report tab
- [ ] Route planning: create route, assign stops, reorder
- [ ] `npm run build` passes
- [ ] `npx vitest run` passes

---

# PHASE 5: SALES & CUSTOMER EXPERIENCE

> **Priority:** MEDIUM — Improves sales process and management visibility
>
> **Dependency:** Phase 3 (invoices, email integration)

## 5.1 Sales Pipeline Visualization

### UI Addition to Quotes.tsx
- Toggle view: List | Pipeline
- Pipeline view (horizontal kanban):
  - Columns: Draft → Sent → Revised → Accepted → Declined/Expired
  - Cards in each column: customer name, quote total, days in stage, assigned rep
  - Summary per column: count + total value
  - Click card → navigate to quote detail
- Conversion metrics bar: "Sent→Accepted rate: 65% | Avg days to close: 12 | Pipeline value: $450K"

## 5.2 Follow-Up Reminders & CRM Tasks

### Database

```sql
CREATE TABLE IF NOT EXISTS follow_ups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  description text,
  due_date date NOT NULL,
  due_time text,
  assigned_to uuid NOT NULL REFERENCES profiles(id),
  related_entity_type text,     -- 'quote', 'order', 'customer', 'invoice'
  related_entity_id uuid,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'cancelled')),
  completed_at timestamptz,
  reminder_sent boolean NOT NULL DEFAULT false,
  created_by uuid NOT NULL REFERENCES profiles(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
```

### UI
- "Add Follow-Up" button on QuoteBuilder, OrderDetail, CustomerDetail, InvoiceDetail
- Follow-up list on Dashboard (today's + overdue follow-ups for current user)
- Notification trigger: `checkFollowUpReminders()` — fires for due/overdue follow-ups
- Quick-complete button (checkmark) on follow-up items

## 5.3 Role-Specific Dashboards

### UI Changes to Dashboard.tsx
- **Admin dashboard** (current, enhanced): Add credit hold widget, aging summary widget, fleet utilization
- **Sales rep dashboard**: My pipeline (quotes by status), my commissions (pending/paid), my customers with balance, my follow-ups due
- **Driver/Applicator dashboard**: Today's route/work orders, today's deliveries, recent completions, total acres applied this week

## 5.4 Season-Over-Season Comparison

### UI Addition to Reports.tsx
- New tab or toggle on existing report tabs: "Compare to Last Season"
- Side-by-side or overlay chart: This season vs last season by month
- Table: Month | This Season Revenue | Last Season Revenue | Change ($) | Change (%)
- Works with existing "This Season" / "Last Season" date range presets

## 5.5 Margin Analysis & Pricing Analytics

### UI Addition to Reports.tsx (new tab: "Margin Analysis")
- By product: Product | Tier 1 Margin | Tier 2 Margin | Tier 3 Margin | Avg Margin | Volume | Revenue
- By customer: Customer | Tier | Avg Margin | Revenue | Margin Trend (up/down)
- By category: Category | Avg Margin | Revenue | % of Total Revenue
- Margin trend over time (line chart by month)
- Identify margin leaks: products where actual margin < expected tier margin

## 5.6 Scheduled Report Delivery

### What
Admin can schedule reports to be emailed weekly/monthly.

### Database

```sql
CREATE TABLE IF NOT EXISTS scheduled_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_type text NOT NULL,         -- 'aging', 'revenue', 'commissions', 'inventory_valuation', etc.
  frequency text NOT NULL CHECK (frequency IN ('daily', 'weekly', 'monthly')),
  recipients JSONB NOT NULL,         -- [{ email: "...", name: "..." }]
  parameters JSONB,                  -- { date_range: "this_season", customer_id: null, ... }
  is_active boolean NOT NULL DEFAULT true,
  last_sent_at timestamptz,
  next_run_at timestamptz,
  created_by uuid NOT NULL REFERENCES profiles(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
```

### Implementation
- Settings page: "Scheduled Reports" section (admin only)
- Add/edit/delete scheduled reports
- Supabase Edge Function: `send-scheduled-report` — called via pg_cron or external cron
  - Generates report data, creates PDF/CSV, sends via `send-email` function
  - Updates last_sent_at, calculates next_run_at

---

## Phase 5 Verification Checklist

- [ ] Sales pipeline kanban view on quotes page
- [ ] Follow-up tasks: CRUD, dashboard widget, reminders
- [ ] Role-specific dashboard variants
- [ ] Season-over-season comparison report
- [ ] Margin analysis report tab
- [ ] Scheduled report delivery configuration + Edge Function
- [ ] `npm run build` passes
- [ ] `npx vitest run` passes

---

# PHASE 6: COMPLIANCE & REGULATORY

> **Priority:** MEDIUM-HIGH — Legal compliance for ag chemical distribution
>
> **Dependency:** Phase 1 (fields, work orders), Phase 2 (lot tracking)

## 6.1 Restricted-Use Pesticide (RUP) Tracking

### Database Changes

```sql
ALTER TABLE products ADD COLUMN IF NOT EXISTS is_restricted_use boolean NOT NULL DEFAULT false;
ALTER TABLE products ADD COLUMN IF NOT EXISTS signal_word text;  -- 'DANGER', 'WARNING', 'CAUTION'
ALTER TABLE products ADD COLUMN IF NOT EXISTS restricted_use_notes text;
```

### Business Rules
- When adding a RUP product to an order or work order, verify the customer has a valid applicator license (Phase 6.2)
- If no valid license → block the order item with error: "Restricted-use product requires valid applicator license"
- Admin can override with confirmation
- RUP products display a red "RESTRICTED USE" badge in product lists and on quotes/orders

## 6.2 Applicator License Tracking

### Database

```sql
CREATE TABLE IF NOT EXISTS applicator_licenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  license_number text NOT NULL,
  license_state text NOT NULL,
  license_type text,                     -- 'commercial', 'private', 'government'
  categories text[],                     -- e.g., ['1a', '1b', '7a'] — pesticide categories
  issued_date date,
  expiration_date date NOT NULL,
  licensee_name text NOT NULL,
  is_verified boolean NOT NULL DEFAULT false,
  verified_by uuid REFERENCES profiles(id),
  verified_at timestamptz,
  document_url text,                     -- uploaded license image/PDF
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_licenses_customer ON applicator_licenses(customer_id);
CREATE INDEX IF NOT EXISTS idx_licenses_expiry ON applicator_licenses(expiration_date);
```

### UI
- **CustomerDetail.tsx**: New "Licenses" tab
  - Table: license_number, state, type, categories, expiration_date, verified badge
  - "Add License" button → modal with form fields + file upload for license document
  - "Verify" button (admin) → is_verified=true
  - Expiration warning: yellow < 90 days, red = expired
- **Notification trigger**: `checkExpiringLicenses()` — alert admins 90 days before expiration

### Business Rules
- License is valid if: expiration_date >= today AND is_verified = true
- RUP order check: customer must have at least one valid license
- Activity log: "License {number} added for {customer}, expires {date}"

## 6.3 SDS Document Management

### Database

```sql
CREATE TABLE IF NOT EXISTS product_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  document_type text NOT NULL CHECK (document_type IN ('sds', 'coa', 'label', 'specimen_label', 'other')),
  document_name text NOT NULL,
  storage_path text NOT NULL,
  document_url text NOT NULL,
  file_size integer,
  version text,
  effective_date date,
  uploaded_by uuid NOT NULL REFERENCES profiles(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
```

### UI
- **ProductDetail.tsx**: New "Documents" section
  - Upload SDS, COA, label, specimen label per product
  - Table: document_type, document_name, version, effective_date, uploaded_by, download link
- **DeliveryDetail PDF**: Auto-include "SDS Available" note for each product delivered with link
- **WorkOrderDetail**: Show SDS links for all products in the work order

## 6.4 EPA Compliance Reporting

### UI Addition to Reports.tsx (new tab: "Regulatory")
- **Restricted-Use Sales Log**: Date | Customer | Applicator License # | Product | EPA Reg # | Quantity | Unit
  - Filter by date range (default: calendar year for state reporting)
  - CSV export formatted for state Department of Agriculture submission
- **Product Application Log**: Date | Customer | Field | Product | EPA Reg # | Rate | Acres | Applicator
  - From work orders (completed/verified)
  - CSV export

## 6.5 Field-Level Application Records

### UI
- Exportable per-field application record combining:
  - Customer + field info (name, acres, legal description, county)
  - All work order applications for that field in a date range
  - Per application: date, products, rates, acres, applicator, weather conditions, lot numbers
- PDF export for customer/regulatory records
- This builds on Phase 1.5 (application history per field) with a formal export format

---

## Phase 6 Verification Checklist

- [ ] `is_restricted_use` flag on products
- [ ] `applicator_licenses` table with CRUD on CustomerDetail
- [ ] RUP enforcement: block orders without valid license
- [ ] License expiration notifications
- [ ] `product_documents` table with SDS/COA upload on ProductDetail
- [ ] EPA restricted-use sales log report
- [ ] Field-level application record export
- [ ] `npm run build` passes
- [ ] `npx vitest run` passes

---

# PHASE 7: ADVANCED FEATURES (FUTURE)

> **Priority:** LOWER — Build after core operations are solid
>
> **These are documented for future reference. Implement when the business is ready.**

## 7.1 Customer Self-Service Portal
- Separate Next.js or React app (or Supabase auth "customer" role)
- Customers can: view quotes, approve quotes online, view orders + delivery status, view/pay invoices, download statements
- Stripe or payment gateway integration for online payments
- Read-only views — no editing of orders or products

## 7.2 QuickBooks Integration
- QuickBooks Online API integration via Edge Function
- Map: Invoices → QB Invoices, Payments → QB Payments, Products → QB Items, Customers → QB Customers
- Two-way sync with conflict resolution
- Chart of accounts mapping configuration
- Journal entry export for month-end close

## 7.3 SMS Notifications
- Twilio integration via Edge Function
- Delivery ETA SMS to customer: "Your delivery from Crop RX is on the way. ETA: 10:30 AM"
- Work order completion SMS: "Application complete on [field]. Products applied: [list]"
- Quote expiration reminder SMS
- Opt-in/opt-out per customer (add phone_opt_in to customers table)

## 7.4 Approval Chains
- Configurable approval workflows per entity type
- PO approval: POs over $X require admin approval before submission
- Discount approval: discounts over Y% require manager approval
- Order cancellation: fulfilled orders require admin approval to cancel
- Configuration UI in Settings

## 7.5 PWA / Mobile Optimization
- Service worker for offline caching (critical for rural areas with poor connectivity)
- PWA manifest for home screen installation
- Push notifications via Web Push API
- Mobile-optimized layouts for driver/applicator views
- Camera integration for blend ticket uploads and delivery photos

## 7.6 Barcode / QR Scanning
- Generate barcodes for products (SKU-based) and inventory lots
- Camera-based barcode scanner component (using quagga2 or html5-qrcode library)
- Scan to: look up product, start receiving, confirm delivery item
- Print barcode labels (thermal printer support)

## 7.7 Vendor Scorecard & Lead Time Tracking
- Track vendor performance: on-time delivery rate, fill rate, quality issues
- Calculate average lead time per vendor (expected_delivery_date vs actual receipt date)
- Vendor comparison dashboard
- Use data to optimize reorder points and preferred vendor selection

## 7.8 Data Visualization (Recharts)
- Replace basic SVG chart on Dashboard with Recharts library
- Interactive tooltips, responsive sizing
- Charts for: revenue trend, margin trend, inventory levels, delivery volume, pipeline funnel
- Drilldown capability (click bar → see underlying data)

## 7.9 Audit Trail Improvements
- Field-level change tracking: store before/after JSON snapshots on updates
- "History" tab on every entity detail page showing who changed what, when
- Diff view: highlight changed fields between versions
- Revert capability (admin only) — restore previous version of a record

---

# APPENDIX A: NEW SIDEBAR NAVIGATION (After All Phases)

```typescript
const navItems: NavItem[] = [
  { path: '/', label: 'Dashboard', icon: <LayoutDashboard /> },
  { path: '/products', label: 'Products', icon: <Package /> },
  { path: '/customers', label: 'Customers', icon: <Users /> },
  { path: '/quotes', label: 'Quotes', icon: <FileText />, roles: ['admin', 'sales_rep'] },
  { path: '/orders', label: 'Orders', icon: <ClipboardList />, roles: ['admin', 'sales_rep'] },
  { path: '/invoices', label: 'Invoices', icon: <Receipt />, roles: ['admin'] },           // NEW Phase 3
  { path: '/work-orders', label: 'Work Orders', icon: <ClipboardCheck />, roles: ['admin', 'sales_rep', 'driver'] }, // NEW Phase 1
  { path: '/inventory', label: 'Inventory', icon: <Warehouse /> },
  { path: '/deliveries', label: 'Deliveries', icon: <Truck /> },
  { path: '/returns', label: 'Returns', icon: <RotateCcw />, roles: ['admin', 'sales_rep'] }, // NEW Phase 4
  { path: '/blend-tickets', label: 'Blend Tickets', icon: <Image /> },
  { path: '/purchase-orders', label: 'Supplier POs', icon: <ShoppingCart />, roles: ['admin'] },
  { path: '/fleet', label: 'Fleet', icon: <Car />, roles: ['admin'] },                      // NEW Phase 4
  { path: '/brand-vs-generic', label: 'Brand vs Generic', icon: <Scale />, roles: ['admin', 'sales_rep'] },
  { path: '/reports', label: 'Reports', icon: <BarChart3 />, roles: ['admin', 'sales_rep'] },
  { path: '/crop-programs', label: 'Crop Programs', icon: <Sprout />, roles: ['admin', 'sales_rep'] },
  { path: '/payments', label: 'Payments', icon: <DollarSign />, roles: ['admin'] },
  { path: '/team-board', label: 'Team Board', icon: <MessageSquare /> },
  { path: '/notifications', label: 'Notifications', icon: <Bell /> },
  { path: '/settings', label: 'Settings', icon: <Settings />, roles: ['admin'] },
];
```

---

# APPENDIX B: NEW REPORT TABS (After All Phases)

Existing: Customer Profitability | Product Profitability | Commissions | Monthly Revenue

New tabs to add:
1. **Application Summary** (Phase 1) — applicator performance, acres applied
2. **Field Application History** (Phase 1) — what was applied to each field
3. **Product Usage** (Phase 1) — application-based product usage
4. **Lot Trace** (Phase 2) — trace a lot from receipt to customer/field
5. **Expiring Inventory** (Phase 2) — lots nearing expiration
6. **Demand Forecast** (Phase 2) — projected shortfall + days of supply
7. **Waste & Spoilage** (Phase 2) — adjustment reason analysis
8. **Dead Stock** (Phase 2) — products with no movement
9. **Inventory Valuation** (Phase 2) — weighted average cost valuation
10. **Inventory Turnover** (Phase 2) — turnover rate + ABC classification
11. **AR Aging** (Phase 3) — 30/60/90/120 day aging buckets
12. **Driver Performance** (Phase 4) — delivery/WO metrics per driver
13. **Regulatory: RUP Sales Log** (Phase 6) — restricted-use pesticide sales
14. **Regulatory: Application Records** (Phase 6) — field-level application export
15. **Season Comparison** (Phase 5) — year-over-year revenue/margin
16. **Margin Analysis** (Phase 5) — margin by product/customer/category

---

# APPENDIX C: COMPLETE FEATURE COUNT

| Phase | Features | New Tables | New Pages | New RPCs | Priority |
|-------|----------|-----------|-----------|----------|----------|
| Phase 1: Work Orders & Fields | 7 | 4 (customer_fields, work_orders, work_order_fields, work_order_products) | 3 (WorkOrders, WorkOrderDetail, WorkOrderCalendar) | 3 (save_work_order, complete_work_order, next_work_order_number) | TOP |
| Phase 2: Inventory Intelligence | 10 | 3 (inventory_lots, cycle_counts, cycle_count_items) | 1 (CycleCountDetail) | 2 (approve_cycle_count, transfer_inventory) | HIGH |
| Phase 3: Financial Foundation | 8 | 3 (invoices, invoice_items, credit_memos) | 2 (Invoices, InvoiceDetail) | 1 (send-email Edge Function) | HIGH |
| Phase 4: Logistics & Delivery | 7 | 4 (vehicles, returns, return_items, delivery_routes + stops) | 2 (Returns, ReturnDetail) | 0 | MEDIUM |
| Phase 5: Sales & Customer | 6 | 2 (follow_ups, scheduled_reports) | 0 (modify existing) | 0 | MEDIUM |
| Phase 6: Compliance & Regulatory | 5 | 2 (applicator_licenses, product_documents) | 0 (modify existing) | 0 | MEDIUM-HIGH |
| Phase 7: Advanced (Future) | 9 | varies | varies | varies | LOWER |
| **TOTAL** | **52 features** | **18 new tables** | **8 new pages** | **6 new RPCs + 1 Edge Function** | — |

---

# APPENDIX D: IMPLEMENTATION RULES

When implementing any phase, ALWAYS:

1. **Create migration file first** — `supabase/migrations/YYYYMMDDHHMMSS_phase{N}_description.sql`
2. **Add TypeScript types** — `src/types/index.ts`
3. **Create RPCs** for any multi-step write operations (never do multi-table writes from the frontend)
4. **Add RLS policies** on every new table (admin full, sales_rep contextual, driver minimal)
5. **Use `checkMutationResult()`** after every mutation
6. **Call `logActivity()`** on every create/update/delete
7. **Add lazy route** in `src/App.tsx`
8. **Add sidebar nav item** in `src/components/layout/Sidebar.tsx`
9. **Use `useSupabaseQuery` hook** for data fetching
10. **Add `.limit(500)`** on all list queries (prevent unbounded loads)
11. **Toast on success/error** for all user actions
12. **Confirmation dialog** for destructive actions (delete, cancel, void)
13. **Run `npm run build`** — fix any TypeScript errors before moving on
14. **Run `npx vitest run`** — add tests for new business logic functions
15. **Do NOT break existing functionality** — verify existing pages still work after schema changes
