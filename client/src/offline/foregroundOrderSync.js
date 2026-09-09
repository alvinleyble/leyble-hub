import { App as CapacitorApp } from '@capacitor/app';
import { pollOrderDelta } from './sync.js';
import { startReachabilityWatcher, stopReachabilityWatcher } from './status.js';

// ADR 0019 — one consistent foreground cadence on every authenticated screen.
export const ORDER_POLL_INTERVAL_MS = 5_000;
export const ORDER_POLL_MAX_BACKOFF_MS = 60_000;

/**
 * Small scheduler kept separate from React so it lives for the signed-in app shell,
 * not for whichever orders screen happens to be mounted. The injected environment is
 * a test seam; production uses document/window/Capacitor App directly.
 */
export function createForegroundOrderPoller({
  poll = pollOrderDelta,
  intervalMs = ORDER_POLL_INTERVAL_MS,
  maxBackoffMs = ORDER_POLL_MAX_BACKOFF_MS,
  doc = typeof document !== 'undefined' ? document : null,
  win = typeof window !== 'undefined' ? window : null,
  capacitorApp = CapacitorApp,
  startRecovery = () => startReachabilityWatcher({ enabled: true }),
  stopRecovery = stopReachabilityWatcher,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  let timer = null;
  let stopped = true;
  let running = false;
  let wakePending = false;
  let browserVisible = !doc || doc.visibilityState !== 'hidden';
  let nativeActive = true;
  let failures = 0;
  let appListener = null;

  const foreground = () => browserVisible && nativeActive;

  const cancelTimer = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };

  const schedule = (delay) => {
    cancelTimer();
    if (stopped || !foreground()) return;
    timer = setTimer(tick, delay);
    timer?.unref?.();
  };

  async function tick() {
    timer = null;
    if (stopped || !foreground() || running) return;
    running = true;
    try {
      await poll();
      failures = 0;
      schedule(intervalMs);
    } catch {
      failures += 1;
      // This connection check is infrastructure, not marker UI, so it runs even in a
      // build where V25_OFFLINE_CORE only hides the marker. Its synthetic `online`
      // event wakes this scheduler the instant reachability is confirmed again.
      startRecovery();
      // Do not hammer an unreachable server every five seconds. The ordinary online
      // event (including status.js's lie-fi recovery event) calls wake immediately.
      schedule(Math.min(intervalMs * (2 ** failures), maxBackoffMs));
    } finally {
      running = false;
      if (wakePending) {
        wakePending = false;
        schedule(0);
      }
    }
  }

  const wake = () => {
    failures = 0;
    if (running) {
      wakePending = true;
      cancelTimer();
      return;
    }
    schedule(0);
  };

  const onVisibility = () => {
    browserVisible = doc.visibilityState !== 'hidden';
    if (browserVisible) wake();
    else {
      cancelTimer();
      stopRecovery();
    }
  };

  const onAppState = ({ isActive }) => {
    nativeActive = Boolean(isActive);
    if (nativeActive) wake();
    else {
      cancelTimer();
      stopRecovery();
    }
  };

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      doc?.addEventListener?.('visibilitychange', onVisibility);
      win?.addEventListener?.('online', wake);
      // addListener is promise-shaped in Capacitor 8. If stop wins this race, remove
      // the handle as soon as it arrives rather than leaving a process-wide listener.
      Promise.resolve(capacitorApp?.addListener?.('appStateChange', onAppState))
        .then((handle) => {
          if (stopped) handle?.remove?.();
          else appListener = handle;
        })
        .catch(() => {});
      schedule(intervalMs);
    },
    stop() {
      if (stopped) return;
      stopped = true;
      cancelTimer();
      doc?.removeEventListener?.('visibilitychange', onVisibility);
      win?.removeEventListener?.('online', wake);
      appListener?.remove?.();
      appListener = null;
      stopRecovery();
      failures = 0;
    },
    wake,
  };
}

let foregroundPoller = null;

export function startForegroundOrderSync() {
  if (!foregroundPoller) foregroundPoller = createForegroundOrderPoller();
  foregroundPoller.start();
}

export function stopForegroundOrderSync() {
  foregroundPoller?.stop();
  foregroundPoller = null;
}
