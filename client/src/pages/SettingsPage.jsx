import React from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import NavIcon from '../components/layout/NavIcon';
import SettingsList, { SETTINGS_SCREENS } from './settings/SettingsList';
import ProfileSection from './settings/ProfileSection';
import PrinterSection from './settings/PrinterSection';
import DeviceSection, { useDeviceReceiptSummary } from './settings/DeviceSection';
import SyncSection from './settings/SyncSection';
import AboutSection from './settings/AboutSection';

// Settings, reached from the hamburger menu. `/settings` is a list of rows — Profile,
// Printer, This device, Sync, About — and each opens on its own screen at
// `/settings/<id>` with a back control to the list. Everyone sees all of it; the app
// has no roles yet. Apart from the account switch and the printer choice, everything
// below Profile is read-only: it shows what printing, numbering and sync are doing
// without changing how they do it.
export default function SettingsPage() {
  const { section } = useParams();
  const { user } = useAuth();
  const receiptSummary = useDeviceReceiptSummary(user?.id);

  if (!section) {
    return (
      <SettingsList
        userName={user?.full_name || user?.email || ''}
        receiptSummary={receiptSummary}
      />
    );
  }

  const screen = SETTINGS_SCREENS.find((s) => s.id === section);
  if (!screen) return <Navigate to="/settings" replace />;

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <Link
        to="/settings"
        className="-ml-2 inline-flex min-h-[48px] items-center gap-1 rounded-lg px-2 text-base font-semibold text-blue-700
                   hover:bg-blue-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
        data-testid="settings-back"
      >
        <NavIcon name="chevronLeft" className="h-5 w-5" />
        Settings
      </Link>
      <h1 id="settings-screen-title" className="mt-1 mb-6 text-2xl font-bold text-slate-900">
        {screen.title}
      </h1>
      {section === 'profile' && <ProfileSection />}
      {section === 'printer' && <PrinterSection deviceSeries={receiptSummary?.series || null} />}
      {section === 'device' && <DeviceSection summary={receiptSummary} />}
      {section === 'sync' && <SyncSection />}
      {section === 'about' && <AboutSection />}
    </div>
  );
}
