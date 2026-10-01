# CRX Manager — Monthly Integrity Reports

Automated pre-close integrity checks run on the 1st of each month.
Each section is one run; all money/quantity values are raw units (cents or product units as labeled).

---

## 2026-10-01 Run

**Verdict: FAIL — resolve 3 check failures (159 discrepancies) before month-end close.**

Run timestamp: 2026-10-01T00:00:00Z (automated)
Supabase project: `rhyzpcqhnizqbxphqdkr`

### Results

| # | Check | Result | Entities checked | Discrepancies |
|---|---|---|---|---|
| 1 | Order Totals | ✅ PASS | 65 orders | 0 |
| 2 | Inventory Ledger | ❌ FAIL | 116 products | 5 |
| 3 | Invoice Payments | ✅ PASS† | 3 invoices (overdue/paid) | 0 |
| 4 | Invoice Balance Formula | ✅ PASS | 13 invoices | 0 |
| 5 | Commission Splits | ✅ PASS | 31 buckets | 0 |
| 6 | Quote-Hold Parity | ✅ PASS | 1 active planned quote | 0 |
| 7 | Delivery-Invoice Qty | ❌ FAIL | 219 order+product pairs | 153 |
| 8 | Pre-booked Inventory | ❌ FAIL | 117 inventory rows | 1 |
| 9 | Return-Credit Linkage | ✅ PASS | 0 credited returns | 0 |
| 10 | Customer AR Consistency | ✅ PASS | 13 invoices | 0 |

† Check 3 originally filters `status = 'posted'` but no invoices carry that status in production (live statuses: draft, overdue, paid, unposted). Checked against overdue/paid instead. **The `/integrity-report` admin page silently sees 0 entities for this check — code bug, see notes below.**

---

### FAIL: Check 2 — Inventory Ledger (5 discrepancies)

Ledger running total (from `inventory_transactions`) vs `inventory.quantity_available`. Units are product units.

| Product | Expected (ledger) | Actual (DB) | Delta |
|---|---|---|---|
| Ammonium Sulfate - 51# Bag | 52,598 | 50,398 | 2,200 |
| Black Strap Molasses Sugar - Tote | 675 | 2,000 | 1,325 |
| Start Right 2.0 (AgBio) - Tote | 140.19 | 670.19 | 530 |
| Roundup 5.4# Generic (Ag Saver 5.4, Slam 5.4) - Bulk | 1,276.65 | 1,011.65 | 265 |
| Gen Valor SX (Zaltus SX, Flumioxazin 51%) - 5# | 185 | 0 | 185 |

---

### FAIL: Check 7 — Delivery-Invoice Quantity (153 discrepancies)

Of 65 orders with completed deliveries, only 11 have any invoice. 153 order+product pairs have product delivered but quantity not yet billed. This is the pre-invoicing gap — deliveries ran ahead of billing for the season.

Top 5 by delta (delivered qty, invoiced qty):

| Order ID (truncated) | Product (truncated) | Delivered | Invoiced | Delta |
|---|---|---|---|---|
| 002579ab | 36732b8d | 21,600 | 0 | 21,600 |
| 1b826608 | 6fd3adc1 | 16,320 | 0 | 16,320 |
| c34e4901 | 36732b8d | 10,800 | 0 | 10,800 |
| 002579ab | 34de8991 | 8,800 | 0 | 8,800 |
| 2e56bd1c | 6fd3adc1 | 8,320 | 0 | 8,320 |

**All 153 show delivered > 0 and invoiced = 0** — these are legitimately unissued invoices, not data corruption. But they must be resolved before close per runbook §5 step 2.

---

### FAIL: Check 8 — Pre-booked Inventory (1 discrepancy)

`inventory.quantity_prebooked` vs `SUM(order_items.quantity_remaining)` for open items.

| Product ID (truncated) | Inventory ID | Expected (order remaining) | Actual (prebooked) | Delta |
|---|---|---|---|---|
| 8b9c7b32 | 768ff8b5 | 247 | 36 | 211 |

One product has 211 fewer units recorded as prebooked than are actually outstanding in open order items. This means inventory appears more available than it really is.

---

### Notes

**Code bug — checks 3 and 4 status filter:** `src/lib/reconciliation.ts` lines 733–734 and 735–736 filter invoices with `.eq('status', 'posted')`. No invoice in production has status `'posted'` (live values: draft, overdue, paid, unposted). The `/integrity-report` admin page will always show 0 entities checked for these two checks, silently skipping them. The fix is to match the actual status values (overdue/paid for check 3; all non-voided for check 4). Low urgency but misleading.

**Schema registry staleness warning:** Session-start hook flagged 3 migration files newer than the schema registry high-water mark (20260914100800, 20260914101000, 20260914101100). Run `/regen-schema-registry` after confirming whether those migrations are applied live.

---

### Recommended actions before close

1. **Check 7 (153 items):** Post invoices for the 27 fulfilled orders with no invoice. Runbook §5 step 2.
2. **Check 2 (5 products):** Investigate inventory transaction history for Ammonium Sulfate, Black Strap Molasses Sugar, Start Right 2.0, Roundup Bulk, and Gen Valor SX. Likely missing adjustment or transfer entries.
3. **Check 8 (1 product):** Investigate product `8b9c7b32` — prebooked qty (36) is 211 units short of order remaining (247). A manual adjustment or a missed booking may be needed.
4. **Code fix (Check 3/4 bug):** File as a routine fix — `/integrity-report` page silently skips invoice payment checks.
