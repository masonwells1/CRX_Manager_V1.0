> **Generated:** 2026-06-02 · **Type:** Read-only structure / simplification / refactor review
> **Method:** Dynamic multi-agent workflow — 33 parallel reviewers (15 deep-file + 12 cross-file sweeps + 6 cross-cutting) across all 343 TS/TSX files (~104k lines) in `src/`. 270 findings collected; the 39 high-impact ones were each adversarially re-checked against the live code by a skeptic agent (6 refuted — see §8). 73 agents, ~22 min, read-only (no code or DB changed).
> **Status:** REPORT ONLY — nothing applied. Use this to choose what to change; apply in priority order on a branch with build+lint+test after each step.

# Ultra Code Review — Structure, Simplification & Refactor

## 1. Executive summary

The codebase is **structurally healthy but heavy with repetition**. There are no detected correctness regressions in the reviewed scope — the recurring theme is the same patterns being copy-pasted instead of shared: a cents-to-currency formatter duplicated across **~60 files**, `getTierPrice` tier-pricing logic re-implemented in **4 production files** plus a tested-but-unused `quoteCalc.ts`, PDF brand colors and type aliases in **10 PDF modules**, and `getPresetDates` date logic in **5 places**. The second theme is **a handful of giant page files** (QuoteBuilder 2,616 lines; DeliveryDetail 2,433; BlendTicketDetail, OrderDetail, InventoryPage, Reports, CustomerDetail all 1,100–1,500+) where data-fetching, business state, and JSX are all tangled in one component.

Roughly **70% of the value is quick-win**: shared formatters, deleting confirmed dead code, consolidating duplicate constants — all low-risk and mechanical. The remaining **30% is "big rocks"**: decomposing the oversized pages into hooks + sub-components. Most decompositions are genuinely behavior-preserving, **but several touch money math, lifecycle transitions, idempotency keys, or RLS-scoped fetches** — and the adversarial reviewers flagged those for elevated risk regardless of how cosmetic they look. **6 findings were refuted outright** and are listed in section 8 — do not act on those blindly.

The golden rule for this report: **anything that moves code which computes money, changes a status, resets an idempotency key, or scopes a query by user/role is HIGH risk** even when the diff looks like a simple cut-and-paste. Those get done last, one at a time, with Codex cross-review.

---

## 2. Quick wins (do first)

These are LOW-RISK and high-value. None touch money math, lifecycle, RLS, idempotency, or audit logic.

| file:line | what | why | effort |
|---|---|---|---|
| `src/pages/OrderDetail.tsx:1124-1125` | Delete two no-op ternaries (`editing ? item.total_units_needed : item.total_units_needed`) | Both branches identical — pure noise | small |
| `src/pages/CustomerDetail.tsx:201-204` | Delete phantom `const { data: items } = { data: null }; void items;` stub | Dead leftover that misleads readers into thinking a fetch happens | small |
| `src/pages/DeliveryDetail.tsx:132,408` | Delete write-only `setOrderItems` state | Getter discarded; value never read | small |
| `src/pages/JobDetail.tsx:137,231` | Delete write-only `setJobId` state | Page always uses `id` from `useParams()` | small |
| `src/pages/PurchaseOrderDetail.tsx:367` | Delete duplicate `reverseIdem.resetKey()` call | Second call is a copy-paste no-op | small |
| `src/pages/ReceivingLog.tsx:129-131` | Delete redundant 2nd `useEffect` calling `fetchData` | Causes a double RPC call on every mount and filter change | small |
| `src/pages/Invoices.tsx:509-514` | Collapse `anySelectedHasShares` + `anySelectedIsFieldApp` (identical expressions) into one | Removes a duplicate `.some()` scan and confusion | small |
| `src/pages/BlendTicketDetail.tsx:824-833` | Delete duplicate `<details>` raw-OCR block (keep the stateful toggle at 1585) | User currently sees two OCR viewers on one page | small |
| `src/lib/db.ts:28-32` | Remove static `X-Request-ID` from `global.headers` | Overwritten per-fetch on line 33-44; dead | small |
| `src/components/team/CommentsSection.tsx:32,35` | Remove unused `noteTitle` prop | Declared, never read; callers pass a no-op | small |
| `src/components/reports/YearEndSummaryDialog.tsx:25` | Inline `getCurrentSeason()` → call `computeSeason()` directly | Trivial one-liner wrapper adds nothing | small |
| `src/hooks/useOCRThresholds.ts` | Replace hook with direct `OCR_CONFIDENCE_THRESHOLD` constant import | It's a static constant disguised as a React hook | small |
| `src/pages/ApplicationServiceDetail.tsx:26`, `src/pages/ProgramTracker.tsx:35` | Replace private `currentSeason()` with shared `computeSeason()` | Two shadow copies of a tested util | small |
| `src/pages/BlendTickets.tsx:33`, `BlendTicketDetail.tsx:31`, `DispatchBoard.tsx:36` | Remove dead `usePageMeta()` calls (result never captured; AppLayout already calls it) | Unnecessary `useLocation()` subscription per render | small |
| `src/pages/ARaging.tsx:488,594` | Delete inner `fmtCents` re-declarations that shadow module-scope version | Same output, just noise | small |
| `src/components/ui/UnsavedChangesModal.tsx:36-38` | Replace inline warning `<svg>` with Lucide `AlertTriangle` | Every other modal uses Lucide; pixel-equivalent | small |
| `src/pages/ProductDetail.tsx:129-145` | Collapse 3 repeated tier-price negative-check blocks into a loop | Same logic ×3 | small |
| Multiple PDF files | Extract `JsPDFWithAutoTable` type alias (declared identically in 10 files) to a shared `pdfTheme.ts` | Pure type boilerplate | small |
| `src/components/ui/CommandPalette.test.tsx:113-140` | Move `recordPageVisit` tests to a new `src/lib/recentPages.test.ts` | Library tests live in the wrong file | small |

A **set of IIFE-in-JSX cleanups** also qualify as quick wins (hoist the immediately-invoked function to a named `const`/`useMemo` above the return): `QuoteBuilder.tsx:1695-1770`, `OrderDetail.tsx:848-878`, `BlendTicketDetail.tsx:1386-1403` & `1295-1306`, `InventoryPage.tsx:1469-1511`, `PurchaseOrderDetail.tsx:968-1007`, `CustomerDetail.tsx:961-1062`, `BlendTickets.tsx:562-611`. Each is behavior-neutral and improves readability.

---

## 3. Big rocks — large files to decompose

These are the oversized files. Each plan is **behavior-preserving in principle**, but read the risk note carefully — several keep money/lifecycle handlers in the parent (good) yet still require careful prop-threading.

### QuoteBuilder.tsx (2,616 lines) — `src/pages/QuoteBuilder.tsx`
**Extract targets** (all verified to hold up by adversaries, except the full-hook):
- `QuoteItemRow.tsx` ← lines 2010–2264 (the ~250-line line-item `<tr>`). **Risk: MEDIUM** — the row embeds pricing/margin logic (price-override at 2064-2072, `calc_mode` flips at 2137/2180/2210). Thread `tier`/`getTierPrice`/`unitConversions` exactly; add a before/after numeric diff test on price_override, total_price, profit, net_margin.
- `QuoteSectionCard.tsx` ← lines 1872–2275. **Risk: LOW.** Note: must also pass `customerId` (used at 1922) and reuse the inline `fields` shape — there is no `FieldOption` type in the repo.
- `QuoteVersionHistory.tsx` ← lines 1522–1773. **Risk: LOW** — restore handler (the only mutation) stays in parent as a callback; must export the file-local `LocalSection`/`LocalItem` types.
- **`buildPdfData` helper** ← consolidate the duplicated 40+ line PDF object in `handleDownloadPdf` (992-1043) and `handlePreviewQuote` (1057-1106).

**STOP / do NOT do as one move:** the full `useQuoteBuilder` hook extraction (the "thin shell" idea) was **refuted** — see section 8. It sweeps money math, lifecycle status transitions, all 9 idempotency keys, and audit logging into one giant move with thin test coverage. **Risk: HIGH.**

### DeliveryDetail.tsx (2,433 lines) — `src/pages/DeliveryDetail.tsx`
- Split into `DeliveryDriverView` (1074-1424) + `DeliveryAdminView` (1427-2433); parent keeps all state/handlers. **Risk: HIGH** (adversary override) — the parent handlers call `complete_delivery`/`confirm_delivery`/`void_delivery`/`edit_delivery` + offline queue. The split is mechanically sound but threads ~30 props; do it in **two stages**, verify build + 1,924 tests + manual driver/admin smoke between.
- `useDeliveryData(id)` hook ← `fetchDelivery` (187-321). **Risk: MEDIUM** — it's also the refetch for 7 lifecycle-mutation handlers; must re-export `refetch` and all 15 state values.
- `buildDeliveryCompletedEmailHtml` helper ← dedupe the verbatim email HTML in `handleComplete` (868-941) and `handleResendEmail` (960-1021).
- `QuantityStepper` component ← the −/input/+ block duplicated at 1215, 1766, 2050.
- `useDeliveryEditMode` hook ← the 10 edit-state slices (112-121). **Risk: MEDIUM.**

### BlendTicketDetail.tsx (~1,700 lines) — `src/pages/BlendTicketDetail.tsx`
- `BlendTicketProductsCard.tsx` ← 1063-1216. **Risk: LOW** (verified) — the two `parseFloat` calls are on quantity/rate, NOT money.
- `BlendTicketFieldsCard.tsx` ← 1218-1313.
- Extend `handleLinkToOrder` to take an optional `orderId` — removes the 24-line verbatim copy at 1346-1369.
- `handleError(err, context, fallback)` helper ← the 7 identical catch blocks.
- `setField` helper ← the ~16 repeated `setFormData({...formData, x})` spreads.

**STOP:** the `useBlendTicketData` full-monolith hook was **refuted** (see section 8) — `products`/`ticketFields`/`suggestedOrder` are set in-component too, and `products` is the array sent to `save_blend_ticket`. **Risk: HIGH.** Salvage only the pure read-and-derive portion.

### OrderDetail.tsx (~1,591 lines) — `src/pages/OrderDetail.tsx`
- `useOrderDetail` hook ← `fetchOrder`/`fetchProducts` (119-252). **Risk: MEDIUM** — must re-export `setOrder`/`setEditItems` (used by surviving handlers) and preserve optimistic `setOrder` semantics.
- `OrderItemsTable` ← 1103-1263. **Risk: LOW** — but add `editItems` to props (New-Total footer reads it at 1252).
- `OrderBillSplit` ← 74-79 / 583-647 / 1265-1373. **Risk: MEDIUM** — moves dollars→cents math (615), the ≤100% guard, and the invoice-lifecycle `sharesLocked` gate (tied to a DB trigger). Pass `shares` + `onRefresh`; do NOT relocate the fetch out of `fetchOrder`.
- Replace inline tier-price cascade (355-359, 1488-1494) with `getTierPrice` from quoteCalc (see §4).

### InventoryPage.tsx (1,467 lines) — `src/pages/InventoryPage.tsx`
- `useInventoryData` hook ← `fetchInventory`/`fetchHolds` (162-254). **Risk: LOW** (verified) — keep `loading=useState(true)` and stable callback identity.
- `ProductSearchPicker` ← dedupe 1263-1293 / 1353-1384 (also kills the shared-`productSearch` coupling). **Risk: LOW** — pass full `Product` to `onSelect` and carry `setHoldWarning('')`.
- `ReorderAlertPanel`, `ForecastTab`, `ActiveHoldsPanel`, `AdjustModal` — each a self-contained extraction.
- `useCreateHold` hook ← 56-59 / 80-87 / 339-430. **Risk: MEDIUM** — `create_inventory_hold` reserves inventory + admin force-override; must preserve all 3 `createHoldIdem.resetKey()` call sites and the modal-open orchestration.

### Reports.tsx (1,042 lines) — `src/pages/Reports.tsx`
- Replace the inline `dateFilterBar` render-function with the existing `ReportShell` component (it was purpose-built and is bypassed). **Risk: LOW.**
- `TabPills` component ← 3 copy-pasted pill-nav blocks (864/903/942).
- Hoist the genuinely-static column arrays to module scope (keep `commissionCols`/`grossSalesCols` in-component — they close over state).

**STOP:** the full 4-component split was **refuted** (see section 8) — it relocates the `handleMarkPaid` commission RPC + idempotency + audit path. **Risk: HIGH.**

### Other decomposition candidates (lower urgency, mostly LOW risk)
- **CustomerDetail.tsx** (1,503) → 7 tab components + `useCustomerTabData` hook. **Risk: MEDIUM** — the Financials tab does money-display math; extract the 6 non-financial tabs first, treat Financials separately. Preserve the `financialsFetched` ref semantics (resets via remount) and the deliberate sequential awaits (an `assertRpcCoverage` test convention).
- **TeamBoard.tsx** → `GlobalActivityLog`, `NoteFormModal` (needs an `initialValues` prop for the "Add Task for Me" prefill), `NoteDetailModal`, `useTeamNotes`. **Risk: LOW** — internal collaboration board, no money/lifecycle/RLS.
- **InvoiceDetail.tsx** → `useInvoiceData`, `PaymentModal`, `ReverseWriteOffModal`. **Risk: MEDIUM** — PaymentModal relocates `allocate_payment` + the Codex-P2 idempotency reset-on-open and balance pre-fill; treat the open-time logic as part of the spec, not parent leftovers.
- **JobDetail.tsx** → `useJobLookups` (LOW), `useJobForm` (MEDIUM — don't bundle `appliedInfo`/`recipeId`; thread `setIsDirty`/`fetchJob` back through handlers), `CompleteJobModal`, `LoadRecipeModal`.
- **PurchaseOrderDetail.tsx** → `usePOReceive` (**HIGH** — inventory + idempotency + over-receive + receiving PDF), `usePOEdit` (MEDIUM — pass shared `setSaving`), the receiving-history hook was **refuted** (see §8).
- **ARaging.tsx** → tab split was **refuted** (see §8). Safe wins only: dedupe `fmtCents`, merge `fetchStatement`/`fetchStatementForCustomer`, extract email HTML builders.
- **Deliveries.tsx** → only the **stable-`DriverCard`** hoist is low-risk; the route-level driver-view split and the `useDeliveries` mega-hook were **refuted** (see §8).
- **Dashboard.tsx** → delete the 100+-line dead `_alerts` block (403-530), then `useDashboardData` hook (**MEDIUM** — relocate a 100-line orchestration with functional `setData` merges and side-effect ordering).

---

## 4. Duplication & dead code

### Top duplication (grep-confirmed, codebase-wide)
| Pattern | Where | Fix | Risk |
|---|---|---|---|
| **Cents→USD formatter** (`new Intl.NumberFormat(...).format(cents/100)`) | **~60 files** (every money page + many components; `reportPdf.ts` already exports `fmtCurrency`) | Add `formatCents`/`formatUSD` to a shared `src/lib/money.ts`; replace all locals | LOW — display only, locale hardcoded |
| **`getTierPrice` tier cascade** | `QuoteBuilder:508`, `NewOrder:181`, `OrderDetail:354 & 1488`, `QuickDeliveryModal:164`; canonical in `quoteCalc.ts:32` | See §8 — **NOT a blind centralize.** `QuickDeliveryModal` works in cents + different fallback. **HIGH** | HIGH |
| **`getPresetDates`** | `Reports`, `SalesReports`, `Jobs`, `ApplicationRecords`, `ReportShell` (5 copies, already drifting) | Export one from `src/utils/season.ts` | LOW |
| **PDF color tuples** (`CRX_GREEN [40,162,106]` etc.) | 10 PDF modules | Extract to `src/lib/pdfTheme.ts` | LOW |
| **`JsPDFWithAutoTable` type** | 10 PDF modules | Same shared file | LOW |
| **PDF `fmt`/`fmtDate`/`fmtNum`** | 7 PDF/email modules | Shared helpers (use `parseLocalDate` for the `T00:00:00` trick) | LOW |
| **`'CROP RX SOLUTIONS'` literal + local `COMPANY_NAME`** | 8 PDF modules + `statementPdf:47`, `yearEndSummaryPdf:38` | Export `COMPANY_NAME_DISPLAY` from `companyInfo.ts` | LOW |
| **`profile_public_view` name-resolution** | 13 pages | `resolveProfileNames(ids)` in `src/lib/profileNames.ts` | LOW |
| **Quoted-CSV `parseCSVLine`** | `BulkCustomerImport:93`, `BulkProductImport:117` (Quote/Pricing use a broken naive split) | Extract to `src/lib/csvUtils.ts`; upgrade the naive importers | LOW |
| **`detectFieldMapping`/`FIELD_MAPPINGS`** | 3 bulk-import components | Generic helper in `csvUtils.ts` | LOW |
| **Filter-`<select>` className string** | 20+ list pages | One exported `SELECT_CLS` constant | LOW |
| **Modal `variantStyles`/`defaultIcons`** | ConfirmModal, ReasonModal, BulkDeleteConfirmModal | Shared `modalVariants.ts` | LOW |
| **`labelToId` slug** | Input, Select, Combobox | Shared `labelToId` util (also add missing `id` prop to Combobox) | LOW |
| **Sort state + filter `useMemo` + skeleton** | DataTable + EditableDataTable (~60 verbatim lines) | `useTableSort` hook + `TableLoadingSkeleton` (verified byte-identical) | LOW |
| **`formatTime`/relative-time** | 3 team components + Dashboard `relativeTime` + CustomerSummaryBar `timeAgo` | One `formatRelativeTime` in `dateUtils.ts` | LOW |
| **`fmtCents` in modals/field-app** | 6 components | Shared `formatCents` | LOW |
| **`Sentry.captureException(err instanceof Error ? err : new Error(String(err)))`** | 80 call-sites (Sentry 10.x accepts `unknown` natively) | Simplify to `Sentry.captureException(err, opts)` | LOW |
| **Auth split-panel layout** | LoginPage, ForgotPasswordPage, ResetPasswordPage | `AuthPageLayout` + `AuthErrorBanner` + `AuthSubmitButton` | LOW |
| **BatchVoidModal ≈ BatchCancelModal** | nearly identical | One `BatchActionConfirmModal` | LOW |
| **Click-outside / body-scroll-lock** | Combobox/HelpTip/TransactionThread; Modal/CommandPalette | `useClickOutside` + ref-counted `useBodyScrollLock` | LOW |
| **`FieldMarkers` ≈ `FieldMarkerLayer`; `MapContainer` ⊂ `CRXMap`** | map components | Consolidate to the richer component | LOW |
| **Entity-routing maps** | StaleTasksAlert/EntityBadge/QuickTaskModal | Export `entityConfig` from EntityBadge; delete the 2 shadows | LOW |

### Confirmed dead code (delete)
- `Dashboard.tsx:403-530` — the entire `_alerts` array (built every render, `void`-discarded). Audit the now-unused icon imports after.
- `statementPdf.ts:812` `generateBatchStatementsPdf` — silently drops all but `statements[0]`; no production caller. (`downloadBatchStatements` is the real path.)
- `offlineQueue.ts:148` `getFailedActions`, `offlineSync.ts:16` `MAX_RETRIES`, `csvExport.ts:10` `formatCSVCell` — exported but only consumed internally/by tests → drop the `export` keyword.
- `FieldAppChemicalEntry.tsx:31,47,73` — dead `Recipe` interface + `recipes` prop (no caller passes it).
- **`quoteCalc.ts`** — zero production imports; only tests use it (verified). **Disposition: DELETE it and relocate/remove its tests** — do NOT "invert the dependency" (the in-prod copies diverge; see §8). **Risk: HIGH** because it touches tier-price math.
- Dead types in `src/types/index.ts`: `FinancialAuditEntry`, `OCRProcessingQueue`, `ArReminderTracking`, `FieldAppInvoicePayload`, `FieldWithGroup`, `FieldPolygon`, `OrderLineAllocation`, `InvoiceLineAllocation` — all zero callers outside `index.ts`.

---

## 5. Types & architecture/structure

### `src/types/index.ts` (2,557 lines) cleanup
- **Delete the 8 zero-caller interfaces** listed above.
- **Use `ProfilePublic`** (currently exported but never imported) at the 8+ sites that inline `.select('id, full_name, role, is_active')` from `profile_public_view` — net correctness gain.
- **Replace local shadow types with the canonical ones:** `PaymentHistory.tsx:21` local `AllocationSet` (extend canonical with `farm_name?`), `JobDetail.tsx:76` local 1-field `CompleteJobResult` (canonical is a superset).
- **Name the inline status unions:** add `CommissionStatus = 'pending'|'paid'|'cancelled'` and `CommissionPaymentStatus = 'unposted'|'posted'|'voided'`; point `Job.priority` at the existing `DeliveryPriority`. **Risk note: these are lifecycle enums — additive type-only change, but verify each union exactly matches the DB CHECK constraint before committing.**
- **Move in-function-body interfaces to module scope:** `CustomerDetail.tsx:101-103` (`AgingRow`/`TxnRow`/`PrepayRow`), `Compliance.tsx:70-83` (`FieldWithFSA`), `FinancialDashboard.tsx:34-108` (`FinancialRpc`/`FinancialData`).
- **(Optional, large)** split `index.ts` into domain files re-exported from a barrel — zero import-path changes for callers, but a big diff; lowest priority.

### Directory / organization moves
- Move `src/utils/season.ts` → `src/lib/season.ts` (it's the only file in `utils/`; every other helper lives in `lib/`). Update ~10 imports.
- Consolidate the 3 lib test locations (`src/lib/`, `src/lib/__tests__/`, `src/lib/tests/`) — there are **two** `parseCents.test.ts` files. Co-locate per the rest of the codebase's convention.
- Move `createCheckboxColumn` JSX factory out of `useRowSelection.tsx` into `components/ui/`, letting the hook file become `.ts`.
- Unify the `sanitizeError` import path (pick `../lib/errorSanitizer`, drop the `db.ts` re-export).
- **(Optional)** add `index.ts` barrels for `components/ui/` and `hooks/` to collapse the 6–12 per-page import lines (Vite tree-shakes, so no bundle cost).

---

## 6. Detail by theme

**Component extraction (presentational, LOW risk):** `ProductSearchPicker`, `QuantityStepper`, `InventoryWarningBanner`, `FarmGroupBadge`, `TabPills`, `StatCard`, `Spinner` (11 hand-rolled spinners with 3 different border widths), `DateRangeFilter`, `EmptyState` `size` prop, `CardHeader` adoption (12 hand-rolled headers), `ThreadStep`. Impact: medium · Effort: small · Risk: low.

**Hook extraction touching reads only (LOW–MEDIUM risk):** `useInventoryData`, `useJobLookups`, `useGlobalActivity`, `useTeamNotes`, `useDashboardData`, `useDeliveryData`, `useOrderDetail`, `useInvoiceData`, `useCustomerTabData`. The data fetches are read-only, but several double as the post-mutation **refetch** — preserve `refetch` and every state value, and keep callback identity stable (exhaustive-deps). Risk rises to MEDIUM wherever the fetched state feeds financial/lifecycle display.

**Modal/state cluster extraction (MEDIUM–HIGH risk):** `PaymentModal`, `usePOReceive`, `useCreateHold`, `OrderBillSplit`, `useDeliveryEditMode`, `useJobForm`. These relocate idempotency-key lifecycles and/or money/inventory-mutating RPCs. Each must preserve **every `resetKey()` call site**, the actor (`p_performed_by`), and the open-time pre-fill logic verbatim. Impact: high · Effort: medium · Risk: medium-high.

**Performance micro-cleanups (LOW risk, optional):**
- Parallelize independent fetches with `Promise.all`: `fetchOrder` (OrderDetail), `fetchInvoice` (InvoiceDetail), `fetchDashboard`'s 3 read RPCs (Dashboard). Behavior-preserving reads.
- N+1 fix in `PrepaymentManager.fetchCustomers:117-157` (one invoice query per customer). **Risk: MEDIUM** — a single `.in()` can hit the PostgREST 1000-row cap and *silently truncate* the displayed unpaid totals. Implement as a **DB-side aggregate / paged fetch**, not a naive `.in()` select.
- `offlineQueue.ts` — cache the IndexedDB connection promise + batch-delete in `clearFailed/StaleActions`.
- Consolidate the 7 sequential `inventory.reduce()` passes (InventoryPage:660-666) and duplicate `lowStockItems` filter into one memo.

**Error-handling consistency (LOW risk, mostly correctness-positive):**
- ~25 pages reach users with raw `error.message` instead of `sanitizeError(err)` (`JobDetail:384`, `TeamBoard:415`, etc.) — wrap with `sanitizeError` to stop PG-internals leaking.
- Move `setSubmitting(false)` into `finally` in `WriteOffModal`, `FinanceChargePreviewModal`, `TeamBoard.handleSave` (insert branch can leave the button stuck loading).
- Add `.catch()` + toast to the fire-and-forget reference-data effect in `PrepaymentManager:276-291`.
- Migrate the ~30 pages with manual `try/catch/Sentry/toast/setLoading` boilerplate to the existing `runCriticalAction` helper (skip the ones that branch on `hasRpcCode`).

---

## 7. Recommended sequencing plan

Safest-first. **Stop and get human + Codex review at every step marked ⚠.**

1. **All of section 2 (quick wins) + confirmed dead-code deletions.** Pure subtraction / no-op removal. Run build + 1,924 tests. No money/lifecycle surface.
2. **Shared utilities, one PR each:** `formatCents`/`money.ts` → `getPresetDates` → `pdfTheme.ts` (colors + type + PDF formatters) → `companyInfo` company-name → `resolveProfileNames` → `csvUtils` → modal/form/UI dedupes (`Spinner`, `variantStyles`, `labelToId`, `useTableSort`, click-outside). Each is mechanical; run the test suite per PR.
3. **Types cleanup:** delete dead interfaces, adopt `ProfilePublic`, replace shadow types, name the status unions (⚠ verify each union against the live DB CHECK constraint), move in-body interfaces out.
4. **Directory moves:** `utils/season.ts` → `lib/`, consolidate lib test dirs, `useRowSelection.tsx` → `.ts`, unify `sanitizeError` path.
5. **Presentational component extractions** from the big files (LOW-risk ones first): `QuoteSectionCard`, `QuoteVersionHistory`, `OrderItemsTable`, `BlendTicketProductsCard`, `ProductSearchPicker`, the InventoryPage panels, the TeamBoard modals, `ReportShell` adoption in Reports. Visual diff + tests each.
6. **Read-only data hooks:** `useInventoryData`, `useJobLookups`, `useGlobalActivity`, `useTeamNotes`, `useDashboardData`, `useDeliveryData`, `useOrderDetail`, `useCustomerTabData`. Preserve `refetch` wiring; run tests + a manual "mutate → UI refreshes" smoke per page.
7. **⚠ MONEY/LIFECYCLE-ADJACENT extractions — one at a time, with Codex cross-review and a before/after numeric-diff smoke test:**
   - `QuoteItemRow` (price-override + calc_mode math)
   - `OrderBillSplit` (dollars→cents, ≤100% guard, sharesLocked DB-trigger invariant)
   - `PaymentModal` (`allocate_payment` + idempotency reset-on-open)
   - `useCreateHold` / `usePOReceive` (inventory-reserving RPC + 3 resetKey sites + admin override)
   - `useInvoiceData`, `useOrderDetail` with their refetch handlers
   - `DeliveryDriverView`/`DeliveryAdminView` split (two stages)
8. **⚠ STOP — do NOT attempt without explicit human sign-off and a dedicated session:** `quoteCalc.ts` deletion + tier-price consolidation, the full `useQuoteBuilder`/`useBlendTicketData` monolith hooks, the Reports 4-component split, the `PrepaymentManager` N+1 rewrite. These are the HIGH-risk money/lifecycle items.

---

## 8. Rejected / needs human check

These had an adversarial verdict of `holdsUp=false` — **do NOT act on them blindly.**

| Finding | File | Why it was refuted |
|---|---|---|
| **Full `useQuoteBuilder` hook ("thin shell")** | `QuoteBuilder.tsx` | Not behavior-preserving: sweeps money math (`recalcItem`/`totals`/tier pricing), lifecycle status transitions (incl. the Bug #29 revert), all 9 idempotency keys, and audit logging into one move. Reviewer's counts were wrong (49 useState, not 27). `fmt` referenced before its `const` (TDZ-crash risk on reorder); 2 effects carry intentional `exhaustive-deps` disables. Thin test coverage. **Corrected risk: HIGH.** Salvage only the *pure* money helpers into a tested lib module first. |
| **Full `useBlendTicketData` hook (owns all state, returns `{data,loading,reload}`)** | `BlendTicketDetail.tsx` | False premise: `products`/`ticketFields`/`suggestedOrder` are NOT exclusively set by the loader — `setProducts`/`setTicketFields`/`setSuggestedOrder` fire from in-component handlers. `products` is the array sent to `save_blend_ticket` (mutation path), coupled to dirty-tracking + blend-math validation effects. **Corrected risk: HIGH.** Only extract the pure read-and-derive portion, or just pull out duplicate-detection so its failure stops aborting the whole load. |
| **Reports.tsx full 4-component split** | `Reports.tsx` | Factual errors (29 useState not 18; `commissionCols`/`grossSalesCols` are NOT static — they close over state) and it relocates the `handleMarkPaid` path = `create_commission_payment` RPC + idempotency key + `logActivity`. Inactive tabs are `&&`-gated so the claimed perf win is negligible. **Corrected risk: HIGH.** The safe subset (hoist genuinely-static column arrays + lift pure-display children) is a much smaller change. |
| **ARaging.tsx 3-tab split** | `ARaging.tsx` | Tabs are NOT independent — the Aging column renderers call `setSelectedCustomer`/`fetchStatementForCustomer`/`openStatementDialog` and drive the Statement tab + batch/email/finance-charge flows. Every tab/column renders money and threads handlers that call `get_customer_statement`, write `ar_reminder_tracking`, and send Resend emails with idempotency keys (admin-gated). **Corrected risk: HIGH.** Only the safe sub-items (dedupe `fmtCents`, merge the two statement fetchers, extract email-HTML builders) should proceed. |
| **PO receiving-history hook (`usePOReceivingHistory`)** | `PurchaseOrderDetail.tsx` | As written it drops the post-reverse `fetchPO()` refresh (handler calls both `fetchReceivingHistory()` AND `fetchPO()`; the proposed signature has no way to trigger `fetchPO`), leaving stale PO status/quantities. `reverse_receiving_record` is an inventory/ledger-mutating RPC with idempotency + `assertRpcResult` + `logActivity`. **Corrected risk: HIGH.** Only viable with an explicit `refreshPO` callback and byte-for-byte preservation of the idempotency/audit calls — Codex cross-review required. |
| **Load-sheet PDF: extract + batch-query rewrite** | `Deliveries.tsx` | The extract itself is fine, but the finding *bundles* replacing the serial `delivery_items` loop with one `.in([...])` and calls the whole thing "behavior-preserving" — it isn't. `delivery_items` is RLS-governed; a 500-element `.in()` can blow the PostgREST URL length limit (a NEW failure at the exact cited scale) and must replicate the per-delivery `.order('id')` + JS sort. **Corrected risk: HIGH.** Do a STRICT pure extract (keep the serial loop); split the batch-query idea into a separate, explicitly-non-cosmetic ticket with RLS-equivalence + URL-length checks. |
| **Deliveries `useDeliveries` mega-hook + route-level driver split** | `Deliveries.tsx` | Refuted: state count wrong (23 not 12); `filtered` can't move without the filter setters wired to the JSX; ignores the driver early-return branch; the fetch applies an **RLS visibility boundary** (`.eq('assigned_driver', profile.id)`) and the route split touches the App.tsx role gate. **Corrected risk: HIGH.** Only the stable-`DriverCard` hoist (pass closure deps as props) is low-risk and worth doing. |
| **58-page `useSupabaseQuery` boilerplate hook** | many list pages | Scope overstated ("identical" is false for the majority); `Invoices`/`Orders` add truncation toasts, several run a 2nd profile query + row mapping, `Products` paginates, `Deliveries` applies the **driver RLS row filter inside the fetch**, callbacks are referenced 4–10× each as refetch handles. **Corrected risk: HIGH.** A real-but-smaller helper is viable for ONLY the 4 genuinely-simple pages (Customers, Vendors, Quotes, PurchaseOrders). |
| **Bulk-import 3-state-machine consolidation ("all six modals")** | bulk-import components | Factually wrong scope: there are SEVEN importers (BulkPOImport uncounted) and BulkFieldImport is a 7-step GIS wizard that doesn't follow the pattern at all; the summary cards are non-uniform (Pricing/Quote use 3-column grids, Order uses per-order preview), so a single `ImportValidationSummary` shape won't fit without per-importer props. Risk to financial paths is genuinely low, but the finding's premise is inaccurate. **Use a narrower version:** extract the shared 2-card grid + a `useImportWizard` hook for ONLY Customer/Product (/Order), leave the rest alone. |

**Also flag for human judgment (not refuted, but noted HIGH by reviewers):** `NewOrder.tsx:192` `recalcItem` uses dollar floats not cents — this is **intentional** (the `create_direct_order` RPC converts server-side). Add a clarifying comment; do **NOT** convert to cents without auditing the RPC contract (that's a real money change).
