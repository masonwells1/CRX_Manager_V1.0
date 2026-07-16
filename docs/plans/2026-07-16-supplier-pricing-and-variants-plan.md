# Supplier Pricing, Price History & Product Variants — Plan

**Date:** 2026-07-16
**Status:** PROPOSED — awaiting Mason's approval of the architecture decision
**Branch:** `claude/supplier-pricing-strategy-9c6129` (planning only, no code in this session)
**Advisors:** Claude (grounding + synthesis) with Codex gpt-5.6 ("Sol 5.6") architecture review

---

## 1. The problems (Mason's words, restated)

1. **Multi-supplier sourcing** — chemical generics are quoted by 2–3 suppliers whose prices move all year. Need to know who's cheapest per product, at any moment, and compare suppliers as new price sheets arrive.
2. **Price history** — look at any product and see its historical price over time, per supplier.
3. **PDF price sheets** — suppliers send large multi-page PDF price lists monthly; updating pricing from them needs to be easy and safe.
4. **Return-policy pricing** — same chemical is priced differently for "full tote, no returns" vs "custom-filled tote, returns allowed." Today this is handled with duplicate product rows named e.g. `Atrazine 4L - NO RETURN, FULL TOTE - 265G`. Needs a scalable model.

## 2. Current state (verified 2026-07-16 against live DB + code)

- `products`: 604 rows, ~441 distinct base names → **~163 rows are packaging/policy variants encoded in the name**. Each is a fully independent row (own cost, tier prices, inventory).
- `products.vendor` is **free text, one supplier per product**, not linked to the `vendors` table (13 rows, AP-only, contains typo-duplicates: "The Anderson's"/"The Andersons", "Van Deist"/"Van Diest"). `purchase_orders.vendor` is also free text (FK was explicitly deferred in an earlier decision).
- `cost_history` exists (old/new cost + tier prices, change_note, changed_at) but has only **29 rows** — written only by the product-detail save and BulkPricingImport frontend paths. **No DB trigger enforces capture**, and the live `receive_po_items` RPC no longer touches product cost or history at all (that code path was dropped in a past migration and never restored).
- `purchase_order_items` (194 rows) holds real paid `unit_cost`/`unit_cost_cents` per PO line — **actual transaction-price history already sitting in the DB, untapped**.
- **PDF import already exists**: `process-document` edge function (Google Vision OCR + regex, first-class `price_list` document type) + `BulkPricingImport` modal (CSV/PDF, fuzzy match by SKU/name, overwrites `current_cost` + tier prices, writes cost_history). It is single-supplier: the parsed `vendor_name` is discarded.
- Quotes resolve sell price live from the product's tier price (server-authoritative `save_quote`); orders snapshot price at quote→order conversion. `unit_conversions` keys are frozen (renaming silently rescales money).

## 3. Architecture decision (the core insight)

There are **three different business facts** currently forced into one `products.current_cost` field:

| Fact | Meaning | Where it should live |
|---|---|---|
| **Supplier price** | "Supplier X offered this item at this cost on this date" | NEW append-only `supplier_price_observations` |
| **Selected cost basis** | "The cost CRX has deliberately chosen as the input to sell pricing" | `products.current_cost` (Phase 1) → `product_cost_basis` (Phase 2) |
| **Actual paid cost** | "What CRX actually paid on a received PO line" | `purchase_order_items` (already exists) |

**Rules that follow:**
- An imported supplier price sheet **never automatically changes sell prices**. It creates observations. Changing the cost basis (and therefore tier prices) is a separate, deliberate, previewed action.
- "Cheapest supplier" is a **recommendation surface, not an automation** — freight, availability, rebates, pack equivalence, and return rights make raw-cheapest frequently wrong.
- Supplier observation rows are **immutable**; corrections supersede rather than update.

## 4. Data model (Phase 1 tables)

### Supplier identity (prerequisite, done incrementally — no big-bang FK migration)
- Keep `vendors` as the canonical supplier table; merge the known typo-duplicates administratively.
- NEW `vendor_aliases`: `vendor_id FK`, `alias_normalized` (unique), `alias_display`, `source` ('legacy_product'|'legacy_po'|'import'|'manual'). All new pricing flows resolve to a real `vendor_id`; legacy free-text fields on `products`/`purchase_orders` stay untouched for now.

### NEW `product_supplier_links` — confirmed "supplier X sells us product Y" mappings
`product_id FK`, `vendor_id FK`, `supplier_sku`, `supplier_product_name`, `supplier_uom`, `supplier_pack_description`, `is_active`, `is_preferred`, `match_confidence`, `confirmed_by/at`. Unique on `(product_id, vendor_id, supplier_sku)`. Fuzzy matches get confirmed once, then reused forever.

### NEW `supplier_price_imports` + `supplier_price_import_rows` — staging, never live
One row per uploaded document (vendor_id, document_date, parser_version, status: draft → needs_review → approved/rejected/partially_approved, approved_by/at) and one row per extracted line (raw text, extracted cost **in cents**, unit/pack fields, proposed product match + confidence, reviewer corrections, raw extraction payload).

### NEW `supplier_price_observations` — the permanent price timeline
`product_id`, `vendor_id`, `product_supplier_link_id`, `import_id/row_id` provenance, `price_kind` ('list'|'quote'|'contract'|'promo'|'manual'), `cost_cents bigint`, `price_unit`/`package_quantity`, `effective_from/to`, `observed_at`, `is_comparable` + note, `supersedes_observation_id`, `created_by/at`. **Not** unique on (product, vendor, date) — corrections/quotes/promos can coexist; dedup happens at import staging.

### Phase 2: `product_cost_basis`
`product_id`, `supplier_price_observation_id` (nullable), `cost_cents`, `basis_type` ('selected_supplier_price'|'actual_purchase'|'manual_override'), `effective_from/to`, `reason`, `selected_by/at`. `products.current_cost` becomes a compatibility cache of the active row until the pricing RPC is migrated.

## 5. Price history plan

- **DB trigger** on `products` capturing every `current_cost`/tier-price change into `cost_history` (+ add actor/source/reason columns) — closes the "any write path can silently skip history" hole for good.
- `supplier_price_observations` is self-historizing (append-only).
- `purchase_order_items` = actual-paid timeline; **backfill** provably-matchable PO lines as `actual_purchase` facts with full provenance — labeled as spend evidence, never faked as price-sheet quotes.
- One read-only **`product_price_timeline` view** merges all three streams for a single product-page chart. Three storage layers, one screen.

## 6. PDF ingestion (hybrid pipeline)

1. Keep Vision OCR for page → text/layout.
2. **Add an LLM extraction step** (Anthropic API call in the edge function) converting OCR output into the strict import-row schema — replaces the brittle regex as primary parser for varied supplier formats. Share provider strategy with the parked vendor-bill (X6/D1) pilot so we run ONE document-AI approach, not two.
3. Deterministic validation after the LLM: cents parsing, UOM/pack checks, duplicate detection, vendor alias resolution. The LLM extracts; it never authorizes.
4. **Mandatory review screen** before anything becomes an observation: supplier + sheet date; every row with page ref + confidence; proposed product match; current cost vs newest vs cheapest-comparable; new/changed/unchanged/cannot-compare status; only high-confidence rows preselected; approval summary states plainly *"You are adding N supplier observations. You are changing ZERO sell prices."*
5. Separate, later action: "use these approved prices as cost basis → preview resulting tier-price changes → confirm." The two approvals are never combined.

## 7. Variants / return-policy pricing (least-disruptive path)

**Do NOT merge the 163 existing variant rows** — live inventory/PO/delivery/invoice references make that high-risk and unnecessary. **Do NOT build a separate variants+inventory subsystem.**

Instead:
- NEW `product_families`: `canonical_name`, active-ingredient/formulation, `comparison_group`.
- ADD to `products`: `product_family_id` (nullable), `return_policy` ('returnable'|'no_return'|'not_applicable'|'unknown'), `packaging_variant`, `is_full_tote_only`, structured pack/volume fields where missing.
- Every existing row keeps being the sellable/inventory SKU it already is; the family layer groups them for comparison and display. A family page shows all variants side-by-side with inventory, selected cost, and cheapest comparable supplier.
- Families beat a `base_product_id` self-reference because a family isn't itself a sellable SKU and survives the "base" row being discontinued.
- Supplier comparisons only run within true equivalence (pack + unit + return policy) — a no-return full tote is a different commercial offering, not a discount on the returnable item.

## 8. Phases

### Phase 1 — Supplier-price intelligence + safe imports (highest value, zero interference with live quoting)
- Vendor dedup + `vendor_aliases`
- `product_supplier_links`, staged imports, `supplier_price_observations`
- Hybrid OCR+LLM extraction with the review/approve screen
- Supplier comparison view + product price-timeline view
- Backfill matchable PO actual-cost facts
- **Touches nothing in** `current_cost`, tier pricing, quotes, inventory

### Phase 2 — Governed cost basis + bulletproof audit
- `product_cost_basis` + the products price-change trigger
- "Select cost basis → preview sell-price impact → confirm" workflow
- Migrate pricing RPC reads gradually; order snapshot behavior unchanged

### Phase 3 — Families + policy normalization
- `product_families` + structured policy attributes; classify the 163 variants (no deletes/merges)
- Family-aware product pickers and reporting
- Only then consider formulaic pricing-rule helpers

### Explicitly NOT building (YAGNI)
Automated vendor selection; automatic sell-price changes from imports; PO `vendor_id` FK migration; rebate optimization; freight allocation; catalog/SKU rewrite. **First scope cuts if needed:** Phase 3 selector polish and anything automatic. **Never cut:** supplier identity, staged approval, immutable observations — they're what stops a bad PDF extraction from becoming bad customer pricing.

## 9. Open owner decisions

1. **Approve this architecture** (observation layer + never-auto-change-sell-prices). Recommended: yes.
2. **Anthropic API key** — the LLM extraction step needs it; the same key unblocks the parked vendor-bill pilot (already TODO owner-action #6).
3. **Vendor merges** — confirm "The Anderson's"="The Andersons" and "Van Deist"="Van Diest" (already an open TODO item).
4. **Priority** — where Phase 1 slots against the current roadmap (CRM Phase 2, etc.).
