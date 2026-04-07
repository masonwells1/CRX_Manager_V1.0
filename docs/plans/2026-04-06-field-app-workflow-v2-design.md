# Field Application Workflow V2 Design

> **Date:** 2026-04-06
> **Status:** Approved
> **Research:** `docs/research/chemman-field-application-research.md`
> **Goal:** Build Chem-Man-style field application workflow in CRX Manager

## Context

CRX Manager excels at chemical sales and inventory but lags behind Chem-Man
for in-field application workflows. After researching Chem-Man's features via
Playwright browser automation, we identified the core advantage: a streamlined
"select locations, enter chemicals, auto-figure" flow that handles
multi-customer billing splits automatically.

CRX already has 70% of the data model (field_billing_defaults, job_fields,
recipes, invoice_shares, CRXMap). The primary work is UX improvements,
auto-calculation logic, and a few new tables.

## Architecture Decisions

1. **Multi-customer jobs** -- `jobs.customer_id` becomes nullable (Option A)
2. **Reusable SelectLocationsModal** -- shared component for jobs AND invoices
3. **New dedicated page** -- `/invoices/field-app/new` for field app invoices
4. **Per-customer tier pricing** -- each customer billed at their tier price

## Schema Changes

### New Table: `field_app_locations`

Links a field application invoice or job to specific fields:

| Column | Type | Purpose |
|--------|------|---------|
| id | uuid PK | |
| invoice_id | uuid FK nullable | Links to invoice |
| job_id | uuid FK nullable | Links to job |
| field_id | uuid FK | The field being applied to |
| map_number | integer | Sequential map number for loader worksheet |
| total_acres | numeric | Total field acres (snapshot) |
| planted_acres | numeric | Planted acres |
| applied_acres | numeric | Actual applied acres (editable) |
| crop_type | text | Crop at time of application |
| wind_direction | text | Wind direction (N, NE, E, etc.) |
| sort_order | integer | Display order |
| created_at | timestamptz | |

Constraint: CHECK (invoice_id IS NOT NULL OR job_id IS NOT NULL)

### New Table: `field_app_location_shares`

Per-location customer billing shares:

| Column | Type | Purpose |
|--------|------|---------|
| id | uuid PK | |
| location_id | uuid FK | References field_app_locations |
| customer_id | uuid FK | Customer for this share |
| split_pct | numeric | Their percentage of this field |
| acres | numeric | Their share of applied acres |
| amount_cents | bigint | Their dollar share (calculated on save) |
| created_at | timestamptz | |

### Alter: `jobs` table

- `customer_id` becomes nullable: `ALTER COLUMN customer_id DROP NOT NULL`
- Existing jobs keep their customer_id; new multi-customer jobs have NULL

## RPCs

### `derive_customer_shares_from_fields(p_field_ids uuid[])`
- Reads field_billing_defaults for each field
- Aggregates each customer's acres across all selected fields
- Returns: array of { customer_id, customer_name, total_pct, total_acres }
- Used by frontend for live CustomerSharesTable updates

### `save_field_app_invoice(p_invoice, p_locations, p_chemicals, p_idempotency_key)`
- Creates/updates invoice + field_app_locations + location_shares + invoice_items
- Auto-calculates: total applied, line totals (per customer tier price), invoice total
- Auto-derives invoice_shares from aggregated location shares
- Atomic transaction with idempotency

### `save_field_app_job(p_job, p_locations, p_chemicals, p_idempotency_key)`
- Creates/updates job with customer_id = NULL
- Saves field_app_locations and chemicals
- Similar to existing save_job() but multi-customer aware

### `transfer_field_app_job_to_invoice(p_job_id, p_idempotency_key)`
### `transfer_field_app_invoice_to_job(p_invoice_id, p_idempotency_key)`
- Bi-directional transfer copying locations, chemicals, and shares

## Frontend Components

### SelectLocationsModal.tsx
- Full-screen modal: CRXMap (left) + filterable table (right)
- Filters: Customer dropdown, Location text search, Crop dropdown
- Table columns: checkbox, Map #, Name, Crop, Customer(s), Planted, Total
- Map shows field boundaries with click-to-toggle
- Returns selected field IDs + billing defaults to parent
- Reusable for both jobs and invoices

### FieldAppChemicalEntry.tsx
- Chemical search autocomplete showing name + EPA reg number
- On product select: auto-fills rate (default_rate), UM, price (customer tier)
- Columns: Product, Warehouse, Rate/acre, UM, Total Applied, Price, Price UM, Line Total
- Recipe support: Select Recipe, Use Last Used Recipe, Save As Recipe
- Crop Program loading support
- Shows Price/Acre and Invoice Total summaries

### CustomerSharesTable.tsx
- Read-only auto-calculated table
- Columns: Customer Name, Total Shares %, Total Acres, Discount Earned, Invoice Total
- Totals row (must sum to 100%)
- Per-customer tier pricing: each customer's dollar amount uses THEIR tier price
- Recalculates live as locations or chemicals change

### FieldApplicationInvoice.tsx (new page)
- Routes: /invoices/field-app/new and /invoices/field-app/:id
- Tab layout: Locations | Chemicals/Charges | Customers | Applied Info
- Header: Invoice #, Transaction Date, Consultant
- Actions: Save, Post, Print, Delete, Transfer to Scheduling

### Existing Page Changes
- Jobs.tsx: update customer filter for multi-customer jobs
- JobDetail.tsx: when customer_id is null, show SelectLocationsModal
- Invoices.tsx: add "New Field Application" button routing to /invoices/field-app/new
- App.tsx: lazy import + route for FieldApplicationInvoice

## Auto-Figuring Calculation Chain

```
applied_acres = sum(all locations' applied_acres)

Per chemical line:
  total_applied = rate_per_acre x applied_acres
  line_total_per_customer = tier_price x (customer_acres / applied_acres) x total_applied
  line_total = sum(all customer line totals)

invoice_total = sum(all line_totals)
price_per_acre = invoice_total / applied_acres

Per customer:
  customer_pct = customer_total_acres / applied_acres
  customer_total = sum(their per-line tier-priced totals)
```

## User Flow

1. User clicks "New Field Application" on Invoices page
2. Clicks "Select Locations" -> map + list modal opens
3. Selects fields -> CustomerSharesTable populates from field_billing_defaults
4. Enters chemicals (or loads recipe/program) -> rates + prices auto-fill
5. Auto-figuring calculates totals live as data changes
6. User clicks "Save Invoice" -> atomic RPC saves everything
7. User clicks "Post Invoice" -> existing post_invoice() flow

## Implementation Phases (tonight)

### Phase 1: Database Foundation
- Migration: field_app_locations + field_app_location_shares tables
- Migration: jobs.customer_id nullable
- RPC: derive_customer_shares_from_fields()
- RPC: save_field_app_invoice()

### Phase 2: Core Components
- SelectLocationsModal.tsx
- FieldAppChemicalEntry.tsx
- CustomerSharesTable.tsx

### Phase 3: Page + Wiring
- FieldApplicationInvoice.tsx page
- App.tsx route + lazy import
- Invoices.tsx "New Field Application" button
- Types in index.ts

### Phase 4: Polish + Docs
- Update CLAUDE.md counts
- Update docs/reference files
- Commit and push
