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

| Package | Status | Migration (disk name → live version) | PR | Opus checkpoint | Mason's apply OK |
|---|---|---|---|---|---|
| WP-0 Data hygiene | ⬜ | none | — | — | *(per-class approval of the proposal file)* |
| WP-1 Ingredient core + fast-entry editor | ⬜ | — | — | — | — |
| WP-2 Density, net weight, scale-weight surface | ⬜ | — | — | — | — |
| WP-3 Brand layer, receiving, split loads | ⬜ | — | — | — | — |
| WP-4 EPA auto-seed | ⬜ | none | — | — | *(bulk commit of proposals)* |
| WP-5 Copy-from-sibling, nickname search | ⬜ | none | — | — | n/a |

**Apply order is the package order.** WP-1 → WP-2 → WP-3, no reordering: WP-2's density
precedence function has a brand slot WP-3 populates, and WP-4 writes into columns WP-1 creates.

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

**Still open, and deliberately so:** findings 16, 20, 21, 22, 24 all concern **Phase 2/3**
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
| 2 | **Codex-app Supabase connector** | Mason | OAuth grant recorded dead (`invalid_grant`) 2026-08-14. Sol reached the live DB read-only through its own path during the 2026-08-19 review, so confirm the current state rather than assuming either way |
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
