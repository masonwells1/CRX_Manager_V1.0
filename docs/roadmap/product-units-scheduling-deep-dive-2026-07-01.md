# Deep Dive: Product Master · Units · Job Scheduling · Inventory (vs Chem-Man)

**Date:** 2026-07-01 · **Status:** RESEARCH ONLY — no code changed. Plan awaiting Mason's OK.
**How it was produced:** 6 parallel read-only analysts (product master, job scheduling, field application, inventory, live DB, units audit) + a completeness critic (7 agents, ~1.17M tokens), plus a live logged-in walkthrough of Chem-Man (job schedule list, edit-job screen, loader worksheet, inventory menu) via Mason's Chrome session.

---

## 1. Headline findings (all verified with file:line or live SQL)

### Rate unit is free text everywhere that matters — and it's already biting
- Product master "Rate Unit": bare text input — `ProductDetail.tsx:470`
- Job chem grid "Rate Unit" **and** "Unit": text inputs — `JobDetail.tsx:2964`, `JobDetail.tsx:2986` (placeholder `pt\ac`)
- LabelReview max-rate unit: text input — `LabelReview.tsx:751`
- Field-app invoice line: unit is **read-only inherited** from the product — no way to fix it at entry (`FieldAppChemicalEntry.tsx:448`)
- The ONLY real rate-unit dropdowns: QuoteBuilder (`QuoteBuilder.tsx:2721-2737`, driven by `unit_conversions`, filtered by product form) and the dead CropPrograms feature (its own divergent hardcoded list, `CropPrograms.tsx:514-519`).
- **Live data proof:** products.rate_unit = `oz` 493 · `Dry oz` 75 · NULL 22 · `''` 8 · `MG` 3 · `qt` 2 · `LB` 1. A real job line has rate_unit = **"32"** (a number typed into the unit box). Three inconsistent unit vocabularies coexist (products bare units, CropPrograms `/acre` forms, unit_conversions rows).
- Free-text units already caused shipped money bugs: the ~128× field-app overbilling (PARKED-010, fixed 20260630180000), the ~8× autofill inflation, the gal-display /128 bug, and the 490-products `oz` data patch (20260331300000).
- A typo'd unit today does one of: silently converts with the wrong factor (pt-for-qt = 2× money, oz-for-gal = 128×), hard-blocks invoicing (`FIELD_APP_UNIT_UNCONVERTIBLE`), or **silently disables the max-label-rate guardrail** (`labelGuardrails.ts:127-131` → `cannot_compare`).

### The single worst correctness bug found: job completion corrupts inventory by the unit ratio
`complete_job` deducts `job_chemicals.quantity` (in RATE-base units, e.g. pints) from `inventory.quantity_available` (in the product's INVENTORY unit, e.g. gallons) with **zero conversion** (`20260630073344:242-253`). A 2 pt/ac × 120 ac job on a gallons-stocked product removes **240 "gallons" instead of 30**. The billing side of this exact class was fixed (20260630180000); the inventory side is still live. Same unconverted compare in `get_job_inventory_shortfalls` (20260702120000) and the DispatchBoard stock light (`DispatchBoard.tsx:417-424`). Job volume is still near zero → fix now, before the season, and no historical ledger repair is needed.

### Category is unmanaged free text with real drift
`products.category` has no CHECK/lookup; the edit form is a free-typing Combobox seeded from whatever strings already exist (`ProductDetail.tsx:111-117,315`). **Live:** 19 distinct values across 604 products, incl. 6 empty strings, `Foliar Nutrition & Liquid Fertilizer` (compound), and `Herbicide` = 6 rows while herbicides actually live under `Post Emergence` 91 / `Pre-Emerge Soybean` 84 / `Pre-Emerge Corn` 57 / `Volunteer Corn` 7. Data mixes two taxonomies: functional class AND application timing.

### Label/safety data is empty → guardrails run dormant
0/604 products have REI/PHI/signal word/max_label_rate (known owner item). The §5 max-rate guardrail + WPS outputs are built but functionally inert until the CSV loads — and until units are dropdowns, the comparator can be silently disabled by spelling.

### Job scheduling: rich data model, thin UI
jobs already carries schedule_date, scheduled_time, date_proposed, priority, applicator_id, vehicle_id, ground_crew, carrier_rate_gpa — but: product picker is a flat `<select>` over all 604 products (`JobDetail.tsx:2939-2943`); crop / warehouse / vendor on lines are free text (a `warehouses` table exists, orphaned); no calendar/day board (list + dispatch map only); weather fires only at completion (Jobs list "Wind Dir." column is a permanent `-`); two disjoint "batch" concepts (jobs.batch_id free text vs job_batches); invoice transfer seeds from PLANNED rate × acres and the office re-keys applied acres (double entry); crop programs are write-only (nothing consumes them).

### Critic's cross-cutting warnings (respect these when building)
1. **No save_product RPC choke point** — products are written by 4 independent client paths (form, inline table edit, CSV import, pricing import). UI dropdowns alone won't stop re-pollution; DB-side trigger validation (extend the existing `validate_product_units` pattern) is the real guard — but only AFTER backfill, or every edit to a dirty row starts failing.
2. **Treat `unit_conversions.unit` strings as frozen keys** — `save_quote` joins `LOWER(rate_unit)=LOWER(unit)` for stored quote lines; `field_app_priced_quantity` has an identity branch + hardcoded factor tables. RENAMING existing unit rows can silently rescale money (the 128× class in reverse). Add synonyms/canonical columns; never rename rows.
3. **Snapshots are everywhere** — unit strings are copied onto quote_items, invoice_items (POSTED financials — never rewrite), application_records JSONB. Backfill scope = products + non-completed jobs' chemicals + draft/sent quote lines ONLY; history normalizes at display via the existing synonym maps.
4. **Category rename re-buckets history** — sales report RPCs join `products.category` LIVE (`20260307200000`). Mason must sign off the remap as a business decision.
5. **Two hand-mirrored synonym maps** (`labelGuardrails.ts:58-69` and SQL `normalize_rate_unit` 20260630170000) + 4 hardcoded chemCalculator tables must not drift — single-source them.
6. **E2E blast radius** — fixtures hardcode `Herbicide`/`qt`/`pt`/`oz`; free-text `fill()` locators break when inputs become selects (the select pattern already exists at `workflow-admin-full-lifecycle.spec.ts:148-150`). Update tests in the same PR.
7. `convert_to_gl_lb` client-vs-server drift: TS accepts `pints`/`quarts`, SQL only `PT`/`QT` → previews show a gal-equivalent that saves as NULL. One additive CREATE OR REPLACE.

---

## 2. What Chem-Man does that we verified live (inspiration tour)

**Job list:** color-coded job TAGS; Tot. ac vs **Rem. ac** (partial completion); chemicals + rates inline per job; MASS EDIT; MAP-select; JOB BATCHES; CHEMICAL SUMMARY REPORT (total product needed across selected jobs); PRINT; dispatch & applicator view.

**Edit Job (5 tabs: Locations · Chemical/Charges · Loader Worksheet · Applied Info · Notifications):**
- Locations rows: acres, planted vs **Applied** input, WIND button, Crop/Strip/Pests dropdowns; add temporary location.
- Chemicals: every line = searchable product picker + **Warehouse dropdown + Vendor dropdown + Rate/ac + UM DROPDOWN + auto-computed Total Applied with automatic FL-OZ→GL conversion shown underneath**.
- **Recipes**: save the current mix as a named recipe; "use last used recipe".
- **Live max-rate warning banner** ("The following chemicals are set to be applied above the maximum… Citric Acid (1 OZ)") — the product-master Max Applied Rate doing its job.
- Job-level Diluent Rate, Hours Reentry, Days Preharvest (auto from products).
- **Loader Worksheet:** applicator + vehicle + tank capacity + rate/ac → number of LOADS (mix sheet math).
- **Applied Info:** running "X of Y acres remaining", weather capture (Visual Crossing), append applied records.
- **Notifications:** send/track customer notices from the job.

**Inventory module:** unposted vs posted additions/deductions, Chemical History, **Quantity on Hand**, **Inventory Reorder Report**, Inventory Cost Report, Adjustments.

**CRX already has (parity or better):** recipes (blend recipes), mass edit, job tags?, map dispatch, stock light, WPS/proof notification, REI/PHI/signal-word/RUP fields, max-rate guardrail (§5), tier pricing, cost history, loader-worksheet math, applied-acres divergence flag. **The gap is mostly: dropdown discipline, category taxonomy, per-line warehouse/vendor, calendar view, and default-rate plumbing.**

---

## 3. The plan (phased; each phase independently shippable)

### Phase 1 — Units become dropdowns + data cleanup (the foundation) — **RECOMMENDED START**
1. `src/lib/units.ts` canonical units module backed by the existing `unit_conversions` table (fetch-once, cached options, one conversion helper). chemCalculator/quoteCalc tables become derived. SQL fns stay authoritative for saved money. (M, no migration)
2. Product master Rate Unit → dropdown filtered by product_form (S, frontend-only; grandfather existing values as a shown-but-deprecated option). `ProductDetail.tsx:470`
3. Job grid rate_unit → dropdown; **`unit` auto-derived/read-only** (reconcileChemAutofillUnits already forces it). (M) `JobDetail.tsx:2964,2986`
4. Field-app line UM → editable dropdown limited to units convertible to the product's inventory unit; add qty-driver like the job grid. (M)
5. LabelReview max-rate-unit + CropPrograms → same source list. (S)
6. **Read-only unit-drift report** (DISTINCT strings that don't normalize) → Mason eyeballs → one UPDATE migration normalizing products (+2 job rows; the `"32"` row needs his call). Live migration ⇒ owner gate + Codex. Backfill BEFORE any DB enforcement.
7. Normalize-on-save in BulkProductImport/BulkQuoteImport + (after backfill) extend `validate_product_units` trigger to rate_unit — the HARD guard. (M, migration, gated)
8. E2E fixtures/locators updated in the same PR.

### Phase 2 — Category taxonomy (needs Mason's list sign-off)
- New RLS'd `product_categories` lookup table, seeded; strict select + admin type-to-add; remap of the 19 live values (owner-approved mapping; note: sales reports re-bucket history on rename — business call).
- **Recommended two-axis design** (his data already mixes them):
  - `category` = functional class: Herbicide · Insecticide · Fungicide · Nematicide · Miticide · Plant Growth Regulator · Defoliant/Desiccant · Seed Treatment · Biological · Inoculant · Adjuvant/Surfactant · Drift Control · Water Conditioner · Foliar Fertilizer · Liquid Fertilizer · Dry Fertilizer · Micronutrient · Nitrogen Stabilizer · Soil Amendment · Charge/Service · Other
  - optional `use_timing` tag: Burndown · Pre-Emerge Corn · Pre-Emerge Soybean · Post-Emergence · In-Furrow · Foliar · Range/Pasture/Turf · Volunteer Corn · Cover Crop
- Category filter lands in the job-grid product picker (see Phase 4.1) so cleanup pays off daily.

### Phase 3 — Correctness fixes enabled/required by units (SQL, all gated: migration-review + Codex + owner OK)
1. **complete_job inventory deduction converts to inventory units** (reuse `field_app_priced_quantity` conversion) — do before job volume grows. Also `get_job_inventory_shortfalls` + DispatchBoard compare in converted units ("Layer 1.5", optionally + same-day demand aggregation).
2. `convert_to_gl_lb` pint/quart aliases (additive).
3. Cross-unit conversion inside `compareToMaxRate` (frontend, warn-only) so the guardrail fires on real mismatches instead of going blind.
4. Re-reconcile job-grid price basis on manual unit edit (mostly moot once dropdowns land).

### Phase 4 — Scheduling office wins (mostly frontend)
1. Searchable, category-filtered product picker on the job chem grid (S — reuse FieldAppChemicalEntry type-ahead).
2. **Wire crop programs into jobs** ("Apply Program" filtered by the job's crops — Chem-Man recipes/crop-overrides analog; the store exists, nothing consumes it). (M)
3. Duplicate Job / job templates (S). 4. Warehouse/vendor/crop dropdowns bound to warehouses table / product vendor / crop list (S). 5. Merge the two batch concepts (S).
6. Calendar/day dispatch board, per-applicator lanes, drag-to-reschedule (writes = what Mass Edit already does). (L)
7. Forecast weather strip on schedule (Open-Meteo at field centroid for job_date; fills the dead Wind Dir. column). (M)
8. Auto-seed invoice applied-acres from as-applied records (kills the double entry; money path ⇒ gated). (M)

### Phase 5 — Chem-Man parity extras on the product master (later)
Min charge · Apply-Default-Rate-As (rate vs total) · Sensitive Crops · Re-Entry PPE · per-crop rate/price overrides · density volume↔weight (fixes dry-product-dosed-in-fl-oz "cannot invoice" wall) · Reorder QTY + one-click vendor PO from low-stock panel · products.vendor_id FK · make warehouses real · expose max_label_rate on ProductDetail (today only editable via LabelReview).

---

## 4. Owner (Mason) decisions & tasks
1. **Approve Phase 1 start** (recommended) — UI work is reversible; the one data-cleanup migration comes back for explicit OK.
2. **Category list + remap mapping** — confirm/edit the Phase 2 list; approve which of the 19 old values maps where (affects historical report bucketing).
3. **Canonical rate-unit display** — recommend storing the bare unit (`pt`) with the UI labeling "/acre", matching the normalizer; alternative is storing `pt/ac`.
4. The job line with rate_unit `"32"` — what was meant (likely 32 oz/ac)?
5. Label CSV (0/604) — still the highest-leverage data task; guardrails go live the day it loads.

## 5. Build prep notes (for the implementing session)
- Run `/regen-schema-registry` first — session-start check shows the registry behind 11 newer migration files.
- Route through `/ship`; Phase 1 items 1–5+8 are frontend (no migration); items 6–7 and all Phase 3 items are migrations ⇒ migration-review + Codex + Mason's explicit OK per item.
- Respect critic warnings §1 (above): never rename unit_conversions rows; never touch posted invoice_items/application_records; backfill before enforcement.
