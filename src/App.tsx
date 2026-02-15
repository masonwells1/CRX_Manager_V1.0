import { lazy, Suspense } from 'react';
import { createBrowserRouter, RouterProvider, Navigate, Outlet } from 'react-router-dom';
import { AuthProvider } from './contexts/AuthContext';
import { ToastProvider } from './components/ui/Toast';
import ErrorBoundary from './components/ErrorBoundary';
import LoginPage from './components/auth/LoginPage';
import ProtectedRoute from './components/auth/ProtectedRoute';
import AppLayout from './components/layout/AppLayout';
import { checkEnvVars, EnvErrorScreen } from './components/EnvCheck';

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
const Payments = lazy(() => import('./pages/Payments'));
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
const PaymentAllocation = lazy(() => import('./pages/PaymentAllocation'));

// Simple loading spinner shown briefly while a page loads
function PageLoader() {
  return (
    <div className="flex items-center justify-center py-20">
      <div className="w-8 h-8 border-4 border-crx-green border-t-transparent rounded-full animate-spin" />
    </div>
  );
}

// Root layout that wraps all routes with providers
function RootLayout() {
  return (
    <AuthProvider>
      <ToastProvider>
        <ErrorBoundary>
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
        children: [
          { index: true, element: <Dashboard /> },
          { path: 'products', element: <Products /> },
          { path: 'products/:id', element: <ProductDetail /> },
          { path: 'customers', element: <Customers /> },
          { path: 'customers/:id', element: <CustomerDetail /> },
          { path: 'fields', element: <Fields /> },
          { path: 'fields/:id', element: <FieldDetail /> },
          { path: 'quotes', element: <Quotes /> },
          { path: 'quotes/new', element: <QuoteBuilder /> },
          { path: 'quotes/:id', element: <QuoteBuilder /> },
          { path: 'orders', element: <Orders /> },
          { path: 'orders/new', element: <NewOrder /> },
          { path: 'orders/:id', element: <OrderDetail /> },
          { path: 'inventory', element: <InventoryPage /> },
          { path: 'deliveries', element: <Deliveries /> },
          { path: 'deliveries/new', element: <NewDelivery /> },
          { path: 'deliveries/:id', element: <DeliveryDetail /> },
          { path: 'invoices', element: <Invoices /> },
          { path: 'invoices/:id', element: <InvoiceDetail /> },
          { path: 'blend-tickets', element: <BlendTickets /> },
          { path: 'blend-tickets/:id', element: <BlendTicketDetail /> },
          { path: 'recipes', element: <BlendRecipes /> },
          { path: 'cycle-counts', element: <CycleCounts /> },
          { path: 'returns', element: <Returns /> },
          { path: 'purchase-orders', element: <PurchaseOrders /> },
          { path: 'purchase-orders/new', element: <NewPurchaseOrder /> },
          { path: 'purchase-orders/:id', element: <PurchaseOrderDetail /> },
          { path: 'brand-vs-generic', element: <BrandVsGeneric /> },
          { path: 'reports', element: <Reports /> },
          { path: 'crop-programs', element: <CropPrograms /> },
          { path: 'payments', element: <Payments /> },
          { path: 'ar-aging', element: <ARaging /> },
          { path: 'compliance', element: <Compliance /> },
          { path: 'rebates', element: <Rebates /> },
          { path: 'vehicles', element: <Vehicles /> },
          { path: 'vehicles/:id', element: <VehicleDetail /> },
          { path: 'application-records', element: <ApplicationRecords /> },
          { path: 'jobs', element: <Jobs /> },
          { path: 'jobs/:id', element: <JobDetail /> },
          { path: 'month-end', element: <ProtectedRoute allowedRoles={['admin']}><MonthEndClose /></ProtectedRoute> },
          { path: 'commission-payments', element: <ProtectedRoute allowedRoles={['admin']}><CommissionPayments /></ProtectedRoute> },
          { path: 'customer-transactions', element: <ProtectedRoute allowedRoles={['admin']}><CustomerTransactionReview /></ProtectedRoute> },
          { path: 'prepayments', element: <ProtectedRoute allowedRoles={['admin']}><PrepaymentManager /></ProtectedRoute> },
          { path: 'payment-allocation', element: <ProtectedRoute allowedRoles={['admin', 'sales_rep']}><PaymentAllocation /></ProtectedRoute> },
          { path: 'team-board', element: <TeamBoard /> },
          { path: 'notifications', element: <Notifications /> },
          { path: 'settings', element: <ProtectedRoute allowedRoles={['admin']}><SettingsPage /></ProtectedRoute> },
        ],
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
