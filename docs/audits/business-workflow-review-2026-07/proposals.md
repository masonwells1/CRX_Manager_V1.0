# PROPOSAL: entry-points

# Entry-Point Consolidation — Full Catalog + Proposal

## Part 1 — Every way to create an Order, Invoice, or Job today (verified)

### Orders — 7 creators, 13 button locations

| # | Engine (RPC) | Button & location | Shows when |
|---|---|---|---|
| 1 | `convert_quote_to_order` | **"Convert to Order"** — QuoteBuilder.tsx:2010-2017; **row icon** — Quotes.tsx:478-486 | Builder: quote `sent` only (QuoteBuilder.tsx:277). List: `sent`+`revised`. RPC accepts sent/revised (mig `20260702172500`:120) — the two screens disagree (Finding 2) |
| 2 | `draw_down_quote` | **"Partial Order"** — QuoteBuilder.tsx:2023-2031 | `sent`/`revised` booking (:281) |
| 3 | `create_direct_order` | **/orders/new** (NewOrder.tsx:427) via 4 doors: Orders.tsx:575 + :598, Dashboard.tsx:424, CustomerDetail.tsx:578 | always (admin+sales) |
| 4 | `create_rush_order` | same page — **"Ship now, price later (rush order)"** checkbox (NewOrder.tsx:552-557 → :391) | toggle on /orders/new |
| 5 | `create_quick_delivery` | **"Quick Delivery"** modal — Deliveries.tsx:845 (driver view) + :1160 (desktop). Creates order + delivery + optional draft invoice (QuickDeliveryModal.tsx:232, invoice checkbox :484-492, default ON) | Deliveries page only |
| 6 | `create_order_from_blend_ticket` | **"Create Order from Ticket"** — BlendTicketDetail.tsx:1440 → modal :1580 | completed ticket |
| 7 | `bulk_import_order` | **"Import Orders"** — Orders.tsx:571 (BulkOrderImport.tsx:377) | setup/CSV tool |

### Invoices — 12 creators (5 automatic/backstop, 7 with buttons)

| # | Engine | Entry | Notes |
|---|---|---|---|
| 1 | `complete_delivery` auto-draft | none — automatic on delivery completion | mig `20260620220000`:252; **THE chemical billing path** |
| 2 | `create_quick_delivery` draft | checkbox in Quick Delivery modal | default ON |
| 3 | `create_invoice_from_order` | **"Create Invoice"** — OrderDetail.tsx:1128 | hidden once a delivery/invoice is active (:1120); warns if delivery pending (:1131) |
| 4 | `create_split_invoices_from_order` | same button — silent branch when field allocations exist (OrderDetail.tsx:822-836) | split preview panel shown in-page (:1856) |
| 5 | `create_invoice_from_blend_ticket` | **"Create Invoice"** — BlendTicketDetail.tsx:1472 | approved + unbilled only |
| 6 | `create_invoice_for_unbilled_delivery` | IntegrityCleanup.tsx:316 | admin backstop (correctly demoted) |
| 7 | `generate_finance_charges` | AR Aging modal — ARaging.tsx:1139 | admin; inserts `misc_charge` invoices |
| 8 | `issue_return_credit` | **"Issue Credit"** — Returns.tsx:945 (:410) | the credit-memo path |
| 9 | `save_invoice` (new) | **/invoices/new — NO BUTTON EXISTS** (InvoiceDetail.tsx:108, :617; type dropdown Chemical Sale / Misc Charge :1285-1291) | hidden misc-charge creator (Finding 3) |
| 10 | `transfer_job_to_invoice` | **"Transfer to Invoice"** — JobDetail.tsx:2576 (:2110) | job `completed` only (:2492); links job → invoice, guards re-bill (mig `20260622020000`:90, :274) |
| 11 | `save_field_app_invoice` | **/invoices/field-app/new** via 4 buttons: Invoices.tsx:681, FieldInvoices.tsx:519 + 616 ("New Field Application"), FieldInvoicesUnposted.tsx:404 ("Add Invoice", primary) | manual editor, **no job picker** (FieldApplicationInvoice.tsx:294-298) — Finding 1 |
| 12 | `complete_job` §4 auto-draft | none — setting `auto_draft_invoice_on_job_completion`, **OFF** (mig `20260630073344`) | calls #10 internally |

### Jobs — 2 creators + 2 non-creators often mistaken for one

| # | Engine | Entry |
|---|---|---|
| 1 | `save_job` (new) | **/jobs/new**: "New Job" — Jobs.tsx:1552-1557; "Add New Job" — buried in DispatchBoard ⋯ options menu (DispatchBoard.tsx:703-709) |
| 2 | `create_job_from_quote_section` | **"Schedule Job"** per section — QuoteBuilder.tsx:2617-2620 (:1564); planned, non-terminal bookings (:293-297) |
| — | Blend ticket → job | **link only** (dropdown, BlendTicketDetail.tsx:902-912), not a creator |
| — | `transfer_invoice_to_job` | **reopens** the source job (FieldApplicationInvoice.tsx:2157) — a reversal, not a creator |

**Total: ~22 creation controls across 13 pages.** The engines are mostly right; the *presentation* is what confuses — several situations have 2-4 competing doors, one situation (misc charge) has zero.

---

## Part 2 — One primary path per real-world situation (before → after)

### S1. Formal program booking (big account: sections, holds, season draw-down)
- **Before:** QuoteBuilder — right tool, but its header stacks ~12 actions, and the two order-creators sit side by side ("Convert to Order" + "Partial Order") with the difference only in hover tips; Convert disappears entirely on a `revised` quote (must go back to the list row icon).
- **After (primary = QuoteBuilder, unchanged engine):** ONE **"Create Order ▾"** control with two named choices — *Convert whole booking* (available on sent AND revised, matching the RPC) and *Draw part of booking…* (opens the existing partial-draw modal). Move Save-as-Template, Roll Over to New Season, Customer View into a ⋯ overflow. Zero RPC changes.

### S2. Fast phone order (book now, deliver later) — highest volume
- **Before:** /orders/new already merges two modes well (priced `create_direct_order` vs "Ship now, price later" `create_rush_order` toggle). 4 doors in.
- **After (primary = /orders/new, keep as-is):** promote it to the FIRST Dashboard quick action. No demotions — this path is already correct.

### S3. Counter sale — product walking out the door now
- **Before:** Quick Delivery (one modal = order + delivery + draft invoice) exists ONLY as a secondary button on the Deliveries page (Deliveries.tsx:845, :1160).
- **After (primary = Quick Delivery modal):** add it to Dashboard quick actions as **"Sell & Deliver Now"**; keep the Deliveries buttons. This is the true walk-in tool — it auto-numbers everything and pre-drafts the bill.

### S4. Spray-job creation — highest volume
- **Before:** visible "New Job" on Job Schedule; on the Dispatch Board (where schedulers live) it's hidden in the ⋯ options menu; program bookings schedule per-section from QuoteBuilder.
- **After (primary = /jobs/new):** visible **"New Job"** header button on BOTH Jobs and Dispatch Board. QuoteBuilder's per-section button stays as the *program* path (it's the only one that ties the job to the booking so holds/draws stay honest) — relabel **"Schedule Job from Booking"**.

### S5. Billing a job (application invoice; incl. fee-only/customer-supplied product)
- **Before:** correct engine = JobDetail "Transfer to Invoice" (links job, flips to `invoiced`, refuses re-bill). But all four invoice pages advertise the MANUAL editor ("New Field Application"/"Add Invoice"), which cannot link a job → phantom backlog + double-bill exposure (Finding 1). Unbilled backlog page is read-only: list → job → transfer = 3 hops.
- **After (primary = transfer_job_to_invoice):** put a one-click **"Create Invoice"** on each row of Unbilled Applications (calls the RPC directly); keep the JobDetail button. **Demote the manual editor:** delete its button from /invoices; on the two field-invoice pages move it behind ⋯ as **"Manual Invoice (no job)"** — it stays the door for fee-only/customer-supplied-chemical bills not run through a job, which the editor already handles (application-fee lines via ApplicationServicePicker). **Owner decision:** flip §4 `auto_draft_invoice_on_job_completion` ON at go-live so completed jobs bill themselves into the Unposted tray (recommended — it's draft-only, never auto-posts).

### S6. Billing a delivery (chemical channel)
- **Before/After: no change.** Auto-draft on `complete_delivery` is the primary; OrderDetail "Create Invoice" remains the guarded pre-delivery override (already warns and hides itself appropriately); IntegrityCleanup stays the admin backstop.

### S7. Misc charge (fee, freight, service)
- **Before:** no door at all — /invoices/new works only if you type the URL (Finding 3).
- **After (owner decision, recommended):** one **"Misc Charge"** button on /invoices opening /invoices/new with type locked to `misc_charge`. (Strict alternative: remove the isNew route entirely.)

### S8. Credit memo
- **Before/After: no change.** Returns → approve → receive → **"Issue Credit"** is already exactly one path.

---

## Part 3 — Demotion ledger (nothing deleted from the database)

| Entry point | Today | Moves to |
|---|---|---|
| "Partial Order" button | adjacent twin of Convert | merged into one "Create Order ▾" chooser (RPC kept) |
| Save-as-Template / Roll Over / Customer View | QuoteBuilder header row | ⋯ overflow menu |
| "New Field Application" on /invoices | the page's only + button | **removed from that page** (button only; route + RPC kept) |
| "Add Invoice" (Unposted tray) / "New Field Application" (Field Invoices) | primary/secondary buttons | one label, behind ⋯ as "Manual Invoice (no job)" |
| DispatchBoard "Add New Job" | ⋯ options menu | promoted to header button |
| Quick Delivery | Deliveries-page-only | promoted to Dashboard ("Sell & Deliver Now") |
| /invoices/new (misc charge) | hidden URL | either linked ("Misc Charge" button) or route closed — owner call |
| create_invoice_for_unbilled_delivery | IntegrityCleanup | stays (already correctly demoted) |
| create_order_from_blend_ticket + create_invoice_from_blend_ticket | BlendTicketDetail | stay contextual (OCR is off the daily path in year one); auto-generate the order number |
| bulk_import_order / BulkQuoteImport | list-page headers | fine as-is (setup tools) |
| Dashboard quick actions New PO / Receiving / Inventory | top row | second row (or removed), replaced by New Quote / New Job / Sell & Deliver Now / New Order |

**Net effect:** each of the 8 owner situations gets exactly one obvious button; the 22 creation controls drop to ~12 visible ones; every RPC survives untouched, so this is a UI-layer refactor plus two optional owner decisions (§4 auto-draft ON; misc-charge policy).


===========


# PROPOSAL: nav-redesign

## Navigation / IA Redesign Proposal — CRX Manager

**IA** (information architecture) = how the menu is organized. Everything below is a re-grouping and re-labeling of the EXISTING pages — no page is deleted, no URL changes, every current route keeps a working home.

### The two anchors — say it plainly

**Office Cockpit and To-Ship are THE two daily landing surfaces, and the menu should treat them that way.**
- **Office Cockpit** (`/office-cockpit`) is the *morning* screen: its 7 tiles are exactly the owner's "what needs attention" list (unbilled jobs, invoices ready to post, watchdog flags, next-7-days jobs, expiring licenses, overdue field AR, inventory shortfalls). Rename it **"Today"** and make it the post-login landing page for admin + sales.
- **To-Ship** (`/to-ship`) is the *shipping-day* screen: what must go out, low stock, unassigned/overdue deliveries, inbound POs. It stays the #2 standalone item.
- The current KPI Dashboard at `/` stays, but demoted to **Insights → Overview** — it's a review screen, not a work screen.
- Phone roles get their own landings: **applicator → `/field` ("My Day")**, **driver → `/my-route` ("My Route")**. (Today an applicator lands on the office KPI dashboard — see findings.)

### Global "+ New" button (top bar, next to Search)

The owner's fastest scenario — a phone call that must become a booking *right now* — should never depend on where you are in the menu. One green **+ New** button in the top bar, on every page: **Quote/Booking · Order · Delivery · Job · Field App Invoice · PO · Quick Receive**. That makes every "create" flow exactly 2 clicks from anywhere. (These all already exist as routes; this is just a menu for them.)

---

### New menu tree — OFFICE view (admin + sales_rep)

```
▸ Today (Office Cockpit)            /office-cockpit      ← post-login landing
▸ To-Ship (Load-Out Board)          /to-ship

SELL & DELIVER — chemical sales: we deliver, they apply
    Quotes & Bookings               /quotes
    Orders                          /orders
    Deliveries                      /deliveries
    My Route (field mode)           /my-route            (shared with drivers)
    Remainders                      /delivery-remainders
    Invoices — Chemical             /invoices
    Returns                         /returns

SPRAY FIELDS — custom application: we apply, billed per acre
    Job Schedule                    /jobs
    Dispatch Board                  /dispatch
    Field Invoices                  /field-invoices      (Unposted/Posted/Unbilled tiles inside)
    Record Book (Applications)      /application-records
    Program Tracker                 /program-tracker
    Blend Recipes                   /recipes
    Field View (phone preview)      /field

CUSTOMERS & FIELDS — shared masters
    Customers                       /customers
    Fields & Maps                   /fields
    Crop Programs                   /crop-programs

INVENTORY & BUYING — shared back office
    Inventory                       /inventory
    Products                        /products
    Brand vs Generic                /brand-vs-generic
    Purchase Orders                 /purchase-orders
    Receiving (Hub)                 /receiving-hub
    Receiving Log                   /receiving
    Cycle Counts                    /cycle-counts        (admin)

MONEY — accounting
    Record Payments                 /payments            (admin + sales)
    A/R Workspace                   /accounts-receivable (admin — tabs: Aging · Payment History · Prepayments · Ledger)
    Prepay Workspace                /prepay-workspace    (admin)
    A/P & Vendor Bills              /accounts-payable    (admin)
    Unposted Invoice Summary        /field-invoices/summary (admin + sales — cross-channel)
    Commissions                     /commission-payments (admin)
    Rebates                         /rebates             (admin)
    Month-End Close                 /month-end           (admin)
    Data Integrity — Report         /integrity-report    (admin)
    Data Integrity — Cleanup        /integrity-cleanup   (admin)

COMPLIANCE & RECORDS — rare but must-find
    Licenses & RUP Register         /compliance
    Lot Trace (recall lookup)       /lot-trace
    Watchdog Flags                  /watchdog
    Label Review                    /label-review        (admin)
    Blend Tickets (OCR)             /blend-tickets       ← deliberately off the daily path

INSIGHTS — analytics
    Overview (KPI Dashboard)        /
    Reports Library                 /reports
    Sales Reports                   /sales-reports
    Financial Dashboard             /financial-dashboard (admin)

SETUP & ADMIN
    Vehicles                        /vehicles            (admin)
    Application Services (fees)     /application-services (admin)
    Vendors                         /vendors             (admin)
    Getting Started (help)          /getting-started
    Settings                        /settings            (admin)

▸ Team Board                        /team-board          (all roles)
🔔 bell in top bar                  /notifications       ("View all")
```

### APPLICATOR menu (phone) — only their world

```
My Day                              /field               ← their landing
My Jobs                             /jobs                (RLS already scopes data)
Record Book                         /application-records
Team Board                          /team-board
Help                                /getting-started
🔔 bell                             /notifications
```
`/dispatch` stays route-permitted for applicators (no regression) but leaves their menu — "My Day" is their screen; the Dispatch Board is the office's.

### DRIVER menu

```
My Route                            /my-route            ← their landing
Deliveries                          /deliveries          (office keys them in here too — both paths stay fast)
Team Board                          /team-board
Help                                /getting-started
```

---

### Owner's daily scenarios — click counts (desktop accordion: group = 1 click, item = 2; standalone = 1)

| Scenario | Path | Clicks |
|---|---|---|
| Phone quote / walk-in booking | **+ New → Quote/Booking** (anywhere) | **2** |
| Schedule / dispatch a spray job | Spray Fields → Job Schedule / Dispatch Board; or Today → jobs tile | **2** |
| Deliveries / load-out | **To-Ship** (standalone) | **1** |
| Complete a delivery (office keys it in) | Sell & Deliver → Deliveries | **2** |
| Record a check | Money → Record Payments | **2** |
| "What needs attention?" | **Today** (landing) | **0–1** |

---

### Complete old → new mapping (every route in App.tsx — NOTHING lost)

| Route | Old home | New home |
|---|---|---|
| `/` | Sidebar "Dashboard" (1st item, everyone's landing) | Insights → **Overview**; login redirect becomes role-based (office→/office-cockpit, applicator→/field, driver→/my-route) |
| `/office-cockpit` | Standalone "Office Cockpit" | Standalone **"Today"** — 1st item, office landing |
| `/to-ship` | Standalone "To-Ship" | Standalone **"To-Ship (Load-Out Board)"** — 2nd item |
| `/getting-started` | Standalone (4th slot) | Setup & Admin → Getting Started (help); stays in phone menus |
| `/quotes` | Sales → Quotes | Sell & Deliver → **Quotes & Bookings** |
| `/quotes/new` | Button on Quotes page | **+ New → Quote/Booking** (global) + button on Quotes |
| `/quotes/:id` | Row click on Quotes | unchanged (row click) |
| `/orders` | Sales → Orders | Sell & Deliver → Orders |
| `/orders/new` | Button on Orders page | + New → Order + button on Orders |
| `/orders/:id` | Row click | unchanged |
| `/deliveries` | Operations → Deliveries | Sell & Deliver → Deliveries (also driver menu) |
| `/deliveries/new` | Button on Deliveries | + New → Delivery + button on Deliveries |
| `/deliveries/:id` | Row click | unchanged |
| `/my-route` | Operations → My Route | Sell & Deliver → My Route; **driver landing** |
| `/my-route/:id` | Stop click on My Route | unchanged |
| `/delivery-remainders` | Operations → Remainders | Sell & Deliver → Remainders |
| `/invoices` | Sales → Invoices | Sell & Deliver → **Invoices — Chemical** |
| `/invoices/:id` | Row click | unchanged |
| `/invoices/field-app/new` | Buttons on Invoices/Field Invoices pages | + New → Field App Invoice + existing buttons |
| `/invoices/field-app/:id` | From field-invoice lists | unchanged |
| `/returns` | Products & Inventory → Returns | Sell & Deliver → Returns |
| `/payments` | Sales → Payments | Money → **Record Payments** (stays admin+sales — do NOT tighten; CLAUDE.md red line) |
| `/jobs` | Operations → Job Schedule | Spray Fields → Job Schedule (also applicator "My Jobs") |
| `/jobs/:id` | Row click | unchanged |
| `/dispatch` | Operations → "Dispatch & Applicator View" | Spray Fields → **Dispatch Board** (office label; leaves applicator menu, route still permitted) |
| `/field` | Operations → My Field Jobs | **Applicator landing "My Day"**; office: Spray Fields → Field View (phone preview) |
| `/field-invoices` | Sales → Field Invoices | Spray Fields → Field Invoices (landing keeps its tiles) |
| `/field-invoices/unposted` | Button on Field Invoices landing + Cockpit tile | unchanged (landing tile + Today tile) |
| `/field-invoices/posted` | Button on landing | unchanged |
| `/field-invoices/unbilled` | Button on landing + Cockpit tile | unchanged |
| `/field-invoices/summary` | Sales → "Customer Summary" | Money → **Unposted Invoice Summary** (cross-channel); button on landing stays |
| `/field-invoices/:id` | Row click | unchanged |
| `/application-records` | Operations → App Records | Spray Fields → **Record Book (Applications)**; applicator menu item |
| `/program-tracker` | Operations → Program Tracker | Spray Fields → Program Tracker |
| `/recipes` | Products & Inventory → Blend Recipes | Spray Fields → Blend Recipes (create-job-from-recipe lives with jobs) |
| `/blend-tickets` | Operations → Blend Tickets | Compliance & Records → **Blend Tickets (OCR)** — off the daily path per owner |
| `/blend-tickets/:id` | Row click | unchanged |
| `/customers` | Customers → Customers | Customers & Fields → Customers |
| `/customers/:id` | Row click | unchanged |
| `/fields` | Customers → Fields | Customers & Fields → **Fields & Maps** |
| `/fields/:id` | Row click | unchanged |
| `/fields/:id/dashboard` | Link on field | unchanged |
| `/crop-programs` | Customers → Crop Programs | Customers & Fields → Crop Programs |
| `/products` | Products & Inventory → Products | Inventory & Buying → Products |
| `/products/:id` | Row click | unchanged |
| `/brand-vs-generic` | Products & Inventory → Brand vs Generic | Inventory & Buying → Brand vs Generic |
| `/inventory` | Products & Inventory → Inventory | Inventory & Buying → Inventory |
| `/cycle-counts` | Products & Inventory → Cycle Counts | Inventory & Buying → Cycle Counts (admin) |
| `/purchase-orders` | Products & Inventory → Supplier POs | Inventory & Buying → **Purchase Orders** |
| `/purchase-orders/new` | Button on POs | + New → PO + button |
| `/purchase-orders/:id` | Row click | unchanged |
| `/receiving-hub` | Products & Inventory → Receiving Hub | Inventory & Buying → **Receiving (Hub)** — the daily one |
| `/receiving` | Products & Inventory → Receiving | Inventory & Buying → **Receiving Log** — renamed for clarity |
| `/receiving/quick` | Button on Receiving Log (ReceivingLog.tsx:336) + palette | unchanged + appears in + New menu |
| `/accounts-receivable` | Finance → Accounts Receivable | Money → **A/R Workspace** (admin) |
| `/ar-aging` | Finance → AR Aging (duplicate item) | Tab inside A/R Workspace (`?tab=aging`); route kept as deep-link; sidebar duplicate removed |
| `/payment-history` | **ORPHAN** (no nav; only a FinancialDashboard tile) | Tab inside A/R Workspace (`?tab=payments`, already wired — AccountsReceivable.tsx:117); added to command palette |
| `/prepayments` | Finance → Prepayments (duplicate item) | Tab inside A/R Workspace (`?tab=prepayments`); route kept as deep-link |
| `/customer-transactions` | Finance → Transactions (duplicate item) | Tab inside A/R Workspace (`?tab=ledger`); route kept as deep-link |
| `/prepay-workspace` | Finance → Prepay Workspace | Money → Prepay Workspace (admin) |
| `/accounts-payable` | Finance → Accounts Payable | Money → **A/P & Vendor Bills** (admin) |
| `/accounts-payable/bills` | Links inside AP dashboard | unchanged |
| `/accounts-payable/bills/new` | Button on Bills | unchanged |
| `/accounts-payable/bills/:id` | Row click | unchanged |
| `/commission-payments` | Finance → Commission Pay | Money → Commissions (admin) |
| `/rebates` | Finance → Rebates | Money → Rebates (admin) |
| `/month-end` | Finance → Month-End | Money → Month-End Close (admin) |
| `/integrity-report` | Finance → Integrity Report | Money → Data Integrity — Report (admin) |
| `/integrity-cleanup` | Finance → Integrity Cleanup | Money → Data Integrity — Cleanup (admin) |
| `/compliance` | Finance → Compliance | Compliance & Records → **Licenses & RUP Register** |
| `/lot-trace` | Finance → Lot Trace | Compliance & Records → Lot Trace (recall lookup) |
| `/label-review` | Finance → Label Review | Compliance & Records → Label Review (admin) |
| `/watchdog` | Finance → Watchdog Flags | Compliance & Records → Watchdog Flags (Today tile stays) |
| `/reports` | Finance → Reports | Insights → Reports Library |
| `/sales-reports` | Finance → Sales Reports | Insights → Sales Reports |
| `/financial-dashboard` | Finance → Dashboard | Insights → Financial Dashboard (admin) |
| `/vendors` | Finance → Vendors | Setup & Admin → Vendors (admin; cross-links from A/P and PO pages stay) |
| `/vehicles` | Operations → Vehicles | Setup & Admin → Vehicles (admin) |
| `/vehicles/:id` | Row click | unchanged |
| `/application-services` | Operations → App Services | Setup & Admin → **Application Services (fees)** (admin) |
| `/application-services/:id` | Row click | unchanged |
| `/settings` | Standalone Settings | Setup & Admin → Settings (admin) |
| `/team-board` | Standalone Team Board | Standalone Team Board (bottom, all roles) |
| `/notifications` | Bell in top bar → "View all" | unchanged (bell); added to command palette |
| `/login`, `/forgot-password`, `/reset-password` | Auth pages, no nav | unchanged |
| `/design-preview` | Dev/preview only, hostname-gated | unchanged |
| `*` (unknown URL) | Redirect to `/` | Redirect to role landing |

**Coverage check:** every one of the 82 routes in src/App.tsx:186-293 appears above — 0 routes lost, 0 URLs changed. The only new construct is the "+ New" top-bar menu; the removals are the 3 duplicate A/R sidebar entries (routes stay live as deep-links into the workspace tabs).

Companion changes so the menu stays truthful: update `PAGE_PERMISSIONS` categories in src/lib/pagePermissions.ts to the new group names (the Settings deny-list screen then mirrors the menu), and regenerate the command-palette page list from it.

### Rationale (5 lines)

1. **The menu now matches how the business thinks:** two selling channels (Sell & Deliver vs Spray Fields) with the shared back office behind them — a phone call, a truck, or a sprayer each has one obvious group.
2. **The two real daily surfaces get top billing:** Today (Office Cockpit) is the morning landing, To-Ship the shipping board — the owner's three highest-volume tasks are 0–2 clicks, everything else ≤2.
3. **Finance's 19-item junk drawer becomes three honest groups** — Money (accounting), Compliance & Records, Insights — so licenses and recalls stop hiding behind a dollar sign, and rarely-used blend-ticket OCR moves off the daily path without losing its page.
4. **Each role sees only its world:** applicators land on My Day with a 5-item phone menu, drivers on My Route, and the deny-list screen finally uses the same categories as the sidebar.
5. **Zero risk of loss:** all 82 routes keep working URLs and a documented home (the previously orphaned /payment-history gains one), so this is a sidebar/labels/redirect refactor — no database, money, or lifecycle changes.