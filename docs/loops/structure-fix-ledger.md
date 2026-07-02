# Structure-Fix Loop — Ledger

**Branch:** `fix/structure-wave-2026-07` (worktree `C:\CRX_StructureFix`) · **Started:** 2026-07-02
**Mission:** [structure-fix-loop-2026-07-02.md](structure-fix-loop-2026-07-02.md)
**Live high-water at start:** `20260701205341` · **Baseline:** typecheck + build clean, tests 3106 pass / 122 skip (GREEN)

## ★★ SHIPPED LIVE 2026-07-02 (Mason authorized "push and ship it all live")
All 6 parked migrations were **APPLIED LIVE** (branch pushed; then applied via gated MCP with the two review
subagents run + proof files: **all 12 reviews clean, 0 blockers**), and the branch is being merged to `main` to
deploy the frontend (A1 + A6 DispatchBoard). Apply verified per-migration (new function bodies present, 1 overload
each; **A7 recompute: 0 remaining on-order drift, 2 new inventory rows**). Migrations `20260702130000`–`135000`
are now in `supabase/migrations/` + live `schema_migrations`. Remaining parked-with-spec items (A5/A8/A9/A11/A12/A13
+ Wave B) are unbuilt; A13/A12 recommended for a fresh session.

---

## ★★ 2026-07-02 (later) — A12 + A13 APPLIED LIVE (Mason: "Apply a12 and a13")

**Plain English:** both database changes are now **LIVE** on production. **A12** = an editable *Crop History* on the
Field dashboard so the office can finally record a crop's variety, planting/harvest dates, yield, and notes (was
impossible before). **A13** = you can set a product's *reorder point* right when you add it to inventory (that's why
0 products had one — the only way to set it was a hidden inline edit); the low-stock alert list already existed.

**How it was applied (gated path, this session):** ran the two mandatory reviewers on EACH migration
(`rls-security-reviewer` + `migration-drift-reviewer` = **4/4 CLEAN**) → wrote apply-guard proof files → applied both
via gated MCP `apply_migration` with Mason's explicit OK → verified live per-function (A12: 1 overload, SECDEF,
search_path, ACL authenticated-only/no-anon; A13: exactly 1 overload = the new 10-arg, old 8-arg cleanly gone,
no-anon) → post-apply DB-invariant sweep on both = PASS (anon-exec false, search_path set, ACTOR_MISMATCH guard,
auth.uid bind, role-gated, 1 overload). Migrations promoted to `supabase/migrations/` (versions stamped by MCP).

**ONE remaining step (needs your OK — it's a production DEPLOY):** the two *screens* (FieldDashboard editor +
Inventory reorder inputs) are on this branch but NOT yet deployed. Merging `fix/structure-wave-2026-07` → `main`
deploys them via Vercel. Both migrations are already live and backward-compatible, so the app is safe right now;
merging just makes the new buttons reachable. Say the word and I'll open the merge (or you can one-click it).

**Proof:** reviewers 4/4 CLEAN; live post-apply verification (above) + invariant sweeps PASS; frontend
typecheck + lint + production build all clean; Codex reviewed twice (found + fixed a real crop-editor data-loss
bug, re-confirmed clean). Detail in Cycles 9–10.

---

## ★ HANDOFF FOR MASON (historical — pre-apply)

**Plain English:** I fixed a batch of the Tier-0 "broken features" from the audit. Every fix is either a
frontend change already committed to this branch, or a **parked** database migration (a `.sql` file in
`scripts/.staging-migrations/` that is drafted, safety-tested against the live database in a rolled-back
transaction, and independently reviewed by Codex — but **NOT applied**). Nothing touched production. Pushes
are held too (the overnight autopilot blocks all `git push` by design — the commits are local on branch
`fix/structure-wave-2026-07`; **push it when you're back**, then we merge to `main` together).

**What's DONE (proven + Codex-clean, on this branch):**
- **A1** (committed frontend) — blend-ticket product picker now actually saves the product (was silently dropping it → $0 / crashes).
- **A6 DispatchBoard** (committed frontend) — the dispatch stock-light now converts units before comparing (was wrong by the unit ratio).

**Parked migrations — SAFE to apply (additive / bug-fix, no policy call), recommended apply order:**
1. `20260702133000_a14` — units: accept full-word pint/quart (was saving NULL). *Trivial, functionally proven.*
2. `20260702130000_a2` — blend ticket saves its job + application-service links (+ a customer-match guard).
3. `20260702131000_a3` — quotes stop wiping section header-notes / needed-by-date / field / is-planned on re-save.
4. `20260702132000_a4` — quick-delivery bills tier1 instead of $0 when a customer's tier price is missing.
5. `20260702134000_a6` — **job completion + shortfalls stop corrupting inventory by the unit ratio** (the worst one).
   ⚠️ **Behavior note:** after A6, completing a job whose chemical has a blank/unknown unit will STOP with a clear
   error instead of silently deducting the wrong amount. Intended guard; the common (same-unit) case is unaffected.
6. `20260702135000_a7` — fixes the products whose "on order" count drifted (16 corrected + 2 new rows) and
   stops the INSERT-as-submitted PO path from re-drifting it. ⚠️ **Apply during low PO activity** (it briefly
   locks the PO/inventory tables for the one-time recompute). Known latent follow-up in the header: on-order
   increment (Main Warehouse) vs receive decrement (received location) can mismatch under multi-location receiving.

**Needs YOUR decision before I build/apply (see `owner-decisions-2026-07.md` — 6 packets with concrete lists):**
- Junk-data deletes (8 RTJ recipes, Test Mfg/Vendor, vendor 'we') · vendor+manufacturer merges · category remap ·
  **due-date policy (unblocks A8)** · wire-vs-retire calls · 'wire' payment method.

**Parked with a detailed spec (not built — see "Remaining Wave-A items" + the specs below):** A5 (blend billing unit
conversion — latent), A8/A9 (need your policy confirm), A11 (dormant — holds have no expiry live), A12 (crop-history editor),
A13 (reorder UI). **A10 was investigated and deliberately NOT changed** — the audit's fix was unsafe (would block invoice resends).

**How to apply a parked migration:** move the file from `scripts/.staging-migrations/` to `supabase/migrations/`, then
apply it through the normal gated MCP path with your explicit OK (each already has its Codex verdict + smoke evidence in the header).

---

---

## Legend
- **Status:** DONE (proven + Codex-clean + committed) · PARKED (reason) · IN-PROGRESS · TODO
- Parked migrations live in `scripts/.staging-migrations/` with smoke evidence + Codex verdict in a header comment. **Nothing is applied live.**

---

## Step 0 (setup)
| Step | Status | Note |
|---|---|---|
| Read both roadmap docs | DONE | app-wide audit + units deep-dive |
| /regen-schema-registry | DONE | rebuilt from live introspection; high-water `20260701205341`; 27 status enums / 114 tables |
| Baseline typecheck+build+test | DONE | GREEN — 3106 tests pass / 122 skip, build clean |
| Create ledger | DONE | this file |

---

## WAVE A — Tier-0 broken features

| # | Item | Ships as | Verify | Status | Proof | Codex | Commit |
|---|---|---|---|---|---|---|---|
| A1 | Blend product-select stale-closure bug | frontend | YES | **DONE** | fail-first test (`'' → 'p1'`) | clean | f9a4d7ee |
| A2 | save_blend_ticket persists job_id + application_service_id (+ job/customer guard) | parked mig `20260702130000` | YES | **PARKED (done, unapplied)** | plpgsql_check CLEAN, rolled back | clean (3 rounds) | (in A2 commit) |
| A3 | save_quote restore 3 section fields + is_planned (idempotency ALREADY LIVE) | parked mig `20260702131000` | PARTIAL* | **PARKED (done, unapplied)** | plpgsql_check CLEAN + drift-review CLEAN (additive-only) | clean | (A3 commit) |
| A4 | create_quick_delivery tier $0 fallback (mig DONE) + getTierPrice consolidation (DEFERRED, DRY-only) | parked mig `20260702132000` | YES | **PARKED (mig done) + frontend deferred** | plpgsql_check CLEAN | clean | (A4 commit) |
| A5 | Blend unit conversion (3 RPCs) + OCR ratePerAcre carry + $0-rate guard | parked migs + edge-fn | YES (LATENT) | **PARKED — spec'd (not built)** | most complex; 0 live blend data; deserves a dedicated session | — | see spec |
| A6 | complete_job + shortfalls unit conversion (mig) + DispatchBoard compare (frontend) | parked mig `20260702134000` | YES | **DONE (mig PARKED + frontend committed)** | both fns plpgsql_check CLEAN + rolled back; DispatchBoard typecheck/lint clean | clean | (A6 commit) |
| A7 | PO on-order INSERT-path fix (insert-as-draft-then-promote) + locked recompute (16 fixed + 2 new rows) | parked mig `20260702135000` | YES (16 drift, not 18) | **PARKED (done, unapplied)** | plpgsql_check CLEAN + recompute smoke (116/16/2) rolled back, live 114 unchanged | clean R2 (R1 P1+P2 fixed; location-mismatch documented) | (A7 commit) |
| A8 | Terms→due-date (payment_terms_days + post_invoice default) — needs Mason policy | parked mig + frontend | YES | **PARKED — needs Mason policy (Packet 4)** | build blocked on due-date/aging decision | — | see spec |
| A9 | Month-end catch-up — needs Mason confirm | parked mig + frontend | YES | **PARKED — needs Mason confirm** | historical-date behavior change; verify live close_accounting_period first | — | see spec |
| A10 | Email idempotency: stable intent-scoped keys | frontend/lib | NO (fix unsafe) | **PARKED — did not apply (audit fix unsafe + risk already mitigated)** | Codex confirmed a stable/window key silently blocks resends | Codex P2 | (no change) |
| A11 | Wire get_expiring_planned_holds into Dashboard/ActionQueue | frontend | PARTIAL (holds have NO expiry live) | **PARKED — dormant until expiry data** | wiring a card that reads a fn returning empty; needs backfill decision | — | see spec |
| A12 | `save_field_crop_history` upsert RPC + FieldDashboard editable Crop History tab | parked mig `20260702140000` + frontend | YES | **DONE — APPLIED LIVE** (mig 20260702140000) + frontend committed | reviewers 4/4 CLEAN; live-verified 1 overload/SECDEF/no-anon; invariant-sweep PASS | clean R2 (R1 data-loss P2 fixed) | b1f67e90 |
| A13 | `manual_inventory_add` gains reorder_point/min_stock_level + Add-Inventory modal inputs (below-reorder panel ALREADY existed) | parked mig `20260702141000` + frontend | YES | **DONE — APPLIED LIVE** (mig 20260702141000) + frontend committed | live post-apply = exactly 1 overload (10-arg); plpgsql_check CLEAN (only a benign PRE-EXISTING v_existing warning); live 8-arg unchanged | clean | b1f67e90 |
| A14 | convert_to_gl_lb pint/quart aliases | parked mig `20260702133000` | YES | **PARKED (done, unapplied)** | FUNCTIONAL smoke pint(8)=1.0/quart(4)=1.0, PT/QT unchanged, plpgsql_check CLEAN | clean | (A14 commit) |

## WAVE B — Phase 1 units (only after Wave A fully ledgered)
| Item | Status | Note |
|---|---|---|
| units.ts canonical module → dropdowns → drift report → normalize (parked) → importers → E2E | **PARKED — spec'd (not reached)** | Wave A not fully built (5 items parked-spec); full Wave-B spec in the section above |

## Decision packets (docs only, no code)
| Packet | Status | Note |
|---|---|---|
| owner-decisions-2026-07.md (6 packets) | **DONE** | Written with concrete live side-by-side lists (vendor/mfr typos, 19 categories, 8 RTJ + Test Mfg/Vendor junk, terms 150-empty, wire-vs-retire, 'wire' method). Awaits Mason's calls. |

---

## Grounding (Step-0.5 — 14-agent read-only verification vs live code + DB, 2026-07-02)
Corrections to the audit worklist (all findings re-verified against live `pg_get_functiondef` / live SQL / real files):
- **A1** reproduces YES — `updateProduct` uses closure `products`, not functional updater; 2-line fix per file.
- **A2** reproduces YES — `save_blend_ticket` (live from `20260608152631`, 1 overload) omits `job_id`/`application_service_id` from its UPDATE; both cols exist; UI passes them; `create_invoice_from_blend_ticket` reads them (gated).
- **A3** reproduces PARTIAL — `save_quote` (live from `20260616204400`, 1 overload) drops **3** section fields on DELETE+re-INSERT (`section_header_notes`, `needed_by_date`, `field_id`) and never writes `is_planned` (on `quotes`). **`create_job_from_quote_section` idempotency `AND operation=` is ALREADY LIVE (20260611211058) — do NOT re-add.** 8 migrations historically emit save_quote; canonical = 20260616204400 → rebuild additively from live source.
- **A4** reproduces YES — `create_quick_delivery` COALESCEs tier2/3 to 0 (not tier1 cascade) at 2 spots → bills $0. Shared `getTierPrice` **already exists** (`src/lib/quoteCalc.ts:40-45`); ~7 inline cascades + 2 local dups to consolidate.
- **A5** reproduces PARTIAL (LATENT — 0 live blend data) — 3 blend RPCs unconverted; OCR parses `ratePerAcre` then drops it (insert omits `rate_per_acre`/`rate_per_acre_unit`); $0-rate lines silently skipped. Reuse `field_app_priced_quantity` (20260630180000).
- **A6** reproduces YES — `complete_job` (20260630073344:242) deducts rate-units from inventory-units unconverted; same in `get_job_inventory_shortfalls` (20260702120000) + `DispatchBoard.tsx:417-424`. Reuse `field_app_priced_quantity`.
- **A7** reproduces YES — **18/604** products drift (worst +9000). Root cause: `trg_po_submitted_update_on_order` fires only on `UPDATE OF status`; `save_purchase_order` RPC INSERTs directly as 'submitted'. Fix = INSERT-path handling + recompute migration (604-product diff in smoke).
- **A8** reproduces YES (POLICY) — no `payment_terms_days` col; `post_invoice` never sets due_date; field-app hardcodes +30d. Needs Mason policy.
- **A9** reproduces YES (POLICY) — 1 accounting_period row; UI only closes current month. **Gotcha: live `close_accounting_period` differs from migration source — verify live def before change.** Needs Mason confirm.
- **A10** reproduces YES — `Date.now()` in email key at `emailService.ts:140` default + 3 inline sites; `buildInvoiceEmailPayload` exists → route all through it, drop timestamp.
- **A11** reproduces PARTIAL — function has zero callers (true) BUT **all 9 crop_program holds have `expires_at = NULL`** (audit's "carry expiry dates" is FALSE). Wiring the card = dormant until expiry data exists. → decision/backfill needed.
- **A12** reproduces YES — `field_crop_history.harvest_date` has no write path (only crop_type trigger writes); 4 read consumers. Need upsert RPC + FieldDashboard editor. Gotchas: RLS admin/sales_rep only, no field-ownership check, `compute_season` consistency.
- **A13** reproduces YES — 0/114 reorder_point set. Inline-editable column already exists (admin, undiscoverable); Add-Inventory modal + `manual_inventory_add` RPC lack the field; no below-reorder list.
- **A14** reproduces YES — `convert_to_gl_lb` (20260629140000) accepts only PT/QT; TS accepts pint(s)/quart(s). Single additive CREATE OR REPLACE.

Full agent output: `tasks/w4jvvj7ip.output` (in scratchpad task dir).

---

## Remaining Wave-A items — implementation specs (for continuation)
Each is grounded (verdicts above). Do them the same way: rebuild fn from LIVE source additively → rolled-back
`plpgsql_check` smoke (+ `[E2E]` marker on any query whose body writes a business table) → `/codex-review` → park.

- **A5 — blend unit conversion (3 RPCs + OCR + $0-rate guard) — most complex, LATENT (0 live blend data).**
  Three live RPCs multiply rate×acres (or ×qty) with NO unit conversion: `create_invoice_from_blend_ticket`
  (live from `20260620240000`), `create_order_from_blend_ticket` (`20260305200000`), `create_application_record_from_blend_ticket`
  (`20260610145350`). Fix: convert via `field_app_priced_quantity(qty, rate_unit, inventory_unit, product_form)`
  (the A6 helper) before pricing/inventory. Carry OCR rate into `blend_ticket_products.rate_per_acre`/`rate_per_acre_unit`:
  `supabase/functions/process-blend-ticket/index.ts` parses `ratePerAcre` (lines 374/391/etc.) but the INSERT (~1057-1068) OMITS
  both columns — add them (edge-fn code committed, deploy PARKED). Guard/warn on $0-rate billable lines (currently silently dropped).
  Split into per-RPC parked migrations + the edge-fn code. Watch: `create_invoice_from_blend_ticket` uses `job.quote_section_id`
  quoted-pricing branch (A2 added the job/customer guard) — keep consistent.
- **A8 — terms→due-date — NEEDS MASON POLICY (Packet 4).** Add `customers.payment_terms_days int` (+ optional per-invoice
  override) + a terms `<select>`; `post_invoice` derives `due_date = invoice_date + terms_days` at post time FORWARD ONLY
  (never backfill posted invoices). Default terms Net 30 (matches field-app +30). Confirm aging basis (Packet 4). Parked + flagged.
- **A9 — month-end catch-up — NEEDS MASON CONFIRM.** GOTCHA: pull the LIVE `close_accounting_period` first — it differs from
  the `20260217200000` migration source (calls check/save_idempotency, references `scheduled_date`). Fix: month/year picker in
  `MonthEndClose.tsx` (currently hardcodes current month, lines 47-56) + seed `accounting_periods` for prior months as 'open'
  BEFORE the first real billing (zero-backfill window). Behavior change on historical dates → owner decision. Parked + flagged.
- **A11 — wire get_expiring_planned_holds — PARTIAL (holds have NO expiry live).** The fn has zero callers; wiring = a new
  category in `ActionQueue.tsx` CATEGORIES (35-120) fed by `get_dashboard_action_items` (must add a call to
  `get_expiring_planned_holds`). BUT live: all 9 crop_program holds have `expires_at = NULL`, so the card is DORMANT until either
  (a) Mason backfills expiry, or (b) `create_planned_holds` is fixed to set it. → decide before wiring a permanently-empty card.
- **A12 — PHI crop-history editor + upsert RPC (frontend + parked mig).** `field_crop_history.harvest_date` has no write path
  (only a crop_type-only trigger `snapshot_field_crop_history` writes). Add `save_field_crop_history(field_id, season, crop_type,
  variety, planting_date, harvest_date, ...)` SECDEF RPC: derive season via `compute_season` (consistency), gate admin/sales_rep
  (+applicator? RLS currently admin/sales_rep only — confirm), strict-actor + `p_idempotency_key`, revoke anon, and mirror
  field-ownership precedence (job_field_shares→field_billing_defaults→customer_id) to prevent cross-tenant writes. Make
  `FieldDashboard.tsx` CropHistoryTab (638-691) editable (it's read-only today). Watch: don't let a future migration re-emit the
  crop_type-only trigger and clobber manual harvest_date edits.
- **A13 — reorder_point edit UI + below-reorder list (frontend + tiny mig).** InventoryPage already has an INLINE-editable
  reorder_point column (admin, undiscoverable) — the gap is: add `reorder_point`/`min_stock_level` inputs to the Add-Inventory
  modal (`InventoryPage.tsx` ~1371-1447) + a `p_reorder_point`/`p_min_stock_level` param on `manual_inventory_add` (parked mig,
  default 0/NULL-safe) + a "below reorder" list/panel. 0/114 rows set today (the ChemMan Reorder-Report gap).

## WAVE B — Phase 1 units (spec, only after Wave A ledgered)
`src/lib/units.ts` canonical module (fetch-once cached options from `unit_conversions`, one conversion helper; chemCalculator/
quoteCalc tables become derived) → rate-unit dropdowns (ProductDetail:470, JobDetail:2964/2986 with `unit` auto-derived,
field-app line editable UM, LabelReview, CropPrograms) → read-only unit-drift report for Mason → normalization UPDATE as a parked
migration (backfill BEFORE any enforcement) → normalize-on-save in BulkProductImport/BulkQuoteImport → E2E fixture/locator updates
in the same commits. FROZEN-KEYS rule: never rename `unit_conversions` rows; canonical/synonym columns are additive only.

---

## Cycle log (chronological)

> **PUSH NOTE:** the armed autopilot deliberately blocks ALL `git push` during an unattended run
> (`autopilot-lib.mjs:19` — "no unattended push — Mason reviews in the morning"). So every cycle
> commits LOCALLY only; **Mason reviews + pushes the branch when he's back**. Work is preserved in
> local commits on `fix/structure-wave-2026-07`. This overrides mission gate #4's per-cycle push
> (the mission also says keep autopilot armed — the autopilot design wins).

**Cycle 1 — A1 (blend product-select stale-closure):** DONE. Fixed `updateProduct` in
ManualTicketCreate.tsx + BlendTicketDetail.tsx to use the functional (`prev =>`) updater so the
two back-to-back setState calls compose. PROOF — Ran: added fail-first regression test; Saw: FAILS
on old closure code (`expected '' to be 'p1'`), PASSES with fix; typecheck clean; 8 blend tests green.
Codex (`--uncommitted`): "no introduced correctness issues." Commit `f9a4d7ee` (local; push deferred).

**Cycle 2 — A2 (save_blend_ticket persist job_id + application_service_id):** PARKED (drafted + proven +
Codex-clean; NOT applied). Rebuilt `save_blend_ticket` verbatim from live source (`20260608152631`, sole
overload) additively adding the two SET columns the UI already sends. PROOF — Ran: live rolled-back
`BEGIN … ROLLBACK` + `plpgsql_check`; Saw: NO FINDINGS - CLEAN (×3), live fn confirmed unchanged
(position()=0). Codex 3 rounds: R1 → added job/customer-match guard (mis-pricing risk via
`create_invoice_from_blend_ticket`→`job.quote_section_id`); R2 → validate EFFECTIVE job (sparse-payload
customer-change edge); R3 clean. Draft: `scripts/.staging-migrations/20260702130000_a2_...sql`.

**Cycle 3 — A3 (save_quote restore dropped fields):** PARKED (done, unapplied). *PARTIAL reproduction:
the mission's second A3 sub-task (create_job_from_quote_section idempotency `AND operation=`) is ALREADY
LIVE (20260611211058) — verified, NOT re-touched. Restored only what's actually broken: rebuilt save_quote
verbatim from live (`20260616204400`, 1 overload) additively adding `is_planned` (quotes UPDATE+INSERT) and
`section_header_notes`/`needed_by_date`/`field_id` (quote_sections INSERT). Payload keys confirmed vs
QuoteBuilder.tsx:889,898-900. PROOF — Ran: rolled-back live smoke + plpgsql_check; Saw: NO FINDINGS - CLEAN,
live fn unchanged (position()=0), 1 overload. Codex CLEAN + migration-drift-reviewer CLEAN (byte-for-byte
additive-only, all 4 columns/types verified). Draft: `...131000_a3_...sql`.

**Cycle 4 — A4 (create_quick_delivery tier-price $0 fallback):** migration PARKED (done); frontend
consolidation DEFERRED. The SERVER bug (bills $0 when a tier-2/3 customer's product has no tier2/3
price) is the real Tier-0 issue — fixed by cascading tier2/3→tier1 in BOTH pricing passes (verbatim
reproduction, 2 surgical CASE edits). PROOF — Ran: rolled-back smoke + plpgsql_check; Saw: NO FINDINGS -
CLEAN, live unchanged (position()=0), 1 overload. Codex CLEAN (matches create_direct_order's existing
pattern). **Frontend getTierPrice consolidation deferred (NOT a bug):** the audit's ~7 frontend cascades
already fall back to tier1, so post-server-fix client & server agree; a blind swap onto the `||`-based
shared helper risks changing money behavior at sites with deliberate `!= null` guards (JobDetail:2396/2410
NO-clobber guard; recipeHelpers:81 recipe-price-first). Needs a per-site pass — logged for follow-up.
Draft: `...132000_a4_...sql`.

**Cycle 5 — A14 (convert_to_gl_lb pint/quart aliases):** PARKED (done, unapplied). Added full-word
`PINT/PINTS`/`QUART/QUARTS` to the liquid branch so a 'pint'/'quart' rate_unit no longer previews a
gallon value on screen but saves NULL (client-shows / server-saves-NULL). PROOF — Ran: FUNCTIONAL
rolled-back smoke actually calling the fn; Saw: pint(8)=1.0 GL, pints(16)=2.0, quart(4)=1.0, quarts(8)=2.0,
PT/QT/gal unchanged, plpgsql_check CLEAN, live unchanged (position()=0). Codex CLEAN. Draft: `...133000_a14_...sql`.

**Cycle 6 — A6 (complete_job inventory unit conversion + shortfalls + DispatchBoard):** DONE (mig PARKED +
frontend committed). complete_job deducted rate-unit job_chemicals.quantity from inventory-unit
quantity_available UNCONVERTED (the "single worst correctness bug" — corrupts stock by the unit ratio).
Fixed by converting via `field_app_priced_quantity` into a new `v_deduct_qty` (HARD-RAISE
JOB_INV_UNIT_UNCONVERTIBLE on unconvertible — consistent w/ field-app side) used in all 5 inventory
writes; get_job_inventory_shortfalls converts demand (COALESCE fallback, read-only, no raise); DispatchBoard
stock-light converts via the TS `fieldAppPricedQuantity` mirror. Drafting+smoke delegated to a subagent w/
exact spec; I pre-reviewed the diff + independently confirmed no-persist (position()=0, 1 overload each).
PROOF — Ran: rolled-back plpgsql_check on both fns = NO FINDINGS - CLEAN; DispatchBoard typecheck+lint clean.
Codex CLEAN (both together). Draft: `...134000_a6_...sql`. **Behavior flag for Mason: blank/unknown job-chem
unit now hard-stops completion (intended guard).**

**Cycle 7 — A10 (email idempotency):** PARKED — investigated, did NOT apply (the audit's fix is unsafe).
I tried the audit's "drop Date.now() for a stable key" (as a per-minute bucket). Codex flagged a real
P2: the send-email edge fn dedups against `email_log` (PERMANENT) purely by key, so ANY stable/window key
SILENTLY blocks intentional resends (customer gets nothing, UI says "sent") — worse than an occasional
duplicate. Verified: `sendEmail` has NO auto-retry (single fetch), so a per-attempt nonce adds no dedup
either. AND the accidental-double-send the audit targets is ALREADY mitigated at the UI: the list pages
guard with `rowActionRef` ("a double-click can't fire two prints/emails") and InvoiceDetail disables the
button via `emailing`/`loading`. So the correct action was to REVERT and keep the unique-per-send key.
Real follow-up (if wanted): surface the edge fn's `deduplicated:true` in the UI — a UI concern, not a key one.

**Cycle 8 — A7 (PO on-order INSERT-path fix + recompute):** PARKED (done, unapplied). Root cause: the on-order
trigger fires only on a draft→submitted UPDATE, but `save_purchase_order` INSERTed POs directly as 'submitted',
skipping it → 16 products drifted (worst 0→9000, an under-count). Fix (delegated draft, my review + Codex):
**Option A insert-as-draft-then-promote** — save_purchase_order now INSERTs as 'draft' then UPDATEs to the
requested status, reusing the EXISTING tested trigger (structurally can't double-count; verified vs all 4 PO
triggers) + a one-time authoritative recompute. Codex R1 found 2 real issues → FIXED: [P1] a SHARE ROW EXCLUSIVE
lock so the recompute can't race concurrent PO writes; [P2] insert Main-Warehouse rows for open-PO products that
lack one (smoke proved 2 REAL such rows — Codex was right). PROOF — Ran: rolled-back plpgsql_check (CLEAN) +
recompute smoke (total 116, 16 changed, 2 inserted); Saw: live still 114 rows, save_purchase_order 1 overload +
promote-block absent (position()=0). Codex R2 clean on the fixes; raised a SEPARATE latent location-mismatch
(increment@MainWarehouse vs receive-decrement@received-location) — DOCUMENTED as a warehouse-theme follow-up (not
a bug in A7's scope; latent since all inventory is single-location). Draft: `...135000_a7_...sql`.

**Cycle 9 — A12 (field crop-history editor + upsert RPC):** DONE (mig PARKED + frontend committed). Grounded vs
live: `field_crop_history` (id/field_id/season/crop_type/variety/planting_date/harvest_date/yield_per_acre/
yield_unit/notes; NO updated_at) had NO write path for harvest_date/variety/yield/notes — the only writer is the
`snapshot_field_crop_history` trigger (crop_type-only, `ON CONFLICT (field_id, season)`). Built a new
`save_field_crop_history` SECDEF upsert RPC on the live unique index `idx_field_crop_history_unique (field_id,
season)` — strict-actor + role gate **admin/sales_rep** (mirrors the live INSERT/UPDATE RLS; applicator is
SELECT-only), `check_idempotency`/`save_idempotency`, `compute_season` fallback, anon revoked. Made the
FieldDashboard Crop History tab editable (Add Entry + per-row pencil → modal → RPC → refetch), gated to
admin/sales_rep. PROOF — Ran: live tx aborted via summary RAISE (nothing persisted; live pg_proc count=0);
plpgsql_check = NO FINDINGS - CLEAN; typecheck+lint+build clean. Codex R1 found a real **[P2] data-loss**: a blank
"Add" on a season that already has a row upserts NULLs over its variety/dates/yield/notes → FIXED (Add now only
offers seasons with no row + a handleSave guard; edit-existing goes through the pencil, which prefills). Codex R2:
data-loss P2 RESOLVED; remaining note is the expected parked-coupling (see apply-order). Draft:
`...140000_a12_...sql`. Type bridge: added a PENDING `save_field_crop_history` entry to the generated `supabase.ts`
(regenerate after apply) + 2 new error tokens (FIELD_NOT_FOUND / CROP_TYPE_REQUIRED) in `db.ts`.

**Cycle 10 — A13 (reorder point at inventory creation):** DONE (mig PARKED + frontend committed). Grounding
CORRECTED the audit's scope: the "below-reorder list/panel" ALREADY EXISTS (InventoryPage's vendor-grouped
"ACTION REQUIRED — Reorder Alerts" card + the "Needs Reorder" filter chip), and reorder_point/min_stock_level are
ALREADY inline-editable (admin). The ONLY real gap = you can't set them when *creating* a record, so new rows sit
at 0/0 (why 0 rows have a reorder point). Fix: `manual_inventory_add` DROP+CREATE (not a 2nd overload) adding two
optional params `p_reorder_point`/`p_min_stock_level` (GREATEST(COALESCE(.,0),0)), grants re-applied
(authenticated only; anon not granted) + two inputs in the Add-Inventory modal. PROOF — Ran: live tx aborted via
RAISE — after DROP+CREATE exactly ONE overload in-tx; plpgsql_check CLEAN except a benign 'never read variable
v_existing' extra-warning verified IDENTICAL on the live 8-arg fn (inherited verbatim, not introduced); live
manual_inventory_add unchanged (still 8-arg); typecheck+lint+build clean. Codex CLEAN on the SQL; R2 note = the
expected parked-coupling. Draft: `...141000_a13_...sql`. Type bridge: added p_reorder_point?/p_min_stock_level? to
the generated `manual_inventory_add` Args (regenerate after apply).

**APPLY-ORDER + COUPLING (A12 & A13) — READ BEFORE SHIPPING:** each item's frontend depends on its migration, and
Codex R2 (correctly) flagged that a frontend deployed AHEAD of its migration would 404 the new call. Both
migrations are **migration-first safe**, so the order is: (1) apply `20260702140000_a12` + `20260702141000_a13`
via the gated MCP path (both additive/backward-compatible — the live app keeps working), (2) regenerate the
supabase types, (3) THEN merge/deploy the frontend. Never deploy the FieldDashboard/InventoryPage frontend before
the two migrations are live.
