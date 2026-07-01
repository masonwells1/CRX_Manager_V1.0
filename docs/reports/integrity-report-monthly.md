# Monthly Integrity Reports

Automated reconciliation runs against the live Supabase database, executed on the 1st of each month before month-end close. Each run is appended below, newest first.

---

## 2026-07-01 Run

**Verdict: Do NOT close the period yet — post or void the 4 outstanding invoices first, then re-check.**

Two checks have real findings: 10 inventory ledger mismatches (pre-existing, matches H1 open item) and 4 invoices still in draft/unposted state that block the period-close RPC. The 157 delivery-invoice gaps are entirely explained by those same 0 posted invoices — not data corruption. One test-product prebook drift is safe to ignore.

---

### Results

| # | Check | Status | Entities Checked | Discrepancies |
|---|-------|--------|-----------------|---------------|
| 1 | Order Totals | **PASS** | 59 orders | 0 |
| 2 | Inventory Ledger | **FAIL** | 114 products | 10 |
| 3 | Invoice Payments | **PASS** | 0 posted invoices¹ | 0 |
| 4 | Invoice Balance Formula | **PASS** | 0 posted invoices¹ | 0 |
| 5 | Commission Splits | **PASS** | 32 orders | 0 |
| 6 | Quote-Hold Parity | **PASS** | 1 planned active quote | 0 |
| 7 | Delivery-Invoice Qty Parity | **NOTICE** | 207 order+product pairs | 157² |
| 8 | Pre-booked Inventory | **NOTICE** | 114 products | 1³ |
| 9 | Return-Credit Linkage | **PASS** | 0 credited returns¹ | 0 |
| 10 | Customer AR Consistency | **PASS** | 4 non-voided invoices | 0 |

¹ Vacuously clean — system is pre-billing; no posted invoices exist yet.  
² All 157 are "delivered but qty_invoiced = 0" — 100% explained by 0 posted invoices. Zero cases of invoiced-without-delivery or partial mismatch. Pre-billing state, not corruption.  
³ Test artifact — product "1A TEST PRODUCT - FAKE PRODUCT". Not a real product.

---

### Check 2 — Inventory Ledger: Top 5 discrepancies

`quantity_available` vs transaction-ledger-derived total. Delta is in product units (bags, gallons, lbs — not cents).

| Product | Stored Qty | Ledger Qty | Delta | Direction |
|---------|-----------|-----------|-------|-----------|
| Ammonium Sulfate - 51# Bag | 51,010 | 53,210 | **2,200** | available LOW |
| Black Strap Molasses Sugar - Tote | 2,000 | 675 | **1,325** | available HIGH |
| Start Right 2.0 (AgBio) - Tote | 670.19 | 140.19 | **530** | available HIGH |
| Roundup 5.4# Generic (Ag Saver/Slam 5.4) - Bulk | 1,090 | 1,355 | **265** | available LOW |
| Gen Valor SX (Zaltus SX, Flumioxazin 51%) - 5# | 0 | 185 | **185** | available LOW |

Remaining 5: Trivapro - Bulk (Δ161), 2,4D Amine 4# - 2.5 Gal (Δ95), 2,4D Amine 4# - Bulk (Δ55), NIS 90 - 2.5 Gal (Δ35), Start Right 2.0 (AgBio) - 2.5G (Δ10).

**Root cause:** Matches the known H1 open item in CLAUDE.md — "physical counts to re-base 17 negative-inventory products." These discrepancies pre-date this run. A physical count correction is needed, not a code fix.

---

### Check 7 — Delivery-Invoice Qty Parity: Top 5 discrepancies

All are delivered-but-not-invoiced. Quantities are product units.

| Order ID (first 8) | Product ID (first 8) | Delivered | Invoiced | Delta |
|--------------------|----------------------|-----------|---------|-------|
| 002579ab | 36732b8d | 21,600 | 0 | 21,600 |
| 1b826608 | 6fd3adc1 | 16,320 | 0 | 16,320 |
| c34e4901 | 36732b8d | 10,800 | 0 | 10,800 |
| 002579ab | 34de8991 | 8,800 | 0 | 8,800 |
| 2e56bd1c | 6fd3adc1 | 8,320 | 0 | 8,320 |

These will clear automatically once invoices are posted. No action required beyond completing billing.

---

### Month-end close checklist (as of 2026-07-01)

- [ ] **Post or void 4 outstanding invoices** (runbook §5 step 2) — required before `close_accounting_period()` will accept
- [ ] Confirm all June deliveries are `completed` or `cancelled` (runbook §5 step 1)
- [ ] Generate finance charges for overdue customers (runbook §5 step 3)
- [ ] Run `close_accounting_period()` — will reject if blockers remain
- [ ] Schedule physical inventory count to resolve the 10 ledger mismatches (H1 open item)
