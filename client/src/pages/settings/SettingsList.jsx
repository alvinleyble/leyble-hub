import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Capacitor } from '@capacitor/core';
import NavIcon from '../../components/layout/NavIcon';
import { usePrinter } from '../../context/PrinterContext';
import { getAppInfo } from '../../version/appVersion';

// The Settings screen itself: one row per sub-setting — icon, name, a one-line summary
// and a chevron. Tapping a row opens that sub-setting on its own screen
// (/settings/<id>); nothing is expanded here.
export const SETTINGS_SCREENS = [
  { id: 'profile', title: 'Profile',     icon: 'profile' },
  { id: 'printer', title: 'Printer',     icon: 'printer' },
  { id: 'device',  title: 'This device', icon: 'device' },
  { id: 'about',   title: 'About',       icon: 'about' },
];

function useAboutSummary(native) {
  const [summary, setSummary] = useState(native ? '' : 'Shown in the Android app');
  useEffect(() => {
    if (!native) return undefined;
    let alive = true;
    getAppInfo()
      .then((info) => { if (alive && info) setSummary(`Version ${info.version} · build ${info.build}`); })
      .catch(() => {});
    return () => { alive = false; };
  }, [native]);
  return summary;
}

// Only the native build has a printer plugin to ask; kept in its own component so the
// web list never reaches for PrinterContext.
function SavedPrinterName() {
  const { savedPrinter } = usePrinter();
  return savedPrinter?.address ? (savedPrinter.name || 'Printer') : 'Not set';
}

export default function SettingsList({
  userName, receiptSummary, native = Capacitor.isNativePlatform(),
}) {
  const about = useAboutSummary(native);

  const summaries = {
    profile: userName,
    printer: native ? <SavedPrinterName /> : 'Set up in the Android app',
    device: !receiptSummary ? '' : (receiptSummary.series || 'Not set up yet'),
    about,
  };

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <h1 className="text-2xl font-bold text-slate-900 mb-6">Settings</h1>
      <nav aria-label="Settings">
        <ul className="divide-y divide-slate-200 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
          {SETTINGS_SCREENS.map(({ id, title, icon }) => (
            <li key={id}>
              <Link
                to={`/settings/${id}`}
                className="flex min-h-[72px] items-center gap-4 px-5 py-3 hover:bg-slate-50 active:bg-slate-100
                           focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-600"
                data-testid={`settings-row-${id}`}
              >
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-blue-50 text-blue-700">
                  <NavIcon name={icon} className="h-6 w-6" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-lg font-semibold text-slate-900">{title}</span>
                  <span className="block truncate text-base text-slate-600" data-testid={`settings-row-${id}-summary`}>
                    {summaries[id]}
                  </span>
                </span>
                <NavIcon name="chevronRight" className="h-5 w-5 shrink-0 text-slate-400" />
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}
