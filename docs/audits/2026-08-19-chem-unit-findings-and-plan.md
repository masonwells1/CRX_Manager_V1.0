# Chem-line unit/money work — findings and plan, for adversarial review

**Date:** 2026-08-19 · **Branch:** `claude/zealous-agnesi-aa7423` @ `85e1acef` (0 behind / 9 ahead of `origin/main`)
**Status:** NOT pushed. Nothing in production has changed. Recommendation is to PARK, not land.
**Worktree:** `C:/CRX_Manager/.claude/worktrees/skills-audit-optimization-c97839`

This document is the thing to review: **the findings and the plan**, not only the diff. Every number
below was measured against the live database (project `rhyzpcqhnizqbxphqdkr`, read-only) or produced by
executing the shipped module in a running dev server. Treat each as a claim to be refuted.

---

## 1. The original task, and why it dissolved

The assignment was to fix `baseUnitOfRate` in `src/lib/chemCalculator.ts`, which strips a per-acre
suffix by splitting on the first `/`, so `oz/cwt` collapses to `oz`. The live SQL `normalize_rate_unit`
does the opposite — it keeps the whole string when the denominator is not acres, precisely so it cannot
match a bare unit and the conversion refuses.

**Measured exposure first: zero.** Across every unit-bearing column — `products` (rate_unit,
inventory_unit, unit_size, container_unit, max_label_rate_unit), `quote_items`, `order_items`,
`job_chemicals`, `invoice_items`, `blend_ticket_products`, `blend_recipe_items`, `inventory`,
`return_items`, `application_record_lots`, `unit_conversions` — exactly **3** stored values contain a
`/` and all three are `pt/ac`. **574** products carry a rate unit; every one is bare. No live value can
trigger the reported bug.

Two anchors named in the assignment do not exist on `main`: the `KNOWN_ISSUES` entry describing this bug
and the `rateBaseUnit` helper it says to reuse both live on the **unmerged** branch
`claude/blend-unit-rebuild-step1`.

**First attempt (`bd080626`) was REVERTED (`0890a2eb`).** Copying the SQL's whole-string behaviour made
the money worse: `oz/cwt` on a $28.00/GAL product went from $44 to **$5,600** — a 128x over-bill.
Server parity was the stated reason and it targeted the wrong server: `field_app_priced_quantity`
returns NULL and its caller refuses, but `transfer_job_to_invoice` — the actual consumer — bills
`safe_cents_qty(price_per_unit_cents, quantity)` with no conversion and refuses nothing. Parity with a
refuse-on-NULL function is only safe when your consumer also refuses.

---

## 2. What the measuring actually found (the real work)

### F-A. 16x over-bill on 61 live products — CONFIRMED, was live-loaded, now fixed on the branch
`unitSizeInForm` sized units off `LIQUID_TO_GALLONS`/`DRY_TO_POUNDS`, which mirror `convert_to_gl_lb`
— a **display** function whose dry branch has no `dry oz`. `field_app_priced_quantity`, the function the
server actually **prices** with, does have it. So `Dry oz` was treated as unconvertible and fell into
the unreconciled branch: quantity counted in ounces, priced per pound.

**61 live products** carry `rate_unit='Dry oz'` against pound stock with `product_form='dry'`.
32 Dry oz/ac over 100 acres at $1.50/lb billed **$4,800** against a true **$300**, and `complete_job`
deducted 3,200 lb instead of 200. No wrong invoice exists yet — the four live `job_chemicals` rows are
all liquid test products.

### F-B. Per-unit price rounding, up to ±10.7% — CONFIRMED, pre-existing
Converting the per-unit price into the rate's smaller unit and rounding to whole cents amplifies by
every unit sold. **466** live products are `oz`-rate against `Gal` stock. Worst live case **+10.66%**
("Liquid AMS 34% - Bulk", $3.47/gal → 2.7109¢/oz stored as 3¢), and **−10.18%** the other way.
Cheap bulk products round hardest. An earlier revision of our docs said "+0.57%" — that was one
$28.00/gal product and is corrected.

### F-C. Prices quoted per the wrong unit — CONFIRMED
`_save_field_app_invoice_impl_20260714` states it outright: *"v_unit_price is per the product's SOLD
unit (inventory_unit)"*. Both client callers passed `unit_size`. The two disagree on **9** live products
and `unit_size` is blank on **8**.

### F-D. Client kept a partial fourth copy of `normalize_rate_unit` — CONFIRMED
`src/lib/labelGuardrails.ts` already contained a complete, correct mirror (same denominator rule, full
synonym table). `baseUnitOfRate` had its own partial copy that folded nothing, so `ounces/ac` missed the
size tables the server reaches after folding to `oz`.

---

## 3. The redesign, and the case for it

To fix F-B the line must be expressed in the product's **selling unit** with its price exactly as
quoted, and the **quantity** carried into that unit — instead of converting the price into the rate's
smaller unit. This is the direction the server already works in.

**The strongest argument was found by a reviewer, not by us, and belongs on the record:**
`create_job_from_quote_section` has **always** written the new model —
`unit = COALESCE(qi.price_unit, p.unit_size)`, `quantity = qi.total_units_needed` (already in the
selling unit). The quote→job path and the JobDetail path were writing **opposite conventions into the
same table**. The redesign makes JobDetail agree with the path that was already there.

Second argument: under the new model `field_app_priced_quantity(jc.quantity,
normalize_rate_unit(jc.unit), p.inventory_unit, …)` short-circuits to identity, so inventory movement
stops depending on a conversion that silently falls back to the raw quantity when a unit is unknown
(`complete_job`'s hard `JOB_INV_UNIT_UNCONVERTIBLE` raise was removed under U11).

**Two independent reviewers agreed the direction is right.** The problem is not the model.

---

## 4. What is still WRONG on the branch (why we are not landing)

Four adversarial rounds; each found real defects, three of them in code already declared proven. All
five below were reproduced by executing the shipped modules.

| # | Defect | Effect |
|---|---|---|
| 1 | Re-pick the product on a row that has a quantity (`JobDetail.tsx:2908-2926`). `reconcile` rewrites `unit` + price; `recomputeChemRowForAcres` is a **no-op without `driver==='rate'`**, and `driver` is never persisted, so every reloaded row qualifies. | 240 pt @281¢ → 240 **Gal** @2250¢ = **$5,400** vs $675. Silent. |
| 2 | Blend-recipe save→load (`recipeHelpers.ts:100,117,131`). `blend_recipe_items` has no `rate_unit` column; the seed sets `rate_unit = unit` **and** `driver:'rate'`, so recompute discards the correct saved quantity. | 18.75 Gal → **150 Gal** in the tank; bills $3,375 vs $421.88. Silent. |
| 3 | Blank-unit line (`chemCalculator.ts:113,122-123`). The function is never told the selling unit, so only one of the dropdown's choices is right. On live row `437dee81`: picking "Pt" (the natural choice) → **$2,785.78** vs $348.22; "Oz" → $44,572.48. And the warning that told the user to set a unit **disappears** once they do. |
| 4 | Unit-dropdown round trip (`chemCalculator.ts:122-123`) writes a **rounded** price back permanently — reintroducing F-B on the same two products we cite as proof it was fixed (+10.66% / −17.95%). Our claim "nothing rounds here now" is false as written. |
| 5 | **Render-path crash.** `rate_unit` of `constructor` or `__proto__` makes `normalizeRateUnit` return an `Object.prototype` member, so `folded.includes` throws inside `chemLineUnitMismatch`, which runs in JSX for every chem row → white-screen. NEW: introduced by the `normalizeRateUnit` import. Reachable — the CSV product import writes `products.rate_unit` unvalidated. |

**Common cause:** every pure function is individually correct. All five are emergent from how they are
composed inside `updateChemRow`, which has **no test file at all**. `driver` is UI-only, unpersisted,
and now silently gates money.

---

## 5. The plan we are proposing

1. **Do not land `85e1acef`.** Park the branch.
2. **Build the missing harness first:** a JobDetail-level invariant test asserting *the line total
   (`quantity × price_per_unit_cents`) cannot change unless the user edited a price or cost field*,
   run across every `(key, value)` the grid can dispatch. Both reviewers independently proposed this;
   it catches defects 1-4 at once.
3. Fix defects 1-5 against that harness. Give `chemLineUnitMismatch` the row's **quantity provenance**,
   not just two unit strings, so "convertible but not converted" stops being silent.
4. Re-review, then land.

**Why parking is defensible:** live exposure of what we are fixing is ~zero — `job_chemicals` holds
**4 rows, two of them test products**, and `blend_recipe_items` is **empty**; the business runs through
orders (288 `order_items`) and quotes. The defects we would introduce are on ordinary actions and would
hit every pre-deploy row. Benefit is latent; risk is active. There is no clock on this.

---

## 6. What we want challenged

1. **Is parking right, or is that over-caution?** The 16x defect is loaded on 61 products and fires the
   first time someone builds a job with one of them.
2. **Is the redesign actually the right model**, or should we instead make the whole app adopt the
   *old* JobDetail convention and change `create_job_from_quote_section` to match?
3. **Is the invariant in step 2 the right one**, or is there a cheaper/stronger check?
4. **Is "no data migration needed" sound?** It holds because a legacy row has `unit == rate base` →
   factor 1. It is also nearly vacuous given only 4 live rows — and defect 1 shows a legacy row is inert
   only until someone edits it.
5. **Have we mis-measured anything?** Especially the 61 / 466 / 9 / 8 counts, the ±10.66% / −17.95%
   figures, and the claim that no live value carries a non-acre denominator.
6. **Is there a sixth defect** in the same composition layer that four rounds have not surfaced?

---

## 7. Ground rules for the review

Read-only. Do not push, merge, apply a migration, or mutate live data. Live DB access is read-only and
a guard rejects SQL whose CTE/alias resembles a function call — use plain `UNION ALL` selects. Report
every finding at any severity; do not filter to high-severity only. Verify from source and live
evidence rather than from this document — **this document is the thing under review.**
