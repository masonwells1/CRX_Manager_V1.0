# Blend Ticket System — Full Planning Document

> **Date:** 2026-03-23 | **Status:** Brainstorm Complete, Ready for Implementation Planning
> **Author:** Mason + Claude brainstorming session
> **Related:** `2026-03-01-superpower-brainstorm-inventory-delivery-blendtickets.md`

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Current State](#current-state)
3. [Vision — The Full Digital Lifecycle](#vision)
4. [Phased Roadmap](#phased-roadmap)
5. [Blend Ticket Data Model](#blend-ticket-data-model)
6. [Phase 1 — OCR Bridge](#phase-1--ocr-bridge)
7. [Phase 2 — Mixer Man Digital Entry](#phase-2--mixer-man-digital-entry)
8. [Phase 3 — Applicator In-Cab](#phase-3--applicator-in-cab)
9. [Product Catalog & Matching](#product-catalog--matching)
10. [Inventory Integration](#inventory-integration)
11. [Load Splitting & Multi-Field Applications](#load-splitting--multi-field-applications)
12. [Billing & Invoicing](#billing--invoicing)
13. [Applicator In-Cab UX](#applicator-in-cab-ux)
14. [Reporting & Office View](#reporting--office-view)
15. [Decisions Made](#decisions-made)
16. [Open Questions](#open-questions)
17. [Where We Left Off](#where-we-left-off)

---

## Executive Summary

The blend ticket system is being designed as a **three-phase evolution** from paper tickets to a fully digital, closed-loop workflow connecting the mix plant to the field and back. The system has never been used in production yet — this is a greenfield design that must get adoption right from day one.

**The long-term vision:** The mixer man enters blend tickets digitally at the plant. The applicator sees assigned tickets on a device in the cab, selects which fields he's spraying, enters actual sprayed acres, and everything ties together — blend ticket, fields, planned vs actual, product usage, and billing.

**OCR is the bridge** — it gets digital data flowing while the team transitions off paper and Chem Man software. It should be designed so that Phase 1's confirm screen becomes Phase 2's entry screen.

---

## Current State

### What Exists in CRX Manager Today
- Full OCR pipeline: upload → Google Vision → parse → review → approve
- Multi-field extraction (customer, driver, applicator, products, quantities, fields)
- Fuzzy product matching with configurable threshold (0.6)
- Manual ticket creation (bypasses OCR)
- 8 blend recipes for common chemical mixes
- Confidence scoring with auto-complete (>70%) or needs-review (<70%)
- Order linkage (link blend ticket to existing order)
- Application record creation from approved tickets (with inventory deduction)
- Background queue processing with retry (3 max retries)
- Bulk ticket upload
- Product catalog already exists in CRX Manager under Products

### What's Being Used Today (Not CRX Manager)
- **Paper blend tickets** — handwritten by mixer man at the chemical building
- **Chem Man software** — some tickets are printed from this system
- **No digital workflow** — blend tickets have never been processed through CRX Manager yet

### The Paper Ticket Format (Current)

Based on the Crop RX Solutions blend ticket template:

**Header Section:**
| Field | Description |
|-------|-------------|
| Customer Name | Who the blend is for |
| Date | Date of mix |
| Time | Time of mix |
| Job # | Job reference number |
| Invoice # | Invoice reference number |

**People & Equipment Section:**
| Field | Current Options | Notes |
|-------|----------------|-------|
| Applicator | Mason / Chance / Clayton / Other | Pre-printed names, fill in "Other" |
| Vehicle | Hagie / Rogator / Customer / Other | Pre-printed options |
| Mixer Name | Mason / Chance / Clayton / Other | Pre-printed names |

**Application Info Section:**
| Field | Description |
|-------|-------------|
| Notes | Free text area |
| Fields | Which field(s) being sprayed |
| Total Acres | Total acres for this load |
| Application Rate | Overall application rate |
| Total Volume | Total volume of the mix |

**Product Table (repeating rows):**
| Column | Description |
|--------|-------------|
| ✓ (left checkbox) | Likely "mixed" confirmation |
| Product | Product name |
| Rate/Acre | Per-acre rate for this product |
| Total Product | Total amount of this product in the mix |
| ✓ (right checkbox) | Likely "applied" confirmation |

---

## Vision — The Full Digital Lifecycle

```
┌─────────────────────────────────────────────────────────────────┐
│                    BLEND TICKET LIFECYCLE                         │
│                                                                   │
│  ┌──────────┐    ┌──────────────┐    ┌───────────────────────┐   │
│  │  PHASE 1  │    │   PHASE 2     │    │      PHASE 3           │   │
│  │ OCR Bridge│    │ Mixer Digital │    │  Applicator In-Cab     │   │
│  └─────┬────┘    └──────┬───────┘    └───────────┬───────────┘   │
│        │                │                        │                │
│   Photo ticket     Mixer enters            Applicator sees       │
│        │           blend digitally          assigned tickets      │
│        ▼                │                        │                │
│   OCR extracts          ▼                        ▼                │
│        │           Ticket is LIVE          Selects fields         │
│        ▼           in the system                 │                │
│   Driver confirms       │                        ▼                │
│   at the plant          │                  Enters actual          │
│        │                │                  sprayed acres          │
│        ▼                │                        │                │
│   Office reviews        │                        ▼                │
│   (if needed)           │                  Marks load complete    │
│        │                │                        │                │
│        ▼                ▼                        ▼                │
│   ┌─────────────────────────────────────────────────────┐        │
│   │              DIGITAL BLEND TICKET RECORD             │        │
│   │   → Linked to customer, fields, products             │        │
│   │   → Planned vs actual acres                          │        │
│   │   → Inventory deducted                               │        │
│   │   → Ready for billing                                │        │
│   └─────────────────────────────────────────────────────┘        │
└─────────────────────────────────────────────────────────────────┘
```

---

## Phased Roadmap

### Phase 1 — OCR Bridge (NOW)
**Goal:** Get digital data flowing while still on paper
**Who uses it:** Driver/mixer photographs tickets → confirms on phone → office reviews
**When OCR becomes secondary:** When Phase 2 is live and mixer man is entering directly
**Key design principle:** The confirm screen the driver sees after OCR becomes the entry screen the mixer man uses in Phase 2 — same UI, different starting point

### Phase 2 — Mixer Man Digital Entry (CRX Manager ready)
**Goal:** Eliminate paper entirely at the mix plant
**Who uses it:** Mixer man enters blend tickets directly in CRX Manager
**Blocker:** Dev resources + missing features in CRX Manager (A and C)
**Key insight:** Same data model as Phase 1, same UI as the OCR confirm screen but empty

### Phase 3 — Applicator In-Cab (CRX Manager mobile)
**Goal:** Close the loop from mix to field
**Who uses it:** Applicator on phone/tablet in the cab
**Key capability:** See assigned tickets, select fields, enter actual sprayed acres
**Device:** Must work on both phone and tablet

---

## Blend Ticket Data Model

This data model is the **core of everything** — it must support all three phases regardless of how the ticket was created (OCR, manual entry, or mixer digital entry).

### Ticket Header
| Field | Type | Required | Notes |
|-------|------|----------|-------|
| id | uuid | auto | Primary key |
| ticket_number | text | yes | Auto-generated or from paper |
| ticket_date | date | yes | Date of mix |
| ticket_time | time | no | Time of mix |
| job_number | text | no | Job reference |
| invoice_number | text | no | Invoice reference (legacy/Chem Man) |
| customer_id | uuid | yes | FK to customers |
| notes | text | no | Free text notes |
| source | enum | yes | 'ocr', 'manual', 'digital' (tracks how ticket was created) |
| status | enum | yes | 'draft', 'pending_review', 'approved', 'applied', 'voided' |
| created_by | uuid | yes | Who created/uploaded the ticket |
| approved_by | uuid | no | Who approved (office staff) |
| approved_at | timestamp | no | When approved |

### People & Equipment
| Field | Type | Required | Notes |
|-------|------|----------|-------|
| applicator_id | uuid | no | FK to team/users — configurable dropdown |
| mixer_id | uuid | no | FK to team/users — configurable dropdown |
| vehicle_id | uuid | no | FK to vehicles — configurable dropdown |

**Important:** Applicator, Mixer, and Vehicle are **configurable dropdowns**, not hardcoded names. The team is growing (Mason's answer: C — growing team and equipment).

### Application Info
| Field | Type | Required | Notes |
|-------|------|----------|-------|
| total_acres | decimal | no | Planned total acres |
| application_rate | decimal | no | Overall rate |
| total_volume | decimal | no | Total volume of the mix |
| total_volume_unit | text | no | gal, oz, pt, etc. |

### Product Lines (blend_ticket_products)
| Field | Type | Required | Notes |
|-------|------|----------|-------|
| id | uuid | auto | Primary key |
| blend_ticket_id | uuid | yes | FK to blend_tickets |
| product_id | uuid | yes/no | FK to products (null if unmatched OCR) |
| product_name_raw | text | no | Raw text from OCR (before matching) |
| rate_per_acre | decimal | no | Rate per acre for this product |
| rate_unit | text | no | Unit for rate (oz, pt, gal, lb) |
| total_product | decimal | no | Total amount of this product |
| total_product_unit | text | no | Unit for total |
| match_confidence | decimal | no | OCR product match confidence (0-1) |
| mixed_confirmed | boolean | default false | Left checkbox — was it mixed? |
| applied_confirmed | boolean | default false | Right checkbox — was it applied? |

### Field Applications (blend_ticket_fields) — NEW for Phase 3
| Field | Type | Required | Notes |
|-------|------|----------|-------|
| id | uuid | auto | Primary key |
| blend_ticket_id | uuid | yes | FK to blend_tickets |
| field_id | uuid | yes | FK to fields |
| planned_acres | decimal | no | Planned acres for this field |
| actual_acres | decimal | no | Actual sprayed acres (entered by applicator) |
| applied_at | timestamp | no | When the applicator marked it done |
| applied_by | uuid | no | Who applied (applicator) |

### OCR Metadata (existing, kept for Phase 1)
| Field | Type | Notes |
|-------|------|-------|
| image_url | text | Uploaded ticket photo |
| raw_ocr_text | text | Full text from Google Vision |
| overall_confidence | decimal | Overall OCR confidence score |
| ocr_field_confidence | jsonb | Per-field confidence scores |
| ocr_processed_at | timestamp | When OCR completed |

---

## Phase 1 — OCR Bridge

### Upload Flow
1. **Driver/mixer photographs the paper ticket** at the chemical building
2. **Uploads via CRX Manager mobile** (phone camera or photo library)
3. **OCR extracts all fields** via Google Vision Edge Function
4. **Driver sees confirm screen on phone** with:
   - Auto-matched customer (from customer list in CRX Manager)
   - Auto-matched products (confidence-based matching — see Product Matching below)
   - All quantities, rates, acres pre-filled from OCR
   - Per-field confidence indicators (green/yellow/red) next to each extracted value
   - Red highlights on anything low-confidence
5. **Driver confirms or corrects** each field
   - Driver is responsible for accuracy — "you upload it, you own it"
6. **Ticket enters the system** as a digital record with status `pending_review`
7. **Office staff reviews** a batch queue (if needed for low-confidence tickets)
8. **Office approves** → ticket moves to `approved` → inventory is deducted

### Smart Detection: Handwritten vs Chem Man Printouts
- Chem Man printouts will OCR much better than handwriting
- System should detect which type it is (printed text vs handwritten)
- Use different parsing logic / confidence thresholds per type
- Printed tickets can have higher auto-approve confidence threshold

### Key Phase 1 Improvements Over Current OCR System
Based on the earlier brainstorm doc (2026-03-01), these should be included in Phase 1:

1. **Per-field confidence display** — Show green/yellow/red next to each extracted field
2. **Raw OCR text viewer** — Show what Google Vision actually read (expandable section)
3. **Batch approve** — Checkbox selection + "Batch Approve" for high-confidence tickets
4. **Duplicate detection** — Check ticket_number + ticket_date before creating
5. **Blend math validation at OCR time** — If total volume ≠ sum of products, flag it
6. **Re-process button** — "Try OCR again" for bad results
7. **Auto-suggest order match** — After OCR, search for customer's open orders with matching products

---

## Phase 2 — Mixer Man Digital Entry

### Entry Flow
1. **Mixer man opens CRX Manager** at the chemical building (tablet or computer at the plant)
2. **Same UI as Phase 1 confirm screen, but empty** — this is the key design insight
3. **Selects customer** (searchable dropdown from customer list)
4. **Selects himself as mixer** (dropdown — auto-default to logged-in user)
5. **Selects applicator** (dropdown from team members)
6. **Selects vehicle** (dropdown from vehicle list)
7. **Adds products** from product catalog:
   - Search/select from product catalog
   - Enter rate/acre and total product for each
   - Can select from saved blend recipes to pre-fill products
8. **Enters fields, total acres, application rate, total volume**
9. **Submits** — ticket is live in the system instantly with status `approved` (no OCR review needed)
10. **Inventory is deducted** immediately on submit

### Key Differences from Phase 1
- No OCR, no photo, no confidence scores
- Ticket goes straight to `approved` (trusted source — mixer man entered it)
- Same data model, same UI components, different entry point
- `source` field = `'digital'` instead of `'ocr'`

### What Needs to Be Built for Phase 2 (on top of Phase 1)
- Configurable team member dropdown (applicators, mixers)
- Configurable vehicle dropdown (Hagie, Rogator, customer equipment, etc.)
- Blend recipe quick-select (pick a recipe → pre-fills product lines)
- Field selector with customer's fields pre-loaded
- The entry form itself (which is the confirm screen from Phase 1 restructured as empty)

---

## Phase 3 — Applicator In-Cab

### Applicator Flow
1. **Applicator opens CRX Manager** on phone or tablet in the cab
2. **Sees a list of assigned blend tickets** for the day
   - Filtered to tickets where they are the assigned applicator
   - Shows: customer name, blend summary, total acres, status
3. **Taps into a ticket** and sees:
   - Full product list with rates
   - Rate per acre
   - Total acres planned
   - Total volume
   - Notes from the ticket
4. **Selects which field(s)** he's spraying from this load
   - Customer's fields shown (from CRX Manager field/mapping data)
   - Can select multiple fields if splitting a load
5. **Enters actual sprayed acres** per field as he goes
   - Can update throughout the day
   - System tracks planned vs actual
6. **Can split a load across multiple fields** (very common — see Load Splitting section)
7. **Marks the ticket complete** when the load is done
   - Ticket status moves to `applied`
   - Actual acres are recorded
   - Inventory reconciliation if needed

### Device Requirements
- Must work on both phone and tablet (responsive design)
- Cell service is usually available (A) — no offline-first requirement, but should handle brief connectivity drops gracefully
- Simple, big-button UI — drivers are wearing gloves, in a bumpy cab

### In-Cab Screen Priority (what matters most while driving)
- **Product list + rates** — "What am I spraying?"
- **Rate per acre** — "How much per acre?"
- **Acres remaining** — "How many acres left on this load?"
- **Field selection** — "Which field am I on?"
- **Actual acres input** — Big number input, easy to update

---

## Product Catalog & Matching

### Current State
- Product catalog already exists in CRX Manager under Products
- Products have units attached (each product has a default unit)
- Products have categories (herbicide, fungicide, insecticide, fertilizer, adjuvant, etc.)

### OCR Product Matching Strategy (Phase 1)

**Primary: Auto-match with confidence**
- System compares OCR-extracted product name against the CRX Manager product catalog
- Uses fuzzy matching (existing threshold: 0.6)
- Shows confidence percentage next to each match
- High-confidence matches auto-fill, low-confidence ones highlight for driver review

**Fallback: Smart suggestions**
- When confidence is below threshold, show top 3-5 possible matches from catalog
- Driver picks the right one from the suggestions
- If none match, driver can search/type to find the correct product

**Confidence Threshold**
- **Configurable** — Mason wants to tune this after seeing real-world results (Decision: D)
- Start with a reasonable default (current 0.6 or maybe 0.7)
- Admin setting to adjust up/down based on accuracy data
- Track match accuracy over time to inform threshold tuning

### Product Name Standardization
- Common products are fairly consistent across drivers (e.g., "AMS" for ammonium sulfate)
- Specialty products vary wildly in how drivers write them
- The system should learn from corrections — if a driver corrects "Roundup PT" to "Roundup PowerMAX" 5 times, future OCR should auto-suggest that match

---

## Inventory Integration

### Current Inventory Positions
| Position | Description |
|----------|-------------|
| On Order | Supplier PO — product ordered but not received |
| Total On Floor | Physical inventory at the warehouse |
| Planned | Reserved via quote "Mark as Planned" function |
| Committed | Customer order confirmed |
| Delivered YTD | Product that has left the building (delivered or applied) |

### How Blend Tickets Affect Inventory

**Decision:** Keep inventory logic simple. When a blend ticket is confirmed/approved, products move to **Delivered YTD** — same as a regular delivery. The system can filter/sort to distinguish between physical deliveries and applications.

**Flow:**
1. Most applications will already be "planned" in inventory via the quote's "Mark as Planned" function
2. When blend ticket is approved → products move from **Planned** to **Delivered YTD**
3. If the application wasn't pre-planned, it deducts directly from **Total On Floor** → **Delivered YTD**
4. Filtering on delivery type (delivery vs application) separates the two in reports

**Delivery Type Distinction:**
- Add a `delivery_type` field or tag: `'physical_delivery'` vs `'application'`
- This lets the office filter Delivered YTD to see "what was delivered to farms" vs "what was sprayed in the field"
- Same inventory position, different context

### Inventory Transaction Created
When a blend ticket is approved, for each product line:
```
inventory_transactions:
  - type: 'delivered' (or new type 'applied'?)
  - product_id: <product>
  - quantity: <total_product from blend ticket>
  - reference_type: 'blend_ticket'
  - reference_id: <blend_ticket_id>
```

**Open question:** Should we use existing `delivered` transaction type with a sub-type, or create a new `applied` transaction type? Using `delivered` keeps it simple (Mason's preference). We can always add granularity later.

---

## Load Splitting & Multi-Field Applications

### The Reality
- **One load commonly covers 2-3 fields** (very common)
- **Big fields need multiple loads** (often)
- **One load can cover multiple customers' fields** (happens)
- **The mixer knows which customers/fields at mix time** — ticket is written for specific customers/fields
- **The applicator sometimes knows the split beforehand** (work order tells him), **sometimes decides in the field** (sprays until tank runs out)

### How the System Handles This

**At Ticket Creation (Phase 1/2):**
- Blend ticket is created with customer(s) and field(s) listed
- Planned acres per field can be entered if known
- If the split isn't known yet, just total acres

**At Application (Phase 3):**
- Applicator selects which field he's currently spraying
- Enters actual acres sprayed on that field
- Moves to next field, enters actual acres
- System tracks: planned acres vs actual acres per field
- Load is "complete" when all product is accounted for

**Multi-Customer Loads:**
- A single blend ticket can reference multiple customers' fields
- Each field application record (blend_ticket_fields) links to a specific field + customer
- Billing is proportional to actual acres sprayed per customer (see Billing section)

**Multi-Load Jobs:**
- A job/work order can have multiple blend tickets
- Each blend ticket = one tank load
- The job tracks total progress across all loads

### Who Creates Jobs/Work Orders?
- **Both salesmen and office staff** create jobs (Decision: C)
- Salesman takes the order from the customer → creates work order
- Office schedules based on incoming requests → creates work order
- Mixer man works off the work order to know what to mix

---

## Billing & Invoicing

### How Blend Tickets Become Invoices

**Current state:** Billing goes through Chem Man, not CRX Manager yet. This won't change immediately, but the blend ticket system should capture all data needed for future billing integration.

### Per-Customer Billing from Split Loads
When a load is split across multiple fields/customers:
- **Each field/customer gets billed for their share** (Decision: A)
- Billing is proportional to **actual sprayed acres** per customer
- Example: 120-acre load split 80/40 across two customers → Customer A billed for 80 acres worth, Customer B for 40 acres worth

### Data Captured for Billing
Each approved + applied blend ticket provides:
- Customer ID
- Products applied (with rates and quantities)
- Actual acres sprayed per field per customer
- Date of application
- Applicator (for service billing if applicable)

### Future Integration
When CRX Manager handles billing:
- "Generate Invoice from Blend Ticket" button
- Pre-populates invoice with products × actual acres × rate
- Links invoice to blend ticket for audit trail

---

## Applicator In-Cab UX

### Screen Layout (Phone)

```
┌────────────────────────────────┐
│  ← Back    Today's Tickets     │
│                                │
│  ┌──────────────────────────┐  │
│  │ 🟢 Smith Farm             │  │
│  │ Herbicide Mix #1          │  │
│  │ 160 acres | 3 products    │  │
│  └──────────────────────────┘  │
│                                │
│  ┌──────────────────────────┐  │
│  │ 🟡 Jones Farm             │  │
│  │ Fungicide Application     │  │
│  │ 80 acres | 2 products     │  │
│  └──────────────────────────┘  │
│                                │
│  ┌──────────────────────────┐  │
│  │ ⚪ Williams Farm           │  │
│  │ Pre-emerge Mix            │  │
│  │ 200 acres | 4 products    │  │
│  └──────────────────────────┘  │
└────────────────────────────────┘
```

### Ticket Detail (Phone)

```
┌────────────────────────────────┐
│  ← Back     Smith Farm    ⋮   │
│                                │
│  BLEND                         │
│  ┌──────────────────────────┐  │
│  │ Roundup PowerMAX  32 oz/ac │  │
│  │ Atrazine 4L       1 qt/ac  │  │
│  │ AMS               2 lb/ac  │  │
│  └──────────────────────────┘  │
│                                │
│  RATE: 15 gal/acre             │
│  TOTAL ACRES: 160              │
│  TOTAL VOLUME: 2,400 gal       │
│                                │
│  FIELDS                        │
│  ┌──────────────────────────┐  │
│  │ ☑ Smith North   80 ac     │  │
│  │   Actual: [  75  ] ac     │  │
│  │                            │  │
│  │ ☑ Smith South   80 ac     │  │
│  │   Actual: [  82  ] ac     │  │
│  └──────────────────────────┘  │
│                                │
│  Acres sprayed: 157 / 160      │
│                                │
│  [ MARK LOAD COMPLETE ]        │
└────────────────────────────────┘
```

### UX Priorities
1. **Big text, big buttons** — gloves, bumpy cab, bright sunlight
2. **Minimal scrolling** — key info visible without scrolling
3. **One-tap field selection** — checkboxes, not dropdowns
4. **Easy number input** — large numeric keyboard for acres
5. **Status at a glance** — color-coded ticket cards (not started / in progress / complete)
6. **Works on phone and tablet** — responsive, not separate apps

---

## Reporting & Office View

### What the Office Needs to See

**Blend Ticket Dashboard:**
- All tickets for today / this week / custom date range
- Filter by: status, customer, applicator, mixer, product
- Batch approve high-confidence OCR tickets
- Flag/reject problematic tickets

**Application Summary Report:**
- By customer: what was applied, when, where, how many acres
- By product: total usage across all applications for a date range
- By applicator: what they sprayed, total acres covered
- By field: application history per field

**Planned vs Actual Report:**
- Planned acres (from ticket) vs actual sprayed acres (from applicator)
- Variance highlighting — where did planned ≠ actual?
- Product usage variance — planned product vs actual used

**Inventory Impact Report:**
- Products consumed by applications for a date range
- Filtered view of Delivered YTD showing only application-type transactions
- Remaining inventory after applications

---

## Decisions Made (Brainstorm Session 2026-03-23)

| # | Question | Decision | Notes |
|---|----------|----------|-------|
| 1 | How will tickets enter the system? | Mostly OCR (with some manual entry) | Phase 1 bridge to digital |
| 2 | Who reviews OCR results? | Mix — uploader confirms, office reviews as needed | Driver owns accuracy |
| 3 | Who confirms after OCR? | Driver/mixer at the plant on their phone | "Snap & confirm" flow |
| 4 | Biggest OCR risk? | Product names (handwriting + abbreviations) | All fields are risky, but products are hardest |
| 5 | Product name standardization? | Mix — common products consistent, specialty varies | Need fuzzy matching + learning |
| 6 | Product matching approach? | Auto-match with confidence (primary) + smart suggestions (fallback) | Confidence-based |
| 7 | Confidence threshold? | Configurable — tune after real-world data | Start reasonable, adjust based on accuracy |
| 8 | Customer/field matching? | Not GPS-based (all at the plant) — recent history + search | GPS won't help at the chemical building |
| 9 | Long-term vision? | Full digital lifecycle: mixer entry → applicator in-cab | OCR is the bridge, not the destination |
| 10 | Product catalog location? | Already in CRX Manager under Products | Has units and categories |
| 11 | Products have units? | Yes — each product has a default unit | Already configured |
| 12 | Products have categories? | Yes — herbicide, fungicide, etc. | Already configured |
| 13 | Load splitting? | Very common — one load covers 2-3 fields | Must be a first-class feature |
| 14 | Multiple loads per job? | Yes, often — big fields need multiple loads | Job → many blend tickets |
| 15 | Who creates jobs? | Both salesmen and office staff | Both paths need to work |
| 16 | Inventory deduction timing? | When blend ticket is confirmed/approved | Moves to Delivered YTD |
| 17 | New inventory position? | No — keep it simple, use Delivered YTD + filter by type | Application vs physical delivery distinguished by filter |
| 18 | Applicator device? | Both phone and tablet — responsive design | Not separate apps |
| 19 | Cell service? | Usually yes — no offline-first requirement | Handle brief drops gracefully |
| 20 | Signature required? | No — internal confirmation is enough | May revisit later |
| 21 | Billing through CRX Manager? | Not yet — currently through Chem Man | Capture all data for future billing |
| 22 | Per-customer billing for split loads? | Yes — proportional to actual sprayed acres | Each customer billed for their share |
| 23 | Blend recipes reused? | Somewhat — about half are repeat recipes | Recipe quick-select is valuable |
| 24 | Weather tracking? | Nice to have, not critical | May add later |
| 25 | REI/PHI tracking? | Eventually, not now | Compliance feature for later |
| 26 | Tech stack? | CRX Manager (Next.js + Supabase) | Same stack as everything else |
| 27 | Team/equipment growing? | Yes — configurable dropdowns, not hardcoded | Growing team and fleet |
| 28 | Mixer knows customer/fields at mix time? | Yes — ticket is written for specific customers/fields | Mixer has the full picture |
| 29 | Applicator knows split beforehand? | Mix — sometimes from work order, sometimes decides in field | Support both patterns |
| 30 | Current inventory positions? | On Order, Total On Floor, Planned, Committed, Delivered YTD | Already built |

---

## Open Questions — ALL ANSWERED (2026-03-29)

| # | Question | Answer | Source |
|---|----------|--------|--------|
| 1 | Vehicles table? | **YES** — full `vehicles` table exists (name, type, capacity, status) | Migration 20260214200000 |
| 2 | Team members / mixers? | **Profiles table** with 4 roles (admin, sales_rep, driver, applicator). No mixer role needed — all roles can mix (Mason's decision) | Migration 20260206172436 + 20260214210000 |
| 3 | Jobs / work orders? | **YES** — complete `jobs` table with `job_fields`, `job_chemicals`, `job_applied_info` | Migration 20260215200000 |
| 4 | Fields → customers? | **YES** — `fields.customer_id` FK + `field_billing_defaults` for split billing | Migration 20260213000000 |
| 5 | Blend recipes? | **YES** — `blend_recipes` + `blend_recipe_items` with product_id, rate_per_acre, unit | Migration 20260213140000 |
| 6 | Multi-customer tickets? | **Option B** — single ticket, per-field customer assignments via new `blend_ticket_fields` table | Mason's decision 2026-03-29 |
| 7 | OCR confirm screen? | **Full page** at `/blend-tickets/:id` — already exists | BlendTicketDetail.tsx |
| 8 | Applicator assignment? | Need to add `applicator_id` FK (currently text only). Nullable — can be set after creation | Schema gap identified |
| 9 | Chem Man detection? | **Skip for Phase 1** — all tickets processed the same way. Revisit if review queue gets clogged | Mason's decision 2026-03-29 |
| 10 | Configurable threshold? | **Admin Settings page** — `app_settings` table with key-value config | New table in Phase 1 plan |

---

## Where We Left Off

### Session: 2026-03-29 (Phase 1 Planning)

**What we completed this session:**
- Answered all 10 open questions by examining the codebase
- Reviewed full existing schema (8 tables, 10 RPCs, 4 pages, 1 Edge Function)
- Identified 4 schema gaps (blend_ticket_fields, applicator_id FK, vehicle_id FK, app_settings)
- Confirmed existing status system (two-column: status + review_status) should NOT change
- Wrote Phase 1 implementation plan: `docs/plans/2026-03-29-blend-ticket-phase1-implementation.md`

**Key decisions made 2026-03-29:**
- Q6: Option B — single ticket, per-field customer assignments via `blend_ticket_fields`
- Q2: No mixer role — all existing roles (admin, sales_rep, applicator) can mix
- Q9: Skip Chem Man detection for Phase 1

**What's next:**
1. **Execute Phase 1 implementation plan** (15 tasks)
2. Phase 1 covers: schema alignment, configurable thresholds, batch approve, duplicate detection, math validation, per-field confidence, raw OCR viewer, re-process, multi-field entry, auto-suggest order match
3. After Phase 1: real-world testing with paper tickets, tune thresholds, then Phase 2 planning

### Session: 2026-03-23 (Late Night Brainstorm)

**What we completed:**
- Full brainstorm of the blend ticket system across all three phases
- Reviewed the actual paper ticket format (Crop RX Solutions template)
- Made 30 key decisions (see Decisions Made table above)
- Defined the complete data model
- Designed the applicator in-cab UX
- Mapped inventory integration
- Documented load splitting and billing logic
- Identified the Phase 1 → Phase 2 UI reuse strategy

---

## Appendix: Reference to Earlier Brainstorm

The `2026-03-01-superpower-brainstorm-inventory-delivery-blendtickets.md` document identified these blend ticket improvements, which are all incorporated into Phase 1 of this plan:

1. Per-field confidence display ✅ Included in Phase 1
2. Raw OCR text viewer ✅ Included in Phase 1
3. Batch approve/reject ✅ Included in Phase 1
4. Auto-suggest order match ✅ Included in Phase 1
5. Lot number OCR extraction — Deferred to later (not critical for initial launch)
6. Duplicate detection ✅ Included in Phase 1
7. Re-process button ✅ Included in Phase 1
8. Blend math validation at OCR time ✅ Included in Phase 1
9. Recipe-based OCR enhancement — Deferred to Phase 2 (recipes more useful with digital entry)
10. Image enhancement before OCR — Deferred (nice to have)
