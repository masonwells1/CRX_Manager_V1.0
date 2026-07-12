# Pages & Routes Reference (75 pages, 82 routes)

| Route | Page | Description |
|-------|------|-------------|
| `/` | Dashboard | KPIs, today's jobs, recent activity |
| `/getting-started` | GettingStarted | Role-aware workflow guide (admin/sales: Quote→Order→Deliver stepper; driver: Dashboard→Deliver stepper) |
| `/products` | Products | Product catalog with search/filter, bulk import |
| `/products/:id` | ProductDetail | Product CRUD (pricing tiers, EPA info, RUP status). Combobox dropdowns for Vendor/Manufacturer/Category. Grouped sections: Product Form → Container (size+unit+type) → Inventory Unit → Application Rates |
| `/customers` | Customers | Customer list with search/filter, bulk import |
| `/customers/:id` | CustomerDetail | Profile, addresses, credit limit, transaction review, finance charge settings, season summary |
| `/quotes` | Quotes | Quote list with status filters |
| `/quotes/new` | QuoteBuilder | Multi-line quote with tiered pricing, commission splits, PDF, auto-emails PDF to customer on send |
| `/quotes/:id` | QuoteBuilder | Edit existing quote |
| `/orders` | Orders | Order list with status badges |
| `/orders/new` | NewOrder | Direct order creation (bypasses quote) |
| `/orders/:id` | OrderDetail | Order detail with status transitions, convert to invoice, auto-emails customer on order confirmed |
| `/inventory` | InventoryPage | Inventory levels, vendor-grouped reorder alerts, transaction ledger, batch adjust, cost valuation columns |
| `/deliveries` | Deliveries | Delivery management + driver dashboard + batch actions + quick delivery + load sheet PDF (~900 lines) |
| `/deliveries/new` | NewDelivery | Create delivery from order |
| `/deliveries/:id` | DeliveryDetail | Full lifecycle: confirm, edit, cancel, photos, issues, remainders, order context, auto-emails customer on completion (~1350 lines) |
| `/delivery-remainders` | DeliveryRemainders | Pending remainder items across all customers |
| `/my-route` | FieldRoute | **Field Mode** driver/applicator workspace — today's route of stops (deliveries + jobs) in a task-first mobile flow. Roles: admin/sales_rep/driver. Added 2026-06-14 (PR #80/#81) |
| `/my-route/:id` | FieldStop | **Field Mode** single route-stop detail — complete a delivery or job from the field (signature, photos, quantities). Roles: admin/sales_rep/driver |
| `/blend-tickets` | BlendTickets | OCR ticket processing with image upload |
| `/blend-tickets/:id` | BlendTicketDetail | Ticket review, approve/reject, create application record |
| `/purchase-orders` | PurchaseOrders | PO list with status filters |
| `/purchase-orders/new` | NewPurchaseOrder | Create PO from vendor catalog |
| `/purchase-orders/:id` | PurchaseOrderDetail | PO detail with two-step receive modal + receiving history (~823 lines) |
| `/receiving` | ReceivingLog | Receiving dashboard with summary cards, filters, searchable log |
| `/receiving/quick` | QuickReceive | 3-step wizard: vendor+products -> auto-match to oldest open POs -> confirm |
| `/jobs` | Jobs | Job list with date/status/customer filters |
| `/jobs/:id` | JobDetail | Full job editor: fields on map, chemicals, vehicle/applicator, complete, transfer to invoice |
| `/vehicles` | Vehicles | Vehicle CRUD (ground/air), capacity, registration |
| `/vehicles/:id` | VehicleDetail | Single vehicle edit form |
| `/application-records` | ApplicationRecords | Read-only list of all chemical applications (from jobs + blend tickets) |
| `/invoices` | Invoices | Invoice list (unposted/posted), batch print, batch void, quick delivery filter |
| `/invoices/:id` | InvoiceDetail | Invoice detail, post/unpost, print PDF, write-off |
| `/payments` | PaymentAllocation | Unified payment entry — allocate checks to invoices, remainder becomes prepay |
| `/ar-aging` | ARaging | AR aging report, generate finance charges, Send AR Reminders (admin), Email Batch Statements (PDF attachment) |
| `/month-end` | MonthEndClose | Admin-only. Period status, checklist, batch statements, "Roll the Month" |
| `/commission-payments` | CommissionPayments | Admin-only. Create from unpaid commissions, post workflow |
| `/customer-transactions` | CustomerTransactionReview | Admin-only. Per-customer transaction history with running balance |
| `/prepayments` | PrepaymentManager | Admin-only. Prepay balances, Split Check entry (bucket-labeled), auto-apply or allocate to workspace |
| `/prepay-workspace` | PrepayWorkspace | Admin-only. Split-panel allocator: left=prepay buckets by check#, right=unpaid invoices. Two-phase commit via `batch_apply_prepayments()` |
| `/financial-dashboard` | FinancialDashboard | Admin-only. Financial KPIs: AR aging, revenue, payments, prepay balances, finance charges. Powered by `financial_dashboard_summary()` RPC |
| `/payment-history` | PaymentHistory | Full payment history with per-invoice allocation breakdown |
| `/accounts-payable` | AccountsPayable | Admin-only. AP Dashboard: total owed, due this week/month, overdue, aging buckets, vendor breakdown |
| `/accounts-payable/bills` | VendorBills | Admin-only. Vendor bill list with status filtering (unpaid/partially paid/paid/overdue), search |
| `/accounts-payable/bills/new` | NewVendorBill | Admin-only. Create vendor bill (manual or linked to PO), auto-calculate due date from payment terms |
| `/accounts-payable/bills/:id` | VendorBillDetail | Admin-only. Bill detail, payment history, record payment, void bill |
| `/vendors` | Vendors | Admin-only. Vendor master-data CRUD (name, contact, payment terms). Save/delete via `save_vendor` / `delete_vendor` RPCs. Added 2026-05-10 in AP polish bundle (PR #59). |
| `/sales-reports` | SalesReports | Comprehensive sales & chemical history. 5 tabs (Detail, By Product, By Customer, By Month, By Sales Rep), 6 filters, multi-customer select with farm group support, Customer View toggle (hides cost/margin), CSV/PDF export |
| `/reports` | Reports | 14 reports: 4 logbook, 6 financial, 4 operational. CSV/PDF export. |
| `/fields` | Fields | Field list with Mapbox map view + bulk import (shapefile/KML/GeoJSON) |
| `/fields/:id` | FieldSetup | Field CRUD with two-panel layout and satellite map with polygon drawing |
| `/recipes` | BlendRecipes | Reusable blend recipe management, create job from recipe |
| `/cycle-counts` | CycleCounts | Inventory cycle counting with variance tracking |
| `/returns` | Returns | Returns/RMA workflow (request -> approve -> receive -> credit) |
| `/brand-vs-generic` | BrandVsGeneric | Ingredient mapping: branded vs generic |
| `/crop-programs` | CropPrograms | Seasonal crop program management |
| `/compliance` | Compliance | Applicator license tracking, RUP product list, RUP Sales Register (auto-generated from invoices, filterable, CSV export) |
| `/lot-trace` | LotTrace | **B1 Lot Capture & Trace** — recall/compliance lookup: enter a lot number → every application that used it (product, field(s), date, customer, applicator, record #, invoice, source). Admin/sales. UI ships in this branch; the `get_lot_application_trace` RPC is pending the B1 migration apply. |
| `/rebates` | Rebates | Manufacturer rebate programs and claim management |
| `/team-board` | TeamBoard | Team communication hub: notes/todos/announcements with entity linking (delivery, order, customer, job, PO, quote), today's deliveries bulletin (role-aware), yesterday's recap, photo attachments, comments, activity log, search/filter, real-time. 8 sub-components in `src/components/team/` |
| `/notifications` | Notifications | User notification center |
| `/settings` | SettingsPage | Admin only: company settings, user management |
| `/dispatch` | DispatchBoard | Map-based dispatch view for job scheduling with applicator assignment |
| `/fields/:id/dashboard` | FieldDashboard | Read-only field profile: overview (season stats, activity), applications (history table with weather), billing (splits visualization), details (FSA, legal desc, notes) |
| `/application-services` | ApplicationServices | Admin: CRUD for application service pricing (vehicle-linked fees like Hagie Y-Drop, Rogator, etc.) |
| `/application-services/:id` | ApplicationServiceDetail | Admin: Create/edit service with customer rate overrides |
| `/program-tracker` | ProgramTracker | Program completion dashboard: planned vs actual acres per customer per season with progress bars |
| `/invoices/field-app/new` | FieldApplicationInvoice | New field application invoice with multi-location select, auto-figuring chemicals and customer shares |
| `/invoices/field-app/:id` | FieldApplicationInvoice | Edit existing field application invoice |
| `/integrity-report` | IntegrityReport | Admin-only. Read-only data integrity dashboard. Runs `runReconciliationChecks()` from `src/lib/reconciliation.ts` and shows pass/fail per check (order totals, inventory ledger, invoice payments via invoice_line_allocations, balance formula, commission splits, quote hold parity, delivery-invoice parity, prebooked inventory, return credit linkage, customer AR consistency). Discrepancy table per failed check with re-run button. Sprint F #4. |
| `/integrity-cleanup` | IntegrityCleanup | Admin-only. Action-driven cleanup tooling for the three production-data issue classes flagged by the deep audit: (1) negative inventory rows — per-row reset form calling `reconcile_negative_inventory` RPC with mandatory reason; (2) over-received PO items — read-only listing for review; (3) completed deliveries without invoices — per-row "Create draft invoice" button calling `create_invoice_for_unbilled_delivery` RPC. Sprint G3 + G4 (Phase 22). |
| `/to-ship` | ToShip | Admin/sales. Operations command center: To-Ship by Product/Customer + Low-Stock/reorder + Deliveries (overdue/unassigned) + Inbound POs, all from frontend queries. Schedule/Reorder act-buttons deep-link into the trusted create flows. (UI overhaul v1) |
| `/receiving-hub` | ReceivingHub | Admin/sales. Open PO lines grouped by product across vendors (ordered/received/remaining + arrival) + a commitment snapshot (On Floor/Hold/Order/Spoken-For/Net) from `get_inventory_position`. Inline full-receipt "Receive" (reuses `receive_po_items`). (UI overhaul v2) |
| `/accounts-receivable` | AccountsReceivable | **Admin-only.** One AR workspace: tabs for Aging / Payment History / Prepayments / Customer Ledger + a Net Money Position card (total owed via `get_ar_aging` minus unused `prepay_credits`). `/payments` (PaymentAllocation) stays SEPARATE (admin+sales). (UI overhaul v2) |
| `/field-invoices` | FieldInvoices | Admin/sales. Field-application invoices area (as-applied billing); list + entry into the field-app invoice editor. |
| `/field-invoices/unposted` | FieldInvoicesUnposted | Admin/sales. Field-app parity #22 — dedicated "Unposted" working tray for field invoices (static path, precedes `:id`). |
| `/field-invoices/posted` | FieldInvoicesPosted | Admin/sales. Field-app parity #23 — dedicated "Posted" committed field-invoice list (static path, precedes `:id`). |
| `/field-invoices/summary` | CustomerInvoiceSummary | Admin/sales. Field-app parity #34 — combined Customer Invoice Summary (unposted chem sales + unposted field-app). |
| `/field-invoices/unbilled` | UnbilledApplications | Admin/sales. Applied-but-unbilled field work awaiting an invoice (reconciliation worklist). |
| `/office-cockpit` | OfficeCockpit | Admin/sales. §3 Beyond-Parity exception dashboard: 7 live tiles (unbilled jobs, ready-to-post field-app invoices, watchdog flags, upcoming jobs 7-day, expiring licenses/certs 30-day, overdue field-app AR, deferred inventory shortfalls). One screen replaces the run-seven-reports ritual. |
| `/field` | FieldView | Admin/sales/applicator. Field-app parity #38 — phone/mobile applicator field view (read-only "my jobs" cards). |
| `/design-preview` | DesignPreview | **Dev/preview only** (hostname-gated, never on croprxsolutions.app): shared-component visual gallery for the design system. |
