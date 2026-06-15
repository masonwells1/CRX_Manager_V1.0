# Foundation Audit Report — CRX Manager V1.0 (2026-05-27)

**Audited by:** Claude Code (claude-sonnet-4-6), read-only + 3 parallel deep-dive subagents
**Scope:** Application layer (React frontend, data/logic layer, cross-cutting consistency)
**Out of scope:** Database security, RLS policies, performance tuning (already hardened)

---

## 1. Headline Verdict — The Rebase Question, Answered

**PARTIAL — Keep almost everything. Refactor 4 specific named areas before building more on them.**

The foundation is structurally correct: one Supabase client, all pages lazy-loaded, money input parsed through a single function, auth context clean, zero `window.confirm()`, zero stray `createClient()` calls, RLS fully enforced. There is no systemic rot. You should not rebase.

However, three technical debt clusters will keep causing rework if left unaddressed: (1) no shared money-display utility (17–32 identical closures scattered everywhere — any display change requires touching dozens of files), (2) two god-components (QuoteBuilder at 2,493 lines and DeliveryDetail at 2,273 lines) where every feature addition is risky because so much state is shared in one place, and (3) a dead test library (quoteCalc.ts) whose tests pass but never exercise production code — giving false confidence on the most important financial calculation in the app.

---

## 2. Plain-English Executive Summary

**Overall foundation grade: Fair**

The app was built carefully and incrementally — it follows most of its own rules. The security and data-integrity concerns from prior audits are genuinely closed. But several specific areas are causing you to rework the same things repeatedly:

**Top 5 root causes of the rework cycle:**

1. **No shared money-display function.** Every page that shows a dollar amount on screen defines its own private `fmt` function. There are at least 17 exact duplicates, plus two other competing patterns (`.toFixed(2)` showing bare `12.50` instead of `$12.50`, and a locale-unsafe `toLocaleString(undefined)` that would break on non-US browsers). When currency display needs to change — even one comma placement or rounding rule — 32 files need updating, and they'll drift apart again.

2. **Two pages are doing too many jobs at once.** QuoteBuilder (2,493 lines, 49 state variables) and DeliveryDetail (2,273 lines, 54 state variables) each embed 5–6 distinct features in one file. Making any change to either touches code for all the other concerns at the same time. This is why those pages feel like a minefield.

3. **The quote-math test suite gives false confidence.** There is a `quoteCalc.ts` library that is well-tested — but QuoteBuilder doesn't use it. It has its own inline copy that adds price override handling the library doesn't have. The tests pass, but they're validating a dead code path. A bug introduced in QuoteBuilder's inline math won't be caught by the tests.

4. **Error handling is split down the middle.** About half the pages use the `runCriticalAction()` wrapper (which sanitizes errors before showing them to users). The other half use raw `try/catch` with `toast(err.message)`, which can expose Postgres internals to users on pages like JobDetail, BlendTicketDetail, and Reports. There are also three confirmed live gaps: one page throws a false error on a valid operation (Mark All Read when there's nothing to mark), and one operational page (DispatchBoard) has a mutation with no error handling at all.

5. **The "how to do X" documentation is wrong in several places.** Developers (and AI assistants) reading `code-patterns.md` are told `checkMutationResult` lives in `businessLogicEnhancements.ts` (a file that doesn't exist), that it's used on "13 pages" (it's used in 43 files), that idempotency is on "24 pages" (it's actually 35+), and that several number formats use a count query (they use RPCs). Wrong documentation is a direct cause of rework because it leads to implementing things the wrong way and then fixing them.

---

## 3. Per-Area Verdict Table

| Area | Verdict | Why (1 line) | Rough effort to fix |
|------|---------|--------------|---------------------|
| Routing & lazy-loading | **Solid** | All 66 pages lazy-loaded, all routes role-guarded correctly | — |
| Supabase client singleton | **Solid** | Single client in db.ts; zero stray createClient() calls | — |
| Auth context | **Solid** | AuthContext is 143 lines, clean, correct retry logic | — |
| RPC guard coverage | **Solid** | assertRpcResult + checkMutationResult used broadly; ESLint enforced | — |
| Money input parsing | **Solid** | parseDollarsToCents used correctly in all 12 financial input pages | — |
| Type safety | **Solid** | Only 2 `as any` in whole codebase; 1 sanctioned, 1 minor (LogbookReport) | — |
| Money display formatting | **Refactor** | 17–32 duplicate `fmt` closures; 3 competing patterns, 1 locale-unsafe | S (< 1 day) |
| Error handling consistency | **Refactor** | `runCriticalAction`/`sanitizeError` adoption only ~50%; 3 live gaps | M (1–3 days) |
| Date display formatting | **Refactor** | 2 competing date-to-display patterns across 33 pages; no display helper | S (< 1 day) |
| QuoteBuilder.tsx | **Refactor** | 2,493 lines / 49 useState / 5+ embedded concerns = rework magnet | L (1 week+) |
| DeliveryDetail.tsx | **Refactor** | 2,273 lines / 54 useState / 6 embedded concerns = rework magnet | L (1 week+) |
| quoteCalc.ts test gap | **Refactor** | Production uses inline copy; library tests give false confidence | M (1–3 days) |
| Documentation drift | **Refactor** | 5+ wrong claims in code-patterns.md; wrong file path cited | S (< 1 day) |
| Shared UI components | **Refactor** | EmptyState bypassed by 40 pages; Skeleton inconsistent; 4 spinner variants | S–M |
| Loading/filter performance | **Refactor** | 50+ pages run `.filter()` in render body; useMemo used in only 4 | S per page |

---

## 4. Severity-Ranked Findings

### Layer B — Data + Logic Layer

**[P1][S][High] DispatchBoard.tsx `handleAssign` has no try/catch — silent failure on job scheduling**
`src/pages/DispatchBoard.tsx:146-167`
`handleAssign` calls `checkMutationResult` (which throws on RLS denial) and `logActivity` with no surrounding try/catch. If the assignment update fails, no user feedback, no Sentry capture — the dispatcher thinks the job is assigned when it isn't. This is an operational page where silent failures affect same-day job scheduling.
_Direction: wrap in try/catch with `toast.error(sanitizeError(err))` and `Sentry.captureException`._

**[P1][S][Med] `checkMutationResult` misused on Mark All Read — false error in production**
`src/pages/Notifications.tsx:90`, `src/components/team/NotificationsPanel.tsx:100`
Both files call `checkMutationResult` on a `.update().eq('is_read', false)` that legitimately returns `[]` when all notifications are already read. `checkMutationResult` throws on empty array. Users who click "Mark All Read" when already caught up see an error toast for a valid no-op.
_Direction: Replace `checkMutationResult(...)` with a plain `if (result.error) throw result.error` — zero rows affected is a success here._

**[P1][M][Med] `quoteCalc.ts` is a dead library — production runs untested inline code for core financial math**
`src/lib/quoteCalc.ts` (entire file) vs `src/pages/QuoteBuilder.tsx:508-578`
`quoteCalc.ts` exports `getTierPrice`, `recalcItem`, and `computeQuoteTotals` with a passing test suite. QuoteBuilder does NOT import it — it has its own inline copy that adds `price_override` handling the library doesn't. Tests pass on code never called in production. A bug in QuoteBuilder's inline tier-price math would not be caught by any test.
`validateCommissionSplits` in `quoteCalc.ts:152` is also duplicated inline in `QuoteBuilder.tsx:800` without importing.
_Direction: Add `price_override` support to `quoteCalc.ts`, import the library functions from QuoteBuilder, and ensure the `price_override` branch is tested._

**[P1][L][Med] QuoteBuilder.tsx — 2,493 lines, 49 useState, 5+ embedded concerns**
`src/pages/QuoteBuilder.tsx`
Handles simultaneously: (1) multi-line quote form (lines 146–1355), (2) version history viewer + restore flow (lines 200–204, 1090–1200), (3) season rollover modal (lines 222–223, 1033–1080), (4) save-as/load-from template modals (lines 218–219, 937–1000), (5) PDF preview + column picker (lines 211–215, 1086–1148), (6) per-section job-scheduling flow (lines ~1155–1206). All concerns share a single state space with 49 useState declarations. Changing the template feature risks breaking the PDF feature because they share state.
_Direction: Extract the product-search modal, version history panel, PDF column picker, and template modals to `src/components/quotes/`. The 6-concern mega-component won't survive another year of feature additions._

**[P1][L][Med] DeliveryDetail.tsx — 2,273 lines, 54 useState, 6 embedded concerns**
`src/pages/DeliveryDetail.tsx`
Handles: (1) delivery header + view, (2) inline edit mode with item add/remove and sequential 4-query max-quantity cascade (lines 387–610), (3) confirm-delivery two-step modal with signature canvas, (4) driver assignment/reassignment, (5) photo upload to Supabase Storage, (6) cancellation/void flows. 54 useState declarations, all at the top level of one component.
_Direction: Extract `DeliveryEditor` (the inline edit engine) and `DeliveryPhotos` (photo upload) to `src/components/deliveries/` as a first step — they have the most isolated state of the 6 concerns._

**[P1][M][Low] No shared currency formatting utility — 17–32 identical closures scattered codebase-wide**
`src/pages/ARaging.tsx:153`, `src/pages/InvoiceDetail.tsx:50`, `src/pages/Invoices.tsx:67`, `src/pages/PaymentAllocation.tsx:32`, `src/pages/PrepaymentManager.tsx:47`, and 12+ more
Every financial page independently defines `const fmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100)`. Additionally, 23 occurrences across 13 pages use `.toFixed(2)` (which produces bare `12.50` not `$12.50`), and 4 pages use `toLocaleString(undefined, ...)` (locale-unsafe). `ARaging.tsx` defines the same closure THREE times in the same file (lines 153, 488, 594).
`Jobs.tsx:174-175` uses `toLocaleString(undefined, ...)` in the CSV export path — on a Canadian French browser this outputs `1 234,56 $` instead of `$1,234.56`.
_Direction: Create `src/lib/formatters.ts` exporting `formatCents(cents: number): string` and `formatDollars(dollars: number): string`. Replace all 32 definitions. This is the single highest-leverage low-risk fix._

**[P2][S][Low] Quote-status revert catch silently swallows failure — no Sentry capture**
`src/pages/QuoteBuilder.tsx:1319-1321`
After a failed `convert_quote_to_order`, the code tries to revert quote status from `'accepted'` back to `'sent'`. If that revert also fails, the catch block has only a comment `// Best effort — status revert failed` with no `Sentry.captureException`. The quote stays permanently in `'accepted'` with no visibility.
_Direction: Add `Sentry.captureException` in the catch._

**[P2][S][Low] `LogbookReport.tsx:71` — `as any[]` removes type safety on Supabase join**
`src/components/reports/LogbookReport.tsx:71`
The Supabase query `select('id, field_name, customer:customers(farm_name)')` returns a typed join result. Casting to `any[]` removes the compiler's ability to flag `r.customer?.farm_name` if the alias or column changes. This is the only `as any` cast outside the two sanctioned uses.
_Direction: Define a local interface for the join shape and remove the cast._

**[P2][S][Low] `validateCommissionSplits` duplicated inline in QuoteBuilder — not imported from quoteCalc.ts**
`src/lib/quoteCalc.ts:152` and `src/pages/QuoteBuilder.tsx:800`
The 100%-sum check for commission splits exists in both locations. Related to the P1 dead-library finding.
_Direction: Fix as part of the quoteCalc.ts integration (P1 above)._

**[P2][S][Low] `useIdempotencyKey` generates keys with empty-string user prefix when profile not yet loaded**
`src/pages/BlendTicketDetail.tsx:34`, `Returns.tsx:63`, and 40+ similar
`profile?.id || ''` fallback means keys generated before auth resolves use `''` as user segment. No collision occurs (UUID suffix is still unique), but server-side key attribution is broken for those brief window cases.
_Direction: Use `profile?.id ?? 'anon'` or document as a known acceptable edge case._

**[P3][S][Low] `Jobs.tsx:174` — locale-unsafe `toLocaleString(undefined)` in CSV export**
`src/pages/Jobs.tsx:174-175`
All other pages use `Intl.NumberFormat('en-US', ...)`. Jobs.tsx uses `toLocaleString(undefined, { minimumFractionDigits: 2 })`. In a Canadian French locale, CSV values would use comma decimals and period thousands separators. Affects exported files, not on-screen UI.
_Direction: Fix as part of the formatCents() migration (P1 above)._

**[P3][S][Low] `commissions.commission_amount` is dollar-valued `numeric`, not cents — latent risk**
`src/types/index.ts:616` (Commission interface)
All other financial fields are `bigint cents`. `commission_amount: number` is correct for the column type but if passed to a `formatCents()` function it would display as 100x the actual value. No current bug, but the schema gotcha is documented only in CLAUDE.md.
_Direction: Add a JSDoc comment to the Commission interface: `/** Dollar value (not cents) — see CLAUDE.md Schema Gotchas */`_

---

### Layer A — Frontend Structure

**[P2][S][Low] Loading state expressed in 4 different ways across 37+ pages**
`src/pages/InvoiceDetail.tsx:765`, `MonthEndClose.tsx:290`, `VendorBillDetail.tsx:361`, `PrepayWorkspace.tsx:396`, and 6 more use raw `<div className="...border-t-transparent rounded-full animate-spin" />`; 3 pages use inline `animate-pulse` without the Skeleton component; 17 pages correctly use `<SkeletonTable />` or `<SkeletonCard />`; `BlendTickets.tsx:512` uses `<Clock className="animate-spin" />` (semantically wrong icon). `PageLoader` in App.tsx is not exported as a shared component. `ApplicationServiceDetail.tsx:135` builds a custom two-block skeleton without Skeleton.tsx.
_Direction: Export `PageLoader` from `src/components/ui/PageLoader.tsx`. Use it consistently._

**[P2][S][Low] `EmptyState` component exists but bypassed by 40+ pages**
`src/components/ui/EmptyState.tsx` (exists, used only in 5 pages)
Forty other pages have ad-hoc empty state text with inconsistent color, padding, font size. Examples: `DeliveryDetail.tsx:2231`, `CustomerDetail.tsx:521`.
_Direction: Migrate the highest-traffic pages to `<EmptyState />` incrementally._

**[P2][M][Low] Client-side filtering runs `.filter()` in render body on 49 of 53 list pages**
`src/pages/Invoices.tsx:158`, `Orders.tsx`, `Customers.tsx`, `Products.tsx`, `Jobs.tsx`, etc.
Only 4 pages (`Deliveries.tsx`, `DispatchBoard.tsx`, `PurchaseOrders.tsx`, `QuoteBuilder.tsx`) use `useMemo` to derive filtered rows. The other 49 re-filter on every re-render. With query limits up to 2,000 rows (`Invoices.tsx:109`), every keystroke in a filter input synchronously re-filters the full dataset.
_Direction: Wrap filter expressions in `useMemo([deps])` — a one-liner fix per page, zero behavioral change._

**[P2][M][Low] Priority-badge mapping duplicated in 4 files with divergent implementations**
`src/pages/Deliveries.tsx:67` (function returning `<Badge>`), `DeliveryDetail.tsx:60` (Record<string,BadgeVariant>), `DispatchBoard.tsx:139` (inline record), `Dashboard.tsx:204` (raw bg/text classes, bypasses Badge component)
Same four priority values represented four different ways. Dashboard uses raw Tailwind instead of the Badge component — visual inconsistency on the ops dashboard.
_Direction: Extract `<PriorityBadge priority={p} />` to `src/components/ui/`._

**[P2][M][Low] Invoice status-badge mapping duplicated between Invoices.tsx and InvoiceDetail.tsx**
`src/pages/Invoices.tsx:44` and `src/pages/InvoiceDetail.tsx:53`
Both define a complete `statusBadge(status: InvoiceStatus)` function with identical map objects. If a new status is added to the DB (e.g., `'canceled'`), both files must be updated.
_Direction: Extract `<InvoiceStatusBadge status={s} />` to `src/components/invoices/`._

**[P2][M][Low] CustomerDetail.tsx — 1,435 lines with 8 tab sections, each fetching independently**
`src/pages/CustomerDetail.tsx`
8 tabs (info, timeline, fields, quotes, orders, deliveries, financials, history) with 29 useState declarations. Each tab lazy-fetches its own data on tab switch. The `financials` tab independently re-fetches AR aging and transaction data already loaded by parent queries on other pages.
_Direction: Extract `CustomerFinancials`, `CustomerTimeline` to sub-components with their own fetch hooks; reduces risk of cross-tab state pollution._

**[P2][M][Low] ARaging.tsx defines the same `fmtCents` closure 3 times in one file**
`src/pages/ARaging.tsx:153`, `488`, `594`
A single page has 3 non-deduplicated closures for the same formatting operation, making it the most extreme case of the currency-display fragmentation problem.
_Direction: Fix as part of the formatCents() migration (P1 above)._

**[P2][S][Low] PaymentHistory page has no sidebar navigation link**
`src/App.tsx:200` (route exists), `src/components/layout/Sidebar.tsx` (no entry)
`/payment-history` is routed and the page exists but is not listed in the sidebar Finance section. Reachable only from `InvoiceDetail.tsx` via direct link. Verify whether this is intentional.
_Direction: Confirm intent; add sidebar link if it should be discoverable._

---

### Layer C — Cross-cutting Consistency

**[P1][S][Low] `businessLogicEnhancements.ts` cited in docs but does not exist**
`docs/reference/code-patterns.md:70`
`code-patterns.md` says `checkMutationResult` lives in `src/lib/businessLogicEnhancements.ts`. That file does not exist. `checkMutationResult` is in `src/lib/db.ts:65`. A developer (or AI) following the doc literally writes a failing import. Only `businessLogicEnhancements.test.ts` exists — and it actually tests notification trigger functions, not checkMutationResult.
_Direction: Update `code-patterns.md:70` to `src/lib/db.ts`. Consider renaming the test file._

**[P2][S][Low] Date display uses two competing patterns across 33 pages**
`src/pages/Invoices.tsx:477`, `Orders.tsx:485`, `Dashboard.tsx:190`, and 30+ more
Pattern 1 (20 pages): `parseLocalDate(str).toLocaleDateString()` — correct, timezone-safe.
Pattern 2 (33 pages): `new Date(str + 'T00:00:00').toLocaleDateString()` — ad-hoc timezone workaround.
Both patterns call `.toLocaleDateString()` with no locale argument — output is browser-locale-dependent.
No `formatDisplayDate()` helper exists in dateUtils.ts (which only has DB-input helpers).
_Direction: Add `formatDisplayDate(isoString: string): string` to `src/lib/dateUtils.ts` wrapping `parseLocalDate().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })`._

**[P2][S][Low] `runCriticalAction()` adopted in only 24 of 55 pages with try/catch blocks**
`DeliveryDetail.tsx` (10 try blocks, 0 `runCriticalAction`), `JobDetail.tsx` (6 try blocks, 0), `FieldApplicationInvoice.tsx` (5 try blocks, 0)
Pages not using `runCriticalAction` bypass both `sanitizeError()` (Postgres internals can reach users) and consistent Sentry capture. About 30 pages toast `err.message` directly.
_Direction: Migrate the 3 highest-traffic pages above as a first step. Document this as the required error pattern for new pages._

**[P2][S][Low] `sanitizeError()` bypassed in 30 pages — Postgres internals can reach users**
`src/pages/JobDetail.tsx` (6 raw toasts), `BlendTicketDetail.tsx` (8), `Reports.tsx` (9), `CommissionPayments.tsx` (4)
Pages using raw `catch (err)` then `toast.error(err.message)` can show strings like `"ERROR: duplicate key value violates unique constraint 'orders_pkey'"` to users. Overlap with the `runCriticalAction` gap above.
_Direction: Part of the same runCriticalAction migration._

**[P2][S][Low] `entityType` in `logActivity()` has no TypeScript enum — ad-hoc strings cause drift**
`src/lib/activityLogger.ts:8` (`entityType?: string`)
Callsites use at least 15 distinct string values with no canonical list. `CropPrograms.tsx:234` uses `'setting'` (should be `'crop_program'`). `ARaging.tsx:578` uses `'system'` with a null entity ID — non-navigable but accepted by the type. No DB CHECK constraint, no TypeScript union.
_Direction: Add `ActivityEntityType` union to `src/types/index.ts`; change the signature to enforce it._

**[P2][S][Low] 5 stale count claims in `code-patterns.md`**
- "Used on 13 pages" for checkMutationResult → actual: 43 files
- "All 24 pages with write operations use `useIdempotencyKey()`" → actual: 35+ pages
- Page count: UI_PATTERNS.md says 65, CLAUDE.md says 66, reality is 66 — UI_PATTERNS.md is 1 off
- Number formats (Invoice, Return, Cycle Count, PO) described as "count query" → all now use RPCs
- `code-patterns.md:100` describes `runCriticalAction` return as `{ success, data?, error? }` → actual return is `T | undefined`
_Direction: Single cleanup commit to code-patterns.md and UI_PATTERNS.md._

**[P2][S][Low] `logActivity()` not called in 4 financial/inventory mutation pages**
`PaymentAllocation.tsx`, `PrepayWorkspace.tsx`, `VendorBillDetail.tsx`, `QuickReceive.tsx`
These pages commit financial or inventory mutations (check recording, prepay batch, vendor bill payment, bulk receiving) without any `logActivity()` call. The activity feed is therefore silent for these operations.
_Direction: Add `logActivity` calls for the key mutations (record_payment, batch_apply_prepayments, record_bill_payment, quick_receive_items)._

**[P3][S][Low] Loading spinners have 4 distinct visual implementations**
`App.tsx:88` (border-4, w-8), many pages inline the same, `SelectLocationsModal.tsx:208` (border-4, w-6), `CycleCounts.tsx:600` (border-2, w-6), `PaymentAllocation.tsx:513` (border-3 — non-standard Tailwind class), `BlendTickets.tsx:512` (Clock icon animated — wrong icon for a spinner)
_Direction: Export `PageLoader` from `src/components/ui/PageLoader.tsx`. Migrate inline spinners._

**[P3][S][Low] `toLocaleDateString()` called without locale arg in 55 occurrences / 31 pages**
Affects date display on browsers not set to `en-US`.
_Direction: Fix as part of `formatDisplayDate()` addition (P2 above)._

---

## 5. Prioritized Roadmap — "If You Only Fix 5 Things"

These are ordered so safe, high-leverage work comes first and each fix sets up the next.

### Fix 1: `formatCents()` + `formatDisplayDate()` utilities
**What:** Add `src/lib/formatters.ts` exporting `formatCents(n: number): string` and `formatDollars(n: number): string`. Add `formatDisplayDate(iso: string): string` to `src/lib/dateUtils.ts`. Then replace all 32 `fmt` closures and all 55 bare `toLocaleDateString()` calls.
**Why first:** Zero risk (pure display). Eliminates the #1 source of copy-paste rework. Once it exists, the rule "use formatCents" can be enforced by an ESLint rule. Every subsequent financial page becomes a one-liner. Also fixes the locale-unsafe `Jobs.tsx` CSV export.
**Effort:** S (< 1 day for the utility + 1 day to migrate pages iteratively).
**Risk to fix:** Low — pure display change, no data mutation.

### Fix 2: `code-patterns.md` doc cleanup + the two live bugs
**What:** (a) Update `code-patterns.md` — fix the nonexistent `businessLogicEnhancements.ts` reference, update all 5 stale counts, fix the `runCriticalAction` return-type description, fix number-format descriptions. Update `UI_PATTERNS.md` page count to 66. (b) Fix the Mark All Read false error (2 lines). (c) Fix DispatchBoard handleAssign silent failure (wrap in try/catch, 6 lines).
**Why second:** The doc fix takes 30 minutes and eliminates misleading guidance that directly causes future rework and bugs. The two live bugs are small to fix and genuinely affect users today.
**Effort:** S (half day total).
**Risk to fix:** Low for docs, Low for the bug fixes.

### Fix 3: Integrate `quoteCalc.ts` into production + fix validateCommissionSplits
**What:** Add `price_override` support to `quoteCalc.ts`, import `getTierPrice`/`recalcItem`/`computeQuoteTotals`/`validateCommissionSplits` into QuoteBuilder.tsx (replacing the inline duplicates). Ensure tests cover the `price_override` branch.
**Why third:** Right now your quote math tests are validating dead code. A pricing bug in QuoteBuilder would be invisible to the test suite. This gives your tests real coverage of the most important financial calculation in the app. Do this before any future quote-math changes.
**Effort:** M (2–3 days — the inline code and library diverge, needs careful integration + test coverage).
**Risk to fix:** Med — touches live quote creation logic. Run E2E quote tests after. No schema change.

### Fix 4: Error-handling consistency for the 3 highest-traffic unhardened pages
**What:** Migrate `DeliveryDetail.tsx`, `JobDetail.tsx`, and `BlendTicketDetail.tsx` from raw try/catch to `runCriticalAction()`. These 3 pages have 10, 6, and 9 try blocks respectively, none using the centralized wrapper.
**Why fourth:** These are some of the most-used pages in daily operations. Currently, any Supabase error on these pages can show Postgres internals to users and goes uncaptured in Sentry. Sentry blind spots mean you find out about production errors from user reports, not dashboards.
**Effort:** M (1–2 days for all three).
**Risk to fix:** Low — behavior is identical; only changes what happens in the catch branch.

### Fix 5: QuoteBuilder.tsx — extract the embedded modals
**What:** Extract the version history panel, PDF column picker, save-as/load-from template modals, and season rollover modal to `src/components/quotes/`. Don't try to split the entire component — just remove the 4 self-contained embedded modals that have the most isolated state. This would reduce QuoteBuilder from ~2,493 lines to approximately 1,800 lines and cut its `useState` count from 49 to ~38.
**Why fifth:** QuoteBuilder is the #1 most-touched file for new features. Every feature addition is a land mine because 49 state variables are all shared. The embedded modals are the cleanest extraction targets (each has a visible `open/close` state that acts as a natural component boundary). DeliveryDetail.tsx follows the same logic for DeliveryEditor and DeliveryPhotos.
**Effort:** L (1 week for QuoteBuilder, another for DeliveryDetail if done together).
**Risk to fix:** Med — touches the most financially critical page. Do with thorough E2E coverage.

---

## 6. Appendix — Phase 1 Map

Full inventory (page sizes, component catalog, data flow traces) in [2026-05-27-foundation-map.md](2026-05-27-foundation-map.md).

### Quick reference: findings by count

| Severity | Count | Fixed by Top-5 Roadmap? |
|----------|-------|------------------------|
| P0 | 0 | — |
| P1 | 7 | Fixes 1, 2, 3, 4, 5 cover all P1s |
| P2 | 18 | Fixes 1+2 cover ~8; rest are P2 queue items |
| P3 | 8 | Defer; polish only |

### What is explicitly NOT a problem
- RLS security (0 WARN on Supabase advisor — confirmed solid)
- Money *input* parsing (parseDollarsToCents used correctly across all 12 financial input pages)
- Auth context (clean, correct retry logic, no re-fetch issues found)
- Supabase client (single, correct, no stray clients)
- Lazy-loading (all 66 pages use React.lazy correctly)
- Role-based routing (all routes role-guarded, no bypass found)
- `window.confirm` / `confirm()` (zero occurrences — ConfirmModal used everywhere)
- Direct `@sentry/react` imports (zero — wrapper import enforced)
- `message.includes()` for RPC error matching (zero — pattern not used)
- Idempotency on critical writes (35+ pages use useIdempotencyKey)

---

*Audit performed 2026-05-27. Read-only — no files modified. Three parallel subagents analyzed Layers A, B, C independently. Findings merged and deduplicated in Phase 3 synthesis.*
