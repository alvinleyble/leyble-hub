import React, { useState } from 'react';
import { Capacitor } from '@capacitor/core';
import Button from '../../components/ui/Button';
import { usePrinter } from '../../context/PrinterContext';
import SettingsSection, { SettingRow, AndroidOnlyNote } from './SettingsSection';

const TRANSPORT_LABELS = { bluetooth: 'Bluetooth', wifi: 'Wi-Fi' };

// Printer: the saved printer, Change printer (the same picker a first print opens) and
// Test print. Reads and drives PrinterContext only — nothing about how a receipt prints
// changes here. The browser build has no printer plugin, so it says so.
export default function PrinterSection({ native = Capacitor.isNativePlatform(), deviceSeries = null }) {
  return (
    <SettingsSection id="printer">
      {native ? (
        <ConnectedPrinterPanel deviceSeries={deviceSeries} />
      ) : (
        <AndroidOnlyNote testId="settings-printer-web-note">
          Printer setup is available in the Android app. In a browser, receipts print
          through the browser&rsquo;s own print window.
        </AndroidOnlyNote>
      )}
    </SettingsSection>
  );
}

function ConnectedPrinterPanel({ deviceSeries }) {
  const { savedPrinter, openPicker, printTestPage } = usePrinter();
  return (
    <PrinterPanel
      printer={savedPrinter}
      onChange={() => openPicker()}
      onTest={() => printTestPage({ deviceSeries })}
    />
  );
}

// The presentational half, so the native layout is testable without the plugin.
export function PrinterPanel({ printer, onChange, onTest }) {
  const [testing, setTesting] = useState(false);
  const saved = Boolean(printer?.address);

  const handleTest = async () => {
    setTesting(true);
    try { await onTest(); } finally { setTesting(false); }
  };

  return (
    <>
      {saved ? (
        <dl>
          <SettingRow label="Saved printer" testId="settings-printer-name">
            {printer.name || 'Printer'}
          </SettingRow>
          <SettingRow label="Connection" testId="settings-printer-connection">
            {TRANSPORT_LABELS[printer.type] || 'Bluetooth'}
            <span className="ml-2 font-mono text-base font-normal text-slate-500">
              {printer.type === 'wifi' ? `${printer.address}:${printer.port || 9100}` : printer.address}
            </span>
          </SettingRow>
        </dl>
      ) : (
        <p className="text-base text-slate-700" data-testid="settings-printer-none">
          No printer saved yet. The first receipt you print will ask you to choose one.
        </p>
      )}
      <div className="mt-4 flex flex-col gap-3 sm:flex-row">
        <Button
          variant="secondary"
          className="w-full sm:w-auto"
          onClick={onChange}
          data-testid="settings-printer-change"
        >
          {saved ? 'Change printer' : 'Choose printer'}
        </Button>
        {saved && (
          <Button
            variant="secondary"
            className="w-full sm:w-auto"
            onClick={handleTest}
            loading={testing}
            data-testid="settings-printer-test"
          >
            Test print
          </Button>
        )}
      </div>
    </>
  );
}
