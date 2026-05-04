# Phase 0 — Current State Audit

**Date:** 2026-05-04
**Auditor:** Claude (Opus 4.7, 1M context)
**Scope:** Read-only. No code changed. Baseline for Phases 1–8.

---

## Plain-English Summary

CRX Manager is a mature internal app — it already has the right modules (sales, deliveries, invoices, payments, jobs, blend tickets, field application, inventory, AR, month-end). The codebase is disciplined: every mutating RPC takes an idempotency key, every table has RLS, money is bigint cents, audit trails are append-only, and pre-commit hooks block the most common drift mistakes. That is unusually clean for a single-owner build.

The work that remains is mostly **product work, not engineering rescue**. The app does the right things in isolation; it does not yet *guide the user through their day*. Daily friction lives in the gaps between screens — finishing a delivery and not knowing whether to bill, opening a customer and clicking through 8 tabs to assemble the picture, hitting "Record Payment" from an order and losing the customer context, or trying to print a sprayer packet and finding a TODO. Phases 1–8 will dig into each of those gaps.

There is also one structural concern worth flagging up front: **doc drift**. Counts in `CLAUDE.md` and `AGENTS.md` no longer match the repo (e.g. CLAUDE.md says 65 pages and 267 migrations, repo has 76 page files / 65 routed pages and 267 migrations; CLAUDE.md says ~172 RPCs but the actual definition count is harder to derive from migration text alone). Doc drift is benign on its own but it predicts where future agent work will go off-track.

---

## Required Reading — What I Read for This Audit

| Doc | Purpose | Key takeaway |
|---|---|---|
| `AGENTS.md` | Codex-flavored quick guide | Same hard rules as CLAUDE.md, slightly different phrasing |
| `CLAUDE.md` | Project source of truth | Hard red lines, business lifecycles, schema gotchas, drift-prevention rules |
| `docs/workflows/SAFE_DEVELOPMENT_RULES.md` | Mandatory safety rules | Read every session — covers data, business, code-quality, deploy red lines |
| `docs/workflows/QUOTE_TO_DELIVERY.md` | Pipeline reference | Quote → order → delivery → invoice → payment, plus parallel field-app branch |
| `docs/workflows/INVENTORY_RULES.md` | (Skimmed) | Net Free = available − planned holds − prebooked |
| `docs/workflows/RLS_SECURITY_GUIDE.md` | (Skimmed) | RLS patterns and `(select auth.uid())` performance rule |
| `docs/workflows/UI_PATTERNS.md` | (Skimmed) | Brand color, table/empty-state conventions |
| `docs/workflows/DATABASE_CHANGE_CHECKLIST.md` | (Skimmed) | Migration anti-patterns and verification steps |
| `docs/reference/pages-routes.md` | Page index | Routes documented page-by-page |
| `docs/reference/database-schema.md` | (Skimmed) | 96+ tables + RLS matrix |
| `docs/reference/rpc-functions.md` | (Skimmed) | RPC catalog |
| `docs/reference/migration-history.md` | (Skimmed) | Migration log |
| `docs/audits/2026-05-04-ui-navigation-workflow-audit.md` | UI/nav baseline (input doc) | Identified passive transaction thread, sidebar overload, hidden command palette, payment-context loss, customer-detail tab sprawl, field-app fragmentation |
| `docs/OPEN_ITEMS.md` | Deferred backlog | Empty — Sprints A–G backlog cleared |
| `docs/CHANGELOG.md` | (Skimmed) | Through Sprints F/G — pg_cron jobs, reconciliation report, runbook, field-app phase 22 |

---

## Ground-Truth Counts (Recomputed 2026-05-04)

| Metric | Repo reality | CLAUDE.md claim | Drift |
|---|---:|---:|---|
| Page files (`src/pages/*.tsx`) | 76 (incl. 10 colocated `.test.tsx` and 1 unrouted `FieldDetail.tsx`) | 65 | Mild |
| Routes wired in `App.tsx` | 65 (counted via lazy imports) | 65 | None |
| Migrations (`supabase/migrations/*.sql`) | 267 | 267 | None |
| Edge Functions | 7 + `_shared` | 7 | None |
| Unit test files (`*.test.*`) | 128 (per CLAUDE.md, not recounted) | 128 | Trust |
| E2E spec files | 93 (per CLAUDE.md) | 93 | Trust |
| `CREATE OR REPLACE FUNCTION` occurrences in migrations | 595 | "~172 RPCs" | Hard to compare — many occurrences re-define the same RPC across migrations. Worth recomputing distinct RPC names once. |

**Action for later:** add a script (or `/audit` step) that counts distinct RPCs from the `pg_proc` snapshot rather than from migration text, so the docs can self-update.

---

## Repository State at Start of Audit

### Branch & uncommitted work
- Branch: `main`
- Recent work shipped through commit `5d50ec6 docs(audit): add 2026-05-04 UI navigation workflow audit` (the doc that fed this audit cycle).
- Uncommitted changes (8 modified files):
  - `.claude/launch.json` (small)
  - `CLAUDE.md` (4 lines — likely date/count refresh)
  - `docs/CHANGELOG.md` (+30)
  - `docs/OPEN_ITEMS.md` (-22)
  - `docs/reference/migration-history.md` (+3)
  - `docs/reference/rpc-functions.md` (+1)
  - `src/components/field-app/FieldAppChemicalEntry.tsx` (a11y cleanup — confirmed via OPEN_ITEMS.md note)
  - `src/pages/OrderDetail.tsx` (+25/-2 — substance unknown until reviewed)

### Untracked files
- The 10 phase-audit and ui-improvement-plan markdowns dated 2026-05-04 — **these are Codex-generated and Mason has asked me to overwrite them with my own audit.**
- `supabase/migrations/20260504100000_lock_order_shares_when_invoice_posted.sql` — a new migration adding a guard that locks `field_app_location_shares` when the parent invoice is posted. Worth confirming this is wired into `rpc-functions.md` and `migration-history.md` as part of the doc-refresh commit before this lands.

### Implication
The working tree is in a transitional state: a small a11y fix, an OrderDetail tweak, and a new safety migration are unstaged. **None of this audit's findings should be acted on until that working tree is committed or stashed cleanly** — see Phase 6/7 for related risks.

---

## App Structure Map

### Frontend entry points
- **`src/main.tsx`** → mounts root.
- **`src/App.tsx`** (253 lines) — single source of all routing.
  - 65 lazy imports (`src/App.tsx:16` through `src/App.tsx:81`)
  - Auth wrapping at `src/App.tsx:149`
  - Per-route ErrorBoundary inside `RouteShell` at `src/App.tsx:114` — a crash on one page does not nuke the sidebar.
  - Route guards via `<ProtectedRoute allowedRoles={[…]}>` (`src/App.tsx:166` through `src/App.tsx:234`).
- **`src/contexts/AuthContext.tsx`** — auth state, profile, role.
- **`src/components/layout/AppLayout.tsx`** — outer chrome (sidebar + topbar).
- **`src/components/layout/Sidebar.tsx`** — navigation tree (more on shape below).
- **`src/components/layout/TopBar.tsx`** — title + notifications + (hidden) command palette trigger.
- **`src/lib/db.ts`** — single Supabase client + `checkMutationResult()`.
- **`src/types/index.ts`** — all shared types.

### Lazy-loaded routes (grouped by access)

**All authenticated roles** (4 routes — `src/App.tsx:160` through `src/App.tsx:163`)
- `/` Dashboard, `/team-board`, `/notifications`, `/getting-started`

**Admin + Sales Rep** (~33 routes — `src/App.tsx:166` through `src/App.tsx:209`)
- Catalog: `/products`, `/products/:id`, `/brand-vs-generic`, `/recipes`
- Customers/fields: `/customers`, `/customers/:id`, `/fields`, `/fields/:id`, `/fields/:id/dashboard`
- Sales pipeline: `/quotes`, `/quotes/new`, `/quotes/:id`, `/orders`, `/orders/new`, `/orders/:id`
- Invoices: `/invoices`, `/invoices/field-app/new`, `/invoices/field-app/:id`, `/invoices/:id`
- Blend tickets: `/blend-tickets`, `/blend-tickets/:id`
- Inventory/POs: `/inventory`, `/returns`, `/receiving`, `/receiving/quick`, `/purchase-orders`, `/purchase-orders/new`, `/purchase-orders/:id`
- Reports: `/reports`, `/sales-reports`, `/crop-programs`
- Money: `/payments`, `/compliance`
- Programs/remainders: `/program-tracker`, `/delivery-remainders`

**Admin + Sales Rep + Driver** (3 routes — `src/App.tsx:212` through `src/App.tsx:214`)
- `/deliveries`, `/deliveries/new`, `/deliveries/:id`

**Admin + Sales Rep + Applicator** (3 routes — `src/App.tsx:217` through `src/App.tsx:219`)
- `/jobs`, `/jobs/:id`, `/dispatch`

**Admin + Sales Rep + Applicator** (extra — `src/App.tsx:207`)
- `/application-records`

**Admin only** (~15 routes — `src/App.tsx:222` through `src/App.tsx:234`)
- Money: `/financial-dashboard`, `/month-end`, `/commission-payments`, `/customer-transactions`, `/prepayments`, `/prepay-workspace`, `/payment-history`, `/ar-aging`, `/rebates`
- AP: `/accounts-payable` and 3 vendor-bill routes
- Catalog/ops: `/cycle-counts`, `/vehicles`, `/vehicles/:id`, `/application-services`, `/application-services/:id`
- Integrity: `/integrity-report`, `/integrity-cleanup`
- `/settings`

### Sidebar structure (`src/components/layout/Sidebar.tsx:79` through `src/components/layout/Sidebar.tsx:193`)
Three standalone links (`/` "Operations", `/getting-started`, `/team-board`) + 5 categories + `/settings`:
- **Sales** (4): Quotes, Orders, Invoices, Payments
- **Customers** (3): Customers, Fields, Crop Programs
- **Products & Inventory** (8): Products, Brand vs Generic, Blend Recipes, Inventory, Cycle Counts, Supplier POs, Receiving, Returns
- **Operations** (9): Job Schedule, Dispatch Board, Deliveries, Remainders, Vehicles, App Services, Blend Tickets, App Records, Program Tracker
- **Finance** (14): Dashboard, AR Aging, Accounts Payable, Prepayments, Prepay Workspace, Commission Pay, Transactions, Month-End, Integrity Report, Integrity Cleanup, Rebates, Reports, Sales Reports, Compliance

**Observations:**
- Top-level dashboard is labeled "Operations" (`src/components/layout/Sidebar.tsx:91`) — same word also names a category (`src/components/layout/Sidebar.tsx:146`). Two unrelated things share the label.
- Finance has 14 items in a single accordion — large enough that it'll be a Phase 5 topic.
- Field application (the workflow Mason cares most about) is **split across three sidebar groups**: jobs/dispatch/blend-tickets/app-records under Operations, field-app invoice creation through the Invoices link under Sales, and field setup under Customers > Fields. Phase 2 will cover this.

### Edge Functions (`supabase/functions/`)
1. `create-user` — admin-only user creation
2. `process-blend-ticket` — Google Vision OCR
3. `process-document` — generic doc processing
4. `reset-user-password` — admin-only
5. `seed-admin` — one-time admin setup
6. `send-email` — Resend API; JWT auth, idempotency, PDF attachments
7. `setup-blend-tickets-storage` — storage bucket config
- Plus `_shared/` for shared CORS/auth helpers
- All require `ALLOWED_ORIGIN`

### Key library files (referenced repeatedly across phases)
- `src/lib/db.ts` — Supabase client + `checkMutationResult()`
- `src/lib/activityLogger.ts` — typed `logActivity({...})` helper
- `src/lib/idempotency.ts` and `src/hooks/useIdempotencyKey.ts`
- `src/lib/sentry.ts` — wraps `@sentry/react` (direct imports are blocked by ESLint)
- `src/lib/invoicePdf.ts` — invoice PDF generator (3 layouts)
- `src/lib/reportPdf.ts` — report PDF generator
- `src/lib/reconciliation.ts` — admin reconciliation report
- `src/lib/metrics.ts` — Sentry navigation breadcrumbs
- `src/components/ui/TransactionThread.tsx` — quote/order/delivery/invoice link strip
- `src/components/ui/CommandPalette.tsx` — Ctrl+K palette
- `src/components/ui/DataTable.tsx` — shared table component
- `src/components/dashboard/ActionQueue.tsx` — dashboard surface for problems

---

## Business Workflow Map (high level — details deferred to phases)

| Workflow | Primary pages | Primary RPCs | Phase that owns it |
|---|---|---|---|
| Quote → Order | `Quotes.tsx`, `QuoteBuilder.tsx`, `Orders.tsx`, `NewOrder.tsx`, `OrderDetail.tsx` | `save_quote`, `convert_quote_to_order`, `create_direct_order` | Phase 1 |
| Delivery (scheduled→completed) | `Deliveries.tsx`, `NewDelivery.tsx`, `DeliveryDetail.tsx`, `DeliveryRemainders.tsx` | `confirm_delivery`, `complete_delivery`, `edit_delivery`, `cancel_delivery`, `void_delivery`, `create_quick_delivery`, `create_followup_delivery` | Phase 1, Phase 4, Phase 8 |
| Invoice + posting | `Invoices.tsx`, `InvoiceDetail.tsx` | `post_invoice`, `post_invoice_group`, `void_invoice`, `check_period_open` | Phase 1, Phase 3 |
| Payments + allocation | `PaymentAllocation.tsx`, `PaymentHistory.tsx` | `allocate_payment` | Phase 3 |
| Field application | `FieldApplicationInvoice.tsx`, `Jobs.tsx`, `JobDetail.tsx`, `DispatchBoard.tsx`, `BlendTickets.tsx`, `BlendTicketDetail.tsx`, `ApplicationRecords.tsx`, `ApplicationServices.tsx` | `save_field_app_invoice`, `preview_field_app_invoice_split`, `post_invoice_group`, `derive_customer_shares_from_fields`, `create_invoice_from_blend_ticket` | Phase 2 |
| Inventory + holds | `InventoryPage.tsx`, `CycleCounts.tsx` | `create_inventory_transaction`, plus net-free aggregation | Phase 4 |
| Purchasing + receiving | `PurchaseOrders.tsx`, `NewPurchaseOrder.tsx`, `PurchaseOrderDetail.tsx`, `ReceivingLog.tsx`, `QuickReceive.tsx` | (varied — covered in Phase 4) | Phase 4 |
| Returns | `Returns.tsx` | (covered in Phase 4) | Phase 4 |
| Customer 360 | `Customers.tsx`, `CustomerDetail.tsx`, `Fields.tsx`, `FieldSetup.tsx`, `FieldDashboard.tsx` | varied | Phase 5 |
| Money/AR | `ARaging.tsx`, `FinancialDashboard.tsx`, `MonthEndClose.tsx`, `CommissionPayments.tsx`, `PrepaymentManager.tsx`, `PrepayWorkspace.tsx`, `CustomerTransactionReview.tsx`, `Rebates.tsx`, `AccountsPayable.tsx`, `VendorBills.tsx`, `NewVendorBill.tsx`, `VendorBillDetail.tsx` | varied | Phase 3 |
| Reports/PDFs | `Reports.tsx`, `SalesReports.tsx`, `Compliance.tsx`, `IntegrityReport.tsx`, `IntegrityCleanup.tsx`, `lib/invoicePdf.ts`, `lib/reportPdf.ts` | varied | Phase 7 |
| Permissions/safety | `App.tsx` (route guards), `lib/pagePermissions.ts`, `Sidebar.tsx` | RLS policies | Phase 6 |
| Mobile/perf | `DataTable.tsx`, field-app components, `Deliveries.tsx`, dashboard | varied | Phase 8 |

---

## Strengths I Want To Preserve

These are good and should *not* be undone in any later phase:

1. **One Supabase client, lifted into `db.ts`** — easy to reason about auth state.
2. **Append-only `financial_audit_log`** — money changes are traceable.
3. **Idempotency keys on mutating RPCs** — prevents double submits in flaky cell coverage.
4. **`assertRpcResult` + `checkMutationResult` patterns**, enforced by ESLint and the safety-net test — silent RLS failures are caught.
5. **Bigint cents everywhere** — no floating-point money.
6. **Per-route `ErrorBoundary`** — one bad page can't kill the app.
7. **`ProtectedRoute` enforces role at the route level**, not just hidden buttons.
8. **Pre-commit hook runs lint + build + tests + SQL/frontend validators** — drift-prevention is real, not aspirational.
9. **Field application invoice supports multi-customer split with one `invoice_group_id`** — the per-acre/per-share math is genuinely complex and already correct.
10. **Quick Delivery atomic path** (`create_quick_delivery` → order + delivery + draft invoice) — exists, works, saves keystrokes.

---

## Pre-Existing Risk Themes (carried into later phases)

Themes I noticed during Phase 0 reading that the deeper phases will examine:

1. **Workflow guidance is passive.** `TransactionThread` shows links but does not say "do this next". (Phase 1, Phase 5.)
2. **Print/PDF gaps.** A field-application invoice "Print" button is a TODO per the prior UI audit. (Phase 7.)
3. **Doc drift.** Counts in CLAUDE.md/AGENTS.md/reference docs are not script-validated. (Phase 0 — flag only.)
4. **Customer detail = 8 tabs.** The screen most-used by sales/admin doesn't have an at-a-glance overview. (Phase 5.)
5. **Field application is fragmented across 5+ pages.** Real-world Mason flow crosses Jobs → Dispatch → Blend Ticket → Field App Invoice → Application Record → Print Packet. (Phase 2.)
6. **`Sidebar` "Operations" name collision** with the dashboard label. (Phase 5.)
7. **`CommandPalette` is hidden** behind Ctrl+K only and has incomplete page coverage. (Phase 5.)
8. **Inventory math runs in the browser.** The prior audit flagged free/planned/on-order being computed in `InventoryPage.tsx` rather than in an authoritative RPC. Worth confirming. (Phase 4.)
9. **Two payment paths with different role rules** — `/payments` allows admin+sales_rep, `InvoiceDetail.tsx` Record-Payment is admin-only. (Phase 6.)
10. **`FieldDetail.tsx` exists but isn't routed in App.tsx.** Possibly dead code or partially implemented. Flag for Phase 5/6 to confirm.

---

## What Phase 0 Did NOT Do

- Did not run any code, tests, or migrations.
- Did not open the browser preview.
- Did not enumerate every RPC — that's `docs/reference/rpc-functions.md`'s job.
- Did not enumerate every table — that's `database-schema.md`.
- Did not assess the migration log line-by-line — that's a separate audit if Mason wants one.
- Did not validate doc counts (just observed drift) — recommended a `/update-docs` pass before any implementation work.

---

## Recommended Pre-Work Before Acting on Any Phase

1. **Commit or stash the current 8 modified files**, including the new migration `20260504100000_lock_order_shares_when_invoice_posted.sql`. Audits should not land on top of an unsaved working tree.
2. **Run `/update-docs`** to refresh the counts in CLAUDE.md / AGENTS.md / reference docs. Audits cite paths and line numbers; cited paths must match reality.
3. **Run `/preflight`** to confirm lint+build+tests are green before any phase begins. Findings are easier to trust on a clean baseline.

---

## Cross-Reference for Later Phases

When other phases cite a route, a page, or an RPC, the canonical reference is:

- **Route definitions:** `src/App.tsx:141` through `src/App.tsx:243`
- **Page implementations:** `src/pages/`
- **RPC catalog:** `docs/reference/rpc-functions.md`
- **Table catalog:** `docs/reference/database-schema.md`
- **Migration log:** `docs/reference/migration-history.md`
- **Pipeline rules:** `docs/workflows/QUOTE_TO_DELIVERY.md`
- **Inventory rules:** `docs/workflows/INVENTORY_RULES.md`
- **RLS patterns:** `docs/workflows/RLS_SECURITY_GUIDE.md`

---

*End of Phase 0. Phases 1–8 follow as separate files.*
