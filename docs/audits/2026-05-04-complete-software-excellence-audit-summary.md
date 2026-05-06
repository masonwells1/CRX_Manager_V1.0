# Complete Software Excellence Audit — Master Summary

**Date:** 2026-05-04
**Auditor:** Claude (Opus 4.7, 1M context) — independent take, replaces Codex's earlier 2026-05-04 set.
**Scope:** Read-only phased audit of `C:\CRX_Manager_V1.0`. No app code was changed.
**Phase files (read these for the detail):**

- [`docs/audits/2026-05-04-phase-0-current-state-audit.md`](2026-05-04-phase-0-current-state-audit.md) — context, structure, ground-truth counts
- [`docs/audits/2026-05-04-phase-1-core-workflow-audit.md`](2026-05-04-phase-1-core-workflow-audit.md) — quote → order → delivery → invoice → payment (10 findings)
- [`docs/audits/2026-05-04-phase-2-field-application-audit.md`](2026-05-04-phase-2-field-application-audit.md) — jobs, dispatch, blend tickets, sprayer packets (15 findings)
- [`docs/audits/2026-05-04-phase-3-money-ar-audit.md`](2026-05-04-phase-3-money-ar-audit.md) — invoices, payments, prepay, month-end, commissions (20 findings)
- [`docs/audits/2026-05-04-phase-4-inventory-purchasing-audit.md`](2026-05-04-phase-4-inventory-purchasing-audit.md) — inventory, holds, POs, receiving, returns, cycle counts (14 findings)
- [`docs/audits/2026-05-04-phase-5-customer-360-navigation-audit.md`](2026-05-04-phase-5-customer-360-navigation-audit.md) — customer detail, sidebar, command palette (15 findings)
- [`docs/audits/2026-05-04-phase-6-permissions-safety-audit.md`](2026-05-04-phase-6-permissions-safety-audit.md) — roles, RLS, three-layer agreement (9 findings)
- [`docs/audits/2026-05-04-phase-7-reports-pdfs-audit.md`](2026-05-04-phase-7-reports-pdfs-audit.md) — invoice/statement/delivery PDFs, exports (multiple findings)
- [`docs/audits/2026-05-04-phase-8-mobile-performance-recovery-audit.md`](2026-05-04-phase-8-mobile-performance-recovery-audit.md) — driver/applicator UX, offline, large lists (13 findings)

Existing input doc kept for reference: [`2026-05-04-ui-navigation-workflow-audit.md`](2026-05-04-ui-navigation-workflow-audit.md).

---

## Plain-English Summary

CRX Manager is in good shape. The hard parts — bigint-cents money, RLS on every table, idempotency keys, append-only audit logs, a per-route error boundary, ESLint enforcement of `assertRpcResult` and `checkMutationResult` — are real and working. The migration discipline is the best defense against drift you'll find in a single-owner build, and the field-application math (multi-customer splits, atomic group posting, OCR ingest) is genuinely solid.

The work that remains splits cleanly into three buckets:

1. **A small number of money/data-correctness bugs that *must* be fixed before anything else.** These don't show up every day, but when they do, they corrupt the books or create over-bills. There are about half a dozen of them, all in Phases 1–4.
2. **A larger pile of workflow guidance gaps.** The app does the right things in isolation but does not yet *guide a user through their day*. Customer 360 is 8 tabs with no overview, the sprayer packet is a TODO, the transaction thread is passive, the dashboard quick actions don't match real role-by-role flows, and CommandPalette is hidden behind Ctrl+K with stale page coverage.
3. **Mobile/recovery polish for field crews.** The offline queue infrastructure is built but only one screen uses it. The field picker is desktop-only. Photo upload has no retry. A photo+signature failure after `complete_delivery` leaves a completed delivery with no signature.

Mason has 0 coding experience but has built a remarkably disciplined codebase. The findings below are written in plain English, with exact file paths and line numbers, and ordered so the books are protected first, then the daily workflow gets smoother, then the field crew gets their offline polish.

---

## Biggest Business Risks (in priority order)

| # | Risk | Phase | Specific finding |
|---:|---|---|---|
| 1 | **`reverse_write_off()` is silently broken — every call fails because it tries to UPDATE a GENERATED column.** Once a write-off is recorded it cannot be reversed in-app without a manual SQL fix. | 3 | P3-1 (CRITICAL) |
| 2 | **"Create Invoice" before delivery completes can leave a stale-quantity manual invoice that the auto-invoice flow refuses to patch — over-bill on partial deliveries.** | 1 | P1-1 (CRITICAL) |
| 3 | **The "Applied Info" tab on the field-app invoice silently discards wind / temperature / applicator inputs.** Compliance evidence vanishes between session and database. | 2 | P2-1 (CRITICAL) |
| 4 | **Closed-period guard does NOT run on prepay-application paths.** Payments can hit a closed period through a side door. | 3 | P3-4 (HIGH) |
| 5 | **`approve_return` / `receive_return` were rebuilt by the dynamic `pg_get_functiondef()` anti-pattern that caused the March 2026 40-bug incident.** Plus `issue_return_credit` declares an idempotency key but its body never uses it. Plus cancelling a `received` return leaves the inventory restock in place — direct books-vs-shelf drift. | 4 | P4-7..P4-10 |
| 6 | **The customer "Order Confirmed" email is gated on a status transition orders cannot reach** (orders are born `confirmed`). Customers have likely never received it. | 1 | P1-7 |
| 7 | **Inventory math runs in JavaScript** from four separate queries; the same screen displays three different formulas for "free." Real-time concurrent changes during a save are not handled. | 4 | P4-1, P4-2 |
| 8 | **No sprayer/applicator print packet exists at all.** The "Print" button on the field-app invoice is a literal `/* TODO: print */`. Applicators leave the office without a paper map/mix sheet. | 2, 7 | P2 print; P7 missing-doc |
| 9 | **No Purchase Order PDF for vendors.** `PurchaseOrderDetail` can only print a *receiving* receipt — vendors never receive a properly formatted PO. | 7 | Missing-doc |
| 10 | **Photo + signature upload after `complete_delivery` runs unguarded.** A network failure mid-flight leaves the delivery completed with no signature and no recovery path. | 8 | P8 |

---

## Biggest Workflow Friction Points

These don't break anything — they just make the app harder to use than it should be.

1. **Customer screen is an 8-tab filing cabinet with no at-a-glance overview.** The data is already in the database (prepay balance, open work counts, AR aging) but it's buried. There isn't even an Invoices tab. (Phase 5)
2. **`TransactionThread` shows links across the pipeline but does not say "do this next".** Empty states render as "No deliveries" or "No invoices" instead of action buttons. (Phase 1, Phase 5)
3. **The same data is captured three different ways across Jobs, Blend Tickets, and Field-App Invoices** with no pre-fill between them. The field-day workflow tab-hops between five pages. (Phase 2)
4. **Payment entry from `OrderDetail` loses customer/invoice context** — sends to `/payments` with no URL params. The user re-searches for the same customer. (Phase 1)
5. **Sidebar is page-shaped, not workflow-shaped.** Finance has 14 items; field application is split across 3 different sidebar sections. (Phase 5)
6. **`CommandPalette` is hidden behind Ctrl+K only, and the underlying `global_search` SQL UNION misses several entity types.** No top-bar search button. (Phase 5)
7. **`usePageMeta` returns wrong titles for every `:id` detail page** because it only inspects the first path segment. (Phase 5)
8. **OCR auto-approve threshold is hard-coded at 70% in the Edge Function** while the UI implies it's tunable. (Phase 2)
9. **`SelectLocationsModal` is desktop-only** (hard-coded `w-1/2` left/right split). Tablet users in the cab struggle. (Phase 8)
10. **Big-list pages cap at 500–2000 rows with disappearing toast warnings.** Once the catalog or invoice list exceeds the cap, rows go missing without explanation. (Phase 8)

---

## Highest-Impact Fixes (Top 12)

In rough order of "most business value per unit of risk." Numbers in `[]` are the originating phase findings.

1. **Fix `reverse_write_off()` to use the underlying balance components, not the GENERATED column.** [P3-1] One migration. Books cannot self-heal until this lands.
2. **Make "Create Invoice" on `OrderDetail` smarter:** if delivery is scheduled, route to "Create Invoice From Delivered Quantities" (post-completion); if user insists on a pre-delivery manual invoice, warn loudly. [P1-1]
3. **Persist the field-app "Applied Info" inputs** (wind, temperature, applicator, time). Add server-side columns or a `field_app_application_meta` row. [P2-1]
4. **Run `check_period_open()` inside every prepay-application RPC.** [P3-4]
5. **Rebuild `approve_return`, `receive_return`, `cancel_return` by hand** (no `pg_get_functiondef`); add idempotency to `issue_return_credit`; reverse the inventory restock when a `received` return is cancelled. [P4-7..P4-10]
6. **Fix the `order_confirmed` email gate** so it actually fires when orders are created. [P1-7]
7. **Move `/inventory` net-position math into a single server-side RPC** and have the page render whatever the RPC returns. [P4-1, P4-2]
8. **Build the sprayer / applicator print packet.** A field-app PDF that shows: customer, fields with map, chemicals + rates + EPA numbers, application service fee, applicator signature line. Wire up the existing TODO at `FieldApplicationInvoice.tsx:522`. [P2 + P7]
9. **Build a Customer 360 panel on `CustomerDetail`** above the tabs: open quotes, active orders, scheduled/in-progress deliveries, unposted/posted invoices, balance due, prepay balance, fields needing attention, plus a "next-best action" row. Add a missing Invoices tab. Backed by one new read-only RPC `get_customer_overview`. [P5]
10. **Upgrade `TransactionThread` into a workflow header.** Replace "No deliveries" / "No invoices" with action buttons ("Schedule Delivery" / "Create Invoice From Delivered" / "Record Payment"). [P1, P5]
11. **Pass invoice + customer context in the URL when navigating to `/payments`** from order/invoice/customer screens. [P1]
12. **Wire the existing `queueAction` offline queue into the 8 mutating screens that don't use it yet.** Today only `DeliveryDetail` uses it; 9 ops are declared in `offlineSync.ts`. [P8]

---

## Recommended Implementation Order

Each "wave" assumes the previous one has shipped. Each wave is small enough to commit, deploy, and verify before the next starts.

### Wave A — Stop the bleeding (Phase 3 + Phase 1 critical bug)
**Why first:** these protect the books. Until they ship, every business day carries risk.

- Fix `reverse_write_off()` (P3-1)
- Fix `order_confirmed` email gate (P1-7)
- Fix `OrderDetail` "Create Invoice" routing (P1-1)
- Add `check_period_open()` to prepay RPCs (P3-4)
- Fix the `'void'` vs `'voided'` status string in `reconciliation.ts` Check 10 (P3-5)
- Re-author the `20260332200000` cure migration without `pg_get_functiondef` (P3-2)

**Likely files:** `supabase/migrations/*.sql` (3-4 new migrations), `src/pages/OrderDetail.tsx`, `src/lib/reconciliation.ts`, plus an email-trigger fix.

### Wave B — Field-application correctness (Phase 2 + Phase 4 returns)
**Why second:** field application is where Mason's business runs daily. The bugs here corrupt compliance evidence and inventory.

- Persist field-app "Applied Info" inputs (P2-1)
- Rebuild returns RPCs without dynamic injection; add idempotency to `issue_return_credit`; restock-reversal on cancel of received returns (P4-7..P4-10)
- Move inventory math server-side via one RPC (P4-1, P4-2)

**Likely files:** `supabase/migrations/*.sql` (3 new migrations: returns rebuild, inventory RPC, applied-info schema), `src/pages/FieldApplicationInvoice.tsx`, `src/pages/Returns.tsx`, `src/pages/InventoryPage.tsx`.

### Wave C — The print packet (Phase 2 + Phase 7)
**Why third:** the sprayer packet is the most-requested missing piece. Standalone work — no dependency on Wave A/B.

- Build sprayer/applicator field PDF
- Wire `FieldApplicationInvoice.tsx:522` TODO Print button to it
- Build vendor-facing Purchase Order PDF
- Unify letterhead address (Martinsville vs Robinson)

**Likely files:** `src/lib/fieldAppPdf.ts` (new), `src/lib/purchaseOrderPdf.ts` (new), `src/pages/FieldApplicationInvoice.tsx`, `src/pages/PurchaseOrderDetail.tsx`, plus brand-asset settings.

### Wave D — Customer 360 + workflow header (Phase 5 + Phase 1 ergonomics)
**Why fourth:** this is the biggest daily-usability lift. Best done after the print packet so users have something to send.

- New RPC `get_customer_overview`
- Customer 360 panel on `CustomerDetail`
- Missing Invoices tab on `CustomerDetail`
- `TransactionThread` → workflow header with next-best-action buttons
- URL-param payment context from order/invoice/customer
- Fix `usePageMeta` for `:id` routes

**Likely files:** `src/pages/CustomerDetail.tsx`, `src/components/ui/TransactionThread.tsx`, `src/pages/PaymentAllocation.tsx`, `src/pages/OrderDetail.tsx`, `src/pages/InvoiceDetail.tsx`, `src/hooks/usePageMeta.ts`, `supabase/migrations/*.sql`.

### Wave E — Field-day reliability (Phase 8)
**Why fifth:** field crews already use the app; this just hardens it.

- Wire `queueAction` into the 8 mutating screens that don't use it
- Make `SelectLocationsModal` responsive (segmented Map / List / Selected on tablet)
- Photo upload retry
- Guard signature upload after `complete_delivery` (and offer a recovery path if the upload fails)
- Replace 500/2000-row caps with proper pagination

**Likely files:** `src/lib/offlineSync.ts` (already exists), `src/components/field-app/SelectLocationsModal.tsx`, `src/pages/DeliveryDetail.tsx`, `src/pages/Customers.tsx`, `src/pages/Orders.tsx`, `src/pages/Invoices.tsx`, `src/pages/InventoryPage.tsx`.

### Wave F — Permissions + nav cleanup (Phase 6 + Phase 5 nav)
**Why last:** correctness is fine (RLS is the safety net); these are clarity wins.

- Reconcile UI vs RLS permissive gaps (DispatchBoard, OrderDetail edit-mode, InvoiceDetail audit-feed)
- Resolve the two-payment-paths story; correct CLAUDE.md to match reality
- Visible top-bar search button + expand `global_search` UNION coverage
- Sidebar reshape (Workflows layer, fix "Operations" name collision)
- Add `/notifications` sidebar link

**Likely files:** `src/pages/DispatchBoard.tsx`, `src/pages/OrderDetail.tsx`, `src/pages/InvoiceDetail.tsx`, `src/components/layout/Sidebar.tsx`, `src/components/layout/TopBar.tsx`, `src/components/ui/CommandPalette.tsx`, `supabase/migrations/*.sql` (one for `global_search`), `CLAUDE.md`.

---

## Which Phase Should Be Fixed First

**Phase 3 (Money & AR), specifically the Wave A bullets above.** Justification:

- `reverse_write_off()` is silently broken every call (P3-1). Every day this isn't fixed is a day the books can't self-heal.
- The `OrderDetail` Create-Invoice routing bug (P1-1) is the only finding that protects the books on partial deliveries.
- These fixes are *small* — one or two SQL migrations and a UI guard. They unblock everything else without destabilizing the app.
- They are testable against existing `*.test.tsx` files and the reconciliation report.

Wave A should be 1–3 days of work. After it ships, Mason and Claude have a clean baseline to build on for Waves B–F.

---

## Files Likely to Be Touched (rolled up across all waves)

### Frontend
- `src/pages/OrderDetail.tsx` — multi-wave (A, D, F)
- `src/pages/CustomerDetail.tsx` — Wave D
- `src/pages/FieldApplicationInvoice.tsx` — Waves B, C
- `src/pages/InvoiceDetail.tsx` — Waves D, F
- `src/pages/PaymentAllocation.tsx` — Wave D
- `src/pages/InventoryPage.tsx` — Waves B, E
- `src/pages/PurchaseOrderDetail.tsx` — Wave C
- `src/pages/Returns.tsx` — Wave B
- `src/pages/DeliveryDetail.tsx` — Wave E
- `src/pages/DispatchBoard.tsx` — Wave F
- `src/pages/Customers.tsx`, `src/pages/Orders.tsx`, `src/pages/Invoices.tsx` — Wave E (pagination)
- `src/components/ui/TransactionThread.tsx` — Wave D
- `src/components/layout/Sidebar.tsx`, `src/components/layout/TopBar.tsx` — Wave F
- `src/components/ui/CommandPalette.tsx` — Wave F
- `src/components/field-app/SelectLocationsModal.tsx` — Wave E
- `src/hooks/usePageMeta.ts` — Wave D
- `src/lib/offlineSync.ts` — Wave E (extending existing)
- `src/lib/reconciliation.ts` — Wave A
- `src/lib/fieldAppPdf.ts` (new) — Wave C
- `src/lib/purchaseOrderPdf.ts` (new) — Wave C

### Database
- `supabase/migrations/*.sql` — at least 7 new files across the waves:
  - reverse_write_off fix (Wave A)
  - prepay period-open guard (Wave A)
  - 20260332200000 cure-without-injection rewrite (Wave A)
  - returns RPC rebuild (Wave B)
  - inventory net-position RPC (Wave B)
  - applied-info schema (Wave B)
  - get_customer_overview RPC (Wave D)
  - global_search UNION expansion (Wave F)

### Edge Functions
- `supabase/functions/process-blend-ticket/index.ts` — make OCR threshold tunable from settings (Wave B/C)

### Docs
- `CLAUDE.md` — fix payment-roles claim, refresh counts (Wave F)
- `docs/reference/rpc-functions.md` — append new RPCs (each wave)
- `docs/reference/migration-history.md` — append each new migration
- `docs/reference/pages-routes.md` — if any new routes
- `docs/CHANGELOG.md` — sprint summaries

---

## Open Questions for Mason

The phase audits each list their own; here are the ones Claude needs Mason to answer before *any* implementation starts.

1. **Sprayer packet contents.** What *exactly* does Mason want on the printed sprayer/applicator packet? Customer + fields + chemicals + rates + EPA numbers + map + applicator signature + wind/weather lines? Anything else? Does he have a competitor's packet to match?
2. **Letterhead address.** Is Crop RX Solutions in Martinsville, IL or Robinson, IL? Both addresses appear in different PDFs today.
3. **Return-cancel inventory behavior.** When a `received` return is later cancelled, should the restocked inventory be reversed (current Phase 4 recommendation) — or treated as a permanent inventory adjustment because the product physically came back?
4. **Period-reopen path.** When a closed period needs to be reopened (write-off, late payment), should that be a one-button admin action, or a multi-step audit-trailed RPC? Phase 3 recommends the latter.
5. **Customer 360 — the ONE most-important number.** If only one number could appear at the top of `CustomerDetail`, what is it? Balance due? Open AR aging bucket? Prepay balance? Open application acres? This drives the layout.
6. **Two-payment-paths.** Are sales reps allowed to record payments? Today CLAUDE.md says admin-only but `/payments` allows sales reps. Pick one.
7. **Big-list page-size.** What's the largest list in production today (Customers? Products? Orders?)? This decides whether Wave E uses pagination or windowed virtualization.
8. **OCR threshold tunability.** Should the 70% blend-ticket OCR auto-approve threshold be admin-tunable, or locked at 70%? If tunable, what should the UI look like?
9. **Field application "Applied Info."** Are wind / temperature / applicator / time legally required for state compliance, or business-internal? This decides whether Wave B's schema treats them as required or optional.
10. **Dead code.** `src/pages/FieldDetail.tsx` exists but is not routed. Delete it, or wire it up?

---

## Pre-Work Before Anything Lands

1. Commit or stash the **8 pre-existing modified files** in the working tree (see Phase 0 for the list). Do not let audit findings land on top of unsaved work.
2. Run `/update-docs` to refresh CLAUDE.md / AGENTS.md counts before any implementation.
3. Run `/preflight` (or `npm run lint && npm run build && npm run test`) on a clean `main` to confirm green baseline.
4. Mason answers the 10 open questions above.

---

## Ready-to-Send Claude Review Prompt

Copy/paste this into a fresh Claude Code session to get a second-opinion review of the audit before implementation:

```
You are a second-opinion reviewer. The user (Mason Wells) has 0 coding experience, runs Crop RX Solutions, and just received a 9-file phased audit of his Supabase + React app at C:\CRX_Manager_V1.0. Your job is to verify the audit is accurate and the recommended order is sound — NOT to implement anything.

Read these files in order:
1. CLAUDE.md
2. docs/workflows/SAFE_DEVELOPMENT_RULES.md
3. docs/audits/2026-05-04-complete-software-excellence-audit-summary.md (the master)
4. docs/audits/2026-05-04-phase-0-current-state-audit.md
5. docs/audits/2026-05-04-phase-1-core-workflow-audit.md
6. docs/audits/2026-05-04-phase-2-field-application-audit.md
7. docs/audits/2026-05-04-phase-3-money-ar-audit.md
8. docs/audits/2026-05-04-phase-4-inventory-purchasing-audit.md
9. docs/audits/2026-05-04-phase-5-customer-360-navigation-audit.md
10. docs/audits/2026-05-04-phase-6-permissions-safety-audit.md
11. docs/audits/2026-05-04-phase-7-reports-pdfs-audit.md
12. docs/audits/2026-05-04-phase-8-mobile-performance-recovery-audit.md

For each Wave A finding (P3-1, P1-1, P2-1, P3-4, P4-7..P4-10, P1-7) verify:
- The cited file:line still says what the audit claims it says.
- The plain-English business risk is accurate.
- The recommended fix direction is the simplest correct fix (not over-engineered).

Then give Mason:
- A list of any audit findings you DISAGREE with, and why.
- A list of any business risks the audit MISSED.
- Confirm or revise the Wave A → Wave F sequencing.
- Confirm whether Wave A really should be 1–3 days of work.

Read-only — do not edit any source code, migrations, or docs. Plain English only. Cite file:line for any claim. Stop after producing your review as a markdown comment in the conversation; do not save a new file.
```

---

## What This Audit Did Not Do

- Did not run any code, tests, migrations, or browser preview.
- Did not enumerate every RPC or every table.
- Did not assess the migration log line-by-line.
- Did not validate that every cited line still says what the auditor claims — Mason or a follow-up Claude session should spot-check the critical findings before implementation.
- Did not benchmark performance — Phase 8 reasons about it from code, but real numbers will need a load test or production query log review.

---

*End of master summary. The phase files contain the line-numbered detail for every finding.*
