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

## Phase 3: Bucket-Based Prepay System (Simplified)

### Business Context

CRX growers prepay with checks that the bookkeeper mentally splits into purpose buckets: "Corn Chemical", "Soybean Chemical", "Application", etc. The system should track these **dollar buckets** — not hard-coded product linkages or price locks.

**Key insight:** Prepay just tracks money. Price locks belong on quotes/orders (a separate concern). The prepay system earmarks dollars by label, and the bookkeeper manually applies those dollars to invoices.

### Schema Changes

```sql
-- One new column on prepay_credits: a soft label for the earmark
ALTER TABLE prepay_credits ADD COLUMN bucket_label text;

-- Predefined bucket categories (admin-editable via app_settings)
-- Seeded with: Corn Chemical, Soybean Chemical, Corn Fungicide,
-- Nutritionals, Application, Parts/Service, General
-- Stored as JSON array in app_settings.setting_value
-- where setting_key = 'prepay_bucket_labels'
```

One check creates multiple `prepay_credits` rows:

| reference_number | bucket_label     | original_amount_cents | balance_cents |
|------------------|------------------|-----------------------|---------------|
| Check #4521      | Corn Chemical    | 500000                | 500000        |
| Check #4521      | Soybean Chemical | 300000                | 300000        |
| Check #4521      | Application      | 200000                | 200000        |

### Prepay Creation Workflow (existing page, enhanced)

PrepaymentManager gets a new "Split Check" flow when creating a credit:

1. **Enter check info:** Check # (reference_number), total amount, customer
2. **Split into buckets:** Add rows — each row has a bucket label (dropdown from predefined list) and a dollar amount
3. **Amounts must sum to total:** Validation ensures splits add up to the check total
4. **Save:** Creates one `prepay_credits` row per bucket, all sharing the same `reference_number`

### Prepay Application Workspace (NEW page)

This is the bookkeeper's main workspace for applying prepay dollars to invoices.

**Layout: Split-panel design**

```
┌─────────────────────────────────────────────────────────┐
│  Customer: [Dropdown]                                     │
├──────────────────────────┬──────────────────────────────┤
│  PREPAY BUCKETS          │  UNPAID INVOICES             │
│  (left panel)            │  (right panel)               │
│                          │                              │
│  Check #4521             │  ┌─────────────────────────┐ │
│  ┌─────────────────────┐ │  │ INV-2026-0042  $4,200  │ │
│  │ 🌽 Corn Chemical    │ │  │ Due: Mar 15             │ │
│  │ $5,000 remaining    │ │  │ [Applied: $0]           │ │
│  │ [Apply ▶]           │ │  └─────────────────────────┘ │
│  └─────────────────────┘ │                              │
│  ┌─────────────────────┐ │  ┌─────────────────────────┐ │
│  │ 🫘 Soybean Chemical │ │  │ INV-2026-0043  $1,800  │ │
│  │ $3,000 remaining    │ │  │ Due: Mar 20             │ │
│  │ [Apply ▶]           │ │  │ [Applied: $0]           │ │
│  └─────────────────────┘ │  └─────────────────────────┘ │
│  ┌─────────────────────┐ │                              │
│  │ 🚜 Application      │ │  ┌─────────────────────────┐ │
│  │ $2,000 remaining    │ │  │ INV-2026-0044  $950    │ │
│  │ [Apply ▶]           │ │  │ Due: Apr 1              │ │
│  └─────────────────────┘ │  │ [Applied: $0]           │ │
│                          │  └─────────────────────────┘ │
│  Check #4521: $10,000    │                              │
│  Applied: $0             │  Outstanding: $6,950         │
│  Remaining: $10,000      │                              │
├──────────────────────────┴──────────────────────────────┤
│  [💾 Save Allocations]  [↩ Reset]                       │
└─────────────────────────────────────────────────────────┘
```

**How it works:**

1. **Select customer** from dropdown
2. **Left panel** shows all prepay buckets grouped by check #, with remaining balance
3. **Right panel** shows all unpaid invoices sorted by date
4. **Click "Apply ▶"** on a bucket → enter dollar amount → pick which invoice(s) to apply to
5. **Everything is editable** until "Save Allocations" is clicked
6. **Save Allocations** commits all pending allocations atomically
7. **Reset** clears all pending allocations (nothing committed yet)

**Key UX principles:**
- Fully manual — bookkeeper has 100% control over every dollar
- No auto-matching algorithm — the labels are informational, not enforcement
- Running balances update live as you allocate
- Color coding: green (fully paid), amber (partially paid), red (overdue)
- When a check's buckets all hit $0, it's visually marked as "fully applied"

### Reconciliation View

After allocations are saved, the bookkeeper can see:
- Audit trail: which bucket → which invoice → amount → date → who
- Check summary: Check #4521 → total $10K → $5K corn chem (applied to INV-42, INV-47) → $3K soybean (applied to INV-43) → $2K application (applied to INV-44)
- Customer statement reflects applied prepay as line items
- AR aging excludes prepay-covered portions

### RPC Changes

```sql
-- Apply a specific prepay bucket to a specific invoice (existing pattern, unchanged)
apply_prepay_to_invoice(
  p_prepay_credit_id uuid,
  p_invoice_id uuid,
  p_amount_cents bigint,
  p_performed_by uuid
) RETURNS jsonb

-- Batch apply multiple allocations at once (for Save Allocations button)
batch_apply_prepayments(
  p_allocations jsonb,  -- [{prepay_credit_id, invoice_id, amount_cents}]
  p_performed_by uuid
) RETURNS jsonb
```

**No `suggest_prepay_matching()` needed** — the bookkeeper manually allocates.

**Keep `apply_remaining_prepayments()`** as legacy fallback but mark deprecated.

### What This Does NOT Do

- Does not enforce that "Corn Chemical" bucket can only apply to corn chemical invoices (soft label only)
- Does not lock prices (that's a quote/order concern)
- Does not auto-match — bookkeeper has full manual control
- Does not track product-level inventory linkage (that's the tote/lot system in Phase 1)

### Test Strategy

- Unit tests for `apply_prepay_to_invoice()` — insufficient balance, over-apply, concurrent access
- Unit tests for batch operations — partial success handling, atomic rollback
- E2E: Create check with splits → open workspace → allocate buckets to invoices → save → verify AR

---

## Migration Safety

All schema changes are **additive** (new columns, new tables, new RPCs). No existing columns are removed or renamed. Rollback = drop the new columns/functions.

**Backfill:**
- Existing prepay_credits get `bucket_label = NULL` (treated as "General" / unlabeled)
- Existing delivery_items get `tote_number = NULL` (already nullable)
- No data migration needed

---

## Implementation Sequence

1. **Phase 0:** Quick SQL fixes (finance charge + billing split) — 1 migration, ~30 min
2. **Phase 1:** Tote tracking — 1 migration + UI changes to 4 pages — ~1 sprint
3. **Phase 2:** RUP warnings — helper + UI banners on 4 pages — ~0.5 sprint
4. **Phase 3:** Bucket-based prepay — 1 column + seed data + 2 RPCs + workspace UI — ~1-1.5 sprints

Total estimated effort: ~3-4 sprints
