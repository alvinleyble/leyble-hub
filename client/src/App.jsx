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
import StationsPage from './pages/stations/StationsPage';
import { startOfflineCore, stopOfflineCore, useSyncGate } from './offline';

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
  // V2.5 (D1) — claim this device's station number once, then keep the outbox
  // draining in the background. A no-op unless the release switch is on (D18), and it
  // runs after sign-in because registration is an authenticated call.
  useEffect(() => {
    startOfflineCore();
    return stopOfflineCore;
  }, []);

  // Slice 3.2 — the ONE time a tablet is held up by a sync: its very first, when it
  // holds no catalogue at all and there is genuinely nothing to sell from. Only the
  // three small reference pulls gate it (products, customers, personnel); the order
  // history streams in behind an already-unlocked app, so nobody waits on years of
  // invoices. Every later login and reconnect is a delta and never reaches this.
  const sync = useSyncGate();
  if (sync.blocking) return <FirstSetupScreen />;

  return <Outlet />;
}

function FirstSetupScreen() {
  return (
    <div className="flex h-screen flex-col items-center justify-center gap-4 bg-slate-50 px-6 text-center">
      <Spinner size="lg" />
      <p className="text-lg font-semibold text-slate-800">Setting up this tablet</p>
      <p className="max-w-sm text-base text-slate-600">
        Copying the product list, customers and staff onto this device so it keeps working
        without internet. This happens once.
      </p>
    </div>
  );
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
          <Route path="/devices"      element={<StationsPage />} />
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
