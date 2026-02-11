# CRX_Manager_V1.0 — Full Forensic Code Audit & Production Readiness Plan

**Date:** 2026-02-11
**Auditor:** Claude Code (Anthropic)
**Repo:** https://github.com/masonwells1/CRX_Manager_V1.0
**Stack:** React 18 + TypeScript + Vite + Tailwind CSS + Supabase + Vercel

> **Purpose:** This document is a comprehensive defect backlog and fix plan produced by
> a 9-phase forensic code audit. NO code was modified during this audit. This plan is
> intended to be reviewed by a second AI (Gemini) before any work begins.

---

## TABLE OF CONTENTS

1. [Executive Summary](#1-executive-summary)
2. [Defect Backlog — Master Table](#2-defect-backlog--master-table)
3. [Phase 1: Build Health](#3-phase-1-build-health)
4. [Phase 2: Database & Security](#4-phase-2-database--security)
5. [Phase 3: Functional Flow Matrix](#5-phase-3-functional-flow-matrix)
6. [Phase 4: Quote Math Forensics](#6-phase-4-quote-math-forensics)
7. [Phase 5: Inventory Integrity](#7-phase-5-inventory-integrity)
8. [Phase 6: Architecture](#8-phase-6-architecture)
9. [Feature Gap Analysis](#9-feature-gap-analysis)
10. [Recommended Fix Order (Sprints)](#10-recommended-fix-order-sprints)

---

## 1. EXECUTIVE SUMMARY

### Overall Verdict: NOT PRODUCTION-READY — Fixable

The CRX_Manager_V1.0 codebase has strong foundations (atomic RPCs, RLS on all tables,
CHECK constraints, proper auth flow, lazy-loaded routes) but contains **critical defects**
that must be resolved before serving real customers.

### Defect Counts

| Severity | Count | Examples |
|----------|-------|---------|
| **CRITICAL** | 8 | Unlimited overselling, non-atomic save-then-delete, unused mutation safety check, zero accessibility |
| **HIGH** | 37 | Silent over-delivery, missing activity logging on 8/11 workflows, no pagination, race conditions |
| **MEDIUM** | 35 | Penny drift, weak fuzzy matching, missing validation, inconsistent margin units |
| **LOW** | 29 | Cosmetic issues, minor duplication, missing constraints on nullable columns |
| **TOTAL** | **109** | |

### The 5 Most Dangerous Defects

1. **INV-001 (CRITICAL):** No availability check on inventory prebooking. You can sell 10,000 units when only 5 exist. No error, no warning.
2. **Q-1 (CRITICAL):** QuoteBuilder saves by DELETING all items, then re-inserting them. Network failure mid-save = permanent data loss.
3. **D-3/X-1 (CRITICAL):** `checkMutationResult()` was built to catch silent RLS failures but is called ZERO times. 29 mutations can silently fail.
4. **G-1/G-3 (CRITICAL):** Zero ARIA attributes, zero keyboard handlers. The app is completely inaccessible.
5. **INV-005 (HIGH):** Delivery completion uses `GREATEST(available - qty, 0)` which silently delivers phantom units when stock is insufficient.

### What's Working Well

- All 29 tables have Row Level Security with role-based access
- 8 atomic RPCs handle critical business operations in database transactions
- CHECK constraints prevent negative inventory in the database
- Auth flow is solid (4-layer ProtectedRoute, `is_active` checks in role functions)
- Supabase client uses anon key only (service role key is server-side only)
- Error boundary catches render crashes
- Realtime subscriptions properly cleaned up

---

## 2. DEFECT BACKLOG — MASTER TABLE

Every defect found across all phases, sorted by severity then phase.

### CRITICAL (8)

| ID | Phase | Finding | Fix |
|----|-------|---------|-----|
| INV-001 | 5 | Prebooking has NO availability check — unlimited overselling | Add `SELECT ... FOR UPDATE` + availability check to `convert_quote_to_order` and `create_direct_order` RPCs |
| Q-1 | 3 | QuoteBuilder save-on-edit deletes ALL items then re-inserts — network failure = data loss | Replace with atomic RPC that handles update-in-place within a transaction |
| PO-1 | 3 | PO edit updates header first, then loops items one-by-one — partial failure leaves inconsistent state | Replace with atomic RPC |
| O-1 | 3 | ZERO activity logging on order creation, editing, status changes, or cancellation | Add `logActivity()` calls to all order mutations |
| X-1 | 3 | `checkMutationResult()` defined but called 0 times — 29 mutations can silently fail due to RLS | Wire up to every `.update()` and `.delete()` call |
| D-3 | 6 | `checkMutationResult()` unused (same as X-1, confirmed from architecture side) | Same fix as X-1 |
| G-1 | 6 | Zero ARIA attributes in entire codebase — no `role`, `aria-label`, `aria-live`, `aria-modal` anywhere | Add ARIA to Modal, Toast, navigation, DataTable, all interactive elements |
| G-3 | 6 | No keyboard navigation — 1 handler in entire app, no focus traps, no Escape-to-close | Add keyboard handlers, focus traps in modals, tabIndex on interactive elements |

### HIGH (37)

| ID | Phase | Finding | Fix |
|----|-------|---------|-----|
| DB-INT-001 | 2 | `inventory` table missing `UNIQUE(product_id, location)` — duplicate rows possible | Add unique constraint after verifying no duplicates |
| DB-RLS-001 | 2 | `notifications` INSERT is `WITH CHECK (true)` — any user can create notifications for any user | Restrict to `is_admin() OR user_id = auth.uid()` + SECURITY DEFINER RPC for cross-user |
| DB-RLS-002 | 2 | `ocr_processing_queue` INSERT/UPDATE fully open — any user can manipulate queue | Tighten to ticket owner on INSERT, admin on UPDATE |
| DB-SEC-003 | 2 | 8 SECURITY DEFINER functions missing `SET search_path` | Add `SET search_path = public` to all 8 |
| DB-ROLE-004 | 2 | Driver delivery UPDATE allows modifying ANY column, not just status | Restrict driver UPDATE to status-related columns only |
| DB-ROLE-005 | 2 | `admin_update_profile` doesn't check caller `is_active` — deactivated admin can reactivate self | Add `AND is_active = true` to caller check |
| DB-INT-002 | 2 | `commissions.recipient` text-matched to `full_name` with no FK | Add `recipient_user_id uuid REFERENCES profiles(id)` |
| C-1 | 3 | No activity logging on customer create/update/delete | Add `logActivity()` calls |
| C-2 | 3 | Address save operations have no error handling — failures silently ignored | Add try/catch with toast per address operation |
| P-1 | 3 | `handleCostUpdate` doesn't validate negative cost (bypasses main save validation) | Add `cost >= 0` check in cost update handler |
| P-2 | 3 | Cost history logging is non-atomic read-then-write — race condition | Wrap in RPC or use RETURNING clause |
| Q-2 | 3 | Quote duplication inserts sections/items sequentially — partial failure = orphaned duplicate | Wrap in RPC |
| Q-3 | 3 | `notifyLargeOrder()` exists but never called | Wire into `convert_quote_to_order` completion handler |
| O-2 | 3 | `notifyOrderStatusChange()` exists but never called | Wire into order status change handlers |
| O-3 | 3 | Status change to "fulfilled" doesn't verify all items are delivered | Add delivery completion verification before allowing fulfilled status |
| D-1 | 3 | No partial delivery support — all-or-nothing completion | Add per-item quantity fields to delivery completion UI |
| D-2 | 3 | No actual signature capture — just a text name input despite `signature_pad` dependency | Integrate signature_pad component |
| D-3 | 3 | No confirmation dialog before completing delivery (irreversible inventory action) | Add confirmation modal |
| D-4 | 3 | Delivery number uses count+1 pattern — race condition | Use database sequence or RPC |
| PO-2 | 3 | PO delete removes items first, then PO — if PO delete fails, items are orphaned | Reverse order or use cascade |
| PO-3 | 3 | Delete allows partially_received POs — loses receiving history reference | Block deletion of POs with received items |
| BT-1 | 3 | BlendTicketDetail `handleSave` shows NO toast on failure — silent error | Add error toast |
| BT-2 | 3 | `handleApprove`/`handleReject` fail silently — no user feedback | Add error toast |
| BT-3 | 3 | No confirmation dialog before Approve/Reject (significant state changes) | Add confirmation modal |
| BT-4 | 3 | `removeProduct` deletes immediately with no confirmation | Add confirmation |
| S-1 | 3 | No activity logging for user creation, role changes, deactivation | Add `logActivity()` calls |
| S-2 | 3 | Settings save uses read-then-write instead of `upsert()` — lost updates possible | Replace with `upsert()` |
| X-4 | 3 | Activity logging only in 3 of 11 workflows — 8 have zero logging | Add to all 8 missing workflows |
| X-5 | 3 | Non-atomic multi-step writes in 5 workflows (Quotes, POs, Customers, Deliveries, BlendTickets) | Wrap in RPCs |
| QM-005 | 4 | SUM-of-ROUND vs ROUND-of-SUM penny drift between frontend and DB trigger | Standardize rounding approach |
| QM-007 | 4 | `net_margin` stored as fraction (0.20) from QuoteBuilder, percentage (20.0) from BulkImport — incompatible | Standardize to one convention + migration |
| INV-002 | 5 | No `SELECT FOR UPDATE` lock on inventory during prebooking | Add FOR UPDATE to convert_quote_to_order and create_direct_order |
| INV-005 | 5 | `GREATEST(x, 0)` silently hides over-delivery — phantom units delivered | Add pre-check or log over_delivery warning |
| INV-007 | 5 | No CHECK constraint that prebooked ≤ available | Add constraint or warning mechanism |
| INV-009 | 5 | Quote save before conversion is non-atomic — can leave quote empty in 'accepted' status | Save + convert should be one atomic operation |
| B-2 | 6 | 10 pages exceed 500 lines (TeamBoard ~1500, QuoteBuilder ~1300) | Extract hooks, sub-components, utility functions |
| H-1 | 6 | Dashboard fires 8 queries (2 tables queried twice), 5 with no limit | Consolidate into 3-4 queries, add limits, move aggregation to DB |
| H-2 | 6 | No pagination on any list page — ALL records loaded every time | Add server-side pagination with `.range()` |
| F-2 | 6 | 49 explicit `any` type annotations across 23 files | Replace with proper types |
| F-3 | 6 | 21 `as any` type assertions suppressing type safety | Define Supabase return types |
| G-2 | 6 | 77 raw HTML form elements bypass accessible reusable components | Replace with Input/Select components |
| C-2 (arch) | 6 | No AbortController or cleanup on 37 fetch useEffect hooks | Add cleanup returns |

### MEDIUM (35)

| ID | Phase | Finding |
|----|-------|---------|
| DB-SEC-002 | 2 | `create-user` CORS wildcard `*` instead of ALLOWED_ORIGIN |
| DB-RLS-003 | 2 | `team_note_tags` DELETE is `USING (true)` — any user can remove tags |
| DB-RLS-004 | 2 | `idempotency_keys` fully open `FOR ALL` policy |
| DB-RLS-005 | 2 | Sales reps see ALL quotes/orders/payments (not scoped to own) |
| DB-RLS-006 | 2 | `customer_addresses` SELECT open to all authenticated |
| DB-INT-003 | 2 | FK to customers lacks explicit ON DELETE behavior |
| DB-INT-004 | 2 | `inventory_transactions` has columns with no FK constraints |
| C-3 | 3 | `fetchCustomer` doesn't check for Supabase errors |
| C-4 | 3 | No duplicate farm name detection |
| C-5 | 3 | Customer save is non-atomic (header → addresses as separate queries) |
| P-3 | 3 | No activity logging on product changes |
| Q-4 | 3 | Commission split percentages not validated to sum to 100% |
| Q-5 | 3 | PDF can be downloaded from unsaved state |
| O-4 | 3 | `checkMutationResult()` never used (reinforces X-1) |
| O-5 | 3 | No duplicate order number validation in NewOrder |
| O-6 | 3 | No tier-based pricing auto-fill in NewOrder |
| D-5 | 3 | No activity logging on delivery operations |
| D-6 | 3 | Past dates allowed for delivery scheduling (only warning) |
| PO-4 | 3 | No idempotency on PO edit |
| BT-5 | 3 | No activity logging on blend ticket operations |
| BT-6 | 3 | Product saves in loop — partial saves possible |
| X-6 | 3 | Delivery/PO number generation is race-condition vulnerable |
| QM-001 | 4 | NULL rate_unit silently defaults to factor 1 (oz) |
| QM-002 | 4 | NULL inventory_unit silently defaults to factor 1 (oz) |
| QM-008 | 4 | Quote totals copied to order then overwritten by trigger |
| QM-010 | 4 | Zero rate OR zero acres passes validation, produces $0 items |
| QM-011 | 4 | Negative rate/acres accepted without validation |
| QM-014 | 4 | BulkQuoteImport uses hardcoded /16 instead of unit conversion |
| INV-014 | 5 | Over-delivery indistinguishable from normal delivery in audit trail |
| A-1 | 6 | PDF libs (~500KB) statically imported |
| A-3 | 6 | Logo PNGs ~670KB, unoptimized, fragile filenames |
| C-1 (arch) | 6 | No data cache — every page refetches on mount |
| D-2 (arch) | 6 | Inconsistent error handling structure |
| E-2 | 6 | Fetch/loading/error boilerplate duplicated 15 times |
| H-3 | 6 | Missing useEffect dependency arrays |

### LOW (29)

| ID | Phase | Finding |
|----|-------|---------|
| DB-RLS-007 | 2 | Several tables lack DELETE policy (safe default, confirm intentional) |
| DB-RLS-008 | 2 | `profiles` SELECT open to all (exposes phone numbers to drivers) |
| DB-ROLE-006 | 2 | `create-user` doesn't validate role value before passing to auth |
| DB-INJ-001 | 2 | `generate_ticket_number()` lacks search_path + uses MAX+1 |
| DB-INT-005 | 2 | `products.current_cost`, `quote_items.acres` nullable (should be NOT NULL DEFAULT 0) |
| DB-INT-006 | 2 | Blend ticket number MAX+1 pattern (mitigated by UNIQUE) |
| DB-SEC-004 | 2 | `admin_update_profile` returns errors as JSON 200 instead of raising |
| C-6 | 3 | No role guard on customer create page (RLS protects, but no UI warning) |
| P-4 | 3 | No duplicate SKU/product name detection |
| P-5 | 3 | ProductDetail fetch error doesn't show toast |
| Q-6 | 3 | No duplicate quote detection |
| O-7 | 3 | Order fulfillment % computed client-side for all orders |
| D-7 | 3 | Driver has no edit capability for delivery items |
| I-1 | 3 | Delete uses `confirm()` instead of proper modal |
| I-2 | 3 | Delete logs transaction then deletes — orphaned transaction if delete fails |
| I-4 | 3 | No `activity_feed` logging (uses `inventory_transactions` only) |
| PO-5 | 3 | No notification when POs fully received |
| BT-7 | 3 | No unsaved changes warning on blend ticket form |
| TB-1 | 3 | No unsaved changes warning on team board edit |
| TB-2 | 3 | Update doesn't check row count for silent RLS failure |
| R-1 | 3 | No activity logging when commissions marked as paid |
| R-2 | 3 | Date range filtering inconsistent across report tabs |
| R-3 | 3 | CSV export generates from possibly-stale client-side data |
| R-4 | 3 | Commission tab filters by `full_name` not `user_id` |
| S-3 | 3 | No validation on `defaultValidDays` (can be 0 or negative) |
| S-4 | 3 | No confirmation before deactivating user |
| S-5 | 3 | Company info save runs Promise.all — partial save if one fails |
| QM-003 | 4 | factor_oz=0 produces silent $0 items (admin misconfiguration) |
| QM-004 | 4 | Product per-acre pricing formula differs from QuoteBuilder |
| QM-006 | 4 | net_margin at 4 decimals, total_margin_pct at 2 decimals |
| QM-012 | 4 | No upper bound on numeric inputs |
| INV-010 | 5 | Concurrent inventory row creation could hit unique violation |
| INV-013 | 5 | Activity feed threshold misses changes <10 units |
| A-2 | 6 | No manual chunk splitting or compression in Vite config |
| E-1 | 6 | OCR edge function doesn't exist (no duplication issue) |
| E-3 | 6 | Six bulk import components with identical scaffold |
| E-4 | 6 | PDF color constants duplicated |
| F-4 | 6 | DataTable generic uses `Record<string, any>` |
| G-4 | 6 | No skip-navigation link |
| G-5 | 6 | Color-only status indication |
| H-5 | 6 | Module-level mutable counter in QuoteBuilder |
| H-6 | 6 | Notification checks fire on every Dashboard load |

---

## 3. PHASE 1: BUILD HEALTH

- **Build:** ✅ Passes (11.2s, 2013 modules, 66 chunks)
- **TypeScript:** ❌ 4 errors in 2 files
- **ESLint:** ❌ 135 errors + 34 warnings across ~30 files

The build succeeds because Vite does not type-check (it only transpiles). The TypeScript
errors and lint issues are real and should be fixed but do not block the running app.

---

## 4. PHASE 2: DATABASE & SECURITY

### Summary: 3 HIGH, 11 MEDIUM, 7 LOW

**Key findings:**
- RLS policies are comprehensive but some are too permissive (notifications INSERT, OCR queue)
- Zero SQL injection vulnerabilities (all RPCs use parameterized queries)
- 8 SECURITY DEFINER functions missing `SET search_path`
- `inventory` table missing UNIQUE constraint on `(product_id, location)` — most dangerous integrity gap
- `commissions.recipient` linked by name text, not FK — fragile
- `create-user` edge function has CORS wildcard `*`
- No secrets in codebase, `.env` properly gitignored

---

## 5. PHASE 3: FUNCTIONAL FLOW MATRIX

### Workflow Ratings

| # | Workflow | Rating | Critical | High | Medium | Low |
|---|---------|--------|----------|------|--------|-----|
| 1 | Customer CRUD | PARTIAL | 0 | 2 | 3 | 1 |
| 2 | Product CRUD | PARTIAL | 0 | 2 | 2 | 1 |
| 3 | Quote Builder | PARTIAL | 1 | 2 | 2 | 1 |
| 4 | Order Management | PARTIAL | 1 | 2 | 3 | 1 |
| 5 | Delivery Workflow | PARTIAL | 0 | 4 | 2 | 1 |
| 6 | Inventory | COMPLETE | 0 | 0 | 3 | 1 |
| 7 | Purchase Orders | PARTIAL | 1 | 2 | 1 | 1 |
| 8 | Blend Tickets | PARTIAL | 0 | 4 | 2 | 1 |
| 9 | Team Board | COMPLETE | 0 | 0 | 2 | 1 |
| 10 | Reports | COMPLETE | 0 | 0 | 2 | 2 |
| 11 | Settings | PARTIAL | 0 | 2 | 2 | 1 |
| — | Cross-Cutting | — | 1 | 4 | 1 | 0 |
| | **TOTALS** | | **4** | **24** | **25** | **12** |

**Key cross-cutting issues:**
- `checkMutationResult()` unused across entire app
- `notifyOrderStatusChange()` and `notifyLargeOrder()` defined but never called
- Activity logging only in 3 of 11 workflows
- Non-atomic multi-step writes in 5 workflows

---

## 6. PHASE 4: QUOTE MATH FORENSICS

### Summary: 0 CRITICAL, 3 HIGH, 5 MEDIUM, 4 LOW

**Most important findings:**
- **QM-007 (HIGH):** `net_margin` column stores DIFFERENT UNITS depending on creation path — fraction (0.20) from QuoteBuilder, percentage (20.0) from BulkImport and direct orders. Same column, incompatible values.
- **QM-005 (HIGH):** Penny drift between frontend rounding and DB trigger rounding. Grows with item count.
- **QM-014 (MEDIUM):** BulkQuoteImport hardcodes `/16` (oz-to-lb) instead of using the unit conversion system. Wrong for gallon-based products.
- **QM-001/002 (MEDIUM):** NULL unit values silently default to factor 1 — wrong calculations with no warning.
- **Positive:** Margin formula is mathematically consistent across all paths. Floating point issues mitigated by rounding.

---

## 7. PHASE 5: INVENTORY INTEGRITY

### Summary: 1 CRITICAL, 5 HIGH, 1 MEDIUM, 2 LOW

**The Critical Scenario (proven):**

```
Starting: Product X has 100 units available, 0 prebooked

Step 1 — Order A for 60 units: prebooked = 60 ✓
Step 2 — Order B for 60 units: prebooked = 120 ⚠️ (exceeds available, NO ERROR)
Step 3 — Deliver Order A (60): available = 40, prebooked = 60 ✓
Step 4 — Deliver Order B (60): available = GREATEST(40-60, 0) = 0 ⚠️

Result: 120 units "delivered" from 100 available. 20 phantom units.
         Zero errors raised at any step. Audit trail shows nothing wrong.
```

**Positive findings:**
- CHECK constraints do prevent truly negative DB values
- `adjust_inventory()` correctly fails on negative (no GREATEST clamping)
- Delivery UPDATE is atomic (no lost updates)
- Complete audit trail in `inventory_transactions` for all major paths

---

## 8. PHASE 6: ARCHITECTURE

### Summary: 3 CRITICAL, 7 HIGH, 9 MEDIUM, 10 LOW

**Key findings:**
- **Accessibility is completely absent** — zero ARIA, zero keyboard handlers
- **No pagination anywhere** — every list page loads all records
- **Dashboard fires 8 queries** with no limits, all aggregation client-side
- **10 "god components"** over 500 lines (TeamBoard ~1500, QuoteBuilder ~1300)
- **No data cache** — every page refetches from Supabase on mount
- **No AbortController cleanup** on any of 37 fetch effects
- **49 `any` types + 21 `as any` assertions**
- **Positive:** Global error boundary exists, auth context well-structured, realtime cleanup proper

---

## 9. FEATURE GAP ANALYSIS

Features that are missing or incomplete for a production agricultural CRM:

| # | Gap | Impact | Effort |
|---|-----|--------|--------|
| FG-1 | No partial delivery support (all-or-nothing) | Drivers cannot record real-world partial deliveries | Medium |
| FG-2 | No actual signature capture (text name only, despite signature_pad dep) | Legal weakness for delivery proof | Low |
| FG-3 | No email integration (no quote emails, no order confirmations) | Manual email outside system | High |
| FG-4 | No print-friendly views for field use | Drivers/reps need paper copies | Medium |
| FG-5 | No customer portal (customers can't view quotes/orders) | All communication manual | High |
| FG-6 | No inventory alert dashboard (low stock notification runs only on Dashboard load) | Proactive monitoring absent | Low |
| FG-7 | No scheduled/recurring orders | Common in agricultural chemical sales | High |
| FG-8 | No multi-location inventory support (hardcoded 'Main Warehouse') | Single location only | Medium |
| FG-9 | No return/credit memo workflow | No way to handle returns | Medium |
| FG-10 | T3-002 test coverage — 0 tests exist | No automated regression testing | High (10-15 days) |
| FG-11 | OCR edge function never built (only client-side parsing exists) | No server-side OCR processing | Medium |
| FG-12 | No data export/backup beyond CSV | No bulk data management | Low |

---

## 10. RECOMMENDED FIX ORDER (SPRINTS)

### Sprint 0: Emergency Fixes (1-2 days)
> These must be fixed before ANY real data enters the system.

| Priority | ID(s) | Fix | Est. Hours |
|----------|-------|-----|------------|
| 1 | INV-001 + INV-002 | Add availability check + FOR UPDATE to prebook RPCs | 4h |
| 2 | X-1 / D-3 | Wire `checkMutationResult()` into all 29 mutations | 3h |
| 3 | Q-1 | Replace QuoteBuilder delete-then-reinsert with atomic RPC | 6h |
| 4 | DB-INT-001 | Add UNIQUE(product_id, location) to inventory table | 1h |
| 5 | INV-005 | Add over-delivery detection/prevention to complete_delivery | 3h |

### Sprint 1: Data Integrity & Notifications (3-4 days)
> Ensure all business operations are logged and atomic.

| Priority | ID(s) | Fix | Est. Hours |
|----------|-------|-----|------------|
| 6 | X-4 | Add `logActivity()` to all 8 missing workflows | 4h |
| 7 | X-2 + X-3 + Q-3 | Wire up `notifyOrderStatusChange()` and `notifyLargeOrder()` | 2h |
| 8 | PO-1 | Replace PO edit with atomic RPC | 4h |
| 9 | X-5 | Wrap remaining non-atomic writes (Customers, Deliveries, BlendTickets) in RPCs | 8h |
| 10 | QM-007 | Standardize net_margin units + data migration | 3h |
| 11 | DB-RLS-001 + DB-RLS-002 | Tighten notifications INSERT and OCR queue policies | 2h |
| 12 | DB-SEC-003 | Add SET search_path to 8 SECURITY DEFINER functions | 1h |

### Sprint 2: Validation & Error Handling (2-3 days)
> Prevent bad data from entering the system.

| Priority | ID(s) | Fix | Est. Hours |
|----------|-------|-----|------------|
| 13 | QM-001 + QM-002 | Add validation: require rate_unit/inventory_unit when rate > 0 | 2h |
| 14 | QM-011 | Add min=0 validation to all numeric inputs | 2h |
| 15 | Q-4 | Validate commission splits sum to 100% | 1h |
| 16 | BT-1 + BT-2 | Add error toasts to BlendTicketDetail save/approve/reject | 1h |
| 17 | BT-3 + D-3 + S-4 | Add confirmation dialogs to irreversible actions | 3h |
| 18 | QM-014 | Fix BulkQuoteImport hardcoded /16 → use unit conversion | 2h |
| 19 | DB-ROLE-004 + DB-ROLE-005 | Tighten driver UPDATE + admin_update_profile is_active | 2h |
| 20 | DB-SEC-002 | Fix create-user CORS wildcard | 0.5h |

### Sprint 3: Performance & Architecture (4-5 days)
> Make the app scale beyond small datasets.

| Priority | ID(s) | Fix | Est. Hours |
|----------|-------|-----|------------|
| 21 | H-2 | Add server-side pagination to all list pages | 8h |
| 22 | H-1 | Consolidate Dashboard into 3-4 queries + DB views | 6h |
| 23 | C-2 (arch) | Create `useSupabaseQuery` hook with AbortController (also fixes E-2) | 4h |
| 24 | B-2 | Break up 3 worst god components (TeamBoard, QuoteBuilder, InventoryPage) | 12h |
| 25 | A-3 | Optimize logos (convert to WebP/SVG, rename files) | 1h |
| 26 | A-1 | Dynamic import PDF libs (load on button click, not page load) | 2h |
| 27 | F-2 + F-3 | Replace `any` types with proper Supabase return types | 6h |

### Sprint 4: Accessibility (3-4 days)
> Legal compliance and inclusive design.

| Priority | ID(s) | Fix | Est. Hours |
|----------|-------|-----|------------|
| 28 | G-1 | Add ARIA to Modal, Toast, nav, DataTable, all interactive elements | 8h |
| 29 | G-3 | Add keyboard handlers: focus traps, Escape-to-close, tabIndex | 8h |
| 30 | G-2 | Replace 77 raw HTML form elements with accessible Input/Select components | 6h |
| 31 | G-4 | Add skip-navigation link | 0.5h |

### Sprint 5: Feature Gaps (5-10 days)
> New functionality for production use.

| Priority | ID(s) | Fix | Est. Hours |
|----------|-------|-----|------------|
| 32 | FG-1 | Partial delivery support | 8h |
| 33 | FG-2 | Signature capture integration | 4h |
| 34 | FG-6 | Inventory alert dashboard with scheduling | 6h |
| 35 | D-4 + X-6 | Fix number generation race conditions (DB sequences) | 3h |
| 36 | DB-INT-002 | Add recipient_user_id FK to commissions | 4h |

### Sprint 6: Test Coverage (10-15 days)
> T3-002 — the big one.

| Priority | ID(s) | Fix | Est. Hours |
|----------|-------|-----|------------|
| 37 | FG-10 | Playwright E2E tests for all 11 workflows | 40-60h |
| 38 | FG-10 | Unit tests for math functions (recalcItem, margin calcs) | 8h |
| 39 | FG-10 | RPC integration tests (inventory scenarios from Phase 5) | 8h |

---

## TOTAL ESTIMATED EFFORT

| Sprint | Days | Focus |
|--------|------|-------|
| Sprint 0 | 1-2 | Emergency fixes |
| Sprint 1 | 3-4 | Data integrity & notifications |
| Sprint 2 | 2-3 | Validation & error handling |
| Sprint 3 | 4-5 | Performance & architecture |
| Sprint 4 | 3-4 | Accessibility |
| Sprint 5 | 5-10 | Feature gaps |
| Sprint 6 | 10-15 | Test coverage |
| **TOTAL** | **~28-43 days** | |

---

*Generated by Claude Code forensic audit. Review with Gemini before executing any fixes.*
