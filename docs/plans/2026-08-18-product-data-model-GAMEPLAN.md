# Product Data Model — Complete Game Plan

**Date:** 2026-08-18
**Owner:** Mason Wells
**Status:** AWAITING MASON'S APPROVAL. **No building has started. Nothing is to be built
until this document is approved.**

## What this document is

The single readable statement of the whole project: what we are building, what it will
require of you, everything that can go wrong, what is already decided, and what is still
open. It is written to be read start to finish without needing to look at code.

Two companion documents hold the detail and the history:

| Document | Purpose |
|---|---|
| `2026-08-18-product-data-model-plan.md` | *Why* the design is shaped this way, plus the full record of three review rounds and what each changed |
| `2026-08-18-product-data-model-PRD.md` | The numbered requirements a builder works from, each with its acceptance test |

Where this document and those two disagree, **this one is the intent** and the others
should be corrected to match.

**How we got here:** the design has been through three independent adversarial reviews
(2026-08-18) and one correction from Mason that overturned a review finding. Round 1 asked
"is this sound?" — yes, four amendments. Round 2 asked "what's missing?" — 24 gaps, and it
caught two of my own factual errors. Round 3 reviewed the combined result and said **"not
ready to build"** — four defects plus eight more factual corrections. Mason then rejected
round 3's headline finding, correctly (see Risk 5). Everything below reflects the state
after all of that.

---

## 1. The problem, in one page

The product catalog is **built and unfilled**, and the fields that matter most for pricing
don't exist at all.

**Unfilled.** Fields that already exist and enforce real rules sit empty. 581 of 604
products have return policy `unknown`. `max_label_rate` is filled on zero products, which
makes Field Mode's "over label rate" safety block permanently inert — it looks like a
guard, it does nothing. Quote notes are wired end-to-end into the Quote Builder and filled
on zero products.

**Missing entirely.** Active ingredients, their concentrations, and product density are not
stored anywhere. Because density is missing, the unit system has two disconnected ladders —
liquid and dry — with no way to convert between them. Your entire brand-versus-generic
pricing method depends on all three of these.

Today you do this work by hand in a Google Sheet whose numbers are **typed, not computed**,
so they never recalculate when a cost changes. You confirmed that sheet is not complete,
isn't automatic, and uses brand names rather than actual chemistry — so it is not an import
source. We are not building from it.

---

## 2. The design, in plain English

Five layers, built in order. Each one is useless without the one beneath it.

### Layer 1 — The product row stays what you sell

This is the most important decision in the design, and it means **nothing about quoting,
pricing, tiers, invoicing or inventory changes.**

You sell a **spec**: "5.4# glyphosate", "LV6 ester 2,4-D". You quote that in December
without knowing which jug will show up. The product row stays exactly that — the sellable
spec. Quotes, price tiers, per-acre pricing, invoices, cost snapshots and inventory all key
off it today and none of them need rework.

### Layer 2 — Brands sit underneath the spec

What actually arrives is a **brand**: Ag Saver, Red Eagle, Slam 54, Lima 6. Each brand has
its own EPA registration number, its own label, sometimes its own density. You asked
specifically to track the real EPA number per brand, because that's the number that matters
if a field record is ever audited.

So each product spec gets a list of acceptable brands beneath it. When product arrives, the
person receiving it picks which brand it is.

**The brand is recorded on the receiving record itself.** It does *not* depend on a lot
number or a tote number — you flagged that many totes don't have them, and the data proved
you understated it (see Risk 5). Where a lot or tote number happens to exist it's noted
alongside; it is never the thing the brand hangs from.

When one load draws from two brands, both get recorded with how much came from each, and
both appear on the customer's paperwork.

The brand name and EPA number are **copied onto the record at the moment it's written**, not
looked up later. That way, fixing a typo in a brand's registration number next year cannot
silently rewrite a spray record from this year.

### Layer 3 — What's actually in the product

Active ingredients with concentrations, stored properly for the first time. Three things
this has to get right that a naive version would get wrong:

- **Acid equivalent versus salt weight.** 5.4# and 5.5# glyphosate are not "2% apart" —
  they're different salts (IPA versus potassium) with different acid equivalents. Storing
  the number without storing which basis it's on produces confidently wrong comparisons.
- **Same ingredient, different names.** The EPA lists glyphosate salt forms under separate
  names. Searching "glyphosate" must return every product carrying any of them, so salt
  forms point back to a parent chemistry.
- **Mode of action codes** (the resistance-management groups) belong to the ingredient, and
  a product can carry several. They go in their own list, not squeezed into a single field.
  You flagged that *"some products have 4 or even 5 FRAC numbers"* — the list has no ceiling,
  and a product carrying five renders all five.

**Fertilizer gets the complete guaranteed analysis** — nitrogen, phosphate, potash, the
secondary macros (calcium, magnesium, sulfur) and the full micronutrient list. You settled
that total nitrogen is enough; we won't require the ammoniacal/urea/nitrate breakdown, but
the design won't forbid adding it later.

You asked for this so the system can *"do recs etc and know poundage of actual applied."*
That second half is the reason liquid fertilizer specifically needs a density: the label
states a percentage by weight, and turning that into pounds actually applied per acre
requires knowing what a gallon weighs.

### Layer 4 — Density, because you blend on scales

Your words: *"we do a lot of blending based off scales so have to have weight of everything
for scales and mixer."*

Density is currently stored **nowhere in the entire database**, and the words
density / specific gravity / lb-per-gal appear **zero times** anywhere in the application.
This is genuinely new capability, not a tidy-up.

Two rules that matter:

- **Warn when you type it in, block when it's used.** An unusual density gets a warning, not
  a rejection — real products range wider than people expect. But when the app is asked to
  produce **a weight for a scale** and it has no density, it must **refuse and say so**. It
  must never fall back to water, a default, or an estimate. Silently guessing a scale weight
  is the worst failure this project could ship.
- **"5.4#" is not a density.** It's pounds of glyphosate per gallon; the product itself is
  around 10.2 lb/gal. Confusing them produces scale weights wrong by roughly half.

Dry products need a net weight per package, or they can't take part in weight-based blending
at all.

### Layer 5 — Rates, corrected

Rate is currently one number on the product row, and it's inconsistent. The same label text
"12-16 oz/acre" is stored as 12 on one product, 8.5 on another and 8 on a third. Some
products carry a per-100-gallon label rate and a per-acre house standard at the same time,
which a single field cannot represent.

Rates move to their own list, where a product can hold more than one — label rate and house
standard, per-acre and per-100-gallon — with exactly one marked as the quoting default.

**Each rate carries a low, a high and a recommended figure**, which is what you asked for:
*"maybe we set a low, high, and recommended rate? sometimes the recommended might match the
high or the low."* The recommended value is allowed to equal either end — that's normal, not
an error. Today the range lives in a free-text box, which is why the same label text stores
three different numbers across three products.

**Adjuvants are the awkward case and are handled the way you already handle them.** Many are
labeled as a concentration — a percent of the spray solution — not as a rate per acre. Your
practice is to record the normal per-acre rate you actually use, and that stays: the per-acre
rate is what quotes, and the per-100-gallon basis is there for the products that need it.

**A product with no true per-acre rate autofills blank, not a guess.** You chose this. Today
there's a hardcoded fallback that quietly turns an unknown unit into ounces; that gets
removed.

### On top of the five layers — the things you asked for by name

These aren't structural, they're the features that sit on the foundation. They land in
Phase 4 unless noted.

**Stop retyping your agronomy.** The one you described at most length: a stored suggestion
per product, in your own words, so you don't retype it every quote. Your example was *"Old
chemistry, generally a lot cheaper to build than buy. Has gotten weak on waterhemp, recommend
spiking an extra ounce of Explorer with it and add Stigmata (generic Stinger) to help with
knockdown."* Two rules you set: it's **selected at quote time**, not forced onto every quote,
and the wording stays **editable grower to grower** after it's pulled in. The machinery for
this already exists in the Quote Builder — auto-fill, per-quote edit, reset-to-default — and
is filled on zero products. This is mostly a matter of giving it something to say.

Separately from that, the description you have today (what the product is made of — "Halex GT
= Roundup + Dual + Callisto") stays as is. The suggestion note is a second, different thing.

**A link to the actual product label**, so it's one click from the product instead of a
search.

**Required adjuvants.** Your words: *"some chemistry HAS to have a certain adjuvant."* Stored
per product with the type, and surfaced when quoting.

**Crop and timing.** Not just which crops a product is labeled for, but the timing within
them — *"some products can be used pre-emerge only on certain crops but also post on 1
crop."* Kept deliberately simple at your direction (*"dont want to get to complicated"*):
rates that vary by crop are **not** in scope.

**Product images — Phase 8, last.** You already have these on the website you built (product
logos and so on). Your call was to **copy them into CRX's own storage** rather than point at
the website, so the app doesn't break if that site changes. They follow the same storage
pattern the delivery and receiving photos already use, and end up on quote PDFs.

---

## 3. What this expects of *you*

This is the part most likely to determine whether the project succeeds, so it's stated
plainly rather than buried.

**Every phase is finished when the mechanism works — never when the catalog is full.** We
will not hold a phase open waiting on data entry.

### Your data-entry burden, honestly estimated

| Work | Volume | Rough time |
|---|---|---|
| ~~Return-policy classification~~ — **deferred, not counted** | ~~581 products~~ | ~~2–4 hrs~~ |
| Typing EPA registration numbers so ingredients can auto-fill | ~123 pesticides that have ingredients but no number on file | 4–6 hrs |
| Ingredients for products that will never have an EPA number | ~194 fertilizers, adjuvants, biologicals | 6–10 hrs |
| **Density lookups (safety data sheet per product)** | up to 508 liquids, no shortcut exists | **15–25 hrs** |
| Reviewing re-derived rates | 573 values, reviewed not auto-rewritten | 5–10 hrs |
| Fertilizer guaranteed analyses | ~130 products | 3–5 hrs |

**Total: roughly 33–56 hours of your time**, spread across the project — return-policy
classification is no longer counted, since you deferred that page. These are estimates,
not measured — treat them as the right order of magnitude, not a quote.

You've already parked the density backfill: *"Let's wait on that for now I don't have time."*
That's respected — the mechanism gets built, the catalog fills when you're ready.

### The one number I got wrong, corrected

I told you ~190 products would need ingredients entered by hand. **It's 317** that have no
usable EPA registration number. About 123 of those are real pesticides — herbicides,
insecticides, fungicides — that have genuine ingredients but no registration number recorded,
so they can't auto-fill until you type the number in first. The tidy framing "287 auto-seed,
the rest are fertilizers" was wrong and hid several hours of your time.

### What changes in your crew's daily routine

**One thing only: picking the brand when product arrives.** You approved making that a
required step. It works with the lot/tote field left blank, which is the normal case.

Everything else — quoting, invoicing, inventory, deliveries — behaves exactly as it does
today until Phase 2, and Phase 2's only visible change is that a product with no real rate
shows blank instead of a wrong number.

---

## 4. Build order, and what "done" means

Done means **the changed behavior was run and observed** — not that a test passed. A test
written by whoever built the thing can rubber-stamp the same misunderstanding that caused
the bug.

### The order came from your ranking

Seven problems were put in front of you and you ranked them. That ranking is what the phases
below are built from, so it's worth seeing next to them:

| Your call | The problem | Where it went |
|---|---|---|
| **Top priority** | Active ingredients aren't stored — *"brainstorm how to store them… lead into our product comparison tool"* | Phase 1, and it's why Phase 1 comes before everything |
| "asap" | Families, packaging variants and return policy all empty | Split: families → Phase 5; return policy → **since deferred by you** |
| "lets fix this" | Two fields hold the same package size | Phase 7 |
| "consolidate and standardize" | Unit spellings inconsistent | Phase 2 |
| "yes we need to fix this" | Duplicates, blanks and a test row in the catalog | Phase 0 — pulled to the front, because it makes every later phase quieter |
| "we will do this later" | Label rate, re-entry and pre-harvest intervals empty | Out of scope for now |
| "not concerned right now" | No required fields when creating a product | Out of scope for now |

The two changes I made to your order: **data hygiene moved up to first** (it's cheap and it
de-noises everything after it), and the return-policy screen was split out on its own — which
you have since deferred entirely.

| Phase | What it is | Done when | Depends on |
|---|---|---|---|
| **0** | Data hygiene — 13 blank SKUs, 1 duplicate SKU, 3 duplicate names, 1 test product | Every SKU unique, no row hard-deleted, all history still resolves | Nothing |
| ~~**0b**~~ | ~~Return-policy screen~~ — **DEFERRED at your direction, 2026-08-18:** *"We don't need the returns policy page yet not important."* This supersedes the earlier "asap" ranking. Not built, not scheduled | — | — |
| **1** | Ingredients, mode of action, density, brands, fertilizer analysis | One product can be given ingredients, a density and a brand, saved and read back **through the running app as a normal user** | Phase 0 |
| **1b** | Excel workbook round-trip, so 604 products aren't edited one at a time | Download, edit, upload, preview, save — with the existing safety guards intact | Phase 1 |
| **2** | Rate correction and unit standardization | A product with no per-acre rate autofills blank; quote totals identical before and after the unit remap | Phase 1 |
| **3** | Comparison tool — the payoff. The old Brand-vs-Generic page is retired and replaced, at your direction | "Which products contain X" and "what does it cost to rebuild brand Y from generics" both answer correctly; the old page and its empty table are gone with no dead references | Phase 2 |
| **4** | Label links, required adjuvants, crop and timing, quote notes | Each visible on a real product | Phase 1 |
| **5** | Product families and packaging variants | Families derived and populated | Phase 1 |
| **7** | Retire the redundant size field | No behavior change | Phase 2 |
| **8** | Product images — last, at your direction. Copied from your website into CRX's own storage, not linked to it | Images on quote PDFs | Everything |

**The comparison tool has a real target of roughly 2026-09-18.** You settled that it comes
after the rate cleanup: *"After rate cleanup it's not important until a month from now."* If
that date comes under pressure, **the thing to protect is the quality of the rate review**,
not the date — Phase 2 is the one phase that can put wrong quantities on customer documents.
A slip gets raised with you rather than absorbed by rushing.

### Phase 1 has an internal order that must be followed

It's 20 requirements and they aren't independent. Building screens first means building them
against tables that then change shape:

1. Settle the brand-versus-families question (already settled — see §6)
2. Tables and migrations, **including the column permissions** (Risk 1) and update triggers
3. Density precedence rule written down (Risk 3) before any weight math is coded
4. EPA auto-seeding, which fills the ~287 products that can fill themselves
5. Screens, once the shapes are stable
6. Copy-from-sibling last, since it operates on everything above

---

## 5. Everything that can go wrong

The full register. Ordered roughly by how much damage each does if missed.

### Risk 1 — New fields that silently refuse to save *(verified live)*

The product table has 48 fields, and the app is only permitted to write to **27 of them** —
permission is granted field by field, left over from earlier security work. There is no
table-wide write permission at all.

Every new field this project adds needs its permission granted **in the same database
change**. Without it, the field appears on screen, you type into it, and the save fails —
or worse, fails silently. It reads like an application bug and is actually a permissions
setting.

**It gets worse:** testing as an administrator bypasses column permissions entirely and
shows a working save on a field no real user can write. **The check must be done as an
ordinary logged-in user, through the running app.**

The project's own reference notes claimed only one other table worked this way. That was
stale; I've corrected it.

### Risk 2 — A live rule that can brick product editing

There's a database rule that checks a product's units against a reference table, matching
**exactly, including capitalization**. Neither design document mentioned it. Three
consequences:

- Phase 2 has a **forced order**: rename every product's unit spelling *first*, then remove
  the duplicate reference rows — and the spellings kept must exactly match what products
  now use. Do it the other way round and **every subsequent edit to an affected product
  fails.**
- Phase 0's reclassification of 11 blank product forms can be **rejected by the database**
  if a row's existing units disagree with the chosen form. Check units first.
- Five database functions read that reference table, not just the quoting one.

### Risk 3 — Density stored in two places with no rule

The spec can carry a density, and so can a brand. Nothing initially said which one the
**scale weight** uses. That is the exact ambiguity this whole project exists to remove,
re-planted on its most dangerous path — a wrong answer here is a wrong weight on a scale.

**Settled rule:** the spec's density is the working value; a brand may override it; the
weight calculation uses the recorded brand's density when a brand is recorded *and* has
one, otherwise the spec's — and the screen shows which one it used.

### Risk 4 — Two overlapping ways to say "same chemistry"

There's an existing "product families" feature (currently empty) that groups related
products, and the new brand list. An early conclusion that these were interchangeable was
**wrong**. They're different: families group *sibling product rows* across specs; brands sit
*under one product row*. Both are needed. Retiring either breaks a later phase.

The one real overlap — two free-text fields on families that duplicate real ingredient data
once it exists — is flagged for retirement when families get populated.

### Risk 5 — Building on infrastructure that nobody uses *(your catch)*

Review round 3 recommended hanging brand tracking on the existing lot-number chain. You
rejected it: *"a lot of totes don't have lot numbers so some will not… don't make tote
number / lot the focus because not all have it."*

The live data is stronger than your caution:

| | Rows | Have an identifier |
|---|---|---|
| Receiving records | 130 | **0** |
| Delivery lines | 400 | **1** |
| Invoice lines | 19 | **0** |
| Blend ticket products | **0 — never used** | — |
| Application record lots | **0 — never used** | — |
| Blend tickets | **0 — never used** | — |

The lot-tracking system is fully built and **entirely unused**. The review verified that the
*code* existed and inferred a working process from it. It never counted the rows; I repeated
that without checking.

**The general lesson, which now applies to the rest of this project:** existing code is not
evidence of an existing workflow. Before building on any existing feature, count its rows.
Other built-but-empty surfaces already known: product families (0), the old ingredient map
(0), label max rate (0 products), quote notes (0 products).

**Design consequence:** brand tracking never depends on a lot or tote number. The dormant
lot/tote fields are left alone — not extended, not deleted, never a condition of anything.
Whether you ever adopt that system is a separate decision.

### Risk 6 — Rate lives in 83 files

The current rate field is read by 83 files across the application — quotes, applicator
sheets, blend tickets, field mode, invoices, crop programs, statements, worker-protection
notices, year-end reports. My first estimate said five. Moving rate to a new home without a
plan for those 83 readers is how Phase 2 becomes a multi-week surprise.

**Settled approach:** keep the existing field as an automatically-maintained mirror of the
quoting-default rate, and revoke the app's ability to write it directly. Every one of the 83
readers keeps working with one consistent meaning, and the three places that create products
are *forced* onto the new path because their old writes start failing.

### Risk 7 — Three ways to create a product, and one of them was missed

Products can be created by inline edit, by the Add Product form, and by a CSV importer that
writes directly to the database. The CSV importer also has a quirk where one column name
maps to two different fields. All three break loudly when Risk 6's change lands and must be
updated in the same piece of work.

### Risk 8 — Classifying return policy starts blocking real transactions *(deferred — kept on record)*

**You deferred this phase on 2026-08-18, so this risk is not live.** It stays written down
because the moment the return-policy work is picked up, it applies in full.

Right now `unknown` blocks nothing. Setting a product to `no_return` **starts** blocking
returns. A misclassification either refuses a legitimate return or wrongly accepts one —
real money either way. This is the only phase that changes money behavior on the day it
ships.

Also worth knowing: the four return functions don't contain the policy check themselves —
they hand off to internal functions that do. Anyone auditing the obvious functions finds no
guard and may wrongly conclude the phase is unprotected.

### Risk 9 — Same ingredients does not mean interchangeable

Two products with identical active ingredients at identical concentrations are not
necessarily substitutable:

- **Safeners** (the additives that protect the crop) are not EPA active ingredients, so
  they're invisible to any ingredient-only comparison. A safened and an unsafened product
  look identical and are not.
- **Formulation type** (SC / EC / OD) changes mixing behavior and crop safety.
- **Built-in adjuvant load** differs between products that otherwise match.
- You told us you *"pretty much only use ester"* for 2,4-D, and want a **loud warning** if
  the system ever offers an amine as an ester substitute.

The comparison tool must present equivalence as *a starting point for your judgment*, never
as an answer.

### Risk 10 — The Excel workbook and the rate move collide

The workbook (Phase 1b) round-trips rate fields through machinery that writes product
columns only. Phase 2 then moves rate somewhere else. Either that machinery learns to write
the new location — real, unestimated work — or the workbook's rate columns get rewired.
**Recommendation: ship the workbook's rate columns read-only from the start**, so it never
becomes a fourth way to write rates that Phase 2 has to unwind.

### Risk 11 — Typing the same thing repeatedly

"Roundup 5.4# Generic" exists as separate rows for 2.5 gallon, bulk, and 265-gallon tote. So
does every other packaged product — 561 of 604 names carry a size suffix. Without a
copy-from-sibling action, every ingredient, density and brand gets typed three times, and
the three copies drift apart. This applies to brands as much as to ingredients.

### Risk 12 — Smaller traps, each real

- **Brand names can't be extracted mechanically.** 129 product names contain parentheses,
  but several aren't brand lists — "(Full pallets)", "(New Formulation of Resicore XL)". A
  parsing pass produces junk; this needs human review.
- **The per-100-gallon cleanup is 37 rows, not 12**, and includes weight-based entries like
  `17 lb/100 Gal` — dry product into liquid.
- **The duplicate SKU is two genuinely different sellables** (a no-return tote and bulk).
  Merging destroys a real distinction; the fix is a distinct SKU, not a merge or a delete.
- **Nothing gets hard-deleted.** Duplicate and test rows carry history in quotes, invoices
  and inventory. Deactivate or re-SKU; deletion is separately approved, never assumed.
- **Biologicals are labeled in colony-forming units**, not percentages. They get proper CFU
  units rather than a nonsense percentage.
- **Fertilizer phosphate and potash are reported as oxides**, and agronomic math often needs
  the elemental figure. Same shape of problem as acid equivalent; must be expressible.
- **Retiring the old ingredient map** touches more than its screen — a security-rules test
  fixture and generated type files too. It holds zero rows, so dropping it destroys no data,
  but it is still a live database change needing your in-chat OK, and a table drop is
  hard-refused in any hands-free run. It gets scheduled for a session you're in.
- **The restricted-use product count is known wrong** (2 recorded; you say materially more —
  and you parked it: *"not important today"*). The compliance report must be treated as
  known-incomplete until the label work happens.
- **Concentrations and densities are measurements, not money.** They must not be forced into
  the whole-cents pattern the project uses for money.
- **New tables need security rules, update timestamps, and safe repeat-protection on any
  function that changes data** — non-negotiable project rules.

### Risk 13 — Process risks, not code

- **You are the data-entry bottleneck.** 35–60 hours, and no phase should be gated on it.
- **Zero Codex credits.** The independent second-model review that your rules require before
  landing database and security changes is unavailable. Every phase here contains such
  changes. See §7.
- **This branch is 24 commits behind the main line.** All unrelated tooling work, none of it
  touching products — but it gets brought current before any building starts.

---

## 6. Already decided — do not reopen

| Decision | Your words / the call | Date |
|---|---|---|
| Density is required, for scale-based blending | *"we do a lot of blending based off scales so have to have weight of everything"* | 2026-08-18 |
| Show both prices, with a customer-tier selector | "Yes both and be able to select tier of customer price" | 2026-08-18 |
| Adjuvant cost is not priced in — **but the exclusion is stated on screen** | "no" to pricing it; the note is required so the generic route isn't understated | 2026-08-18 |
| **Return windows stay on paperwork — no date modeling** | *"don't worry about that we send out paperwork on those dates we can keep system simple on returns"* | 2026-08-18 |
| Ester/amine substitution — warn loudly | *"Warn loudly we pretty much only use ester"* | 2026-08-18 |
| You enter most data yourself | "i enter most data" | 2026-08-18 |
| Full fertilizer analysis, including micros and secondary macros | *"all complete analysis"* | 2026-08-18 |
| Density backfill sequencing — parked | *"Let's wait on that for now I don't have time"* | 2026-08-18 |
| Your Google Sheet is not an import source | *"not complete and is not automatic or have actual ingredients"* | 2026-08-18 |
| Split loads show every brand with amounts | Chosen | 2026-08-18 |
| Brand required at receiving | Chosen | 2026-08-18 |
| Blank rate beats a guessed rate | Chosen | 2026-08-18 |
| Total nitrogen is enough | Chosen | 2026-08-18 |
| **Brand tracking never depends on lot/tote numbers** | *"not all have it"* | 2026-08-18 |
| Comparison tool comes after the rate cleanup | *"After rate cleanup it's not important until a month from now"* | 2026-08-18 |
| **Return-policy screen — DEFERRED.** Supersedes the earlier "asap" ranking; drops Phase 0b out of the near-term path and removes 2–4 hrs of data entry | *"We don't need the returns policy page yet not important"* | 2026-08-18 |
| **Retire the old Brand-vs-Generic page and build a fresh one** — do not extend it | *"retire it and we will build a new page in future"* | 2026-08-18 |
| Ingredient foundation gets built before anything else | *"i agree i want to do the ingredient foundation 1st"* | 2026-08-18 |
| A bulk-edit workbook is needed — one-by-one editing doesn't scale | *"very hard to navigate all these products going one by one"* | 2026-08-18 |
| Restricted-use flag is known wrong, and **parked for now** | *"there are alot more but not important today"* | 2026-08-18 |
| Product images come last, and get **copied into CRX storage**, not linked from your website | *"save this for the end or last"* / *"i think we copy them into crx own storage"* | 2026-08-18 |
| Rates carry a low, a high **and** a recommended value; recommended may equal either end | *"maybe we set a low, high, and recommended rate? sometimes the recommended might match the high or the low"* | 2026-08-18 |
| Quote suggestion notes are **picked at quote time and editable per grower** — not forced onto every quote | *"it is an option at quote time to select what we want and then be able to edit wording from grower to grower"* | 2026-08-18 |
| Mode-of-action storage must hold **at least five codes** per product | *"some products have 4 or even 5 FRAC numbers"* | 2026-08-18 |
| Required-adjuvant tracking is in scope | *"some chemistry HAS to have a certain adjuvant"* | 2026-08-18 |
| Crop-and-timing restrictions are in scope, kept simple | *"some products can be used pre emerge only on certain crops but also post on 1 crop"* / *"dont want to get to complicated"* | 2026-08-18 |
| Mode-of-action codes are worth storing | "great idea" | 2026-08-18 |
| Label links are in scope | "ok" | 2026-08-18 |

**Deliberately not in scope:** label max rate / REI / PHI, required fields on product
create, tank-mix companions, successor-product pointers, storage and freeze risk (all
deferred by you); rates that vary by crop; normalizing vendor into a proper reference;
rainfast intervals, grazing restrictions, plant-back intervals, carrier volumes, mix order,
PPE, state special registrations, temperature limits. Listed once so a future reviewer can
see they were considered, not missed.

**No pricing, margin or cost calculation changes anywhere in this project.**

---

## 7. Still open — and who decides

### Needs your decision

1. **Codex credits.** The independent second-model review your rules require before landing
   database, security or money changes cannot run at zero credits. Every phase here contains
   database changes. Either credits get restored before those land, or you explicitly accept
   a specific change going in without that check. **I won't waive it quietly.** My
   recommendation: build and prove everything locally, and make this call when the first
   change is actually ready to land — not now.

2. **Who builds it.** The plan was written for Codex; at zero credits, I'm the available
   builder. No cost to you either way beyond the credits question above.

### Technical — I decide, recorded so you can see them

3. **Workbook rows that vanish** — if a product disappears from an uploaded spreadsheet tab,
   does that mean delete it or ignore it? The hardest question in any spreadsheet round-trip.
   Must be answered before Phase 1b.
4. **Seed-treatment rate basis** — 18 products measured per hundredweight of seed or per seed
   unit. The value gets added in Phase 2 while it's free; adding it later is a migration.
5. **Per-phase rollback** — Phases 1, 1b, 3 and 4 are additive, so rollback is "stop using
   it." Phases 0 and 2 need a real answer. Phase 2 behind an on/off switch is the obvious
   protection.
6. **Child-table concurrency** — the existing "don't overwrite someone else's edit" guard
   covers the product row only, not the new lists hanging off it.

---

## 8. How we'll know it worked

Not "the tests pass." For each phase, the specific thing that gets run and watched:

| Phase | The proof |
|---|---|
| 0 | Every SKU unique; open a previously-duplicated product's history and see it intact |
| 1 | **As an ordinary logged-in user, not an administrator** — add ingredients, a density and a brand to a real product, save, reload, all present. Then ask for a scale weight on a product with no density and watch it refuse rather than guess |
| 1b | Download the workbook, edit a row in the app while it's open, upload, and watch that row be refused rather than silently overwritten |
| 2 | A quote's total is identical before and after the unit consolidation. A product with no per-acre rate autofills blank. Edit and save a product for each affected unit and watch all succeed |
| 3 | Rebuild a known branded product from generics and check the answer against your own arithmetic |
| Every phase | Nothing to production without your approval; every database change reviewed before it's applied |

---

## 9. Gates — what needs your explicit OK

These never happen on assumption, no matter what any earlier approval implied:

- Pushing to GitHub or merging anything to the main line
- Applying any change to the live database
- Deleting any data
- Deploying to production
- Changing security, permissions or customer-visible behavior beyond what a reviewed code
  change inherently changes

**Currently held at your instruction:** nothing has been pushed to GitHub. All work is local
commits on branch `claude/product-data-storage-58ba26`.

---

## 10. The recommended first step

**Approve this plan, or tell me what's wrong with it.**

On approval, the order is: bring the branch current with the main line → build Phase 0 (data
hygiene) → move straight into Phase 1, the ingredient/density/brand foundation you ranked
first → show you each running before anything goes live.

The return-policy screen is **out of the near-term path** at your direction.

Nothing gets pushed, applied, or deployed without you saying so.
