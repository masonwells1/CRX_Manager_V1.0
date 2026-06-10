# CRX Manager Foundation Map

Generated: 2026-05-28

Scope note: this is an orientation map only. It intentionally avoids judgments; findings belong in the audit report.

## Counts

- Page source files in `src/pages/`: 66
- Page test files in `src/pages/`: 10
- Lazy page declarations in `src/App.tsx`: 66
- Route entries in `src/App.tsx`: 72, including auth and wildcard routes
- Shared component/source files under `src/components/`: 150
- Hook source/test files under `src/hooks/`: 22
- Library source/test files under `src/lib/`: 81
- Context source/test files under `src/contexts/`: 2
- Migration files: 356
- Edge Function directories, excluding `_shared`: 7

## Page Inventory

| Page | Route(s) | Lazy | Lines |
|---|---|---:|---:|
| AccountsPayable | `/accounts-payable` | yes | 266 |
| ApplicationRecords | `/application-records` | yes | 281 |
| ApplicationServiceDetail | `/application-services/:id` | yes | 159 |
| ApplicationServices | `/application-services` | yes | 224 |
| ARaging | `/ar-aging` | yes | 1047 |
| BlendRecipes | `/recipes` | yes | 557 |
| BlendTicketDetail | `/blend-tickets/:id` | yes | 1608 |
| BlendTickets | `/blend-tickets` | yes | 712 |
| BrandVsGeneric | `/brand-vs-generic` | yes | 216 |
| CommissionPayments | `/commission-payments` | yes | 668 |
| Compliance | `/compliance` | yes | 883 |
| CropPrograms | `/crop-programs` | yes | 511 |
| CustomerDetail | `/customers/:id` | yes | 1435 |
| Customers | `/customers` | yes | 267 |
| CustomerTransactionReview | `/customer-transactions` | yes | 193 |
| CycleCounts | `/cycle-counts` | yes | 665 |
| Dashboard | `/` | yes | 1053 |
| Deliveries | `/deliveries` | yes | 1224 |
| DeliveryDetail | `/deliveries/:id` | yes | 2273 |
| DeliveryRemainders | `/delivery-remainders` | yes | 311 |
| DispatchBoard | `/dispatch` | yes | 343 |
| FieldApplicationInvoice | `/invoices/field-app/new`, `/invoices/field-app/:id` | yes | 785 |
| FieldDashboard | `/fields/:id/dashboard` | yes | 650 |
| Fields | `/fields` | yes | 485 |
| FieldSetup | `/fields/:id` | yes | 854 |
| FinancialDashboard | `/financial-dashboard` | yes | 698 |
| GettingStarted | `/getting-started` | yes | 577 |
| IntegrityCleanup | `/integrity-cleanup` | yes | 575 |
| IntegrityReport | `/integrity-report` | yes | 152 |
| InventoryPage | `/inventory` | yes | 1467 |
| InvoiceDetail | `/invoices/:id` | yes | 1336 |
| Invoices | `/invoices` | yes | 717 |
| JobDetail | `/jobs/:id` | yes | 949 |
| Jobs | `/jobs` | yes | 413 |
| MonthEndClose | `/month-end` | yes | 555 |
| NewDelivery | `/deliveries/new` | yes | 607 |
| NewOrder | `/orders/new` | yes | 745 |
| NewPurchaseOrder | `/purchase-orders/new` | yes | 475 |
| NewVendorBill | `/accounts-payable/bills/new` | yes | 315 |
| Notifications | `/notifications` | yes | 162 |
| OrderDetail | `/orders/:id` | yes | 1492 |
| Orders | `/orders` | yes | 585 |
| PaymentAllocation | `/payments` | yes | 602 |
| PaymentHistory | `/payment-history` | yes | 384 |
| PrepaymentManager | `/prepayments` | yes | 940 |
| PrepayWorkspace | `/prepay-workspace` | yes | 424 |
| ProductDetail | `/products/:id` | yes | 555 |
| Products | `/products` | yes | 712 |
| ProgramTracker | `/program-tracker` | yes | 179 |
| PurchaseOrderDetail | `/purchase-orders/:id` | yes | 1177 |
| PurchaseOrders | `/purchase-orders` | yes | 731 |
| QuickReceive | `/receiving/quick` | yes | 921 |
| QuoteBuilder | `/quotes/new`, `/quotes/:id` | yes | 2493 |
| Quotes | `/quotes` | yes | 345 |
| Rebates | `/rebates` | yes | 872 |
| ReceivingLog | `/receiving` | yes | 476 |
| Reports | `/reports` | yes | 950 |
| Returns | `/returns` | yes | 898 |
| SalesReports | `/sales-reports` | yes | 568 |
| SettingsPage | `/settings` | yes | 676 |
| TeamBoard | `/team-board` | yes | 1396 |
| VehicleDetail | `/vehicles/:id` | yes | 257 |
| Vehicles | `/vehicles` | yes | 245 |
| VendorBillDetail | `/accounts-payable/bills/:id` | yes | 646 |
| VendorBills | `/accounts-payable/bills` | yes | 240 |
| Vendors | `/vendors` | yes | 288 |

## Shared Building Blocks

- `src/components/ui/`: shared primitives such as `Button`, `Card`, `Modal`, `ConfirmModal`, `DataTable`, `EditableDataTable`, `Toast`, `Skeleton`, `EmptyState`, `Badge`, `Input`, `Select`, `CommissionSplitEditor`, and `TransactionThread`.
- Domain component folders: `auth`, `layout`, `reports`, `deliveries`, `blendtickets`, `customers`, `products`, `purchase-orders`, `orders`, `inventory`, `invoices`, `field-app`, `fields`, `map`, `statements`, `team`, and `dashboard`.
- `src/hooks/`: `useIdempotencyKey`, `useFormDraft`, `useGuardrails`, `useOCRProcessor`, `useOCRThresholds`, `useOnlineStatus`, `usePageMeta`, `useRealtimeSubscription`, `useRowSelection`, `useUnsavedChanges`, and `useFitBounds`.
- `src/contexts/`: `AuthContext` is the app-wide context; tests live beside it.
- `src/lib/`: `db.ts` owns the Supabase client plus RPC/mutation guards; other notable libraries include activity logging, idempotency, date utilities, PDF generation, CSV export, quote math, reconciliation, metrics, error sanitizing, notification triggers, offline queue/sync, email service, and permission helpers.

## Data-Flow Traces

### Quote Save

`QuoteBuilder` loads customer/product/reference data from `supabase.from(...)`, keeps a large local quote-editing state, computes display totals locally, then calls `save_quote` through `supabase.rpc(...)` with `p_quote_payload`, `p_sections`, `p_performed_by`, and a `useIdempotencyKey` key. The database-side `save_quote` migration inserts the submitted structure, then recomputes quote item and quote totals server-side from product and conversion data before returning `{ quote_id }`.

### Invoice Post/Void

`InvoiceDetail` loads invoice, item, customer, payment, delivery, and write-off data from table queries. Posting uses `post_invoice_group` when the invoice has `invoice_group_id`, otherwise `post_invoice` as a void-returning RPC with `.throwOnError()`. Voiding uses `void_invoice` with `.throwOnError()`. Idempotency keys are sourced from `useIdempotencyKey`.

### Payment Allocation

`PaymentAllocation` loads eligible invoices and customer AR context, stages allocations in React state, then calls `allocate_payment` with `p_payment_date`, `p_customer_id`, allocation rows, and a stable `useIdempotencyKey` key. The RPC result is checked with `assertRpcResult`, and user feedback is shown through the shared toast provider.
