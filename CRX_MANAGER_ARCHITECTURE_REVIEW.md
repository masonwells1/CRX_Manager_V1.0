# CRX Manager — Complete Architecture Review & Recommendations

> **For:** Claude Code / any implementing agent
> **Status:** REFERENCE DOCUMENT — Read before implementing any phase
> **Created:** February 12, 2026
> **Source:** Multi-session review of CheMan walkthrough, gap analysis (G1–G17), Phase 1–7 plan, ideal platform analysis, and cross-review with ChatGPT architectural analysis
> **Canonical planning doc:** `KINMAN_REVIEW_AND_GAP_ANALYSIS.md` (contains PART A/B/C)

---

## Table of Contents

1. [Tech Stack](#1-tech-stack)
2. [Critical Data Model Decisions (Lock In Before Any Code)](#2-critical-data-model-decisions-lock-in-before-any-code)
3. [Critical Technology Decisions (Lock In Before Any Code)](#3-critical-technology-decisions-lock-in-before-any-code)
4. [Gap Analysis Review (G1–G8)](#4-gap-analysis-review-g1g8)
5. [Missing Gaps Not in Original Analysis](#5-missing-gaps-not-in-original-analysis)
6. [Recommended Phase Sequencing (Rewritten)](#6-recommended-phase-sequencing-rewritten)
7. [Billing Splits Architecture (G2) — Detailed Design](#7-billing-splits-architecture-g2--detailed-design)
8. [Google Maps / Field Mapping Architecture (G1) — Detailed Design](#8-google-maps--field-mapping-architecture-g1--detailed-design)
9. [Technical Risks & Architectural Concerns](#9-technical-risks--architectural-concerns)
10. [Red Flags That Will Cause Problems If Not Addressed Now](#10-red-flags-that-will-cause-problems-if-not-addressed-now)
11. [Ideal Platform Feature Set (Beyond CheMan Clone)](#11-ideal-platform-feature-set-beyond-cheman-clone)
12. [Competitive Advantage Features](#12-competitive-advantage-features)
13. [Modern SaaS Patterns Missing from Current Plan](#13-modern-saas-patterns-missing-from-current-plan)
14. [Pre-Implementation Checklist](#14-pre-implementation-checklist)

---

## 1. Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18, TypeScript, Vite, Tailwind CSS |
| Backend | Supabase (Postgres + Auth + Storage + Edge Functions) |
| Deployment | Vercel |
| Mapping | Mapbox GL JS (recommended) or MapLibre GL JS |
| Geospatial DB | PostGIS extension in Supabase |
| Payments (future) | Stripe ACH |
| Notifications (future) | Twilio SMS, email via Edge Functions |

---

## 2. Critical Data Model Decisions (Lock In Before Any Code)

These decisions affect every table and every RPC. Get them right now or pay for it in rework later.

### 2A. Money: Store as Integer Cents (`bigint`), Not Decimals

```sql
-- ✅ CORRECT: integer cents
amount_cents bigint NOT NULL  -- $1,499.85 stored as 149985

-- ❌ WRONG: decimal dollars
amount numeric(12,2)  -- works 95% of the time, fails on split math edge cases
```

**Why:** When you split $4,500.00 three ways and multiply by 0.3333, decimal math can produce tiny rounding artifacts that compound across 500+ fields. Integer cents with largest-remainder rounding eliminates this entirely. Convert to dollars only for display in the UI.

### 2B. Percentages: Store as `numeric(9,6)`

```sql
split_percentage numeric(9,6) NOT NULL  -- 33.333333%
```

**Why:** `numeric` is exact (no floating-point surprises). 6 decimal places handles any reasonable split precision.

### 2C. Splits: Store at Line-Item Level (Not Invoice Header)

Splits must be on `invoice_items` and `order_items`, not on the invoice/order header. This is because different line items on the same invoice can have different split configurations (e.g., landlord pays for chemical, tenant pays for application fee).

Header-level splits are a **convenience shortcut** that applies the same percentages to all lines — but the authoritative data lives at the line level.

### 2D. Split History: Use Allocation Set Versioning

Every time someone edits a split, create a new allocation set (immutable append-only). The latest set is "active." All previous sets are permanent history. This gives you a tamper-proof audit trail for financial records.

### 2E. Season / Crop Year on All Operational Tables

```sql
season integer NOT NULL DEFAULT 2026  -- or crop_year
```

Add this column to: `orders`, `invoices`, `blend_tickets`, `fields` (for crop rotation), `payments`, `inventory_transactions`. This enables season-over-season reporting and clean end-of-year closeouts. Retrofitting this later across every table is miserable.

### 2F. Customer Hierarchy

```sql
parent_customer_id uuid REFERENCES customers(id)  -- for customer groups
```

Add to `customers` table. Enables "Wells Family Group" containing Mason, Clayton, Chad, and Wells Family Trust. Essential for group-level reporting and billing.

### 2G. Salesman Tracking on Financial Records

```sql
salesman_id uuid REFERENCES users(id)  -- or staff/employees table
```

Add to `orders`, `invoices`, `quotes`. If you pay salespeople commission, this must be in the data model from day one — not bolted on after you've created thousands of records without it.

### 2H. Soft Deletes on All Financial Tables

```sql
deleted_at timestamptz  -- NULL means active, timestamp means soft-deleted
```

Never hard-delete invoices, payments, orders, or blend tickets. Use `void` / `cancelled` statuses for workflow, and `deleted_at` as the ultimate safety net.

---

## 3. Critical Technology Decisions (Lock In Before Any Code)

### 3A. Mapping: Use Mapbox GL JS (NOT Google Maps)

**Reasons:**
- Google's Maps JavaScript Drawing library was **deprecated August 2025** and is scheduled to become unavailable ~May 2026. If you build polygon editing on Google's DrawingManager, you'll face a forced rewrite within months.
- Mapbox renders with WebGL — handles 500+ polygons significantly better than Google Maps' SVG/DOM rendering.
- `react-map-gl` by Uber is an excellent, well-maintained React wrapper.
- Mapbox free tier (50K map loads/month) is generous enough for an internal app.

**Alternative:** MapLibre GL JS (open-source fork of Mapbox, zero cost) if you're willing to source your own satellite tile layer. Mapbox is recommended because its built-in satellite imagery is essential for identifying fields.

### 3B. Geospatial: Enable PostGIS in Supabase

```sql
CREATE EXTENSION IF NOT EXISTS postgis;
```

Use `geography(POLYGON, 4326)` for field boundaries and `geography(POINT, 4326)` for centroids. Add GIST spatial indexes. Compute acreage via `ST_Area()`. Serve GeoJSON to the frontend via `ST_AsGeoJSON()`.

### 3C. All Financial Math in Postgres RPCs (Never in React)

The database is the single source of truth for:
- Split calculations (largest-remainder rounding)
- Invoice totals
- Payment application
- Inventory adjustments
- Balance calculations

React can *display* calculated values but must never compute authoritative financial totals. This prevents frontend bugs from corrupting financial data.

### 3D. Immutable, Append-Only Patterns for Financial Events

Inventory movements, invoice revisions, split changes, payment applications, and credit adjustments should be **append-only** (insert new rows, never update/delete old ones). This preserves a complete audit trail.

---

## 4. Gap Analysis Review (G1–G8)

### Priority Assessment

| Gap | Description | Original Priority | Reviewed Priority | Notes |
|-----|------------|-------------------|-------------------|-------|
| **G1** | Google Maps field selection → start blends/orders | 🔴 #1 FAVORITE | **Build 5th** | User's favorite feature but depends on G4 + G2 being solid first. Build the data model before the UI. |
| **G2** | Customer billing splits | CRITICAL | **Build 2nd (architectural priority #1)** | Touches every downstream system. If this data model is wrong, everything breaks. |
| **G3** | Unposted → Posted invoice workflow | CRITICAL | **Build 3rd** | Under-designed in current plan. Needs full approval pipeline, batch operations, audit logging, ability to void. |
| **G4** | Farm/field setup with splits + acreage | CRITICAL | **Build 1st** | Data backbone — must exist before G1, G2, or anything referencing fields. |
| **G5** | Saved blend recipes / programs | CRITICAL | **Downgrade to IMPORTANT** | Productivity feature, not a blocker. System works without it (just slower). Build after core billing. |
| **G6** | Miscellaneous charges | CRITICAL | **CRITICAL — Build 4th** | Can't fully replace CheMan without all 3 billing types. |
| **G7** | Customer statements + AR aging | CRITICAL | **CRITICAL — but sequence later** | Reporting/read-only. Build after the write-side (invoices, payments, splits) is solid. |
| **G8** | Season program planning / booking | CRITICAL | **Downgrade to IMPORTANT** | Seasonal workflow. 2026 planning likely done in CheMan already. Build before fall 2026 for 2027 planning cycle. |

### Recommended Build Order for Gaps

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

---

## 5. Missing Gaps Not in Original Analysis

The gap analysis (G1–G17) missed these features that CheMan provides or that are architecturally necessary:

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

## 6. Recommended Phase Sequencing (Rewritten)

The original Phase 1–7 plan has a structural problem: it builds billing linkage (Phase 1) and inventory counting (Phase 2) BEFORE the farm/field data model, billing splits, or unposted→posted workflow exist. This guarantees rework.

### Rewritten Sequence

```
Phase 0: Bug fix sprints S0-S5 (already planned — do these FIRST)
    ↓
Phase 1 (NEW): Farm/Field Data Foundation                          [~5-7 days]
    - fields table with PostGIS boundary support
    - field_customer_splits (default billing splits per field)
    - customer hierarchy (parent_customer_id)
    - field management UI (list + detail view)
    - Enable PostGIS extension
    - This is G4 + Missing Gap A
    ↓
Phase 2 (NEW): Billing Architecture                                [~12-18 days]
    - Invoice system with line-item structure
    - Billing splits at line-item level with allocation set versioning
    - Unposted → Posted workflow with batch operations + audit trail
    - Miscellaneous charges support (3 billing types: chemical, application, misc)
    - Salesman tracking on orders/invoices
    - Prepay ledger and credit application workflow
    - Payment application to specific invoices
    - This is G2 + G3 + G6 + Missing Gaps B, C
    ↓
Phase 3 (MOVED): Blend Ticket ↔ Order Linkage                     [~3-4 days]
    - Original Phase 1, but now references fields + splits correctly
    - Blend ticket billing status (split into order_link_status + payment_status)
    - Junction table mapping blend ticket products to order items
    - RPCs for linking and creating orders from blend tickets
    ↓
Phase 4 (NEW): Saved Recipes + Maps                                [~8-12 days]
    - Blend recipes/programs (G5) — quick to build, high productivity value
    - Mapbox GL JS integration with satellite imagery
    - Field boundary display, click-to-select, selected fields panel
    - "Create Blend Ticket from Map Selection" workflow
    - This is G5 + G1
    ↓
Phase 5 (MOVED): Inventory Enhancements                            [~5-7 days]
    - Cycle counting (original Phase 2)
    - Receiving workflow (Missing Gap E)
    - Multi-location warehouse support (Missing Gap D)
    - Reorder point alerts
    ↓
Phase 6 (MOVED): Returns / RMA                                     [~4-5 days]
    - Original Phase 4, depends on Phase 2 for credit handling
    ↓
Phase 7: Reporting, Sales, Compliance                               [~10-15 days]
    - AR aging + customer statements (G7)
    - Season program planning (G8)
    - Sales pipeline, follow-ups, dashboards (original Phase 5)
    - Compliance: RUP tracking, applicator licenses (original Phase 6)
    - Manufacturer rebate tracking (Missing Gap F)
    - Season-over-season comparison reports
    ↓
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

---

## 7. Billing Splits Architecture (G2) — Detailed Design

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
    organization_id uuid NOT NULL REFERENCES organizations(id),
    UNIQUE(field_id, customer_id, effective_date)
);
```

**Purpose:** "Field L19 is normally split Mason 33.333333%, Clayton 33.333333%, Chad 33.333334%." The `effective_date` handles ownership changes mid-season without losing history.

#### Table 2: `allocation_sets` — Versioning for split history

```sql
CREATE TABLE allocation_sets (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_type text NOT NULL CHECK (entity_type IN ('order', 'invoice')),
    entity_id uuid NOT NULL,  -- FK to orders.id or invoices.id
    version integer NOT NULL DEFAULT 1,
    created_by uuid REFERENCES auth.users(id),
    created_at timestamptz DEFAULT now(),
    is_active boolean DEFAULT true,
    notes text,
    organization_id uuid NOT NULL REFERENCES organizations(id),
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
    split_invoice_id uuid REFERENCES invoices(id),  -- if generating separate invoices per split
    created_at timestamptz DEFAULT now()
);
```

### Rounding Logic (MUST be implemented in Postgres RPC)

```sql
-- Largest-remainder rounding for billing splits
-- Ensures split amounts sum EXACTLY to line total (no penny discrepancies)

-- Example: $4,500.00 (450000 cents) split 3 ways (33.333333% each)
-- Step 1: Calculate raw amounts
--   Mason:   450000 × 0.33333333 = 149999.9985 → floor = 149999
--   Clayton: 450000 × 0.33333333 = 149999.9985 → floor = 149999
--   Chad:    450000 × 0.33333333 = 149999.9985 → floor = 149999
-- Step 2: Sum of floors = 449997, total = 450000, remainder = 3
-- Step 3: Distribute remainder to splits with largest fractional parts (1 cent each to top 3)
--   Mason:   149999 + 1 = 150000 ($1,500.00)
--   Clayton: 149999 + 1 = 150000 ($1,500.00)
--   Chad:    149999 + 1 = 150000 ($1,500.00)
-- Step 4: Verify: 150000 + 150000 + 150000 = 450000 ✓
```

**CRITICAL CONSTRAINT:** For each `(allocation_set_id, line_item_id)`: `SUM(amount_cents)` MUST equal the line item's `extended_cents`. Enforce via deferred constraint trigger (a plain CHECK can't sum sibling rows).

```sql
CREATE OR REPLACE FUNCTION verify_allocation_sum()
RETURNS TRIGGER AS $$
DECLARE
    v_total bigint;
    v_line_total bigint;
BEGIN
    SELECT SUM(amount_cents) INTO v_total
    FROM invoice_line_allocations
    WHERE allocation_set_id = NEW.allocation_set_id
      AND invoice_item_id = NEW.invoice_item_id;

    SELECT extended_cents INTO v_line_total
    FROM invoice_items
    WHERE id = NEW.invoice_item_id;

    IF v_total IS DISTINCT FROM v_line_total THEN
        RAISE EXCEPTION 'Allocation sum (%) does not equal line total (%)',
            v_total, v_line_total;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_verify_allocation_sum
AFTER INSERT OR UPDATE ON invoice_line_allocations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION verify_allocation_sum();
```

### Workflow

1. Admin selects Field L19 for a job/order
2. System auto-loads splits from `field_billing_defaults` → Mason 33.33%, Clayton 33.33%, Chad 33.34%
3. Admin can **accept defaults** OR **override** for this specific order
4. Splits saved to `order_line_allocations` via an `allocation_set`
5. When order becomes invoice, splits copy to `invoice_line_allocations`
6. Admin can choose: **one combined invoice** or click **"Generate Split Invoices"** to create separate invoices per split customer
7. If splits are edited later, a **new allocation set** is created (old one preserved as history)

### Scaling Note (500+ Fields)

Do NOT store 500 field-level split rows on a single invoice. Instead:
- Store field-level detail on the **blend ticket / work order** (operational record)
- Aggregate to **bill-to customer** level per invoice line when generating the invoice
- Keep a drill-down link from invoice → originating blend ticket → field details

This gives you: invoice allocations with 2-10 customer rows (fast), and operational detail with 500 fields (separate table, queryable).

---

## 8. Google Maps / Field Mapping Architecture (G1) — Detailed Design

### ⚠️ Google Maps Drawing Library Deprecation

Google's Maps JavaScript Drawing library was **deprecated August 2025** and is scheduled to become unavailable approximately **May 2026**. Do NOT build polygon editing on Google's DrawingManager.

### Recommended Stack

| Component | Technology | Why |
|-----------|-----------|-----|
| Map rendering | Mapbox GL JS | WebGL performance, built-in satellite, generous free tier |
| React wrapper | `react-map-gl` (by Uber) | Mature, well-maintained, excellent DX |
| Polygon drawing/editing | `@mapbox/mapbox-gl-draw` | Purpose-built for boundary editing |
| Geospatial DB | PostGIS (Supabase extension) | Spatial queries, acreage calculation, GeoJSON serving |
| Alternative (free) | MapLibre GL JS | Open-source fork, zero cost, but requires sourcing satellite tiles |

### PostGIS Schema for Fields

```sql
-- Enable PostGIS (run once)
CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE fields (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL,
    acreage numeric(10,2),
    crop_type text,
    season integer NOT NULL DEFAULT 2026,
    primary_customer_id uuid REFERENCES customers(id),

    -- Geographic data
    centroid geography(POINT, 4326),
    boundary geography(POLYGON, 4326),

    -- Legal / location metadata
    county text,
    state text DEFAULT 'IL',
    section text,           -- Section-Township-Range legal description
    soil_type text,         -- for label rate adjustments

    -- Administrative
    organization_id uuid NOT NULL REFERENCES organizations(id),
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now(),
    deleted_at timestamptz  -- soft delete
);

-- Spatial indexes for fast geographic queries
CREATE INDEX idx_fields_boundary ON fields USING GIST (boundary);
CREATE INDEX idx_fields_centroid ON fields USING GIST (centroid);

-- Compute acreage from boundary (optional — can auto-calculate)
-- ST_Area returns square meters for geography type
-- 1 acre = 4046.8564224 square meters
-- Example: SELECT ST_Area(boundary) / 4046.8564224 AS computed_acres FROM fields;
```

### How to Get 500+ Field Boundaries Into the System

This is the hard part nobody plans for. Options (in order of preference):

1. **Export from CheMan** — Ask DataSmart if they can export field boundaries as GeoJSON, KML, or Shapefile. This is the fastest path.
2. **Import from precision ag platforms** — If you use Climate FieldView, Granular, John Deere Operations Center, or AgLeader, they likely have your boundaries and can export them.
3. **Import from USDA CLU data** — The USDA FSA publishes Common Land Unit boundaries. If your fields align with CLU data, bulk-import is possible.
4. **Draw in browser** — Mapbox GL Draw lets admins draw polygons on the satellite map. Accurate but extremely time-consuming for 500 fields. Use as a last resort or for corrections.

**Recommendation:** Pursue options 1-3 simultaneously. Start the data export conversation with DataSmart NOW, before you need the map feature.

### React Component Architecture

```
<MapPage>
  ├── <MapContainer>              ← react-map-gl wrapper (Mapbox GL JS)
  │   ├── <FieldPolygonLayer>     ← renders all field boundaries as Mapbox source/layer
  │   ├── <FieldLabelLayer>       ← field name labels at centroids
  │   ├── <SelectedHighlight>     ← highlight color on selected fields
  │   └── <DrawControl>           ← @mapbox/mapbox-gl-draw for editing boundaries
  ├── <FieldSearchPanel>          ← search/filter by customer, field name, crop type
  └── <SelectedFieldsPanel>       ← shows selected fields + acreage + splits
      └── <CreateBlendButton>     ← "Create Blend Ticket" → navigates to form with fields pre-populated
```

### Performance with 500+ Polygons

- Load all **centroids** (points) on initial map render — lightweight, fast
- Load full **polygon boundaries** only when zoomed in past a threshold (e.g., zoom level 12+) or when fields are selected
- Use Mapbox's vector tile rendering — WebGL handles 500+ polygons smoothly
- Consider clustering centroids at low zoom levels if the map looks cluttered

---

## 9. Technical Risks & Architectural Concerns

### 🔴 Critical

**9A. Billing Split Architecture is Underspecified in Current Plan**
The current plan defines `field_customer_splits` with field_id/customer_id/percentage. This is insufficient because:
- Splits aren't always at the field level (can be overridden per order/invoice)
- Different line items can split differently (landlord pays chemical, tenant pays application)
- No versioning/audit trail for split changes

**Fix:** Use the 3-table + allocation set architecture defined in Section 7 above.

**9B. No Immutable Audit Trail for Financial Operations**
General `logActivity()` is insufficient for financial operations. Need a dedicated, append-only `financial_audit_log` table with no UPDATE or DELETE allowed (enforced by RLS). Every post, void, payment, credit adjustment, and split change must be permanently logged.

**9C. `billing_status` on Blend Tickets Conflates Two Concepts**
Current plan: `billing_status` with values `unbilled`, `linked`, `billed`, `prepaid`, `no_charge`. This mixes relationship status with payment status. A blend ticket can be linked to an order AND prepaid simultaneously.

**Fix:** Split into two columns:
```sql
order_link_status text DEFAULT 'unlinked' CHECK (order_link_status IN ('unlinked', 'linked'))
payment_status text DEFAULT 'unbilled' CHECK (payment_status IN ('unbilled', 'billed', 'prepaid', 'no_charge'))
```

### 🟡 Important

**9D. RPC Design is Too Coarse**
Several RPCs bundle multiple operations (e.g., `process_return` does restock + credit). Handle edge cases with explicit parameters — not every return means both restock AND credit.

**9E. No Soft Delete Strategy**
The invoice table has `void` status, but orders, payments, and blend tickets lack equivalent protection. Add `deleted_at timestamptz` to all financial tables. Never hard-delete financial records.

**9F. Sequence Number Race Conditions**
`next_invoice_number()` style RPCs must use Postgres sequences or `SELECT ... FOR UPDATE` to prevent duplicate numbers when two users create invoices simultaneously.

**9G. RLS Complexity with Billing Splits**
One invoice can reference 3 customers via splits. Verify RLS policies don't accidentally hide split data or leak data between organizations. Test with split invoice scenarios early.

### 🟢 Minor

**9H. All Financial Calculations Must Be in Postgres**
React can display but never compute authoritative totals. Every split calculation, balance update, and payment application must be a Postgres RPC.

---

## 10. Red Flags That Will Cause Problems If Not Addressed Now

### 🚩 1. No Data Migration Strategy from CheMan

500+ fields, years of customer records, payment history, billing data — how does it get into CRX Manager? Contact DataSmart NOW about data export options (CSV, database dump, API). Look at the actual data structure. Write migration scripts early.

### 🚩 2. No Parallel-Run / Reconciliation Plan

Before cutting over from CheMan, run both systems simultaneously for at least one full billing cycle. Verify that CRX Manager produces matching invoices, balances, and statements. If totals don't match, you can't trust the new system.

### 🚩 3. No Multi-Year / Season Concept in Data Model

The system has no concept of "2026 Season" vs "2027 Season." Add `season` / `crop_year` to all operational and financial tables NOW. Essential for end-of-year closeouts, season comparison reports, and crop rotation tracking.

### 🚩 4. Maps Feature Built on Deprecated Google Drawing Library

Google's Drawing library is deprecated (Aug 2025) and may be removed ~May 2026. Use Mapbox GL JS or MapLibre GL JS instead.

### 🚩 5. Invoice Split Math Not Enforced at Database Level

If split amounts can drift from invoice total, you will ship incorrect invoices. Use deferred constraint triggers to enforce `SUM(split_amount_cents) = line_total_cents`.

### 🚩 6. No Backup/Recovery Plan for Financial Data

Supabase provides daily backups on paid plans, but consider:
- Point-in-time recovery (can you restore to 2 hours ago if someone mass-posts bad invoices?)
- Data export capability (can YOU get your data out?)
- Outage plan during spraying season

### 🚩 7. The 26-35 Day Timeline Estimate is Unrealistic

Realistic estimate: 52-78 days of focused work, or 3-6 months at part-time pace while running the business. Do NOT cancel CheMan based on the 35-day timeline.

### 🚩 8. Permissions Are Too Loose

One wrong "adjust inventory" or "void invoice" permission costs real money. Implement RLS + role-based policies early. Critical operations (posting invoices, voiding, adjusting inventory, editing splits) should require admin role.

### 🚩 9. No Offline / Weak-Signal Strategy

Rural Illinois and Indiana have spotty cell coverage. Applicators in the field need basic functionality without a connection. PWA with offline data caching is listed as Phase 7 "Future" — this should move up significantly if field staff will use the app during spray season.

---

## 11. Ideal Platform Feature Set (Beyond CheMan Clone)

This section describes what a **best-in-class** 2026 ag chemical management platform would include — beyond just replicating CheMan. These features represent the gap between "replacement" and "competitive advantage."

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
- Click-to-select → start blend ticket workflow
- Application history per field (every product applied, every date, every rate — going back years)
- Crop rotation tracking (corn 2025 → beans 2026)
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
- Navigation integration (tap field → opens directions)
- Driver delivery view (route, signature capture, return initiation)

### Integrations
- QuickBooks / Xero (two-way invoice + payment sync)
- Weather data API (current conditions + forecast for scheduling)
- Precision ag platforms (import field boundaries from John Deere, Climate FieldView, etc.)
- Stripe ACH (payment links on invoices, auto-reconciliation)
- SMS notifications via Twilio (job dispatch, customer application notifications, invoice reminders)
- Email with open tracking (verify "I never got the invoice" claims)

---

## 12. Competitive Advantage Features

These features would differentiate CRX Manager from legacy software (CheMan, AgWorks, Agvance, Kahler) and most modern competitors:

### Tier 1: Game-Changers

**Customer Self-Service Portal** — The single most impactful feature not in the current plan. Customers log in to view invoices, payment history, application records, and make online payments. Makes your business irreplaceable. Most ag chemical platforms don't offer this.

**Automatic Job-Complete Notifications** — When an applicator marks a field as sprayed, the customer gets a text/email: "Your field [name] was sprayed today with [products] at [rate]. Weather: 72°F, wind 8mph. View full record: [link]." Builds trust through transparency.

**Seasonal Program Builder** — Build complete season programs: "2026 Corn Program — 500 acres — Pre + Post + Fungicide = $XX/acre." Locks in customer commitments early, simplifies billing, gives predictable revenue.

### Tier 2: Strong Differentiators

**Manufacturer Rebate Tier Tracking** — Real-time tracking of purchase volumes against rebate tier thresholds. Most operators track this manually.

**Integrated Field Scouting Notes** — Scout observations tied to field records, visible when building blend tickets. Connects agronomic decisions to application records in one system.

**Supplier Price Comparison** — Historical pricing by supplier by product, visible at purchase time. Every buying decision becomes data-driven.

**"What If" Scenario Pricing** — Customer calls asking "what would it cost to add a fungicide pass on 800 acres?" Model the answer in 2 minutes while they're on the phone.

### Tier 3: Polish & Professionalism

**Morning Dashboard** — Comprehensive operational briefing: today's jobs, weather, unbilled work, low inventory, past-due balances, expiring licenses.

**Activity Timeline on Every Record** — Chronological feed on each customer/order/field showing everything that happened. Eliminates clicking through 5 pages to understand transaction history.

**Proactive License Expiration Alerts** — Automated alerts at 90/60/30 days before applicator or customer licenses expire.

---

## 13. Modern SaaS Patterns Missing from Current Plan

### Notification System
No notification architecture exists in the current plan. In 2026, users expect to be notified — not to go hunting for information. Need:
- In-app notification bell with unread count
- Email notifications (configurable per user)
- SMS notifications for critical events (via Twilio, future phase)
- Daily digest option ("3 unposted invoices, 2 low-inventory alerts, 1 expiring license")

### Saved Views / Custom Filters
Let users save frequently used filter combinations as one-click bookmarks. Power users in operational software rely heavily on this.

### Keyboard Shortcuts
For a power user processing hundreds of transactions: N (new), S (save), → (next record), Esc (cancel). Small investment, outsized productivity gains.

### Bulk Operations
Beyond batch posting — bulk operations across the app:
- Select 20 unposted invoices → "Post All"
- Select 15 fields → "Create Blend Ticket"
- Select 8 customers → "Generate Statements"
- Select 5 products → "Update Pricing"

### Activity Feed / Timeline
On every customer, order, and field record: chronological feed of everything that happened. Replaces the need to check 5 different pages to understand history.

### Scheduled Automations
"Every Monday at 7am, email me: unbilled work, past-due balances, this week's jobs, low inventory." "On the 1st of every month, generate and email statements for all customers with balances." Expand Phase 5's scheduled report delivery into a general automation engine.

---

## 14. Pre-Implementation Checklist

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

> **END OF DOCUMENT**
>
> This document should be read by any implementing agent (Claude Code, Cursor, etc.) before starting work on any phase. It supersedes the original Phase 1-7 plan in `KINMAN_REVIEW_AND_GAP_ANALYSIS.md` for architectural decisions and sequencing. The original document remains the authoritative source for CheMan feature descriptions (Part A) and gap identification (Part B).
