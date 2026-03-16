# Quote Builder V2 — Design Document

**Date:** 2026-03-16
**Status:** Approved
**Approach:** Migration per sprint (Approach B)
**Sprints:** 12

---

## Summary

Major upgrade to the Quote Builder covering: versioning with full snapshots, reworked send/present workflow, product notes auto-pull, PDF column customization, planned programs with inventory forecasting, quote templates, and cross-app integrations.

---

## Sprint 1: Product Internal Notes Field

**Migration:** `_product_internal_notes.sql`

### Database
- Add `internal_notes` (text, nullable) to `products` table
- Copy existing `notes` data → `internal_notes` for all products
- `notes` column stays as-is — no rename, no drop

### Frontend
- **ProductDetail.tsx:** Relabel "Notes" textarea to **"Grower Description"** with helper text: "Shown to growers on quotes and PDFs"
- Add new **"Internal Notes"** textarea below it with helper text: "Internal only — never shown to growers"
- Both are 3-row textareas

### TypeScript
- Add `internal_notes: string | null` to `Product` interface
- All existing `product.notes` references remain unchanged

### Impact
- Zero breaking changes — everything referencing `product.notes` continues to work

---

## Sprint 2: Quote Versioning

**Migration:** `_quote_versioning_v2.sql`

### Database
- `quote_versions` table already exists — no schema change
- New RPC: **`create_quote_version(p_quote_id, p_performed_by, p_method)`**
  - `p_method`: `'presented'` | `'emailed'`
  - Snapshots full quote state (sections, items, prices, notes, totals) into `snapshot_data` JSONB
  - Auto-increments `version_number`
  - Sets `sent_at`, `sent_by`, `sent_method`
  - Updates quote status → `sent`
- New RPC: **`restore_quote_version(p_quote_id, p_version_id, p_performed_by)`**
  - Reads `snapshot_data` from target version
  - Overwrites current quote sections/items with snapshot data via `save_quote` pattern (delete + re-insert)
  - Sets status → `revised`
  - All version history preserved — non-destructive

### Frontend
- **Version History panel** (expandable sidebar or modal):
  - List: V1 (Presented Mar 5), V2 (Emailed Mar 10), etc.
  - Click version → **read-only snapshot view** with all sections, items, prices, totals
  - **"Compare to Current"** button → inline diff highlighting added/removed products, price changes, qty changes
  - **"Restore as Draft"** button → calls `restore_quote_version`, reloads as `revised` status
- Version badge in header: "V3" next to quote number

### Version Trigger Rules
| Action | Creates Version? | Status Change? |
|--------|:-:|:-:|
| Save Draft | No | stays `draft` |
| Preview PDF | No | no change |
| Download PDF | No | no change |
| **Mark as Presented** | **Yes** | → `sent` |
| **Email to Grower** | **Yes** | → `sent` |
| Edit after presenting | No | → `revised` |

---

## Sprint 3: Send/Present Workflow Rework

**Migration:** None (frontend only)

### Current Flow (being replaced)
Click "Send Quote" → auto-emails grower → status changes

### New Flow
1. **"Preview Quote" button** replaces current "Send Quote"
2. Opens **PDF preview modal** with the quote rendered in-browser
3. Column preset selector visible in modal (see Sprint 5)
4. Three action buttons from preview:

| Button | Action | Creates Version? | Status Change? |
|--------|--------|:-:|:-:|
| **Download PDF** | Saves PDF to computer | No | No |
| **Mark as Presented** | Flags as shown to grower | Yes | → `sent` |
| **Email to Grower** | Disabled for now ("Coming Soon" tooltip) | Yes (when enabled) | → `sent` |

### Customer View Toggle
- Add `customerView` toggle button to QuoteBuilder (follows SalesReports `customerView` pattern)
- Uses `Eye`/`EyeOff` icon + green banner when active
- Hides: Cost, Profit, Margin columns from the editor table
- Cost/profit/margin **NEVER** appear on grower-facing PDFs regardless of toggle
- Toggle state is UI-only (not persisted)

---

## Sprint 4: Product Notes Auto-Pull + Section Header Notes

**Migration:** `_quote_section_header_notes.sql`

### Database
- Add `section_header_notes` (text, nullable) to `quote_sections` table

### Quote Item Notes Auto-Pull
- When a product is added to a quote, `product.notes` (grower description) auto-populates into the quote item's `notes` field
- `notes` field is editable per-quote — customize for this specific grower
- Small **"Reset to default"** link to restore product's original notes
- No schema change — `quote_items.notes` already exists

### Section Header Notes
- New textarea on each section, between section name and items table
- Collapsible when empty — no visual clutter
- Use case: "Use this program in early spring. If weather delays, call us."

### PDF Rendering
```
┌─ SOYBEAN PRE-EMERGE ──────────────────────────┐
│ [section_header_notes — above items, italic]   │
│                                                │
│ Product │ Notes │ Rate │ Acres │ Price │ Total  │
│ ...     │ ...   │ ...  │ ...   │ ...   │ ...    │
│                                                │
│ [section_notes — below items, italic]          │
└────────────────────────────────────────────────┘
```
- All three note areas (header, item, footer) skip rendering if empty — no blank space

---

## Sprint 5: PDF Column Picker + Presets

**Migration:** `_quote_pdf_templates.sql`

### New Table: `quote_pdf_templates`
| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid, PK | |
| `template_name` | text, NOT NULL | "Program Detail", etc. |
| `columns` | jsonb | Array of column keys in display order |
| `is_default` | boolean | Which preset is pre-selected |
| `is_system` | boolean | Seed presets — editable but not deletable |
| `created_by` | uuid, nullable | Null for system presets |
| `created_at` | timestamptz | |
| `updated_at` | timestamptz | |

### Seed Presets
| Preset | Columns |
|--------|---------|
| **Program Detail** (default) | product, notes, sug_rate, actual_rate, acres, qty, price_unit, price_per_acre |
| **Simple Pricing** | product, notes, price_unit, price_per_acre |
| **Summary** | product, qty, total_price |

### Available Columns (grower-safe only)
`product`, `category`, `notes`, `sug_rate`, `actual_rate`, `rate_unit`, `acres`, `qty`, `unit_size`, `price_unit`, `price_per_acre`, `total_price`

**Cost, profit, margin are NEVER available for grower PDFs.**

### Quote-Level Storage
- Add `pdf_template_id` (uuid, nullable, FK → `quote_pdf_templates`) to `quotes` table
- Add `pdf_columns_override` (jsonb, nullable) to `quotes` table
- Priority: `pdf_columns_override` > `pdf_template_id` > default preset

### UI in Preview Modal
- Dropdown to pick a preset
- "Customize" button → checkboxes for each column with drag-to-reorder
- Changes reflect immediately in preview
- Saved with the quote

### Future: Settings Page
- Edit preset names and columns
- Create new presets
- Set default preset
- System presets editable but not deletable

---

## Sprint 6: Planned Programs + Inventory Forecasting

**Migration:** `_planned_programs.sql`

### Database
- Add `needed_by_date` (date, nullable) to `quote_sections` table
- New RPC: **`create_planned_holds(p_quote_id, p_performed_by)`**
  - Called when quote saved with `is_planned = true`
  - Creates `inventory_holds` row per quote item:
    - `hold_type` = `'crop_program'`
    - `source_id` = quote id
    - `customer_id` = quote's customer
    - `expires_at` = section's `needed_by_date` + 14 days
    - `is_active` = true
  - Idempotent: deletes old holds for this quote first
- When `is_planned` toggled OFF → releases all holds for that quote
- New RPC: **`get_expiring_planned_holds(p_days_ahead integer)`**
  - Returns holds where `needed_by_date` is within N days
  - Grouped by quote/customer with product details

### Hold Expiration Timeline
| Event | What Happens |
|-------|-------------|
| 7 days before `needed_by_date` | Dashboard alert: "Planned program holds expiring soon" |
| `needed_by_date` passes | Nothing — holds stay active, buffer starts |
| 14 days after `needed_by_date` | Holds auto-expire (`is_active` → false) |
| Anytime | Manual release available |

### Frontend — QuoteBuilder
- **"Planned Program"** toggle switch on quote header
- When ON: date picker on each section header labeled "Needed By"
- Badge: "Planned Program" on quote header

### Frontend — Quotes List
- New filter tab: **"Planned Programs"**
- `is_planned` badge on quote rows
- Sortable by earliest `needed_by_date`

### Frontend — Dashboard
- New alert card in action items section
- "X planned programs need attention — holds expiring in 7 days"
- Click → shows list with links to each quote
- Follows existing dashboard alert pattern

---

## Sprint 7: Quote Templates

**Migration:** `_quote_templates.sql`

### New Table: `quote_templates`
| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid, PK | |
| `template_name` | text, NOT NULL | "2026 Soybean Program" |
| `description` | text, nullable | When to use this template |
| `sections` | jsonb | Section structure with items (no customer data) |
| `created_by` | uuid, FK → profiles | |
| `is_active` | boolean, default true | |
| `created_at` | timestamptz | |
| `updated_at` | timestamptz | |

### Template Content (what's saved)
- Section names, order, header notes, footer notes
- Products with: suggested_rate, actual_rate, rate_unit, calc_mode, notes

### Template Exclusions (NOT saved)
- Customer, acres, total_units_needed, pricing overrides
- Quote number, status, dates, commission splits

### RPCs
- **`save_quote_template(p_quote_id, p_template_name, p_description, p_performed_by)`**
  - Reads quote sections/items, strips customer-specific data, saves to `quote_templates`
- **`create_quote_from_template(p_template_id, p_customer_id, p_performed_by)`**
  - Creates new draft quote from template
  - Auto-fills tier pricing from customer's assigned tier
  - Returns new `quote_id`

### Frontend
- **"Save as Template"** button on any quote → prompts for name + description
- **"New Quote" page** gets "Start from Template" dropdown
- Selecting template pre-fills sections/products, then pick customer and enter acres

---

## Sprint 8: Notes Flow Through Pipeline

**Migration:** `_notes_pipeline_flow.sql`

### Quote → Order
- Update `convert_quote_to_order` RPC:
  - Copy `quote_items.notes` → `order_items.notes`
  - Copy `quote_sections.section_header_notes` → order equivalent (if order sections exist) or store in order-level notes

### Order → Delivery
- When delivery items created from order items:
  - Copy `order_items.notes` → `delivery_items.notes`
  - Add `notes` to `delivery_items` if not already present

### Delivery → Load Sheet PDF
- Update load sheet PDF generation to include product notes column
- Driver sees application info: "apply at 2oz/acre, do not tank mix with X"

### Principle
- Enter product info ONCE on the product → auto-flows to quote → order → delivery → load sheet
- Editable at each stage — customizations don't flow backward

---

## Sprint 9: Customer Detail — Quotes & Programs Tabs

**Migration:** None (frontend only, uses existing data)

### New Tabs on CustomerDetail.tsx
- **"Quotes" tab** — all quotes for this customer
  - Columns: Quote #, Status, Total, Created, Expires
  - Status badges (color-coded)
  - Click → navigates to QuoteBuilder
- **"Planned Programs" tab** — active planned programs
  - Columns: Quote #, Sections (with needed_by_date), Hold Status, Total Held Qty
  - Visual indicator: holds active vs expired
- Both tabs use existing data — just new queries joining `quotes` where `customer_id` matches

---

## Sprint 10: Inventory Forecasting Dashboard

**Migration:** `_inventory_forecasting.sql`

### New RPC: `get_inventory_forecast(p_months_ahead integer)`
- Aggregates all active planned holds grouped by product and month (based on `needed_by_date`)
- Returns: product_name, month, planned_demand, current_available, on_order, net_gap
- Net gap = planned_demand - (available + on_order - prebooked)

### Frontend — New Tab on Inventory Page: "Forecast"
- **Planned Demand view** — all active planned holds grouped by product
- **Timeline view** — bar chart or table: "March: 500 gal Roundup, April: 300 gal"
- **Gap alerts** — highlighted rows where planned demand > supply
  - "Roundup: Need 500 gal by April 1, have 200 on hand + 100 on order = shortfall 200"
- **Filters:** product, date range, customer

---

## Sprint 11: Seasonal Program Rollover

**Migration:** `_seasonal_rollover.sql`

### New RPC: `rollover_quote_to_season(p_quote_id, p_new_season, p_performed_by)`
- Duplicates quote into new season
- Strips old dates, resets status to `draft`
- Updates pricing to current tier prices (re-fetches from products table)
- Resets `needed_by_date` on sections to null (user sets new dates)
- Returns new `quote_id`

### Frontend
- **"Roll Over to New Season"** button on any quote
- Prompts for target season year
- Creates new draft with updated pricing
- Navigates to the new quote for editing

---

## Sprint 12: Quick Quote from Customer Page

**Migration:** None (frontend only)

### CustomerDetail.tsx Changes
- **"New Quote" button** in the customer header area
  - Navigates to `/quotes/new?customer_id={id}`
  - QuoteBuilder auto-fills: customer, tier, commission split from customer defaults
- **"New from Last Quote" button** (visible if customer has existing quotes)
  - Finds most recent quote for this customer
  - Duplicates it as new draft (uses existing `duplicate_quote` RPC)
  - Navigates to new quote

---

## Architecture Decisions

### Why migration-per-sprint
- 187 existing migrations, project handles them well
- Smaller migrations easier to review and rollback
- Each sprint is fully self-contained and deployable

### Why `notes` column stays as-is
- Zero breaking changes across entire codebase
- All existing references to `product.notes` continue to work
- Just relabeled in UI as "Grower Description"
- `internal_notes` added as new column

### Why presets + custom picker (not just one)
- Presets cover 90% of use cases with one click
- Custom picker handles the 10% edge cases
- Presets editable in future Settings page

### Why holds expire 14 days after need date (not on need date)
- Agricultural timelines are weather-dependent
- 14-day buffer prevents premature release
- 7-day dashboard alert before need date gives time to follow up
- Manual release always available

### Why restore creates new draft (not literal revert)
- Non-destructive — version history always preserved
- Allows tweaking before re-presenting
- Grower never sees a version that wasn't intentionally presented

---

## What's NOT in Scope

- Email sending (button wired but disabled — "Coming Soon")
- Quote analytics/conversion reports
- Template manager Settings page (templates created via "Save as Template" only)
- Inventory page "Planned" column breakdown (forecasting dashboard covers this)
- Auto-expire holds via scheduled job (uses `expires_at` column checked at query time)
