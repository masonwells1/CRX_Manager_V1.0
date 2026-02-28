# Audit Remediation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix 5 validated audit findings — 2 quick SQL fixes + 3 feature additions — to address finance charge compounding, billing split concurrency, missing tote tracking, RUP compliance warnings, and product-specific prepayment.

**Architecture:** Phase 0 is a single SQL migration replacing two RPCs with one-line fixes. Phase 1 adds nullable `tote_number` columns + optional UI fields. Phase 2 adds a pure TypeScript helper + amber warning banners. Phase 3 is the largest — new prepay schema columns, three new RPCs, and a new split-panel bookkeeper workspace page.

**Tech Stack:** Supabase PostgreSQL (migrations, RPCs), React + TypeScript (UI), Vitest (unit tests), existing component library (Card, Button, Badge, DataTable, Modal, Input).

---

## Phase 0: Quick SQL Fixes (~30 min)

### Task 1: Create Phase-0 migration file

**Files:**
- Create: `supabase/migrations/20260301000000_audit_phase0_fixes.sql`

**Step 1: Write the migration**

Create migration that fixes both issues in a single file:

```sql
-- Phase 0: Audit remediation quick fixes
-- Fix #4: Finance charge non-compounding
-- Fix #5: Billing split concurrency lock

-- ============================================================================
-- FIX #4: generate_finance_charges() compounds interest by including prior
-- finance charge invoices (invoice_type = 'misc_charge') in overdue balance.
-- FIX: Exclude misc_charge invoices from the overdue balance calculation.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.generate_finance_charges(
  p_as_of_date date,
  p_performed_by uuid,
  p_customer_ids uuid[] DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
-- IMPORTANT: This is a full replacement of the function from
-- migration 20260315200001_accounting_and_integrity_fixes.sql.
-- The ONLY change is adding: AND i.invoice_type != 'misc_charge'
-- to the overdue balance query (the FOR loop that sums balance_cents).
-- Copy the ENTIRE current function body from that migration,
-- then add the filter line after: AND i.deleted_at IS NULL
-- in the FOR v_customer loop (around line 471 of the source migration).
--
-- The exact line to add is:
--   AND i.invoice_type != 'misc_charge'
-- after the line:
--   AND i.deleted_at IS NULL
-- in the inner JOIN condition.
$$;

-- ============================================================================
-- FIX #4b: preview_finance_charges() has the same compounding bug.
-- FIX: Exclude misc_charge invoices from the overdue balance subquery.
-- ============================================================================

-- Same approach: copy entire function from
-- migration 20260220200000_finance_charge_intelligence.sql,
-- add AND i.invoice_type != 'misc_charge'
-- after AND i.deleted_at IS NULL in the inner subquery (around line 74).

-- ============================================================================
-- FIX #5: transfer_job_to_invoice() reads field_billing_defaults without
-- FOR UPDATE. Concurrent edits can corrupt split percentages.
-- FIX: Add FOR UPDATE to the field_billing_defaults subquery.
-- ============================================================================

-- Same approach: copy entire function from
-- migration 20260305200000_audit_safety_fixes.sql,
-- change all three JOINs to field_billing_defaults to use FOR UPDATE
-- by converting the JOIN subqueries to use a CTE with FOR UPDATE,
-- or by adding a SELECT ... FOR UPDATE at the top of the billing split block.
```

> **Implementation note for engineer:** The actual migration must contain the FULL function bodies copied from their source migrations with the fixes applied. The comments above describe what to change. You MUST read the latest version of each function, copy it entirely, apply the fix, and write it into this migration. Do NOT use partial replacements.

**Step 2: Detailed fix for generate_finance_charges()**

Read `supabase/migrations/20260315200001_accounting_and_integrity_fixes.sql` starting around line 430. Copy the entire `generate_finance_charges()` function. Find this block (around line 467-473):

```sql
      INNER JOIN public.invoices i
        ON i.customer_id = c.id
        AND i.status = 'posted'
        AND i.balance_cents > 0
        AND i.deleted_at IS NULL
        AND i.due_date IS NOT NULL
```

Add this line after `AND i.deleted_at IS NULL`:

```sql
        AND i.invoice_type != 'misc_charge'
```

This ensures prior finance charge invoices (which have `invoice_type = 'misc_charge'`) are excluded from the overdue balance sum, preventing compound interest.

**Step 3: Detailed fix for preview_finance_charges()**

Read `supabase/migrations/20260220200000_finance_charge_intelligence.sql` starting around line 22. Copy the entire `preview_finance_charges()` function. Find this block (around line 71-76):

```sql
    FROM public.invoices i
    WHERE i.status = 'posted'
      AND i.balance_cents > 0
      AND i.deleted_at IS NULL
      AND i.due_date IS NOT NULL
```

Add this line after `AND i.deleted_at IS NULL`:

```sql
      AND i.invoice_type != 'misc_charge'
```

**Step 4: Detailed fix for transfer_job_to_invoice()**

Read `supabase/migrations/20260305200000_audit_safety_fixes.sql` starting around line 1525. The function JOINs to `field_billing_defaults` in three places (lines ~1534, ~1540, ~1572). Add a locking statement at the start of the billing-split block:

```sql
  -- Lock field_billing_defaults rows for this job to prevent concurrent corruption
  PERFORM 1 FROM job_fields jf
    JOIN field_billing_defaults fbd ON fbd.field_id = jf.field_id
    WHERE jf.job_id = p_job_id
    FOR UPDATE OF fbd;
```

Insert this BEFORE the `IF EXISTS (SELECT 1 FROM job_fields jf JOIN field_billing_defaults ...)` check at line ~1532. The `FOR UPDATE OF fbd` locks only the `field_billing_defaults` rows (not `job_fields`), preventing concurrent writes to split percentages while this transaction reads them.

**Step 5: Run the migration locally**

```bash
# Apply via Supabase CLI or direct SQL execution
npx supabase db push
```

Expected: Migration applies successfully, no errors.

**Step 6: Verify the fixes**

Test manually via SQL console:
- Finance charges: Create a customer with an overdue misc_charge invoice → run `preview_finance_charges()` → verify the misc_charge invoice's balance is NOT included in overdue_balance_cents
- Billing split: The FOR UPDATE is structural — verify by reviewing the migration applied correctly

**Step 7: Commit**

```bash
git add supabase/migrations/20260301000000_audit_phase0_fixes.sql
git commit -m "fix: exclude prior finance charges from compounding + lock billing splits

- generate_finance_charges(): filter out invoice_type='misc_charge' from overdue balance
- preview_finance_charges(): same filter for consistency
- transfer_job_to_invoice(): add FOR UPDATE on field_billing_defaults reads"
```

---

## Phase 1: Optional Tote Tracking (~1 sprint)

### Task 2: Schema migration for tote columns

**Files:**
- Create: `supabase/migrations/20260301100000_tote_tracking.sql`

**Step 1: Write the migration**

```sql
-- Phase 1: Optional tote-level tracking
-- Adds nullable tote_number to delivery_items and invoice_items.
-- Adds is_non_returnable flag to receiving_records.

-- delivery_items: optional tote # per line item
ALTER TABLE public.delivery_items ADD COLUMN IF NOT EXISTS tote_number text;

-- invoice_items: tote # copied from delivery during invoicing
ALTER TABLE public.invoice_items ADD COLUMN IF NOT EXISTS tote_number text;

-- receiving_records: flag non-returnable totes
ALTER TABLE public.receiving_records ADD COLUMN IF NOT EXISTS is_non_returnable boolean NOT NULL DEFAULT false;
```

**Step 2: Run migration**

```bash
npx supabase db push
```

Expected: 3 ALTER TABLE statements succeed.

**Step 3: Commit**

```bash
git add supabase/migrations/20260301100000_tote_tracking.sql
git commit -m "feat: add tote_number columns to delivery_items + invoice_items

- delivery_items.tote_number: optional tote # per line item
- invoice_items.tote_number: copied from delivery for traceability
- receiving_records.is_non_returnable: flag non-returnable totes"
```

### Task 3: Thread tote_number through complete_delivery()

**Files:**
- Create: `supabase/migrations/20260301100001_complete_delivery_tote_copy.sql`

**Context:** `complete_delivery()` is defined most recently in `supabase/migrations/20260310210000_browser_smoke_test_fixes.sql` (line 171). When it creates invoice_items from delivery_items, it needs to copy `tote_number`.

**Step 1: Find the invoice_item INSERT in complete_delivery()**

Read the latest `complete_delivery()` function. Find where it inserts into `invoice_items`. Add `tote_number` to both the column list and the SELECT that populates it:

```sql
-- In the invoice_items INSERT, add:
-- Column: tote_number
-- Value:  di.tote_number  (from the delivery_items join)
```

The migration must copy the ENTIRE `complete_delivery()` function with this addition.

**Step 2: Run migration and verify**

```bash
npx supabase db push
```

**Step 3: Commit**

```bash
git add supabase/migrations/20260301100001_complete_delivery_tote_copy.sql
git commit -m "feat: copy tote_number from delivery_items to invoice_items on completion"
```

### Task 4: Add tote # field to NewDelivery page

**Files:**
- Modify: `src/pages/NewDelivery.tsx`

**Step 1: Add tote_number to DeliveryItemDraft interface**

In `src/pages/NewDelivery.tsx`, find the `DeliveryItemDraft` interface (line 16-23):

```typescript
interface DeliveryItemDraft {
  order_item_id: string;
  product_id: string;
  product_name: string;
  quantity: number;
  max_quantity: number;
  unit_size: string;
}
```

Add `tote_number`:

```typescript
interface DeliveryItemDraft {
  order_item_id: string;
  product_id: string;
  product_name: string;
  quantity: number;
  max_quantity: number;
  unit_size: string;
  tote_number: string;
}
```

**Step 2: Initialize tote_number when building items**

Find where `DeliveryItemDraft` objects are created (when order items are loaded). Add `tote_number: ''` to the initial object.

**Step 3: Add tote_number to the insert payload**

Find the `itemInserts` map (line ~256-262):

```typescript
const itemInserts = activeItems.map((item) => ({
  delivery_id: delData.id,
  order_item_id: item.order_item_id,
  product_id: item.product_id,
  quantity: item.quantity,
  unit_size: item.unit_size || null,
}));
```

Add tote_number:

```typescript
const itemInserts = activeItems.map((item) => ({
  delivery_id: delData.id,
  order_item_id: item.order_item_id,
  product_id: item.product_id,
  quantity: item.quantity,
  unit_size: item.unit_size || null,
  tote_number: item.tote_number || null,
}));
```

**Step 4: Add optional Tote # input field in the UI**

In the delivery items list (the card/row that shows each product + quantity), add an optional `Input` field:

```tsx
<Input
  placeholder="Tote #"
  value={item.tote_number}
  onChange={(e) => updateItem(index, 'tote_number', e.target.value)}
  className="w-32"
/>
```

Place this next to the quantity field. It's optional — empty is fine.

**Step 5: Verify build**

```bash
npm run build
```

Expected: Clean build with no TypeScript errors.

**Step 6: Commit**

```bash
git add src/pages/NewDelivery.tsx
git commit -m "feat: add optional tote # field to NewDelivery items"
```

### Task 5: Show tote # on DeliveryDetail page

**Files:**
- Modify: `src/pages/DeliveryDetail.tsx`

**Step 1: Add tote_number to the delivery_items query**

Find where delivery items are fetched. Add `tote_number` to the `.select()` string.

**Step 2: Display tote # in the items table**

Add a "Tote #" column to the delivery items display. Only show the column header if at least one item has a tote_number (conditional rendering).

```tsx
{items.some(i => i.tote_number) && (
  <th className="text-left text-xs font-medium text-secondary">Tote #</th>
)}
```

**Step 3: Verify build + commit**

```bash
npm run build
git add src/pages/DeliveryDetail.tsx
git commit -m "feat: display tote # on DeliveryDetail if populated"
```

### Task 6: Show tote # on invoice line items

**Files:**
- Modify: `src/pages/InvoiceDetail.tsx` (or wherever invoice line items are displayed)

**Step 1: Add tote_number to invoice_items query**

**Step 2: Display conditionally (same pattern as Task 5)**

**Step 3: Verify build + commit**

```bash
npm run build
git add src/pages/InvoiceDetail.tsx
git commit -m "feat: display tote # on invoice line items if populated"
```

### Task 7: Add non-returnable badge to ReceivingLog

**Files:**
- Modify: `src/pages/ReceivingLog.tsx`

**Step 1: Add is_non_returnable to receiving_records query**

**Step 2: Show badge when true**

```tsx
{record.is_non_returnable && (
  <Badge variant="warning">Non-Returnable</Badge>
)}
```

**Step 3: Verify build + commit**

```bash
npm run build
git add src/pages/ReceivingLog.tsx
git commit -m "feat: show non-returnable badge on receiving records"
```

### Task 8: Add tote # to Delivery PDF

**Files:**
- Modify: `src/lib/deliveryPdf.ts`

**Step 1: Add tote_number to the items data fetched for the PDF**

**Step 2: Add "Tote #" column to the PDF table — only if at least one item has a tote_number**

Follow the existing column pattern in `deliveryPdf.ts`. Conditionally add the column header and data.

**Step 3: Verify build + commit**

```bash
npm run build
git add src/lib/deliveryPdf.ts
git commit -m "feat: print tote # column on delivery PDF if populated"
```

---

## Phase 2: RUP Warning System (~0.5 sprint)

### Task 9: Write failing test for RUP compliance helper

**Files:**
- Create: `src/lib/rupCompliance.test.ts`

**Step 1: Write the test file**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock supabase before importing
vi.mock('./db', () => ({
  supabase: {
    from: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    in: vi.fn().mockReturnThis(),
    is: vi.fn().mockReturnThis(),
    gt: vi.fn().mockReturnThis(),
    gte: vi.fn().mockReturnThis(),
    single: vi.fn(),
    maybeSingle: vi.fn(),
  },
}));

import { checkRUPCompliance } from './rupCompliance';
import { supabase } from './db';

describe('checkRUPCompliance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns no warnings when no products are RUP', async () => {
    // Mock: products query returns no RUP products
    const mockFrom = vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        in: vi.fn().mockReturnValue({
          eq: vi.fn().mockResolvedValue({ data: [], error: null }),
        }),
      }),
    });
    (supabase.from as ReturnType<typeof vi.fn>).mockImplementation(mockFrom);

    const result = await checkRUPCompliance('customer-1', ['prod-1', 'prod-2']);
    expect(result.hasRUPProducts).toBe(false);
    expect(result.warnings).toHaveLength(0);
  });

  it('warns when RUP product and customer has no license', async () => {
    // Mock: one RUP product found, no license for customer
    // Implementation will query products.is_rup then applicator_licenses
    const result = await checkRUPCompliance('customer-1', ['rup-prod-1']);
    expect(result.hasRUPProducts).toBe(true);
    expect(result.missingLicense).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('warns when RUP product and customer license is expired', async () => {
    const result = await checkRUPCompliance('customer-1', ['rup-prod-1']);
    expect(result.hasRUPProducts).toBe(true);
    expect(result.expiredLicense).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('returns no warnings when RUP product and license is valid', async () => {
    const result = await checkRUPCompliance('customer-1', ['rup-prod-1']);
    expect(result.hasRUPProducts).toBe(true);
    expect(result.hasValidLicense).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });
});
```

> **Note:** The test mocks above are scaffolds — the engineer must fill in proper mock implementations based on the actual Supabase query patterns used by `checkRUPCompliance()`. Each test case needs its own mock chain setup.

**Step 2: Run test to verify it fails**

```bash
npx vitest run src/lib/rupCompliance.test.ts
```

Expected: FAIL — module `./rupCompliance` not found.

**Step 3: Commit failing test**

```bash
git add src/lib/rupCompliance.test.ts
git commit -m "test: add failing tests for RUP compliance checker"
```

### Task 10: Implement rupCompliance.ts

**Files:**
- Create: `src/lib/rupCompliance.ts`

**Step 1: Write the implementation**

```typescript
import { supabase } from './db';

export interface RUPComplianceResult {
  hasRUPProducts: boolean;
  hasValidLicense: boolean;
  expiredLicense: boolean;
  missingLicense: boolean;
  rupProductNames: string[];
  warnings: string[];
}

/**
 * Check if any products in the list are RUP (Restricted Use Pesticide)
 * and whether the customer has a valid applicator license.
 *
 * Returns warnings — does NOT block the transaction.
 */
export async function checkRUPCompliance(
  customerId: string,
  productIds: string[]
): Promise<RUPComplianceResult> {
  const result: RUPComplianceResult = {
    hasRUPProducts: false,
    hasValidLicense: false,
    expiredLicense: false,
    missingLicense: false,
    rupProductNames: [],
    warnings: [],
  };

  if (!productIds.length) return result;

  // 1. Check which products are RUP
  const { data: rupProducts } = await supabase
    .from('products')
    .select('id, product_name')
    .in('id', productIds)
    .eq('is_rup', true);

  if (!rupProducts?.length) return result;

  result.hasRUPProducts = true;
  result.rupProductNames = rupProducts.map((p) => p.product_name);

  // 2. Check customer's applicator license
  const today = new Date().toISOString().split('T')[0];
  const { data: licenses } = await supabase
    .from('applicator_licenses')
    .select('id, expiry_date')
    .eq('customer_id', customerId)
    .is('deleted_at', null);

  if (!licenses?.length) {
    result.missingLicense = true;
    result.warnings.push(
      `⚠️ RUP products (${result.rupProductNames.join(', ')}) require a valid applicator license. No license on file for this customer.`
    );
    return result;
  }

  // Check if any license is currently valid
  const validLicense = licenses.find((l) => l.expiry_date >= today);
  if (validLicense) {
    result.hasValidLicense = true;
    return result;
  }

  // All licenses are expired
  result.expiredLicense = true;
  result.warnings.push(
    `⚠️ RUP products (${result.rupProductNames.join(', ')}) require a valid applicator license. Customer's license is expired.`
  );

  return result;
}
```

**Step 2: Update test mocks to match implementation**

Update `rupCompliance.test.ts` mock chains to match the actual query patterns above (`.from('products').select().in().eq()` and `.from('applicator_licenses').select().eq().is()`).

**Step 3: Run tests**

```bash
npx vitest run src/lib/rupCompliance.test.ts
```

Expected: All 4 tests PASS.

**Step 4: Commit**

```bash
git add src/lib/rupCompliance.ts src/lib/rupCompliance.test.ts
git commit -m "feat: add RUP compliance checker with tests

- checkRUPCompliance() queries products.is_rup + applicator_licenses
- Returns warnings for missing/expired licenses
- Warning-only: does not block transactions"
```

### Task 11: Add RUP warning banner to QuoteBuilder

**Files:**
- Modify: `src/pages/QuoteBuilder.tsx`

**Step 1: Import the helper and add state**

```typescript
import { checkRUPCompliance, type RUPComplianceResult } from '../lib/rupCompliance';

// In component:
const [rupWarnings, setRupWarnings] = useState<string[]>([]);
```

**Step 2: Call checkRUPCompliance when products change**

Add a `useEffect` that calls `checkRUPCompliance(customerId, productIds)` whenever the selected customer or line item products change. Update `rupWarnings` state.

**Step 3: Render amber warning banner**

Above the line items section, render:

```tsx
{rupWarnings.length > 0 && (
  <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 mb-4">
    <div className="flex items-start gap-2">
      <AlertTriangle className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
      <div className="text-sm text-amber-800">
        {rupWarnings.map((w, i) => <p key={i}>{w}</p>)}
      </div>
    </div>
  </div>
)}
```

Import `AlertTriangle` from `lucide-react`.

**Step 4: Verify build**

```bash
npm run build
```

**Step 5: Commit**

```bash
git add src/pages/QuoteBuilder.tsx
git commit -m "feat: show RUP compliance warning banner on QuoteBuilder"
```

### Task 12: Add RUP warning to NewDelivery and DeliveryDetail

**Files:**
- Modify: `src/pages/NewDelivery.tsx`
- Modify: `src/pages/DeliveryDetail.tsx`

Same pattern as Task 11: import `checkRUPCompliance`, call on product/customer changes, render amber banner.

**Step 1: Add to NewDelivery.tsx**

**Step 2: Add to DeliveryDetail.tsx**

**Step 3: Verify build + commit**

```bash
npm run build
git add src/pages/NewDelivery.tsx src/pages/DeliveryDetail.tsx
git commit -m "feat: show RUP compliance warnings on delivery pages"
```

### Task 13: Add RUP audit logging

**Files:**
- Modify: `src/pages/QuoteBuilder.tsx` (and other pages where RUP warnings appear)

**Step 1: Log activity when RUP product is added for unlicensed customer**

When `checkRUPCompliance()` returns warnings, call:

```typescript
import { logActivity } from '../lib/activityLogger';

if (rupResult.warnings.length > 0) {
  logActivity(
    'rup_compliance_warning',
    `RUP products (${rupResult.rupProductNames.join(', ')}) added for customer without valid license`,
    profile.id,
    'customer',
    customerId,
    customerId
  );
}
```

**Step 2: Verify build + commit**

```bash
npm run build
git add src/pages/QuoteBuilder.tsx src/pages/NewDelivery.tsx src/pages/DeliveryDetail.tsx
git commit -m "feat: log RUP compliance warnings to activity feed"
```

### Task 14: Add "Overdue License" filter to Compliance page

**Files:**
- Modify: `src/pages/Compliance.tsx`

**Step 1: Add filter to licenses tab**

The Compliance page already has `licenses` and `rup_products` tabs. On the licenses tab, add a toggle or filter chip: "Show Overdue Only" that filters to licenses where `expiry_date < today`.

**Step 2: Verify build + commit**

```bash
npm run build
git add src/pages/Compliance.tsx
git commit -m "feat: add overdue license filter to Compliance page"
```

---

## Phase 3: Bucket-Based Prepay System (~1-1.5 sprints)

### Task 15: Schema migration for bucket labels + seed data

**Files:**
- Create: `supabase/migrations/20260301200000_prepay_bucket_system.sql`

**Step 1: Write the migration**

```sql
-- Phase 3: Bucket-based prepay system
-- Adds a soft label to prepay_credits for earmarking dollars by purpose.
-- One check → multiple rows in prepay_credits, each with a bucket_label.

-- Single new column: a human-readable earmark label
ALTER TABLE public.prepay_credits
  ADD COLUMN IF NOT EXISTS bucket_label text;

-- Seed predefined bucket categories into app_settings
-- Bookkeeper picks from this dropdown; admin can add/edit labels
INSERT INTO public.app_settings (setting_key, setting_value)
VALUES (
  'prepay_bucket_labels',
  '["Corn Chemical","Soybean Chemical","Corn Fungicide","Soybean Fungicide","Nutritionals","Application","Parts/Service","General"]'
)
ON CONFLICT (setting_key) DO NOTHING;

-- Index for grouping by check reference
CREATE INDEX IF NOT EXISTS idx_prepay_credits_reference
  ON public.prepay_credits (customer_id, reference_number)
  WHERE balance_cents > 0;
```

**Step 2: Run migration**

```bash
npx supabase db push
```

Expected: ALTER TABLE + INSERT + CREATE INDEX all succeed.

**Step 3: Commit**

```bash
git add supabase/migrations/20260301200000_prepay_bucket_system.sql
git commit -m "feat: add bucket_label to prepay_credits + seed bucket categories

- prepay_credits.bucket_label: soft earmark label (e.g. 'Corn Chemical')
- app_settings.prepay_bucket_labels: predefined dropdown options
- Index on (customer_id, reference_number) for check grouping"
```

### Task 16: Create apply_prepay_to_invoice() and batch RPCs

**Files:**
- Create: `supabase/migrations/20260301200001_prepay_application_rpcs.sql`

**Step 1: Write apply_prepay_to_invoice()**

```sql
-- Apply a specific prepay bucket to a specific invoice with full audit trail

CREATE OR REPLACE FUNCTION public.apply_prepay_to_invoice(
  p_prepay_credit_id uuid,
  p_invoice_id uuid,
  p_amount_cents bigint,
  p_performed_by uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_credit record;
  v_invoice record;
  v_applied_id uuid;
BEGIN
  -- Lock and read the prepay credit (bucket)
  SELECT * INTO v_credit
    FROM public.prepay_credits
    WHERE id = p_prepay_credit_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Prepay credit not found';
  END IF;

  IF v_credit.balance_cents < p_amount_cents THEN
    RAISE EXCEPTION 'Insufficient prepay balance: % available, % requested',
      v_credit.balance_cents, p_amount_cents;
  END IF;

  -- Lock and read the invoice
  SELECT * INTO v_invoice
    FROM public.invoices
    WHERE id = p_invoice_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice not found';
  END IF;

  IF v_invoice.balance_cents < p_amount_cents THEN
    RAISE EXCEPTION 'Amount exceeds invoice balance: % owed, % applied',
      v_invoice.balance_cents, p_amount_cents;
  END IF;

  -- Create immutable application record
  INSERT INTO public.prepay_applications (
    prepay_credit_id, invoice_id, applied_amount_cents, applied_by
  ) VALUES (
    p_prepay_credit_id, p_invoice_id, p_amount_cents, p_performed_by
  ) RETURNING id INTO v_applied_id;

  -- Deduct from prepay credit bucket
  UPDATE public.prepay_credits
    SET balance_cents = balance_cents - p_amount_cents,
        updated_at = now()
    WHERE id = p_prepay_credit_id;

  -- Deduct from invoice balance
  UPDATE public.invoices
    SET balance_cents = balance_cents - p_amount_cents,
        updated_at = now()
    WHERE id = p_invoice_id;

  -- Update customer aggregate prepay_balance_cents
  UPDATE public.customers
    SET prepay_balance_cents = prepay_balance_cents - p_amount_cents,
        updated_at = now()
    WHERE id = v_credit.customer_id;

  -- Audit log
  INSERT INTO public.financial_audit_log (
    action, entity_type, entity_id, performed_by, details
  ) VALUES (
    'prepay_applied', 'prepay_application', v_applied_id, p_performed_by,
    jsonb_build_object(
      'prepay_credit_id', p_prepay_credit_id,
      'invoice_id', p_invoice_id,
      'amount_cents', p_amount_cents,
      'bucket_label', v_credit.bucket_label,
      'check_reference', v_credit.reference_number
    )
  );

  RETURN jsonb_build_object(
    'success', true,
    'application_id', v_applied_id,
    'prepay_remaining', v_credit.balance_cents - p_amount_cents,
    'invoice_remaining', v_invoice.balance_cents - p_amount_cents
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.apply_prepay_to_invoice(uuid, uuid, bigint, uuid) TO authenticated;
```

**Step 2: Write batch_apply_prepayments()**

```sql
-- Batch apply multiple allocations atomically (for "Save Allocations" button)

CREATE OR REPLACE FUNCTION public.batch_apply_prepayments(
  p_allocations jsonb,  -- [{prepay_credit_id, invoice_id, amount_cents}]
  p_performed_by uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_alloc jsonb;
  v_results jsonb[] := ARRAY[]::jsonb[];
  v_result jsonb;
  v_total_applied bigint := 0;
  v_count integer := 0;
BEGIN
  FOR v_alloc IN SELECT * FROM jsonb_array_elements(p_allocations)
  LOOP
    v_result := public.apply_prepay_to_invoice(
      (v_alloc->>'prepay_credit_id')::uuid,
      (v_alloc->>'invoice_id')::uuid,
      (v_alloc->>'amount_cents')::bigint,
      p_performed_by
    );
    v_results := array_append(v_results, v_result);
    v_total_applied := v_total_applied + (v_alloc->>'amount_cents')::bigint;
    v_count := v_count + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'applied_count', v_count,
    'total_applied_cents', v_total_applied,
    'details', to_jsonb(v_results)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.batch_apply_prepayments(jsonb, uuid) TO authenticated;
```

> **Note:** No `suggest_prepay_matching()` RPC needed. The bookkeeper manually allocates from labeled buckets — no auto-match algorithm.

**Step 3: Run migration + commit**

```bash
npx supabase db push
git add supabase/migrations/20260301200001_prepay_application_rpcs.sql
git commit -m "feat: add prepay application RPCs

- apply_prepay_to_invoice(): atomic single-allocation with audit trail
- batch_apply_prepayments(): atomic batch allocation for Save button"
```

### Task 17: Add "Split Check" flow to PrepaymentManager

**Files:**
- Modify: `src/pages/PrepaymentManager.tsx`

**Step 1: Fetch bucket labels from app_settings**

On mount, fetch the predefined bucket labels:

```typescript
const [bucketLabels, setBucketLabels] = useState<string[]>([]);

useEffect(() => {
  supabase
    .from('app_settings')
    .select('setting_value')
    .eq('setting_key', 'prepay_bucket_labels')
    .maybeSingle()
    .then(({ data }) => {
      if (data?.setting_value) {
        setBucketLabels(JSON.parse(data.setting_value));
      }
    });
}, []);
```

**Step 2: Add "New Check" button + modal**

Create a modal for the "Split Check" flow:

1. **Customer dropdown** — select which customer the check is for
2. **Check # field** — text input for `reference_number`
3. **Total amount** — dollar input for the full check amount
4. **Bucket splits** — dynamic rows, each with:
   - Bucket label dropdown (from `bucketLabels`)
   - Dollar amount input
   - Remove row button
5. **"Add Bucket" button** — adds another split row
6. **Validation:** Split amounts must sum to the total check amount
7. **Save:** Creates one `prepay_credits` row per bucket split, all sharing the same `reference_number` and `customer_id`

**Step 3: Update customer prepay_balance_cents**

After inserting all prepay_credits rows, update `customers.prepay_balance_cents` by the total check amount. (Or rely on the existing `create_prepay_credit()` RPC if it already handles this — check and reuse.)

**Step 4: Verify build + commit**

```bash
npm run build
git add src/pages/PrepaymentManager.tsx
git commit -m "feat: add 'Split Check' flow to PrepaymentManager

- New Check modal: enter check #, total, and split into labeled buckets
- Bucket dropdown from app_settings.prepay_bucket_labels
- Validation ensures splits sum to check total
- Creates one prepay_credits row per bucket"
```

### Task 18: Create PrepayWorkspace page (split-panel allocator)

**Files:**
- Create: `src/pages/PrepayWorkspace.tsx`

This is the bookkeeper's main workspace — a new page at route `/prepay-workspace`.

**Step 1: Create the page component**

```typescript
/**
 * PrepayWorkspace — Split-panel workspace for applying prepay buckets
 * to unpaid invoices. Fully manual — bookkeeper has 100% control.
 *
 * Layout: Left panel (prepay buckets by check) | Right panel (unpaid invoices)
 * Bottom toolbar: Save Allocations | Reset
 */
```

**Key state:**

```typescript
interface PendingAllocation {
  prepay_credit_id: string;  // which bucket row
  invoice_id: string;
  amount_cents: number;
}

const [selectedCustomerId, setSelectedCustomerId] = useState<string>('');
const [buckets, setBuckets] = useState<PrepayBucket[]>([]);
const [invoices, setInvoices] = useState<Invoice[]>([]);
const [pendingAllocations, setPendingAllocations] = useState<PendingAllocation[]>([]);
const [saving, setSaving] = useState(false);
```

**Step 2: Customer selector at top**

Dropdown of customers who have prepay balance > 0. When customer changes, fetch their prepay buckets and unpaid invoices.

**Step 3: Left panel — Prepay Buckets (grouped by check)**

Query `prepay_credits` with `balance_cents > 0` for selected customer. Group by `reference_number` (check #). Each group shows:
- Check # header with total remaining across all its buckets
- Individual bucket cards underneath:
  - Bucket label badge (e.g. "🌽 Corn Chemical")
  - Remaining balance
  - "Apply ▶" button

When all buckets in a check group hit $0, show the check as "✅ Fully Applied".

**Step 4: Right panel — Unpaid Invoices**

Query `invoices` with `status = 'posted'` and `balance_cents > 0`. Each card shows:
- Invoice number + total amount + remaining balance
- Due date
- Pending applied amount (from `pendingAllocations` state, shown live)
- Color: green (fully covered), amber (partially), red (overdue)

**Step 5: Apply flow**

Clicking "Apply ▶" on a bucket opens a mini-modal:
- Shows all unpaid invoices for this customer
- Each invoice has a dollar input field
- Bookkeeper enters how much of this bucket to apply to each invoice
- "Apply Full" shortcut button applies entire bucket balance to one invoice
- Amounts are added to `pendingAllocations` state (not committed yet)

Both panels update live as allocations are added.

**Step 6: Save Allocations button**

Calls `batch_apply_prepayments()` with all pending allocations. On success:
- Shows toast with total applied
- Refreshes bucket and invoice data
- Clears pending state

**Step 7: Reset button**

Clears all `pendingAllocations`. No confirmation needed (nothing committed).

**Step 8: Verify build**

```bash
npm run build
```

**Step 9: Commit**

```bash
git add src/pages/PrepayWorkspace.tsx
git commit -m "feat: add PrepayWorkspace split-panel prepay allocation page

- Customer selector loads prepay buckets + unpaid invoices
- Left panel: buckets grouped by check # with remaining balances
- Right panel: unpaid invoices with due dates and live applied amounts
- Apply flow: click bucket → enter amounts per invoice → all editable
- Save Allocations: atomic batch commit via batch_apply_prepayments()
- Reset: clears all pending work without committing
- Fully manual — no auto-matching, bookkeeper controls every dollar"
```

### Task 19: Add route + nav for PrepayWorkspace

**Files:**
- Modify: `src/App.tsx` (or wherever routes are defined)
- Modify: Navigation sidebar component

**Step 1: Add route**

```typescript
<Route path="/prepay-workspace" element={<PrepayWorkspace />} />
```

**Step 2: Add nav link**

In the Finance section of the sidebar, add "Prepay Workspace" link with appropriate icon (e.g. `Wallet` or `ArrowLeftRight` from lucide-react).

**Step 3: Verify build + commit**

```bash
npm run build
git add src/App.tsx src/components/layout/Sidebar.tsx
git commit -m "feat: add /prepay-workspace route and sidebar nav link"
```

### Task 20: Link PrepaymentManager to workspace + update table

**Files:**
- Modify: `src/pages/PrepaymentManager.tsx`

**Step 1: Add "Allocate" button per customer row**

Next to each customer row's existing "Apply" button, add an "Allocate ▶" button that navigates to `/prepay-workspace?customer={id}`.

**Step 2: Show bucket breakdown in expanded row (optional enhancement)**

If time permits, add an expandable row that shows the customer's prepay buckets grouped by check. This lets the bookkeeper see the breakdown without leaving the page.

**Step 3: Keep legacy "Apply" as fallback**

The existing auto-apply button (`apply_remaining_prepayments()`) stays as a "Quick Apply" option. The new "Allocate ▶" button is primary and more prominent.

**Step 4: Verify build + commit**

```bash
npm run build
git add src/pages/PrepaymentManager.tsx
git commit -m "feat: link PrepaymentManager to PrepayWorkspace

- 'Allocate' button navigates to /prepay-workspace?customer=id
- Legacy 'Quick Apply' button stays as fallback"
```

### Task 21: Integration testing

**Step 1: Test the full flow manually**

1. Open PrepaymentManager → click "New Check"
2. Select customer, enter Check #4521, total $10,000
3. Split: $5,000 Corn Chemical + $3,000 Soybean Chemical + $2,000 Application
4. Save → verify 3 `prepay_credits` rows created with correct bucket_labels
5. Open PrepayWorkspace for the customer
6. See 3 buckets under "Check #4521"
7. Click "Apply ▶" on Corn Chemical bucket → apply $4,200 to INV-2026-0042
8. Click "Apply ▶" on Soybean bucket → apply $1,800 to INV-2026-0043
9. Click "Save Allocations"
10. Verify: prepay_credits.balance_cents decreased, invoices.balance_cents decreased, prepay_applications rows created
11. Check #4521 shows $800 remaining in Corn Chemical, $1,200 remaining in Soybean, $2,000 remaining in Application

**Step 2: Test edge cases**

- Over-apply: try applying more than bucket balance → should show error
- Over-apply: try applying more than invoice balance → should show error
- Reset clears all pending without committing
- Concurrent saves are handled by FOR UPDATE locks
- Bucket with $0 remaining doesn't show "Apply ▶" button

**Step 3: Final commit**

```bash
git add -A
git commit -m "chore: audit remediation Phase 3 complete — bucket-based prepay system"
```

---

## Summary Checklist

| Task | Phase | Description | Estimated Time |
|------|-------|-------------|----------------|
| 1 | 0 | Finance charge + billing split SQL fixes | 30 min |
| 2 | 1 | Tote tracking schema migration | 10 min |
| 3 | 1 | Thread tote_number through complete_delivery() | 30 min |
| 4 | 1 | Tote # field on NewDelivery page | 20 min |
| 5 | 1 | Tote # display on DeliveryDetail | 15 min |
| 6 | 1 | Tote # display on InvoiceDetail | 15 min |
| 7 | 1 | Non-returnable badge on ReceivingLog | 10 min |
| 8 | 1 | Tote # column in Delivery PDF | 20 min |
| 9 | 2 | Failing tests for RUP compliance | 15 min |
| 10 | 2 | Implement rupCompliance.ts | 30 min |
| 11 | 2 | RUP warning banner on QuoteBuilder | 20 min |
| 12 | 2 | RUP warnings on delivery pages | 20 min |
| 13 | 2 | RUP audit logging | 10 min |
| 14 | 2 | Overdue license filter on Compliance | 15 min |
| 15 | 3 | Prepay bucket schema + seed data | 10 min |
| 16 | 3 | Two prepay application RPCs | 30 min |
| 17 | 3 | "Split Check" flow on PrepaymentManager | 45 min |
| 18 | 3 | PrepayWorkspace page (main effort) | 2-3 hours |
| 19 | 3 | Route + nav for workspace | 10 min |
| 20 | 3 | Link PrepaymentManager to workspace | 15 min |
| 21 | 3 | Integration testing | 30 min |

**Total:** ~7-8 hours of focused implementation work across 4 phases.
