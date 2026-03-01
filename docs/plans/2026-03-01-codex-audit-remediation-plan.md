# Codex Audit Remediation — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix all confirmed gaps from the Codex codebase review — 17 verified findings across server-side RPCs, UI controls, money handling, and reconciliation.

**Architecture:** Six independent workstreams that can run as parallel agents. Each workstream produces one migration file and/or one set of frontend edits. All workstreams are designed to be merge-conflict-free (touching different files/functions).

**Tech Stack:** PostgreSQL RPCs (plpgsql), React/TypeScript, Vitest unit tests, Supabase migrations

---

## Verification Summary

| ID | Finding | Verdict | Severity |
|----|---------|---------|----------|
| P1-1 | `save_quote()` no state machine | CONFIRMED | High |
| P1-2 | QuoteBuilder buttons not status-gated | CONFIRMED | High |
| P1-3 | Hold release doesn't restore `quantity_available` | CONFIRMED | High |
| P1-4a | `cancel_order()` writes generated column | ALREADY PATCHED | — |
| P1-4b | `cancel_order()` hold release uses wrong `source_id` | CONFIRMED | High |
| P1-5 | Commission split not validated at conversion | DENIED | — |
| P1-6 | `complete_job()` allows `scheduled -> completed` | CONFIRMED | Medium |
| P1-7 | `transfer_job_to_invoice()` allows scheduled | DENIED | — |
| P1-8 | `receive_po_items()` no PO header gate | CONFIRMED | High |
| P1-9 | Return credits don't flow to AR | CONFIRMED | Critical |
| P1-10 | `close_accounting_period()` no role check | CONFIRMED | High |
| P2-2 | `receive_po_items()` missing `FOR UPDATE` | CONFIRMED | High |
| P2-3 | Payment entry uses `parseFloat` | CONFIRMED | Medium |
| P2-4 | `quote_versions` insert fire-and-forget | CONFIRMED | Medium |
| P3-1 | Quote UI not locked by state (=P1-2) | CONFIRMED | Medium |
| P3-2 | List pages hard-capped, no pagination | CONFIRMED | Medium |
| P3-3 | Month-end N+1 RPC loop | CONFIRMED | Medium |
| P4-1 | Bare `auth.uid()` in storage policies | CONFIRMED (low) | Low |
| P5-1 | `reconciliation.ts` schema-stale | DENIED | — |
| P5-2 | Reconciliation missing cross-entity checks | CONFIRMED | High |

**Denied findings (no action needed):** P1-5, P1-7, P5-1, P4-2
**Already patched:** P1-4a / P2-1

---

## Workstream Map (6 parallel agents)

```
Agent 1: RPC State Machines     ──→ Migration A (quote, job, PO, accounting period)
Agent 2: Inventory & Holds      ──→ Migration B (hold restore, cancel_order fix)
Agent 3: Return Credit → AR     ──→ Migration C (credit memo integration)
Agent 4: Frontend Hardening     ──→ QuoteBuilder, PaymentAllocation, InvoiceDetail, parseCents utility
Agent 5: Reconciliation Engine  ──→ src/lib/reconciliation.ts + tests
Agent 6: Scale & Cleanup        ──→ Migration D (batch year-end RPC) + storage policy fix
```

All agents can run simultaneously — zero file overlap between workstreams.

---

## Agent 1: RPC State Machine Enforcement

**Migration file:** `supabase/migrations/20260316100000_rpc_state_machine_enforcement.sql`
**Fixes:** P1-1, P1-6, P1-8, P1-10, P2-2
**Test file:** `src/lib/__tests__/rpcStateMachines.test.ts` (unit tests for expected behaviors)

### Task 1.1: Quote Status State Machine in `save_quote()`

**Files:**
- Modify: `supabase/migrations/20260316100000_rpc_state_machine_enforcement.sql` (new file)

**What to do:**
Replace `save_quote()` with a version that validates status transitions before applying.

Valid transitions:
- `draft` → `sent`, `revised`, `declined`, `expired`
- `sent` → `revised`, `accepted`, `declined`, `expired`
- `revised` → `sent`, `accepted`, `declined`, `expired`
- `accepted` → (terminal — no transitions allowed)
- `declined` → (terminal)
- `expired` → `revised` (re-open flow)

```sql
CREATE OR REPLACE FUNCTION public.save_quote(p_quote_payload jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_id uuid;
  v_current_status text;
  v_new_status text;
  v_valid boolean := false;
BEGIN
  v_id := (p_quote_payload->>'id')::uuid;
  v_new_status := COALESCE(p_quote_payload->>'status', 'draft');

  -- For new quotes, only 'draft' is allowed
  IF v_id IS NULL THEN
    IF v_new_status != 'draft' THEN
      RAISE EXCEPTION 'New quotes must start as draft, got: %', v_new_status;
    END IF;
  ELSE
    -- Fetch current status with lock
    SELECT status INTO v_current_status
    FROM public.quotes WHERE id = v_id FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Quote not found: %', v_id;
    END IF;

    -- If status hasn't changed, allow the save (editing fields only)
    IF v_new_status = v_current_status THEN
      v_valid := true;
    ELSE
      -- Validate transition
      v_valid := CASE v_current_status
        WHEN 'draft'    THEN v_new_status IN ('sent', 'revised', 'declined', 'expired')
        WHEN 'sent'     THEN v_new_status IN ('revised', 'accepted', 'declined', 'expired')
        WHEN 'revised'  THEN v_new_status IN ('sent', 'accepted', 'declined', 'expired')
        WHEN 'expired'  THEN v_new_status IN ('revised')
        ELSE false  -- accepted, declined are terminal
      END;

      IF NOT v_valid THEN
        RAISE EXCEPTION 'Invalid quote status transition: % → %', v_current_status, v_new_status;
      END IF;
    END IF;
  END IF;

  -- ... rest of existing save_quote logic (INSERT or UPDATE) ...
```

**Important:** Read the FULL existing `save_quote()` body from migration `20260228200000_safety_audit_hardening.sql` lines 201-288 and preserve ALL existing field assignments. Only ADD the state machine validation block at the top of the function, before the INSERT/UPDATE logic.

### Task 1.2: `complete_job()` — Require `in_progress`

**What to do:**
Change the status check from allowing `scheduled, in_progress` to requiring only `in_progress`.

In the same migration file, add:

```sql
-- Fix complete_job: require in_progress (not scheduled)
CREATE OR REPLACE FUNCTION public.complete_job(...)
```

Read the full existing function from `20260215200000_job_scheduling_tables.sql` lines 430-500. Change:

```sql
-- OLD:
IF v_job.status NOT IN ('scheduled', 'in_progress') THEN
-- NEW:
IF v_job.status != 'in_progress' THEN
  RAISE EXCEPTION 'Job must be in_progress before completion. Current status: %. Use start_job() first.', v_job.status;
END IF;
```

Preserve everything else in the function.

### Task 1.3: `receive_po_items()` — PO Header Status Gate + FOR UPDATE Lock

**What to do:**
Add two things to `receive_po_items()`:
1. Validate parent PO status is in allowed states before receiving
2. Add `FOR UPDATE` lock on inventory rows before updating

Read full function from `20260310210000_browser_smoke_test_fixes.sql` lines 9-154.

Add after PO header SELECT:

```sql
-- Gate by PO header status
IF v_po.status NOT IN ('submitted', 'partially_received') THEN
  RAISE EXCEPTION 'Cannot receive items for PO in status: %. PO must be submitted or partially_received.', v_po.status;
END IF;
```

Add `FOR UPDATE` before inventory update:

```sql
-- Lock inventory row before update
PERFORM 1 FROM public.inventory
WHERE product_id = v_po_item.product_id AND location = v_storage_location
FOR UPDATE;

UPDATE public.inventory SET
  quantity_available = quantity_available + v_qty,
  quantity_on_order = GREATEST(quantity_on_order - v_qty, 0),
  updated_at = now()
WHERE product_id = v_po_item.product_id AND location = v_storage_location;
```

### Task 1.4: `close_accounting_period()` — Add Role Check

**What to do:**
Add an admin role check at the top of the function body.

Read full function from `20260217200000_accounting_periods.sql` lines 63-108.

Add after DECLARE block:

```sql
BEGIN
  -- Enforce admin-only access
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = p_performed_by AND role = 'admin'
  ) THEN
    RAISE EXCEPTION 'Only admin users can close accounting periods';
  END IF;

  -- ... rest of existing function ...
```

### Task 1.5: Write Tests

**File:** `src/lib/__tests__/rpcStateMachines.test.ts`

Test the state machine transitions (these call RPCs via Supabase):

```typescript
// Test that invalid transitions are rejected
// Test that valid transitions succeed
// Test that complete_job rejects scheduled status
// Test that receive_po_items rejects cancelled PO
// Test that close_accounting_period rejects non-admin
```

Note: These may need to be integration tests if they call RPCs. At minimum, write unit tests for the state machine logic that can be extracted to a pure function.

### Task 1.6: Commit

```bash
git add supabase/migrations/20260316100000_rpc_state_machine_enforcement.sql
git add src/lib/__tests__/rpcStateMachines.test.ts
git commit -m "fix: enforce server-side state machines for quote, job, PO receive, and accounting period close"
```

---

## Agent 2: Inventory Holds & cancel_order Fix

**Migration file:** `supabase/migrations/20260316100001_inventory_hold_restoration.sql`
**Fixes:** P1-3, P1-4b

### Task 2.1: Hold Release Restores `quantity_available`

**What to do:**
Modify the trigger function `release_holds_on_quote_status_change()` to also restore `quantity_available` when holds are deactivated.

Read existing trigger from `20260312200000_business_logic_audit_fixes.sql` lines 24-60.

```sql
CREATE OR REPLACE FUNCTION public.release_holds_on_quote_status_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_hold record;
BEGIN
  IF NEW.status IN ('accepted', 'declined', 'expired') AND OLD.status != NEW.status THEN
    -- Restore inventory for each active hold before deactivating
    FOR v_hold IN
      SELECT * FROM public.inventory_holds
      WHERE source_id = NEW.id AND is_active = true
    LOOP
      UPDATE public.inventory
      SET quantity_available = quantity_available + v_hold.quantity_held,
          updated_at = now()
      WHERE id = v_hold.inventory_id;
    END LOOP;

    -- Deactivate the holds
    UPDATE public.inventory_holds
    SET is_active = false, updated_at = now()
    WHERE source_id = NEW.id AND is_active = true;
  END IF;

  RETURN NEW;
END;
$$;
```

**Important:** Check the actual column names in `inventory_holds` table. The hold should have `inventory_id` (or `product_id`) and `quantity_held` (or `quantity`). Read the schema from `20260206172436_create_full_schema_v2.sql` to get exact names.

### Task 2.2: Fix `cancel_order()` Hold Release Source ID

**What to do:**
In `cancel_order()`, holds are linked by `source_id = quote_id`, not `order_id`. Fix the WHERE clause to find the originating quote.

Read full function from `20260315200000_emergency_rpc_fixes.sql`.

Change:

```sql
-- OLD:
UPDATE inventory_holds SET is_active = false, updated_at = now()
WHERE source_id = p_order_id AND is_active = true;

-- NEW: Release holds linked to the originating quote
UPDATE public.inventory_holds SET is_active = false, updated_at = now()
WHERE source_id = v_order.quote_id AND is_active = true;
```

Also add inventory restoration (same pattern as Task 2.1) before deactivating:

```sql
-- Restore inventory from any remaining active holds
FOR v_hold IN
  SELECT * FROM public.inventory_holds
  WHERE source_id = v_order.quote_id AND is_active = true
LOOP
  UPDATE public.inventory
  SET quantity_available = quantity_available + v_hold.quantity_held,
      updated_at = now()
  WHERE id = v_hold.inventory_id;
END LOOP;

UPDATE public.inventory_holds SET is_active = false, updated_at = now()
WHERE source_id = v_order.quote_id AND is_active = true;
```

**Pre-check:** Confirm `orders` table has a `quote_id` column by reading schema. If not, join through `quotes` → `orders` mapping.

### Task 2.3: Commit

```bash
git add supabase/migrations/20260316100001_inventory_hold_restoration.sql
git commit -m "fix: restore quantity_available on hold release and fix cancel_order hold source_id"
```

---

## Agent 3: Return Credit → AR Integration

**Migration file:** `supabase/migrations/20260316100002_return_credit_ar_integration.sql`
**Fixes:** P1-9
**This is the largest change — requires careful design.**

### Task 3.1: Design Decision

The current `issue_return_credit()` only updates the return record and logs to audit. It needs to:
1. Create a credit memo (negative invoice or credit record)
2. Apply the credit against the original invoice's balance

**Approach:** Create a credit entry in the invoices table with negative `total_amount_cents`, linked to the return's original `order_id`. This reduces the customer's AR balance naturally through the existing invoice sum logic.

### Task 3.2: Implement Credit Memo Creation

Read the existing `issue_return_credit()` from `20260315200001_accounting_and_integrity_fixes.sql` lines 1015-1069.

Replace the TODO section with actual credit memo logic:

```sql
CREATE OR REPLACE FUNCTION public.issue_return_credit(
  p_return_id uuid,
  p_actor_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_return record;
  v_total bigint;
  v_credit_invoice_id uuid;
  v_invoice_number text;
  v_next_seq integer;
BEGIN
  -- Lock and fetch return
  SELECT * INTO v_return FROM public.returns WHERE id = p_return_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Return not found: %', p_return_id; END IF;
  IF v_return.status != 'received' THEN
    RAISE EXCEPTION 'Return must be in received status to issue credit. Current: %', v_return.status;
  END IF;

  -- Calculate total credit from return items
  SELECT COALESCE(SUM(ri.quantity * ri.unit_price_cents), 0) INTO v_total
  FROM public.return_items ri WHERE ri.return_id = p_return_id;

  IF v_total <= 0 THEN
    RAISE EXCEPTION 'Return has no items or zero credit value';
  END IF;

  -- Generate credit memo number
  SELECT COUNT(*) + 1 INTO v_next_seq
  FROM public.invoices
  WHERE invoice_number LIKE 'CM-' || to_char(now(), 'YYYY') || '-%';

  v_invoice_number := 'CM-' || to_char(now(), 'YYYY') || '-' || lpad(v_next_seq::text, 4, '0');

  -- Create credit memo as negative invoice
  INSERT INTO public.invoices (
    order_id, customer_id, invoice_number, invoice_date,
    total_amount_cents, paid_amount_cents, status,
    notes, created_by
  ) VALUES (
    v_return.order_id, v_return.customer_id, v_invoice_number, now()::date,
    -v_total, 0, 'posted',
    'Credit memo for return ' || v_return.return_number,
    p_actor_id
  )
  RETURNING id INTO v_credit_invoice_id;

  -- Update return status to credited
  UPDATE public.returns SET
    status = 'credited',
    credit_amount_cents = v_total,
    credit_invoice_id = v_credit_invoice_id,
    credited_at = now(),
    credited_by = p_actor_id,
    updated_at = now()
  WHERE id = p_return_id;

  -- Financial audit log
  INSERT INTO public.financial_audit_log (
    operation_type, entity_type, entity_id,
    actor_user_id, total_impact_cents, description
  ) VALUES (
    'return_credit_issued', 'return', p_return_id,
    p_actor_id, -v_total,
    'Credit memo ' || v_invoice_number || ' issued for return ' || v_return.return_number || ' ($' || (v_total / 100.0)::text || ')'
  );

  RETURN jsonb_build_object(
    'return_id', p_return_id,
    'credit_invoice_id', v_credit_invoice_id,
    'credit_invoice_number', v_invoice_number,
    'credit_amount_cents', v_total
  );
END;
$$;
```

**Pre-check columns:** Verify `returns` table has `credit_invoice_id` and `credit_amount_cents`. If not, add them in the same migration:

```sql
ALTER TABLE public.returns ADD COLUMN IF NOT EXISTS credit_invoice_id uuid REFERENCES public.invoices(id);
ALTER TABLE public.returns ADD COLUMN IF NOT EXISTS credit_amount_cents bigint DEFAULT 0;
ALTER TABLE public.returns ADD COLUMN IF NOT EXISTS credited_at timestamptz;
ALTER TABLE public.returns ADD COLUMN IF NOT EXISTS credited_by uuid REFERENCES auth.users(id);
```

Also verify `return_items` has `unit_price_cents` column.

### Task 3.3: Update TypeScript Types

**File:** `src/types/index.ts`

Add to the Return interface:
```typescript
credit_invoice_id?: string;
credit_amount_cents?: number;
credited_at?: string;
credited_by?: string;
```

### Task 3.4: Commit

```bash
git add supabase/migrations/20260316100002_return_credit_ar_integration.sql
git add src/types/index.ts
git commit -m "feat: implement return credit memo integration with AR/invoice system"
```

---

## Agent 4: Frontend Hardening

**Fixes:** P1-2/P3-1, P2-3, P2-4
**Files:** QuoteBuilder.tsx, PaymentAllocation.tsx, InvoiceDetail.tsx, new `src/lib/parseCents.ts`

### Task 4.1: Create Decimal-Safe Money Parser

**File (create):** `src/lib/parseCents.ts`

```typescript
/**
 * Parse a dollar string into cents (bigint-safe integer).
 * Avoids parseFloat IEEE 754 precision issues.
 *
 * "25.50" → 2550
 * "$1,234.56" → 123456
 * "10" → 1000
 * "" → 0
 */
export function parseDollarsToCents(input: string): number {
  if (!input || typeof input !== 'string') return 0;

  // Strip everything except digits and decimal point
  const cleaned = input.replace(/[^0-9.]/g, '');
  if (!cleaned) return 0;

  const parts = cleaned.split('.');
  const dollars = parseInt(parts[0] || '0', 10);
  // Take only first 2 decimal digits, pad with 0 if needed
  const centStr = (parts[1] || '00').substring(0, 2).padEnd(2, '0');
  const cents = parseInt(centStr, 10);

  return dollars * 100 + cents;
}
```

**Test file (create):** `src/lib/__tests__/parseCents.test.ts`

```typescript
import { describe, it, expect } from 'vitest';
import { parseDollarsToCents } from '../parseCents';

describe('parseDollarsToCents', () => {
  it('parses whole dollars', () => expect(parseDollarsToCents('25')).toBe(2500));
  it('parses dollars and cents', () => expect(parseDollarsToCents('25.50')).toBe(2550));
  it('parses with $ prefix', () => expect(parseDollarsToCents('$1,234.56')).toBe(123456));
  it('handles empty string', () => expect(parseDollarsToCents('')).toBe(0));
  it('handles single cent digit', () => expect(parseDollarsToCents('1.5')).toBe(150));
  it('avoids float precision issue', () => expect(parseDollarsToCents('1.01')).toBe(101));
  it('truncates beyond 2 decimals', () => expect(parseDollarsToCents('1.999')).toBe(199));
});
```

### Task 4.2: Replace parseFloat in PaymentAllocation.tsx

**File:** `src/pages/PaymentAllocation.tsx`

Replace `parseDollarInput` (around line 35):

```typescript
// OLD:
const parseDollarInput = (val: string): number => {
  const cleaned = val.replace(/[^0-9.]/g, '');
  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : Math.round(num * 100);
};

// NEW:
import { parseDollarsToCents } from '../lib/parseCents';
// Then replace all calls to parseDollarInput with parseDollarsToCents
```

### Task 4.3: Replace parseFloat in InvoiceDetail.tsx

**File:** `src/pages/InvoiceDetail.tsx`

Replace `parseFloat(payAmount)` in `handlePayment()` (around line 371):

```typescript
// OLD:
const amountDollars = parseFloat(payAmount);
// ...
p_amount_cents: Math.round(amountDollars * 100),

// NEW:
import { parseDollarsToCents } from '../lib/parseCents';
// ...
const amountCents = parseDollarsToCents(payAmount);
if (amountCents <= 0) {
  toast('error', 'Enter a valid payment amount');
  return;
}
// ...
p_amount_cents: amountCents,
```

### Task 4.4: QuoteBuilder Status-Gated Buttons

**File:** `src/pages/QuoteBuilder.tsx`

Add status-based button guards. Around line 117 where `isEditing` is defined, also extract current status:

```typescript
const currentStatus = existingQuote?.status || 'draft';
const canEdit = ['draft', 'revised'].includes(currentStatus);
const canSend = ['draft', 'revised'].includes(currentStatus);
const canConvert = ['sent', 'revised'].includes(currentStatus);
```

Then gate the action buttons (around lines 943-954):

```tsx
{/* Send Quote — only for draft/revised */}
{isEditing && canSend && (
  <Button variant="primary" icon={<Send className="w-4 h-4" />}
    onClick={() => setConfirmSendOpen(true)} loading={sending}>
    Send Quote
  </Button>
)}

{/* Convert to Order — only for sent/revised */}
{isEditing && canConvert && (
  <Button variant="primary" icon={<ShoppingCart className="w-4 h-4" />}
    onClick={() => setConfirmConvertOpen(true)} loading={converting}>
    Convert to Order
  </Button>
)}
```

Also disable the Save button for terminal states:

```tsx
<Button onClick={handleSave} disabled={!canEdit && isEditing} ...>
  {isEditing ? 'Update Quote' : 'Create Quote'}
</Button>
```

Add a status banner for read-only states:

```tsx
{isEditing && !canEdit && (
  <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-amber-800 text-sm">
    This quote is in <strong>{currentStatus}</strong> status and cannot be edited.
  </div>
)}
```

### Task 4.5: Fix quote_versions Insert Error Handling

**File:** `src/pages/QuoteBuilder.tsx` (around lines 766-777)

```typescript
// OLD:
await supabase.from('quote_versions').insert({
  quote_id: result,
  version_number: versionNum,
  // ...
});

// NEW:
const { error: versionError } = await supabase.from('quote_versions').insert({
  quote_id: result,
  version_number: versionNum,
  sent_by: profile.id,
  sent_at: new Date().toISOString(),
  sent_method: 'manual',
  snapshot_data: snapshotData,
  notes: `Version ${versionNum} sent`,
});
if (versionError) {
  console.error('Failed to create quote version snapshot:', versionError);
  toast('error', 'Quote was sent but version snapshot failed to save. Contact admin.');
  // Don't return — the quote was already sent; just warn the user
}
```

### Task 4.6: Commit

```bash
git add src/lib/parseCents.ts src/lib/__tests__/parseCents.test.ts
git add src/pages/PaymentAllocation.tsx src/pages/InvoiceDetail.tsx
git add src/pages/QuoteBuilder.tsx
git commit -m "fix: decimal-safe money parsing, quote status guards, and version snapshot error handling"
```

---

## Agent 5: Reconciliation Engine Expansion

**File:** `src/lib/reconciliation.ts`
**Test file:** `src/lib/__tests__/reconciliation.test.ts` (existing — extend it)
**Fixes:** P5-2

### Task 5.1: Add 5 Missing Cross-Entity Checks

Read the existing `src/lib/reconciliation.ts` (480 lines) and `src/lib/__tests__/reconciliation.test.ts`.

Add these new pure-function checks following the existing pattern (typed arrays → `Discrepancy[]`):

**Check 6: Quote-Hold Parity**
Every quote with `is_planned = true` and status in (`draft`, `sent`, `revised`) should have at least one active inventory hold.

```typescript
export function checkQuoteHoldParity(
  quotes: { id: string; quote_number: string; is_planned: boolean; status: string }[],
  holds: { source_id: string; is_active: boolean }[]
): Discrepancy[] {
  const activeHoldSources = new Set(
    holds.filter(h => h.is_active).map(h => h.source_id)
  );
  return quotes
    .filter(q => q.is_planned && ['draft', 'sent', 'revised'].includes(q.status))
    .filter(q => !activeHoldSources.has(q.id))
    .map(q => ({
      check: 'quote_hold_parity',
      entity: q.quote_number,
      expected: 'At least one active inventory hold',
      actual: 'No active holds found',
      difference: 'Missing hold',
    }));
}
```

**Check 7: Delivery → Invoice Quantity Parity**
For completed deliveries, the sum of delivered quantities per product should match invoiced quantities for the same order.

**Check 8: Prebooked vs Order Remaining**
`inventory.quantity_prebooked` should approximate the sum of undelivered order item quantities.

**Check 9: Return Credit → Invoice Balance Linkage**
Returns in `credited` status should have a non-null `credit_invoice_id`.

**Check 10: Customer AR vs Invoice Sum**
Per-customer AR (sum of non-voided invoice balances) should be internally consistent.

### Task 5.2: Update DB Wrapper

Add the new checks to `runReconciliationChecks()` — fetch the additional data from Supabase and pass to the new pure functions.

### Task 5.3: Write Tests for New Checks

Add tests in `src/lib/__tests__/reconciliation.test.ts` following the existing pattern.

### Task 5.4: Commit

```bash
git add src/lib/reconciliation.ts src/lib/__tests__/reconciliation.test.ts
git commit -m "feat: add 5 cross-entity reconciliation checks (quote-hold, delivery-invoice, prebooked, return-credit, customer-AR)"
```

---

## Agent 6: Scale Fixes & Cleanup

**Migration file:** `supabase/migrations/20260316100003_batch_year_end_and_cleanup.sql`
**Fixes:** P3-3, P4-1

### Task 6.1: Batch Year-End Summary RPC

Create a new RPC that returns year-end summaries for ALL customers in one call:

```sql
CREATE OR REPLACE FUNCTION public.get_batch_year_end_summaries(
  p_customer_ids uuid[],
  p_season integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_results jsonb := '[]'::jsonb;
  v_cid uuid;
  v_summary jsonb;
BEGIN
  FOREACH v_cid IN ARRAY p_customer_ids LOOP
    SELECT public.get_customer_year_end_summary(v_cid, p_season) INTO v_summary;
    v_results := v_results || jsonb_build_array(v_summary);
  END LOOP;

  RETURN v_results;
END;
$$;
```

Note: This still iterates internally, but it's one round-trip instead of N. A truly set-based approach would be better but requires rewriting the inner RPC — this is the safe minimum change.

### Task 6.2: Update MonthEndClose.tsx to Use Batch RPC

**File:** `src/pages/MonthEndClose.tsx`

Replace the per-customer loop (around lines 187-217):

```typescript
// OLD: N+1 loop
const summaries: YearEndSummaryData[] = [];
for (const cid of uniqueIds) {
  const { data, error } = await supabase.rpc('get_customer_year_end_summary', { ... });
  // ...
}

// NEW: Single batch call
const { data: summaries, error } = await supabase.rpc('get_batch_year_end_summaries', {
  p_customer_ids: uniqueIds,
  p_season: season,
});
if (error) {
  toast('error', 'Failed to generate year-end summaries: ' + error.message);
  return;
}
```

### Task 6.3: Fix Storage Policy `auth.uid()` Wrapper

In the same migration, fix the bare `auth.uid()` in storage policies:

```sql
-- Fix document OCR storage policies to use (select auth.uid()) for consistency
DROP POLICY IF EXISTS "Users can read own document uploads" ON storage.objects;
CREATE POLICY "Users can read own document uploads"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (bucket_id = 'document-uploads' AND (storage.foldername(name))[1] = (select auth.uid())::text);

DROP POLICY IF EXISTS "Users can upload documents" ON storage.objects;
CREATE POLICY "Users can upload documents"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (bucket_id = 'document-uploads' AND (storage.foldername(name))[1] = (select auth.uid())::text);

DROP POLICY IF EXISTS "Users can delete own document uploads" ON storage.objects;
CREATE POLICY "Users can delete own document uploads"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (bucket_id = 'document-uploads' AND (storage.foldername(name))[1] = (select auth.uid())::text);
```

### Task 6.4: Commit

```bash
git add supabase/migrations/20260316100003_batch_year_end_and_cleanup.sql
git add src/pages/MonthEndClose.tsx
git commit -m "feat: batch year-end RPC (eliminates N+1) and fix storage policy auth.uid() wrapper"
```

---

## Deferred Items (Not in This Sprint)

| Finding | Why Deferred |
|---------|-------------|
| P3-2: List page pagination | Large UX change affecting 3+ pages. Needs design review. 500-record cap is acceptable for current customer base. |

---

## Verification Checklist (after all agents complete)

```bash
# 1. Type check
npm run typecheck

# 2. Build
npm run build

# 3. Unit tests
npx vitest run

# 4. Apply migrations to Supabase
# (Review each migration file, then apply via Supabase dashboard or CLI)

# 5. Manual smoke test
# - Create a quote, try to convert from draft (should fail)
# - Send a quote, then convert (should work)
# - Try completing a scheduled job (should fail, must start first)
# - Try receiving into a cancelled PO (should fail)
# - Process a return through to credit (should create credit memo invoice)
# - Run reconciliation checks from admin panel
```

---

## Commit Strategy

Each agent commits independently. After all agents merge:

```bash
git checkout -b feature/codex-audit-remediation
# Cherry-pick or merge all agent branches
# Final: npm run typecheck && npm run build && npx vitest run
# Push and PR
```
