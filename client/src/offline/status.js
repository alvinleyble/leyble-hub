import { useState, useEffect, useCallback } from 'react';
import { V25_OFFLINE_CORE, isSimulatedOffline } from '../config/features.js';
import { waitingCount, listNeedsAttention, subscribeOutbox } from './outbox.js';

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
}

export function markOnline() {
  cachedOnline = true;
  lastProbeTime = Date.now();
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
    try {
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      let timer = null;
      if (controller && typeof setTimeout === 'function') {
        timer = setTimeout(() => controller.abort(), timeoutMs);
      }

      const res = await fetch(healthUrl, {
        method: 'GET',
        signal: controller?.signal,
        cache: 'no-store',
      });

      if (timer) clearTimeout(timer);
      cachedOnline = Boolean(res && res.ok);
    } catch {
      cachedOnline = false;
    } finally {
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
}
