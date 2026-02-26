# Inventory Rules

Complete reference for inventory management, calculations, and transaction handling.

---

## Core Tables

| Table | Purpose |
|-------|---------|
| `inventory` | Stock per product per location (quantity_available, quantity_prebooked, quantity_on_order, reorder_point, min_stock_level) |
| `inventory_transactions` | Audit trail of every stock change (transaction_type, quantity, reference) |
| `inventory_holds` | Reserved inventory (quantity, hold_type, expires_at, is_active) |
| `purchase_orders` | Supplier POs (po_number, vendor, status, total_cost) |
| `purchase_order_items` | PO line items (quantity_ordered, quantity_received, unit_cost) |
| `receiving_records` | Per-event receiving details (condition, lot_number, notes, storage_location) |
| `warehouses` | Storage locations (warehouse_name, code, is_active, is_default) |
| `cycle_counts` | Count sessions (status, counted_by) |
| `cycle_count_items` | Individual count lines (expected_qty, counted_qty, variance) |

---

## Season Date

**Season runs July 1 to June 30.** All YTD calculations use this boundary, NOT calendar year.

Example: "Delivered YTD" means total delivered since July 1 of the current season.

---

## Inventory Calculation Formulas

### Net Free (what's actually available to sell)
```
Net Free = quantity_available - planned holds - quantity_prebooked
```

### On Order (incoming from suppliers)
```
On Order = SUM(quantity_ordered - quantity_received) from open POs
```
Only POs with status `submitted` or `partially_received` count.

### Low Stock Alert
```
Low Stock = quantity_available <= reorder_point
```
Products at or below their reorder point show a low-stock badge.

### Total on Floor
```
Total on Floor = quantity_available (what's physically in the warehouse)
```

### Delivered YTD (season-based)
```
Delivered YTD = SUM(quantity) from inventory_transactions
  WHERE transaction_type = 'delivered'
  AND created_at >= season start date (July 1)
```

---

## Six Transaction Types

Every inventory change creates an `inventory_transactions` record. Here are the 6 types:

| Type | When used | Effect on quantity_available |
|------|-----------|------------------------------|
| `received` | PO items are received | + (increases stock) |
| `booked` | Inventory hold is created (quote planned) | No change to quantity_available (tracked via holds) |
| `delivered` | Delivery is completed | - (decreases stock) |
| `returned` | Customer return is received back | + (increases stock, if restocked) |
| `adjusted` | Manual inventory adjustment or cycle count variance | +/- (can go either direction) |
| `transferred` | Stock moved between warehouses | +/- (decrease at source, increase at destination) |

### Critical rule: All inventory math happens in the database, NOT in React.

Inventory calculations are done in PostgreSQL RPCs and triggers. The React frontend only displays results — it never calculates stock levels itself.

---

## Inventory Holds

Holds reserve inventory for planned quotes without actually deducting stock.

### Fields
- `quantity` — how much is reserved
- `hold_type` — `manual` or `crop_program`
- `expires_at` — when the hold automatically releases (nullable)
- `is_active` — whether the hold is currently in effect

### How holds work
1. Quote is marked `is_planned = true`
2. System creates `inventory_holds` records for each quote item
3. Holds reduce "Net Free" inventory but NOT `quantity_available`
4. When quote is accepted and converted to order, holds are released
5. Expired holds (past `expires_at`) are no longer counted

### Important
- Holds do NOT deduct from `quantity_available` — they only affect Net Free calculations
- Multiple holds can exist for the same product
- Concurrent hold creation can exceed available inventory — this is a known edge case to test

---

## Purchase Order Lifecycle

### Status transitions
```
draft -> submitted -> partially_received -> fully_received -> cancelled
```

### Tables
- `purchase_orders` — PO header (po_number format: PO-YYYY-NNNN via `next_po_number()`)
- `purchase_order_items` — line items with quantity_ordered, quantity_received, unit_cost

### Source files
- `src/pages/PurchaseOrders.tsx` — PO list
- `src/pages/NewPurchaseOrder.tsx` — create PO
- `src/pages/PurchaseOrderDetail.tsx` — PO detail with receive modal (~823 lines)

### Receiving flow
1. Open a submitted PO
2. Click "Receive Items" to open the two-step receive modal
3. For each item: enter quantity received, condition, lot number, notes, storage location
4. Submit calls `receive_po_items()` RPC which:
   - Creates `receiving_records` entries (one per item received)
   - Updates `purchase_order_items.quantity_received`
   - Updates `inventory.quantity_available` (adds received quantity)
   - If unit cost differs from existing product cost, creates a `cost_history` record
   - Updates PO status to `partially_received` or `fully_received`

### Quick Receive (shortcut)
- 3-step wizard: select vendor + products -> auto-match to oldest open POs -> confirm
- Uses `match_quick_receive_items()` RPC to automatically allocate items to the right POs
- Source: `src/pages/QuickReceive.tsx`

### Key RPCs
- `receive_po_items()` — per-item condition/lot/notes/storage, creates receiving_records
- `get_receiving_log()` — paginated, filterable receiving history
- `get_receiving_summary()` — dashboard stats
- `match_quick_receive_items()` — auto-allocate for Quick Receive

---

## Cost History

When receiving items where the PO unit cost differs from the product's current cost:

1. A `cost_history` record is created with old/new costs and prices
2. The product's cost fields are updated to the new PO cost
3. This ensures the product catalog always reflects the most recent cost

### Table: `cost_history`
- `product_id`, `old_cost`, `new_cost`, `old_price`, `new_price`, `change_note`

---

## Cycle Counts

Physical inventory verification process.

### Flow
1. Create a cycle count for a warehouse
2. System populates `cycle_count_items` with expected quantities from `inventory`
3. User enters actual counted quantities
4. System calculates variance (counted - expected)
5. Complete the count via `complete_cycle_count()` RPC
6. Variances create `inventory_transactions` of type 'adjusted'

### Tables
- `cycle_counts` — count sessions (status: in_progress/completed/cancelled)
- `cycle_count_items` — per-product count lines (expected_qty, counted_qty, variance, variance_pct, resolved)

### Source: `src/pages/CycleCounts.tsx`

---

## Safety Checklist for Inventory Changes

- [ ] All stock math happens in PostgreSQL RPCs — never calculate in React
- [ ] Every stock change creates an `inventory_transactions` record
- [ ] Use `checkMutationResult()` after inventory writes
- [ ] Test with edge cases: zero stock, negative variance, concurrent holds
- [ ] Verify that receiving updates both PO items AND inventory levels
- [ ] Check cost_history creation when PO cost differs from product cost
- [ ] Remember: season is July 1 to June 30 for all YTD calculations
- [ ] All money values are bigint cents (store * 100, display / 100)
