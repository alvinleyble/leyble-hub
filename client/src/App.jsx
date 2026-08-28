import React, { useEffect } from 'react';
import { Routes, Route, Navigate, Outlet } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import { ProfileProvider, useProfile } from './context/ProfileContext';
import { ToastProvider } from './components/ui/Toast';
import { PrinterProvider } from './context/PrinterContext';
import AppLayout from './components/layout/AppLayout';
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

  return (
    <ProfileProvider>
      <ProfileGate />
    </ProfileProvider>
  );
}

// Renders the V1 shell underneath, overlaying the "who's using this" picker on
// top when no profile has been chosen yet — the app is never hidden behind a
// separate screen for it.
function ProfileGate() {
  const { needsPick, loading } = useProfile();

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

  return (
    <>
      <Outlet />
      {!loading && needsPick && <ProfilePickerModal />}
    </>
  );
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
