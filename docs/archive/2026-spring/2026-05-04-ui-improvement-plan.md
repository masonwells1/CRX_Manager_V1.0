# CRX Manager UI Improvement Plan

Date: 2026-05-04
Companion to: `docs/audits/2026-05-04-ui-navigation-workflow-audit.md` (Codex audit)
Status: Approved — not yet started

This document is the implementation plan derived from a rebuttal of Codex's UI/navigation audit plus an independent code review by Claude. Decisions were locked through Q&A with Mason on 2026-05-04.

---

## Plain-English Summary

Codex's audit identified real UX friction but proposed restructuring that was too large for the actual problems. This plan keeps Codex's small wins, drops the workspace redesigns, and bumps mobile/tablet polish up to a Phase 2 peer concern because Mason confirmed heavy mobile use for pick lists, blend tickets, applicators, and delivery drivers.

The work is split into 4 independently shippable phases with no migrations, no RPC changes, and no business-logic changes. Total scope: ~7-8 working days.

---

## Rebuttal of Codex Audit

### Where Codex was right (verified against current code)

- **Sidebar label collision** — `Sidebar.tsx:85` labels the `/` link "Operations", and `Sidebar.tsx:147` labels a category "Operations". Two siblings with the same label. Real bug, trivial fix.
- **CommandPalette page list is incomplete** — Diffing `ALL_PAGES` (`CommandPalette.tsx:129-173`) against `App.tsx` shows missing routes: `/program-tracker`, `/application-services`, `/integrity-report`, `/integrity-cleanup`, `/payment-history`, `/notifications`, `/invoices/field-app/new`, `/accounts-payable/bills*`, `/fields/:id/dashboard`, `/deliveries/new`, `/jobs/:id`.
- **Page titles wrong on nested routes** — `usePageMeta.ts:46` only looks at first path segment, so `/invoices/field-app/new` renders as "Invoice Management".
- **TransactionThread is passive** — `TransactionThread.tsx:190` and `:221` render literal "No deliveries" / "No invoices" text.
- **Payment context loss** — `OrderDetail.tsx:992` fires `navigate('/payments')` with zero context; `PaymentAllocation.tsx:106-133` then forces the user to re-search the same customer.
- **TopBar has no search affordance** — `TopBar.tsx:11-34` is just menu + title + notifications. Ctrl+K is undiscoverable.

### Where Codex was wrong or overscoped

1. **"Sales Desk / Dispatch Desk / Field Application Desk / Finance Desk" workspaces** — overscoped and wrong shape. The current sidebar is one-category-open-at-a-time with persistence (`Sidebar.tsx:256`); that is already a workflow-shaped pattern. Adding a parallel "Workspaces" layer would mean more navigation, not less. Real fix: relabel + structural cleanup, not a new top-level concept.
2. **"Customer detail has too many tabs"** — 8 tabs is reasonable for a Customer 360. The actual gap is that there is no glanceable rollup. Adding an overview header above the tabs is much smaller than reshuffling, and Mason confirmed this is preemptive rather than reactive (he has not used customer detail enough to feel pain there).
3. **Phase 2 "unified application workspace"** (jobs + dispatch + blend tickets + field app invoice) — months of work and conflates four distinct database lifecycles. Rejected entirely. Replaced with: lightweight "Related Work" strip on each existing detail page (Phase 4 if needed at all).
4. **"Standardize all tables to DataTable"** — risky churn. `Invoices.tsx` and `Deliveries.tsx` use custom tables for a reason (selection bars, row shapes). Multi-day migration with regression risk for very modest UX gain. Dropped.

### What Codex missed

- **Sidebar list and command palette list are duplicated** — two hand-maintained route lists with no shared source of truth. This is *why* Codex found drift; a structural fix prevents future drift.
- **No deep-linking from dashboard action queue** — clicking "5 overdue invoices" should land on `/invoices?status=posted&overdue=true`, but list pages don't read URL filter state consistently.
- **No "Recently viewed" surface** outside the empty command palette state. `getRecentItems()` exists in `src/lib/recentPages.ts` but is unused outside the palette.
- **No saved/quick filters anywhere.**
- **Tablet breakpoint is awkward** — `lg:hidden` (1024px) means an iPad in landscape gets the desktop sidebar. Codex caught the field-app modal symptom but missed the breakpoint root cause.
- **Breadcrumb coverage is inconsistent** — present on quote/order/delivery/invoice detail, but missing on most list pages and intermediate flows.

---

## Locked Decisions (from 2026-05-04 Q&A)

| # | Question | Answer |
|---|----------|--------|
| 1 | Biggest pain workflow | Quote → Order → Delivery → Invoice (drives Phase 2 priority) |
| 2 | Real users | 2 main users + occasional others (light role-awareness, not heavy) |
| 3 | Mobile/tablet usage | Heavy — pick lists, blend tickets, applicators, drivers (Phase 4 is real work) |
| 4 | TransactionThread direction | Show missing more clearly, not active suggestions (Option A — lifecycle status) |
| 5 | Customer detail | Preemptive concern, no restructure — overview header only |
| 6 | "Create Invoice From…" | Filtered list deep-links (lighter than picker modals) |
| 7 | Scope appetite | All 4 phases approved |

---

## Phase 1 — Plumbing & Tiny Wins (~1 day, low risk)

Goal: kill the duplicated route lists and fix obvious labels.

| # | File | Change |
|---|------|--------|
| 1.1 | `src/components/layout/Sidebar.tsx:85` | Rename `/` link "Operations" → "Dashboard" |
| 1.2 | `src/lib/routesConfig.ts` (new) | Single source of truth: `{ path, label, icon, roles, palette: bool, sidebar: 'standalone' \| <category-id> \| 'hidden' }` for every route in `App.tsx` |
| 1.3 | `src/components/layout/Sidebar.tsx` | Refactor `navigation[]` to be derived from `routesConfig.ts` |
| 1.4 | `src/components/ui/CommandPalette.tsx:129` | Refactor `ALL_PAGES` to be derived from `routesConfig.ts` |
| 1.5 | `src/hooks/usePageMeta.ts` | Rewrite with longest-prefix match against `routesConfig.ts`. Fixes `/invoices/field-app/new`, `/accounts-payable/bills/:id`, `/dispatch`, `/program-tracker`, etc. in one shot |
| 1.6 | `src/lib/routesConfig.test.ts` (new) | Unit test diffing `routesConfig.ts` against `App.tsx` route table — fails CI if drift returns |
| 1.7 | `src/components/layout/TopBar.tsx` | Add visible "Search…" button with ⌘K kbd hint, wired to existing palette |
| 1.8 | `src/components/layout/AppLayout.tsx` | Hoist palette open state if needed so TopBar can trigger it |

Verify: `npm run typecheck && npm run build && npm run test`

---

## Phase 2 — Pipeline Context (~2 days, addresses #1 pain point)

Goal: stop losing context as the user moves through quote → order → delivery → invoice → payment.

| # | File | Change |
|---|------|--------|
| 2.1 | `src/components/ui/TransactionThread.tsx` | Add lifecycle status micro-text under each chip (Option A): "Accepted", "Confirmed", "1 of 2 complete", "Posted". Driven from existing `*.status` columns. Status display only, no action buttons. |
| 2.2 | `src/pages/PaymentAllocation.tsx` | Read `?customer=` and `?invoice=` query params on mount; preselect customer + scroll/highlight that invoice row |
| 2.3 | `src/pages/OrderDetail.tsx:992` | "Record Payment" → `/payments?customer={id}` |
| 2.4 | `src/pages/InvoiceDetail.tsx` | "Record Payment" passes `?customer={id}&invoice={id}` |
| 2.5 | `src/pages/CustomerDetail.tsx` | Payment-entry buttons pass `?customer={id}` |
| 2.6 | `src/pages/Invoices.tsx:583` | Replace "New Field Application" button with `[+ Create Invoice ▾]` dropdown: From Order → `/orders?needs_invoice=true`, From Blend Ticket → `/blend-tickets?status=approved&billed=false`, Field Application → `/invoices/field-app/new` |
| 2.7 | `src/pages/Orders.tsx`, `src/pages/BlendTickets.tsx` | Read new `?needs_invoice=` / `?status=&billed=` params and apply filters |
| 2.8 | `src/pages/QuoteBuilder.tsx`, `OrderDetail.tsx`, `InvoiceDetail.tsx`, `DeliveryDetail.tsx` | Action hierarchy pass: one green primary (the next step), secondary outlined (edit/print main), "More ▾" overflow for template/history/destructive |

---

## Phase 3 — Customer Overview + Dashboard Wiring (~2 days)

Goal: glanceable rollups and deep-linkable dashboard cards. No tab restructure.

| # | File | Change |
|---|------|--------|
| 3.1 | `src/pages/CustomerDetail.tsx` | Add overview header strip above the tab bar — KPIs (open quotes, active orders, scheduled deliveries, posted-with-balance, prepay balance, fields w/ open work). Each KPI links to that customer's tab. Tabs untouched. |
| 3.2 | `src/components/dashboard/ActionQueue.tsx` | Cards include URL filter params in their links (e.g., overdue invoices → `/invoices?status=posted&overdue=true`) |
| 3.3 | `src/pages/Invoices.tsx`, `src/pages/Deliveries.tsx` | Read URL filter state on mount, apply to filter UI (only the filters action queue uses) |
| 3.4 | `src/components/layout/TopBar.tsx` | Add "Recent" dropdown pill — reuses existing `getRecentItems()` from `src/lib/recentPages.ts` (already implemented, currently only consumed by palette empty state) |

---

## Phase 4 — Mobile / Tablet Polish (~2-3 days)

Goal: make field/driver/applicator flows actually work on phones and tablets. Bumped up from "optional" because Mason confirmed heavy mobile use.

| # | File | Change |
|---|------|--------|
| 4.1 | `src/components/layout/Sidebar.tsx`, `AppLayout.tsx` | Move drawer breakpoint from `lg` (1024px) to `xl` (1280px). iPad landscape gets mobile drawer instead of cramped desktop sidebar. |
| 4.2 | `src/components/field-app/SelectLocationsModal.tsx` | Segmented control on tablet/mobile: Map / List / Selected. Sticky selected-acres footer. |
| 4.3 | `src/pages/Deliveries.tsx`, `src/pages/Jobs.tsx` | Mobile card fallback for the table — what drivers and applicators see |
| 4.4 | `src/pages/OrderDetail.tsx` (Print Pick List path) | Verify mobile-browser print output is clean; tighten print CSS if not |
| 4.5 | `src/pages/BlendTicketDetail.tsx` | Mobile thumb-first pass: input field sizes, photo upload, sign/approve buttons |
| 4.6 | `src/pages/FieldApplicationInvoice.tsx:521`, `src/lib/invoicePdf.ts` | Implement print packet (kills the existing TODO). Applicators carry this paper. |

---

## Verification per phase

Each phase ends with:
- `npm run lint` (0 errors)
- `npm run typecheck` (0 errors)
- `npm run build` (clean build)
- `npm run test` (all passing)
- Targeted E2E spec runs for the changed surface
- Doc count refresh (page count, route count) per CLAUDE.md "Documentation Maintenance Rules"

## Risk profile

- 0 migrations
- 0 RPC changes
- 0 business-logic changes
- All work is in the React layer — `git revert` rolls back any phase cleanly
- Each phase ships independently; user can stop after any phase

## How to start

When ready, say "start phase 1" in a fresh session and reference this doc. Implementation will proceed file-by-file with diffs shown for sign-off before each change is written.
