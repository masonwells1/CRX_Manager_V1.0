# Wave 4 Consolidated Bug Audit (2026-03-12)

**Audited by:** 6 parallel agents — Financial, Inventory, Delivery/Orders, Security, Data Integrity, Frontend
**Scope:** Full codebase deep dive for bugs NOT found in Waves 1–3 (110 known bugs)
**Result:** ~92 NEW unique bugs after deduplication (some overlap between agents)

---

## Executive Summary

| Severity | Count | Description |
|----------|-------|-------------|
| CRITICAL | 10 | Data corruption, money errors, security bypasses |
| HIGH | 25 | Broken workflows, missing guards, wrong calculations |
| MEDIUM | 36 | Display errors, missing validations, dead code |
| LOW | 21 | Cosmetic, minor UX, documentation gaps |
| **TOTAL** | **92** | |

### Combined Totals (All Waves)

| | Wave 1 | Wave 2 | Wave 3 | Wave 4 | Combined |
|--|--------|--------|--------|--------|----------|
| Critical | 3 | 6 | — | 10 | **19** |
| High | 7 | 17 | — | 25 | **49** |
| Medium | 16 | 22 | — | 36 | **74** |
| Low | 18 | 20 | — | 21 | **59** |
| **TOTAL** | **45** | **65** | *(fixes)* | **92** | **202** |

---

## 🔴 CRITICAL (10 bugs — fix immediately)

### C1 | `void_payment` writes to GENERATED ALWAYS column
- **Source:** Financial agent (FIN-C1)
- **File:** `supabase/migrations/20260321300000_void_payment.sql:58`
- **Bug:** UPDATE directly sets `balance_cents` which is `GENERATED ALWAYS AS (total_amount_cents - paid_amount_cents - prepay_applied_cents - write_off_cents)`. Postgres either ignores the SET or errors. The formula also ignores prepay and write-off amounts.
- **Impact:** Invoice balances could be incorrect after voiding payments; potential Postgres error in strict mode.
- **Fix:** Remove `balance_cents = ...` from SET clause. Only update `paid_amount_cents` — let the generated column compute balance.

### C2 | `void_payment` RETURNING captures post-UPDATE value (always 0)
- **Source:** Financial agent (FIN-C2) + Data Integrity agent (W4-12)
- **File:** `supabase/migrations/20260321300000_void_payment.sql:81`
- **Bug:** `UPDATE prepay_credits SET balance_cents = 0 ... RETURNING balance_cents INTO v_prepay_reversed` — returns 0 (NEW value), not the original balance. The IF check `v_prepay_reversed > 0` is always false.
- **Impact:** Customer `prepay_balance_cents` is NEVER decremented when voiding overpayment credits. Prepay balances become permanently inflated.
- **Fix:** SELECT the old value before the UPDATE, then use it in the decrement.

### C3 | `order_shares.amount_cents` stored as dollars (100x error)
- **Source:** Financial agent (FIN-C3)
- **File:** `src/pages/OrderDetail.tsx:334`
- **Bug:** `Math.round((order.total_price * 100 * pct) / 100)` — multiplies to cents then divides back to dollars. Stores dollars in a column named `amount_cents`.
- **Impact:** All bill-splitting downstream reads are off by 100x. A $10,000 order with 50% split stores `50` instead of `500000`.
- **Fix:** `Math.round(order.total_price * 100 * (pct / 100))` — convert to cents, then apply percentage.

### C4 | `complete_delivery` inventory pre-check adds instead of subtracts
- **Source:** Delivery agent (W4-008)
- **File:** `complete_delivery` RPC
- **Bug:** Pre-check uses `quantity_available + quantity_prebooked` to verify sufficient stock. Should be `quantity_available - quantity_prebooked` (Net Free). Adding prebooked inflates available count.
- **Impact:** Deliveries complete even when true free inventory is insufficient, creating negative available inventory.
- **Fix:** Change `+` to `-` in the availability check.

### C5 | Bulk delete receiving records doesn't reverse inventory
- **Source:** Inventory agent (#15) + Data Integrity agent (W4-10)
- **File:** `src/pages/ReceivingLog.tsx` (bulk delete handler)
- **Bug:** Individual delete calls `reverse_receiving_record()` which decrements `quantity_available`. Bulk delete uses direct `.delete()` — no inventory reversal, no PO status update, no cost recalculation.
- **Impact:** Deleting received inventory in bulk leaves phantom stock in the system. PO stays "fully_received" with no matching receiving records.
- **Fix:** Bulk delete must loop through `reverse_receiving_record()` for each item, or create a `batch_reverse_receiving` RPC.

### C6 | Application records from blend tickets never deduct inventory
- **Source:** Inventory agent (#10)
- **File:** Blend ticket → application record flow
- **Bug:** When a blend ticket creates an application record, the inventory deduction step is missing. Products used in the blend are recorded but never subtracted from `quantity_available`.
- **Impact:** Inventory counts are overstated by the amount of product used in blending. Over time this creates significant phantom stock.
- **Fix:** Add inventory deduction logic to the blend ticket completion/application record creation flow.

### C7 | `void_payment` has no role check (any user can void)
- **Source:** Security agent (S1)
- **File:** `void_payment` RPC
- **Bug:** SECURITY DEFINER function with no internal role check. Wave 2 fix (ROLE-2) may not have been applied or was applied to a different overload.
- **Impact:** Any authenticated user (including drivers) can reverse payment allocations, inflating invoice balances.
- **Fix:** Add `IF role != 'admin' THEN RAISE EXCEPTION` at function start.

### C8 | `edit_prepay_credit` has no role check
- **Source:** Security agent (S2)
- **File:** `edit_prepay_credit` RPC
- **Bug:** SECURITY DEFINER with no role check. Any authenticated user can modify prepay credit amounts.
- **Impact:** A driver or sales rep could inflate a customer's prepay balance.
- **Fix:** Add admin-only role check.

### C9 | `delete_prepay_credit` has no role check
- **Source:** Security agent (S3)
- **File:** `delete_prepay_credit` RPC
- **Bug:** SECURITY DEFINER with no role check. Any authenticated user can delete prepay credits.
- **Impact:** Any user can wipe customer prepay balances, losing money records.
- **Fix:** Add admin-only role check.

### C10 | `batch_void_invoices` has no role check
- **Source:** Security agent (S4)
- **File:** `batch_void_invoices` RPC
- **Bug:** SECURITY DEFINER with no role check. Any authenticated user can void invoices in bulk.
- **Impact:** Catastrophic — a non-admin could void all posted invoices, zeroing out AR.
- **Fix:** Add admin-only role check.

---

## 🟠 HIGH (25 bugs — fix before production use)

### Financial (7)

**H1 | `record_invoice_payment` missing `check_period_open()`** (FIN-H1)
File: `record_invoice_payment` RPC. Payments can be recorded in closed accounting periods, breaking reconciliation.

**H2 | `void_payment` missing `check_period_open()`** (FIN-H2)
File: `void_payment` RPC. Same as H1 — voids can alter closed-period balances.

**H3 | `record_invoice_payment` sets phantom status `'paid'`** (FIN-H3)
File: `record_invoice_payment` RPC:71. CHECK constraint doesn't include `'paid'` — UPDATE fails when payment fully pays an invoice. Payment records but status doesn't update.

**H4 | `record_invoice_payment` idempotency key silently ignored** (FIN-H4)
File: `InvoiceDetail.tsx:411-426`. Frontend sends `p_idempotency_key` but RPC signature doesn't accept it. PostgREST discards the extra arg. No double-click protection.

**H5 | InvoiceDetail falsy `||` guard on zero-cent values** (FIN-H5)
File: `InvoiceDetail.tsx:499,503`. `invoice.total_amount_cents || fallback` treats $0.00 as missing. Use `??` instead.

**H6 | Reconciliation Check 3 queries wrong table** (FIN-H6)
File: `src/lib/reconciliation.ts:660`. Queries `payment_allocations` but current RPC writes to `payments` table. All payments show as "not found" in reconciliation.

**H7 | InvoiceDetail cost accumulation missing `Math.round()`** (FIN-H7)
File: `InvoiceDetail.tsx:500`. Fractional quantities produce floating-point cents. Also has falsy `||` guard. Margin calculation on PDFs could be wrong.

### Inventory (5)

**H8 | No optimistic locking on inventory updates**
Any `.update()` on products table has no `updated_at` check. Concurrent edits silently overwrite each other. Two users adjusting the same product's stock at the same time — last write wins.

**H9 | Soft-deleted products still appear in inventory queries**
Queries missing `.is('deleted_at', null)` filter. Soft-deleted products inflate inventory counts and appear in dropdowns.

**H10 | Receiving record quantity validation missing**
No check that received quantity ≤ ordered quantity per PO line item. Users can receive 1000 units against a PO for 10.

**H11 | Inventory transfer between locations has no atomic lock**
Transfer reads source, checks quantity, then updates — not using `FOR UPDATE`. Concurrent transfers can overdraw source location.

**H12 | Manual inventory adjustment has no audit trail**
`manual_inventory_add` writes to products table but doesn't log to `inventory_transactions` or any audit table. Adjustments are invisible in history.

### Delivery/Orders (4)

**H13 | Cancel order doesn't release inventory holds**
File: `cancel_order` RPC. When an order is cancelled, associated inventory holds (from prebooked quantities) are not released. Stock stays locked.

**H14 | Quick delivery doesn't validate customer credit limit**
File: `create_quick_delivery` RPC. Creates order + delivery + invoice without checking if customer has exceeded their credit limit.

**H15 | Delivery reassign doesn't update driver assignment on related records**
When a delivery is reassigned to a new driver, the `deliveries.driver_id` updates but related records (delivery notes, photos) still reference the old driver.

**H16 | Partial fulfillment percentage calculated from item count, not value**
File: `Orders.tsx`. Fulfillment percentage counts items delivered vs items ordered. Should be value-based (cents delivered / cents ordered) for accurate representation.

### Security (4)

**H17 | `create_commission_payment` no role check**
SECURITY DEFINER without role check. Any user can mark commissions as paid.

**H18 | `batch_adjust_inventory` no role check**
SECURITY DEFINER without role check. Any user can adjust inventory quantities in bulk.

**H19 | `create_prepay_credit` no role check**
SECURITY DEFINER without role check. Any user can create prepay credits.

**H20 | Multiple RPCs missing `SET search_path`**
Several SECURITY DEFINER functions beyond those fixed in Wave 2/3 still lack `SET search_path = public, extensions`. Vulnerable to search_path injection.

### Data Integrity (3)

**H21 | Delete customer with open invoices allowed**
No FK constraint or trigger prevents deleting (soft or hard) a customer who has open (posted) invoices. Orphans AR records.

**H22 | Delete product with open PO lines allowed**
Same pattern — product deletion doesn't check for open PO line items referencing it.

**H23 | Commission records orphaned when order is cancelled**
Order cancellation sets order status to `cancelled` but leaves commission records in `pending` status. These show up in month-end commission reports.

### Frontend (2)

**H24 | Dashboard financial summary uses stale cached data**
Dashboard caches financial summary on first load. Navigating away and back doesn't refresh. Users see outdated AR/AP totals.

**H25 | Bulk operations don't show progress indicator**
Bulk post invoices, bulk void, bulk PO cancel — all fire and wait with no progress. On large batches, users think the UI is frozen and click again.

---

## 🟡 MEDIUM (36 bugs)

### Financial (6)
| ID | Description |
|----|-------------|
| M1 | MonthEndClose "Payments reconciled" check trivially satisfied — any non-zero payment marks as done (FIN-M1) |
| M2 | MonthEndClose "Commissions reviewed" check trivially satisfied — paying 1 of 100 marks done (FIN-M2) |
| M3 | PrepaymentManager float rounding in split validation — individual rounding != total rounding (FIN-M3) |
| M4 | InvoiceDetail references phantom status `'overdue'` in void eligibility check — dead code (FIN-M4) |
| M5 | PrepayWorkspace queries non-existent column `total_cents` — should be `total_amount_cents` (FIN-M5) |
| M6 | PrepaymentManager non-atomic two-step write — insert credit + increment balance not in transaction (FIN-M6) |

### Inventory (6)
| ID | Description |
|----|-------------|
| M7 | Product cost recalculation on receiving uses simple average instead of weighted average |
| M8 | Low stock alerts don't account for incoming PO quantities |
| M9 | Inventory count page doesn't lock records during physical count |
| M10 | Reorder point can be set to 0 without warning — effectively disables low stock alerts |
| M11 | Bulk import doesn't validate product SKU uniqueness before insert |
| M12 | Transfer history page doesn't show reversed/voided transfers |

### Delivery/Orders (6)
| ID | Description |
|----|-------------|
| M13 | Order total doesn't recalculate when items are removed |
| M14 | Delivery manifest PDF shows items in insertion order, not sorted by product name |
| M15 | Cancelled deliveries still count toward route planning metrics |
| M16 | Quick delivery allows $0 total orders (no minimum validation) |
| M17 | Order search doesn't index customer name — slow for large datasets |
| M18 | Delivery complete timestamp uses browser time, not server time |

### Security (5)
| ID | Description |
|----|-------------|
| M19 | Session tokens not invalidated on password change |
| M20 | Role change doesn't force re-authentication |
| M21 | API rate limiting not configured for financial RPCs |
| M22 | Audit log entries don't capture IP address or user agent |
| M23 | Soft-deleted users' sessions not terminated |

### Data Integrity (6)
| ID | Description |
|----|-------------|
| M24 | Invoice number sequence has no advisory lock — concurrent creates can duplicate |
| M25 | Customer prepay balance can go negative (no CHECK constraint) |
| M26 | Order items allow negative quantities (no CHECK constraint) |
| M27 | Delivery photos not cleaned up when delivery is deleted |
| M28 | Team note comments not cascade-deleted when note is deleted |
| M29 | Activity log entries reference deleted entities — broken links in UI |

### Frontend (7)
| ID | Description |
|----|-------------|
| M30 | Date inputs don't respect season boundaries (Oct 1 – Sep 30) for YTD filters |
| M31 | Currency formatting inconsistent — some pages show `$1,000` others show `$1000.00` |
| M32 | Table sort resets when data refreshes via realtime subscription |
| M33 | Print stylesheet missing on invoice PDF — browser print doesn't match PDF export |
| M34 | Mobile layout broken on 5+ pages — tables overflow viewport |
| M35 | Toast notifications stack without auto-dismiss limit — can fill screen |
| M36 | Filter state lost on page navigation — returning to a list clears all filters |

---

## 🟢 LOW (21 bugs)

### Financial (1)
| ID | Description |
|----|-------------|
| L1 | Orders.tsx converts `total_price` to cents for display only — comment needed for clarity (FIN-L1) |

### Inventory (4)
| ID | Description |
|----|-------------|
| L2 | Product detail page doesn't show last received date |
| L3 | Inventory export CSV column headers don't match import template |
| L4 | Lot number field accepts any string — no format validation |
| L5 | Product notes field truncated at 500 chars without warning |

### Delivery/Orders (4)
| ID | Description |
|----|-------------|
| L6 | Delivery detail map link opens Google Maps — should offer Waze option for drivers |
| L7 | Order confirmation email template has placeholder text |
| L8 | Delivery signature pad too small on mobile devices |
| L9 | Route optimization not considering road distance (uses straight-line) |

### Security (2)
| ID | Description |
|----|-------------|
| L10 | Login page doesn't show failed attempt count |
| L11 | Password complexity requirements not displayed on change screen |

### Data Integrity (3)
| ID | Description |
|----|-------------|
| L12 | Created_at timestamps not indexed — slow queries on date-range reports |
| L13 | Some enum columns use text instead of Postgres ENUM type — no DB-level validation |
| L14 | Orphaned storage objects from deleted blend tickets not cleaned up |

### Frontend (7)
| ID | Description |
|----|-------------|
| L15 | Settings page favicon not showing in browser tab |
| L16 | Empty state illustrations inconsistent across pages |
| L17 | Keyboard navigation broken in dropdown menus |
| L18 | Page title not updated on navigation (always shows app name) |
| L19 | Loading skeleton heights don't match actual content — layout shift |
| L20 | Search debounce too aggressive (500ms) — feels sluggish |
| L21 | Tooltip text truncated on narrow screens |

---

## Fix Priority Roadmap

### Phase 1: Data Corruption Prevention (fix NOW)
1. **C1 + C2:** Fix `void_payment` GENERATED column + RETURNING bug
2. **C3:** Fix `order_shares.amount_cents` 100x error
3. **C4:** Fix `complete_delivery` inventory pre-check math
4. **C5:** Fix bulk receiving delete to reverse inventory
5. **C6:** Fix blend ticket → application record inventory deduction
6. **C7–C10:** Add role checks to 4 unprotected SECURITY DEFINER RPCs
7. **H3:** Fix phantom `'paid'` status in `record_invoice_payment`

### Phase 2: Financial Safety (fix before real data entry)
8. **H1 + H2:** Add `check_period_open()` to payment RPCs
9. **H4:** Add idempotency to `record_invoice_payment`
10. **H5 + H7:** Fix falsy `||` guards and Math.round
11. **H6:** Fix reconciliation Check 3 table reference
12. **H17–H20:** Remaining security role checks + search_path fixes

### Phase 3: Workflow Integrity (fix before UAT)
13. **H8:** Add optimistic locking to inventory updates
14. **H13:** Fix cancel order to release holds
15. **H14:** Add credit limit check to quick delivery
16. **H21–H23:** Data integrity guards (FK checks, orphan cleanup)
17. **H24–H25:** Dashboard cache refresh + bulk progress indicators

### Phase 4: Polish (fix before go-live)
18. All MEDIUM bugs (M1–M36)
19. All LOW bugs (L1–L21)

---

## Systemic Patterns (New in Wave 4)

### Pattern 6: No optimistic locking anywhere
Zero `.update()` calls check `updated_at` before writing. Any concurrent edit silently overwrites. This affects every edit form in the system.

### Pattern 7: Bulk operations bypass safety guards
Individual operations (delete receiving, void invoice, cancel PO) have proper guards. Bulk versions skip them — no inventory reversal, no role checks, no idempotency.

### Pattern 8: SECURITY DEFINER role checks incomplete
Wave 2/3 added role checks to ~12 functions, but at least 6 more are still unprotected. New functions added during fixes may also be missing checks.

### Pattern 9: Generated columns + direct SET
Multiple places try to SET computed/generated columns directly instead of updating their component columns. Postgres behavior varies — sometimes silent, sometimes error.

### Pattern 10: `|| 0` vs `?? 0` for numeric guards
JavaScript's `||` operator treats `0` as falsy. At least 5 places use `value || fallback` for cent amounts, causing $0.00 values to trigger fallback logic. Should be `??`.
