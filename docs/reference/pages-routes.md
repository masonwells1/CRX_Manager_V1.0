# Pages & Routes Reference (57 total)

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
| `/sales-reports` | SalesReports | Comprehensive sales & chemical history. 5 tabs (Detail, By Product, By Customer, By Month, By Sales Rep), 6 filters, multi-customer select with farm group support, Customer View toggle (hides cost/margin), CSV/PDF export |
| `/reports` | Reports | 14 reports: 4 logbook, 6 financial, 4 operational. CSV/PDF export. |
| `/fields` | Fields | Field list with Mapbox map view + bulk import (shapefile/KML/GeoJSON) |
| `/fields/:id` | FieldDetail | Field CRUD with polygon drawing on satellite map |
| `/recipes` | BlendRecipes | Reusable blend recipe management, create job from recipe |
| `/cycle-counts` | CycleCounts | Inventory cycle counting with variance tracking |
| `/returns` | Returns | Returns/RMA workflow (request -> approve -> receive -> credit) |
| `/brand-vs-generic` | BrandVsGeneric | Ingredient mapping: branded vs generic |
| `/crop-programs` | CropPrograms | Seasonal crop program management |
| `/compliance` | Compliance | Applicator license tracking, RUP product list, RUP Sales Register (auto-generated from invoices, filterable, CSV export) |
| `/rebates` | Rebates | Manufacturer rebate programs and claim management |
| `/team-board` | TeamBoard | Team communication hub: notes/todos/announcements with entity linking (delivery, order, customer, job, PO, quote), today's deliveries bulletin (role-aware), yesterday's recap, photo attachments, comments, activity log, search/filter, real-time. 8 sub-components in `src/components/team/` |
| `/notifications` | Notifications | User notification center |
| `/settings` | SettingsPage | Admin only: company settings, user management |
