# CRX_Manager_V1.0 — FINAL MERGED ACTION PLAN

**Date:** 2026-02-11
**Sources:** Claude Code forensic audit (109 findings) + ChatGPT functional audit (18 findings)
**Purpose:** Single source of truth for all fixes. Review with Gemini, then execute.
**Rule:** NO code changes until this plan is approved.

---

## HOW THIS PLAN WAS BUILT

Two independent AI audits were performed:

| | Claude Code Audit | ChatGPT Audit |
|---|---|---|
| **Date** | Feb 11, 2026 | Feb 9, 2026 |
| **Method** | 9-phase forensic analysis, plan only | Functional review + applied fixes |
| **Defects found** | 109 | 18 |
| **Verdict** | NOT production-ready | "Production Ready" |
| **Files modified** | 0 | 10 |

### Cross-Audit Findings

- **ChatGPT applied 10 valid fixes** already in the codebase (error handling on 8 pages, DataTable types, BlendTickets column headers)
- **ChatGPT made 8 factual errors** in its schema audit (see Appendix A)
- **ChatGPT's "Production Ready" verdict is incorrect** — critical inventory, data integrity, and security issues exist
- **Claude's 109-defect backlog is the master list** — it's a superset of ChatGPT's findings
- **7 ChatGPT findings overlap** with Claude's (race conditions, type casts, error handling)
- **ChatGPT's already-applied fixes are excluded** from this plan (they're done)

---

## TABLE OF CONTENTS

1. [Sprint 0: Emergency Fixes](#sprint-0-emergency-fixes-1-2-days)
2. [Sprint 1: Data Integrity & Audit Trail](#sprint-1-data-integrity--audit-trail-3-4-days)
3. [Sprint 2: Validation & Error Handling](#sprint-2-validation--error-handling-2-3-days)
4. [Sprint 3: Performance & Architecture](#sprint-3-performance--architecture-4-5-days)
5. [Sprint 4: Accessibility](#sprint-4-accessibility-3-4-days)
6. [Sprint 5: Feature Gaps](#sprint-5-feature-gaps-5-10-days)
7. [Sprint 6: Test Coverage](#sprint-6-test-coverage-10-15-days)
8. [Appendix A: ChatGPT Audit Errors](#appendix-a-chatgpt-audit-errors)
9. [Appendix B: Full Defect Reference](#appendix-b-full-defect-reference)

---

## SPRINT 0: EMERGENCY FIXES (1-2 days)

> **These must be fixed before ANY real customer data enters the system.**
> Without these, the app can silently lose data, oversell inventory, and fail without telling users.

### S0-1. Inventory Availability Check (CRITICAL)
- **IDs:** INV-001, INV-002, INV-007
- **Problem:** When a quote is converted to an order or a direct order is created, the system prebooks inventory without checking if enough exists. You can sell 10,000 units when only 5 are available. No error, no warning.
- **Proven scenario:** 100 units available → Order A for 60 → Order B for 60 → both succeed → prebooked=120 vs available=100 → deliver both → 20 phantom units delivered from thin air.
- **Files to modify:**
  - `supabase/migrations/` — new migration to modify `convert_quote_to_order()` and `create_direct_order()` RPCs
- **Fix:** Add `SELECT ... FOR UPDATE` lock on inventory row, then check `quantity_available - quantity_prebooked >= new_amount` before prebooking. If insufficient, `RAISE EXCEPTION` with clear message.
- **Also add:** Consider a CHECK constraint or trigger that warns when `quantity_prebooked > quantity_available`.
- **Est:** 4 hours

### S0-2. Wire Up checkMutationResult() (CRITICAL)
- **IDs:** X-1, D-3 (architecture), O-4
- **Problem:** The function `checkMutationResult()` in `src/lib/db.ts` was specifically built to catch silent RLS failures. When Supabase `.update()` or `.delete()` is blocked by RLS, it returns `{ data: null, error: null }` — a silent no-op. This function detects that. But it is called ZERO times in the entire codebase. 29 mutations across 12 page files can silently fail.
- **Files to modify:** Every page file that calls `.update()` or `.delete()`:
  - `BlendTicketDetail.tsx` (5 mutations)
  - `QuoteBuilder.tsx` (3 mutations)
  - `PurchaseOrderDetail.tsx` (4 mutations)
  - `CustomerDetail.tsx` (3 mutations)
  - `TeamBoard.tsx` (4 mutations)
  - `InventoryPage.tsx` (2 mutations)
  - `ProductDetail.tsx` (2 mutations)
  - `OrderDetail.tsx` (1 mutation)
  - `Notifications.tsx` (2 mutations)
  - `CropPrograms.tsx` (1 mutation)
  - `Reports.tsx` (1 mutation)
  - `SettingsPage.tsx` (1 mutation)
- **Fix:** After every `.update()` and `.delete()` call, pass the result through `checkMutationResult(result, 'operation name')`. It will throw if zero rows were affected.
- **Est:** 3 hours

### S0-3. Atomic Quote Save (CRITICAL)
- **ID:** Q-1
- **Problem:** When editing an existing quote, `QuoteBuilder.tsx` saves by: (1) DELETE all quote_items, (2) DELETE all quote_sections, (3) re-INSERT sections, (4) re-INSERT items. These are 4 separate Supabase calls. If a network failure happens after step 2 but before step 4, the quote permanently loses all its items and sections. There is no transaction wrapping these operations.
- **Files to modify:**
  - `supabase/migrations/` — new migration with `save_quote()` RPC
  - `src/pages/QuoteBuilder.tsx` — replace saveQuote() with RPC call
- **Fix:** Create a new SECURITY DEFINER RPC `save_quote(quote_id, sections_json, items_json)` that handles the delete-and-reinsert inside a single PostgreSQL transaction. If any step fails, everything rolls back.
- **Est:** 6 hours

### S0-4. Inventory Unique Constraint (HIGH)
- **ID:** DB-INT-001
- **Problem:** The `inventory` table has no UNIQUE constraint on `(product_id, location)`. Multiple rows can exist for the same product at the same location. When RPCs do `UPDATE inventory WHERE product_id = X AND location = 'Main Warehouse'`, they could update multiple rows or create duplicates via the `IF NOT FOUND THEN INSERT` fallback.
- **Files to modify:**
  - `supabase/migrations/` — new migration
- **Fix:** First verify no duplicates exist with `SELECT product_id, location, COUNT(*) FROM inventory GROUP BY product_id, location HAVING COUNT(*) > 1`. Then add `ALTER TABLE inventory ADD CONSTRAINT inventory_product_location_unique UNIQUE (product_id, location)`.
- **Est:** 1 hour

### S0-5. Over-Delivery Detection (HIGH)
- **ID:** INV-005, INV-014
- **Problem:** `complete_delivery()` uses `GREATEST(quantity_available - qty, 0)` which clamps to zero instead of failing. If 60 units are delivered but only 40 are available, the result is `available = 0` with no error. 20 phantom units were delivered. The audit trail shows a normal delivery with no indication of the shortfall.
- **Files to modify:**
  - `supabase/migrations/` — modify `complete_delivery()` RPC
- **Fix:** Before the UPDATE, check `IF v_inv.quantity_available < v_item.quantity`. Options: (a) RAISE EXCEPTION to block over-delivery, or (b) allow it but log an `'over_delivery'` transaction type with the shortfall amount. Business decision needed on which approach.
- **Est:** 3 hours

**Sprint 0 Total: ~17 hours**

---

## SPRINT 1: DATA INTEGRITY & AUDIT TRAIL (3-4 days)

> **Make every important action logged, atomic, and notification-enabled.**

### S1-1. Activity Logging for All Workflows (HIGH)
- **IDs:** X-4, O-1, C-1, P-3, D-5, BT-5, S-1, R-1
- **Problem:** Only 3 of 11 workflows log to `activity_feed` (QuoteBuilder, PurchaseOrders, TeamBoard). The other 8 have zero logging. Orders — the core revenue entity — have no audit trail.
- **Files to modify:** `OrderDetail.tsx`, `NewOrder.tsx`, `CustomerDetail.tsx`, `ProductDetail.tsx`, `DeliveryDetail.tsx`, `NewDelivery.tsx`, `BlendTicketDetail.tsx`, `SettingsPage.tsx`, `Reports.tsx`
- **Fix:** Add `logActivity()` calls from `src/lib/activityLogger.ts` to all create, update, delete, and status-change operations.
- **Est:** 4 hours

### S1-2. Wire Up Existing Notification Functions (HIGH)
- **IDs:** X-2, X-3, Q-3, O-2
- **Problem:** `notifyOrderStatusChange()` and `notifyLargeOrder()` are fully implemented in `src/lib/notificationTriggers.ts` but NEVER called from any page. Order cancellations, fulfillments, and large orders produce zero notifications.
- **Files to modify:** `OrderDetail.tsx` (status changes), `QuoteBuilder.tsx` (after conversion)
- **Fix:** Call `notifyOrderStatusChange()` after every order status update. Call `notifyLargeOrder()` after `convert_quote_to_order` returns successfully. Both functions already exist — they just need to be invoked.
- **Est:** 2 hours

### S1-3. Atomic PO Edit (CRITICAL)
- **ID:** PO-1, PO-2, PO-3
- **Problem:** PO edit updates header first, then loops items one-by-one. PO delete removes items then PO. Both are non-atomic. Also, partially_received POs can be deleted, losing receiving history.
- **Files to modify:**
  - `supabase/migrations/` — new `save_purchase_order()` RPC
  - `src/pages/PurchaseOrderDetail.tsx` — use RPC
- **Fix:** Create atomic RPC. Add status check blocking deletion of partially/fully received POs.
- **Est:** 6 hours

### S1-4. Atomic Multi-Step Writes (HIGH)
- **ID:** X-5
- **Problem:** 5 workflows use non-atomic multi-step writes: Customers (header then addresses), Deliveries (delivery then items), BlendTickets (products one-by-one), Quote duplication (sections then items).
- **Files to modify:** Multiple pages + new RPCs
- **Fix:** For each workflow, either create an RPC or restructure the operations. Priority order: Customer addresses → Delivery creation → BlendTicket product saves → Quote duplication.
- **Est:** 8 hours

### S1-5. Standardize net_margin Units (HIGH)
- **ID:** QM-007
- **Problem:** The `net_margin` column stores a FRACTION (0.20 meaning 20%) from QuoteBuilder, but a PERCENTAGE (20.0 meaning 20%) from BulkQuoteImport and `create_direct_order`. Same column, two incompatible units.
- **Files to modify:**
  - `src/pages/QuoteBuilder.tsx` — change line 338 to multiply by 100
  - OR `src/components/quotes/BulkQuoteImport.tsx` + `create_direct_order` RPC — remove the *100
  - `supabase/migrations/` — data migration to normalize existing records
- **Fix:** Pick ONE convention (recommend percentage to match `total_margin_pct`). Update all writers. Run data migration on existing records.
- **Est:** 3 hours

### S1-6. Tighten RLS Policies (HIGH)
- **IDs:** DB-RLS-001, DB-RLS-002, DB-RLS-004, DB-SEC-003
- **Files to modify:** `supabase/migrations/` — new migration
- **Fixes:**
  - `notifications` INSERT: Change from `WITH CHECK (true)` to `WITH CHECK (is_admin() OR user_id = (select auth.uid()))`. Create SECURITY DEFINER RPC for cross-user notifications.
  - `ocr_processing_queue` INSERT: Restrict to ticket owner. UPDATE: Restrict to admin.
  - `idempotency_keys`: Remove open FOR ALL policy. Access only via RPCs.
  - Add `SET search_path = public` to 8 SECURITY DEFINER functions.
- **Est:** 3 hours

### S1-7. Fix admin_update_profile is_active Check (HIGH)
- **ID:** DB-ROLE-005
- **Problem:** A deactivated admin who still has a valid JWT can call `admin_update_profile` to set their own `is_active` back to `true`.
- **Files to modify:** `supabase/migrations/` — modify RPC
- **Fix:** Add `AND is_active = true` to the caller role check.
- **Est:** 0.5 hours

**Sprint 1 Total: ~26.5 hours**

---

## SPRINT 2: VALIDATION & ERROR HANDLING (2-3 days)

> **Prevent bad data from entering the system.**

### S2-1. Unit Conversion Validation (MEDIUM)
- **IDs:** QM-001, QM-002
- **Problem:** When `rate_unit` or `inventory_unit` is NULL, the conversion factor silently defaults to 1 (oz). If a user enters 32 gal/acre but forgets to pick the unit, the system calculates as 32 oz/acre — a 128x error.
- **Files to modify:** `src/pages/QuoteBuilder.tsx`
- **Fix:** In `recalcItem()` or save validation, require `rate_unit` when `actual_rate > 0` and warn when product has null `inventory_unit`.
- **Est:** 2 hours

### S2-2. Numeric Input Validation (MEDIUM)
- **IDs:** QM-011, QM-010, S-3
- **Problem:** Rate, acres, quantity, and price inputs accept negative values and zero values that produce $0 line items. `defaultValidDays` in settings accepts 0.
- **Files to modify:** `QuoteBuilder.tsx`, `NewOrder.tsx`, `SettingsPage.tsx`
- **Fix:** Add `min={0}` to all numeric inputs. Add validation that both rate AND acres must be > 0 (not just one). Add `min={1}` to `defaultValidDays`.
- **Est:** 2 hours

### S2-3. Commission Split Validation (MEDIUM)
- **ID:** Q-4
- **Problem:** Commission splits are not validated to sum to 100%. A split of 60% + 60% = 120% is accepted.
- **Files to modify:** `src/pages/QuoteBuilder.tsx`
- **Fix:** Before save, validate `splits.reduce((sum, s) => sum + s.percentage, 0) === 100`.
- **Est:** 1 hour

### S2-4. BlendTicket Error Handling (HIGH)
- **IDs:** BT-1, BT-2, BT-3, BT-4
- **Problem:** `handleSave`, `handleApprove`, `handleReject` all fail silently (only `console.error`, no toast). `removeProduct` deletes immediately with no confirmation. Approve/Reject have no confirmation dialog.
- **Files to modify:** `src/pages/BlendTicketDetail.tsx`
- **Fix:** Add error toasts to all catch blocks. Add confirmation modals before approve, reject, and product removal.
- **Est:** 3 hours

### S2-5. Confirmation Dialogs for Irreversible Actions (HIGH)
- **IDs:** D-3 (delivery completion), S-4 (user deactivation)
- **Problem:** Completing a delivery (irreversible inventory change) and deactivating a user (locks them out) have no confirmation step.
- **Files to modify:** `DeliveryDetail.tsx`, `SettingsPage.tsx`
- **Fix:** Add confirmation modal before `completeDelivery` and before toggling `is_active = false`.
- **Est:** 2 hours

### S2-6. BulkQuoteImport Unit Fix (MEDIUM)
- **ID:** QM-014
- **Problem:** `BulkQuoteImport.tsx` line 326 hardcodes `/16` (oz-to-lb) instead of using the product's actual `inventory_unit` conversion factor. Bulk-imported quotes for gallon-based products show 8x wrong unit counts.
- **Files to modify:** `src/components/quotes/BulkQuoteImport.tsx`
- **Fix:** Look up the product's `inventory_unit`, get its `factor_oz` from `unit_conversions`, and divide by that instead of hardcoded 16.
- **Est:** 2 hours

### S2-7. Driver UPDATE Column Restriction (MEDIUM)
- **ID:** DB-ROLE-004
- **Problem:** Driver delivery UPDATE policy allows modifying ANY column, not just status fields. A driver could change `customer_id`, `order_id`, `scheduled_date`, etc.
- **Files to modify:** `supabase/migrations/`
- **Fix:** Either restrict the driver UPDATE policy to specific columns, or remove driver from UPDATE entirely and force all driver writes through the `complete_delivery` RPC (which already limits what it changes).
- **Est:** 1 hour

### S2-8. CORS Wildcard Fix (MEDIUM)
- **ID:** DB-SEC-002
- **Problem:** `create-user` edge function uses `Access-Control-Allow-Origin: *` while all other edge functions use `ALLOWED_ORIGIN`.
- **Files to modify:** `supabase/functions/create-user/index.ts`
- **Fix:** Change line 5 to use `Deno.env.get("ALLOWED_ORIGIN") || "http://localhost:5173"`.
- **Est:** 0.5 hours

### S2-9. Number Generation Race Conditions (MEDIUM)
- **IDs:** D-4, X-6, PO-4/PO-5 (from ChatGPT audit items 14-16)
- **Problem:** Delivery and PO number generation uses count+1 pattern. Two simultaneous creates can get the same number. Quote duplication also uses count instead of the existing `next_quote_number()` RPC.
- **Files to modify:**
  - `supabase/migrations/` — new sequences for delivery and PO numbers
  - `src/pages/NewDelivery.tsx`, `src/pages/PurchaseOrderDetail.tsx`, `src/pages/Quotes.tsx`
- **Fix:** Create `next_delivery_number()` and `next_po_number()` DB functions using sequences. Update quote duplication to call `next_quote_number()` RPC.
- **Est:** 3 hours

### S2-10. Settings Upsert Fix (HIGH)
- **ID:** S-2
- **Problem:** Settings save uses read-then-write (check if key exists, then update or insert). Under concurrent editing, this causes lost updates.
- **Files to modify:** `src/pages/SettingsPage.tsx`
- **Fix:** Replace with single `supabase.from('app_settings').upsert({...}, { onConflict: 'setting_key' })` call.
- **Est:** 1 hour

**Sprint 2 Total: ~17.5 hours**

---

## SPRINT 3: PERFORMANCE & ARCHITECTURE (4-5 days)

> **Make the app scale beyond small datasets.**

### S3-1. Server-Side Pagination (HIGH)
- **ID:** H-2
- **Problem:** Every list page fetches ALL records from Supabase with no `.limit()` or `.range()`. DataTable renders every row into the DOM. With hundreds of records, this causes slow loads and large payloads.
- **Files to modify:** All list pages (Customers, Products, Orders, Quotes, Deliveries, PurchaseOrders, BlendTickets, Payments)
- **Fix:** Add `.range(from, to)` to all list queries. Add page controls to DataTable. Start with 50 rows per page.
- **Est:** 8 hours

### S3-2. Dashboard Query Consolidation (HIGH)
- **ID:** H-1, H-6
- **Problem:** Dashboard fires 8 separate queries (2 tables queried twice), 5 with no limit. All aggregation happens client-side in JavaScript. Notification checks fire on every Dashboard load with no debounce.
- **Files to modify:**
  - `supabase/migrations/` — create DB views or RPCs for dashboard aggregates
  - `src/pages/Dashboard.tsx` — use views/RPCs instead of raw queries
- **Fix:** Create `dashboard_summary` DB view/RPC that returns pre-aggregated totals, monthly revenue, top customers, low stock, and AR balance in one call. Add 5-minute debounce on notification checks.
- **Est:** 6 hours

### S3-3. Create useSupabaseQuery Hook (HIGH)
- **IDs:** C-2 (architecture), E-2
- **Problem:** 37 fetch useEffect hooks have no AbortController cleanup. The fetch/loading/error/toast boilerplate is duplicated across 15 pages.
- **Files to modify:**
  - `src/hooks/useSupabaseQuery.ts` (new file)
  - All list/detail pages (update to use hook)
- **Fix:** Create a shared hook that handles: AbortController cleanup on unmount, loading state, error toast, stale-while-revalidate, and abort on re-render. Then migrate pages one at a time.
- **Est:** 4 hours for hook + 6 hours for migration = 10 hours

### S3-4. Break Up God Components (HIGH)
- **ID:** B-2
- **Problem:** 10 pages exceed 500 lines (TeamBoard ~1500, QuoteBuilder ~1300, InventoryPage ~1050). They mix data fetching, business logic, event handlers, and presentation in one function.
- **Files to modify:** Start with the 3 worst: `TeamBoard.tsx`, `QuoteBuilder.tsx`, `InventoryPage.tsx`
- **Fix:** For each: extract data fetching into custom hooks, business logic into utility functions, and JSX sections into child components. Target <300 lines per file.
- **Est:** 12 hours

### S3-5. Image & Bundle Optimization (MEDIUM)
- **IDs:** A-1, A-3, A-2
- **Problem:** Logo PNGs are ~670KB each with fragile filenames containing parentheses. PDF libs (~500KB) are statically imported. No Vite build optimization.
- **Files to modify:**
  - `src/assets/` — replace PNGs with optimized WebP or SVG
  - `src/lib/quotePdf.ts`, `src/lib/deliveryPdf.ts` — dynamic import
  - `vite.config.ts` — add manualChunks for vendor splitting
- **Fix:** Convert logos to SVG or compressed WebP. Rename to clean filenames. Use `await import('jspdf')` inside download functions. Add vendor chunk splitting in Vite config.
- **Est:** 3 hours

### S3-6. TypeScript Cleanup (HIGH)
- **IDs:** F-2, F-3
- **Problem:** 49 explicit `any` type annotations + 21 `as any` type assertions across 23 files. Most are caused by Supabase join results not having proper types.
- **Files to modify:** 23 files with `any` types, primarily `TeamBoard.tsx`, `CustomerDetail.tsx`, `InventoryPage.tsx`, `Dashboard.tsx`
- **Fix:** Define typed interfaces for Supabase query results with joins. Use `.returns<T>()` where available. Replace `as any` with proper type narrowing.
- **Est:** 6 hours

**Sprint 3 Total: ~45 hours**

---

## SPRINT 4: ACCESSIBILITY (3-4 days)

> **Legal compliance and inclusive design.**

### S4-1. ARIA Attributes (CRITICAL)
- **ID:** G-1
- **Problem:** Zero ARIA attributes in the entire codebase. Modals have no `role="dialog"`, toasts have no `role="alert"`, navigation has no `role="navigation"`, DataTable has no grid semantics.
- **Files to modify:** `Modal.tsx`, `Toast.tsx`, `Sidebar.tsx`, `AppLayout.tsx`, `DataTable.tsx`, `Badge.tsx`
- **Fix:** Add `role="dialog"` + `aria-modal="true"` + `aria-labelledby` to Modal. Add `role="alert"` + `aria-live="assertive"` to Toast. Add `role="navigation"` to Sidebar. Add `aria-expanded` to expandable sections. Add `aria-label` to icon-only buttons.
- **Est:** 8 hours

### S4-2. Keyboard Navigation (CRITICAL)
- **ID:** G-3
- **Problem:** Only 1 keyboard handler in the entire app (an onKeyPress in TagsManager, which is deprecated). No focus traps in modals. No Escape-to-close. No tabIndex on clickable elements. DataTable rows have onClick but no keyboard equivalent.
- **Files to modify:** `Modal.tsx`, `DataTable.tsx`, all pages with expandable sections
- **Fix:** Add focus trap to Modal (focus cycles within modal, Escape closes). Add `tabIndex={0}` + `onKeyDown={Enter}` to DataTable rows. Add `onKeyDown` Escape handlers to all overlays. Replace deprecated `onKeyPress` with `onKeyDown`.
- **Est:** 8 hours

### S4-3. Replace Raw HTML Form Elements (HIGH)
- **ID:** G-2, B-3
- **Problem:** 77 raw HTML form elements (43 `<select>`, 27 `<input>`, 7 `<textarea>`) bypass the accessible reusable Input/Select components that properly generate `htmlFor`/`id` associations and labels.
- **Files to modify:** ~20 page files
- **Fix:** Replace raw elements with the existing `Input` and `Select` components from `src/components/ui/`. This also improves styling consistency.
- **Est:** 6 hours

### S4-4. Skip Navigation Link (LOW)
- **ID:** G-4
- **Problem:** No "Skip to main content" link for keyboard users (WCAG 2.1 Level A requirement).
- **Files to modify:** `src/components/layout/AppLayout.tsx`
- **Fix:** Add visually-hidden skip link as first focusable element that jumps to `#main-content`.
- **Est:** 0.5 hours

**Sprint 4 Total: ~22.5 hours**

---

## SPRINT 5: FEATURE GAPS (5-10 days)

> **New functionality needed for production use.**

### S5-1. Partial Delivery Support (HIGH)
- **ID:** FG-1, D-1
- **Problem:** Delivery completion is all-or-nothing. If a driver delivers 8 of 10 items, they cannot record a partial completion.
- **Files to modify:** `DeliveryDetail.tsx`, `complete_delivery` RPC
- **Fix:** Add per-item quantity input on completion form. Modify RPC to accept partial quantities. Leave order in `partially_fulfilled` status when not all items delivered.
- **Est:** 8 hours

### S5-2. Signature Capture (HIGH)
- **ID:** FG-2, D-2
- **Problem:** `signature_pad` is listed as a dependency but never used. Delivery completion only has a text input for "signed by" name.
- **Files to modify:** `DeliveryDetail.tsx`
- **Fix:** Import and integrate `signature_pad`. Store signature image in Supabase storage. Display on delivery receipt PDF.
- **Est:** 4 hours

### S5-3. Inventory Alert Dashboard (LOW)
- **ID:** FG-6
- **Problem:** Low stock notifications only run when someone visits the Dashboard. No proactive monitoring, no scheduling.
- **Files to modify:** `src/pages/InventoryPage.tsx` or new component
- **Fix:** Add a low-stock alerts section to the Inventory page. Consider a Supabase cron or edge function for scheduled checks (not just on Dashboard load).
- **Est:** 6 hours

### S5-4. Commission FK Fix (MEDIUM)
- **ID:** DB-INT-002
- **Problem:** `commissions.recipient` is a text field matched against `profiles.full_name`. If a name changes, the user loses access to their commissions. If two users have the same name, they see each other's.
- **Files to modify:** `supabase/migrations/`, `Reports.tsx`, `QuoteBuilder.tsx`
- **Fix:** Add `recipient_user_id uuid REFERENCES profiles(id)` column. Update RLS policy to use `recipient_user_id = auth.uid()` instead of name matching. Migrate existing data.
- **Est:** 4 hours

### S5-5. Unsaved Changes Guards (LOW)
- **IDs:** BT-7, TB-1
- **Problem:** BlendTicketDetail and TeamBoard edit modal have no unsaved changes warning. Users can navigate away and lose edits.
- **Files to modify:** `BlendTicketDetail.tsx`, `TeamBoard.tsx`
- **Fix:** Import and use the existing `useUnsavedChanges` hook.
- **Est:** 1 hour

**Sprint 5 Total: ~23 hours**

---

## SPRINT 6: TEST COVERAGE (10-15 days)

> **T3-002 — automated testing to prevent regressions.**

### S6-1. Playwright E2E Tests
- **ID:** FG-10
- **Scope:** All 11 workflows end-to-end
- **Priority order:** Login/Auth → Orders → Deliveries → Inventory → Quotes → Customers → Products → POs → BlendTickets → TeamBoard → Settings
- **Est:** 40-60 hours

### S6-2. Unit Tests for Math Functions
- **ID:** FG-10
- **Scope:** `recalcItem()`, margin calculations, unit conversions, `validateBlendMath()`, fuzzy matching
- **Framework:** Vitest (already compatible with Vite)
- **Est:** 8 hours

### S6-3. RPC Integration Tests
- **ID:** FG-10
- **Scope:** All 8 RPCs, especially the inventory scenarios from Phase 5 (overselling, over-delivery, concurrent access)
- **Est:** 8 hours

**Sprint 6 Total: ~56-76 hours**

---

## TOTAL ESTIMATED EFFORT

| Sprint | Focus | Est. Days |
|--------|-------|-----------|
| **Sprint 0** | Emergency fixes (inventory, mutations, atomic saves) | 1-2 |
| **Sprint 1** | Data integrity, audit trail, notifications, RLS | 3-4 |
| **Sprint 2** | Validation, error handling, confirmations | 2-3 |
| **Sprint 3** | Performance, pagination, architecture | 4-5 |
| **Sprint 4** | Accessibility (ARIA, keyboard, labels) | 3-4 |
| **Sprint 5** | Feature gaps (partial delivery, signatures, alerts) | 5-10 |
| **Sprint 6** | Test coverage (E2E, unit, integration) | 10-15 |
| **TOTAL** | | **~28-43 days** |

---

## APPENDIX A: CHATGPT AUDIT ERRORS

These are factual errors in `SUPABASE_SCHEMA_AUDIT.md` and `AUDIT_REPORT.md` that should be disregarded:

| # | ChatGPT Claim | Reality |
|---|---|---|
| 1 | "PRODUCTION READY" | NOT production-ready. Critical inventory, data integrity, and security issues. |
| 2 | "No policies with `USING (true)` without reason" | 25+ instances of `USING (true)` across migrations. Several are security gaps. |
| 3 | "Fixed Unrestricted Insert: Changed notifications insert from `WITH CHECK (true)` to proper ownership check" | NEVER changed. `20260210_fix_rls_critical_issues.sql` line 70 clearly shows `WITH CHECK (true)`. |
| 4 | "3 Edge Functions" | 4 edge functions exist. Missed `process-blend-ticket` (the largest/most complex one). |
| 5 | "All 26 pages" | 27 page files + LoginPage = 28 routes total. |
| 6 | "profiles SELECT: Own profile OR admin" | Final policy is `USING (true)` — ALL authenticated users read ALL profiles. |
| 7 | "notifications INSERT: Admin OR self-notification" | Final policy is `WITH CHECK (true)` — any user can target any user. |
| 8 | "Search path protection on all functions" | 8 SECURITY DEFINER functions are MISSING `SET search_path`. |

---

## APPENDIX B: FULL DEFECT REFERENCE

For complete details on every defect (including code line numbers, exact file paths,
and reproduction steps), see the following files in this repo:

- **`AUDIT_PLAN.md`** — Claude Code's full 109-defect audit with Phase 0-9 details
- **`AUDIT_REPORT.md`** — ChatGPT's 18-finding audit (contains the already-applied fixes)
- **`SUPABASE_SCHEMA_AUDIT.md`** — ChatGPT's schema audit (contains factual errors noted above)

---

## HOW TO USE THIS PLAN

1. **Give this file to Gemini** for independent review
2. **Gemini confirms, questions, or modifies** the sprint order and severity ratings
3. **Once approved**, execute sprints in order (S0 first — it's the emergency sprint)
4. **Each sprint ends with:** commit, push, verify build passes, update MEMORY.md
5. **After Sprint 6:** the system is production-ready

---

*Generated by Claude Code. Cross-referenced against ChatGPT audit.*
*Review with Gemini before executing any fixes.*
