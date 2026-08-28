// Native-storage key layout for the V2.5 offline core (D17).
//
// Everything the device owns sits under one prefix, and NOTHING under that prefix is
// session state. D15: waiting receipts, the local receipt history and the station
// number survive logout and re-login — they belong to the tablet, not to whoever is
// signed in. The logout path in client/src/api/client.js clears `authToken` and
// `activeProfile` by name and must never be widened to a prefix sweep.
export const NS = 'v25.';

export const SESSION_KEY  = `${NS}session`;   // { id, email, full_name, role }
export const STATION_KEY  = `${NS}station`;   // { station_number, device_key, registered_at }
export const SEQUENCE_KEY = `${NS}sequence`;  // last receipt sequence issued on this device

export const OUTBOX_PREFIX  = `${NS}outbox.`;   // one key per queued record
export const RECEIPT_PREFIX = `${NS}receipt.`;  // one key per locally held receipt (D9)

// Outbox and history keys embed a zero-padded monotonic id, so a plain lexicographic
// sort of the keys IS insertion order. That removes the need for a separate index
// blob, which is the one thing in a key-value store that can drift out of step with
// the records it points at.
const ID_PAD = 12;

export function paddedId(n) {
  return String(n).padStart(ID_PAD, '0');
}

export function outboxKey(id) {
  return `${OUTBOX_PREFIX}${paddedId(id)}`;
}

export function receiptKey(receiptNumber) {
  return `${RECEIPT_PREFIX}${receiptNumber}`;
}

// One key per (customer, order_type) pair, not a single blob — the device only ever
// visits a handful of customers between outages, so this fills in with exactly the
// accounts the tablet actually sold to, rather than every saved price the store has
// ever recorded.
export const CUSTOMER_PRICES_PREFIX = `${NS}catalogue.prices.`;

export function customerPricesKey(customerId, orderType) {
  return `${CUSTOMER_PRICES_PREFIX}${customerId}.${orderType}`;
}
