# Product Data Model — Build Plan and Handoff Contract

**Date:** 2026-08-19
**Branch:** `claude/product-data-storage-58ba26` — local commits only, nothing pushed
**Intended executor:** Codex **`sol`** (`gpt-5.6-sol`, high reasoning effort)
**Reviewer of record:** Claude **Opus 5** — per-package gate plus a final coverage audit
**Design source of truth:** `docs/plans/2026-08-18-product-data-model-MASTER-RECORD.md`
(43 issues, every decision, and why) and `…-PRD.md` (numbered requirements + acceptance)

This file is the **executable** layer. The master record says *what is wrong and why*; this
says *what gets built, in what order, by whom, and what proof ends each step.* Where the two
disagree, the master record wins on reasoning and this file wins on sequencing.

---

## 0. Nine decisions closed since the master record, plus one new finding

The master record left nine questions open that a builder cannot proceed past without
inventing an answer. All nine are now decided. **These are technical calls, recorded so Mason
can see them — none of them needs his approval.**

### NEW FINDING — there is no feature-flag system in this repo

The master record's Phase 2 rollback plan was *"behind a feature flag — the obvious
mitigation, and it must be built in."* Verified 2026-08-19: `feature_flag`, `featureFlag`,
`FEATURE_FLAG` and `rollout` appear **zero times** across `src/` and `supabase/migrations/`.
There was nothing to put Phase 2 behind.

There is, however, an exact precedent for the same job: `app_settings(setting_key,
setting_value text)` plus a pure parse helper — `src/lib/labelGuardrailSetting.ts`, which
holds a `'warn' | 'block'` mode and **never invents the dangerous value** when the setting is
blank or malformed. That is the pattern, and decision **D-F** below adopts it.

### The nine decisions

| # | Question left open | Decision | Closes |
|---|---|---|---|
| **D-A** | `ae_fraction` cannot express oxide→elemental for fertilizer nutrients (PRD 1.10b left it an either/or) | **Generalize the column.** `ae_fraction` becomes **`canonical_fraction`** with a companion **`fraction_basis`** (`acid_equivalent` \| `elemental`). Glyphosate IPA salt → parent glyphosate acid, fraction 0.74, basis `acid_equivalent`. P₂O₅ → parent P, fraction 0.436, basis `elemental`. **One mechanism, both problems.** `basis` on the concentration row gains `oxide` and `elemental` values | B-24, PRD 1.10b, amends T-2 |
| **D-B** | Are specific-gravity entries normalized on write or converted on read? (PRD 1.20) | **Normalize to `lb_per_gal` on write.** The entered value and its unit are retained alongside for audit, so nothing is lost, but exactly one number is ever used for math | PRD 1.20 |
| **D-C** | Do the workbook's rate columns ship writable? (PRD 1b.5) | **Read-only from the start.** Confirms T-15. The workbook never becomes a fourth write path that Phase 2 has to unwind | C-32, open item 13 |
| **D-D** | Does an absent row in the workbook's `Ingredients` / `Crop Uses` tabs mean delete or ignore? (open item 8) | **Ignore.** Deletion requires an explicit `__delete` marker column set to `true` on the row being removed. A missing row is *never* destructive — the failure mode of the opposite default is a filtered spreadsheet silently wiping a product's chemistry | Open item 8 |
| **D-E** | The child tables have no concurrency token; `pricing_version` guards the `products` row only (open item 8) | **New `products.product_data_version` integer**, bumped by every ingredient / density / brand RPC, and **revoked from direct app write** (same governance pattern as C-42). Do **not** reuse `pricing_version` — bumping it from a chemistry edit would fire false conflicts in the pricing workbook | Open item 8 |
| **D-F** | Phase 2 rollback (C-38, open item 10) | **`app_settings` key `product_rate_source_mode`**, values `legacy` (default, shipped) \| `rates_table`. Parse helper mirrors `src/lib/labelGuardrailSetting.ts`: only the exact string `rates_table` switches over; blank, missing or malformed means `legacy`. Rollback is one settings row, no deploy | C-38, open item 10 |
| **D-G** | Seed-treatment rate basis (C-40, open item 9) | **Add `per_cwt_seed` and `per_seed_unit` to the `product_rates.basis` CHECK on day one**, while it is free. `per_unit` keeps its narrow meaning: *per each*. Widening the CHECK later is a migration | C-40, open item 9 |
| **D-H** | How much of the brand back-fill is mechanical? (open item 14) | **Human-reviewed pass, always.** A parenthetical parser may *propose* brand rows into the same review queue the EPA seeding uses (D-I), but nothing it produces is written unreviewed. "(Full pallets)" and "(New Formulation of Resicore XL)" are in that 129 and are not brands | Open item 14 |
| **D-I** | Where does machine-sourced data land before a human sees it? | **Reuse `product_label_drafts`' propose-review-commit shape** (status set, confidence, `reviewed_by`, `run_idempotency_key`) — verified live in `supabase/migrations/20260629210000_product_label_drafts.sql` and `src/pages/LabelReview.tsx`. EPA ingredient seeding and parsed brand proposals both use it | T-18, open item 14 |

---

## 1. Readiness verdict

**The design is ready to build. The handoff is blocked on one thing, and it is not technical.**

| Blocker | State | Who clears it |
|---|---|---|
| **Codex credits are at zero** (recorded 2026-08-18) | Sol cannot execute anything, and the `gpt-5.6-sol` adversarial gate that `AGENTS.md` requires for every migration-bearing diff cannot run either | **Mason.** Nothing in this plan starts without it |
| **Supabase connector scope in the Codex app** | The tracked `.codex/config.toml` points at project `rhyzpcqhnizqbxphqdkr` with `read_only=false`; its OAuth grant was recorded dead (`invalid_grant`) on 2026-08-14, and the live scope is an owner-only toggle in the Codex app | **Mason** confirms it before Sol relies on live-database reads |
| Everything else | **Clear.** All 43 issues are mapped to a work package below; the nine open questions are closed above | — |

### One consequence of Sol executing, stated plainly

`AGENTS.md` requires a *fresh, separate, exact-SHA adversarial proof pinned to `gpt-5.6-sol`
at high effort* for risky diffs. If Sol also **writes** the diff, that gate becomes the same
model reviewing its own work in a new session. That satisfies the contract's letter and is
weaker than its intent.

**This is exactly the hole the Opus review in §5 fills** — a genuinely different model, on a
fixed checklist, with the coverage matrix as its scoresheet. Both run. Neither replaces the
other.

---

## 2. Standing rules for this build

Sol must obey these on every package. They exist because each one has already burned this
project or this codebase once.

| # | Rule | Why |
|---|---|---|
| **R-1** | **No migration package ships without the screen surface that proves it.** A migration whose only proof is a test is not accepted | `products` is column-carved (C-25). A missing `GRANT` renders a perfect-looking field that silently fails to save, and **service-role testing cannot see it** |
| **R-2** | **Every acceptance is run as a normal authenticated user in the running app** — never as service role, never "the tests pass" | C-25, and the `AGENTS.md` Verification Standard |
| **R-3** | **Every new `products` column ships `GRANT INSERT(col), UPDATE(col)` in the same migration.** Update `docs/reference/gotchas.md` in the same change — it currently names only `application_services` and is stale | C-25 |
| **R-4** | **Search merges forms; math never does.** All searching and grouping goes through `canonical_ingredient_id`; every calculation — rebuild quantity, family matching, scale weight — uses the **specific** ingredient row | B-8, C-33, D-11 |
| **R-5** | **Existing code is not evidence of an existing workflow. Only data is.** Before building on any table, count its rows | C-29 — the lot/tote chain is fully built and holds zero rows |
| **R-6** | **Warn on entry, block on use.** An unusual density warns and saves. A request for a scale weight with no density **refuses** — never water, never a default, never an estimate | D-5. A wrong comparison is a bad quote; a wrong density is a wrong weight in a real mixer |
| **R-7** | **Never hard-delete, in any package.** Deactivate or re-identify. If a row genuinely warrants deletion, that is a separate request to Mason with the foreign-key survey attached | T-17 |
| **R-8** | **One package, one pull request.** No package bundles a second package's migration | Keeps each of Mason's approval gates a decision he can actually read |

---

## 3. Work packages — Phase 0 and Phase 1

This is the handoff scope. Phase 1b onward is sketched in §4 and is **not** handed off yet.

Each package states: what it builds, the proof that ends it, the issues it closes, and its
gates. Packages are strictly ordered — WP-1 before WP-2 before WP-3 — because the master
record's round 3 found that a builder who starts on screens builds them against tables that
then change shape.

---

### WP-0 · Data hygiene — **no migration**

**Builds:** re-SKU one `9768NR` row (both stay active and orderable, T-16); resolve 13 blank
SKUs; resolve 3 duplicate name groups; deactivate `1A TEST PRODUCT - FAKE PRODUCT`; trim 13
whitespace-only `epa_registration` values to NULL; classify 11 blank `product_form` rows.

**Order that matters:** for the 11 blank forms, **check each row's units first.** The live
BEFORE trigger `validate_product_units` case-sensitively matches `inventory_unit` /
`container_unit` against `unit_conversions`, and will *reject* a form that disagrees (C-26).

**Deliverable before any write:** a proposal file listing every affected row, its current
value, its intended value, and its foreign-key references — for Mason's per-class sign-off.

**Proof:** every SKU identifies exactly one sellable; nothing hard-deleted; every historical
reference still resolves (before/after `SELECT`s attached to the PR).

**Closes:** A-5, C-26 (Phase 0 half), T-16, T-17, PRD 0.1–0.3a.
**Gates:** Mason approves **each class** before it runs. No migration → no Codex gate.
**Rollback:** each change individually reversible; nothing deleted.

---

### WP-1 · Ingredient core + minimal ingredient editor — **migration**

**Tables:** `active_ingredients` (name, CAS, EPA code, `canonical_ingredient_id` self-FK,
**`canonical_fraction`**, **`fraction_basis`** — see D-A); `product_active_ingredients`
(product, ingredient, nullable `concentration_value`, `concentration_unit`,
`basis`, `source`, `verified_by`, `verified_at`); `ingredient_moa_codes` (ingredient,
`scheme`, `code` — child table, **multiple per ingredient**, scheme required).

**Constraints:** `concentration_unit` ∈ `lb_per_gal`, `percent_w_w`, `cfu_per_ml`,
`cfu_per_g` — **`lb_per_lb` rejected** (T-10). `basis` ∈ `acid_equivalent`,
`active_ingredient`, `oxide`, `elemental` (D-A). Nullable concentration is explicitly
allowed and means *ingredient present, amount unknown* (PRD 1.12).

**Also in this migration:** RLS + policies (1.5), `updated_at` + trigger on every new table
(1.14), `p_idempotency_key` on every mutating RPC (1.7), the ingredient/density/analysis
**audit trail** following the `cost_history` precedent (1.16, C-37), and
`products.product_data_version` per D-E with its write revoked.

**Also builds:** the ingredient section on `ProductDetail` — add, edit, remove, with unit and
basis pickers. Herbicide MOA uses the **numeric global code only** (D-17).

**Seed as the proof case:** the three glyphosate salt forms plus the parent acid, with real
`canonical_fraction` values (IPA ≈ 0.74, potassium ≈ 0.817, DMA ≈ 0.78).

**Proof (R-2):** signed in as a **normal user**, open a product, add three ingredients with
different bases, save, reload — all three persist. Change a concentration and show the prior
value and who changed it. Search "glyphosate" and get **every** salt form back, not a subset.

**Closes:** A-1, B-8 (mechanism), B-9, B-23, B-24, C-37, T-2 (as amended by D-A), T-3, T-9,
T-10, D-17, PRD 1.1, 1.1a, 1.2, 1.5, 1.6, 1.7, 1.12, 1.14, 1.16.
**Gates:** RLS review + migration-drift review before apply · fresh exact-SHA `gpt-5.6-sol`
proof · **Mason's explicit in-chat OK to apply live.**
**Rollback:** additive — stop using it.

---

### WP-2 · Density, net weight, formulation type, safener — **migration**

**Adds to `products` (each with its `GRANT`, R-3):** `density_value`, `density_unit`,
`density_source` (`label`/`sds`/`supplier`/`measured`/`assumed`), dry **net weight per
purchase unit** (1.19), `formulation_type` and `safener` (1.11), `nickname`.

**Rules built in code:**
- **Warn band ≈ 6.5–14 lb/gal — warn, never reject.** A hard 8–12 floor is a defect: crop
  oils and MSOs run 7.6–7.8 (T-5).
- **Specific gravity normalizes to `lb_per_gal` on write**, entered value retained (D-B).
- **Density precedence function**, written before any weight math: spec density is the
  working value; a brand row may override; the calculation prefers the recorded brand's
  density when one exists; **the screen displays which one it used** (T-8, 1.18). The brand
  slot is built now and populated by WP-3.
- **Scale weight refuses** when density is absent, with a message naming the missing product
  (R-6, D-5).

**Proof (R-2):** enter 7.7 lb/gal on a real crop-oil product as a normal user — it saves,
with at most a warning. Enter a specific gravity and the equivalent lb/gal on two products →
identical scale weight. Ask for a scale weight on a product with no density → **refusal**, no
number produced. `gotchas.md` corrected in the same PR.

**Closes:** B-10, B-11, C-25 (first live exercise), C-27, C-33 (the formulation/safener half),
T-5, T-8, D-5, PRD 1.3, 1.3a, 1.11, 1.18, 1.19, 1.20.
**Gates:** as WP-1. **This is the safety-critical package** — treat its review at the same
tier as money.
**Rollback:** additive.

---

### WP-3 · Brand layer, receiving capture, split loads — **migration**

**Table:** `product_brands` under the product spec — `brand_name`, **its own
`epa_registration`**, manufacturer, `label_url`, `density_value` (the WP-2 override),
`is_currently_sourced`, and **`sourcing_tier`** (C-43).

**Receiving:** a `brand_id` column **on the receiving record itself**, independent of any lot
or tote number (1.9a). Brand selection is **required** once a spec has brand rows defined, and
**completing with the lot/tote field blank is the normal successful path, not a warning**
(1.9a-i). A spec with no brand rows yet does not block receiving.

**Split loads:** more than one brand, each with a quantity, per delivery/application line —
keyed to the line, **not** to a lot number (1.9a-ii).

**Snapshots:** records store the brand's name and EPA number **at write time** and never
dereference the brand row later, so correcting a typo cannot rewrite history (1.9a-iii).

**Hands off:** `receiving_records.lot_number`, `delivery_items.tote_number`,
`invoice_items.tote_number`, `blend_ticket_products`, `application_record_lots`,
`blend_tickets` — existing but dormant. Not extended, not deleted, never a condition of any
brand behavior (1.9a-iv, R-5).

**Proof (R-2):** receive a product with **no lot number and no tote number** → brand fully
recorded and it reaches paperwork. Record a split of 30 gal / 15 gal across two brands → both
brands, both EPA numbers, both quantities on the customer document, still with no lot or tote
entered. Change a brand's EPA number afterwards → the existing record still shows the old one.

**Closes:** B-16 (brand half), B-17, C-28, C-29, C-43 (capture half), D-13, D-14, D-15, T-6,
T-7, PRD 1.9, 1.9a, 1.9a-i, 1.9a-ii, 1.9a-iii, 1.9a-iv, 1.9b.
**Gates:** as WP-1. **This is the one package that changes the crew's daily routine.**
**Rollback:** additive, but the required-brand step at receiving is behind the same
`app_settings` mechanism as D-F so it can be switched off without a deploy.

---

### WP-4 · EPA auto-seed through propose-review-commit — **no new tables**

**Builds:** the EPA lookup **persists** what it already fetches and discards — ingredients
mapped to canonical acids, the label URL and accepted date, and `productStatus` /
`isCancelled`. All of it lands as **proposed**, in the `product_label_drafts` shape (D-I),
and nothing is written to the live ingredient tables until Mason approves it.

**Scope note, honestly:** this fills roughly **287** products. **317 have no usable EPA
registration number, and ~123 of those are real pesticides** with genuine ingredients — they
cannot auto-seed until someone types the number in first (B-22).

**Deliberate scope pull-forward:** PRD 4.1 (label URL + accepted date) moves from Phase 4 to
here, because it is the same fetch and splitting it would mean running the lookup twice.

**Proof (R-2):** run the lookup on a real product with a known EPA number → its ingredients
appear as proposals under the right **canonical** ingredient; approve → committed; a cancelled
registration is visible in the app without re-running the lookup.

**Closes:** B-8 (seeding half), B-22 (surfaced), D-23, T-18, PRD 1.4, 1.13, 4.1.
**Gates:** no schema change beyond WP-1's tables → RLS review only. Bulk commit of proposals
is a **bulk write to live rows → Mason's approval.**

---

### WP-5 · Copy-from-sibling and searchable nickname — **no migration**

**Builds:** "copy ingredients / density / brands from sibling" on the product detail screen,
so a Bulk row inherits the 2.5-gallon row's chemistry in one action (1.8) — and the same for
brand rows, so "Ag Saver 5.4" is not typed onto three packaging siblings (1.9c). Nickname
becomes searchable on the Products page and in the QuoteBuilder picker (1.15).

**Proof (R-2):** type "Generic Callisto" → the product is found. Copy from a sibling → the
Bulk row carries the same chemistry, and editing one afterwards does not silently change the
other.

**Closes:** B-18 (entry half), PRD 1.8, 1.9c, 1.15.
**Gates:** no migration. Standard review.

---

## 4. The rest of the sequence — planned, not yet handed off

Detail lives in the master record and PRD. What follows is the sequencing and the decisions
already made, so nothing here has to be re-derived.

| Phase | Package | Already decided |
|---|---|---|
| **1b** | Product Data Workbook | Extend the **existing** machinery — reuse the concurrency guard, preview and archive safety (T-14). `Ingredients` and `Crop Uses` as separate tabs, never delimited strings. **Rate columns read-only** (D-C). **Absent row = ignore** (D-D). Child-table concurrency via `product_data_version` (D-E) |
| **2** | Rate correction + unit standardization | **Highest-risk phase.** `product_rates` child table with `low`/`high`/`recommended`, one per-acre quoting default enforced by the database (T-4, D-20). Old columns become a **trigger-synced read-only mirror** with app writes revoked (T-11, C-42). All **three** write paths updated together (C-31). Blank-unit rejection as a **database CHECK** (T-12) with the hardcoded `'oz'` removed (B-15). **Remap spellings first, delete aliases second** (T-13, C-26) and **change no conversion factor** in the same change. All **37** per-100-gallon rows reviewed (C-30/B-14). Seed-treatment bases from day one (D-G). Behind `product_rate_source_mode` (D-F). **573 re-derived values reviewed by Mason, never bulk-rewritten** |
| **3** | Comparison tool *(target ≈ 2026-09-18)* | Search through the canonical id (R-4); Halex GT at 4 pt must reproduce Mason's sheet exactly — 33.44 oz / 3.34 oz / 1.09 pt; coverage gaps surfaced loudly; both cost and customer price with a selectable tier; the adjuvant-exclusion note visible wherever a total is; money parses to whole cents (T-22); RUP never shown as verified (B-21); old page and `ingredient_map` retired — and that retirement also touches the RLS contract fixture, generated types and the schema registry (C-36) |
| **4** | Adjuvants, crop/timing, note boxes | Label URL already pulled into WP-4. Crop **and timing as pairs** (D-19). Required-vs-recommended adjuvant (D-18). The customer-facing note box clearly marked — and **filling `quoting_notes` changes what 444 products auto-fill onto new quotes**, so preview the before/after first (B-19) |
| **5** | Families and packaging variants | Derived and **proposed**, never typed; Mason approves each grouping. Exclude zero-ingredient products (T-19). **Respect the sourcing tier** (C-43). Family-drift check (T-20). Match on the **specific** ingredient row (R-4). Use the EPA distributor-registration signal (5.5) |
| **7** | Retire `unit_size` | Late because of **breadth, not money** (C-41): 50+ files, a workbook column, database function bodies to re-emit. `inventory_unit` becomes required in the same migration (T-21) |
| **8** | Product images | Copied into CRX storage, not linked (D-22) |
| **Parked** | Label rate / REI / PHI · required fields on create · RUP correction · density backfill · per-crop rates | Mason's calls, on record. Field Mode's over-label-rate warning stays inert until the first of these runs |
| **Tracked outside** | `blendMathValidator.ts` sums gallons and pounds together (C-39) | Warning-text only — but once WP-2 lands, density makes it **fixable**. Raise as its own ticket; do not fold it into this plan |

---

## 5. The Opus review gate

Mason's requirement: *"make sure opus reviews all work to make sure when it is done we have
fixed and covered all issues."* Three checkpoints, and a scoresheet that makes the review
mechanical instead of archaeological.

### Checkpoint 1 — per package, before the migration applies

Opus reads the diff plus **the proof evidence Sol attached**, and answers four questions:

1. Does every issue this package claims to close actually get closed by this diff?
2. Does the proof show the behavior **running as a normal user**, or does it show a test?
3. Are the CRX hard rules satisfied — RLS in the same migration, idempotency key enforced,
   `SET search_path`, column grants (R-3), no floating-point money, `assertRpcResult` /
   `checkMutationResult`, `ConfirmModal` not `confirm()`?
4. Does the diff touch anything outside its package (R-8)?

**Verdict:** `PASS` / `PASS WITH FINDINGS` / `BLOCK`. A `BLOCK` returns to Sol; it does not
go to Mason as a decision.

This is **in addition to** the `gpt-5.6-sol` exact-SHA adversarial gate, not instead of it.

### Checkpoint 2 — end of Phase 1 (after WP-5)

Full coverage audit at **xhigh** effort against §6. Every one of the 43 issues gets a verdict
and an evidence pointer. Anything not `COVERED` is either scheduled to a named later package
or escalated to Mason as a gap.

### Checkpoint 3 — end of project

The same audit re-run across all phases, plus the eight end-to-end tests from the master
record's *"How we will know it worked"* — run live, observed, and reported to Mason with what
was seen, not what was expected.

### The scoresheet

`docs/plans/2026-08-19-product-data-model-COVERAGE.md` — created from §6 below. **Sol fills in
the evidence column as each package lands; Opus verifies it and sets the verdict.** Sol never
sets a verdict on its own work; Opus never has to reconstruct where something was addressed.

---

## 6. Coverage matrix — all 43 issues

`WP-n` = a package in §3 (handed off now). `Ph-n` = a later phase in §4. Status is what the
matrix starts at; the tracked COVERAGE file is what gets updated.

| Issue | Severity | Where it gets closed | Proof that closes it |
|---|---|---|---|
| A-1 Ingredients not stored | BLOCKER | **WP-1** | Three ingredients persist on a real product, as a normal user |
| A-2 Family/variant/return fields unwritable | HIGH | **Ph-5** (families) · return policy **deferred** | Families written for the first time |
| A-3 `unit_size` duplicates `inventory_unit` | MEDIUM | **Ph-7** | 50+ files migrated; `inventory_unit` required |
| A-4 Unit spellings inconsistent | MEDIUM | **Ph-2** | Quote total byte-identical before/after the remap |
| A-5 Duplicates, blanks, a test row | MEDIUM | **WP-0** | Every SKU identifies one sellable; all FKs still resolve |
| A-6 Label rate / REI / PHI empty | HIGH | **PARKED** (Mason) | — Field Mode's warning stays inert until unparked |
| A-7 No required fields on create | MEDIUM | **PARKED** (Mason) | — |
| B-8 Same-name-different-substance | BLOCKER | **WP-1** + WP-4 + Ph-3 + Ph-5 | One "glyphosate" search returns every salt form |
| B-9 Acid equivalent vs salt weight | BLOCKER | **WP-1** (`canonical_fraction`, D-A) | A 5.4# and a 5.5# product compare on the same basis |
| B-10 Density does not exist | BLOCKER | **WP-2** | Density saved and re-read; missing density refuses a weight |
| B-11 Liquid and dry chains disconnected | BLOCKER | **WP-2** | A `% w/w` product converts to lb/gal via its density |
| B-12 "Each" stored as an ounce | MEDIUM | **Ph-2** (flagged, not blessed) | The 8 affected products identified before the alias cleanup |
| B-13 Rates picked from ranges with no rule | HIGH | **Ph-2** | 573 values reviewed by Mason, none auto-rewritten |
| B-14 Two kinds of rate in one field | HIGH | **Ph-2** | MSO XL stores both its label and house rates |
| B-15 Blank rate unit becomes ounces | HIGH | **Ph-2** | Database CHECK rejects it through all three write paths |
| B-16 One name carrying five facts | HIGH | **WP-3** (brands) + WP-1 (the `#` loading) | Brand list lives in rows, not in the name string |
| B-17 No per-brand EPA number | HIGH | **WP-3** | Two brands under one spec, each with its own number |
| B-18 Packaging siblings typed twice | HIGH | **WP-5** + Ph-5 (drift check) | Bulk row inherits the 2.5-gal chemistry in one action |
| B-19 Customer-facing note box empty | MEDIUM | **Ph-4** | Before/after previewed before any mass-fill |
| B-20 The spreadsheet has no math | HIGH | **Ph-3** | Halex GT reproduces the sheet: 33.44 / 3.34 / 1.09 |
| B-21 RUP count known wrong | HIGH | **PARKED**; **Ph-3** must show it unverified | RUP never rendered as verified fact |
| B-22 A third of the catalog can't auto-seed | HIGH | **WP-4** (surfaced honestly) | The ~123 pesticides needing manual numbers are listed |
| B-23 Biologicals fit neither unit | MEDIUM | **WP-1** (CFU units) | All 9 store a real CFU figure, no fake percentage |
| B-24 Oxide vs elemental nutrients | MEDIUM | **WP-1** (D-A) | P₂O₅ and elemental P are distinguishable and convertible |
| C-25 `products` is permission-carved | BLOCKER | **R-3**, first exercised in **WP-2** | A new column is edited **through the app as a normal user** |
| C-26 Unit-cleanup order can brick editing | BLOCKER | **WP-0** + **Ph-2** (T-13) | Every affected product still saves after the remap |
| C-27 Density in two places, no rule | BLOCKER | **WP-2** (T-8) | Each weight shows which density it used |
| C-28 Brands vs families — both needed | HIGH | **WP-3** + Ph-5 | Both ship; the overlap columns flagged for retirement |
| C-29 Lot/tote chain is unused | BLOCKER | **WP-3** (R-5) | Receiving with no lot **and** no tote works completely |
| C-30 Rate field is in 83 files | HIGH | **Ph-2** (T-11) | Every existing reader still renders a rate |
| C-31 Three product write paths | HIGH | **Ph-2** | All three write rates through the RPC |
| C-32 Workbook and rate move collide | HIGH | **D-C** → Ph-1b | Workbook rate columns ship read-only |
| C-33 Same ingredients ≠ interchangeable | HIGH | **WP-2** (capture) + Ph-3/Ph-5 (surface) | A safened and unsafened pair are visibly different |
| C-34 Return-policy risk written backwards | HIGH | **DEFERRED** — on record | — |
| C-35 Return guard is behind a delegation | MEDIUM | Documented in `gotchas.md` (**WP-2** PR) | A builder grepping the public functions is not misled |
| C-36 `ingredient_map` retirement footprint | MEDIUM | **Ph-3** | Fixture, types and schema registry all updated |
| C-37 No audit trail for ingredient/rate/density | HIGH | **WP-1** | Prior value and author shown after a change |
| C-38 No per-phase rollback story | MEDIUM | **D-F** → Ph-2; WP-0 documented | Rollback is one `app_settings` row, no deploy |
| C-39 Blend math adds gallons to pounds | MEDIUM | **Tracked outside** — fixable once WP-2 lands | Own ticket; not folded into this plan |
| C-40 Seed treatments have no valid basis | MEDIUM | **D-G** → Ph-2 | The enum carries both seed bases from day one |
| C-41 `unit_size` risk was overstated | — | **Ph-7** | Corrected rationale recorded; breadth not money |
| C-42 Governance is stronger than claimed | — | Pattern reused in **D-E** and Ph-2 (T-11) | Direct writes fail; the RPC is the only path |
| C-43 Identical ingredients, different products | HIGH | **WP-3** (tier) + Ph-5 (grouping) + Ph-3 (labelling) | `Gen Liberty` and `Gen Liberty: Higher Quality` never silently merge |

---

## 7. Approval gates — unchanged, and a handoff carries none of them forward

Sol must stop and get Mason's explicit OK **in that session** before:

- applying any live database migration;
- any bulk write to live product rows (WP-0, WP-4's commit step, Ph-2, Ph-5);
- pushing, opening a pull request, merging, or deploying;
- deleting anything — including dropping `ingredient_map` in Phase 3.

Standing mechanics: `main` is protected, so landing means **branch → PR → checks green
(Vercel required) → read and resolve CodeRabbit → merge**. A merge to `main` deploys
production.

**What Mason needs to do before any of this starts:**

1. **Restore Codex credits.** Nothing runs without them — not Sol executing, and not the
   adversarial gate on the first migration.
2. **Confirm the Supabase connector** in the Codex app is live and correctly scoped.
3. Then approve **WP-0's proposal file**, which is the first thing Sol produces.

---

**Nothing in this plan is built until Mason says go.**
