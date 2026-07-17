# Supplier Pricing, Price History & Product Variants — Plan

**Date:** 2026-07-16 (rev 5 — Mason's decision: NO AI extraction of supplier PDFs, manual-entry-only ingestion; rev 4 incorporated the Codex adversarial review; rev 2–3 added pre-season replacement cost, the pricing worksheet, and whole-product fields)
**Status:** PROPOSED — awaiting Mason's approval of the architecture decision
**Branch:** `claude/supplier-pricing-strategy-9c6129` (planning only, no code in this session)
**Advisors:** Claude (grounding + synthesis) with Codex gpt-5.6 ("Sol 5.6") — advisory round + full adversarial review (verdict folded into this rev; see §11)

---

## 1. The problems (Mason's words, restated)

1. **Multi-supplier sourcing** — chemical generics are quoted by 2–3 suppliers whose prices move all year. Need to know who's cheapest per product, at any moment, and compare suppliers as new price sheets arrive.
2. **Price history** — look at any product and see its historical price over time, per supplier.
3. **PDF price sheets** — suppliers send large multi-page PDF price lists monthly; updating pricing from them needs to be easy and safe.
4. **Return-policy pricing** — same chemical is priced differently for "full tote, no returns" vs "custom-filled tote, returns allowed." Today this is handled with duplicate product rows named e.g. `Atrazine 4L - NO RETURN, FULL TOTE - 265G`. Needs a scalable model.
5. **Pre-season reality** — **~80% of sales happen pre-season, BEFORE the supplier order exists.** At quote time there is often no owned inventory and no PO cost — the only meaningful cost is **replacement cost** (what a supplier would charge today). In-season, the same product may instead be priced off what was actually paid. Both must be visible side by side and both must be tracked over time.
6. **Owner control** — Mason wants sell-price updates to run through a workflow HE drives: download a spreadsheet, edit prices in Excel where he can see everything and get it right, upload it back. AI may help fill the market-evidence side (current supplier prices), not the decision side.
7. **Whole-product worksheet** — the same sheet should carry all routinely-edited product fields (use rate, suggested rate, internal notes, external quoting notes) for quick batch editing.

## 2. Current state (verified 2026-07-16 against live DB + code)

- `products`: 604 rows, ~441 distinct base names → **~163 rows are packaging/policy variants encoded in the name**. Each is a fully independent row (own cost, tier prices, inventory).
- `products.vendor` is **free text, one supplier per product**, not linked to the `vendors` table (13 rows, AP-only, contains typo-duplicates: "The Anderson's"/"The Andersons", "Van Deist"/"Van Diest"). `purchase_orders.vendor` is also free text (FK was explicitly deferred in an earlier decision).
- `cost_history` exists (old/new cost + tier prices, change_note, changed_at) but has only **29 rows** — written only by the product-detail save and BulkPricingImport frontend paths. **No DB trigger enforces capture**, and the live `receive_po_items` RPC no longer touches product cost or history at all (that code path was dropped in a past migration and never restored).
- `purchase_order_items` (194 rows) holds real paid `unit_cost`/`unit_cost_cents` per PO line. **Neither `inventory` nor `receiving_records` carries any cost column** — there is no lot-level costing, so "cost of what's on hand" is not currently computable, only approximable from PO lines.
- **PDF import already exists**: `process-document` edge function (Google Vision OCR + regex, first-class `price_list` document type) + `BulkPricingImport` modal (CSV/PDF, fuzzy match by SKU/name, **directly overwrites `current_cost` + tier prices**, writes cost_history). It is single-supplier: the parsed `vendor_name` is discarded.
- Quotes resolve sell price live from the product's tier price (server-authoritative `save_quote`); orders snapshot price at quote→order conversion. `unit_conversions` keys are frozen (renaming silently rescales money).
- **Live trigger `trigger_calculate_prices_from_margin`**: changing `products.current_cost` (or margins) auto-recomputes tier prices. So ANY write to cost is already a sell-price change today.

## 3. Architecture decision (the core insight)

There are **three different price facts** currently forced into one `products.current_cost` field:

| Fact | Meaning | Where it should live |
|---|---|---|
| **Replacement cost** (supplier price) | "Supplier X offered this item at this cost on this date" → the current best/preferred offer per product is its **replacement cost today**. This is the pricing input for the ~80% of sales made pre-season, before anything is bought. | NEW append-only `supplier_price_observations`; replacement cost per product is DERIVED from the latest comparable observations (view or cached column), never hand-maintained |
| **Selected cost basis** | "The cost CRX has deliberately chosen as the input to sell pricing" — pre-season this will usually be set FROM replacement cost; in-season it may follow actual paid cost. Always an explicit owner decision. | `products.current_cost` (Phase 1) → `product_cost_basis` (Phase 2) |
| **Actual paid cost** | "What CRX actually paid on a received PO line" | `purchase_order_items` (already exists); surfaced as **"last paid"** and **"recent-PO weighted average"** — honestly labeled, NOT called "inventory/on-hand cost" (see §5a) |

**Rules that follow:**
- An imported supplier price sheet **never changes sell prices** — it creates observations. Changing the cost basis (and therefore tier prices) is a separate, deliberate, previewed action. **This requires actively closing the existing hole:** `BulkPricingImport`'s direct write path to `current_cost`/tier prices is retired in Phase 1a (§6c).
- "Cheapest supplier" is a **recommendation surface, not an automation**, and only ever shown between genuinely comparable offers (§4a).
- Supplier observation rows are **immutable, enforced in the database**: RLS with insert-only policies, UPDATE/DELETE rejected by trigger, supersession constrained (no self/cyclic references, same product only). Corrections supersede; nothing is edited in place.

**Display rule:** wherever cost appears (product page, worksheet, margin displays), show **both** replacement cost and last-paid/recent-average beside the selected basis, each with its as-of date.

## 4. Data model (Phase 1 tables)

### Supplier identity (prerequisite, done incrementally — no big-bang FK migration)
- Keep `vendors` as the canonical supplier table; merge the known typo-duplicates administratively.
- NEW `vendor_aliases`: `vendor_id FK`, `alias_raw` (exact source text, preserved), `alias_normalized` (unique; normalization rule defined in the spec — lowercase, trim, collapse whitespace, strip punctuation), `alias_display`, `source` ('legacy_product'|'legacy_po'|'import'|'manual'), `created_at`. **New aliases from imports require admin review before they resolve** — ambiguous names (branches, near-matches) are never auto-merged.
- NEW `legacy_vendor_resolution` (for PO backfill, §5): `original_text`, `vendor_id`, `confidence`, `reviewed_by`, `reviewed_at`. Historical PO lines join through this reviewed table only; unresolved history displays as **"supplier unknown"**, never fuzzy-assigned.

### NEW `product_supplier_links` — confirmed "supplier X sells us product Y" mappings
`product_id FK`, `vendor_id FK`, `supplier_sku`, `supplier_product_name`, `supplier_uom`, `supplier_pack_description`, **`inventory_units_per_supplier_unit` (directional, human-approved conversion — e.g. 1 supplier tote × 265 = 265 inventory gallons; deliberately NOT a generic "conversion_factor", per the 2026-07-16 inventory-costing advisory)**, `is_active`, `is_preferred`, `match_confidence`, `confirmed_by/at`. Unique on `(product_id, vendor_id, supplier_sku)`.
**Feed-forward for the parked inventory-costing plan (Gate 0):** future PO lines snapshot (not re-read) the link id, supplier unit, inventory unit, `inventory_units_per_supplier_unit`, supplier qty, supplier unit cost cents, exact receipt total cents, and normalized inventory quantity — columns added in 1b so the costing engine (see `docs/plans/2026-07-16-inventory-costing-plan.md`) never needs PO rework.
**Reuse rules (anti-mismatch):** a link only becomes reusable once it has a supplier SKU + confirmed pack/UOM. Name-only matches stay pending review every time; a changed package or missing SKU breaks reuse. Links are never copied across formulations/pack sizes.

### 4a. Comparability model (not just a flag)
An observation is rankable against others ONLY when its link carries an approved conversion to the product's inventory unit AND return policy/formulation match. The comparison surface always shows **both** the quoted package price and the normalized per-inventory-unit cost. Anything without an approved conversion displays as **"cannot compare"** — never silently included in "best/cheapest".

### NEW `supplier_price_imports` + `supplier_price_import_rows` — staging, never live
One row per uploaded document (vendor_id, document_date, parser_version, status: draft → needs_review → approved/rejected/partially_approved, approved_by/at, source document retained in storage) and one row per extracted line (raw text, page ref, extracted cost **in cents**, unit/pack fields, proposed link + confidence, reviewer corrections, raw extraction payload).

### NEW `supplier_price_observations` — the permanent price timeline
`product_id`, `vendor_id`, `product_supplier_link_id`, `import_id/row_id` provenance, `price_kind` ('list'|'quote'|'contract'|'promo'|'manual'), `cost_cents bigint`, `price_unit`/`package_quantity`, `effective_from/to`, `observed_at`, `supersedes_observation_id` (constrained: same product, no cycles), `created_by/at`. Append-only enforced per §3. Not unique on (product, vendor, date) — corrections/quotes/promos coexist; dedup happens at import staging.

### Phase 2: `product_cost_basis`
`product_id`, `supplier_price_observation_id` (nullable), `cost_cents`, `basis_type` ('selected_supplier_price'|'actual_purchase'|'manual_override'), `effective_from/to`, `reason`, `selected_by/at`. `products.current_cost` becomes a compatibility cache of the active row until the pricing RPC is migrated.

### Money boundary
New tables store integer cents; `products.current_cost`/tier prices remain legacy numeric dollars. **The preview/apply RPC (§6b) is the single cents↔dollars conversion point** — exact integer validation, returns the trigger-produced final values, rounding edge cases tested. No client-side money conversion.

## 5. Price history plan

- **Single-writer rule:** history capture moves into an `AFTER UPDATE` DB trigger on `products` (cost + tier prices → `cost_history`, extended with actor/source/reason via the writing RPC's transaction context). **The frontend `cost_history` inserts in ProductDetail and BulkPricingImport are removed in the same release** — otherwise every change is double-logged.
- `supplier_price_observations` is self-historizing (append-only).
- `purchase_order_items` = actual-paid timeline. **Backfill** through the reviewed `legacy_vendor_resolution` table only; unresolved lines appear as "supplier unknown". Labeled `actual_purchase` — spend evidence, never faked as price-sheet quotes.
- **Named deliverable:** a product-page **price history view, filterable by supplier**, charting all three streams (supplier observations per vendor, selected cost basis, actual paid) — Mason asked to "look at a product and SEE the historical price from each supplier"; tables alone don't satisfy that.

### 5a. What we will NOT call "inventory cost" (honesty rule)
`inventory` and `receiving_records` carry no cost; without lot-level costing, "cost of what's on hand" is not computable. The worksheet/product page therefore shows **"last paid (date)"** and **"recent-PO weighted average"** — both derived from PO lines and labeled as such. True on-hand costing (receipt-cost lots, remaining quantities, FIFO/weighted-average allocation, adjustments, reconciliation) is a **separate future design**, explicitly out of scope here.

## 6. Supplier price ingestion — manual entry only (Mason's decision, 2026-07-16)

**Owner decision (rev 5): NO automated extraction from supplier PDFs — no LLM, no OCR parsing of price sheets.** Mason judged machine-read prices too risky; supplier prices enter the system only through human-entered, staged, reviewed data.

The workflow:
1. **Supplier quote sheet** — a downloadable .xlsx template per supplier (same format contract as §6b): one row per linked product showing the product, the supplier's last known price + date, pack/UOM — with editable columns for new price, effective date, and price kind (list/quote/contract/promo). Mason (or staff) transcribes from the supplier's PDF while reading it.
2. Upload → **staged import** (`supplier_price_imports`/`_rows`) → deterministic validation (cents parsing, UOM/pack checks, duplicate detection, alias resolution) → **review screen**: every row, new/changed/unchanged/cannot-compare status, approval summary stating plainly *"You are adding N supplier observations. You are changing ZERO sell prices."*
3. The source PDF can be attached to the import for provenance/audit — stored, never parsed.
4. Quick single-quote entry (one product, one supplier, one price — e.g. a phone quote) goes through the same staging + review path.

**AI extraction is explicitly PARKED, not designed-in.** If monthly transcription proves too tedious in practice, it can be revisited later — the staging/review architecture is deliberately shaped so an extraction step could slot in front of the same review gate without any redesign. Re-opening it is an owner decision.

## 6b. The product & pricing worksheet — owner-controlled round-trip (Phase 1 centerpiece)

Mason's preferred control surface is a spreadsheet, so the primary batch-edit workflow for product data is **export → edit in Excel → import → diff → approve**.

**Format contract (Excel-proofing):** the export is **.xlsx** (not hand-parsed CSV); identity columns (product_id UUID, SKU) are protected/text-formatted and validated untouched on re-upload; ISO dates; strict decimal parsing (no locale-ambiguous money); formulas, duplicate IDs, edited identity fields, and blank required cells are rejected per-row with reasons.

**Export** (one click, one row per product; variant rows grouped by family once Phase 3 lands). Column groups:
- **Identity** (read-only, protected): product_id, product, SKU, category, pack/unit, `row_version`
- **Market evidence** (read-only, fed by approved supplier-quote imports §6): latest price + date **per supplier** (quoted package price AND normalized per-inventory-unit cost), best comparable = **replacement cost today**, or "cannot compare"
- **Purchase evidence** (read-only): on-hand qty, **last paid + date**, **recent-PO weighted average** (per §5a labels)
- **Current pricing** (read-only): current cost basis, tier 1/2/3 margins + prices
- **Editable — pricing**: `pricing_mode` per row (**margin-driven**: new cost + margins, server computes prices; or **price-driven**: new cost + explicit tier prices, server reconciles margins — one mode per row, both never compete), + optional note
- **Editable — product info** (fixed v1 contract, no "as-needed" additions): `suggested_rate`, `rate_per_acre`, `rate_unit`, `use_timing`, `internal_notes`, `quoting_notes` (**NEW dedicated column, decided now** — customer-facing quote text; existing `notes` stays untouched)

**Import → atomic apply:** upload → server-side **preview RPC** diffs only editable columns against live values using each row's `row_version`; preview returns a change-set ID showing every effect including trigger-produced tier prices; Mason approves → **apply RPC** validates all expected versions and writes accepted rows **atomically** (all-or-nothing per approved change-set; a change-set can be applied once — no replay). Any row whose baseline shifted since export (product-page edit, another upload) **conflicts loudly** instead of silently overwriting. Writes flow through the RPC only — the single money-conversion and single history-writing point.

**Editable-field guardrails:**
- `rate_unit` is money-adjacent (`save_quote` joins `LOWER(rate_unit)` against frozen-key `unit_conversions`): validated against the allowed unit list, every change flagged loudly in the preview.
- **Regulatory/label fields stay OFF the editable set** (EPA registration, signal word, REI/PHI, max label rate) — curated by the EPA-verified label-data tooling; read-only here.
- Pricing edits → `cost_history` (via the single writer); product-info edits → `activity_feed` entries with old→new values.

**Division of labor**: the supplier quote sheets (§6) keep market-evidence columns fresh; only the product worksheet's decision columns change sell pricing — and only Mason edits those.

## 6c. Retiring the unsafe legacy path (Phase 1a, first)

`BulkPricingImport` currently lets an OCR'd PDF directly overwrite `current_cost` + tier prices (and the margin trigger then rewrites sell prices). **Before anything else ships:** its price-list/PDF OCR mode is retired outright (per Mason's rev-5 no-machine-read decision, there is no automated replacement), and its direct product writes are removed. Any surviving manual CSV pricing path must use the same preview/apply RPC as the worksheet. This closes the "bad scan silently reprices a grower's quote" hole — the single biggest business risk both reviewers identified.

## 7. Variants / return-policy pricing (least-disruptive path)

**Do NOT merge the 163 existing variant rows** — live inventory/PO/delivery/invoice references make that high-risk and unnecessary. **Do NOT build a separate variants+inventory subsystem.**

Instead:
- NEW `product_families`: `canonical_name`, active-ingredient/formulation, `comparison_group`.
- ADD to `products`: `product_family_id` (nullable), `return_policy` ('returnable'|'no_return'|'not_applicable'|'unknown'), `packaging_variant`, `is_full_tote_only`, structured pack/volume fields where missing.
- Every existing row keeps being the sellable/inventory SKU it already is; the family layer groups them for comparison and display.
- **Enforcement, not just grouping (rev 4):** Phase 3 includes the behavior hooks — the product picker shows family variants side-by-side with their policy so a rep can't grab the wrong SKU blind, and return/credit flows **block returns against `return_policy = 'no_return'` SKUs** with a clear message. Grouping metadata without enforcement doesn't solve Mason's problem.
- Supplier comparisons only run within true equivalence (pack + unit + return policy) per §4a.

## 8. Phases (re-cut after adversarial review — safety foundation first)

### Phase 1a — Safety foundation
- Retire/reroute `BulkPricingImport` direct price writes (§6c)
- Worksheet round-trip for the **pricing columns**: .xlsx contract, row_version, preview/apply RPCs, atomic change-sets, single-writer history
- Single history writer (trigger + frontend insert removal)

### Phase 1b — Supplier evidence (complete ingestion, manual-only per §6)
- Vendor dedup + `vendor_aliases` (+ review flow) + `legacy_vendor_resolution`
- `product_supplier_links` (with conversion factors), staging tables, `supplier_price_observations` (append-only enforced)
- Supplier quote sheets (.xlsx template per supplier) + quick single-quote entry — both staged + reviewed
- Comparison surface (per-supplier latest + normalized cost + cannot-compare) and the supplier-filterable product price-history view
- Market-evidence columns of the worksheet export go live from observations
- PO backfill through reviewed vendor resolution

### Phase 2 — Governed cost basis
- `product_cost_basis` + "select basis → preview sell-price impact → confirm" workflow
- Pricing RPC migrates to read the selected basis; order snapshot behavior unchanged
- **Fast-follow:** worksheet product-info columns (§6b fixed contract incl. `quoting_notes`) — kept out of the first risky pricing release, added once the loop is proven

### Phase 3 — Families + policy enforcement
- `product_families`, policy attributes, classify the 163 variants (no merges)
- Picker + return-blocking enforcement (§7)

### Separate future projects (explicitly parked)
- True on-hand inventory costing (lot-level, §5a)
- **AI/OCR extraction of supplier price sheets** — parked by Mason's decision 2026-07-16 (§6); re-opening it is an owner decision

### Explicitly NOT building (YAGNI)
Automated vendor selection; automatic sell-price changes from imports; machine-read price sheets (parked above); PO `vendor_id` FK migration; rebate optimization; freight allocation; catalog/SKU rewrite. **Never cut:** supplier identity, staged approval, immutable observations, the §6c retirement of the legacy write path.

## 9. Open owner decisions

1. **Approve this architecture** (observation layer + never-auto-change-sell-prices + owner-controlled worksheet; adversarially hardened rev 4, manual-ingestion rev 5). Recommended: yes.
2. **Vendor merges — SETTLED 2026-07-17 by Mason:** both pairs ARE the same vendor; merge them. (His reply named "The Anderson's and Van Deist." Recommended canonical display spellings: the companies' official ones — **"The Andersons"** and **"Van Diest"** — with the other variants preserved as aliases, which the alias system keeps searchable either way. If Mason prefers his spellings as the display names, one word overrides this.)
3. **Priority** — moot: Mason launched the Codex build 2026-07-16; Phase 1a built overnight.

*(SETTLED 2026-07-16 by Mason: no AI/OCR extraction of supplier PDFs — manual staged entry only. This also removed the Anthropic-API-key and PDF-sample-corpus asks from this project; the vendor-bill pilot's key need is unrelated and stands on its own.)*

## 10. What Mason sees, per want (alignment check)

| Mason's want | Delivered by |
|---|---|
| A. Compare 2–3 suppliers, know who's cheapest | §4a comparison surface (normalized or "cannot compare"), Phase 1b |
| B. Price history per product per supplier | §5 supplier-filterable history view + PO backfill, Phase 1b |
| C. Monthly PDF price sheets | §6 supplier quote sheets (transcribe from PDF into a prefilled .xlsx, staged + reviewed), Phase 1b — AI extraction parked by Mason's decision |
| D. Tote/no-return variants, scalable | §7 families + enforcement, Phase 3 |
| E. Replacement cost vs actual cost, pre-season | §3 dual display with honest labels (§5a), Phases 1a–1b |
| F. Spreadsheet control of pricing | §6b atomic round-trip, Phase 1a |
| G. Whole-product editing on the same sheet | §6b fixed product-info contract incl. NEW `quoting_notes`, Phase 2 fast-follow |

## 11. Adversarial review record (2026-07-16)

Codex gpt-5.6 reviewed rev 3 adversarially (full context of Mason's wants; read the plan + code read-only). Verdict: architecture right, rev 3 not approvable as written. All three BLOCKERs and all HIGH/MED findings were accepted and folded into this rev 4: legacy BulkPricingImport write path must be retired first (→ §6c, Phase 1a); worksheet needed atomic versioned apply + one pricing mode per row (→ §6b); "on-hand weighted average cost" was not computable and is now honestly labeled (→ §5a); plus comparability model (§4a), reviewed legacy vendor resolution, single history writer, DB-enforced immutability, .xlsx format contract, alias review, SKU-gated link reuse, RPC money boundary, real-PDF acceptance corpus, family enforcement, and the safety-first phase re-cut (§8). Both models jointly defend: no merging of variant rows, observation/cost-basis separation, human review before observations count, no automatic sell-price changes, cheapest-as-recommendation-only.

**Rev 5 addendum:** Mason then decided to drop AI extraction entirely (§6) — a strictly risk-reducing change relative to the reviewed rev 4 (it removes the extraction failure modes; every remaining ingestion path is human-entered + staged + reviewed). The rev-4 safety machinery (staging, review gate, atomic worksheet apply, §6c retirement) is unchanged.
