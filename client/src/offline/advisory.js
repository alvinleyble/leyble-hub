import { V25_OFFLINE_CORE } from '../config/features';
import { getStation } from './station';

// D11 — Offline-mode advisory toast (captain-originated).
//
// Trigger: the first time an active save fails while someone is working.
// Fires ONCE per outage, never on every failed call, and never on app open or
// background drain.
//
// Station 1 (Honor Pad X8B / Main tablet):
//   "You are offline. Keep working here, and leave the other device alone until the connection returns."
// Other stations (Second device):
//   "You are offline. Use the main tablet if you can."

let advisoryFired = false;

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    resetOfflineAdvisory();
  });
}

/**
 * Returns whether the advisory toast has already fired for the current outage.
 */
export function hasOfflineAdvisoryFired() {
  return advisoryFired;
}

/**
 * Resets the advisory toast latch so the next outage will trigger the advisory once again.
 */
export function resetOfflineAdvisory() {
  advisoryFired = false;
}

/**
 * Triggered on active save failure when offline.
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
  if (advisoryFired) return false;

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
    ? 'You are offline. Keep working here, and leave the other device alone until the connection returns.'
    : 'You are offline. Use the main tablet if you can.';

  advisoryFired = true;

  if (typeof addToast === 'function') {
    addToast(message, 'warning');
  }

  return true;
}

/**
 * Test seam to reset internal state.
 */
export function __resetAdvisoryState() {
  advisoryFired = false;
}
