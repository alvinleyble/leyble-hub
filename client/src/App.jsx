import React, { useEffect } from 'react';
import { Routes, Route, Navigate, Outlet } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import { ToastProvider } from './components/ui/Toast';
import { PrinterProvider } from './context/PrinterContext';
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
import { startOfflineCore, stopOfflineCore, useSyncGate } from './offline';
import VersionGate from './components/version/VersionGate';
import FirstSetupGateScreen from './components/setup/FirstSetupGateScreen';

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

  return <AuthedShell />;
}

// The V1 shell for a signed-in user. ADR 0017 §5 removed the "who's using this" picker
// that used to overlay it: each person signs in with their own account, so the identity
// is settled by the time this renders.
function AuthedShell() {
  // V2.5 (D1) / ADR 0017 #2 — allocate this person's device letter once, then keep the
  // outbox draining in the background. It runs after sign-in because registration is an
  // authenticated call, and because the letter belongs to the account, not the tablet.
  useEffect(() => {
    startOfflineCore();
    return stopOfflineCore;
  }, []);

  // ADR 0019 — the ONE time a tablet is held up by a sync: its very first (or the
  // resume of one that was interrupted), when it does not yet hold the complete order
  // history required to work offline. Every later login and reconnect is a delta and
  // never reaches this gate — see useSyncGate's own doc in offline/sync.js.
  const sync = useSyncGate();
  if (sync.blocking) return <FirstSetupGateScreen />;

  return <Outlet />;
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />

      {/* All authenticated pages live inside ProtectedLayout */}
      <Route element={<ProtectedLayout />}>
        <Route index element={<Navigate to="/orders" replace />} />

        <Route element={<AppLayout />}>
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
          <VersionGate>
            <AppRoutes />
          </VersionGate>
        </PrinterProvider>
      </ToastProvider>
    </AuthProvider>
  );
}
