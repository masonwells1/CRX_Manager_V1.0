# Earmarked Prepayment System — Implementation Plan

**Status:** PLAN ONLY — Do not implement without explicit instruction
**Date:** 2026-02-24 (v3 FINAL — all owner decisions incorporated)
**Problem:** Prepayments are a generic money pool. Customer pays $50,000 for chemical but the system blindly applies it to the oldest invoice — which might be a sprayer application. No earmarking, no admin control, no customer visibility.

---

## Owner Decisions (Locked In)

These were decided by the owner and are final:

1. **Three buckets:** Chemical, Fertilizer, and **General** (multi-use / "don't care")
2. **No crop tags** — dropped for simplicity. Buckets only. Can revisit later if needed.
3. **Cross-bucket override allowed:** Admin CAN apply Chemical prepay to a Fertilizer invoice (or vice versa, or to application). Requires explicit override confirmation with reason. Strong audit trail — the original check number always stays linked to what invoice it actually got applied against.
4. **Mixed invoices:** System suggests bucket-matched portions by default, but admin can override to apply any prepay to any invoice portion — including application.
5. **Manual application only** — system suggests, admin confirms. No auto-apply.
6. **Standalone prepay history report page** — all customers, filterable by date/customer/check #/bucket. Also viewable per-customer on their detail page.
7. **Configurable override alert threshold** — admin sets a dollar amount in Settings. Overrides above that threshold send notifications to all admins.

---

## Design Goals

1. **Earmark prepayments** by bucket (Chemical / Fertilizer / General)
2. **Manual application with suggestions** — system proposes matches, admin confirms
3. **Override flexibility** — admin can cross buckets when needed, with audit trail + notifications
4. **Full traceability** — check number / reference always tied to what invoice it was applied against
5. **Customer visibility** — statements clearly show where prepay money went
6. **Simple to administer** — minimal clicks for the 80% common case

---

## How It Works (Plain English)

### The Three Buckets

| Bucket | What it covers | Example products |
|--------|---------------|-----------------|
| **Chemical** | Herbicides, insecticides, fungicides, adjuvants | Roundup, Warrant, Authority, crop oil |
| **Fertilizer** | Dry/liquid fertilizers, micronutrients, lime | 28-0-0, MAP, potash, zinc sulfate |
| **General** | Anything — customer doesn't care or hasn't decided | "Just put $20K on the books" |

**General** is the "I don't care" bucket. It matches against ANY invoice (chemical, fertilizer, or even application). It gets suggested last — after bucket-specific credits are used up.

### Recording a Prepayment
Admin records a $50,000 prepayment for a customer. A dropdown asks:
- **Bucket:** Chemical, Fertilizer, or General (required)
- **Payment method + reference #:** (existing — e.g., "Check #4521")
- **Notes:** free text (e.g., "Spring herbicide program")

This creates an earmarked credit: "$50,000 — Chemical (Check #4521)"

### Matching to Invoices (Suggestion Engine)
Every product in the catalog gets a **prepay bucket** field: `chemical`, `fertilizer`, or `none`.

When the system suggests applications for a customer:
1. It breaks down each unpaid invoice by bucket: "INV-0045 has $4,200 chemical + $1,800 fertilizer + $500 application"
2. It matches earmarked credits to invoice portions using priority rules (see below)
3. It presents all suggestions to the admin for review

### Priority Rules for Suggestions

| Priority | Rule | Example |
|----------|------|---------|
| 1 | Chemical credit → chemical portion of invoice | Chemical credit → $4,200 chemical products on INV-0045 |
| 2 | Fertilizer credit → fertilizer portion of invoice | Fertilizer credit → $1,800 fertilizer products on INV-0051 |
| 3 | General credit → any invoice portion | General credit → any unpaid amount on any invoice |
| — | Within each priority: oldest invoices first (FIFO) | |

**The system NEVER auto-suggests cross-bucket matches** (e.g., Chemical credit → Fertilizer invoice portion). Cross-bucket is admin-only override territory.

### Applying Prepay (the new flow)
1. Admin opens "Apply Prepay" for a customer
2. System shows the customer's earmarked credits with remaining balances
3. System shows unpaid invoices with a breakdown by bucket
4. System **suggests** matches using the priority rules above
5. Admin reviews each suggestion — can accept, adjust the amount, or skip
6. Admin can also **manually add** an application that wasn't suggested (including cross-bucket overrides)
7. Cross-bucket applications show a yellow warning: "This crosses earmark boundaries (Chemical → Fertilizer). Reason required."
8. Admin clicks **Confirm** — only then does the money move
9. Each application is logged in the audit trail with: credit details (check #, earmark), invoice #, amount, whether it was an override, and override reason if applicable
10. If any override exceeds the configurable threshold, notifications are sent to all admins

### The Override Flow

When admin wants to apply Chemical prepay to a Fertilizer invoice (or any cross-bucket):

```
┌────────────────────────────────────────────────────────┐
│ ⚠ Earmark Override                                     │
│                                                        │
│ You are applying a Chemical credit (Check #4521)       │
│ to INV-2026-0051 which contains Fertilizer products.   │
│                                                        │
│ Override reason: [Customer requested reallocation    ▼] │
│                                                        │
│ Options:                                               │
│   • Customer requested reallocation                    │
│   • Insufficient funds in correct bucket               │
│   • Season-end cleanup                                 │
│   • Other (free text)                                  │
│                                                        │
│                         [Cancel]  [Confirm Override]    │
└────────────────────────────────────────────────────────┘
```

The override reason is stored in the audit trail. The original check # stays linked. Anyone reviewing later can see: "Check #4521 was earmarked Chemical but was applied to Fertilizer INV-2026-0051 because: Customer requested reallocation."

If the override amount exceeds the configured threshold (e.g., $5,000), all admin users receive an in-app notification: "Prepay override: $8,500 Chemical → Fertilizer on ACME Farms by [user]. Reason: Customer requested reallocation."

### What the Customer Sees (Statements)
```
INVOICE    DESCRIPTION              AMOUNT     PREPAY APPLIED            BALANCE
INV-0045   Order #1234 (Chemical)   $4,200.00  -$4,200.00 (Chemical)     $0.00
INV-0051   Order #1240 (Fertilizer) $8,500.00  -$8,500.00 (Fertilizer)   $0.00
INV-0053   Application Service      $2,000.00                            $2,000.00

PREPAY BALANCES:
  Chemical:     $37,300.00 remaining  (Check #4521)
  General:      $20,000.00 remaining  (Check #4600)
  ────────────────────
  Total Available:     $57,300.00
```

Customer can clearly see: their chemical prepay only went toward chemical invoices, and the application invoice is untouched.

### Audit Trail Detail

Every prepay application records:
- **Credit source:** credit ID, earmark bucket, payment method, reference # (check #)
- **Invoice target:** invoice ID, invoice number
- **Amount applied** (cents)
- **Was this an override?** (boolean)
- **Override reason** (text, only if override)
- **Applied by** (admin user ID)
- **Applied at** (timestamp)
- **Earmark label snapshot** (e.g., "Chemical (Check #4521)")

This means you can always answer: "Where did Check #4521 end up?" → query prepay_applications by credit_id and see every invoice it was applied against.

---

## Schema Changes

### 1. New migration: Add `prepay_bucket` to products

```sql
-- Every product gets classified for prepay matching
ALTER TABLE products ADD COLUMN IF NOT EXISTS
  prepay_bucket text CHECK (prepay_bucket IN ('chemical', 'fertilizer', 'none'))
  DEFAULT 'none';

COMMENT ON COLUMN products.prepay_bucket IS
  'Which prepay earmark bucket this product draws from. "none" means prepay will not auto-suggest for this product (can still be overridden).';
```

**Why `none` as default?** Safe — new products won't accidentally drain prepay until admin explicitly classifies them. Existing products all start as `none` and need a one-time classification pass (bulk action on Products page makes this fast).

### 2. New migration: Add earmark columns to `prepay_credits`

```sql
ALTER TABLE prepay_credits ADD COLUMN IF NOT EXISTS
  earmark_bucket text NOT NULL DEFAULT 'general'
  CHECK (earmark_bucket IN ('chemical', 'fertilizer', 'general'));

COMMENT ON COLUMN prepay_credits.earmark_bucket IS
  'Required: which product bucket this prepay is earmarked for. "general" = multi-use / no preference.';
```

**Note:** Default is `general` so any existing prepay credits (pre-earmarking) become "General" — safe, since General matches everything. No admin action needed for old credits unless they want to tighten earmarks.

### 3. New migration: Enhance `prepay_applications` for audit trail

```sql
-- Richer audit trail on every prepay application
ALTER TABLE prepay_applications ADD COLUMN IF NOT EXISTS
  earmark_label text DEFAULT NULL;

ALTER TABLE prepay_applications ADD COLUMN IF NOT EXISTS
  source_reference_number text DEFAULT NULL;

ALTER TABLE prepay_applications ADD COLUMN IF NOT EXISTS
  source_payment_method text DEFAULT NULL;

ALTER TABLE prepay_applications ADD COLUMN IF NOT EXISTS
  is_override boolean NOT NULL DEFAULT false;

ALTER TABLE prepay_applications ADD COLUMN IF NOT EXISTS
  override_reason text DEFAULT NULL;

COMMENT ON COLUMN prepay_applications.earmark_label IS
  'Snapshot of earmark at application time, e.g. "Chemical (Check #4521)".';
COMMENT ON COLUMN prepay_applications.source_reference_number IS
  'Snapshot of the original prepay check #/reference at time of application. For traceability.';
COMMENT ON COLUMN prepay_applications.source_payment_method IS
  'Snapshot of the original payment method (check, wire, cash, etc.).';
COMMENT ON COLUMN prepay_applications.is_override IS
  'True if this application crossed earmark boundaries (e.g., Chemical credit applied to Fertilizer invoice).';
COMMENT ON COLUMN prepay_applications.override_reason IS
  'Required when is_override = true. Why the earmark was overridden.';
```

### 4. App setting: Override reasons + alert threshold

```sql
INSERT INTO app_settings (setting_key, setting_value)
VALUES ('prepay_override_reasons', '["Customer requested reallocation","Insufficient funds in correct bucket","Season-end cleanup","Other"]')
ON CONFLICT (setting_key) DO NOTHING;

INSERT INTO app_settings (setting_key, setting_value)
VALUES ('prepay_override_alert_threshold_cents', '500000')
ON CONFLICT (setting_key) DO NOTHING;
```

Admin can edit both in Settings. Threshold defaults to $5,000 (500000 cents).

### 5. New migration: Invoice-level prepay tracking columns

```sql
-- Track how much prepay was applied per bucket on each invoice
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS
  prepay_applied_chemical_cents bigint NOT NULL DEFAULT 0;

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS
  prepay_applied_fertilizer_cents bigint NOT NULL DEFAULT 0;

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS
  prepay_applied_general_cents bigint NOT NULL DEFAULT 0;
```

Existing `prepay_applied_cents` stays for backward compat — recalculated as sum of all three.

---

## New RPC: `suggest_prepay_applications(p_customer_id uuid)`

**What it does:** Analyzes a customer's earmarked credits and unpaid invoices, returns suggested matches. Read-only — does NOT apply anything.

**Logic:**
1. Fetch all prepay credits for customer where `balance_cents > 0`, ordered by earmark_bucket (chemical first, then fertilizer, then general last)
2. Fetch all posted invoices where `balance_cents > 0` and `status != 'void'`
3. For each invoice, calculate the **bucket breakdown**:
   - Join `invoice_items` → `products` to sum line totals by `prepay_bucket`
   - Also calculate the "none" portion (products with `prepay_bucket = 'none'`)
   - Subtract any already-applied prepay per bucket
   - Result: "INV-0045 has $4,200 eligible-chemical, $1,800 eligible-fertilizer, $500 none-bucket"
4. Match credits to invoices:
   - Chemical credits → chemical portions of invoices, oldest first
   - Fertilizer credits → fertilizer portions of invoices, oldest first
   - General credits → any remaining uncovered portion on any invoice, oldest first
   - **Never suggest cross-bucket** (Chemical → Fertilizer). That's admin override only.
5. Return array of suggestions:
   ```json
   [
     {
       "credit_id": "uuid",
       "credit_label": "Chemical (Check #4521, $45,800 remaining)",
       "credit_bucket": "chemical",
       "credit_reference": "Check #4521",
       "invoice_id": "uuid",
       "invoice_number": "INV-2026-0045",
       "invoice_date": "2026-03-15",
       "eligible_amount_cents": 420000,
       "suggested_amount_cents": 420000,
       "match_type": "bucket_match",
       "target_bucket": "chemical",
       "is_override": false
     }
   ]
   ```

**Important:** This RPC is read-only. It suggests — it does NOT apply.

---

## New RPC: `apply_prepay_manual(p_applications jsonb)`

**What it does:** Takes admin-confirmed applications and executes them in a single transaction.

**Input format:**
```json
[
  {
    "credit_id": "uuid",
    "invoice_id": "uuid",
    "amount_cents": 420000,
    "is_override": false,
    "override_reason": null
  },
  {
    "credit_id": "uuid",
    "invoice_id": "uuid",
    "amount_cents": 850000,
    "is_override": true,
    "override_reason": "Customer requested reallocation"
  }
]
```

**Logic (inside a transaction):**
1. Lock relevant prepay_credits and invoices with `FOR UPDATE`
2. For each application:
   - Validate credit has sufficient `balance_cents`
   - Validate invoice has sufficient `balance_cents`
   - If NOT override: validate the invoice has matching bucket products with sufficient uncovered amount
   - If IS override: validate `override_reason` is not null/empty
   - Snapshot the credit's reference_number, payment_method, earmark label
   - Insert into `prepay_applications` with all audit fields
   - Decrement `prepay_credits.balance_cents`
   - Update invoice: decrement `balance_cents`, increment appropriate `prepay_applied_*_cents` column
   - Insert into `financial_audit_log` with old_data/new_data capturing the full change
3. Update `customers.prepay_balance_cents` (recalculate from sum of credits)
4. For each override application: check if `amount_cents` exceeds the `prepay_override_alert_threshold_cents` setting. If so, insert a notification for every admin user.
5. Return summary: `{ applied_count, total_applied_cents, credits_remaining, overrides_count }`

**Safety:** If any single application fails validation, the entire batch rolls back.

---

## Modified RPC: `allocate_payment()` Update

When a payment has leftover after invoice allocation (creating a prepay credit), the RPC now accepts an earmark parameter:

```sql
p_earmark_bucket text DEFAULT 'general'
```

Default is `general` so existing behavior doesn't break — unearmarked leftovers become General credits.

---

## Deprecate: `apply_remaining_prepayments()`

The old auto-apply RPC stays in the database (don't delete migrations) but is no longer called from the UI. All prepay application goes through the new manual suggestion → confirm flow.

---

## UI Changes

### 1. Products: Add Prepay Bucket Field

**File:** `src/pages/ProductDetail.tsx`

Add a dropdown to the product edit form (admin only):
```
Prepay Bucket: [Chemical ▼] [Fertilizer] [None]
```
- Default: `none`
- Inline help: "Which prepay earmark can cover this product? 'None' for services and application fees."

**File:** `src/pages/Products.tsx`
- Add "Prepay Bucket" column to the product table (filterable)
- Add bulk action: "Set Prepay Bucket" to classify multiple products at once
  - Important for initial setup — don't want admin clicking 200 products one by one
  - Modal: select products → pick bucket → confirm → bulk update

### 2. PrepaymentManager: Complete Overhaul

**File:** `src/pages/PrepaymentManager.tsx`

**Recording a prepayment (top section):**
- Customer dropdown (existing)
- Amount (existing)
- Payment method + reference # (existing)
- **NEW:** Earmark Bucket: Chemical | Fertilizer | General (required, default General)
- **NEW:** Notes (existing, but placeholder: "e.g., Spring herbicide program")

**Customer prepay dashboard (main section):**
Replace current simple list with a richer card-per-customer view:

```
┌──────────────────────────────────────────────────────────────┐
│ ACME Farms                                                   │
│                                                              │
│  Chemical:   $45,800.00  (Check #4521, 01/15/26)            │
│  Chemical:    $5,000.00  (Wire #W-889, 02/01/26)            │
│  Fertilizer: $12,000.00  (Check #4590, 01/20/26)            │
│  General:    $20,000.00  (Check #4600, 02/10/26)            │
│  ──────────────────────────────────                          │
│  Total Prepay Balance: $82,800.00                            │
│                                                              │
│  [Apply Prepay →]                                            │
└──────────────────────────────────────────────────────────────┘
```

Each credit row expandable to show: original amount, date, payment method, reference #, notes, application history (what invoices this specific credit has already been applied to).

**"Apply Prepay" flow (new modal — large size):**

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Apply Prepay — ACME Farms                                                │
│                                                                          │
│ AVAILABLE CREDITS                                                        │
│  Chemical:   $45,800.00  (Check #4521)                                  │
│  Fertilizer: $12,000.00  (Check #4590)                                  │
│  General:    $20,000.00  (Check #4600)                                  │
│                                                                          │
│ ─────────────────────────────────────────────────────────────────────    │
│                                                                          │
│ SUGGESTED APPLICATIONS                           (system-generated)      │
│                                                                          │
│ ☑ $4,200.00  Chemical (Chk #4521) → INV-0045 (chemical products)       │
│              ✓ Bucket match                                              │
│                                                                          │
│ ☑ $3,100.00  Chemical (Chk #4521) → INV-0052 (chemical products)       │
│              ✓ Bucket match                                              │
│                                                                          │
│ ☑ $8,500.00  Fertilizer (Chk #4590) → INV-0051 (fertilizer products)   │
│              ✓ Bucket match                                              │
│                                                                          │
│ ☑ $2,000.00  General (Chk #4600) → INV-0053 (application service)      │
│              ○ General credit (matches anything)                         │
│                                                                          │
│ [+ Add Manual Application]   ← for overrides / custom applications      │
│                                                                          │
│ ─────────────────────────────────────────────────────────────────────    │
│ Total to apply: $17,800.00                                               │
│                                                                          │
│                                       [Cancel]  [Confirm Applications]   │
└──────────────────────────────────────────────────────────────────────────┘
```

- Each suggestion row has: checkbox, editable amount, credit label with check #, invoice #, match indicator
- Suggestions are pre-checked, admin can uncheck any
- Amount fields are editable (partial application)
- **"+ Add Manual Application"** button opens a row where admin picks any credit + any invoice + amount
  - If the credit bucket doesn't match the invoice products → override warning appears inline
  - Override requires selecting a reason from dropdown (or "Other" with free text)
- Match quality indicators: ✓ = bucket match, ○ = general, ⚠ = override

**"+ Add Manual Application" inline row:**
```
│ Credit: [Chemical (Chk #4521) ▼]  Invoice: [INV-0060 ▼]  Amount: [$___]       │
│ ⚠ Override: Chemical credit → Application invoice                               │
│ Reason: [Customer requested reallocation ▼]                     [Add] [Cancel]  │
```

### 3. Prepay Application History (NEW PAGE)

**New file:** `src/pages/PrepayApplicationHistory.tsx`
**Route:** `/prepay-history`

A standalone report page showing all prepay applications across all customers. Filterable and searchable.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ Prepay Application History                                    [CSV] [PDF]    │
│                                                                              │
│ Filters: [Customer ▼] [Date Range] [Bucket ▼] [Check # ___] [Overrides ▼]  │
│                                                                              │
│ DATE       CUSTOMER     CHECK #   BUCKET      INVOICE    AMOUNT     OVER?   │
│ ────────── ──────────── ──────── ─────────── ────────── ────────── ──────   │
│ 02/15/26   ACME Farms   #4521    Chemical     INV-0045   $4,200.00  No      │
│ 02/15/26   ACME Farms   #4521    Chemical     INV-0052   $3,100.00  No      │
│ 02/16/26   ACME Farms   #4590    Fertilizer   INV-0051   $8,500.00  No      │
│ 02/16/26   ACME Farms   #4600    General      INV-0053   $2,000.00  No      │
│ 02/18/26   Smith Ranch  #3200    Chemical→Fert INV-0070  $6,000.00  Yes ⚠   │
│            Override reason: Customer requested reallocation                   │
│ ...                                                                          │
│                                                                              │
│ Showing 42 applications | Total applied: $187,400.00 | 3 overrides          │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Key features:**
- **Filter by customer** — dropdown of all customers with prepay history
- **Filter by date range** — from/to date pickers
- **Filter by bucket** — Chemical / Fertilizer / General / All
- **Search by check #** — text input, answers "where did Check #4521 go?"
- **Filter by overrides** — All / Overrides only / Non-overrides only
- Override rows highlighted with ⚠ and expandable to show override reason
- CSV + PDF export
- Summary footer: total applications, total applied, override count

**Navigation:** Add to sidebar under "AR & Finance" section, below Prepayments.

### 4. Statement PDF: Show Prepay Detail

**File:** `src/lib/statementPdf.ts`

When prepay was applied to an invoice, show a sub-line below the invoice:
```
  Prepay Applied — Chemical (Check #4521):  -$4,200.00
```

At the bottom of the statement, add a **Prepay Balances** section:
```
PREPAY CREDIT BALANCES:
  Chemical (Check #4521):     $37,300.00 remaining
  General (Check #4600):      $18,000.00 remaining
  ─────────────────────────────────
  Total Available:            $55,300.00
```

### 5. Customer Detail: Earmarked Balance Breakdown

**File:** `src/pages/CustomerDetail.tsx`

Replace the single "Prepay Balance: $X" with a breakdown card:
```
Prepay Balances
  Chemical:   $50,800.00  (2 credits)
  Fertilizer: $12,000.00  (1 credit)
  General:    $20,000.00  (1 credit)
  ─────────────────────
  Total:      $82,800.00

  [Apply Prepay →]  [View History]
```

Expandable to see individual credits with check #, date, original amount, remaining balance.

"View History" links to the Prepay Application History page filtered to this customer.

### 6. Settings: Override Reasons + Alert Threshold

**File:** `src/pages/SettingsPage.tsx`

New "Prepay Settings" section:
- **Override Reasons:** Add/remove reasons that appear in the override dropdown
- **Override Alert Threshold:** Dollar amount input (e.g., $5,000). Overrides above this amount trigger notifications to all admins. Set to $0 to alert on every override.

Both stored in `app_settings`.

---

## TypeScript Changes

### `src/types/index.ts`

```typescript
// Update Product interface
export interface Product {
  // ... existing fields ...
  prepay_bucket: 'chemical' | 'fertilizer' | 'none' | null;
}

// Update PrepayCredit interface
export interface PrepayCredit {
  // ... existing fields ...
  earmark_bucket: 'chemical' | 'fertilizer' | 'general';
}

// Update PrepayApplication interface
export interface PrepayApplication {
  // ... existing fields ...
  earmark_label: string | null;
  source_reference_number: string | null;
  source_payment_method: string | null;
  is_override: boolean;
  override_reason: string | null;
}

// New type for suggestion results
export interface PrepayApplicationSuggestion {
  credit_id: string;
  credit_label: string;
  credit_bucket: 'chemical' | 'fertilizer' | 'general';
  credit_reference: string | null;
  invoice_id: string;
  invoice_number: string;
  invoice_date: string;
  eligible_amount_cents: number;
  suggested_amount_cents: number;
  match_type: 'bucket_match' | 'general';
  target_bucket: 'chemical' | 'fertilizer' | 'none';
  is_override: boolean;
}
```

---

## Migration Data Backfill Strategy

### Existing prepay credits → default to `general`
The migration defaults `earmark_bucket` to `'general'`. This means all pre-existing credits automatically become "General" — which matches everything, so existing behavior is preserved. Admin can optionally re-earmark them if they want tighter control.

### Existing products → default to `none`
All products start as `prepay_bucket = 'none'`. Admin uses the bulk "Set Prepay Bucket" action on the Products page to classify them. This is a one-time setup task. Until products are classified, the suggestion engine won't suggest anything for bucket-specific credits (safe default). General credits can still be manually applied.

### First-time setup banner
Show a banner on the PrepaymentManager page when products haven't been classified:
> "X products have no prepay bucket assigned. Suggestions will be limited until products are classified. [Go to Products →]"

---

## Matching Priority Rules (Final)

### For Chemical and Fertilizer credits:
| Priority | Condition | Auto-suggested? |
|----------|-----------|----------------|
| 1 | Credit bucket matches invoice line item bucket | Yes |
| 2 | Cross-bucket (e.g., Chemical credit → Fertilizer invoice) | **No — manual override only** |

### For General credits:
| Priority | Condition | Auto-suggested? |
|----------|-----------|----------------|
| 1 | Any unpaid invoice, any bucket (chemical/fertilizer/none) | Yes |
| — | Suggested AFTER bucket-specific credits are exhausted | |

### Within each priority:
- Oldest invoices first (FIFO by invoice_date)

### Override rules:
- Any credit can be applied to any invoice via manual override
- Override requires a reason (from configurable dropdown in Settings)
- Override is flagged in audit trail (`is_override = true`)
- Original check # / reference always preserved in snapshot fields
- Overrides exceeding configurable threshold trigger admin notifications

---

## What This Does NOT Change

- Payment recording flow (payments still work the same)
- Invoice creation flow (invoices still created from orders/deliveries)
- AR aging calculations (still based on invoice balance_cents)
- Month-end close process
- Commission calculations
- Delivery workflow
- Existing `prepay_credits` rows (they become "General" automatically)

---

## New Page Added

| Route | Page | Description |
|-------|------|-------------|
| `/prepay-history` | PrepayApplicationHistory | All prepay applications across all customers. Filter by customer, date, bucket, check #, overrides. CSV/PDF export. |

---

## Files to Modify (Summary)

| File | Change |
|------|--------|
| New migration | `prepay_bucket` on products, `earmark_bucket` on `prepay_credits`, audit columns on `prepay_applications`, `prepay_applied_*_cents` on invoices, app_settings |
| New migration | `suggest_prepay_applications()` RPC |
| New migration | `apply_prepay_manual()` RPC |
| New migration | Update `allocate_payment()` to accept earmark param |
| `src/types/index.ts` | Update Product, PrepayCredit, PrepayApplication interfaces; add PrepayApplicationSuggestion |
| `src/pages/ProductDetail.tsx` | Add prepay bucket dropdown |
| `src/pages/Products.tsx` | Add prepay bucket column + bulk "Set Prepay Bucket" action |
| `src/pages/PrepaymentManager.tsx` | Major overhaul — earmark recording, dashboard, suggestion modal with override support |
| `src/pages/PaymentAllocation.tsx` | Add earmark bucket when creating prepay from remainder |
| **NEW** `src/pages/PrepayApplicationHistory.tsx` | Standalone prepay history report page |
| `src/pages/CustomerDetail.tsx` | Earmarked balance breakdown card + link to history |
| `src/pages/SettingsPage.tsx` | Override reasons + alert threshold management |
| `src/lib/statementPdf.ts` | Show prepay detail lines with check # + earmark labels, balance breakdown |
| `src/App.tsx` | Add lazy route for `/prepay-history` |
| `src/components/layout/AppLayout.tsx` | Add sidebar link for Prepay History |
| Unit tests | Suggestion logic, manual application, override validation, bucket matching, General credit handling, alert threshold |
| E2E tests | Earmarked prepay end-to-end flow including override + notification scenario |

---

## Test Plan

### Unit Tests
- `suggest_prepay_applications` returns correct matches by bucket
- Chemical credits only match chemical product portions of invoices
- Fertilizer credits only match fertilizer product portions of invoices
- General credits match any portion (chemical, fertilizer, or none-bucket)
- General credits are suggested AFTER bucket-specific credits are exhausted
- `apply_prepay_manual` validates bucket matching for non-override applications
- `apply_prepay_manual` requires override_reason when is_override = true
- `apply_prepay_manual` rolls back entire batch on single failure
- Override: Chemical credit successfully applied to Fertilizer invoice line items
- Override: any credit applied to application/service ("none" bucket) products
- Partial amount application works correctly
- Source reference # snapshot is captured from original credit
- Invoice `prepay_applied_*_cents` columns updated correctly per bucket
- Earmark label snapshot format is correct
- Existing credits default to "general" and match everything
- Override notification sent when amount exceeds threshold
- Override notification NOT sent when amount is below threshold
- Override notification sent to ALL admin users

### E2E Tests
- Record earmarked prepayment (Chemical) → verify it shows in customer dashboard
- Apply prepay via suggestion flow → verify invoice balance updated, credit decremented
- Apply prepay with override → verify warning shown, reason required, audit logged
- General prepay applied to application service invoice
- Verify statement PDF shows prepay detail lines with check # and earmark labels
- Bulk product classification via "Set Prepay Bucket" action
- First-time setup banner appears when products unclassified
- Prepay Application History page: filter by customer, check #, overrides
- Override alert threshold triggers notification

---

## No Open Questions

All owner decisions have been incorporated. This plan is ready for implementation.
