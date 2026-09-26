# Code Patterns & AI Dev Reference

## Number Formats
All numbers are generated server-side. The year is the America/Chicago calendar year (`20260908140000`, `20260914100100`), and each generator serializes callers with an advisory lock or a counter-row lock. Never build a number in the browser from a count query.
- Invoice: `{PREFIX}-{YYYY}-{sequential 4-digit}` via `next_invoice_number(p_invoice_type)`. Prefix by type: `CS` chemical_sale, `MC` misc_charge, `CM` credit_memo, `INV` everything else (field application is the default). Each prefix has its own sequence.
- Return: `RMA-{YYYY}-{sequential 4-digit}` via `next_return_number()`
- Rebate claim: `RC-{YYYY}-{sequential 4-digit}` from the per-year `rebate_claim_counters` row inside `create_rebate_claim`
- Cycle count: `CC-{YYYY}-{sequential 5-digit}` via `next_cycle_count_number()`
- PO: `PO-{YYYY}-{sequential 4-digit}` via `next_po_number()`
- Job: `JOB-{YYYY}-{sequential 4-digit}` via `next_job_number()` RPC
- Application record: `APP-{YYYY}-{sequential 4-digit}` via `next_application_record_number()`
- Commission payment: `CP-{YYYY}-{sequential 4-digit}` via `next_commission_payment_number()`
- Delivery: `DEL-{sequential 5-digit}` (no year) via `next_delivery_number()`

## UI Patterns
- Bulk imports use a 3-state modal pattern: file selection -> validation/review -> results
- Bulk import components live in `src/components/{domain}/Bulk*.tsx`
- Modal component accepts `size="large"` prop
- Tab-based page layout used in: ARaging (3 tabs), Compliance (2 tabs), Rebates (2 tabs), InventoryPage, BlendRecipes
- Commission split editor: `src/components/ui/CommissionSplitEditor.tsx`
- Combobox component: `src/components/ui/Combobox.tsx` — dropdown with type-to-filter + accept new values. Used for Vendor, Manufacturer, Category on ProductDetail. Props: `value`, `onChange(string)`, `options: string[]`, `label`, `disabled`, `placeholder`

## Bulk Operations Pattern
- `useRowSelection` hook + `createCheckboxColumn` + `BulkActionBar` (auto-hides when 0 selected) + `BulkDeleteConfirmModal`
- Used on 11 pages: ApplicationServices, BlendTickets, Customers, Fields, Jobs, Orders, Products, PurchaseOrders, Quotes, Returns, Vehicles
- Smart fallback export: `const rows = selected.size > 0 ? selectedRows : filtered;` — exports selected if any, otherwise all filtered
- Soft delete pattern: `.update({ deleted_at: new Date().toISOString() })` + filter `.is('deleted_at', null)`. Still used directly by several list pages (for example Returns, Orders, Quotes, Jobs, BlendTickets, BlendRecipes). Invoices do NOT use it: they delete through the `delete_invoices` RPC.
- Hand-rolled checkbox selection: Invoices and Deliveries use custom `Set<string>` state (pre-existing pattern, kept for stability)
- InventoryPage uses `EditableDataTable` (inline editing) — has checkbox column for batch adjust, transaction ledger per product, "Needs Reorder" filter chip

## PDF Generation
- Invoice PDF: 3 layouts via `src/lib/invoicePdf.ts`
- Statement PDF: dual-mode via `src/lib/statementPdf.ts`
- Year-end summary PDF: `src/lib/yearEndSummaryPdf.ts`
- Delivery PDF: `src/lib/deliveryPdf.ts` — batch support, delivered vs planned columns, partial delivery amber highlight
- Receiving PDF: `src/lib/receivingPdf.ts` — CRX green header, condition color-coding, batch support
- Load Sheet PDF: `src/lib/loadSheetPdf.ts` — product summary table + per-stop tables, aggregates quantities across stops, tote number column
- PDF text extraction uses `pdfjs-dist` (already installed), see `BulkOrderImport.tsx` for reference

## OCR & Matching
- Product fuzzy matching via `fuzzyMatchProductWithScore()` in `src/components/purchase-orders/BulkPOImport.tsx`, which delegates to the exported `resolveFuzzyProductIdentity()` in `src/lib/productIdentityResolver.ts` (default `minimumScore = 0.7`)
- Blend math validator: `src/lib/blendMathValidator.ts`
- Manual ticket creation: `src/components/blendtickets/ManualTicketCreate.tsx`

## Key Component Patterns
- Activity logging via `logActivity()` from `src/lib/activityLogger.ts`
- Product search modal pattern reused from `NewPurchaseOrder.tsx` (the `productSearchOpen` modal)
- Admin user edit via `admin_update_profile` RPC (SECURITY DEFINER)
- ReportShell component: reusable date range + season presets + CSV/PDF export wrapper (`src/components/reports/ReportShell.tsx`)
- LogbookReport component: 4 sub-tabs (by Customer/Applicator/Field/FAA)

## Financial Patterns
- AR aging uses Supabase RPC `get_ar_aging(p_as_of_date)` — admin-only gross AR aging over posted invoices as of a cutoff (it does not read `orders`); fails closed when a past cutoff can no longer be reconstructed. See `rpc-functions.md`.
- Customer statement uses RPC `get_customer_statement()` — running balance via window function
- Season comparison uses RPC `get_season_comparison()` — YoY metrics (October 1-September 30 seasons)
- Financial audit log: immutable append-only table, logged via `financial_audit_log` inserts
- Atomic operations: PostgreSQL RPCs with `FOR UPDATE` row locks for race-free multi-table writes

## Delivery/Receiving Patterns
- Delivery enhancements (S18): edit/cancel/reassign, driver issue reporting, photo uploads (up to 10, compressed), delivery remainders with follow-up creation, batch cancel
- Receiving system (S19): two-step receive modal, per-item condition/lot/notes/storage_location, receiving dashboard with summary cards
- Delivery integrity (S20): two-step confirm->complete flow, items locked to order, order context columns, quick delivery modal, is_quick_delivery flag

## Field Import
- 3-step wizard (upload -> attribute mapping -> preview map -> insert)
- Parser in `src/lib/fieldImportParser.ts`. Supports .shp/.dbf/.shx, .kml, .geojson
- Uses proj4 for coordinate reprojection
- ParsedImportField type in `src/types/index.ts`

## Mutation Safety Pattern
- `checkMutationResult(result, operation)` from `src/lib/db.ts` — detects silent RLS failures (0 rows affected despite no error). The single argument is the whole Supabase result object (`{ error, data, count }`). Used broadly after any Supabase `.update()` / `.delete()` call.
- Pattern: `const result = await supabase.from('table').update(…).eq('id', id).select(); checkMutationResult(result, 'Updating delivery');`
- Note: a legitimately-zero-rows update (e.g. "mark all read" with nothing unread) should NOT use `checkMutationResult` — guard for that case and check `result.error` only.

## Offline Conflict Detection
- `PendingAction` in `src/lib/offlineQueue.ts` has optional `snapshotAt`, `entityTable`, `entityId` fields
- `syncPendingActions(currentUserId, options)` in `src/lib/offlineSync.ts` compares `snapshotAt` against the entity's `updated_at` before replaying, but only for operations that are NOT durable — returns `conflicts: string[]` for stale-data warnings
- Durable operations (`complete_delivery`, `complete_job`; see `isDurableOfflineOperation` in `src/lib/offlineReceipts.ts`) skip that client check: the server decides conflicts when the action is staged (`stage_offline_action`), and conflicting work lands in the Offline Work Review queue instead of replaying

## Realtime Subscription Disabled Pattern
- `useRealtimeSubscription({ table, disabled?: boolean })` — when `disabled` is true, hook skips channel creation entirely (no-op)
- Convenience hooks (`useRealtimeComments`, `useRealtimeActivity`) pass `disabled: !noteId` so null noteId doesn't create a subscription with an undefined filter

## Operational Metrics Pattern (Sprint 5a)
- Fire-and-forget Sentry wrappers in `src/lib/metrics.ts`
- `setUserContext(user)` / `clearUserContext()` — called from `AuthContext` on login/logout
- `trackNavigation(from, to)` — called from `NavigationTracker` component in `App.tsx` (headless, uses `useLocation` + `useRef` to skip initial mount)
- `trackBusinessEvent(name, data)` — called after key business actions (order_created, quote_created, quote_converted_to_order)
- All functions are no-op safe (catch and log errors internally, never throw)

## Reconciliation Checks Pattern (Sprint 5b)
- Pure computation functions in `src/lib/reconciliation.ts` — testable without DB mocks
- 10 checks: order totals vs line items, inventory ledger vs transactions, invoice payments vs allocations, invoice balance formula (GENERATED ALWAYS sanity), commission splits sum to 100%, quote hold parity, delivery-invoice quantity parity, prebooked inventory, return credit linkage, customer AR consistency
- Each check: takes typed arrays → returns `Discrepancy[]`
- DB wrapper `runReconciliationChecks()` fetches from Supabase and delegates to pure functions
- Tolerance: ±1 cent for money (TOLERANCE_CENTS), ±0.01 for quantities (liquid products have decimals)
- Money always in cents (bigint-safe integers), display divides by 100

## Critical Action Pattern (Sprint 4a)
- `runCriticalAction({ action, successMessage, errorPrefix })` from shared helper
- Replaces scattered try/catch/toast patterns across pages
- Consistent error handling: logs error, shows toast with `errorPrefix + error.message`
- Returns `{ success: boolean, data?, error? }`

## Idempotency Pattern (Sprint 1a + Security Audit)
- `useIdempotencyKey(operation, userId, intentScope?)` in `src/hooks/useIdempotencyKey.ts` returns `{ getKey, resetKey, getKeyFor, resetKeyFor, ... }`. It keeps ONE key per intent scope (not one per mount): the key is minted lazily on the first `getKey()` and stays the same across retries until `resetKey()` after a confirmed success (or an authoritative reload). Switching scope mints a fresh key; returning to a scope with an unresolved outcome reuses its original key. Do not retire a key on `IDEMPOTENCY_PAYLOAD_CONFLICT` — see the hook's header comment.
- `useUncertainMutationIntent` in `src/hooks/useUncertainMutationIntent.ts` — freezes an exact request whose reply was lost (persisted across reloads and tabs) so a retry re-sends the same payload under the same key; used for money/inventory writes such as the batch inventory adjustment below.
- Most pages with write operations use `useIdempotencyKey()` rather than inline `generateIdempotencyKey()`.

## Server-Authoritative Math Pattern (Sprint 1b)
- There is no `calculate_quote_totals()` RPC (it never existed in the migrations). Quote writes go through the `save_quote` RPC; see `rpc-functions.md`.
- The money rule is in `AGENTS.md`: money resolves to exact whole cents, new storage uses bigint cents, and authoritative TypeScript parses decimals into integer cents before arithmetic. Financial invariants belong in PostgreSQL RPCs, triggers, or constraints.
- Client-side calculation is a display-only hint; the server result is authoritative

## RUP Compliance Pattern (Audit Remediation)
- `checkRUPCompliance(items, customerLicenses)` in `src/lib/rupCompliance.ts` — 3 checks: license expiry, certification type match, product registration status
- Returns `string[]` of warning messages — empty array means compliant
- Used on 6 pages: QuoteBuilder, NewOrder, NewDelivery, DeliveryDetail, InvoiceDetail, FieldAppSplitInvoiceEditor — shown as amber warning banner
- Audit logging: RUP warnings written to `financial_audit_log` on order/delivery creation
- Unit tests in `src/lib/rupCompliance.test.ts`

## Prepay Bucket Pattern (Audit Remediation)
- `prepay_credits.bucket_label` — categorizes credits (e.g., "Corn Chemical", "Soybean Fungicide", "General")
- 8 bucket labels seeded in `app_settings.prepay_bucket_labels`
- Split Check modal on the Manager tab of `/prepay` (`src/components/prepay/PrepaymentManagerPanel.tsx`): creates one `prepay_credits` row per bucket split
- Workspace tab of `/prepay` (`src/components/prepay/PrepayWorkspacePanel.tsx`): split-panel allocator with two-phase commit — stage allocations in React state, commit atomically via `batch_apply_prepayments()` RPC
- `apply_prepay_to_invoice()` uses `FOR UPDATE` row locks on both `prepay_credits` and `invoices` for concurrent safety

## Tote Tracking Pattern (Audit Remediation)
- `delivery_items.tote_number` (text, nullable) — tracks container/tote for each delivery item
- There is no `delivery_items.is_non_returnable` column. Non-returnable containers are flagged on receipt instead: `receiving_records.is_non_returnable`, shown as a "Non-Returnable" badge in the receiving log (`src/components/receiving/ReceivingLogPanel.tsx`, `ReceivingLogMobileCards.tsx`)
- Tote # is entered on the NewDelivery page and shown on DeliveryDetail
- Tote # column added to delivery PDF export via `deliveryPdf.ts`
- Threaded through `complete_delivery()` and `create_quick_delivery()` RPCs

## Email Integration Pattern (Track A)
- **Service layer**: `src/lib/emailService.ts` — `sendEmail()`, `pdfToBase64()`, `buildEmailHtml()` (CRX-branded template)
- **Edge Function**: `supabase/functions/send-email/index.ts` — Resend API, JWT auth, idempotency guard, base64 PDF attachments, `email_log` audit trail
- **10 email types** in the Edge Function source (`ALL_EMAIL_TYPES`): `invoice`, `statement`, `order_confirmed`, `delivery_completed`, `quote`, `ar_reminder`, `low_stock_alert`, `month_end_close`, `pre_application_notice`, `post_application_notice`. Drivers may send only `delivery_completed`.
- **Graceful degradation**: Email sends are always wrapped in try/catch inside the primary action handler. Email failure never blocks the core business action (quote send, order confirm, delivery complete)
- **Pages using email**:
  - `InvoiceDetail.tsx` — "Email Invoice" button (admin, posted invoices only) with PDF attachment
  - `QuoteBuilder.tsx` — auto-emails quote PDF on send (if customer has email)
  - `OrderDetail.tsx` — auto-emails customer when order status → confirmed
  - `DeliveryDetail.tsx` — auto-emails customer on delivery completion (includes delivered items, signature, photos)
  - `ARaging.tsx` — "Send AR Reminders" button (admin) with dedup via `ar_reminder_tracking`, "Email Statements" button with PDF attachment per selected customer
- **AR reminder dedup**: `ar_reminder_tracking` table has UNIQUE constraint on `(customer_id, reminder_level, sent_date)` — max one reminder per customer per level per day
- **Idempotency**: All `sendEmail()` calls include an `idempotency_key` (checked in `email_log` by Edge Function before sending)
- **Prerequisite**: Resend DNS verification (SPF/DKIM for `croprxsolutions.app`) + Edge Function secrets (`RESEND_API_KEY`, `FROM_EMAIL`, `ALLOWED_ORIGIN`)

## Team Board V2 Component Library Pattern

The Team Board was decomposed from a monolith (`TeamBoard.tsx`) into reusable components in `src/components/team/`. The table lists the original 8; the folder now holds more (for example ActivityFeed, CommentsSection, CustomerContextCard, NotificationsPanel, StaleTasksAlert, TagsManager, TeamBoardFilters, WorkloadView):

| Component | Purpose | Reused On |
|-----------|---------|-----------|
| `NoteCard.tsx` | Extracted card with priority/overdue badges, entity badge, action buttons | TeamBoard (all views) |
| `EntityBadge.tsx` | Clickable pill linking to entity detail page (6 types) | NoteCard, Detail Modal |
| `TodaysDeliveries.tsx` | Role-aware delivery bulletin (today + tomorrow preview) | TeamBoard Board tab |
| `YesterdayRecap.tsx` | Completion summary with issue cards (auto-expands on issues) | TeamBoard Board tab |
| `QuickTaskModal.tsx` | Modal to create entity-linked task from any detail page | OrderDetail, DeliveryDetail, JobDetail, CustomerDetail, PurchaseOrderDetail |
| `RelatedNotes.tsx` | Collapsible card showing notes linked to an entity via RPC | Same 5 detail pages |
| `NotePhotoUpload.tsx` | Camera-capture + multi-file upload to Supabase storage | TeamBoard Detail Modal |
| `NoteAttachments.tsx` | Thumbnail grid with click-to-view and delete support | TeamBoard Detail Modal |

**Entity Linking Pattern:**
- `team_notes.linked_entity_type` (text) + `team_notes.linked_entity_id` (uuid)
- Allowed types: `delivery`, `order`, `customer`, `job`, `purchase_order`, `quote`
- RPC `get_notes_for_entity(p_entity_type, p_entity_id)` fetches linked notes
- `EntityBadge` component maps type → route, icon, and color

**Role-Aware RPC Pattern:**
- `get_team_board_deliveries()` checks `auth.uid()` profile role
- Drivers see only their assigned deliveries; admins/sales reps see all
- Returns `{ today: [], tomorrow: [], today_total, unassigned_count }`

**Photo Upload Pattern (Supabase Storage):**
- Bucket: `team-note-attachments` (public read, authenticated write)
- Upload path: `{userId}/{timestamp}_{index}.{ext}`
- 10MB max per file, client-side compression before upload
- DB record in `team_note_attachments` links `note_id` → `file_url`
- Delete removes both storage object and DB record

**Adding QuickTaskModal to a new detail page:**
```tsx
import QuickTaskModal from '../components/team/QuickTaskModal';
import RelatedNotes from '../components/team/RelatedNotes';

const [quickTaskOpen, setQuickTaskOpen] = useState(false);

// In JSX:
<RelatedNotes entityType="order" entityId={id} onCreateTask={() => setQuickTaskOpen(true)} />
<QuickTaskModal open={quickTaskOpen} onClose={() => setQuickTaskOpen(false)}
  entityType="order" entityId={id} prefillTitle={`Re: Order ${orderNumber}`} />
```

## Build Notes
- `db.ts` uses fallback placeholder URL/key so `createClient()` doesn't crash in CI
- Supabase join inference: joined FK tables infer as arrays — use `as unknown as TargetType[]`
- JSX `&&` chains with `unknown` values: use ternary `cond ? <JSX/> : null`
- Known warning: vendor-mapbox chunk ~1,680KB (>500KB limit) — expected
- react-map-gl v8: import from `'react-map-gl/mapbox'`, NOT bare `'react-map-gl'`
- react-map-gl can't go in Vite manualChunks — only put `mapbox-gl`

## Transaction Ledger Pattern (Inventory Improvements)
- `TransactionLedgerModal` in `src/components/inventory/TransactionLedgerModal.tsx` — shows full transaction history per product
- Queries `inventory_transactions` joined with `profiles` for performer names, ordered chronologically
- `signedQuantity(qty, type)` determines the signed delta per transaction type:
  - **Positive (adds):** received, returned, released, cancelled_delivery_reversal, void_delivery_reversal
  - **Negative (subtracts):** delivered, booked, prebooked, job_applied
  - **Signed (as-is):** adjusted, transferred, prebook_reconciliation
- There is no running-balance helper any more. `summarizeInventoryPosition(rows, productId)` reports on-floor and prebooked quantities from the current `inventory` rows, because the inventory table/RPC is the current truth and the historical ledger can be incomplete
- Triggered via inline FileText icon button next to product name in InventoryPage table
- Unit tests in `TransactionLedgerModal.test.ts`

## Batch Inventory Adjustment Pattern (Inventory Improvements)
- `BatchAdjustModal` in `src/components/inventory/BatchAdjustModal.tsx` — applies uniform delta to selected products
- `buildAdjustmentCalls(items, reason, userId, getKey)` exported pure function — filters zero-delta items and builds the RPC call array; the caller supplies each row's key through `getKey`
- Keys come from a frozen batch: `useUncertainMutationIntent` (operation `adjust_inventory_batch`) freezes the exact rows, delta, and reason, and each row's key is `batchRowIdempotencyKey(batchKey, inventoryId)`. A retry re-sends every unsettled row under the key it was first sent with; any change to the batch is a new batch with new keys
- Calls `supabase.rpc('adjust_inventory', call)` per row and classifies each result as adjusted / refused / uncertain / binding_rejected (an `IDEMPOTENCY_ACTOR_MISMATCH` or `IDEMPOTENCY_INTENT_MISMATCH` means that key can never succeed; check stock history before adjusting again)
- Selection via `Set<string>` state + checkbox column in `EditableDataTable`
- "Adjust N Selected" button appears when `selectedIds.size > 0`
- Unit tests in `BatchAdjustModal.test.ts` and `BatchAdjustModal.retry.test.tsx`

## Vendor-Grouped Reorder Alerts Pattern (Inventory Improvements)
- Low-stock items grouped by `vendor` using `Map<string, InventoryRow[]>` in InventoryPage
- "ACTION REQUIRED" heading with product count + vendor count
- Per-vendor accordion showing product name, available qty, reorder point, on-order, shortfall
- "Needs Reorder" filter chip with count badge — toggles `reorderFilter` state to show only `is_low_stock` items in table
- Shortfall = `reorder_point - quantity_available`

## Inventory Valuation Pattern (Inventory Improvements)
- `current_cost` from products table joined into inventory query
- "Inventory Value" summary card: `SUM(quantity_available × current_cost)` with currency format
- "Unit Cost" and "Value" columns in table (admin-only visibility)
- Currency formatting: `$` prefix with `.toLocaleString()` and 2 decimal places

## Load Sheet PDF Pattern (Inventory Improvements)
- `generateLoadSheetPdf()` in `src/lib/loadSheetPdf.ts` — generates pick list for warehouse staff
- Product summary table: aggregates quantities across all stops by product name
- Per-stop tables: delivery number, customer, items with quantities and tote numbers
- Follows `deliveryPdf.ts` pattern: dynamic imports of jsPDF + jspdf-autotable, CRX brand colors
- "Load Sheet" button on Deliveries page for scheduled deliveries
- 6 unit tests in `loadSheetPdf.test.ts`
