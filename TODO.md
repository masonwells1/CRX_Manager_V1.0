# CRX Manager — Combined TODO (as of 2026-07-16)

The single combined list of everything still open, in priority order.
Built 2026-07-16 from a full docs review with subagent verification of every
"done" and "open" claim against the code on disk and the live database.

- Shipped history → `docs/CHANGELOG.md`
- Full detail on parked findings/migrations → `docs/manual/KNOWN_ISSUES.md` (canonical for agents)
- Strategic direction + engineering ticket board → `docs/roadmap/2026-07-15-roadmap-and-execution-plan.md`

When an item here ships or is decided, update this file AND `docs/manual/KNOWN_ISSUES.md`.

---

## 🔴 1. Owner actions (needs Mason — ranked by value unblocked)

1. **Re-base the 18 negative-inventory products** — verified live 2026-07-16
   (`inventory.quantity_available < 0` = 18 rows). Blocks clean deliveries. Bring
   physical counts; worksheet: `docs/operations/2026-06-10-negative-inventory-rebase-worksheet.md`.
   Note: this has been stalled since mid-May (`docs/reports/cleanup-sprint-progress.md`).
2. **Run a real billing cycle in the app** — order → delivery → invoice → post →
   payment. Live DB still shows **0 payments** (10 invoices: 8 draft / 2 posted).
   Deliveries ARE flowing now (106 live). Afterward ask for the money-audit re-run
   (`/foundation-ultra-review`) — all prior money audits were vacuously clean on empty data.
3. **Create a Stripe account** (~15 min) and hand over API keys — unblocks A1
   ACH pay-now links (the #1 competitive gap) and later portal payments.
4. **Label data load + EPA backfill approval** — 0 of ~604 products have full
   label data; ~105 of 204 stored EPA reg numbers are wrong. The `/label-data-quality`
   tool (shipped) makes this data-entry. Gates the whole compliance track.
5. **Decision packets** (details in `docs/loops/owner-decisions-2026-07.md` + KNOWN_ISSUES §3):
   junk-data deletes · vendor-name merges · category remap · due-date/Net-30 policy ·
   wire-vs-retire on 5 dead structures (incl. #40 orphaned RPC) · "wire" as payment method ·
   #107 auto-draft-on-applicator-completion policy · Sprint D3 halves (blend commission
   mint + `jobs.commission_split` visibility) · live-data cleanup (8 SEED commission
   batches, PO-2026-0008/0015, 5 empty deliveries, 1 E2E invoice).
6. **Send ~10 real vendor bills + Anthropic API key** — unblocks the D1 extraction pilot.
7. **Supabase Pro / PITR decision + run the first `/backup-db`** — FREE plan today;
   only ONE in-DB snapshot run exists (verified live) and no off-repo dump has been
   taken via `/backup-db` yet. Also gates leaked-password protection (L4).
8. **Backup restore drill** — one-time restore to a throwaway project to prove recovery works.
9. **Create staging Supabase project + GitHub secrets** — unblocks the parked E2E CI lane.
10. **Unused-index decision (from 2026-05-11)** — 159 unused-index findings awaiting a
    keep/drop call: `docs/2026-05-11-unused-index-report.txt`. Low risk to defer further.
11. **Workstation `psql` + `SUPABASE_DB_URL` credentials** — unblocks the strict
    DB-sweep/advisor lane (gauntlet ledger MED-2).
12. **Sell-side in-app smoke with real eyes** — ship-now/price-later, draft-invoice
    consolidation, open-booking rollover.
13. **Dispatch backfill (optional call)** — currently a verified no-op (0 matching jobs);
    parked migration re-checks the count before doing anything.

## 🔧 2. Engineering — Now / Next (see the 2026-07-15 execution plan for the full board)

- **Gauntlet close-out (T3)** — most July-14/15 HIGHs verified applied live this pass
  (incl. the three commission/prepay-admin migrations, re-stamped as live versions
  `20260715134551/134618/134629`). Remaining: re-run gauntlet §5–§8 from fresh main to
  confirm closure with live evidence. ~~T1 registry regen~~ **DONE** (verified fresh at
  high-water `20260715203911`). ~~T2 ledger/docs update~~ **DONE in this cleanup.**
- **Offline Stage 1B real-phone proof (T5/N3)** — browser rollout is live; run the
  on-device proof (lost-response recovery, two-tab replay, office resolution) with `[E2E]` fixtures.
- **Dead-structure retirement batch (T4)** — `setup-blend-tickets-storage` edge fn
  (still deployed v18 ACTIVE, zero callers — needs an approved retirement session);
  #40 RPC after Mason's wire-vs-retire call. (U12/U13 stale drafts: already deleted.)
- **X1 Stripe ACH pay-now links** — after owner action 3.
- **X2 EPA backfill Waves 4–5 execution** — after owner action 4.
- **X3 REI/PHI tracking + dispatch warnings (B4/T8), then dicamba 72-hr auto-draft (B2/T9)**.
- **X4 field-level profitability (E4/T10)** — verified not built yet.
- **X5 portal prework (P1 customer-org model, P3 server-side PDFs)** — before any portal UI.
- **X6 vendor-bill extraction pilot (D1/T13)** — after owner action 6.
- **#117** — `auto_draft_skipped` activity-feed row (small; verified not built).
- **F3 WebP for `process-document`** — was blocked on a transient deploy 500 on 2026-07-10;
  all 7 edge fns were redeployed 2026-07-12 (CORS fix), so this is **likely already live —
  verify the deployed version includes the WebP change before re-deploying**.

## 🅿️ 3. Parked / deferred on purpose (pointers — KNOWN_ISSUES has full detail)

- **Billing Feature B** (per-delivery split invoicing) — design BLOCKER: residual-ledger
  redesign needed. `docs/audits/split-billing-B-perdelivery-design-2026-07-10.md`
- **Earmark engine** — shelved; 3 migrations in `docs/roadmap/shelved-earmark-engine/`
  must NOT be applied as-is; needs reserved-pool redesign.
- **Prepay bulk-apply** — hard-disabled in prod (`PREPAY_BULK_APPLY_DISABLED`); real fix
  is the reserved-pool redesign above.
- **Grower portal** — deferred until P1/P3 prework + A1 click-through data. Vision docs
  live in `docs/plans/` (grower-portal brainstorm + 2 design/grounding docs).
- **EPA Stage 2 (OCR REI/PHI auto-fill)** — deliberately deferred safety trap.
- **H2 migration-baseline squash** (791 live migrations) — quiet window only.
- **Offline deferred list** — signature/photo persistence, notification replay, cross-tab
  Web Locks, more operations, auto device-discovery of office resolutions (KNOWN_ISSUES §5).
- **`apply_prepay_to_invoice` hand-decrement cleanup** — drop only after more prod watching.
- **Customer RLS upper bound** (far-future job visibility) — left as-is on purpose.
- **4 MEDIUM + ~11 LOW parked bug-hunt findings** — `docs/audits/overnight-bug-hunt/LEDGER.json`
  (transfer_job_to_invoice actor binding, save_field_app_invoice row-lock, prepay status
  check (moot while bulk-apply disabled), commission-pay-picker blanks; plus LOWs incl.
  C11/C23 inline-idempotency cleanups).
- **Guard-system hardening backlog** — KNOWN_ISSUES §4b (accepted residuals + sweep ideas).

## 🆕 4. Surfaced by the 2026-07-16 docs review (previously untracked anywhere)

- **Sprayer-packet feature** — `docs/plans/sprayer-packet-feature-todo.md`. Never built;
  "awaiting design pass — do NOT start without explicit Mason approval." Decide: schedule or drop.
- **Month-end close picker UI** — the A9 month/year picker was deferred after Codex
  surfaced a period-switch concurrency class; committed as WIP branch-only, never
  prod-ready, never rebuilt (recorded in the structure-fix ledger — archived to
  `docs/archive/2026-summer-closeout/loops/` — and `docs/loops/structure-wave-2-ledger.md`).
  Decide: rebuild test-first or drop.
- **Split-billing architecture decision** — the app has FOUR parallel split mechanisms
  (`order_shares`, `order_item_field_allocations`, `field_app_location_shares`,
  `job_field_shares`) + a dead twin (`order_line_allocations`) and TWO as-applied stores.
  Flagged (app-wide structure audit, 2026-07-01) as needing a design decision **before the
  first real billing season** — increasingly urgent now that real deliveries are flowing.
- **Scheduling-office Phase 4/5 leftovers** (product-units deep-dive, 2026-07-01, never
  confirmed shipped): calendar/day dispatch board with per-applicator lanes + drag-to-reschedule,
  duplicate-job/job templates, forecast weather strip, auto-seed invoice applied-acres.
- **Future-projects Tier-1 idea backlog** (2026-06-19 idea mining, unscheduled): soil-test
  record capture · audit-grade application record (partially shipped via #106) · prompt-pay
  discount terms · compliance document vault · application-time compliance check ·
  duplicate-customer detection. Plus the open-source comparison backlog
  (`docs/research/2026-06-19-future-projects-open-source-comparison.md`).

## 🚫 Not building (settled — don't re-add without new evidence)

Native apps · multi-tenancy now · ML forecasting · autonomous AI on financial records ·
QuickBooks two-way sync · grain/energy/feed modules · big-bang UI redesign · role-workspace
IA before portal+mobile usage data · re-enabling prepay bulk-apply · applying shelved
earmark migrations as-is · broad offline money mutations.

---

## 📋 Status snapshot (verified live 2026-07-16)

| Metric | Value |
|---|---|
| Live migrations | 791 (disk has fewer — pre-existing drift, not a bug) |
| Edge functions | 7 ACTIVE (create-user v23, process-blend-ticket v25, process-document v18, send-email v17, reset-user-password v15, epa-lookup v4, setup-blend-tickets-storage v18 ← retirement pending) |
| Schema registry | FRESH — high-water `20260715203911` (= latest live migration) |
| customers / products | 153 / 604 |
| fields / quotes / orders | 5 / 3 / 63 |
| invoices | 10 (8 draft, 2 posted) |
| payments | **0** |
| jobs / deliveries | 4 / **106** (2026-07-13 snapshot had these reversed) |
| blend_tickets | 0 |
| negative inventory rows | 18 |
| In-DB backup runs | 1 (weekly pg_cron live) — off-site `/backup-db` dump: none yet |
| Production | croprxsolutions.app — `main` merges deploy via PR only (branch protection) |

## ✅ Verified done this pass (don't re-do)

- Schema registry regen (T1) — fresh at `20260715203911`.
- 2026-07-14 workflow-review HIGH (deactivated-admin commission access): all 3 fix
  migrations **applied live 2026-07-15** (names `20260714185129/185130/185631`, live
  versions `20260715134551/134618/134629`). `migration-history.md` corrected this pass.
- Business-workflow findings **#106 + #109** — shipped live 2026-07-06 (`20260707050000`);
  KNOWN_ISSUES corrected this pass. Still open from that review: #40 (owner), #107 (owner), #117 (small build).
- U12/U13 stale drafts — deleted (2026-07-15); do not re-apply.
- The 5 originally-HIGH overnight-hunt money findings — all fixed live 2026-06-21/22.
- ROADMAP.md done-claims spot-checked against code — all verified real (Team Board F-items,
  WPS PDF, `/label-data-quality`, `/my-route`, unbilled reconciliation view).
