import { V25_OFFLINE_CORE } from '../config/features';
import { api } from '../api/client';
import { countDuplicateCustomers } from '../utils/duplicateCustomers';
import { countPossibleDoubleOrders } from '../utils/duplicateOrders';

// D4 — Post-drain notification after an outage.
//
// Tells them (4): one non-blocking toast when the outbox finishes draining
// after an outage:
//   "14 receipts synced · 2 customers may be duplicates"
// Once per outage recovery, never repeated.
//
// D6 reuses this exact pattern for a possibly-doubled parked order — same toast,
// same once-per-outage rule, one more clause appended when there is something to
// say: "14 receipts synced · 2 customers may be duplicates · 2 orders may be doubled".

let drainToastFired = false;
let globalToastHandler = null;

export function registerToastHandler(handler) {
  globalToastHandler = handler;
  return () => {
    if (globalToastHandler === handler) globalToastHandler = null;
  };
}

export function resetDrainToastLatch() {
  drainToastFired = false;
}

export function hasDrainToastFired() {
  return drainToastFired;
}

/**
 * G27 — silent background sync. Screens like OrderDetailPage listen for this to
 * silently re-read their record once something has actually synced, with no
 * spinner and no toast of their own. Must fire on every drain that sends
 * something, independent of both the `V25_OFFLINE_CORE` flag (Round 2 Fix 1:
 * this is a sync mechanism, not a display concern, so unlike the marker/orderRef
 * fallback it must not be flag-gated) and the once-per-outage toast latch below —
 * a screen showing "Waiting to sync" needs to know about every drain that might
 * concern it, not just the first one after an outage.
 */
function dispatchDrainCompleteEvent(sent, waiting) {
  if (typeof window !== 'undefined' && typeof window.CustomEvent === 'function' && sent > 0) {
    // Use window's own CustomEvent constructor, not the bare global — under jsdom
    // (this app's test harness) `window` is a separate realm from Node's global
    // CustomEvent, and jsdom's dispatchEvent rejects an event built with the wrong one.
    window.dispatchEvent(new window.CustomEvent('leyble:drain-complete', { detail: { sent, waiting } }));
  }
}

/**
 * Synchronous/direct drain complete notification with pre-supplied customers list.
 */
export function notifyDrainComplete(opts = {}) {
  return notifyDrainCompleteWith(opts, V25_OFFLINE_CORE);
}

/**
 * Core implementation with explicit enabled flag (for testing both sides of D18).
 */
export function notifyDrainCompleteWith(
  { sent = 0, waiting = 0, customers = [], orders = [], addToast = globalToastHandler } = {},
  enabled = V25_OFFLINE_CORE,
  { skipDispatch = false } = {}
) {
  if (!skipDispatch) dispatchDrainCompleteEvent(sent, waiting);

  if (!enabled) return false;
  if (sent <= 0) return false;
  if (drainToastFired) return false;

  const duplicates = countDuplicateCustomers(customers);
  const doubles = countPossibleDoubleOrders(orders);
  const receiptsStr = `${sent} ${sent === 1 ? 'receipt' : 'receipts'} synced`;
  const duplicatesStr = duplicates > 0
    ? ` · ${duplicates} ${duplicates === 1 ? 'customer' : 'customers'} may be duplicates`
    : '';
  const doublesStr = doubles > 0
    ? ` · ${doubles} ${doubles === 1 ? 'order' : 'orders'} may be doubled`
    : '';

  const message = `${receiptsStr}${duplicatesStr}${doublesStr}`;

  drainToastFired = true;

  if (typeof addToast === 'function') {
    addToast(message, 'info');
  }

  return { message, sent, duplicates, doubles };
}

/**
 * Asynchronously handles drain completion by fetching customers to evaluate duplicates.
 */
export async function handleDrainCompletion(opts = {}) {
  return handleDrainCompletionWith(opts, V25_OFFLINE_CORE);
}

export async function handleDrainCompletionWith(
  { sent = 0, waiting = 0, addToast = globalToastHandler } = {},
  enabled = V25_OFFLINE_CORE
) {
  if (sent <= 0) return false;

  // Round 2 Fix 1: this is the function the real drain path actually calls
  // (see offline/index.js). Dispatch before the enabled/latch gates below —
  // those gates are for the duplicate-detection toast only, and must not also
  // suppress the sync signal screens rely on to leave "Waiting to sync".
  dispatchDrainCompleteEvent(sent, waiting);

  if (!enabled) return false;
  if (drainToastFired) return false;

  let customers = [];
  try {
    const data = await api.get('/customers');
    if (Array.isArray(data)) customers = data;
  } catch {
    // Network or parse issue; evaluate with empty customer list
  }

  let orders = [];
  try {
    const data = await api.get('/orders?status=pending');
    if (Array.isArray(data)) orders = data;
  } catch {
    // Network or parse issue; evaluate with empty order list
  }

  return notifyDrainCompleteWith({ sent, waiting, customers, orders, addToast }, enabled, { skipDispatch: true });
}

export function __resetDrainNotifierState() {
  drainToastFired = false;
  globalToastHandler = null;
}
