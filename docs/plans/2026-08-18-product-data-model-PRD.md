# PRD — Product Data Model Rebuild

**Date:** 2026-08-18
**Owner:** Mason Wells

> ## ⚠️ THIS DOCUMENT PREDATES SOL'S ADVERSARIAL REVIEW — IT IS NOT FULLY RECONCILED
>
> *Added 2026-08-20 while reviewing PR #435.* This PRD was frozen on **2026-08-18**. Sol's review
> landed **2026-08-19** with 34 findings, the build plan is now at **revision 3**, and Mason has
> settled **five decisions** since (D-W, D-X, and the three closed on 2026-08-20). This document
> has **not** been revised through all of that.
>
> **Where this PRD and `2026-08-19-product-data-model-BUILD-PLAN.md` disagree, the BUILD PLAN
> wins.** It is the newer document and the one Sol's review and Mason's decisions were applied to.
>
> The specific contradictions found so far are corrected inline below and marked **[REV4]**.
> **That correction pass is not known to be complete** — it fixed what PR #435's reviewers
> happened to surface, not the result of a systematic reconciliation. Until someone walks this
> document requirement-by-requirement against revision 3, treat any un-marked requirement here as
> **possibly stale**, and check the build plan before acting on it. A full reconciliation is
> tracked as a prerequisite of WP-1, not as optional tidying.

**Status:** DRAFT — **three adversarial review rounds COMPLETE** (Fable, 2026-08-18,
read-only, live-verified). Round 1 asked *"is this design sound?"* (yes, four amendments);
round 2 asked *"what is missing?"* (24 gaps); round 3 reviewed the combined result and
returned **"not ready"** — four Phase-1 defects that would produce wrong work on day one,
plus eight factual corrections. All three rounds are folded in below, marked
*(round 2)* / **[Round 2]** / **[REV3]** where they changed something. Awaiting Mason's go.

**Round-3 blockers, all now written into Phase 1 above the requirement they affect:**
1.17 (column-level grants on `products`), 1.9a (~~brand rides the existing lot chain~~ — **[REV4]
REVERSED: brand does NOT ride the lot chain.** PRD 1.9a-iv rules that infrastructure dormant, and
Mason settled on **2026-08-20** that the application workflow is not currently in use and the
lot/tote chain stays untouched — `application_record_lots` holds 0 rows. Brand capture follows the
**delivery** path; see WP-3),
1.18 (density precedence), 1.9b (brand table and `product_families` are both needed).
Phases 0 and 0b were judged executor-ready after small edits; Phase 1 was not.
**Design source:** `docs/plans/2026-08-18-product-data-model-plan.md`
**Intended executor:** **[REV3b] Undecided — Mason has 0 Codex credits as of 2026-08-18.**
The plan was written for Codex (`terra`); with no credits, Claude is the available builder.
**Consequence the executor must respect:** the adversarial cross-model gate that
`AGENTS.md` requires for risky diffs is pinned to `gpt-5.6-sol` and **cannot run without
credits**. Phase 0's row changes and every migration in Phases 0b/1/2 are exactly the
diffs that gate covers. Either credits are restored before those land, or Mason explicitly
accepts the gate being unavailable for a given change — it is not something the builder may
waive silently.

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

- No pricing, margin, or cost changes. **Pricing and money rules are unchanged.**
  **[REV3 — corrected after Sol finding 23.]** This previously read "no change to how quotes,
  orders, invoices, or inventory calculate anything", which flatly contradicts Phase 2: Phase 2
  deliberately rewires **which rate those consumers read**. Taken literally, the old wording
  tells a builder to leave an invoice reader on legacy `products.rate_per_acre` while quoting
  moves to `product_rates` — so a quote and its own invoice compute different quantities. The
  precise rule: **money rules stay the same, and every rate-source reader moves together**, with
  proven equivalent output through the cutover.
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
| `receiving_records` rows / **with a lot number** | 130 / **0** *(added [REV3b])* |
| `delivery_items` rows / **with a tote number** | 400 / **1** *(added [REV3b])* |
| `invoice_items` rows / **with a tote number** | 19 / **0** *(added [REV3b])* |
| `blend_tickets` / `blend_ticket_products` / `application_record_lots` rows | **0 / 0 / 0 — never used** *(added [REV3b])* |
| `application_records` rows | **1** *(added [REV3b])* |

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
- **[Round 2 correction] `rate_per_acre` is referenced by 83 files (Round 2 said 82), not the 5 listed here.**
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
| 0.1 | **Resolve so SKUs are unique — never hard-delete.** Duplicate and test rows may carry foreign-key history in quote lines, invoices and inventory movements, which makes a hard delete either impossible or silently destructive | For each row touched, its historical references still resolve afterwards |
| 0.1a | **[REV3] Re-SKU is an allowed outcome, and is the right one here.** Round 2 prescribed "merge or deactivate", which does not fit the actual duplicate: the two `9768NR` rows are two **genuinely different sellables** — a 265-gallon no-return tote and Bulk. Merging destroys a real business distinction; deactivating hides a product Mason actually sells. Giving one row a distinct SKU is the correct fix | `9768NR` identifies exactly one sellable. Both the tote and the Bulk row remain active and orderable |
| 0.2 | Normalize `epa_registration`: trim whitespace-only values to NULL | 13 whitespace-only rows become NULL; a subsequent "run the lookup on everything with a registration" batch does not fail on them |
| 0.3 | Classify the 11 blank `product_form` rows as liquid or dry | Zero blanks remain; density scoping in Phase 1 has a reliable key |
| 0.3a | **[REV3] Check each of the 11 rows' units before choosing its form.** A live BEFORE trigger, `validate_product_units`, validates `product_form` against the unit type of `inventory_unit`/`container_unit`. Setting a form that disagrees with a row's existing units is **rejected by the database**, not accepted — so units may need correcting first | All 11 classifications save on the first attempt, or the units are fixed in the same change |

Deleting data is an approval-gated, irreversible act under `AGENTS.md`. If any class of row
genuinely warrants deletion rather than deactivation, that is a separate request to Mason
with the FK survey attached — not part of this phase's standing approval.

### Phase 0b — Return-policy admin screen — **DEFERRED, DO NOT BUILD**

> **Mason, 2026-08-18:** *"We don't need the returns policy page yet not important."* This
> **supersedes** the earlier "asap" ranking recorded below and everywhere else in this
> document. Phase 0b is out of the near-term build path. The requirements stay written down
> so the phase can be picked up intact later; nothing here is scheduled.

*(split out of Phase 5; owner originally ranked it "asap" — superseded above)*

| # | Requirement | Acceptance |
|---|---|---|
| 0b.1 | Admin screen calling the existing `set_product_phase3_metadata` | A product's return policy changes from `unknown` and persists |
| 0b.2 | Bulk classification path for the 581 unknowns, applied in evidence-backed batches | 581 products classifiable without 581 individual interactions |
| 0b.3 | **The screen offers four values: `returnable`, `no_return`, `not_applicable`, `unknown`** | All four selectable. A three-value screen is a defect — the live CHECK allows four (`20260723193312_product_families_return_policy_foundation.sql:49`) |
| 0b.4 | **State which bulk mechanism is used and why.** `set_product_phase3_metadata` is strictly per-product with compare-and-set arguments (`p_expected_return_policy` and siblings), so bulk means either 581 read-then-CAS round trips with partial-failure and progress handling, or a new bulk RPC — the latter being a migration that pulls in the full RLS, idempotency and drift gate stack | The chosen approach is written down before code; partial failure leaves no half-applied batch |
| 0b.5 | **[REV3] There is a third and cheaper option Round 2 missed: an evidence-backed governed classification *migration*.** This repo has already done exactly this for return policy — `20260729213733_supplier_pricing_phase3c_return_policy_classification.sql`. It reuses an already-approved gate rather than building new bulk machinery, and it leaves a reviewable record of the evidence behind each classification | The three options are compared before code. If the migration path is chosen, it follows the existing precedent file's shape |

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

**[REV3] Build this phase in order — it is 20 requirements and they are not independent.**
A builder who starts on screens will build them against tables that then change shape:

1. **1.9b first** — brand rows and `product_families` are settled as separate things, but the
   brand table's shape determines where ingredient and density rows hang.
2. **Tables and migrations next** — including **1.17 column grants** in the *same* migration
   as any new `products` column, and **1.14** `updated_at` triggers.
3. **1.18 density precedence decided and written down** before any weight math is coded.
4. **1.4 EPA seeding**, which populates the tables for the ~287 products that can auto-fill.
5. **Screens**, once the shapes are stable.
6. **1.8 / 1.13 / 1.9c copy-from-sibling last**, since it operates on all of the above.

| # | Requirement | Acceptance |
|---|---|---|
| 1.1 | Active ingredients stored per product with concentration value, unit, and an explicit `acid_equivalent` vs `active_ingredient` basis | Open a product in the running app, add three ingredients, save, reload — all three persist with basis intact |
| 1.1a | **`active_ingredients` carries `canonical_ingredient_id` (self-FK) and `canonical_fraction`.** EPA salt-form names (`glyphosate, isopropylamine salt` etc.) are seeded as rows pointing at the parent acid; all search and grouping goes through the canonical id | Seed the three glyphosate salt forms; one search for "glyphosate" returns **every** product carrying any of them |
| 1.2 | Mode-of-action codes in an **`ingredient_moa_codes` child table** (**`ingredient_id`** *[REV4 — was `active_ingredient_id`; the build plan and every proof query use `ingredient_id`, and either spelling compiles, so a mismatch would never surface at build time]*, `scheme`, `code`) — not scalar columns. Herbicides use the **numeric global HRAC code only** | An ingredient with two codes stores both; a product with ≥4 codes renders all of them, scheme-labeled |
| 1.3 | Product density stored with value, unit, and source (`label`/`sds`/`supplier`/`measured`/`assumed`) | Density saved and re-read on a real product |
| 1.3a | **Density validation is a warn band (~6.5–14 lb/gal), never a hard reject.** Required only for liquid products with weight-basis concentrations or liquid↔dry comparison — not a 604-row mandatory backfill | Enter 7.7 lb/gal (a real crop-oil density): saves, with at most a warning. **A hard 8–12 reject is a defect** |
| **1.4** | **[REV4 — this requirement was DANGEROUS as written and is corrected.]** EPA lookup persists the ingredients it already returns instead of discarding them. ~~mapping salt forms to canonical acids~~ — **NO.** A label states a concentration for a **specific chemical form** ("5.4 lb glyphosate IPA salt per gallon"), and the concentration attaches to **that specific form row**. `canonical_ingredient_id` is used **only** to group and search; **it never receives a concentration.** Storing 5.4 on the canonical acid makes every downstream calculation read it as acid equivalent — the true figure is `5.4 × 0.741 = 4.0014` — so the system believes each gallon carries ~35% more active than it does and quotes roughly **26 gallons too few on a 100-gallon job**, silently. This was Sol's most consequential blocker (2026-08-19); the build plan fixed it in WP-4 and this requirement was left stale until PR #435. See D-A and WP-4 | Run the lookup on an `[E2E]` clone with a known EPA number; read back the stored row and show the **foreign key pointing at the specific chemical-form row, not the canonical parent**. A proof that does not show that has not proved this requirement |
| 1.5 | New tables have RLS enabled with policies in the same migration | Migration inspected; RLS-security review passes |
| 1.6 | Concentration unit is `lb_per_gal` or `percent_w_w` only. **`lb_per_lb` is excluded** — it is `percent_w_w` ÷ 100, the same axis twice | Constraint rejects `lb_per_lb` |
| 1.7 | Any new mutating RPC accepts **and enforces** `p_idempotency_key text DEFAULT NULL` | Replaying the same key does not double-write |
| 1.8 | "Copy ingredients/density from sibling" action on the product detail screen | A bulk row inherits the 2.5-gal row's chemistry in one action |
| **1.9** | **Brand rows beneath the sellable spec.** A child table on `products`: `brand_name`, **`epa_registration` per brand**, manufacturer, `label_url`, `density_value`, `is_currently_sourced`. The `products` row remains the sellable spec — quoting, tiers, pricing and inventory are unchanged | "Roundup 5.4# Generic" carries Ag Saver 5.4 and Slam 5.4 as separate brand rows, each with its own EPA number, and the product still quotes exactly as it does today |
| **1.9a** | **[REV3b] Brand is recorded directly on the receiving record. It must NEVER depend on a lot or tote number — Mason, 2026-08-18.** *"A lot of totes don't have lot numbers so some will not… don't make tote number / lot the focus because not all have it."* **Verified live and worse than stated: `receiving_records` has 0 of 130 rows with a lot number, `delivery_items` 1 of 400 with a tote number, `invoice_items` 0 of 19, and `blend_ticket_products` / `application_record_lots` / `blend_tickets` are entirely empty (0 rows).** The lot chain exists in code and is **unused in practice**. So `brand_id` is its own column on the receiving record, independent of any batch identifier. A lot or tote number, where one happens to exist, is optional supporting detail recorded alongside — never the key the brand hangs from | Receive product with **no lot number and no tote number** and the brand is still fully recorded and flows to paperwork. Nothing about brand tracking degrades when the identifier is absent, because that is the normal case |
| **1.9a-i** | **[REV3] Brand selection is required at receiving — Mason, 2026-08-18.** Asked whether picking the brand can be a required step when product arrives, Mason chose yes: it is the cheapest capture point, because the person unloading is holding the jug. **[REV3b]** This requirement is independent of lot numbers — it must be satisfiable with the batch-identifier field left blank | Receiving cannot be completed without a brand once the spec has brand rows defined, **and completing it with no lot/tote number is a normal successful path, not a warning**. A spec with no brand rows yet does not block receiving |
| **1.9a-ii** | **[REV3b] Split loads record every contributing brand with its amount — Mason, 2026-08-18 — and this needs a real new shape, because the table Round 3 pointed at is empty.** Round 3 claimed `application_record_lots` already models multiple lots with a quantity each so brands would "ride along free." It has **0 rows and has never been used**; `blend_tickets` is likewise empty and `application_records` holds 1 row. Building on it would be building on something unproven. Instead: allow **more than one brand, each with a quantity, per delivery/application line**, keyed to the line itself — not to a lot number | An application record drawing 30 gal of Ag Saver and 15 gal of Slam shows both brands, both EPA numbers and both quantities on the customer's paperwork, **with no lot or tote number entered anywhere** |
| **1.9a-iii** | **[REV3] Records snapshot the brand's name and EPA registration number at write time; they do not dereference the brand row later.** Otherwise correcting a typo in a brand's registration number silently rewrites historical spray records | Change a brand's EPA number after a delivery is recorded; the existing delivery and application records still show the number that was in force when they were written |
| **1.9a-iv** | **[REV3b] Do not build on, extend, or assume the lot/tote infrastructure.** `receiving_records.lot_number`, `blend_ticket_products.lot_number`, `application_record_lots` (`lot_number`, `quantity_from_lot`), `delivery_items.tote_number` and `invoice_items.tote_number` all exist, and all are effectively unpopulated. Treat them as **existing but dormant**: leave them alone, do not delete them, and do not make any brand behavior conditional on them. Whether that infrastructure is ever adopted is a separate decision for Mason, unrelated to this plan | No brand feature reads a lot or tote number to function. Removing every lot/tote value from the database would not change any brand behavior |
| **1.9b** | **[REV3] Settled: brand rows and `product_families` are different axes and both are needed.** `product_families` groups **sibling product rows** — packaging variants and equivalent chemistry *across* specs — and Phase 5 (5.1–5.5) explicitly writes to it. Brand rows live **under a single product row** as the fulfilment articles for that one spec. Retiring families leaves Phase 5 with nothing to write; retiring brands forces every brand to become its own product row, which this plan explicitly rejected. Round 2 recorded this as a free choice; **that was wrong** | Both mechanisms ship, with the distinction documented. The only real overlap is `product_families.active_ingredient` and `.formulation` — two free-text columns that become conflicting duplicates once real ingredient tables exist; flag both for retirement or derivation when Phase 5 populates families |
| **1.9c** | **[REV3] Brand entry must not re-create the packaging-sibling double-entry problem.** "Ag Saver 5.4" would otherwise be typed separately onto the 2.5 Gal, Bulk and 265G rows — the exact drift this plan solves for ingredients in 1.8/1.13. Either extend the copy-from-sibling action to cover brand rows, or model brands as an entity table plus a product-brand junction | Adding a brand to one packaging sibling makes it available on the others without retyping. (Note: a brand legitimately does **not** cross specs — "Ag Saver 5.4" and a 4-lb spec are different products and correctly share no brand row) |
| **1.10** | **Complete fertilizer analysis** storable: primary macros (N, P₂O₅, K₂O), secondary macros (Ca, Mg, S) and micronutrients (B, Cl, Co, Cu, Fe, Mn, Mo, Ni, Zn), as `percent_w_w` | A liquid fertilizer stores a full guaranteed analysis, saves and re-reads. Combined with density it yields pounds of nutrient actually applied |
| **1.10a** | **[REV3] Add `cfu_per_ml` and `cfu_per_g` as concentration units.** Round 2 left this an either/or; it is now decided. "Complete analysis" with 9 biological products unstorable is self-contradictory, and forcing a colony-forming-unit count into a percentage column is a data defect | The 9 biological products store their labelled CFU figure in a CFU unit. No biological carries a nonsense percentage |
| **1.10b** | **[REV3] Nutrient basis must be expressible.** Guaranteed analysis reports phosphorus and potassium on an **oxide** basis (P₂O₅, K₂O); agronomic math frequently needs **elemental** P and K (×0.436 and ×0.830). This is structurally the same problem as acid equivalent versus salt weight, which 1.1a already solves with `canonical_ingredient_id` + `canonical_fraction` — but the `basis` column's proposed values (`acid_equivalent` \| `active_ingredient`) cannot express "oxide" | Either a nutrient basis value is added, or the PRD states explicitly that oxide→elemental rides the existing canonical/fraction mechanism. A build that silently treats P₂O₅ as elemental P is a defect |
| **1.10c** | **[REV3] Total nitrogen only — Mason, 2026-08-18.** Asked whether recommendations need nitrogen split into ammoniacal / urea / nitrate forms as labels break them out, Mason chose total N. The schema should not *forbid* the breakdown later, but no requirement to enter it ships now | A fertilizer stores a single total-N figure. Adding form-level detail later does not require re-entering the analyses captured now |
| **1.11** | **Formulation type and safener** captured, because identical ingredients at identical concentrations are not always interchangeable (SC vs EC vs OD; safened vs unsafened s-metolachlor) | A safened and an unsafened product with identical ingredient rows are visibly distinguishable |
| **1.12** | `concentration_value` nullability is stated explicitly, so *ingredient present, amount unknown* is distinguishable from *ingredient missing* | A product with a known ingredient and unknown amount saves, and Phase 3 can tell the two cases apart |
| **1.13** | Persist the registration-status signals the EPA lookup already returns — `productStatus` and `isCancelled` (`src/types/index.ts:130-131`) | A cancelled registration is visible in the app without re-running the lookup |
| **1.14** | Every new table carries `updated_at` and its trigger | The `tables_without_updated_at` drift check passes |
| **1.15** | Nickname is searchable on the Products page (`searchKeys`, `src/pages/Products.tsx:862`) and in the QuoteBuilder product picker | Typing "Generic Callisto" finds the product |
| **1.16** | Edits to ingredients, density and analysis are audited (who, when, old value, new value), following the `cost_history` precedent | Change a concentration, then show the prior value and who changed it |
| **1.17** | **[REV4 — carve-out added: "every new column" is not literally every new column.** Columns the build plan makes **RPC-only** must NOT receive direct `INSERT`/`UPDATE` grants — specifically the density fields (WP-2 routes writes through the density RPC so the audit trail and precedence cannot be bypassed) and **`product_data_version`**, which WP-1 explicitly revokes because it is the concurrency token: granting direct write to it lets any authenticated user forge the compare-and-set that protects every other edit. **The rule is: each new column ships either its column-level grant or a deliberate, stated revocation — never silence.** Ship the expected-privilege matrix, not a bare check.**] **[REV3] BLOCKER — every new `products` column ships its column-level GRANT in the same migration.** `products` is a **column-carved** table: `authenticated` holds no table-level INSERT or UPDATE, and 27 of its 48 columns instead carry explicit column-level `INSERT`/`UPDATE` grants (verified live via `relacl`). Any Phase 1 column added without a matching `GRANT INSERT(col), UPDATE(col)` is **unwritable by the app** — the field renders, the user types into it, and the save either errors with "permission denied for column" or dies silently. `docs/reference/gotchas.md` currently lists only `application_services` as column-carved and is **stale** | Add a column, then edit it **through the running app as a normal authenticated user** — not as service-role, which masks the failure entirely. Value persists. `gotchas.md` updated in the same change |
| **1.18** | **[REV3] BLOCKER — density precedence must be a stated rule, not left to the executor.** 1.3 puts `density_value` on the product spec; 1.9 also puts one on brand rows. Nothing currently says which the scale-weight math uses. That re-plants the exact dual-source ambiguity this project exists to remove, on its most safety-critical path. **Rule: the spec density is the working value; a brand row may carry an override; the weight calculation uses the recorded brand's density when a brand is recorded *and* that brand has one, otherwise the spec's — and the screen displays which one it used.** The same rule governs per-brand ingredient rows; "the link belongs on whichever row is authoritative" is not something a builder can implement | Two products, one with a brand override and one without, both produce a scale weight, and each shows the source of the density it used |
| **1.19** | **[REV3] Dry products store a net weight per purchase unit.** The design plan discusses this in prose but no numbered requirement ever demanded it, so a builder working from this table would skip it — and dry products then cannot participate in weight-based blending at all | A dry product sold by the case or bag carries its net weight, and a blend drawing on it produces a scale weight |
| **1.20** | **[REV3] State whether specific-gravity entries are normalized to `lb_per_gal` at write time or converted at read time.** Pick one and write it down; a mixed convention produces two subtly different numbers for the same product | The choice is recorded before code. Entering a specific gravity and entering the equivalent lb/gal yield the same scale weight |

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
  `canonical_fraction` case — 5.5# products are the potassium salt, 5.4# the IPA salt.
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
| **1b.5** | **[REV3] Decide now whether the workbook's rate columns are writable, because Phase 2 moves rate truth out from under them.** 1b round-trips `rate_per_acre`, `rate_unit` and `suggested_rate` through `apply_product_pricing_change_set`, which writes **`products` columns only**. Once Phase 2 lands, either that machinery must learn to write child tables — real, unestimated work — or these columns must be rewired or dropped. **Recommended: ship 1b's rate columns read-only from the start**, so the workbook never becomes a fourth write path that Phase 2 has to unwind | The choice is recorded before 1b is built. Phase 2 does not discover the workbook as an unplanned dependency |

### Phase 2 — Rate model correction + unit standardization

| # | Requirement | Acceptance |
|---|---|---|
| 2.1 | **`product_rates` child table** — `product_id`, `basis` (`per_acre`/`per_100_gal`/`per_unit`), `source` (`label`/`house_standard`), `low`, `high`, `recommended`, `unit`, `is_quoting_default`. **Not columns on `products`** | MSO XL stores **two** rows: `2 qt/100 Gal` (label) and `9.6 oz/acre` (house standard). Columns cannot represent this — a single-row-per-product shape is a defect |
| 2.2 | Partial unique index: exactly one `is_quoting_default = true` row per product, constrained to `basis = 'per_acre'` | Attempting a second default, or a non-per-acre default, is rejected by the database |
| 2.3 | **Quotes read only the per-acre quoting-default row.** A product without one gets **no rate autofill — blank, not a number** | A per-unit-only product autofills blank on a quote line, not a wrong figure |
| 2.4 | A filled rate with a blank unit is rejected. **[REV3] Enforce as a database CHECK on `product_rates`, not as UI validation** — per the project hard rule that invariants live in PostgreSQL, a CHECK covers all three write paths for free, while a UI check covers one | Cannot save a rate value with no unit, attempted through **each** write path |
| 2.4a | **[REV3] Correction to 2.4's framing: the exposure is prospective, not current.** 30 products do have a blank `rate_unit`, but all 30 also have a blank `rate_per_acre` — the live count of rows with a **filled rate and blank unit is zero**. The silent-ounces trap is real (`getConversionFactor` returns 1 for an unknown unit) but nothing hits it today. 2.4 still stands as a guard; it is not remediation of active damage | The requirement is built, and the PRD no longer implies live wrong numbers are being produced by this path |
| 2.4b | **[REV3] Remove the hardcoded ounce fallback in the UI as part of this requirement.** `FieldAppChemicalEntry.tsx:304` does `rate_unit: product.rate_unit \|\| product.inventory_unit \|\| 'oz'` — it *manufactures* an ounce guess that the new CHECK then has to reject. Fixing only the database leaves the UI generating rejects | The field-entry path no longer invents a unit. A product with no unit produces a blank the user must fill, not an error the user cannot explain |
| 2.5 | `suggested_rate` free text retained during transition as the audit trail | Original text still readable after migration |
| 2.6 | Re-derived rate values reviewed by the owner before being written. **No bulk auto-rewrite.** | Owner approves the value set; applicator-sheet quantity for a known product matches expectation before and after |
| 2.7 | Unit spellings consolidated (`Oz`/`oz`, `LB`/`Lb`, `Qt`/`qt`, `Unit`/`Ea`) | Spot-check: a quote's total is byte-identical before and after the remap |
| 2.7a | **[REV3] BLOCKER — 2.7 and 2.8 have a forced order, and getting it wrong bricks product editing.** A live BEFORE trigger on `products`, `validate_product_units`, does a **case-sensitive exact match** of `inventory_unit`/`container_unit` against `unit_conversions.unit`. Therefore: **remap every product's unit spelling first (2.7), then delete alias rows (2.8)** — and the canonical spellings kept in `unit_conversions` must exactly match what was written to `products`. Reverse the order, or keep a spelling products don't use, and **every subsequent edit to an affected product fails** | After the consolidation, edit and save a product through the running app for each affected unit. All succeed |
| 2.7b | **[REV3] Alias consolidation touches five database functions that join `unit_conversions`, not just the quote path**: `validate_product_units`, `product_price_per_acre`, `apply_product_pricing_change_set`, `preview_product_cost_basis_changes`, and `_save_quote_below_cost_impl_20260810`. Round 2 named only the quote join | Each of the five is reviewed against the consolidated table before the alias rows are deleted |
| 2.8 | Alias rows consolidated **out of `unit_conversions` itself** — the live `save_quote` join is `LOWER(unit) = LOWER(rate_unit)` against a table holding both cases, which matches two rows and duplicates the base row. **Do not change any conversion factor in the same change** | Join returns one row per unit; quote totals unchanged |
| **2.9** | **[REV3] Resolves open item 6 — the fate of `products.rate_per_acre`. Keep the columns as a trigger-synced projection of the quoting-default `product_rates` row, and REVOKE the app's direct write access to them.** This is the governance pattern already proven on the four phase-3 columns. All 83 consumer files keep working with one consistent meaning; 2.3's blank-not-guessed behavior lands everywhere at once; and the three write paths are *forced* through the new rate RPC because their direct column writes begin failing. This is a technical choice, not an owner decision | Every existing reader still renders a rate. An attempt to write `products.rate_per_acre` directly fails. Changing the quoting-default rate updates the projection |
| **2.9a** | **[REV3] The three product write paths break loudly when 2.9 lands and must be updated in the same change** — verified live: inline edit via `EditableDataTable`, the Add Product modal, and `BulkProductImport.tsx:229`, which does a direct insert. The CSV importer additionally maps `rate_per_acre` and carries an alias quirk: `'unit'` aliases to **both** `unit_size` and `rate_unit` in its alias table (~lines 30–45) | All three paths write rates through the RPC. A CSV import containing a rate column still works, and its `'unit'` column lands in exactly one field |
| **2.10** | **[REV3] `per_100_gal` must handle weight-based rates, and the cleanup is ~3× the stated size.** The literal `2 qt/100 Gal` case is 12 rows across 6 formulations as documented, but the full per-100-gallon class is **37 rows**, including dry-into-liquid entries such as `17 lb/100 Gal`. Sizing the phase for 12 volume-only rows understates it | The basis handles a weight per 100 gallons. All 37 rows are reviewed, not 12 |

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
| 3.4 | Mixed weight/volume products compared correctly using density **and `canonical_fraction`** — density alone converts `% w/w` to lb *salt*/gal, not to acid equivalent | A `% w/w` salt-basis product compares correctly against a `lb ae/gal` product |
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

**[REV3] `products` is a column-carved table — every new column ships its column-level
GRANT in the same migration.** `authenticated` holds **no** table-level INSERT or UPDATE on
`products`; 27 of its 48 columns instead carry explicit column-level `INSERT`/`UPDATE`
grants, a consequence of the earlier phase-3 governance work. A column added without
`GRANT INSERT(col), UPDATE(col)` is unwritable by the app, and the failure mode is a field
that looks completely normal and refuses to save. **Verify by editing through the running
app as an ordinary authenticated user — service-role access masks this failure entirely.**
`docs/reference/gotchas.md` lists only `application_services` as column-carved and is stale;
correct it in the same change.

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

> **STATUS UPDATE 2026-08-19 — read this before treating anything below as open.**
> `2026-08-19-product-data-model-BUILD-PLAN.md` §0 (revision 2) closed several of these. Where
> this list and the build plan disagree, **the build plan wins.**
>
> | Item below | Now closed by | Decision |
> |---|---|---|
> | 8 — absent workbook row | **D-D** | Absent row = **ignore**; deletion needs an explicit `__delete` marker |
> | 8 — child-table concurrency token | **D-E** | New `products.product_data_version`, compare-and-set via `p_expected_data_version` |
> | 9 — seed-treatment rate basis | **D-G** | `per_cwt_seed` and `per_seed_unit` added to the CHECK on day one |
> | 10 — per-phase rollback | **D-F** | `app_settings` key `product_rate_source_mode`. **Read-path switch only** — it does not undo a wrong re-derived value, the revoked grants, or deleted aliases |
> | 13 — workbook / rate collision | **D-C** | Workbook rate columns ship **read-only** from the start |
> | 14 — brand back-fill scope | **D-H** | Human-reviewed pass always; a parser may only *propose* into the review queue |
>
> Also decided 2026-08-19 and not represented below at all: **D-A** (three rules governing
> `canonical_fraction`, incl. nullable for isomers), **D-B** (specific gravity normalizes on
> write; `WATER_LB_PER_GAL = 8.345404`), **D-I** (machine-sourced data lands as a proposal),
> **D-J** (chemistry edits admin-only), **D-K** (an unlisted brand never blocks receiving).
>
> **Still genuinely open:** items **3** (RUP count — parked by Mason), **5** (Codex-app
> connector — Mason's), **7** (the three product write paths — a Phase 2 decision, not needed
> for the Phase 0/1 handoff), **15**, **16**, **17** (documented facts and later-phase scope,
> not decisions).


1. ~~Fable adversarial review in flight.~~ **RESOLVED 2026-08-18.** Verdict: architecture
   sound, no redesign. Four substantive amendments folded in above — canonical
   ingredient + `canonical_fraction`, `product_rates` child table, corrected density warn band,
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
6. ~~**[Round 2] Blocking Phase 2: decide in writing what happens to
   `products.rate_per_acre`.**~~ **RESOLVED by the round-3 review — see requirement 2.9.**
   Keep the columns as a **trigger-synced projection** of the quoting-default `product_rates`
   row and REVOKE the app's direct write access, reusing the governance pattern already
   proven on the four phase-3 columns. All consumers keep working with one consistent
   meaning, and the three write paths are forced through the rate RPC because their direct
   writes start failing. (Corrected count: **83** files reference it, not 82.) This was a
   technical choice, not an owner decision.
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
13. **[REV3] Blocking Phase 2 — the Phase 1b workbook and the Phase 2 rate move collide.**
    Phase 1b ships a workbook that round-trips `rate_per_acre`, `rate_unit` and
    `suggested_rate` through `apply_product_pricing_change_set`, which today writes
    **`products` columns only**. Phase 2 then moves rate truth into `product_rates`. Routing
    the re-derivation "through the change-set machinery" therefore means teaching that
    machinery to write child tables — real, unestimated work — and the workbook's rate
    columns must be rewired or dropped in the same phase. Size Phase 2 honestly, or build
    1b's rate columns read-only from the start.
14. **[REV3] Open until Phase 1 starts: how much of the brand back-fill is manual.** 129
    product names contain parentheses, but several parentheticals are **not** brand lists —
    e.g. "(Full pallets)", "(New Formulation of Resicore XL)". Mechanical parsing of the name
    string will produce junk brand rows. Plan the extraction as a human-reviewed pass.
15. **[REV3] Retiring `ingredient_map` (Phase 3.8) has a wider footprint than recorded.** It
    is referenced by `BrandVsGeneric.tsx` and its test, **and** by `src/lib/rlsContracts.test.ts`
    and the generated `src/types/supabase.ts`. Retirement must update the RLS contract
    fixture, regenerate types, and refresh `.claude/schema-registry.json`.
16. **[REV3] Owner-hours estimate in item 11 is understated.** ~287 products can auto-seed
    from the EPA lookup, but **317** products have no usable EPA registration number — and
    roughly 123 of those are real pesticides (85 herbicide, 18 insecticide, 13 fungicide,
    6 seed treatment, 11 other) that *have* active ingredients but no registration number on
    file. Those cannot auto-seed until someone first types the registration number in. The
    "287 auto-seed, the rest are fertilizers" framing hides a meaningful block of Mason's
    time.
17. **[REV3] The four return RPCs do not themselves call `assert_phase3_return_policy`.**
    `create_return` / `approve_return` / `receive_return` / `issue_return_credit` are thin
    wrappers delegating to `_*_intent_impl_20260812` functions, which carry the guard (plus
    triggers on `return_items`). Net enforcement is as documented, but an executor grepping
    the four public functions finds no guard and may wrongly conclude Phase 0b is
    unprotected. The same delegation pattern applies to `save_quote` →
    `_save_quote_below_cost_impl_20260810`, which is where the `LOWER` join and
    `COALESCE(p.inventory_unit, p.unit_size, 'Ea')` this PRD attributes to `save_quote`
    actually live.

---

## 10. Note on writing quality of this PRD

Every count in §5 was verified live and independently re-verified by the reviewer.
Statements the review found overstated or backwards have been corrected in place rather
than softened — specifically the return-policy enforcement scope, the `unit_size` money
risk, the `quoting_notes` "no code needed" freebie, and the Phase 2 → Phase 3 dependency.
Where a claim is a snapshot rather than a standing fact, it says so.
