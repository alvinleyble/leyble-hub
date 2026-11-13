import { listRecords, QUEUED, NEEDS_ATTENTION, isParkedForServerError, waitsOn, orderCreatesByReceipt } from './outbox.js';
import { getCachedEntity } from './catalogue.js';
import { formatPeso } from '../utils/money.js';
import { orderStatusLabel } from '../utils/statusBadges.js';

// The sync-details view's data: what is still waiting on this tablet to reach the
// server, oldest first, each record named in staff words with its attempts and last
// error. Read-only — nothing here changes, resends or reorders a record — and it reads
// only device storage (the outbox and the held catalogue), so it works blind.
//
// Why it exists: the drain sends the oldest record first and stops at a failure, so one
// bad record at the head of the queue holds everything behind it. The release build is
// not webview-debuggable, so before this view the only way to see WHY a tablet was stuck
// (e.g. "356 waiting") was the production server logs.

export const STATE_NEXT      = 'next';       // the record the next drain pass tries first
export const STATE_WAITING   = 'waiting';    // queued behind the next one
export const STATE_BLOCKED   = 'blocked';    // queued, but waits on a record that has not synced
export const STATE_ATTENTION = 'attention';  // on the Needs attention list

// Field names as staff know them, for "what changed" on an edit record.
const FIELD_WORDS = {
  name: 'name',
  full_name: 'name',
  customer_type: 'type',
  address: 'address',
  phone: 'phone',
  notes: 'notes',
  remarks: 'remarks',
  delivery_fee: 'delivery fee',
  is_active: 'active / inactive',
  current_stock: 'stock count',
  base_wholesale_price: 'price',
  category: 'category',
  unit: 'unit',
  sku: 'SKU',
  units_per_case: 'units per case',
  requires_bottle_return: 'bottle return',
  deposit_fee: 'deposit',
  license_number: 'license number',
};

const fieldWord = (key) => FIELD_WORDS[key] || String(key).replace(/_/g, ' ');

function changedFields(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const words = [...new Set(Object.keys(payload)
    .filter((k) => k !== 'reason' && k !== 'request_key')
    .map(fieldWord))];
  return words.length ? `Changed: ${words.join(', ')}` : null;
}

const isRef = (v) => v && typeof v === 'object' && !Array.isArray(v) && '$ref' in v;

// A receipt number reads as itself; a bare row id (an order from before receipt
// numbers) as "#1240".
function orderName(ref) {
  if (ref === undefined || ref === null || ref === '') return 'order';
  const s = String(ref);
  return /^\d+$/.test(s) ? `#${s}` : s;
}

const ORDER_PATH = /^\/orders\/([^/]+)/;
const ID_PATH = /^\/[a-z-]+\/([^/]+)/;

function idFromEndpoint(endpoint, pattern = ID_PATH) {
  const m = pattern.exec(endpoint || '');
  return m ? decodeURIComponent(m[1]) : null;
}

/**
 * Names held on the device for ids a record carries. Built once per load from the held
 * catalogue (inactive rows included — a record can name a since-deactivated customer)
 * and the outbox itself (a customer quick-created on this tablet is only an outbox
 * record until she syncs).
 */
export function buildLookups({ products = [], customers = [], personnel = [], records = [] } = {}) {
  const byId = (rows, field) => new Map(rows.map((r) => [String(r.id), r[field]]));
  return {
    products: byId(products, 'name'),
    customers: byId(customers, 'name'),
    personnel: byId(personnel, 'full_name'),
    records: new Map(records.map((r) => [String(r.id), r])),
  };
}

function customerName(value, lookups) {
  if (isRef(value)) {
    const rec = lookups.records.get(String(value.$ref));
    return rec?.payload?.name ? `${rec.payload.name} (new)` : 'a new customer';
  }
  if (value === undefined || value === null) return null;
  // A still-local customer's placeholder id ("local-12") names the outbox record.
  const local = /^local-(\d+)$/.exec(String(value));
  if (local) {
    const rec = lookups.records.get(local[1]);
    if (rec?.payload?.name) return `${rec.payload.name} (new)`;
  }
  return lookups.customers.get(String(value)) || null;
}

// The customer an endpoint like /customers/:customerId or /customers/12/prices names.
function endpointCustomer(record, lookups) {
  const param = record.endpoint_params?.customerId;
  if (param) return customerName(param, lookups);
  const id = idFromEndpoint(record.endpoint);
  return id ? customerName(id, lookups) : null;
}

function itemsSummary(items) {
  if (!Array.isArray(items) || items.length === 0) return null;
  const total = items.reduce((sum, i) => sum + Number(i.quantity || 0) * Number(i.unit_price || 0), 0);
  const count = `${items.length} ${items.length === 1 ? 'item' : 'items'}`;
  return total > 0 ? `${count} · ${formatPeso(total)}` : count;
}

const join = (...parts) => parts.filter(Boolean).join(' · ') || null;

/**
 * What a record is, in staff words: `{ title, detail }`. Never a raw endpoint or id
 * alone — an unknown record type still reads as "Other change"; its request is in the
 * technical details.
 */
export function describeRecord(record, lookups = buildLookups()) {
  const p = record?.payload || {};
  switch (record?.entity_type) {
    case 'order': {
      const ref = orderName(record.receipt_number || p.receipt_number);
      const customer = record.display?.customer_name || customerName(p.customer_id, lookups);
      return {
        title: p.status === 'draft' ? `Draft order ${ref}` : `Order ${ref}`,
        detail: join(customer && `Customer: ${customer}`, itemsSummary(p.items)),
      };
    }
    case 'order_status':
      return {
        title: `Status change: order ${orderName(idFromEndpoint(record.endpoint, ORDER_PATH))}`,
        detail: p.status ? `Mark as ${orderStatusLabel(p.status)}` : null,
      };
    case 'receipt_printed':
      return {
        title: `Receipt printed: order ${orderName(idFromEndpoint(record.endpoint, ORDER_PATH))}`,
        detail: null,
      };
    case 'order_delete':
      return {
        title: `Discard draft ${orderName(p.orderRef ?? idFromEndpoint(record.endpoint, ORDER_PATH))}`,
        detail: null,
      };
    case 'customer':
      return { title: `New customer: ${p.name || 'unnamed'}`, detail: null };
    case 'customer_update':
      return {
        title: `Customer edit: ${endpointCustomer(record, lookups) || 'a customer'}`,
        detail: changedFields(p),
      };
    case 'customer_price': {
      const product = lookups.products.get(String(p.product_id));
      const price = p.custom_unit_price !== undefined ? formatPeso(p.custom_unit_price) : null;
      return {
        title: `Custom price: ${endpointCustomer(record, lookups) || 'a customer'}`,
        detail: join(product, price, p.order_type === 'pickup' ? 'Pickup' : p.order_type === 'delivery' ? 'Delivery' : null),
      };
    }
    case 'product':
      return { title: `New product: ${p.name || 'unnamed'}`, detail: null };
    case 'product_update': {
      const id = idFromEndpoint(record.endpoint);
      return {
        title: `Product edit: ${lookups.products.get(String(id)) || 'a product'}`,
        detail: changedFields(p),
      };
    }
    case 'product_batch_price': {
      const updates = Array.isArray(p.updates) ? p.updates : [];
      const names = updates.map((u) => lookups.products.get(String(u.id))).filter(Boolean);
      const shown = names.slice(0, 3).join(', ');
      return {
        title: `Price change: ${updates.length} ${updates.length === 1 ? 'product' : 'products'}`,
        detail: shown ? (names.length > 3 ? `${shown} and ${names.length - 3} more` : shown) : null,
      };
    }
    case 'delivery':
      return {
        title: `Supplier delivery ${p.delivery_ref || record.receipt_number || ''}`.trim(),
        detail: join(p.supplier_name, Array.isArray(p.items) && p.items.length
          ? `${p.items.length} ${p.items.length === 1 ? 'product' : 'products'}` : null),
      };
    case 'personnel':
      return { title: `New personnel: ${p.full_name || 'unnamed'}`, detail: null };
    case 'personnel_update': {
      const id = idFromEndpoint(record.endpoint);
      return {
        title: `Personnel edit: ${lookups.personnel.get(String(id)) || 'a staff member'}`,
        detail: changedFields(p),
      };
    }
    default:
      return { title: 'Other change', detail: null };
  }
}

const NETWORK_WORDS = /failed to fetch|networkerror|network request failed|load failed|no internet connection|err_internet|err_connection/i;
const TIMEOUT_WORDS = /timed out|took too long|abort/i;
const REQUEST_FAILED = /^Request failed \((\d{3})\)$/;

/**
 * The record's last error in plain words, or null if it has none. The raw message is
 * kept separately (`rawError`) so the exact server text is still one tap away.
 */
export function plainError(record) {
  const raw = record?.last_error;
  if (!raw) return null;
  const message = String(raw);

  if (isParkedForServerError(record)) {
    return 'The server kept having an error saving this, so it was set aside. It is not a problem with the details.';
  }
  if (/^Depends on outbox record/.test(message)) {
    return 'It depends on another change that is no longer on this tablet, so it cannot be sent.';
  }

  const status = Number(record.last_error_status) || Number(REQUEST_FAILED.exec(message)?.[1]) || null;
  if (status) {
    if (status === 502 || status === 503 || status === 504) {
      return 'The server was restarting or unavailable.';
    }
    if (status >= 500) return 'The server had an error while saving this.';
    if (status === 409) return 'The server says this clashes with a change already saved.';
    if (status === 404) return 'The server could not find what this points to (it may have been deleted or merged).';
    return 'The server refused this change.';
  }

  if (TIMEOUT_WORDS.test(message)) return 'The server took too long to answer (more than 5 seconds).';
  if (NETWORK_WORDS.test(message)) return 'Could not reach the server — no internet, or the server was down.';
  // Recorded before this tablet kept the answer's status: say only what is certain.
  return record.status === NEEDS_ATTENTION ? 'The server refused this change.' : 'The last try failed.';
}

/**
 * Turns outbox records into the view's rows, in the order the drain sends them (outbox
 * id order — the keys are zero-padded ids, so this is insertion order).
 *
 * `state` mirrors the drain's own walk: a record on the Needs attention list blocks
 * anything waiting on it, a queued record waiting on a blocked one is blocked in turn,
 * and the first queued record nothing holds back is the one the next pass tries first.
 */
export function buildSyncDetails(records, lookups = buildLookups({ records })) {
  const sorted = [...(records || [])].sort((a, b) => Number(a.id) - Number(b.id));
  const blocked = new Set(sorted.filter((r) => r.status !== QUEUED).map((r) => r.id));
  const createsByReceipt = orderCreatesByReceipt(sorted);
  let nextFound = false;

  const rows = sorted.map((record) => {
    let state;
    if (record.status === NEEDS_ATTENTION) {
      state = STATE_ATTENTION;
    } else if (record.status !== QUEUED) {
      state = STATE_WAITING;
    } else if (waitsOn(record, createsByReceipt).some((id) => blocked.has(id))) {
      blocked.add(record.id);
      state = STATE_BLOCKED;
    } else if (!nextFound) {
      nextFound = true;
      state = STATE_NEXT;
    } else {
      state = STATE_WAITING;
    }
    const { title, detail } = describeRecord(record, lookups);
    return {
      id: record.id,
      state,
      title,
      detail,
      createdAt: record.created_at || null,
      attempts: Number(record.attempts) || 0,
      lastAttemptAt: record.last_attempt_at || null,
      error: plainError(record),
      rawError: record.last_error || null,
      errorStatus: record.last_error_status ?? null,
      request: `${record.method || 'POST'} ${record.endpoint || ''}`.trim(),
      savedBy: record.profile_key || null,
    };
  });

  return {
    rows,
    waitingCount: rows.filter((r) => r.state !== STATE_ATTENTION).length,
    attentionCount: rows.filter((r) => r.state === STATE_ATTENTION).length,
  };
}

/** Everything the view shows, from device storage only. Never throws. */
export async function loadSyncDetails() {
  const records = await listRecords().catch(() => []);
  const [products, customers, personnel] = await Promise.all(
    ['products', 'customers', 'personnel'].map((e) => getCachedEntity(e).catch(() => [])),
  );
  return buildSyncDetails(records, buildLookups({ products, customers, personnel, records }));
}

// "Nov 14, 2:05 PM" — the date matters: a stuck record is often days old.
export function formatWhen(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString('en-PH', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
