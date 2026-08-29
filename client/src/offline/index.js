import { ensureStationRegistered, isRegistered } from './station.js';
import { drainOutbox, waitingCount } from './outbox.js';
import { resetOfflineAdvisory } from './advisory.js';
import { handleDrainCompletion } from './drainNotifier.js';
import { nativeStore } from './nativeStore.js';
import { runSync } from './sync.js';
import { screenProductMutations } from './productMutations.js';

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
export * from './sync.js';
export * from './queuedCustomers.js';
export * from './backOfficeCache.js';
export * from './reconcile.js';
export * from './productMutations.js';
export * from './deliveries.js';
export { nativeStore } from './nativeStore.js';

const DRAIN_INTERVAL_MS = 30_000;

// ADR 0016 — how often a device that already holds a slot re-asks the server whether it
// still does. Only ever costs one small request; a slot reassignment reaches a tablet
// that is left running within this window rather than at its next restart.
const RECONFIRM_INTERVAL_MS = 10 * 60_000;

let timer = null;
let lastConfirmedAt = 0;

/**
 * Called once the user is signed in and a profile is chosen.
 *
 * Claims a station number if this device does not have one (D1), kicks off this
 * login's sync (Slice 3.2), and starts the background drain. Registration failing is
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
    lastConfirmedAt = Date.now();
  } catch {
    // Offline, or the server refused. Retried on the next start and by the drain loop.
  }

  // ADR 0015 §4 replaced V2.5 D9's rolling 30-day window with "no age limit", so
  // pruneReceipts() is deliberately NOT called here any more — this is the line that
  // would otherwise delete the history the sync below spends its first setup pulling.
  //
  // Slice 3.2 — sync on login. Fire-and-forget: the app is not held up by it (a first
  // setup gates only its own reference pull, via useSyncGate in App.jsx), and a device
  // with no line yet simply syncs nothing and tries again on the next reconnect.
  runSync({ trigger: 'login' }).catch(() => {});

  async function runDrainPass() {
    try {
      // ADR 0015 §6 — nothing guarded is sent unscreened. A queued stock count or
      // price edit is checked against the server first, and any value another tablet
      // corrected in the meantime is lifted out into a question for a human rather
      // than quietly overwriting theirs. Offline this is a no-op and everything
      // simply stays queued.
      await screenProductMutations().catch(() => {});
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
      // gets its slot the moment the line returns. A device that already holds one
      // re-confirms on the slow cadence below — ADR 0016 makes the server authoritative
      // on who holds which slot, so a tablet whose slot was moved to its replacement has
      // to find out without waiting for a restart. Confirming on every 30s tick would be
      // a pointless request a minute; RECONFIRM_INTERVAL_MS is the compromise.
      isRegistered()
        .then((ok) => {
          if (!ok) return ensureStationRegistered({ label: effectiveLabel });
          if (Date.now() - lastConfirmedAt < RECONFIRM_INTERVAL_MS) return null;
          return ensureStationRegistered({ label: effectiveLabel })
            .then((station) => { lastConfirmedAt = Date.now(); return station; });
        })
        .catch(() => {})
        .then(runDrainPass)
        .catch(() => {});
    }, DRAIN_INTERVAL_MS);
    // G30 — Node Test Liveness: without unref(), this interval keeps `node --test`
    // runners alive indefinitely. No-op in a browser (timer is a plain number there).
    timer.unref?.();
  }

  // Nudge the drain whenever the browser/WebView says the line is back, rather than
  // waiting out the interval — and check in for anything that changed elsewhere while
  // we were blind. runSync throttles the reconnect trigger itself (Slice 3.2): a link
  // that flaps fires `online` repeatedly, and two of those inside 90s must cost one
  // sync, not two.
  if (typeof window !== 'undefined' && !startOfflineCore.listening) {
    startOfflineCore.listening = true;
    window.addEventListener('online', () => {
      runDrainPass();
      runSync({ trigger: 'reconnect' }).catch(() => {});
    });
  }

  return { enabled: true, waiting: await waitingCount() };
}

export function stopOfflineCore() {
  if (timer) { clearInterval(timer); timer = null; }
  lastConfirmedAt = 0;
}
