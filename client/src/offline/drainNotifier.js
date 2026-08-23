import { V25_OFFLINE_CORE } from '../config/features';
import { api } from '../api/client';
import { countDuplicateCustomers } from '../utils/duplicateCustomers';

// D4 — Post-drain notification after an outage.
//
// Tells them (4): one non-blocking toast when the outbox finishes draining
// after an outage:
//   "14 receipts synced · 2 customers may be duplicates"
// Once per outage recovery, never repeated.

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
 * Synchronous/direct drain complete notification with pre-supplied customers list.
 */
export function notifyDrainComplete(opts = {}) {
  return notifyDrainCompleteWith(opts, V25_OFFLINE_CORE);
}

/**
 * Core implementation with explicit enabled flag (for testing both sides of D18).
 */
export function notifyDrainCompleteWith(
  { sent = 0, waiting = 0, customers = [], addToast = globalToastHandler } = {},
  enabled = V25_OFFLINE_CORE
) {
  if (!enabled) return false;
  if (sent <= 0) return false;
  if (drainToastFired) return false;

  const duplicates = countDuplicateCustomers(customers);
  const receiptsStr = `${sent} ${sent === 1 ? 'receipt' : 'receipts'} synced`;
  const duplicatesStr = duplicates > 0
    ? ` · ${duplicates} ${duplicates === 1 ? 'customer' : 'customers'} may be duplicates`
    : '';

  const message = `${receiptsStr}${duplicatesStr}`;

  drainToastFired = true;

  if (typeof addToast === 'function') {
    addToast(message, 'info');
  }

  return { message, sent, duplicates };
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
  if (!enabled) return false;
  if (sent <= 0) return false;
  if (drainToastFired) return false;

  let customers = [];
  try {
    const data = await api.get('/customers');
    if (Array.isArray(data)) customers = data;
  } catch {
    // Network or parse issue; evaluate with empty customer list
  }

  return notifyDrainCompleteWith({ sent, waiting, customers, addToast }, enabled);
}

export function __resetDrainNotifierState() {
  drainToastFired = false;
  globalToastHandler = null;
}
