# Ag-Retail Audit Remediation — Design Document

> **Date:** 2026-02-28
> **Source:** Gemini forensic review + Codex triage, validated against current codebase
> **Scope:** 5 valid findings, 1 already fixed, 2 false alarms

---

## Findings Summary

| # | Finding | Verdict | Severity | Phase |
|---|---------|---------|----------|-------|
| 1 | Missing lot/tote-level tracking | VALID | P1 | 1 |
| 2 | No RUP enforcement | VALID | P1 | 2 |
| 3 | Generic prepayment pooling | VALID | P1 | 3 |
| 4 | Finance charge compounding | VALID | P1 | 0 (quick fix) |
| 5 | Billing split locking gap | VALID | P2 | 0 (quick fix) |
| 6 | Cycle count cap-at-zero | FALSE ALARM | — | — |
| 7 | Quote hold oversell | FALSE ALARM | — | — |
| 8 | Float precision in quoteCalc | ALREADY FIXED (Sprint 1b) | — | — |

---

## Phase 0: Quick SQL Fixes

### Fix #4 — Finance charge non-compounding

**Problem:** `generate_finance_charges()` sums ALL posted invoices for overdue balance, including prior finance charge invoices (`invoice_type = 'misc_charge'`). This compounds interest.

**Fix:** Add `AND i.invoice_type != 'misc_charge'` to the overdue balance query in both `generate_finance_charges()` and `preview_finance_charges()`.

**Migration:** Single ALTER replacing both RPCs.

### Fix #5 — Billing split concurrency lock

**Problem:** `transfer_job_to_invoice()` reads `field_billing_defaults` without `FOR UPDATE`. Concurrent edits can corrupt split percentages.

**Fix:** Add `FOR UPDATE` to the `field_billing_defaults` SELECT inside `transfer_job_to_invoice()`.

**Migration:** Single ALTER replacing the RPC.

---

## Phase 1: Tote/Lot Tracking (Optional Capture)

### Business Context

CRX tracks product by tote number, not lot number. Totes from the manufacturer may be non-returnable (which affects customer pricing). Warehouse grabs whatever tote is in the shed — tracking is optional, not enforced.

### Schema Changes

```sql
-- delivery_items: optional tote tracking
ALTER TABLE delivery_items ADD COLUMN tote_number text;

-- invoice_items: copied from delivery for traceability
ALTER TABLE invoice_items ADD COLUMN tote_number text;

-- Flag non-returnable totes on receiving
ALTER TABLE receiving_records ADD COLUMN is_non_returnable boolean NOT NULL DEFAULT false;
```

### RPC Changes

- `complete_delivery()` — copy tote_number from delivery_items to invoice_items during invoicing
- No changes to inventory deduction logic (stays aggregate)

### UI Changes

- **NewDelivery / DeliveryDetail:** Optional "Tote #" text field per line item
- **Delivery PDF:** Print tote # column if any items have one
- **ReceivingLog:** Show non-returnable badge on receiving records
- **CustomerDetail / InvoiceDetail:** Show tote # on invoice line items if populated

### What This Does NOT Do

- Does not enforce FIFO lot rotation
- Does not split inventory by lot (stays aggregate)
- Does not require tote # to complete a delivery
- Does not track tote returns (future enhancement)

---

## Phase 2: RUP Warning System (Warning Only)

### Business Context

Selling Restricted Use Pesticides (RUPs) to customers without valid applicator licenses is a federal violation. However, the business wants a WARNING, not a hard block — sales reps need flexibility.

### Implementation

**New helper:** `src/lib/rupCompliance.ts`

```typescript
export async function checkRUPCompliance(
  customerId: string,
  productIds: string[]
): Promise<{
  hasRUPProducts: boolean;
  hasValidLicense: boolean;
  expiredLicense: boolean;
  missingLicense: boolean;
  rupProductNames: string[];
  warnings: string[];
}>
```

**Where warnings appear:**
- QuoteBuilder — amber banner above line items
- NewOrder — amber banner above order summary
- NewDelivery / DeliveryDetail — amber banner above delivery items
- Compliance page — existing page, add "overdue license" filter

**Audit trail:**
- `logActivity()` call when RUP product is added to order/delivery for customer without valid license
- Activity type: `rup_compliance_warning`
- Logged data: customer, products, license status

### Schema Changes

None required — `products.is_rup` and `applicator_licenses.expiry_date` already exist.

---

## Phase 3: Product-Specific Prepay System

### Business Context

CRX growers use three prepayment models:
1. **SKU-specific** (most chemical sales) — prepay for exact product at locked price
2. **Category** (70% of nutritionals/application work) — prepay for a product category at a price
3. **General credit** — money on account, applies to anything

The bookkeeper must have **full manual control** over how prepay is applied. Auto-matching suggests allocations, but the bookkeeper reviews and confirms everything. They need an intuitive UI to drag/reassign allocations easily.

### Schema Changes

```sql
-- Enhance prepay_credits with optional product linkage
ALTER TABLE prepay_credits ADD COLUMN prepay_type text NOT NULL DEFAULT 'general'
  CHECK (prepay_type IN ('general', 'sku_specific', 'category', 'family'));
ALTER TABLE prepay_credits ADD COLUMN product_id uuid REFERENCES products(id);
ALTER TABLE prepay_credits ADD COLUMN product_category text;
ALTER TABLE prepay_credits ADD COLUMN product_family text;
ALTER TABLE prepay_credits ADD COLUMN locked_price_cents bigint;
ALTER TABLE prepay_credits ADD COLUMN locked_price_unit text;
ALTER TABLE prepay_credits ADD COLUMN locked_until date;
```

### Prepay Application Workflow

#### Step 1: Create Prepay Credit (existing page, enhanced)

PrepaymentManager gets new fields when creating a credit:
- **Type selector:** General | Specific Product | Category | Product Family
- **Product picker:** shown for SKU-specific (autocomplete from products)
- **Category dropdown:** shown for Category type
- **Family text field:** shown for Family type
- **Locked price + unit:** shown for SKU and Category types
- **Valid until date:** optional expiration

#### Step 2: Apply Prepayments (NEW "Payment Application" workspace)

This is the bookkeeper's main workspace. It replaces the current auto-apply behavior with a supervised, visual allocation tool.

**Layout: Split-panel design**

```
┌─────────────────────────────────────────────────────────┐
│  Customer: [Dropdown]                    Period: [Date]  │
├──────────────────────────┬──────────────────────────────┤
│  AVAILABLE FUNDS         │  UNPAID INVOICES             │
│  (left panel)            │  (right panel)               │
│                          │                              │
│  ┌─────────────────────┐ │  ┌─────────────────────────┐ │
│  │ Prepay: Roundup     │ │  │ INV-2026-0042  $4,200  │ │
│  │ $5,000 @ $50/gal    │ │  │ Items: Roundup, Gramoxone│
│  │ [Apply ▶]           │ │  │ Due: Mar 15             │ │
│  └─────────────────────┘ │  │ [Applied: $0]           │ │
│                          │  └─────────────────────────┘ │
│  ┌─────────────────────┐ │                              │
│  │ Prepay: General     │ │  ┌─────────────────────────┐ │
│  │ $3,000              │ │  │ INV-2026-0043  $1,800  │ │
│  │ [Apply ▶]           │ │  │ Items: Dry fertilizer   │ │
│  └─────────────────────┘ │  │ Due: Mar 20             │ │
│                          │  │ [Applied: $0]           │ │
│  ┌─────────────────────┐ │  └─────────────────────────┘ │
│  │ Check #4521         │ │                              │
│  │ $2,500              │ │  ┌─────────────────────────┐ │
│  │ [Apply ▶]           │ │  │ INV-2026-0044  $950    │ │
│  └─────────────────────┘ │  │ Items: Parts/service    │ │
│                          │  │ Due: Apr 1              │ │
│  Balance: $10,500        │  │ [Applied: $0]           │ │
│                          │  └─────────────────────────┘ │
│                          │                              │
│                          │  Outstanding: $6,950         │
├──────────────────────────┴──────────────────────────────┤
│  [🔄 Auto-Match]  [💾 Save Allocations]  [↩ Reset]     │
└─────────────────────────────────────────────────────────┘
```

**How it works:**

1. **Select customer** from dropdown (shows customers with prepay balance or unpaid invoices)
2. **Left panel** shows all available funds: prepay credits (by type with product info), undeposited checks, any unapplied payments
3. **Right panel** shows all unpaid invoices, sorted by date, with line item product summary
4. **Click "Apply ▶"** on a fund source → opens a mini-modal:
   - Shows matching invoices (auto-highlighted if product matches)
   - Enter dollar amount to apply to each invoice
   - Or click "Apply Full" to use the entire amount on one invoice
5. **Auto-Match button** runs the matching algorithm:
   - SKU-specific prepay → matches invoices containing that product
   - Category prepay → matches invoices containing products in that category
   - General → oldest invoices first
   - Shows proposed allocations as **editable** amounts — bookkeeper can adjust every number
6. **Save Allocations** commits all pending allocations to `prepay_applications` table
7. **Reset** clears all pending allocations back to starting state

**Key UX principles:**
- Everything is reversible until "Save Allocations" is clicked
- Auto-match is a SUGGESTION, not final — every amount is editable
- Applied amounts show live on both panels as you work
- Running balances update in real-time
- Color coding: green (fully paid), amber (partially paid), red (overdue)

#### Step 3: Reconciliation View

After allocations are saved, the bookkeeper can see:
- Full audit trail in `prepay_applications` (which credit → which invoice → amount → date → who)
- Customer statement reflects applied prepay as line items
- AR aging excludes prepay-covered portions

### RPC Changes

**Replace `apply_remaining_prepayments()`** with:

```sql
-- New: Apply a specific prepay credit to a specific invoice
apply_prepay_to_invoice(
  p_prepay_credit_id uuid,
  p_invoice_id uuid,
  p_amount_cents bigint,
  p_performed_by uuid
) RETURNS jsonb

-- New: Batch apply multiple allocations at once (for Save Allocations button)
batch_apply_prepayments(
  p_allocations jsonb,  -- [{prepay_credit_id, invoice_id, amount_cents}]
  p_performed_by uuid
) RETURNS jsonb

-- New: Suggest auto-match allocations (returns proposals, doesn't apply)
suggest_prepay_matching(
  p_customer_id uuid
) RETURNS jsonb  -- [{prepay_credit_id, invoice_id, suggested_amount, match_reason}]
```

**Keep `apply_remaining_prepayments()`** as legacy fallback but mark deprecated.

### Test Strategy

- Unit tests for `suggest_prepay_matching()` — SKU match, category match, general fallback
- Unit tests for `apply_prepay_to_invoice()` — insufficient balance, already-applied, period checks
- Unit tests for batch operations — partial success handling
- E2E: Create prepay → create invoice → open workspace → auto-match → adjust → save → verify AR

---

## Migration Safety

All schema changes are **additive** (new columns, new tables, new RPCs). No existing columns are removed or renamed. Rollback = drop the new columns/functions.

**Backfill:**
- Existing prepay_credits get `prepay_type = 'general'` (already the default)
- Existing delivery_items get `tote_number = NULL` (already nullable)
- No data migration needed

---

## Implementation Sequence

1. **Phase 0:** Quick SQL fixes (finance charge + billing split) — 1 migration, ~30 min
2. **Phase 1:** Tote tracking — 1 migration + UI changes to 4 pages — ~1 sprint
3. **Phase 2:** RUP warnings — helper + UI banners on 4 pages — ~0.5 sprint
4. **Phase 3:** Product-specific prepay — schema + 3 RPCs + new workspace UI — ~2-3 sprints

Total estimated effort: ~4-5 sprints
