# CRX Manager — Combined TODO (statuses last corrected 2026-09-26)

The single combined list of everything still open, in priority order.
Built 2026-07-16 from a full docs review with subagent verification of every
"done" and "open" claim against the code on disk and the live database. Items were added
through 2026-09-03, and stale statuses were corrected on 2026-09-26. A live count inside an
item is as of the date that item states.

- Shipped history → `docs/changelog.d/` (one file per change; `docs/CHANGELOG.md` holds entries up to 2026-08-27)
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
   ("skip and don't worry about it for now"). The 18 rows (verified live 2026-07-16:
   `inventory.quantity_available < 0`; 19 when re-verified 2026-08-08 per KNOWN_ISSUES §1) stay as-is until he brings physical counts;
   worksheet: `docs/operations/2026-06-10-negative-inventory-rebase-worksheet.md`.
   Deliveries are flowing despite it, so nothing is hard-blocked today. Don't re-raise
   as the top action — revisit only when Mason asks or a delivery actually fails on it.
2. **Run a real billing cycle in the app** — order → delivery → invoice → post →
   payment. Live DB showed **0 payments** on 2026-07-16 (10 invoices: 8 draft / 2 posted).
   Deliveries ARE flowing now (106 live). Afterward ask for the money-audit re-run
   (`/foundation-ultra-review`) — all prior money audits were vacuously clean on empty data.
3. **Create a Stripe account** (~15 min) and hand over API keys — unblocks A1
   ACH pay-now links (the #1 competitive gap) and later portal payments.
4. **Label data load + EPA backfill approval** — 0 of ~604 products have full
   label data; ~105 of 204 stored EPA reg numbers are wrong. The `/label-data-quality`
   tool (shipped) makes this data-entry. Gates the whole compliance track. A June 2026 filled
   research draft (`docs/plans/CRX-label-data-FILLED-DRAFT-2026-06-14.csv`, removed 2026-09-26)
   can be recovered from git history as a starting point: `git show e81853970:docs/plans/CRX-label-data-FILLED-DRAFT-2026-06-14.csv` (the last `main` commit before the removal).
5. **Decision packets** (details in `docs/loops/owner-decisions-2026-07.md` + KNOWN_ISSUES §3).
   **Decided 2026-07-16:** due dates = Net 30 + override (build spec in
   `docs/plans/invoice-due-dates-net30-spec-2026-07-16.md`, removed 2026-09-26, in git history) · dead structures = KEEP
   (planned features) · "wire" = already live (stale packet) · junk data = keep test
   entities tagged `[E2E]` (tagging done live).
   **Still open:** vendor-name merges · category remap · #107 auto-draft-on-applicator
   policy · Sprint D3 halves (blend commission mint + `jobs.commission_split` visibility) ·
   true-junk deletes awaiting line-item OK (8 gibberish blend recipes, 4 zero-link customer
   rows, vendor `we`, ~5 bad emails, 8 SEED commission batches, PO-2026-0008/0015,
   5 empty deliveries, 1 E2E invoice).
6. **Send ~10 real vendor bills + Anthropic API key** — unblocks the D1 extraction pilot.
7. **Supabase Pro / PITR decision + run the first `/backup-db`** — FREE plan today;
   only ONE in-DB snapshot run existed (verified live 2026-07-16) and no off-repo dump has been
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

> ### ✅ COMPLETED LIVE — restore "as of a past date" commission reporting
>
> **Added 2026-09-03 at Mason's request.** He was asked directly whether he uses historical
> commission dates and said **"Yes I want to be able to look at historical dates."** Deferred
> deliberately ("we are not going to patch it now"), then reopened for implementation on
> 2026-09-03. Migration `20260903150100_ledger_backed_commission_history` was applied live the same
> day as ledger version `20260903202611`; exact reports begin on `2026-09-04` Chicago time. The
> source merged to `main` in PR #592 on 2026-09-08.
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
> **Why it is dated rather than "someday" — the payout window is open and closing.** Verified live
> 2026-09-03: **35 commissions (33 pending, 2 cancelled, 0 paid), 8 commission_payments (all
> unposted), and 0 commission_payment_items.** Nothing has ever been paid, so no payout history
> needs reconstruction. However, earlier earned-state versions were never recorded and cannot be
> reconstructed honestly. The migration therefore captures an opening observation at its real
> cutover time and refuses every earlier date. Build it after a season of payouts and payout history
> before that point is also **permanently unrecoverable**.
>
> **What already exists, so nobody scopes a payout rewrite:** payment headers and immutable item
> amounts are already there. `commission_payments` has `payment_date`, `posted_at` and a
> `unposted|posted|voided` status; `commission_payment_items` links payments to commissions with
> amounts. `create_/post_/void_commission_payment` are live, and so is
> `src/pages/CommissionPayments.tsx`. The remaining gap requires durable event history: an immutable
> cutover record, earned-state snapshots, signed post/void events, and reports that read those facts.
>
> **Candidate solution:** add `commission_payments.voided_at`/`voided_by`,
> `commissions.cancelled_at` plus an exact bigint-cent pre-cancellation snapshot, an immutable
> cutover record, and two append-only bigint-cent event ledgers. Runtime events use wall-clock
> transition time; the report exposes aggregate and per-payment detail from the ledgers only. The
> first supported cutoff is the first complete Chicago day after cutover. Earlier dates fail closed,
> and the 2 existing cancelled rows enter the opening observation as excluded legacy states. The
> apply day itself is deliberately unavailable in Reports until the next Chicago day. The 8 empty
> `SEED-*` payment headers were already unpostable under the live posting function's empty-batch
> guard; this migration leaves them unchanged. New payout creation fails immediately for a
> negative item or a payment date before its commission's order date. Canonical zero-dollar
> commissions remain settleable and change from pending to paid only when a signed settlement
> event exists.
>
> **Proof/status 2026-09-03:** the first candidate's PostgreSQL 17 proof passed, but exact-SHA and
> Claude reviews correctly rejected its backdated opening state. The corrected migration uses a real
> immutable cutover and passed renewed PostgreSQL 17, exact-SHA, RLS, drift, and Claude review gates
> before its guarded live apply. Postflight found 35 opening states (33 baseline, 2 legacy excluded),
> zero settlement events, and no live `[E2E]` fixture writes. Source merged in PR #592 (2026-09-08).
>
> Full spec, acceptance criteria, and the fallback if the window has closed:
> `docs/plans/commission-history-as-of-reporting-spec-2026-09-03.md` (removed 2026-09-26 — the feature is live;
> it remains in git history, and its one unrun acceptance check is in §5 "Proof still owed").
>
> **ANSWERED 2026-09-03 — treat this as a financial-reporting requirement, not a convenience.**
> Asked what he uses it for, Mason said: *"year end, checking what I owed and reconciling payouts —
> all of it. It is very important to have this."* So it needs per-payment reconciliation detail,
> not just per-recipient aggregates, and a year-end figure must return the **same answer when
> re-run next year** — which is precisely what the current-status implementation cannot do.
> The first payouts (≈2026-11/12) land near year-end 2026, so the first year-end that needs this
> is likely the first one with payouts in it.
>
> **Verified 2026-09-03:** `_post_commission_payment_intent_impl_20260809` and
> `_void_commission_payment_intent_impl_20260809` already write `commission_payment_items` and
> maintain `commissions.paid_date`. Those operational rows remain inputs, but stable reporting also
> needs the candidate's immutable cutover and event ledgers; current mutable rows alone are not history.

- **Gauntlet close-out (T3)** — most July-14/15 HIGHs verified applied live in the 2026-07-16 pass
  (incl. the three commission/prepay-admin migrations, re-stamped as live versions
  `20260715134551/134618/134629`). Remaining: re-run gauntlet §5–§8 from fresh main to
  confirm closure with live evidence. ~~T1 registry regen~~ **DONE** 2026-07-16 (the registry has been
  regenerated since; see the status snapshot below). ~~T2 ledger/docs update~~ **DONE 2026-07-16.**
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
- ~~**Per-line-item custom split billing (field-app)**~~ — **SHIPPED AND LIVE 2026-07-21** (PR #164;
  migrations `20260720213000` / `20260720214000` / `20260720233000` are in the live ledger; the
  `per_line_split_billing_enabled` flag has been ON since 2026-07-21 — KNOWN_ISSUES §0). Default splits
  from field ownership, override %/price per invoice line, one invoice per customer, unpost reversible,
  $0 recorded-but-unsent. **Not yet used on real invoices** (zero split rows at the 2026-07-27 check);
  the first real billing cycle (owner action 2) will be its first real use. Design record:
  `docs/plans/per-line-item-split-billing-spec-2026-07-17.md`. This is the settled resolution of the
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
- **True inventory costing (on-hand average purchase cost)** — scoped, never built (`inventory`,
  `inventory_transactions` and `receiving_records` still carry no cost columns). Its parking gate —
  supplier-pricing Phases 1a/1b shipped — was met in July; it needs Mason's go to schedule.
  Plan: `docs/plans/2026-07-16-inventory-costing-plan.md`.
- **H2 migration-baseline squash** (1,011 live ledger rows on 2026-09-26) — quiet window only. A
  clean-rebuild baseline for new projects now exists (`supabase/baselines/`, high-water
  `20260727174805`, checked by `npm run test:schema-baseline`); the old migration files stay as the audit trail.
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

## 🗂️ 5. Carried over by the 2026-09-26 docs cleanup (their only record was a removed doc)

The source docs were deleted as finished history; each is recoverable from git history by the
path named. Re-verify against the live app before acting — these were checked against `main` on
2026-09-26, not against live data.

**Owner decisions still open**
- **Editing a partly delivered order** (2026-05-04 core-workflow audit P1-3): should unshipped lines
  on a `partially_fulfilled` order be editable? Today `OrderDetail` locks them.
- **Money housekeeping** (2026-05-04 money/AR audit): (1) finance charges run only from the manual AR
  Aging button — automate monthly or keep manual? (2) reopening a closed period gives no age-based
  warning — add one? (3) Month-End Close "reviewed" checkboxes are not saved with the close — persist them?
- **Restricted-use (RUP) expired licenses** (sell-side plan gate G2, 2026-06-13 recovery audit): a RUP
  sale to a customer whose applicator license is EXPIRED (not missing) is recorded as a WARNING, not
  NON-COMPLIANT (`generate_rup_sales_records`, `src/lib/rupCompliance.ts`). Confirm WARNING is right, or
  switch to NON-COMPLIANT. Also confirm the WPS notice PDF's "see product label" wording is sufficient.
- **Retired product with an open PO** (P4-11, deferred 2026-05-06): `get_inventory_position` shows only
  active products, so a retired product with open PO lines drops out of the Inventory / on-order view.
  Options: show a "Retired – has open PO" badge, or refuse PO lines on retired products server-side.
- **Full-acreage billing nudge** (field-map-ux F2, parked 2026-06-24): an automatic "confirm before
  posting" prompt when a field-application invoice bills a field's full acreage. Only the "Full field /
  Edited" badge shipped. The premise has changed: `job_applied_record_fields.applied_acres` now records
  real sprayed acres, so a data-driven nudge may be buildable without new capture. Build it, or keep the badge.
- **Map licensing check** (2026-06-22 field-mapping roadmap): confirm the Mapbox GL usage-metered cost
  tier and the satellite basemap's commercial-use terms for a revenue app (a free government-imagery
  basemap is the fallback).
- **Per-product margin targets** (2026-08-09 pricing audit): how to seed margin targets across ~600 SKUs
  (the recommendation then was to derive them from historical selling prices).
- **Integrity-report flags from 2026-08-01**: Inventory Ledger (10 products whose on-hand does not match
  the transaction ledger) and Delivery-Invoice Qty Parity (157 delivered-but-not-invoiced order+product
  pairs). Decide whether these are real billing/ledger gaps or whether the parity check should exclude
  intentionally deferred-billing orders. The Pre-booked check's only flag was an inactive test product.
- **Junk-customer line items** (detail for §1 item 5, flag list 2026-07-05; re-verify links live first):
  zero-link rows with id prefixes `73672cfe`, `b4d71a33` (a PO-bucket row), `e8508e65` and `b6a1d451`
  (inactive duplicates). The inactive `d8bd091a` row has linked orders and commissions — merge it into its
  active twin, do not delete it. The active `987c3722` row is your call.

**Owner smoke test**
- Click-test the three act-from-the-list write buttons on real data (open since 2026-06-24): Quotes list
  "Convert to Order", Deliveries list "Complete" (signed-by popup), and Receiving Hub "Receive" on a PO
  line. Each should match its detail-page flow.

**Features approved or requested but never built**
- **Record Payment prefill** (approved 2026-05-04): Record Payment from an order, invoice or customer opens
  `/payments` with no customer preselected (`PaymentAllocation` reads no URL parameters).
- **One shared route list** (approved 2026-05-04): Sidebar, CommandPalette and `usePageMeta` each keep a
  separate hand-maintained route list.
- **Vendor Purchase Order PDF/email** and a **single combined PDF for batch invoice print** (2026-05-04
  reports audit): neither exists today.

**Proof still owed**
- **Commission as-of report, live real-path proof** (acceptance #6 of the 2026-09-03 spec, removed in
  this cleanup): when the first commission payment posts (real or `[E2E]`), run the report for a date
  before and a date after the payment, void it, run both again, and confirm the answers change correctly.
  Only a disposable PostgreSQL 17 proof exists so far.

## 🚫 Not building (settled — don't re-add without new evidence)

Native apps · multi-tenancy now · ML forecasting · autonomous AI on financial records ·
QuickBooks two-way sync · grain/energy/feed modules · big-bang UI redesign · role-workspace
IA before portal+mobile usage data · re-enabling prepay bulk-apply · applying shelved
earmark migrations as-is · broad offline money mutations.

---

## 📋 Status snapshot (as of 2026-07-16 unless a row says otherwise — re-query before relying on a count)

Current live state belongs in `docs/manual/CURRENT_STATE.md`; this table is a dated snapshot.

| Metric | Value |
|---|---|
| Live migrations | 1,011 ledger rows, latest `20260926163005` (read-only ledger query 2026-09-26; 791 on 2026-07-16) |
| Edge functions | 8 functions in `supabase/functions/` (2026-09-26, not counting `_shared`): the 7 below plus `customer-document-files` (deployed v1 2026-09-22 per `DEPLOYMENT.md`). Versions as of 2026-07-16: create-user v23, process-blend-ticket v25, process-document v18, send-email v17, reset-user-password v15, epa-lookup v4, setup-blend-tickets-storage v18 ← retirement pending |
| Schema registry | Generated 2026-09-20, high-water `20260920052149` — 7 migrations behind live (applied 2026-09-21 → 2026-09-26) |
| customers / products | 153 / 604 |
| fields / quotes / orders | 5 / 3 / 63 |
| invoices | 10 (8 draft, 2 posted) |
| payments | **0** |
| jobs / deliveries | 4 / **106** (2026-07-13 snapshot had these reversed) |
| blend_tickets | 0 |
| negative inventory rows | 18 (re-base DEFERRED by Mason 2026-07-16) |
| In-DB backup runs | 1 (weekly pg_cron live) — off-site `/backup-db` dump: none yet |
| Production | croprxsolutions.app — `main` merges deploy via PR only (branch protection) |

## ✅ Verified done in the 2026-07-16 pass (don't re-do)

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
