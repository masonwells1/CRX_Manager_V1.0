# Structure-Fix Loop — Ledger

**Branch:** `fix/structure-wave-2026-07` (worktree `C:\CRX_StructureFix`) · **Started:** 2026-07-02
**Mission:** [structure-fix-loop-2026-07-02.md](structure-fix-loop-2026-07-02.md)
**Live high-water at start:** `20260701205341` · **Baseline:** typecheck + build clean, tests 3106 pass / 122 skip (GREEN)

> **HANDOFF (kept at top; filled in at end):** apply-order for parked migrations · decision packet pointer · plain-English summary for Mason.

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
| A5 | Blend unit conversion (3 RPCs) + OCR ratePerAcre carry + $0-rate guard | parked migs + edge-fn | | TODO | | | |
| A6 | complete_job inventory unit conversion + shortfalls + DispatchBoard | parked mig + frontend | | TODO | | | |
| A7 | PO single write path + quantity_on_order recompute (604-product diff) | parked mig + frontend | | TODO | | | |
| A8 | Terms→due-date (payment_terms_days + post_invoice default) — needs Mason policy | parked mig + frontend | | TODO | | | |
| A9 | Month-end catch-up — needs Mason confirm | parked mig + frontend | | TODO | | | |
| A10 | Email idempotency: stable intent-scoped keys | frontend/lib | | TODO | | | |
| A11 | Wire get_expiring_planned_holds into Dashboard/ActionQueue | frontend | | TODO | | | |
| A12 | PHI guardrail writer: field crop-history editor + upsert RPC | frontend + parked mig | | TODO | | | |
| A13 | reorder_point edit UI + below-reorder list | frontend | | TODO | | | |
| A14 | convert_to_gl_lb pint/quart aliases | parked mig | | TODO | | | |

## WAVE B — Phase 1 units (only after Wave A fully ledgered)
| Item | Status | Note |
|---|---|---|
| units.ts canonical module → dropdowns → drift report → normalize (parked) → importers → E2E | TODO | |

## Decision packets (docs only, no code)
| Packet | Status | Note |
|---|---|---|
| owner-decisions-2026-07.md (6 packets) | TODO | vendor/mfr merge · category remap · junk-delete · due-date policy · wire-vs-retire · 'wire' payment method |

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
