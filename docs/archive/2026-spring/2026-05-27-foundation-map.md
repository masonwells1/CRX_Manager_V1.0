# Foundation Map — CRX Manager V1.0 (2026-05-27)

Phase 1 inventory built from direct file inspection. Used as briefing for the three parallel deep-dive subagents.

---

## 1. Page Inventory (66 non-test pages)

All pages are lazy-loaded via `React.lazy()` in `src/App.tsx`. All authenticated routes go through `ProtectedRoute` with explicit `allowedRoles` checks. No routing deviations detected.

### By size (line count, non-test .tsx only)

| Lines | File | Role/Scope |
|-------|------|-----------|
| 2,493 | QuoteBuilder.tsx | Multi-line quote creation AND editing (shared route) |
| 2,273 | DeliveryDetail.tsx | Full delivery lifecycle (confirm→complete, photos, remainders) |
| 1,608 | BlendTicketDetail.tsx | OCR review, approve/reject, application record creation |
| 1,492 | OrderDetail.tsx | Order lifecycle, invoice conversion, status transitions |
| 1,467 | InventoryPage.tsx | Inventory levels, reorder alerts, transaction ledger, batch adjust |
| 1,435 | CustomerDetail.tsx | Customer profile, addresses, credit, season summary |
| 1,396 | TeamBoard.tsx | Team notes/todos/announcements, real-time, photos, comments |
| 1,336 | InvoiceDetail.tsx | Invoice post/unpost, write-offs, print PDF |
| 1,224 | Deliveries.tsx | Delivery list + driver dashboard + batch actions + quick delivery |
| 1,177 | PurchaseOrderDetail.tsx | PO detail, two-step receive modal, receiving history |
| 1,053 | Dashboard.tsx | KPIs, today's jobs, recent activity |
| 1,047 | ARaging.tsx | AR aging, finance charges, send reminders, batch statements |
| 950 | Reports.tsx | 14 reports, CSV/PDF export |
| 949 | JobDetail.tsx | Job editor with field map, chemicals, vehicle/applicator |
| 940 | PrepaymentManager.tsx | Prepay balances, split check entry, bucket labels |
| 921 | QuickReceive.tsx | 3-step receive wizard |
| 898 | Returns.tsx | Returns/RMA full workflow |
| 883 | Compliance.tsx | Applicator licenses, RUP list, RUP sales register |
| 872 | Rebates.tsx | Rebate programs and claims |
| 854 | FieldSetup.tsx | Field CRUD with satellite map + polygon drawing |
| 785 | FieldApplicationInvoice.tsx | Multi-location field app invoice |
| 745 | NewOrder.tsx | Direct order creation |
| 731 | PurchaseOrders.tsx | PO list |
| 717 | Invoices.tsx | Invoice list, batch print, batch void |
| 712 | Products.tsx / BlendTickets.tsx | (both 712 lines) |
| 698 | FinancialDashboard.tsx | Financial KPIs admin view |
| 676 | SettingsPage.tsx | Admin settings + user management |
| 668 | CommissionPayments.tsx | Commission workflow |
| 665 | CycleCounts.tsx | Cycle counting with variance tracking |
| 650 | FieldDashboard.tsx | Read-only field profile |
| 646 | VendorBillDetail.tsx | Vendor bill, record payment, void |
| 607 | NewDelivery.tsx | Create delivery from order |
| 602 | PaymentAllocation.tsx | Unified payment entry |
| 585 | Orders.tsx | Order list |
| ... | (26 pages between 152–577 lines) | |

**Sizes summary:**
- >1,000 lines: 10 pages (QuoteBuilder, DeliveryDetail, BlendTicketDetail, OrderDetail, InventoryPage, CustomerDetail, TeamBoard, InvoiceDetail, Deliveries, PurchaseOrderDetail, Dashboard, ARaging)
- 500–1,000 lines: 22 pages
- <500 lines: 34 pages

---

## 2. Shared Building Blocks

### Components (93 non-test .tsx files across `src/components/`)

| Directory | Key Components | Count |
|-----------|---------------|-------|
| `ui/` | Modal, DataTable, EditableDataTable, BulkActionBar, BulkDeleteConfirmModal, Badge, Button, Card, Input, Select, Combobox, ConfirmModal, Toast, SignatureCanvas, Skeleton, SplitHeading, HelpTip, Breadcrumbs, OfflineBanner, CommissionSplitEditor | ~25 |
| `auth/` | LoginPage, ProtectedRoute, ForgotPasswordPage, ResetPasswordPage | 4 |
| `layout/` | AppLayout, TopBar, Sidebar | 3 |
| `team/` | NoteCard, EntityBadge, TodaysDeliveries, YesterdayRecap, QuickTaskModal, RelatedNotes, NotePhotoUpload, NoteAttachments, NotificationsPanel, TagsManager, WorkloadView, StaleTasksAlert, CommentsSection | 13 |
| `deliveries/` | BatchCancelModal, StartDeliveryModal, DeliveryCalendar, QuickDeliveryModal | 4 |
| `blendtickets/` | BulkTicketUpload, ManualTicketCreate | 2 |
| `customers/` | BulkCustomerImport, CustomerSummaryBar | 2 |
| `products/` | BulkProductImport, BulkPricingImport | 2 |
| `invoices/` | InvoicePrintDialog, BatchVoidModal, WriteOffModal, FinanceChargePreviewModal | 4 |
| `reports/` | ReportShell, YearEndSummaryDialog | 2 |
| `map/` | MapContainer, FieldMarkers, LayerToggle, LocateMe, DrawLayer | 5 |
| `field-app/` | ApplicationServicePicker, CustomerSharesTable, FieldAppChemicalEntry | 3 |
| `dashboard/` | ActionQueue | 1 |
| `statements/` | StatementPrintDialog | 1 |
| `orders/` | BulkOrderImport | 1 |
| `quotes/` | BulkQuoteImport | 1 |
| `purchase-orders/` | BulkPOImport | 1 |
| `fields/` | AttributeMappingStep, ImportPreviewMap, BulkFieldImport | 3 |
| `inventory/` | TransactionLedgerModal, BatchAdjustModal | 2 |

### Hooks (17 custom hooks in `src/hooks/`)
- `useIdempotencyKey` — stable UUID per component mount
- `useRealtimeSubscription` — Supabase channel subscription with disabled option
- `useRowSelection` — selected IDs Set for bulk operations
- `useOnlineStatus` — navigator.onLine wrapper
- `useUnsavedChanges` — dirty-state tracking
- `usePageMeta` — document.title management
- `useFormDraft` — form draft persistence
- `useOCRProcessor` — OCR pipeline
- `useOCRThresholds` — OCR confidence thresholds
- `useGuardrails` — delivery/order state guardrails
- `useFitBounds` — map viewport fitting

### Libs (80+ files in `src/lib/`)

**Client & infrastructure:**
- `db.ts` — Supabase singleton, `checkMutationResult()`, `assertRpcResult()`, `RpcErrorCodes`, `hasRpcCode()`
- `sentry.ts` — Sentry init + re-export wrapper
- `metrics.ts` — fire-and-forget Sentry event tracking

**Data entry:**
- `parseCents.ts` — `parseDollarsToCents()`, `parseDollarsToCentsSigned()`
- `dateUtils.ts` — `localToday()`, `parseLocalDate()`, `formatLocalDate()`
- `activityLogger.ts` — `logActivity()`, `createNotification()`, `notifyAdmins()`
- `idempotency.ts` — idempotency key generation
- `criticalAction.ts` — `runCriticalAction()` wrapper

**Domain logic:**
- `quoteCalc.ts` — quote total calculations
- `rupCompliance.ts` — RUP compliance checks
- `reconciliation.ts` — data integrity checks
- `notificationTriggers.ts` — notification fan-out logic
- `paymentAllocation.ts` — payment allocation math
- `financeChargeCalc.ts` — finance charge calculations
- `deliveryLifecycle.ts` — delivery state machine helpers

**PDF generators (7 files):**
- `invoicePdf.ts` (756 lines), `statementPdf.ts` (818 lines), `yearEndSummaryPdf.ts` (633 lines), `deliveryPdf.ts`, `receivingPdf.ts`, `loadSheetPdf.ts`, `quotePdf.ts`, `reportPdf.ts`, `orderPickListPdf.ts`, `orderSummaryPdf.ts`

**Infrastructure:**
- `emailService.ts` — Resend via Edge Function
- `offlineQueue.ts` / `offlineSync.ts` — offline action queuing
- `imageCompression.ts` — Supabase Storage upload prep
- `fieldImportParser.ts` — shapefile/KML/GeoJSON parsing
- `csvExport.ts` — CSV generation

**Contexts (1):**
- `AuthContext.tsx` — session, profile, role, deniedPages, signIn, signOut (142 lines, clean)

**Types:**
- `src/types/index.ts` — 2,350 lines, all shared TypeScript interfaces in one file

---

## 3. Data Flow Traces

### Pattern A — Read-only list page (e.g., Invoices.tsx, 717 lines)
```
Page mount
  ↓ useState([data] = [], loading = true, filters...)
  ↓ useEffect([filters]) → supabase.from('invoices').select('*, customer:customers(farm_name)').is('deleted_at', null).order(...)
  ↓ if error: toast.error; else setData(data); setLoading(false)
  ↓ Filter/sort applied client-side to loaded array
  ↓ DataTable renders rows
  ↓ Bulk actions: useRowSelection + BulkActionBar
```
No cache layer — every filter change re-fetches from Supabase. No React Query/SWR.

### Pattern B — Detail page with mutations (e.g., OrderDetail.tsx, 1,492 lines)
```
Page mount
  ↓ Multiple useState slices: order, items, deliveries, invoices, commissions, loading...
  ↓ Multiple useEffect fetches — all kick off in parallel on mount
  ↓ RPC calls for business operations:
      data = await supabase.rpc('convert_order_to_invoice', { p_order_id, p_idempotency_key })
      assertRpcResult(data, 'convert_order_to_invoice')
      ← hasRpcCode used in some RPCs (InventoryPage, Rebates) but NOT most detail pages
  ↓ Mutation: supabase.from('orders').update({status}).eq('id', id).select()
      checkMutationResult(result, 'Update order status')
  ↓ logActivity({ event, description, performedBy: profile.id, ... })
  ↓ Local state refresh (re-fetch rather than optimistic update)
  ↓ try/catch wraps critical actions; toast.success/error for feedback
```

### Pattern C — Financial write page (e.g., PaymentAllocation.tsx, 602 lines)
```
Page mount
  ↓ Loads invoices + prepay credits via multiple supabase.from() + supabase.rpc()
  ↓ assertRpcResult on RPC data
  ↓ Form state: check amount (dollar string) → parseDollarsToCents() → cents integer
  ↓ useIdempotencyKey() for critical submit
  ↓ supabase.rpc('record_payment', { ..., p_idempotency_key })
  ↓ assertRpcResult + logActivity + toast
```

---

## 4. Key Structural Observations

### Confirmed following documented patterns ✓
- Single Supabase client (only `src/lib/db.ts` calls `createClient()`)
- All 66 pages lazy-loaded via `React.lazy()` in App.tsx
- All money inputs parsed via `parseDollarsToCents()` (at least for cent fields — 34 usages across 12 pages)
- Date utilities used: 92 usages of `localToday/parseLocalDate/formatLocalDate` across 32 pages
- Zero `window.confirm()` / bare `confirm()` in .tsx files
- Zero `message.includes()` for RPC error detection in pages
- Zero stray Supabase client instantiations in src/
- Sentry always imported via `../lib/sentry` wrapper
- `as any` appears in exactly 2 locations: LogbookReport.tsx:71 (flagged) and reportPdf.ts:122 (sanctioned)

### Patterns worth deep investigation
1. **`hasRpcCode` almost never used** — only 5 occurrences across 2 files (InventoryPage.tsx, Rebates.tsx) despite 259 `assertRpcResult` calls and 141 catch blocks across 50 pages. Most RPC error handling must be using plain error messages or generic toast messages.
2. **No central `formatCurrency` function** in pages — zero `formatCurrency/formatDollar/formatMoney` imports across pages. Display formatting is ad-hoc (inline `/ 100` and `toFixed(2)`).
3. **`businessLogicEnhancements.ts` doesn't exist** — code-patterns.md says `checkMutationResult` lives here; the file was not found. The function is in `db.ts`. Documentation drift.
4. **types/index.ts is 2,350 lines** — all interfaces in one file.
5. **setLoading(false)** — 101 usages across 58 page files. Every page has its own loading state machinery.
6. **QuoteBuilder.tsx at 2,493 lines** handles BOTH new quote creation and edit (shared route `quotes/new` and `quotes/:id`).

---

## 5. File Count Summary

| Category | Count |
|----------|-------|
| Pages (non-test .tsx) | 66 |
| Component files (non-test .tsx) | 93 |
| Custom hooks | 17 |
| Lib files (non-test .ts) | ~45 |
| Routes in App.tsx | 71 (some pages serve multiple paths) |
| `src/types/index.ts` lines | 2,350 |
| Migrations | 356 |
| Edge Functions | 7 |

---

*Map built 2026-05-27. Used as Phase 1 briefing for Phase 2 parallel deep-dive subagents.*
