import { ensureStationRegistered, isRegistered } from './station.js';
import { drainOutbox, waitingCount } from './outbox.js';
import { pruneReceipts } from './receiptHistory.js';
import { resetOfflineAdvisory } from './advisory.js';
import { handleDrainCompletion } from './drainNotifier.js';
import { nativeStore } from './nativeStore.js';

// The V2.5 offline core's entry point. startOfflineCore() itself runs unconditionally
// (G30); individual UI surfaces (the marker, orderRef's receipt-number display) still
// read VITE_V25_OFFLINE_CORE on their own to decide what to show.

export * from './station.js';
export * from './outbox.js';
export * from './receiptHistory.js';
export * from './receiptNumbers.js';
export * from './posSave.js';
export * from './parkedOrders.js';
export * from './catalogue.js';
export * from './advisory.js';
export * from './status.js';
export * from './drainNotifier.js';
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
 *
 * G30 — Unconditional Engine Boot. Registration and the drain loop run in every
 * standard build, not only ones compiled with VITE_V25_OFFLINE_CORE=on: V1's rehosted
 * OrderCreateModal calls saveOrderLocalFirst() unconditionally (G27), so the engine
 * that actually issues receipt numbers and drains the outbox must be running
 * unconditionally too, in production Android builds included — the release switch
 * left gates UI surfaces (the marker, orderRef's display fallback), not the engine.
 */
export async function startOfflineCore({ label } = {}) {
  // G30 — Android Production Guard. A dev-only label (e.g. "dev — <hostname>") must
  // never reach a real station registration on a native Capacitor tablet — its WebView
  // origin is https://localhost, so an unguarded label would mislabel or clobber a
  // real store station's name. Labelling is a desktop-dev-only convenience (G2).
  const effectiveLabel = nativeStore.isNative ? undefined : label;

  try {
    await ensureStationRegistered({ label: effectiveLabel });
  } catch {
    // Offline, or the server refused. Retried on the next start and by the drain loop.
  }
  await pruneReceipts().catch(() => {});

  async function runDrainPass() {
    try {
      const res = await drainOutbox();
      if (res && res.sent > 0) {
        resetOfflineAdvisory();
        handleDrainCompletion(res).catch(() => {});
      }
    } catch {}
  }

  if (!timer && typeof setInterval === 'function') {
    timer = setInterval(() => {
      // Registration is retried here too: a device that installed during an outage
      // claims its station the moment the line returns.
      isRegistered()
        .then((ok) => (ok ? null : ensureStationRegistered({ label: effectiveLabel })))
        .catch(() => {})
        .then(runDrainPass)
        .catch(() => {});
    }, DRAIN_INTERVAL_MS);
    // G30 — Node Test Liveness: without unref(), this interval keeps `node --test`
    // runners alive indefinitely. No-op in a browser (timer is a plain number there).
    timer.unref?.();
  }

  // Nudge the drain whenever the browser/WebView says the line is back, rather than
  // waiting out the interval.
  if (typeof window !== 'undefined' && !startOfflineCore.listening) {
    startOfflineCore.listening = true;
    window.addEventListener('online', () => { runDrainPass(); });
  }

  return { enabled: true, waiting: await waitingCount() };
}

export function stopOfflineCore() {
  if (timer) { clearInterval(timer); timer = null; }
}
