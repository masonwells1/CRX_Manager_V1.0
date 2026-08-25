# Product Data Model — Master Record

**Date:** 2026-08-18
**Status:** AWAITING YOUR APPROVAL. Nothing built. No database changed. No code written.
**Branch:** `claude/product-data-storage-58ba26` — local commits only, nothing pushed.

---

## How to read this

You asked for one document with all the issues, the reasoning behind every decision, and
the planned changes. This is that document. It is the **one to read**; the other three are
working files it was compiled from.

| Document | What it is | Read it when |
|---|---|---|
| **This file** | The complete record — issues, reasoning, changes | **Now, before you approve** |
| `2026-08-18-product-data-model-GAMEPLAN.md` | Plain-English design walkthrough | You want the design explained again |
| `2026-08-18-product-data-model-plan.md` | The full working plan + three review rounds | Someone is building and needs the *why* |
| `2026-08-18-product-data-model-PRD.md` | Numbered requirements with acceptance tests | Someone is building and needs the *what* |

Everything below is either quoted from you, or verified against the live database and the
current source on 2026-08-18. Nothing here is from memory or from an old handoff.

**Three review rounds were run against this design** — independent, read-only, verified
against the live database. Round 1 asked *"is this sound?"*, round 2 asked *"what is
missing?"*, round 3 asked *"could someone actually build this?"*. Round 3 answered **no**
and found four things that would have produced broken work on day one. All three rounds are
folded in below. That is why this document is long: the mistakes are in it, not hidden.

---

# PART 1 — EVERY ISSUE

Forty-three issues, grouped by where they came from. Each one says what is wrong, the
evidence, what it costs you, and where it gets fixed.

Severity: **BLOCKER** = would break the build or produce wrong numbers.
**HIGH** = real money or real paperwork exposure. **MEDIUM** = friction, drift, or
wasted time.

---

## Group A — The seven problems you originally ranked

These are the findings that started the project. Your ranking is what the build order is
made of.

### A-1 · Active ingredients are not stored anywhere — **BLOCKER** *(your top priority)*

Your words: *"brainstorm how to store them… lead into our product comparison tool."*

The app already looks up active ingredients from the EPA, shows them on screen, and then
**throws them away.** There is no column, anywhere in the database, that can hold them.
Everything you want — "show me everything containing mesotrione", "what does it cost to
build Halex GT out of generics" — is impossible until they have somewhere to live.

→ Fixed in **Phase 1**.

### A-2 · Family / packaging-variant / return-policy fields exist but nothing can write them — **HIGH**

Your words: *"make sure this gets fixed asap."*

Verified live: `product_family_id` filled on **0** of 604 products. `packaging_variant`
filled on **0**. `return_policy = 'unknown'` on **581**. The `product_families` table has
**0 rows**.

The reason is not neglect. The database function that is the *only* thing allowed to write
those four columns — `set_product_phase3_metadata` — **has no caller anywhere in the
application.** It appears only in test fixtures and generated type files. There is no
screen that can set these fields. The plumbing was built and the tap was never connected.

→ Families fixed in **Phase 5**. Return policy **deferred at your direction** (see D-4).

### A-3 · `unit_size` duplicates `inventory_unit` — **MEDIUM** *(your "lets fix this")*

Two columns hold the same package size and **disagree on 10 rows**. Two fields holding one
fact is how a wrong one gets used.

→ Fixed in **Phase 7**, deliberately last. See C-41 for why the original justification for
this one was wrong.

### A-4 · Unit spellings are inconsistent — **MEDIUM** *(your "consolidate and standardize")*

Verified live:

- `inventory_unit`: Gal 492, Lb 65, Dry oz 17, Oz 11, Qt 8, Unit 7, MG 3, Ea 1
- `unit_size`: the same set plus `LB` 1, and 8 blanks
- `rate_unit`: oz 493, Dry oz 75, blank 30, MG 3, qt 2, LB 1

The drift is **case-only** (`Oz`/`oz`, `LB`/`Lb`, `Qt`/`qt`) plus one synonym pair
(`Unit`/`Ea`). No two spellings mean different things, and every alias pair carries an
identical conversion factor — which is why the cleanup provably cannot move a price.

→ Fixed in **Phase 2**. But see C-26 — the order of operations here can brick product
editing if done backwards.

### A-5 · Data hygiene — duplicates, blanks, a test row — **MEDIUM** *(your "yes we need to fix this")*

Verified live: **13 blank SKUs**, **1 duplicate SKU group** (`9768NR`, two Generic Liberty
rows), **3 duplicate name groups**, and `1A TEST PRODUCT - FAKE PRODUCT` — which carries a
bogus rate that would otherwise get re-derived and reviewed alongside real ones.

→ Fixed in **Phase 0**, moved to the very front.

### A-6 · Label rate / REI / PHI are completely empty — **HIGH, but parked at your direction**

Verified live: `max_label_rate` filled on **0** of 604. `rei_hours` **0**. `phi_days`
**0**. `signal_word` on only 95.

Consequence worth knowing: Field Mode has a working **"OVER LABEL RATE"** warning block
that is **permanently inert**, because the number it compares against is never present. It
looks like a safety net and is not one.

Your call: *"we will do this later."* → **Parked. Not scheduled.**

### A-7 · No required fields when creating a product — **MEDIUM, parked at your direction**

Your call: *"not concerned right now."* → **Parked.**

---

## Group B — Chemistry and measurement problems found while designing

These were not in the original review. They surfaced once the design met real chemistry,
and two of them would have silently produced wrong numbers forever.

### B-8 · The same-name-different-substance trap — **BLOCKER**

Glyphosate is the clearest example, not the only one. The EPA does not return "glyphosate."
It returns **"glyphosate, isopropylamine salt," "glyphosate, potassium salt," "glyphosate,
dimethylamine salt"** — three separate ingredient names for what you call one chemical.

If ingredients are seeded straight from EPA lookups with the name as the unique key, the
database ends up with three or more different "glyphosates." Your headline query — *"show me
everything containing glyphosate"* — then returns a **partial list, with no error and no
warning.** That is the single worst thing this project could produce: a confidently wrong
answer to the question the whole project exists to answer.

**The same trap has at least three shapes, and your catalog carries all three:**

| Shape | Live example in your catalog |
|---|---|
| **Salt forms** | `Roundup 5.4#` (IPA salt) vs `Roundup 5.5#` (potassium salt); `Gen Banvel: (Dicamba DMA, Disha DMA)` names the salt in the product name |
| **Ester vs amine** | 2,4-D LV ester vs DMA amine — same acid, not field-interchangeable (D-11) |
| **Isomers** | `Gen Dual R Moc` vs `Gen Dual S Moc` — **both exist as separate products.** R is racemic metolachlor, S is S-metolachlor. Same ingredient name, and **a pound of one is not a pound of the other** |

The isomer row is the one the glyphosate example hid. It is not a salt and has no acid
equivalent, so `ae_fraction` does not touch it — the fix is that they must stay **separate
ingredient rows that never merge for math.**

**The rule that keeps all three correct, stated once:** *search merges forms; math never
does.* `canonical_ingredient_id` exists so one search finds every form. Every calculation —
rebuild quantity, family matching, scale weight — uses the **specific ingredient row** the
product actually contains.

→ Fixed by `canonical_ingredient_id` (see decision T-2), with the search-versus-math rule
now explicit rather than implied.

### B-9 · Acid equivalent versus salt weight — **BLOCKER**

Glyphosate is sold as a salt but measured two ways: total salt weight, and **acid
equivalent** — the actual weed-killing acid. Your sheet uses acid equivalent.

A "5.4# glyphosate" product is **5.4 lb of salt but 4.0 lb of acid equivalent** per gallon.

Store the salt number, compare it against an acid-equivalent number, and **every glyphosate
comparison is roughly 26% wrong — silently.** No error, no warning, just a number that
looks right.

Live consequence in your own catalog: **5.5# products are the potassium salt and 5.4#
products are the IPA salt.** 5.5 is *not* "2% stronger than" 5.4. They are different
chemistries measured on different bases.

→ Fixed by the `basis` column plus `ae_fraction` (see decision T-2).

### B-10 · Density does not exist anywhere in the database — **BLOCKER**

Verified by searching **every column in the entire public schema** for density, specific
gravity, lb-per, weight, or net-weight: **zero rows.** It is not on `products` and it is not
anywhere else. The words `density`, `specific gravity` and `lb_per_gal` appear **zero times**
across all of `src/`.

Your words: *"this is a MUST and we do not capture that yet"* and *"I need that also because
we do a lot of blending based off scales so have to have weight of everything for scales and
mixer."*

That second sentence changes what density *is* in this project. It is not only the bridge
that lets the comparison tool convert a percentage into pounds per gallon — **it is the
number that tells a person what to put on a scale.** A wrong comparison number makes a bad
quote. A wrong density puts the wrong weight into a real mixer.

→ Fixed in **Phase 1**, at a raised risk tier.

### B-11 · The unit conversion table has two chains that do not connect — **BLOCKER**

Live contents of `unit_conversions` (14 rows), everything normalized into a column literally
named `factor_oz`:

| Chain | Units | What `factor_oz` means |
|---|---|---|
| `liquid` | Gal 128, Qt/qt 32, Pt 16, oz/Oz/fl oz 1 | fluid ounces |
| `dry` | Lb/LB 16, Dry oz 1, g 0.0353, MG 0.0000353 | dry (weight) ounces |
| `both` | Ea 1, Unit 1 | neither |

**A fluid ounce and a dry ounce both carry `factor_oz = 1`, and they are not the same
thing.** There is no conversion between the liquid and dry chains anywhere in the table.

**Density is that missing conversion.** This is why B-10 blocks the comparison tool and not
just the scale feature.

### B-12 · "Each" is stored as if it were an ounce — **MEDIUM**

`Ea` and `Unit` are stored as `unit_type = 'both'` with `factor_oz = 1`. "Each" is not an
ounce. Any conversion involving them is arithmetically meaningless — and **8 products' quote
math currently divides by that fake factor.**

→ Flagged in **Phase 2** so the alias cleanup does not silently bless it.

### B-13 · Stored rates were picked from ranges with no rule — **HIGH**

`suggested_rate` is free text (570 filled). `rate_per_acre` is the number that actually
drives quantity on applicator sheets, chemical application reports, blend-math validation
and invoices (573 filled). Where the text held a range, the number was picked with no
consistent rule. Verified live:

| Text says | Number stored | Which is that? |
|---|---|---|
| `12-16 oz/acre` | 12 | low end |
| `3-5 oz/acre` | 4 | midpoint |
| `32-44 oz/acre` | 34 | neither |
| `1-4gpa` | 320 oz | midpoint |
| `.5-2GPA` | 128 oz | neither |
| `Corvus 4-5.6` | 5.6 | high end |
| `Capture LFR 12-16 oz/acre` | 8.5 | **below the range entirely** |

The last row is the one that matters: a stored rate that falls **below its own labeled
range**. And `12-16 oz/acre` does not drift between two stored values — it drifts between
**three** (12, 8.5 and 8).

→ Fixed in **Phase 2**, with every re-derived value reviewed by you before it is written.

### B-14 · Two different *kinds* of rate share one field — **HIGH**

`2 qt/100 Gal` is a **concentration**, not a per-acre rate. It sits in the same column as
per-acre numbers. Verified live: that literal string appears on **12 rows covering 6
formulations**, with 9.6 stored on 8 of them and 6 stored on the other 4 — the same
formulation, two different answers.

And the literal string undercounts it. The full per-100-gallon class is **37 rows**,
including weight-into-liquid entries like `17 lb/100 Gal`.

→ Fixed in **Phase 2** by the `product_rates` child table (decision T-4).

### B-15 · A blank rate unit silently becomes ounces — **HIGH (prospective, not active)**

`getConversionFactor` returns **1** for an unknown unit, so "unknown unit" silently becomes
"ounces." **30 products have a blank `rate_unit`.**

Honest correction: all 30 of those also have a blank rate, so the live count of rows with a
**filled rate and blank unit is zero.** The trap is real and it is armed; it is not currently
producing wrong numbers. This document said otherwise before round 3 corrected it.

Worse, the app *manufactures* the guess: `FieldAppChemicalEntry.tsx:304` does
`rate_unit: product.rate_unit || product.inventory_unit || 'oz'`.

→ Fixed in **Phase 2** as a database CHECK, with the hardcoded `'oz'` removed in the same
change. Your call, applied: *blank is better than a guess.*

### B-16 · One product name is carrying five separate facts — **HIGH**

Real names from your live catalog:

```
Roundup 5.4# Generic (Ag Saver 5.4, Slam 5.4) - 2.5 Gal
Roundup 5.4# Generic NO RETURN, Full Tote (Ag Saver 5.4, Slam 5.4) - 265G
Roundup 5.5# Generic (Honcho K6, Mad Dog K6, Envy K-Six) - Bulk
Generic Stinger: (Bite, CleanSlate, Spur, Stigmata) - 2.5 Gal
```

One text string is carrying the sellable spec, the generic-versus-branded distinction, the
list of acceptable fulfilment brands, the return policy, and the package size. At scale:
**129 names carry a parenthetical brand list** and **561 of 604 use the `" - <size>"`
suffix**.

**This is not ad-hoc — it is a systematic convention covering 90 products**, written as
`Gen <benchmark>: (acceptable brands) - size`:

```
Gen Boundary: (Ledger, MetalliS MTZ, Presidual) - 2.5 Gal
Gen Authority MTZ: (Sulfen MTZ, Aquesta MTZ) - 12#
Gen Quilt Xcel: (Aquila XL, Azoxyprop Xtra, Cover XL, Propaz) - 2.5 Gal
Gen Liberty: Higher Quality (Interline, Inflame) - 2.5 Gal
```

Note that **the benchmark is frequently a premix** — Boundary is two actives, Authority MTZ
is two, Quilt Xcel is two, Resicore and SureStart are three. The brand-and-generic problem
and the multiple-actives problem are **the same rows**, not two separate populations.

Two consequences worth naming. First, the search term "Generic" finds only 5 products — the
convention spells it **`Gen`** — so any hand-built list keyed on the wrong word silently
misses 90% of the pattern. Second, **48 names carry the loading as a `#` number**
(`Gen Sencor Liquid 4#`, `Gen Capture LFR 1.75#`, `Gen Warrior 1LB` vs `2LB`,
`Roundup 5.4#` vs `5.5#`). That number **is** the ingredient concentration — the exact fact
the ingredient table will hold, currently living only in a text string nothing validates.

**The naming convention is the current schema, and it has already been mined once.** 21
names contain "NO RETURN" and exactly 21 rows carry `return_policy = 'no_return'`; 10 names
say "Full Tote" and exactly 10 rows carry `is_full_tote_only = true`. Those columns were
back-filled from the strings. That proves the extraction works — and equally that the name
and the columns **can drift apart, because nothing keeps them in step.**

→ Fixed in **Phase 1** by the brand layer (decision T-6).

### B-17 · No per-brand EPA registration number — **HIGH**

Your words: *"I will sell or quote early season as just 5.4# glyphosate or LV6 ester 24d,
then we might deliver Lima 6 brand lv6 or low vol ester, etc etc depending on what we source
so we need to track the actual individual epa number on them."*

Today there is one registration number per product row, and the product row is the spec you
sell — not the jug you delivered. **The number that matters if a field record is ever
audited is the one on the jug**, and there is nowhere to put it.

→ Fixed in **Phase 1** by the brand layer.

### B-18 · Packaging siblings mean everything gets typed twice — **HIGH**

Pack sizes are **separate product rows**: "Callisto - 1 Gal" and "Callisto - Bulk" are two of
the 604. Roughly half the catalog duplicates another row's chemistry.

Ingredients, concentrations, density, mode of action, crop/timing, adjuvant requirements and
label links are properties of the **formulation**, not the package. Attaching them per
product row means entering everything twice — and **silent drift when the bulk row is
updated and the 2.5-gallon row is not.**

That is the exact failure this whole project exists to eliminate, reintroduced in a new
place.

→ Fixed by "copy from sibling" in **Phase 1** and the family-drift check in **Phase 5**.

### B-19 · The customer-facing note box is empty, and filling it changes what customers see — **MEDIUM**

`quoting_notes` already exists and is already wired: adding a product to a quote auto-fills
it into the line's notes, it is editable per grower on that quote, and there is a
reset-to-default button. Fill rate: **0 of 604**, against `notes` 444 and `internal_notes`
443.

The catch, corrected by review: the helper is `quoting_notes || notes` — so **today `notes`
is what reaches the customer**, as the fallback. Filling `quoting_notes` therefore **changes
what auto-fills on every new quote line** for 444 products. That is almost certainly what you
want, but it is a **customer-visible change, not the free win it was first described as.**

→ **Phase 4** surfaces it properly; the before/after gets previewed before any mass-fill.

### B-20 · Your spreadsheet has no math in it — **HIGH (this is the real reason for the project)**

Your Google Apps Script was read in full — 231 lines, `Crop Rx Pricing Tools.gs`. It builds a
menu, stamps a date and logs cost changes to a `PRICE_HISTORY` tab, applies row borders, and
copies a quote sheet with a `SUM` total.

**It contains no ingredient or brand-vs-generic math at all.** Every equivalence number in
the comparison chart was typed by hand.

Which means those numbers **never recalculate.** The chart already shows the failure —
"Resicore REV (New Formulation of Resicore XL)" has ingredients listed and **blank equivalent
rates.** Storing concentrations and computing the equivalence removes that entire class of
silent staleness.

You also confirmed the sheet is *"not complete and is not automatic or have actual
ingredients — it is still using brand product names of individual generic chemistries."*
So it is a useful seed for the brand shorthand, **not an import source.**

### B-21 · The restricted-use product count is known wrong — **HIGH**

Live: `is_rup = true` on **2** products. Your words: *"there are alot more but not important
today."*

Until this is corrected, the RUP compliance report (`src/lib/rupCompliance.ts`,
`src/pages/Compliance.tsx`) must be treated as **known incomplete, not as a clean result.**

→ Parked with A-6. **Phase 3** must display RUP status as unverified, never as fact.

### B-22 · A third of the catalog can never auto-fill from the EPA — **HIGH**

**317 products have no usable EPA registration number** (300 non-NULL, but 13 are
whitespace-only, leaving 287 usable out of 604).

The comfortable framing — "287 auto-seed, the rest are fertilizers" — is **wrong.** About
**123 of the 317 are real pesticides** (85 herbicide, 18 insecticide, 13 fungicide, 6 seed
treatment, 11 other) that have genuine active ingredients but **no registration number on
file.** They cannot auto-seed until someone types the number in first.

→ Counted honestly in the data-entry estimate in Part 3.

### B-23 · Biologicals fit neither unit — **MEDIUM**

Biologicals are stated in colony-forming units, which is neither pounds per gallon nor a
percentage. **9 products.** Forcing a CFU count into a percentage column is a data defect.

→ Fixed by adding `cfu_per_ml` / `cfu_per_g` as concentration units (decision T-9).

### B-24 · Fertilizer nutrients have an oxide-versus-elemental trap — **MEDIUM**

Guaranteed analysis reports phosphorus and potassium on an **oxide** basis (P₂O₅, K₂O);
agronomic math frequently needs **elemental** P and K (×0.436 and ×0.830).

This is structurally **the same problem as acid equivalent versus salt weight** — the same
substance measured two ways. A build that silently treats P₂O₅ as elemental P is a defect.

→ Must be explicitly resolved in **Phase 1** (requirement 1.10b).

---

## Group C — What the three review rounds caught

These are the ones that would have wasted real build time or produced broken work. Round 3's
verdict on the plan as it then stood was **"not ready to hand to a builder."**

### C-25 · `products` is a permission-carved table — **BLOCKER, and the worst failure mode**

Verified live: the `authenticated` role holds **no table-level INSERT or UPDATE** on
`products`. Instead, **27 of its 48 columns carry explicit column-level grants** — a
consequence of earlier governance work.

**Every new column planned for Phase 1** — density, nickname, formulation type, safener,
registration status — **would have been unwritable by the app** until a matching permission
shipped with it.

The failure mode is the worst kind: the field renders normally, you type into it, click
save, and **the save dies.** And it is **completely invisible to anyone testing with admin
credentials**, because those bypass column permissions entirely. It would have been found by
you, in production, not by the builder.

`docs/reference/gotchas.md` lists only one other table as permission-carved and is **stale**
— it gets corrected in the same change.

→ Now a hard requirement: **every new column ships its permission grant in the same
migration**, and acceptance is *edit it through the running app as a normal user.*

### C-26 · A live trigger can brick product editing if the unit cleanup runs backwards — **BLOCKER**

`validate_product_units` is a live BEFORE trigger on `products` that does a
**case-sensitive exact match** of a product's units against the `unit_conversions` table.
Neither working document mentioned it.

Consequence: the unit cleanup has a **forced order.** Remap every product's unit spelling
**first**, then delete the alias rows — and the spellings kept must exactly match what was
written to products. **Reverse that order and every subsequent edit to an affected product
fails.**

It also constrains Phase 0: classifying the 11 blank `product_form` rows can be **rejected by
the database** if a row's current units disagree with the chosen form.

And the alias cleanup touches **five database functions** that join `unit_conversions`, not
just the quote path.

### C-27 · Density was going to exist in two places with no rule — **BLOCKER**

One requirement put density on the product spec; another put density on brand rows. **Nothing
said which one the scale-weight math uses.**

That is the exact dual-source ambiguity this project exists to eliminate, re-planted on its
**most safety-critical path** — a wrong answer here is a wrong weight on a scale.

→ Settled: **the spec density is the working value; a brand may override it; the calculation
prefers the recorded brand's density when one exists; and the screen displays which one it
used.**

### C-28 · "Brand table versus product families — either choice is free" was false — **HIGH**

Both documents recorded this as an open question with no cost either way, because both
tables have zero rows. **That was wrong.** They are different axes:

- `product_families` groups **sibling product rows** — packaging variants and equivalent
  chemistry *across* specs. Phase 5 explicitly writes to it.
- Brand rows live **under a single product row** as the fulfilment articles for that one spec.

Retiring families leaves Phase 5 with nothing to write to. Retiring brands forces every brand
to become its own product row — which this design explicitly rejected. **Both ship.**

The one genuine overlap: `product_families.active_ingredient` and `.formulation`, two
free-text columns that become conflicting duplicates once real ingredient tables exist.
Flagged for retirement when Phase 5 runs.

### C-29 · Brand tracking was about to be built on infrastructure nobody uses — **BLOCKER (your catch)**

Round 3 called this its best finding: hang brand tracking on the existing lot/tote chain,
since a lot number *is* a specific branded batch.

**You rejected it the same day:** *"a lot of totes don't have lot numbers so some will not…
don't make tote number / lot the focus because not all have it."*

The live data is **more emphatic than your caution:**

| Table / column | Rows | Populated |
|---|---|---|
| `receiving_records.lot_number` | 130 | **0** |
| `delivery_items.tote_number` | 400 | **1** |
| `invoice_items.tote_number` | 19 | **0** |
| `blend_ticket_products` | **0 rows — never used** | — |
| `application_record_lots` | **0 rows — never used** | — |
| `blend_tickets` | **0 rows — never used** | — |

The lot/tote infrastructure **exists in code and has no data in it at all.** The review had
verified the *files* — `LotsEditorModal.tsx`, `lotRpc.ts`, `QuickReceivePanel.tsx`,
`receivingPdf.ts` — and inferred a working workflow from their existence. It never checked
the row counts, and this plan repeated the conclusion without checking either.

**The general lesson, worth keeping: existing code is not evidence of an existing workflow.
Only data is.**

→ Brand attaches **directly to the receiving record**, with a column of its own, independent
of any batch identifier. The acceptance test encodes the correction: **receive product with
no lot number and no tote number, and every brand behavior works completely.** That is the
*normal* case, not a degraded one.

### C-30 · The rate field is in 83 files, not 5 — **HIGH**

The plan named four consumers of `rate_per_acre`. The real count is **83 files** — the field
app, blend tickets, crop programs, blend recipes, quote defaults, jobs, statements,
worker-protection notices and year-end PDFs among them.

That is the difference between a contained change and a multi-week surprise.

→ Resolved by decision T-11 (trigger-synced projection), which lets all 83 keep working
unchanged.

### C-31 · There are three ways to create a product, and one was never mentioned — **HIGH**

Verified live: single create at `/products/new`, inline bulk save via the editable table,
**and a CSV importer** at `src/components/products/BulkProductImport.tsx:229` that inserts
products directly with its own field-alias mapping.

After the rate change, **a product created through any of them has zero rate rows** and
autofills blank on a quote. All three must be updated in the same change.

The CSV importer also carries a quirk worth catching now: its alias table maps `'unit'` to
**both** `unit_size` and `rate_unit`.

### C-32 · The Excel workbook and the rate move collide — **HIGH**

The planned workbook round-trips rate columns through machinery that writes **`products`
columns only**. The rate phase then moves rate truth into a child table. Routing the
re-derivation "through the change-set machinery" therefore means teaching that machinery to
write child tables — real, unestimated work.

→ **Recommendation: ship the workbook's rate columns read-only from the start**, so the
workbook never becomes a fourth write path that has to be unwound later.

### C-33 · "Same ingredients" does not mean "interchangeable" — **HIGH**

Chemically true, agronomically unsafe. Three things an ingredient-only comparison cannot see:

- **Safeners.** Benoxacor and furilazole are not EPA active ingredients. Generic
  s-metolachlor without a safener versus Dual II Magnum with one is a real corn-injury
  difference — **invisible** to the comparison.
- **Formulation type.** SC, EC and OD of the same active are not interchangeable in a tank.
- **Built-in adjuvant load.** A fully loaded branded glyphosate versus a bare generic that
  needs surfactant or AMS added.

And separately: `canonical_ingredient_id` correctly merges 2,4-D ester and amine **for
search**, but they are **not interchangeable in the field** — same for dicamba DGA versus
BAPMA, and same for the R/S metolachlor pair that exists as two live products in your
catalog (B-8). Family matching must key on the **specific ingredient row**, never the
canonical parent.

Your call: *"Warn loudly we pretty much only use ester."* → Propose with a loud warning,
never refuse, never substitute silently.

### C-34 · The return-policy risk was written backwards — **HIGH**

The original plan said classifying return policy would *unblock* transactions. **The opposite
is true.** `unknown` blocks nothing today, so the 581 unknowns already behave as returnable.
Setting `no_return` is what **starts** blocking.

So the failure mode is a legitimate return being refused, or a no-return product wrongly
accepted — real money either way.

→ Academic for now: **you deferred this page.** Kept on record so it is not re-derived wrong
later.

### C-35 · Grepping for the return guard finds nothing — **MEDIUM**

The four return functions do not themselves call the policy guard; they are thin wrappers
delegating to internal implementation functions that carry it. Net enforcement is exactly as
documented — but a builder grepping the public functions **finds no guard and may wrongly
conclude the rule is unprotected.**

The same delegation pattern applies to the quote save path.

### C-36 · Retiring the old comparison table has a wider footprint than recorded — **MEDIUM**

`ingredient_map` is referenced by the old page and its test **and** by the RLS contract test
fixture and the generated type file. Retirement must update the fixture, regenerate types,
and refresh the schema registry.

### C-37 · No audit trail for ingredient, rate or density edits — **HIGH**

This data will drive customer-visible quantities and, now, **scale weights.** A silently
changed concentration changes every downstream number **with no trace.** Cost history is the
precedent on the pricing side; nothing equivalent was planned here.

→ Now a requirement (1.16).

### C-38 · No per-phase rollback story — **MEDIUM**

Phases 1, 1b, 3 and 4 are additive, so rollback is "stop using it." **Phase 0 (changes real
rows) and Phase 2 (rewires quote autofill) have real reversal questions** that were never
answered. Phase 2 behind a feature flag is the obvious mitigation.

### C-39 · Blend math adds gallons to pounds — **MEDIUM, tracked separately**

`src/lib/blendMathValidator.ts` sums product quantities **without reading the unit** —
gallons, pints and pounds added together before being compared against the ticket's total
volume. It declares a unit field and never reads it.

Warning-text only; it does not alter stored quantities, pricing or inventory. **Found in
passing, tracked outside this plan** so it does not quietly expand the scope.

### C-40 · Seed treatments have no valid rate basis — **MEDIUM**

**18 products.** Real bases are per hundredweight of seed or per seed unit, and the planned
`per_unit` value is ambiguous between "per each" and "per seed unit." Today a
`0.714 oz/unit` seed treatment is stored as `rate_per_acre = 0.71` and flows through the
acres × rate path **meaning something it does not mean.**

Adding the enum value now is free; widening a constraint later is a migration.

### C-41 · The `unit_size` retirement risk was overstated — **corrected**

The plan claimed this is "the only change that can move a customer's price," through a
fallback in both the app and the live quote function. The fallback is real — **but
`inventory_unit` is filled on all 604 products, so that path is dead code today.** Retiring
`unit_size` cannot move a price through it.

**The real reason it goes last is breadth, not money:** `unit_size` appears in **50+ files**,
is a workbook column, and is baked into database function bodies that must be re-emitted.
That still earns the full treatment.

One addition: a future product created without `inventory_unit` would **re-arm** that dead
fallback, so the retirement makes `inventory_unit` required in the same change.

### C-42 · The governance on those four columns is stronger than claimed — **confirmed, favourable**

The claim that `set_product_phase3_metadata` has no caller turned out to be **stronger than
stated**: direct writes to those four columns are blocked by **both** a column-level
permission revoke **and** a BEFORE trigger. Nothing else *could* write them.

That is the pattern being reused for the rate columns in decision T-11 — it is proven in this
codebase, not invented for this plan.

### C-43 · Identical ingredients, deliberately different products — **HIGH**

Found on 2026-08-18 while checking that this design generalizes past glyphosate. Your catalog
already splits the *same chemistry at the same loading* into separate products on a
**sourcing-quality** basis:

```
Gen Liberty: (Cheetah, Glufosinate, Opportunity, Reckon) - 2.5 Gal
Gen Liberty: Higher Quality (Interline, Inflame) - 2.5 Gal

Gen Callisto: (Argos, Calleron, Cavallo, Meso 4SC, Mesotrione) - 1 or 2.5
Gen Callisto: High Quality (Explorer, Incinerate) - 1 Gal
```

The same split appears without the word "quality" at all: `Roundup 5.4# (Bucc 5 Extra)` and
`Roundup 5.4# Generic (Ag Saver 5.4, Slam 5.4)` are two separate products at one loading with
two different acceptable-brand sets.

**The active ingredients are identical.** So as the plan currently stands, Phase 5 would group
them into one family and the comparison tool would present them as drop-in equivalents —
**and you clearly do not treat them that way,** or they would not be separate rows carrying
separate prices.

Ingredient data alone cannot see this. It is a sourcing judgement, not a chemistry fact, and
it is the fourth thing C-33 could not see.

→ **Fix:** the brand row carries a quality/sourcing tier, family grouping respects it, and the
comparison tool labels a cross-tier substitution rather than presenting it as equivalent. It
never refuses — same posture as ester-versus-amine (D-11). Added to Phase 1 and Phase 5.

---

# PART 2 — EVERY DECISION, AND WHY

Three kinds: **yours** (D-*), **technical calls I made** (T-*), and **things rejected**
(R-*). Then a list of claims that turned out wrong and were corrected (X-*), because you
should be able to see where this document changed its mind.

---

## 2A — Your decisions

Each one is your words, what it means, and why it changed the plan.

### D-1 · Ingredient foundation first

> *"i agree i want to do the ingredient foundation 1st."*

**Why it matters:** everything else depends on it. Density, the comparison tool, families,
and the brand layer all read from ingredient data. Starting anywhere else means building
against tables that then change shape.

### D-2 · Retire the old Brand-vs-Generic page — do not extend it

> *"retire it and we will build a new page in future."*

**Why:** the old page reads `ingredient_map`, a table with **0 rows**. Extending it would
mean carrying a dead design forward. The replacement is built fresh in Phase 3.

Consequence: dropping that table is still a live migration needing your in-chat OK, and
phrased as a table drop it is hard-refused in an unattended run. **Scheduled for an
interactive session.**

### D-3 · Comparison tool comes after the rate cleanup

> *"After rate cleanup it's not important intill a month from now."*

**Why it matters:** technically the comparison tool is **not blocked** by the rate work — it
divides concentrations and takes the rate as an input, exactly as your spreadsheet does. It
could ship right after Phase 1. **You chose the order anyway**, so the rate correction gets
the clean run.

**Target: roughly 2026-09-18.** If that date comes under pressure, the thing to protect is
the *quality of the rate review*, not the date. Phase 2 is the one phase that can put wrong
quantities on customer paperwork.

### D-4 · Return-policy screen — deferred

> *"We don't need the returns policy page yet not important."*

**This supersedes your earlier "asap" ranking.** Phase 0b leaves the near-term path
entirely. Knock-on effects already applied across all documents: 2–4 hours removed from your
data-entry estimate, its risk kept on record but marked deferred, and the first step after
Phase 0 becomes Phase 1.

The requirements stay written down so it can be picked up intact later.

### D-5 · Density is a must, and it is about scales

> *"this is a MUST and we do not capture that yet"*
> *"I need that also because we do a lot of blending based off scales so have to have weight
> of everything for scales and mixer."*

**Why this changed the plan more than any other sentence:** it reclassified density from an
analytical convenience into **operational safety data**, and widened the scope from ~300
EPA-linked liquids to **all 508 liquids** — because the products you blend most are
fertilizers, which carry no EPA registration at all.

It also forced a rule that did not exist before: **warn on entry, block on use.** Typing an
unusual density gets a warning. Asking the app for a scale weight when density is missing
gets a **refusal** — never a fall back to water, a default, or an estimate.

### D-6 · Density backfill is parked

> *"Let's wait on that for now I don't have time."*

**Applied:** Phase 1 is done when the *mechanism* works — one product can be given a density
and read back. It is **not** gated on the catalog being filled. That principle now applies to
every phase.

### D-7 · Fertilizers are in, with the complete analysis

> *"Yes I want fertilizer analysis stored for future so we can do recs etc and know poundage
> of actual applied etc make sure you can also store micronutrients and secondary macros, all
> complete analysis."*

**Applied:** primary macros (N, P₂O₅, K₂O), secondary macros (Ca, Mg, S) and micronutrients
(B, Cl, Co, Cu, Fe, Mn, Mo, Ni, Zn). Stored as a percentage, which is how a fertilizer label
states it — and combined with density that yields the "poundage of actual applied" you asked
for. **That is the second reason density is required for liquid fertilizer specifically.**

### D-8 · Total nitrogen only

Asked whether recommendations need nitrogen split into ammoniacal / urea / nitrate forms as
labels break them out: **total N is enough.**

**Applied:** the schema will not *forbid* the breakdown later, but no entry requirement ships
now. Adding form-level detail later does not mean re-entering the analyses captured now.

### D-9 · The comparison shows both your cost and the customer price

**Applied:** with a **selectable customer tier**. Three tiers already exist in the database,
so this needs no new schema.

### D-10 · Adjuvant cost is excluded from the generic build

**Your call, respected.** But it leaves a known directional bias: rebuilding a loaded branded
product from unloaded generics **understates the true cost of the generic route.**

Since that number drives real offers, **Phase 3 carries a visible on-screen note that the
comparison excludes adjuvant cost.** Stating the exclusion is not the same as pricing it, and
does not reopen your decision.

### D-11 · Ester versus amine — warn loudly

> *"Warn loudly we pretty much only use ester."*

**Applied:** 2,4-D ester and amine share a canonical acid for *search* purposes but are not
field-interchangeable. The tool **proposes with a loud warning, never refuses, never
substitutes silently.** Same rule for dicamba DGA versus BAPMA.

### D-12 · Return windows stay on paperwork

> *"on the returns don't worry about that we send out paperwork on those dates we can keep
> system simple on returns."*

**Applied:** a vendor × product-class × deadline model was proposed and declined. The flag
answers "can this ever come back"; the deadline stays outside the app. **Do not build the
date table.**

### D-13 · Brand selection is required when product arrives

**Why it is the right capture point:** the person unloading is holding the jug. Any later
point is a memory exercise.

**Applied, with your other constraint honored:** it must be satisfiable with the lot/tote
field left **blank**, because that is the normal case. A product spec with no brand rows
defined yet does not block receiving.

**This is the one change to your crew's daily routine in this entire project.**

### D-14 · Split loads show every brand with its amount

**Applied:** an application record drawing 30 gal of one brand and 15 gal of another shows
**both brands, both EPA numbers and both quantities** on the customer's paperwork — with no
lot or tote number entered anywhere.

### D-15 · Don't build on lot and tote numbers

> *"a lot of totes don't have lot numbers so some will not, make sure and note that — don't
> make tote number / lot the focus because not all have it."*

**You were right, and the data is worse than your caution** (see C-29). This is the single
most valuable correction in the project — it stopped a whole subsystem being built on
something with zero rows in it.

### D-16 · Blank is better than a guessed rate

**Applied:** a product with no true per-acre rate autofills **blank** on a quote line, not a
wrong number. Confirms removing the hardcoded ounce fallback rather than merely flagging it.

### D-17 · Mode of action — "great idea"

**Applied:** you confirmed products with **4–5 codes** exist and must be supported. Mode of
action is a property of the *ingredient*, so a product with five ingredients carries five
codes with no extra structure.

For herbicides, the **numeric global code only** — the legacy letter codes and the current
numeric ones coexist in the wild and mixing them is a known mess.

### D-18 · Required adjuvants

> *"some chemistry HAS to have a certain adjuvant."*

**Applied:** per product — adjuvant type (COC, MSO, NIS, AMS, drift agent…), whether it is
*required* or *recommended*, an optional note, and an optional link to a stocked product.
**The most commonly forgotten item on a quote.**

### D-19 · Crop and timing as pairs

> *"some products can be used pre emerge only on certain crops but also post on 1 crop."*

**Applied:** a **list of crop-and-timing pairs**, not a crop list plus a timing. Corn/pre-emerge
and soybeans/post-emerge are two separate rows. That is the only shape that can express what
you described.

Deliberately out of scope, at your direction (*"dont want to get to complicated"*): rates that
vary by crop. Real, but deferred — and the child-table shape means adding it later needs no
re-migration.

### D-20 · Rates carry a low, a high, **and** a recommended value

**Applied:** the recommended value may equal either end. This is what stops the range from
collapsing into one arbitrary number, which is exactly how B-13 happened.

### D-21 · Quote suggestion notes are picked at quote time and editable per grower

**Applied — and the machinery already exists.** The note auto-fills onto the line, is editable
on that specific quote for that specific grower, and has a reset-to-default button. Nothing to
build; see B-19 for the one catch before any mass-fill.

### D-22 · Product images copied into CRX storage, last priority

> *"save this for the end or last, not a high priority at the moment."*

**Applied:** and you chose CRX-owned storage over linking to your website, so quotes and PDFs
**cannot break if that site is restructured.** There is an existing proven pattern to copy.

### D-23 · Label links — "ok"

**Applied:** the EPA lookup already returns the label URL and a full list with accepted dates,
and the app **validates them and throws them away.** No label-URL column exists anywhere.
Storing the URL **and** the accepted date means a newer EPA label can be detected. Immediately
covers the ~287 products with a usable registration number.

### D-24 · Bulk editing, because one-by-one is unworkable

> *"very hard to navigate all these products going one by one."*

**Applied — and most of it already exists.** A download → edit in Excel → upload → preview →
apply round-trip is **live on the Products page today**, with a per-row concurrency guard, a
preview screen, file-size and archive safety, and formula detection. It already round-trips six
non-pricing fields.

**Immediate consequence: `quoting_notes` can be mass-filled in Excel today, with no new code.**

### D-25 · You enter the data personally

**Why this changes the design:** it makes the EPA auto-seed and the workbook **load-bearing
rather than convenient**, and it makes the honest hours estimate in Part 3 a real planning
input rather than a footnote.

### D-26 · Your spreadsheet is not an import source

Your confirmation that it is *"not complete and is not automatic"* means it is a seed for the
brand shorthand layer, **not** a substitute for EPA ingredient data. **Do not plan around
importing it wholesale.**

### D-27 · Restricted-use count — parked

> *"there are alot more but not important today."*

**Applied:** parked with the label-rate work. Until then the RUP compliance report is treated
as **known incomplete**, and Phase 3 never presents restricted-use status as verified fact.

### D-28 to D-31 · Four things you turned down

| You declined | Your words | Consequence |
|---|---|---|
| Companion / tank-mix partner products | *"good idea in theory but not universal enough to warrant building"* | Not built |
| Successor product pointer | *"maybe, dont want to get to complicated lets not do this one"* | Not built |
| Storage / freeze risk tracking | *"skip it for now"* | Not built |
| Per-crop rates | *"dont want to get to complicated"* | Deferred; the child-table shape leaves room for it |

---

## 2B — Technical decisions I made

These are mine to make. They are recorded so you can see them, not because you need to choose.

### T-1 · Two tables, not three

I originally described a three-layer model — ingredient → generic benchmark → real product.
Having checked the data, **the middle layer is unnecessary.** A benchmark like "Generic
Roundup 5.4#" is not a separate thing to store — **it is a real product already in your
catalog**, carrying a real glyphosate concentration. Once concentrations live on real
products, the benchmark is just a nickname.

Simpler, and one fewer place for the same fact to live.

### T-2 · `canonical_ingredient_id` + `ae_fraction` — two columns, no new architecture

Fixes B-8 and B-9 together:

- **`canonical_ingredient_id`** — a self-reference. Every salt-form row points at the parent
  acid row. All searching and grouping goes through it, so **"glyphosate" means one thing.**
- **`ae_fraction`** — multiply a salt-basis concentration by this to get acid equivalent
  (IPA salt ≈ 0.74, potassium ≈ 0.817, DMA ≈ 0.78).

The `basis` column can *detect* that two rows disagree. It cannot *reconcile* them. Nothing in
the original design could.

### T-3 · Mode of action goes in a child table, not two columns

The original plan said "stored as a scheme column plus a code column" and then, two lines
later, "an ingredient may carry more than one code." **Two single-value columns cannot hold
more than one thing.**

The scheme is **required** — a Group 15 fungicide and a Group 15 herbicide are unrelated and
must not collide.

### T-4 · Rates go in a child table, not columns on the product

The original plan proposed one set of rate columns. That **cannot store what the plan itself
promised.** MSO XL needs *two* rates: the label's `2 qt/100 Gal` and the house's
`9.6 oz/acre`. One set of columns holds one or the other — **which is exactly how the
9.6-versus-6 split happened in the first place.** Columns would label the problem; they would
not fix it.

The child table also gives your deferred per-crop rates a home later with no re-migration.

**Plus the consumption rule, which was undefined:** quotes read **only** the per-acre
quoting-default row, and exactly one such row is allowed per product — enforced by the
database, not by a screen.

### T-5 · Density validation is a warn band, not a hard reject

The originally proposed 8–12 lb/gal hard reject **was wrong and would have corrupted your data
by refusing it.** Crop oil concentrates and MSOs run about **7.6–7.8 lb/gal** — lighter than
water — so a floor of 8 would have rejected **essentially every oil adjuvant in your catalog.**
Some suspension concentrates and fertilizer solutions run above 12.

**Corrected: warn band roughly 6.5–14 lb/gal. Warn, never reject.** Water at 8.34 stays the
mental anchor, not the rule.

And separately: **"5.4#" is not a density.** It is pounds of glyphosate salt per gallon — an
ingredient concentration. The product itself is roughly 10.2 lb/gal. Conflating them produces
**scale weights wrong by about half.**

### T-6 · The product row stays the sellable spec; brands sit underneath it

**This is the most important structural call in the project**, and it came from you, not from
a reviewer.

Quotes, tiers, per-acre pricing, invoices, cost-at-quote snapshots and inventory **all key on
the product id today, and none of them need to change.** You go on quoting "5.4# glyphosate"
in December without the system knowing which jug will arrive.

Underneath sits one row per acceptable brand, each with its **own EPA registration number**,
manufacturer, label, and density. Then at receiving, you record which brand actually filled
the order — which is what puts a **real EPA registration number onto an application record**
without disturbing how anything is sold.

### T-7 · Brand attaches to the receiving record, independent of any batch identifier

Forced by C-29 and D-15. A lot or tote number, where one happens to exist, is **optional
supporting detail recorded beside the brand — never the key it hangs from.** The dormant
lot/tote columns are left strictly alone: not extended, not deleted, and never a condition of
any brand behavior.

### T-8 · Density precedence: spec first, brand may override, screen shows which

Forced by C-27. **The spec's density is the working value. A brand row may carry an override.
The weight calculation uses the recorded brand's density when a brand is recorded and that
brand has one; otherwise the spec's. And the screen displays which one it used.**

"Whichever row is authoritative" is not something a person can build. This is.

### T-9 · Fertilizer nutrients live in the same ingredient table, with CFU units added

**A percentage of a product is a percentage of a product** whether the substance is mesotrione
or zinc. One place to look, one set of unit rules.

Biologicals get `cfu_per_ml` / `cfu_per_g` rather than a nonsense percentage. Round 2 left this
an either/or; "complete analysis" with 9 products unstorable is self-contradictory.

### T-10 · Drop `lb_per_lb` as a concentration unit

It is a percentage divided by 100 — **the same axis written two ways**, and two ways to write
one thing is an entry-error generator. Pick one.

### T-11 · The old rate columns become a read-only mirror of the new table

This resolves the biggest open question in the project — what happens to `products.rate_per_acre`
once the child table is the truth (C-30).

**Keep the columns, sync them automatically from the quoting-default rate row, and revoke the
app's ability to write them directly.** This is the governance pattern **already proven in this
codebase** on the four return-policy columns (C-42).

Three things fall out of it for free:

1. All **83 consumer files keep working**, with one consistent meaning.
2. The blank-not-guessed behavior lands **everywhere at once**.
3. The three product write paths (C-31) are **forced** through the new rate function, because
   their direct writes start failing loudly instead of silently doing the wrong thing.

### T-12 · The blank-unit rejection is a database rule, not a screen check

Per the project's standing rule that invariants live in the database. **A database check covers
all three write paths for free; a screen check covers one.**

### T-13 · Remap unit spellings first, then delete aliases — never the reverse

Forced by C-26. And **do not change any conversion factor in the same change** — the cleanup is
provably price-neutral only as long as no factor moves.

### T-14 · Extend the existing workbook; do not build a second system

Rebuilding would mean re-earning the concurrency guard, the preview flow, and the archive
safety. **The concurrency guard in particular is what prevents a bulk upload from silently
overwriting an edit someone made in the app while the spreadsheet was open.**

**List-type data needs extra tabs** — a `Products` tab plus `Ingredients` and `Crop Uses` tabs
keyed by product. **Never a delimited string in a single cell**, which is how bulk imports go
silently wrong.

### T-15 · Ship the workbook's rate columns read-only from the start

Forced by C-32. Otherwise the workbook becomes a fourth write path the rate phase has to unwind.

### T-16 · Re-SKU the duplicate — do not merge or deactivate it

The two `9768NR` rows are **two genuinely different sellables** — a 265-gallon no-return tote
and Bulk. Merging destroys a real business distinction; deactivating hides a product you
actually sell. **Giving one row a distinct SKU is the correct fix.**

### T-17 · Never hard-delete in the hygiene phase

Duplicate and test rows may carry history in quote lines, invoices and inventory movements,
which makes a hard delete either impossible or **silently destructive.** Deactivate or
re-identify; never delete. If any row genuinely warrants deletion, that is a **separate request
to you** with the reference survey attached.

### T-18 · Reuse the existing propose-review-commit pipeline for EPA seeding

There is already a live pattern in this codebase for machine-sourced data that needs human
sign-off, with a status set, a confidence score and a reviewer stamp. **That is exactly what
EPA ingredient seeding is.** The plan's simpler `source` / `verified_at` columns are a weaker
substitute for something that already exists — so reuse it, or write down why not.

### T-19 · Families exclude products with zero ingredient rows

Otherwise **every adjuvant and fertilizer in the catalog — all of which have no ingredients
recorded — collapses into one giant false "family."**

### T-20 · A family-drift check, so packaging siblings cannot diverge silently

Flag any family whose members disagree on ingredients or density. Without it, the comparison
tool will eventually give **two different answers for the same chemistry in two pack sizes** —
confidently, and with no warning.

### T-21 · Make `inventory_unit` required when `unit_size` retires

Otherwise a future product created without it **re-arms the dead fallback** that C-41 just
established is harmless today.

### T-22 · Comparison money math parses to whole cents before arithmetic

Per the project's standing money rule. The original plan was silent on this, and the comparison
tool does money math over cost and tier-price columns.

---

## 2C — Considered and rejected

| Rejected | Why it was tempting | Why not |
|---|---|---|
| **Every brand becomes its own product row**, grouped by family, quotes reference the family | Arguably the more "correct" database normalization | Rewrites quoting, pricing and inventory to be family-aware — **to fix a workflow that is not broken.** Revisit only if the child-table shape proves insufficient in practice |
| **Parse the parenthetical brands into a plain text column** | Cheapest possible option; keeps search working | Delivers **none** of the three things you asked for: per-brand EPA number, per-brand density, per-brand label |
| **Retire `product_families` in favour of brand rows** | Both tables have 0 rows, so it looked free | It is not free — Phase 5 explicitly writes to families. Different axes; both ship (C-28) |
| **A hard 8–12 lb/gal density reject** | Sounds like tight validation | Would have **rejected every crop oil and MSO in your catalog** (T-5) |
| **A vendor × product-class × return-date table** | Models the real world accurately | **You declined it.** Deadlines stay on paperwork |
| **Hanging brand tracking on the existing lot chain** | A lot number *is* a specific branded batch | **Zero rows exist in that chain.** Building on it would be building on nothing (C-29) |
| **Building a second bulk-import system** | A clean sheet is easier to design | Throws away a proven concurrency guard, preview flow and archive safety (T-14) |
| **Rate columns on the product row** | Simplest possible shape | **Cannot store two rates for one product** — which is the actual requirement (T-4) |

---

## 2D — Claims that were wrong, and the corrections

Recorded so you can see where this document changed its mind. Every one of these was corrected
in place rather than quietly softened.

| The claim | The truth |
|---|---|
| ~190 products need ingredients typed by hand | **317** have no usable EPA registration number, and ~123 of those are **real pesticides**, not fertilizers |
| 300 products have an EPA registration number | 300 non-NULL, but **13 are whitespace-only → 287 usable** |
| `rate_per_acre` appears in 82 files | **83** |
| The per-100-gallon cleanup is 12 rows | 12 rows for that literal string; **37 rows** for the full class, including weight-based entries |
| `12-16 oz/acre` drifts between two stored values | **Three**: 12, 8.5 and 8 — which strengthens the case for the rate phase |
| `2 qt/100 Gal` appears on two rows | **12 rows across 6 formulations** |
| Classifying return policy *unblocks* transactions | It **starts** blocking. `unknown` blocks nothing today |
| The four return functions enforce the policy guard | They **delegate** to internal functions that carry it. Same enforcement, wrong stated mechanism |
| Retiring `unit_size` can move a customer's price | **Dead code today** — `inventory_unit` is filled on all 604 |
| Filling `quoting_notes` is an inert freebie | **Customer-visible** — `notes` is the live fallback for 444 products |
| The comparison tool is hard-blocked by the rate phase | **Not blocked.** You chose the order anyway |
| Brand tracking should ride the existing lot chain | **Retracted.** That chain has 0 rows (C-29) |
| Codex cannot reach the live database | **False** — its connector is configured against the live project |
| Brand table versus families is a free choice | **False.** Both are needed (C-28) |
| 30 products have a filled rate with a blank unit | **Zero do.** The trap is armed but not firing |

---

# PART 3 — THE PLANNED CHANGES

---

## What this expects of *you*

**Every phase is finished when the mechanism works — never when the catalog is full.** No
phase is held open waiting on data entry.

### Your data-entry burden, honestly estimated

| Work | Volume | Rough time |
|---|---|---|
| ~~Return-policy classification~~ — **deferred, not counted** | ~~581 products~~ | ~~2–4 hrs~~ |
| Typing EPA registration numbers so ingredients can auto-fill | ~123 pesticides with ingredients but no number on file | 4–6 hrs |
| Ingredients for products that will never have an EPA number | ~194 fertilizers, adjuvants, biologicals | 6–10 hrs |
| **Density lookups (a safety data sheet per product)** | up to 508 liquids — **no shortcut exists** | **15–25 hrs** |
| Reviewing re-derived rates | 573 values, reviewed not auto-rewritten | 5–10 hrs |
| Fertilizer guaranteed analyses | ~130 products | 3–5 hrs |

**Total: roughly 33–56 hours of your time**, spread across the project. These are estimates,
not measurements — treat them as the right order of magnitude, not a quote.

You have already parked the density backfill. That is respected: **the mechanism gets built,
the catalog fills when you are ready.**

### What changes in your crew's daily routine

**One thing only: picking the brand when product arrives** (D-13). It works with the lot/tote
field left blank, which is the normal case.

Everything else — quoting, invoicing, inventory, deliveries — behaves exactly as it does today
until Phase 2, and **Phase 2's only visible change is that a product with no real rate shows
blank instead of a wrong number.**

---

## The build order came from your ranking

| Your call | The problem | Where it went |
|---|---|---|
| **Top priority** | Active ingredients aren't stored | **Phase 1** — and it is why Phase 1 comes before everything |
| "asap" | Families, packaging variants, return policy all empty | Split: families → Phase 5; return policy → **since deferred by you** |
| "lets fix this" | Two fields hold the same package size | **Phase 7** |
| "consolidate and standardize" | Unit spellings inconsistent | **Phase 2** |
| "yes we need to fix this" | Duplicates, blanks and a test row | **Phase 0** — pulled to the front |
| "we will do this later" | Label rate, REI, PHI empty | Out of scope for now |
| "not concerned right now" | No required fields on create | Out of scope for now |

**Two changes I made to your order:** data hygiene moved up to first (it is cheap and it
de-noises everything after it), and the return-policy screen was split onto its own track —
which you have since deferred entirely.

---

## Phase 0 — Data hygiene

**Goal:** stop the junk rows from polluting every phase after this one.

| What changes | Detail |
|---|---|
| Duplicate SKU | `9768NR` — **re-SKU one row** (T-16). Both stay active and orderable |
| 13 blank SKUs | Resolved so every SKU is unique |
| 3 duplicate name groups | Resolved |
| `1A TEST PRODUCT - FAKE PRODUCT` | Removed from the working set — **deactivated, never hard-deleted** |
| 13 whitespace-only EPA registrations | Trimmed to **NULL**, so a bulk EPA lookup does not fail on them. Not empty string — an empty string still counts as non-NULL and would recreate B-22's miscount |
| 11 blank `product_form` rows | Classified liquid or dry — **units checked first**, because the live trigger can reject the classification (C-26) |

**Done when:** every SKU identifies exactly one sellable, no row was hard-deleted, and all
historical references still resolve.

**Risk:** Low, but it touches live rows — **each class of change needs your OK before it runs.**

**Rollback:** each change is individually reversible; nothing is deleted.

---

## Phase 0b — Return-policy screen — **DEFERRED, DO NOT BUILD**

> **Your words, 2026-08-18:** *"We don't need the returns policy page yet not important."*

Superseded the "asap" ranking. Out of the near-term path. **Requirements stay written down so
it can be picked up intact later.** Nothing scheduled.

Three things preserved for whenever it resumes: the screen must offer **four** values, not
three (the live constraint allows `returnable`, `no_return`, `not_applicable`, `unknown`);
bulk classification is **not** "a screen that calls the existing function," because that
function is strictly one-product-at-a-time; and there is a **cheaper third option** — an
evidence-backed classification migration, for which this repo already has a precedent.

---

## Phase 1 — Ingredient foundation, mode of action, density, brands

**The core of the project.** 20 requirements, and they are **not independent** — a builder who
starts on screens will build them against tables that then change shape.

### The internal order, which must be followed

1. **Settle the brand-versus-families shape** — already settled (C-28), because it determines
   where ingredient and density rows hang
2. **Tables and migrations** — including **column permissions in the same migration** (C-25)
   and update triggers on every new table
3. **Density precedence written down** (T-8) **before any weight math is coded**
4. **EPA auto-seeding**, which fills the ~287 products that can fill themselves
5. **Screens**, once the shapes are stable
6. **Copy-from-sibling last**, since it operates on everything above

### What gets built

| Area | What it is |
|---|---|
| `active_ingredients` | The canonical chemical list — name, CAS number, EPA code, **`canonical_ingredient_id`**, **`ae_fraction`** |
| `product_active_ingredients` | Which chemicals are in which product, how much, on which **basis**, from which **source**, verified by whom and when |
| `ingredient_moa_codes` | Mode-of-action codes — scheme + code, **multiple per ingredient** |
| Brand rows | Under each product spec: brand name, **its own EPA registration**, manufacturer, label, density, and whether it is currently sourced |
| Brand at receiving | A brand column on the receiving record, **independent of any lot or tote number** |
| Density | Value, unit, and **source** (label / SDS / supplier / measured / assumed) |
| Fertilizer analysis | Complete guaranteed analysis, including CFU units for biologicals |
| Formulation type + safener | Because identical ingredients are not always interchangeable (C-33) |
| Sourcing-quality tier on the brand row | Because identical ingredients are sometimes *deliberately* different products (C-43) |
| Nickname | Plain text on the product — **and searchable**, because that is how you look products up |
| EPA status signals | Persist `productStatus` and `isCancelled`, currently fetched and discarded — the **only automatic rot detector available** |
| Audit trail | Who changed a concentration, density or analysis, when, and from what (C-37) |

**Done when:** you open a product **in the running app as a normal user**, add ingredients, a
density and a brand, save, reload — and they are all still there. **Not "tests pass."**

**Risk:** Low. Purely additive — new tables, no existing column changed, no money math. The
one real trap is the column permissions (C-25), which is now a hard requirement.

**Rollback:** additive, so rollback is "stop using it."

**Gates:** RLS review + migration-drift review before apply. **Live apply needs your OK.**

---

## Phase 1b — Product Data Workbook

**Goal:** stop editing 604 products one at a time.

- Widen the **existing** workbook machinery to a full product-data column set
- Add `Ingredients` and `Crop Uses` tabs for list-type data
- **Reuse — do not reimplement** — the concurrency guard, preview screen, and archive safety
- **Ship the rate columns read-only** (T-15)

**Done when:** download, edit in Excel, upload, preview, save — with the existing safety
guards intact. Editing a product in the app while a workbook is open causes that row to be
**refused, not silently overwritten.**

**Risk:** Medium. Bulk writes touch many rows at once — which is precisely why the existing
guard and preview are being reused rather than rebuilt.

**Note:** `quoting_notes` can be mass-filled through the *existing* pricing workbook **before
this phase ships. No code needed.**

**Still open:** does an absent row in the new tabs mean *delete* or *ignore*? The hardest
question in any bulk round-trip, and it must be answered before this is built.

---

## Phase 2 — Rate correction and unit standardization

**Goal:** stop producing inconsistent quantities on customer-facing documents. **This is the
highest-risk phase in the project.**

| What changes | Detail |
|---|---|
| `product_rates` child table | `basis`, `source`, **low / high / recommended**, unit, and exactly one quoting default per product |
| Quote consumption rule | Quotes read **only** the per-acre quoting-default row. No such row → **blank, not a guess** |
| Blank-unit rejection | A **database check**, covering all three write paths (T-12) |
| Hardcoded `'oz'` fallback | **Removed** in the same change |
| Old rate columns | Become an **automatically synced read-only mirror**; direct app writes revoked (T-11) |
| Three write paths | All updated in the same change (C-31) |
| Unit spellings | Consolidated — **remap first, delete aliases second** (T-13) |
| Re-derived rates | **573 values, reviewed by you before anything is written.** No bulk auto-rewrite |
| Per-100-gallon class | All **37 rows** reviewed, not 12 — including weight-based ones |
| Seed treatments | A rate basis that actually fits them (C-40) |

**Done when:** a product with no per-acre rate autofills blank on a quote line, and quote
totals are **byte-identical before and after** the unit remap.

**Risk:** **Medium-high.** The rate number feeds applicator sheets, application reports,
blend-math validation and invoices across 83 files.

**One thing that limits the exposure:** the correction propagates **forward only.** Quote lines
copy the rate at the moment a product is added, and the save recomputes from the line's own
stored value — so **existing quotes and invoices do not retroactively change.** The exposure is
new documents defaulting from a wrongly re-derived number, which is exactly what your row-by-row
Excel review in Phase 1b is there to catch.

**Rollback:** behind a feature flag — the obvious mitigation, and it must be built in.

---

## Phase 3 — The comparison tool *(target ~2026-09-18)*

**Goal:** *"show me everything containing mesotrione"* and *"what does it cost to build Halex
GT out of generics."* **This is the payoff.**

The math is one division, and it has been **proven against your own sheet.** Halex GT at 4 pt,
three for three exact:

| Ingredient in Halex GT | Generic benchmark | Your sheet | Calculated |
|---|---|---|---|
| 2.09 lb ae glyphosate/gal | Generic Roundup 5.4# (4.0 lb ae/gal) | 33.44 oz | **33.44 oz** |
| 0.209 lb mesotrione/gal | Generic Callisto (4.0 lb/gal) | 3.34 oz | **3.344 oz** |
| 2.09 lb s-metolachlor/gal | Generic Dual (7.64 lb/gal) | 1.09 pt | **1.094 pt** |

**There is no hidden logic to reproduce.**

| What gets built | Detail |
|---|---|
| Ingredient search | Through the **canonical id**, so one search finds every salt form |
| Mode-of-action search | Serves *"old chemistry, has gotten weak on waterhemp"* — resistance tracking needs the group number |
| Build-from-generics comparison | Read-only. No writes, no pricing changes |
| Both prices | Your cost **and** the customer price, with a **selectable tier** (D-9) |
| Adjuvant exclusion note | **Visible on screen wherever a total is shown** (D-10) |
| Coverage gaps | **Surfaced loudly, never silently dropped.** An incomplete rebuild priced as complete is the worst output this tool can produce |
| More-expensive results | **Shown plainly**, not suppressed |
| Ester/amine, safener, formulation type | **Warn loudly** (D-11, C-33) |
| Unverified numbers | Visibly marked as unverified |
| Restricted-use status | Never presented as verified fact (B-21) |
| Old page and table | **Retired** (D-2) |

**Done when:** both questions answer correctly, the Halex GT case reproduces your sheet, and
the old page and its empty table are gone with no dead references.

**Risk:** Low-medium. Read-only — but it **displays cost figures**, so the arithmetic gets
tested against your sheet rows as the acceptance check, and the money math parses to whole
cents (T-22).

---

## Phase 4 — Label links, adjuvants, crop and timing, quote notes

| What gets built | Detail |
|---|---|
| EPA label URL + accepted date | Currently fetched, validated, and **thrown away**. Covers ~287 products immediately |
| Required/recommended adjuvant | Per product, with type — **the most commonly forgotten item on a quote** |
| Crop + timing pairs | Corn/pre-emerge and soybean/post-emerge as separate rows |
| The three note boxes | Made visually distinct, with **the customer-facing one clearly marked** |

**Done when:** each is visible on a real product in the running app.

**Risk:** Low. Additive; nothing here changes an existing calculation.

---

## Phase 5 — Product families and packaging variants

- Families **derived, not typed.** Same ingredients at the same concentrations = drop-in
  equivalents. **The app proposes; you approve.**
- **Exclude products with zero ingredient rows** (T-19)
- **Respect the sourcing-quality tier** (C-43) — `Gen Liberty` and `Gen Liberty: Higher
  Quality` have identical actives and must not be silently merged into one equivalence
- **Family-drift check** (T-20)
- **Same ingredients ≠ interchangeable** — safeners, formulation type, built-in adjuvant load,
  and matching on the **specific** ingredient row, not the canonical parent (C-33)
- Use the **EPA distributor-registration signal**: two catalog rows sharing a parent
  registration number are the same formulation — the cheapest reliable family evidence
  available, and currently unused

**Risk:** Medium. Grouping the wrong products as equivalents would let the comparison tool
propose a substitution that is not one. **You approve each grouping.**

---

## Phase 7 — Retire `unit_size`

Deliberately late. The real reason is **breadth, not money** (C-41): 50+ files, a workbook
column, and database function bodies that must be re-emitted.

Plus: **make `inventory_unit` required in the same migration** (T-21).

**Gates:** the full treatment — a fresh exact-commit adversarial review at high effort, plus
your explicit approval.

---

## Phase 8 — Product images — LAST, at your direction

Copy product images from your website into **CRX-owned storage**, following an existing proven
pattern. Copied, **not linked** — so quotes and PDFs cannot break if that site is restructured.

---

## Parked — not scheduled

| Item | Your words |
|---|---|
| Label rate / REI / PHI | *"we will do this later"* — Field Mode's over-label-rate warning stays inert until this is done |
| Required fields on product create | *"not concerned right now"* |
| Restricted-use product correction | *"there are alot more but not important today"* |
| Density catalog backfill | *"Let's wait on that for now I don't have time"* |
| Per-crop rates | *"dont want to get to complicated"* |

**Also considered and parked with the label work, listed once so nobody re-raises them as
oversights:** rainfast interval, grazing and feeding restrictions, plant-back and rotational
crop intervals, carrier-volume minimums, mix order and tank-mix compatibility, PPE, state
24(c)/SLN registrations, and application temperature limits.

---

# PART 4 — GATES, OPEN ITEMS, AND THE NEXT STEP

---

## What needs your explicit OK, every time

Per the project contract — a handoff **never** carries approval forward:

- **Applying any live database migration**
- **Any bulk write to live product rows** (Phases 0, 2, 5)
- **Pushing, opening a pull request, merging, or deploying**
- **Deleting anything**, including dropping the old `ingredient_map` table in Phase 3

Every new table must have row-level security with policies **in the same migration**; every new
writing function must accept and actually enforce an idempotency key; every new product column
must ship its permission grant (C-25).

---

## Still open — and who decides

### Needs your decision

**1. Codex credits.** The project contract requires an independent adversarial review, pinned
to a specific model at high effort, before any risky migration lands. **Codex is currently at
zero credits, so that gate cannot run.** This does not block Phase 0, but it blocks the first
migration-bearing phase. **Recommendation: restore credits before Phase 1's migration is ready
to apply** — not now, but before that point.

**2. Whether to confirm the Supabase connector in the Codex app is live and correctly scoped**
before a builder relies on live-database access. Its OAuth grant was recorded dead on
2026-08-14.

### Technical — I decide, recorded so you can see them

| Open item | Recommendation |
|---|---|
| Absent rows in the workbook's new tabs — delete or ignore? | Must be answered before Phase 1b is built |
| Concurrency token for the child tables | The existing guard covers the product row only |
| How much brand back-fill is manual | **Plan it as a human-reviewed pass.** 129 names contain parentheses, but several are not brand lists — "(Full pallets)", "(New Formulation of Resicore XL)". Mechanical parsing produces junk |
| Per-phase rollback for Phases 0 and 2 | Phase 2 behind a feature flag |
| Whether specific-gravity entries normalize on write or on read | Pick one and write it down; a mixed convention produces two subtly different numbers for the same product |

---

## How we will know it worked

| Test | Passes when |
|---|---|
| Ingredient search | Searching "glyphosate" returns **every** product carrying **any** salt form — not a partial list |
| The Halex GT case | The tool reproduces your sheet: 33.44 oz, 3.34 oz, 1.09 pt |
| The gap case | "Resicore REV" reports the **missing ingredient** rather than pricing an incomplete rebuild as complete |
| Scale weight | A product with no density **refuses** to produce a weight, rather than guessing |
| Receiving with no lot number | Brand capture, split-load quantities and EPA numbers on paperwork **all work completely** |
| A new column | Edit it **through the running app as a normal user** — the value persists |
| Unit remap | A quote's total is **byte-identical** before and after |
| Blank rate | A per-unit-only product autofills **blank**, not a number |

---

## The recommended first step

**Approve this document. Then Phase 0 — data hygiene — starts.**

It is the cheapest phase, it touches only 28 rows, nothing is deleted, every change is
reversible, and it makes every phase after it quieter. It needs no migration gate and no Codex
credits.

While that runs, the one thing worth doing on your side is deciding when to restore Codex
credits — that gate is needed before Phase 1's migration can be applied, not before it can be
written.

---

**Nothing in this plan is built until you say go.**
