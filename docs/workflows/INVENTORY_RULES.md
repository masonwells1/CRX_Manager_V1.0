# Inventory Rules

Complete reference for inventory management, calculations, and transaction handling.

---

## Core Tables

| Table | Purpose |
|-------|---------|
| `inventory` | Stock per product per location (quantity_available, quantity_prebooked, quantity_on_order, reorder_point, min_stock_level, manufactured_at_delivery) |
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

**Season runs October 1 to September 30.** All YTD calculations use this boundary, NOT calendar year.

Example: "Delivered YTD" means total delivered since October 1 of the current season.

---

## Inventory Calculation Formulas

### Net Position — the canonical "where do we stand?" number
```
Net Position = quantity_available - quantity_prebooked + on_order
```
**This is the only formula used for the user-visible "Net Position" number.** The InventoryPage column, the dashboard summary, the order-creation warnings (`create_direct_order`, `convert_quote_to_order`), and the field-app preview all read this same number from the same RPC: `get_inventory_position()` (Wave B.3, migration 20260507150000).

Holds and planned-quote demand are **not** subtracted from Net Position. They are reported in their own "Planned" column. Mixing them in confused users in the past (audit findings P4-1 + P4-2) — three different formulas on the same page meant a sales rep could read "12 free" from one column and be warned "would go negative" from another. One formula now, period.

### Today's free stock (used internally by the manual-hold warning)
```
Today's Free = quantity_available - quantity_prebooked - active holds
```
The manual-hold creation modal warns when `Today's Free - new hold qty < 0`. Net Position is the wrong number to use here because it adds `on_order` — but a hold competes against today's physical stock, not future PO arrivals. This formula is computed client-side in `InventoryPage.tsx` from fields that the RPC returns (`quantity_available`, `quantity_prebooked`, `holds_qty`).

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
  AND created_at >= season start date (October 1)
```

---

## Twelve Transaction Types

Every inventory change creates an `inventory_transactions` record. Here are all 12 types:

| Type | When used | Effect on quantity_available |
|------|-----------|------------------------------|
| `received` | PO items are received | + (increases stock) |
| `booked` | Inventory hold is created (quote planned) | No change to quantity_available (tracked via holds) |
| `delivered` | Delivery is completed | - (decreases stock) |
| `returned` | Customer return is received back | + (increases stock, if restocked) |
| `adjusted` | Manual inventory adjustment or cycle count variance | +/- (can go either direction) — **see caveat below** |
| `transferred` | Stock moved between warehouses | +/- (decrease at source, increase at destination) |
| `job_applied` | Product applied during a job or field application (incl. blend-ticket applications) | - (decreases stock) |
| `prebooked` | Order created, inventory reserved | No change to quantity_available (tracked via prebooked) |
| `released` | Order cancelled or fulfilled, prebooked inventory released | No change to quantity_available (tracked via prebooked) |
| `prebook_reconciliation` | Data-fix correction of `quantity_prebooked` only (added 2026-06-10) | **No change to quantity_available** (prebooked-only) |
| `cancelled_delivery_reversal` | Cancelled delivery restores inventory | + (increases stock) |
| `void_delivery_reversal` | Voided delivery restores inventory | + (increases stock) |

### Caveats for anyone recomputing stock from the ledger

- **Historical `adjusted` rows are not always available-affecting.** Before
  `prebook_reconciliation` existed, prebooked-only corrections were recorded as
  `adjusted` rows distinguishable only by their notes (e.g. "Prebooked
  reconciliation: cancel_delivery bug fix (migration 20260331900000)",
  "prebooked inventory ... was missing"). Exclude those rows when recomputing
  `quantity_available`, or the recompute will be wrong by exactly their amounts
  (this caused a false-positive HIGH in the 2026-06-10 audit). New
  prebooked-only corrections MUST use `prebook_reconciliation` instead.
- **Early-March 2026 seeds are unledgered.** A handful of products created
  around 2026-03-04 had `quantity_available` seeded with no `received` ledger
  rows; the ledger is not a complete derivation of stock for that era.
- **Warn-not-block is now UNIVERSAL (2026-07-06, owner decision §6.1 of the
  business-workflow review).** `complete_delivery` and `create_quick_delivery`
  no longer hard-block on insufficient stock (mig `20260706130000`): they
  proceed, allow negative stock, flag the ledger row (`requires_review = true`),
  and notify admins — matching the order-creation and job/blend-application
  paths, which already warned-and-flagged. History: the delivery hard block was
  restored 2026-04-30 after a deliberate 2026-03-19→04-30 no-block window, and
  retired again 2026-07-06 (real paper tickets must be enterable even when the
  count is wrong — the count is what's wrong, not reality).
- **Reversals may drive stock negative by design** (2026-06-10): 
  `reverse_receiving_record` / the `receiving_records` delete trigger subtract
  the full reversed quantity so the ledger always equals the applied change; a
  negative snapshot is surfaced for reconciliation rather than silently clamped.

### Critical rule: All inventory math happens in the database, NOT in React.

Inventory calculations are done in PostgreSQL RPCs and triggers. The React frontend only displays results — it never calculates stock levels itself.

The single source of truth for inventory math is the `get_inventory_position()` RPC (added in Wave B.3, migration 20260507150000). It returns one row per (product, location) for active products with `quantity_available`, `quantity_prebooked`, `quantity_on_order`, `holds_qty`, `planned_qty`, `delivered_ytd` (season-to-date), and the computed `net_position`. **Don't add a parallel inventory aggregation in another file; if you need numbers, call this RPC.**

Note: `get_inventory_forecast()` (Forecast tab) computes the same supply numbers (`current_available`, `prebooked`, `on_order`) using the same column definitions, so the two views are already consistent. A future cleanup could DRY the supply math by having `get_inventory_forecast` call `get_inventory_position` internally; today both functions just read the same source columns identically.

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

### Manual holds — server-side validated (P4-3, 2026-05-07)
The `/inventory` page's "Create Hold" flow goes through the `create_inventory_hold()` RPC, NOT a bare table insert. The RPC takes a `FOR UPDATE` lock on the Main Warehouse inventory row and recomputes today's free inside the transaction.

Local candidate `20260905210000` (NOT applied live yet) adds a per-key serialization layer in front of that body: the idempotency key is required, the caller must be an ACTIVE admin/sales_rep, and `check_idempotency_intent` locks the key and compares actor + request BEFORE the stock check, so a double-click or a retry racing the original replays the first hold instead of erroring. Today (pre-apply) the second racing call fails with `IDEMPOTENCY_CONCURRENT_REPLAY_RETRY` even though the hold exists.

Free-stock formula:

```
Today's free = quantity_available − quantity_prebooked − SUM(active hold quantities)
```

If `today's free − requested qty < 0`, the RPC `RAISE EXCEPTION 'INSUFFICIENT_HOLD_INVENTORY'` and the hold is NOT created. Admins can override by passing `p_force=true` with a non-blank `p_force_reason` — the override is recorded in `activity_feed` with a `WARNING:` description prefix. Sales reps cannot force.

This closes the concurrency window where two admins clicking "Create Hold" simultaneously could each pass the client-side warning and both succeed, leaving total holds in excess of available inventory.

### Important
- Holds do NOT deduct from `quantity_available` — they only affect Net Free / today's free calculations
- Multiple holds can exist for the same product
- The browser-side warning at hold-creation is now a UX preview only; the server is the authoritative gate

---

## Phantom inventory rows (P4-7, 2026-05-07)

`inventory.manufactured_at_delivery boolean NOT NULL DEFAULT false` flags rows that were created during a delivery completion when the product had no prior inventory record. Since `20260706130000` (warn-not-block, 2026-07-06), `complete_delivery` and `create_quick_delivery` DO auto-create a zero row on the NOT FOUND branch — with `manufactured_at_delivery = true` — so the shortage stays visible in the position math instead of a silent no-op UPDATE. Such rows surface on `/integrity-cleanup` as designed. The flag's original purposes remain:

1. A future driver-app or field-app path that legitimately needs to manufacture rows.
2. Detecting regressions to an older `complete_delivery` body that had an auto-create branch (the March 19 body in `20260319200000` used to do this).

When the flag is true, the row surfaces on `/integrity-cleanup` under the "Phantom inventory rows" section. The admin RPC `mark_inventory_row_verified(p_inventory_id, p_performed_by, p_idempotency_key)` clears the flag after physical-stock confirmation, logging to `activity_feed`.

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
- Source: `src/components/receiving/QuickReceivePanel.tsx`

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
- [ ] Remember: season is October 1 to September 30 for all YTD calculations
- [ ] Money remains exact whole cents: new storage uses bigint cents; legacy PostgreSQL
      numeric-dollar storage is approved only after exact numeric math, clean finite whole-cent
      values, and an active finite whole-cent CHECK are verified; dirty or unconstrained columns remain findings
