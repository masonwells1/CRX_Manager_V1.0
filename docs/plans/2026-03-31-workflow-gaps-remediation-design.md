# Workflow Gaps Remediation — Design Document

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Date:** 2026-03-31
**Status:** Approved
**Priority:** Season-critical — all 4 pillars needed before field season

---

## Problem Statement

Deep audit of CRX Manager against Agvance/SSI, Agworld, and AGRIS revealed 8 broken data connections and multiple feature gaps across the job scheduling, blend ticket, field, and billing workflows. The 4 most critical issues are:

1. **Blend ticket → invoice requires 3 manual steps** (should be one click)
2. **Field billing splits are captured but never flow to invoices**
3. **No map-based dispatch view for job scheduling**
4. **8 broken data connections where data is captured but doesn't flow downstream**

## Goals

1. One-click "Create Invoice" from approved blend ticket
2. Field billing splits auto-propagate through quote → order → invoice chain
3. Map-based dispatch view for job scheduling with applicator assignment
4. Fix all 8 broken connections (B1-B8 from gap analysis)

## Non-Goals (Deferred)

- Real-time GPS/telematics for applicators
- Soil test integration
- CLU/PLSS boundary import
- Weather station auto-capture
- Regulatory compliance document generation (1206 forms)

---

## Pillar 1: One-Click Blend Ticket → Invoice

### Problem
`invoices.blend_ticket_id` column exists but is never populated. No RPC creates an invoice directly from a blend ticket. Users must: (1) create an order, (2) link the ticket to the order, (3) create invoice from order. Agvance does this in one step.

### Solution

**New RPC: `create_invoice_from_blend_ticket()`**
- Takes: `p_blend_ticket_id`, `p_created_by`, `p_idempotency_key`
- Validates: ticket must be approved (`review_status = 'approved'`)
- Creates invoice with `blend_ticket_id` set, `order_id` null
- Creates invoice_items from `blend_ticket_products`:
  - Looks up each product's current tier price for the ticket's customer
  - Looks up each product's current cost
  - Creates invoice_item with unit_price_cents, cost_cents, quantity
- Auto-sets `blend_tickets.payment_status = 'billed'`
- Returns invoice_id

**Add `unit_cost_cents` + `unit_price_cents` to `blend_ticket_products`**
- Snapshot cost/price at ticket creation or approval time
- Used as source of truth for invoice creation (not current product price)

**UI: "Create Invoice" button on BlendTicketDetail.tsx**
- Visible when: `review_status = 'approved'` AND `payment_status != 'billed'`
- Calls RPC, navigates to new invoice detail page
- Shows confirmation with product/price summary before creating

**Auto-sync `payment_status`:**
- Trigger: when invoice with `blend_ticket_id` is created, set ticket `payment_status = 'billed'`
- Trigger: when invoice with `blend_ticket_id` is voided, set ticket `payment_status = 'unbilled'`

### Database Changes

```sql
-- Add cost/price columns to blend_ticket_products
ALTER TABLE blend_ticket_products
  ADD COLUMN unit_cost_cents bigint,
  ADD COLUMN unit_price_cents bigint;

-- New RPC
CREATE FUNCTION create_invoice_from_blend_ticket(
  p_blend_ticket_id uuid,
  p_created_by uuid,
  p_idempotency_key text DEFAULT NULL
) RETURNS uuid  -- returns invoice_id
```

### Files to Modify
- New migration SQL
- `src/pages/BlendTicketDetail.tsx` — add "Create Invoice" button
- `src/types/index.ts` — update BlendTicketProduct type

---

## Pillar 2: Field Billing Splits → Auto-Invoice

### Problem
`field_billing_defaults` stores multi-customer splits (e.g., 60% tenant / 40% landlord) but `create_invoice_from_order()` and `create_invoice_from_delivery()` always invoice 100% to the order's customer. Manual order/invoice shares are the only workaround.

### Solution

**Approach: Auto-generate split invoices at invoice creation time**

When `create_invoice_from_order()` or `create_invoice_from_blend_ticket()` runs:
1. Check if order/ticket references any fields with billing splits
2. If splits exist, create multiple invoices:
   - Primary invoice → primary billing customer (largest split %)
   - Secondary invoice(s) → each secondary customer
   - Each invoice's line items proportioned by split %
   - All invoices linked via `invoice_group_id` (new column)
3. If no splits, create single invoice as today (backward compatible)

**Field → Invoice connection:**
- Jobs have `job_fields` (field_id) — fields are known
- Blend tickets have `blend_ticket_fields` (field_id) — fields are known
- Orders linked to jobs/blend tickets inherit field context
- Quote sections can optionally reference a field (new `field_id` column on `quote_sections`)

**New column: `invoices.invoice_group_id`**
- Groups split invoices together
- Allows viewing "this invoice is part of a 60/40 split with invoice #INV-2024-0456"

**New column: `quote_sections.field_id`**
- Links quote sections to fields
- Enables field billing splits to flow from quote → order → invoice

### Database Changes

```sql
-- Link quotes to fields
ALTER TABLE quote_sections ADD COLUMN field_id uuid REFERENCES fields(id);

-- Group split invoices
ALTER TABLE invoices ADD COLUMN invoice_group_id uuid;
CREATE INDEX idx_invoices_group ON invoices(invoice_group_id) WHERE invoice_group_id IS NOT NULL;

-- Update create_invoice_from_order to check field billing splits
-- Update create_invoice_from_blend_ticket to check field billing splits
```

### Files to Modify
- Migration SQL (schema + RPC updates)
- `src/pages/QuoteBuilder.tsx` — field selector on sections
- `src/pages/InvoiceDetail.tsx` — show "split group" link when part of group
- `src/types/index.ts` — update QuoteSection, Invoice types

---

## Pillar 3: Map-Based Dispatch View

### Problem
No dispatch view exists. Dispatchers manage jobs from a flat list in Jobs.tsx. Agvance SKY Dispatch has a dual-screen map+list view with applicator assignment, filtering by status/location/applicator, and real-time tracking.

### Solution

**New page: `/dispatch` (DispatchBoard.tsx)**

**Layout:** Split-screen — map on left (60%), job list on right (40%)

**Map Panel:**
- CRXMap with all pending/in-progress job field boundaries highlighted
- Color-coded by status: pending=yellow, assigned=blue, in-progress=green, completed=gray
- Click job polygon → show popup with job details + assign button
- Applicator markers showing their assigned job locations

**List Panel:**
- Filterable by: status, date range, applicator, customer, crop type
- Sortable by: date, customer, acres, priority
- Drag-to-assign: drag job to applicator in sidebar
- Quick actions: assign, start, complete, reschedule

**Job Status Flow for Dispatch:**
```
pending → assigned → in_progress → completed
                  ↗ (dispatcher assigns)
```

**Applicator Sidebar:**
- List of active applicators/drivers (from profiles where role = 'applicator')
- Each shows: name, current assignment (if any), total acres today
- Click applicator → highlight their assigned jobs on map

**New columns needed:**
```sql
ALTER TABLE jobs ADD COLUMN assigned_to uuid REFERENCES profiles(id);
ALTER TABLE jobs ADD COLUMN priority text DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent'));
ALTER TABLE jobs ADD COLUMN scheduled_date date;
ALTER TABLE jobs ADD COLUMN estimated_hours numeric(5,2);
```

### Files to Create
- `src/pages/DispatchBoard.tsx` — new page (~400-500 lines)
- `src/components/dispatch/DispatchJobCard.tsx` — job card for list panel
- `src/components/dispatch/ApplicatorSidebar.tsx` — applicator list
- `src/components/map/JobBoundaryLayer.tsx` — map layer for job fields

### Files to Modify
- `src/App.tsx` — add `/dispatch` route
- `src/components/layout/Sidebar.tsx` — add Dispatch nav link under Operations
- Migration SQL (new columns + RPC)

---

## Pillar 4: Fix All 8 Broken Connections

### B1: Field billing splits → invoices (covered in Pillar 2)

### B2: Blend ticket → invoice direct path (covered in Pillar 1)

### B3: Blend ticket products have no cost/price (covered in Pillar 1)

### B4: Payment status auto-sync (covered in Pillar 1)

### B5: Blend ticket multi-field application records

**Fix:** Update `create_application_record_from_blend_ticket()` to:
- Query `blend_ticket_fields` (not just `blend_tickets.field_id`)
- Create one application_record PER field in blend_ticket_fields
- If no blend_ticket_fields rows, fall back to blend_tickets.field_id

```sql
-- Updated RPC creates multiple app records (one per field)
CREATE OR REPLACE FUNCTION create_application_record_from_blend_ticket(
  p_blend_ticket_id uuid,
  p_performed_by uuid
) RETURNS uuid[]  -- returns array of app record IDs
```

### B6: Job number on blend tickets is text, not FK

**Fix:** Add `job_id` column alongside existing `job_number` text field:

```sql
ALTER TABLE blend_tickets ADD COLUMN job_id uuid REFERENCES jobs(id);
CREATE INDEX idx_blend_tickets_job ON blend_tickets(job_id) WHERE job_id IS NOT NULL;
```

- OCR still populates `job_number` (text) for display
- When user reviews/approves, they can link to actual job via dropdown
- UI shows job selector with autocomplete from job_number text

### B7: Commission records not voided when order voided

**Fix:** Add cascade logic to `void_order()` and `cancel_order()` RPCs:

```sql
-- Inside void_order / cancel_order:
UPDATE commissions SET status = 'cancelled', updated_at = now()
WHERE order_id = p_order_id AND status = 'pending';

-- Log to financial_audit_log
INSERT INTO financial_audit_log (entity_type, entity_id, action, new_data, performed_by)
SELECT 'commission', id, 'cancelled', jsonb_build_object('reason', 'Order voided'), p_performed_by
FROM commissions WHERE order_id = p_order_id AND status = 'cancelled';
```

### B8: FSA numbers captured but never used

**Fix:** Two options:
- **Option A (minimal):** Add FSA numbers to compliance reports and logbook export
- **Option B (remove):** Hide FSA fields from FieldSetup unless user enables in Settings

**Recommendation:** Option A — add FSA numbers to the compliance page's field listing and logbook report CSV export. They have regulatory value even if not automated.

---

## Pillar 5: Crop History Tracking (Bonus)

### Problem
`field.crop_type` is overwritten each season. No history. Agvance tracks multi-year crop history per field.

### Solution

**New table: `field_crop_history`**

```sql
CREATE TABLE field_crop_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  field_id uuid NOT NULL REFERENCES fields(id) ON DELETE CASCADE,
  season integer NOT NULL,  -- crop year (Oct 1 - Sep 30)
  crop_type text NOT NULL,
  variety text,
  planting_date date,
  harvest_date date,
  yield_per_acre numeric(10,2),
  yield_unit text,  -- bu, tons, etc.
  notes text,
  created_at timestamptz DEFAULT now()
);

CREATE UNIQUE INDEX idx_field_crop_history_unique ON field_crop_history(field_id, season);
```

**Auto-populate:** When `field.crop_type` changes, snapshot the old value to `field_crop_history` with the previous season.

**UI:** New "Crop History" tab on FieldDashboard showing multi-year rotation timeline.

---

## Implementation Phases

### Phase 1: Fix Broken Connections (B3-B8) — No UI changes
1. Migration: `blend_ticket_products` cost columns + `blend_tickets.job_id` column
2. Update `create_application_record_from_blend_ticket()` for multi-field
3. Update `void_order()` / `cancel_order()` to cascade commissions
4. Add FSA numbers to compliance reports

### Phase 2: Blend Ticket → Invoice (Pillar 1)
5. Migration: `create_invoice_from_blend_ticket()` RPC
6. Payment status auto-sync triggers
7. BlendTicketDetail "Create Invoice" button UI
8. Update BlendTickets list to show invoice link

### Phase 3: Field Billing Splits → Auto-Invoice (Pillar 2)
9. Migration: `quote_sections.field_id` + `invoices.invoice_group_id`
10. Update `create_invoice_from_order()` to check field splits
11. Update `create_invoice_from_blend_ticket()` to check field splits
12. QuoteBuilder field selector on sections
13. InvoiceDetail split group display

### Phase 4: Dispatch View (Pillar 3)
14. Migration: jobs columns (assigned_to, priority, scheduled_date)
15. Create DispatchBoard.tsx page
16. Create JobBoundaryLayer.tsx map component
17. Create DispatchJobCard + ApplicatorSidebar components
18. Add route + nav link

### Phase 5: Crop History (Pillar 5)
19. Migration: `field_crop_history` table
20. Auto-snapshot trigger on crop_type change
21. FieldDashboard "Crop History" tab

---

## Backward Compatibility

- All changes are additive — existing workflows unchanged
- Single-customer invoices still work (split logic only activates when field has billing defaults)
- Blend ticket → order → invoice path still works (new direct path is an alternative, not a replacement)
- Job scheduling via Jobs.tsx still works (DispatchBoard is a new view, not a replacement)

---

## Success Criteria

- [ ] Approved blend ticket can generate invoice in one click
- [ ] Invoice products/costs come from blend ticket snapshot (not current product price)
- [ ] Field billing splits auto-generate proportional split invoices
- [ ] Split invoices are grouped and cross-referenced
- [ ] Dispatch map shows all pending/assigned jobs with field boundaries
- [ ] Applicators can be assigned to jobs from dispatch view
- [ ] Application records created for ALL fields on multi-field blend tickets
- [ ] Order void cascades to cancel pending commissions
- [ ] Blend tickets can be linked to actual job records (not just text)
- [ ] Crop history tracked per field per season

---

## Sources Referenced

- [Agvance Blend Tickets](https://helpcenter.agvance.net/home/adding-blend-tickets)
- [Agvance SKY Dispatch](https://agvance.net/products/agronomy/dispatch)
- [Agvance Field Plans](https://helpcenter.agvance.net/home/field-plan-window)
- [Agworld for Ag Retailers](https://www.agworld.com/us/ag-retailers/)
- [Top Ag Retail Software 2026](https://gitnux.org/best/ag-retail-software/)
- [Agvance Delivery Tickets](https://helpcenter.agvance.net/home/add-delivery-ticket)
