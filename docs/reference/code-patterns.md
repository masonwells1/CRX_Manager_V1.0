# Code Patterns & AI Dev Reference

## Number Formats
- Invoice: `INV-{YYYY}-{sequential 4-digit}` via count query
- Return: `RMA-{YYYY}-{sequential 4-digit}` via count query
- Claim: `RC-{YYYY}-{sequential 4-digit}` via count query
- Cycle count: `CC-{YYYY}-{sequential 4-digit}` via count query
- PO: `PO-{YEAR}-{sequential 4-digit}` via count query
- Job: `JOB-{YYYY}-{sequential 4-digit}` via `next_job_number()` RPC
- Application record: `APP-{YYYY}-{sequential 4-digit}` via `next_application_record_number()`
- Commission payment: `CP-{YYYY}-{sequential 4-digit}` via `next_commission_payment_number()`
- Delivery: `DEL-{YYYY}-{sequential 4-digit}` via `next_delivery_number()`

## UI Patterns
- Bulk imports use a 3-state modal pattern: file selection -> validation/review -> results
- Bulk import components live in `src/components/{domain}/Bulk*.tsx`
- Modal component accepts `size="large"` prop
- Tab-based page layout used in: ARaging (3 tabs), Compliance (2 tabs), Rebates (2 tabs), InventoryPage, BlendRecipes
- Commission split editor: `src/components/ui/CommissionSplitEditor.tsx`

## Bulk Operations Pattern
- `useRowSelection` hook + `createCheckboxColumn` + `BulkActionBar` (auto-hides when 0 selected) + `BulkDeleteConfirmModal`
- Used on 6 pages: Products, Customers, Jobs, Quotes, PurchaseOrders, BlendTickets
- Other pages (Orders, Vehicles, Fields, Returns, ReceivingLog) use same pattern directly
- Smart fallback export: `const rows = selected.size > 0 ? selectedRows : filtered;` — exports selected if any, otherwise all filtered
- Soft delete pattern: `.update({ deleted_at: new Date().toISOString() })` + filter `.is('deleted_at', null)`. Used by Returns, Invoices
- Hand-rolled checkbox selection: Invoices and Deliveries use custom `Set<string>` state (pre-existing pattern, kept for stability)
- InventoryPage uses `EditableDataTable` (inline editing) — no checkbox column, export-only

## PDF Generation
- Invoice PDF: 3 layouts via `src/lib/invoicePdf.ts` (756 lines)
- Statement PDF: dual-mode via `src/lib/statementPdf.ts` (818 lines)
- Year-end summary PDF: `src/lib/yearEndSummaryPdf.ts` (633 lines)
- Delivery PDF: `src/lib/deliveryPdf.ts` — batch support, delivered vs planned columns, partial delivery amber highlight
- Receiving PDF: `src/lib/receivingPdf.ts` — CRX green header, condition color-coding, batch support
- PDF text extraction uses `pdfjs-dist` (already installed), see `BulkOrderImport.tsx` for reference

## OCR & Matching
- Product fuzzy matching via `fuzzyMatchProduct()` in `src/lib/ocrParser.ts` (0.7 threshold)
- Blend math validator: `src/lib/blendMathValidator.ts`
- Manual ticket creation: `src/components/blendtickets/ManualTicketCreate.tsx`

## Key Component Patterns
- Activity logging via `logActivity()` from `src/lib/activityLogger.ts`
- Product search modal pattern reused from `NewPurchaseOrder.tsx:400-453`
- Admin user edit via `admin_update_profile` RPC (SECURITY DEFINER)
- ReportShell component: reusable date range + season presets + CSV/PDF export wrapper (`src/components/reports/ReportShell.tsx`)
- LogbookReport component: 4 sub-tabs (by Customer/Applicator/Field/FAA)

## Financial Patterns
- AR aging uses Supabase RPC `get_ar_aging()` — handles both invoiced and uninvoiced orders
- Customer statement uses RPC `get_customer_statement()` — running balance via window function
- Season comparison uses RPC `get_season_comparison()` — YoY metrics (July 1-June 30 seasons)
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

## Build Notes
- `db.ts` uses fallback placeholder URL/key so `createClient()` doesn't crash in CI
- Supabase join inference: joined FK tables infer as arrays — use `as unknown as TargetType[]`
- JSX `&&` chains with `unknown` values: use ternary `cond ? <JSX/> : null`
- Known warning: vendor-mapbox chunk ~1,680KB (>500KB limit) — expected
- react-map-gl v8: import from `'react-map-gl/mapbox'`, NOT bare `'react-map-gl'`
- react-map-gl can't go in Vite manualChunks — only put `mapbox-gl`
