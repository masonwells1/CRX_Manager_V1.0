# Sol adversarial review — product data model build plan

**Date:** 2026-08-19
**Reviewer:** Codex `sol` (`gpt-5.6-sol`, reasoning effort `high`), read-only sandbox, independent session
**Subject:** the planning package, before any of it is built — build plan, orchestration design, master record, PRD, and the loop mission/ledger
**Requested by:** Mason, for a second opinion on the approach and logic before the build starts

**VERDICT: NOT SAFE AS WRITTEN** — 8 blockers, 22 high, 4 medium/low.

This reviews *documents*, not code. Nothing was built, changed, or applied. Sol was asked for every
finding at every severity with no cap, and told to try to break ten named load-bearing claims rather
than give a general opinion.

The single most likely silent-wrong-number path Sol identified: **EPA import attaching a salt-form
concentration to the canonical acid parent**, then calculating as though the number were already
acid equivalent — `5.4 lb IPA salt/gal` treated as `5.4 lb ae/gal` instead of
`5.4 × 0.741 = 4.0014`, so every gallon is believed to carry ~35% more acid than it does, and the
quote invoices too few gallons for the intended treatment.

Findings below are Sol's own text, unedited except that its `Location` links were machine-absolute
(`/C:/CRX_Manager/.claude/worktrees/…`) and have been made repository-relative so they resolve for
any reader. No finding text was changed. Disposition — agree/disagree per finding, and what
changes before the build — is Mason's call and is not recorded here yet.

---

VERDICT: NOT SAFE AS WRITTEN

## BLOCKER findings

### 1. The proposal queue cannot hold the planned data

**Location:** [BUILD PLAN §0 D-I, WP-3, WP-4](docs/plans/2026-08-19-product-data-model-BUILD-PLAN.md:56); existing [product_label_drafts migration](supabase/migrations/20260629210000_product_label_drafts.sql:16)  
**Severity:** BLOCKER — **Confidence: High**

The existing queue has fixed columns and fixed `create_label_draft`/`commit_label_draft` arguments for signal word, REI, PHI, EPA number, and label rate. It has nowhere to store ingredient rows, specific-form IDs, concentration basis/fraction, brand proposals, label URL/date, cancellation state, or a typed-value-versus-EPA conflict. Nevertheless, WP-4 says “no migration.”

**Trigger:** EPA returns 5.4 lb glyphosate IPA salt/gal plus cancellation metadata → the queue cannot represent that payload → the builder either discards fields or bypasses review and writes directly → incomplete or unreviewed chemistry becomes authoritative.

**Smallest fix:** Add an owned prerequisite migration extending the queue/RPC contract with a typed, versioned payload and purpose, then prove every planned field survives propose → review → commit. WP-4 cannot remain “no migration.”

### 2. WP-2 depends on a table WP-3 has not created

**Location:** [BUILD PLAN WP-2 density precedence](docs/plans/2026-08-19-product-data-model-BUILD-PLAN.md:231), [WP-3 product_brands](docs/plans/2026-08-19-product-data-model-BUILD-PLAN.md:251)  
**Severity:** BLOCKER — **Confidence: High**

WP-2’s density-precedence function supposedly includes a brand slot, but `product_brands` arrives in WP-3.

**Trigger:** WP-2 SQL references `product_brands` → migration fails because the relation does not exist. If the builder stubs out the brand lookup instead, WP-3 has no explicit obligation to replace and re-prove the function → product density silently wins over brand density.

**Smallest fix:** Either create the minimal brand-density relation in WP-2 or move the complete precedence function to WP-3. Name the replacement migration and repeat the density proof after WP-3.

### 3. WP-3 is not additive, so apply-before-merge is unsafe

**Location:** [BUILD PLAN WP-3](docs/plans/2026-08-19-product-data-model-BUILD-PLAN.md:251), [ORCHESTRATION apply-before-merge rationale](docs/plans/2026-08-19-product-data-model-ORCHESTRATION.md:72)  
**Severity:** BLOCKER — **Confidence: High**

The plan explicitly calls for a `receive_po_items` signature change. Current production callers supply four named arguments in [QuickReceivePanel](src/components/receiving/QuickReceivePanel.tsx:325), [PurchaseOrderDetail](src/pages/PurchaseOrderDetail.tsx:291), and [offline replay](src/lib/offlineSync.ts:414). The current wrapper delegates to an internal serialized function in [the latest receiving migration](supabase/migrations/20260726190515_section9_po_ap_high_remediation.sql:157).

PostgreSQL cannot replace a function’s input signature in place. The migration must either drop the old signature or create an overload.

**Trigger:** Live migration applies before code merge → old application or queued offline action invokes the four-argument RPC → “function not found” or overload ambiguity → receiving fails, or the implementation bypasses the serialized path.

**Smallest fix:** Keep the existing four-argument signature and carry optional brand data inside `p_items`, with old/new caller and offline-replay proofs. Otherwise reverse the order: compatible code first, migration second, cleanup later.

### 4. The permission proof cannot prove the permission policy

**Location:** [BUILD PLAN permission protocol](docs/plans/2026-08-19-product-data-model-BUILD-PLAN.md:77), R-2/R-3, WP-1–WP-3  
**Severity:** BLOCKER — **Confidence: High**

The repository deliberately revokes table-level product writes and grants selected columns in [the pricing migration](supabase/migrations/20260718190000_supplier_pricing_phase1a_cutover.sql:354). The plan does not enumerate an expected `INSERT` and `UPDATE` result for every new `products` column.

Merely recording `has_column_privilege('authenticated', …)` is insufficient:

- It does not assert which columns must return true versus false.
- It does not assert that table-level `INSERT`/`UPDATE` remain false.
- An accidental table-level grant makes every column check pass.
- `authenticated` is the shared database role; it cannot distinguish an app-profile admin from a non-admin.
- Mason declined a separate non-admin user, while R-2 requires a named non-admin app session.

**Trigger:** A new directly edited column lacks its grant → the field renders but save fails. Conversely, an RPC-only chemistry column gets an accidental table grant → any authenticated user can bypass the intended admin RPC.

**Smallest fix:** Put a column-by-column expected privilege matrix in each migration package; assert table privileges remain false; run the real app using an existing named non-admin E2E identity and an admin identity; prove direct deny, RPC deny, RPC allow, and read-back.

### 5. EPA seeding contradicts the specific-form-only calculation rule

**Location:** [D-A](docs/plans/2026-08-19-product-data-model-BUILD-PLAN.md:48), [WP-4](docs/plans/2026-08-19-product-data-model-BUILD-PLAN.md:291)  
**Severity:** BLOCKER — **Confidence: High**

D-A correctly says concentrations attach to the specific chemical-form row. WP-4 instead says EPA ingredients are “mapped to canonical acids,” and its proof asks only whether they appear under the right canonical ingredient. That language directs the builder toward the parent row.

**Trigger:** A label states 5.4 lb glyphosate IPA salt/gal → importer attaches 5.4 to canonical glyphosate acid → comparison treats 100 gallons as 540 lb acid equivalent instead of `5.4 × 0.741 × 100 = 400.14 lb` → roughly 26 gallons fewer may be quoted to deliver the required acid amount.

**Smallest fix:** Rewrite WP-4 to require: resolve/create the specific form row, attach concentration there, use canonical ID only for discovery/grouping, and prove the stored foreign key is not the parent.

### 6. NULL fraction refusal is prose, not an enforced state

**Location:** [D-A](docs/plans/2026-08-19-product-data-model-BUILD-PLAN.md:48), WP-1 proof, Phase 3 comparison  
**Severity:** BLOCKER — **Confidence: High**

The database can store `canonical_fraction = NULL`, but the plan names no central conversion API, RPC, discriminated error result, SQL guard, or UI blocked state. No proof attempts the isomer case and confirms that no number is returned.

**Trigger:** Racemic metolachlor and S-metolachlor share a search parent with NULL conversion → a builder uses `fraction ?? 1`, `COALESCE(fraction, 1)`, or simply omits multiplication → products are compared 1:1 even though no valid numeric conversion exists.

**Smallest fix:** Define one mandatory conversion function whose return type is either a validated numeric result or a refusal reason. All comparison and scale consumers must use it. Add mutation tests proving NULL cannot become 1.0 or any displayed quantity.

### 7. Brand allocations have no quantity-conservation invariant

**Location:** BUILD PLAN WP-3 schema/proof  
**Severity:** BLOCKER — **Confidence: High**

The plan adds brand allocations to delivery and application records but specifies no database rule requiring allocations to equal the parent line quantity, use compatible units, remain positive/finite, or resist idempotent replay.

**Trigger:** Delivery line is 45 gal → allocations are 30 gal Brand A plus 10 gal Brand B → invoice/inventory says 45 gal while scale or regulatory paperwork says 40 gal. A replay could also duplicate both allocations.

**Smallest fix:** Make allocation writes an atomic RPC that locks the parent, converts to one unit, requires a positive finite sum exactly equal to the line quantity, and enforces an idempotency key. Include under-, over-, unit-mismatch, and replay negatives.

### 8. “Warn, never reject” has no hard numeric domain

**Location:** BUILD PLAN D-H, WP-1/WP-2 schemas and density proof  
**Severity:** BLOCKER — **Confidence: High**

The plan distinguishes plausible versus implausible densities only by warning. It does not separately require positive, finite density, concentration, canonical fraction, net weight, or allocation quantities.

**Trigger:** Density `-8`, `0`, `NaN`, or infinity is accepted as an outlier warning → 100 gal produces negative, zero, or non-numeric scale weight.

**Smallest fix:** Add hard database/RPC validation for finite positive values and valid fraction ranges. Apply soft warnings only after hard domain validation passes.

## HIGH findings

### 9. Applying the migration changes the reviewed branch afterward

**Location:** [ORCHESTRATION steps 10–14](docs/plans/2026-08-19-product-data-model-ORCHESTRATION.md:65)  
**Severity:** HIGH — **Confidence: High**

The PR and checks happen before apply. Applying then renames the migration file and regenerates the schema registry, creating tracked changes after CodeRabbit, Vercel, and commit review.

**Trigger:** PR is green for placeholder migration filename/schema → live apply assigns a new stamp and registry changes → merge either omits those changes or pushes a new unreviewed head.

**Smallest fix:** After apply, commit and push the rename/registry changes, then rerun exact-head review, CodeRabbit, required checks, and Vercel before merge.

### 10. The advertised exact-SHA proof is not exact-SHA

**Location:** BUILD PLAN §1; ORCHESTRATION step 9; [write-apply-proofs](scripts/write-apply-proofs.mjs:150)  
**Severity:** HIGH — **Confidence: High**

`write-apply-proofs.mjs` hashes the migration file, not the full Git commit. It does not review UI consumers, generated types, RPC call sites, or other files at the PR head.

**Trigger:** SQL remains unchanged but a later TypeScript edit adds `fraction ?? 1` → migration proof remains valid even though the exact commit now contains the wrong calculation.

**Smallest fix:** Keep the migration-content proof for apply, but separately require the repository’s exact-HEAD push proof after the final commit.

### 11. The proof expires before the plan reaches apply

**Location:** [ORCHESTRATION proof TTL and steps 9–13](docs/plans/2026-08-19-product-data-model-ORCHESTRATION.md:35)  
**Severity:** HIGH — **Confidence: High**

Proofs expire in 30 minutes, but the plan mints one before commit, PR creation, Vercel, CodeRabbit, and the human gate.

**Trigger:** Normal PR checks take more than 30 minutes → apply guard rejects the stale proof, or someone feels pressure to weaken/bypass the gate.

**Smallest fix:** Run an initial review earlier if desired, but mint the apply proof immediately after Mason’s approval and immediately before live apply.

### 12. WP-4’s acceptance mutates a real product and lacks a negative case

**Location:** [BUILD PLAN WP-4 proof](docs/plans/2026-08-19-product-data-model-BUILD-PLAN.md:312)  
**Severity:** HIGH — **Confidence: High**

The proof says to approve EPA data on a real product. It neither uses an `[E2E]` product nor requires a demonstrated revert. It proves only the happy path.

**Trigger:** A parser maps the wrong concentration to a real catalog product → the acceptance itself installs bad chemistry into production.

**Smallest fix:** Use an E2E clone with a real EPA number. Add negatives for typed-value conflict, lower-priority source, cancelled status, unknown chemical form, and malformed concentration.

### 13. “Void and clean” does not prove receiving was reversed

**Location:** [R-9](docs/plans/2026-08-19-product-data-model-BUILD-PLAN.md:121), WP-3 proof  
**Severity:** HIGH — **Confidence: High**

Voiding an E2E PO does not inherently reverse inventory movements created by `receive_po_items`.

**Trigger:** Receive 100 gal in the proof → mark the PO void → inventory remains 100 gal higher while the test row disappears from normal screens.

**Smallest fix:** Require the canonical receiving-reversal RPC and prove before/after inventory balance, inventory transaction count, receipt state, and brand allocations all return to zero.

### 14. Density source precedence is not write-enforced

**Location:** BUILD PLAN D-M, WP-2/WP-3  
**Severity:** HIGH — **Confidence: High**

A precedence function for reading does not prevent a lower-trust import from overwriting the one stored current density and source.

**Trigger:** Measured density is 10.2 lb/gal → later supplier feed writes 8.34 → 100-gallon scale ticket changes from 1,020 lb to 834 lb.

**Smallest fix:** Store source candidates/history and enforce source ranking in the commit RPC. A lower-ranked candidate must remain a proposal unless explicitly approved over the higher-ranked value.

### 15. The plan cannot identify which brand density belongs to a shipped load

**Location:** BUILD PLAN WP-3 receiving, delivery/application allocation, scale proof  
**Severity:** HIGH — **Confidence: High**

Receiving Brand A does not establish that a later pooled-inventory delivery used Brand A. The plan defines neither brand-level inventory balances nor a mandatory brand selection at delivery/application time.

**Trigger:** Inventory contains 100 gal Brand A at 8.3 lb/gal and 100 gal Brand B at 10.2 → product screen selects the last/first/default brand → a 100-gallon load is printed as 830 lb when the physical product is 1,020 lb.

**Smallest fix:** Require an explicit brand or receipt allocation on the delivery/application line before brand density can override product density. Never infer from the last receipt.

### 16. Typed and EPA concentrations lack a single-authoritative-value rule

**Location:** BUILD PLAN D-L, WP-1 and WP-4  
**Severity:** HIGH — **Confidence: High**

“Typed wins” is prose. The planned authoritative ingredient table has no described candidate/effective distinction or uniqueness rule preventing both values from participating in math.

**Trigger:** Owner typed 4.0 lb ae/gal; EPA returns 5.4 lb salt/gal → both rows become approved → comparison sums them or chooses nondeterministically.

**Smallest fix:** Store proposals separately from effective concentration rows and enforce exactly one effective concentration per product, specific ingredient form, and basis. Conflicts must remain non-authoritative until resolved.

### 17. Shared ingredient edits do not invalidate every affected product

**Location:** BUILD PLAN D-E and WP-1 concurrency  
**Severity:** HIGH — **Confidence: High**

`canonical_fraction` belongs to a shared ingredient row, but `product_data_version` is product-scoped. The plan does not say that editing the shared fraction bumps every linked product.

**Trigger:** Fraction changes from 0.741 to 0.713 while a workbook holds an earlier product version → workbook save succeeds because that product’s version did not change → old and new chemistry are mixed.

**Smallest fix:** Atomically bump/audit all linked products when a shared mathematical ingredient field changes, or include ingredient-version hashes in compare-and-set validation.

### 18. Copy-from-sibling has no safe eligibility or source-version rule

**Location:** [BUILD PLAN WP-5](docs/plans/2026-08-19-product-data-model-BUILD-PLAN.md:322)  
**Severity:** HIGH — **Confidence: Medium-high**

The plan says to copy ingredients, density, and brands from a packaging sibling but does not prevent copying across formulation, safener, quality tier, or manufacturer differences. It also protects only the target conceptually, not a changing source snapshot.

**Trigger:** Standard Gen Liberty is selected as sibling for Higher Quality bulk → ingredients and density copy successfully, but the premium surfactant/inert distinction is erased or misrepresented.

**Smallest fix:** Define database-enforced sibling eligibility and require expected versions for both source and target inside one transaction.

### 19. D-O is modeled at the wrong layer

**Location:** [D-O](docs/plans/2026-08-19-product-data-model-BUILD-PLAN.md:67), WP-3 `product_brands.sourcing_tier`  
**Severity:** HIGH — **Confidence: High**

D-O describes genuinely different sellable product specifications: different inert ingredients, surfactant load, performance, and cost. WP-3 puts `sourcing_tier` on a brand record and adds no product-level built-in-adjuvant or formulation-quality field.

**Trigger:** Comparison groups standard and premium rows because their actives match → displays them as quantity-equivalent and merely different brands/prices → owner is led to treat them as substitutes while the cheaper product needs added surfactant.

**Smallest fix:** Put quality tier and built-in-adjuvant/inert distinction on the sellable product specification, exclude cross-tier automatic substitution, and prove the exact Gen Liberty pair.

### 20. Multi-active generic matching requires an unrecorded algorithm decision

**Location:** BUILD PLAN Phase 3; PRD comparison requirements  
**Severity:** HIGH — **Confidence: Medium-high**

The plan does not define how a generic premix participates when it covers two or more target ingredients.

**Trigger:** Target requires A and B; one generic premix contains both → independent per-ingredient math selects or counts the same premix twice, or satisfies A while overdosing B → wrong total product quantity.

**Smallest fix:** For V1, restrict benchmark candidates to single-active products, or specify a constrained multi-ingredient solver with overdose/under-dose rules and premix regression cases.

### 21. The comparison rate source is not settled

**Location:** BUILD PLAN Phase 2/Phase 3; D-F  
**Severity:** HIGH — **Confidence: High**

The plan creates low, high, recommended, and quoting-default rates but never settles which rate determines the source ingredient target in comparison math.

**Trigger:** Label range is 3–4 pt/ac; customer intends 4 pt/ac → comparison silently uses recommended 3 pt → generic quantity is 25% short.

**Smallest fix:** Require an explicit user-selected source rate or define one authoritative default with a visible provenance label. Never silently choose from a range.

### 22. The database rule described as “exactly one default” only guarantees “at most one”

**Location:** BUILD PLAN Phase 2  
**Severity:** HIGH — **Confidence: High**

A partial unique index prevents two quoting defaults, but it permits zero. The plan simultaneously requires blank-safe refusal and “one default enforced.”

**Trigger:** A product has two rate rows and neither is default → reader uses first/low/legacy fallback → invoice quantity changes without an explicit decision.

**Smallest fix:** Enforce exactly one through the rate commit RPC/transaction when rates exist, and make zero-default reads refuse rather than fall back.

### 23. The PRD contradicts the build about invoice behavior

**Location:** [PRD §3 Non-goals](docs/plans/2026-08-18-product-data-model-PRD.md:66), BUILD PLAN Phase 2  
**Severity:** HIGH — **Confidence: High**

The PRD says there is no change to how quotes, orders, invoices, or inventory calculate. Phase 2 explicitly rewires the rate source used by those consumers.

**Trigger:** Builder follows the non-goal and leaves an invoice reader on legacy `products.rate_per_acre` while quoting uses `product_rates` → quote and invoice calculate different quantities.

**Smallest fix:** Replace the non-goal with a precise statement: pricing/money rules remain unchanged, but rate-source readers must move together and produce proven equivalent output during cutover.

### 24. The three rate write paths are both “settled” and still parked

**Location:** [PRD 2.9a](docs/plans/2026-08-18-product-data-model-PRD.md:331), [ledger parked decisions](docs/loops/product-data-model-ledger.md:83)  
**Severity:** HIGH — **Confidence: High**

The PRD says all three paths must use the RPC and calls it a technical choice. The ledger still lists their fate as an owner decision.

**Trigger:** One builder updates inline edit and Add Product while treating CSV as parked → CSV inserts a rate through the revoked legacy column or creates a product with no authoritative rate.

**Smallest fix:** Remove the stale parked item and explicitly assign inline edit, Add Product, and CSV importer—including child-row transaction semantics—to Phase 2.

### 25. Dry-product net weight is not specified enough to calculate safely

**Location:** BUILD PLAN WP-2  
**Severity:** HIGH — **Confidence: Medium-high**

The plan says dry products use net weight but does not define the normalized value/unit, package basis, source, or whether a case contains multiple bags.

**Trigger:** Product is a case of four 10-lb bags → builder interprets `unit_size = 10` as case weight → scale ticket reports 10 lb instead of 40 lb.

**Smallest fix:** Define an explicit normalized package net-weight field plus unit, package count/basis, provenance, hard validation, and a missing-weight refusal case.

### 26. “Cancelled means keep selling” is not a safe universal rule

**Location:** [BUILD PLAN D-T](docs/plans/2026-08-19-product-data-model-BUILD-PLAN.md:72)  
**Severity:** HIGH — **Confidence: High**

EPA existing-stock permissions depend on the specific cancellation order and may contain sale/distribution cutoffs or immediate prohibitions; cancellation status alone does not establish legal sell-through. [EPA’s cancellation guidance](https://www.epa.gov/pesticide-registration/voluntary-cancellation-pesticide-product-or-use) and individual [existing-stock orders](https://www.epa.gov/pesticides/epa-issues-final-cancellation-and-updates-existing-stocks-provisions-several) make that conditional.

**Trigger:** Registration is cancelled and its sale cutoff has passed → CRX shows a warning but still allows a quote/order.

**Smallest fix:** Record the controlling order, sale/use disposition, and dates. Fail closed when sale authorization is unknown or expired. D-T needs a new owner decision.

### 27. WP-1 claims math coverage it does not prove

**Location:** BUILD PLAN WP-1 proof and coverage matrix  
**Severity:** HIGH — **Confidence: High**

The stated proof covers generic ingredient entry/search and one invalid basis. It does not prove NULL refusal, already-acid-equivalent bypass, oxide-to-elemental conversion, isomer grouping, percentage bounds, or biological units.

**Trigger:** P₂O₅ is stored and later treated as elemental P → displayed elemental quantity is approximately 2.29 times too high.

**Smallest fix:** Add one positive and one negative real-path case for every mathematical branch claimed closed, including glyphosate salt, already-AE, P₂O₅, NULL isomer, percent bounds, and CFU/biological refusal.

### 28. “Full schema surface enumerated” is false

**Location:** [BUILD PLAN WP-3](docs/plans/2026-08-19-product-data-model-BUILD-PLAN.md:251)  
**Severity:** HIGH — **Confidence: High**

The list uses “application-record tables” instead of naming exact relations and omits the internal serialized receive function, offline replay, generated RPC types, and current receive call sites.

**Trigger:** Public wrapper is changed but `_section9_receive_po_items_serialized` is not → brand data is dropped before inventory mutation, even though the UI appears to submit it.

**Smallest fix:** Enumerate every relation, function signature, call site, offline action, generated type, document/print consumer, and registry fixture by exact name.

### 29. The canonical fraction field still has two names

**Location:** D-A versus [PRD 1.1a/3.4](docs/plans/2026-08-18-product-data-model-PRD.md:252)  
**Severity:** HIGH — **Confidence: High**

The settled decision renames/generalizes `ae_fraction` to `canonical_fraction`, but the PRD and later acceptance requirements still instruct builders to use `ae_fraction`.

**Trigger:** Builder implements `ae_fraction` for acid equivalents only → fertilizer oxide conversion has no authoritative field → P₂O₅ is treated as P or handled by an ad hoc second path.

**Smallest fix:** Normalize every requirement, schema sketch, proof, and coverage entry to `canonical_fraction`/`fraction_basis`; add a docs check that rejects the obsolete schema term.

### 30. Migration ownership is not currently clean enough to start

**Location:** ORCHESTRATION prerequisite; loop ledger  
**Severity:** HIGH — **Confidence: High**

The read-only fleet check returned `PARKED STATE UNKNOWN`, including this worktree, with numerous migration candidates awaiting ownership resolution.

**Trigger:** A new WP migration is stamped or applied while another branch owns overlapping schema work → duplicate or conflicting migration history, potentially leaving code and live schema on different contracts.

**Smallest fix:** Resolve parked migration ownership and establish the live high-water mark before WP-1 creates its draft migration.

## MEDIUM findings

### 31. The owner-admin permission claim is factually wrong for direct writes

**Location:** [BUILD PLAN permission note](docs/plans/2026-08-19-product-data-model-BUILD-PLAN.md:77)  
**Severity:** MEDIUM — **Confidence: High**

The plan says an admin session cannot reveal a missing column grant. For direct product writes, both owner-admin and non-admin app users operate through the database `authenticated` role; the current product screen performs direct `.update()` in [ProductDetail](src/pages/ProductDetail.tsx:436). A missing grant therefore fails for the owner too.

This does not solve D-J testing: a profile admin can still mask application-level authorization mistakes in `SECURITY DEFINER` RPCs.

**Smallest fix:** Correct the factual statement and separate SQL column-grant proof from app-profile authorization proof.

### 32. The builder is not physically isolated from live systems

**Location:** [ORCHESTRATION role topology](docs/plans/2026-08-19-product-data-model-ORCHESTRATION.md:40); [codex-build.mjs](scripts/codex-build.mjs:42)  
**Severity:** MEDIUM — **Confidence: High**

The launcher uses `danger-full-access`. Its own comments acknowledge that shell and built-in tools are not network-sandboxed. The separation is procedural, not physical.

**Trigger:** A builder follows an accidental command or uses locally authenticated CLI tooling → reaches a live service despite the orchestration’s safety claim.

**Smallest fix:** Describe the boundary honestly and add deterministic command/tool deny guards for builder sessions.

### 33. R-11 is not reflected in each package acceptance

**Location:** BUILD PLAN R-11 and WP proofs  
**Severity:** MEDIUM — **Confidence: High**

WP-4 is positive-only; WP-5 is positive-only; WP-1 omits the load-bearing NULL refusal. A global rule does not tell the builder which failure must be demonstrated.

**Trigger:** Copy succeeds in the normal case but accepts a stale version or incompatible sibling; the package is marked complete because its listed proof passed.

**Smallest fix:** Put named negative cases directly inside every WP acceptance section and coverage row.

### 34. The plan’s PR/landing status is stale

**Location:** ORCHESTRATION prerequisites and loop documents  
**Severity:** LOW — **Confidence: High**

The documents still describe the plan/loop as local work that must land through PR #429. Local `origin/main` already contains the plan commit, and the mission validator passes.

**Trigger:** Orchestrator waits for or recreates an already-completed prerequisite, increasing the chance that work begins from another stale branch.

**Smallest fix:** Refresh the prerequisite status before execution.

## Verification limitations

- No files or refs were changed.
- Live migration history was readable; no product-data-model migration was visible.
- The live `information_schema`/privilege query was blocked by the read-only guard. Per instruction, I did not retry or route around it. Therefore the exact current “27 of 48” privilege count remains unverified live; the permission-carved design itself is confirmed by migrations and source.
- The checkout is five commits behind its local `origin/main` reference, but the six reviewed documents are identical to that `origin/main` snapshot. I did not fetch because this review was explicitly read-only.
- No Graphify report existed, and refreshing it would write files, so focused source inspection was used.
- I found no embedded instruction in the reviewed documents that attempted to override this review.

## Most likely silent wrong-number path

The single most likely path is **EPA import attaching a salt-form concentration to the canonical acid parent, followed by calculation as though the stated number were already acid equivalent**.

The plan itself creates this opening: D-A requires the specific form, but WP-4 tells the builder to map EPA ingredients to canonical acids, and no centralized conversion/refusal mechanism or negative proof enforces otherwise.

Concrete failure:

`5.4 lb IPA salt/gal` → stored on canonical glyphosate acid → interpreted as `5.4 lb ae/gal` instead of `5.4 × 0.741 = 4.0014 lb ae/gal` → the comparison/quoting path believes each gallon contains about 35% more acid than it really does → it recommends and invoices too few gallons for the intended treatment.
