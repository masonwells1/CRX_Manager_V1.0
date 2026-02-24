# Price List Versioning System — Design Document

> **Status:** FUTURE PROJECT — DO NOT WORK ON THIS UNLESS INSTRUCTED TO
>
> **Created:** 2026-02-23
> **Author:** Mason Wells + Claude (brainstorming session)
> **Priority:** Future enhancement (post-launch)

---

## Problem Statement

Product prices (both vendor cost and sell prices) change throughout the growing season. Currently, prices are snapshotted at the quote level — which works well for individual quotes. But there is no formal mechanism to:

1. Create named, reusable price snapshots ("Early Bird 2026", "Spring 2026")
2. Assign a customer to a specific price version so future quotes default to those prices
3. See at a glance what price a customer was committed to vs current prices
4. Incentivize early planning and prepayment by making committed pricing visible and easy to honor
5. Track seasonal price evolution for margin/commission reporting

## Business Context

- Quoting season: Dec–Mar. Work season: Mar–Aug.
- Chemical costs change monthly (vendor-driven). Sell prices also change (strategic).
- Most customers quote first, but some book lump sums split to landlords after work.
- Sales reps decide pricing case-by-case — system should suggest, not enforce.
- Customers who plan early and prepay should be rewarded with locked pricing.
- Admin and sales reps both need full access to this feature.

## What Already Works (No Changes Needed)

- `quote_items.price_per_unit` and `quote_items.current_cost` snapshot at quote creation
- `order_items` copy from `quote_items` — locked at conversion
- `invoice_items` locked at invoicing (cents as bigint)
- `commissions` calculated from `order_profit` at conversion time
- `cost_history` table logs every cost/price change with old/new values and timestamps
- All of the above remains unchanged by this design

## Chosen Approach: Price List Versioning (Approach A)

### New Database Tables

#### `seasons`
Named crop year with custom date range.

| Column | Type | Notes |
|--------|------|-------|
| id | uuid PK | |
| name | text NOT NULL | e.g., "2026 Season" |
| start_date | date NOT NULL | e.g., 2025-11-01 |
| end_date | date NOT NULL | e.g., 2026-10-31 |
| is_current | boolean DEFAULT false | Only one can be true |
| notes | text | |
| created_by | uuid FK profiles | |
| created_at | timestamptz | |

#### `price_lists`
Named price snapshot within a season.

| Column | Type | Notes |
|--------|------|-------|
| id | uuid PK | |
| season_id | uuid FK seasons | |
| name | text NOT NULL | e.g., "Early Bird 2026" |
| effective_date | date NOT NULL | When this list became active |
| expires_at | date | Optional expiration |
| is_current | boolean DEFAULT false | The currently active list for new quotes |
| notes | text | |
| created_by | uuid FK profiles | |
| created_at | timestamptz | |

#### `price_list_items`
Per-product prices for a given list. Only includes products the admin selects.

| Column | Type | Notes |
|--------|------|-------|
| id | uuid PK | |
| price_list_id | uuid FK price_lists | |
| product_id | uuid FK products | |
| tier1_price | numeric | Tier 1 sell price |
| tier2_price | numeric | Tier 2 sell price |
| tier3_price | numeric | Tier 3 sell price |
| cost_at_time | numeric | Product cost when snapshotted |
| notes | text | Per-product notes |
| UNIQUE | (price_list_id, product_id) | No duplicates |

### Column Additions to Existing Tables

- `customers.committed_price_list_id` — nullable FK to `price_lists`. Which price list this customer is locked to.
- `quotes.price_list_id` — nullable FK to `price_lists`. Which price list was used when building this quote (audit trail).

### Workflow: Creating a Price List

1. Admin goes to **Settings > Price Lists** (new page, admin-only)
2. Clicks "New Price List"
3. Names it, selects the season, sets effective date
4. Selects products to include (checkboxes from product list)
5. Option: "Import from current prices" button pre-fills with today's product prices for selected products
6. Can manually adjust any tier price or cost before saving
7. Can also create a price list from **BulkPricingImport** — after importing, prompt: "Create a price list from these prices?"

### Workflow: Assigning a Customer

1. **Customer Detail page** gets a new dropdown: "Committed Price List" (active lists for current season)
2. Admin or sales rep selects a list and saves
3. **Auto-assignment:** When a quote is accepted (`convert_quote_to_order`), if the quote has a `price_list_id`, customer automatically gets assigned to that list (unless they already have one)
4. Admin can manually change or remove the assignment anytime

### Workflow: QuoteBuilder Behavior

**Customer WITH committed price list:**
- Line item prices default to the committed price list's prices
- Visual indicator: "Committed: $50.00 | Current: $65.00" next to each product
- Rep can override to current price or any custom price
- Quote header shows which price list is being used
- Products NOT on the committed list fall through to current product pricing

**Customer WITHOUT committed price list:**
- Works exactly as today — current product tier prices
- Rep can optionally select a price list from a dropdown to apply

### Workflow: Quick Delivery

- If customer has committed price list, quick delivery modal defaults to committed prices
- Falls through to current prices for products not on the list

### Season Management

- Seasons page under Settings (admin-only)
- List of seasons with name, date range, active status
- Only one season `is_current` at a time
- On new season creation, customer `committed_price_list_id` values are NOT carried forward
- Old season data remains fully accessible for historical lookback

### Reporting

1. **Price List Comparison** — side-by-side: two or more price lists vs current prices
2. **Customer Price Commitment Report** — customers, their committed list, invoiced amount, and what they'd pay at current prices ("savings" column)
3. **Margin Analysis Enhancement** — existing reports gain "Committed Cost" column alongside actual cost

### Access Control

- **Admin:** Full CRUD on seasons, price lists, customer assignments
- **Sales Rep:** Can view price lists, assign customers to lists, use committed pricing in QuoteBuilder
- **Driver/Applicator:** No access to price list management

### What Does NOT Change

- `quote_items` still snapshots final price chosen by rep
- `order_items` still copied from `quote_items`
- `invoice_items` still in cents, locked at invoicing
- `commission` still from `order_profit` at conversion
- `cost_history` continues logging every individual change
- `prepay_credits` work the same (account-level, not product-level)
- All RLS, idempotency, rate limiting patterns unchanged

### Key Design Decisions

1. **System suggests, rep overrides** — no hard enforcement of committed prices
2. **Selective product inclusion** — admin picks which products go on each list; others fall through to current
3. **~4 formal lists per season** plus ongoing current pricing for in-season work
4. **Price lists are internal** — not handed to customers (quotes serve that purpose)
5. **cost_history remains the ground truth** for historical cost tracking; price lists are named bookmarks on top

### Estimated Scope

- 3 new database tables + 2 column additions
- 1 new migration file
- 2 new pages (Seasons, Price Lists under Settings)
- QuoteBuilder UI enhancements (committed price display, price list selector)
- Customer Detail UI enhancement (committed price list dropdown)
- BulkPricingImport enhancement (optional price list creation)
- 2-3 new reports or report enhancements
- RLS policies for new tables
- Unit + E2E tests

### Open Questions (To Resolve Before Implementation)

1. Should price list items store per-acre prices too, or just per-unit?
2. Should we track which rep overrode a committed price on a quote line? (audit trail)
3. Do we need a "price list PDF" export even though we don't hand them to customers? (internal reference)
4. Should season rollover prompt admin to review/clear customer commitments?
