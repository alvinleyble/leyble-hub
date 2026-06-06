import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import { ToastProvider } from './components/ui/Toast';
import AppLayout from './components/layout/AppLayout';
import Spinner from './components/ui/Spinner';
import LoginPage from './pages/LoginPage';
import DashboardPage from './pages/DashboardPage';
import InventoryPage from './pages/inventory/InventoryPage';
import CustomersPage from './pages/customers/CustomersPage';
import PersonnelPage from './pages/personnel/PersonnelPage';
import OrdersPage from './pages/orders/OrdersPage';
import OrderDetailPage from './pages/orders/OrderDetailPage';
import IncomingPage from './pages/incoming/IncomingPage';
import TicketsPage from './pages/tickets/TicketsPage';
import AuditPage from './pages/audit/AuditPage';

// Layout route: guards all children behind auth check.
function ProtectedLayout() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-slate-50">
        <Spinner size="lg" />
      </div>
    );
  }

  if (!user) return <Navigate to="/login" replace />;

  return <AppLayout />;
}


function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />

      {/* All authenticated pages live inside ProtectedLayout */}
      <Route element={<ProtectedLayout />}>
        <Route index element={<Navigate to="/dashboard" replace />} />
        <Route path="/dashboard"    element={<DashboardPage />} />
        <Route path="/orders"         element={<OrdersPage />} />
        <Route path="/orders/:id"    element={<OrderDetailPage />} />
        <Route path="/inventory"    element={<InventoryPage />} />
        <Route path="/customers/*"  element={<CustomersPage />} />
        <Route path="/incoming"     element={<IncomingPage />} />
        <Route path="/personnel/*"  element={<PersonnelPage />} />
        <Route path="/tickets"      element={<TicketsPage />} />
        <Route path="/audit"        element={<AuditPage />} />
        <Route path="*"             element={<Navigate to="/dashboard" replace />} />
      </Route>
    </Routes>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <ToastProvider>
        <AppRoutes />
      </ToastProvider>
    </AuthProvider>
  );
}
