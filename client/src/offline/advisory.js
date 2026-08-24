import { V25_OFFLINE_CORE } from '../config/features.js';
import { getStation } from './station.js';
import { nativeStore } from './nativeStore.js';

// D11 — Offline-mode advisory toast (captain-originated, revised 2026-08-24).
//
// Trigger: the first time an active save occurs while offline.
// Fires ONCE per outage, survives app restarts via nativeStore, and resets
// when connection returns. Never fires on app open or background drain passes.
//
// Station 1 (Honor Pad X8B / Main tablet):
//   "You are offline. Keep creating orders on this tablet only — do not use the other device until the connection returns."
// Other stations (Secondary device):
//   "You are offline. Create orders on the main tablet only — do not use this device until the connection returns."

export const ADVISORY_KEY = 'v25.advisory_fired';

let memAdvisoryFired = false;

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    resetOfflineAdvisory().catch(() => {});
  });
}

/**
 * Returns whether the advisory toast has already fired for the current outage.
 */
export async function hasOfflineAdvisoryFired() {
  const stored = await nativeStore.getJson(ADVISORY_KEY).catch(() => null);
  return Boolean(stored || memAdvisoryFired);
}

/**
 * Resets the advisory toast latch so the next outage will trigger the advisory once again.
 */
export async function resetOfflineAdvisory() {
  memAdvisoryFired = false;
  await nativeStore.remove(ADVISORY_KEY).catch(() => {});
}

/**
 * Triggered on active save when offline.
 */
export function triggerOfflineAdvisory(opts = {}) {
  return triggerOfflineAdvisoryWith(opts, V25_OFFLINE_CORE);
}

/**
 * Core implementation with explicit enabled flag (enables testing both sides of D18).
 *
 * @param {object} opts
 * @param {Function} [opts.addToast] Toast dispatch function: addToast(message, type)
 * @param {number} [opts.stationNumber] Optional override for station number
 * @param {boolean} [enabled] Release switch override
 * @returns {Promise<boolean>} True if the advisory toast was fired, false if skipped/disabled
 */
export async function triggerOfflineAdvisoryWith({ addToast, stationNumber } = {}, enabled = V25_OFFLINE_CORE) {
  if (!enabled) return false;

  const alreadyFired = await hasOfflineAdvisoryFired();
  if (alreadyFired) return false;

  let station = stationNumber;
  if (station === undefined) {
    try {
      const info = await getStation();
      station = info?.station_number;
    } catch {
      station = null;
    }
  }

  const message = (station === 1)
    ? 'You are offline. Keep creating orders on this tablet only — do not use non-tablet device until connection is back.'
    : 'You are offline. Create orders on the main tablet only — do not use non-tablet device until connection is back.';

  memAdvisoryFired = true;
  await nativeStore.setJson(ADVISORY_KEY, true).catch(() => {});

  if (typeof addToast === 'function') {
    addToast(message, 'warning');
  }

  return true;
}

/**
 * Test seam to reset internal state.
 */
export async function __resetAdvisoryState() {
  memAdvisoryFired = false;
  await nativeStore.remove(ADVISORY_KEY).catch(() => {});
}
