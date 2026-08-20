# Product Data Model — Coverage Scoresheet

**Purpose:** one row per issue, tracked from "found" to "proven fixed." This is the file the
Opus review grades against, so no reviewer ever has to reconstruct where something was
addressed.

**Source of truth for the issues themselves:** `2026-08-18-product-data-model-MASTER-RECORD.md`
**Source of truth for the packages:** `2026-08-19-product-data-model-BUILD-PLAN.md`

## How this file is used

| Who | Does what |
|---|---|
| **Codex `sol`** (builder) | Fills **Evidence** when a package lands: the PR or commit, plus one line naming what was run and what was seen. Sets **Status** to `CLAIMED`. **Never sets Verdict.** |
| **Claude Opus 5** (reviewer) | Sets **Verdict** — `COVERED`, `PARTIAL`, `NOT COVERED`, or `DEFERRED` — after reading the diff and the evidence. `PARTIAL` and `NOT COVERED` must say what is missing. |
| **Mason** | Reads the Verdict column. Anything not `COVERED` or `DEFERRED` at the end of a phase comes to him as a decision. |

**Rules:** Evidence must describe behavior observed **in the running app as a normal user** —
a passing test is not evidence (build plan R-1, R-2). A `DEFERRED` verdict requires the
decision that deferred it, named. No row is deleted; a dropped issue becomes `DEFERRED` with
the reason.

**Status values:** `OPEN` → `IN PROGRESS` → `CLAIMED` → verdict set.

---

## Group A — Mason's original list

| # | Issue | Package | Status | Evidence (Sol) | Verdict (Opus) |
|---|---|---|---|---|---|
| A-1 | Ingredients not stored anywhere | WP-1 | OPEN | | |
| A-2 | Family / variant / return fields unwritable | Ph-5 · return deferred | OPEN | | |
| A-3 | `unit_size` duplicates `inventory_unit` | Ph-7 | OPEN | | |
| A-4 | Unit spellings inconsistent | Ph-2 | OPEN | | |
| A-5 | Duplicates, blank SKUs, a test row | WP-0 | OPEN | | |
| A-6 | Label rate / REI / PHI all empty | PARKED | OPEN | | |
| A-7 | No required fields on product create | PARKED | OPEN | | |

## Group B — found by investigation

| # | Issue | Package | Status | Evidence (Sol) | Verdict (Opus) |
|---|---|---|---|---|---|
| B-8 | Same name, different substance | WP-1 · WP-4 · Ph-3 · Ph-5 | OPEN | | |
| B-9 | Acid equivalent vs salt weight | WP-1 | OPEN | | |
| B-10 | Density does not exist in the schema | WP-2 | OPEN | | |
| B-11 | Liquid and dry unit chains never meet | WP-2 | OPEN | | |
| B-12 | "Each" stored as one ounce | Ph-2 | OPEN | | |
| B-13 | Rates picked from ranges with no rule | Ph-2 | OPEN | | |
| B-14 | Two kinds of rate in one field | Ph-2 | OPEN | | |
| B-15 | Blank rate unit silently becomes ounces | Ph-2 | OPEN | | |
| B-16 | One product name carrying five facts | WP-3 · WP-1 | OPEN | | |
| B-17 | No per-brand EPA registration number | WP-3 | OPEN | | |
| B-18 | Packaging siblings entered twice | WP-5 · Ph-5 | OPEN | | |
| B-19 | Customer-facing note box unused | Ph-4 | OPEN | | |
| B-20 | The pricing spreadsheet has no ingredient math | Ph-3 | OPEN | | |
| B-21 | Restricted-use count is known wrong | PARKED · Ph-3 shows unverified | OPEN | | |
| B-22 | A third of the catalog cannot auto-seed | WP-4 | OPEN | | |
| B-23 | Biologicals fit neither concentration unit | WP-1 | OPEN | | |
| B-24 | Fertilizer oxide vs elemental | WP-1 | OPEN | | |

## Group C — found in review rounds

| # | Issue | Package | Status | Evidence (Sol) | Verdict (Opus) |
|---|---|---|---|---|---|
| C-25 | `products` is permission-carved column by column | R-3, first exercised WP-2 | OPEN | | |
| C-26 | Unit cleanup in the wrong order bricks editing | WP-0 · Ph-2 | OPEN | | |
| C-27 | Density would live in two places with no rule | WP-2 | OPEN | | |
| C-28 | Brands and families are different axes | WP-3 · Ph-5 | OPEN | | |
| C-29 | Brand tracking was about to be built on a dead chain | WP-3 | OPEN | | |
| C-30 | The rate field is in 83 files | Ph-2 | OPEN | | |
| C-31 | Three separate product write paths | Ph-2 | OPEN | | |
| C-32 | Workbook and rate move collide | Ph-1b (decision D-C) | OPEN | | |
| C-33 | Same ingredients ≠ interchangeable | WP-2 · Ph-3 · Ph-5 | OPEN | | |
| C-34 | Return-policy risk is written backwards | DEFERRED | OPEN | | |
| C-35 | Return guard hides behind a delegation | WP-2 PR (`gotchas.md`) | OPEN | | |
| C-36 | `ingredient_map` retirement reaches further than expected | Ph-3 | OPEN | | |
| C-37 | No audit trail for ingredient / rate / density edits | WP-1 | OPEN | | |
| C-38 | No per-phase rollback story | Ph-2 (decision D-F) | OPEN | | |
| C-39 | Blend math adds gallons to pounds | TRACKED OUTSIDE | OPEN | | |
| C-40 | Seed treatments have no valid rate basis | Ph-2 (decision D-G) | OPEN | | |
| C-41 | `unit_size` retirement risk was overstated | Ph-7 | OPEN | | |
| C-42 | Existing governance is stronger than assumed | Pattern reused: D-E, Ph-2 | OPEN | | |
| C-43 | Identical ingredients, deliberately different products | WP-3 · Ph-5 · Ph-3 | OPEN | | |

---

## End-to-end tests — Opus checkpoint 3

Run live and observed, not asserted. From the master record's *"How we will know it worked."*

| # | Test | Result | Observed by |
|---|---|---|---|
| 1 | Search "glyphosate" returns every salt form, not a subset | | |
| 2 | A 5.4# and a 5.5# product compare on the same acid-equivalent basis | | |
| 3 | Halex GT at 4 pt reproduces the sheet: 33.44 oz / 3.34 oz / 1.09 pt | | |
| 4 | A scale weight is refused when density is missing — no default, no water | | |
| 5 | Receiving completes with no lot number and no tote number, brand recorded | | |
| 6 | A split load shows both brands, both EPA numbers, both quantities | | |
| 7 | An ingredient edit shows its prior value and its author | | |
| 8 | A normal (non-admin) user can save every new field through the app | | |

---

## Package ledger

| Package | Migration? | PR | Sol proof attached | Opus checkpoint 1 | Live apply approved by Mason |
|---|---|---|---|---|---|
| WP-0 Hygiene | no | | | | |
| WP-1 Ingredient core | **yes** | | | | |
| WP-2 Density | **yes** | | | | |
| WP-3 Brands | **yes** | | | | |
| WP-4 EPA seeding | no | | | | |
| WP-5 Copy / nickname | no | | | | |
