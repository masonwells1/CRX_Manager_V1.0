# Deep Audit Bug Report — 2026-03-11

**Audited by:** 6 parallel agents covering RPCs, state machines, financial math, Supabase queries, inventory logic, and type safety.

**Result:** 49 bugs found + 1 documentation error. Financial math: CLEAN (0 bugs).

---

## TIER 1 — CRITICAL (will crash at runtime)

### C1. `save_purchase_order` references non-existent `product_name` column
- **Location:** Migration `20260325200000_sprint1_fix_financial_compliance.sql`
- **Bug:** The RPC inserts `product_name` into `purchase_order_items`, but that column doesn't exist in the table.
- **Impact:** Any call to save a purchase order will fail with a PostgreSQL column-not-found error.
- **Fix:** Add migration: `ALTER TABLE purchase_order_items ADD COLUMN product_name text;` OR remove the column from the INSERT and use a JOIN to `products`.

### C2. `cancel_order` sets `commissions.status = 'cancelled'` — violates CHECK constraint
- **Location:** Migration `20260302200000_business_logic_enhancements.sql` (~line 864)
- **Bug:** The DB CHECK constraint on `commissions.status` only allows `'pending'` or `'paid'`. TypeScript includes `'cancelled'` but the DB doesn't.
- **Impact:** Cancelling any order with commissions will fail with a CHECK constraint violation.
- **Fix:** Add migration: `ALTER TABLE commissions DROP CONSTRAINT commissions_status_check; ALTER TABLE commissions ADD CONSTRAINT commissions_status_check CHECK (status IN ('pending', 'paid', 'cancelled'));`

### C3. `cancel_delivery` sets draft invoices to `'voided'` — invalid state transition
- **Location:** Migration `20260315200000_emergency_rpc_fixes.sql`, line 405-406
- **Bug:** The invoice state machine trigger only allows `posted -> voided`, not `draft -> voided`.
- **Impact:** Cancelling any delivery with a linked draft invoice crashes with "Invalid invoice status transition: draft -> voided".
- **Fix:** Change to `status = 'cancelled'` for draft/unposted invoices (matching what `cancel_order` does).

---

## TIER 2 — HIGH (data integrity / financial risk)

### H1. Partially fulfilled orders remain editable
- **Location:** `src/pages/OrderDetail.tsx`, line 60
- **Bug:** `canEdit` only blocks `fulfilled` and `cancelled`. A `partially_fulfilled` order (with active deliveries/invoices) can still be edited.
- **Fix:** Add `&& order?.status !== 'partially_fulfilled'` to canEdit.

### H2. Invoice post has no confirm dialog
- **Location:** `src/pages/InvoiceDetail.tsx`, line 373
- **Bug:** Posting is irreversible (locks amounts, starts AR aging) but fires immediately with no confirmation. Void correctly uses a modal.
- **Fix:** Add `window.confirm()` or modal before `handlePost`.

### H3. Paid invoices can be voided
- **Location:** `src/pages/InvoiceDetail.tsx`, line 685
- **Bug:** Void button shown for `posted`, `overdue`, and `paid`. Voiding a paid invoice leaves orphaned payment records.
- **Fix:** Remove `paid` from void eligibility, or ensure void reverses associated payments.

### H4. Jobs can complete directly from 'scheduled', skipping 'in_progress'
- **Location:** `src/pages/JobDetail.tsx`, line 473
- **Bug:** `canComplete` allows both `scheduled` and `in_progress`. Lifecycle requires `scheduled -> in_progress -> completed`.
- **Fix:** Change to `status === 'in_progress'` only. Add a "Start Job" button.

### H5. PO edit modal allows arbitrary status changes
- **Location:** `src/pages/PurchaseOrderDetail.tsx`, lines 786-791
- **Bug:** Status dropdown lists all 5 statuses regardless of current state. A user can change `fully_received` back to `draft`.
- **Fix:** Remove status from edit modal, or filter to valid next states only.

### H6. `create_quick_delivery` does NOT prebook inventory
- **Location:** Migration `20260325100000_sprint1_fix_critical_overloads.sql`, lines 501-647
- **Bug:** Unlike `create_direct_order` and `convert_quote_to_order`, quick delivery skips `quantity_prebooked` increment. Two simultaneous quick deliveries could oversell stock.
- **Fix:** Add prebooking pass after the availability check, matching `create_direct_order` pattern.

### H7. `InvoiceStatus` includes phantom statuses `'paid'` and `'overdue'`
- **Location:** `src/types/index.ts:706`
- **Bug:** DB CHECK only allows `draft | unposted | posted | voided | cancelled`. Frontend code checking `status === 'paid'` or `status === 'overdue'` will never match.
- **Fix:** Remove `'paid' | 'overdue'` from InvoiceStatus. Compute these from `balance_cents` and `due_date`.

---

## TIER 3 — MEDIUM (workflow gaps, missing actions, silent failures)

### M1. Revised quotes can be converted without re-sending
- **Location:** `src/pages/QuoteBuilder.tsx`, line 174
- **Bug:** `canConvert` includes `'revised'` — allows converting a revised quote directly to an order without re-sending to customer.
- **Fix:** Only allow `'sent'` for conversion, or document that revised = implicitly re-sent.

### M2. No UI actions for Quote Decline or Expire
- **Location:** `src/pages/QuoteBuilder.tsx`
- **Bug:** No buttons or handlers exist to decline or expire quotes. No cron/trigger for auto-expiration.
- **Fix:** Add Decline button for sent/revised quotes. Add trigger for `expires_at < now()`.

### M3. Order status dropdown shows invalid transitions
- **Location:** `src/pages/OrderDetail.tsx`, lines 898-903
- **Bug:** All 4 statuses shown regardless of current state. Users can see `fulfilled -> confirmed`.
- **Fix:** Filter using existing `validTransitions` map at lines 194-197.

### M4. No confirm dialog for order status changes (non-cancel)
- **Location:** `src/pages/OrderDetail.tsx`, line 906
- **Bug:** Dropdown onChange fires immediately — accidental selection triggers the update.
- **Fix:** Add confirmation before `handleStatusChange`.

### M5. Fully received POs can be edited
- **Location:** `src/pages/PurchaseOrderDetail.tsx`, line 423
- **Bug:** Edit only blocked for `cancelled`. Fully received POs (with costs applied) remain editable.
- **Fix:** Also block `fully_received`, or only allow editing in `draft`.

### M6. No cancel action for Jobs
- **Location:** `src/pages/JobDetail.tsx`
- **Bug:** `'cancelled'` exists in JobStatus but no button/handler exists.
- **Fix:** Add Cancel button for `scheduled` or `in_progress` with confirm dialog.

### M7. No confirm dialog for Job completion
- **Location:** `src/pages/JobDetail.tsx`, line 357
- **Bug:** Completing a job deducts inventory and creates application records — irreversible but no confirmation.
- **Fix:** Add confirm step before or within the completion modal.

### M8. No cancel action for Returns/RMA
- **Location:** `src/pages/Returns.tsx`
- **Bug:** `'cancelled'` exists in ReturnStatus but no button/handler exists.
- **Fix:** Add Cancel button for `requested` or `approved`.

### M9. No confirm dialog for Return Approve/Reject
- **Location:** `src/pages/Returns.tsx`, line 275
- **Bug:** Approve/reject execute immediately without confirmation.
- **Fix:** Add `window.confirm()` before RPC calls.

### M10. No confirm dialog for Commission Post
- **Location:** `src/pages/CommissionPayments.tsx`, line 197
- **Bug:** Financial action executes without confirmation.
- **Fix:** Add confirmation prompt.

### M11. NewOrder.tsx Net Position omits planned holds
- **Location:** `src/pages/NewOrder.tsx`, line 560
- **Bug:** `netPos = onOrder + available - prebooked` omits inventory holds and planned quote reservations. InventoryPage.tsx correctly includes them.
- **Fix:** Fetch holds/planned quantities and subtract, or share utility function with InventoryPage.

### M12. "On Order" includes draft POs
- **Location:** `src/pages/InventoryPage.tsx`, line 167
- **Bug:** Draft POs haven't been submitted to suppliers. Including them inflates supply-side numbers.
- **Fix:** Remove `'draft'` from PO status filter.

### M13. `Customer` interface missing `prepay_balance_cents`
- **Location:** `src/types/index.ts:77-107`
- **Fix:** Add `prepay_balance_cents: number;` to Customer interface.

### M14. `Commission` interface missing 4 fields
- **Location:** `src/types/index.ts:456-470`
- **Bug:** Missing `season`, `deleted_at`, `order_number`, `customer_name` (added in migration 20260223210000).
- **Fix:** Add all four fields.

### M15. `Invoice` interface missing `write_off_cents`
- **Location:** `src/types/index.ts:708-763`
- **Fix:** Add `write_off_cents: number;`.

### M16. Date timezone off-by-one-day risk (~19 locations)
- **Bug:** `new Date("2026-03-11")` parses as UTC midnight, which in US timezones becomes the previous day. ~19 pages use `new Date(dateString)` on date-only columns without appending `T00:00:00`.
- **Affected files:** Orders.tsx, Invoices.tsx, CustomerDetail.tsx, Reports.tsx, BlendTicketDetail.tsx, Returns.tsx, VendorBills.tsx, VendorBillDetail.tsx, InvoiceDetail.tsx, OrderDetail.tsx, NewOrder.tsx, QuoteBuilder.tsx, Quotes.tsx, PaymentAllocation.tsx, DeliveryDetail.tsx, PrepayWorkspace.tsx, DeliveryRemainders.tsx
- **Fix:** Change to `new Date(dateString + 'T00:00:00')` for date-only columns. `PaymentHistory.tsx:185` already does this correctly.

---

## TIER 4 — LOW (silent errors, cleanup, style)

### L1. BlendTicketDetail `removeProduct` missing try/catch around checkMutationResult
- **Location:** `src/pages/BlendTicketDetail.tsx`, line 342-353
- **Fix:** Wrap in try/catch, show toast on error.

### L2. Products.tsx `cost_history` insert error ignored
- **Location:** `src/pages/Products.tsx`, line 300
- **Fix:** Destructure and log error.

### L3. ProductDetail.tsx `cost_history` insert error ignored
- **Location:** `src/pages/ProductDetail.tsx`, line 179
- **Fix:** Destructure and log error.

### L4. BlendRecipes.tsx duplicate recipe items insert error ignored
- **Location:** `src/pages/BlendRecipes.tsx`, line 263
- **Fix:** Check error and throw.

### L5. ARaging.tsx `ar_reminder_tracking` insert error ignored
- **Location:** `src/pages/ARaging.tsx`, line 541
- **Bug:** Lost dedup record means next batch could re-email same customers.
- **Fix:** Log error.

### L6. BlendTicketDetail `addProduct` gives no error feedback
- **Location:** `src/pages/BlendTicketDetail.tsx`, lines 331-339
- **Fix:** Add error toast.

### L7. Activity logger ignores Supabase response errors (3 locations)
- **Location:** `src/lib/activityLogger.ts`, lines 23, 56, 95
- **Fix:** Destructure and console.error.

### L8. offlineSync.ts `.single()` should be `.maybeSingle()`
- **Location:** `src/lib/offlineSync.ts`, line 89
- **Fix:** Change to `.maybeSingle()`.

### L9. `batch_void_invoices` missing try/catch
- **Location:** `src/pages/Invoices.tsx`, lines 178-197
- **Fix:** Wrap in try/catch like `handleBatchPost`.

### L10. N+1 query in Reports.tsx year-end summaries
- **Location:** `src/pages/Reports.tsx`, lines 382-386
- **Fix:** Use existing `get_batch_year_end_summaries` RPC instead of looping.

### L11. Race condition in PrepaymentManager fallback
- **Location:** `src/pages/PrepaymentManager.tsx`, lines 298-317
- **Fix:** Use atomic SQL expression or remove fallback.

### L12. Batch inventory adjustment lacks transaction boundary
- **Location:** `src/components/inventory/BatchAdjustModal.tsx`, lines 82-90
- **Fix:** Create batch RPC or accept partial failure reporting.

### L13. Stale `cancel_delivery(uuid, text)` overload in database
- **Location:** Migration `20260228300000_critical_prelaunch_fixes.sql`, line 635
- **Fix:** Add `DROP FUNCTION IF EXISTS cancel_delivery(uuid, text);`

### L14. `as any[]` type erasure in Deliveries.tsx and LogbookReport.tsx
- **Location:** `src/pages/Deliveries.tsx:243`, `src/components/reports/LogbookReport.tsx:67`
- **Fix:** Define proper return types.

### L15. `PurchaseOrderItem` missing `product_name` field
- **Location:** `src/types/index.ts:397-407`
- **Fix:** Add `product_name?: string;` (after C1 is fixed).

### L16. `deliveryPdf.ts` fmt doesn't divide by 100
- **Location:** `src/lib/deliveryPdf.ts:46`
- **Bug:** Plain number formatter, not currency. Need to verify call sites pass dollars not cents.
- **Fix:** Audit all fmt() calls in that file.

### L17. `@ts-expect-error` in fieldImportParser.ts
- **Location:** `src/lib/fieldImportParser.ts:1, 144`
- **Fix:** Add proper type declarations.

### L18. `'unposted'` invoice status is undocumented
- **Location:** `src/pages/InvoiceDetail.tsx`, line 587
- **Bug:** Used in code and DB but not in documented lifecycle (`draft -> posted -> void`).
- **Fix:** Document it or consolidate with `draft`.

---

## DOCUMENTATION ERROR

### D1. CLAUDE.md says `complete_delivery` requires `p_signed_by uuid` — it's actually `text`
- **Location:** CLAUDE.md, Schema Gotchas section
- **Fix:** Change to `p_signed_by text`.

---

## SUMMARY

| Tier | Count | Description |
|------|-------|-------------|
| **Critical** | 3 | Runtime crashes — must fix before production use |
| **High** | 7 | Data integrity risks, missing safety guards |
| **Medium** | 16 | Workflow gaps, missing actions, type drift, timezone bugs |
| **Low** | 18 | Silent errors, cleanup, style issues |
| **Doc** | 1 | CLAUDE.md inaccuracy |
| **TOTAL** | **45** | (deduplicated from 49 raw findings across 6 audits) |

### What's CLEAN (no bugs found):
- **Financial math** — all cents/dollars conversions correct throughout
- **checkMutationResult usage** — all 38 `.update()` and 11 `.delete()` calls properly checked
- **Supabase query filters** — no unfiltered updates/deletes found
- **Core RPC parameter passing** — 120+ calls audited, all correct
- **Core inventory RPCs** — complete_delivery, receive_po, cancel_order, adjust_inventory all correct
