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

> ### ⏰ DEADLINE ITEM — test the pricing/repricing path before sales season
>
> **Added 2026-09-02 at Mason's request** ("this all needs tested before we start sales season —
> I don't have time now"). Deferred deliberately; it is **not** blocked and **not** forgotten.
>
> **What needs testing:** the full bulk-reprice path end to end, with real eyes, on real costs —
> Products → **"Pricing .xlsx"** → edit costs/margins in Excel → **"Review Pricing File"** →
> preview → approve → confirm tier prices moved correctly on live products.
>
> **Why it is dated rather than "someday":** margins are computed from `products.current_cost`, and
> that cost basis is stale. Verified live 2026-09-02 — of 604 `product_cost_basis` rows, **602 are
> the original `migration_baseline` load** (`effective_from` 2026-03-04 → 2026-07-18); exactly one
> came from a supplier price selection and one from a product-page override. **No cost of any kind
> has moved since 2026-07-18.** Every margin, profitability, and commission figure is therefore
> computed against costs up to six months old. Repricing into a season on stale costs is the
> expensive version of this bug.
>
> **What is already proven, so nobody rebuilds it:** the tooling exists and works. A real round trip
> ran on 2026-09-02 — exported a workbook, edited a cost and a price through Excel, parsed it back,
> and both edits came through on the right rows with money preserved as exact decimals and Excel
> formulas detected rather than silently applied. Repo tests pass (14). Both RPCs are live
> (`preview_product_cost_basis_changes`, `apply_product_cost_basis_change_set`). Row cap is 5,000,
> well above the ~604-product catalog. **The gap is adoption and a real-data test, not construction.**
>
> Usage to date: **one** workbook export and 4 changed rows, all on 2026-08-18.
>
> Detail: `docs/manual/KNOWN_ISSUES.md` and the item-4 label-data entry below (same catalog, same
> data-entry bottleneck — worth doing in one sitting).

1. ~~**Re-base the 18 negative-inventory products**~~ — **⏸ DEFERRED by Mason 2026-07-16**
   ("skip and don't worry about it for now"). The 18 rows (verified live:
   `inventory.quantity_available < 0`) stay as-is until he brings physical counts;
   worksheet: `docs/operations/2026-06-10-negative-inventory-rebase-worksheet.md`.
   Deliveries are flowing despite it, so nothing is hard-blocked today. Don't re-raise
   as the top action — revisit only when Mason asks or a delivery actually fails on it.
2. **Run a real billing cycle in the app** — order → delivery → invoice → post →
   payment. Live DB still shows **0 payments** (10 invoices: 8 draft / 2 posted).
   Deliveries ARE flowing now (106 live). Afterward ask for the money-audit re-run
   (`/foundation-ultra-review`) — all prior money audits were vacuously clean on empty data.
3. **Create a Stripe account** (~15 min) and hand over API keys — unblocks A1
   ACH pay-now links (the #1 competitive gap) and later portal payments.
4. **Label data load + EPA backfill approval** — 0 of ~604 products have full
   label data; ~105 of 204 stored EPA reg numbers are wrong. The `/label-data-quality`
   tool (shipped) makes this data-entry. Gates the whole compliance track.
5. **Decision packets** (details in `docs/loops/owner-decisions-2026-07.md` + KNOWN_ISSUES §3).
   **Decided 2026-07-16:** due dates = Net 30 + override (build spec in
   `docs/plans/invoice-due-dates-net30-spec-2026-07-16.md`) · dead structures = KEEP
   (planned features) · "wire" = already live (stale packet) · junk data = keep test
   entities tagged `[E2E]` (tagging done live).
   **Still open:** vendor-name merges · category remap · #107 auto-draft-on-applicator
   policy · Sprint D3 halves (blend commission mint + `jobs.commission_split` visibility) ·
   true-junk deletes awaiting line-item OK (8 gibberish blend recipes, 4 zero-link customer
   rows, vendor `we`, ~5 bad emails, 8 SEED commission batches, PO-2026-0008/0015,
   5 empty deliveries, 1 E2E invoice).
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

> ### ⏰ DEADLINE ITEM — restore "as of a past date" commission reporting
>
> **Added 2026-09-03 at Mason's request.** He was asked directly whether he uses historical
> commission dates and said **"Yes I want to be able to look at historical dates."** Deferred
> deliberately ("we are not going to patch it now"), **not** dropped.
>
> **Must land BEFORE the first commission payout of the season** — Mason put that at *"probably a
> few months out"* on 2026-09-03. Confirm the real date with him; don't assume.
>
> **What happened:** migration `20260831162000` (PR #535) makes
> `get_commission_balance_report` refuse any as-of date that is not Chicago-today. That is the
> right call — the old answer was silently wrong, because `commissions` keeps only *current*
> status, so a commission paid in July reported as "already paid" in a June run. The refusal is a
> stopgap; restoring the capability properly is this item.
>
> **Why it is dated rather than "someday" — the window is open and closing.** Verified live
> 2026-09-03: **35 commissions (33 pending, 2 cancelled, 0 paid), 8 commission_payments (all
> unposted), and 0 commission_payment_items.** Nothing has ever been paid, so there is no history
> to reconstruct and nothing is lost by building it now. Build it after a season of payouts and
> everything before that point is **permanently unrecoverable** — the data will never have existed.
>
> **What already exists, so nobody scopes a rebuild:** the dated payment ledger is already there
> and already the right shape. `commission_payments` has `payment_date`, `posted_at` and a
> `unposted|posted|voided` status; `commission_payment_items` links payments to commissions with
> amounts. `create_/post_/void_commission_payment` are live, and so is
> `src/pages/CommissionPayments.tsx`. **The gap is two missing dated columns and a report that
> reads current status instead of the ledger — not a new subsystem.**
>
> **The two real gaps:** `commission_payments` has no `voided_at` (so a void's timing is
> unrecoverable), and `commissions` has no `cancelled_at` (the 2 existing cancelled rows have
> already lost their date — accept that, don't invent one).
>
> Full spec, acceptance criteria, and the fallback if the window has closed:
> `docs/plans/commission-history-as-of-reporting-spec-2026-09-03.md`.
>
> **Open question for Mason, asked 2026-09-03 and not yet answered:** what does he use a
> historical commission balance *for* (year-end, point-in-time liability, payout reconciliation)?
> It decides whether this is a date picker on the existing report or a dated per-recipient
> statement.

- **Gauntlet close-out (T3)** — most July-14/15 HIGHs verified applied live this pass
  (incl. the three commission/prepay-admin migrations, re-stamped as live versions
  `20260715134551/134618/134629`). Remaining: re-run gauntlet §5–§8 from fresh main to
  confirm closure with live evidence. ~~T1 registry regen~~ **DONE** (verified fresh at
  high-water `20260715203911`). ~~T2 ledger/docs update~~ **DONE in this cleanup.**
- **Offline Stage 1B real-phone proof (T5/N3)** — browser rollout is live; run the
  on-device proof (lost-response recovery, two-tab replay, office resolution) with `[E2E]` fixtures.
- **Dead-structure retirement batch (T4)** — now only the `setup-blend-tickets-storage`
  edge fn (still deployed v18 ACTIVE, zero callers — needs an approved retirement session).
  The #40 RPC + other dead structures are **KEEP per Mason 2026-07-16** (planned features).
- ~~**Invoice due dates — APPROVED 2026-07-16**~~ — **SHIPPED 2026-07-21** (PR #195):
  investigation showed the A8 stamping/aging machinery was already live; shipped the two real
  gaps — due-on-receipt parser support (migration `20260721191914`, applied live) + the
  Net 30/Net 15/Due on receipt/Custom terms picker on FieldApplicationInvoice.
  **Chemical-sale follow-up SHIPPED 2026-07-21** (PR #197 + migration `20260721223817`, applied
  live): save_invoice now persists payment_terms; same picker on InvoiceDetail; single + batch
  PDFs print the invoice override. The approved due-dates spec is now fully complete.
- **Per-line-item custom split billing (field-app)** — SPEC COMPLETE, review-hardened (3 advisor
  passes), **not started; Mason builds in Codex next week.** Default splits from field ownership,
  override %/price per invoice line, one invoice per customer, unpost reversible, $0 recorded-but-unsent.
  Spec: `docs/plans/per-line-item-split-billing-spec-2026-07-17.md`. Build §6.1 (baseline real-billing
  cycle) FIRST, then schema→calculator→RPC behind a feature flag. This is the settled resolution of the
  split-billing architecture decision (§4).
- **X1 Stripe ACH pay-now links** — after owner action 3.
- **X2 EPA backfill Waves 4–5 execution** — after owner action 4.
- **X3 REI/PHI tracking + dispatch warnings (B4/T8), then dicamba 72-hr auto-draft (B2/T9)**.
- **X4 field-level profitability (E4/T10)** — verified not built yet.
- **X5 portal prework (P1 customer-org model, P3 server-side PDFs)** — before any portal UI.
- **X6 vendor-bill extraction pilot (D1/T13)** — after owner action 6.
- **#117** — `auto_draft_skipped` activity-feed row — **BUILT 2026-07-21** (migration
  `20260722012359_auto_draft_skipped_activity_row.sql`, PR #199); **APPLIED LIVE 2026-07-21** (ledger `20260722012359`).
- ~~**F3 WebP for `process-document`**~~ **RESOLVED — verified 2026-07-16:** the deployed
  v18 source contains the WebP/BMP/TIFF magic-byte allow-list (commented "Codex bug-hunt
  F3"); the 2026-07-12 CORS redeploy carried it live. No redeploy needed.

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
- **~11 LOW parked bug-hunt findings** — `docs/audits/overnight-bug-hunt/LEDGER.json`
  (incl. C11/C23 inline-idempotency cleanups). **2026-07-21 sweep of the 4 parked MEDIUMs:**
  transfer_job_to_invoice actor binding = FIXED LIVE (strict-actor guard verified in the live
  body); save_field_app_invoice row-lock = FIXED LIVE (locking wrapper, July split-billing
  hardening); commission-pay-picker blanks = FIXED on main (fetchUnpaid resolves via FK
  lookups); prepay status check stays MOOTED while bulk-apply is hard-blocked.
- **Guard-system hardening backlog** — KNOWN_ISSUES §4b (accepted residuals + sweep ideas).

## 🆕 4. Surfaced by the 2026-07-16 docs review (previously untracked anywhere)

- **Sprayer-packet feature** — `docs/plans/sprayer-packet-feature-todo.md`. Never built;
  "awaiting design pass — do NOT start without explicit Mason approval." Decide: schedule or drop.
- **Month-end close picker UI** — the A9 month/year picker was deferred after Codex
  surfaced a period-switch concurrency class; committed as WIP branch-only, never
  prod-ready, never rebuilt (recorded in the structure-fix ledger — archived to
  `docs/archive/2026-summer-closeout/loops/` — and `docs/loops/structure-wave-2-ledger.md`).
  Decide: rebuild test-first or drop.
- ~~**Split-billing architecture decision**~~ — **DECIDED 2026-07-17.** The FOUR parallel split
  mechanisms are settled: the **field-application-invoice path is the surface** we build on; the
  order-side engine (`order_shares` / `order_item_field_allocations` / `create_split_invoices_from_order`)
  is unproven → retire later; `order_line_allocations` (dead twin) drops after its delete-refs go. Chosen
  direction = **per-line-item custom splits on the field-app path** (see Engineering §2 + spec).
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
| negative inventory rows | 18 (re-base DEFERRED by Mason 2026-07-16) |
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
