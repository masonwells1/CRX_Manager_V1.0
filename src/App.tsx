import { lazy, Suspense, useEffect, useRef } from 'react';
import { createBrowserRouter, RouterProvider, Navigate, Outlet, useLocation } from 'react-router-dom';
import { AuthProvider } from './contexts/AuthContext';
import { ToastProvider } from './components/ui/Toast';
import ErrorBoundary from './components/ErrorBoundary';
import LoginPage from './components/auth/LoginPage';
import ProtectedRoute from './components/auth/ProtectedRoute';
import AppLayout from './components/layout/AppLayout';
import { checkEnvVars, EnvErrorScreen } from './components/EnvCheck';
import { trackNavigation } from './lib/metrics';
import UpdatePrompt from './components/UpdatePrompt';

// Lazy-loaded pages — each page is only downloaded when the user navigates to it
const Dashboard = lazy(() => import('./pages/Dashboard'));
const Products = lazy(() => import('./pages/Products'));
const ProductDetail = lazy(() => import('./pages/ProductDetail'));
const Customers = lazy(() => import('./pages/Customers'));
const CustomerDetail = lazy(() => import('./pages/CustomerDetail'));
const Quotes = lazy(() => import('./pages/Quotes'));
const QuoteBuilder = lazy(() => import('./pages/QuoteBuilder'));
const Orders = lazy(() => import('./pages/Orders'));
const NewOrder = lazy(() => import('./pages/NewOrder'));
const OrderDetail = lazy(() => import('./pages/OrderDetail'));
const InventoryPage = lazy(() => import('./pages/InventoryPage'));
const Deliveries = lazy(() => import('./pages/Deliveries'));
const NewDelivery = lazy(() => import('./pages/NewDelivery'));
const DeliveryDetail = lazy(() => import('./pages/DeliveryDetail'));
const PurchaseOrders = lazy(() => import('./pages/PurchaseOrders'));
const NewPurchaseOrder = lazy(() => import('./pages/NewPurchaseOrder'));
const PurchaseOrderDetail = lazy(() => import('./pages/PurchaseOrderDetail'));
const BrandVsGeneric = lazy(() => import('./pages/BrandVsGeneric'));
const Reports = lazy(() => import('./pages/Reports'));
const CropPrograms = lazy(() => import('./pages/CropPrograms'));
const TeamBoard = lazy(() => import('./pages/TeamBoard'));
const Notifications = lazy(() => import('./pages/Notifications'));
const SettingsPage = lazy(() => import('./pages/SettingsPage'));
// Payments.tsx removed — PaymentAllocation is now the sole payment page at /payments
const Fields = lazy(() => import('./pages/Fields'));
const FieldDetail = lazy(() => import('./pages/FieldDetail'));
const BlendTickets = lazy(() => import('./pages/BlendTickets').then(m => ({ default: m.BlendTickets })));
const BlendTicketDetail = lazy(() => import('./pages/BlendTicketDetail').then(m => ({ default: m.BlendTicketDetail })));
const Invoices = lazy(() => import('./pages/Invoices'));
const InvoiceDetail = lazy(() => import('./pages/InvoiceDetail'));
const BlendRecipes = lazy(() => import('./pages/BlendRecipes'));
const CycleCounts = lazy(() => import('./pages/CycleCounts'));
const Returns = lazy(() => import('./pages/Returns'));
const ARaging = lazy(() => import('./pages/ARaging'));
const Compliance = lazy(() => import('./pages/Compliance'));
const Rebates = lazy(() => import('./pages/Rebates'));
const Vehicles = lazy(() => import('./pages/Vehicles'));
const VehicleDetail = lazy(() => import('./pages/VehicleDetail'));
const ApplicationRecords = lazy(() => import('./pages/ApplicationRecords'));
const Jobs = lazy(() => import('./pages/Jobs'));
const JobDetail = lazy(() => import('./pages/JobDetail'));
const MonthEndClose = lazy(() => import('./pages/MonthEndClose'));
const CommissionPayments = lazy(() => import('./pages/CommissionPayments'));
const CustomerTransactionReview = lazy(() => import('./pages/CustomerTransactionReview'));
const PrepaymentManager = lazy(() => import('./pages/PrepaymentManager'));
const PrepayWorkspace = lazy(() => import('./pages/PrepayWorkspace'));
const PaymentAllocation = lazy(() => import('./pages/PaymentAllocation'));
const PaymentHistory = lazy(() => import('./pages/PaymentHistory'));
const DeliveryRemainders = lazy(() => import('./pages/DeliveryRemainders'));
const ReceivingLog = lazy(() => import('./pages/ReceivingLog'));
const QuickReceive = lazy(() => import('./pages/QuickReceive'));
const FinancialDashboard = lazy(() => import('./pages/FinancialDashboard'));
const AccountsPayable = lazy(() => import('./pages/AccountsPayable'));
const VendorBills = lazy(() => import('./pages/VendorBills'));
const NewVendorBill = lazy(() => import('./pages/NewVendorBill'));
const VendorBillDetail = lazy(() => import('./pages/VendorBillDetail'));
const SalesReports = lazy(() => import('./pages/SalesReports'));

// Simple loading spinner shown briefly while a page loads
function PageLoader() {
  return (
    <div className="flex items-center justify-center py-20">
      <div className="w-8 h-8 border-4 border-crx-green border-t-transparent rounded-full animate-spin" />
    </div>
  );
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
        <UpdatePrompt />
        <ErrorBoundary>
          <NavigationTracker />
          <Suspense fallback={<PageLoader />}>
            <Outlet />
          </Suspense>
        </ErrorBoundary>
      </ToastProvider>
    </AuthProvider>
  );
}

const router = createBrowserRouter([
  {
    element: <RootLayout />,
    children: [
      { path: 'login', element: <LoginPage /> },
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
          { index: true, element: <Dashboard /> },
          { path: 'team-board', element: <TeamBoard /> },
          { path: 'notifications', element: <Notifications /> },

          // Admin + Sales Rep
          { path: 'products', element: <ProtectedRoute allowedRoles={['admin', 'sales_rep']}><Products /></ProtectedRoute> },
          { path: 'products/:id', element: <ProtectedRoute allowedRoles={['admin', 'sales_rep']}><ProductDetail /></ProtectedRoute> },
          { path: 'customers', element: <ProtectedRoute allowedRoles={['admin', 'sales_rep']}><Customers /></ProtectedRoute> },
          { path: 'customers/:id', element: <ProtectedRoute allowedRoles={['admin', 'sales_rep']}><CustomerDetail /></ProtectedRoute> },
          { path: 'fields', element: <ProtectedRoute allowedRoles={['admin', 'sales_rep']}><Fields /></ProtectedRoute> },
          { path: 'fields/:id', element: <ProtectedRoute allowedRoles={['admin', 'sales_rep']}><FieldDetail /></ProtectedRoute> },
          { path: 'quotes', element: <ProtectedRoute allowedRoles={['admin', 'sales_rep']}><Quotes /></ProtectedRoute> },
          { path: 'quotes/new', element: <ProtectedRoute allowedRoles={['admin', 'sales_rep']}><QuoteBuilder /></ProtectedRoute> },
          { path: 'quotes/:id', element: <ProtectedRoute allowedRoles={['admin', 'sales_rep']}><QuoteBuilder /></ProtectedRoute> },
          { path: 'orders', element: <ProtectedRoute allowedRoles={['admin', 'sales_rep']}><Orders /></ProtectedRoute> },
          { path: 'orders/new', element: <ProtectedRoute allowedRoles={['admin', 'sales_rep']}><NewOrder /></ProtectedRoute> },
          { path: 'orders/:id', element: <ProtectedRoute allowedRoles={['admin', 'sales_rep']}><OrderDetail /></ProtectedRoute> },
          { path: 'inventory', element: <ProtectedRoute allowedRoles={['admin', 'sales_rep']}><InventoryPage /></ProtectedRoute> },
          { path: 'invoices', element: <ProtectedRoute allowedRoles={['admin', 'sales_rep']}><Invoices /></ProtectedRoute> },
          { path: 'invoices/:id', element: <ProtectedRoute allowedRoles={['admin', 'sales_rep']}><InvoiceDetail /></ProtectedRoute> },
          { path: 'blend-tickets', element: <ProtectedRoute allowedRoles={['admin', 'sales_rep']}><BlendTickets /></ProtectedRoute> },
          { path: 'blend-tickets/:id', element: <ProtectedRoute allowedRoles={['admin', 'sales_rep']}><BlendTicketDetail /></ProtectedRoute> },
          { path: 'recipes', element: <ProtectedRoute allowedRoles={['admin', 'sales_rep']}><BlendRecipes /></ProtectedRoute> },
          { path: 'cycle-counts', element: <ProtectedRoute allowedRoles={['admin']}><CycleCounts /></ProtectedRoute> },
          { path: 'returns', element: <ProtectedRoute allowedRoles={['admin', 'sales_rep']}><Returns /></ProtectedRoute> },
          { path: 'receiving', element: <ProtectedRoute allowedRoles={['admin', 'sales_rep']}><ReceivingLog /></ProtectedRoute> },
          { path: 'receiving/quick', element: <ProtectedRoute allowedRoles={['admin', 'sales_rep']}><QuickReceive /></ProtectedRoute> },
          { path: 'purchase-orders', element: <ProtectedRoute allowedRoles={['admin', 'sales_rep']}><PurchaseOrders /></ProtectedRoute> },
          { path: 'purchase-orders/new', element: <ProtectedRoute allowedRoles={['admin', 'sales_rep']}><NewPurchaseOrder /></ProtectedRoute> },
          { path: 'purchase-orders/:id', element: <ProtectedRoute allowedRoles={['admin', 'sales_rep']}><PurchaseOrderDetail /></ProtectedRoute> },
          { path: 'brand-vs-generic', element: <ProtectedRoute allowedRoles={['admin', 'sales_rep']}><BrandVsGeneric /></ProtectedRoute> },
          { path: 'reports', element: <ProtectedRoute allowedRoles={['admin', 'sales_rep']}><Reports /></ProtectedRoute> },
          { path: 'sales-reports', element: <ProtectedRoute allowedRoles={['admin', 'sales_rep']}><SalesReports /></ProtectedRoute> },
          { path: 'crop-programs', element: <ProtectedRoute allowedRoles={['admin', 'sales_rep']}><CropPrograms /></ProtectedRoute> },
          { path: 'payments', element: <ProtectedRoute allowedRoles={['admin', 'sales_rep']}><PaymentAllocation /></ProtectedRoute> },
          { path: 'payment-history', element: <ProtectedRoute allowedRoles={['admin']}><PaymentHistory /></ProtectedRoute> },
          { path: 'ar-aging', element: <ProtectedRoute allowedRoles={['admin']}><ARaging /></ProtectedRoute> },
          { path: 'compliance', element: <ProtectedRoute allowedRoles={['admin', 'sales_rep']}><Compliance /></ProtectedRoute> },
          { path: 'rebates', element: <ProtectedRoute allowedRoles={['admin']}><Rebates /></ProtectedRoute> },
          { path: 'vehicles', element: <ProtectedRoute allowedRoles={['admin']}><Vehicles /></ProtectedRoute> },
          { path: 'vehicles/:id', element: <ProtectedRoute allowedRoles={['admin']}><VehicleDetail /></ProtectedRoute> },
          { path: 'application-records', element: <ProtectedRoute allowedRoles={['admin', 'sales_rep', 'applicator']}><ApplicationRecords /></ProtectedRoute> },
          { path: 'delivery-remainders', element: <ProtectedRoute allowedRoles={['admin', 'sales_rep']}><DeliveryRemainders /></ProtectedRoute> },

          // Admin + Sales Rep + Driver (drivers need delivery access)
          { path: 'deliveries', element: <ProtectedRoute allowedRoles={['admin', 'sales_rep', 'driver']}><Deliveries /></ProtectedRoute> },
          { path: 'deliveries/new', element: <ProtectedRoute allowedRoles={['admin', 'sales_rep']}><NewDelivery /></ProtectedRoute> },
          { path: 'deliveries/:id', element: <ProtectedRoute allowedRoles={['admin', 'sales_rep', 'driver']}><DeliveryDetail /></ProtectedRoute> },

          // Admin + Sales Rep + Applicator (applicators need job access)
          { path: 'jobs', element: <ProtectedRoute allowedRoles={['admin', 'sales_rep', 'applicator']}><Jobs /></ProtectedRoute> },
          { path: 'jobs/:id', element: <ProtectedRoute allowedRoles={['admin', 'sales_rep', 'applicator']}><JobDetail /></ProtectedRoute> },

          // Admin only
          { path: 'financial-dashboard', element: <ProtectedRoute allowedRoles={['admin']}><FinancialDashboard /></ProtectedRoute> },
          { path: 'month-end', element: <ProtectedRoute allowedRoles={['admin']}><MonthEndClose /></ProtectedRoute> },
          { path: 'commission-payments', element: <ProtectedRoute allowedRoles={['admin']}><CommissionPayments /></ProtectedRoute> },
          { path: 'customer-transactions', element: <ProtectedRoute allowedRoles={['admin']}><CustomerTransactionReview /></ProtectedRoute> },
          { path: 'prepayments', element: <ProtectedRoute allowedRoles={['admin']}><PrepaymentManager /></ProtectedRoute> },
          { path: 'prepay-workspace', element: <ProtectedRoute allowedRoles={['admin']}><PrepayWorkspace /></ProtectedRoute> },
          { path: 'accounts-payable', element: <ProtectedRoute allowedRoles={['admin']}><AccountsPayable /></ProtectedRoute> },
          { path: 'accounts-payable/bills', element: <ProtectedRoute allowedRoles={['admin']}><VendorBills /></ProtectedRoute> },
          { path: 'accounts-payable/bills/new', element: <ProtectedRoute allowedRoles={['admin']}><NewVendorBill /></ProtectedRoute> },
          { path: 'accounts-payable/bills/:id', element: <ProtectedRoute allowedRoles={['admin']}><VendorBillDetail /></ProtectedRoute> },
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
