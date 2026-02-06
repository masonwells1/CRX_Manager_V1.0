import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './contexts/AuthContext';
import { ToastProvider } from './components/ui/Toast';
import LoginPage from './components/auth/LoginPage';
import ProtectedRoute from './components/auth/ProtectedRoute';
import AppLayout from './components/layout/AppLayout';
import Dashboard from './pages/Dashboard';
import Products from './pages/Products';
import ProductDetail from './pages/ProductDetail';
import Customers from './pages/Customers';
import CustomerDetail from './pages/CustomerDetail';
import Quotes from './pages/Quotes';
import QuoteBuilder from './pages/QuoteBuilder';
import Orders from './pages/Orders';
import NewOrder from './pages/NewOrder';
import OrderDetail from './pages/OrderDetail';
import InventoryPage from './pages/InventoryPage';
import Deliveries from './pages/Deliveries';
import NewDelivery from './pages/NewDelivery';
import DeliveryDetail from './pages/DeliveryDetail';
import PurchaseOrders from './pages/PurchaseOrders';
import NewPurchaseOrder from './pages/NewPurchaseOrder';
import PurchaseOrderDetail from './pages/PurchaseOrderDetail';
import BrandVsGeneric from './pages/BrandVsGeneric';
import Reports from './pages/Reports';
import TeamBoard from './pages/TeamBoard';
import Notifications from './pages/Notifications';
import SettingsPage from './pages/SettingsPage';

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <ToastProvider>
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
        </ToastProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
