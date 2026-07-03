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
| A8-aging | AR aging-basis unification (3 reporting producers) | parked mig | ✅ done — parked, Codex R3 clean, committed |
| AR-reminder | Reminder due-date basis + **configurable threshold** (Settings) | parked mig 162000 + SettingsPage/ARaging | ✅ done — parked, Codex R4 clean, committed |
| P2-1 | Category two-axis remap (+ park ambiguous-2 + 6 blanks) | parked mig + frontend | ⏸ grounded — proposals parked for owner input (below); unambiguous remap ready to build on confirm |
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

## Owner decisions — RESOLVED 2026-07-03
- **AR reminder cadence:** Mason OK'd >30-days-past-DUE as-is, AND asked for the threshold to be **adjustable in Settings** (new work item: make `get_ar_reminder_candidates` read the day-count from a setting + add a Settings control).
- **Category 6 blanks:** `Imazuron Herbicide`→Herbicide, `Treaty Extra`→Herbicide, `Palisade EC`→Other, `Piksi Dust Plus`→**Foliar Fertilizer**, `Water W/ D-Chlorinator`→Other, `1A TEST PRODUCT - FAKE PRODUCT`→**HIDE (is_active=false)**.
- **Category 2 ambiguous buckets (defaults, flagged for confirm-at-apply):** "Foliar Nutrition & Liquid Fertilizer" (16)→**Foliar Fertilizer** (use_timing=Foliar); "Utility" (2)→**Other**. Flip either before apply if wrong.

## Owner-confirms parked for Mason (surface at end)
- **Category remap ambiguous buckets** (P2-1): (a) "Foliar Nutrition & Liquid Fertilizer" (16 products) → Foliar Fertilizer OR Liquid Fertilizer; (b) "Utility" (2) → Charge/Service OR Other.
- **Category remap — the 6 empty-category products** (P2-1, grounded 2026-07-02; my proposal, confirm/correct each):
  1. `Imazuron Herbicide` (Nufarm, dry) → **Herbicide** (clear from name). *(confident)*
  2. `Treaty Extra` (Nufarm, dry) → **Herbicide** (Treaty = a metsulfuron SU herbicide). *(confident)*
  3. `Palisade EC` (Atticus, liquid) → **?? Other** (Palisade = a plant growth regulator; no PGR bucket exists — Other, or add a "Growth Regulator" category?).
  4. `Piksi Dust Plus` (Alchemy BioScience, dry) → **?? Biological** (Alchemy makes biologicals) **or Adjuvant** — need your read.
  5. `Water W/ D-Chlorinator` (no mfr) → **?? Other/Utility** (carrier water / conditioner, not a product).
  6. `1A TEST PRODUCT - FAKE PRODUCT` (20 Mule Team) → **NOT a category — this is JUNK/fake test data.** Recommend HIDE it (is_active=false), like the Phase-1 [UI-TEST] products. It was missed by Phase-1 (no [UI-TEST]/[E2E] prefix). Confirm and I'll fold the hide into the remap migration.
- **AR reminder dunning cadence** (A8-aging, mig 20260702161000 fn 4): switching `get_ar_reminder_candidates` to the due-date basis means dunning-reminder emails now fire at **>30 days past DUE** (was >30 days past invoice = the due date itself for a Net-30 customer). This is the coherent, more-conservative behavior and it stops premature reminders on not-yet-due invoices — but it shifts *when* customers get reminded. Confirm the cadence before applying (or say if you'd rather remind sooner, e.g. any days-past-due > 0).

---

## Cycle log
(newest first — one entry per item as it completes)

### 2026-07-03 — AR reminder: due-date basis + configurable threshold — ✅ PARKED, Codex R4 clean
- **Mason asked** (2026-07-03) to keep >30-days-past-due reminders AND make the day-count adjustable in Settings.
- **Parked mig `20260702162000`**: seeds `app_settings.ar_reminder_days='30'` (ON CONFLICT DO NOTHING) + re-emits `get_ar_reminder_candidates` on the due-date basis, reading the threshold from that setting (robust leading-integer parse, default 30, clamp 1..3650). No signature change. Moved OUT of 161000 to avoid double-defining the function across two parked migrations.
- **Frontend (on branch, coupled to 162000):** `SettingsPage.tsx` new "AR Reminder Threshold (days past due)" number input (mirrors default_quote_valid_days; normalizes 1..3650 on save + input max). `ARaging.tsx` send-confirm modal + toast made GENERIC (no hardcoded day-count) so they can't mislead regardless of migration state.
- **Proof:** rolled-back live smoke — threshold_parse=PASS incl. '30.0'→30 / '1e2'→1 / '45.5'→45, plpgsql_check_errors=0, wiring+parser=PASS, nothing persisted; frontend lint+typecheck clean.
- **Codex:** R1 (parser digit-strip + ARaging copy) → R2 (SettingsPage save normalize) → R3 **P1** (deploy-gap: UI vs old-RPC mismatch → fixed by generic send copy) → R4 CLEAN.
- **⚠ APPLY-ORDER (handoff):** apply `160000 → 161000 → 162000` live BEFORE merging/deploying the SettingsPage+ARaging frontend (same branch; merge = deploy). Otherwise the Settings control saves a value the not-yet-updated RPC ignores.

### 2026-07-02 — A8 (terms→due-date) + A8-aging (aging-basis unification) — ✅ PARKED, Codex R3 clean
- **A8** (`20260702160000_a8_terms_to_due_date.sql`): new `parse_payment_terms_days(text)` helper + `post_invoice` sets `due_date` at post from the parsed terms, only-when-NULL + forward-only. Terms source = invoice override (`invoices.payment_terms`) then customer default. `transfer_job_to_invoice`'s +30 left as-is (= customer terms for all current Net-30 customers; future-proof follow-up noted).
- **A8-aging** (`20260702161000_a8_aging_basis_unification.sql`): age basis `invoice_date` → `COALESCE(due_date, invoice_date)` across **4** producers — `get_ar_aging` (+ Current `<=29` folds in not-yet-due), `get_detailed_statement_data`, `financial_dashboard_summary`, and (Codex-found 4th) `get_ar_reminder_candidates`. Bucket-boundary labels + the dashboard's 4-bucket JSON shape deliberately unchanged.
- **Proof:** every re-emit proven SURGICAL by rolled-back live smoke (new pg-def == old with only the intended swaps, whitespace/comment-insensitive) + `plpgsql_check_errors=0` + `due_date` math; nothing persisted (verified `*_changed_live=false`).
- **Codex:** R1 helper overflow (fixed: numeric cast) → R2 invoice-override terms + 4th aging producer (both fixed) → R3 CLEAN.
- **Owner-confirm parked:** AR reminder dunning cadence (see above). **Apply order:** 160000 then 161000, together.
