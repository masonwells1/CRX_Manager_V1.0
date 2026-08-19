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
| 1 | **Codex credits at zero** | Mason | Blocks Sol building **and** the exact-SHA adversarial gate. Nothing starts without it |
| 2 | **Codex-app Supabase connector** | Mason | OAuth grant recorded dead (`invalid_grant`) 2026-08-14 |
| 3 | **Fresh backup** | Loop, cycle 1 | Last good 2026-08-09. Free plan — **no point-in-time recovery.** Required before WP-0's first live write (R-12) |
| 4 | **Parked-migration scan is fail-closed** | Loop, cycle 1 | `fleet-status.mjs` reports `PARKED STATE UNKNOWN`. This build adds three migrations to a queue that cannot currently be counted |
| 5 | **PR #429 must merge** | Mason | Until it does, a worktree cut from `main` cannot read the plan or this mission doc |

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
