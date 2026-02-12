# CRX Manager — Customized Feature Implementation Plan

> ⚠️ **STATUS: DRAFT — DO NOT IMPLEMENT**
> This document is a PLANNING DRAFT. The user is still adding context and refining details.
> **NO agent should write code, create migrations, or modify any files based on this plan.**
> When ready, the user will explicitly say "implement Phase X" in a new session.
> The canonical copy lives at: `C:\Users\pc\CRX_Manager_V1.0\CUSTOM_FEATURE_PLAN.md`

---

# PART A: KinMan by DataSmart — Complete Software Overview

> **Source:** 15:57 video walkthrough recorded by user (Feb 2026), 191 screenshots, full audio transcript.
> **Purpose:** Document the existing software the user currently relies on, so we can compare against CRX Manager and build the best possible replacement.

## 1. What KinMan Is

KinMan by DataSmart is a **web-based agricultural chemical management and billing platform** (accessed at `login.chem-man.com`). The user describes it as having excellent layout, search, and billing functionality, but lacking in inventory management and some modern features — which is why CRX Manager is being built.

**What the user loves about it:**
- Everything visible on one screen (no jumping between windows)
- Powerful search/filter on every list page
- The billing split system (splitting charges across landlords/tenants)
- The job scheduling + field mapping with satellite overlay
- The applicator/vehicle tracking and reporting
- The unposted → posted review workflow for invoices
- The reporting engine (export to CSV, PDF, or view in browser)

**What the user says is lacking:**
- Inventory management is weak (can't track supplier, limited visibility)
- Limited functionality beyond what's shown (user wants more modern features)

## 2. Navigation Structure

KinMan uses a **horizontal top navigation bar** with these main sections:

| Tab | Purpose |
|-----|---------|
| **Customers** | Manage all customer records, search, filter |
| **Billing** | Chemical sales, field application invoices, other charges |
| **Inventory** | Add/subtract stock, cost reports, adjustments |
| **Work Orders** | Schedule field application jobs |
| **Applicators** | Manage applicator profiles and assignments |
| **Chemical Audit** | EPA compliance tracking |
| **Vehicles** | Equipment/sprayer tracking and reporting |
| **Reports** | Comprehensive reporting engine |
| **Setup** | Fields, maps, system configuration |

Below the top nav, a **left sidebar** appears contextually with sub-options for the active section.

## 3. Module-by-Module Breakdown

### 3A. Customer Management

**Manage Customers page:**
- Full data table with columns: Customer Name, Address, City, State, Zip, Phone, Email, Balance, Status
- **Powerful filtering**: Filter by customer type, balance status (has balance / no balance), customer group
- **Customer grouping**: Landlords can be grouped under a parent entity (e.g., all "State Farm" landlords together)
- Blue action buttons on each row (Edit, View, etc.)
- Total balance shown at bottom

**Key feature — Customer Type Grouping:**
- Multiple landlords can belong to one parent group
- Searching by group shows all related landlords together
- This is how billing splits work — the system knows who's connected

**Customer Reporting:**
- Search by customer name + date range
- View payment history (every check written, every credit applied)
- Export to CSV, PDF, or view in browser
- Posted Payments and Credits listing — filterable by date range, customer, payment type

### 3B. Billing System

KinMan has **THREE types of billing:**

#### Type 1: Chemical Sales (Product-Only)
- Path: Billing → Enter Unposted Chemical Sale → Add
- **For:** Customer orders product for delivery, no spraying service
- **Workflow:**
  1. Auto-generates sequential invoice number
  2. Enter date, purchase order #, comments
  3. Add chemicals: search product → auto-populates warehouse, vendor, unit price (over-the-counter price)
  4. Enter quantity (e.g., 1000 gallons)
  5. **Customer Split**: Split the charge across multiple customers (e.g., Mason Wells 50%, Clayton Wells 50%) — system auto-calculates dollar amounts
  6. Assign salesman (for commission tracking)
  7. Save → goes to "Unposted" queue
- **Price tiers:** Currently uses single "over-the-counter" price; user wants tier 1/2/3 in CRX Manager

#### Type 2: Field Application Invoices (Service + Product)
- Generated FROM completed work orders (scheduled jobs)
- **Workflow:**
  1. Job is scheduled (see Section 3E below)
  2. Job is completed in the field
  3. Actual acres sprayed are entered
  4. Hit "Transfer to Invoice" → job becomes an invoice
  5. Goes to "Unposted Invoices" queue for admin review
- Contains: all products, rates, price per gallon, billing splits, field locations
- Admin reviews and edits anything before posting

#### Type 3: Other Charges (Miscellaneous)
- Path: Billing → Enter Unposted Transactions
- **For:** Non-chemical charges like delivery/hauling fees, service fees, equipment charges
- Simple entry form: customer, description, amount, date

#### The Unposted → Posted Workflow (CRITICAL)
This is a two-step review process the user explicitly wants in CRX Manager:
1. **Unposted**: Invoice is created but does NOT hit the customer's account balance yet
2. **Admin Review**: Administrator reviews all unposted invoices, can edit anything
3. **Post**: Admin hits "Post Current" → invoice is applied to customer's account → balance increases
4. **Posted**: Invoice is now live, appears in Posted Chemical Sales or Posted Invoices list

**Why this matters:** Planned programs and sales can sit in "unposted" until they're actually executed. Nothing hits the customer's account until admin explicitly posts it.

### 3C. Payments & Prepay

**Payments tab features:**
- Select customer(s) with balances
- Enter: check number, payment amount, method
- **Apply payment to specific items:**
  - Apply to prepayment on their farm (prepay credit for future use)
  - Apply to specific invoices (chemical blend tickets listed under customer)
  - Apply partial payments across multiple invoices
- Payments, credits, and check details all tracked

**Prepay System:**
- Customer can prepay for product/services
- Prepay dollars sit as a credit on the farm
- At end of month (or whenever), admin applies prepay dollars against invoices
- The user wants this flexibility in CRX Manager

### 3D. Inventory Management

**Current KinMan inventory (what the user says is WEAK):**
- Enter Unposted Inventory Additions/Deductions
- Fields: Product, reference/shipment number, vendor, quantity, unit cost
- Unit cost tracking maintains cost average (for commission calculations)
- Can see quantity on hand
- **Cannot** track supplier details, lot numbers, or detailed history
- Inventory adjustments and cost reports available
- User says: "We've already got a way better inventory with what we're building with Claude"

### 3E. Job Scheduling & Work Orders

This is the **most feature-rich module** in KinMan and what the user loves most.

**Creating a Scheduled Job:**
1. Start new Job Schedule (auto-generates job number, e.g., #230499)
2. **Select Locations** → opens satellite map overlay:
   - Search customer name → shows all their fields on map
   - Each field has: name/ID, acreage, crop type, customer billing split
   - Select specific fields for this job
   - Map shows field boundaries with satellite imagery
   - Acreage auto-populated (can be adjusted)
3. **Chemicals / Charges** section:
   - Add products with rate per acre
   - Total gallons calculated automatically from (rate × acres)
   - Can use **pre-blended recipe programs** (saved blends applied with one click)
   - Multiple products per job
4. **Loader Worksheet Setup**:
   - Select vehicle/sprayer → system knows tank size
   - Enter spray rate (gallons per acre)
   - System calculates: total loads needed, product amounts per load
   - Generates printable mixing instructions for the chemical mixer person
5. **Applied Info** (EPA compliance):
   - Date sprayed, applicator name, vehicle used
   - Start time, end time
   - System auto-pulls weather data for EPA records
   - All compliance fields in one section
6. **Notifications** section at bottom

**Scheduled Jobs List:**
- Shows all jobs with status (color-coded: yellow = scheduled, green = complete, etc.)
- Columns: customer, field, chemicals, status, date, applicator, vehicle
- Drag to reorder priority
- Filter and sort capabilities

**Dispatch / Applicator View:**
- Every work order visible to the sprayer operator
- Can dispatch specific jobs to specific sprayers/applicators
- Schedule dates and deadlines
- Applicator can click into their assigned jobs

**Printable Reports from Jobs:**
- **Applicator Report**: Full job detail — locations, chemicals, rates, billing splits, field maps, application info
- **Loader Report**: Just the mixing instructions — product amounts per load, total gallons needed
- **Field Maps**: Satellite maps showing individual fields or combined overview
  - Can toggle between individual field maps and combined view
  - Includes latitude/longitude

### 3F. Vehicle & Equipment Tracking

**Manage Vehicles page:**
- Every sprayer and tender is a "vehicle" with a unique ID
- Tracks which entity owns/leases each vehicle
- Important for: tracking acres per vehicle → paying sublease costs

**Vehicle Reports:**
- Select vehicle + date range → generates report showing:
  - Every product run through that sprayer
  - Total gallons of product
  - Dollar value of product
  - Total acreage sprayed
- Used to calculate sublease payments (pay per acre of service performed)

### 3G. Applicator Management

**Manage Applicators page:**
- Every applicator has a profile with login credentials
- Tracks: which applicator was in which rig, when
- Each applicator can log into their own account to view assignments
- Linked to EPA compliance (who sprayed what, when)

**Applicator Reports:**
- Who sprayed what fields, with what chemicals, on what dates
- Vehicle assignments per applicator
- Acreage totals per applicator

### 3H. Field Setup & Mapping

**Field List:**
- Every field in the system with: field name/ID, acreage, crop type, customer billing splits
- Fields linked to customer(s) with percentage splits (e.g., L19 farm = 1/3 Mason, 1/3 Clayton, 1/3 Chad)
- This is the foundation for how billing splits work automatically

**Mapping Features:**
- Full satellite map view of ALL fields in the system (across entire service area)
- Individual field views with boundaries drawn on satellite imagery
- Yellow labels showing field names on the map
- Used during job scheduling to select which fields to spray
- Printable maps for drivers/applicators

### 3I. Reporting Engine

KinMan has an extensive reports menu with **16+ report types:**

| Report | Purpose |
|--------|---------|
| Printed Field Applicator Report | Job detail printout for sprayer operator |
| Landlord Reports | Billing/activity by landlord |
| Unfinished Transactions Report | Work still in progress |
| Closeout Reports | End-of-season/period closeouts |
| Inventory Reports | Stock levels and movements |
| Product/Chemical Sale Report | Sales by product |
| Posted Chemical Sale Report | All posted chemical sales by customer/date |
| Product Units on Hand Report | Current inventory levels |
| Rights and Claims Check Report | Compliance/legal tracking |
| Driver Sale Report | Sales by driver |
| Invoice Summary | Summary of all invoices |
| Application Time Report | Time tracking for applications |
| Growth Times or Statement of Charges | Customer-facing statements |
| Full Custom Report | Build your own report |
| Field Location Reports | Field details and locations |

**Report features:**
- Filter by customer, date range, product, applicator, vehicle
- Export options: CSV, PDF, or view in browser
- Customer-facing reports available (statements, invoices)

## 4. Key Workflows Summary

### Workflow A: Chemical Sale (Product Delivery Only)
```
Create Chemical Sale → Add Products → Set Customer Splits → Set Salesman
    → Save (Unposted) → Admin Reviews → Post to Account → Customer Billed
```

### Workflow B: Field Application (Spray Job)
```
Schedule Job → Select Fields (map) → Add Chemicals → Set Vehicle/Applicator
    → Print Loader Worksheet → Print Applicator Report → Execute Job
    → Enter Actual Acres + Applied Info → Transfer to Invoice (Unposted)
    → Admin Reviews → Post to Account → Customer Billed
```

### Workflow C: Payment Processing
```
Select Customer(s) with Balance → Enter Check #/Amount/Method
    → Apply to Prepay OR Apply to Specific Invoices → Save → Posted
```

### Workflow D: Miscellaneous Charge
```
Enter Other Charge → Customer, Description, Amount → Save (Unposted)
    → Admin Reviews → Post → Customer Billed
```

## 5. Additional Context from Q&A (Post-Video)

### Farm/Customer Relationships
- **Both tenants AND landlords are customers** — not just the tenant
- A farm can be split 3 ways (e.g., Mason Wells 33%, Clayton Wells 33%, Chad Wells 33%)
- Billing splits are flexible: sometimes each person gets their own invoice, sometimes it's combined — **depends on the situation** (user chooses per case)
- Landlords can prepay for their share separately
- **Scale: 500+ fields** across all customers

### Payment Patterns
- **Mix of everything**: Some customers pay as invoices come (30-60 days), some pay end of season, some prepay
- Prepay dollars can be applied to specific invoices at end of month or whenever

### Blend Recipes
- **Both crop-specific and generic**: Some recipes are tied to crop + timing (e.g., "corn pre-emerge"), others are general-purpose mixes

### Features NOT Shown in Video That User Relies On
1. **Customer statements and accounts receivable aging reports** — sending statements, tracking who owes what and how overdue
2. **Season program planning** — pre-season planning, committed acres, booking product in advance
3. **Google Maps / Mapbox field integration** — **USER'S FAVORITE FEATURE**:
   - Satellite map overlay with field boundaries
   - Can SELECT fields directly from the map view to start building blend tickets or orders
   - Can also select from a list of fields
   - Starting blends/orders from map view is the #1 most important workflow
   - Uses Google Maps + Mapbox for the mapping layer

> ⚠️ **IMPORTANT UPDATE**: The user originally said field mapping was "want eventually." After further discussion, they clarified it is their **FAVORITE and most important feature** of KinMan. This should be re-prioritized.

## 6. User's Feature Priorities for CRX Manager (UPDATED from Q&A)

Based on the video walkthrough and extensive follow-up questions:

| Feature from KinMan | Priority for CRX | Notes |
|---------------------|-------------------|-------|
| **Google Maps field selection → start orders/blends** | **🔴 #1 FAVORITE** | User's most important feature — start blends from map |
| Customer billing splits (landlord %) | **CRITICAL** | Used constantly, 500+ fields, must have |
| Unposted → Posted review workflow | **CRITICAL** | Same 2-step process wanted |
| Farm/field setup with splits + acreage | **CRITICAL** | Foundation for billing splits and map feature |
| Saved blend recipes/programs | **YES** | Crop-specific + generic, reuse often |
| Misc/other charges (hauling, delivery) | **YES** | 3 billing types: chemical, spray, delivery |
| Customer statements + AR aging | **YES** | Daily use for account management |
| Season program planning / booking | **YES** | Pre-season committed acres and product |
| Chemical sale invoicing | **YES** | Already planned in Phase 3 |
| Field application invoicing | **YES** | Already planned via blend ticket linkage |
| Payment application to specific invoices | **YES** | Flexible — apply to prepay or specific invoices |
| Prepay credit system | **YES** | Already planned, user refining details |
| Comprehensive reporting engine | **YES** | Planned in Phase 5 |
| Vehicle/equipment tracking | **EVENTUALLY** | For sublease cost tracking |
| Applicator profile + reporting | **EVENTUALLY** | For EPA compliance |
| Job scheduling/dispatching | **EVENTUALLY** | Major feature for future |
| Loader worksheet (tank load calc) | **NOT NEEDED** | Can calculate manually |

---

# PART B: Gap Analysis — KinMan vs. CRX Manager Current Plan

## Features KinMan Has That Are NOT Yet in CRX Manager Plan

| # | KinMan Feature | Status in CRX Plan | Recommendation |
|---|---------------|-------------------|----------------|
| G1 | **Google Maps field selection → start blends/orders from map** | ❌ NOT PLANNED | **🔴 USER'S #1 FAVORITE — must prioritize** |
| G2 | **Customer billing splits** (split invoice across multiple customers by %) | ❌ NOT PLANNED | **Must add — user says CRITICAL** |
| G3 | **Unposted → Posted invoice workflow** (2-step admin review) | ❌ NOT PLANNED (invoices go draft→sent→paid) | **Must add — user explicitly wants this** |
| G4 | **Farm/field setup** (500+ fields, acreage, crop, customer split %) | ❌ NOT PLANNED | **Foundation for G1 and G2 — must add** |
| G5 | **Saved blend recipes / programs** (one-click apply a saved chemical mix) | ❌ NOT PLANNED | **User wants this — add to plan** |
| G6 | **Miscellaneous / other charges** (hauling, delivery, service fees) | ❌ NOT PLANNED | **User confirmed 3 billing types needed** |
| G7 | **Customer statements + AR aging reports** | ❌ NOT PLANNED | **Daily use — add to reporting** |
| G8 | **Season program planning / committed acres / booking** | ❌ NOT PLANNED | **Add to plan** |
| G9 | **Apply payment to specific invoices** (choose which invoices to pay) | ⚠️ PARTIALLY (record_invoice_payment exists but no invoice selection UI) | **Enhance payment UI** |
| G10 | **Job scheduling / work orders / dispatching** | ❌ NOT PLANNED | Eventually (after map feature) |
| G11 | **Vehicle/equipment tracking + per-vehicle reports** | ❌ NOT PLANNED | Eventually |
| G12 | **Applicator profiles with login accounts** | ⚠️ PARTIAL (drivers exist but no applicator-specific features) | Eventually |
| G13 | **Loader worksheet / tank load calculations** | ❌ NOT PLANNED | **User says NOT NEEDED** |
| G14 | **EPA compliance fields** (weather auto-pull, start/end time, applicator) | ⚠️ PARTIAL (blend tickets have some fields) | Enhance later |
| G15 | **Printable applicator/loader reports from jobs** | ❌ NOT PLANNED | Eventually with job scheduling |
| G16 | **Customer balance listing report** | ⚠️ PARTIAL (dashboard shows some data) | Add to reporting |
| G17 | **Posted payments & credits listing** | ❌ NOT PLANNED | Add to Phase 3 reporting |

## CRITICAL Gaps That Must Be Added to the CRX Plan

### 🔴 Gap G1: Google Maps Field Selection → Start Blends/Orders from Map
**Impact:** User's **#1 FAVORITE feature** of KinMan. This is the workflow they use most and love most. Fields are displayed on a Google Maps/Mapbox satellite view with boundaries. User clicks fields on the map to select them, then starts building a blend ticket or order directly from that selection.

**What's needed:**
- Google Maps or Mapbox integration with satellite imagery
- Field boundaries drawn as polygons on the map
- Click-to-select fields (highlight selected fields)
- Right panel showing selected fields with acreage, crop, customer splits
- "Create Blend Ticket" / "Create Order" button from selection
- Selected fields auto-populate into the new blend/order
- Full map view of all 500+ fields across service area
- Individual field zoom views

**Dependencies:** Requires Gap G4 (farm/field setup) to be built first.

### Gap G2: Customer Billing Splits
**Impact:** This is foundational to how the user does business. Every farm can have multiple owners (landlords/tenants) with percentage splits. When a job is done or product is sold, the invoice is automatically split across those entities. Both tenants and landlords are customers. Billing can be separate invoices per person OR combined — user chooses per situation.

**What's needed:**
- `field_customer_splits` table: field_id, customer_id, split_percentage
- On orders/invoices: ability to split line items across multiple customers by percentage
- Auto-calculation of split dollar amounts
- Option to generate separate invoices per split OR one combined invoice
- Reporting by split customer
- 500+ fields with varying split configurations

### Gap G3: Unposted → Posted Invoice Workflow
**Impact:** The user explicitly said they want the same 2-step review process. Currently our invoice plan goes `draft→sent→paid` with no "unposted" review gate.

**What's needed:**
- Add `unposted` status to invoice workflow (before `sent`)
- "Post Current" batch action to move invoices from unposted → posted (which makes them live on the account)
- Unposted invoices list page with batch post capability
- Nothing hits customer balance until posted
- Applies to ALL invoice types (chemical sales, field application, misc charges)

### Gap G4: Farm/Field Setup with Customer Splits
**Impact:** This is the **data foundation** for billing splits (G2) AND the map feature (G1). Every field has acreage, crop type, location, and ownership percentages. 500+ fields in the system.

**What's needed:**
- `fields` table: name/ID, acreage, crop_type, location (lat/lng), boundary polygon (GeoJSON), primary_customer_id
- `field_customer_splits`: field_id, customer_id, percentage
- Field management page (list + detail + map view)
- Link fields to blend tickets, orders, and invoices
- Crop rotation tracking (crop can change year to year)

### Gap G5: Saved Blend Recipes / Programs
**Impact:** User said "Yes, definitely" — they reuse the same blends often. Recipes can be crop-specific (e.g., "corn pre-emerge") or generic.

**What's needed:**
- `blend_recipes` table: name, description, crop_type (optional), application_timing (optional), created_by
- `blend_recipe_items` table: recipe_id, product_id, rate_per_acre, default_unit
- UI on blend ticket creation: "Apply Recipe" button → select recipe → auto-populates products
- Recipe management page (CRUD)
- Filter recipes by crop type and timing

### Gap G6: Miscellaneous Charges
**Impact:** User bills for chemical sales, field spraying, AND delivery/hauling fees. Current plan only handles chemical product orders.

**What's needed:**
- Ability to create invoices for non-product charges (service fees, hauling, delivery)
- Either a separate "Other Charges" entry or a flexible line-item type on invoices (type: product / service / fee)
- These also go through the unposted → posted workflow

### Gap G7: Customer Statements + AR Aging Reports
**Impact:** Daily use for account management. Need to send statements showing all invoices/payments and track how overdue balances are.

**What's needed:**
- Customer statement generation (all invoices + payments for a date range)
- AR aging buckets (current, 30-day, 60-day, 90-day, 120+ day)
- Printable/PDF/emailable statements
- Aging summary dashboard widget

### Gap G8: Season Program Planning / Committed Acres / Booking
**Impact:** Pre-season planning is a key workflow — committing acres and product before the season starts.

**What's needed:**
- Season/program planning entity (pre-season commitments)
- Committed acres tracking per customer per product
- Booking system (reserve product for planned applications)
- Convert bookings to orders/blend tickets when executed

---

# PART C: Feature Implementation Plan (Updated)

> The sections below are the UPDATED implementation phases, incorporating all KinMan learnings.

## Context

The FEATURE_AUDIT_PROMPT.md contains a 7-phase, 52-feature roadmap. The user reviewed all 7 phases and gave specific feedback on what they actually need vs what was proposed. This plan incorporates that feedback into a customized, sequenced implementation plan.

**Relationship to FINAL_ACTION_PLAN.md:** The bug fix sprints (S0-S5) remain the FIRST priority. This feature plan begins AFTER those fixes are complete.

**Key user clarifications gathered:**
- Blend ticket prepay: User wants flexibility — may apply prepay dollars at end of month. Has existing software to screenshot for reference (TODO: user to share screenshots).
- Manufacturer finance: Manufacturer bills customer directly; CRX tracks it but doesn't collect that money.
- Returns: Both drivers AND admin/sales can initiate.

**KinMan walkthrough analysis (Feb 12, 2026):**
- Full 15:57 video reviewed (191 screenshots + audio transcript)
- 5 CRITICAL gaps identified (billing splits, unposted workflow, saved recipes, misc charges, farm/field setup)
- 10 additional features cataloged for future phases
- User confirmed priorities via Q&A

**Open items still to resolve:**
- [ ] ~~User wants to share screenshots of existing software~~ ✅ DONE (video walkthrough analyzed)
- [ ] Integrate 5 critical gaps (G1-G5) into the phase plan below
- [ ] User may have more context to add to specific phases
- [ ] Plan needs final user approval before any implementation begins

---

## Phase Summary (Modified from Original)

| Phase | Focus | What Changed | Est. Days |
|-------|-------|-------------|-----------|
| 1 | Blend Ticket ↔ Order Linkage | **NEW** — not in original. Solves prepaid/planned/unplanned billing | 3-4 |
| 2 | Inventory Cycle Counting | Stripped to cycle counting ONLY (skip lot tracking, forecasting, etc.) | 3-4 |
| 3 | Financial: Invoices + Finance Programs + Stripe Arch | Added line-item finance source tracking + Stripe ACH columns | 8-10 |
| 4 | Returns/RMA Only | Removed fleet, calendar, routes, time windows, driver metrics | 4-5 |
| 5 | Sales & Customer Experience | Kept as-is | 5-8 |
| 6 | Compliance: Licenses Only | Removed SDS document management | 3-4 |
| 7 | Advanced (Future) | Removed barcode/QR + vendor scorecard | Future |
| **TOTAL** | | | **26-35 days** |

---

## PHASE 1: Blend Ticket ↔ Order Billing Linkage

### Problem
Blend tickets (field application records) are completely disconnected from orders, invoices, and inventory. The user has 3 real-world scenarios:
1. **Pre-paid** — Customer already paid via an order; blend ticket just documents what was applied
2. **Planned job** — Product is on a quote/order but not yet billed; blend ticket confirms the work
3. **Out of the blue** — Product applied with no existing order; need to create one retroactively

### Database Changes

**Migration file:** `supabase/migrations/YYYYMMDDHHMMSS_blend_ticket_billing_linkage.sql`

New columns on `blend_tickets`:
- `order_id uuid REFERENCES orders(id)` — FK to linked order (null if unlinked)
- `billing_status text DEFAULT 'unbilled'` — values: `unbilled`, `linked`, `billed`, `prepaid`, `no_charge`
- `billing_notes text`

New junction table `blend_ticket_order_items`:
- Maps each `blend_ticket_product` to an `order_item` with `quantity_applied`
- Handles cases where one blend ticket spans multiple orders or vice versa

Indexes on `blend_tickets(order_id)`, `blend_tickets(billing_status)`, junction table FKs.
RLS: same pattern as blend_tickets (admin full, sales_rep read/update).

### New RPCs (2)
1. **`link_blend_ticket_to_order(p_blend_ticket_id, p_order_id, p_product_mappings, p_billing_status, p_performed_by)`** — Atomic: sets order_id + billing_status + inserts junction mappings
2. **`create_order_from_blend_ticket(p_blend_ticket_id, p_customer_id, p_tier, p_performed_by)`** — Creates order retroactively from blend ticket products using tier pricing, links automatically

### Modified RPC (1)
- `save_blend_ticket` — Add `order_id` and `billing_status` to accepted parameters

### UI Changes
- **BlendTicketDetail.tsx**: New "Billing" section with:
  - Billing status badge (color-coded)
  - "Link to Order" button → modal with order dropdown + product-to-order-item mapping
  - "Create Order from Ticket" button → confirmation modal → calls RPC → navigates to new order
  - "Unlink" button (admin only)
- **BlendTickets.tsx**: Billing status filter dropdown (All / Unbilled / Linked / Billed / Prepaid)
- **OrderDetail.tsx**: New "Blend Tickets" tab showing linked tickets
- **Dashboard.tsx**: "Unbilled Blend Tickets" alert widget

### Types to Add (`src/types/index.ts`)
- `BillingStatus` type union
- `BlendTicketOrderItem` interface
- Update `BlendTicket` interface with `order_id`, `billing_status`, `billing_notes`, optional `order`

### Verification
- [ ] Link a blend ticket to an existing prepaid order → status shows "prepaid"
- [ ] Link a blend ticket to an unpaid order → status shows "linked"
- [ ] Create order from an unlinked blend ticket → order created with correct products/prices
- [ ] Dashboard shows count of unbilled blend tickets
- [ ] `npm run build` passes

---

## PHASE 2: Inventory Cycle Counting

### Problem
No way to verify physical inventory matches system records. User wants weekly or bi-weekly physical counts.

### Database Changes

**Migration file:** `supabase/migrations/YYYYMMDDHHMMSS_cycle_counting.sql`

New tables:
- `cycle_counts` — header (count_number UNIQUE, location, status: draft→in_progress→pending_approval→approved→cancelled, count_date, counted_by, approved_by)
- `cycle_count_items` — per-product lines (product_id, system_quantity snapshot, counted_quantity input, variance + variance_pct as generated columns, notes)

RLS: admin full access, sales_rep can create/update own counts.

### New RPCs (3)
1. **`create_cycle_count(p_location, p_product_ids, p_created_by)`** — Snapshots current `inventory.quantity_available` into count items
2. **`approve_cycle_count(p_count_id, p_approved_by)`** — For each item with non-zero variance: creates `inventory_transaction` (type='adjusted', reason='cycle_count'), updates `inventory.quantity_available`
3. **`next_cycle_count_number()`** — Sequence: CC-YYYY-NNNN

### UI Changes
- **InventoryPage.tsx**: "Start Cycle Count" button → modal (select location, optionally filter products)
- **New page: CycleCountDetail.tsx** (`/inventory/cycle-count/:id`)
  - Table: product name, system qty, counted qty (editable input), variance, variance %, notes
  - Color coding: green (0), yellow (<5%), red (>5% or >10%)
  - Workflow buttons: Start Counting → Submit for Approval → Approve (admin)
  - Summary: total items counted, items with variance, total $ variance
- **New route in App.tsx**: `/inventory/cycle-count/:id`

### Verification
- [ ] Create count → system quantities snapshotted correctly
- [ ] Enter counted quantities → variances calculated
- [ ] Approve count → inventory adjusted, transactions logged
- [ ] `npm run build` passes

---

## PHASE 3: Financial Foundation

### Problem
No invoices, no line-item finance tracking, no way to distinguish manufacturer-financed vs cash vs dealer-financed products.

### 3A. Invoice System

**Migration file:** `supabase/migrations/YYYYMMDDHHMMSS_invoice_system.sql`

New tables:
- `invoices` — header (invoice_number UNIQUE, order_id, customer_id, status: draft→sent→partially_paid→paid→void→overdue, due_date, amount, amount_paid, balance_due, stripe_payment_link, stripe_payment_intent_id)
- `invoice_items` — line items (invoice_id, order_item_id, product_id, quantity, unit_price, total, finance_program_id, payment_source)

New columns on `customers`: `credit_limit numeric`, `credit_hold boolean DEFAULT false`

New RPCs:
- `create_invoice_from_order(p_order_id, p_performed_by)` — generates invoice + items from order
- `record_invoice_payment(p_invoice_id, p_amount, p_method, p_ref, p_notes, p_performed_by)` — records payment, updates invoice + order balances
- `next_invoice_number()` — INV-YYYY-NNNN

New pages:
- `Invoices.tsx` (`/invoices`) — list with status/aging filters
- `InvoiceDetail.tsx` (`/invoices/:id`) — view, PDF generation, email (future)

Sidebar: Add "Invoices" (Receipt icon, admin role)

### 3B. Line-Item Finance Source Tracking

**User's requirement:** "Each line item almost needs an option to select where it is financed against."
**Key clarification:** Manufacturer bills customer directly — CRX tracks it but doesn't collect that money.

New reference table `finance_programs`:
- `program_name`, `program_type` (manufacturer / dealer / cash), `manufacturer` name, `interest_rate`, `term_days`, `start_date`, `end_date`, `is_active`

New columns on `order_items`:
- `finance_program_id uuid REFERENCES finance_programs(id)`
- `payment_source text DEFAULT 'cash'` — values: `cash`, `manufacturer_finance`, `dealer_finance`

These columns also added to `quote_items` so the finance source carries from quote → order → invoice.

UI changes:
- **SettingsPage.tsx**: New "Finance Programs" section — CRUD for programs (e.g., "Bayer Flex", "Syngenta Early Pay", "CRX Dealer Finance", "Cash")
- **QuoteBuilder.tsx**: Per line item, "Payment Source" dropdown + "Finance Program" dropdown (when not cash)
- **NewOrder.tsx / OrderDetail.tsx**: Same per-item finance dropdowns
- **Reports.tsx**: New "Finance Programs" tab — receivables by source, grouped by program, with totals

### 3C. Stripe ACH Architecture (Columns Only)

Add to `payments` table: expand payment_method CHECK to include 'stripe_ach'.
Add to `invoices`: `stripe_payment_link`, `stripe_payment_intent_id` columns.
**No Stripe code written now** — just the column infrastructure so invoices can hold payment links in the future.

### Verification
- [ ] Create invoice from order → items + totals correct
- [ ] Set line items to different payment sources → tracks correctly
- [ ] Finance Programs report shows breakdown by source
- [ ] Credit limit enforcement blocks orders for over-limit customers
- [ ] `npm run build` passes

---

## PHASE 4: Returns / RMA (Only)

### Removed from Original Phase 4
~~Delivery calendar~~, ~~fleet management~~, ~~load planning~~, ~~time windows~~, ~~driver metrics~~, ~~route optimization~~

### What's Built
Returns system where BOTH admin/sales AND drivers can initiate returns.

**Migration file:** `supabase/migrations/YYYYMMDDHHMMSS_returns_system.sql`

New tables:
- `returns` — header (return_number UNIQUE, customer_id, order_id, delivery_id, reason CHECK, status: pending→approved→received→restocked→credited→rejected, processed_by_driver, driver_signature_url, driver_notes, photos)
- `return_items` — per-product (product_id, order_item_id, quantity, unit_price, condition: sellable/damaged/expired, restock boolean, lot_number)
- `return_images` — driver photos (storage_path, image_url, caption, uploaded_by)

New RPCs:
- `process_return(p_return_id, p_approved_by)` — Atomic: restocks inventory (if item.restock=true) + credits customer account (reduces order.balance_due)
- `next_return_number()` — RMA-YYYY-NNNN

New storage bucket: `return-images` (same pattern as blend-ticket-images)

New pages:
- `Returns.tsx` (`/returns`) — list with status filter
- `ReturnDetail.tsx` (`/returns/:id`, `/returns/new`) — create from order, per-item quantities + condition, driver photo upload (uses existing `imageCompression.ts`), signature capture (uses existing `signature_pad`), admin approve/reject

Sidebar: Add "Returns" (RotateCcw icon, admin + sales_rep roles)

Driver view: Drivers can create returns from their delivery view, upload photos, capture signature.

### Verification
- [ ] Admin creates return from order → items populated
- [ ] Driver creates return with photos + signature
- [ ] Approve return → inventory restocked + customer credited
- [ ] `npm run build` passes

---

## PHASE 5: Sales & Customer Experience (As-Is from FEATURE_AUDIT_PROMPT.md)

No user changes. Implement:
1. Sales pipeline kanban view on Quotes page
2. Follow-up reminders (`follow_ups` table, dashboard widget)
3. Role-specific dashboards (admin / sales rep / driver variants)
4. Season-over-season comparison report tab
5. Margin analysis report tab
6. Scheduled report delivery (Edge Function + `scheduled_reports` table)

---

## PHASE 6: Compliance — Applicator Licenses Only

### Removed
~~SDS/COA document management~~ (user: "not important to me")

### What's Built
1. **RUP tracking** — `is_restricted_use`, `signal_word` columns on products, red badge display
2. **Applicator licenses** — `applicator_licenses` table on CustomerDetail (license number, state, type, categories, expiration, verification, document upload)
3. **RUP enforcement** — Block orders with RUP products if customer has no valid license (admin override available)
4. **EPA reporting** — Restricted-use sales log report tab, CSV export

New storage: `license-documents` bucket for uploaded license images/PDFs.

---

## PHASE 7: Advanced Features (Future — No Implementation)

### Kept for Future
- Customer self-service portal
- QuickBooks integration
- SMS notifications (Twilio)
- Approval chains
- PWA / mobile optimization
- Data visualization (Recharts)
- Audit trail improvements

### Removed per User Request
- ~~Barcode / QR scanning~~
- ~~Vendor scorecard~~

---

## Existing Code to Reuse

| Utility | File Path | Used In |
|---------|-----------|---------|
| `checkMutationResult()` | `src/lib/db.ts` | All new mutations |
| `logActivity()` | `src/lib/activityLogger.ts` | All create/update/delete operations |
| `useToast()` | `src/components/ui/Toast.tsx` | All user-facing actions |
| `imageCompression.ts` | `src/lib/imageCompression.ts` | Return photo uploads |
| `SignatureCanvas` | `src/components/ui/SignatureCanvas.tsx` | Return driver signatures |
| `Modal`, `DataTable`, `Badge`, `Button`, `Input`, `Card` | `src/components/ui/` | All new pages |
| `useSupabaseQuery` pattern | Various pages | All data fetching |
| Number generator RPCs pattern | `20260211260000_number_generation_sequences.sql` | New sequence generators |

## RPCs to Modify

| RPC | Change | Phase |
|-----|--------|-------|
| `save_blend_ticket` | Accept order_id + billing_status params | 1 |
| `convert_quote_to_order` | Carry payment_source + finance_program_id from quote_items to order_items | 3 |
| `create_direct_order` | Accept payment_source + finance_program_id per item | 3 |
| `record_payment` | Add optional invoice_id param, update invoice balance | 3 |

## New RPCs to Create

| RPC | Purpose | Phase |
|-----|---------|-------|
| `link_blend_ticket_to_order` | Link blend ticket to order + map products | 1 |
| `create_order_from_blend_ticket` | Create order retroactively from blend ticket | 1 |
| `create_cycle_count` | Snapshot inventory into count items | 2 |
| `approve_cycle_count` | Approve count + adjust inventory | 2 |
| `create_invoice_from_order` | Generate invoice from order | 3 |
| `record_invoice_payment` | Record payment against invoice | 3 |
| `process_return` | Approve return → restock + credit | 4 |
| `next_cycle_count_number` | CC-YYYY-NNNN | 2 |
| `next_invoice_number` | INV-YYYY-NNNN | 3 |
| `next_return_number` | RMA-YYYY-NNNN | 4 |

## Dependency Order
```
FINAL_ACTION_PLAN Sprints 0-5 (bug fixes — do these FIRST)
    ↓
Phase 1: Blend Ticket Linkage (3-4 days)
    ↓
Phase 2: Cycle Counting (3-4 days)
    ↓
Phase 3: Financial (8-10 days) — depends on Phase 1 for blend ticket billing flow
    ↓
Phase 4: Returns (4-5 days) — depends on Phase 3 for credit handling
    ↓
Phase 5: Sales (5-8 days)
    ↓
Phase 6: Compliance (3-4 days)
```

## How to Test End-to-End

After each phase:
1. `npm run build` — must pass clean
2. Manual test in browser: create/edit/view the new entities
3. Verify Supabase data via `execute_sql` queries
4. Run `get_advisors` for security + performance checks
5. Verify RLS: test as admin, sales_rep, and driver roles

---

> ⚠️ **REMINDER: This is a DRAFT. DO NOT IMPLEMENT.**
> The user is still refining this plan and has more context to add.
> No code changes, no migrations, no file modifications until the user explicitly approves and requests implementation of a specific phase.
