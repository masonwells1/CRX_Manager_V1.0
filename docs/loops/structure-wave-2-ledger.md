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
| A8 | Terms → due-date (post_invoice) | mig 596 | 🚀 **APPLIED LIVE 2026-07-03** (v20260703170243), verified |
| A8-aging | AR aging-basis unification (3 reporting producers) | mig 597 | 🚀 **APPLIED LIVE 2026-07-03** (v20260703170440), verified |
| AR-reminder | Reminder due-date basis + **configurable threshold** (Settings) | mig 598 + SettingsPage/ARaging | ✅ **mig LIVE + frontend DEPLOYED 2026-07-03** (v20260703170528; prod @b07715d0) |
| P2-1 | Category two-axis remap (+ use_timing + normalization trigger + write path) | mig 599 + frontend | ✅ **mig LIVE + frontend DEPLOYED 2026-07-03** (v20260703170632, verified: herb 272/foliar 53/timing 317/0 blanks; prod @b07715d0) |
| P2-2 | Retire dead tables/columns | mig 180000 (live v20260703190820) | 🚀 **APPLIED LIVE 2026-07-03 (2 clean drops: create_prepay_credit + document_processing_log), verified gone** · 6 of 8 targets NOT dead → jobs.tags/batch_id KEEP per owner + rest deferred (see cycle log) |
| P2-3 | Ingredient-map (brand↔generic) page | **frontend-only (no mig)** | 🚀 **DEPLOYED TO PROD 2026-07-03** — admin CRUD on `ingredient_map`; Codex push-gate 5 rounds → CLEAN; main @`1ef739e2`, Vercel `dpl_8WPxBGvSmhRuYfQ9b91eJUjRAi3Q` READY (croprxsolutions.app) |
| P2-4 | Crop Programs → "Apply Program" into jobs | **frontend-only (no mig)** | ✅ **BUILT + Codex-CLEAN 2026-07-03** — "Load Program" appends a crop program's products into JobDetail chemicals (unit-reconciled money math); 5 Codex rounds (2 money P1s fixed) → CLEAN |
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

### 2026-07-03 — P2-4 Crop Programs → "Load Program" into jobs — ✅ BUILT + Codex-CLEAN (frontend-only, no DB change)
- **What Packet 5 flagged:** Crop Programs (reusable product/rate templates in `app_settings`) were write-only — nothing consumed them. Mason chose WIRE. Owner decision (this session): **append to existing chemicals, non-destructive** (not replace).
- **Grounded vs live first:** crop programs are JSON in `app_settings` (key `crop_programs`); job chemicals go through `save_job` (`p_chemicals`); the existing **"Load Recipe"** is the exact non-destructive client-side precedent → mirrored it. No migration.
- **Built:** new pure `src/lib/cropProgramHelpers.ts` (types + `parseCropPrograms` + `orderProgramsForJob` [crop-match first] + `programItemToChemRowSeed`) + JobDetail "Load Program" button (canEdit + active-program gated) + "Load Crop Program" modal + `loadProgramById` (appends seeds, re-derives qty from acres).
- **Codex push-gate: 5 rounds → CLEAN.** Every finding real & fixed: **P1** rate-unit vs stock-unit reconciliation (an oz/acre line on a per-gal product was a 128× over-bill — now routes through `reconcileChemAutofillUnits` like the manual path); **P1** live `Dry oz` unit normalized to `oz` (was a 16× dry over-bill); **P2** since-deactivated program products fetched by id so they price correctly (not $0/blank-REI-PHI); **P2** double-click in-flight guard (`loadingProgram`).
- **Proof:** typecheck + eslint + build clean · full suite **191 files / 3126 tests** · **13 helper tests incl. a regression over the EXACT live program** ("2026 Wells NON-GMO", incl. the `9.6` decimal + `Dry oz` line) proving parse + money-correct mapping. In-browser click-through auth-gated; wiring mirrors the shipped Load Recipe path.

### 2026-07-03 — P2-3 Ingredient-map (brand↔generic) management page — ✅ BUILT + PROVEN (frontend-only, no DB change)
- **What Packet 5 flagged:** the `BrandVsGeneric` page was read-only and its empty state literally told a no-code owner to "add mappings in the ingredient_map table" — a dead end. Mason chose WIRE (keep + finish the UI), not retire.
- **Grounded vs live first:** `ingredient_map` already exists with correct RLS (SELECT for any authenticated user; INSERT/UPDATE/DELETE gated on `is_admin()`), FK `generic_product_id → products(id)`, 0 rows, no `updated_at`, no money cols. **No migration needed — frontend-only.**
- **Built** (`src/pages/BrandVsGeneric.tsx`, single file + companion test): kept the price-comparison viewer; added an admin **Manage Mappings** section — a searchable DataTable of all mappings + an Add/Edit modal (Branded Product & Generic Alternative via `Combobox`, Active Ingredient, bulk checkbox, notes) + delete via `ConfirmModal`. Direct table mutations + `checkMutationResult` (house pattern for a simple admin reference table — matches the RLS design; an SECDEF RPC would bypass RLS, so not used). Write controls gated to `role==='admin'`; sales_rep keeps read-only (never hits the RLS wall). `branded_ingredient` (NOT NULL) defaults to the branded name when blank; generic name resolves to `generic_product_id`; branded must match a real product (validation).
- **Proof (ran, not just "tests pass"):** typecheck + eslint + build clean · every-page render smoke PASS · **4 behavioral tests PASS** (real component render + click-through capturing the actual insert payload; NOT-NULL default; name→id resolution; "must be a real product" reject; sales_rep read-only) · **rolled-back LIVE insert smoke PASS** — ran both exact `handleSave` payload shapes against the real `ingredient_map` table inside a DO block, both accepted (FK + NOT NULL satisfied), aborted with `SMOKE_ROLLBACK_OK`, verified 0 rows / 0 `[E2E]` leftovers persisted.
- **Review:** `compliance-reviewer` → **CLEAN** (0 blockers/high/med). Codex-gate not triggered (frontend-only; no migration/RLS/money/edge-fn per CLAUDE.md scope) — available on request.
- **Ship state:** committed to loop branch `fix/structure-wave-2026-07`. **NOT pushed to `main`** (per loop gate; frontend deploy = Mason's call). Since it's the same branch as the already-deployed Wave-2 frontend, merging this branch to `main` will deploy it to prod (Vercel) — surfaced for Mason.

### 2026-07-03 — 🚀 APPLY GATE: P2-2 clean drops APPLIED LIVE (Mason OK'd "apply the 2 verified dead drops now")
- **Owner decisions this session:** (1) apply the 2 clean drops → done; (2) **KEEP `jobs.tags` + `jobs.batch_id` + the Batch ID UI box** — Mason: "we don't use the app yet but will" (planned features, NOT dead — do not retire).
- **Gate:** rls-security-reviewer + migration-drift-reviewer both ran on the migration → **0 BLOCKERS** (drift: single correct overload, no incoming FK, RESTRICT-safe; RLS: nothing references either object, drop reduces attack surface). Codex `review --uncommitted` already CLEAN. Content-bound apply-guard proof written (queryHash `c51fb5fe…`).
- **Applied** via MCP apply_migration (name `20260702180000_p2_2_retire_dead_objects`, stamped live version **v20260703190820**). Verified live: `create_prepay_credit` gone (0), `document_processing_log` gone (false); `prepay_credits` table + edit/delete/apply_prepay RPCs INTACT (prepay feature unaffected).
- **Post-apply sync:** promoted staging→`supabase/migrations/` (599→600); migration-history #600 row; CLAUDE.md counts (112 tables / 281 RPCs / 600 migs) + Wave-2 note; schema-registry document_processing_log removed (4 blocks, JSON re-validated); AGENTS.md regen; doc-drift PASS. **DEFERRED cleanup (harmless, noted):** `src/types/supabase.ts` still has both objects' auto-gen types (a full regen would pull unrelated parallel-session drift — do it in a dedicated regen pass); the two reference docs (rpc-functions.md/database-schema.md) are branch-baseline-stale already.

### 2026-07-03 — P2-2 retire dead objects — build+park (clean subset only), Codex-clean
**Method:** 9-target adversarial verification workflow (Explore verifiers + Opus critic, ~660k tok) + my own live pg_proc/pg_trigger checks. The approved "dead" list was **materially over-broad — only 2 of 8 are clean.** Verified each against live DB + running code before writing any DROP.

**PARKED (mig `20260702180000_p2_2_retire_dead_objects.sql`, 2 objects — 0 rows/values, 0 live readers/writers, no frontend/type fallout):**
- `DROP FUNCTION create_prepay_credit(uuid,bigint,text,text,text)` — 1 overload, zero callers (caller-graph confirms), in no test fixture array.
- `DROP TABLE document_processing_log` — 0 rows, no incoming FK, no fn/trigger/view/edge-fn reads it, no hand-written index.ts interface.
- **Coupling edits on branch (build+test green either merge order):** `rpcFixtureLiveDiff.test.ts` snapshot (removed `create_prepay_credit`, count 267→266; 7/7 pass) + `backup-via-rest.py` TABLES (removed `document_processing_log`, else backup 404s). Apply-time: regen supabase.ts + schema-registry.
- **Proof:** rolled-back live smoke `SMOKE_RESULT|cpc_gone=t doclog_table_gone=t` (ran the actual DROPs against live, verified, rolled back — nothing persisted) + typecheck clean.
- **Codex (`review --uncommitted`):** CLEAN — "No actionable correctness issues … in the backup table list, RPC fixture snapshot, or parked dead-object retirement SQL."

**NOT clean → deferred / OWNER-GATED (do NOT fold a bare drop in — each verified against live):**
- `deliveries.receipt_pdf_url` — dead in DB (0/102, no reader) BUT removing its `index.ts` Delivery field destabilizes fragile `as Array<Delivery&{…}>` casts in `Deliveries.tsx:294,436` (customer-mismatch typecheck error). Needs a tiny cast-cleanup first; not a schema-drop ride-along. **DEFERRED (low effort, own change).**
- `jobs.tags` + `jobs.batch_id` — BOTH written by `save_job` (INSERT+UPDATE) and guarded by `_enforce_billed_job_immutability` (`NEW.tags/batch_id IS NOT DISTINCT FROM OLD.*`). Dropping either crashes save_job + the trigger. `batch_id` is ALSO a live editable "Batch ID" field on JobDetail (:2609-2615, saved). **OWNER-GATED:** needs a save_job + trigger re-emit (do both columns in ONE save_job touch); `batch_id` removal is a product decision (remove the UI field).
- `payments` (table) + `record_invoice_payment` (RPC) — 0 rows, but 3 LIVE money reports SELECT `public.payments` (`close_accounting_period`, `get_monthly_summary`, `get_customer_statement`) + live E2E specs call `record_invoice_payment`. Dropping = money-behavior change. **OWNER-GATED (a `/foundation-ultra-review`-class change: re-point the 3 readers + migrate the E2E seed path first).**
- `order_line_allocations` (table) — 0 rows, but live `DELETE` refs remain in prod RPCs (`update_order_items` + 2 more) + a smoke script. **NOT dead — keep out.**

### 2026-07-03 — 🚀 APPLY GATE: all 4 Wave-2 workstreams APPLIED LIVE (Mason OK'd "apply the 4")
- **Pre-apply grounding:** live moved well past this session's base (parallel Layer2 + A-series migrations, newest applied 11:13 today). Re-verified every re-emitted fn (post_invoice, get_ar_aging, get_detailed_statement_data, financial_dashboard_summary, get_ar_reminder_candidates) is byte-for-byte the CURRENT live def with only the intended aging/terms swaps — **zero parallel-session drift**. Re-verified P2-1 live category counts + 6 UUIDs unchanged. app_settings columns/UNIQUE confirmed for 162000.
- **Gate:** rls-security-reviewer + migration-drift-reviewer ran on both the AR batch and P2-1 → **0 blockers** (only a B7 version-stamp handoff + "confirm live data" notes, both satisfied). Final live `pg_proc` overload check = exactly 1 overload per fn. Codex verdicts (a8-r3, reminder-r4, p2-1-r6) recorded this session. Apply-guard proofs written per-migration (content-hash bound).
- **Applied in order** via MCP apply_migration (each content-hash matched the guard = faithful transmission), verified live after each: 160000 (helper+post_invoice A8), 161000 (3 aging fns COALESCE basis), 162000 (setting seeded + reminder fn reads it), 170000 (Herbicide 272 / Foliar Fertilizer 53 / use_timing 317 / 0 blanks / fake hidden / trigger active). Live versions v20260703170243→170632.
- **Post-apply:** promoted 4 files staging→supabase/migrations (595→599); anon-exec revoked on parse_payment_terms_days (normalize_product_category is an inert INVOKER trigger fn — accepted); docs synced (migration-history 596–599, CLAUDE.md snapshot, schema-registry products.use_timing + high-water, AGENTS.md).
- **✅ FRONTEND DEPLOYED (Mason OK'd "deploy the UI now"):** ran a fresh Codex push-gate review on the FULL branch diff (migrations + frontend) → CLEAN ("no actionable correctness issues"); merged `origin/main` (1 unrelated commit, no conflicts) → pushed `fix/structure-wave-2026-07` → fast-forwarded `main` @`b07715d0` = Vercel prod deploy. Verified **Vercel deployment `dpl_4rL1efCsw54bw3r1TD6XfmrGYCB8` = READY / production / commit b07715d0**. Coupled UI now live: SettingsPage AR-reminder control · ARaging generic copy · ProductDetail Use-Timing combobox · BulkProductImport use_timing map. (Click-through render not visually confirmed — auth-gated; build compiled + Codex confirmed frontend compiles.)


### 2026-07-03 — P2-1 category two-axis remap — ✅ PARKED (mig 170000 + frontend), Codex 6 rounds
- **Data remap** (`20260702170000`): new `products.use_timing` column (nullable, free-text, no CHECK); pulled TIMING out of the herbicide categories into use_timing so `category`='Herbicide' (Post Emergence/Pre-Emerge Corn+Soybean/Volunteer Corn/Range Pasture Turf); consolidated the two foliar buckets → 'Foliar Fertilizer'/Foliar; Utility→Other; applied Mason's 6-blank classifications; hid the fake product. ~400 rows re-bucketed. Categories already clean (Fungicide/Insecticide/etc.) left untouched to minimize sales-report churn.
- **Normalization trigger** `trg_normalize_product_category` (BEFORE INSERT OR UPDATE OF category): maps the deprecated category aliases → functional class + the alias's canonical timing, so no write path (UI/import/RPC) can re-introduce the old taxonomy. **Does NOT police free-text use_timing** — deliberate (see below).
- **Write path** (frontend, coupled to the migration): ProductDetail gains a "Use Timing" combobox (shown for Herbicide/Foliar Fertilizer); BulkProductImport maps a use_timing column; `use_timing?: string|null` on the Product type. Category dropdowns already self-adapt (dynamic Combobox).
- **Codex (6 rounds):** R1 re-drift → trigger. R2 stale-tag on re-type → direct-assign. R3/R4 asked to CLEAR cross-category stale tags → added a valid-tag invariant. R5 → widen trigger + add write path. **R6** showed the invariant DISCARDS legitimate free-text timings ('Burndown', 'In-Furrow') = data-loss. **RESOLUTION:** R3/R4 (clear) vs R6 (preserve) are in genuine tension on a free-text column; preserving operator input wins — the trigger no longer clears free-text. Accepted trade-off: a rare cross-category re-edit can leave a cosmetically-stale tag, operator-fixable via the Use-Timing field.
- **Proof:** final rolled-back live smoke — backfill=PASS (herb=272, foliar=53, timing=317, empty=0, fake hidden), legacy_norm=PASS, free_text_preserved=PASS ('Burndown' survives), plpgsql_check=0, nothing persisted; frontend typecheck+lint clean.
- **⚠ APPLY-ORDER:** apply `170000` (adds products.use_timing) BEFORE merging/deploying the ProductDetail/BulkProductImport frontend (same branch; merge=deploy).
- **Owner note:** the 2 ambiguous buckets used defaults (Foliar Nutrition & Liquid Fertilizer→Foliar Fertilizer; Utility→Other) — flip in the migration before apply if wrong.

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
