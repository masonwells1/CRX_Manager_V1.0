# Business Logic Fixes Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix 9 verified business logic issues discovered during production audit — 2 CRITICAL SQL bugs, 2 HIGH SQL bugs, 2 HIGH TSX/TS bugs, and 3 MEDIUM bugs.

**Architecture:** All SQL fixes are new migrations that CREATE OR REPLACE the affected functions. TSX fixes are surgical edits to existing pages. Each task is independently deployable and testable.

**Tech Stack:** PostgreSQL (PL/pgSQL), Supabase RPCs, React 18, TypeScript, Vitest

---

## Audit Review Summary

| Original # | Issue | Verified? | Disposition |
|------------|-------|-----------|-------------|
| #1 | complete_delivery inventory drift | Already fixed in migration `20260309210000` | SKIP |
| #2 | Holds never released on quote accept | CONFIRMED | Task 1 |
| #3 | check_period_open() never called | CONFIRMED | Task 2 |
| #4 | Commission % not validated server-side | CONFIRMED | Task 3 |
| #5 | Quick delivery bypasses inventory | CONFIRMED | Task 4 |
| #6 | Missing checkMutationResult() | CONFIRMED (13 pages) | Task 5 |
| #7 | Offline sync no conflict resolution | CONFIRMED | Task 6 |
| #8 | Hardcoded email recipients | NOT FOUND — dynamic DB lookup | SKIP |
| #9 | Deprecated order columns | FALSE POSITIVE — Reports uses RPC fields | SKIP |
| #10 | Realtime null-filter bug | CONFIRMED | Task 7 |
| #11 | Double-click race | Already protected via loading/disabled | SKIP |
| #12 | totalOnFloor double-count | CONFIRMED | Task 8 |

---

## Task 1: Release Inventory Holds on Quote Acceptance (CRITICAL)

**Problem:** `convert_quote_to_order()` pre-books inventory but never releases the corresponding `inventory_holds`. The release trigger uses wrong column name (`quote_id` instead of `source_id`) and only fires for declined/expired, not accepted.

**Files:**
- Create: `supabase/migrations/20260312200000_fix_hold_release_and_period_enforcement.sql`
- Test: E2E — verify hold release after quote conversion

**Step 1: Write the migration — fix trigger function**

The trigger `release_holds_on_quote_status_change()` has two bugs:
1. Uses `quote_id` (doesn't exist) instead of `source_id`
2. Only fires for declined/expired, not accepted

```sql
-- Fix 1: Inventory hold release trigger
CREATE OR REPLACE FUNCTION public.release_holds_on_quote_status_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- Release holds when quote is accepted, declined, or expired
  -- (accepted quotes convert to orders with their own prebook;
  --  declined/expired quotes just free the inventory)
  IF NEW.status IN ('accepted', 'declined', 'expired')
     AND OLD.status NOT IN ('accepted', 'declined', 'expired') THEN

    UPDATE public.inventory_holds
    SET is_active = false, updated_at = now()
    WHERE source_id = NEW.id AND is_active = true;

    -- Log inventory adjustments for released holds
    INSERT INTO public.activity_log (entity_type, entity_id, action, details, performed_by)
    SELECT 'inventory_hold', ih.id, 'hold_released',
           jsonb_build_object(
             'reason', 'quote_status_change',
             'new_status', NEW.status,
             'product_id', ih.product_id,
             'quantity', ih.quantity_held
           ),
           COALESCE(NEW.updated_by, NEW.created_by)
    FROM public.inventory_holds ih
    WHERE ih.source_id = NEW.id AND ih.is_active = false
      AND ih.updated_at >= now() - interval '5 seconds';
  END IF;

  RETURN NEW;
END;
$$;
```

**Step 2: Also add hold release inside convert_quote_to_order()**

Add this block right after the inventory pre-booking loop (after line ~728 of current function):

```sql
-- Release any inventory holds tied to this quote (now superseded by order prebook)
UPDATE public.inventory_holds
SET is_active = false, updated_at = now()
WHERE source_id = p_quote_id AND is_active = true;
```

This goes inside the `convert_quote_to_order()` function body, after the prebook loop.

**Step 3: Run migration locally**

```bash
npx supabase migration up --local
```

**Step 4: Write E2E test**

Create test in existing E2E suite that:
1. Creates a quote with inventory holds
2. Converts quote to order via `convert_quote_to_order()`
3. Asserts `inventory_holds` for that quote are `is_active = false`

**Step 5: Commit**

```bash
git add supabase/migrations/20260312200000_fix_hold_release_and_period_enforcement.sql
git commit -m "fix(critical): release inventory holds on quote acceptance

- Fix trigger column name: quote_id → source_id
- Fire trigger on accepted status (not just declined/expired)
- Also release holds inside convert_quote_to_order() directly"
```

---

## Task 2: Wire check_period_open() Into Financial RPCs (CRITICAL)

**Problem:** `check_period_open()` exists but is never called. Users can post invoices, record payments, and void invoices in closed accounting periods.

**Files:**
- Modify: Same migration file from Task 1 (or new migration if Task 1 already applied)
- Affected RPCs: `post_invoice()`, `record_invoice_payment()`, `void_invoice()`, `apply_prepay_to_invoice()`, `apply_write_off()`, `allocate_payment()`, `batch_post_invoices()`, `batch_void_invoices()`, `issue_return_credit()`

**Step 1: Add period enforcement to each financial RPC**

Add this line near the top of each function, right after parameter validation:

```sql
-- Enforce accounting period (raises exception if period is closed)
PERFORM public.check_period_open(v_invoice_date::date);
```

For payment-based RPCs, use the payment date:
```sql
PERFORM public.check_period_open(CURRENT_DATE);
```

**RPCs to modify (add PERFORM check_period_open):**

| RPC | Date to check | Location in function |
|-----|---------------|---------------------|
| `post_invoice()` | `v_invoice.invoice_date` | After invoice lookup |
| `void_invoice()` | `CURRENT_DATE` | After invoice lookup |
| `record_invoice_payment()` | `p_payment_date` or `CURRENT_DATE` | After param validation |
| `apply_prepay_to_invoice()` | `CURRENT_DATE` | After param validation |
| `apply_write_off()` | `CURRENT_DATE` | After param validation |
| `allocate_payment()` | `CURRENT_DATE` | After param validation |
| `batch_post_invoices()` | Each invoice's date (inside loop) | Inside batch loop |
| `batch_void_invoices()` | `CURRENT_DATE` | Before loop |
| `issue_return_credit()` | `CURRENT_DATE` | After param validation |

**Step 2: Write the migration with all RPC updates**

Each RPC gets `CREATE OR REPLACE FUNCTION` with the added `PERFORM check_period_open(...)` line. The rest of each function body stays identical.

**Step 3: Write unit test**

```sql
-- Test: inserting a closed period then calling post_invoice should fail
INSERT INTO accounting_periods (period_start, period_end, status)
VALUES ('2026-01-01', '2026-01-31', 'closed');

-- This should raise an exception
SELECT post_invoice('some-invoice-id');
-- Expected: ERROR: Date 2026-01-15 falls in closed accounting period
```

**Step 4: Run migration and verify**

```bash
npx supabase migration up --local
```

**Step 5: Commit**

```bash
git commit -m "fix(critical): wire check_period_open into all financial RPCs

Prevents posting invoices, recording payments, voiding invoices,
and other financial operations in closed accounting periods."
```

---

## Task 3: Add Server-Side Commission Validation (HIGH)

**Problem:** `save_customer()` accepts commission splits without validating they sum to 100%. `validateCommissionSplits()` exists in `src/lib/quoteCalc.ts` but is only used in tests.

**Files:**
- Modify: Migration file (new) — add validation to `save_customer()` and commission-creation RPCs
- Test: Unit test for invalid splits

**Step 1: Write migration adding validation**

Add validation block inside `save_customer()`, before the UPDATE:

```sql
-- Validate commission splits sum to 100%
IF p_customer_payload ? 'default_commission_split'
   AND jsonb_array_length(p_customer_payload->'default_commission_split') > 0 THEN
  DECLARE
    v_split_total numeric;
  BEGIN
    SELECT COALESCE(SUM((elem->>'percentage')::numeric), 0)
    INTO v_split_total
    FROM jsonb_array_elements(p_customer_payload->'default_commission_split') elem;

    IF ABS(v_split_total - 100) > 0.01 THEN
      RAISE EXCEPTION 'Commission splits must sum to 100%% (got %.2f%%)', v_split_total;
    END IF;
  END;
END IF;
```

Also add the same check inside `create_quick_delivery()` before it creates commission records.

**Step 2: Run migration**

**Step 3: Write test verifying invalid splits are rejected**

**Step 4: Commit**

```bash
git commit -m "fix(high): add server-side commission split validation

Validates commission percentages sum to 100% in save_customer()
and create_quick_delivery() RPCs. Client-side validation was
bypassable."
```

---

## Task 4: Add Inventory Pre-Check to create_quick_delivery() (HIGH)

**Problem:** `create_quick_delivery()` creates delivery items without checking inventory availability. If stock is insufficient, the delivery is scheduled but will fail at completion time.

**Files:**
- Modify: Migration file — add inventory check to `create_quick_delivery()`

**Step 1: Write migration adding inventory pre-check**

Add this block inside `create_quick_delivery()`, inside the item loop, right after product lookup:

```sql
-- Lock and check inventory availability
SELECT * INTO v_inv
FROM inventory
WHERE product_id = v_product.id AND location = 'Main Warehouse'
FOR UPDATE;

IF NOT FOUND OR v_inv.quantity_available < v_item_qty THEN
  RAISE EXCEPTION 'Insufficient inventory for %: need % units, only % available',
    v_product.product_name,
    v_item_qty,
    COALESCE(v_inv.quantity_available, 0);
END IF;
```

This matches the pattern used in `complete_delivery()` (migration `20260309210000`, lines 69-76).

**Step 2: Run migration**

**Step 3: Write test — attempt quick delivery with 0 inventory**

**Step 4: Commit**

```bash
git commit -m "fix(high): add inventory pre-check to create_quick_delivery

Prevents creating deliveries for products with insufficient stock.
Matches the validation pattern used in complete_delivery()."
```

---

## Task 5: Add Missing checkMutationResult() Calls (HIGH)

**Problem:** 13 pages call `.update()` or `.delete()` without `checkMutationResult()`, allowing silent RLS failures to go undetected.

**Files to modify (each gets checkMutationResult added after the mutation):**

| # | File | Line(s) | Operation |
|---|------|---------|-----------|
| 1 | `src/pages/Customers.tsx` | ~154 | `.update({ is_active: false })` in handleDeactivate |
| 2 | `src/pages/DeliveryDetail.tsx` | ~519 | `.update({ signature_url })` in completion |
| 3 | `src/pages/Invoices.tsx` | ~301 | `.update({ deleted_at })` in handleBatchDelete |
| 4 | `src/pages/Jobs.tsx` | ~208 | `.update({ deleted_at })` in handleDelete |
| 5 | `src/pages/Products.tsx` | ~173 | `.update({ is_active: false })` in handleDeactivate |
| 6 | `src/pages/Products.tsx` | ~320 | `.update({ ...fields })` in inline edit |
| 7 | `src/pages/PurchaseOrders.tsx` | ~182 | `.update({ status: 'cancelled' })` in handleCancel |
| 8 | `src/pages/Quotes.tsx` | ~149 | `.update({ deleted_at })` in handleDelete |
| 9 | `src/pages/QuoteBuilder.tsx` | ~813 | `.update({ status: 'sent' })` fallback |
| 10 | `src/pages/BlendRecipes.tsx` | ~199 | `.delete()` on blend_recipe_items |
| 11 | `src/pages/Fields.tsx` | ~118 | `.delete().in('id', ids)` |
| 12 | `src/pages/Orders.tsx` | ~161 | `.delete()` — error-only check |
| 13 | `src/pages/Vehicles.tsx` | ~114 | `.delete()` — error-only check |

**Pattern for each fix:**

Before (typical):
```typescript
const { error } = await supabase.from('table').update({ ... }).eq('id', id);
if (error) throw error;
```

After:
```typescript
const result = await supabase.from('table').update({ ... }).eq('id', id).select();
checkMutationResult(result, 'Update table');
```

**Step 1:** Fix pages 1-4 (Customers, DeliveryDetail, Invoices, Jobs)

**Step 2:** Fix pages 5-8 (Products x2, PurchaseOrders, Quotes)

**Step 3:** Fix pages 9-13 (QuoteBuilder, BlendRecipes, Fields, Orders, Vehicles)

**Step 4:** Run full test suite

```bash
npx vitest run
```

**Step 5:** Commit

```bash
git commit -m "fix(high): add checkMutationResult to 13 pages

Catches silent RLS failures on .update() and .delete() calls.
Previously these operations would appear to succeed even if
RLS policies denied the mutation."
```

---

## Task 6: Add Offline Sync Conflict Detection (HIGH)

**Problem:** `offlineSync.ts` blindly replays queued operations without checking if server data changed while offline. Can silently overwrite other users' changes.

**Files:**
- Modify: `src/lib/offlineSync.ts`
- Modify: `src/lib/offlineQueue.ts` (add `snapshotAt` field)

**Step 1: Add timestamp capture to offline queue**

When queuing an action, capture `updated_at` of the target entity:

```typescript
interface PendingAction {
  // ... existing fields ...
  snapshotAt?: string; // ISO timestamp of entity's updated_at when queued
  entityTable?: string; // e.g. 'deliveries', 'orders'
  entityId?: string; // primary key of the entity
}
```

**Step 2: Add pre-flight conflict check in executeAction()**

Before executing the RPC, check if the entity was modified since we queued:

```typescript
async function executeAction(action: PendingAction): Promise<void> {
  // Conflict detection: check if entity was modified while we were offline
  if (action.snapshotAt && action.entityTable && action.entityId) {
    const { data } = await supabase
      .from(action.entityTable)
      .select('updated_at')
      .eq('id', action.entityId)
      .single();

    if (data && new Date(data.updated_at) > new Date(action.snapshotAt)) {
      throw new Error(
        `Conflict: ${action.entityTable} ${action.entityId} was modified ` +
        `while offline (server: ${data.updated_at}, queued: ${action.snapshotAt}). ` +
        `Skipping to prevent data loss.`
      );
    }
  }

  // ... existing RPC execution ...
}
```

**Step 3: Surface conflicts to the user**

In `syncPendingActions()`, collect conflict errors and return them so the UI can show a toast:

```typescript
return { synced, failed, cleaned, conflicts: conflictErrors };
```

**Step 4: Write unit tests for conflict detection**

**Step 5: Commit**

```bash
git commit -m "fix(high): add conflict detection to offline sync

Checks entity updated_at before replaying offline operations.
Prevents silent overwrites when server data changed while offline."
```

---

## Task 7: Fix Realtime Null-Filter Bug (MEDIUM)

**Problem:** `useRealtimeSubscription` passes `undefined` filter to Supabase when `noteId` is null, subscribing to ALL changes in the table instead of none.

**File:** `src/hooks/useRealtimeSubscription.ts`

**Step 1: Add early return when filter is required but missing**

```typescript
// In useRealtimeSubscription, line 30:
useEffect(() => {
  // Don't subscribe if filter is explicitly undefined (e.g., noteId is null)
  // This prevents subscribing to ALL changes in the table
  if (config.filter === undefined && config.table !== 'team_notes' && config.table !== 'notifications') {
    return;
  }
  // ... rest of subscription setup
```

Better approach — add a `disabled` flag:

```typescript
interface SubscriptionConfig {
  table: string;
  event?: 'INSERT' | 'UPDATE' | 'DELETE' | '*';
  filter?: string;
  disabled?: boolean; // Skip subscription when true
  // ... callbacks
}
```

Then in the callers:
```typescript
// useRealtimeComments
useRealtimeSubscription({
  table: 'team_note_comments',
  filter: noteId ? `note_id=eq.${noteId}` : undefined,
  disabled: !noteId,  // Don't subscribe until we have a noteId
  onChange: onCommentsChange,
});
```

**Step 2: Update useEffect to check disabled flag**

```typescript
useEffect(() => {
  if (config.disabled) return; // Skip when disabled

  let channel: RealtimeChannel;
  // ... existing setup code
```

**Step 3: Update all callers (useRealtimeComments, useRealtimeActivity)**

**Step 4: Write unit test**

**Step 5: Commit**

```bash
git commit -m "fix(medium): prevent null-filter realtime subscriptions

Adds 'disabled' flag to useRealtimeSubscription. When noteId
is null, subscription is skipped instead of subscribing to
all changes in the table."
```

---

## Task 8: Fix InventoryPage totalOnFloor Double-Count (MEDIUM)

**Problem:** `InventoryPage.tsx:211` calculates `totalOnFloor = quantity_available + quantity_prebooked`, which inflates the "on floor" number. Then line 213 subtracts `quantity_prebooked` again in `freeQty`, double-counting.

**File:** `src/pages/InventoryPage.tsx:211-213`

**Step 1: Fix the formula**

Before:
```typescript
const totalOnFloor = item.quantity_available + item.quantity_prebooked;
const plannedQty = (holdsByProduct[item.product_id] || 0) + (plannedByProduct[item.product_id] || 0);
const freeQty = onOrderQty + totalOnFloor - plannedQty - item.quantity_prebooked;
```

After:
```typescript
const totalOnFloor = item.quantity_available + item.quantity_prebooked;
const plannedQty = (holdsByProduct[item.product_id] || 0) + (plannedByProduct[item.product_id] || 0);
const freeQty = onOrderQty + item.quantity_available - plannedQty;
```

**Explanation:** `freeQty` = incoming (on order) + available (not committed) - planned outgoing. The prebooked quantity is already committed to existing orders, so it should not be in the "free" calculation.

`totalOnFloor` stays as-is because it genuinely represents everything physically in the warehouse (available + prebooked). The fix is only to `freeQty`.

**Step 2: Update any tests referencing freeQty**

**Step 3: Run tests**

```bash
npx vitest run --reporter verbose 2>&1 | grep -i inventory
```

**Step 4: Commit**

```bash
git commit -m "fix(medium): correct freeQty formula in InventoryPage

freeQty was double-subtracting quantity_prebooked. Now correctly
calculates: onOrder + available - planned (excluding prebooked
which is already committed)."
```

---

## Execution Order

| Order | Task | Severity | Type | Est. Lines Changed |
|-------|------|----------|------|--------------------|
| 1 | Task 1: Hold release fix | CRITICAL | SQL migration | ~40 |
| 2 | Task 2: Period enforcement | CRITICAL | SQL migration | ~100 |
| 3 | Task 3: Commission validation | HIGH | SQL migration | ~25 |
| 4 | Task 4: Quick delivery inventory | HIGH | SQL migration | ~15 |
| 5 | Task 8: totalOnFloor fix | MEDIUM | TSX (1 line) | ~1 |
| 6 | Task 7: Realtime null-filter | MEDIUM | TSX/TS | ~15 |
| 7 | Task 5: checkMutationResult | HIGH | TSX (13 files) | ~50 |
| 8 | Task 6: Offline conflict detection | HIGH | TS | ~40 |

**Rationale:** SQL migrations first (Tasks 1-4) because they fix data integrity issues. Then quick TSX fixes (Tasks 8, 7). Then the two larger TSX tasks (Tasks 5, 6) which are mechanical but touch many files.

**After all tasks:** Run full test suite (`npx vitest run`) and build (`npm run build`) to verify no regressions.

---

## Verification Plan

After all fixes are deployed:

1. **Hold Release:** Create quote with hold → convert to order → verify holds are `is_active = false`
2. **Period Enforcement:** Close a period → attempt to post invoice in that period → verify it's blocked
3. **Commission Validation:** Try saving customer with splits summing to 95% → verify rejection
4. **Quick Delivery Inventory:** Try quick delivery with 0 stock → verify error message
5. **checkMutationResult:** Temporarily revoke RLS permission → attempt update → verify error shown
6. **Offline Conflict:** Queue offline action → modify entity on server → go online → verify conflict detected
7. **Realtime:** Open team notes with no note selected → verify no subscription created
8. **totalOnFloor:** Compare freeQty calculation with manual math on known inventory
