# Codex adversarial verdict — chem-line unit/money findings and plan

**Date:** 2026-08-19
**Reviewer:** OpenAI Codex CLI 0.148.0-alpha.15, model **`gpt-5.6-sol`**, `model_reasoning_effort="high"`,
`--sandbox read-only`, `approval_policy=never`. The gate **genuinely ran** at the pinned model and effort.
**Subject:** `docs/audits/2026-08-19-chem-unit-findings-and-plan.md` (the findings AND the plan), plus
`git diff origin/main` on branch `claude/zealous-agnesi-aa7423`.
**Instruction given:** REFUTE, not confirm; report every finding at any severity; do not be conservative.

**Headline: Codex says PARK — agreeing with our recommendation, but for a stronger reason and with a
correction.** It confirms all five known defects, finds a **sixth BLOCKER**, and rejects two of our
supporting claims (`no data migration needed`, and the proposed invariant catching defects 1-4).
It also says our "there is no clock" framing is **wrong**: parking the branch must not mean parking the
live Dry-oz hazard.

**One material limitation, since closed:** Codex ran with `approval_policy=never`, so its Supabase query
path was blocked and it could **not** verify any live count (its section 5 says BLOCKED, not refuted).
Those numbers were verified independently in the same session against project `rhyzpcqhnizqbxphqdkr`
read-only — see **Appendix A**, which resolves Codex finding **F25** and adds two corrections of its own.

---

## VERDICT

**PARK.**
All five listed defects are real; defect 5 is broader than documented but is prototype-chain type confusion, not actual prototype pollution.
I found a sixth **BLOCKER**: after reload, `driver` is lost, so acreage changes leave rate-derived quantity and billing stale.
The quantity-side model is correct, but this implementation violates the exact-money rule and does not unify every writer.
The live 61/466/9/8 counts and denominator claim are **UNVERIFIED**: Supabase access required approval, while this review’s policy was `never`.
Parking must not mean waiting: if the 61-product claim is accurate, the production defect remains urgent.
**Most important next step:** leave this rewrite parked and add a narrow fail-closed production guard for the Dry-oz/Lb hazard before continuing the redesign.

## Q1. PARKING versus the live 16× defect

**Verdict: PARK this branch, but do not park the production risk.**

Landing is unsafe because the branch contains multiple silent billing corruptions, a reload/acreage blocker, a recipe corruption, and a render crash. Using it as an emergency fix would replace one known 16× defect with several reachable defects.

The packet’s “there is no clock” conclusion is wrong. If 61 active products really carry this combination, the defect is latent only until the first relevant job is created. That is an urgent reason for a small fail-closed guard or isolated hotfix—not a reason to land this broad rewrite.

The defensible sequence is:

1. Keep this branch parked.
2. Prevent the current Dry-oz/Lb path from silently reaching invoicing or completion.
3. Repair the redesign behind an exact state-transition harness.
4. Land only after all writers and existing-row transitions share one convention.

## Q2. Quantity-side versus price-side

**Losing-side argument first:** changing `create_job_from_quote_section` and JobDetail to the old price-side convention would give `job_chemicals` one apparent representation: quantity remains in the agronomic rate unit, and price is converted into that unit. It would reduce the immediate frontend surface and preserve familiar displays such as `240 pt` rather than `30 Gal`. If prices supported exact rational or fractional cents, this could be a valid model.

**Why it loses here:** prices are stored as whole cents. A quoted $3.47/Gal price is `347/128 = 2.7109375¢/oz`; it cannot be represented exactly. Rounding to 3¢ creates +10.66%. Likewise, $0.39/Lb becomes 2.4375¢/oz and rounds to 2¢, creating −17.95%. Changing SQL to reproduce that convention would knowingly violate `AGENTS.md:70-77` and `SAFE_DEVELOPMENT_RULES.md:191-197`.

**Conclusion: quantity-side is the right model.** Store quantity in the selling unit and retain the exact quoted cents per selling unit. But the packet overstates existing server alignment:

- Repository SQL writes `quantity = total_units_needed` but uses `COALESCE(price_unit, p.unit_size)`, not `inventory_unit` (`20260707060000_u8_application_channel_commissions.sql:278-292`).
- Bulk quote import computes `total_units_needed` in `inventory_unit`, then submits both `price_unit` and `unit_size` as null (`BulkQuoteImport.tsx:571-630`).
- Therefore imported quote-to-job rows can receive a quantity measured in `inventory_unit` but a unit label taken from `products.unit_size`. That is exactly the discrepancy the packet says exists on 9/8 products.

The model is right; the claim that every server writer already follows it is false.

## Q3. Proposed invariant

**Verdict: useful supplementary check, but neither sufficient nor universally valid.**

It should use the exact server-equivalent rounded-cent result—not raw JavaScript `quantity * price`—and should separately check extended sale price and extended cost.

Would it catch defects 1–4?

- **Defect 1:** generally yes. Product re-pick changes quantity/price pairing without an explicit money-field edit.
- **Defect 2:** no, not in an `updateChemRow`-only matrix. Recipe seeding and the subsequent JobDetail acreage recomputation happen outside that reducer.
- **Defect 3:** no. Selecting `Pt` from the blank-unit row produces factor 1, so the incorrect $2,785.78 total remains unchanged while the warning disappears. The invariant passes. Selecting `Gal` correctly repairs the total from $2,785.78 to $348.22, which the proposed invariant could incorrectly reject.
- **Defect 4:** sometimes. `30 Gal × 2250¢ → 240 pt × 281¢` changes $675.00 to $674.40 and would fail. The opposite direction starting from the already-rounded 281¢/pt preserves $674.40 and passes without recovering the true quote.

A cheaper check is to extract `updateChemRow` into a pure reducer and table-test operations without mounting the full page.

A stronger check is a state-machine/property suite with operation-specific invariants:

- Canonical physical quantity remains unchanged on unit-only conversion.
- Price and cost remain paired with the row’s selling unit.
- Rate-driven rows satisfy `quantity = rate × acres × exact conversion`.
- Quantity-driven rows hold physical quantity and back-solve rate.
- Invalid, blank, non-finite, cross-form, and non-acre units fail closed.
- Save→reload, recipe, crop-program, quote, and acreage transitions are covered.
- Arithmetic uses exact decimal/rational conversion and server-equivalent cent rounding.

A defect the proposed total invariant misses: double quantity and halve price. The customer total is unchanged, but inventory deduction and chemical application are doubled. It also misses the stale `rate_unit` defects below.

## Q4. “No data migration needed”

**Verdict: UNSOUND as a categorical rollout claim.**

Deployment alone does not mutate existing rows. The danger appears when they are subsequently used.

For a pre-existing `job_chemicals` row:

- Reload omits `driver` (`JobDetail.tsx:1638-1656`).
- An acreage or field change calls recomputation, but a no-driver row is returned unchanged (`JobDetail.tsx:2700-2704`; `chemCalculator.ts:196-213`). A rate-derived line therefore becomes stale.
- Editing rate or quantity establishes a new driver and begins using the new conversion rules.
- Re-picking the product can replace unit and price without converting the old quantity.
- Changing the unit permanently rounds the price.
- Existing rounded prices remain rounded; the branch contains no backfill. `KNOWN_ISSUES.md:382-385` itself records this.
- Old- and new-convention rows split mixing reports by unit (`KNOWN_ISSUES.md:374-381`).

For a pre-existing `blend_recipe_items` row:

- The database row remains unchanged.
- Loading it guesses `rate_unit = unit` and marks it rate-driven (`recipeHelpers.ts:89-117`).
- JobDetail immediately recomputes from that guessed unit (`JobDetail.tsx:2549-2580`), potentially discarding the stored quantity.
- A later job save persists the corrupted job row.
- The missing rate-unit provenance cannot be repaired robustly without adding a stored field, representation version, or explicit user reconciliation. The branch’s own `KNOWN_ISSUES.md:368-373` says a migration is the real fix.

A full historical rewrite might ultimately be unnecessary, but some durable representation/provenance mechanism and a classified treatment of existing rows are required. The current “factor 1 means no migration” proof does not establish safety.

## Q5. Measured numbers and worked examples

**Live verification verdict: BLOCKED, not accepted or rejected.**

The Supabase query path required approval, but approval policy was `never`; therefore I could not independently verify:

- 61 Dry-oz/Lb products
- 466 oz/Gal products
- 9 `inventory_unit != unit_size`
- 8 blank `unit_size`
- 574 rate-bearing products
- Four `job_chemicals` rows
- No non-acre denominator in live data

Internal audit findings:

- The packet says **466** oz/Gal products, while the changed `docs/CHANGELOG.md:18` says **463**. No predicate difference is documented, so one count is stale or uses a different filter.
- The count claims are not reproducible from the packet because it lists tables but not the exact SQL predicates, active/deleted filters, normalization, or timestamp.
- `+10.66%` is correct: `(3 − 347/128) / (347/128) = +10.6628%`.
- `−17.95%` is correct: `(2 − 39/16) / (39/16) = −17.9487%`.
- `−10.18%` cannot be independently re-derived because the underlying live product price is not supplied and live access was blocked.

Worked examples:

- **$4,800 versus $300:** `32 oz/ac × 100 ac = 3,200 oz`. Wrong: `3,200 × $1.50 = $4,800`. Correct: `3,200/16 = 200 lb`; `200 × $1.50 = $300`. Reproduces.
- **$5,600 versus $44:** `2 oz/ac × 100 ac = 200 oz`. No conversion: `200 × $28/Gal = $5,600`. Correct quantity-side result: `200/128 × $28 = $43.75`, not exactly $44. The old rounded price-side result is `200 × 22¢ = $44`. The packet rounds $43.75 to a whole-dollar label.
- **$5,400 versus $675:** `240 × $22.50 = $5,400`; `240 pt / 8 = 30 Gal`; `30 × $22.50 = $675`. Reproduces.
- **$3,375 versus $421.88:** recipe reload produces `1.5 × 100 = 150 Gal`; `150 × $22.50 = $3,375`. Stored quantity: `18.75 × $22.50 = $421.875`, rounded by server cents to $421.88. Reproduces.
- **$2,785.78 versus $348.22:** `73.31 × $38 = $2,785.78`; `73.31 pt / 8 = 9.16375 Gal`; `9.16375 × $38 = $348.2225`, rounded to $348.22. Reproduces.
- **$44,572.48:** `73.31 pt × 16 = 1,172.96 oz`; `1,172.96 × $38 = $44,572.48`. Reproduces.

## Q6. Sixth defect and composition-layer hunt

**Verdict: yes—there is at least one sixth BLOCKER, plus several additional defects.**

The clearest sixth defect is lost driver provenance:

1. A newly rate-driven row saves correctly.
2. Reload drops `driver`.
3. Changing acreage calls `recomputeChemRowForAcres`.
4. That function refuses to touch a no-driver row.
5. Example: a saved `1.5 pt/ac` line over 100 acres remains at its old quantity after acreage becomes 200. Billing and application quantity should double but do not.

Other defects found:

- A quantity-driven row changing `rate_unit` does not back-solve its rate. For `30 Gal` over 160 acres, changing `pt/ac` to `oz/ac` leaves `1.5 oz/ac`; the quantity actually represents `24 oz/ac` (`JobDetail.tsx:2950-2958`).
- Non-acre denominators are visibly warned but still calculated as `rate × acres` and may save. `oz/cwt` is deliberately collapsed to `oz` (`chemCalculator.ts:416-430`); the warning is render-only.
- Product replacement retains the prior chemical’s nonblank rate and rate unit (`JobDetail.tsx:2891-2896`). Depending on driver state, it then preserves either the old numeric quantity or the old rate. A cross-product replacement can therefore carry the old chemical’s dose into the new product.
- `rowQuantityFactor` omits the available product form (`chemCalculator.ts:70-71`). A grandfathered liquid line with a dry-only unit pair can silently take the dry conversion before the separate warning renders.
- Empty/invalid quantities become zero on save; infinity is not rejected consistently (`jobChemicalPayload.ts:17-37`). There is no chemical numeric validation in `handleSave` (`JobDetail.tsx:1900-2013`).
- Authoritative totals use binary floating point (`JobDetail.tsx:1752-1753`), and `fmtQty` deliberately rounds a bill-determining quantity using binary floats (`chemCalculator.ts:143`). This contradicts the project’s exact-money rule.
- Customer-supplied lines skip unit and denominator warnings even though the applicator still uses their application instructions (`JobDetail.tsx:3738-3749`).
- Recipe cost is always loaded from the product’s current selling-unit cost, even when the recipe item’s stored unit is a different legacy unit (`recipeHelpers.ts:78-101`). That can corrupt job cost/margin while price remains recipe-specific.
- Blank recipe units are silently persisted as `gal` (`recipeHelpers.ts:126-136`).
- I found no copy/undo/re-render path that incrementally applies the same conversion twice. Recompute is derived from the rate rather than the previous converted quantity. Recipe composition is wrong for a different reason: lost `rate_unit`.

Five-defect confirmation:

- **Defect 1: REAL**, with one overstatement: every reloaded row lacks `driver`, but only rows whose quantity representation conflicts with the replacement selling unit corrupt this way.
- **Defect 2: REAL.**
- **Defect 3: REAL.**
- **Defect 4: REAL.**
- **Defect 5: REAL and broader.** `constructor`, `__proto__`, `toString`, `valueOf`, `hasOwnProperty`, and other inherited names can return non-string prototype members. Calling `.includes` then crashes. This is unsafe prototype-chain lookup/type confusion, not mutation of a prototype.

## All findings

| ID | Severity (BLOCKER/HIGH/MED/LOW/NIT) | Confidence (HIGH/MED/LOW) | file:line | Finding | Why it is real (or why I could not verify) |
|---|---|---|---|---|---|
| F01 | BLOCKER | HIGH | `src/pages/JobDetail.tsx:2879-2926` | Listed defect 1: product re-pick can relabel legacy quantity with a selling unit and exact selling price without converting quantity. | Reloaded rows have no `driver`; recompute returns them unchanged. `240 pt` can become `240 Gal × 2250¢`. |
| F02 | BLOCKER | HIGH | `src/lib/recipeHelpers.ts:89-117`; `src/pages/JobDetail.tsx:2549-2580` | Listed defect 2: recipe load discards the correct saved quantity. | The recipe lacks `rate_unit`; seed guesses `rate_unit = unit`, sets `driver:'rate'`, then JobDetail recomputes. |
| F03 | BLOCKER | HIGH | `src/lib/chemCalculator.ts:100-124`; `src/pages/JobDetail.tsx:2933-2948` | Listed defect 3: blank-unit choices can preserve or massively inflate an invalid bill and clear the warning. | `Pt` gives factor 1 and keeps $2,785.78; `Oz` multiplies quantity by 16 while retaining the Gal price. |
| F04 | BLOCKER | HIGH | `src/lib/chemCalculator.ts:122-123` | Listed defect 4: unit changes permanently round whole-cent prices. | `2250/8 → 281¢`, changing $675.00 to $674.40; $0.39/Lb becomes 2¢/oz. |
| F05 | HIGH | HIGH | `src/lib/labelGuardrails.ts:38-70`; `src/lib/chemCalculator.ts:422-430` | Listed defect 5: inherited object keys can crash rendering. | `SYNONYMS[base]` is not an own-property lookup; unsafe names return functions/objects and `.includes` fails. |
| F06 | BLOCKER | HIGH | `src/pages/JobDetail.tsx:1638-1656,2699-2704`; `src/lib/chemCalculator.ts:196-213` | Sixth defect: reloaded rate-driven rows do not follow acreage changes. | `driver` is not persisted; no-driver recomputation is a no-op. Billing and application quantity become stale. |
| F07 | HIGH | HIGH | `src/pages/JobDetail.tsx:2950-2958` | Quantity-driven `rate_unit` edits leave a stale rate. | Only rate-driven rows recompute on `rate_unit`; `applyChemEdit` ignores that key. |
| F08 | HIGH | MED | `src/pages/JobDetail.tsx:2891-2926` | Cross-product replacement retains the previous product’s rate/rate unit. | Autofill only fills blank rate fields. Existing dose semantics carry into the newly selected chemical. |
| F09 | HIGH | HIGH | `src/lib/chemCalculator.ts:416-430,532-548`; `src/pages/JobDetail.tsx:3748` | Non-acre denominators warn but still calculate and save as if per-acre. | `baseUnitOfRate` strips to the numerator, and the mismatch is render-only; save has no corresponding block. |
| F10 | BLOCKER | HIGH | `src/components/quotes/BulkQuoteImport.tsx:571-630`; `supabase/migrations/20260707060000_u8_application_channel_commissions.sql:278-292` | Imported quote→job path can write inventory-unit quantity under a `unit_size` label. | Import computes quantity using `inventory_unit` but sends null `price_unit`; SQL falls back to `p.unit_size`. |
| F11 | BLOCKER | HIGH | `src/pages/JobDetail.tsx:1752-1753`; `src/lib/chemCalculator.ts:115-143`; `AGENTS.md:70-77` | The redesigned money path still uses binary floating-point arithmetic. | Job totals and bill-determining quantity conversion use `parseFloat`/`Math.round`, contrary to the hard exact-money rule. |
| F12 | MED | HIGH | `src/lib/jobChemicalPayload.ts:17-37`; `src/pages/JobDetail.tsx:1900-2013` | Blank/invalid quantity and money text silently becomes zero; infinity is not consistently rejected. | Payload uses `parseFloat(...) || 0` and `parseInt(...) || 0`; chemical values have no finite validation before save. |
| F13 | MED | HIGH | `src/lib/chemCalculator.ts:70-71`; `src/pages/JobDetail.tsx:2958` | Recompute omits known product form. | `rowQuantityFactor` always tries both forms, permitting a legacy cross-form pair to use a conversion the selected product cannot use. |
| F14 | HIGH | HIGH | `src/pages/JobDetail.tsx:3738-3749` | Customer-supplied lines suppress unit/denominator warnings despite being application instructions. | They bill/deduct zero, but their dose still reaches the applicator workflow. |
| F15 | MED | MED | `src/lib/recipeHelpers.ts:78-101` | Recipe load can pair a legacy recipe unit with product cost quoted per another unit. | `item.unit` wins, while `current_cost` is copied without conversion from the product selling unit. |
| F16 | MED | HIGH | `src/lib/recipeHelpers.ts:126-136` | A blank recipe unit is silently changed to `gal`. | `unit: row.unit || 'gal'` invents semantics not present in the source row. |
| F17 | HIGH | HIGH | `docs/manual/KNOWN_ISSUES.md:350-385`; branch contains no migration | “No data migration needed” overstates safety. | Stored rounded prices remain, mixed representations fragment reports, and recipe provenance is absent. |
| F18 | HIGH | HIGH | `docs/audits/2026-08-19-chem-unit-findings-and-plan.md:115-119` | Proposed total invariant does not catch all four claimed defects. | Defect 2 is outside `updateChemRow`; defect 3 can preserve the wrong total while clearing the warning. |
| F19 | MED | HIGH | `src/lib/recipeHelpers.test.ts:167-198` | Recipe “round-trip” test does not test the shipped composition path. | It stops at helper output and omits JobDetail’s acreage recomputation—the operation that corrupts quantity. |
| F20 | MED | HIGH | `src/lib/chemCalculator.test.ts:468-473` | “No migration needed” test is not representative of a reload. | It constructs `driver:'rate'`; actual loaded rows omit `driver`. |
| F21 | MED | HIGH | `src/lib/chemCalculator.test.ts:490-501` | “Preserving line total” test encodes a loss. | Gal→pt begins at $675.00 and asserts the rounded $674.40 result. |
| F22 | LOW | HIGH | `src/lib/chemCalculator.test.ts:504-513` | Blank-unit money assertion is too loose. | `toBeCloseTo(..., 1)` checks approximate dollars rather than exact server cents. |
| F23 | MED | HIGH | `src/lib/chemCalculator.test.ts:426-431` | Prototype regression test misses the actual crash path. | It calls reconciliation and checks only NaN; it never calls `baseUnitOfRate`/render with an unsafe rate unit. |
| F24 | LOW | HIGH | `src/pages/JobDetail.tsx:248-253`; `src/lib/chemCalculator.ts:191-213` | Inline driver documentation contradicts implementation. | Comment says an undefined/reloaded line follows its rate; implementation leaves it untouched. |
| F25 | MED | HIGH | `docs/audits/2026-08-19-chem-unit-findings-and-plan.md:42-65`; `docs/CHANGELOG.md:18` | Live counts are unverified and 466 conflicts with 463. | Supabase access was blocked; the two changed documents give different oz/Gal counts without different predicates. |
| F26 | LOW | HIGH | `docs/audits/2026-08-19-chem-unit-findings-and-plan.md:30-33`; `src/lib/chemCalculator.test.ts:396-401` | `$44` does not reproduce as the exact quantity-side amount. | Exact result is $43.75; $44 is the old rounded-price result or whole-dollar shorthand. |
| F27 | LOW | HIGH | repository state | Packet/target branch snapshot is stale. | HEAD is `2addb1d4`, but local `origin/main...HEAD` is 4 behind/10 ahead, not 0/9. `git diff origin/main` also lists hook files; merge-base branch-owned diff does not. |
| F28 | LOW | HIGH | `docs/audits/2026-08-19-chem-unit-findings-and-plan.md:100,123-126` | Packet both overstates and understates exposure. | “Every reloaded row” is too broad for defect 1; “no clock” and “~zero exposure” understate the claimed 61-product trigger. |
| F29 | LOW | HIGH | `docs/audits/2026-08-19-chem-unit-findings-and-plan.md:66-71`; `src/lib/labelGuardrails.ts:38-70` | `normalizeRateUnit` is not a “complete, correct” mirror. | Its synonym lookup accepts inherited prototype keys and violates its string return contract. |
| F30 | NIT | HIGH | `src/pages/JobDetail.tsx:2896-2904`; `src/lib/cropProgramHelpers.ts:83-85` | Comments and dead helper remain stale. | JobDetail comment still says reconciliation returns the rate-base unit; `normalizeProgramRateUnit` has no caller. |
| F31 | LOW | MED | `src/lib/chemCalculator.ts:132-143`; `src/lib/chemCalculator.test.ts:475-486` | Claimed six-decimal worst-case money bound is not demonstrated over the allowed input domain. | One example proves less than half a cent; no maximum price/rate/acreage domain or exhaustive bound is established. |
| F32 | LOW | HIGH | `docs/audits/2026-08-19-chem-unit-findings-and-plan.md:18-24` | “No live non-acre denominator” could not be checked and its method is under-specified. | The packet gives no executable SQL or filtering rules, and live access was blocked. |
| F33 | LOW | HIGH | `docs/audits/2026-08-19-chem-unit-findings-and-plan.md:106` | “Prototype-pollution crash vector” overstates the mechanism. | No prototype is mutated; the defect is inherited-property lookup returning a non-string, causing type confusion/DoS. |

**Bottom line: PARK.** The first action should be an isolated fail-closed protection against the currently claimed Dry-oz/Lb production hazard. Then repair this redesign around a pure reducer, persisted representation/provenance, exact arithmetic, and cross-writer state-machine tests.

CODEX_REVIEW_COMPLETE


---

# Appendix A — independent live-database verification (closes Codex Q5 / F25)

Codex could not query the live database. These queries were run in the same session against project
`rhyzpcqhnizqbxphqdkr`, **read-only, plain `UNION ALL` selects only** (no CTEs, no function-shaped
aliases), on 2026-08-19.

## A.1 Packet counts — verdict per claim

| Packet claim | Measured | Verdict |
|---|---|---|
| **574** products carry a rate unit | 574 | **CONFIRMED** |
| **3** stored values contain `/`, all `pt/ac` | 3 (`invoice_items.rate_unit`, `job_chemicals.rate_unit`, `invoice_items.total_applied_unit`) — all `pt/ac` | **CONFIRMED** |
| No live value carries a **non-acre denominator** | Swept 33 unit-bearing text columns across the whole public schema; every `/`-bearing value is `pt/ac` | **CONFIRMED** |
| **61** `Dry oz` rate against pound stock | 61 (`rate_unit='Dry oz'` AND `inventory_unit` in lb/lbs/pound/pounds) | **CONFIRMED — but see A.2** |
| **466** `oz`-rate against `Gal` stock | 466 (464 if restricted to active) | **CONFIRMED** |
| **8** products with blank `unit_size` | 8 | **CONFIRMED** |
| **9** products where `unit_size` and `inventory_unit` disagree | 9 — **but 8 of the 9 ARE the blank-`unit_size` rows** | **MISLEADING — see A.3** |
| `job_chemicals` = 4 rows, `blend_recipe_items` = 0, `order_items` = 288 | 4 / 0 / 288 | **CONFIRMED** |
| F-B worst case **+10.66%** ("Liquid AMS 34% - Bulk", $3.47/gal) | +10.66% exactly, on that exact product | **CONFIRMED** |
| F-B **-10.18%** the other way | -10.18% exactly ("Diamond First Pass Soybean (100%) - Bulk", $5.70/gal → 4.4531¢/oz stored as 4¢) | **CONFIRMED** |
| Defect 4 **-17.95%** | Codex re-derived it algebraically: `(2 − 39/16) / (39/16) = −17.9487%` | **CONFIRMED (arithmetic)** |

## A.2 NEW — the packet **understates** Dry-oz exposure

`rate_unit = 'Dry oz'` is carried by **75** live products, not 61. The 61 figure is correct only for the
subset whose `inventory_unit` is a pound unit. The other **14** products carry `Dry oz` against a
*non-pound* stock unit and were never counted or characterised. They are not necessarily safe — they are
simply outside the predicate the packet chose. Any fail-closed guard should be scoped to all 75.

## A.3 NEW — the packet **overstates** the F-C `unit_size` disagreement

The packet reads as if two populations exist: "the two disagree on **9** live products and `unit_size` is
blank on **8**." In fact **8 of those 9 disagreements *are* the 8 blank rows** — blank ≠ `inventory_unit`
counts as a disagreement. Exactly **one** live product has both values populated and genuinely different.
F-C is real, but its non-blank footprint is 1 product, not 9.

## A.4 Resolving Codex F25 — the 466 vs 463 conflict

Codex flagged that the packet says **466** and the branch's `docs/CHANGELOG.md:18` says **463**, with no
documented predicate difference. Measured live:

- plain `oz` rate / `Gal` stock, case-insensitive: **466**
- same, restricted to active products: **464**
- widened to the `oz` synonym family / `gal` family: **466**

No predicate reproduces **463**. **466 is the correct figure; the CHANGELOG's 463 is wrong** and should be
corrected when the branch is next touched.

## A.5 Confirming Codex F27 — the packet's branch header is stale

`git rev-list --left-right --count origin/main...HEAD` in the worktree returns **4 behind / 10 ahead**.
The packet header states "0 behind / 9 ahead" and pins `85e1acef`; HEAD is now `2addb1d4`. Any re-review
must re-establish the diff against a fetched `origin/main`, not trust the header.

## A.6 Independent source confirmation of defect 5

`labelGuardrails.ts:70` is `return SYNONYMS[base] ?? base;` on a plain object literal. `SYNONYMS['constructor']`
returns the `Object` constructor — non-nullish, so `??` does not fire — and `chemCalculator.ts:424` then calls
`folded.includes('/')` on a function. Confirmed by reading source. Codex is right that this is **broader**
than documented (`toString`, `valueOf`, `hasOwnProperty` and every other inherited name reach it too) and
right that "prototype pollution" is the wrong name for it — nothing mutates a prototype; this is unsafe
inherited-property lookup causing type confusion.

## A.7 What remains unverified

- Codex finding **F10** (bulk quote import writing an `inventory_unit` quantity under a `unit_size` label)
  was not independently reproduced here. It is the highest-value item to check next, because if true it
  means a *third* writer disagrees with both conventions.
- The `-10.18%` figure was confirmed on `tier1_price` only; tier2/tier3 were not swept and could be worse.
- No behaviour was executed in a running app during this review. This was a read-only review gate.
