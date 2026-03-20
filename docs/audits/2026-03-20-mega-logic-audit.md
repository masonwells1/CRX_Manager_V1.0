# Mega Logic Audit Report — CRX_Manager_V1.0

**Date:** March 20, 2026
**Type:** Read-only logic audit (no code changes)
**Method:** 8 parallel agents, each auditing a focused domain
**Total Issues Found:** 105+

---

## Executive Summary

| Severity | Count | Description |
|----------|-------|-------------|
| **Critical** | 9 | Data corruption, double-counting, wrong calculations actively breaking production |
| **High** | 33 | Significant logic gaps enabling data integrity violations |
| **Medium** | 42 | Reporting inaccuracies, missing guards, operational issues |
| **Low** | 21+ | Cosmetic, maintenance hazards, edge cases |

### Top 10 Most Dangerous Issues

| # | Domain | Issue | Why It's Dangerous |
|---|--------|-------|--------------------|
| 1 | Inventory | Planned quote holds never released on conversion to order | Double-reservation: same inventory held + prebooked. Every planned program customer affected |
| 2 | Financial | AR Aging + Dashboard exclude overdue invoices | Once `mark_overdue_invoices` runs, overdue AR vanishes from all reports. Total AR appears artificially low |
| 3 | Financial | `get_customer_transaction_review()` references wrong column (`amount_cents` vs `applied_amount_cents`) | Page crashes for any customer with prepay applications |
| 4 | Cross-Domain | `allocate_payment()` uses July season cutoff instead of October | Payments Jul-Sep assigned to wrong season. Corrupts financial reports |
| 5 | Cross-Domain | `apply_prepay_to_invoice()` doesn't update `customers.prepay_balance_cents` | Customer prepay balance drifts higher than reality after every application |
| 6 | Quotes | Active `save_quote()` silently drops `is_planned`, `section_header_notes`, `needed_by_date` | Planned programs stop working. Data loss on every quote save |
| 7 | Orders | `void_delivery()` references wrong column (`quantity` vs `total_units_needed`) | Order status incorrectly resets after voiding delivery on standard orders |
| 8 | Orders | `void_delivery()` uses wrong idempotency columns (`key`/`result_id`) | Idempotency broken — double-void possible or RPC crashes |
| 9 | Inventory | CHECK constraint `qty_available >= 0` blocks `complete_delivery()` negative-inventory design | Deliveries that exceed stock will fail even though code was designed to allow it |

---

## DOMAIN 1: Inventory Position Integrity

### Critical

**INV-1: Planned quote holds never released on order conversion**
- Location: `convert_quote_to_order()` in migration `20260325100000` and `20260320100000`
- When a planned quote converts to an order, the function prebooks inventory (`quantity_prebooked += qty`) but NEVER deactivates the existing `inventory_holds`. Both hold and prebook are active simultaneously = double reservation.
- Impact: Net Free shows significantly lower than reality for all planned program products. Sales reps see false out-of-stock.

### High

**INV-2: Reconciliation missing 5 of 11 transaction types**
- Location: `src/lib/reconciliation.ts` lines 134-195
- The `checkInventoryLedger` function only handles 6 types (received, booked, delivered, returned, adjusted, transferred). Missing: job_applied, cancelled_delivery_reversal, void_delivery_reversal, prebooked, released. The `default` case assigns `delta = 0`, silently ignoring them.
- Impact: Reconciliation report produces false positives, making it unreliable.

**INV-3: Reconciliation treats 'booked' as negative when it doesn't affect quantity_available**
- Location: `src/lib/reconciliation.ts` lines 148-168
- 'Booked' transactions change `quantity_prebooked`, NOT `quantity_available`. But reconciliation subtracts them from the running balance, causing systematic under-count for every ordered product.
- Impact: Inventory ledger reconciliation is fundamentally broken for any product with orders.

**INV-4: CHECK constraint blocks the "allow negative inventory" design**
- Location: Migration `20260209200000` (CHECK constraint) vs `20260319200000` (complete_delivery allows negative)
- `complete_delivery()` was redesigned to allow negative `quantity_available` with admin notifications. But the `chk_inventory_qty_available CHECK (quantity_available >= 0)` constraint from an earlier migration was never dropped.
- Impact: Deliveries exceeding stock WILL fail with a constraint violation, contradicting the business decision.

### Medium

**INV-5: Transaction Ledger Modal running balance wrong**
- Location: `src/components/inventory/TransactionLedgerModal.tsx` lines 56-74
- Same issue as INV-3 but in the UI. 'Booked' and 'prebooked' are treated as negatives, 'released' as positive — but none of these affect `quantity_available`. Running balance shown to users won't match the actual inventory position.

**INV-6: Asymmetric hold lifecycle inflates inventory on cancel**
- Location: `create_planned_holds()` and `cancel_order()` in multiple migrations
- Creating holds does NOT reduce `quantity_available`, but `cancel_order()` DOES restore it when releasing holds. Each cancelled planned-quote order permanently inflates `quantity_available`.

**INV-7: Quote revision doesn't update inventory holds**
- Location: `save_quote()` and `create_planned_holds()` — holds are not automatically updated when a planned quote is revised. Old holds persist with stale quantities.

**INV-8: adjust_inventory() has no floor check**
- Location: `adjust_inventory()` in migration `20260211100000`
- A negative delta can attempt to set `quantity_available` below zero with no validation. Depends on CHECK constraint (which may or may not be active per INV-4).

**INV-9: Net Free formula inconsistency (frontend vs tooltip vs docs)**
- Location: `InventoryPage.tsx` lines 243-249
- Code includes `on_order` in Net Position. Tooltip says "Available - Prebooked - Planned Holds" (no on_order). CLAUDE.md says same. Three different definitions.

**INV-10: complete_job() blocks on insufficient inventory unlike complete_delivery()**
- Location: `complete_job()` in migration `20260325100000`
- Jobs are physical work already done (chemicals applied in field), but the function refuses to complete if inventory is insufficient. Inconsistent with `complete_delivery()` which was changed to allow this.

### Low

**INV-11:** Cycle count doesn't check if prebooked > new counted quantity (impossible state possible)
**INV-12:** Returns restocking doesn't re-increment prebooked for partially fulfilled orders
**INV-13:** All RPCs hard-code 'Main Warehouse' — multi-location is structurally unsupported

---

## DOMAIN 2: Financial Ledger & Invoices

### Critical

**FIN-1: AR Aging and Dashboard exclude overdue invoices**
- Location: `get_ar_aging()` and `financial_dashboard_summary()` filter `WHERE status = 'posted'`
- Once `mark_overdue_invoices()` transitions invoices to `overdue`, they vanish from all AR reporting.
- Impact: Total AR appears artificially low. Delinquent accounts invisible.

**FIN-2: Customer Transaction Review crashes on prepay applications**
- Location: `get_customer_transaction_review()` in migration `20260228320000` line 93
- References `pa.amount_cents` but actual column is `applied_amount_cents`.
- Impact: Runtime error for any customer with prepay applications.

### High

**FIN-3: allocate_payment() doesn't call check_period_open()**
- Location: Latest `allocate_payment()` in migration `20260316200001`
- Payments can be allocated to invoices in closed accounting periods. The fix from `20260311000001` was lost during a rewrite.
- Impact: Defeats month-end close.

**FIN-4: create_invoice_from_order() duplicates items on second call**
- Location: Migration `20260311200000` lines 1104-1125
- No filter for already-invoiced order items. Second invoice copies ALL items including those on the first invoice.
- Impact: Inflated AR, duplicate billing.

**FIN-5: Month-End Close shows commissions at 1/100th actual value**
- Location: `get_monthly_summary()` returns commission_amount (dollars) as `earned_cents`, frontend divides by 100
- $500 commission displays as $5.00.

**FIN-6: void_invoice() doesn't cancel linked commissions**
- Commissions remain payable even after invoice void.

**FIN-7: AR aging bucket boundaries inconsistent between dashboard and AR page**
- Dashboard: <=30, 31-60, 61-90, >90. AR page: 0-29, 30-59, 60-89, 90-119, 120+. Same invoice can appear in different buckets.

### Medium

**FIN-8:** Customer Transaction Review excludes voided invoices (running balance wrong)
**FIN-9:** Customer Transaction Review has no opening balance (starts from zero)
**FIN-10:** Finance charges use monthly flat rate, not daily accrual
**FIN-11:** Commission dollar convention has no code comments (maintenance trap)
**FIN-12:** Dashboard revenue includes cancelled/deleted orders (no status/deleted_at filter)
**FIN-13:** Dashboard AR calculation missing `deleted_at IS NULL` filter, masks overpayments

### Low

**FIN-14:** TypeScript types still include dropped `total_paid`/`balance_due` columns
**FIN-15:** Finance charge invoices in `unposted` status block period close

---

## DOMAIN 3: Order Lifecycle

### Critical

**ORD-1: void_delivery() references wrong column name**
- Location: Migration `20260332000000` lines 120-123
- Uses `quantity_remaining < quantity` but standard orders use `total_units_needed`, not `quantity`. May incorrectly reset order status to `confirmed` after void.

**ORD-2: void_delivery() uses wrong idempotency column names**
- Location: Same migration, lines 57-62 and 180-182
- Uses `key` and `result_id` instead of `idempotency_key` and `result`. Crashes or bypasses idempotency.

### High

**ORD-3: update_order_items() doesn't recalculate cost/profit/margin on orders**
- Only `total_price` is recalculated after editing items. `total_cost`, `total_profit`, `total_margin_pct` remain stale.

**ORD-4: Same-product edit path skips item-level profit/margin recalculation**
- Product-swap path correctly recalculates, but same-product quantity/price changes don't.

**ORD-5: NewDelivery.tsx has no idempotency protection**
- Uses direct `.insert()` instead of RPC. Only UI-level `saving` flag prevents double-submit.

**ORD-6: create_quick_delivery() commission schema inconsistency**
- Inserts `recipient_id` (uuid) while other RPCs insert `recipient` (text). Commission reports may miss quick-delivery commissions.

**ORD-7: Order shares sum validation allows < 100%, amounts not recalculated on edit**
- Shares can total 90%. `amount_cents` becomes stale when order total changes.

**ORD-8: create_invoice_from_order() ignores order_shares entirely**
- Always creates single full-amount invoice for primary customer regardless of split-bill configuration.

**ORD-9: update_order_items RPC allows nonexistent 'pending' status**
- Dead code branch, but allows editing if order somehow reaches 'pending' state.

### Medium

**ORD-10:** UI item deletion not synced with RPC guard — items disappear from UI but persist in DB
**ORD-11:** cancel_order() doesn't block cancellation of voided orders (double-release possible)
**ORD-12:** complete_delivery() no FOR UPDATE lock on orders row during fulfillment status check
**ORD-13:** Duplicate order check warns on any same-customer order within 7 days regardless of content
**ORD-14:** Frontend rounds intermediate values, RPC doesn't — potential 1-cent discrepancies
**ORD-15:** Commissions never recalculated after order edits (stale profit values)
**ORD-16:** "Schedule Delivery" and "Create Invoice" buttons visible for voided orders

### Low

**ORD-17:** No CHECK constraint preventing quantity_delivered > total_units_needed
**ORD-18:** create_invoice_from_order() has no order status guard (allows invoicing cancelled/voided orders)

---

## DOMAIN 4: Quote Builder & Pricing Engine

### Critical

**QTE-1: Active save_quote() dropped is_planned, section_header_notes, needed_by_date**
- Location: Migration `20260333200000` regressed the planned programs feature
- The latest rewrite silently drops these fields on every save. Planned programs stop working. Data loss.

### High

**QTE-2: Price overrides silently reverted by server recalculation**
- Frontend supports `price_override` but `save_quote()` always overwrites with tier price.
- Custom negotiated pricing is lost on every save.

**QTE-3: convert_quote_to_order() loses oz_per_acre, price_per_acre, calc_mode, price_unit**
- These fields exist on quote_items but have no columns in order_items. Pricing context lost.

**QTE-4: save_quote_template() uses wrong idempotency columns — crashes with key**
- `key` instead of `idempotency_key`, `entity_type/entity_id` instead of `operation/result`

**QTE-5: create_quote_from_template() same idempotency column bug**

**QTE-6: rollover_quote_to_season() same idempotency column bug**

**QTE-7: create_planned_holds() same idempotency column bug + doesn't deduct quantity_available**
- Holds created but inventory not reduced. Release trigger then ADDS to available = inflation.

### Medium

**QTE-8:** units_direct + acres=0: frontend preserves stale values, server zeros them
**QTE-9:** Rounding path divergence in quote-level totalProfit (few cents drift)
**QTE-10:** duplicate_quote() missing is_planned, calc_mode, price_unit, section_header_notes
**QTE-11:** restore_quote_version() doesn't restore tier, is_planned, commission_split, valid_days
**QTE-12:** Inventory holds not recalculated after version restoration
**QTE-13:** Seasonal rollover copies is_planned=true but creates no holds
**QTE-14:** Rolled-over items missing all calculated fields (totals, quantities = 0)

### Low

**QTE-15:** getTierPrice JS `||` treats tier2_price=0 as missing (falls back to tier1). Server COALESCE does not. Client-server parity bug for $0 tier prices.
**QTE-16:** create_quote_from_template() doesn't check if products still exist/active

---

## DOMAIN 5: Delivery Workflow

### Critical

**DEL-1: cancel_delivery() idempotency check without save — deduplication broken**
- Checks for cached result but never saves one. Double-cancel possible.

### High

**DEL-2: create_followup_delivery() idempotency parameter accepted but never used**
- Frontend sends key, function ignores it. Duplicate follow-ups possible.

**DEL-3: No server-side delivery item quantity validation**
- Location: `NewDelivery.tsx` uses direct `.insert()`. Only UI-level cap on quantity. API bypass can exceed order remaining.

**DEL-4: void/cancel delivery affects ALL order invoices, not just that delivery's**
- `WHERE order_id = v_delivery.order_id AND status = 'draft'` — too broad. Cancelling one delivery destroys sibling delivery invoices.

**DEL-5: No delivery-level inventory commitment between confirm and complete**
- After confirm (in_progress), inventory is back in `quantity_available` with no delivery-specific lock. Another delivery or adjustment can consume it.

### Medium

**DEL-6:** batch_cancel_deliveries() no exception handling — one failure rolls back entire batch
**DEL-7:** batch_reschedule_deliveries() audit trail only references first delivery
**DEL-8:** create_followup_delivery() no prebook validation for follow-up items
**DEL-9:** NewDelivery.tsx non-atomic multi-step creation (orphaned deliveries possible)
**DEL-10:** complete_delivery() invoice adjustment matches by product_id not order_item_id (duplicate product = wrong invoice line)
**DEL-11:** void_delivery() orphans follow-up deliveries, deletes remainder linkage without cascading cancel

### Low

**DEL-12:** complete_delivery() missing explicit in_progress check (relies on trigger message)
**DEL-13:** Tote tracking is informational only (no lifecycle management)
**DEL-14:** Empty string accepted for p_signed_by in complete_delivery()

---

## DOMAIN 6: Cross-Domain Consistency

### Critical

**XD-1: allocate_payment() uses July season cutoff instead of October**
- Location: Latest `allocate_payment()` uses `>= 7` instead of `>= 10`
- Payments Jul-Sep assigned to wrong season. Corrupts financial reports and prepay credit attribution.

**XD-2: apply_prepay_to_invoice() doesn't update customers.prepay_balance_cents**
- Credit balance decreases on the credit record but customer-level cached balance stays inflated.
- Drift accumulates with every prepay application until manual reconciliation.

### High

**XD-3: generate_finance_charges() uses calendar year, not compute_season()**
- Finance charges Oct-Dec assigned to wrong season (off by 1).

**XD-4: Orders TypeScript type still declares dropped columns (balance_due, total_paid)**
- Runtime returns undefined but type says number. Maintenance trap.

**XD-5: Multiple pages don't filter deleted_at IS NULL on orders**
- Orders.tsx, Reports.tsx, CustomerDetail.tsx include soft-deleted orders in lists and calculations.

**XD-6: allocate_payment() has no financial_audit_log entry**
- The most important financial operation has no audit trail in the financial log.

**XD-7: Orders.tsx bulk delete is HARD DELETE with no audit trail**
- Permanently removes orders, cascades to order_items. No logActivity() call. Irrecoverable.

### Medium

**XD-8:** invoice_items.cost_cents stores per-unit cost, not extended cost (margin calculations wrong)
**XD-9:** Quotes.tsx doesn't filter deleted_at IS NULL
**XD-10:** complete_delivery() has no financial_audit_log entry (even when adjusting invoices)
**XD-11:** Commissions calculated on full order profit, never adjusted for partial fulfillment
**XD-12:** orders.total_price is numeric(dollars), invoices.total_amount_cents is bigint(cents) — mixed naming
**XD-13:** Reports include cancelled/deleted orders in profitability calculations
**XD-14:** Multiple pages perform mutations without logActivity()
**XD-15:** Cross-season quote conversion allowed with no warning or price recalculation

### Low

**XD-16:** order_items.quantity_remaining manually maintained, not a GENERATED column
**XD-17:** RLS policies don't include deleted_at IS NULL
**XD-18:** No inventory position vs ledger reconciliation function exists

---

## DOMAIN 7: Frontend Display & Calculations

### High

**FE-1: Returns CSV exports raw cents without conversion**
- `total_credit_cents` passed to CSV with no division. $15.00 exports as 150000.

**FE-2: Invoices CSV exports raw cents without conversion**
- `total_amount_cents` and `balance_cents` exported as raw integers.

### Medium

**FE-3:** Reports.tsx and SalesReports.tsx truncate dollars to 0 decimal places (maximumFractionDigits: 0)
**FE-4:** 12+ files use `Math.round(parseFloat*100)` instead of project's `parseDollarsToCents()` utility
**FE-5:** Stale data after mutation on some detail pages (optimistic local state vs server refetch)

### Low

**FE-6-9:** Various cosmetic CSV formatting issues (missing $ prefix, commission formatting, etc.)
**FE-10:** Division-by-zero possible at 100% margin in Products.tsx
**FE-11:** Status badge `replace('_', ' ')` only replaces first underscore

---

## DOMAIN 8: Secondary Workflows (AP, Returns, Jobs, POs)

### High

**SEC-1: receive_po_items() doesn't check for cancelled PO status**
- Can receive items against cancelled POs, resurrecting them and inflating inventory.

**SEC-2: receive_po_items() latest version dropped cost_per_unit tracking**
- Receiving no longer updates product costs. Margins drift from reality.

### Medium

**SEC-3:** AP aging uses bill_date instead of due_date (overstates overdue severity)
**SEC-4:** allocate_payment season calc uses July not October (duplicate of XD-1)
**SEC-5:** Returns: no server-side validation that return qty <= delivered qty (fraud risk)
**SEC-6:** receive_return() silently skips restocking when no inventory row exists
**SEC-7:** create_order_from_blend_ticket() missing tier price fallback (tier 2/3 get $0)
**SEC-8:** complete_job() incorrectly decrements quantity_prebooked (erodes other orders' reservations)
**SEC-9:** check_remainder_reminders() not scheduled in pg_cron (only runs on dashboard load)
**SEC-10:** check_remainder_reminders() uses potentially wrong customer_id for notification
**SEC-11:** Credit limit check is post-hoc warning only, never blocks order creation

### Low

**SEC-12:** record_vendor_payment() allows payment on voided bills
**SEC-13:** transfer_job_to_invoice() uses MAX+1 instead of sequence for invoice numbers
**SEC-14:** auto_expire_quotes() not scheduled in pg_cron (holds persist indefinitely)

---

## Systemic Patterns Identified

### Pattern 1: Idempotency Column Name Bugs (5+ RPCs affected)
Multiple RPCs reference `key` instead of `idempotency_key`, `entity_type/entity_id` instead of `operation/result`. Affected: void_delivery, save_quote_template, create_quote_from_template, rollover_quote_to_season, create_planned_holds. These either crash with key or silently bypass deduplication.

### Pattern 2: Season Calculation Wrong (3+ RPCs)
`allocate_payment()`, `generate_finance_charges()`, and older versions of `create_commission_payment()` use `>= 7` (July) or calendar year instead of `>= 10` (October) / `compute_season()`.

### Pattern 3: Soft Delete Not Filtered (5+ pages)
Orders.tsx, Quotes.tsx, Reports.tsx, CustomerDetail.tsx, and profitability calculations don't filter `deleted_at IS NULL`. RLS policies also don't enforce it.

### Pattern 4: Financial Audit Log Gaps
`allocate_payment()` and `complete_delivery()` — two of the most important operations — have no `financial_audit_log` entries.

### Pattern 5: Planned Programs Feature Regression
The active `save_quote()` dropped `is_planned`. Combined with holds never releasing on conversion (INV-1), the entire planned programs feature chain is broken: save drops the flag, conversion double-reserves, and holds never clean up.

---

## Recommended Fix Priority

### Phase 1: Critical Data Integrity (fix first)
1. INV-1 — Release holds on quote→order conversion
2. FIN-1 — Include `overdue` status in AR aging/dashboard queries
3. FIN-2 — Fix column name in customer transaction review
4. XD-1 — Fix season calculation in allocate_payment
5. XD-2 — Update customers.prepay_balance_cents in apply_prepay_to_invoice
6. QTE-1 — Restore is_planned/header_notes/needed_by_date in save_quote
7. ORD-1/ORD-2 — Fix void_delivery column refs and idempotency
8. INV-4 — Drop or reconcile the CHECK constraint vs negative inventory design
9. DEL-1 — Fix cancel_delivery idempotency save

### Phase 2: High Data Integrity
10. FIN-3 — Add check_period_open to allocate_payment
11. FIN-4 — Filter already-invoiced items in create_invoice_from_order
12. FIN-5 — Fix commission cents/dollars display on month-end close
13. QTE-2 — Respect price overrides in save_quote server recalc
14. All idempotency column fixes (QTE-4/5/6/7)
15. ORD-3/4 — Recalculate all order totals on item edit
16. DEL-4 — Scope invoice void/cancel to specific delivery, not entire order
17. XD-6/7 — Add financial audit log to allocate_payment, fix hard delete on orders

### Phase 3: Medium Fixes (batch by pattern)
- Soft delete filtering sweep (all pages + RLS)
- Season calculation sweep (all RPCs using compute_season)
- parseDollarsToCents consistency sweep
- CSV export formatting sweep
- Missing logActivity sweep
- Reconciliation function fixes (all 11 transaction types)
