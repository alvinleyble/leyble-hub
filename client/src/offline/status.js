import { useState, useEffect, useCallback } from 'react';
import { V25_OFFLINE_CORE, isSimulatedOffline } from '../config/features.js';
import { waitingCount, listNeedsAttention, subscribeOutbox, drainOutbox } from './outbox.js';

// D7 / Reachability — Genuine server reachability check (captain revised 2026-08-24).
//
// "Online" must mean the server is genuinely reachable via GET /health.
// - navigator.onLine === false short-circuits immediately without probing.
// - Probe cached for 30s in steady state (not hammered every 5s).
// - Probed immediately on 'online' event and before interactive save.
// - Failed drain attempt marks offline immediately.
// - With V25_OFFLINE_CORE off, no probing happens.
// - Never logs out, never surfaces errors.

const PROBE_TTL_MS = 30_000;
const PROBE_TIMEOUT_MS = 2_500;

let cachedOnline = true;
let lastProbeTime = 0;
let inFlightProbe = null;

export function markOffline() {
  cachedOnline = false;
  lastProbeTime = Date.now();
  startReachabilityWatcher();
}

export function markOnline() {
  cachedOnline = true;
  lastProbeTime = Date.now();
  stopReachabilityWatcher();
}

// ── Lie-Fi recovery watcher ──────────────────────────────────────────────────
//
// markOffline() can now fire from a hung request (client.js's timeout abort) with no
// screen necessarily mounted to notice the line coming back — useOfflineStatus's own
// polling only runs while some component using the hook is on screen. This runs
// independently of any screen: a lightweight GET /health every RECOVERY_INTERVAL_MS
// while offline, self-stopping the moment it succeeds (or the moment anything else
// marks the app online first).

const RECOVERY_INTERVAL_MS = 7_000;
const RECOVERY_PROBE_TIMEOUT_MS = 2_000;

let recoveryTimer = null;
let recoveryInFlight = false;

async function attemptRecovery(enabled) {
  // probeReachability already de-dupes concurrent calls via its own in-flight guard,
  // but this flag also skips scheduling a redundant call in the first place.
  if (recoveryInFlight) return;
  recoveryInFlight = true;
  try {
    const reachable = await probeReachability({ force: true, timeoutMs: RECOVERY_PROBE_TIMEOUT_MS, enabled });
    if (reachable) {
      markOnline();
      // A genuine 'online' event, not a bespoke one — so every existing listener for it
      // (this file's own useOfflineStatus hook, offline/index.js's reconnect sync) fires
      // exactly as it would for the browser's own transition, even though navigator.onLine
      // never flipped (that's the Lie-Fi case: the interface stayed up throughout).
      if (typeof window !== 'undefined' && typeof window.CustomEvent === 'function') {
        window.dispatchEvent(new window.CustomEvent('online'));
      }
      drainOutbox().catch(() => {});
    }
  } catch {
    // probeReachability catches internally and never rejects, but a probe failure must
    // never wedge this loop — the next tick simply tries again.
  } finally {
    recoveryInFlight = false;
  }
}

/**
 * Starts the periodic reachability probe that watches for the line coming back while
 * offline. Idempotent (a second call while already running is a no-op) and self-stops
 * once reachability is confirmed. `enabled`/`intervalMs` are test seams — production
 * callers (markOffline, above) rely on the defaults.
 */
export function startReachabilityWatcher({
  enabled = V25_OFFLINE_CORE, intervalMs = RECOVERY_INTERVAL_MS,
} = {}) {
  if (!enabled) return;
  if (recoveryTimer || typeof setInterval !== 'function') return;
  recoveryTimer = setInterval(() => {
    if (cachedOnline) {
      // Recovered through some other path (the browser's own 'online' event, an
      // interactive save's own probe) — nothing left for this loop to do.
      stopReachabilityWatcher();
      return;
    }
    attemptRecovery(enabled).catch(() => {});
  }, intervalMs);
  // G30-style Node test liveness: without unref(), this interval keeps `node --test`
  // runners alive indefinitely. No-op in a browser (the timer is a plain number there).
  recoveryTimer.unref?.();
}

export function stopReachabilityWatcher() {
  if (recoveryTimer) {
    clearInterval(recoveryTimer);
    recoveryTimer = null;
  }
}

/**
 * Executes a fast reachability probe to GET /health (or /api/v1/health).
 */
export async function probeReachability({ force = false, timeoutMs = PROBE_TIMEOUT_MS, enabled = V25_OFFLINE_CORE } = {}) {
  if (isSimulatedOffline()) {
    cachedOnline = false;
    return false;
  }
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    cachedOnline = false;
    return false;
  }
  if (!enabled) {
    return typeof navigator !== 'undefined' && typeof navigator.onLine === 'boolean'
      ? navigator.onLine
      : true;
  }

  const now = Date.now();
  if (!force && (now - lastProbeTime < PROBE_TTL_MS) && inFlightProbe === null) {
    return cachedOnline;
  }

  if (inFlightProbe) return inFlightProbe;

  const baseUrl = typeof import.meta !== 'undefined' && import.meta.env?.VITE_API_URL
    ? import.meta.env.VITE_API_URL
    : '';
  const healthUrl = `${baseUrl}/health`;

  inFlightProbe = (async () => {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    let timer = null;
    if (controller && typeof setTimeout === 'function') {
      timer = setTimeout(() => controller.abort(), timeoutMs);
    }
    try {
      const res = await fetch(healthUrl, {
        method: 'GET',
        signal: controller?.signal,
        cache: 'no-store',
      });
      cachedOnline = Boolean(res && res.ok);
    } catch {
      cachedOnline = false;
    } finally {
      // Must run on the failure path too — a rejected fetch (the common case while
      // genuinely offline) used to leave this timer running for the full timeoutMs on
      // every single probe, which the recovery watcher now fires every few seconds.
      if (timer) clearTimeout(timer);
      lastProbeTime = Date.now();
      inFlightProbe = null;
    }
    return cachedOnline;
  })();

  return inFlightProbe;
}

/**
 * Instant synchronous check returning current cached status.
 */
export function checkIsOnline(enabled = V25_OFFLINE_CORE) {
  if (isSimulatedOffline()) return false;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return false;
  if (!enabled) {
    return typeof navigator !== 'undefined' && typeof navigator.onLine === 'boolean'
      ? navigator.onLine
      : true;
  }
  return cachedOnline;
}

/**
 * Live React hook for offline & outbox queue state.
 */
export function useOfflineStatus() {
  const [isOnline, setIsOnline] = useState(() => checkIsOnline(V25_OFFLINE_CORE));
  const [waiting, setWaiting] = useState(0);
  const [needsAttention, setNeedsAttention] = useState(0);

  const refresh = useCallback(async () => {
    if (!V25_OFFLINE_CORE) {
      setIsOnline(checkIsOnline(false));
      return;
    }

    // Check reachability if TTL expired
    if (Date.now() - lastProbeTime >= PROBE_TTL_MS) {
      await probeReachability().catch(() => {});
    }
    setIsOnline(checkIsOnline(true));

    try {
      const [wCount, attn] = await Promise.all([
        waitingCount(),
        listNeedsAttention(),
      ]);
      setWaiting(wCount);
      setNeedsAttention(attn.length);
    } catch {
      // Ignore reading errors
    }
  }, []);

  useEffect(() => {
    refresh();

    const handleOnline = async () => {
      await probeReachability({ force: true }).catch(() => {});
      setIsOnline(checkIsOnline(V25_OFFLINE_CORE));
      refresh();
    };

    const handleOffline = () => {
      markOffline();
      setIsOnline(false);
      refresh();
    };

    if (typeof window !== 'undefined') {
      window.addEventListener('online', handleOnline);
      window.addEventListener('offline', handleOffline);
    }

    const unsubscribe = subscribeOutbox(() => {
      refresh();
    });

    const interval = setInterval(refresh, 5000);

    return () => {
      if (typeof window !== 'undefined') {
        window.removeEventListener('online', handleOnline);
        window.removeEventListener('offline', handleOffline);
      }
      unsubscribe();
      clearInterval(interval);
    };
  }, [refresh]);

  return {
    isOnline,
    waitingCount: waiting,
    needsAttentionCount: needsAttention,
    refresh,
  };
}

export function __resetStatusState() {
  cachedOnline = true;
  lastProbeTime = 0;
  inFlightProbe = null;
  stopReachabilityWatcher();
  recoveryInFlight = false;
}
