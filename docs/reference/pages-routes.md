# Pages & Routes Reference (80 pages, 95 routes)

> Rebuilt 2026-09-26 from the `src/App.tsx` router. The page count is the number of `lazy(` imports in `src/App.tsx` (it includes the `JobDetailRoute` wrapper and the dev-only `DesignPreview`). The route count is the number of rows in this table, which lists every router path except `login`, `forgot-password`, `reset-password`, and the `*` catch-all. `npm run check:docs` (`scripts/check-doc-drift.mjs`) compares the page count with `src/App.tsx`, but compares the route count only with this table's own rows: nothing checks that each row matches a real route, so rebuild the table from `src/App.tsx` whenever routes change. Redirect rows are routes kept for old bookmarks and render no page of their own. Role gates come from `ProtectedRoute allowedRoles` in `src/App.tsx` and the page registry in `src/lib/pagePermissions.ts`.

| Route | Page | Description |
|-------|------|-------------|
| `/` | RoleLanding (redirect) | Role-based landing with no page of its own (`src/components/auth/RoleLanding.tsx`): drivers go to `/my-route`, applicators to `/field`, admin/sales to `/office-cockpit` (Today); anyone denied their landing page falls back to `/team-board` |
| `/dashboard` | Dashboard | KPI overview ("Overview (KPI Dashboard)" in the page registry, admin/sales_rep): KPIs, today's jobs, recent activity |
| `/getting-started` | GettingStarted | Role-aware workflow guide (admin/sales: Quote→Order→Deliver stepper; driver: Dashboard→Deliver stepper) |
| `/products` | Products | Product catalog with search/filter, bulk import |
| `/supplier-pricing` | SupplierPricing | Admin-only supplier-evidence workspace (locked down 2026-07-20, migration 20260720203000): protected per-supplier .xlsx quote sheets, manual staging and approval, comparable-cost review, Product/supplier links, and reviewed vendor aliases. Optional source PDFs are retained for audit and are never parsed. |
| `/products/:id` | ProductDetail | Product CRUD (pricing tiers, EPA info, RUP status). Combobox dropdowns for Vendor/Manufacturer/Category. Grouped sections: Product Form → Container (size+unit+type) → Inventory Unit → Application Rates |
| `/customers` | Customers | Customer list with search/filter, bulk import |
| `/customers/:id` | CustomerDetail | Profile, addresses, credit limit, transaction review, finance charge settings, season summary |
| `/call-lists` | CallLists | **CRM** seasonal call worklists — prepay prospects, no-recent-contact, stale quotes, lapsed products, unassigned accounts (admin-only list); per-row call-prep peek + log-call. Roles: admin/sales_rep. Added 2026-07-16 (CRM Phase 3) |
| `/quotes` | Quotes | Quote list with status filters |
| `/quotes/new` | QuoteBuilder | Multi-line quote with tiered pricing, commission splits, PDF, auto-emails PDF to customer on send |
| `/quotes/:id` | QuoteBuilder | Edit existing quote |
| `/orders` | Orders | Order list with status badges |
| `/orders/new` | NewOrder | Direct order creation (bypasses quote) |
| `/orders/:id` | OrderDetail | Order detail with status transitions, convert to invoice, auto-emails customer on order confirmed |
| `/inventory` | InventoryPage | Inventory levels, vendor-grouped reorder alerts, transaction ledger, batch adjust, cost valuation columns |
| `/deliveries` | Deliveries | Delivery management + driver dashboard + batch actions + quick delivery + load sheet PDF. Roles: admin/sales_rep/driver |
| `/deliveries/new` | NewDelivery | Create delivery from order |
| `/deliveries/:id` | DeliveryDetail | Full lifecycle: confirm, edit, cancel, photos, issues, remainders, order context, auto-emails customer on completion. Roles: admin/sales_rep/driver |
| `/delivery-remainders` | DeliveryRemainders | Pending remainder items across all customers |
| `/my-route` | FieldRoute | **Field Mode** driver/applicator workspace — today's route of stops (deliveries + jobs) in a task-first mobile flow. Roles: admin/sales_rep/driver. Added 2026-06-14 (PR #80/#81) |
| `/my-route/:id` | FieldStop | **Field Mode** single route-stop detail — complete a delivery or job from the field (signature, photos, quantities). Roles: admin/sales_rep/driver |
| `/blend-tickets` | BlendTickets | OCR ticket processing with image upload |
| `/blend-tickets/:id` | BlendTicketDetail | Ticket review, approve/reject, create application record |
| `/purchase-orders` | PurchaseOrders | PO list with status filters |
| `/purchase-orders/new` | NewPurchaseOrder | Create PO from vendor catalog |
| `/purchase-orders/:id` | PurchaseOrderDetail | PO detail with two-step receive modal + receiving history |
| `/receiving` | Receiving | Admin/sales. One inbound-inventory page with three tabs (`?tab=hub`, `quick`, `log`): **Hub** (`ReceivingHubPanel`: open PO lines grouped by product across vendors, a commitment snapshot from `get_inventory_position`, inline full-receipt Receive via `receive_po_items`), **Quick Receive** (`QuickReceivePanel`: 3-step wizard, vendor+products -> auto-match to oldest open POs -> confirm), **Log** (`ReceivingLogPanel`: summary cards, filters, searchable receiving log) |
| `/receiving/quick` | Redirect -> `/receiving?tab=quick` | Admin/sales. Old bookmark; the Quick Receive wizard is now a tab of `/receiving` |
| `/jobs` | Jobs | Job list with date/status/customer filters |
| `/jobs/:id` | JobDetailRoute -> JobDetail | Roles: admin/sales_rep/applicator. The `JobDetailRoute` wrapper keys `JobDetail` by job id so switching jobs remounts the page. Full job editor: fields on map, chemicals, vehicle/applicator, complete, transfer to invoice |
| `/vehicles` | Vehicles | Admin-only. Vehicle CRUD (ground/air), capacity, registration |
| `/vehicles/:id` | VehicleDetail | Admin-only. Single vehicle edit form |
| `/application-records` | ApplicationRecords | Read-only list of all chemical applications (from jobs + blend tickets). Roles: admin/sales_rep/applicator |
| `/invoices` | Invoices | Invoice list (unposted/posted), batch print, batch void, quick delivery filter |
| `/invoices/:id` | InvoiceDetail | Invoice detail, post/unpost, print PDF, write-off |
| `/payments` | PaymentAllocation | Unified payment entry — allocate checks to invoices, remainder becomes prepay |
| `/ar-aging` | ARaging | Admin-only. AR aging report, generate finance charges, Send AR Reminders (admin), Email Batch Statements (PDF attachment) |
| `/month-end` | MonthEndClose | Admin-only. Period status, checklist, batch statements, "Roll the Month" |
| `/commission-payments` | CommissionPayments | Admin-only. Create from unpaid commissions, post workflow |
| `/customer-transactions` | CustomerTransactionReview | Admin-only. Per-customer transaction history with running balance |
| `/prepay` | Prepay | Admin-only. One prepay page with two tabs (`?tab=workspace`, `manager`): **Workspace** (`PrepayWorkspacePanel`: split-panel allocator, left = prepay buckets by check #, right = unpaid invoices; two-phase commit via `batch_apply_prepayments()`) and **Manager** (`PrepaymentManagerPanel`: prepay balances, Split Check entry (bucket-labeled), auto-apply or allocate to the workspace) |
| `/prepayments` | Redirect -> `/prepay` (Manager tab) | Admin-only. Old bookmark (`LegacyTabRedirect`) |
| `/prepay-workspace` | Redirect -> `/prepay` (Workspace tab) | Admin-only. Old bookmark (`LegacyTabRedirect`) |
| `/financial-dashboard` | FinancialDashboard | Admin-only. Financial KPIs: AR aging, revenue, payments, prepay balances, finance charges. Powered by `financial_dashboard_summary()` RPC |
| `/payment-history` | PaymentHistory | Admin-only. Full payment history with per-invoice allocation breakdown |
| `/accounts-payable` | AccountsPayable | Admin-only. AP Dashboard: total owed, due this week/month, overdue, aging buckets, vendor breakdown |
| `/accounts-payable/bills` | VendorBills | Admin-only. Vendor bill list with status filtering (unpaid/partially paid/paid/overdue), search |
| `/accounts-payable/bills/new` | NewVendorBill | Admin-only. Create vendor bill (manual or linked to PO), auto-calculate due date from payment terms |
| `/accounts-payable/bills/:id` | VendorBillDetail | Admin-only. Bill detail, payment history, record payment, void bill |
| `/vendors` | Vendors | Admin-only. Vendor master-data CRUD (name, contact, payment terms). Save/delete via `save_vendor` / `delete_vendor` RPCs. Added 2026-05-10 in AP polish bundle (PR #59). |
| `/sales-reports` | SalesReports | Comprehensive sales & chemical history. 5 tabs (Detail, By Product, By Customer, By Month, By Sales Rep), 6 filters, multi-customer select with farm group support, Customer View toggle (hides cost/margin), CSV/PDF export |
| `/reports` | Reports | 14 reports: 4 logbook, 6 financial, 4 operational. CSV/PDF export. |
| `/fields` | Fields | Field list with Mapbox map view + bulk import (shapefile/KML/GeoJSON) |
| `/field-profitability` | FieldProfitability | Field-level profitability report (X4/E4/T10): margin per acre by field/customer/season from posted field-app invoices via read-only RPC `get_field_profitability`; "(unassigned field)" bucket for job-transferred invoices without location rows. Roles: admin/sales_rep. Added 2026-07-21 |
| `/fields/:id` | FieldSetup | Field CRUD with two-panel layout and satellite map with polygon drawing |
| `/recipes` | BlendRecipes | Reusable blend recipe management, create job from recipe |
| `/cycle-counts` | CycleCounts | Admin-only. Inventory cycle counting with variance tracking |
| `/returns` | Returns | Returns/RMA workflow (request -> approve -> receive -> credit) |
| `/brand-vs-generic` | BrandVsGeneric | Ingredient mapping: branded vs generic |
| `/crop-programs` | CropPrograms | Seasonal crop program management |
| `/compliance` | Compliance | Applicator license tracking, RUP product list, RUP Sales Register (auto-generated from invoices, filterable, CSV export) |
| `/lot-trace` | LotTrace | **B1 Lot Capture & Trace** — recall/compliance lookup: enter a lot number → every application that used it (product, field(s), date, customer, applicator, record #, invoice, source). Admin/sales. The `get_lot_application_trace` RPC is live (B1 migration `20260622170000`, applied 2026-06-23). |
| `/rebates` | Rebates | Admin-only. Manufacturer rebate programs and claim management |
| `/team-board` | TeamBoard | Team communication hub: notes/todos/announcements with entity linking (delivery, order, customer, job, PO, quote), today's deliveries bulletin (role-aware), yesterday's recap, photo attachments, comments, activity log, search/filter, real-time. Sub-components live in `src/components/team/`. All authenticated roles |
| `/notifications` | Notifications | User notification center. All authenticated roles |
| `/settings` | SettingsPage | Admin only: company settings, user management |
| `/dispatch` | DispatchBoard | Map-based dispatch view for job scheduling with applicator assignment. Roles: admin/sales_rep/applicator |
| `/fields/:id/dashboard` | FieldDashboard | Read-only field profile: overview (season stats, activity), applications (history table with weather), billing (splits visualization), details (FSA, legal desc, notes) |
| `/application-services` | ApplicationServices | Admin: CRUD for application service pricing (vehicle-linked fees like Hagie Y-Drop, Rogator, etc.) |
| `/application-services/:id` | ApplicationServiceDetail | Admin: Create/edit service with customer rate overrides |
| `/program-tracker` | ProgramTracker | Program completion dashboard: planned vs actual acres per customer per season with progress bars |
| `/invoices/field-app/new` | FieldApplicationInvoice | New field application invoice with multi-location select, auto-figuring chemicals and customer shares |
| `/invoices/field-app/:id` | FieldApplicationInvoice | Edit existing field application invoice |
| `/integrity` | Integrity | Admin-only. One data-integrity page with two tabs (`?tab=report`, `cleanup`); each tab is described in its redirect row below |
| `/integrity-report` | Redirect -> `/integrity` (Report tab) | Admin-only. Old bookmark (`LegacyTabRedirect`). The **Report** tab (`IntegrityReportPanel`) is a read-only data integrity dashboard. It runs `runReconciliationChecks()` from `src/lib/reconciliation.ts` and shows pass/fail per check (order totals, inventory ledger, invoice payments via invoice_line_allocations, balance formula, commission splits, quote hold parity, delivery-invoice parity, prebooked inventory, return credit linkage, customer AR consistency). Discrepancy table per failed check with re-run button. Sprint F #4. |
| `/integrity-cleanup` | Redirect -> `/integrity` (Cleanup tab) | Admin-only. Old bookmark (`LegacyTabRedirect`). The **Cleanup** tab (`IntegrityCleanupPanel`) is action-driven cleanup tooling for the three production-data issue classes flagged by the deep audit: (1) negative inventory rows — per-row reset form calling `reconcile_negative_inventory` RPC with mandatory reason; (2) over-received PO items — read-only listing for review; (3) completed deliveries without invoices — per-row "Create draft invoice" button calling `create_invoice_for_unbilled_delivery` RPC. Sprint G3 + G4 (Phase 22). |
| `/to-ship` | ToShip | Admin/sales. Operations command center: To-Ship by Product/Customer + Low-Stock/reorder + Deliveries (overdue/unassigned) + Inbound POs, all from frontend queries. Schedule/Reorder act-buttons deep-link into the trusted create flows. (UI overhaul v1) |
| `/receiving-hub` | Redirect -> `/receiving?tab=hub` | Admin/sales. Old bookmark; the Receiving Hub (open PO lines by product with ordered/received/remaining + arrival, and the On Floor/Hold/Order/Spoken-For/Net commitment snapshot) is now the Hub tab of `/receiving` |
| `/accounts-receivable` | AccountsReceivable | **Admin-only.** One AR workspace: tabs for Aging / Payment History / Prepayments / Customer Ledger + a Net Money Position card (total owed via `get_ar_aging` minus unused `prepay_credits`). `/payments` (PaymentAllocation) stays SEPARATE (admin+sales). (UI overhaul v2) |
| `/field-invoices` | FieldInvoices | Admin/sales. Field-application invoices area (as-applied billing) with five tabs (`?tab=`): **Unbilled** (`unbilled`: applied-but-unbilled field work awaiting an invoice), **Drafts** (`drafts`: unposted field invoices), **Posted** (`posted`), **By Customer** (`customer`: combined Customer Invoice Summary of unposted chem sales + unposted field-app), **All Invoices** (`all`: the original all-status list with CSV/report actions) |
| `/field-invoices/:id` | InvoiceDetail (`routeArea="field"`) | Admin/sales. Field-invoice detail: the generic invoice editor under the field-invoices permission (job-built quantity invoices and posted field invoices) |
| `/split-billing/new` | FieldAppSplitInvoiceEditor | Per-line split-billing editor (flag-gated: per_line_split_billing_enabled; renders a not-enabled notice when OFF). Roles: admin/sales_rep. Added 2026-07-20 (inherited from main merge) |
| `/split-billing/:id` | FieldAppSplitInvoiceEditor | Edit an existing per-line split-billing set (same flag gate) |
| `/field-invoices/unposted` | Redirect -> `/field-invoices?tab=drafts` | Admin/sales. Old bookmark |
| `/field-invoices/posted` | Redirect -> `/field-invoices?tab=posted` | Admin/sales. Old bookmark |
| `/field-invoices/summary` | Redirect -> `/field-invoices?tab=customer` | Admin/sales. Old bookmark |
| `/field-invoices/unbilled` | Redirect -> `/field-invoices?tab=unbilled` | Admin/sales. Old bookmark |
| `/office-cockpit` | OfficeCockpit | Admin/sales. §3 Beyond-Parity exception dashboard: 7 live tiles (unbilled jobs, ready-to-post field-app invoices, watchdog flags, upcoming jobs 7-day, expiring licenses/certs 30-day, overdue field-app AR, deferred inventory shortfalls). One screen replaces the run-seven-reports ritual. |
| `/watchdog` | WatchdogExceptions | Admin/sales. Standing list of active (non-dismissed) watchdog flags across jobs/invoices, grouped by type, with a one-tap dismiss and a "Refresh flags" button that re-runs the server-side detection sweep. Advisory only |
| `/label-review` | LabelReview | Admin-only. Label-data backfill review queue: create label drafts, accept/edit/reject each per product, and view a label coverage report. Nothing is applied to a product without an explicit accept/edit |
| `/label-data-quality` | LabelDataQuality | Admin-only. In-app EPA registration-number check with inline fixes, plus bulk EPA signal-word apply (shipped 2026-07-10) |
| `/offline-work-review` | OfflineWorkReview | Admin/sales audited queue for resolving permanent offline delivery/job receipts without rerunning or deleting business work. |
| `/field` | FieldView | Admin/sales/applicator. Field-app parity #38 — phone/mobile applicator field view (read-only "my jobs" cards). |
| `/design-preview` | DesignPreview | **Dev/preview only** (hostname-gated, never on croprxsolutions.app): shared-component visual gallery for the design system. |
