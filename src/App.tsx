import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './contexts/AuthContext';
import { ToastProvider } from './components/ui/Toast';
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
const TeamBoard = lazy(() => import('./pages/TeamBoard'));
const Notifications = lazy(() => import('./pages/Notifications'));
const SettingsPage = lazy(() => import('./pages/SettingsPage'));
const BlendTickets = lazy(() => import('./pages/BlendTickets').then(m => ({ default: m.BlendTickets })));
const BlendTicketDetail = lazy(() => import('./pages/BlendTicketDetail').then(m => ({ default: m.BlendTicketDetail })));

// Simple loading spinner shown briefly while a page loads
function PageLoader() {
  return (
    <div className="flex items-center justify-center py-20">
      <div className="w-8 h-8 border-4 border-crx-green border-t-transparent rounded-full animate-spin" />
    </div>
  );
}

export default function App() {
  const envCheck = checkEnvVars();

  if (!envCheck.isValid) {
    return <EnvErrorScreen missing={envCheck.missing} />;
  }

  return (
    <BrowserRouter>
      <AuthProvider>
        <ToastProvider>
          <Suspense fallback={<PageLoader />}>
            <Routes>
              <Route path="/login" element={<LoginPage />} />
              <Route
                element={
                  <ProtectedRoute>
                    <AppLayout />
                  </ProtectedRoute>
                }
              >
                <Route index element={<Dashboard />} />
                <Route path="products" element={<Products />} />
                <Route path="products/:id" element={<ProductDetail />} />
                <Route path="customers" element={<Customers />} />
                <Route path="customers/:id" element={<CustomerDetail />} />
                <Route path="quotes" element={<Quotes />} />
                <Route path="quotes/new" element={<QuoteBuilder />} />
                <Route path="quotes/:id" element={<QuoteBuilder />} />
                <Route path="orders" element={<Orders />} />
                <Route path="orders/new" element={<NewOrder />} />
                <Route path="orders/:id" element={<OrderDetail />} />
                <Route path="inventory" element={<InventoryPage />} />
                <Route path="deliveries" element={<Deliveries />} />
                <Route path="deliveries/new" element={<NewDelivery />} />
                <Route path="deliveries/:id" element={<DeliveryDetail />} />
                <Route path="blend-tickets" element={<BlendTickets />} />
                <Route path="blend-tickets/:id" element={<BlendTicketDetail />} />
                <Route path="purchase-orders" element={<PurchaseOrders />} />
                <Route path="purchase-orders/new" element={<NewPurchaseOrder />} />
                <Route path="purchase-orders/:id" element={<PurchaseOrderDetail />} />
                <Route path="brand-vs-generic" element={<BrandVsGeneric />} />
                <Route path="reports" element={<Reports />} />
                <Route path="team-board" element={<TeamBoard />} />
                <Route path="notifications" element={<Notifications />} />
                <Route path="settings" element={<ProtectedRoute allowedRoles={['admin']}><SettingsPage /></ProtectedRoute>} />
              </Route>
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Suspense>
        </ToastProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
