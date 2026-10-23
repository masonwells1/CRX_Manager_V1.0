// A route list, not a component module: the lazy page bindings below are not
// components this file renders, and editing a page still hot-reloads that page's
// own file. Editing this list reloads the app, which is fine.
/* eslint-disable react-refresh/only-export-components */
import { lazy, type ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import LegacyTabRedirect from './components/LegacyTabRedirect';
import type { UserRole } from './types';

/**
 * The shared page list: every page inside the signed-in app, kept in one place.
 *
 * The router (App.tsx) builds its routes from it, the page-permission list
 * (lib/pagePermissions.ts: ProtectedRoute's deny-list check, the Settings
 * permission screen, the command palette) is derived from it, and the sidebar
 * takes each link's role gate from it and may only link to a page address listed
 * here (a type error otherwise). So a page's address and who may open it cannot
 * disagree between them. src/routeBaseline.test.tsx checks the result for every
 * route and role.
 *
 * Each entry is one page:
 *   key       its permission and deny-list key; the first segment of its address.
 *   roles     who may open it. Admins pass every page check.
 *   label, category
 *             how the Settings permission screen and the command palette name and
 *             group it. A page with neither has no permission entry and is exempt
 *             from the deny list (see EXEMPT_ROUTE_SEGMENTS).
 *   routes    its router paths, relative (no leading slash). The FIRST is the page's
 *             own address, where Settings, the command palette and the sidebar link.
 *             A route may narrow `roles` further.
 *
 * Order is the Settings screen and command palette order. The sidebar's order,
 * wording and icons differ by role and live in components/layout/Sidebar.tsx.
 */

// Lazy-loaded pages — each page is only downloaded when the user navigates to it
const Dashboard = lazy(() => import('./pages/Dashboard'));
const Products = lazy(() => import('./pages/Products'));
const SupplierPricing = lazy(() => import('./pages/SupplierPricing'));
const ProductDetail = lazy(() => import('./pages/ProductDetail'));
const Customers = lazy(() => import('./pages/Customers'));
const CustomerDetail = lazy(() => import('./pages/CustomerDetail'));
const CallLists = lazy(() => import('./pages/CallLists'));
const Quotes = lazy(() => import('./pages/Quotes'));
const QuoteBuilder = lazy(() => import('./pages/QuoteBuilder'));
const Orders = lazy(() => import('./pages/Orders'));
const NewOrder = lazy(() => import('./pages/NewOrder'));
const OrderDetail = lazy(() => import('./pages/OrderDetail'));
const InventoryPage = lazy(() => import('./pages/InventoryPage'));
const Deliveries = lazy(() => import('./pages/Deliveries'));
const NewDelivery = lazy(() => import('./pages/NewDelivery'));
// Routed through DeliveryDetailRoute, which keys DeliveryDetail by the delivery id so an edit
// opened on one delivery never carries over to the next. See that file.
const DeliveryDetailRoute = lazy(() => import('./components/DeliveryDetailRoute'));
const FieldRoute = lazy(() => import('./pages/FieldRoute'));
const FieldStop = lazy(() => import('./pages/FieldStop'));
const PurchaseOrders = lazy(() => import('./pages/PurchaseOrders'));
const NewPurchaseOrder = lazy(() => import('./pages/NewPurchaseOrder'));
const PurchaseOrderDetail = lazy(() => import('./pages/PurchaseOrderDetail'));
const BrandVsGeneric = lazy(() => import('./pages/BrandVsGeneric'));
const Reports = lazy(() => import('./pages/Reports'));
const CropPrograms = lazy(() => import('./pages/CropPrograms'));
const TeamBoard = lazy(() => import('./pages/TeamBoard'));
const Notifications = lazy(() => import('./pages/Notifications'));
const SettingsPage = lazy(() => import('./pages/SettingsPage'));
const Integrity = lazy(() => import('./pages/Integrity'));
// Payments.tsx removed — PaymentAllocation is now the sole payment page at /payments
const Fields = lazy(() => import('./pages/Fields'));
const FieldSetup = lazy(() => import('./pages/FieldSetup'));
const FieldDashboard = lazy(() => import('./pages/FieldDashboard'));
const FieldProfitability = lazy(() => import('./pages/FieldProfitability'));
const BlendTickets = lazy(() => import('./pages/BlendTickets').then(m => ({ default: m.BlendTickets })));
const BlendTicketDetail = lazy(() => import('./pages/BlendTicketDetail').then(m => ({ default: m.BlendTicketDetail })));
const Invoices = lazy(() => import('./pages/Invoices'));
const FieldInvoices = lazy(() => import('./pages/FieldInvoices'));
const InvoiceDetail = lazy(() => import('./pages/InvoiceDetail'));
const BlendRecipes = lazy(() => import('./pages/BlendRecipes'));
const CycleCounts = lazy(() => import('./pages/CycleCounts'));
const Returns = lazy(() => import('./pages/Returns'));
const ARaging = lazy(() => import('./pages/ARaging'));
const AccountsReceivable = lazy(() => import('./pages/AccountsReceivable'));
const Compliance = lazy(() => import('./pages/Compliance'));
const LabelReview = lazy(() => import('./pages/LabelReview'));
const LabelDataQuality = lazy(() => import('./pages/LabelDataQuality'));
const WatchdogExceptions = lazy(() => import('./pages/WatchdogExceptions'));
const OfflineWorkReview = lazy(() => import('./pages/OfflineWorkReview'));
const OfficeCockpit = lazy(() => import('./pages/OfficeCockpit'));
const Rebates = lazy(() => import('./pages/Rebates'));
const Vehicles = lazy(() => import('./pages/Vehicles'));
const VehicleDetail = lazy(() => import('./pages/VehicleDetail'));
const ApplicationServices = lazy(() => import('./pages/ApplicationServices'));
const ApplicationServiceDetail = lazy(() => import('./pages/ApplicationServiceDetail'));
const ApplicationRecords = lazy(() => import('./pages/ApplicationRecords'));
const LotTrace = lazy(() => import('./pages/LotTrace'));
const ProgramTracker = lazy(() => import('./pages/ProgramTracker'));
const Jobs = lazy(() => import('./pages/Jobs'));
// Routed through JobDetailRoute, which keys JobDetail by the job id so switching records
// REMOUNTS the page instead of reusing it. See that file for what reuse leaked.
const JobDetailRoute = lazy(() => import('./components/JobDetailRoute'));
const DispatchBoard = lazy(() => import('./pages/DispatchBoard'));
const FieldView = lazy(() => import('./pages/FieldView'));
const MonthEndClose = lazy(() => import('./pages/MonthEndClose'));
const CommissionPayments = lazy(() => import('./pages/CommissionPayments'));
const CustomerTransactionReview = lazy(() => import('./pages/CustomerTransactionReview'));
const Prepay = lazy(() => import('./pages/Prepay'));
const PaymentAllocation = lazy(() => import('./pages/PaymentAllocation'));
const PaymentHistory = lazy(() => import('./pages/PaymentHistory'));
const DeliveryRemainders = lazy(() => import('./pages/DeliveryRemainders'));
const Receiving = lazy(() => import('./pages/Receiving'));
const FinancialDashboard = lazy(() => import('./pages/FinancialDashboard'));
const AccountsPayable = lazy(() => import('./pages/AccountsPayable'));
const VendorBills = lazy(() => import('./pages/VendorBills'));
const NewVendorBill = lazy(() => import('./pages/NewVendorBill'));
const VendorBillDetail = lazy(() => import('./pages/VendorBillDetail'));
const Vendors = lazy(() => import('./pages/Vendors'));
const SalesReports = lazy(() => import('./pages/SalesReports'));
const GettingStarted = lazy(() => import('./pages/GettingStarted'));
// Per-line split-billing editor — flag-gated (per_line_split_billing_enabled). The page
// self-gates on the flag (renders a "not enabled" notice when OFF), so the route is safe
// even by hand-typed URL; the nav link is only shown when the flag is ON.
const FieldAppSplitInvoiceEditor = lazy(() => import('./pages/FieldAppSplitInvoiceEditor'));
const ToShip = lazy(() => import('./pages/ToShip'));

export interface AppRoute {
  /** Router path, relative (no leading slash). */
  path: string;
  element: ReactNode;
  /** Narrower than the page's roles, when only some of them may open this route. */
  roles?: readonly UserRole[];
}

/** Settings label and group: both, or neither (no permission entry; exempt from the deny list). */
type PermissionEntry =
  | { label: string; category: string }
  | { label?: never; category?: never };

export type AppPage = PermissionEntry & {
  key: string;
  roles: readonly UserRole[];
  routes: readonly [AppRoute, ...AppRoute[]];
};

export const APP_PAGES = [
  // Sell & Deliver
  {
    key: 'quotes', label: 'Quotes & Bookings', category: 'Sell & Deliver', roles: ['admin', 'sales_rep'],
    routes: [
      { path: 'quotes', element: <Quotes /> },
      { path: 'quotes/new', element: <QuoteBuilder /> },
      { path: 'quotes/:id', element: <QuoteBuilder /> },
    ],
  },
  {
    key: 'orders', label: 'Orders', category: 'Sell & Deliver', roles: ['admin', 'sales_rep'],
    routes: [
      { path: 'orders', element: <Orders /> },
      { path: 'orders/new', element: <NewOrder /> },
      { path: 'orders/:id', element: <OrderDetail /> },
    ],
  },
  {
    // Drivers need delivery access, but only the office creates deliveries.
    key: 'deliveries', label: 'Deliveries', category: 'Sell & Deliver', roles: ['admin', 'sales_rep', 'driver'],
    routes: [
      { path: 'deliveries', element: <Deliveries /> },
      { path: 'deliveries/new', element: <NewDelivery />, roles: ['admin', 'sales_rep'] },
      { path: 'deliveries/:id', element: <DeliveryDetailRoute /> },
    ],
  },
  {
    key: 'my-route', label: 'My Route', category: 'Sell & Deliver', roles: ['admin', 'sales_rep', 'driver'],
    routes: [
      { path: 'my-route', element: <FieldRoute /> },
      { path: 'my-route/:id', element: <FieldStop /> },
    ],
  },
  {
    key: 'delivery-remainders', label: 'Remainders', category: 'Sell & Deliver', roles: ['admin', 'sales_rep'],
    routes: [{ path: 'delivery-remainders', element: <DeliveryRemainders /> }],
  },
  {
    key: 'invoices', label: 'Invoices — Chemical', category: 'Sell & Deliver', roles: ['admin', 'sales_rep'],
    routes: [
      { path: 'invoices', element: <Invoices /> },
      { path: 'invoices/:id', element: <InvoiceDetail routeArea="chemical" /> },
    ],
  },
  {
    key: 'returns', label: 'Returns', category: 'Sell & Deliver', roles: ['admin', 'sales_rep'],
    routes: [{ path: 'returns', element: <Returns /> }],
  },
  {
    key: 'to-ship', label: 'To-Ship (Load-Out Board)', category: 'Sell & Deliver', roles: ['admin', 'sales_rep'],
    routes: [{ path: 'to-ship', element: <ToShip /> }],
  },

  // Spray Fields
  {
    key: 'jobs', label: 'Job Schedule', category: 'Spray Fields', roles: ['admin', 'sales_rep', 'applicator'],
    routes: [
      { path: 'jobs', element: <Jobs /> },
      { path: 'jobs/:id', element: <JobDetailRoute /> },
    ],
  },
  {
    key: 'dispatch', label: 'Dispatch Board', category: 'Spray Fields', roles: ['admin', 'sales_rep', 'applicator'],
    routes: [{ path: 'dispatch', element: <DispatchBoard /> }],
  },
  {
    key: 'field-invoices', label: 'Field Invoices', category: 'Spray Fields', roles: ['admin', 'sales_rep'],
    routes: [
      { path: 'field-invoices', element: <FieldInvoices /> },
      // Field-invoice detail (job-built quantity invoices + posted field invoices)
      // reuses the generic invoice editor under the field-invoices permission. #3 edit-path.
      { path: 'field-invoices/:id', element: <InvoiceDetail routeArea="field" /> },
      // This page also owns invoices/field-app/new and invoices/field-app/:id (the
      // field-application editor; getPageKeyFromPath maps them here, not to Chemical
      // invoices). Those two are still written out in App.tsx, because
      // src/pages/FieldApplicationInvoice.test.tsx pins their text there.
      // Kept for bookmarks; all workflow views now live as query-addressable tabs.
      { path: 'field-invoices/unposted', element: <Navigate to="/field-invoices?tab=drafts" replace /> },
      { path: 'field-invoices/posted', element: <Navigate to="/field-invoices?tab=posted" replace /> },
      { path: 'field-invoices/unbilled', element: <Navigate to="/field-invoices?tab=unbilled" replace /> },
      { path: 'field-invoices/summary', element: <Navigate to="/field-invoices?tab=customer" replace /> },
    ],
  },
  {
    // Per-line split-billing editor (flag-gated OFF; the page self-gates and the nav
    // link is hidden while off). /split-billing/:id reopens a saved billing set
    // (#H save-now/post-later: read-only review + Post).
    key: 'split-billing', label: 'Split Billing', category: 'Spray Fields', roles: ['admin', 'sales_rep'],
    routes: [
      { path: 'split-billing/new', element: <FieldAppSplitInvoiceEditor /> },
      { path: 'split-billing/:id', element: <FieldAppSplitInvoiceEditor /> },
    ],
  },
  {
    key: 'application-records', label: 'Record Book (Applications)', category: 'Spray Fields', roles: ['admin', 'sales_rep', 'applicator'],
    routes: [{ path: 'application-records', element: <ApplicationRecords /> }],
  },
  {
    key: 'program-tracker', label: 'Program Tracker', category: 'Spray Fields', roles: ['admin', 'sales_rep'],
    routes: [{ path: 'program-tracker', element: <ProgramTracker /> }],
  },
  {
    key: 'recipes', label: 'Blend Recipes', category: 'Spray Fields', roles: ['admin', 'sales_rep'],
    routes: [{ path: 'recipes', element: <BlendRecipes /> }],
  },
  {
    // Phone/mobile applicator field view (#38) — read-only "my jobs" cards.
    key: 'field', label: 'Field View (phone preview)', category: 'Spray Fields', roles: ['admin', 'sales_rep', 'applicator'],
    routes: [{ path: 'field', element: <FieldView /> }],
  },

  // Customers & Fields
  {
    key: 'customers', label: 'Customers', category: 'Customers & Fields', roles: ['admin', 'sales_rep'],
    routes: [
      { path: 'customers', element: <Customers /> },
      { path: 'customers/:id', element: <CustomerDetail /> },
    ],
  },
  {
    key: 'call-lists', label: 'Call Lists', category: 'Customers & Fields', roles: ['admin', 'sales_rep'],
    routes: [{ path: 'call-lists', element: <CallLists /> }],
  },
  {
    key: 'fields', label: 'Fields & Maps', category: 'Customers & Fields', roles: ['admin', 'sales_rep'],
    routes: [
      { path: 'fields', element: <Fields /> },
      { path: 'fields/:id', element: <FieldSetup /> },
      { path: 'fields/:id/dashboard', element: <FieldDashboard /> },
    ],
  },
  {
    key: 'crop-programs', label: 'Crop Programs', category: 'Customers & Fields', roles: ['admin', 'sales_rep'],
    routes: [{ path: 'crop-programs', element: <CropPrograms /> }],
  },

  // Inventory & Buying
  {
    key: 'inventory', label: 'Inventory', category: 'Inventory & Buying', roles: ['admin', 'sales_rep'],
    routes: [{ path: 'inventory', element: <InventoryPage /> }],
  },
  {
    key: 'products', label: 'Products', category: 'Inventory & Buying', roles: ['admin', 'sales_rep'],
    routes: [
      { path: 'products', element: <Products /> },
      { path: 'products/:id', element: <ProductDetail /> },
    ],
  },
  {
    key: 'supplier-pricing', label: 'Supplier Pricing', category: 'Inventory & Buying', roles: ['admin'],
    routes: [{ path: 'supplier-pricing', element: <SupplierPricing /> }],
  },
  {
    key: 'brand-vs-generic', label: 'Brand vs Generic', category: 'Inventory & Buying', roles: ['admin', 'sales_rep'],
    routes: [{ path: 'brand-vs-generic', element: <BrandVsGeneric /> }],
  },
  {
    key: 'purchase-orders', label: 'Purchase Orders', category: 'Inventory & Buying', roles: ['admin', 'sales_rep'],
    routes: [
      { path: 'purchase-orders', element: <PurchaseOrders /> },
      { path: 'purchase-orders/new', element: <NewPurchaseOrder /> },
      { path: 'purchase-orders/:id', element: <PurchaseOrderDetail /> },
    ],
  },
  {
    key: 'receiving', label: 'Receiving', category: 'Inventory & Buying', roles: ['admin', 'sales_rep'],
    routes: [
      { path: 'receiving', element: <Receiving /> },
      // Kept for bookmarks; the former pages now live as query-addressable tabs.
      { path: 'receiving-hub', element: <Navigate to="/receiving?tab=hub" replace /> },
      { path: 'receiving/quick', element: <Navigate to="/receiving?tab=quick" replace /> },
    ],
  },
  {
    key: 'cycle-counts', label: 'Cycle Counts', category: 'Inventory & Buying', roles: ['admin'],
    routes: [{ path: 'cycle-counts', element: <CycleCounts /> }],
  },

  // Money
  {
    // payment-allocation route removed — now served at /payments
    key: 'payments', label: 'Record Payments', category: 'Money', roles: ['admin', 'sales_rep'],
    routes: [{ path: 'payments', element: <PaymentAllocation /> }],
  },
  {
    key: 'accounts-receivable', label: 'A/R Workspace', category: 'Money', roles: ['admin'],
    routes: [{ path: 'accounts-receivable', element: <AccountsReceivable /> }],
  },
  {
    key: 'ar-aging', label: 'A/R Aging', category: 'Money', roles: ['admin'],
    routes: [{ path: 'ar-aging', element: <ARaging /> }],
  },
  {
    key: 'prepay', label: 'Prepay', category: 'Money', roles: ['admin'],
    routes: [
      { path: 'prepay', element: <Prepay /> },
      // Kept for bookmarks; the former pages now live as query-addressable tabs.
      { path: 'prepayments', element: <LegacyTabRedirect to="/prepay" tab="manager" /> },
      { path: 'prepay-workspace', element: <LegacyTabRedirect to="/prepay" tab="workspace" /> },
    ],
  },
  {
    key: 'customer-transactions', label: 'Customer Transactions', category: 'Money', roles: ['admin'],
    routes: [{ path: 'customer-transactions', element: <CustomerTransactionReview /> }],
  },
  {
    key: 'accounts-payable', label: 'A/P & Vendor Bills', category: 'Money', roles: ['admin'],
    routes: [
      { path: 'accounts-payable', element: <AccountsPayable /> },
      { path: 'accounts-payable/bills', element: <VendorBills /> },
      { path: 'accounts-payable/bills/new', element: <NewVendorBill /> },
      { path: 'accounts-payable/bills/:id', element: <VendorBillDetail /> },
    ],
  },
  {
    key: 'commission-payments', label: 'Commissions', category: 'Money', roles: ['admin'],
    routes: [{ path: 'commission-payments', element: <CommissionPayments /> }],
  },
  {
    key: 'rebates', label: 'Rebates', category: 'Money', roles: ['admin'],
    routes: [{ path: 'rebates', element: <Rebates /> }],
  },
  {
    key: 'month-end', label: 'Month-End Close', category: 'Money', roles: ['admin'],
    routes: [{ path: 'month-end', element: <MonthEndClose /> }],
  },
  {
    key: 'integrity', label: 'Data Integrity', category: 'Money', roles: ['admin'],
    routes: [
      { path: 'integrity', element: <Integrity /> },
      // Kept for bookmarks; the former pages now live as query-addressable tabs.
      { path: 'integrity-report', element: <LegacyTabRedirect to="/integrity" tab="report" /> },
      { path: 'integrity-cleanup', element: <LegacyTabRedirect to="/integrity" tab="cleanup" /> },
    ],
  },
  {
    key: 'payment-history', label: 'Payment History', category: 'Money', roles: ['admin'],
    routes: [{ path: 'payment-history', element: <PaymentHistory /> }],
  },

  // Compliance & Records
  {
    key: 'compliance', label: 'Licenses & RUP Register', category: 'Compliance & Records', roles: ['admin', 'sales_rep'],
    routes: [{ path: 'compliance', element: <Compliance /> }],
  },
  {
    key: 'lot-trace', label: 'Lot Trace (recall lookup)', category: 'Compliance & Records', roles: ['admin', 'sales_rep'],
    routes: [{ path: 'lot-trace', element: <LotTrace /> }],
  },
  {
    key: 'watchdog', label: 'Watchdog Flags', category: 'Compliance & Records', roles: ['admin', 'sales_rep'],
    routes: [{ path: 'watchdog', element: <WatchdogExceptions /> }],
  },
  {
    key: 'offline-work-review', label: 'Offline Work Review', category: 'Compliance & Records', roles: ['admin', 'sales_rep'],
    routes: [{ path: 'offline-work-review', element: <OfflineWorkReview /> }],
  },
  {
    key: 'label-review', label: 'Label Review', category: 'Compliance & Records', roles: ['admin'],
    routes: [{ path: 'label-review', element: <LabelReview /> }],
  },
  {
    key: 'label-data-quality', label: 'Label Data Quality', category: 'Compliance & Records', roles: ['admin'],
    routes: [{ path: 'label-data-quality', element: <LabelDataQuality /> }],
  },
  {
    key: 'blend-tickets', label: 'Blend Tickets (OCR)', category: 'Compliance & Records', roles: ['admin', 'sales_rep'],
    routes: [
      { path: 'blend-tickets', element: <BlendTickets /> },
      { path: 'blend-tickets/:id', element: <BlendTicketDetail /> },
    ],
  },

  // Insights
  {
    key: 'dashboard', label: 'Overview (KPI Dashboard)', category: 'Insights', roles: ['admin', 'sales_rep'],
    routes: [{ path: 'dashboard', element: <Dashboard /> }],
  },
  {
    key: 'office-cockpit', label: 'Today', category: 'Insights', roles: ['admin', 'sales_rep'],
    routes: [{ path: 'office-cockpit', element: <OfficeCockpit /> }],
  },
  {
    key: 'reports', label: 'Reports Library', category: 'Insights', roles: ['admin', 'sales_rep'],
    routes: [{ path: 'reports', element: <Reports /> }],
  },
  {
    key: 'field-profitability', label: 'Field Profitability', category: 'Insights', roles: ['admin'],
    routes: [{ path: 'field-profitability', element: <FieldProfitability /> }],
  },
  {
    key: 'sales-reports', label: 'Sales Reports', category: 'Insights', roles: ['admin', 'sales_rep'],
    routes: [{ path: 'sales-reports', element: <SalesReports /> }],
  },
  {
    key: 'financial-dashboard', label: 'Financial Dashboard', category: 'Insights', roles: ['admin'],
    routes: [{ path: 'financial-dashboard', element: <FinancialDashboard /> }],
  },

  // Setup & Admin
  {
    key: 'vehicles', label: 'Vehicles', category: 'Setup & Admin', roles: ['admin'],
    routes: [
      { path: 'vehicles', element: <Vehicles /> },
      { path: 'vehicles/:id', element: <VehicleDetail /> },
    ],
  },
  {
    key: 'application-services', label: 'Application Services (fees)', category: 'Setup & Admin', roles: ['admin'],
    routes: [
      { path: 'application-services', element: <ApplicationServices /> },
      { path: 'application-services/:id', element: <ApplicationServiceDetail /> },
    ],
  },
  {
    key: 'vendors', label: 'Vendors', category: 'Setup & Admin', roles: ['admin'],
    routes: [{ path: 'vendors', element: <Vendors /> }],
  },
  {
    key: 'getting-started', label: 'Getting Started (help)', category: 'Setup & Admin', roles: ['admin', 'sales_rep', 'driver', 'applicator'],
    routes: [{ path: 'getting-started', element: <GettingStarted /> }],
  },

  // No permission entry: open to every listed role, never on a deny list.
  {
    key: 'team-board', roles: ['admin', 'sales_rep', 'applicator', 'driver'],
    routes: [{ path: 'team-board', element: <TeamBoard /> }],
  },
  {
    key: 'notifications', roles: ['admin', 'sales_rep', 'applicator', 'driver'],
    routes: [{ path: 'notifications', element: <Notifications /> }],
  },
  {
    key: 'settings', roles: ['admin'],
    routes: [{ path: 'settings', element: <SettingsPage /> }],
  },
] as const satisfies readonly AppPage[];

/** A page's own address, e.g. '/quotes'. The sidebar may only link to one of these. */
export type PagePath = `/${(typeof APP_PAGES)[number]['routes'][0]['path']}`;

const PAGES: readonly AppPage[] = APP_PAGES;

export const pagePath = (page: AppPage): string => `/${page.routes[0].path}`;

const PAGE_BY_PATH = new Map(PAGES.map((page) => [pagePath(page), page]));

/** Who may open the page at this address. */
export function rolesForPage(path: PagePath): readonly UserRole[] {
  const page = PAGE_BY_PATH.get(path);
  if (!page) throw new Error(`No page at ${path} in src/appPages.tsx`);
  return page.roles;
}
