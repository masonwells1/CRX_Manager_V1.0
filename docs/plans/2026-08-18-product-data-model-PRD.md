# PRD — Product Data Model Rebuild

**Date:** 2026-08-18
**Owner:** Mason Wells
**Status:** DRAFT — **adversarial review COMPLETE** (Fable, 2026-08-18, read-only,
live-verified). Findings folded in below. Awaiting Mason's go.
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
| `epa_registration` filled | 300 |
| `return_policy` unknown / no_return / returnable | 581 / 21 / 2 |
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
- `rate_per_acre` feeds `applicatorSheetData.ts`, `applicatorSheetPdf.ts`,
  `blendMathValidator.ts`, `chemicalApplicationReport*.ts`, and `invoicePdf.ts`.

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

### Phase 0b — Return-policy admin screen *(split out of Phase 5; owner ranked it "asap")*

| # | Requirement | Acceptance |
|---|---|---|
| 0b.1 | Admin screen calling the existing `set_product_phase3_metadata` | A product's return policy changes from `unknown` and persists |
| 0b.2 | Bulk classification path for the 581 unknowns, applied in evidence-backed batches | 581 products classifiable without 581 individual interactions |

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
4. **Owner choice, not a technical question:** ship Phase 3 (the comparison tool) straight
   after Phase 1 with a typed-in rate, or wait for the Phase 2 rate correction. Faster
   payoff versus a cleaner sequence.
5. **Owner-only check:** confirm the Supabase connector in the Codex app's settings is
   live and appropriately scoped before the executor relies on live-database access. The
   tracked `.codex/config.toml` connector's OAuth grant was recorded dead (`invalid_grant`)
   on 2026-08-14.

---

## 10. Note on writing quality of this PRD

Every count in §5 was verified live and independently re-verified by the reviewer.
Statements the review found overstated or backwards have been corrected in place rather
than softened — specifically the return-policy enforcement scope, the `unit_size` money
risk, the `quoting_notes` "no code needed" freebie, and the Phase 2 → Phase 3 dependency.
Where a claim is a snapshot rather than a standing fact, it says so.
