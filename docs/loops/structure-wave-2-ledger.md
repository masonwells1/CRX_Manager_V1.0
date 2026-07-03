# Structure Wave-2 Loop — Ledger

**Started:** 2026-07-02 · **Branch:** `fix/structure-wave-2026-07` (run in-place in `C:\CRX_StructureFix`;
Mason redirected the loop here after Phase-1 finished — no separate worktree). **Mission:** `structure-wave-2-loop-2026-07-02.md`.

**Hard gates (unchanged):** never apply a live migration · never deploy an edge fn · never delete/mutate live data ·
never push to `main` · all SQL PARKED in `scripts/.staging-migrations/` with smoke + Codex verdict in the header ·
each item Codex-gated (≤3 rounds) before commit.

**Base:** `main` fast-forwarded to `c85b8779` (Phase-1 + docs/registry sync). Registry accurate to `20260702153000`.

---

## Status board

| # | Item | Ships as | Status |
|---|------|----------|--------|
| A8 | Terms → due-date (post_invoice) | parked mig | ✅ done — parked, Codex R3 clean, committed |
| A8-aging | AR aging-basis unification (4 producers) | parked mig | ✅ done — parked, Codex R3 clean, committed |
| P2-1 | Category two-axis remap (+ park ambiguous-2 + 6 blanks) | parked mig + frontend | ⬜ not started |
| P2-2 | Retire dead tables/columns | parked mig | ⬜ not started |
| P2-3 | Ingredient-map (brand↔generic) page | frontend (+mig?) | ⬜ not started |
| P2-4 | Crop Programs → "Apply Program" into jobs | frontend + parked mig | ⬜ not started |
| P2-5 | Surface per-acre tier pricing in QuoteBuilder | frontend | ⬜ not started |
| P2-8 | Vendor master consolidation | parked mig | ⬜ not started |
| A5 | Blend unit conversion | parked migs + edge-fn code | ⬜ not started |
| A9 | Month-end catch-up | parked mig + frontend | ⬜ not started |
| WaveB | Units Phase 1 (src/lib/units.ts + dropdowns) | parked migs + frontend | ⬜ not started |

Legend: ⬜ not started · 🔨 in progress · 🧪 built, proving · 🔍 Codex round N · ✅ done (parked, Codex-clean, committed) · ⏸ parked-with-spec (owner input) · ❌ dropped

---

## Owner-confirms parked for Mason (surface at end)
- **Category remap ambiguous buckets** (P2-1): (a) "Foliar Nutrition & Liquid Fertilizer" (16 products) → Foliar Fertilizer OR Liquid Fertilizer; (b) "Utility" (2) → Charge/Service OR Other; (c) 6 empty-category products → classify by hand (list TBD once identified).
- **AR reminder dunning cadence** (A8-aging, mig 20260702161000 fn 4): switching `get_ar_reminder_candidates` to the due-date basis means dunning-reminder emails now fire at **>30 days past DUE** (was >30 days past invoice = the due date itself for a Net-30 customer). This is the coherent, more-conservative behavior and it stops premature reminders on not-yet-due invoices — but it shifts *when* customers get reminded. Confirm the cadence before applying (or say if you'd rather remind sooner, e.g. any days-past-due > 0).

---

## Cycle log
(newest first — one entry per item as it completes)

### 2026-07-02 — A8 (terms→due-date) + A8-aging (aging-basis unification) — ✅ PARKED, Codex R3 clean
- **A8** (`20260702160000_a8_terms_to_due_date.sql`): new `parse_payment_terms_days(text)` helper + `post_invoice` sets `due_date` at post from the parsed terms, only-when-NULL + forward-only. Terms source = invoice override (`invoices.payment_terms`) then customer default. `transfer_job_to_invoice`'s +30 left as-is (= customer terms for all current Net-30 customers; future-proof follow-up noted).
- **A8-aging** (`20260702161000_a8_aging_basis_unification.sql`): age basis `invoice_date` → `COALESCE(due_date, invoice_date)` across **4** producers — `get_ar_aging` (+ Current `<=29` folds in not-yet-due), `get_detailed_statement_data`, `financial_dashboard_summary`, and (Codex-found 4th) `get_ar_reminder_candidates`. Bucket-boundary labels + the dashboard's 4-bucket JSON shape deliberately unchanged.
- **Proof:** every re-emit proven SURGICAL by rolled-back live smoke (new pg-def == old with only the intended swaps, whitespace/comment-insensitive) + `plpgsql_check_errors=0` + `due_date` math; nothing persisted (verified `*_changed_live=false`).
- **Codex:** R1 helper overflow (fixed: numeric cast) → R2 invoice-override terms + 4th aging producer (both fixed) → R3 CLEAN.
- **Owner-confirm parked:** AR reminder dunning cadence (see above). **Apply order:** 160000 then 161000, together.
