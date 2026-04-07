# Chem-Man Field Application Research

> **Date:** 2026-04-06
> **Researched by:** Claude (Playwright browser automation of login.chem-man.com)
> **Purpose:** Document Chem-Man's field application workflows to model improvements in CRX Manager
> **Account:** Crop RX Solutions, Inc. (Martinsville, IL)

---

## Executive Summary

CRX Manager excels at chemical sales and inventory management but lags behind Chem-Man for **in-field application workflows**. Chem-Man's core advantage is a streamlined "select locations, enter chemicals, auto-figure" flow that:

1. Lets you build multi-customer jobs/invoices from a single map-based field picker
2. Auto-populates pricing and suggested rates when adding chemicals
3. Auto-calculates billing splits across customers based on field ownership

This document captures every detail of Chem-Man's two key features for reference during CRX Manager development.

---

## Feature 1: Manage Job Scheduling (Work Orders)

### Overview

Jobs in Chem-Man are **multi-customer batch work orders** -- one job can span fields belonging to many different customers. This is fundamentally different from CRX Manager where `jobs.customer_id` limits a job to one customer.

**URL pattern:** `/#/jobSchedules/editJob/{jobId}/{storeId}`

### Job Editor Structure

The editor is a single scrolling page with **5 tabs** at the top:

| Tab | Purpose |
|-----|---------|
| **Locations** | Select fields to spray, view/edit map, per-field details |
| **Chemical/Charges** | Tank mix entry with product search, rates, recipes |
| **Loader Worksheet** | Vehicle capacity, loads calculation, applicator assignment |
| **Applied Info** | Weather data, actual acres applied, completion tracking |
| **Notifications** | Pre/post application notifications to customers |

### Job Header Fields

| Field | Type | Notes |
|-------|------|-------|
| Job # | Auto-generated | Numeric, sequential |
| Status | Dropdown | Pending, In Progress, Complete, Cancelled |
| Call Date | Date | When customer called |
| Date Proposed | Date | Proposed application date |
| Time Proposed | Time | Proposed time |
| Schedule Date | Date | Firm scheduled date |
| Date Expires | Date | Quote/schedule expiration |
| Consultant | Dropdown | Crop consultant reference |

### Select Locations Modal

This is the **core differentiator**. A full-screen modal with:

**Left side: Interactive Map**
- Satellite imagery (Google Maps via Leaflet)
- Field boundaries drawn as orange polygons
- Each field labeled with name + acres
- Click to select/deselect fields on map

**Right side: Filterable Location Table**

| Filter | Type | Purpose |
|--------|------|---------|
| Select Customers | Multi-select dropdown | Filter fields by customer |
| Location | Text search | Search by field name |
| Crop | Dropdown | Filter by crop type |
| Strip | Dropdown | Filter by strip configuration |

**Table columns:**
| Column | Description |
|--------|-------------|
| Checkbox | Select/deselect field |
| Map # | Sequential number for loader worksheet reference |
| Name | Field name |
| Crops | Current crop (Corn, Soybeans, etc.) |
| Customers | Owning customer(s) with ID numbers |
| Planted | Planted acres (can differ from total) |
| Total | Total field acres |

**Key behaviors:**
- Shows ALL fields across ALL customers in one view
- Each field knows its customer ownership and billing splits
- Multiple customers can appear on one field (e.g., landlord + tenant)
- "Planted" and "Total" can differ (partial planting)
- Map numbers are sequential for loader worksheet cross-reference
- Confirm selection with "Select Locations" button

### Per-Location Detail (Expanded View)

When "Toggle Location Details" is clicked, each field row expands to show:

| Field | Type | Notes |
|-------|------|-------|
| Location name | Text | Pre-populated from field master |
| Customers | Display | All customers with addresses (e.g., "Wells, Chad (1003), 4497 N. Melrose Rd.") |
| Acres | Number | Total field acres |
| Planted | Number | Planted acres |
| Applied | Editable number | Defaults to planted; can override |
| Wind | 8-direction compass | NW/N/NE/W/E/SW/S/SE indicator buttons |
| Crop | Dropdown | Corn, Soybeans, etc. |
| Strip | Dropdown | Strip configuration |
| Pests | Dropdown | Target pests |

**Multi-customer fields** show all customers with addresses under the location name:
- Example: "R2 -- Customers: Wells, Chad (1003), 4497 N. Melrose Rd. / Piersall, Heidi (1030), 9109 Amelia Dr. / Randle, Sue (1031), 20002 N. 1500th St."

### Chemicals / Charges Section

**Recipe System:**
- "Select Recipe" button -- load a saved tank mix
- "Use Last Used Recipe" button -- quick re-use
- "Save As Recipe" button with name field -- save current mix

**Chemical Entry Table:**

| Column | Type | Description |
|--------|------|-------------|
| Drag handle | Icon | Reorder chemicals |
| Chemical/Charge Search | Autocomplete | Product search showing name + EPA reg # |
| Select Warehouse | Dropdown | Source warehouse |
| Select Vendor | Dropdown | Product vendor |
| Rate/acre | Number | Application rate per acre |
| (Calculator) | Button | Rate calculation helper |
| UM | Dropdown | Unit of measure (FL OZ, PT, QT, GL, LB) |
| Total Applied | Auto-calculated | Rate/acre x Total Acres |
| Delete | Button | Remove line |

**Chemical dropdown behavior:**
- Type 2+ characters to search
- Shows product name + EPA registration number (e.g., "AGSAVER GLYPHOSATE 53.8% (83772-12)")
- Auto-populates suggested rate and default unit of measure
- Pulls in pricing from product master

**Below chemicals:**
| Field | Description |
|-------|-------------|
| Diluent Rate | Carrier/water rate |
| Hours Reentry | REI (Restricted Entry Interval) |
| Days Preharvest | PHI (Pre-Harvest Interval) |

### Loader Worksheet Setup

| Field | Type | Description |
|-------|------|-------------|
| Select Applicator | Dropdown | Person applying |
| Vehicle | Dropdown | Application equipment |
| Vehicle Capacity | Number | Tank size in gallons |
| Rate | Number + unit (GL) | Spray rate per acre |
| Acre | Auto-populated | Total job acres from locations |
| Loads | Auto-calculated | Acres x Rate / Vehicle Capacity |
| Total Job Acres | Display | Sum of all selected field acres |

Shows "Invalid" if vehicle capacity is 0 (can't calculate loads).

### Applied Info Section

- "Toggle Applied Info Details" -- expand/collapse
- "Total Remaining Acres: X of Y" -- tracks completion
- Weather Info powered by Visual Crossing API
- "Add Applied Info" button for recording actual application data

### Notes Fields

| Field | Printed? |
|-------|----------|
| Loader Comment | Yes |
| Additional Info | Yes |
| Internal Job/Invoice Memo | No (internal only) |

### Job Tags

Clickable tag badges on job list and editor:
- Y-Drop
- Fungicide
- Foliar Feed
- Pre-Emerge
- Post-Emerge Chemical
- Other
- Y-Drop Toolbar

### Job Actions

| Action | Description |
|--------|-------------|
| Mark Job as Cancelled | Cancel the job |
| Transfer to Invoice | Convert completed job to field application invoice |
| Send Post-Notification | Notify customers after application |
| Cancel Without Saving | Discard changes |
| Save Job | Persist all changes |

### Job List Page

**Filters:** Job Nbr, Select Customers, Select Applicator, Schedule Date From/To, Job Tags, More
**Toolbar:** Map Selected Jobs, Select By Map, Mass Edit, Edit Job Tags, Job Batches, Chemical Summary Report, More Report Options, New Dispatch & Applicator View

**Table columns:** Checkbox, Tags, Job Nbr, Customers, Locations, Applicators, Crops, Chemicals, Tot. ac, Rem. ac, Scheduled, Status, Created By, Updated By, Printed

---

## Feature 2: Unposted Field Application Invoice

### Overview

The invoice editor is **nearly identical to the job editor** but adds **pricing columns** and **auto-calculated customer billing splits**. This is the "auto-figuring" feature.

**URL pattern:** `/#/invoices/editInvoice/{invoiceId}` or `/#/invoices/editInvoice/new`

### Invoice Editor Structure

Same 5-tab layout as jobs, but the tabs are:

| Tab | Purpose |
|-----|---------|
| **Locations** | Same Select Locations as jobs |
| **Chemical/Charges** | Same as jobs BUT with pricing columns |
| **Customers** | Auto-calculated billing splits (NEW vs jobs) |
| **Applied Info** | Same as jobs |
| **Notifications** | Same as jobs |

### Invoice Header

| Field | Type | Notes |
|-------|------|-------|
| Invoice # | Auto-generated | e.g., "230498 - Corn Fertilizer Pre Pay" |
| Transaction Date | Date | Invoice date |
| Consultant | Dropdown | Crop consultant |

### Locations Section (Same as Jobs)

Identical to job editor -- Select Locations modal, per-field details, wind tracking, crop/strip/pests dropdowns.

Additional button: **"Add Temporary Location"** -- for one-off fields not in the system.
Additional link: **"Open Manage Field Locations"** -- quick jump to field master data.

### Chemicals / Charges Section (Enhanced vs Jobs)

Same as jobs BUT with additional pricing columns:

| Column | Type | Description |
|--------|------|-------------|
| Chemical/Charge Search | Autocomplete | Same as jobs |
| Select Warehouse | Dropdown | Same |
| Select Vendor | Dropdown | Same |
| Rate/acre | Number | Same |
| UM | Dropdown | Same |
| Total Applied | Auto-calculated | Rate x Acres |
| **Price** | **Number** | **Price per unit (NEW)** |
| **Price UM** | **Dropdown** | **Price unit of measure (NEW)** |
| **Total $** | **Auto-calculated** | **Price x Total Applied (NEW)** |

**Auto-calculated summaries:**
- **Price/Acre** = Invoice Total / Total Applied Acres
- **Invoice Total** = Sum of all chemical line totals

**Additional fields:**
- Diluent Per acre
- Current Fuel Price

### Real Example: Invoice #230498 - Corn Fertilizer Pre Pay

```
Locations: 26 fields, 1520.30 total applied acres
Customers: 6 (Wells Mason, Wells Clayton, Wells Chad, Piersall Heidi, Randle Sue, Wells Farms LLC)

Chemical 1: Corn In-Furrow Program
  Rate: 1.000000 GL/acre
  Total Applied: 1520.300000 GL
  Price: $34.98/GL
  Line Total: $53,180.09

Chemical 2: Corn 2X2 Fertilizer
  Rate: 1.000000 GL/acre
  Total Applied: 1520.300000 GL
  Price: $21.93/GL
  Line Total: $33,340.18

Price/Acre: $56.91
Invoice Total: $86,520.27
```

### The Auto-Figuring Calculation Chain

```
1. Rate/acre x Total Acres = Total Applied
   (1 GL/ac x 1520.30 ac = 1520.30 GL)

2. Price per unit x Total Applied = Line Total
   ($34.98/GL x 1520.30 GL = $53,180.09)

3. Sum of all Line Totals = Invoice Total
   ($53,180.09 + $33,340.18 = $86,520.27)

4. Invoice Total / Total Acres = Price/Acre
   ($86,520.27 / 1520.30 ac = $56.91/ac)

5. Customer Shares auto-derived from field ownership:
   Each customer's % = (their acres / total acres)
   Each customer's $ = Invoice Total x their %
```

### Customers Section (Auto-Calculated)

**"Customer Shares By" dropdown:** Options include "Locations" (default) which auto-derives splits from field ownership.

| Column | Description |
|--------|-------------|
| Name | Customer name + ID |
| Total Shares | Percentage of total acres |
| Total acres | Sum of their field acres |
| Discount Earned | Volume/loyalty discount |
| Invoice Total | Their share of the total |

**Real example from Invoice #230498:**

| Customer | Share % | Acres | Invoice Total |
|----------|---------|-------|---------------|
| Wells, Mason (1000) | 15.00% | 228.03 | $12,977.15 |
| Wells, Clayton (1001) | 15.00% | 228.05 | $12,978.37 |
| Wells, Chad (1003) | 32.01% | 486.72 | $27,699.19 |
| Piersall, Heidi (1030) | 8.80% | 133.78 | $7,613.42 |
| Randle, Sue (1031) | 4.73% | 71.89 | $4,091.28 |
| Wells Farms LLC. (229561) | 24.46% | 371.83 | $21,160.86 |
| **Totals** | **100.00%** | **1520.30** | **$86,520.27** |

### Applicator Info Summary

| Field | Type |
|-------|------|
| Select Applicator | Dropdown (e.g., Wells, Clayton) |
| Vehicle | Dropdown (e.g., Rogator 1100C) |
| Shares | Number (default 100) |
| Acre | Auto-populated from locations |

### Invoice Actions

| Action | Description |
|--------|-------------|
| Delete Invoice | Remove the invoice |
| **Transfer to Scheduling** | **Convert invoice back to job (reverse direction!)** |
| Post Invoice | Finalize invoice to AR |
| Send Post-Notification | Notify customers |
| Print | Generate PDF |
| Cancel Without Saving | Discard |
| Save Invoice | Persist |

### Invoice List Page (Unposted)

**Filters:** Inv. Nbr, Select Customers, Transaction Date From/To
**Batch actions:** Print All, Old Print All, Print Invoice Report, Post All

**Table columns:** Checkbox, Job Nbr, Customers, Locations, Applicators, Crops, Chemicals, Acres, Total, Transaction date

---

## Gap Analysis: CRX Manager vs Chem-Man

### What CRX Manager Already Has

| Existing Feature | Table/Code | Notes |
|-----------------|------------|-------|
| Field billing splits | `field_billing_defaults` | Per-field customer splits with percentages |
| Job-field linking | `job_fields` | Many-to-many with acres_to_treat |
| Job chemicals | `job_chemicals` | Products with rate_per_acre, cost, price |
| Saved recipes | `recipes` table | Loadable into jobs |
| Job-to-invoice transfer | `transfer_job_to_invoice()` RPC | One-way only |
| Invoice shares | `invoice_shares` table | Billing splits on invoices |
| Map infrastructure | CRXMap + FieldBoundaryLayer | Satellite + field polygons |
| Application records | `application_records` table | Immutable truth layer |
| Product EPA data | `products.epa_registration` | Regulatory compliance |
| Tier pricing | `products.tier1/2/3_price` | Customer tier-based pricing |
| Application services | `application_services` table | Named services with per-acre pricing |

### Major Gaps

| Gap | Severity | Description |
|-----|----------|-------------|
| **Multi-customer jobs** | Critical | CRX jobs have single `customer_id`; Chem-Man spans many customers |
| **Select Locations modal** | Critical | No unified map + list field picker across all customers |
| **Auto-figuring engine** | Critical | No auto-calculation of totals and customer splits from locations + chemicals |
| **Inline pricing on chemical entry** | High | Invoice chemical entry doesn't show price per unit and line total inline |
| **Auto customer shares** | High | `field_billing_defaults` data exists but isn't auto-applied to invoices |
| **Bi-directional transfer** | Medium | CRX only has job-to-invoice, not invoice-to-job |
| **Loader worksheet calc** | Medium | Vehicle capacity / loads auto-calculation |
| **Per-field wind tracking** | Low | Wind direction per location |
| **Chemical suggested rates** | Low | Auto-populate rate when product selected |

### What CRX Does Better Than Chem-Man

| Feature | CRX Advantage |
|---------|---------------|
| Inventory management | Full warehouse, PO, receiving, cycle count system |
| Quote-to-order pipeline | Sophisticated quote builder with tier pricing |
| Financial suite | Payments, prepay credits, write-offs, finance charges |
| Commission tracking | Per-order commission splits |
| Role-based access | RLS policies on every table |
| Audit trail | `financial_audit_log` + activity logging |
| Modern UI | React + Tailwind vs Chem-Man's older Vue.js interface |

---

## Recommended Implementation Phases

### Phase 1: Select Locations Modal
- Build unified field picker with map + filterable table
- Show fields across all customers
- Integrate with existing CRXMap + FieldBoundaryLayer
- Display billing splits per field from `field_billing_defaults`

### Phase 2: Enhanced Job Editor
- Support multi-customer jobs (derive customers from selected fields)
- Auto-populate chemicals from recipes with suggested rates
- Add loader worksheet calculations
- Bi-directional job/invoice transfer

### Phase 3: Auto-Figuring Invoice
- Add inline pricing to chemical entry (price per unit + line total)
- Auto-calculate Price/Acre and Invoice Total
- Auto-derive Customer Shares from `field_billing_defaults`
- "Customer Shares By: Locations" dropdown

### Phase 4: Polish
- Per-field wind tracking
- Chemical suggested rates auto-population
- Job tags system
- Pre/post notification system
