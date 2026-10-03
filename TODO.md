# CRX Manager — Combined TODO (statuses last corrected 2026-09-27)

The single combined list of everything still open, in priority order.
Built 2026-07-16 from a full docs review with subagent verification of every
"done" and "open" claim against the code on disk and the live database. Items were added
through 2026-09-26 (§5 carried over by the docs cleanup), and stale statuses were corrected on
2026-09-26 and 2026-09-27. A live count inside an
item is as of the date that item states.

- Shipped history → `docs/changelog.d/` (one file per change; `docs/CHANGELOG.md` holds entries up to 2026-08-26)
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

1. ~~**Re-base the negative-inventory products**~~ — **⏸ DEFERRED by Mason 2026-07-16**
   ("skip and don't worry about it for now"). The rows (first verified live 2026-07-16:
   `inventory.quantity_available < 0`; re-verified 2026-08-08; take the current list from KNOWN_ISSUES §1) stay as-is until he brings physical counts;
   worksheet: `docs/operations/2026-06-10-negative-inventory-rebase-worksheet.md`.
   Deliveries are flowing despite it, so nothing is hard-blocked today. Don't re-raise
   as the top action — revisit only when Mason asks or a delivery actually fails on it.
2. ~~**Run a real billing cycle in the app**~~ — **DONE 2026-07-17.** A real payment was
   recorded and allocated through `allocation_sets` + `prepay_credits`, and both halves
   reconcile (`docs/manual/CURRENT_STATE.md` §1). `payments` is a dead legacy table, so its
   zero count never meant the loop was unrun. The money-audit re-run it was waiting for ran as
   the 2026-08-08 foundation ultra review. Nothing further is owed on this item.
3. **Create a Stripe account** (~15 min) and hand over API keys — unblocks A1
   ACH pay-now links (the #1 competitive gap) and later portal payments.
4. **Label data load + EPA backfill approval** — 0 of ~604 products have full
   label data; ~105 of 204 stored EPA reg numbers are wrong. The `/label-data-quality`
   tool (shipped) makes this data-entry. Gates the whole compliance track. A June 2026 filled
   research draft (`docs/plans/CRX-label-data-FILLED-DRAFT-2026-06-14.csv`, removed in the docs
   cleanup) can be recovered as a starting point: `git show e81853970:docs/plans/CRX-label-data-FILLED-DRAFT-2026-06-14.csv`.
5. **Decision packets** (details in `docs/loops/owner-decisions-2026-07.md` + KNOWN_ISSUES §3).
   **Decided 2026-07-16:** due dates = Net 30 + override (build spec in
   `docs/plans/invoice-due-dates-net30-spec-2026-07-16.md`, removed in the docs cleanup; recover with
   `git show e81853970:docs/plans/invoice-due-dates-net30-spec-2026-07-16.md`) · dead structures = KEEP
   (planned features) · "wire" = already live (stale packet) · junk data = keep test
   entities tagged `[E2E]` (tagging done live).
   **Still open:** vendor-name merges · category remap · #107 auto-draft-on-applicator
   policy · Sprint D3 halves (blend commission mint + `jobs.commission_split` visibility) ·
   true-junk deletes awaiting line-item OK (8 gibberish blend recipes, 4 zero-link customer
   rows, vendor `we`, ~5 bad emails, 8 SEED commission batches, PO-2026-0008/0015,
   5 empty deliveries, 1 E2E invoice).
6. **Send ~10 real vendor bills + Anthropic API key** — unblocks the D1 extraction pilot.
7. **Supabase Pro / PITR decision + refresh the local `/backup-db` JSON dump** — FREE plan today;
   only ONE in-DB snapshot run existed (verified live 2026-07-16). For the local `/backup-db` JSON dump,
   at the 2026-09-27 check the local marker (`backups/LATEST-OK.json`) was over a month old, while the separate weekly off-site encrypted backup was current.
   Also gates leaked-password protection (L4).
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
> `docs/plans/commission-history-as-of-reporting-spec-2026-09-03.md` (removed in the docs cleanup — the
> feature is live; recover with `git show e81853970:docs/plans/commission-history-as-of-reporting-spec-2026-09-03.md`,
> and its one unrun acceptance check is in §5 "Proof still owed").
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
  edge fn (still deployed and ACTIVE, zero callers — needs an approved retirement session).
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
  `per_line_split_billing_enabled` flag was set ON on 2026-07-21 and read ON, its row unchanged since then,
  at a read-only live check on 2026-09-27 — KNOWN_ISSUES §0). Default splits
  from field ownership, override %/price per invoice line, one invoice per customer, unpost reversible,
  $0 recorded-but-unsent. **Still open — its first real-invoice proof:** still unused (no split invoices at
  the read-only 2026-09-26 check; the 2026-07-17 billing cycle predates the feature). Check the
  first real split invoice when one is made. Design record:
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
- **H2 migration-baseline squash** (1,012 live ledger rows on 2026-09-27) — quiet window only. A
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

The source docs are removed by the docs cleanup as finished history. Each item names its source
(a path or an audit label). Recover the full write-up from `e81853970`, the last `main` commit that
has every one of them: for a label, find the file with `git grep -l "<label>" e81853970 -- docs`;
then read it with `git show e81853970:<path>`. Re-verify against the live app before acting — these were checked against `main` on
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
- **Integrity-report flags from 2026-08-01**: the Inventory Ledger check (products whose on-hand does
  not match the transaction ledger) and the Delivery-Invoice Qty Parity check (delivered-but-not-invoiced
  order+product pairs) both failed. Re-run the integrity report for current figures, then decide whether
  these are real billing/ledger gaps or whether the parity check should exclude intentionally
  deferred-billing orders. The Pre-booked check's only flag was an inactive test product.
- **Junk-customer line items** (detail for §1 item 5, flag list 2026-07-05; re-verify links live first):
  the rows with no linked records can be deleted on your OK; an inactive duplicate that has linked
  records should be merged into its active twin, not deleted; and an active row is your call. The row list is in
  `git show e81853970:docs/loops/business-workflow-junk-customer-flags.md`.

**Owner smoke test**
- Click-test the three act-from-the-list write buttons (open since 2026-06-24) using disposable `[E2E]` records only,
  never real customer data; an agent does this only with Mason's explicit approval in the current conversation: Quotes list
  "Convert to Order", Deliveries list "Complete" (signed-by popup), and Receiving Hub "Receive" on a PO
  line. Each should match its detail-page flow.
- Import one sanitized boundary export in genuine John Deere, FieldView or .zip vendor format (never an
  actual customer's export) into a fresh, disposable `[E2E]` test customer, never a real one; an agent does
  this only with Mason's explicit approval in the current
  conversation. Confirm it bills on the file's acres, the ±10% difference flag appears, and redrawing the
  map does not change the billed acres. Then remove the test fields, since a re-import or a failed save can
  leave duplicates or partial field data (see the field boundary import item below). This was the one check
  left open at the June field-acre billing go-live.

**Features approved or requested but never built**
- **Record Payment prefill** (approved 2026-05-04): Record Payment from an order, invoice or customer opens
  `/payments` with no customer preselected (`PaymentAllocation` reads no URL parameters).
- **One shared route list** (approved 2026-05-04): Sidebar, CommandPalette and `usePageMeta` each keep a
  separate hand-maintained route list.
- **Vendor Purchase Order PDF/email** and a **single combined PDF for batch invoice print** (2026-05-04
  reports audit): neither exists today.

**Deferred by the June 2026 UI overhaul** (source: `docs/archive/2026-summer-closeout/build-loops/ui-overhaul-v2/STATE.md`,
removed in this cleanup; recover with
`git show 4b6ff6293:docs/archive/2026-summer-closeout/build-loops/ui-overhaul-v2/STATE.md`; each was still open in code on 2026-09-28)
- **Owner decision — old A/R pages:** `/ar-aging`, `/payment-history` and the other old money pages still
  have their own routes and links next to the combined `/accounts-receivable` workspace. Turning them into
  redirects and dropping the extra links would change where you click, so the overhaul left it to you.
  Related: each A/R workspace tab still has its own customer picker; the overhaul planned picking the
  customer once for all tabs (see the comment in `src/pages/AccountsReceivable.tsx`).
- **Dashboard alerts not built:** overdue vendor bills (the summary RPC has no AP-due field) and blend
  tickets awaiting approval.
- **Act-from-the-list actions not built:** "Create Invoice" from the Orders list (it branches on split
  allocations, so it stays on the order page) and "Link Order" / "Create Invoice" on Blend Tickets rows (it
  needs an order picker).
- **Search and balance gaps:** a by-product filter on Field Invoices / Unbilled Applications (invoice lines
  need a product join), and a per-field outstanding balance on the customer Fields tab (it needs a new
  field-level source).
- **Customer 360 summary bar:** add field count, license expiry and next compliance date to the cards on
  the customer page. `CustomerSummaryBar` shows only AR, orders, deliveries, credit tier and last activity,
  and `get_customer_summary` returns only those five, so this needs an RPC change or extra queries. Making
  the bar stay put while scrolling (sticky) was left as visual polish for you to decide.
- **Customer drawer actions:** the slide-out customer drawer was planned with quick actions (new order, new
  quote, add note) and recent orders / open invoices; it only has "Open full profile".
- Dropped as low value: sticky summary cards on A/R Aging, which shows aging as table columns.

**Found by a full sweep of every removed doc (2026-09-30)** — each item was checked as still open in code
and missing from every other tracker. Sources are recoverable with `git show 4b6ff6293:<path>`.
- **Approved 2026-05-04, never built** (`docs/archive/2026-summer-closeout/build-loops/ui-overhaul/STATE.md`):
  make the customer name on Order, Invoice and Delivery pages a link with a small balance/credit card;
  status text under each step of the quote→order→delivery→invoice strip; a "+ Create Invoice ▾" menu on
  Invoices linking to filtered Orders / Blend Tickets; one main button plus a "More ▾" menu on Order,
  Invoice and Delivery pages. Optional phone polish: a Map/List/Selected toggle in Select Locations and a
  phone-first blend ticket page.
- **Field boundary import** (`docs/build-loops/field-acre-billing/STATE.md` and `HANDOFF.md`): bulk import
  never runs the existing overlapping-field check, so re-importing a farm creates duplicate fields; add a
  Skip / Replace / Import-as-new choice at preview. Separately, saving a field, its boundary and its billable
  acres is not one transaction, so a lost response or a rejected boundary can leave a duplicate or a field
  with no map. Fixing that needs a migration (your call).
- **Inventory and loader safety (low)**: the hold function still accepts a "crop program" hold with no
  quote, which would never auto-release (the app only sends "manual"; narrow the function or require the
  quote). No check catches a job reservation left active on a cancelled, finished or deleted job (add a
  read-only sweep that should always count 0). Ticked "loads done" on a loader worksheet survive a change
  to the job's acres or the tank layout, so a crew can see stale progress.
- **Field-app parity leftovers (June 2026 parity loop)**: confirm one real job-attachment upload and delete
  works in production; decide whether you want a fuel-surcharge rate (built, off by default) and whether
  projected use should count only remaining field acres. On the Dispatch board, the retry key is lost after
  a reload and failed applicator/recipe loads are not reported.
- **Cosmetic**: pop-up and toast open/close animations never run, because their Tailwind animation plugin
  is not installed. Install it or remove the classes. A short customer statement prints its last-page
  footer twice: `src/lib/statementPdf.ts` draws it from the table's `didDrawPage` and again after the
  remittance stub (2026-05-30 p2/p3 sprint handoff).
- **Access gaps (low, same class as the tracked field-app access lows)**: `save_field` lets any sales rep
  edit any customer's fields and billing defaults (no per-customer ownership check, the pattern already
  closed for `save_customer`); every active user, including drivers and applicators, can read every
  customer's addresses (the July change added only an active-user check, on purpose); and the By-Customer
  invoice summary on Field Invoices under-totals for a sales rep, because it reads only the invoices that
  rep can see. Narrow each, or record that you accept it in KNOWN_ISSUES.
- **Owner actions and decisions (field app)**: the pre- and post-application customer notification emails
  are built, but code comments say the `send-email` Edge Function deploy that turns them on was never
  done. Confirm the live version, then the deploy needs your approval. Decide whether an over-label
  chemical rate should block the save or keep warning (warn is today's default). Decide whether to build
  the "wrong field" alert (as-applied acres far from the job's planned acres) and the F2 in-field acre
  nudge, or keep today's display-only "Full field / Edited" badge.
- **Field-app bugs (low)**: the Jobs list's tag, crop, county, state, chemical and field-name filters only
  see the first 500 jobs fetched; bulk Loader Worksheet print stamps "printed" on jobs that dropped out of
  the PDF; auto-created split draft invoices on delivery completion raise no bell notification; and on a
  blend ticket, a product line with a saved name but no catalog match shows a blank "Select Product".
- **Field-app polish**: a recipe filter on mobile FieldView and the Dispatched List (only the office
  Dispatch Board has one; `get_dispatched_list` returns no recipe); "undo last point" in the guided
  map-drawing tool; tab semantics and arrow-key support on the Customer 360 tab strip; finishing the
  visual refresh on Modal, Breadcrumbs, Combobox and the app shell; and a sidebar link for Payment
  History (today it is reachable only by URL or the A/R workspace).
- **Ordering (sell-side plan, 2026-06)**: `create_direct_order` checks its idempotency key and then runs
  with no lock until it saves the key. `create_rush_order` got an advisory lock for exactly this race, and
  this one never did. Confirm whether two simultaneous same-key submits can both create an order, and add
  the same lock if so (migration). Separately, field-staff (driver/applicator) rush ordering was scaffolded,
  then switched off pending scoped RLS and page permissions. Decide whether to finish it or remove the
  dormant `isFieldStaff` branch in `src/pages/NewOrder.tsx`.
- **Decide keep or drop** (2026-05-09 implementation plan, "not in this plan"): bank reconciliation, vendor
  1099 tracking, line items on vendor bills, and linking purchase orders to the vendor record instead of a
  typed name. Also optional: a count badge for unpriced rush orders (sell-side plan); and, as a decision for you, whether a
  price-later rush order should count an estimated amount (from its suggested price) against the customer's
  credit limit before it is priced. Today credit exposure is only checked once the order is priced or
  invoiced. Last, a screen for the
  product return-policy fields, which nothing in the app edits (product data model D-4, "not yet" on
  2026-08-18).
- **Quote discount, tax and fee model (decide)**: quotes have no discount, tax or fee fields and no
  server-side order of operations for them. Adjustments go through per-line price overrides. Ag inputs
  are often tax-exempt, so this may be deliberate, but no decision is recorded (Q1 audits
  `PHASE6_RESPONSIBILITY_AUDIT.md` and `PHASE7_COMPLETE_DEFECT_BACKLOG.md`). The invoice prompt-pay
  discount item is a separate feature.
- **Earmarked prepay plan, only partly built (decide)**: the 2026-02-24 plan (v3, with your locked
  decisions) called for:
  - Chemical, Fertilizer and General buckets matched to invoice lines by each product's bucket;
  - cross-bucket use allowed only as an admin override with a required reason and an audit entry;
  - admin alerts above a dollar threshold set in Settings;
  - a standalone prepay history report.

  What shipped in March is `prepay_credits.bucket_label` with free labels and the prepay workspace. The
  product matching, override reason, threshold alerts and history report were not found in code on
  2026-10-03. This differs from the shelved booking "earmark engine" above. Recover the plan with
  `git show 4b6ff6293:docs/archive/2026-Q1-brainstorms/2026-02-24-earmarked-prepayments-plan.md`.

**Found by a sweep of every removed audit's findings (2026-10-02)**: about 100 removed audit and review
reports, from February to July 2026, were read finding by finding. Most findings were already fixed. These
were still open in code on 2026-10-02 and in no tracker. Sources are recoverable with
`git show 4b6ff6293:<path>`.
- **Money and data integrity**:
  - The financial audit log still references hard-deleted invoices and payments with no snapshot of what
    they were (see KNOWN_ISSUES §0).
  - `save_quote` never checks a line's price against the product's tier pricing.
  - QuoteBuilder uses its own untested tier and recalculation math instead of the tested `quoteCalc.ts`,
    and `NewOrder.tsx` duplicates it again.
  - No Integrity Report check compares `customers.prepay_balance_cents` with the sum of the customer's
    prepay credits.
  - `complete_job` deducts inventory and only warns on a shortfall, while `complete_delivery` blocks.
    Decide which is intended.
  - Order and quote CSV imports split on bare commas, so a quoted value that contains a comma lands in the
    wrong column. Reuse the customer import's quoted-CSV parser.
  - Blend-ticket OCR auto-approves at a fixed 70% in `process-blend-ticket`, ignoring the thresholds
    setting the app shows.
  - Email and notification "don't resend" keys include the current time, so a double-click or retry can
    send twice.
  - `require_admin()` and `require_admin_or_sales_rep()` exist only in the live database (no migration
    defines them), so a from-scratch rebuild would fail.
  - Smaller items: `restore_quote_version` returns a generic "duplicate" on a retry instead of the
    original result; `update_order_items` checks an order status (`pending`) that never existed;
    `create_planned_holds` uses its own idempotency check instead of the shared helpers; some idempotency
    keys use an empty user segment before the profile loads.
- **Database safeguards** (`docs/archive/2026-spring/2026-05-25-14-domain-review-supplement.md`, re-checked against code and the live database on
  2026-10-02):
  - **Accounting periods and dates:** `allocate_payment` defaults its payment date to the server's
    `CURRENT_DATE`, which is UTC, and the payment screen never sends a date. A payment recorded in the
    last hours of the Central business day can therefore be checked against the wrong accounting period.
    Pass a Chicago date, or set the database timezone (high).
  - **Edits after completion:** admins can still edit `delivery_items` directly after a delivery is in
    progress or completed, which can desync the inventory ledger (high).
  - **Invoice source rule:** no database constraint enforces that an invoice comes from an order or a
    blend ticket (or a documented exception such as a misc charge or a field-app invoice). Only app code
    and RPCs enforce it (high).
  - **Concurrency:** `generate_ticket_number`, the `allocate_payment` allocation-set version and
    `check_period_open` take no lock. Orders have no `row_version` stale-write guard, unlike quotes and
    customers.
  - **Orphans and cascades:** some live deliveries and commissions point at soft-deleted orders, and
    `inventory_holds.product_id` still cascades on product delete.
  - **Timing:** the overnight cron jobs run at fixed UTC times. Finance-charge `period_start` ignores
    each customer's grace days. Season boundaries can differ between the browser and the server near
    Sep 30/Oct 1.
  - **Customer emails:** delivery emails insert values such as the signer's name and product names into
    HTML without escaping.
  - **Field app:** job completion has no offline queue (Delivery, FieldStop and FieldView do).
  - **Smaller items:** the Action Queue shows only 10 items per category with no "view all", and list
    search isn't debounced.
- **Access (decide, or record as accepted)**: every sales rep can read all orders and order lines; any
  sales rep can insert inventory-ledger rows directly; `FORCE ROW LEVEL SECURITY` is on only 2 tables.
  Order Detail offers editing to sales reps although the `orders` update policy is admin-only (confirm
  whether their saves go through an RPC). Sales reps can record a payment on `/payments` but not from
  Invoice Detail; pick one rule.
- **Alerts never built** (Q1 audit): a driver-reported delivery issue (damaged, shortage, refused, wrong
  product, access) sends only the generic "Delivery Completed" notice; `cancel_delivery` notifies the
  driver and sometimes an admin, but never the order's sales rep; and `dashboard_summary()` computes
  driver-issue, expired-hold and cancelled-but-posted counts that no screen shows. Smaller cleanups:
  `getPresetDates` has 5 copies, `CommentsSection` has an unused `noteTitle` prop, and
  `useOCRThresholds` is a hook wrapping a constant.
- **Errors that show as empty screens**: `DataTable` has no error state, so a failed load shows "No …
  found"; `WorkloadView` ignores the `get_team_workload` error; four of Blend Ticket Detail's ten loads
  fail silently; `runCriticalAction`/`sanitizeError` are used on only about a third of pages, so others can
  show raw database errors. Queries that read only `data` and drop the `error` (checked 2026-10-02 in the
  pages the Q1 risk audit §2.1–2.4 named) remain in Reports (for example, the Chemical History product
  filter just shows empty), QuoteBuilder, Blend Ticket Detail, Deliveries, AR Aging, Cycle Counts and
  Inventory, and likely elsewhere. A lint rule (see engineering hygiene below) is the durable fix.
- **Activity feed gaps**: posting, voiding and recording a payment on an invoice write no activity entry,
  and neither do the key actions in `PaymentAllocation`, `VendorBillDetail`, the prepay workspace and
  quick receive. Field-app invoice events are logged as plain `invoice`. `logActivity` takes an untyped
  entity name and is awaited in some places but not others, and QuoteBuilder passes an empty
  performed-by.
- **Compliance and field work**:
  - Application Records has no detail page and no per-record PDF to hand an inspector.
  - The Compliance page (RUP register, field/FSA listing) exports CSV only.
  - The load-sheet PDF is on Deliveries but not on the Dispatch Board.
  - Decide whether the Dispatch Board should also show deliveries.
  - A blend ticket's free-text field-names box duplicates its structured field rows.
  - The field-app invoice split preview works only while the invoice is editable.
  - Job, blend ticket and field-app invoice headers don't show the customer.
  - Only New Order saves a draft that survives an iPad app kill (`useFormDraft`); QuoteBuilder and the
    field-app invoice should be next.
- **Money screens**:
  - The credit-limit check runs only after a quote converts; show AR and credit status in the quote
    header first.
  - Posting an invoice gives no next step.
  - Voiding an invoice and prepay "Apply All" have no preview of what will change.
  - The month-end delivery check counts all deliveries, not just the period's.
  - A write-off blocked by a closed period shows a generic error.
  - The commission payment screen doesn't show split percentages.
  - The prepayment manager runs one query per customer.
  - AR reminders dedupe on the local date.
- **Reports and PDFs**:
  - The Reports export comment promises PDF, but only CSV exists.
  - Emails don't use the shared `companyInfo.ts` branding.
  - There's no on-screen preview before printing.
  - `invoicePdf.ts` drawing callbacks have no try/catch.
  - The bulk invoice "Email" button is still a disabled "Coming soon".
- **Navigation**:
  - The command palette searches only 5 record types.
  - Browser tab titles don't name the record.
  - The customer page has no Invoices tab or at-a-glance overview.
  - The quote→invoice status strip is text, not links.
  - There's no Notifications sidebar link.
  - Clicking a field on a customer opens the boundary editor, not the field history.
  - Customer notes appear only on the Info tab.
  - The Customers list has no balance or overdue columns.
- **Engineering hygiene**:
  - QuoteBuilder (over 5,000 lines), DeliveryDetail, CustomerDetail, InvoiceDetail and BlendTicketDetail
    keep growing. Split them when a change touches them.
  - `SettingsPage` calls Edge Functions with a hand-built `fetch` instead of `supabase.functions.invoke`.
  - `Jobs.tsx` formats CSV money with its own `toLocaleString` helper.
  - Status badges, empty states and spinners are re-implemented page by page.
  - No lint rule catches `.select('*')` with raw casts, or unchecked storage/select errors.
  - No smoke test mounts every lazy page.
  - DeliveryDetail and InventoryPage have no characterization tests.
  - The deferred content-freshness gate for docs was never built.
  - `scripts/db-invariant-sweeps/FIN-README.md` still lists the fixed `void_payment` overpayment bug as
    open.
  - E2E comments in `workflow-financial-operations.spec.ts` still describe `window.confirm()`.
- **Not fully re-checked**: lower-tier rows in these removed audits were not re-verified one by one:
  - `docs/archive/2026-summer-closeout/roadmap/app-wide-structure-audit-2026-07-01.md` (tiers 1–3);
  - `docs/archive/2026-spring/2026-05-11-phase0-verification.md`;
  - `docs/archive/2026-spring/2026-05-09-full-scope-review-campaign.html`.

  Re-read them from git history before acting in those areas.

**Proof still owed**
- **Commission as-of report, live real-path proof** (acceptance #6 of the 2026-09-03 spec, removed in
  this cleanup): create and post a disposable `[E2E]` commission payment (a live-data change — needs Mason's OK first; never use or void a real payment), run the report for a date
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
| Live migrations | 1,012 ledger rows, latest `20260927060531` (read-only ledger query 2026-09-27; 791 on 2026-07-16) |
| Edge functions | 8 functions in `supabase/functions/` (2026-09-26, not counting `_shared`), including `customer-document-files` (deployed v1 2026-09-22 per `DEPLOYMENT.md`); `setup-blend-tickets-storage` retirement pending. For deployed versions, run the read-only Supabase `list_edge_functions` tool |
| Schema registry | Regenerated 2026-09-26 by PR #820, high-water `20260926163005` — 1 migration behind live (`20260914100800`, applied 2026-09-27) |
| customers / products | 153 / 604 |
| fields / quotes / orders | 5 / 3 / 63 |
| invoices | 10 (8 draft, 2 posted) |
| payments | **0** |
| jobs / deliveries | 4 / **106** (2026-07-13 snapshot had these reversed) |
| blend_tickets | 0 |
| negative inventory rows | 18 (re-base DEFERRED by Mason 2026-07-16) |
| In-DB backup runs | 1 as of 2026-07-16 (weekly pg_cron live). 2026-09-27: local `/backup-db` JSON dump stale (over a month old); weekly off-site encrypted backup current |
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
