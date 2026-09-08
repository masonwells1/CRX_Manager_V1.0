import { lazy, Suspense, useEffect, useRef } from 'react';
import { createBrowserRouter, RouterProvider, Navigate, Outlet, useLocation } from 'react-router-dom';
import { AuthProvider } from './contexts/AuthContext';
import { ToastProvider } from './components/ui/Toast';
import { BelowCostApprovalProvider } from './contexts/BelowCostApprovalContext';
import ErrorBoundary from './components/ErrorBoundary';
import LoginPage from './components/auth/LoginPage';
import ForgotPasswordPage from './components/auth/ForgotPasswordPage';
import ResetPasswordPage from './components/auth/ResetPasswordPage';
import ProtectedRoute from './components/auth/ProtectedRoute';
import RoleLanding from './components/auth/RoleLanding';
import AppLayout from './components/layout/AppLayout';
import { checkEnvVars, EnvErrorScreen } from './components/EnvCheck';
import { trackNavigation } from './lib/metrics';
import UpdatePrompt from './components/UpdatePrompt';

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
const DeliveryDetail = lazy(() => import('./pages/DeliveryDetail'));
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
const FieldApplicationInvoice = lazy(() => import('./pages/FieldApplicationInvoice'));
// Per-line split-billing editor — flag-gated (per_line_split_billing_enabled). The page
// self-gates on the flag (renders a "not enabled" notice when OFF), so the route is safe
// even by hand-typed URL; the nav link is only shown when the flag is ON.
const FieldAppSplitInvoiceEditor = lazy(() => import('./pages/FieldAppSplitInvoiceEditor'));
const ToShip = lazy(() => import('./pages/ToShip'));
// Design-system gallery — available on dev + preview hosts, hidden on the production domain.
const DesignPreview = lazy(() => import('./pages/DesignPreview'));
const SHOW_DESIGN_PREVIEW =
  import.meta.env.DEV ||
  (typeof window !== 'undefined' && !/(^|\.)croprxsolutions\.app$/.test(window.location.hostname));

// Simple loading spinner shown briefly while a page loads
function PageLoader() {
  return (
    <div className="flex items-center justify-center py-20">
      <div className="w-8 h-8 border-4 border-crx-green border-t-transparent rounded-full animate-spin" />
    </div>
  );
}

interface LegacyTabRedirectProps {
  to: string;
  tab: string;
}

function LegacyTabRedirect({ to, tab }: LegacyTabRedirectProps) {
  const { search } = useLocation();
  const params = new URLSearchParams(search);
  params.set('tab', tab);
  return <Navigate to={`${to}?${params.toString()}`} replace />;
}


/**
 * Headless component that records a Sentry navigation breadcrumb
 * every time the route changes.  Renders nothing.
 */
function NavigationTracker() {
  const location = useLocation();
  const isFirstRender = useRef(true);

  useEffect(() => {
    // Skip the initial mount — the page-load is already captured by Sentry
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    trackNavigation(location.pathname);
  }, [location.pathname]);

  return null;
}

// Wraps each route's lazy-loaded page so a crash on one page doesn't
// take down the sidebar or prevent navigating to other pages.
function RouteShell() {
  return (
    <ErrorBoundary inline>
      <Suspense fallback={<PageLoader />}>
        <Outlet />
      </Suspense>
    </ErrorBoundary>
  );
}

// Root layout that wraps all routes with providers
function RootLayout() {
  return (
    <AuthProvider>
      <ToastProvider>
        <BelowCostApprovalProvider>
          <UpdatePrompt />
          <ErrorBoundary>
            <NavigationTracker />
            <Suspense fallback={<PageLoader />}>
              <Outlet />
            </Suspense>
          </ErrorBoundary>
        </BelowCostApprovalProvider>
      </ToastProvider>
    </AuthProvider>
  );
}

const router = createBrowserRouter([
  // Dev-only design-system gallery — top-level (outside the auth provider) so it
  // renders standalone for visual verification. Excluded from production builds.
  ...(SHOW_DESIGN_PREVIEW
    ? [{ path: '/design-preview', element: <Suspense fallback={<PageLoader />}><DesignPreview /></Suspense> }]
    : []),
  {
    element: <RootLayout />,
    children: [
      { path: 'login', element: <LoginPage /> },
      { path: 'forgot-password', element: <ForgotPasswordPage /> },
      { path: 'reset-password', element: <ResetPasswordPage /> },
      {
        element: (
          <ProtectedRoute>
            <AppLayout />
          </ProtectedRoute>
        ),
        children: [{
          // RouteShell wraps all authenticated pages with an inline ErrorBoundary
          // so a crash on one page keeps the sidebar/nav functional.
          element: <RouteShell />,
          children: [
          // All authenticated roles
          { index: true, element: <RoleLanding /> },
          { path: 'dashboard', element: <Dashboard /> },
          { path: 'team-board', element: <TeamBoard /> },
          { path: 'notifications', element: <Notifications /> },
          { path: 'getting-started', element: <GettingStarted /> },

          // Admin + Sales Rep
          { path: 'products', element: <ProtectedRoute allowedRoles={['admin', 'sales_rep']}><Products /></ProtectedRoute> },
          { path: 'products/:id', element: <ProtectedRoute allowedRoles={['admin', 'sales_rep']}><ProductDetail /></ProtectedRoute> },
          { path: 'customers', element: <ProtectedRoute allowedRoles={['admin', 'sales_rep']}><Customers /></ProtectedRoute> },
          { path: 'customers/:id', element: <ProtectedRoute allowedRoles={['admin', 'sales_rep']}><CustomerDetail /></ProtectedRoute> },
          { path: 'call-lists', element: <ProtectedRoute allowedRoles={['admin', 'sales_rep']}><CallLists /></ProtectedRoute> },
          { path: 'fields', element: <ProtectedRoute allowedRoles={['admin', 'sales_rep']}><Fields /></ProtectedRoute> },
          { path: 'fields/:id', element: <ProtectedRoute allowedRoles={['admin', 'sales_rep']}><FieldSetup /></ProtectedRoute> },
          { path: 'fields/:id/dashboard', element: <ProtectedRoute allowedRoles={['admin', 'sales_rep']}><FieldDashboard /></ProtectedRoute> },
          { path: 'quotes', element: <ProtectedRoute allowedRoles={['admin', 'sales_rep']}><Quotes /></ProtectedRoute> },
          { path: 'quotes/new', element: <ProtectedRoute allowedRoles={['admin', 'sales_rep']}><QuoteBuilder /></ProtectedRoute> },
          { path: 'quotes/:id', element: <ProtectedRoute allowedRoles={['admin', 'sales_rep']}><QuoteBuilder /></ProtectedRoute> },
          { path: 'orders', element: <ProtectedRoute allowedRoles={['admin', 'sales_rep']}><Orders /></ProtectedRoute> },
          { path: 'orders/new', element: <ProtectedRoute allowedRoles={['admin', 'sales_rep']}><NewOrder /></ProtectedRoute> },
          { path: 'orders/:id', element: <ProtectedRoute allowedRoles={['admin', 'sales_rep']}><OrderDetail /></ProtectedRoute> },
          { path: 'to-ship', element: <ProtectedRoute allowedRoles={['admin', 'sales_rep']}><ToShip /></ProtectedRoute> },
          { path: 'inventory', element: <ProtectedRoute allowedRoles={['admin', 'sales_rep']}><InventoryPage /></ProtectedRoute> },
          { path: 'invoices', element: <ProtectedRoute allowedRoles={['admin', 'sales_rep']}><Invoices /></ProtectedRoute> },
          { path: 'invoices/field-app/new', element: <ProtectedRoute allowedRoles={['admin', 'sales_rep']}><FieldApplicationInvoice /></ProtectedRoute> },
          { path: 'invoices/field-app/:id', element: <ProtectedRoute allowedRoles={['admin', 'sales_rep']}><FieldApplicationInvoice /></ProtectedRoute> },
          { path: 'invoices/:id', element: <ProtectedRoute allowedRoles={['admin', 'sales_rep']}><InvoiceDetail routeArea="chemical" /></ProtectedRoute> },
          { path: 'field-invoices', element: <ProtectedRoute allowedRoles={['admin', 'sales_rep']}><FieldInvoices /></ProtectedRoute> },
          // Per-line split-billing editor (flag-gated; page self-gates on per_line_split_billing_enabled).
          { path: 'split-billing/new', element: <ProtectedRoute allowedRoles={['admin', 'sales_rep']}><FieldAppSplitInvoiceEditor /></ProtectedRoute> },
          // #H save-now/post-later: reopen a saved billing set (read-only review + Post).
          { path: 'split-billing/:id', element: <ProtectedRoute allowedRoles={['admin', 'sales_rep']}><FieldAppSplitInvoiceEditor /></ProtectedRoute> },
          // Kept for bookmarks; all workflow views now live as query-addressable tabs.
          { path: 'field-invoices/unposted', element: <ProtectedRoute allowedRoles={['admin', 'sales_rep']}><Navigate to="/field-invoices?tab=drafts" replace /></ProtectedRoute> },
          { path: 'field-invoices/posted', element: <ProtectedRoute allowedRoles={['admin', 'sales_rep']}><Navigate to="/field-invoices?tab=posted" replace /></ProtectedRoute> },
          { path: 'field-invoices/unbilled', element: <ProtectedRoute allowedRoles={['admin', 'sales_rep']}><Navigate to="/field-invoices?tab=unbilled" replace /></ProtectedRoute> },
          { path: 'field-invoices/summary', element: <ProtectedRoute allowedRoles={['admin', 'sales_rep']}><Navigate to="/field-invoices?tab=customer" replace /></ProtectedRoute> },
          // Field-invoice detail (job-built quantity invoices + posted field invoices)
          // reuses the generic invoice editor but under the field-invoices permission
          // (getPageKeyFromPath maps /field-invoices/* -> 'field-invoices'). #3 edit-path.
          { path: 'field-invoices/:id', element: <ProtectedRoute allowedRoles={['admin', 'sales_rep']}><InvoiceDetail routeArea="field" /></ProtectedRoute> },
          { path: 'blend-tickets', element: <ProtectedRoute allowedRoles={['admin', 'sales_rep']}><BlendTickets /></ProtectedRoute> },
          { path: 'blend-tickets/:id', element: <ProtectedRoute allowedRoles={['admin', 'sales_rep']}><BlendTicketDetail /></ProtectedRoute> },
          { path: 'recipes', element: <ProtectedRoute allowedRoles={['admin', 'sales_rep']}><BlendRecipes /></ProtectedRoute> },
          { path: 'cycle-counts', element: <ProtectedRoute allowedRoles={['admin']}><CycleCounts /></ProtectedRoute> },
          { path: 'returns', element: <ProtectedRoute allowedRoles={['admin', 'sales_rep']}><Returns /></ProtectedRoute> },
          { path: 'receiving', element: <ProtectedRoute allowedRoles={['admin', 'sales_rep']}><Receiving /></ProtectedRoute> },
          // Kept for bookmarks; the former pages now live as query-addressable tabs.
          { path: 'receiving-hub', element: <ProtectedRoute allowedRoles={['admin', 'sales_rep']}><Navigate to="/receiving?tab=hub" replace /></ProtectedRoute> },
          { path: 'receiving/quick', element: <ProtectedRoute allowedRoles={['admin', 'sales_rep']}><Navigate to="/receiving?tab=quick" replace /></ProtectedRoute> },
          { path: 'purchase-orders', element: <ProtectedRoute allowedRoles={['admin', 'sales_rep']}><PurchaseOrders /></ProtectedRoute> },
          { path: 'purchase-orders/new', element: <ProtectedRoute allowedRoles={['admin', 'sales_rep']}><NewPurchaseOrder /></ProtectedRoute> },
          { path: 'purchase-orders/:id', element: <ProtectedRoute allowedRoles={['admin', 'sales_rep']}><PurchaseOrderDetail /></ProtectedRoute> },
          { path: 'brand-vs-generic', element: <ProtectedRoute allowedRoles={['admin', 'sales_rep']}><BrandVsGeneric /></ProtectedRoute> },
          { path: 'reports', element: <ProtectedRoute allowedRoles={['admin', 'sales_rep']}><Reports /></ProtectedRoute> },
          { path: 'field-profitability', element: <ProtectedRoute allowedRoles={['admin', 'sales_rep']}><FieldProfitability /></ProtectedRoute> },
          { path: 'sales-reports', element: <ProtectedRoute allowedRoles={['admin', 'sales_rep']}><SalesReports /></ProtectedRoute> },
          { path: 'crop-programs', element: <ProtectedRoute allowedRoles={['admin', 'sales_rep']}><CropPrograms /></ProtectedRoute> },
          { path: 'payments', element: <ProtectedRoute allowedRoles={['admin', 'sales_rep']}><PaymentAllocation /></ProtectedRoute> },
          { path: 'payment-history', element: <ProtectedRoute allowedRoles={['admin']}><PaymentHistory /></ProtectedRoute> },
          { path: 'ar-aging', element: <ProtectedRoute allowedRoles={['admin']}><ARaging /></ProtectedRoute> },
          { path: 'compliance', element: <ProtectedRoute allowedRoles={['admin', 'sales_rep']}><Compliance /></ProtectedRoute> },
          { path: 'lot-trace', element: <ProtectedRoute allowedRoles={['admin', 'sales_rep']}><LotTrace /></ProtectedRoute> },
          { path: 'label-review', element: <ProtectedRoute allowedRoles={['admin']}><LabelReview /></ProtectedRoute> },
          { path: 'label-data-quality', element: <ProtectedRoute allowedRoles={['admin']}><LabelDataQuality /></ProtectedRoute> },
          { path: 'watchdog', element: <ProtectedRoute allowedRoles={['admin', 'sales_rep']}><WatchdogExceptions /></ProtectedRoute> },
          { path: 'offline-work-review', element: <ProtectedRoute allowedRoles={['admin', 'sales_rep']}><OfflineWorkReview /></ProtectedRoute> },
          { path: 'office-cockpit', element: <ProtectedRoute allowedRoles={['admin', 'sales_rep']}><OfficeCockpit /></ProtectedRoute> },
          { path: 'rebates', element: <ProtectedRoute allowedRoles={['admin']}><Rebates /></ProtectedRoute> },
          { path: 'vehicles', element: <ProtectedRoute allowedRoles={['admin']}><Vehicles /></ProtectedRoute> },
          { path: 'vehicles/:id', element: <ProtectedRoute allowedRoles={['admin']}><VehicleDetail /></ProtectedRoute> },
          { path: 'application-services', element: <ProtectedRoute allowedRoles={['admin']}><ApplicationServices /></ProtectedRoute> },
          { path: 'application-services/:id', element: <ProtectedRoute allowedRoles={['admin']}><ApplicationServiceDetail /></ProtectedRoute> },
          { path: 'application-records', element: <ProtectedRoute allowedRoles={['admin', 'sales_rep', 'applicator']}><ApplicationRecords /></ProtectedRoute> },
          { path: 'program-tracker', element: <ProtectedRoute allowedRoles={['admin', 'sales_rep']}><ProgramTracker /></ProtectedRoute> },
          { path: 'delivery-remainders', element: <ProtectedRoute allowedRoles={['admin', 'sales_rep']}><DeliveryRemainders /></ProtectedRoute> },

          // Admin + Sales Rep + Driver (drivers need delivery access)
          { path: 'deliveries', element: <ProtectedRoute allowedRoles={['admin', 'sales_rep', 'driver']}><Deliveries /></ProtectedRoute> },
          { path: 'deliveries/new', element: <ProtectedRoute allowedRoles={['admin', 'sales_rep']}><NewDelivery /></ProtectedRoute> },
          { path: 'deliveries/:id', element: <ProtectedRoute allowedRoles={['admin', 'sales_rep', 'driver']}><DeliveryDetail /></ProtectedRoute> },
          { path: 'my-route', element: <ProtectedRoute allowedRoles={['admin', 'sales_rep', 'driver']}><FieldRoute /></ProtectedRoute> },
          { path: 'my-route/:id', element: <ProtectedRoute allowedRoles={['admin', 'sales_rep', 'driver']}><FieldStop /></ProtectedRoute> },

          // Admin + Sales Rep + Applicator (applicators need job access)
          { path: 'jobs', element: <ProtectedRoute allowedRoles={['admin', 'sales_rep', 'applicator']}><Jobs /></ProtectedRoute> },
          { path: 'jobs/:id', element: <ProtectedRoute allowedRoles={['admin', 'sales_rep', 'applicator']}><JobDetailRoute /></ProtectedRoute> },
          { path: 'dispatch', element: <ProtectedRoute allowedRoles={['admin', 'sales_rep', 'applicator']}><DispatchBoard /></ProtectedRoute> },
          // Phone/mobile applicator field view (#38) — read-only "my jobs" cards.
          { path: 'field', element: <ProtectedRoute allowedRoles={['admin', 'sales_rep', 'applicator']}><FieldView /></ProtectedRoute> },

          // Admin only
          { path: 'supplier-pricing', element: <ProtectedRoute allowedRoles={['admin']}><SupplierPricing /></ProtectedRoute> },
          { path: 'financial-dashboard', element: <ProtectedRoute allowedRoles={['admin']}><FinancialDashboard /></ProtectedRoute> },
          { path: 'month-end', element: <ProtectedRoute allowedRoles={['admin']}><MonthEndClose /></ProtectedRoute> },
          { path: 'integrity', element: <ProtectedRoute allowedRoles={['admin']}><Integrity /></ProtectedRoute> },
          // Kept for bookmarks; the former pages now live as query-addressable tabs.
          { path: 'integrity-report', element: <ProtectedRoute allowedRoles={['admin']}><LegacyTabRedirect to="/integrity" tab="report" /></ProtectedRoute> },
          { path: 'integrity-cleanup', element: <ProtectedRoute allowedRoles={['admin']}><LegacyTabRedirect to="/integrity" tab="cleanup" /></ProtectedRoute> },
          { path: 'commission-payments', element: <ProtectedRoute allowedRoles={['admin']}><CommissionPayments /></ProtectedRoute> },
          { path: 'customer-transactions', element: <ProtectedRoute allowedRoles={['admin']}><CustomerTransactionReview /></ProtectedRoute> },
          { path: 'prepay', element: <ProtectedRoute allowedRoles={['admin']}><Prepay /></ProtectedRoute> },
          { path: 'prepayments', element: <ProtectedRoute allowedRoles={['admin']}><LegacyTabRedirect to="/prepay" tab="manager" /></ProtectedRoute> },
          { path: 'accounts-receivable', element: <ProtectedRoute allowedRoles={['admin']}><AccountsReceivable /></ProtectedRoute> },
          { path: 'prepay-workspace', element: <ProtectedRoute allowedRoles={['admin']}><LegacyTabRedirect to="/prepay" tab="workspace" /></ProtectedRoute> },
          { path: 'accounts-payable', element: <ProtectedRoute allowedRoles={['admin']}><AccountsPayable /></ProtectedRoute> },
          { path: 'accounts-payable/bills', element: <ProtectedRoute allowedRoles={['admin']}><VendorBills /></ProtectedRoute> },
          { path: 'accounts-payable/bills/new', element: <ProtectedRoute allowedRoles={['admin']}><NewVendorBill /></ProtectedRoute> },
          { path: 'accounts-payable/bills/:id', element: <ProtectedRoute allowedRoles={['admin']}><VendorBillDetail /></ProtectedRoute> },
          { path: 'vendors', element: <ProtectedRoute allowedRoles={['admin']}><Vendors /></ProtectedRoute> },
          { path: 'settings', element: <ProtectedRoute allowedRoles={['admin']}><SettingsPage /></ProtectedRoute> },

          // payment-allocation route removed — now served at /payments
          ],
        }],
      },
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
]);

export default function App() {
  const envCheck = checkEnvVars();

  if (!envCheck.isValid) {
    return <EnvErrorScreen missing={envCheck.missing} />;
  }

  return <RouterProvider router={router} />;
}
