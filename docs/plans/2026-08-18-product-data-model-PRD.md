# PRD — Product Data Model Rebuild

**Date:** 2026-08-18
**Owner:** Mason Wells
**Status:** DRAFT — **two adversarial review rounds COMPLETE** (Fable, 2026-08-18,
read-only, live-verified). Round 1 asked *"is this design sound?"* (yes, four amendments);
round 2 asked *"what is missing?"* (24 gaps). Both folded in below and marked
*(round 2)* / **[Round 2]** where they changed something. Awaiting Mason's go.
**Design source:** `docs/plans/2026-08-18-product-data-model-plan.md`
**Intended executor:** Codex (`terra`)

---

## 1. Problem

The product catalog is not under-built — it is **built and unfilled**, and the fields that
matter most for pricing decisions do not exist at all.

Two distinct failures:

**Unfilled.** Compliance fields, product-family fields, and a return-policy rule the
database enforces **in the returns pipeline** all exist, but no screen was ever built to
populate them. 581 of 604 products sit at return policy `unknown` — which, verified, blocks
nothing today; only `no_return` raises. `max_label_rate` is filled on zero products, which
makes Field Mode's "OVER LABEL RATE" block permanently inert. `quoting_notes` is wired
end-to-end into the Quote Builder and filled on zero products.

**Missing.** Active ingredients, concentrations, and **product density** are not stored
anywhere. Density's absence means the unit system has two disconnected ladders (liquid and
dry) with no conversion between them. The owner's entire brand-vs-generic pricing method
depends on all three.

The owner currently does this work by hand in a Google Sheet whose numbers are typed, not
computed, and therefore never recalculate when a cost changes.

---

## 2. Goals

1. Store active ingredients, their concentrations, and their mode-of-action codes per
   product, with an explicit acid-equivalent-vs-active-ingredient basis.
2. Store product density, enabling conversion between weight-basis and volume-basis
   concentrations.
3. Ship a comparison tool that answers: *which products contain ingredient X*, and *what
   does it cost to rebuild branded product Y from generics we stock*.
4. Make bulk data correction practical via an Excel round-trip, so 604 products are not
   edited one at a time.
5. Correct the rate model so customer-facing quantities stop being derived from an
   inconsistently-populated field.
6. Populate return policy, families, and packaging variants.

## 3. Non-goals

- No pricing, margin, or cost changes. No change to how quotes, orders, invoices, or
  inventory calculate anything.
- Not normalizing `products.vendor` into a foreign key (settled out of scope, 2026-07-16
  supplier pricing plan).
- Rates that vary by crop — real, deliberately deferred.
- Deferred by the owner on 2026-08-18: label max rate / REI / PHI, required fields on
  product create, tank-mix companion products, successor-product pointers, storage/freeze
  risk.

## 4. Users

Internal only. Sales/agronomy staff building quotes, and the owner doing pricing analysis.
No customer-facing surface changes except the *content* of quote notes and, later, product
images on quote PDFs.

---

## 5. Verified current state

Every fact below was verified read-only against Supabase project `rhyzpcqhnizqbxphqdkr`
on 2026-08-18. It is a **point-in-time snapshot, not a substitute for checking.**

**Codex does have live database access.** `.codex/config.toml` configures the Supabase MCP
against this project with `read_only=false` — read *and write*. Two caveats the executor
must resolve before relying on it:

- That tracked connector's OAuth grant was dead (`invalid_grant`) as of 2026-08-14.
- Codex's actual Supabase traffic flows through the Supabase App connector in the Codex
  app's own settings, whose scope is an owner-only toggle not represented in any repo file.

**The executor must re-verify these counts live before acting on any of them.** They will
have drifted. Where a number below is load-bearing for a decision, confirm it first and say
so. Do not cite this table as current evidence.

**Because Codex's connector is write-enabled, §8's approval gates are not advisory.** The
capability to apply a migration or mutate live rows exists; the authorization does not.
See §8.

| Fact | Value |
|---|---|
| Products total / active | 604 / 595 |
| `max_label_rate` / `rei_hours` / `phi_days` filled | 0 / 0 / 0 |
| `signal_word` filled | 95 |
| `is_rup` = true | 2 (owner: actual number is much higher) |
| `epa_registration` filled | 300 non-NULL — **13 are whitespace-only, so 287 usable** *(corrected in round 2)* |
| `return_policy` unknown / no_return / returnable / not_applicable | 581 / 21 / 2 / 0 — **the CHECK allows four values, not three** *(corrected in round 2)* |
| `product_form` liquid / dry / **blank** | 508 / 85 / **11** *(added in round 2)* |
| Product names with a parenthetical brand list | **129** *(added in round 2)* |
| Product names using the `" - <size>"` suffix | **561 of 604** *(added in round 2)* |
| `product_family_id` / `packaging_variant` filled | 0 / 0 |
| `is_full_tote_only` = true | 10 |
| `product_families` rows / `ingredient_map` rows | 0 / 0 |
| `notes` / `internal_notes` / `quoting_notes` filled | 444 / 443 / **0** |
| `suggested_rate` / `rate_per_acre` / `rate_unit` filled | 570 / 573 / 574 |
| Blank SKUs | 13 |
| Duplicate SKU groups / duplicate name groups | 1 / 3 |
| `unit_size` <> `inventory_unit` | 10 rows |
| `unit_conversions` rows | 14 |
| Density / specific-gravity columns, entire public schema | **0** |

**Structural facts verified in source:**

- `set_product_phase3_metadata` is the only function permitted to write `return_policy`,
  `product_family_id`, `packaging_variant`, `is_full_tote_only` (writes REVOKEd from app
  roles in `supabase/migrations/20260723193312_product_families_return_policy_foundation.sql`).
  It has **no caller anywhere in the application** — only test fixtures and generated types.
- `ingredient_map` is referenced only by `src/pages/BrandVsGeneric.tsx` and its tests.
- `quoting_notes` is wired: auto-fills the quote line (`src/pages/QuoteBuilder.tsx:1217`),
  editable per quote, reset-to-default button (`:3944`), preference helper
  `src/lib/quoteNotes.ts`.
- `apply_product_pricing_change_set` assigns `suggested_rate`, `rate_per_acre`,
  `rate_unit`, `use_timing`, `internal_notes`, `quoting_notes` and guards on
  `pricing_version`. The workbook round-trip for these fields is real, not export-only.
- The EPA lookup already returns `latestLabelPdfUrl` and a `labelPdfs[]` list with accepted
  dates (`src/types/index.ts:115`); the app validates and discards them. No label-URL
  column exists in any table.
- `unit_conversions` normalizes everything to a column named `factor_oz`. Liquid units and
  dry units both bottom out at `1`. There is no liquid↔dry conversion. `Ea` and `Unit` are
  stored as `unit_type='both'`, `factor_oz=1`.
- **[Round 2 correction] `rate_per_acre` is referenced by 82 files, not the 5 listed here.**
  The original list — `applicatorSheetData.ts`, `applicatorSheetPdf.ts`,
  `blendMathValidator.ts`, `chemicalApplicationReport*.ts`, `invoicePdf.ts` — badly
  understates it. It is also in the field app
  (`src/components/field-app/FieldAppChemicalEntry.tsx:304`), blend tickets
  (`src/components/blendtickets/ManualTicketCreate.tsx:262`), crop programs
  (`src/lib/cropProgramHelpers.ts:134`), blend recipes (`src/lib/recipeHelpers.ts:96`),
  quote product defaults (`src/pages/QuoteBuilder.tsx:1222`), jobs, statements,
  worker-protection notices and year-end PDFs. **Phase 2's risk framing rested on the
  undercount.** See plan §10.1.
- **[Round 2] Three product write paths exist, and the plan named one.** Single create at
  `src/pages/Products.tsx:843`, inline bulk save via `EditableDataTable`, and a **second,
  previously unmentioned CSV importer** at
  `src/components/products/BulkProductImport.tsx:229`, which inserts products directly and
  maps `suggested_rate` / `rate_per_acre` / `rate_unit` (lines 38–40).
- **[Round 2] Nothing in the app handles weight.** `density`, `specific gravity` and
  `lb_per_gal` appear zero times across `src/`. `blendMathValidator.ts` declares
  `ProductData.unit` and never reads it, so it sums quantities across mixed units.
- **[Round 2] `product_label_drafts` is a live propose-review-commit pipeline** with
  `LabelReview.tsx`, a status set, confidence, `reviewed_by` and `run_idempotency_key`
  (`src/types/index.ts:137-183`). It is the house pattern for machine-sourced data needing
  human sign-off — which is exactly what EPA ingredient seeding is.
- **[Round 2] Three customer price tiers already exist** — `tier1_price` … `tier3_price`
  and `tier1_price_per_acre` … `tier3_price_per_acre` (`src/types/index.ts:72-83`).

---

## 6. Requirements

Phase numbering matches the design plan. Each requirement states its acceptance criterion.
**Acceptance = the behavior was run and observed**, per the AGENTS.md Verification
Standard. A passing unit test is not acceptance.

### Phase 0 — Data hygiene *(moved to the front by the review)*

13 blank SKUs, 1 duplicate SKU group (`9768NR`, two Generic Liberty rows), 3 duplicate name
groups, `1A TEST PRODUCT - FAKE PRODUCT`. Each class reviewed and approved by the owner
before it runs. Runs first because the workbook and the 573-row rate review both otherwise
have to work around this in Excel.

**[Round 2] Mechanics, which the phase previously left undefined:**

| # | Requirement | Acceptance |
|---|---|---|
| 0.1 | **Deactivate or merge with a pointer — never hard-delete.** Duplicate and test rows may carry foreign-key history in quote lines, invoices and inventory movements, which makes a hard delete either impossible or silently destructive | For each row touched, its historical references still resolve afterwards |
| 0.2 | Normalize `epa_registration`: trim whitespace-only values to NULL | 13 whitespace-only rows become NULL; a subsequent "run the lookup on everything with a registration" batch does not fail on them |
| 0.3 | Classify the 11 blank `product_form` rows as liquid or dry | Zero blanks remain; density scoping in Phase 1 has a reliable key |

Deleting data is an approval-gated, irreversible act under `AGENTS.md`. If any class of row
genuinely warrants deletion rather than deactivation, that is a separate request to Mason
with the FK survey attached — not part of this phase's standing approval.

### Phase 0b — Return-policy admin screen *(split out of Phase 5; owner ranked it "asap")*

| # | Requirement | Acceptance |
|---|---|---|
| 0b.1 | Admin screen calling the existing `set_product_phase3_metadata` | A product's return policy changes from `unknown` and persists |
| 0b.2 | Bulk classification path for the 581 unknowns, applied in evidence-backed batches | 581 products classifiable without 581 individual interactions |
| 0b.3 | **The screen offers four values: `returnable`, `no_return`, `not_applicable`, `unknown`** | All four selectable. A three-value screen is a defect — the live CHECK allows four (`20260723193312_product_families_return_policy_foundation.sql:49`) |
| 0b.4 | **State which bulk mechanism is used and why.** `set_product_phase3_metadata` is strictly per-product with compare-and-set arguments (`p_expected_return_policy` and siblings), so bulk means either 581 read-then-CAS round trips with partial-failure and progress handling, or a new bulk RPC — the latter being a migration that pulls in the full RLS, idempotency and drift gate stack | The chosen approach is written down before code; partial failure leaves no half-applied batch |

**[Round 2] Return *windows* are out of scope — Mason, 2026-08-18.** Vendors do have
different return deadlines per product class, and Mason declined modelling them: *"on the
returns don't worry about that we send out paperwork on those dates we can keep system
simple on returns."* The four-value flag answers "can this ever come back"; deadlines stay
on paperwork. **Do not build a vendor × class × date table.**

**Risk note the executor must respect:** classifying does **not** unblock transactions.
`unknown` blocks nothing today; setting `no_return` **starts** blocking. A misclassification
refuses a legitimate return or wrongly accepts one — real money either way.

Depends on nothing in Phases 1–4. May run parallel with Phase 1.

### Phase 1 — Ingredient foundation, mode of action, density

| # | Requirement | Acceptance |
|---|---|---|
| 1.1 | Active ingredients stored per product with concentration value, unit, and an explicit `acid_equivalent` vs `active_ingredient` basis | Open a product in the running app, add three ingredients, save, reload — all three persist with basis intact |
| 1.1a | **`active_ingredients` carries `canonical_ingredient_id` (self-FK) and `ae_fraction`.** EPA salt-form names (`glyphosate, isopropylamine salt` etc.) are seeded as rows pointing at the parent acid; all search and grouping goes through the canonical id | Seed the three glyphosate salt forms; one search for "glyphosate" returns **every** product carrying any of them |
| 1.2 | Mode-of-action codes in an **`ingredient_moa_codes` child table** (`active_ingredient_id`, `scheme`, `code`) — not scalar columns. Herbicides use the **numeric global HRAC code only** | An ingredient with two codes stores both; a product with ≥4 codes renders all of them, scheme-labeled |
| 1.3 | Product density stored with value, unit, and source (`label`/`sds`/`supplier`/`measured`/`assumed`) | Density saved and re-read on a real product |
| 1.3a | **Density validation is a warn band (~6.5–14 lb/gal), never a hard reject.** Required only for liquid products with weight-basis concentrations or liquid↔dry comparison — not a 604-row mandatory backfill | Enter 7.7 lb/gal (a real crop-oil density): saves, with at most a warning. **A hard 8–12 reject is a defect** |
| 1.4 | EPA lookup persists the ingredients it already returns instead of discarding them, mapping salt forms to canonical acids | Run the lookup on a product with a known EPA number; ingredients land in the new tables under the right canonical ingredient |
| 1.5 | New tables have RLS enabled with policies in the same migration | Migration inspected; RLS-security review passes |
| 1.6 | Concentration unit is `lb_per_gal` or `percent_w_w` only. **`lb_per_lb` is excluded** — it is `percent_w_w` ÷ 100, the same axis twice | Constraint rejects `lb_per_lb` |
| 1.7 | Any new mutating RPC accepts **and enforces** `p_idempotency_key text DEFAULT NULL` | Replaying the same key does not double-write |
| 1.8 | "Copy ingredients/density from sibling" action on the product detail screen | A bulk row inherits the 2.5-gal row's chemistry in one action |
| **1.9** | **Brand rows beneath the sellable spec.** A child table on `products`: `brand_name`, **`epa_registration` per brand**, manufacturer, `label_url`, `density_value`, `is_currently_sourced`. The `products` row remains the sellable spec — quoting, tiers, pricing and inventory are unchanged | "Roundup 5.4# Generic" carries Ag Saver 5.4 and Slam 5.4 as separate brand rows, each with its own EPA number, and the product still quotes exactly as it does today |
| **1.9a** | **Record which brand actually filled the line** at order, receiving or delivery, so an application record carries the real EPA registration number of what was applied | A delivery records "Lima 6"; the application record shows Lima 6's EPA number, not the spec's |
| **1.9b** | Resolve whether the brand table and `product_families` are the same idea. Both exist to say "these are the same chemistry"; `product_families` has 0 rows and no writer, so either choice is free now | The build ships **one** mechanism, not two overlapping ones, with the decision recorded |
| **1.10** | **Complete fertilizer analysis** storable: primary macros (N, P₂O₅, K₂O), secondary macros (Ca, Mg, S) and micronutrients (B, Cl, Co, Cu, Fe, Mn, Mo, Ni, Zn), as `percent_w_w` | A liquid fertilizer stores a full guaranteed analysis, saves and re-reads. Combined with density it yields pounds of nutrient actually applied |
| **1.10a** | Biologicals are stated in CFU and fit neither allowed concentration unit. Either add a CFU unit or leave the 9 biological products unstored — **do not force a CFU count into a percentage column** | Whichever is chosen is stated explicitly; no biological carries a nonsense percentage |
| **1.11** | **Formulation type and safener** captured, because identical ingredients at identical concentrations are not always interchangeable (SC vs EC vs OD; safened vs unsafened s-metolachlor) | A safened and an unsafened product with identical ingredient rows are visibly distinguishable |
| **1.12** | `concentration_value` nullability is stated explicitly, so *ingredient present, amount unknown* is distinguishable from *ingredient missing* | A product with a known ingredient and unknown amount saves, and Phase 3 can tell the two cases apart |
| **1.13** | Persist the registration-status signals the EPA lookup already returns — `productStatus` and `isCancelled` (`src/types/index.ts:130-131`) | A cancelled registration is visible in the app without re-running the lookup |
| **1.14** | Every new table carries `updated_at` and its trigger | The `tables_without_updated_at` drift check passes |
| **1.15** | Nickname is searchable on the Products page (`searchKeys`, `src/pages/Products.tsx:862`) and in the QuoteBuilder product picker | Typing "Generic Callisto" finds the product |
| **1.16** | Edits to ingredients, density and analysis are audited (who, when, old value, new value), following the `cost_history` precedent | Change a concentration, then show the prior value and who changed it |

**[Round 2] Density is operational, not analytical — this changes 1.3 and 1.3a.**
Mason: *"I need that also because we do a lot of blending based off scales so have to have
weight of everything for scales and mixer."* Therefore:

- **Scope widens from ~300 EPA-linked liquids to all 508 liquids**, because the products
  blended most are fertilizers, which carry no EPA registration. Dry products additionally
  need a net weight per purchase unit where that unit is a package rather than a weight.
- **The warn band applies to entry, not to use.** 6.5–14 lb/gal warn-never-reject stays
  correct when *typing a density in*. But when the app is asked to produce **a weight for a
  scale** and the product has no density, it must **refuse and say so** — never fall back to
  water, a default or an estimate. Warning on entry and blocking on use are different jobs.
- **`"5.4#"` is an ingredient concentration, not a density.** It is pounds of glyphosate salt
  per gallon; the product itself is roughly 10.2 lb/gal. Conflating them produces scale
  weights wrong by about half. The 5.4 vs 5.5 pair in the live catalog is also an
  `ae_fraction` case — 5.5# products are the potassium salt, 5.4# the IPA salt.
- **Phase 1 is done when the mechanism works, not when the catalog is full.** Mason parked
  the backfill (*"Let's wait on that for now I don't have time"*). Acceptance is: one product
  can be given a density and read back, and a missing density blocks a weight rather than
  guessing.

### Phase 1b — Product Data Workbook

| # | Requirement | Acceptance |
|---|---|---|
| 1b.1 | Excel export covering the full product-data column set, extending the existing workbook machinery rather than replacing it | Download a workbook, confirm columns present |
| 1b.2 | List-type data (ingredients, crop uses) exported as separate tabs keyed by product, never as delimited strings in one cell | Halex GT occupies 3 rows on the Ingredients tab |
| 1b.3 | Upload reuses the existing row-version guard, preview screen, and archive safety | Edit a product in the app while a workbook is open, then upload — that row is refused, not silently overwritten |
| 1b.4 | Upload lands in a preview before anything saves | Preview shows every intended change; cancelling writes nothing |

### Phase 2 — Rate model correction + unit standardization

| # | Requirement | Acceptance |
|---|---|---|
| 2.1 | **`product_rates` child table** — `product_id`, `basis` (`per_acre`/`per_100_gal`/`per_unit`), `source` (`label`/`house_standard`), `low`, `high`, `recommended`, `unit`, `is_quoting_default`. **Not columns on `products`** | MSO XL stores **two** rows: `2 qt/100 Gal` (label) and `9.6 oz/acre` (house standard). Columns cannot represent this — a single-row-per-product shape is a defect |
| 2.2 | Partial unique index: exactly one `is_quoting_default = true` row per product, constrained to `basis = 'per_acre'` | Attempting a second default, or a non-per-acre default, is rejected by the database |
| 2.3 | **Quotes read only the per-acre quoting-default row.** A product without one gets **no rate autofill — blank, not a number** | A per-unit-only product autofills blank on a quote line, not a wrong figure |
| 2.4 | A filled rate with a blank unit is rejected | Cannot save a rate value with no unit (30 products have a blank `rate_unit` today, and an unknown unit silently becomes ounces) |
| 2.5 | `suggested_rate` free text retained during transition as the audit trail | Original text still readable after migration |
| 2.6 | Re-derived rate values reviewed by the owner before being written. **No bulk auto-rewrite.** | Owner approves the value set; applicator-sheet quantity for a known product matches expectation before and after |
| 2.7 | Unit spellings consolidated (`Oz`/`oz`, `LB`/`Lb`, `Qt`/`qt`, `Unit`/`Ea`) | Spot-check: a quote's total is byte-identical before and after the remap |
| 2.8 | Alias rows consolidated **out of `unit_conversions` itself** — the live `save_quote` join is `LOWER(unit) = LOWER(rate_unit)` against a table holding both cases, which matches two rows and duplicates the base row. **Do not change any conversion factor in the same change** | Join returns one row per unit; quote totals unchanged |

**Scope note:** the rate correction propagates **forward only.** Quote lines copy the rate
at add-time and `save_quote` recomputes from the line's own value, so existing quotes and
invoices do not retroactively change. The exposure is new documents defaulting from a
wrongly re-derived number.

### Phase 3 — Comparison tool

| # | Requirement | Acceptance |
|---|---|---|
| 3.1 | Search products by active ingredient, **resolved through `canonical_ingredient_id`** | Searching glyphosate returns products carrying **any** salt form, not a partial list |
| 3.2 | Search/filter by mode-of-action group | Group filter returns the expected set |
| 3.3 | Build-from-generics cost comparison, read-only, no writes | **Halex GT at 4 pt reproduces the owner's sheet: 33.44 oz generic Roundup, 3.34 oz generic Callisto, 1.09 pt generic Dual** |
| 3.4 | Mixed weight/volume products compared correctly using density **and `ae_fraction`** — density alone converts `% w/w` to lb *salt*/gal, not to acid equivalent | A `% w/w` salt-basis product compares correctly against a `lb ae/gal` product |
| 3.5 | **Coverage gaps surfaced loudly, never silently dropped.** If no stocked generic carries one of the branded product's ingredients, the tool says so instead of omitting it from the total | Reproduce the "Resicore REV" case: the tool reports the missing ingredient rather than pricing an incomplete rebuild as complete |
| 3.6 | Unverified concentrations visibly marked using the existing `source` / `verified_at` fields | An unverified number is presented as unverified, not as fact |
| 3.7 | Money math parses to whole cents before arithmetic — no binary floating-point rounding (2026-08-10 decision) | Cost figures are exact |
| 3.8 | Old `BrandVsGeneric` page and `ingredient_map` table retired | Page gone, table dropped, no dead references |
| **3.9** | **Show both your cost and the customer price, with a selectable customer tier** (Mason, 2026-08-18). Three tiers already exist — `tier1_price` … `tier3_price` and the per-acre variants (`src/types/index.ts:72-83`) — so no new schema | Switching the tier selector changes the customer-price column; the cost column does not move |
| **3.10** | **A visible on-screen note that the comparison excludes adjuvant cost.** Mason declined pricing the adjuvant delta; the exclusion still has to be stated, because rebuilding a loaded branded product from unloaded generics understates the generic route's true cost | The note is present wherever a build-from-generics total is displayed |
| **3.11** | **Show the result when the generic build is more expensive**, plainly, rather than suppressing it | A case where the build costs more displays the higher figure |
| **3.12** | **Salt and ester forms warn, never silently substitute.** Family matching keys on the specific ingredient row, not the canonical parent — 2,4-D ester and amine share a canonical acid and are not field-interchangeable, and the same holds for dicamba DGA vs BAPMA. Mason: *"Warn loudly we pretty much only use ester"* | Proposing an ester↔amine swap raises a prominent warning; it is never applied silently |
| **3.13** | **Safener, formulation type and built-in adjuvant load surfaced on any equivalence claim** | An unsafened generic proposed against a safened branded product carries a visible caution |
| **3.14** | Restricted-use status displayed under the same "unverified" marking rule as 3.6 — `is_rup` is known wrong (2 flagged; Mason: *"there are a lot more"*) | RUP status never presented as verified fact |

**Phase 3 is not blocked by Phase 2.** The comparison divides *concentrations* and takes the
branded rate as an input — it never reads `rate_per_acre`, and can accept a typed-in rate
exactly as the owner's spreadsheet does. Shipping Phase 3 straight after Phase 1 with a
typed rate is a valid option **for the owner to choose**, not a technical constraint.
Backfilling density likewise does not gate a first version: the Halex GT case is entirely
`lb/gal` and acid-equivalent basis and needs no density at all.

### Phase 4 — Label link, adjuvants, crop/timing, quoting notes

| # | Requirement | Acceptance |
|---|---|---|
| 4.1 | EPA label URL + accepted date persisted | Label opens from the product page on a product with an EPA number |
| 4.2 | Required/recommended adjuvant per product with type | Product requiring COC displays it; appears when quoting |
| 4.3 | Crop + timing stored as pairs (corn/pre-emerge and soybean/post-emerge are separate rows) | A product labeled pre-emerge on one crop and post on another displays both correctly |
| 4.4 | The three note boxes are visually distinguished, with the customer-facing one clearly marked | Owner can tell at a glance which box reaches the quote |

### Phase 5 — Product families *(return-policy half moved to Phase 0b)*

| # | Requirement | Acceptance |
|---|---|---|
| 5.1 | Families derived from matching ingredients+concentrations and proposed for owner approval, not typed by hand | App proposes groupings; owner approves before anything is written |
| 5.2 | **Derivation excludes products with zero ingredient rows** | Adjuvants and fertilizers (no ingredients recorded) do **not** collapse into one giant false family |
| 5.3 | **Family-drift check:** flag any family whose members disagree on ingredient set or density | A bulk row and a 2.5-gal row of the same product with different densities is flagged, not silently averaged |
| **5.4** | **[Round 2] "Same ingredients" is not "interchangeable."** Derivation must account for safeners, formulation type (SC/EC/OD) and built-in adjuvant load, and must match on the **specific ingredient row** rather than the canonical parent so salt and ester forms do not collapse together | A safened and an unsafened product with identical ingredient rows are not proposed as one family without a visible caution |
| **5.5** | **[Round 2] Use the EPA distributor-registration signal.** Two catalog rows sharing a parent registration number are the same formulation — the cheapest reliable family evidence available, and currently unused | Products sharing a parent registration are proposed as a family |

### Phase 6 — *(moved to Phase 0)*

### Phase 7 — Retire `unit_size`

**Corrected rationale.** The earlier claim that this "feeds quote money math" and can move a
customer's price is **not true today**: the fallback (`inventory_unit || unit_size`, in both
the app and live `save_quote`) is dead code because `inventory_unit` is filled on all 604
products. The real risk is **breadth** — `unit_size` appears in 50+ files under `src/`, is a
pricing-workbook column, and is baked into database function bodies that must be re-emitted.

It still gets the full treatment: a fresh exact-SHA adversarial proof pinned to
`gpt-5.6-sol` at high reasoning effort, plus the owner's explicit approval.

**Additional requirement:** make `inventory_unit` NOT NULL (or defaulted) in the same
migration — otherwise a future product created without it re-arms the dead fallback.

### Phase 8 — Product images

Copy product images from the owner's website into CRX-owned Supabase storage, following the
existing `delivery_photos` / `receiving_photos` / `blend_ticket_images` pattern.
Explicitly last priority.

---

## 7. Hard constraints

From `AGENTS.md` — these are not negotiable and the executor must satisfy them:

- Database changes only as **new** files under `supabase/migrations/`. Never edit an
  applied migration.
- New tables enable RLS **and** include policies in the same migration.
- Mutating RPCs accept and enforce `p_idempotency_key text DEFAULT NULL`.
- `SECURITY DEFINER` functions use `SET search_path = public, pg_temp`.
- Money is exact whole cents. No binary floating-point money arithmetic.
- Inventory and financial invariants live in PostgreSQL RPCs/triggers, not only in React.
- `src/lib/db.ts` is the only Supabase client. `assertRpcResult()` after RPCs,
  `checkMutationResult()` after `.update()`/`.delete()`.
- `ConfirmModal` not `confirm()`. Toasts not `alert()`. Sentry only via `src/lib/sentry`.
- Shared types from `src/types/index.ts`, Lucide icons, Tailwind.
- Status values must match `.claude/schema-registry.json`.

**Concentration and density values are not money and must not be forced into cents.** They
are measurements; store them as `numeric` with enough precision, and do not reuse the
money-cents pattern for them.

---

## 8. Approval gates

The executor must stop and get the owner's explicit approval before:

- Applying any live database migration
- Any bulk write to live product rows (Phases 2, 5, 6 all touch existing data)
- Pushing, opening a PR, merging, or deploying
- Deleting anything, including dropping `ingredient_map` in Phase 3

A handoff never carries approval forward. Approval given to Claude in this session does not
transfer to the executing session.

---

## 9. Open items

1. ~~Fable adversarial review in flight.~~ **RESOLVED 2026-08-18.** Verdict: architecture
   sound, no redesign. Four substantive amendments folded in above — canonical
   ingredient + `ae_fraction`, `product_rates` child table, corrected density warn band,
   re-ordered phases. Full change list: plan §9.
2. ~~Schema sections provisional.~~ **RESOLVED** — §6 Phase 1 is final.
3. Restricted-use product count is known wrong (2 recorded, owner says materially more).
   Parked with the deferred label work, but the RUP compliance report must be treated as
   **known incomplete** in the meantime, not as a clean result.
4. ~~Owner choice: ship Phase 3 straight after Phase 1 with a typed-in rate, or wait for
   the Phase 2 rate correction.~~ **SETTLED by Mason 2026-08-18: after the rate cleanup.**
   His words: *"After rate cleanup it's not important intill a month from now."*

   **Two consequences the executor must respect:**
   - Phase 3 keeps its place in the sequence — **do not** shortcut it forward.
   - **The comparison tool has a real target date of roughly 2026-09-18.** Phases 0, 0b, 1,
     1b and 2 all land before it. If that schedule comes under pressure, the thing to
     protect is the *quality* of the Phase 2 rate review (573 values, owner-reviewed, no
     bulk auto-rewrite) — not the date. Raise a slip with Mason rather than rushing the
     rate correction, which is the one phase that can put wrong quantities on customer
     documents.
5. **Owner-only check:** confirm the Supabase connector in the Codex app's settings is
   live and appropriately scoped before the executor relies on live-database access. The
   tracked `.codex/config.toml` connector's OAuth grant was recorded dead (`invalid_grant`)
   on 2026-08-14.
6. **[Round 2] Blocking Phase 2, not Phases 0/0b/1: decide in writing what happens to
   `products.rate_per_acre`** once `product_rates` is the source of truth. 82 files read it.
   The options — keep and sync it from the quoting-default row, dual-write, or rewire all
   82 consumers — differ enormously in cost, and choosing late is what turns Phase 2 into a
   multi-week surprise. See plan §10.1.
7. **[Round 2] Also blocking Phase 2: decide the fate of the three product write paths**,
   including the previously unmentioned CSV importer at
   `src/components/products/BulkProductImport.tsx:229`. After Phase 2 a product created
   through any of them has zero `product_rates` rows and autofills blank. Extend, gate or
   retire each — and say where the blank-unit rejection lives. See plan §10.2.
8. **[Round 2] Blocking Phase 1b: does an absent row in the `Ingredients` / `Crop Uses`
   tabs mean delete, or ignore?** The hardest question in any bulk round-trip, and currently
   unanswered. Related: `pricing_version` guards the `products` row only, so the child
   tables have no concurrency token and 1b.3's acceptance does not cover what the phase
   actually writes.
9. **[Round 2] Seed-treatment rate basis.** 18 products; real bases are per hundredweight of
   seed or per seed unit, and `per_unit` is ambiguous between "per each" and "per seed
   unit." Add the enum value in Phase 2 while it is free — widening a CHECK later is a
   migration.
10. **[Round 2] Per-phase rollback is unwritten.** Phases 1, 1b, 3 and 4 are additive, so
    rollback is "stop using it." Phases 0 (row changes), 0b (starts blocking returns) and 2
    (rewires quote autofill) need a real answer. Phase 2 behind a flag is the obvious
    mitigation; Phase 0b reverses through the same RPC that sets it.
11. **[Round 2] Effort is unestimated and the data-entry owner is Mason personally.** ~287
    products can auto-seed ingredients from the EPA lookup; density has no shortcut and is a
    safety-data-sheet lookup per product. This is tens of hours of owner time. Every phase's
    definition of done is the *mechanism*, never a filled catalog. Mason has parked density
    sequencing: *"Let's wait on that for now I don't have time."*
12. **[Round 2] Mason's Google Sheet is not an import source.** He confirmed it is *"not
    complete and is not automatic or have actual ingredients — it is still using brand
    product names of individual generic chemistries."* Useful as a seed for the brand
    shorthand layer; not a substitute for EPA ingredient data. Do not plan around importing
    it wholesale.

---

## 10. Note on writing quality of this PRD

Every count in §5 was verified live and independently re-verified by the reviewer.
Statements the review found overstated or backwards have been corrected in place rather
than softened — specifically the return-policy enforcement scope, the `unit_size` money
risk, the `quoting_notes` "no code needed" freebie, and the Phase 2 → Phase 3 dependency.
Where a claim is a snapshot rather than a standing fact, it says so.
