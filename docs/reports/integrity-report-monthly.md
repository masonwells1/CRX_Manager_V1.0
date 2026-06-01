# CRX Manager — Monthly Integrity Reports

Automated pre-close reconciliation run on the 1st of each month.
Each section is one run. Checks executed via Supabase MCP `execute_sql` (read-only).

---

## 2026-06-01 Run

**Verdict: RESOLVE 3 CATEGORIES OF DISCREPANCIES BEFORE CLOSING.**

Run timestamp: 2026-06-01T (automated, headless)
Total checks: 10 | PASS: 7 | FAIL: 3 | Total discrepancies: 168

---

### Check Results

| # | Check | Status | Entities Checked | Discrepancies |
|---|-------|--------|-----------------|---------------|
| 1 | Order Totals | **PASS** | 53 orders | 0 |
| 2 | Inventory Ledger | **FAIL** | 111 products | 10 |
| 3 | Invoice Payments | PASS (vacuous) | 0 posted invoices | 0 |
| 4 | Invoice Balance Formula | PASS (vacuous) | 0 posted invoices | 0 |
| 5 | Commission Splits | **PASS** | 21 orders | 0 |
| 6 | Quote-Hold Parity | **PASS** | 1 planned quote | 0 |
| 7 | Delivery-Invoice Qty Parity | **FAIL** | 202 order+product pairs | 157 |
| 8 | Pre-booked Inventory | **FAIL** | 111 products | 1 |
| 9 | Return-Credit Linkage | PASS (vacuous) | 0 credited returns | 0 |
| 10 | Customer AR Consistency | **PASS** | 2 non-voided invoices | 0 |

---

### FAIL Detail

#### Check 2 — Inventory Ledger (10 discrepancies)

Stored `quantity_available` diverges from the running total computed from
`inventory_transactions`. Positive delta = more stored than ledger explains;
negative ledger = ledger went below zero (over-delivered vs received).

| Product | Ledger Expected (units) | Stored Actual (units) | Delta |
|---------|------------------------|-----------------------|-------|
| Ammonium Sulfate - 51# Bag | 53,210.00 | 51,010 | 2,200 |
| Black Strap Molasses Sugar - Tote | 675.00 | 2,000 | 1,325 |
| Start Right 2.0 (AgBio) - Tote | 140.19 | 670.19 | 530 |
| Roundup 5.4# Generic (Ag Saver 5.4, Slam 5.4) - Bulk | 1,355.00 | 1,090 | 265 |
| Gen Valor SX: (Zaltus SX, Flumioxazin 51%, Varsity, Panther) - 5# | 185.00 | 0 | 185 |
| Trivapro - Bulk | 514.00 | 353 | 161 |
| 2, 4D Amine 4# - 2.5 Gal | **-50.00** ⚠ | 45 | 95 |
| 2, 4D Amine 4# - Bulk | 0.00 | 55 | 55 |
| NIS 90 - 2.5 Gal | 310.00 | 275.0 | 35 |
| Start Right 2.0 (AgBio) - 2.5G | 280.00 | 290 | 10 |

⚠ "2, 4D Amine 4# - 2.5 Gal" has a **negative ledger total (-50 units)** — more
product was delivered than was ever received in the transaction log. Indicates
missing `received` transactions or a delivery recorded against the wrong product.

**Root cause hypothesis:** Most of these are stored > ledger, consistent with
stock loaded via direct inventory adjustments rather than proper `received`
transactions. Recommended fix: run a cycle count per product and post correcting
`adjusted` transactions to align the ledger.

---

#### Check 7 — Delivery-Invoice Quantity Parity (157 discrepancies)

**Context:** The database has 62 completed deliveries but only 2 draft invoices
(no posted invoices exist). All 157 discrepancies follow the same pattern:
`qty_delivered > 0, qty_invoiced = 0`. This is an **operational invoicing backlog**,
not data corruption — but it will block `close_accounting_period()` per runbook §5.

Top 5 by unmatched delivered quantity (units, not cents):

| Order (prefix) | Product (prefix) | Delivered (units) | Invoiced (units) | Delta |
|----------------|-----------------|-------------------|-----------------|-------|
| 002579ab… | 36732b8d… | 21,600 | 0 | 21,600 |
| 1b826608… | 6fd3adc1… | 16,320 | 0 | 16,320 |
| c34e4901… | 36732b8d… | 10,800 | 0 | 10,800 |
| 002579ab… | 34de8991… | 8,800 | 0 | 8,800 |
| 2e56bd1c… | 6fd3adc1… | 8,320 | 0 | 8,320 |

**Action required (runbook §5 step 2):** Create and post invoices for all
62 completed deliveries before running period close.

---

#### Check 8 — Pre-booked Inventory (1 discrepancy)

| Product | Expected Prebooked (units) | Actual Prebooked (units) | Delta |
|---------|---------------------------|--------------------------|-------|
| 1A TEST PRODUCT - FAKE PRODUCT | 247 | 36 | 211 |

Test product — 247 units of remaining order items reference this product but
`inventory.quantity_prebooked` shows only 36. Low operational impact (test
data), but `quantity_prebooked` is out of sync. Can be ignored or cleaned up.

---

### Notes on Vacuous PASSes

- **Checks 3 & 4 (Invoice Payments / Balance Formula):** Filter is `status = 'posted'`. Zero posted invoices exist (2 drafts total). These will become meaningful once invoices are posted.
- **Check 9 (Return-Credit Linkage):** No returns in `credited` status exist. Will activate once credits are issued.

---

### Pre-Close Action List

1. **BLOCKER — Invoice backlog:** Create and post invoices for all 62 completed
   deliveries (runbook §5 step 2). `close_accounting_period()` will reject until clear.
2. **INVESTIGATE — Inventory ledger drift (10 products):** Run a cycle count or
   reconcile transaction history. Particularly urgent for "2, 4D Amine 4# - 2.5 Gal"
   (ledger went negative). Post correcting `adjusted` transactions after verification.
3. **LOW — Test product prebook:** Clean up `1A TEST PRODUCT - FAKE PRODUCT`
   order items (211-unit prebook mismatch). Does not block close.

**Resolve 3 discrepancy categories before month-end close.**
