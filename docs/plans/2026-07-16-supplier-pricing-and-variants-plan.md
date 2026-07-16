# Supplier Pricing, Price History & Product Variants — Plan

**Date:** 2026-07-16 (rev 2, same day — pre-season replacement-cost + pricing-worksheet refinements from Mason)
**Status:** PROPOSED — awaiting Mason's approval of the architecture decision
**Branch:** `claude/supplier-pricing-strategy-9c6129` (planning only, no code in this session)
**Advisors:** Claude (grounding + synthesis) with Codex gpt-5.6 ("Sol 5.6") architecture review

---

## 1. The problems (Mason's words, restated)

1. **Multi-supplier sourcing** — chemical generics are quoted by 2–3 suppliers whose prices move all year. Need to know who's cheapest per product, at any moment, and compare suppliers as new price sheets arrive.
2. **Price history** — look at any product and see its historical price over time, per supplier.
3. **PDF price sheets** — suppliers send large multi-page PDF price lists monthly; updating pricing from them needs to be easy and safe.
4. **Return-policy pricing** — same chemical is priced differently for "full tote, no returns" vs "custom-filled tote, returns allowed." Today this is handled with duplicate product rows named e.g. `Atrazine 4L - NO RETURN, FULL TOTE - 265G`. Needs a scalable model.
5. **Pre-season reality (added rev 2)** — **~80% of sales happen pre-season, BEFORE the supplier order exists.** At quote time there is often no owned inventory and no PO cost — the only meaningful cost is **replacement cost** (what a supplier would charge today). In-season, the same product may instead be priced off what's actually sitting in inventory from POs. Both must be visible side by side and both must be tracked over time.
6. **Owner control (added rev 2)** — Mason wants sell-price updates to run through a workflow HE drives: download a spreadsheet, edit prices in Excel where he can see everything and get it right, upload it back. AI may help fill the market-evidence side (current supplier prices), not the decision side.

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
| **Replacement cost** (supplier price) | "Supplier X offered this item at this cost on this date" → the current best/preferred offer per product is its **replacement cost today**. This is the pricing input for the ~80% of sales made pre-season, before anything is bought. | NEW append-only `supplier_price_observations`; replacement cost per product is DERIVED from the latest comparable observations (view or cached column), never hand-maintained |
| **Selected cost basis** | "The cost CRX has deliberately chosen as the input to sell pricing" — pre-season this will usually be set FROM replacement cost; in-season it may follow actual inventory cost. Always an explicit owner decision. | `products.current_cost` (Phase 1) → `product_cost_basis` (Phase 2) |
| **Actual paid / inventory cost** | "What CRX actually paid on a received PO line" → what the on-hand inventory really cost | `purchase_order_items` (already exists); surface last-paid + weighted-average-on-hand as derived views |

**Display rule:** wherever cost appears (product page, pricing worksheet, margin displays), show **both** replacement cost and actual/inventory cost next to the selected basis, each with its as-of date — the pre-season vs in-season difference is then visible instead of implicit.

**Existing-trigger caution:** the live DB has `trigger_calculate_prices_from_margin` — changing `current_cost` already auto-recomputes tier prices from margins. So "update cost basis" IS a sell-price change today. Any workflow that writes `current_cost` must preview the resulting tier prices before saving (the pricing worksheet does this, §6b).

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

## 6b. The pricing worksheet — owner-controlled round-trip (Phase 1 centerpiece)

Mason's preferred control surface is a spreadsheet, so the primary sell-price workflow is **export → edit in Excel → import → diff → approve**, not an in-app editor:

**Export** (one click, one row per product; variant rows grouped by family once Phase 3 lands):
- Identity: product, SKU, category, pack/unit
- Market evidence (read-only, AI/import-fed): latest price + date **per supplier** (2–3 columns), best comparable = **replacement cost today**
- Ownership evidence (read-only): on-hand qty, weighted-avg cost of on-hand, last-paid price + date (from POs)
- Current state (read-only): current cost basis, tier 1/2/3 margins + prices
- **Editable columns**: new cost basis, new tier margins/prices (+ optional note)

**Import**: upload the edited file → system diffs ONLY the editable columns against current values → preview screen shows each change including the tier prices that will result (per the margin trigger) → Mason approves → writes happen with `cost_history` rows noting "pricing worksheet YYYY-MM-DD". Unchanged rows are untouched; malformed cells are rejected per-row, never silently guessed.

**Division of labor**: AI (PDF import pipeline, §6) keeps the *market-evidence* columns fresh; Mason alone edits the *decision* columns. The export is always regenerable, so a stale downloaded copy can't corrupt anything — the diff is computed against live values at upload time, and any row whose read-only baseline shifted since export is flagged rather than blindly applied.

This also de-risks Phase 1: Excel is the UI, so the build is export + staged-import + diff-preview — no big new in-app pricing screens needed up front.

## 7. Variants / return-policy pricing (least-disruptive path)

**Do NOT merge the 163 existing variant rows** — live inventory/PO/delivery/invoice references make that high-risk and unnecessary. **Do NOT build a separate variants+inventory subsystem.**

Instead:
- NEW `product_families`: `canonical_name`, active-ingredient/formulation, `comparison_group`.
- ADD to `products`: `product_family_id` (nullable), `return_policy` ('returnable'|'no_return'|'not_applicable'|'unknown'), `packaging_variant`, `is_full_tote_only`, structured pack/volume fields where missing.
- Every existing row keeps being the sellable/inventory SKU it already is; the family layer groups them for comparison and display. A family page shows all variants side-by-side with inventory, selected cost, and cheapest comparable supplier.
- Families beat a `base_product_id` self-reference because a family isn't itself a sellable SKU and survives the "base" row being discontinued.
- Supplier comparisons only run within true equivalence (pack + unit + return policy) — a no-return full tote is a different commercial offering, not a discount on the returnable item.

## 8. Phases

### Phase 1 — Supplier-price intelligence + the pricing worksheet
- Vendor dedup + `vendor_aliases`
- `product_supplier_links`, staged imports, `supplier_price_observations`; derived replacement-cost + inventory-cost views
- Hybrid OCR+LLM extraction feeding staged observations (review before approve)
- **Pricing worksheet round-trip (§6b)** — export with per-supplier replacement costs + inventory cost, Mason edits, diff-preview (incl. margin-trigger tier-price effects), approve, history written
- Product page: show replacement cost + inventory cost alongside current cost basis
- Backfill matchable PO actual-cost facts
- Supplier price sheets never write sell prices directly; only the worksheet approval path (and the existing product page) does

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

1. **Approve this architecture** (observation layer + never-auto-change-sell-prices; rev 2 adds pre-season replacement cost as the headline derived number and the pricing worksheet as the owner-controlled sell-price surface). Recommended: yes.
2. **Anthropic API key** — the LLM extraction step needs it; the same key unblocks the parked vendor-bill pilot (already TODO owner-action #6).
3. **Vendor merges** — confirm "The Anderson's"="The Andersons" and "Van Deist"="Van Diest" (already an open TODO item).
4. **Priority** — where Phase 1 slots against the current roadmap (CRM Phase 2, etc.).
