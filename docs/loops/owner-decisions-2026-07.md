# Owner Decisions — Structure-Fix Wave (2026-07)

**For:** Mason · **From:** the structure-fix loop · **Status:** decisions needed before the matching code is applied.
These six packets each need a business call (not a coding call). Nothing here is applied yet. Where a fix is
already drafted-and-parked (Wave A), the packet notes it. Live counts pulled 2026-07-02.

**Lead recommendation:** the safest, highest-value first step is **Packet 3 (junk-data deletes)** and **Packet 4
(due-date policy)** — packet 3 is pure cleanup of obviously-fake rows, and packet 4 unblocks the whole late-AR
machine (parked migration A8 is waiting on it). The two merge packets (1, 2) re-bucket history, so take those
only when you can sign off the exact spelling that is the "real" one.

---

## Packet 1 — Vendor + manufacturer MERGE mappings (re-buckets spend/rebate history — your call which spelling is real)

**Why it's yours:** merging "Van Diest" and "Van Deist" into one re-buckets AP spend + PO history under one name
permanently; which spelling is the legal entity is a business fact I can't know. The bill↔PO link is exact-string
today and hard-fails on these typos.

### Vendors (free text on products + purchase_orders)
| Likely-canonical (keep) | Merge INTO it (typo/variant) | Where it appears |
|---|---|---|
| **The Anderson's** (73 products, 2 POs) | The Andersons (2 products) | products.vendor, purchase_orders.vendor |
| **Van Diest Supply** (3 products, 1 PO) | Van Deist Supply (1 product, 1 PO) | products.vendor, purchase_orders.vendor |
| Wells Ag Supply (452 products, 17 POs) | — (house vendor, clean) | — |

→ Confirm the two merges above (or correct which spelling is canonical). "we" and "Test Vendor" are junk — see Packet 3.

### Manufacturers (products.manufacturer, 602/604 populated, 41 distinct)
| Likely-canonical (keep) | Merge INTO it (typo/variant) |
|---|---|
| **Corteva** (65) | Cortteva (1) |
| **Syngenta** (47) | Syngeta (1), Syngtenta (1) |
| **NuFarm** (2) *(pick one casing)* | Nufarm (2) |
| **Alchemy BioScience** (3) | Alchemy Bioscience (1) |
| **Bayer** (37) | Bayer (BASF) (3) *(confirm — is "(BASF)" meaningful or a note?)* |

Notes: "Various" (116) is a real bucket, not a typo — leave as-is or decide a policy. "Test Mfg" (3) is junk (Packet 3).
Rebates join manufacturer money-claims on this free-typed string (`Rebates.tsx:700`), so the merge also fixes rebate matching.

---

## Packet 2 — Category remap of the 19 live values (sales reports re-bucket history on rename — business call)

**Why it's yours:** `products.category` is joined LIVE by sales-report RPCs, so renaming a category re-buckets
historical sales. The data currently mixes TWO taxonomies (functional class AND application timing).

**Recommended two-axis model** (from the units/category deep-dive): keep `category` = functional class, add an optional
`use_timing` tag. Proposed mapping of the live 19 values:

| Live value (count) | → functional `category` | → `use_timing` tag |
|---|---|---|
| Post Emergence (91) | Herbicide | Post-Emergence |
| Pre-Emerge Soybean (84) | Herbicide | Pre-Emerge Soybean |
| Pre-Emerge Corn (57) | Herbicide | Pre-Emerge Corn |
| Volunteer Corn (7) | Herbicide | Volunteer Corn |
| Herbicide (6) | Herbicide | (none) |
| Fungicide (58) | Fungicide | — |
| Insecticide (56) | Insecticide | — |
| Liquid Fertilizer (55) | Liquid Fertilizer | — |
| Adjuvant (48) | Adjuvant/Surfactant | — |
| Foliar Nutrition (36) | Foliar Fertilizer | Foliar |
| Foliar Nutrition & Liquid Fertilizer (16) | **?? pick ONE** (Foliar Fertilizer or Liquid Fertilizer) | Foliar |
| Range Pasture Turf (25) | Herbicide *(mostly)* | Range/Pasture/Turf |
| Seed Treatment (18) | Seed Treatment | — |
| Dry Water Soluble Fertilizer (13) | Dry Fertilizer | — |
| Biological (9) | Biological | — |
| Nitrogen Stabilizer (9) | Nitrogen Stabilizer | — |
| Other (8) | Other | — |
| Utility (2) | **?? (Charge/Service or Other)** | — |
| (empty) (6) | **?? classify these 6 by hand** | — |

→ Confirm the mapping; flag the 3 marked **??** and the 6 empty rows.

---

## Packet 3 — Junk-data deletes (obviously fake rows in production — approve the list)

Deleting real records is your call. All of these look like leftover test data. **Recommended: delete all.**

| What | Count | Where | Impact of deleting |
|---|---|---|---|
| `RTJ Recipe mmq…` blend recipes | **8** | blend_recipes | Pollute two production recipe pickers; no real tickets use them |
| `Test Mfg` products | **3** | products.manufacturer='Test Mfg' | Fake manufacturer |
| `Test Vendor` products | **3** | products.vendor='Test Vendor' | Fake vendor (NOT the `[E2E]` fixture) — confirm these 3 SKUs are fake |
| Vendor `we` | **1** | purchase_orders.vendor='we' | One PO vendored to a typo/word-fragment; re-vendor or void |
| Invalid customer emails | ~5 (per audit) | customers.email | Block §6 proof notices; re-query with your definition of "not an email" |

→ Approve delete of the 8 recipes + 3 Test Mfg + vendor 'we'. Confirm the 3 "Test Vendor" products and the bad emails.
(Deletes ship as ONE reviewed owner-gated migration — none applied yet.)

---

## Packet 4 — Due-date / aging policy (unblocks parked migration A8)

**Why it's yours:** it changes money behavior. Today chemical-sale invoices get NO due_date, so the entire late-AR
machine (overdue cron, finance charges, Office Cockpit overdue tile) protects nothing. Parked migration **A8** builds
the terms→due-date rule but is flagged "needs Mason policy confirm."

Two questions:
1. **Default terms?** Recommend **Net 30** (field-app invoices already hardcode +30 days). A `payment_terms_days` int
   drives it; the customer's terms override the default.
2. **Age from which date?** Recommend **age from due_date** (a 30-day-old invoice on Net-30 terms is "Current", not "30 days").
   Aging is currently inconsistent (2 bases × 2 bucket boundaries across 4 surfaces) — one rule fixes all.

**Hard guarantee already built into A8:** due_date is derived at post time **going forward only** — NEVER backfilled
onto already-posted invoices (that would create retroactive overdue/finance-charge exposure). Confirm both above and A8 can apply.

---

## Packet 5 — Wire-vs-retire calls (surface it in the UI, or drop the dead structure)

For each, decide **wire** (finish the UI/plumbing) or **retire** (drop the dead table/column in a cleanup migration):

| Feature / structure | State today | Recommend |
|---|---|---|
| `ingredient_map` page / BrandVsGeneric | Empty-state tells a no-code owner to edit the raw table | Wire a mgmt page OR retire |
| CropPrograms + ProgramTracker | Write-only; nothing consumes crop programs | Wire "Apply Program" into jobs (Phase 4.2) OR retire |
| Per-acre tier columns (`tier1/2/3_price_per_acre`) | Trigger-maintained on 560 products, ZERO readers | Surface in QuoteBuilder OR drop the trigger |
| Dead tables (legacy `payments`, `order_line_allocations`, `rate_limit_log`, `document_processing_log`, jobs.tags/batch_id, receipt_pdf_url, `create_prepay_credit`) | 0 rows / UI-invisible; the legacy `payments` table is a booby-trap 2nd payment path | Retire in one dead-code migration |
| `get_customer_delivery_remainders` RPC (business-workflow review #40) | Defined and secured by `20260529214355_revoke_anon_execute_on_report_dashboard_secdef.sql`, but has zero repository callers | Wire a per-customer remainders card OR retire it in a separately reviewed migration |

→ Pick wire/retire per row (or "leave for now"). The #40 RPC remains unchanged in this cleanup; retirement needs a later owner decision and explicitly approved migration. None applied yet.

---

## Packet 6 — Confirm 'wire' as an allowed payment method

Two UIs offer **wire** as a payment method, but the CHECK constraint on the (dead) `payments` table bans it, and
the live payment tables (allocation_sets / commission_payments / vendor_payments) have no method CHECK at all.

→ Confirm **wire is allowed**. If yes, the cleanup adds one shared method list (check/ach/cash/credit_card/wire/other)
and matching CHECKs on the live tables while they're still empty (zero-backfill moment). If no, remove 'wire' from the 2 UIs.

---

## What happens after you decide
- Packet 3 (junk) + Packet 4 (due-date) → I can apply the parked/cleanup migrations (with your explicit OK per migration).
- Packets 1, 2 (merges) → I generate the exact UPDATE migration from your confirmed mapping, Codex-review it, and it waits for your apply OK.
- Packets 5, 6 → become small cleanup migrations on your go-ahead.
