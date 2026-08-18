# Product Data Model — Implementation Plan

**Date:** 2026-08-18
**Status:** DRAFT — awaiting Mason's approval. No code written, no database changed.
**Revision:** amended 2026-08-18 after adversarial review (Fable, read-only, live-verified).
Changes from that review are marked **[REV]** and listed in §9.

---

## 1. What this plan is for

Mason ranked seven findings from the product-model review. This document turns that
ranking into a build order, states what each phase changes, and names the gates that
must pass before anything touches live data.

Mason's ranking (his words, condensed):

| His rank | Finding | His direction |
|---|---|---|
| **#2 — top** | Active ingredients not stored | "brainstorm how to store them… lead into our product comparison tool" |
| #3 | Families / packaging variants / return policy unpopulated | "make sure this gets fixed asap" |
| #4 | `unit_size` duplicates `inventory_unit` | "lets fix this" |
| #5 | Unit spellings inconsistent | "consolidate and standardize" |
| #6 | Data hygiene (dupes, blanks, test rows) | "yes we need to fix this" |
| #1 | Label rate / REI / PHI empty | "we will do this later" |
| #7 | Required fields on product create | "not concerned right now" |

---

## 2. Verified starting facts

Read directly from the live database on 2026-08-18. Read-only queries; nothing mutated.

| Fact | Value |
|---|---|
| Products total / active | 604 / 595 |
| `max_label_rate` filled | **0** |
| `rei_hours` filled | **0** |
| `phi_days` filled | **0** |
| `signal_word` filled | 95 |
| `is_rup` = true | 2 |
| `epa_registration` filled | 300 |
| `return_policy` = 'unknown' | **581** |
| `return_policy` = 'no_return' / 'returnable' | 21 / 2 |
| `product_family_id` filled | **0** |
| `packaging_variant` filled | **0** |
| `is_full_tote_only` = true | 10 |
| `product_families` table rows | **0** |
| `ingredient_map` table rows | **0** |
| Blank SKUs | 13 |
| Duplicate SKU groups | 1 |
| Duplicate product-name groups | 3 |
| `unit_size` <> `inventory_unit` | 10 rows |
| `unit_conversions` rows | 14 |

Also verified by code search:

- `set_product_phase3_metadata` — the **only** function permitted to write
  `return_policy`, `product_family_id`, `packaging_variant`, `is_full_tote_only` —
  has **no caller anywhere in the application**. It appears only in test fixtures and
  generated type files. There is no screen that can set these fields.
- `ingredient_map` is referenced only by `src/pages/BrandVsGeneric.tsx` and its tests.

**Unit spelling drift (live):**

- `inventory_unit`: Gal 492, Lb 65, Dry oz 17, Oz 11, Qt 8, Unit 7, MG 3, Ea 1
- `unit_size`: same set plus `LB` 1, and 8 blanks
- `rate_unit`: oz 493, Dry oz 75, empty/blank 30, MG 3, qt 2, LB 1

The drift is case-only (`Oz`/`oz`, `LB`/`Lb`, `Qt`/`qt`) plus one synonym pair
(`Unit`/`Ea`). No two spellings mean different things.

---

## 3. The problem in one paragraph

The product model is not under-built — it is built and unfilled. The database has
compliance fields, family/variant fields, and a return-policy rule that the database
enforces. **[REV]** That rule is narrower than first stated: it is enforced only in the
**returns** pipeline (`create_return`, `approve_return`, `receive_return`,
`issue_return_credit` all call `assert_phase3_return_policy`), **not** on orders — and it
only raises on `no_return`. `unknown` blocks nothing. So the 581 "unknown" products are
not stuck; they behave as returnable. But the screens that would fill those fields were
never built, and the Field Mode "over label rate" warning can never fire. Separately, active ingredients — the thing
Mason's whole pricing method depends on — are fetched from the EPA, shown on screen,
and then thrown away. There is nowhere to put them.

---

## 4. Design: how we store active ingredients

### The correction to my earlier description

I earlier described a three-layer model (ingredient → generic benchmark → real
product). Having checked the data, **the middle layer is unnecessary.** A benchmark
like "Generic Roundup 5.4#" is not a separate thing to store — it is a real product
already in the catalog, carrying a real glyphosate concentration. Once concentrations
are stored on real products, the benchmark is just a nickname. Two tables, not three.

### Two new tables

**`active_ingredients`** — the canonical chemical list, one row per chemical.

- `name` (unique) — e.g. `glyphosate`, `mesotrione`, `s-metolachlor`
- `cas_number`, `epa_pc_code` — identifiers the EPA lookup already returns
- `default_basis` — see below
- **[REV]** `canonical_ingredient_id` — self-reference. Salt-form rows point at the parent
  acid. See "the salt-name trap" below.
- **[REV]** `ae_fraction` — the number that converts a salt weight to acid equivalent.

**`product_active_ingredients`** — which chemicals are in which product, and how much.

- `product_id`, `active_ingredient_id`
- `concentration_value` + `concentration_unit` (`lb_per_gal`, `percent_w_w`)
  — **[REV]** `lb_per_lb` dropped: it is `percent_w_w` ÷ 100, the same axis written two
  ways, and two ways to write one thing is an entry-error generator. Pick one.
- `basis` — **`acid_equivalent` or `active_ingredient`** (critical, see below)
- `source` — `epa_lookup`, `manual`, or `import` — so we always know where a number came from
- `verified_by` / `verified_at`

Nicknames ("Generic Callisto") get a plain text column on `products`. No table needed.

### [REV] The salt-name trap — found by the review, and it would have broken the top use case

The EPA does not return "glyphosate." It returns **"glyphosate, isopropylamine salt,"
"glyphosate, potassium salt," "glyphosate, dimethylamine salt"** — separate ingredient
names for what a farmer calls one chemical.

If we seed the canonical list straight from EPA lookups with `name` as the unique key, we
get three or more different "glyphosates." Mason's headline query — *"show me everything
containing glyphosate"* — then returns a **partial list, with no error and no warning.**
That is the single worst failure mode this project can produce.

It also breaks the arithmetic. Converting an EPA salt percentage into the acid-equivalent
numbers Mason's sheet uses needs the salt-to-acid ratio (IPA salt ≈ 0.74, potassium salt
≈ 0.817, DMA salt ≈ 0.78). The `basis` column can *detect* that two rows disagree; it
cannot *reconcile* them. Nothing in the original design could.

**Fix — two columns, no new architecture:**

- `canonical_ingredient_id` — every salt row points at the parent acid row. All searching
  and grouping goes through the canonical id, so "glyphosate" means one thing.
- `ae_fraction` — multiply a salt-basis concentration by this to get acid equivalent.

### The acid-equivalent catch

Glyphosate is sold as a salt but measured two ways: total salt weight, and **acid
equivalent (ae)** — the actual weed-killing acid. Mason's sheet uses acid equivalent.
A "5.4# glyphosate" product is 5.4 lb salt but **4.0 lb ae** per gallon.

If we stored the salt number and compared it against an ae number, every glyphosate
comparison would be roughly 26% wrong — silently. Hence the `basis` column. It is not
optional and it is not cosmetic.

### The math, proven against Mason's own sheet

The rule is one division:

> (concentration in the branded product x rate) ÷ (concentration in the generic)
> = how much generic replaces it

Checked against three rows of Mason's `Branded Vs Generic Comparison Charts`, for
Halex GT at a 4 pt rate:

| Ingredient in Halex GT | Generic benchmark | Sheet says | Calculated |
|---|---|---|---|
| 2.09 lb ae glyphosate/gal | Generic Roundup 5.4# (4.0 lb ae/gal) | 33.44 oz | **33.44 oz** |
| 0.209 lb mesotrione/gal | Generic Callisto (4.0 lb/gal) | 3.34 oz | **3.344 oz** |
| 2.09 lb s-metolachlor/gal | Generic Dual (7.64 lb/gal) | 1.09 pt | **1.094 pt** |

Three for three, exact. There is no hidden logic to reproduce.

### Why compute instead of store

Mason's Google Apps Script was inspected in full (231 lines, `Crop Rx Pricing Tools.gs`).
It does four things: builds a menu, stamps a date and logs cost changes to a
`PRICE_HISTORY` tab, applies row borders, and copies a quote sheet with a `SUM` total.
**It contains no ingredient or brand-vs-generic math.** Every equivalence number in the
comparison chart was typed by hand.

That means those numbers never recalculate. The chart already shows the failure mode —
"Resicore REV (New Formulation of Resicore XL)" has ingredients listed but blank
equivalent rates. Storing concentrations and computing the equivalence removes that
whole class of silent staleness.

---

## 4b. Additional fields — settled with Mason 2026-08-18

### Rates — the current state is producing wrong numbers

`suggested_rate` is free text (570 filled); `rate_per_acre` is the number that actually
drives quantity on applicator sheets, chemical application reports, blend-math
validation, and invoices (573 filled). Where the text held a range, the number was
picked with no consistent rule — verified live:

| `suggested_rate` text | `rate_per_acre` stored | What that is |
|---|---|---|
| `12-16 oz/acre` | 12 | low end |
| `3-5 oz/acre` | 4 | midpoint |
| `32-44 oz/acre` | 34 | neither |
| `1-4gpa` | 320 oz (2.5 gal) | midpoint |
| `.5-2GPA` | 128 oz (1 gal) | neither |
| **[REV]** `Corvus 4-5.6` | 5.6 | high end |
| **[REV]** `Capture LFR 12-16 oz/acre` | 8.5 | **below the range entirely** |

**[REV]** The review re-checked these live. One row in the original table (`32-43 → 40`)
did not reproduce and has been dropped. The two rows added above are worse than anything
originally listed — including a stored rate that falls **below** the labeled range. The
problem is bigger than first described, not smaller.

Two different **kinds** of rate are also stored in the same field. `2 qt/100 Gal` is a
concentration, not a per-acre rate — **[REV]** it appears on **12 rows covering 6
formulations** (not twice), with 9.6 stored on 8 of them and 6 stored on the other 4.
`0.714 oz/unit` is per-unit.

**New shape — [REV] a child table, not columns on `products`.**

The original plan proposed one set of rate columns on `products`. The review caught that
this **cannot store what the next paragraph promises.** MSO XL needs *two* rates: the
label's `2 qt/100 Gal` and the house's `9.6 oz/acre`. One set of columns holds one or the
other — which is exactly how the 9.6-vs-6 split happened in the first place. Columns would
label the problem; they would not fix it.

**`product_rates`** — one row per rate a product has:

- `product_id`
- `basis` — `per_acre` | `per_100_gal` | `per_unit`
- `source` — `label` | `house_standard`
- `low`, `high`, `recommended`, `unit`
- `is_quoting_default` — exactly one true row per product, enforced by a partial unique
  index, and constrained to `basis = 'per_acre'`.

This also gives Mason's deliberately-deferred per-crop rates a home later with no
re-migration. The original plan claimed "adding it later does not require redoing this" —
**[REV]** that claim is only true in the child-table shape.

**[REV] Consumption rule — must be stated, was undefined.** Quote math consumes exactly
one per-acre number. Once `basis` exists, quotes read **only the per-acre quoting-default
row**. A product with no such row gets **no rate autofill — blank, not a garbage number.**
Without this rule, Phase 2 makes the semantics visible while leaving the math wrong. Today
per-unit seed treatments (`0.714 oz/unit` stored as `rate_per_acre = 0.71`) already flow
through the acres × rate path meaning something they don't mean.

**[REV] Reject a filled rate with a blank unit.** `getConversionFactor` returns 1 for an
unknown unit, and 30 products have a blank `rate_unit` today — so "unknown unit" silently
becomes "ounces."

**Adjuvant nuance (Mason, 2026-08-18):** many adjuvants are labelled as a concentration,
but CRX knows a normal per-acre rate and quotes off that. Store **both** — which the child
table now actually allows. Quoting behavior is unchanged: the house number is still what
quotes use. The point is that the app stops presenting a house assumption as a label fact.

### Product density — Mason 2026-08-18: "this is a MUST and we do not capture that yet"

**Confirmed absent.** A search of every column in the `public` schema for
density / specific gravity / lb-per / weight / net-weight returned **zero rows**. It is
not on `products` and it is not anywhere else.

**This is not a nice-to-have — it is a missing bridge that blocks the Phase 1/3 goal.**
Live contents of `unit_conversions` (14 rows) show two disconnected chains, everything
normalized to a column literally named `factor_oz`:

| Chain | Units | factor_oz |
|---|---|---|
| `liquid` | Gal 128, Qt/qt 32, Pt 16, oz/Oz/fl oz 1 | fluid ounces |
| `dry` | Lb/LB 16, Dry oz 1, g 0.03527396, MG 0.00003527396 | dry (weight) ounces |
| `both` | Ea 1, Unit 1 | neither — see below |

**A fluid ounce and a dry ounce both carry `factor_oz = 1`, and they are not the same
thing.** There is no conversion between the liquid and dry chains anywhere in the table.
Density *is* that conversion.

Concrete consequences for this plan:

1. **The comparison tool cannot work without it.** Labels state concentration two ways:
   `lb/gal` (volume basis) and `% w/w` (weight basis). Converting `% w/w` to `lb/gal`
   requires density. A product labeled "43.2% mesotrione" cannot be compared against one
   labeled "4 lb/gal" without it. The plan already lists `percent_w_w` as an accepted
   `concentration_unit` in §4 — that unit is unusable until density exists.
2. Dry formulations cannot be rate-compared against liquid ones at all.
3. Shipping/handling weight cannot be derived from a volume.

**Shape:** `density_value` + `density_unit` (`lb_per_gal` primary; allow `g_per_ml` /
`sg` and normalize) + `density_source` (`label` | `sds` | `supplier` | `measured` |
`assumed`).

**[REV] The proposed 8–12 lb/gal hard reject was wrong and would have corrupted data by
refusing it.** Crop oil concentrates and MSOs run about **7.6–7.8 lb/gal** — lighter than
water — so a hard floor of 8 would reject essentially every oil adjuvant in the catalog.
Some suspension concentrates and fertilizer solutions run **above 12**. Corrected:

- Warn band roughly **6.5–14 lb/gal**. **Warn, never reject.** Water at 8.34 stays the
  mental anchor, not the rule.

**[REV] Scope it — do not create a 604-row mandatory chore.** Density is needed only for
**liquid** products whose concentration is stored on a weight basis, or that take part in
a liquid-vs-dry comparison. A dry product's `% w/w` converts to lb ai per lb with no
density at all. The real need is roughly the ~300 EPA-linked liquids.

**[REV] One scalar per product is right**, and per-*product* is the right place (density
is a property of the formulation). Temperature swings it about 2–3%, well below quoting
tolerance, and settling does not change as-purchased bulk density. `density_source` stays.

**[REV] Density is necessary but not sufficient.** EPA `% w/w` for a salt, multiplied by
density, gives pounds of *salt* per gallon. Reaching the acid-equivalent numbers Mason's
sheet uses still needs `ae_fraction` from the salt-name fix above. Density and
`ae_fraction` are two halves of one bridge.

**Sequencing:** density moves into **Phase 1**, alongside the ingredient tables. It is a
prerequisite for the Phase 3 comparison tool. **[REV]** But *backfilling* it must not gate
Phase 3 v1 — the Halex GT case Mason cares about most is entirely lb/gal and
acid-equivalent basis and needs no density at all.

**Separate smell, noted not scheduled:** `Ea` and `Unit` are stored as
`unit_type = 'both'` with `factor_oz = 1`. "Each" is not an ounce. This makes any
conversion involving them arithmetically meaningless — **[REV]** and 8 products' quote
math currently divides by that fake factor. Related to the `Unit`/`Ea` synonym cleanup in
Phase 2; flagged so the cleanup does not silently bless it.

### [REV] `unit_conversions` has a latent duplicate-row join

`save_quote` joins `unit_conversions` on `LOWER(unit) = LOWER(rate_unit)`, and the table
holds **both** case variants (`Qt` and `qt`, `Oz`/`oz`/`fl oz`, `Lb`/`LB`). That match hits
**two rows** and duplicates the base row. It is harmless today only because the duplicate
factors are identical and the final update collapses identical values.

Phase 2 should consolidate the alias rows out of `unit_conversions` — with lowercase
matching they are pure redundancy. The original plan only discussed remapping the product
columns and never mentioned the table itself. **If the aliases are kept instead, never
edit a factor on one alias without the other.**

### Mode of action codes — Mason: "great idea"

Mode of action is a property of the **active ingredient**, not the product, so a product
with five active ingredients carries five codes with no extra structure. Mason confirmed
products with 4–5 codes exist and must be supported.

**[REV] Corrected shape — a child table, not two columns.** The original plan said "stored
on `active_ingredients`: `moa_scheme` + `moa_code`" and then, two lines later, "an
ingredient may carry more than one code." Two single-value columns cannot hold more than
one. Use:

**`ingredient_moa_codes`** — `active_ingredient_id`, `scheme` (`FRAC` | `HRAC` | `IRAC`),
`code`.

The scheme is required — a Group 15 fungicide and a Group 15 herbicide are unrelated and
must not collide. **[REV]** For herbicides store the **numeric global HRAC code only**;
the legacy letter codes and the current numeric ones coexist in the wild and mixing them
is a known mess.

The plan's original claim — that ingredient-level MOA handles 4–5-code products with no
extra structure — **survives**: a five-code product gets its codes through its five
ingredients. Only the column shape was wrong.

Serves Mason's stated use case directly: "old chemistry, has gotten weak on waterhemp" is
a resistance statement, and resistance tracking needs the group number.

### Required adjuvant — Mason: "some chemistry HAS to have a certain adjuvant"

Per product: adjuvant `type` (COC, MSO, NIS, AMS, drift agent, …), `requirement`
(`required` | `recommended`), optional note, optional link to a stocked product.
Most-commonly-forgotten item on a quote.

### Crop + timing — Mason: "some products can be used pre emerge only on certain crops but also post on 1 crop"

A **list of crop-and-timing pairs** per product, not a crop list plus a timing.
Corn/pre-emerge and soybeans/post-emerge are two separate rows. This is the only shape
that can express what Mason described.

**Deliberately out of scope for now** (Mason: "dont want to get to complicated"): rates
that vary by crop. Real, but deferred. Adding it later does not require redoing this.

### [REV] The packaging-sibling problem — every new field gets typed twice

In this catalog, pack sizes are **separate product rows**: "Callisto - 1 Gal" and
"Callisto - Bulk" are two of the 604. The `2 qt/100 Gal` label text sits on 12 rows for 6
formulations. So roughly half of the 604 rows are duplicates of another row's chemistry.

Ingredients, concentrations, density, MOA, crop/timing, adjuvant requirements and label
links are all properties of the **formulation**, not the package. Attaching them per
product row means **entering everything twice, and silent drift when the bulk row is
updated and the 2.5-gallon row is not.** That is the exact "silent staleness" failure this
plan was written to eliminate, reintroduced in a new place.

The clean entity is the product family — but families are derived *from* ingredients
(Phase 5), so we cannot attach to families first. Pragmatic fix, no redesign:

1. A **"copy from sibling"** action on the product detail screen, and a
   formulation-oriented Ingredients tab in the workbook.
2. **[REV] A family-drift check, added to Phase 5:** once families are derived, flag any
   family whose members' ingredient sets or densities disagree. Without it, the comparison
   tool will eventually give two different answers for the same chemistry in two pack
   sizes — confidently, and with no warning.

### Label link — Mason: "ok"

The EPA lookup already returns `latestLabelPdfUrl` and a full `labelPdfs` list with
accepted dates (`src/types/index.ts:115`); the app validates them and discards them.
No label-URL column exists anywhere in the database — verified across all tables.
Store the URL **and** the accepted date, so a newer EPA label can be detected.
Immediately covers the 300 products that have an EPA registration number.

### Product images — Mason: copy into CRX storage, LAST priority

Mason chose CRX-owned storage over linking to his website, so quotes and PDFs cannot
break if that site is restructured. Existing proven pattern to copy: `delivery_photos`,
`receiving_photos`, `blend_ticket_images`. **Explicitly scheduled last** — Mason: "save
this for the end or last, not a high priority at the moment."

### Quoting notes — already built, never filled

`quoting_notes` already exists and is already wired: adding a product to a quote
auto-fills it into the line's notes (`src/pages/QuoteBuilder.tsx:1217`), it is editable
per grower on that quote, and there is a reset-to-default button
(`src/pages/QuoteBuilder.tsx:3944`). Fill rate: **0 of 604**, against `notes` 444 and
`internal_notes` 443.

Nothing to build. What is missing is a screen that makes clear the three boxes are
different and which one reaches the customer.

**[REV] Correction, and it matters before any mass-fill.** The helper is
`quoting_notes || notes` — so **today, `notes` (444 filled) is what reaches the customer**,
as the fallback. Filling `quoting_notes` therefore **changes what auto-fills on every new
quote line** for every product where `notes` was doing the job. That is almost certainly
what Mason wants, but it is a **customer-visible change, not the inert freebie the plan
described.** Preview the before/after for those 444 products before applying.

### Bulk edit workbook — Mason 2026-08-18: "very hard to navigate all these products going one by one"

**A download → edit in Excel → upload → preview → apply round-trip already exists and is
live on the Products page.** Verified this session:

- `src/lib/productPricingWorkbook.ts` (748 lines) + `productPricingSupplierEvidenceWorkbook.ts`
- Wired at `src/pages/Products.tsx:517` (export) and `:560` (upload)
- Safety already built in: per-row `identity_fingerprint`, `row_token`, and `row_version`
  optimistic-concurrency guard; `_crx_manifest` sheet with an expiry; 5,000-row cap;
  10 MB file cap; zip-entry and uncompressed-size caps (`xlsxArchiveSafety.ts`); formula
  detection so an Excel formula cannot be applied as a value.
- Upload lands in a preview screen (`PricingChangePreviewModal.tsx`) before anything saves.

**It already round-trips six non-pricing fields** — `suggested_rate`, `rate_per_acre`,
`rate_unit`, `use_timing`, `internal_notes`, `quoting_notes`. Confirmed live that
`apply_product_pricing_change_set` actually assigns all six and guards on
`pricing_version`; they are not export-only.

**Immediate consequence:** `quoting_notes` (0 of 604 filled) can be mass-filled in Excel
today, with no new code.

**Not covered by the existing workbook:** category, vendor, manufacturer, container
size/type/unit, EPA registration, signal word, `is_rup`, return policy, family,
packaging variant — plus every field this plan adds.

**Decision: extend the existing machinery, do not build a second system.** Rebuilding
would mean re-earning the version guard, preview flow, and archive safety. The version
guard in particular is what prevents a bulk upload from silently overwriting an edit
someone made in the app while the spreadsheet was open.

**List-type data needs extra tabs.** A spreadsheet is one row per product, but
ingredients, MOA codes, adjuvants, and crop/timing pairs are lists (Halex GT has three
ingredients). Use a `Products` tab plus `Ingredients` and `Crop Uses` tabs keyed by
product — never a delimited string in a single cell, which is how bulk imports go
silently wrong.

**Sequencing consequence:** this lands **before** the Phase 2 rate correction. Reviewing
573 re-derived rate values is a sort-and-scan job in Excel and a punishing one in a
row-by-row UI.

### Rejected by Mason 2026-08-18

- **Companion / tank-mix partner products** — "good idea in theory but not universal
  enough to warrant building."
- **Successor product pointer** — "maybe, dont want to get to complicated lets not do
  this one."
- **Storage / freeze risk** — "skip it for now."

---

## 5. Build order

Ordered to follow Mason's ranking. **[REV]** The review found the original order buried
Mason's #3 ("asap") in fifth place and left cleanup until after two phases that have to
work around the mess. Three sequencing changes, all marked below.

### [REV] Phase 0 — Data hygiene, moved to the front (was Phase 6)

13 blank SKUs, 1 duplicate SKU group (9768NR, two Generic Liberty rows), 3 duplicate
names, and `1A TEST PRODUCT - FAKE PRODUCT` — which carries a bogus rate that would
otherwise get re-derived and reviewed like a real one.

**Why it moves first:** the workbook round-trip and the 573-row rate review both have to
scroll past this junk in Excel, and a duplicated SKU makes two rows genuinely hard to tell
apart in a spreadsheet. Hygiene is cheap and de-noises every phase after it.

**Risk:** Low, but it touches live rows — needs Mason's OK per class of change.

### [REV] Phase 0b — Return-policy admin screen (Mason's #3, "asap") — runs parallel with Phase 1

Split out of the old Phase 5. The return-policy half **depends on nothing** in Phases 1–4:
the RPC, its guards and its permissions are live today. Only the *family derivation* half
needs ingredients, and that stays in Phase 5. Mason ranked this "asap" and the original
order landed it fifth.

- Admin screen calling the existing `set_product_phase3_metadata` function.
- Bulk classification, so 581 products do not need 581 clicks.

**[REV] Risk — and the original plan had this backwards.** Classifying does not *unblock*
transactions; `unknown` blocks nothing today. Classifying **starts** blocking, for anything
marked `no_return`. So the failure mode is a legitimate return being refused, or a
no-return product wrongly accepted for return — real money either way. Mitigation:
classify in evidence-backed batches, mirroring the protocol the existing backfill migration
already used. Every change is reversible through the same RPC.

### Phase 1 — Ingredient foundation + mode of action (his #2, top priority)

**Goal:** every product can carry its active ingredients with concentrations and MOA codes.

- New migration: `active_ingredients` (including **[REV]** `canonical_ingredient_id` and
  `ae_fraction`) + `product_active_ingredients` + **[REV]** `ingredient_moa_codes`, all
  with Row Level Security and policies in the same migration (project hard rule).
- **[REV]** Seeding from EPA must map salt-form names onto their parent acid via
  `canonical_ingredient_id` — not create three "glyphosates."
- **Product density** (`density_value` / `density_unit` / `density_source`) — see §4b.
  Required here, not later: without it `percent_w_w` concentrations cannot be converted
  to `lb/gal` and the Phase 3 comparison tool cannot compare weight-basis against
  volume-basis products.
- Persist what the EPA lookup already returns instead of discarding it — ingredient
  name, CAS number, PC code.
- Product detail screen: view and hand-edit a product's ingredients.
- Importer for the `Branded Vs Generic Comparison Charts` data.

**Files:** new `supabase/migrations/*`, `src/types/index.ts`,
`src/pages/ProductDetail.tsx`, new ingredient components.

**Done when:** a product is opened in the running app, ingredients are added and saved,
the page is reloaded, and they are still there. Not "tests pass."

**Risk:** Low. Purely additive — new tables, no existing column changed, no money math.

**Gate:** RLS review + migration-drift review before apply. Live apply needs Mason's OK.

### Phase 1b — Product Data Workbook (extend the existing round-trip)

**Goal:** stop editing 604 products one at a time.

- Widen the existing workbook machinery (see §4b) to a full product-data column set.
- Add `Ingredients` and `Crop Uses` tabs for list-type data.
- Reuse — do not reimplement — the row-version guard, preview screen, and archive safety.

**Risk:** Medium. Bulk writes touch many rows at once; the existing version guard and
preview screen are the mitigations, which is precisely why they are being reused rather
than rebuilt.

**Note:** `quoting_notes` can be mass-filled through the *existing* pricing workbook
before this phase ships. No code needed.

### Phase 2 — Rate model correction + unit standardization

**Goal:** stop producing inconsistent quantities on customer-facing documents.

- **[REV]** Add the `product_rates` child table (see §4b) — *not* rate columns on
  `products`. Keep `suggested_rate` text during the transition as the audit trail of what
  was originally typed.
- **[REV]** Consolidate the alias rows out of `unit_conversions`, and do **not** touch any
  conversion factor in the same change.
- Re-derive each product's numbers from its `suggested_rate` text, **reviewed by Mason
  before anything is written** — the existing numbers are known-inconsistent, so this is
  a correction, not a mechanical reformat.
- Unit standardization (his #5) lands here: the drift is case-only (`Oz`/`oz`, `LB`/`Lb`,
  `Qt`/`qt`) plus the `Unit`/`Ea` synonym, conversion factors are identical, so remapping
  provably cannot move any price.

**Why before the comparison tool.** Technically this is a preference, not a hard
dependency — the comparison divides *concentrations* and takes the branded rate as an
**input**, never reading `rate_per_acre`, so it could run on a typed-in rate exactly as
Mason's spreadsheet does. **Mason settled it on 2026-08-18: the comparison tool comes after
the rate cleanup.** His words: *"After rate cleanup it's not important intill a month from
now."* So the rate correction gets the clean run, and Phase 3 targets roughly 2026-09-18.

**Risk:** Medium-high — `rate_per_acre` feeds applicator sheets, chemical application
reports, blend-math validation, and invoices. Every changed value is reviewed before it
is written; no bulk auto-rewrite.

**[REV] The correction propagates forward only — worth stating plainly.** Quote lines copy
`rate_per_acre` at the moment a product is added, and `save_quote` recomputes from the
line's own stored rate. **Existing quotes and invoices do not retroactively change.** The
exposure is limited to *new* documents defaulting from a wrongly re-derived number — which
is precisely what Mason's row-by-row Excel review in Phase 1b is there to catch.

### Phase 3 — Comparison tool (the payoff for #2)

**Goal:** "show me everything containing mesotrione" and "what does it cost to build
Halex GT out of generics."

- Read-only database function doing the division above. No writes, no pricing changes.
- New page: search by ingredient (**[REV]** via `canonical_ingredient_id`, so one search
  finds every salt form) and by mode-of-action group; build-from-generics cost comparison.

**[REV] The tool must say when it cannot answer.** If no stocked generic carries one of
the branded product's ingredients — the "Resicore REV" case this plan already cites — the
tool must **surface that gap loudly**, never quietly drop the ingredient from the total.
An incomplete rebuild priced as if it were complete is the single worst output this tool
can produce. Same rule for unverified concentrations: `source` and `verified_at` exist, so
the tool must visibly mark a number it has not had confirmed.

**Risk:** Low-medium. Read-only, but it displays cost figures, so the arithmetic gets
tested against Mason's sheet rows as the acceptance check.

**[REV] Money rule applies here.** This tool does money math in TypeScript over the legacy
numeric-dollar cost and tier-price columns. Per the 2026-08-10 decision, new authoritative
money math parses to whole cents before arithmetic — no binary floating-point rounding.
The original plan was silent on this.

### Phase 4 — Label link, adjuvants, crop/timing, quoting notes

**Goal:** the reference and recommendation fields Mason asked for on 2026-08-18.

- Persist the EPA label URL + accepted date already being fetched and discarded.
- Adjuvant requirement per product (type, required vs recommended).
- Crop-and-timing pairs per product.
- Surface `quoting_notes` properly so it is obvious which of the three note boxes reaches
  the customer, and fill it.

**Risk:** Low. Additive; nothing here changes existing calculations.

### Phase 5 — Product families — **[REV]** return-policy half moved to Phase 0b

- Families/variants: **derived, not typed.** Same ingredients at the same
  concentrations = drop-in equivalents. The app proposes the grouping; Mason approves it.
- **[REV] Derivation must exclude products with zero ingredient rows** — otherwise every
  adjuvant and fertilizer in the catalog, all of which have no ingredients recorded,
  collapses into one giant false "family."
- **[REV] Family-drift check** (see §4b): flag any family whose members disagree on
  ingredients or density. This is what stops packaging siblings from silently diverging.

**Risk:** Medium. Grouping the wrong products as equivalents would let the comparison tool
propose a substitution that isn't one. Mason approves each grouping.

### Phase 6 — *(moved to Phase 0 — see above)*

### Phase 7 — Retire `unit_size` (his #4) — deliberately late

`unit_size` duplicates `inventory_unit` and disagrees on 10 rows. It should go.

**[REV] The original justification was wrong, but the conclusion still holds.** The plan
said this is "the only change that can move a customer's price," via a fallback
(`inventory_unit || unit_size`) in both the app and the live `save_quote` function. The
fallback is real — but **`inventory_unit` is filled on all 604 products, so that path is
dead code today.** Retiring `unit_size` cannot move a price through it.

**The real reason it goes last is breadth, not money:** `unit_size` appears in 50+ files
under `src/`, is a column in the pricing workbook format, and is baked into database
function bodies that must be re-emitted. That still earns the full treatment — adversarial
cross-model review pinned to an exact commit, plus Mason's explicit approval.

**[REV] One addition:** a future product created without `inventory_unit` would re-arm that
dead fallback. The retirement migration should make `inventory_unit` NOT NULL (or give it
a default) in the same change.

### Phase 8 — Product images — LAST, at Mason's direction

Copy product logos/images from Mason's website into CRX-owned storage, following the
existing `delivery_photos` / `receiving_photos` / `blend_ticket_images` pattern.
Mason: "save this for the end or last, not a high priority at the moment."

### Parked at Mason's direction

- **#1 label rate / REI / PHI** — "later." Note: Field Mode has a working
  "OVER LABEL RATE" block that is inert because `max_label_rate` is 0/604. It stays
  inert until this is done.
- **#7 required fields on create** — "not concerned right now."

---

## 6. Explicitly not in scope

- No pricing changes. No margin changes. No cost changes.
- No changes to how quotes, orders, invoices, or inventory calculate anything.
- Not normalizing `products.vendor` into a foreign key — settled as out of scope in the
  2026-07-16 supplier pricing plan; not reopening it.
- No production deploy, live migration, or data mutation without Mason's explicit
  in-chat approval at the time.

---

## 7. Decisions — settled by Mason 2026-08-18

1. **`BrandVsGeneric` page — RETIRE.** Mason: "retire it and we will build a new page in
   future." The page and its empty `ingredient_map` table are removed; the replacement
   comparison page is built fresh in **Phase 3** (**[REV]** the plan previously said Phase
   2 here and Phase 3 in the build order — Phase 3 is correct). Do not extend the old page
   or its table. **[REV]** `ingredient_map` has 0 rows, so dropping it destroys no data —
   but it is still a live migration needing Mason's in-chat OK, and phrased as a table DROP
   it is hard-refused in an armed hands-free run. Schedule it for an interactive session.
2. **Build order — ingredient foundation first, CONFIRMED.** Mason: "i agree i want to do
   the ingredient foundation 1st." **However — Mason has additional design input on the
   plan before Phase 1 begins.** Phase 1 does not start until that brainstorm is captured
   and folded in.
3. **Phase 3 comes after the Phase 2 rate cleanup — SETTLED 2026-08-18.** Mason: *"After
   rate cleanup it's not important intill a month from now."* The comparison tool is not
   pulled forward, and it carries a soft target of roughly **2026-09-18**. Everything
   before it — hygiene, return policy, ingredients + density, the workbook, and the rate
   correction — lands first. If the schedule tightens, protect the owner-reviewed rate
   correction and slip the date; that phase is the one that can put wrong quantities on
   customer paperwork.
4. **Restricted-use products — the live count of 2 is WRONG.** Mason: "there are alot more
   but not important today." Parked with finding #1 (label rate / REI / PHI). When #1 is
   picked up, `is_rup` must be re-derived from EPA label data, not trusted as-is. Until
   then, treat the RUP compliance report (`src/lib/rupCompliance.ts`,
   `src/pages/Compliance.tsx`) as **known incomplete**, not as a clean result.

---

## 8. Cross-reference gate (before any code)

Per Mason's instruction — plan first, cross-reference, then build:

1. ~~Independent adversarial review of this plan against current source and live schema.~~
   **DONE 2026-08-18** — Fable, read-only, verified against live schema and current source.
2. ~~Specifically challenge: the two-table ingredient design, the acid-equivalent
   handling, the claim that unit remapping is price-neutral, and the claim that
   `set_product_phase3_metadata` has no existing caller.~~ **DONE.** Results: the two-table
   design **survived**; acid-equivalent handling was **incomplete** (see the salt-name
   trap); unit remapping **is** price-neutral, confirmed at both the app and database layer
   with identical factors for every alias pair; and `set_product_phase3_metadata` having no
   caller is **stronger than claimed** — direct writes to those four columns are blocked by
   both a column-level REVOKE and a BEFORE trigger, so nothing else *could* write them.
3. Findings returned to Mason in plain English before Phase 1 starts. **DONE.**

### [REV] Project hard rules the original plan was silent on

These are not optional and must appear in every phase that writes:

- **Row Level Security** on *all* new tables, in the same migration — including
  `product_rates`, `ingredient_moa_codes`, and the adjuvant and crop/timing tables.
- **`p_idempotency_key`** accepted *and actually enforced* by every new mutating RPC
  (ingredient writes, extended workbook apply, density writes). The plan never mentioned
  it. `apply_product_pricing_change_set` and `set_product_phase3_metadata` are compliant
  models to copy.
- **`SECURITY DEFINER` + `SET search_path = public, pg_temp` + deliberate grants** on
  anything new. Both existing functions were verified compliant.
- **`assertRpcResult()` / `checkMutationResult()`** on every new call site.
- **The workbook must never write the four governed columns directly.** Return policy,
  family, and packaging variant flow only through `set_product_phase3_metadata`, even in
  bulk. The trigger will reject a direct write anyway — this note just saves someone a
  wasted cycle discovering that.
- **Refresh `.claude/schema-registry.json`** after each applied migration.

Nothing in this plan is built until Mason says go.

---

## 9. [REV] What the adversarial review changed

Reviewed by Fable on 2026-08-18, read-only, against the live database and current source.
**Verdict: the architecture is right — no redesign.** Every count in §2 was re-verified
digit-for-digit and held. Four amendments were substantive:

| # | Change | Why it matters |
|---|---|---|
| 1 | `canonical_ingredient_id` + `ae_fraction` on `active_ingredients` | Without it, "show me everything with glyphosate" silently returns a **partial list**, and salt-to-acid conversion has nowhere to live |
| 2 | `product_rates` child table instead of rate columns | The column shape **could not store** the label-rate-plus-house-rate requirement the plan itself set |
| 3 | Density guard becomes a **warn band ~6.5–14**, not a hard 8–12 reject | A hard floor of 8 would have **rejected every crop oil and MSO** in the catalog |
| 4 | Hygiene to Phase 0; return policy split out to Phase 0b | Mason ranked return policy "asap" and it had landed fifth; hygiene de-noises every phase after it |

Smaller corrections: `ingredient_moa_codes` child table (two columns can't hold "more than
one code"); return policy is enforced on **returns only**, not orders, and `unknown` blocks
nothing — so classifying *starts* blocking rather than unblocking; `unit_size` retirement's
money risk is **not** live today because `inventory_unit` is 604/604 filled; filling
`quoting_notes` **is** customer-visible because `notes` is the current fallback; the
`2 qt/100 Gal` conflict spans **12 rows / 6 formulations**, not two; a stored rate exists
that falls **below** its labeled range; `unit_conversions` has a latent duplicate-row join;
`lb_per_lb` and `percent_w_w` are the same axis; and Phase 3 is **not** hard-blocked by
Phase 2.

Corrected before the review, from Mason's own challenge: the earlier claim that **Codex
cannot reach the live database is false** — `.codex/config.toml` configures the Supabase
MCP against project `rhyzpcqhnizqbxphqdkr` with `read_only=false`.
