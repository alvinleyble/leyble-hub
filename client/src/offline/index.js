import { V25_OFFLINE_CORE } from '../config/features.js';
import { ensureStationRegistered, isRegistered } from './station.js';
import { drainOutbox, waitingCount } from './outbox.js';
import { pruneReceipts } from './receiptHistory.js';

// The V2.5 offline core's entry point. Everything here is a no-op unless the release
// switch is on (D18), so with the switch off the app behaves exactly as it does today.

export * from './station.js';
export * from './outbox.js';
export * from './receiptHistory.js';
export * from './receiptNumbers.js';
export * from './posSave.js';
export { nativeStore } from './nativeStore.js';

const DRAIN_INTERVAL_MS = 30_000;

let timer = null;

/**
 * Called once the user is signed in and a profile is chosen.
 *
 * Claims a station number if this device does not have one (D1), prunes the local
 * history past 30 days (D9), and starts the background drain. Registration failing is
 * not an error worth surfacing here: a device that is offline simply has not registered
 * yet, and a brand-new device installed during an outage cannot issue receipts at all —
 * an accepted corner, covered by paper.
 */
export async function startOfflineCore({ label } = {}) {
  if (!V25_OFFLINE_CORE) return { enabled: false };

  try {
    await ensureStationRegistered({ label });
  } catch {
    // Offline, or the server refused. Retried on the next start and by the drain loop.
  }
  await pruneReceipts().catch(() => {});

  if (!timer && typeof setInterval === 'function') {
    timer = setInterval(() => {
      // Registration is retried here too: a device that installed during an outage
      // claims its station the moment the line returns.
      isRegistered()
        .then((ok) => (ok ? null : ensureStationRegistered({ label })))
        .catch(() => {})
        .then(() => drainOutbox())
        .catch(() => {});
    }, DRAIN_INTERVAL_MS);
  }

  // Nudge the drain whenever the browser/WebView says the line is back, rather than
  // waiting out the interval.
  if (typeof window !== 'undefined' && !startOfflineCore.listening) {
    startOfflineCore.listening = true;
    window.addEventListener('online', () => { drainOutbox().catch(() => {}); });
  }

  return { enabled: true, waiting: await waitingCount() };
}

export function stopOfflineCore() {
  if (timer) { clearInterval(timer); timer = null; }
}
