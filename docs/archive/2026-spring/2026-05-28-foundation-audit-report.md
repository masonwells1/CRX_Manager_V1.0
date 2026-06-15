# CRX Manager Foundation Audit Report

Generated: 2026-05-28

Scope: application layer only - React frontend, Supabase data/logic calls from the app, and cross-cutting consistency. This audit did not change app code. Supabase live MCP/CLI access was not available in this Codex session, so live database/type drift checks were limited to repository evidence, generated docs, migrations, and source code.

## 1. Headline Verdict - The Rebase Question

**PARTIAL** - do not rebase the whole app. The main foundation is worth keeping: routing is lazy-loaded and consistent, the browser Supabase client is centralized, most critical write flows already use RPCs/idempotency, and the repo has many guardrails. The recurring rework is coming from specific app-layer weak spots: very large workflow pages, convention-based safety checks with blind spots, duplicated business/display logic, and inconsistent shared UI/data patterns.

## 2. Plain-English Executive Summary

Overall grade: **Fair**.

This app is not a teardown. It has a real structure and several mature safety rules. But Mason is likely feeling repeated rework because the hardest workflows have grown into giant files, and the same ideas are implemented several different ways depending on which screen was built when.

Top root causes:

1. **The most important workflows are too concentrated.** The 10 largest page files hold 15,901 lines, about 34% of all page code. `QuoteBuilder`, `DeliveryDetail`, and `BlendTicketDetail` each mix data fetching, validation, calculations, mutations, UI state, and rendering in one file.
2. **Guardrails exist, but a few are too easy to bypass.** The app has `assertRpcResult()` and `checkMutationResult()`, but some RPCs assert the whole Supabase response object instead of `data`, and the mutation guard script mostly checks for imports rather than each mutation call.
3. **Critical concepts are still implemented many ways.** Money formatting, date-only handling, loading/error UI, toasts, route metadata, and bulk imports each have multiple patterns. That is where "fix it in one place, miss it in another" comes from.
4. **Some visible product surfaces are not finished.** A few field-app and invoice controls are user-visible TODOs/no-ops.
5. **Docs mostly help, but several app-layer docs are stale.** The headline counts are mostly current, but some workflow/reference docs still name old files, old status values, and old page counts.

No P0 finding was confirmed in this app-layer audit. The highest-priority issues are P1/P2: recurring rework drivers and safety gaps that should be addressed before expanding the same areas.

## 3. Per-Area Verdict Table

| Area | Verdict | Why | Rough effort |
|---|---|---|---|
| Routing and lazy-load shell | Solid | All 66 page source files are lazy-loaded and routed; `RouteShell` wraps protected page routes in `Suspense`/`ErrorBoundary` at `src/App.tsx:116`. | None/S |
| Supabase client and auth entry points | Solid | The app follows the single-client rule in `src/lib/db.ts`; no second browser client creation was found in production `src`. | None/S |
| Large workflow pages | Refactor | 47 of 66 page files exceed 400 lines; the largest workflows mix too many jobs in one file. | L |
| RPC/mutation safety guardrails | Refactor | The right helpers exist, but some call shapes and scripts do not actually enforce the documented rule. | S-M |
| Idempotency on critical writes | Refactor | Most major writes use `useIdempotencyKey()`, but several financial/inventory/bulk writes still generate fresh keys per attempt. | M |
| Business/display logic placement | Refactor | Server-authoritative RPCs exist, but several frontend screens still duplicate quantity, hold, and pricing preview logic. | M |
| Shared UI/data consistency | Refactor | Loading/error states, route registries, money/date formatting, toasts, and bulk import parsing are split across local patterns. | M |
| Field app unfinished controls | Refactor | Visible TODO/no-op controls exist in production paths. | S |
| Documentation/reference layer | Refactor | Some docs preserve stale filenames, counts, status strings, and column names. | S |

## 4. Severity-Ranked Findings

### Layer A - Frontend Structure

**[P1][L][Med] God pages concentrate too much critical behavior** - `src/pages/QuoteBuilder.tsx:146`, `src/pages/DeliveryDetail.tsx:70`, `src/pages/BlendTicketDetail.tsx:27` - 47 of 66 page files are over 400 lines; 14 are over 1,000 lines; the 10 largest page files total 15,901 lines. `QuoteBuilder` is 2,493 lines, `DeliveryDetail` is 2,273, and `BlendTicketDetail` is 1,608. These files are doing many jobs at once: fetch data, hold UI state, calculate totals/limits, call RPCs, log activity, show modals, and render the page. That makes small workflow changes risky and explains why the same areas need repeated repair. Suggested direction: split the top workflows one at a time into domain hooks, mutation/action modules, and presentational sections.

**[P2][M][Med] Bulk import screens duplicate CSV/import logic and have drifted** - `src/components/customers/BulkCustomerImport.tsx:93`, `src/components/orders/BulkOrderImport.tsx:113`, `src/components/quotes/BulkQuoteImport.tsx:102`, `src/components/products/BulkPricingImport.tsx:76` - there are 8 bulk import components totaling about 4,289 lines. Customer import has a quoted CSV parser; order/quote/pricing import still split with `line.split(',')`. CSV files with quoted commas can behave differently by screen. Suggested direction: extract one CSV parser/import state helper and leave only domain validation inside each importer.

**[P2][S][Med] Receiving Log double-fetches the same data** - `src/pages/ReceivingLog.tsx:123`, `src/pages/ReceivingLog.tsx:129` - one effect calls `fetchData()` and `fetchStaff()`, then a second effect calls `fetchData()` for the same filter dependencies. Each filter change can run `get_receiving_summary` and `get_receiving_log` twice. This wastes backend work and can let stale responses win. Suggested direction: keep one data-fetch effect, split staff loading, and add stale-response cancellation.

**[P2][M][Low] Route registries disagree across app shell/search/topbar permissions** - `src/App.tsx:15`, `src/components/layout/Sidebar.tsx:80`, `src/components/ui/CommandPalette.tsx:129`, `src/hooks/usePageMeta.ts:3`, `src/lib/pagePermissions.ts:20` - `App.tsx`, Sidebar, CommandPalette, page metadata, and permissions all maintain separate route/page lists. Agent cross-checking found Sidebar paths missing from CommandPalette and page metadata. This creates navigation/search/topbar drift even though page routing itself is solid. Suggested direction: derive route, nav, command, meta, and permission data from one typed route manifest.

**[P2][S][Med] Visible field-app/invoice controls are unfinished** - `src/components/field-app/FieldAppChemicalEntry.tsx:295`, `src/components/field-app/FieldAppChemicalEntry.tsx:298`, `src/pages/FieldApplicationInvoice.tsx:573`, `src/pages/Invoices.tsx:568` - Select Recipe, Save As Recipe, and Print have TODO no-op handlers, and the invoice Email button is disabled as "Coming soon". This is user-facing unfinished behavior, not internal polish. Suggested direction: hide the actions or wire them to real recipe/PDF/email services before they remain visible.

**[P2][M][High] Load failures can collapse into empty states** - `src/components/ui/DataTable.tsx:104`, `src/components/ui/DataTable.tsx:110`, `src/pages/Products.tsx:56`, `src/pages/Customers.tsx:40`, `src/pages/Invoices.tsx:120` - `DataTable` distinguishes loading from empty data, but not failed loads. Pages often toast an error, set `loading=false`, and then the table can render "No products/customers/invoices" after the toast disappears. That makes backend/permission/network failures look like real empty data. Suggested direction: add persistent page/table error state with retry, or a shared `LoadState`/query hook.

### Layer B - Data And Logic Layer

**[P1][S][Med] RPC guard can be bypassed by asserting the whole response object** - `src/lib/db.ts:58`, `src/pages/BlendTickets.tsx:251`, `src/pages/BlendTickets.tsx:256`, `src/pages/BlendTickets.tsx:281`, `src/pages/BlendTickets.tsx:286`, `src/pages/BlendTicketDetail.tsx:434`, `src/pages/BlendTicketDetail.tsx:440`, `eslint-local-rules/rules/require-assert-rpc-result.cjs:69` - `assertRpcResult()` only checks whether the argument is null/undefined. Several callsites pass the entire Supabase response object (`result`) instead of `result.data`; a response object is non-null even when `result.error` exists. The local ESLint rule only tracks destructured `{ data }` RPC responses, so this shape is not prevented. This can show success or reset idempotency after a failed RPC. Suggested direction: change these callsites to destructure `{ data, error }`, throw `error`, assert `data`, and tighten the ESLint/test guard to reject whole-response assertions.

**[P1][M][High] Critical writes still create fresh idempotency keys per attempt** - `src/hooks/useIdempotencyKey.ts:7`, `src/hooks/useIdempotencyKey.ts:13`, `src/pages/PaymentHistory.tsx:150`, `src/pages/PaymentHistory.tsx:154`, `src/pages/InventoryPage.tsx:435`, `src/pages/InventoryPage.tsx:438`, `src/pages/InventoryPage.tsx:466`, `src/pages/InventoryPage.tsx:474`, `src/pages/PurchaseOrders.tsx:413`, `src/pages/PurchaseOrders.tsx:416` - the documented hook keeps one key for a user intent and resets only after confirmed success. Several comparable writes still pass `crypto.randomUUID()` directly, including payment voiding, inventory hold release/manual add, and purchase order cancellation. A retry or double click can become a new operation instead of the same deduped attempt. Suggested direction: use `useIdempotencyKey()` or stable per-entity intent keys for these writes; for bulk work, generate stable per-row operation keys.

**[P2][S][Med] Mutation guard is advisory rather than enforced per mutation** - `scripts/validate-frontend.sh:59`, `scripts/validate-frontend.sh:63`, `scripts/validate-frontend.sh:66` - the script checks whether a file with `.update()`/`.delete()` imports `checkMutationResult`, then emits a warning. It does not verify every mutation call has `.select()` and `checkMutationResult()`, and it does not fail on the warning. This means future silent mutation failures can slip in despite the documented rule. Suggested direction: add an AST ESLint rule or safety-net test requiring `.select()` plus `checkMutationResult()` for each update/delete.

**[P2][M][Med] Delivery/inventory quantity rules are duplicated in frontend and RPCs** - `src/pages/DeliveryDetail.tsx:410`, `src/pages/DeliveryDetail.tsx:417`, `supabase/migrations/20260517010000_create_delivery_with_items_cross_delivery_aggregation.sql:145`, `src/pages/InventoryPage.tsx:378` - the UI recomputes remaining quantities by subtracting other active deliveries, and migrations/RPCs also enforce the same rule. Similar hold math exists in inventory. Server enforcement is correct, but duplicate frontend logic can drift and show the wrong preview/maximum before save. Suggested direction: expose server preview/max-quantity data through RPC/view outputs, or centralize read-side calculations in one shared module.

**[P2][S][Low] Read-side RPC errors can render empty or stuck UI** - `src/components/team/WorkloadView.tsx:47`, `src/components/team/WorkloadView.tsx:48`, `src/components/team/RelatedNotes.tsx:38`, `src/components/team/RelatedNotes.tsx:43` - some read RPCs destructure only `data` and either assert only if data exists or do not catch errors. If Supabase returns `data: null` with an error, the user may see an empty widget or a stuck loading panel. Suggested direction: always destructure `error`, throw it, and call `assertRpcResult()` unconditionally where data is required.

**[P2][S][Low] Type-safety exceptions exceed the documented rule** - `docs/workflows/SAFE_DEVELOPMENT_RULES.md:192`, `src/components/ui/DataTable.tsx:27`, `src/components/ui/DataTable.tsx:28`, `src/components/reports/LogbookReport.tsx:70`, `src/components/reports/LogbookReport.tsx:71` - the workflow says no `any` or `@ts-ignore` should remain, aside from the known `reportPdf.ts` exception. Production code still has explicit `any` suppressions in shared UI/report code. This is not breaking the app today, but shared generic components are exactly where row-shape mistakes spread. Suggested direction: replace with `Record<string, unknown>`, typed accessors, or small typed mapper functions.

**[P3][S][Low] Single Supabase client rule is clean but not locally enforced** - `CLAUDE.md:47`, `src/lib/db.ts:14`, `eslint-local-rules/index.cjs:6` - production app code follows the rule today: the browser client is created in `src/lib/db.ts`. The local ESLint rules focus on RPC assertion and Sentry imports, not future `createClient()` value imports in `src`. Suggested direction: add a `no-restricted-imports`/local rule that allows Supabase client creation only in `src/lib/db.ts` and test-only exceptions.

### Layer C - Cross-Cutting Consistency

**[P2][M][High] Money formatting is split across cents and dollars helpers** - `src/lib/reportPdf.ts:37`, `src/pages/InvoiceDetail.tsx:50`, `src/pages/InvoiceDetail.tsx:51` - agent search found 57 currency formatter sites, 181 `/ 100` divisions, and `parseDollarsToCents` use across 15 files. Some helpers format dollars directly (`reportPdf`), while most page helpers divide cents by 100. This raises the risk of double-divide/no-divide mistakes in invoices, exports, and PDFs. Suggested direction: centralize `formatCents`, `formatDollars`, and money input parsing, then keep CSV/PDF wrappers thin and explicit.

**[P2][M][Med] Date-only formatting still bypasses project date utilities** - `src/lib/dateUtils.ts:4`, `src/lib/dateUtils.ts:9`, `src/components/team/CustomerContextCard.tsx:45`, `src/pages/FieldApplicationInvoice.tsx:81`, `src/pages/BlendTickets.tsx:188` - `dateUtils` documents the UTC date bug and says to use local date utilities. Production code still has direct `toISOString().slice(0, 10)` and `new Date(String(v)).toLocaleDateString()` patterns. Date-only fields can shift by timezone or render inconsistently. Suggested direction: route all date-only display/storage through `dateUtils` and add a lint/rg guard for forbidden patterns.

**[P2][S][Med] Activity logging has mixed awaited and fire-and-forget semantics** - `src/lib/activityLogger.ts:17`, `src/lib/activityLogger.ts:29` - the logger intentionally swallows failures so logging does not break the main flow. Agent search found about 81 production `logActivity()` callsites split between awaited and unawaited calls. That makes audit-trail timing inconsistent, especially before navigation or refresh. Suggested direction: define one rule: await audit-critical logs before success/navigation, and use an explicit `void logActivitySafe(...)` wrapper for noncritical logs.

**[P2][M][Med] Toast error handling bypasses the canonical sanitizer** - `src/lib/criticalAction.ts:34`, `src/pages/Reports.tsx:254`, `src/pages/BlendTicketDetail.tsx:446` - `runCriticalAction()` centralizes sanitized error toasts and Sentry for mutation failures, but agent search found 754 direct production toast calls across 85 files and 89 raw `error.message`/`err.message` toasts across 38 files. Users can see database/internal messages, and Sentry capture becomes inconsistent. Suggested direction: move mutation failures through `runCriticalAction()` or a shared `toastError(err)` wrapper.

**[P2][S][High] Schema/reference docs preserve wrong status and column names** - `docs/reference/database-schema.md:75`, `docs/reference/database-schema.md:80`, `src/pages/Invoices.tsx:33`, `src/types/index.ts:1221` - docs list invoice status as `void` and prepay credits as `remaining_cents`; app/types use `voided` and `balance_cents`. These names are enforced by DB constraints and are the kind of mismatch that causes repeated fixups. Suggested direction: correct the docs and add drift checks for status enums and renamed money columns.

**[P2][S][Med] Orphaned mutation-safety docs point to a missing module** - `docs/reference/code-patterns.md:70`, `src/lib/db.ts:65` - docs say `checkMutationResult()` comes from `src/lib/businessLogicEnhancements.ts` and is used on 13 pages, but the real export is `src/lib/db.ts` and actual usage is much broader. New work can copy the wrong import path and undercount coverage. Suggested direction: update the doc to the current `src/lib/db.ts` contract.

**[P3][S][Low] Loading UI has several competing implementations** - `src/components/ui/Skeleton.tsx:5`, `src/pages/NewOrder.tsx:427`, `src/components/inventory/TransactionLedgerModal.tsx:155` - shared Skeleton/Button loading patterns exist, but agent search found 26 inline `animate-spin` implementations across 24 files plus ad hoc loading text. This is mostly UX consistency debt, but it compounds with the load-error issue above. Suggested direction: add shared `PageLoader`/`InlineLoader` guidance and reserve inline spinners for special layouts.

**[P3][S][Low] Native confirm is gone from app code, but stale in E2E tests** - `tests/e2e/workflow-financial-operations.spec.ts:410` - production `src` has 0 `confirm()`/`window.confirm()`/`alert()` matches and many `ConfirmModal` references, which is good. Some E2E comments/handlers still reference native confirm. Suggested direction: update E2E helpers/comments to assert `ConfirmModal` patterns so tests do not teach the old rule.

**[P3][S][Med] Counts and workflow docs drift from source** - `CLAUDE.md:11`, `docs/workflows/UI_PATTERNS.md:43`, `docs/workflows/SAFE_DEVELOPMENT_RULES.md:18`, `docs/reference/code-patterns.md:8`, `src/pages/NewPurchaseOrder.tsx:167` - the main `CLAUDE.md` count matches the map, but UI patterns still says 65 pages, safe-development says 57 pages, and code-patterns says PO numbers use a count query while code uses `next_po_number()`. Suggested direction: regenerate these sections from source or replace static counts with links to generated map/scripts.

## 5. Prioritized Roadmap - If You Only Fix 5 Things

1. **Close the RPC guard blind spot.** Fix the whole-response `assertRpcResult(result, ...)` callsites, require `error` handling, and tighten the ESLint/test rule. This is first because it is small and can prevent false-success UI in production workflows. Effort: S. Risk-to-fix: Med.

2. **Normalize idempotency for critical random-key writes.** Replace direct `crypto.randomUUID()`/`Date.now()` idempotency keys in financial, inventory, and bulk write paths with intent-stable keys. This is second because retries/double-clicks are exactly where live financial/inventory apps need predictability. Effort: M. Risk-to-fix: High if done broadly; lower if handled one workflow at a time.

3. **Create the shared app-layer foundations before adding more UI.** Centralize route metadata, load/error state, money formatting, and date-only formatting. This reduces the "many ways to do one thing" problem and makes future work cheaper. Effort: M. Risk-to-fix: Med.

4. **Decompose the top three workflow pages one at a time.** Start with `QuoteBuilder`, then `DeliveryDetail`, then `BlendTicketDetail`. Do not rewrite the whole app; extract domain hooks/actions/components around existing behavior with narrow tests. Effort: L. Risk-to-fix: Med/High because these are live workflows.

5. **Finish or hide unfinished controls and consolidate bulk import parsing.** Remove visible no-op controls from field-app/invoice paths, then move the CSV parsing/import flow into shared helpers. This is fifth because it is visible to users and prevents another round of importer-specific fixes. Effort: S-M. Risk-to-fix: Low/Med.

## 6. Appendix

Phase 1 map: [2026-05-28-foundation-map.md](./2026-05-28-foundation-map.md)

Key map facts:

- 66 page source files in `src/pages/`.
- 66 lazy page declarations in `src/App.tsx`.
- 72 route entries in `src/App.tsx`, including auth and wildcard routes.
- 150 shared component source/test files under `src/components/`.
- 81 source/test files under `src/lib/`.
- 356 migration files and 7 Edge Function directories excluding `_shared`.
- Every page source file is routed and lazy-loaded.

