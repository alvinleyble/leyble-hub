import React, { useCallback, useState } from 'react';
import Spinner from '../ui/Spinner';
import Button from '../ui/Button';
import { useSyncGate, runSync } from '../../offline/sync.js';

/**
 * The ADR 0019 first-setup gate. Rendered instead of the app for as long as
 * `useSyncGate().blocking` is true: a brand-new tablet, or one whose first setup was
 * interrupted before the complete order history landed. Two truthful sub-states share
 * this one screen —
 *
 *   - actively downloading (`phase === 'setup'`): a phase-appropriate progress message,
 *     never a fake percentage (there is no reliable total to measure one against);
 *   - waiting for connection (`phase === 'idle'` while still blocking): the previous
 *     attempt was interrupted. It resumes automatically on the next login/reconnect,
 *     and Retry lets the operator ask for that resume right now instead of waiting.
 *
 * Later login, reconnect and foreground syncs never reach this screen once a device's
 * one first setup has actually finished — see useSyncGate's own doc in offline/sync.js.
 */
export default function FirstSetupGateScreen() {
  const sync = useSyncGate();
  const [retrying, setRetrying] = useState(false);

  const handleRetry = useCallback(() => {
    setRetrying(true);
    // 'login' is a deliberate trigger and is never throttled — the operator asked for
    // this resume right now. useSyncGate() re-renders reactively as runSync() publishes
    // progress; nothing here needs to await the result.
    runSync({ trigger: 'login' }).finally(() => setRetrying(false));
  }, []);

  const waiting = sync.phase !== 'setup' && !retrying;

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex h-screen flex-col items-center justify-center gap-4 bg-slate-50 px-6 text-center"
    >
      {waiting ? (
        <div className="rounded-full bg-amber-100 p-4 text-amber-600" aria-hidden="true">
          <svg className="h-10 w-10" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M18.364 5.636a9 9 0 11-12.728 0M12 3v9" />
          </svg>
        </div>
      ) : (
        <Spinner size="lg" />
      )}

      <p className="text-lg font-semibold text-slate-800">Setting up this tablet</p>

      {waiting ? (
        <>
          <p className="max-w-sm text-base text-slate-600">
            Setup was interrupted before the order history finished downloading. It will
            resume automatically once there is a connection, or tap Retry now.
          </p>
          <div className="mt-2">
            <Button variant="primary" size="lg" onClick={handleRetry} disabled={retrying}>
              Retry
            </Button>
          </div>
        </>
      ) : !sync.essentialsReady ? (
        <p className="max-w-sm text-base text-slate-600">
          Copying the product list, customers and staff onto this device.
        </p>
      ) : (
        <p className="max-w-sm text-base text-slate-600">
          Downloading the complete order history so this device keeps working without
          internet. This happens once.
          {sync.ordersSynced > 0 && (
            <>
              <br />
              {sync.ordersSynced} orders downloaded so far.
            </>
          )}
        </p>
      )}
    </div>
  );
}
