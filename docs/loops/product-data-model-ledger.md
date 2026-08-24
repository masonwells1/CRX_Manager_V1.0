# Ledger — Product Data Model Rebuild (Phase 0 + Phase 1)

**Mission:** `docs/loops/product-data-model-loop-2026-08.md`
**Scoresheet:** `docs/plans/2026-08-19-product-data-model-COVERAGE.md`
**Worktree:** `C:\CRX_ProductData` (to be created from `main` after PR #429 merges)
**Branch per package:** `ship/product-data-<package>`, each cut fresh from `origin/main`

**Hard gates (never without Mason's in-chat OK):** live migration apply · bulk write to live
product rows · push / PR / merge / deploy · any deletion.

**This ledger tracks cycles. COVERAGE.md tracks issues.** Both are required; they reference each
other. Sol fills evidence and never sets a verdict.

**Status glyphs:** ⬜ not started · 🔨 building · 🧪 proving · 🔍 in review · ✅ reviewed, awaiting
apply/merge · 🚀 shipped and verified live · ⏸ parked

---

## Status board

**Reading this board:** `none` means the package carries **no migration**. `—` means **required
but not yet written** — the disk name and live version stamp get filled in when it exists. The two
are not interchangeable; an earlier revision of this board used `none` for packages that do carry
migrations, which is the defect corrected on 2026-08-20.

| Package | Status | Migration (disk name → live version) | PR | Opus checkpoint | Mason's apply OK |
|---|---|---|---|---|---|
| WP-0 Data hygiene | ⬜ | none | — | — | *(per-class approval of the proposal file)* |
| WP-1 Ingredient core + fast-entry editor | ⬜ | **required** — not yet written | — | — | **migration apply OK** |
| WP-2 Density, net weight, scale-weight surface | ⬜ | **required** — not yet written | — | — | **migration apply OK** |
| WP-3 Brand layer, receiving, split loads | ⬜ | **required** — not yet written | — | — | **migration apply OK** |
| WP-4 EPA auto-seed | ⬜ | **required** — adds **only** the `create_label_draft_proposal` RPC. The `product_label_drafts` queue schema is **WP-1's**, and `create_label_draft` is never modified | — | — | **migration apply OK** *(plus bulk proposal creation and bulk commit — both are live writes)* |
| WP-5 Copy-from-sibling, nickname search | ⬜ | **required** — atomic sibling-copy RPC with compare-and-set on both products | — | — | **migration apply OK** |

**Apply order is the package order.** WP-1 → WP-2 → WP-3 → **WP-4** → **WP-5**, no reordering:
WP-2's density precedence function has a brand slot WP-3 populates, WP-4 writes into columns WP-1
creates, and WP-5 copies the chemistry WP-1 through WP-3 defined.

**Five packages carry migrations — WP-1 through WP-5, each with its own apply gate.** *(This line
first said "four", counting WP-4 but not WP-5, and was corrected the same day. WP-0 is the only
package with no migration.)* The board above now matches the build plan *(both corrected reviewing
PR #435)*. WP-4 was still listed as `none` here after revision 3 made it a migration, and WP-5 was
listed as `none` in both documents:

- **WP-4** — revision 2 said "no migration"; revision 3 replaced that after Sol's finding 1,
  because the existing `product_label_drafts` queue has nowhere to put ingredient rows,
  specific-form ids, concentration basis, brand proposals, label URL/date or cancellation state.
  **The queue *schema* work then moved to WP-1** — WP-3's D-K escape hatch needs it and WP-3
  applies first — so WP-4's migration adds only the `create_label_draft_proposal` RPC over that
  shape *(corrected 2026-08-20, blocker S-02 of the exact-snapshot Codex review of PR #435: this
  row and the build plan had disagreed about who owns the change)*.
- **WP-5** — the sibling copy must move ingredients, density and brands atomically while
  comparing expected versions on **both** products. That is not expressible as a sequence of
  browser/PostgREST writes, and no sibling-copy RPC exists yet.

An executor reading the stale `none` would skip the migration and its apply gate entirely —
silently dropping fields, or leaving a half-copied product behind. **Both packages take the full
migration gate**: RLS + drift review, exact-SHA proof, Opus checkpoint, and Mason's in-chat apply
OK, exactly like WP-1 through WP-3.

---

## Proof lines

One per package, written when it ships. `PROOF — Ran: <what was executed> · Saw: <what was
observed>`. A passing test is not a proof (build plan R-1/R-2). Every proof runs on `[E2E]` test
rows (R-9), covers a negative case as well as a positive one (R-11), and records the
`has_column_privilege` check for each new column — because Mason's account is an admin session and
cannot reveal a missing grant.

- **WP-0** — *(pending)*
- **WP-1** — *(pending)*
- **WP-2** — *(pending)*
- **WP-3** — *(pending)*
- **WP-4** — *(pending)*
- **WP-5** — *(pending)*

---

## Cycle log

*(Newest first. One entry per cycle: what was attempted, what happened, what the next cycle
picks up. Record a `BLOCK` from Opus and its fix round here, not just the final pass.)*

### 2026-08-20 — cycle 0b: adversarial review, then plan revision 3

Codex `sol` (`gpt-5.6-sol`, high effort, read-only) reviewed the whole planning package before
any of it was built. **Verdict: NOT SAFE AS WRITTEN** — 8 blockers, 22 high, 4 minor. Full text:
`docs/audits/2026-08-19-sol-adversarial-review-product-data-plan.md`.

The blocker that mattered most: **WP-4 told the builder to map EPA ingredients "to canonical
acids", contradicting D-A.** Storing 5.4 lb IPA salt/gal on the canonical acid and reading it as
acid equivalent overstates active per gallon by ~35% and under-quotes a 100-gallon job by ~26
gallons, silently. Verified against the file before fixing.

**Fixed in revision 3 — all 8 blockers:** WP-4 rewritten (specific-form attachment, and it now
carries a migration because the draft queue cannot hold the payload); WP-3's `receive_po_items`
signature change withdrawn in favour of carrying brand data inside `p_items`; brand-allocation
conservation invariant added; WP-2's brand slot deferred to WP-3 with an explicit re-prove
obligation; hard finite/positive domain validation ahead of the soft warn band; R-4a added — one
conversion function that returns a value **or a refusal**, never a coalescible nullable; the
permission protocol now ships an expected-privilege matrix instead of a bare check.

**Also fixed, 14 highs:** apply-before-merge additivity is now an audited gate; the three
proof-timing/scope defects (findings 9–11); inventory-reversal proof (13); write-enforced density
precedence (14); brand-to-shipped-load rule (15); shared-ingredient version invalidation (17);
copy-from-sibling eligibility (18); PRD non-goal contradiction (23); dry net weight (25); WP-1's
unproven math branches (27); WP-3 schema enumeration incl. the serialized function (28);
`ae_fraction` → `canonical_fraction` across the PRD (29); the false admin-cannot-see claim (31).

**Closed by owner decision, not fixed:** finding 26 (cancelled EPA → D-W) and finding 19
(quality tier → D-X).

**Finding 16 is NO LONGER deferred — it was mis-scoped *(corrected 2026-08-20 by the
exact-snapshot Codex review of PR #435)*.** It reads as Phase 2/3 comparison behavior, but its
substance — *which concentration is authoritative when a typed value and an EPA value both exist*
— is decided by **WP-4's live write in Phase 1**. Deferring it left WP-4 free to create two rows
for the same chemistry with no rule about which counts, so a consumer could sum them. It is now
answered inside WP-4 as a database invariant: exactly one effective row per
`(product_id, ingredient_id, basis)`, enforced by a partial unique index, with EPA conflicts held
as proposed/audit data until an atomic approval retires the prior effective row. **Findings 20,
21, 22 and 24 remain genuinely Phase 2/3 and stay deferred.**

**Second pass of the exact-snapshot review — three more blockers, all fixed 2026-08-20.** The
merge gate re-ran against the pushed snapshot and returned `BLOCKERS`. All three were
contradictions the first pass introduced or left standing, not new scope:

- **S-01** — the "one effective concentration" invariant was keyed
  `(product_id, ingredient_id, basis)`, so a typed acid-equivalent row and an EPA
  active-ingredient row **both stayed effective** and could be summed. Bases are alternate
  representations, never additive. Re-keyed to `(product_id, ingredient_id)`, with a
  differing-basis negative proof added.
- **S-02** — this ledger and the build plan **disagreed about who owns the queue schema.** WP-1
  owns the shape; WP-4 adds only `create_label_draft_proposal`; `create_label_draft` is never
  modified. A third `purpose`, `brand_proposal`, was also added — D-K's crew-typed brand had no
  unambiguous commit route between `manual` and `epa_label_seed`.
- **S-03** — allocation conservation was checked only inside the allocation RPC, while
  `create_delivery_with_items`, `create_quick_delivery`, `edit_delivery` and `void_delivery` can
  all move a parent line without it. Now enforced by constraint trigger on the parent, with
  direct allocation writes revoked, plus brand-level available-quantity bounds so a delivery
  cannot allocate more of a brand than was received.

Two further findings from the same pass were fixed with them: the brand-density proof now selects
the shipped brand through a delivery allocation instead of inferring it from the receipt, and
`application_records.product_data` elements carry a `brand_allocations[]` array rather than one
scalar snapshot pair.

**Third pass — four more fixed, two dismissed as settled owner decisions.** Fixed: every new
`product_label_drafts` payload column is nullable/defaulted with a *purpose-conditional* CHECK, so
WP-1's migration cannot break the deployed `create_label_draft` caller, and WP-1's proof now
exercises the legacy create **and commit** path; brand allocations carry the parent's
`product_id` under a composite foreign key so a line for one product cannot be allocated to
another product's brand, with scalar-versus-allocation exclusivity enforced too; WP-5's copy RPC
gained an explicit authorization boundary (`SECURITY DEFINER`, `auth.uid()` admin check,
actor-bound audit, non-admin refusal proof); and the build plan's per-package chain no longer
collapses the step-9 adversarial verdict, the step-10a exact-HEAD push proof and the step-12a
apply proof into one "exact-SHA proof" placed before commit — ORCHESTRATION.md is now named
authoritative where the two differ.

**Dismissed — and they will keep coming back, so do not re-fix them.** The adversarial gate has
no memory of owner decisions and re-raises these every round:

- **"Cancelled EPA registrations fail open"** → **D-W.** Mason, 2026-08-19: *"Don't worry about
  it, let it be sold."* Sol's sell-through argument was put to him and he accepted it as his
  call. Do not add a sale-blocking gate.
- **"Cross-tier sibling copying is permitted"** → **D-X**, reaffirmed by Mason on **2026-08-20**
  when he was asked whether to drop the database restriction or reopen D-X and chose to **drop
  the restriction**. Tier protection stays at the display layer (D-O, D-P). A builder must not
  add `sourcing_tier` to `products` or build cross-tier substitution rules.

**This means `CODEX_PROOF_VERDICT: CLEAN` may be unreachable for this PR**, since two of its
findings are owner decisions the reviewer will re-raise indefinitely. Judge the gate on whether
the *remaining* findings are real, not on the token.

**Fourth pass — prediction confirmed, four more fixed.** The gate re-raised **D-W and D-X
verbatim** as findings 3 and 4, exactly as the paragraph above said it would. That is now
measured behavior, not a guess. The other four were real and two of them were defects the third
pass introduced:

- **Ownership, again — ORCHESTRATION.md still said WP-4 extends the queue** while the build plan
  and this ledger had been corrected. The third pass fixed two documents out of three. Now all
  three state it identically.
- **`brand_proposal` named an undefined "brand-commit path".** Naming a path without specifying
  it is how a builder invents an unguarded one, and this call writes an EPA number that reaches
  customer paperwork. Now `commit_brand_proposal`, owned by **WP-1** for the same
  applies-before-WP-4 reason as the queue: `SECURITY DEFINER`, `auth.uid()` actor, admin-only per
  D-S, idempotent, locks the proposal `FOR UPDATE` and refuses a non-pending row, with replay,
  double-approve and non-admin refusal proofs.
- **A partial unique index gives *at most* one effective row, not *exactly* one** — and proposed
  rows sat in the fully readable chemistry table, so a consumer missing a `state = 'effective'`
  predicate reads EPA proposals as live chemistry. Reads now go through an effective-only view
  with direct base-table SELECT revoked, and promotion/retirement happen in one transaction so
  the count never passes through zero.
- **Brand balances could be overdrawn concurrently.** The allocation RPC locked the parent
  delivery *line*, which does nothing about two different lines drawing the same brand: two
  6-gallon deliveries against 10 available gallons both read 10 and both commit. The lock moves
  to the balance row itself, taken before the availability check, with a deterministic
  ascending-`brand_id` order to avoid deadlock and a non-negative CHECK as backstop. A
  simultaneous-allocation proof is now required — a sequential proof cannot detect this.

**Still open, and deliberately so:** findings 20, 21, 22, 24 all concern **Phase 2/3**
comparison and rate-source behavior, which this loop does not build — they must be settled before
Phase 2, not before WP-0. Finding 30 (parked-migration ownership) is blocker row 4 above and
**must clear before WP-1 stamps a migration**. Findings 32, 33, 34 are process-honesty items.

**Nothing built. No schema change. No live data touched.**

**Next cycle picks up:** blocker row 4, then the standing prerequisites, then WP-0's proposal file.

---

### 2026-08-19 — cycle 0: planning complete, build not started

Planning package finished and pushed as PR #429: master record (43 issues), PRD, build plan
(6 packages, 22 decisions, 12 standing rules), orchestration design, coverage scoresheet, and
this loop's mission doc and ledger. An independent adversarial review returned 26 findings —
verdict *safe with changes* — all folded into revision 2, including one blocker (WP-4 wrote into
columns no package created) and two corrections to earlier claims.

**Nothing built. No schema change. No live data touched.**

**Next cycle picks up:** the standing prerequisites below, then WP-0's proposal file.

---

## Blocked / awaiting

| # | What | Owner | Detail |
|---|---|---|---|
| 1 | ~~Codex credits at zero~~ — **CLEARED 2026-08-19** | — | Sol ran a full adversarial review of the plan that evening. Credits work; the gate is available |
| 2 | ~~Codex-app Supabase connector~~ — **CLEARED, verified 2026-08-20** | — | The 2026-08-14 `invalid_grant` record is stale. During Sol's 2026-08-19 review `codex_apps/supabase.list_migrations` **completed** twice against the live project. The only refusals in that run came from **our own** LIVE-DATA GUARD hook rejecting non-read-only SQL — which is the guard working, not a broken connector |
| 3 | **Fresh backup** | Loop, cycle 1 | Last good 2026-08-09. Free plan — **no point-in-time recovery.** Required before WP-0's first live write (R-12) |
| 4 | **Parked-migration scan is fail-closed** | Loop, cycle 1 | `fleet-status.mjs` reports `PARKED STATE UNKNOWN`. This build adds migrations to a queue that cannot currently be counted. **Sol finding 30: resolve parked-migration ownership and establish the live high-water mark before WP-1 stamps its first migration** |
| 5 | ~~PR #429 must merge~~ — **MERGED 2026-08-19 16:32 CDT** by Mason (`a9fdd48c`) | — | The plan documents are on `main`. Cut the loop's worktree from current `origin/main` |
| 6 | **The plan itself is NOT SAFE AS WRITTEN** | Loop, cycle 1 | Sol's 2026-08-19 review: 8 blockers, 22 high. **All 8 blockers were fixed in revision 3 on 2026-08-20**, along with 14 of the highs. See the cycle log for exactly what remains open — do not start WP-0 believing the whole review is dispositioned |

---

## Owner decisions parked for later phases

Not needed for WP-0 … WP-5; do not chase them now.

- **The three product write paths** (Phase 2) — extend, gate, or retire each, including the CSV
  importer at `src/components/products/BulkProductImport.tsx:229`.
- **What `legacy` rate mode reads** once the Phase 2 trigger-synced mirror exists — the mirror
  projects the same re-derived row, so `legacy` may not mean what it sounds like.
- **Restricted-use product count** — parked by Mason. The compliance report stays *known
  incomplete*, never presented as clean.
- **Density backfill sequencing**, **label rate / REI / PHI**, **required fields on create**,
  **per-crop rates** — all parked by Mason, on record in the master record.
