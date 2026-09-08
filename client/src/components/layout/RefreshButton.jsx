import React, { useState, useCallback } from 'react';
import { probeReachability, checkIsOnline, markOnline, markOffline } from '../../offline/status.js';
import { drainOutbox, waitingCount } from '../../offline/outbox.js';
import { useToast } from '../ui/Toast.jsx';

/**
 * Header Refresh Button.
 * Placed beside OfflineMarker in mobile header and desktop sidebar.
 * Forces an immediate health check, triggers drain if records are waiting,
 * dispatches `leyble:refresh` for active screens, spins during check, and shows a status toast.
 */
export default function RefreshButton({ variant = 'v1' }) {
  const [spinning, setSpinning] = useState(false);
  const { addToast } = useToast();

  const handleRefresh = useCallback(async () => {
    if (spinning) return;
    setSpinning(true);
    const minSpinPromise = new Promise((resolve) => setTimeout(resolve, 400));
    try {
      // 1. Trigger checkIsOnline(true) from client/src/offline/status.js to force an immediate health probe.
      await probeReachability({ force: true }).catch(() => {});
      const online = checkIsOnline(true);
      if (online) markOnline();
      else markOffline();

      // 2. Trigger drainOutbox() from client/src/offline/outbox.js if there are waiting records.
      const count = await waitingCount().catch(() => 0);
      if (online && count > 0) {
        await drainOutbox().catch(() => {});
      }

      // 3. Dispatch window.dispatchEvent(new CustomEvent('leyble:refresh')) so active screens can reload their data.
      const Evt = (typeof window !== 'undefined' && window.CustomEvent) || (typeof CustomEvent !== 'undefined' && CustomEvent);
      if (typeof window !== 'undefined' && Evt) {
        window.dispatchEvent(new Evt('leyble:refresh', { detail: { online } }));
      }

      // 4. Ensure smooth spin animation doesn't immediately vanish
      await minSpinPromise;

      // 5. Provide a brief success toast
      if (online) {
        addToast('Connection refreshed · Online', 'success');
      } else {
        addToast('Refreshed · Offline mode', 'info');
      }
    } catch {
      await minSpinPromise;
      addToast('Refresh failed', 'error');
    } finally {
      setSpinning(false);
    }
  }, [spinning, addToast]);

  const ringClass = variant === 'v2' ? 'focus-visible:ring-v2-accent' : 'focus-visible:ring-blue-400';

  return (
    <button
      type="button"
      onClick={handleRefresh}
      disabled={spinning}
      aria-label="Refresh connection and sync"
      title="Refresh connection and sync"
      className={`inline-flex items-center justify-center w-8 h-8 rounded-full border border-slate-700 bg-slate-800 text-slate-300
                 hover:text-white hover:bg-slate-700 focus-visible:outline-none focus-visible:ring-2 ${ringClass}
                 transition-colors shrink-0 disabled:opacity-50`}
    >
      <svg
        className={`w-4 h-4 shrink-0 ${spinning ? 'animate-spin' : ''}`}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
        <path d="M21 3v5h-5" />
        <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
        <path d="M3 21v-5h5" />
      </svg>
    </button>
  );
}
