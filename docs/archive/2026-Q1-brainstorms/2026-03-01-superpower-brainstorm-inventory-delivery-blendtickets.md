# Superpower Brainstorm: Inventory, Deliveries & Blend Tickets

> **Date:** 2026-03-01 | **Author:** Claude (analysis session) | **Status:** Proposal

---

## Executive Summary

After a deep analysis of the CRX Manager codebase (50 pages, 72+ tables, ~115 RPCs), this document identifies **gaps, blind spots, and high-impact improvements** across the three focus areas: Inventory Management, Deliveries, and Blend Ticket Processing.

The app has a **strong foundation** — the core happy-path workflows work well. The opportunities below are about closing gaps that cause your team to work harder than they need to, fall back to spreadsheets/paper, or miss things that cost money.

---

## Area 1: Inventory Management

### What's Working Well
- Net Free / On Order / Delivered YTD calculations are solid
- Inventory holds system (manual + crop program) with auto-release on quote accept/decline/expire
- Inline editing on the inventory table (EditableDataTable)
- Cycle counts with variance tracking
- Reorder point / low-stock badge alerts
- Cost history tracking when PO unit cost changes
- Full audit trail via `inventory_transactions`
- Quick Receive wizard (3-step auto-match to oldest POs)

### Gaps & Blind Spots

#### 1. No Inventory Transfer UI
**Impact: HIGH** | **Effort: MEDIUM**

The `inventory_transactions` table supports a `transferred` transaction type, but there is **no UI to transfer stock between warehouses**. The `warehouses` table exists and is populated, but you can't move product from Warehouse A to Warehouse B without a manual adjustment (decrease at one, increase at the other — and hoping nothing goes wrong in between).

**What to build:** A "Transfer Stock" modal on the Inventory page — select source warehouse, destination warehouse, product, quantity. Creates two atomic `inventory_transactions` records (one decrease, one increase) in a single RPC.

#### 2. No Automatic Reorder Suggestions / Purchase Order Generation
**Impact: HIGH** | **Effort: MEDIUM**

You have `reorder_point` and `min_stock_level` columns on inventory, and a low-stock badge, but:
- There's no **Suggested Reorders** view that aggregates all products below reorder point
- There's no **one-click PO generation** from low-stock items
- There's no **email/notification alert** when products hit reorder point

**What to build:** A "Suggested Reorders" tab or section on the Inventory page showing all products at/below reorder point, grouped by vendor, with a "Create PO" button that pre-populates a purchase order with the suggested quantities (reorder point - current quantity + safety stock).

#### 3. No Inventory Valuation / Cost Report on the Main Page
**Impact: MEDIUM** | **Effort: LOW**

The `get_inventory_cost_report()` RPC exists, but the Inventory page only shows quantities — not dollar values. You can't glance at inventory and see "we're sitting on $450K of product."

**What to build:** A summary card row at the top of Inventory page showing: Total Inventory Value (quantity x cost), Total On-Order Value, and maybe a "Slow Moving" count (products with zero deliveries in last 90 days).

#### 4. No Batch Adjustments
**Impact: MEDIUM** | **Effort: LOW**

Adjustments happen one product at a time. After a cycle count or a warehouse cleanup, you may need to adjust 20+ items. Currently that's 20 separate modal open/close cycles.

**What to build:** A "Batch Adjust" mode that lets you enter adjustments on multiple rows in the existing editable table, then submit them all at once.

#### 5. No Inventory Transaction History View
**Impact: MEDIUM** | **Effort: LOW**

Every inventory change creates an `inventory_transactions` record, but there's **no page to view this audit trail**. If someone asks "why is product X at 47 units?" you have to dig through the database manually.

**What to build:** An "Inventory Ledger" tab or page showing all transactions for a selected product, with date, type (received/delivered/adjusted/transferred), quantity, reference (PO#, delivery#, etc.), and who did it.

#### 6. No Product Expiration / Lot Tracking
**Impact: MEDIUM** | **Effort: HIGH**

Receiving records capture `lot_number`, but there's no:
- Lot-level inventory tracking (how much of lot #ABC123 is left?)
- Expiration date tracking at the lot level
- FEFO (First Expired, First Out) warnings when creating deliveries
- Shelf-life alerts for ag chemicals that expire

This is especially important for **RUP (Restricted Use Pesticide)** products where lot traceability is a compliance requirement.

#### 7. No Seasonal Demand Forecasting
**Impact: LOW-MEDIUM** | **Effort: HIGH**

You have historical `inventory_transactions` with `delivered` type by season (Oct-Sep). You could use past season data to project what you'll need next season — but there's no forecasting or comparison view.

**What to build (future):** A "Season Planning" view that shows last season's deliveries per product and lets you plan next season's purchasing.

---

## Area 2: Deliveries

### What's Working Well
- Two-step confirm -> complete flow with inventory deduction
- Driver dashboard with "Today / Upcoming / Completed" views
- 7-day schedule strip with unassigned count per day
- Quick Delivery shortcut (atomic order + delivery + invoice)
- Batch operations: cancel, reschedule, print PDFs
- Photo uploads (10 max, compressed), issue reporting
- Tote tracking with non-returnable flag
- RUP compliance warnings
- Delivery remainders for partial deliveries with follow-up creation
- Driver can self-assign unassigned deliveries

### Gaps & Blind Spots

#### 1. No Route Optimization / Map View
**Impact: VERY HIGH** | **Effort: HIGH**

You have Mapbox integrated (for field polygon drawing), customer addresses, and delivery addresses — but there's **no map view for delivery routes**. Drivers have to figure out the most efficient route themselves.

**What to build:** A "Route Planner" view (or tab on the Deliveries page) that:
- Shows today's deliveries on a Mapbox map with pins
- Clusters deliveries by geographic proximity
- Optionally suggests an optimized route order
- Lets drivers tap a pin to open navigation (Google Maps/Apple Maps deep link)

Even without full route optimization (which requires an API), just **seeing deliveries on a map** would be a huge win.

#### 2. No Load Sheet / Pick List
**Impact: HIGH** | **Effort: LOW**

Before a driver leaves the warehouse, they need to know what to load on the truck. Currently they have to open each delivery individually to see the items. There's no consolidated **"Load Sheet"** that says:

```
Driver: John | Date: March 1
───────────────────────────────
Product A: 50 gal (20 for Smith Farm, 30 for Jones Farm)
Product B: 10 bags (10 for Smith Farm)
Product C: 25 gal (25 for Jones Farm)
───────────────────────────────
Total: 3 products, 85 units, 2 stops
```

**What to build:** A "Print Load Sheet" action on the Deliveries page that aggregates all products across a driver's deliveries for a given day, grouped by product, with per-delivery breakdowns. PDF output.

#### 3. No Delivery Status Notifications to Customers
**Impact: HIGH** | **Effort: MEDIUM**

When a delivery is confirmed (in_progress) or completed, the customer has no idea. They'd have to call your office. There's no SMS, email, or even in-app notification to the customer.

**What to build (low-effort version):** Auto-generate a shareable delivery status link (like pizza tracking) that the customer can check. No login required — just a unique URL per delivery showing status + ETA + items.

#### 4. No Delivery Calendar View
**Impact: MEDIUM** | **Effort: MEDIUM**

The 7-day schedule strip is useful, but for planning deliveries a week or two out, there's no **calendar view**. Sales reps and dispatchers have to scroll through a list filtered by date.

**What to build:** A weekly/monthly calendar view (like Google Calendar) showing deliveries color-coded by status, with drag-and-drop to reschedule.

#### 5. No Delivery Time Window Enforcement
**Impact: MEDIUM** | **Effort: LOW**

The schema has `delivery_window_start` and `delivery_window_end` columns, but:
- The UI doesn't prominently display these
- There's no alert when a delivery is running late relative to its window
- There's no filtering by "overdue" (past window, still scheduled)

**What to build:** Add time window display to driver cards, add an "Overdue" filter/badge for deliveries past their window that aren't completed.

#### 6. No Driver Performance Metrics
**Impact: MEDIUM** | **Effort: LOW**

You have all the data to track driver performance — completed_at timestamps, scheduled_dates, issue reports — but no dashboard showing:
- Deliveries completed per day/week per driver
- Average time from confirm to complete
- Issue rate per driver
- On-time delivery rate

**What to build:** A "Driver Stats" section on the Deliveries page or a simple report showing key metrics per driver for a selected time range.

#### 7. No Signature Capture on Mobile
**Impact: MEDIUM** | **Effort: MEDIUM**

The `signature_url` field exists and there's a `create_signed_url()` RPC for privacy, but the signature capture appears to be basic. For a mobile-first driver experience, you'd want:
- Full-screen signature pad on mobile
- Typed name + signature
- Automatic attachment to completed delivery

#### 8. No Recurring Delivery Schedules
**Impact: LOW-MEDIUM** | **Effort: MEDIUM**

Some customers get deliveries on a regular schedule (every 2 weeks, monthly). There's no way to set up recurring deliveries — each one has to be manually created.

**What to build (future):** A "Recurring Schedule" option on customers that auto-generates delivery records X days in advance.

---

## Area 3: Blend Tickets (OCR)

### What's Working Well
- Full OCR pipeline: upload -> Google Vision -> parse -> review -> approve
- Multi-field extraction (customer, driver, applicator, products, quantities, field names, etc.)
- Fuzzy product matching with configurable threshold (0.6)
- Manual ticket creation (bypasses OCR)
- Blend recipes for common chemical mixes
- Confidence scoring with auto-complete (>70%) or needs-review (<70%)
- Order linkage (link blend ticket to existing order)
- Application record creation from approved tickets (with inventory deduction)
- Background queue processing with retry (3 max retries)
- Bulk ticket upload
- Bulk row selection with delete/export

### Gaps & Blind Spots

#### 1. No Per-Field Confidence Display
**Impact: HIGH** | **Effort: LOW**

When a ticket comes back at 65% confidence, the reviewer has **no idea which fields failed**. They have to manually check every field. The overall score is a black box.

**What to build:** Show a green/yellow/red confidence indicator next to each extracted field (customer, date, products, etc.) so reviewers can jump straight to the problem fields.

#### 2. No Raw OCR Text Viewer
**Impact: HIGH** | **Effort: LOW**

The `raw_ocr_text` is stored in the database but **never shown to the user**. When OCR gets a product name wrong, the reviewer has no way to see what the OCR actually read. They have to open the image and squint at it.

**What to build:** A "Raw OCR Text" expandable section on BlendTicketDetail that shows the full text Google Vision extracted, ideally with highlighting of the parts that matched to fields.

#### 3. No Batch Approve/Reject
**Impact: HIGH** | **Effort: LOW**

If 30 tickets come in from a delivery day, you have to open each one individually, review, and approve. That's 30 clicks minimum.

**What to build:** Checkbox selection on the BlendTickets list + "Batch Approve" button for tickets that are >90% confidence. Include a summary modal showing what will be approved.

#### 4. No Smart Auto-Link to Customer Orders
**Impact: HIGH** | **Effort: MEDIUM**

When a blend ticket is processed, the system extracts the customer name and products, but it **doesn't automatically suggest matching open orders**. The user has to manually find and link the ticket to an order.

**What to build:** After OCR completes, automatically search for the customer's open orders that contain the same products. Show "Suggested Order Match: ORD-2026-0042 (3 of 4 products match)" on the ticket detail page.

#### 5. No Lot Number Extraction from OCR
**Impact: HIGH** | **Effort: MEDIUM**

Lot numbers are printed on most blend tickets but the OCR parser **doesn't extract them at all**. This is a compliance requirement for Restricted Use Pesticides — you need to trace which lot was applied where.

**What to build:** Add lot number regex patterns to the OCR parser (common formats: alphanumeric 6-10 chars, often near quantity). Store as `lot_number` on `blend_ticket_products`.

#### 6. No Duplicate Detection
**Impact: MEDIUM** | **Effort: LOW**

The same ticket uploaded twice creates two separate records. There's no content-based or ticket-number-based deduplication. During busy days, this leads to double-counting.

**What to build:** Before creating a new ticket, check if a ticket with the same `ticket_number` + `ticket_date` already exists. Warn the user with "This ticket may already exist: BT-20260301-005."

#### 7. No Re-Processing Button
**Impact: MEDIUM** | **Effort: LOW**

If OCR fails or gives bad results, the user can manually correct — but they can't say "try OCR again." Sometimes re-processing with a better image or after a transient API failure would fix it.

**What to build:** A "Reprocess OCR" button on BlendTicketDetail that re-queues the ticket for processing.

#### 8. No Blend Math Validation at OCR Time
**Impact: MEDIUM** | **Effort: LOW**

The `blendMathValidator.ts` exists and validates that total volume equals sum of product quantities, but it only runs in the UI — **not during OCR processing**. So tickets with math errors auto-complete at >70% confidence.

**What to build:** Call `validateBlendMath()` in the Edge Function. If math doesn't add up, reduce confidence score and flag the ticket.

#### 9. Recipes Not Used During OCR
**Impact: MEDIUM** | **Effort: MEDIUM**

Blend recipes exist to define standard mixes, but OCR processing doesn't use them. If a ticket matches a known recipe, you could dramatically improve accuracy by cross-referencing extracted products against the recipe.

**What to build:** After OCR extracts products, compare against active blend recipes. If >80% product match, suggest the recipe and auto-fill missing fields.

#### 10. No Image Enhancement Before OCR
**Impact: LOW-MEDIUM** | **Effort: MEDIUM**

Blend tickets from the field are often crumpled, stained, or photographed at angles. There's no:
- Auto-rotation / orientation detection
- Skew correction
- Contrast enhancement

These would improve OCR accuracy significantly for poor-quality images.

---

## Priority Matrix: Where to Start

### Quick Wins (Low Effort, High Impact) — Do First

| # | Feature | Area | Effort | Impact |
|---|---------|------|--------|--------|
| 1 | **Load Sheet / Pick List PDF** | Delivery | 1-2 days | Saves drivers 15+ min/day |
| 2 | **Per-field confidence display** | Blend Tickets | 1 day | Cuts review time in half |
| 3 | **Raw OCR text viewer** | Blend Tickets | 0.5 day | Eliminates "what did OCR read?" guesswork |
| 4 | **Batch approve/reject** | Blend Tickets | 1 day | 30 clicks -> 2 clicks |
| 5 | **Inventory transaction ledger** | Inventory | 1-2 days | Answers "why is stock at X?" instantly |
| 6 | **Duplicate ticket detection** | Blend Tickets | 0.5 day | Prevents double-counting |
| 7 | **Delivery time window alerts** | Delivery | 0.5 day | Shows overdue deliveries |
| 8 | **Inventory valuation cards** | Inventory | 0.5 day | Know total $ on the floor at a glance |

### Medium Effort, High Impact — Do Next

| # | Feature | Area | Effort | Impact |
|---|---------|------|--------|--------|
| 9 | **Delivery map view** | Delivery | 3-5 days | Huge for driver efficiency |
| 10 | **Auto-suggest order match** | Blend Tickets | 2-3 days | Eliminates manual order linking |
| 11 | **Suggested reorder / auto-PO** | Inventory | 2-3 days | Prevents stockouts |
| 12 | **Inventory transfers** | Inventory | 2 days | Proper multi-warehouse management |
| 13 | **Lot number OCR extraction** | Blend Tickets | 2-3 days | Compliance requirement |
| 14 | **Driver performance metrics** | Delivery | 2 days | Data-driven operations |

### Longer-Term / Future Sprints

| # | Feature | Area | Effort | Impact |
|---|---------|------|--------|--------|
| 15 | **Delivery calendar view** | Delivery | 3-5 days | Better scheduling UX |
| 16 | **Lot-level inventory tracking** | Inventory | 5+ days | Full compliance traceability |
| 17 | **Recipe-based OCR enhancement** | Blend Tickets | 3-4 days | Better accuracy |
| 18 | **Customer delivery notifications** | Delivery | 3-5 days | Professional customer experience |
| 19 | **Seasonal demand forecasting** | Inventory | 5+ days | Smarter purchasing |
| 20 | **Recurring delivery schedules** | Delivery | 3-5 days | Automation for repeat customers |

---

## Recommended First Sprint

If I were picking the first batch of work, I'd do these 5 things:

1. **Load Sheet PDF** — Your drivers will love you. This is the single most impactful daily workflow improvement.
2. **Inventory Transaction Ledger** — Stop digging through the database when someone asks "why."
3. **Blend Ticket Batch Approve + Per-Field Confidence** — Cut blend ticket review time by 70%.
4. **Inventory Transfers** — If you have multiple warehouses, this is a must-have.
5. **Delivery Map View** — You already have Mapbox. Dropping delivery pins on a map is the biggest wow-factor feature.

---

## Cross-Cutting Observations

### Things That Are Surprisingly Strong
- **Idempotency** is everywhere — double-submit protection is solid
- **RLS policies** cover every table — security is tight
- **Audit trails** (inventory_transactions, financial_audit_log, activity_feed) — compliance-ready
- **Reconciliation checks** — cross-entity data integrity is monitored
- **Offline support** for driver delivery completion — handles rural/field scenarios

### Things to Watch
- **500-row query limits** on several pages (deliveries, blend tickets, customers) — will become a problem as data grows. Consider server-side pagination.
- **No real-time inventory updates** — the Inventory page doesn't use the `useRealtimeSubscription` hook, so if two people are adjusting inventory simultaneously, they could be looking at stale data.
- **Client-side PDF generation** — works for now, but large batch prints (50+ deliveries) might hit browser memory limits. Server-side PDF generation would scale better.
- **OCR is Google Vision only** — single point of failure. If Google Vision API goes down or changes pricing, there's no fallback.
