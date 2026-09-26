import React, { useEffect, useState } from 'react';
import { getDeviceReceiptSummary } from '../../offline/station';
import { subscribeOutbox } from '../../offline/outbox';
import SettingsSection, { SettingRow } from './SettingsSection';

// Reads who this device numbers receipts as for the signed-in person, and re-reads when
// a Save issues a number (every issued receipt lands in the outbox) or the account
// switches. Read-only: numbering is untouched.
export function useDeviceReceiptSummary(userId) {
  const [summary, setSummary] = useState(null);
  useEffect(() => {
    let alive = true;
    const load = () => {
      getDeviceReceiptSummary()
        .then((s) => { if (alive) setSummary(s); })
        .catch(() => { if (alive) setSummary({ series: null, lastReceiptNumber: null }); });
    };
    load();
    const unsubscribe = subscribeOutbox((event) => { if (event?.type === 'enqueue') load(); });
    return () => { alive = false; unsubscribe(); };
  }, [userId]);
  return summary;
}

export default function DeviceSection({ summary }) {
  return (
    <SettingsSection id="device" title="This device">
      {!summary ? (
        <p className="text-base text-slate-500">Loading…</p>
      ) : summary.series ? (
        <>
          <dl>
            <SettingRow label="Receipts from this device" testId="settings-device-series">
              {summary.series}
            </SettingRow>
            <SettingRow label="Last receipt" testId="settings-device-last-receipt">
              {summary.lastReceiptNumber || 'None yet'}
            </SettingRow>
          </dl>
          <p className="mt-2 text-base text-slate-600">
            Every receipt this device prints for you starts with {summary.series}.
          </p>
        </>
      ) : (
        <p className="text-base text-slate-700" data-testid="settings-device-unregistered">
          This device has no receipt number yet. Connect to the internet once while signed
          in and it will set itself up.
        </p>
      )}
    </SettingsSection>
  );
}
