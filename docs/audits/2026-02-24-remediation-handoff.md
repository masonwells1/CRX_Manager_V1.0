# CRX Manager V1.0 — Remediation Handoff for Claude Code

**Context:** A deep audit of this codebase found 33 issues across crash prevention, silent data loss, error handling, security, data integrity, performance, and test coverage. This file is your task list. Work through the sprints in order — Sprint 1 is the most critical.

**Rules:**
- Read `CLAUDE.md` first for architecture rules, project structure, and patterns
- Read `RISK_AUDIT_HANDOFF.md` for the full audit report with detailed explanations
- Always read the file before editing — line numbers may have shifted from prior fixes
- Run `npm run build` and `npx vitest run` after each sprint to verify nothing broke
- Commit after each sprint with a descriptive message
- Do NOT add unnecessary comments, docstrings, or refactoring beyond what's specified
- Do NOT modify database migrations or RLS policies — this is frontend-only work
- Import `checkMutationResult` from `'../lib/db'` (already exported)
- Import `generateIdempotencyKey` from `'../lib/idempotency'` (already exported)
- The existing pattern for toast errors is: `toast.error('Message')` — follow the same style used in each file

---

## Sprint 1 — Crash Prevention & Silent Data Loss

### Task 1.1: Fix `convertToGlLb()` null crash
- **File:** `src/lib/quoteCalc.ts`
- **Action:** Find the `convertToGlLb()` function. Add a null/undefined guard for the `unit` parameter at the top of the function: `if (!unit) return quantity;`
- **Why:** `.toUpperCase()` on null/undefined throws TypeError

### Task 1.2: Add `checkMutationResult()` to all unprotected mutations
- **Action:** For each file below, find every `.update()` and `.delete()` call that doesn't already use `checkMutationResult()`. Ensure each mutation has `.select()` appended, capture the result, and pass it to `checkMutationResult(result, 'Description of operation')`.
- **Pattern to follow:** Look at `src/pages/VehicleDetail.tsx` or `src/pages/BlendTicketDetail.tsx` (the approve/reject blocks around line 256-289) for the correct pattern — they already do it right.

**Files to fix (each file has the import `{ supabase }` from `'../lib/db'` — add `checkMutationResult` to that import):**

1. `src/pages/OrderDetail.tsx` — order status update
2. `src/pages/QuoteBuilder.tsx` — quote status changes (search for `.update(` calls)
3. `src/pages/ProductDetail.tsx` — product save and cost update
4. `src/pages/Products.tsx` — bulk product update
5. `src/pages/BlendRecipes.tsx` — recipe update, item operations, soft delete
6. `src/pages/Compliance.tsx` — compliance data update
7. `src/pages/CropPrograms.tsx` — settings update
8. `src/pages/CycleCounts.tsx` — cycle count updates
9. `src/pages/DeliveryDetail.tsx` — signature URL update
10. `src/pages/InventoryPage.tsx` — inventory hold update
11. `src/pages/Notifications.tsx` — mark as read (both single and bulk)
12. `src/pages/Rebates.tsx` — rebate program and claim updates
13. `src/pages/Reports.tsx` — mark commissions as paid
14. `src/pages/Returns.tsx` — reject return
15. `src/pages/TeamBoard.tsx` — all team note mutations (update, soft delete, complete toggle, pin toggle)

### Task 1.3: Fix batch invoice PDF popup blocker issue
- **File:** `src/lib/invoicePdf.ts`
- **Action:** Find `generateBatchInvoicePdf()` (near the bottom of the file). It currently loops and calls `doc.save()` for each invoice separately. Refactor to use a single `jsPDF` document — call `doc.addPage()` between invoices and `doc.save()` once at the end.
- **Reference:** Look at `generateBatchDeliveryPdf()` in `src/lib/deliveryPdf.ts` for the correct multi-page pattern.

---

## Sprint 2 — Error Handling & User Feedback

### Task 2.1: Fix `.then()` chains with missing error handling
- **Files and actions:**
  1. `src/pages/ProductDetail.tsx` — find the unit conversions fetch (around line 77-79). Add error checking — if `error`, show a toast.
  2. `src/pages/Reports.tsx` — find the product options fetch (around line 148-151). Add error checking.
  3. `src/pages/Deliveries.tsx` — find the unassigned deliveries fetch (around line 124-140). Add error checking.
- **Pattern:** Convert `.then(({ data }) => ...)` to include `({ data, error }) => { if (error) { toast.error('Failed to load ...'); return; } ... }`

### Task 2.2: Fix `Promise.all()` partial failure handling
- **Files and actions:**
  1. `src/pages/InventoryPage.tsx` — find the `Promise.all()` that fetches holds, PO items, and quote data (around line 125-127). After the `Promise.all()`, check each response's `.error` property individually. If any fail, show a toast and skip setting that piece of state.
  2. `src/pages/BlendTicketDetail.tsx` — find the data loading function (around line 94-189). There are ~7 queries — 5 check errors, 2 don't. Find the 2 that don't and add error checks.

### Task 2.3: Replace empty/console-only catch blocks with user-visible errors
- **Files and actions:**
  1. `src/pages/BlendTicketDetail.tsx` — find the catch block around `loadTicketData`. If it only has `console.error`, add `toast.error('Failed to load ticket data')`.
  2. `src/pages/MonthEndClose.tsx` — find the year-end summary generation loop (around line 209-211). If it silently `continue`s on error, add a counter of failed customers and show a toast at the end: `toast.error('Failed to generate summaries for X customers')`.
  3. `src/pages/QuoteBuilder.tsx` — find the bare `catch {}` block (around line 680-686). Replace with `catch (err) { console.error('Failed to revert quote status:', err); toast.error('Failed to update quote status'); }`.

### Task 2.4: Stop replacing valid data with empty array on error
- **Files and actions:**
  1. `src/pages/CycleCounts.tsx` — find the data fetch (around line 183-192). After showing the error toast, do NOT call `setCycleCounts(data || [])` — instead `return` early so existing state is preserved.
  2. `src/pages/ARaging.tsx` — same pattern at lines 73-79 and 103-114. On error, return early instead of setting state to empty.

### Task 2.5: Fix duplicate delivery guard
- **File:** `src/pages/NewDelivery.tsx`
- **Action:** Find the duplicate delivery check query (around line 192-200). Change the destructure from `{ data: existingDels }` to `{ data: existingDels, error: dupeCheckError }`. Add: `if (dupeCheckError) { toast.error('Failed to check for existing deliveries'); return; }`

---

## Sprint 3 — Security & Permissions Hardening

### Task 3.1: Change pagePermissions default from fail-open to fail-closed
- **File:** `src/lib/pagePermissions.ts`
- **Action:** Find the line `if (!page) return true;` (around line 94). Change to `if (!page) return false;`. Then verify that every route in `src/App.tsx` has a corresponding entry in the permissions map. If any are missing, add them with appropriate role access.

### Task 3.2: Switch edge function call to Supabase client
- **File:** `src/pages/SettingsPage.tsx`
- **Action:** Find the `fetch()` call to the create-user edge function (around line 233-240). Replace with:
  ```typescript
  const { data, error } = await supabase.functions.invoke('create-user', {
    body: { /* same body as current fetch */ }
  });
  ```
  Remove the manual `apikey` and `Authorization` header construction.

---

## Sprint 4 — Data Integrity & Idempotency

### Task 4.1: Add idempotency keys to critical mutations
- **Action:** For each file below, add `generateIdempotencyKey()` to the mutation. The pattern is:
  1. Import `generateIdempotencyKey` from `'../lib/idempotency'`
  2. Generate key before the mutation: `const idempotencyKey = generateIdempotencyKey('entity-action', entityId);`
  3. Add to the mutation body or use as a deduplication check
  4. Also disable the submit button while saving (`setSaving(true)` / `setSaving(false)`)

**Priority files (HIGH — do these):**
1. `src/pages/OrderDetail.tsx` — order status change
2. `src/pages/ProductDetail.tsx` — product save and cost update
3. `src/pages/InventoryPage.tsx` — inventory hold update

**Secondary files (MEDIUM — do these if time allows):**
4. `src/pages/BlendTicketDetail.tsx` — ticket approve/reject
5. `src/pages/Products.tsx` — bulk product update
6. `src/pages/CycleCounts.tsx` — cycle count updates

### Task 4.2: Fix timezone-naive date comparison
- **File:** `src/pages/TeamBoard.tsx`
- **Action:** Find the overdue detection code (around line 482-483). It compares `new Date(n.due_date)` against `new Date()`. Fix by comparing date strings instead:
  ```typescript
  const todayStr = new Date().toISOString().split('T')[0];
  const overdue = open.filter(n => n.due_date && n.due_date < todayStr);
  ```

### Task 4.3: Fix N+1 query in batch invoice print
- **File:** `src/pages/Invoices.tsx`
- **Action:** Find the batch print function (around line 194-272). It loops over selected invoices and makes 3 queries per invoice. Refactor to:
  1. Collect all selected invoice IDs
  2. Batch-fetch all customers, invoice items, and grower shares with `.in('invoice_id', ids)` or `.in('id', customerIds)`
  3. Build a lookup map, then loop to generate PDFs

### Task 4.4: Fix N+1 query in commission payment list
- **File:** `src/pages/CommissionPayments.tsx`
- **Action:** Find the item count fetch loop (around line 89-101). Replace with a single query that gets counts for all payments, or join the count in the initial fetch.

---

## Sprint 5 — Test Coverage

### Task 5.1: Add PDF generation tests for untested modules
- **File to create:** `src/lib/__tests__/pdfGeneration2.test.ts` (or add to existing `pdfGeneration.test.ts`)
- **Action:** Add tests for `statementPdf.ts`, `yearEndSummaryPdf.ts`, and `quotePdf.ts`. Follow the exact same jsPDF mock pattern used in the existing `pdfGeneration.test.ts`. Test cases for each:
  1. Valid input generates without throwing
  2. Empty data array generates without throwing
  3. Null/undefined optional fields don't crash

---

## Sprint 6 — Performance & Polish

### Task 6.1: Fix useEffect dependency causing unnecessary refetches
- **File:** `src/pages/Deliveries.tsx`
- **Action:** Find the useEffect for unassigned deliveries (around line 122-140). Remove `deliveries` from the dependency array — it causes refetching every time the main delivery list updates.

---

## Verification

After all sprints are complete, run:
```bash
npm run build
npx vitest run
```

Both must pass with zero errors. The build will have a warning about the mapbox chunk being >500KB — that's expected and fine.
