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
| A1 | Blend product-select stale-closure bug | frontend | | TODO | | | |
| A2 | save_blend_ticket persists job_id + application_service_id | parked mig | | TODO | | | |
| A3 | save_quote restore dropped fields + create_job_from_quote_section idempotency | parked mig | | TODO | | | |
| A4 | create_quick_delivery tier-price $0 fallback + shared getTierPrice | parked mig + frontend | | TODO | | | |
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
