// Native-storage key layout for the V2.5 offline core (D17).
//
// Everything the device owns sits under one prefix, and NOTHING under that prefix is
// session state. D15: waiting receipts, the local receipt history and the station
// number survive logout and re-login — they belong to the tablet, not to whoever is
// signed in. The logout path in client/src/api/client.js clears `authToken` and
// `activeProfile` by name and must never be widened to a prefix sweep.
export const NS = 'v25.';

export const SESSION_KEY  = `${NS}session`;   // { id, email, full_name, role }

// The last identity this device was ever signed in as, kept distinct from SESSION_KEY
// above: a normal logout or a genuine 401 correctly clear SESSION_KEY (the live,
// silently-restorable session), but must never wipe this — it is what makes ADR 0015
// §3's "Resume Offline Session" login-screen action possible after either of those.
export const LAST_IDENTITY_KEY = `${NS}lastIdentity`; // { id, email, full_name, role }
export const STATION_KEY  = `${NS}station`;   // { station_number, device_key, registered_at }
export const SEQUENCE_KEY = `${NS}sequence`;  // last receipt sequence issued on this device

export const OUTBOX_PREFIX  = `${NS}outbox.`;   // one key per queued record
export const RECEIPT_PREFIX = `${NS}receipt.`;  // one key per locally held order snapshot

// ADR 0015 §4 — Dual Identifier Resolution. An order snapshot is stored under its
// receipt number when it has one, and under `id-<row id>` when it does not (every
// order created before V2.5 — those are never backfilled, ADR 0010). A second, tiny
// key per order maps the numeric row id onto whichever of the two the snapshot
// actually lives under, so a link that only carries `/orders/1240` still resolves
// offline. It is an index of pointers, not of records: losing one costs a lookup
// path, never the order itself, and `getReceipt` rebuilds the answer by scanning as
// a last resort.
export const ORDER_INDEX_PREFIX = `${NS}orderindex.`;

export function orderIndexKey(orderId) {
  return `${ORDER_INDEX_PREFIX}${orderId}`;
}

// The storage identity of an order snapshot: its receipt number when it has one,
// otherwise `id-<row id>`. Never the bare numeric id — that would collide with a
// station-issued receipt number the moment receipt numbering reached that value.
export function snapshotIdentifier(order) {
  if (order?.receipt_number) return String(order.receipt_number);
  if (order?.id !== undefined && order?.id !== null) return `id-${order.id}`;
  return null;
}

// ADR 0015 §4 / the sync layer's own bookkeeping: when this device last completed a
// sync, and whether it has ever finished its one-time first setup.
export const SYNC_STATE_KEY = `${NS}sync.state`;

// Reference data cached whole (server-replaced, not built up locally) — see
// catalogue.js. Personnel joins products/customers here so Driver/Helper assignment
// in the order modal works blind (ADR 0015 §9).
export const PRODUCTS_KEY  = `${NS}catalogue.products`;
export const CUSTOMERS_KEY = `${NS}catalogue.customers`;
export const PERSONNEL_KEY = `${NS}catalogue.personnel`;

// The server's own parked drafts, cached whole the same way (server-replaced, not
// built up locally). Distinct from the RECEIPT_PREFIX order history, which the sync
// endpoint deliberately excludes drafts from: a draft is working state, so it is not
// mirrored by the delta sync and has to be held here to survive an outage at all.
export const DRAFTS_KEY = `${NS}drafts`;

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

// ── Slice 3.3 (ADR 0015 §9) — back-office reference cache ───────────────────
//
// Dashboard, Tickets, the deliveries list and the two audit feeds are read-only
// reference data that the owners look at, not records this device builds up. They
// cache as ONE whole value each (same reasoning as the catalogue above), wrapped in
// `{ cached_at, value }` so the offline banner can name the copy's age — the one
// place in this app that deliberately shows staleness, because D16's "never tell them
// how old the catalogue is" is about SELLING, and a back-office figure read during an
// outage is only meaningful if you know when it was true.
export const BACKOFFICE_PREFIX = `${NS}cache.`;

export function backOfficeKey(name) {
  return `${BACKOFFICE_PREFIX}${name}`;
}

// ── Slice 3.3 (ADR 0015 §8) — device-issued delivery references ─────────────
//
// `<station>-DEL-<sequence>`, e.g. `1-DEL-00007`. Its own sequence, deliberately
// separate from SEQUENCE_KEY: a receipt number is what a customer holds on paper and
// a delivery reference is warehouse bookkeeping, and sharing one counter would make
// both series full of gaps that look like lost paperwork.
export const DELIVERY_SEQUENCE_KEY = `${NS}deliverySequence`;

// ── Slice 3.3 (ADR 0015 §6) — stock/price reconciliation questions ──────────
//
// NOT outbox records. An outbox record is something to send; these are something to
// ASK — two equally valid values for the same physical fact, waiting on a human to
// say which one is true. Keeping them in their own space is why resolving one can
// enqueue a fresh, ordinary write instead of mutating a half-sent record in place.
export const RECONCILE_PREFIX = `${NS}reconcile.`;

export function reconcileKey(id) {
  return `${RECONCILE_PREFIX}${id}`;
}
