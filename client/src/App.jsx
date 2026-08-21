import React from 'react';
import { Routes, Route, Navigate, Outlet } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import { ProfileProvider, useProfile } from './context/ProfileContext';
import { ToastProvider } from './components/ui/Toast';
import { PrinterProvider } from './context/PrinterContext';
import AppLayout from './components/layout/AppLayout';
import V2Shell from './components/layout/V2Shell';
import ProfilePickerModal from './components/profile/ProfilePickerModal';
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
import POSPage from './pages/pos/POSPage';
import InventoryV2Page from './pages/inventory/InventoryV2Page';
import CustomersV2Page from './pages/customers/CustomersV2Page';

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

  return (
    <ProfileProvider>
      <ProfileGate />
    </ProfileProvider>
  );
}

// Renders whichever shell the matched route asked for (V1 AppLayout or the V2
// tablet shell) underneath, overlaying the "who's using this" picker on top when
// no profile has been chosen yet — the app is never hidden behind a separate screen for it.
function ProfileGate() {
  const { needsPick, loading } = useProfile();
  return (
    <>
      <Outlet />
      {!loading && needsPick && <ProfilePickerModal />}
    </>
  );
}


function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />

      {/* All authenticated pages live inside ProtectedLayout */}
      <Route element={<ProtectedLayout />}>
        {/* V2 tablet shell — POS-first, 3 destinations. */}
        <Route path="/v2" element={<V2Shell />}>
          <Route index element={<Navigate to="/v2/pos" replace />} />
          <Route path="pos"       element={<POSPage />} />
          <Route path="inventory" element={<InventoryV2Page />} />
          <Route path="customers" element={<CustomersV2Page />} />
          <Route path="*"         element={<Navigate to="/v2/pos" replace />} />
        </Route>

        {/* V1 shell — every pre-existing route keeps its path, page and UI. */}
        <Route element={<AppLayout />}>
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
      </Route>
    </Routes>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <ToastProvider>
        <PrinterProvider>
          <AppRoutes />
        </PrinterProvider>
      </ToastProvider>
    </AuthProvider>
  );
}
