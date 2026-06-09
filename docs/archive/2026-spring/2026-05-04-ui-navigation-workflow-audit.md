# CRX Manager UI and Navigation Workflow Audit

Date: 2026-05-04  
Scope: Read-only UI/navigation review plus this planning document. No app code was changed.

## Plain-English Summary

CRX Manager has the right core screens, but too much of the user's real work is spread across separate pages. The app already knows how records connect, especially quote -> order -> delivery -> invoice, but that connection is mostly shown as small links after the user has opened a record. The next UI improvement should turn those links into a more obvious workflow guide: show where the user is, what is already done, what still needs to happen, and the next best button.

The biggest opportunity is not a new visual theme. It is reducing page hopping. The app should feel more like a set of workspaces:

- Customer workspace: customer, fields, quotes, orders, deliveries, invoices, payments, and history in one place.
- Sales/order workspace: quote -> order -> delivery -> invoice -> payment without losing context.
- Application workspace: field application invoice, jobs, dispatch, blend tickets, sprayer map/print packet, and application records tied together.
- Finance workspace: posted/unposted invoices, AR, payments, prepay, statements, and customer balance review connected from one flow.

## Evidence Reviewed

- `AGENTS.md`
- `CLAUDE.md`
- `docs/workflows/SAFE_DEVELOPMENT_RULES.md`
- `docs/workflows/UI_PATTERNS.md`
- `docs/reference/pages-routes.md`
- `src/App.tsx`
- `src/components/layout/AppLayout.tsx`
- `src/components/layout/Sidebar.tsx`
- `src/components/layout/TopBar.tsx`
- `src/components/ui/CommandPalette.tsx`
- `src/components/ui/TransactionThread.tsx`
- Key pages in `src/pages/`, especially customer, quote, order, delivery, invoice, payment, field, job, dispatch, and blend-ticket screens.

## What Is Already Working

The app already has useful building blocks:

- Route coverage is broad: `docs/reference/pages-routes.md:1` lists 65 routes.
- Pages are lazy-loaded in one place, which keeps routing consistent: `src/App.tsx:15`.
- The sidebar already groups pages by business area: `src/components/layout/Sidebar.tsx:79`.
- A command palette exists and can search pages plus some records: `src/components/ui/CommandPalette.tsx:128` and `src/components/ui/CommandPalette.tsx:229`.
- Important detail pages already use breadcrumbs: examples include `src/pages/QuoteBuilder.tsx:1345`, `src/pages/OrderDetail.tsx:762`, `src/pages/DeliveryDetail.tsx:1426`, and `src/pages/InvoiceDetail.tsx:700`.
- A transaction thread already links quote, order, delivery, and invoice records: `src/components/ui/TransactionThread.tsx:117`.
- The dashboard already has useful action sections: quick actions at `src/pages/Dashboard.tsx:533`, delivery command center at `src/pages/Dashboard.tsx:798`, and action queue at `src/pages/Dashboard.tsx:944`.

## Main Findings

### 1. The sidebar shows too many destinations, not enough workflows

**Evidence**

- The sidebar is a long static navigation structure: `src/components/layout/Sidebar.tsx:79`.
- Sales alone exposes Quotes, Orders, Invoices, and Payments as separate destinations: `src/components/layout/Sidebar.tsx:99`.
- Operations exposes Jobs, Dispatch, Deliveries, Remainders, Vehicles, App Services, Blend Tickets, App Records, and Program Tracker together: `src/components/layout/Sidebar.tsx:143`.
- Finance exposes 14 links in one group: `src/components/layout/Sidebar.tsx:162`.
- The standalone dashboard is labeled "Operations", while another category is also labeled "Operations": `src/components/layout/Sidebar.tsx:83` and `src/components/layout/Sidebar.tsx:146`.

**Plain-English problem**

The sidebar is organized like a file cabinet. Real users think in jobs: sell it, deliver it, apply it, bill it, collect it. The current structure makes users choose the right page before the app helps them do the job.

**Recommended user flow**

Keep the pages, but add a top-level "Workflows" or "Workspaces" layer:

- Sales Desk: quotes, orders, delivery status, invoice status, payment status.
- Dispatch Desk: jobs, deliveries, applicator/driver assignment, maps.
- Field Application Desk: field invoice, selected fields, chemicals, customer split, print packet.
- Finance Desk: invoices needing action, AR, payments, prepay, statements.

Also rename the dashboard link from "Operations" to "Dashboard" so it does not compete with the Operations section.

### 2. The global search/command palette is hidden and incomplete

**Evidence**

- `Ctrl+K` opens the command palette, but the visible top bar only shows the mobile menu, page title, and notifications: `src/components/layout/AppLayout.tsx:23` and `src/components/layout/TopBar.tsx:15`.
- The command palette page list is manually maintained: `src/components/ui/CommandPalette.tsx:128`.
- It searches only five entity types: customer, order, invoice, delivery, product: `src/components/ui/CommandPalette.tsx:62`.
- Several real routes are missing from the command palette page list, including application services, field application invoice creation, integrity pages, payment history, program tracker, and vendor bill pages. The relevant app routes are in `src/App.tsx:181`, `src/App.tsx:205`, `src/App.tsx:222`, `src/App.tsx:224`, `src/App.tsx:225`, and `src/App.tsx:231`.

**Plain-English problem**

The app already has a good shortcut system, but users may not know it exists. Even when they use it, it cannot reach several newer pages or search important work like quotes, jobs, fields, blend tickets, payments, or application records.

**Recommended user flow**

Add a visible search button in the top bar: "Search or jump to..." Then expand command palette coverage so Mason or staff can type things like "field app", "program tracker", "job 1024", "blend ticket", "payment", or "customer balance" and jump straight there.

### 3. Page titles are sometimes generic or wrong

**Evidence**

- Page titles come from a hard-coded base-path map: `src/hooks/usePageMeta.ts:3`.
- The hook only looks at the first path segment: `src/hooks/usePageMeta.ts:46`.
- Several current routes have no matching title entry, including dispatch, application services, program tracker, prepay workspace, integrity report, integrity cleanup, and getting started.
- Nested routes can get misleading titles. For example, `/invoices/field-app/new` is routed at `src/App.tsx:181`, but the title hook sees only `/invoices` and returns "Invoice Management" from `src/hooks/usePageMeta.ts:10`.

**Plain-English problem**

The top of the app sometimes tells the user the wrong room they are in. That makes a big app feel more confusing than it needs to.

**Recommended user flow**

Make page titles route-aware. A field application invoice should say "Field Application Invoice", dispatch should say "Dispatch Board", and program tracker should say "Program Tracker". This is a small, low-risk fix.

### 4. The quote -> order -> delivery -> invoice thread is helpful, but it is passive

**Evidence**

- The transaction thread shows quote, order, deliveries, and invoices: `src/components/ui/TransactionThread.tsx:117`.
- Missing steps render as labels like "No deliveries" and "No invoices": `src/components/ui/TransactionThread.tsx:190` and `src/components/ui/TransactionThread.tsx:221`.
- Order detail has next-step buttons for "Create Invoice" and "Schedule Delivery": `src/pages/OrderDetail.tsx:800`.
- Quote detail has "Convert to Order": `src/pages/QuoteBuilder.tsx:1449`.
- Delivery detail has the transaction thread, but completion/next billing action is handled elsewhere in the page: `src/pages/DeliveryDetail.tsx:1431`.

**Plain-English problem**

The app shows related records, but it does not consistently answer the user's most important question: "What do I do next?"

**Recommended user flow**

Upgrade the transaction thread into a workflow header:

- Show completed steps, current step, and missing step.
- When a step is missing, show an action button instead of only "No invoices" or "No deliveries".
- Examples:
  - Quote sent -> "Convert to Order"
  - Order confirmed -> "Schedule Delivery" and "Create Draft Invoice"
  - Delivery completed -> "Review Invoice"
  - Posted invoice with balance -> "Record Payment"

### 5. Payment entry loses context from some pages

**Evidence**

- Order detail shows a "Record Payment" button, but it navigates to `/payments` without customer or invoice context: `src/pages/OrderDetail.tsx:977`.
- Payment entry then requires the user to search/select the customer again: `src/pages/PaymentAllocation.tsx:80` and `src/pages/PaymentAllocation.tsx:104`.
- Invoice detail has a direct "Record Payment" modal for posted invoices: `src/pages/InvoiceDetail.tsx:773`.

**Plain-English problem**

If a user is already looking at a customer/order/invoice, the app should not make them search for the same customer again.

**Recommended user flow**

Let `/payments` accept context in the URL, such as customer ID and invoice ID, and prefill the payment screen. Also consider using the same payment modal pattern from invoice detail wherever the user is paying a known invoice.

### 6. Invoices are source-based, but the invoice list does not fully guide users to the right source

**Evidence**

- The invoice list has a button for "New Field Application": `src/pages/Invoices.tsx:583`.
- The old standalone "New Invoice" path was intentionally removed, and the code comment says invoices must come from an order or blend ticket: `src/pages/Invoices.tsx:586`.
- Empty invoice state sends users to Orders: `src/pages/Invoices.tsx:638`.
- Blend ticket detail can create a direct invoice from an approved blend ticket: `src/pages/BlendTicketDetail.tsx:1418`.

**Plain-English problem**

The rule is correct: invoices should come from real work. But the UI makes the user already know whether to go to Orders, Blend Tickets, or Field Application first.

**Recommended user flow**

Replace "New Field Application" as the only create option with a guided "Create Invoice From..." menu:

- Order
- Blend Ticket
- Field Application

That keeps the accounting rule intact while making the starting point obvious.

### 7. Customer detail has too many tabs for a daily customer workflow

**Evidence**

- Customer detail stores eight tabs: info, timeline, fields, quotes, orders, deliveries, financials, history: `src/pages/CustomerDetail.tsx:78` and `src/pages/CustomerDetail.tsx:467`.
- Quick actions are available, but they only cover task, quote, order, delivery, and summary: `src/pages/CustomerDetail.tsx:500`.
- Each customer workflow section is mostly separated into its own tab/table: fields at `src/pages/CustomerDetail.tsx:807`, quotes at `src/pages/CustomerDetail.tsx:895`, orders at `src/pages/CustomerDetail.tsx:998`, deliveries at `src/pages/CustomerDetail.tsx:1064`, financials at `src/pages/CustomerDetail.tsx:1195`, and history at `src/pages/CustomerDetail.tsx:1352`.

**Plain-English problem**

A customer screen should answer: "What is happening with this customer right now?" The current tabs make users click around to build that picture themselves.

**Recommended user flow**

Create a Customer 360 overview at the top:

- Open quotes
- Active orders
- Scheduled/in-progress deliveries
- Unposted/posted invoices
- Balance due
- Prepay balance
- Fields needing attention
- One row of next-best actions

Keep the tabs for detail, but make the overview powerful enough that users do not have to visit every tab.

### 8. Field application work is split between field app invoice, jobs, dispatch, blend tickets, maps, and records

**Evidence**

- Field application invoice has four tabs: Locations, Chemicals, Customers, Applied Info: `src/pages/FieldApplicationInvoice.tsx:53`.
- It has a print button stub with a TODO: `src/pages/FieldApplicationInvoice.tsx:521`.
- It uses a map/table field picker through `SelectLocationsModal`: `src/pages/FieldApplicationInvoice.tsx:640` and `src/components/field-app/SelectLocationsModal.tsx:136`.
- Jobs have fields, chemicals, loader worksheet, applied info, and transfer-to-invoice actions: `src/pages/JobDetail.tsx:551`, `src/pages/JobDetail.tsx:712`, `src/pages/JobDetail.tsx:762`, and `src/pages/JobDetail.tsx:845`.
- Dispatch has a separate map-based job assignment screen: `src/pages/DispatchBoard.tsx:1` and `src/pages/DispatchBoard.tsx:256`.
- Blend tickets have products, application fields, order linkage, and direct invoice actions: `src/pages/BlendTicketDetail.tsx:1043`, `src/pages/BlendTicketDetail.tsx:1198`, `src/pages/BlendTicketDetail.tsx:1295`, and `src/pages/BlendTicketDetail.tsx:1418`.
- Blend ticket fields can still be text-based/manual: `src/pages/BlendTicketDetail.tsx:968`.

**Plain-English problem**

Field application is one real-world job, but the app treats pieces of it as separate rooms. This is likely where users feel the most tab-hopping.

**Recommended user flow**

Create an application workspace that connects these pieces:

- Select fields on a map.
- Enter/load chemicals.
- Show customer splits.
- Show job/dispatch status.
- Show linked blend ticket.
- Preview and print the applicator/sprayer packet.
- Create/post invoices from the same workspace when ready.

Do not rebuild the map from scratch. Reuse `CRXMap`, `FieldBoundaryLayer`, `SelectLocationsModal`, and the current field application invoice pieces.

### 9. The field picker is strong on desktop but not mobile/tablet friendly

**Evidence**

- The location picker is a full-screen modal with a fixed left/right split: map at `w-1/2` and table at `w-1/2`: `src/components/field-app/SelectLocationsModal.tsx:136`, `src/components/field-app/SelectLocationsModal.tsx:139`, and `src/components/field-app/SelectLocationsModal.tsx:158`.
- The footer already summarizes selected locations and acres: `src/components/field-app/SelectLocationsModal.tsx:262`.

**Plain-English problem**

This is good for a wide office monitor, but a tablet user in the field may need a stacked or toggleable map/list layout.

**Recommended user flow**

On mobile/tablet, use a segmented control:

- Map
- List
- Selected

Keep the selected acres footer sticky so the applicator or office user always knows what has been chosen.

### 10. Dashboard quick actions are useful but not tuned to the highest-friction workflows

**Evidence**

- Dashboard quick actions include New Order, New PO, Schedule Delivery, Inventory, and Receiving: `src/pages/Dashboard.tsx:533`.
- It does not include New Quote, Field Application, Payment, Quick Receive, or Dispatch.
- The dashboard already has clickable KPI cards for quotes/orders/deliveries: `src/pages/Dashboard.tsx:591`.
- The action queue can surface overdue invoices, cancelled posted invoices, overdue deliveries, low stock, expiring quotes, and unassigned deliveries: `src/components/dashboard/ActionQueue.tsx:35`.

**Plain-English problem**

The dashboard is close to being the user's daily home base. It needs more role-based "start work" actions and better links from problem cards to the exact filtered work list.

**Recommended user flow**

Make dashboard quick actions role-aware:

- Sales/admin: New Quote, New Order, Field Application, Record Payment.
- Dispatch: Dispatch Board, Schedule Delivery, Load Sheet.
- Applicator: My Jobs, Field Application Map/Packet.
- Warehouse/receiving: Quick Receive, Purchase Orders, Inventory.

### 11. Tables and filter patterns are not fully consistent

**Evidence**

- The shared `DataTable` supports search, sorting, row click, filters, loading, and empty states: `src/components/ui/DataTable.tsx:13`.
- Many list pages use the shared table pattern.
- Some major pages still use custom table/selection patterns, including invoices and deliveries: `src/pages/Invoices.tsx:81`, `src/pages/Invoices.tsx:632`, `src/pages/Deliveries.tsx:109`, and `src/pages/Deliveries.tsx:1132`.
- Customer detail uses many custom tables inside tabs: `src/pages/CustomerDetail.tsx:846`, `src/pages/CustomerDetail.tsx:951`, `src/pages/CustomerDetail.tsx:1015`, `src/pages/CustomerDetail.tsx:1082`, and `src/pages/CustomerDetail.tsx:1291`.

**Plain-English problem**

Users have to relearn small differences from screen to screen: where filters are, how selection works, and where actions appear.

**Recommended user flow**

Standardize list/table behavior:

- Same filter layout.
- Same selected-row action bar.
- Same row action area.
- Same "clear filters" and saved filter patterns.
- Same mobile card fallback for dense tables.

### 12. Detail pages have actions, but actions compete with each other

**Evidence**

- Quote builder header can show many actions at once: save, customer view, PDF, template, rollover, preview, convert, revise, versions: `src/pages/QuoteBuilder.tsx:1390`.
- Order detail can show edit, create invoice, schedule delivery, print summary, print pick list, and create task: `src/pages/OrderDetail.tsx:790`.
- Invoice detail can show save, post, print, email, record payment, write off, and void: `src/pages/InvoiceDetail.tsx:740`.
- Field application invoice can show delete, print, post group, preview, and save: `src/pages/FieldApplicationInvoice.tsx:515`.

**Plain-English problem**

The app has the right buttons, but the most important next action is not always visually separated from secondary actions like export, print, or task creation.

**Recommended user flow**

Use a consistent action hierarchy:

- Primary next step: one green button.
- Secondary actions: small outlined buttons.
- More menu: print/export/template/history/destructive actions.
- Status-aware help text: one sentence explaining why the next step is or is not available.

## Recommended Phases

### Phase 1: Highest-impact, lowest-risk navigation improvements

This phase should improve flow without touching business rules or database behavior.

1. Rename the dashboard sidebar item from "Operations" to "Dashboard".
2. Add a visible top-bar search/command button that opens the existing command palette.
3. Add missing routes to the command palette and page-title map.
4. Add command palette search coverage for quotes, jobs, fields, blend tickets, application records, and payments if the existing `global_search` RPC supports or can safely be extended later.
5. Improve `TransactionThread` into a small workflow header with next-step prompts.
6. Preserve context when navigating to payment entry from order/customer/invoice screens.
7. Add a "Create Invoice From..." menu on the invoice list.
8. Make detail page action headers consistent: one primary next-step button, secondary actions grouped, print/export/history moved into a more menu where practical.

Likely files:

- `src/components/layout/Sidebar.tsx`
- `src/components/layout/TopBar.tsx`
- `src/components/layout/AppLayout.tsx`
- `src/components/ui/CommandPalette.tsx`
- `src/hooks/usePageMeta.ts`
- `src/components/ui/TransactionThread.tsx`
- `src/pages/Invoices.tsx`
- `src/pages/PaymentAllocation.tsx`
- `src/pages/OrderDetail.tsx`
- `src/pages/InvoiceDetail.tsx`
- `src/pages/QuoteBuilder.tsx`

Suggested checks after Phase 1:

- `npm run typecheck`
- `npm run build`
- Targeted tests for sidebar, command palette, transaction thread, and payment entry.

### Phase 2: Deeper workflow consolidation

This phase should reduce tab/page hopping in the heaviest workflows.

1. Build a stronger Customer 360 overview on `CustomerDetail`.
2. Add an Order Workspace pattern: order summary, delivery state, invoice state, payment state, and next action in one top panel.
3. Connect field application invoice, jobs, dispatch, blend tickets, and field dashboard into a unified application workspace.
4. Finish field application printing from the existing print infrastructure.
5. Make invoice creation source-aware without violating the rule that invoices must come from an order, blend ticket, or field application workflow.
6. Add saved filters or quick filters for common operational views, such as "needs invoice", "needs delivery", "posted with balance", "unassigned delivery", and "application needs print packet".

Likely files:

- `src/pages/CustomerDetail.tsx`
- `src/pages/OrderDetail.tsx`
- `src/pages/DeliveryDetail.tsx`
- `src/pages/InvoiceDetail.tsx`
- `src/pages/FieldApplicationInvoice.tsx`
- `src/pages/JobDetail.tsx`
- `src/pages/DispatchBoard.tsx`
- `src/pages/BlendTicketDetail.tsx`
- `src/pages/FieldDashboard.tsx`
- `src/components/field-app/SelectLocationsModal.tsx`
- `src/lib/invoicePdf.ts`

Suggested checks after Phase 2:

- `npm run typecheck`
- `npm run build`
- Relevant unit tests for changed pages/components.
- E2E smoke test for quote -> order -> delivery -> invoice -> payment.
- E2E smoke test for field application invoice and print/preview flow.

### Phase 3: Polish, mobile/tablet, and consistency

This phase should make the app feel smoother once the big workflow problems are addressed.

1. Make `SelectLocationsModal` responsive for tablet/mobile map work.
2. Add a mobile card layout for dense tables used in customer, field application, delivery, and payment screens.
3. Standardize filters, selected-row actions, and empty states across list pages.
4. Add role-based dashboard quick actions.
5. Make dispatch and field maps easier to use on smaller screens.
6. Review spacing, button hierarchy, and page headers across the biggest pages.

Likely files:

- `src/components/ui/DataTable.tsx`
- `src/components/ui/BulkActionBar.tsx`
- `src/components/field-app/SelectLocationsModal.tsx`
- `src/pages/Dashboard.tsx`
- `src/pages/Deliveries.tsx`
- `src/pages/Fields.tsx`
- `src/pages/FieldApplicationInvoice.tsx`
- `src/pages/PaymentAllocation.tsx`
- `src/pages/CustomerDetail.tsx`

Suggested checks after Phase 3:

- `npm run typecheck`
- `npm run build`
- Browser verification at desktop, tablet, and mobile widths.
- Targeted E2E checks for navigation/search, field selection, and payment entry.

## First Phase Recommendation

Start with Phase 1. It is the best first move because it improves navigation and user confidence without changing core business math, inventory rules, invoice posting, or database behavior.

The first implementation should be small and reviewable:

1. Visible top-bar search button.
2. Complete command palette/page title coverage.
3. Sidebar label cleanup.
4. Workflow header improvements.
5. Payment context preservation.
6. Invoice "Create From..." menu.

That phase should make the app feel more connected immediately, while leaving the larger customer/application workspace redesigns for separate approvals.
