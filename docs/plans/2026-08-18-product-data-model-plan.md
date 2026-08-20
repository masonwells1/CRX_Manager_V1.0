# Product Data Model — Implementation Plan

**Date:** 2026-08-18
**Status:** DRAFT — awaiting Mason's approval. No code written, no database changed.
**Revision:** amended three times on 2026-08-18 after three adversarial review rounds
(Fable, read-only, live-verified). Round 1 asked *"is this design sound?"* — changes marked
**[REV]**, listed in §9. Round 2 asked *"what is missing?"* — changes marked **[REV2]**,
listed in §10. Round 3 reviewed the result of rounds 1–2 in full context — changes marked
**[REV3]**, listed in §11, and it corrected eight factual claims this document had been
carrying. The largest round-2 addition (the spec-versus-brand layer in §4b) came from Mason,
not from a reviewer; round 3 then established that its implementation must ride the lot
chain that already exists rather than introduce a parallel one.

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
| `epa_registration` filled | 300 non-NULL, **but 13 are whitespace-only → 287 usable** *(corrected 2026-08-18, second review)* |
| `return_policy` = 'unknown' | **581** |
| `return_policy` = 'no_return' / 'returnable' / 'not_applicable' | 21 / 2 / 0 |
| `product_form` liquid / dry / **blank** | 508 / 85 / **11** *(added 2026-08-18, second review)* |
| Product names containing a parenthetical brand list | **129** *(added 2026-08-18, second review)* |
| Product names using the `" - <size>"` packaging suffix | **561 of 604** *(added 2026-08-18, second review)* |
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

### [REV2] Density is operational, not just analytical — Mason, 2026-08-18

The scope paragraph immediately above is **superseded**. Mason: *"I need that also because
we do a lot of blending based off scales so have to have weight of everything for scales
and mixer."*

That reclassifies density. It is not only the bridge that lets the comparison tool convert
`% w/w` to `lb/gal` — it is the number that tells a human what to put on a scale. Three
consequences, all verified against current source:

1. **Nothing in the app does weight today.** `density`, `specific gravity` and `lb_per_gal`
   appear **zero times** across all of `src/`. `blendMathValidator.ts` works purely in
   volume and counts; it declares `ProductData.unit` and never reads it. Weight-based
   blending is a new capability, not an improvement to an existing one.
2. **Scope widens from ~300 EPA-linked liquids to all 508 liquids**, because the products
   Mason blends most are fertilizers, which carry no EPA registration at all. Dry products
   additionally need a net weight per purchase unit where the unit is a package (bag, jug,
   case) rather than a weight — a dry product already sold in `Lb` needs nothing.
   The **11 products with a blank `product_form`** must be classified in Phase 0 first,
   because `product_form` is the key that decides which rule applies to a row.
3. **The risk tier rises.** A wrong comparison number produces a bad quote. A wrong density
   puts the wrong weight into a real mixer. Density therefore keeps `density_source` and
   gains the same `verified_by` / `verified_at` treatment as concentrations, and belongs in
   the audit trail described later in this section.

**The warn band does not apply to the blending path.** The 6.5–14 warn-never-reject rule
stays correct for *data entry* — it exists so a legitimate crop oil at 7.6 is not refused.
But when the app is asked to produce a **weight for a scale** and the product has no
density, it must **refuse and say so**, not fall back to water, a default, or an estimate.
Warning on entry and blocking on use are different jobs; do not collapse them into one
rule.

**[REV2] "5.4#" is not density — keep the two numbers apart.** Mason's catalog names encode
strengths like `Roundup 5.4#` and `Roundup 5.5#`. That figure is pounds of glyphosate salt
per gallon — an ingredient concentration, belonging in `product_active_ingredients`. The
product's own density is roughly 10.2 lb/gal. Both are needed, they are different columns,
and an executor who conflates them will produce scale weights that are wrong by about half.
The 5.4 vs 5.5 pair is also a live `ae_fraction` case: 5.5# products in the catalog are K6
(potassium salt) while 5.4# is the IPA salt, so 5.5 is not "2% stronger than" 5.4.

**Sequencing note:** the *schema* for density lands in Phase 1 as already planned. The
*backfill* is owner time — roughly 300+ safety-data-sheet lookups — and Mason has parked
sequencing it (2026-08-18: *"Let's wait on that for now I don't have time"*). Phase 1 is
therefore done when the columns, validation and entry path exist and one product can be
given a density and read back; it is **not** gated on the catalog being filled.

### [REV2] Fertilizer analysis — Mason, 2026-08-18: "yes I want fertilizer analysis stored"

**[REV3] Corrected: 317 products have no usable EPA registration number, not ~190.** The
earlier figure — Liquid Fertilizer 55, Foliar Fertilizer 53, Adjuvant 48, Dry Water Soluble
Fertilizer 13, Nitrogen Stabilizer 9, Biological 9 — listed **category totals**, not
no-EPA counts; 3 of the 9 nitrogen stabilizers are in fact EPA-registered. The ~123
products the old number missed are **pesticides** (Herbicide 85, Insecticide 18, Fungicide
13, Seed Treatment 6, Other 11) that have real active ingredients but **no registration
number on file**, so they cannot auto-seed from the EPA API until someone first enters the
registration number by hand. The convenient framing "287 auto-seed, the rest are
fertilizers" is wrong, and it hides a meaningful block of Mason's time — see PRD §9 item 16.

The original design had no home for the genuinely EPA-less products. Mason's direction: *"Yes I want
fertilizer analysis stored for future so we can do recs etc and know poundage of actual
applied etc make sure you can also store micronutrients and secondary macros, all complete
analysis."*

- Store the **complete guaranteed analysis**, not just N-P-K: primary macros (N, P₂O₅, K₂O),
  secondary macros (Ca, Mg, S), and micronutrients (B, Cl, Co, Cu, Fe, Mn, Mo, Ni, Zn).
- The natural shape is the **same `product_active_ingredients` table with a nutrient
  ingredient class**, not a parallel table — a percentage of a product is a percentage of a
  product whether the substance is mesotrione or zinc. This keeps one place to look and one
  set of unit rules. The executor should confirm this against the constraint design before
  committing to it; if a nutrient class cannot be expressed cleanly, a sibling table is
  acceptable, but two tables must not both be able to hold the same fact.
- Analysis is stored as **`percent_w_w`**, which is how a fertilizer label states it.
  Combined with density it yields the "poundage of actual applied" Mason asked for — this
  is the second reason density is required for liquid fertilizer specifically.
- Biologicals are stated in CFU and fit neither `lb_per_gal` nor `percent_w_w`. Nine
  products. Either add a CFU unit or leave biologicals unstored and say so; do not force a
  CFU count into a percentage column.

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

### [REV2] What Mason sells is a **spec**; what he delivers is a **brand** — 2026-08-18

This is the largest structural addition from the second review round, and it came from
Mason, not from an agent. His words:

> *"I sell based off (generic roundup 5.4#) in winter and then we order and now what actual
> brand we are selling such as agsaver glyphosate, red eagle glyphosate 54, slam 54 etc.
> Somehow we need to brainstorm how this will work in our system."*
>
> *"I will sell or quote early season as just 5.4# glyphosate or LV6 ester 24d, then we might
> deliver Lima 6 brand lv6 or low vol ester, etc etc depending on what we source so we need
> to track the actual individual epa number on them."*

**He is already doing this, and the current model stores the answer as prose.** Live product
names, read from the database on 2026-08-18:

```
Roundup 5.4# Generic (Ag Saver 5.4, Slam 5.4) - 2.5 Gal
Roundup 5.4# Generic (Ag Saver 5.4, Slam 5.4) - Bulk
Roundup 5.4# Generic NO RETURN, Full Tote (Ag Saver 5.4, Slam 5.4) - 265G
Roundup 5.4# (Bucc 5 Extra) - 2.5 Gal
Roundup 5.5# Generic (Honcho K6, Mad Dog K6, Envy K-Six) - Bulk
Generic Stinger: (Bite, CleanSlate, Spur, Stigmata) - 2.5 Gal
```

A single `product_name` string is carrying five independent facts: the sellable spec, the
generic-versus-branded distinction, the set of acceptable fulfilment brands, the return
policy, and the package size. At catalog scale: **129 names carry a parenthetical brand
list** and **561 of 604 use the `" - <size>"` suffix**.

**The naming convention is the current schema, and it has already been mined once.** 21
product names contain "NO RETURN" and exactly 21 rows carry `return_policy = 'no_return'`;
10 names say "Full Tote" and exactly 10 rows carry `is_full_tote_only = true`. Those two
columns were evidently back-filled from the name strings. That is strong evidence the
extraction approach works here — and equally, that the name string and the columns can
drift apart, because nothing keeps them in step.

**Design conclusion: the `products` row stays the sellable spec.** This is the important
call. Quotes, tiers, per-acre pricing, invoices, cost-at-quote snapshots and inventory all
key on `products.id` today and none of them need to change. Mason can go on quoting "5.4#
glyphosate" in December without the system knowing which jug will arrive.

**What is missing is the layer beneath the spec:** the real branded article that fills the
order, each with **its own EPA registration number**, label, manufacturer and density.

Proposed shape — a child table under `products`, one row per acceptable brand:

- `product_id` → the spec row
- `brand_name` — e.g. `Ag Saver 5.4`, `Slam 5.4`, `Lima 6`
- `epa_registration` — **the field Mason explicitly asked to track per brand**
- `manufacturer` / `basic_supplier`
- `label_url`, `density_value` — brands genuinely differ, and density feeds the scale
- `is_currently_sourced` — which brand is actually flowing right now
- `active_ingredients` — brands of one spec should agree, but they are not required to;
  the ingredient link belongs on whichever row is authoritative for that formulation

Then **at order, receiving or delivery, record which brand actually filled the line.** That
is what puts a real EPA registration number onto an application record — the number that
matters if a field record is ever audited — without disturbing how anything is sold.

> **[REV3b] Corrected — read this before building the paragraph above, and disregard the
> round-3 version of this note, which was wrong.** Round 3 said brand should attach to the
> existing lot chain (`receiving_records.lot_number` → `blend_ticket_products.lot_number` →
> `application_record_lots`), on the reasoning that a lot number *is* a specific branded
> batch. Mason rejected that on 2026-08-18: *"a lot of totes don't have lot numbers so some
> will not… don't make tote number / lot the focus because not all have it."*
>
> **Verified live, and the reality is stronger than his caution:** `receiving_records` has
> **0 of 130** rows with a lot number; `delivery_items` **1 of 400** with a tote number;
> `invoice_items` **0 of 19**; and `blend_tickets`, `blend_ticket_products` and
> `application_record_lots` are **entirely empty**. The lot chain exists in code and is
> **not in use**. Round 3 verified the *file footprint* of that infrastructure, never its row
> counts, and this plan repeated the conclusion without checking.
>
> **Correct design: `brand_id` is its own column on the receiving record, independent of any
> batch identifier.** A lot or tote number, where one exists, is optional supporting detail
> recorded beside the brand — never the key it hangs from. Split loads get their own
> per-line brand-plus-quantity shape rather than riding `application_record_lots`, which is
> unproven. The dormant lot/tote columns are left alone: not extended, not deleted, and never
> a condition of any brand behavior. See §11.1 item 2 and PRD 1.9a through 1.9a-iv.
>
> Unchanged from round 3: brand selection is required when product arrives (Mason's
> 2026-08-18 answer), split loads show **every** contributing brand with its amount, and
> records **snapshot** the brand's name and EPA number at write time so correcting a typo
> cannot rewrite history.
>
> Two further corrections to the bullet list above: **`density_value` on a brand row needs a
> stated precedence rule against the spec's density** (§11.1 item 3, PRD 1.18) — "whichever
> row is authoritative" is not implementable. And brand rows must not re-create the
> packaging-sibling double-entry problem: "Ag Saver 5.4" would otherwise be typed onto the
> 2.5 Gal, Bulk and 265G rows separately (PRD 1.9c).

**Alternatives considered and rejected:**

- *Every brand becomes its own product row, grouped by family, and quotes reference the
  family.* Arguably the more "correct" normalization, and it is what `product_families`
  gestures at. Rejected because it rewrites quoting, pricing and inventory to be
  family-aware, to fix a workflow that is not broken. Revisit only if the child-table shape
  proves insufficient in practice.
- *Parse the parenthetical brands into a plain text column.* Cheapest, keeps search working,
  and delivers none of the three things Mason asked for — per-brand EPA number, per-brand
  density, per-brand label.

~~**Open for the executor, not for Mason:** whether the brand child table is genuinely
distinct from `product_families`, or whether families should be retired in favour of it.
`product_families` has 0 rows and no writer, so there is no migration cost to choosing
either way.~~

**[REV3] Settled — and the struck-through paragraph above was wrong.** They are **different
axes and both are needed.** `product_families` groups **sibling product rows** — packaging
variants and equivalent chemistry *across* specs — and Phase 5 (5.1–5.5) explicitly derives
and writes it. Brand rows live **under a single product row** as the fulfilment articles for
that one spec. Retiring families leaves Phase 5 with nothing to write to; retiring brands
forces every brand to become its own product row, which is the alternative this section
already rejected. The zero row count made the choice look free; it is not. The one genuine
overlap is `product_families.active_ingredient` and `.formulation` — two free-text columns
that become conflicting duplicates once real ingredient tables exist, and which should be
flagged for retirement or derivation when Phase 5 populates families. See §11.1 item 4 and
PRD 1.9b.

Fable's second review flagged a related signal worth using here: EPA distributor
registrations share a parent number, which is the cheapest reliable evidence that two
catalog rows are the same formulation.

**Sequencing:** this is Phase 1 work — it is part of the ingredient foundation, not a later
nicety, because the spec/brand distinction determines *where the ingredient rows hang*. Get
it wrong and Phase 1 stores concentrations on the wrong layer.

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

### Phase 0b — Return-policy admin screen — **DEFERRED, DO NOT BUILD**

> **Mason, 2026-08-18:** *"We don't need the returns policy page yet not important."* This
> **supersedes** the "asap" ranking below. Phase 0b leaves the near-term path; the reasoning
> is kept intact so the phase can be resumed later without re-deriving it.

*(originally: Mason's #3, "asap" — ran parallel with Phase 1; superseded above)*

Split out of the old Phase 5. The return-policy half **depends on nothing** in Phases 1–4:
the RPC, its guards and its permissions are live today. Only the *family derivation* half
needs ingredients, and that stays in Phase 5. Mason ranked this "asap" and the original
order landed it fifth.

- Admin screen calling the existing `set_product_phase3_metadata` function.
- Bulk classification, so 581 products do not need 581 clicks.

**[REV2] The screen must offer four values, not three.** The live CHECK constraint is
`returnable | no_return | not_applicable | unknown` (migration
`20260723193312_product_families_return_policy_foundation.sql:49`). Both this plan and the
PRD previously enumerated only three. A screen built from the old text would have omitted a
legal state.

**[REV2] Bulk classification is not "a screen that calls the existing function."**
`set_product_phase3_metadata` is strictly per-product and uses compare-and-set arguments
(`p_expected_return_policy` and siblings). Bulk-classifying 581 products therefore means
either 581 read-then-CAS round trips with partial-failure and progress handling, or a new
bulk RPC — which is a migration, and pulls the full RLS + idempotency + drift gate stack
into Phase 0b. The executor must pick one and say which; the phase as originally written
budgeted for neither.

**[REV2] Return *windows* are explicitly out of scope — Mason, 2026-08-18.** Vendors do
have different return deadlines by product class (pre-emerge one date, post chemistry
another, insecticide and fungicide another). A vendor × class × date model was proposed and
Mason declined it: *"on the returns don't worry about that we send out paperwork on those
dates we can keep system simple on returns."* The four-value flag answers "can this ever
come back"; the deadline stays on paperwork outside the app. Do not build the date table.

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

---

## 10. [REV2] Second review round — 2026-08-18

A second adversarial pass (Fable, read-only, live-verified) was run with a different
question from the first. The first asked *"is this design sound?"* and answered yes with
four amendments. The second asked *"what is missing?"* and returned 24 gaps. Its verdict:
nothing invalidates the settled architecture, but the plan was not complete enough to hand
to an executor for Phase 2.

Items already folded into the sections above — the four-value return enum, bulk
classification mechanics, `product_form` and its 11 blanks, the corrected 287 usable EPA
registrations, density as operational data, fertilizer analysis, and the spec/brand
layer — are not repeated here.

### 10.1 The Phase 2 undercount, and what it means

**`rate_per_acre` is referenced by 83 files, not the 5 this plan named.** (Round 2 recorded 82; the true count is 83.) The original
consumer list (applicator sheets, blend math validator, chemical application report,
invoice PDF) is a fraction of reality. It is also in the field app
(`src/components/field-app/FieldAppChemicalEntry.tsx:304`), blend tickets
(`src/components/blendtickets/ManualTicketCreate.tsx:262`), crop programs
(`src/lib/cropProgramHelpers.ts:134`), blend recipes (`src/lib/recipeHelpers.ts:96`),
quote defaults (`src/pages/QuoteBuilder.tsx:1222`), jobs, statements, worker-protection
notices and year-end PDFs.

**The plan defines the consumption rule for quotes only.** It never says what happens to
the legacy `products.rate_per_acre` column once `product_rates` becomes the source of
truth. The three live options — leave it and sync it from the quoting-default row,
dual-write, or rewire all 83 consumers — have very different costs, and choosing late is
what turns Phase 2 into a multi-week surprise. **This must be decided in writing before
Phase 2 starts.** It does not block Phases 0, 0b or 1.

### 10.2 There is already a second bulk import system

`src/components/products/BulkProductImport.tsx:229` inserts products directly from CSV,
with its own field-alias mapping that includes `suggested_rate`, `rate_per_acre` and
`rate_unit` (lines 38–40). The plan's "extend the workbook, do not build a second system"
principle is sound but arrives after the fact.

Three write paths therefore exist: single create at `/products/new`
(`src/pages/Products.tsx:843`), inline bulk save via `EditableDataTable`, and this CSV
importer. **After Phase 2, a product created through any of them has zero `product_rates`
rows** and will autofill blank on a quote. The plan must say what happens to each path —
extend, gate, or retire — and where the blank-unit rejection actually lives.

### 10.3 Equivalence is not the same as interchangeability

The Phase 5 premise "same ingredients at the same concentrations are drop-in equivalents"
is chemically true and agronomically unsafe. Three things it cannot see:

- **Safeners.** Benoxacor and furilazole are not EPA active ingredients. Generic
  s-metolachlor without a safener versus Dual II Magnum with one is a real corn-injury
  difference, invisible to an ingredient-only comparison.
- **Formulation type.** SC, EC and OD of the same active are not interchangeable in a tank.
- **Built-in adjuvant load.** A fully loaded branded glyphosate versus a bare generic that
  needs NIS or AMS added.

Fix: a formulation-type and safener field carried on the product (or the brand row from the
spec/brand section), plus a standing caution in Phase 3 output and the Phase 5 approval
screen. Cheap now; a wrong swap recommended confidently is not cheap later.

**Salt and ester forms must not silently substitute.** `canonical_ingredient_id` correctly
merges 2,4-D ester and amine for *search*, but they are not interchangeable in the field,
and the same is true of dicamba DGA versus BAPMA. Family matching must key on the
**specific ingredient row**, not the canonical parent. **Mason, 2026-08-18: "Warn loudly we
pretty much only use ester."** So: propose with a loud warning, never refuse, never
substitute silently.

### 10.4 Owner decisions settled on 2026-08-18

| Question | Mason's answer |
|---|---|
| Fertilizers in the model? | **In** — and the reason is blending on scales, see the density section |
| Store full fertilizer analysis? | **Yes** — including secondary macros and micronutrients |
| Which price does the comparison show? | **Both cost and customer price, with a selectable customer tier** |
| Include the adjuvant delta in the generic build? | **No** |
| Ester versus amine substitution? | **Warn loudly** |
| Return windows by vendor and class? | **No — keep returns simple, deadlines stay on paperwork** |
| Who enters the data? | **Mason, personally** |
| Density backfill sequencing? | **Parked** — *"Let's wait on that for now I don't have time"* |

Three tiers already exist (`tier1_price` … `tier3_price`, plus `tier1_price_per_acre` …
`tier3_price_per_acre` in `src/types/index.ts:72-83`), so the tier selector needs no new
schema.

**On the adjuvant answer:** Mason declined including adjuvant cost in the generic build.
That leaves a known directional bias — rebuilding a loaded branded product from unloaded
generics understates the true cost of the generic route. Since the number drives real
offers, Phase 3 must carry a visible on-screen note that the comparison excludes adjuvant
cost. Stating the exclusion is not the same as pricing it, and does not reopen the decision.

**On data entry:** Mason enters most data himself. That makes the EPA auto-seed and the
Phase 1b workbook load-bearing rather than convenient. Roughly 287 products can auto-seed
ingredients from the EPA lookup, which already returns percent, PC code and CAS number
(`src/types/index.ts:108-113`). Density has no equivalent shortcut — it is a
safety-data-sheet lookup per product. The plan previously carried no effort estimate at
all; it should say plainly that the backfill is tens of hours of owner time, and that Phase
1's definition of done is the *mechanism*, not a filled catalog.

**On Mason's spreadsheet:** he confirmed the Google Sheet is *"not complete and is not
automatic or have actual ingredients — it is still using brand product names of individual
generic chemistries."* It is therefore a useful seed for the brand-shorthand layer, not a
substitute for EPA ingredient data. Do not plan around importing it wholesale.

### 10.5 Smaller gaps to close before the phases they belong to

**Phase 0 (hygiene)**

- Mechanics are undefined: merge versus deactivate is never stated. Duplicate and test rows
  may carry foreign-key history in quote lines, invoices and inventory movements, which
  makes a hard delete either impossible or destructive. **Recommendation: deactivate or
  merge with a pointer; never hard-delete.** Deleting data is an approval-gated,
  irreversible act under `AGENTS.md`.
- Normalize `epa_registration`: 13 rows hold whitespace-only strings, and any "run the EPA
  lookup across the 300" batch fails on them.
- Classify the 11 blank `product_form` rows — density scoping depends on that column.

**Phase 1 (ingredients, MOA, density)**

- **Unknown-concentration semantics.** A known ingredient with an unknown amount must be
  representable — state explicitly whether `concentration_value` is nullable. Phase 3's
  "loud gap" behaviour depends on telling *ingredient missing* apart from *amount unknown*.
- **Reuse the existing propose-review-commit pipeline.** `product_label_drafts` is live with
  `LabelReview.tsx`, a status set (`pending/accepted/edited/rejected/needs_manual`),
  confidence, `reviewed_by` and `run_idempotency_key` (`src/types/index.ts:137-183`). That
  is the house pattern for machine-sourced data needing human sign-off — exactly what EPA
  ingredient seeding is. The plan's `source` and `verified_at` columns are a weaker
  substitute for a pattern that already exists. Reuse it or record why not. Note also that
  the parked label work will resume through this pipeline, so Phase 4's label-URL
  persistence must not collide with it.
- **Persist the registration-status signals the EPA lookup already returns** —
  `productStatus` and `isCancelled` (`src/types/index.ts:130-131`). The plan currently keeps
  the label URL and discards the discontinued/lapsed signal, which is the only automatic rot
  detector available.
- **`updated_at` plus its trigger** on every new table — the drift gate checks
  `tables_without_updated_at` and the table specs never mention it.
- **Idempotency semantics for set-based writes.** "Replaying the same key does not
  double-write" is clear for inserts; for a replace-the-whole-ingredient-list write, state
  whether a replay is a no-op or re-applies the same set.
- **Nickname search.** The plan adds a "Generic Callisto"-style nickname column, but nothing
  requires the Products page (`searchKeys` at `src/pages/Products.tsx:862` covers name, SKU,
  category and vendor) or the QuoteBuilder picker to search it — and nickname is how Mason
  looks products up.

**Phase 1b (workbook)**

- **Absent row: delete or ignore?** The hardest question in any bulk round-trip, unanswered
  for the new `Ingredients` and `Crop Uses` tabs. Also unspecified: per-row error reporting,
  partial-failure behaviour, and duplicate-row handling on re-upload.
- **Concurrency does not currently cover children.** `pricing_version` guards the `products`
  row only; the child tables have no version token, so the phase's acceptance criteria do
  not actually cover what the phase writes.

**Phase 2 (rates)**

- **Seed treatments have no valid rate basis.** 18 products; real bases are per
  hundredweight of seed or per seed unit, and `per_unit` is ambiguous between "per each" and
  "per seed unit." Adding an enum value now is free; widening a CHECK constraint later is a
  migration.
- **Route the re-derivation through the change-set machinery** that records old and new
  values, rather than any direct write, so the old `rate_per_acre` values are captured.

**Phase 3 (comparison)**

- **`is_rup` is known wrong** (2 products flagged; Mason: *"there are a lot more"*). A
  proposal that swaps toward a restricted-use product without flagging it is
  compliance-adjacent. Minimum: display restricted-use status under the same "unverified"
  marking rule the phase already uses for other gaps, never as fact.

**Cross-cutting**

- **No audit trail for ingredient, rate or density edits.** `cost_history` is the precedent
  on the pricing side. This data drives customer-visible quantities and, now, scale weights;
  a silently changed concentration changes every downstream number with no trace.
- **No per-phase rollback story.** Phases 1, 1b, 3 and 4 are additive, so rollback is "stop
  using it." Phase 0 (row changes), 0b (starts blocking returns) and 2 (rewires quote
  autofill) have real reversal questions the plan never answers. Phase 2 behind a flag is
  the obvious mitigation; Phase 0b is reversible through the same RPC that sets it.

### 10.6 Deliberately parked — recorded so they are not re-litigated as oversights

Rainfast interval, grazing and feeding restrictions, plant-back and rotational-crop
intervals, carrier-volume minimums, mix order and tank-mix compatibility, PPE, state 24(c)
and SLN registrations, and application temperature limits. These belong with the parked
label-data work or were declined outright (Mason rejected tank-mix complexity on
2026-08-18). None blocks this build. They are listed once, here, so a future reviewer can
see they were considered rather than missed.

### 10.7 Found in passing — spawned as separate work, not part of this plan

`src/lib/blendMathValidator.ts` sums product quantities without reading `ProductData.unit`,
so gallons, pints and pounds are added together before being compared against the ticket's
total volume. Warning-text only — it does not alter stored quantities, pricing or
inventory — so it is moderate, not a money defect. Tracked outside this plan.

---

## 11. [REV3] Third review round — 2026-08-18

Round 3 read the combined output of rounds 1 and 2 with full context on *why* the design is
shaped as it is, and returned **"not ready to hand to an executor."** Phases 0 and 0b were
judged buildable after small edits; **Phase 1 was not.** Four defects would have produced
wrong or broken work on day one, and eight factual claims in these documents were wrong.

### 11.1 The four Phase-1 blockers

**1. `products` is a column-carved table, and neither document said so.** `authenticated`
holds no table-level INSERT or UPDATE on `products`; 27 of its 48 columns instead carry
explicit column-level grants — a consequence of the earlier phase-3 governance work. Every
Phase 1 column (density, nickname, formulation, safener, registration status) would have
been **unwritable by the app** until a matching `GRANT INSERT(col), UPDATE(col)` shipped.
The failure mode is the worst kind: the field renders, the user types into it, and the save
dies. Worse, it is invisible to anyone testing as service-role. Now PRD requirement **1.17**
and a §7 hard constraint. `docs/reference/gotchas.md` lists only `application_services` as
column-carved and is stale — it must be corrected in the same change.

**2. ~~The brand layer ignored provenance tracking the app already has.~~ RETRACTED
2026-08-18 — see §11.8.** Round 3 called this its best catch and recommended hanging brand
tracking on `receiving_records.lot_number` → `blend_ticket_products.lot_number` →
`application_record_lots`. Mason rejected it the same day, and live row counts confirm he
was right: that infrastructure has **no data in it at all**. The finding verified the
existence of the *code* (`LotsEditorModal.tsx`, `lotRpc.ts`, `QuickReceivePanel.tsx`,
`receivingPdf.ts`, `ManualTicketCreate.tsx`) and inferred that the workflow was in use. It
is not. Brand attaches directly to the receiving record instead, with no dependence on any
batch identifier. Full correction and evidence in §11.8.

**3. Density existed in two places with no precedence rule.** 1.3 put `density_value` on the
spec; 1.9 put one on brand rows; nothing said which the scale-weight math uses. That is the
exact dual-source ambiguity this project exists to eliminate, re-planted on its most
safety-critical path — a wrong answer here is a wrong weight on a scale. Now settled in
requirement **1.18**: spec density is the working value, a brand may override it, the
calculation prefers the recorded brand's density when one exists, and the screen shows
which it used. The same rule governs per-brand ingredient rows.

**4. "Brand table versus `product_families` — either choice is free" was false.** They are
different axes. `product_families` groups **sibling product rows** across specs and Phase 5
explicitly writes to it; brand rows live **under one product row**. Retiring families leaves
Phase 5 with nothing to write; retiring brands forces every brand to become its own product
row, which this plan rejected outright. Both ship. The only genuine overlap is
`product_families.active_ingredient` and `.formulation`, two free-text columns that become
conflicting duplicates once real ingredient tables exist — flagged for retirement or
derivation when Phase 5 runs. Now a settled answer in **1.9b**, not an open question.

### 11.2 Corrections to facts these documents were carrying

| Claim | Truth |
|---|---|
| ~190 products carry no EPA ingredients | **317** have no usable registration number. The old figure used category totals; ~123 of the miss are pesticides with real ingredients but no number on file, which cannot auto-seed until one is typed in |
| The `2 qt/100 Gal` cleanup is 12 rows | 12 rows for that literal string, but the full per-100-gallon class is **37 rows**, including weight-based entries like `17 lb/100 Gal` |
| 30 products have a blank `rate_unit`, silently becoming ounces | True about the blanks, but **zero** rows have a filled rate *and* a blank unit — the trap is real and prospective, not active damage |
| The four return RPCs enforce `assert_phase3_return_policy` | They delegate to `_*_intent_impl_20260812` functions which carry the guard. Same enforcement, wrong stated mechanism — an executor grepping the public functions finds nothing |
| "12-16 oz/acre" drifts between two stored values | **Three**: 12, 8.5 and 8 — which strengthens Phase 2's case |
| 129 names carry a parenthetical brand list | 129 contain parentheses, but several are not brands ("(Full pallets)", "(New Formulation of Resicore XL)"). Extraction needs human review, not parsing |
| `ingredient_map` is referenced by `BrandVsGeneric.tsx` and its test | Also `src/lib/rlsContracts.test.ts` and the generated `src/types/supabase.ts` — retirement must update the RLS fixture, regenerate types, refresh the schema registry |
| `rate_per_acre` appears in 82 files | 83 |

### 11.3 Resolved by this round

**The fate of `products.rate_per_acre`** — open since round 2 and the largest remaining
Phase 2 unknown — now has a recommended answer that needs no decision from Mason: keep the
columns as a **trigger-synced projection** of the quoting-default `product_rates` row and
revoke the app's direct write access, reusing the governance pattern already proven on the
four phase-3 columns. All 83 consumers keep working with one consistent meaning, and the
three write paths are *forced* through the new rate RPC because their direct writes begin
failing. PRD **2.9**.

Also settled: the blank-unit rejection belongs in a database CHECK rather than UI validation
(2.4); the hardcoded `'oz'` fallback at `FieldAppChemicalEntry.tsx:304` must be removed in
the same change (2.4b); Phase 0's duplicate SKU is two genuinely different sellables, so
re-SKU — not merge or deactivate — is the right fix (0.1a); and Phase 0b has a cheaper third
option in an evidence-backed classification migration, precedent
`20260729213733_supplier_pricing_phase3c_return_policy_classification.sql` (0b.5).

### 11.4 A live trigger that constrains two phases

`validate_product_units` is a BEFORE trigger on `products` doing a **case-sensitive exact
match** of `inventory_unit`/`container_unit` against `unit_conversions.unit`, plus a
unit-type-versus-`product_form` check. Neither document mentioned it. Consequences:

- **Phase 2 has a forced order** — remap every product's unit spelling *first*, then delete
  alias rows, and keep exactly the spellings products use. Reverse it and every subsequent
  edit to an affected product fails (2.7a).
- **Phase 0.3's form classification can be rejected by the database** if a row's current
  units disagree with the chosen form; check units first (0.3a).
- **Five functions join `unit_conversions`**, not just the quote path: `validate_product_units`,
  `product_price_per_acre`, `apply_product_pricing_change_set`,
  `preview_product_cost_basis_changes`, `_save_quote_below_cost_impl_20260810` (2.7b).

### 11.5 Owner decisions settled 2026-08-18 (round 3)

| Question | Mason's answer | Where it lands |
|---|---|---|
| Split loads — must paperwork show both brands and how much of each? | **Both brands, with amounts** | PRD 1.9a-ii. **[REV3b]** Needs a real per-line brand+quantity shape — the round-3 claim that `application_record_lots` gives this for free was wrong; that table is empty and unused (§11.8) |
| Make picking the brand required when product arrives? | **Yes, capture at receiving** | PRD 1.9a-i. Cheapest capture point — the person unloading is holding the jug. **[REV3b]** Must work with the lot/tote field left blank, which is the normal case (§11.8) |
| Blank rate instead of a guessed one on quote lines with no true per-acre rate? | **Blank is better than a guess** | PRD 2.3 / 2.4b. Confirms removing the `'oz'` fallback rather than flagging it |
| Fertilizer nitrogen — total N, or split into ammoniacal/urea/nitrate? | **Total nitrogen is enough** | PRD 1.10c. Schema must not forbid the breakdown later, but no entry requirement ships now |

### 11.6 Endorsed as correct — recorded so they are not reopened

Density's warn-on-entry (~6.5–14 lb/gal) with a hard block only on scale-weight *use*; the
scope of all 508 liquids rather than only the ~300 EPA-linked ones; the `"5.4#"`-is-not-a-density
trap as documented; co-locating fertilizer nutrients in `product_active_ingredients` with a
nutrient class; and `is_currently_sourced` as sufficient handling for a brand discontinued
mid-season. Already-quoted-not-delivered lines need no special handling — quotes key the
spec and copy values at add time (`QuoteBuilder.tsx:1222`), so recording a brand at delivery
changes nothing upstream.

### 11.7 What round 3 could not verify

Mason's Google Sheet and its Apps Script (no access — sheet-derived numbers were checked
only for internal arithmetic consistency); chemistry constants (2,4-D acid-equivalent
fractions 0.74/0.817, Roundup ~10.2 lb/gal, crop-oil density 7.6–7.8 — domain knowledge,
plausible and self-consistent); the HRAC/FRAC coding-scheme claims; and the executor-side
Codex connector assumptions in PRD §8. Everything else in §2 of this plan was re-verified
digit-for-digit against the live database, along with the cited source lines and function
bodies.

### 11.8 [REV3b] Retraction — brand tracking must not depend on lot or tote numbers

**Mason, 2026-08-18:** *"A lot of totes don't have lot numbers so some will not, make sure
and note that — don't make tote number / lot the focus because not all have it."*

He is right, and the live data is more emphatic than his caution:

| Table / column | Rows | Populated |
|---|---|---|
| `receiving_records.lot_number` | 130 | **0** |
| `delivery_items.tote_number` | 400 | **1** |
| `invoice_items.tote_number` | 19 | **0** |
| `blend_ticket_products` | **0 rows — table never used** | — |
| `application_record_lots` | **0 rows — table never used** | — |
| `blend_tickets` | **0 rows — table never used** | — |
| `application_records` | 1 | — |

**The lot/tote infrastructure exists in code and is not in use.** Round 3 verified its
*file footprint* — `LotsEditorModal.tsx`, `lotRpc.ts`, `QuickReceivePanel.tsx`,
`receivingPdf.ts`, `ManualTicketCreate.tsx` — and inferred a working end-to-end workflow
from the presence of those files. It never checked the row counts. This plan then repeated
the conclusion without checking either. **Existing code is not evidence of an existing
workflow**; only data is. That is the general lesson worth keeping from this correction.

**What replaces it.** `brand_id` is its own column on the receiving record, independent of
any batch identifier. Where a lot or tote number happens to exist it is recorded alongside
the brand as optional supporting detail — never as the key the brand hangs from. Split
loads get a per-line brand-plus-quantity shape of their own rather than riding
`application_record_lots`, which is unproven and empty. The dormant lot/tote columns are
left strictly alone: not extended, not deleted, and never a precondition of any brand
behavior. Whether that infrastructure is ever adopted is a separate question for Mason and
has no bearing on this plan.

**Acceptance test that encodes the correction:** receive product with **no lot number and
no tote number**, and every brand behavior — capture, split-load quantities, EPA number on
paperwork — works completely. That is the *normal* case, not a degraded one.

Requirements: PRD **1.9a**, **1.9a-i**, **1.9a-ii**, **1.9a-iv**.
