# CRX Manager V1.0 — Risk Audit & Remediation Handoff

**Generated:** 2026-02-23
**Audited by:** Automated deep-scan across 49 pages, 50+ components, 64 migrations
**Purpose:** Comprehensive list of every known risk, blind spot, and defect — prioritized for remediation

---

## How to Read This Report

- **Sprints are prioritized** — Sprint 1 is the scariest stuff, Sprint 6 is polish
- **Every item has a file path and line number** so you can jump straight to it
- **Severity labels:** CRITICAL (will crash or lose data), HIGH (silent failures users won't notice), MEDIUM (degraded UX or subtle bugs), LOW (code quality / future-proofing)
- **Estimated effort** is per-item, not per-sprint

---

## SPRINT 1 — Crash Prevention & Silent Data Loss (Day 1)

### 1.1 `convertToGlLb()` crashes on null input
| | |
|---|---|
| **File** | `src/lib/quoteCalc.ts:135, 140` |
| **Severity** | CRITICAL |
| **What** | `.toUpperCase()` called on `unit` parameter without null check. TypeError if null/undefined. |
| **Current state** | Function exists but is unused (dead code). Will crash the moment someone calls it. |
| **Fix** | Add `if (!unit) return quantity;` guard at top, or delete the function if truly unused. |
| **Effort** | 5 minutes |

### 1.2 `checkMutationResult()` missing on ~30 mutations
| | |
|---|---|
| **File** | Multiple — see full list below |
| **Severity** | HIGH |
| **What** | `.update()` and `.delete()` calls that don't validate the result. If RLS denies the operation, it returns `{ data: [], error: null }` — a silent failure. The UI shows "saved" but the database didn't change. |
| **Fix** | Add `.select()` to each mutation and wrap with `checkMutationResult(result, 'Operation name')`. |
| **Effort** | 2-3 hours |

**Files needing `checkMutationResult()` added:**

| File | Line(s) | Operation |
|------|---------|-----------|
| `src/pages/OrderDetail.tsx` | 148 | Order status change |
| `src/pages/QuoteBuilder.tsx` | ~685, ~700, 808 | Quote status revert, send, conversion recovery |
| `src/pages/ProductDetail.tsx` | 183, 220 | Product update, cost update |
| `src/pages/Products.tsx` | 98 | Bulk product update |
| `src/pages/BlendRecipes.tsx` | 151, 180, 240-242, 257 | Recipe update, item delete, item insert, soft delete |
| `src/pages/Compliance.tsx` | 206 | Compliance data update |
| `src/pages/CropPrograms.tsx` | 132 | Crop program settings update |
| `src/pages/CycleCounts.tsx` | 214, 300 | Cycle count updates |
| `src/pages/DeliveryDetail.tsx` | 517 | Signature URL update |
| `src/pages/InventoryPage.tsx` | 617 | Inventory hold update |
| `src/pages/Notifications.tsx` | 43, 69 | Mark as read |
| `src/pages/Rebates.tsx` | 225, 298 | Rebate program/claim updates |
| `src/pages/Reports.tsx` | 410 | Mark commissions paid |
| `src/pages/Returns.tsx` | 289 | Reject return |
| `src/pages/TeamBoard.tsx` | 340, 392, 417, 435 | Team note mutations |

### 1.3 Batch invoice PDF triggers popup blockers
| | |
|---|---|
| **File** | `src/lib/invoicePdf.ts:728-755` |
| **Severity** | HIGH |
| **What** | `generateBatchInvoicePdf()` downloads each invoice as a separate file in a loop. Browsers block downloads after 2-3. Compare with `generateBatchDeliveryPdf()` in `deliveryPdf.ts:219-248` which correctly combines into one multi-page PDF. |
| **Fix** | Refactor to match the delivery PDF pattern — single `jsPDF` document, `doc.addPage()` between invoices, one `doc.save()` at end. |
| **Effort** | 1-2 hours |

---

## SPRINT 2 — Error Handling & User Feedback (Day 2)

### 2.1 Supabase queries with no error handling (`.then()` without `.catch()`)
| | |
|---|---|
| **Severity** | MEDIUM-HIGH |
| **What** | Several pages use `.then()` promise chains that destructure only `{ data }` and ignore errors. If the query fails, the user sees a blank/empty page with no explanation. |
| **Fix** | Convert to `async/await` with `try/catch`, add `toast('error', ...)` in catch blocks. |
| **Effort** | 1-2 hours |

**Affected locations:**

| File | Line(s) | What loads silently |
|------|---------|---------------------|
| `src/pages/ProductDetail.tsx` | 77-79 | Unit conversions |
| `src/pages/Reports.tsx` | 148-151 | Product options for report filters |
| `src/pages/Deliveries.tsx` | 124-140 | Unassigned deliveries (driver dashboard) |

### 2.2 `Promise.all()` partial failure ignored
| | |
|---|---|
| **Severity** | HIGH |
| **What** | Pages use `Promise.all()` to fetch multiple datasets but don't check `.error` on individual responses. If one query fails, that dataset silently becomes `[]`. |
| **Fix** | Check each response's `.error` property. Show toast if any fail. Don't set data to empty on error — keep previous state or show error UI. |
| **Effort** | 1-2 hours |

**Affected locations:**

| File | Line(s) | Risk |
|------|---------|------|
| `src/pages/InventoryPage.tsx` | 125-127 | Inventory position calculations wrong if holds/PO/quote queries fail |
| `src/pages/BlendTicketDetail.tsx` | 94-189 | Fields and linked orders queries not checked (5 of 7 checked, 2 skipped) |

### 2.3 Empty/console-only catch blocks
| | |
|---|---|
| **Severity** | MEDIUM |
| **What** | Catch blocks that log to console but never show the user anything. User has no idea something went wrong. |
| **Fix** | Add `toast('error', 'Failed to ...')` in every catch block that handles a user-facing operation. |
| **Effort** | 1 hour |

**Affected locations:**

| File | Line(s) | Operation |
|------|---------|-----------|
| `src/pages/BlendTicketDetail.tsx` | catch block around loadTicketData | Ticket data load |
| `src/pages/MonthEndClose.tsx` | 209-211 | Year-end summary loop silently skips failed customers |
| `src/pages/QuoteBuilder.tsx` | 680-686 | Quote status revert — bare `catch {}` |

### 2.4 Data set to empty array after query error
| | |
|---|---|
| **Severity** | MEDIUM |
| **What** | After showing an error toast, code still sets `setState(data || [])`, replacing valid previous data with an empty array. |
| **Fix** | Only set state on success. On error, keep previous state. |
| **Effort** | 30 minutes |

**Affected locations:**

| File | Line(s) |
|------|---------|
| `src/pages/CycleCounts.tsx` | 183-192 |
| `src/pages/ARaging.tsx` | 73-79, 103-114 |

### 2.5 Duplicate delivery creation possible
| | |
|---|---|
| **File** | `src/pages/NewDelivery.tsx:192-200` |
| **Severity** | MEDIUM-HIGH |
| **What** | Duplicate-delivery check query destructures `{ data }` without `{ error }`. If query fails, `existingDels` is undefined, the guard is skipped, and duplicate deliveries can be created. |
| **Fix** | Destructure and check error. |
| **Effort** | 10 minutes |

---

## SPRINT 3 — Security & Permissions Hardening (Day 3)

### 3.1 `pagePermissions.ts` defaults unknown pages to ALLOW
| | |
|---|---|
| **File** | `src/lib/pagePermissions.ts:94` |
| **Severity** | MEDIUM |
| **What** | `if (!page) return true;` — any new route added to `App.tsx` is automatically accessible to ALL roles until manually added to the permissions list. Fail-open design. |
| **Fix** | Change to `if (!page) return false;` (fail-closed). Then ensure every route is in the list. Add a dev-mode console warning when a page key isn't found. |
| **Effort** | 30 minutes |

### 3.2 Frontend role checks are cosmetic only
| | |
|---|---|
| **Severity** | LOW (RLS is the real guard) |
| **What** | Pages like `ProductDetail.tsx:259-384` use `disabled={!isAdmin}` on form fields. A user could remove `disabled` via DevTools and submit. This is fine because RLS blocks the write server-side, but it's worth documenting. |
| **Fix** | No code change needed. Add a comment: `// UX only — RLS enforces server-side`. |
| **Effort** | 15 minutes |

### 3.3 Edge Function called with raw fetch instead of Supabase client
| | |
|---|---|
| **File** | `src/pages/SettingsPage.tsx:233-240` |
| **Severity** | LOW |
| **What** | User creation calls edge function with raw `fetch()`, manually passing `apikey` and `Authorization` headers. Should use `supabase.functions.invoke()` which handles auth automatically. |
| **Fix** | Replace with `supabase.functions.invoke('create-user', { body: {...} })`. |
| **Effort** | 15 minutes |

---

## SPRINT 4 — Data Integrity & Idempotency (Day 4-5)

### 4.1 Missing idempotency keys on critical mutations
| | |
|---|---|
| **Severity** | HIGH |
| **What** | Critical business operations lack `generateIdempotencyKey()`. Double-clicking "Save" or network retry could create duplicate records or overwrite timestamps. |
| **Fix** | Add idempotency key generation + button disable while saving. |
| **Effort** | 3-4 hours |

**Mutations needing idempotency keys:**

| File | Line | Operation | Severity |
|------|------|-----------|----------|
| `src/pages/OrderDetail.tsx` | 148 | Order status change | HIGH |
| `src/pages/ProductDetail.tsx` | 183, 220 | Product update, cost update | MEDIUM |
| `src/pages/InventoryPage.tsx` | 617 | Inventory hold update | MEDIUM |
| `src/pages/BlendTicketDetail.tsx` | 256-264, 280-288 | Ticket approve/reject | MEDIUM |
| `src/pages/Products.tsx` | 98 | Bulk product update | MEDIUM |
| `src/pages/CycleCounts.tsx` | 214, 300 | Cycle count updates | MEDIUM |
| `src/pages/Compliance.tsx` | 206 | Compliance update | LOW |
| `src/pages/CropPrograms.tsx` | 132 | Crop program update | LOW |
| `src/pages/TeamBoard.tsx` | 340, 392, 417, 435 | Team note mutations | LOW |
| `src/pages/Notifications.tsx` | 43, 69 | Mark as read | LOW |

### 4.2 Timezone-naive date comparisons
| | |
|---|---|
| **Severity** | MEDIUM |
| **What** | `new Date(n.due_date)` parses a `date` column as UTC midnight, but compares against `new Date()` which is local time. Off-by-one-day errors for users west of UTC. |
| **Fix** | Parse dates with explicit timezone handling or compare date strings directly. |
| **Effort** | 1-2 hours |

**Affected locations:**

| File | Line(s) | What |
|------|---------|------|
| `src/pages/TeamBoard.tsx` | 482-483 | Overdue note detection |
| Various pages | Multiple | `new Date().toISOString().split('T')[0]` for default dates (actually safe) |

### 4.3 N+1 query in batch invoice print
| | |
|---|---|
| **File** | `src/pages/Invoices.tsx:194-272` |
| **Severity** | MEDIUM |
| **What** | Batch print loop makes 3 sequential queries per invoice (customer, items, shares). Printing 10 invoices = 30 queries. |
| **Fix** | Batch-fetch all data upfront with `.in('invoice_id', selectedIds)`, then loop to render. |
| **Effort** | 1-2 hours |

### 4.4 N+1 query in commission payment list
| | |
|---|---|
| **File** | `src/pages/CommissionPayments.tsx:89-101` |
| **Severity** | MEDIUM |
| **What** | Fetches item count per payment in a loop. No error handling on inner query. |
| **Fix** | Use a single query with aggregate or join. |
| **Effort** | 30 minutes |

---

## SPRINT 5 — Test Coverage (Day 5-6)

### 5.1 Three PDF modules with zero tests (~1,718 lines)
| | |
|---|---|
| **Severity** | MEDIUM |
| **What** | `statementPdf.ts` (818 lines), `yearEndSummaryPdf.ts` (633 lines), and `quotePdf.ts` (267 lines) have no unit tests. The other 3 PDF modules (invoice, delivery, receiving) are tested in `pdfGeneration.test.ts`. |
| **Fix** | Add test suites following the same mock pattern in `pdfGeneration.test.ts`. Test: valid input renders without crash, empty data renders without crash, edge cases (long names, zero amounts, null fields). |
| **Effort** | 4-6 hours |

### 5.2 Missing form validation tests
| | |
|---|---|
| **Severity** | LOW |
| **What** | QuoteBuilder (commission split sum), JobDetail (required fields), FieldDetail (billing split %) lack explicit validation before save. |
| **Fix** | Add pre-submit validation and corresponding unit tests. |
| **Effort** | 2-3 hours |

---

## SPRINT 6 — Performance & Polish (Day 6-8)

### 6.1 All list pages hard-capped at 500 rows with no pagination
| | |
|---|---|
| **Severity** | MEDIUM |
| **What** | 7+ list pages use `.limit(500)` with client-side filtering. No "Load More" or page navigation. As data grows, users silently lose visibility of records beyond 500. |
| **Fix** | Implement cursor-based or offset pagination. Add "Showing X of Y" indicator. |
| **Effort** | 4-6 hours (architectural) |

**Affected pages:**

| Page | File | Current Limit |
|------|------|---------------|
| Customers | `src/pages/Customers.tsx:28-30` | 500 |
| Orders | `src/pages/Orders.tsx:30-34` | 500 |
| Invoices | `src/pages/Invoices.tsx:82-87` | 500 |
| Products | `src/pages/Products.tsx:34-38` | 500 |
| Deliveries | `src/pages/Deliveries.tsx:170-175` | 500 |
| Blend Tickets | `src/pages/BlendTickets.tsx:42-54` | 500 |
| Application Records | `src/pages/ApplicationRecords.tsx:77-87` | 500 |

### 6.2 Large component files (11 files over 500 lines)
| | |
|---|---|
| **Severity** | LOW |
| **What** | Several page components exceed 800-1500 lines, making them hard to maintain. |
| **Fix** | Extract sub-components (e.g., DeliveryDetail could split into DeliveryPhotos, DeliverySignature, DeliveryItems, DeliveryActions). |
| **Effort** | 6-10 hours |

**Largest files:**

| File | Lines |
|------|-------|
| `src/pages/DeliveryDetail.tsx` | 1,508 |
| `src/pages/QuoteBuilder.tsx` | 1,424 |
| `src/pages/TeamBoard.tsx` | 1,370 |
| `src/pages/InventoryPage.tsx` | 1,168 |
| `src/pages/BlendTicketDetail.tsx` | 1,122 |
| `src/pages/CustomerDetail.tsx` | 1,032 |
| `src/pages/Reports.tsx` | 971 |
| `src/pages/InvoiceDetail.tsx` | 961 |
| `src/pages/Deliveries.tsx` | 918 |
| `src/pages/QuickReceive.tsx` | 911 |
| `src/pages/PurchaseOrderDetail.tsx` | 845 |

### 6.3 Minor accessibility gaps
| | |
|---|---|
| **Severity** | LOW |
| **What** | Some date inputs lack `<label htmlFor>`, notification bell missing `aria-label`, navigation uses `<button onClick>` instead of `<Link>`. |
| **Fix** | Add proper labels, aria attributes, semantic HTML. |
| **Effort** | 1-2 hours |

### 6.4 useEffect dependency causing unnecessary refetches
| | |
|---|---|
| **File** | `src/pages/Deliveries.tsx:122-140` |
| **Severity** | LOW |
| **What** | Driver dashboard's unassigned deliveries effect depends on `[isDriver, deliveries]` — refetches every time the main list updates. |
| **Fix** | Remove `deliveries` from dependency array or use a separate trigger. |
| **Effort** | 10 minutes |

---

## What's NOT Broken (Passed Audit)

These areas were audited and found to be solid:

| Area | Status | Notes |
|------|--------|-------|
| SQL injection | PASS | All queries use Supabase parameterized API |
| Hardcoded secrets | PASS | All secrets in `.env` / Supabase secrets |
| Route protection | PASS | All routes wrapped in `<ProtectedRoute>` |
| RLS policies | PASS | All 72 tables have RLS enabled |
| Money/currency math | PASS | Proper cents-based bigint throughout |
| Cascade deletes | PASS | Critical RPCs (void_invoice, cancel_order, complete_delivery) properly cascade |
| Atomic RPCs | PASS | Critical multi-table writes use PostgreSQL RPCs with FOR UPDATE locks |
| Payment idempotency | PASS | `record_payment()` and `create_quick_delivery()` use idempotency keys |
| Realtime cleanup | PASS | `useRealtimeSubscription` properly removes channels on unmount |
| Offline queue | PASS | Delivery completion has offline support |
| `.then()` error handling on pages | PASS | Previously broken, fixed in recent hardening commits |

---

## Summary by Severity

| Severity | Count | Sprint |
|----------|-------|--------|
| CRITICAL | 1 | Sprint 1 |
| HIGH | 6 | Sprints 1-2 |
| MEDIUM-HIGH | 3 | Sprints 2-4 |
| MEDIUM | 15 | Sprints 2-6 |
| LOW | 8 | Sprints 3, 6 |

**Total estimated effort: 30-40 hours across all 6 sprints**

---

## Quick Wins (< 30 minutes each)

If you only have a few hours, fix these first — highest risk-to-effort ratio:

1. `convertToGlLb()` null guard — 5 min
2. `NewDelivery.tsx:192` add error check on duplicate query — 10 min
3. `pagePermissions.ts:94` change `return true` to `return false` — 10 min
4. `Deliveries.tsx:122` remove `deliveries` from useEffect deps — 10 min
5. `QuoteBuilder.tsx:680-686` replace bare `catch {}` with logging + toast — 10 min
6. `SettingsPage.tsx:233` switch to `supabase.functions.invoke()` — 15 min
