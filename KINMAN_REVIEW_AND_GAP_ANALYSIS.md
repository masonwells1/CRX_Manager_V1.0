# CRX Manager — Complete Feature Plan & Architecture Review

> **STATUS: PLANNING DOCUMENT — DO NOT IMPLEMENT WITHOUT EXPLICIT APPROVAL**
> No agent should write code, create migrations, or modify any files based on this plan.
> When ready, the user will explicitly say "implement Phase X" in a new session.
>
> **Created:** February 2026
> **Last Updated:** February 12, 2026
> **Source:** CheMan by DataSmart video walkthrough (15:57, 191 screenshots), gap analysis (G1-G17), Phase 1-7 plan, ideal platform analysis, and cross-review with ChatGPT architectural analysis
> **Companion doc:** `CRX_MANAGER_ARCHITECTURE_REVIEW.md` (full detailed reference)

---

## Table of Contents

**PART A:** [CheMan by DataSmart — Complete Software Overview](#part-a-cheman-by-datasmart--complete-software-overview)
**PART B:** [Gap Analysis — CheMan vs. CRX Manager](#part-b-gap-analysis--cheman-vs-crx-manager-current-plan)
**PART C:** [Critical Architecture Decisions (Lock In Before Any Code)](#part-c-critical-architecture-decisions-lock-in-before-any-code)
**PART D:** [Rewritten Phase Sequencing & Implementation Plan](#part-d-rewritten-phase-sequencing--implementation-plan)
**PART E:** [Technical Risks, Red Flags & Pre-Implementation Checklist](#part-e-technical-risks-red-flags--pre-implementation-checklist)
**PART F:** [Ideal Platform Vision & Competitive Advantage](#part-f-ideal-platform-vision--competitive-advantage)

---

# PART A: CheMan by DataSmart — Complete Software Overview

> **Source:** 15:57 video walkthrough recorded by user (Feb 2026), 191 screenshots, full audio transcript.
> **Purpose:** Document the existing software the user currently relies on, so we can compare against CRX Manager and build the best possible replacement.

## 1. What CheMan Is

CheMan by DataSmart is a **web-based agricultural chemical management and billing platform** (accessed at `login.chem-man.com`). The user describes it as having excellent layout, search, and billing functionality, but lacking in inventory management and some modern features — which is why CRX Manager is being built.

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

CheMan uses a **horizontal top navigation bar** with these main sections:

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

CheMan has **THREE types of billing:**

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

**Current CheMan inventory (what the user says is WEAK):**
- Enter Unposted Inventory Additions/Deductions
- Fields: Product, reference/shipment number, vendor, quantity, unit cost
- Unit cost tracking maintains cost average (for commission calculations)
- Can see quantity on hand
- **Cannot** track supplier details, lot numbers, or detailed history
- Inventory adjustments and cost reports available
- User says: "We've already got a way better inventory with what we're building with Claude"

### 3E. Job Scheduling & Work Orders

This is the **most feature-rich module** in CheMan and what the user loves most.

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
   - Total gallons calculated automatically from (rate x acres)
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

CheMan has an extensive reports menu with **16+ report types:**

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

> **IMPORTANT UPDATE**: The user originally said field mapping was "want eventually." After further discussion, they clarified it is their **FAVORITE and most important feature** of CheMan. This should be re-prioritized.

## 6. User's Feature Priorities for CRX Manager (UPDATED from Q&A)

Based on the video walkthrough and extensive follow-up questions:

| Feature from CheMan | Priority for CRX | Notes |
|---------------------|-------------------|-------|
| **Google Maps field selection → start orders/blends** | **#1 FAVORITE** | User's most important feature — start blends from map |
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

# PART B: Gap Analysis — CheMan vs. CRX Manager Current Plan

## Features CheMan Has That Are NOT Yet in CRX Manager Plan

| # | CheMan Feature | Status in CRX Plan | Recommendation |
|---|---------------|-------------------|----------------|
| G1 | **Google Maps field selection → start blends/orders from map** | NOT PLANNED | **USER'S #1 FAVORITE — must prioritize** |
| G2 | **Customer billing splits** (split invoice across multiple customers by %) | NOT PLANNED | **Must add — user says CRITICAL** |
| G3 | **Unposted → Posted invoice workflow** (2-step admin review) | NOT PLANNED (invoices go draft→sent→paid) | **Must add — user explicitly wants this** |
| G4 | **Farm/field setup** (500+ fields, acreage, crop, customer split %) | NOT PLANNED | **Foundation for G1 and G2 — must add** |
| G5 | **Saved blend recipes / programs** (one-click apply a saved chemical mix) | NOT PLANNED | **User wants this — add to plan** |
| G6 | **Miscellaneous / other charges** (hauling, delivery, service fees) | NOT PLANNED | **User confirmed 3 billing types needed** |
| G7 | **Customer statements + AR aging reports** | NOT PLANNED | **Daily use — add to reporting** |
| G8 | **Season program planning / committed acres / booking** | NOT PLANNED | **Add to plan** |
| G9 | **Apply payment to specific invoices** (choose which invoices to pay) | PARTIALLY (record_invoice_payment exists but no invoice selection UI) | **Enhance payment UI** |
| G10 | **Job scheduling / work orders / dispatching** | NOT PLANNED | Eventually (after map feature) |
| G11 | **Vehicle/equipment tracking + per-vehicle reports** | NOT PLANNED | Eventually |
| G12 | **Applicator profiles with login accounts** | PARTIAL (drivers exist but no applicator-specific features) | Eventually |
| G13 | **Loader worksheet / tank load calculations** | NOT PLANNED | **User says NOT NEEDED** |
| G14 | **EPA compliance fields** (weather auto-pull, start/end time, applicator) | PARTIAL (blend tickets have some fields) | Enhance later |
| G15 | **Printable applicator/loader reports from jobs** | NOT PLANNED | Eventually with job scheduling |
| G16 | **Customer balance listing report** | PARTIAL (dashboard shows some data) | Add to reporting |
| G17 | **Posted payments & credits listing** | NOT PLANNED | Add to Phase 3 reporting |

## Gap Priority Re-Assessment (from Architecture Review)

The architecture review re-ordered gap priorities based on dependency analysis:

| Gap | Description | User Priority | **Build Order** | Notes |
|-----|------------|---------------|-----------------|-------|
| **G4** | Farm/field setup with splits + acreage | CRITICAL | **Build 1st** | Data backbone — must exist before G1, G2, or anything referencing fields |
| **G2** | Customer billing splits | CRITICAL | **Build 2nd** | Touches every downstream system. If this data model is wrong, everything breaks |
| **G3** | Unposted → Posted invoice workflow | CRITICAL | **Build 3rd** | Needs full approval pipeline, batch operations, audit logging, ability to void |
| **G6** | Miscellaneous charges | CRITICAL | **Build 4th** | Can't fully replace CheMan without all 3 billing types |
| **G1** | Google Maps field selection → start blends/orders | #1 FAVORITE | **Build 5th** | User's favorite but depends on G4 + G2 being solid first. Build the data model before the UI |
| **G5** | Saved blend recipes / programs | IMPORTANT | **Build 6th** | Productivity feature, not a blocker. System works without it (just slower) |
| **G7** | Customer statements + AR aging | CRITICAL | **Build 7th** | Reporting/read-only. Build after the write-side (invoices, payments, splits) is solid |
| **G8** | Season program planning / booking | IMPORTANT | **Build 8th** | Seasonal workflow. 2026 planning likely done in CheMan already. Build before fall 2026 for 2027 planning cycle |

**Recommended build order:**
```
G4 (Farm/field data foundation)
  → G2 (Billing splits architecture)
    → G3 (Unposted → Posted workflow)
      → G6 (Misc charges — completes 3 billing types)
        → G1 (Maps UI — data model now supports it)
          → G5 (Saved recipes — productivity booster)
            → G7 (AR aging / statements — reporting layer)
              → G8 (Season planning — seasonal, you have time)
```

## Missing Gaps Not in Original Analysis (G1-G17)

The gap analysis missed these features that CheMan provides or that are architecturally necessary:

### Missing Gap A: Customer Grouping / Parent-Child Hierarchy
CheMan Part A Section 3A describes: "Customer grouping — Landlords can be grouped under a parent entity (e.g., all 'State Farm' landlords together)." Current customer model is flat. Need `parent_customer_id` or `customer_groups` table for group-level reporting and billing.

### Missing Gap B: Salesman / Commission Tracking on Invoices
CheMan Part A Section 3B: every chemical sale has "Assign salesman (for commission tracking)." No `salesman_id` exists on orders/invoices in the current plan. If salespeople earn commission, this must be baked into the invoice data model from the start.

### Missing Gap C: Prepay Credit Application Workflow
CheMan Part A Section 3C describes: customer prepays → credit sits on account → admin later applies credit against specific invoices. The current plan mentions prepay exists but doesn't detail the **application workflow**. Need a `prepay_applications` junction table and UI for allocating prepay credits against specific invoices.

### Missing Gap D: Multi-Location Warehouse Support
CheMan mentions inventory with "warehouse" fields. Phase 2 cycle counting references a `location` field, but no `warehouses` or `locations` reference table is defined. If chemicals are stored at multiple physical locations, the data model needs this from day one.

### Missing Gap E: Receiving Workflow for Inbound Inventory
The current plan has inventory tracking and cycle counting but no **inbound receiving** workflow. When a supplier truck arrives with product, how does it get into the system? Need:
- Receiving against purchase orders
- Quantity verification (ordered vs. received)
- Cost basis update (weighted average)
- Discrepancy flagging

### Missing Gap F: Manufacturer Rebate Tracking
Operations this size typically earn volume rebates from manufacturers (e.g., buy $500K of Roundup, Bayer owes a rebate). The system should track purchase volumes against rebate tier thresholds and project rebate earnings. Currently tracked in spreadsheets — should be in-app.

---

# PART C: Critical Architecture Decisions (Lock In Before Any Code)

> These decisions affect every table and every RPC. Get them right now or pay for it in rework later.

## C1. Money: Store as Integer Cents (`bigint`), Not Decimals

```sql
-- CORRECT: integer cents
amount_cents bigint NOT NULL  -- $1,499.85 stored as 149985

-- WRONG: decimal dollars
amount numeric(12,2)  -- works 95% of the time, fails on split math edge cases
```

**Why:** When you split $4,500.00 three ways and multiply by 0.3333, decimal math can produce tiny rounding artifacts that compound across 500+ fields. Integer cents with largest-remainder rounding eliminates this entirely. Convert to dollars only for display in the UI.

## C2. Percentages: Store as `numeric(9,6)`

```sql
split_percentage numeric(9,6) NOT NULL  -- 33.333333%
```

**Why:** `numeric` is exact (no floating-point surprises). 6 decimal places handles any reasonable split precision.

## C3. Splits: Store at Line-Item Level (Not Invoice Header)

Splits must be on `invoice_items` and `order_items`, not on the invoice/order header. This is because different line items on the same invoice can have different split configurations (e.g., landlord pays for chemical, tenant pays for application fee).

Header-level splits are a **convenience shortcut** that applies the same percentages to all lines — but the authoritative data lives at the line level.

## C4. Split History: Use Allocation Set Versioning

Every time someone edits a split, create a new allocation set (immutable append-only). The latest set is "active." All previous sets are permanent history. This gives you a tamper-proof audit trail for financial records.

## C5. Season / Crop Year on All Operational Tables

```sql
season integer NOT NULL DEFAULT 2026  -- or crop_year
```

Add this column to: `orders`, `invoices`, `blend_tickets`, `fields` (for crop rotation), `payments`, `inventory_transactions`. This enables season-over-season reporting and clean end-of-year closeouts. Retrofitting this later across every table is miserable.

## C6. Customer Hierarchy

```sql
parent_customer_id uuid REFERENCES customers(id)  -- for customer groups
```

Add to `customers` table. Enables "Wells Family Group" containing Mason, Clayton, Chad, and Wells Family Trust. Essential for group-level reporting and billing.

## C7. Salesman Tracking on Financial Records

```sql
salesman_id uuid REFERENCES profiles(id)
```

Add to `orders`, `invoices`, `quotes`. If you pay salespeople commission, this must be in the data model from day one — not bolted on after you've created thousands of records without it.

## C8. Soft Deletes on All Financial Tables

```sql
deleted_at timestamptz  -- NULL means active, timestamp means soft-deleted
```

Never hard-delete invoices, payments, orders, or blend tickets. Use `void` / `cancelled` statuses for workflow, and `deleted_at` as the ultimate safety net.

## C9. Mapping: Use Mapbox GL JS (NOT Google Maps)

**Reasons:**
- Google's Maps JavaScript Drawing library was **deprecated August 2025** and is scheduled to become unavailable ~May 2026. If you build polygon editing on Google's DrawingManager, you'll face a forced rewrite within months.
- Mapbox renders with WebGL — handles 500+ polygons significantly better than Google Maps' SVG/DOM rendering.
- `react-map-gl` by Uber is an excellent, well-maintained React wrapper.
- Mapbox free tier (50K map loads/month) is generous enough for an internal app.

**Alternative:** MapLibre GL JS (open-source fork of Mapbox, zero cost) if you're willing to source your own satellite tile layer. Mapbox is recommended because its built-in satellite imagery is essential for identifying fields.

## C10. Geospatial: Enable PostGIS in Supabase

```sql
CREATE EXTENSION IF NOT EXISTS postgis;
```

Use `geography(POLYGON, 4326)` for field boundaries and `geography(POINT, 4326)` for centroids. Add GIST spatial indexes. Compute acreage via `ST_Area()`. Serve GeoJSON to the frontend via `ST_AsGeoJSON()`.

## C11. All Financial Math in Postgres RPCs (Never in React)

The database is the single source of truth for:
- Split calculations (largest-remainder rounding)
- Invoice totals
- Payment application
- Inventory adjustments
- Balance calculations

React can *display* calculated values but must never compute authoritative financial totals. This prevents frontend bugs from corrupting financial data.

## C12. Immutable, Append-Only Patterns for Financial Events

Inventory movements, invoice revisions, split changes, payment applications, and credit adjustments should be **append-only** (insert new rows, never update/delete old ones). This preserves a complete audit trail.

---

# PART D: Rewritten Phase Sequencing & Implementation Plan

> The original Phase 1-7 plan has a structural problem: it builds billing linkage (Phase 1) and inventory counting (Phase 2) BEFORE the farm/field data model, billing splits, or unposted→posted workflow exist. This guarantees rework. The sequencing below fixes this.

## Updated Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18, TypeScript, Vite, Tailwind CSS |
| Backend | Supabase (Postgres + Auth + Storage + Edge Functions) |
| Deployment | Vercel |
| Mapping | Mapbox GL JS (recommended) or MapLibre GL JS |
| Geospatial DB | PostGIS extension in Supabase |
| Payments (future) | Stripe ACH |
| Notifications (future) | Twilio SMS, email via Edge Functions |

## Rewritten Phase Sequence

```
Phase 0: Bug fix sprints S0-S5 (already planned — do these FIRST)
    |
Phase 1 (NEW): Farm/Field Data Foundation                          [~5-7 days]
    - fields table with PostGIS boundary support
    - field_customer_splits (default billing splits per field)
    - customer hierarchy (parent_customer_id)
    - field management UI (list + detail view)
    - Enable PostGIS extension
    - This is G4 + Missing Gap A
    |
Phase 2 (NEW): Billing Architecture                                [~12-18 days]
    - Invoice system with line-item structure
    - Billing splits at line-item level with allocation set versioning
    - Unposted → Posted workflow with batch operations + audit trail
    - Miscellaneous charges support (3 billing types: chemical, application, misc)
    - Salesman tracking on orders/invoices
    - Prepay ledger and credit application workflow
    - Payment application to specific invoices
    - This is G2 + G3 + G6 + Missing Gaps B, C
    |
Phase 3 (MOVED): Blend Ticket <> Order Linkage                     [~3-4 days]
    - Original Phase 1, but now references fields + splits correctly
    - Blend ticket billing status (split into order_link_status + payment_status)
    - Junction table mapping blend ticket products to order items
    - RPCs for linking and creating orders from blend tickets
    |
Phase 4 (NEW): Saved Recipes + Maps                                [~8-12 days]
    - Blend recipes/programs (G5) — quick to build, high productivity value
    - Mapbox GL JS integration with satellite imagery
    - Field boundary display, click-to-select, selected fields panel
    - "Create Blend Ticket from Map Selection" workflow
    - This is G5 + G1
    |
Phase 5 (MOVED): Inventory Enhancements                            [~5-7 days]
    - Cycle counting (original Phase 2)
    - Receiving workflow (Missing Gap E)
    - Multi-location warehouse support (Missing Gap D)
    - Reorder point alerts
    |
Phase 6 (MOVED): Returns / RMA                                     [~4-5 days]
    - Original Phase 4, depends on Phase 2 for credit handling
    |
Phase 7: Reporting, Sales, Compliance                               [~10-15 days]
    - AR aging + customer statements (G7)
    - Season program planning (G8)
    - Sales pipeline, follow-ups, dashboards (original Phase 5)
    - Compliance: RUP tracking, applicator licenses (original Phase 6)
    - Manufacturer rebate tracking (Missing Gap F)
    - Season-over-season comparison reports
    |
Phase 8 (FUTURE): Customer Portal, Mobile, Integrations
    - Customer self-service portal (read-only access to invoices, application records)
    - PWA / offline mobile capability
    - QuickBooks integration
    - SMS notifications (Twilio)
    - Weather data API integration
    - Precision ag platform import/export
```

### Why This Order

| Phase | Why It's Here |
|-------|--------------|
| 1 (Fields) | Everything references fields — splits, maps, blend tickets, invoices. Build the foundation first. |
| 2 (Billing) | The billing engine is the core of the business. Splits, posting, payments, and invoicing must be solid before anything depends on them. |
| 3 (Blend Linkage) | Now that fields and billing exist, blend tickets can correctly reference them. No rework needed. |
| 4 (Recipes + Maps) | Recipes are quick and improve daily workflow. Maps require the field data model from Phase 1. Both are now safe to build. |
| 5 (Inventory) | Independent of billing workflow. Can slide without blocking other features. |
| 6 (Returns) | Depends on invoice/credit system from Phase 2. |
| 7 (Reporting) | Reporting reads from data created in Phases 1-6. Build last so you have data to report on. |

### Realistic Timeline Estimate

The original plan estimated 26-35 days total. That is **significantly underestimated**. A more realistic timeline:

| Phase | Estimated Days | Cumulative |
|-------|---------------|------------|
| Phase 0 (Bug fixes) | 5-10 | 5-10 |
| Phase 1 (Fields) | 5-7 | 10-17 |
| Phase 2 (Billing) | 12-18 | 22-35 |
| Phase 3 (Blend Linkage) | 3-4 | 25-39 |
| Phase 4 (Recipes + Maps) | 8-12 | 33-51 |
| Phase 5 (Inventory) | 5-7 | 38-58 |
| Phase 6 (Returns) | 4-5 | 42-63 |
| Phase 7 (Reporting + Compliance) | 10-15 | 52-78 |
| **TOTAL** | **52-78 days** | |

At part-time pace (building with Claude while running the business), expect **3-6 months** for Phases 0-7. **Do NOT cancel CheMan** until CRX Manager has run in parallel for at least one full billing cycle with real data.

## Billing Splits Architecture (G2) — Detailed Design

This is the biggest architectural decision in the entire application.

### Schema (3 Core Tables + 1 Versioning Table)

#### Table 1: `field_billing_defaults` — Default splits per field

```sql
CREATE TABLE field_billing_defaults (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    field_id uuid NOT NULL REFERENCES fields(id) ON DELETE CASCADE,
    customer_id uuid NOT NULL REFERENCES customers(id),
    split_percentage numeric(9,6) NOT NULL CHECK (split_percentage > 0 AND split_percentage <= 100),
    is_active boolean DEFAULT true,
    effective_date date NOT NULL DEFAULT CURRENT_DATE,
    created_at timestamptz DEFAULT now(),
    UNIQUE(field_id, customer_id, effective_date)
);
```

**Purpose:** "Field L19 is normally split Mason 33.333333%, Clayton 33.333333%, Chad 33.333334%." The `effective_date` handles ownership changes mid-season without losing history.

#### Table 2: `allocation_sets` — Versioning for split history

```sql
CREATE TABLE allocation_sets (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_type text NOT NULL CHECK (entity_type IN ('order', 'invoice')),
    entity_id uuid NOT NULL,
    version integer NOT NULL DEFAULT 1,
    created_by uuid REFERENCES auth.users(id),
    created_at timestamptz DEFAULT now(),
    is_active boolean DEFAULT true,
    notes text,
    UNIQUE(entity_type, entity_id, version)
);
```

**Purpose:** Every time splits are edited, a new allocation set is created. The latest `is_active = true` set is authoritative. All previous sets are permanent audit history.

#### Table 3: `order_line_allocations` — Splits on order line items

```sql
CREATE TABLE order_line_allocations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    allocation_set_id uuid NOT NULL REFERENCES allocation_sets(id) ON DELETE CASCADE,
    order_item_id uuid NOT NULL REFERENCES order_items(id),
    bill_to_customer_id uuid NOT NULL REFERENCES customers(id),
    split_percentage numeric(9,6) NOT NULL,
    amount_cents bigint NOT NULL,
    created_at timestamptz DEFAULT now()
);
```

#### Table 4: `invoice_line_allocations` — Splits on invoice line items

```sql
CREATE TABLE invoice_line_allocations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    allocation_set_id uuid NOT NULL REFERENCES allocation_sets(id) ON DELETE CASCADE,
    invoice_item_id uuid NOT NULL REFERENCES invoice_items(id),
    bill_to_customer_id uuid NOT NULL REFERENCES customers(id),
    split_percentage numeric(9,6) NOT NULL,
    amount_cents bigint NOT NULL,
    split_invoice_id uuid REFERENCES invoices(id),
    created_at timestamptz DEFAULT now()
);
```

### Rounding Logic (MUST be implemented in Postgres RPC)

```sql
-- Largest-remainder rounding for billing splits
-- Ensures split amounts sum EXACTLY to line total (no penny discrepancies)

-- Example: $4,500.00 (450000 cents) split 3 ways (33.333333% each)
-- Step 1: Calculate raw amounts
--   Mason:   450000 x 0.33333333 = 149999.9985 -> floor = 149999
--   Clayton: 450000 x 0.33333333 = 149999.9985 -> floor = 149999
--   Chad:    450000 x 0.33333333 = 149999.9985 -> floor = 149999
-- Step 2: Sum of floors = 449997, total = 450000, remainder = 3
-- Step 3: Distribute remainder to splits with largest fractional parts (1 cent each to top 3)
--   Mason:   149999 + 1 = 150000 ($1,500.00)
--   Clayton: 149999 + 1 = 150000 ($1,500.00)
--   Chad:    149999 + 1 = 150000 ($1,500.00)
-- Step 4: Verify: 150000 + 150000 + 150000 = 450000
```

**CRITICAL CONSTRAINT:** For each `(allocation_set_id, line_item_id)`: `SUM(amount_cents)` MUST equal the line item's `extended_cents`. Enforce via deferred constraint trigger.

### Billing Splits Workflow

1. Admin selects Field L19 for a job/order
2. System auto-loads splits from `field_billing_defaults` -> Mason 33.33%, Clayton 33.33%, Chad 33.34%
3. Admin can **accept defaults** OR **override** for this specific order
4. Splits saved to `order_line_allocations` via an `allocation_set`
5. When order becomes invoice, splits copy to `invoice_line_allocations`
6. Admin can choose: **one combined invoice** or click **"Generate Split Invoices"** to create separate invoices per split customer
7. If splits are edited later, a **new allocation set** is created (old one preserved as history)

### Scaling Note (500+ Fields)

Do NOT store 500 field-level split rows on a single invoice. Instead:
- Store field-level detail on the **blend ticket / work order** (operational record)
- Aggregate to **bill-to customer** level per invoice line when generating the invoice
- Keep a drill-down link from invoice -> originating blend ticket -> field details

## Field Mapping Architecture (G1) — Detailed Design

### PostGIS Schema for Fields

```sql
CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE fields (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL,
    acreage numeric(10,2),
    crop_type text,
    season integer NOT NULL DEFAULT 2026,
    primary_customer_id uuid REFERENCES customers(id),
    centroid geography(POINT, 4326),
    boundary geography(POLYGON, 4326),
    county text,
    state text DEFAULT 'IL',
    section text,
    soil_type text,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now(),
    deleted_at timestamptz
);

CREATE INDEX idx_fields_boundary ON fields USING GIST (boundary);
CREATE INDEX idx_fields_centroid ON fields USING GIST (centroid);
```

### How to Get 500+ Field Boundaries Into the System

1. **Export from CheMan** — Ask DataSmart if they can export field boundaries as GeoJSON, KML, or Shapefile. Fastest path.
2. **Import from precision ag platforms** — Climate FieldView, Granular, John Deere Operations Center, or AgLeader likely have boundaries.
3. **Import from USDA CLU data** — USDA FSA publishes Common Land Unit boundaries.
4. **Draw in browser** — Mapbox GL Draw for corrections. Last resort for 500 fields.

**Recommendation:** Pursue options 1-3 simultaneously. Start the data export conversation with DataSmart NOW.

### Mapping React Component Architecture

```
<MapPage>
  +-- <MapContainer>              (react-map-gl wrapper, Mapbox GL JS)
  |   +-- <FieldPolygonLayer>     (renders all field boundaries)
  |   +-- <FieldLabelLayer>       (field name labels at centroids)
  |   +-- <SelectedHighlight>     (highlight color on selected fields)
  |   +-- <DrawControl>           (@mapbox/mapbox-gl-draw for editing)
  +-- <FieldSearchPanel>          (search/filter by customer, field name, crop type)
  +-- <SelectedFieldsPanel>       (shows selected fields + acreage + splits)
      +-- <CreateBlendButton>     ("Create Blend Ticket" -> navigates with fields pre-populated)
```

### Performance with 500+ Polygons

- Load all **centroids** (points) on initial map render — lightweight, fast
- Load full **polygon boundaries** only when zoomed in past threshold (zoom level 12+)
- Use Mapbox's vector tile rendering — WebGL handles 500+ polygons smoothly
- Consider clustering centroids at low zoom levels

---

# PART E: Technical Risks, Red Flags & Pre-Implementation Checklist

## Technical Risks & Architectural Concerns

### CRITICAL

**E1. Billing Split Architecture is Underspecified in Original Plan**
The original plan defines `field_customer_splits` with field_id/customer_id/percentage. This is insufficient because:
- Splits aren't always at the field level (can be overridden per order/invoice)
- Different line items can split differently
- No versioning/audit trail for split changes
**Fix:** Use the 3-table + allocation set architecture from Part D.

**E2. No Immutable Audit Trail for Financial Operations**
General `logActivity()` is insufficient for financial operations. Need a dedicated, append-only `financial_audit_log` table with no UPDATE or DELETE allowed (enforced by RLS).

**E3. `billing_status` on Blend Tickets Conflates Two Concepts**
Original plan: `billing_status` with values `unbilled`, `linked`, `billed`, `prepaid`, `no_charge`. This mixes relationship status with payment status. A blend ticket can be linked to an order AND prepaid simultaneously.
**Fix:** Split into two columns:
```sql
order_link_status text DEFAULT 'unlinked' CHECK (order_link_status IN ('unlinked', 'linked'))
payment_status text DEFAULT 'unbilled' CHECK (payment_status IN ('unbilled', 'billed', 'prepaid', 'no_charge'))
```

### IMPORTANT

**E4. RPC Design is Too Coarse** — Several RPCs bundle multiple operations. Handle edge cases with explicit parameters.

**E5. No Soft Delete Strategy** — Add `deleted_at timestamptz` to all financial tables. Never hard-delete financial records.

**E6. Sequence Number Race Conditions** — `next_invoice_number()` style RPCs must use Postgres sequences or `SELECT ... FOR UPDATE` to prevent duplicates.

**E7. RLS Complexity with Billing Splits** — One invoice can reference 3 customers via splits. Verify RLS policies don't accidentally hide split data. Test early.

**E8. All Financial Calculations Must Be in Postgres** — React can display but never compute authoritative totals.

## Red Flags That Will Cause Problems If Not Addressed Now

1. **No Data Migration Strategy from CheMan** — 500+ fields, years of customer records, payment history, billing data. Contact DataSmart NOW about data export options (CSV, database dump, API).

2. **No Parallel-Run / Reconciliation Plan** — Run both systems simultaneously for at least one full billing cycle. Verify matching invoices, balances, and statements.

3. **No Multi-Year / Season Concept in Data Model** — Add `season` / `crop_year` to all operational and financial tables NOW.

4. **Maps Feature Must Use Mapbox (Not Google)** — Google's Drawing library is deprecated (Aug 2025) and may be removed ~May 2026.

5. **Invoice Split Math Not Enforced at Database Level** — Use deferred constraint triggers to enforce `SUM(split_amount_cents) = line_total_cents`.

6. **No Backup/Recovery Plan for Financial Data** — Verify Supabase backup configuration. Consider point-in-time recovery.

7. **The 26-35 Day Timeline Estimate is Unrealistic** — Realistic: 52-78 days focused, or 3-6 months part-time. Do NOT cancel CheMan based on 35-day timeline.

8. **Permissions Are Too Loose** — Critical operations (posting invoices, voiding, adjusting inventory, editing splits) should require admin role.

9. **No Offline / Weak-Signal Strategy** — Rural Illinois and Indiana have spotty cell coverage. PWA with offline data caching should move up if field staff will use the app during spray season.

## Pre-Implementation Checklist

Before writing ANY implementation code (after bug fix sprints complete):

### Must Do Now
- [ ] Enable PostGIS extension in Supabase project
- [ ] Contact DataSmart about CheMan data export (customers, fields, boundaries, billing history)
- [ ] Add `season integer` column to all existing operational/financial tables via migration
- [ ] Add `parent_customer_id` to customers table via migration
- [ ] Add `salesman_id` to orders and quotes tables via migration
- [ ] Add `deleted_at timestamptz` to all financial tables that don't have it
- [ ] Verify Supabase backup configuration (daily backups, point-in-time recovery)
- [ ] Create a Mapbox account and obtain API key

### Must Decide Now
- [ ] Mapbox GL JS vs MapLibre GL JS (recommendation: Mapbox for satellite imagery)
- [ ] How to get field boundary data (CheMan export? Precision ag platform? USDA CLU? Manual drawing?)
- [ ] Accounting integration target (QuickBooks Online? Xero? Manual for now?)
- [ ] When to start parallel-run testing (recommendation: as soon as Phase 2 billing is functional)

### Must NOT Do Now
- [ ] Do NOT cancel CheMan subscription
- [ ] Do NOT build maps UI before field data model and billing splits are complete
- [ ] Do NOT implement Stripe integration until invoice system is proven with manual payments
- [ ] Do NOT build customer portal until core billing, splits, and application records are solid

---

# PART F: Ideal Platform Vision & Competitive Advantage

> This section describes what a best-in-class 2026 ag chemical management platform would include — beyond just replicating CheMan.

## Ideal Platform Feature Set

### Day-to-Day Operations
- Visual dispatch board (calendar + map hybrid) showing all daily jobs
- Smart scheduling with constraint awareness (equipment capacity, applicator certifications, product compatibility, weather)
- Auto-generated mixing/loading worksheets based on tank size + spray rate + field acreage
- Real-time job tracking (applicators tap Start/Complete in the field)
- Tank cleanout tracking (what was last in each tank, required cleanout before switching product families)

### Billing & Accounting
- Three billing pipelines (chemical sales, field application, misc charges) through unified posting workflow
- Billing split engine at line-item level with allocation set versioning
- Prepay ledger as first-class concept (deposits, applications against invoices, balance tracking, end-of-season reconciliation)
- Finance program per-line-item tracking (manufacturer finance, dealer finance, cash)
- Manufacturer rebate tier tracking (purchase volumes against rebate thresholds)
- Automatic late fee / interest calculation (configurable per customer)
- Smart statement generation with email delivery

### Customer Management
- Customer hierarchy (parent groups containing related entities)
- Communication log (phone calls, emails, meetings logged against customer record)
- Customer profitability analysis (revenue minus COGS minus application cost per customer)
- Customer self-service portal (invoices, statements, application records, online payment)

### Inventory & Supply Chain
- Real-time multi-location inventory
- Weighted average cost calculation on receiving
- Receiving workflow with PO matching and discrepancy flagging
- Lot tracking for restricted-use products (full chain of custody)
- Reorder point alerts
- Supplier price comparison (historical pricing by supplier by product)

### Compliance & Regulatory
- Automatic EPA record generation from completed jobs
- Weather data auto-pull at job start (temperature, wind, humidity)
- RUP enforcement (license verification before allowing RUP orders/applications)
- Dicamba / sensitive crop buffer zone awareness
- State reporting format exports (Illinois pesticide use reporting)
- License expiration dashboard + proactive alerts (90/60/30 days)

### Field & Mapping
- Interactive satellite map with all 500+ fields
- Click-to-select -> start blend ticket workflow
- Application history per field (every product applied, every date, every rate)
- Crop rotation tracking (corn 2025 -> beans 2026)
- Soil type storage and label rate adjustment awareness
- Neighbor / sensitive area tracking (organic farms, schools, waterways)
- Field-level profitability analysis

### Reporting & Analytics
- Morning operational dashboard (today's jobs, weather, unbilled work, low inventory, past-due balances)
- AR aging with drill-down (current / 30 / 60 / 90 / 120+)
- Revenue and margin by customer, product, field, time period
- Salesman commission reporting
- Vehicle utilization (acres per sprayer per day/week/season)
- Season-over-season comparison
- Manufacturer rebate tier progress

### Mobile & Field Use
- Applicator mobile view (assigned jobs, start/complete, actual acres, photos, signatures)
- Offline capability (cached jobs, queued uploads, sync when connected)
- GPS-tagged photo documentation (auto-stamped with coordinates, timestamp, job ID)
- Navigation integration (tap field -> opens directions)
- Driver delivery view (route, signature capture, return initiation)

### Integrations
- QuickBooks / Xero (two-way invoice + payment sync)
- Weather data API (current conditions + forecast for scheduling)
- Precision ag platforms (import field boundaries from John Deere, Climate FieldView, etc.)
- Stripe ACH (payment links on invoices, auto-reconciliation)
- SMS notifications via Twilio (job dispatch, customer application notifications, invoice reminders)
- Email with open tracking

## Competitive Advantage Features

These features would differentiate CRX Manager from legacy software (CheMan, AgWorks, Agvance, Kahler):

### Tier 1: Game-Changers
- **Customer Self-Service Portal** — Customers log in to view invoices, payment history, application records, and make online payments.
- **Automatic Job-Complete Notifications** — When a field is sprayed, the customer gets a text/email with details.
- **Seasonal Program Builder** — Build complete season programs with committed acres and predictable revenue.

### Tier 2: Strong Differentiators
- **Manufacturer Rebate Tier Tracking** — Real-time tracking of purchase volumes against rebate tier thresholds.
- **Integrated Field Scouting Notes** — Scout observations tied to field records, visible when building blend tickets.
- **Supplier Price Comparison** — Historical pricing by supplier by product, visible at purchase time.
- **"What If" Scenario Pricing** — Model costs in real-time during customer calls.

### Tier 3: Polish & Professionalism
- **Morning Dashboard** — Comprehensive operational briefing for each day.
- **Activity Timeline on Every Record** — Chronological feed eliminating the need to check 5 different pages.
- **Proactive License Expiration Alerts** — Automated alerts at 90/60/30 days.

## Modern SaaS Patterns to Add

- **Notification System** — In-app bell with unread count, email notifications, daily digest option
- **Saved Views / Custom Filters** — One-click bookmarks for frequently used filter combinations
- **Keyboard Shortcuts** — N (new), S (save), -> (next record), Esc (cancel) for power users
- **Bulk Operations** — Select 20 unposted invoices -> "Post All", Select 15 fields -> "Create Blend Ticket"
- **Activity Feed / Timeline** — On every customer, order, and field record
- **Scheduled Automations** — Weekly email digests, monthly auto-generated statements

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
| `save_blend_ticket` | Accept order_id + billing_status params | 3 |
| `convert_quote_to_order` | Carry payment_source + finance_program_id from quote_items to order_items | 2 |
| `create_direct_order` | Accept payment_source + finance_program_id per item | 2 |
| `record_payment` | Add optional invoice_id param, update invoice balance | 2 |

## New RPCs to Create

| RPC | Purpose | Phase |
|-----|---------|-------|
| `link_blend_ticket_to_order` | Link blend ticket to order + map products | 3 |
| `create_order_from_blend_ticket` | Create order retroactively from blend ticket | 3 |
| `create_cycle_count` | Snapshot inventory into count items | 5 |
| `approve_cycle_count` | Approve count + adjust inventory | 5 |
| `create_invoice_from_order` | Generate invoice from order | 2 |
| `record_invoice_payment` | Record payment against invoice | 2 |
| `process_return` | Approve return -> restock + credit | 6 |
| `calculate_billing_splits` | Largest-remainder rounding for splits | 2 |
| `next_cycle_count_number` | CC-YYYY-NNNN | 5 |
| `next_invoice_number` | INV-YYYY-NNNN | 2 |
| `next_return_number` | RMA-YYYY-NNNN | 6 |

## Dependency Order
```
FINAL_ACTION_PLAN Sprints 0-5 (bug fixes — do these FIRST)
    |
Phase 1: Farm/Field Foundation (5-7 days) — G4 + Missing Gap A
    |
Phase 2: Billing Architecture (12-18 days) — G2 + G3 + G6 + Missing Gaps B, C
    |
Phase 3: Blend Ticket Linkage (3-4 days) — depends on Phase 1+2
    |
Phase 4: Recipes + Maps (8-12 days) — G5 + G1, depends on Phase 1
    |
Phase 5: Inventory Enhancements (5-7 days) — Missing Gaps D, E
    |
Phase 6: Returns/RMA (4-5 days) — depends on Phase 2 for credit handling
    |
Phase 7: Reporting + Sales + Compliance (10-15 days) — G7 + G8 + Missing Gap F
    |
Phase 8 (FUTURE): Customer Portal, Mobile, Integrations
```

## How to Test End-to-End

After each phase:
1. `npm run build` — must pass clean
2. Manual test in browser: create/edit/view the new entities
3. Verify Supabase data via `execute_sql` queries
4. Run `get_advisors` for security + performance checks
5. Verify RLS: test as admin, sales_rep, and driver roles

---

> **END OF DOCUMENT**
>
> This document should be read by any implementing agent (Claude Code, Cursor, etc.) before starting work on any phase. The companion `CRX_MANAGER_ARCHITECTURE_REVIEW.md` contains additional detailed reference material.
>
> **REMINDER: This is a PLANNING DOCUMENT. DO NOT IMPLEMENT without explicit user approval per phase.**
