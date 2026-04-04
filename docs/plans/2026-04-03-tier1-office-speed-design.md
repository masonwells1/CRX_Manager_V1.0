# Tier 1: Office Speed + Money Visibility — Design Doc

> Created: 2026-04-03 | Owner: Mason Wells | Status: **Approved**

## Overview

5 features that directly reduce daily admin friction and improve financial visibility. These are the highest-impact items from the full 52-item backlog, prioritized because Mason's biggest pain points are office/admin workflows and money tracking.

---

## Feature 1: Transaction Thread Cross-Links

**Problem:** To understand the full lifecycle of an order, you have to manually navigate between 4 different pages. InvoiceDetail and DeliveryDetail are missing links to related entities.

**Solution:** A shared `TransactionThread` component displayed at the top of every detail page showing the full pipeline: Quote → Order → Delivery → Invoice. Each step is clickable. Current page is highlighted.

### Design
- **New component:** `src/components/ui/TransactionThread.tsx`
- **Placement:** Top of QuoteDetail, OrderDetail, DeliveryDetail, InvoiceDetail (below page header, above content)
- **Visual:** Horizontal breadcrumb with arrows: `Quote #Q-123 → Order #O-456 → Delivery #D-789 → Invoice #INV-012`
- **Behavior:**
  - Each step is a clickable link (navigates to that entity's detail page)
  - Current page step is bold + crx-green
  - Missing steps show as gray dashed: "No invoice yet"
  - Multiple deliveries/invoices show as "3 Deliveries" with a dropdown
- **Data source:** Existing FK relationships — no new RPC needed
  - From order: query deliveries + invoices by order_id
  - From delivery: read order_id, then query invoice by order_id
  - From invoice: read order_id, then query deliveries by order_id
  - From quote: query orders by quote_id

### Props Interface
```typescript
interface TransactionThreadProps {
  quoteId?: string;
  quoteNumber?: string;
  orderId?: string;
  orderNumber?: string;
  deliveries?: { id: string; delivery_number: string }[];
  invoices?: { id: string; invoice_number: string }[];
  currentEntity: 'quote' | 'order' | 'delivery' | 'invoice';
}
```

### Database Changes
None — uses existing FK relationships.

---

## Feature 2: Customer 360 View Enhancement

**Problem:** CustomerDetail already has 7 tabs, but you can't see the big picture at a glance. No summary metrics, no timeline, no quick actions.

**Solution:** Add a summary bar with KPIs, a timeline tab, and quick action buttons.

### Design

#### 2a. Customer Summary Bar
- **New component:** `src/components/customers/CustomerSummaryBar.tsx`
- **Placement:** Above the tab bar on CustomerDetail
- **5 KPI cards in a row:**
  1. AR Balance (from invoices.balance_cents sum)
  2. Total Orders (season) — count of orders this season
  3. Total Deliveries (season) — count of completed deliveries
  4. Credit Tier (tier 1/2/3 from customer record)
  5. Last Activity (most recent activity_feed entry for this customer)
- **Data:** Single new RPC `get_customer_summary(p_customer_id uuid)` that returns all 5 values

#### 2b. Timeline Tab
- **New tab** added to CustomerDetail: "Timeline"
- Shows chronological feed of all activity for this customer:
  - Orders placed, deliveries completed, invoices posted, payments received
- **Data:** Query `activity_feed` WHERE entity relates to this customer
- **Visual:** Vertical timeline with colored dots per event type (same pattern as Dashboard recent activity)

#### 2c. Quick Actions
- **3 buttons** in the CustomerDetail header area:
  - "New Quote" → `/quotes/new?customer={id}`
  - "New Order" → `/orders/new?customer={id}`
  - "Schedule Delivery" → `/deliveries/new?customer={id}`
- Pre-fills the customer on the target page via URL params

### Database Changes
- 1 migration: `get_customer_summary()` RPC

---

## Feature 3: Dashboard Action Queue

**Problem:** Dashboard alerts show counts ("3 overdue deliveries") but don't tell you WHICH ones or let you act directly. Users click through to a list page and then hunt for the items.

**Solution:** Replace passive alert cards with specific, actionable items that link directly to the entity.

### Design

- **New component:** `src/components/dashboard/ActionQueue.tsx`
- **Replaces:** The "Operational Alerts" section on Dashboard.tsx
- **Structure:**
  - Collapsible categories: "Overdue Invoices (3)", "Overdue Deliveries (2)", etc.
  - Each item is specific: "Invoice #INV-234 — Farm Alpha — 15 days overdue — $2,450.00"
  - Each item is clickable → navigates directly to the entity detail page
  - Priority sorted: financial items first (overdue invoices, cancelled+posted), then operational
  - "Dismiss for today" button per item (stored in sessionStorage, resets on reload)
  - Max 5 items per category expanded by default, "Show all X →" link
  - Total cap: 30 items across all categories

- **Categories (in priority order):**
  1. Overdue Invoices — invoice number, customer, days overdue, amount
  2. Cancelled Orders with Posted Invoices — order number, customer, invoice number
  3. Overdue Deliveries — delivery number, customer, days overdue
  4. Low Stock Items — product name, current qty, reorder point
  5. Expiring Quotes — quote number, customer, expires in X days
  6. Unassigned Deliveries — delivery number, customer, scheduled date
  7. Stale Inventory Holds — quote number, customer, hold age
  8. POs Expected Today — PO number, vendor
  9. Expiring Licenses — applicator name, expires in X days
  10. Planned Holds Expiring — quote number, customer

### Database Changes
- 1 migration: `get_dashboard_action_items()` RPC that returns specific entity details per category (not just counts)

---

## Feature 4: Workflow Guardrails

**Problem:** Common mistakes (duplicate orders, exceeding credit limits, zero-qty items, stale quotes) are caught too late or not at all.

**Solution:** Frontend warnings at the point of action. Warnings only — not hard blocks (admin can always proceed).

### Design

#### 4a. Duplicate Order Warning
- **Where:** NewOrder page, after customer + products are selected
- **Check:** Query orders for same customer in last 7 days with overlapping product IDs
- **UI:** Yellow warning banner: "Farm Alpha has an order from 3 days ago with the same products. Continue anyway?"
- **Override:** User clicks "Continue" to dismiss

#### 4b. Credit Limit Soft-Block
- **Where:** NewOrder and NewInvoice, before save
- **Check:** Sum of customer's unpaid invoice balance_cents + new total vs. credit_limit_cents
- **UI:** Orange warning: "This will put Farm Alpha $1,200 over their $50,000 credit limit."
- **Override:** Admin can proceed; non-admin gets a harder warning
- **DB change:** Add `credit_limit_cents bigint` column to `customers` table (nullable, null = no limit)
- **Settings:** Credit limits set per-customer on CustomerDetail Info tab

#### 4c. Zero-Quantity Block
- **Where:** Order items, delivery items, invoice items — any line item form
- **Check:** Frontend validation — quantity must be > 0
- **UI:** Red inline error on the quantity field: "Quantity must be greater than zero"
- **Override:** None — this is a hard block (zero-qty items are always a mistake)

#### 4d. Stale Quote Warning
- **Where:** Quote conversion (accept → create order)
- **Check:** If quote created_at is more than 30 days ago
- **UI:** Yellow warning: "This quote is 45 days old. Product prices may have changed since it was created."
- **Override:** User clicks "Convert Anyway"

#### 4e. Overloaded Driver Warning
- **Where:** Delivery creation/edit, when assigning a driver
- **Check:** Count deliveries assigned to that driver on the same scheduled_date
- **UI:** Orange warning: "Jake already has 6 deliveries scheduled for Apr 5."
- **Override:** User can proceed (sometimes drivers handle many deliveries)

### Database Changes
- 1 migration: Add `credit_limit_cents bigint DEFAULT NULL` to `customers` table
- Update Customer TypeScript interface

### New Hook
- `src/hooks/useGuardrails.ts` — shared hook that runs guardrail checks and returns warnings

---

## Feature 5: Global Command Palette (Ctrl+K)

**Problem:** Finding a specific customer, order, or invoice requires navigating through the sidebar to the right list page, then searching within that page.

**Solution:** Press Ctrl+K from anywhere to instantly search across all entity types.

### Design

- **New component:** `src/components/ui/CommandPalette.tsx`
- **Trigger:** `Ctrl+K` (or `Cmd+K` on Mac) — global keydown listener in AppLayout.tsx
- **Visual:** Centered modal overlay with:
  - Search input at top (auto-focused)
  - Results grouped by category with icons
  - Keyboard navigation (arrow keys + Enter to select, Escape to close)

- **Search Categories:**
  1. **Recent** (from localStorage, last 10 pages visited) — shown when input is empty
  2. **Pages** — fuzzy match against all navigation items (client-side, instant)
  3. **Customers** — search by farm_name ILIKE
  4. **Orders** — search by order_number ILIKE
  5. **Invoices** — search by invoice_number ILIKE
  6. **Deliveries** — search by delivery_number ILIKE
  7. **Products** — search by name ILIKE

- **Result format per item:**
  - Icon (entity type icon from lucide)
  - Entity type badge (small colored pill)
  - Primary text (name/number)
  - Subtitle (customer name for orders/deliveries/invoices, or category for products)

- **Performance:**
  - Debounced search (300ms after typing stops)
  - Max 5 results per category, 25 total
  - Pages category is instant (client-side fuzzy match)
  - Entity search via new RPC

- **Recent items tracking:**
  - AppLayout records each page visit to localStorage
  - Format: `{ path, title, icon, timestamp }`
  - Capped at 20 items, FIFO

### Database Changes
- 1 migration: `global_search(p_query text, p_limit int DEFAULT 5)` RPC
  - Searches customers, orders, invoices, deliveries, products with ILIKE
  - Returns unified result set: `{ entity_type, id, primary_text, secondary_text }`

---

## Implementation Order

Build in this order (each feature is independently shippable):

1. **Command Palette** — immediate productivity boost, no dependencies
2. **Transaction Thread** — purely frontend, no migrations
3. **Workflow Guardrails** — 1 small migration (credit_limit_cents), mostly frontend
4. **Customer 360** — 1 RPC migration, moderate frontend work
5. **Action Queue** — most complex RPC, replaces existing dashboard section

---

## Migration Summary

| # | Migration | Purpose |
|---|-----------|---------|
| 1 | `global_search` RPC | Command Palette entity search |
| 2 | `credit_limit_cents` on customers | Credit limit guardrail |
| 3 | `get_customer_summary` RPC | Customer 360 summary bar |
| 4 | `get_dashboard_action_items` RPC | Action Queue specific items |

## New Components

| Component | Location |
|-----------|----------|
| `TransactionThread.tsx` | `src/components/ui/` |
| `CommandPalette.tsx` | `src/components/ui/` |
| `CustomerSummaryBar.tsx` | `src/components/customers/` |
| `ActionQueue.tsx` | `src/components/dashboard/` |
| `useGuardrails.ts` | `src/hooks/` |

## Pages Modified

| Page | Changes |
|------|---------|
| `AppLayout.tsx` | Ctrl+K listener, recent page tracking |
| `QuoteDetail.tsx` | Add TransactionThread |
| `OrderDetail.tsx` | Add TransactionThread |
| `DeliveryDetail.tsx` | Add TransactionThread |
| `InvoiceDetail.tsx` | Add TransactionThread |
| `CustomerDetail.tsx` | Add SummaryBar, Timeline tab, quick actions |
| `Dashboard.tsx` | Replace Operational Alerts with ActionQueue |
| `NewOrder.tsx` | Duplicate order + credit limit guardrails |
| `NewInvoice.tsx` | Credit limit guardrail |
| `DeliveryForm` pages | Overloaded driver guardrail |
| `QuoteDetail.tsx` | Stale quote guardrail on conversion |
| Various item forms | Zero-quantity validation |
