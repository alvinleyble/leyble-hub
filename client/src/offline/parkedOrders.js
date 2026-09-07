import { issueReceiptNumber } from './station.js';
import { enqueue, listRecords, drainOutbox, pendingDeletionRefs, QUEUED, ref } from './outbox.js';
import { outboxKey, DRAFTS_KEY } from './keys.js';
import { nativeStore } from './nativeStore.js';
import { api } from '../api/client.js';

// D6 — parked orders go quiet when the tablet is blind, riding the same local store
// and outbox the receipts already use (D17), rather than a second mechanism.
//
// Online, parking is unchanged: the early POST + debounced PATCH pre-2.5 always had
// (see POSPage.jsx). Only when that POST hits a genuine network failure does a draft
// park here instead — as an ordinary queued 'order' outbox record whose payload
// carries status: 'draft', the exact shape POST /orders already accepts online.
//
// It gets a device-issued receipt number purely as its local identity (the resend key
// is the outbox record's own request_key, ADR 0017 #9 — see requestKeys.js), and the
// route it posts to is the ordinary one: idempotency.js is deliberately table-agnostic
// over any orders row, drafts included, so this is the mechanism already built for
// it, not a new one. It is never shown to the owners as a printed receipt number,
// since a draft is never printed; the UI labels it plainly as a draft reference.
//
// Once synced, every order route already resolves either a plain row id or a
// receipt-number string (resolveOrderId in server/src/routes/orders.js), so a
// locally parked draft that has since synced is addressed the same way any other
// order is — by its receipt number — with no separate lookup required.

/**
 * Parks a new draft locally. Called only when the online create failed with a
 * genuine network failure (see POSPage.jsx) — a validation error must not fall back
 * to a local park.
 */
export async function parkOrderLocalFirst({
  customer,
  orderType = 'delivery',
  notes = '',
  adjustment = { value: 0, reason: '' },
  items = [],
  display = null,
  profileKey = null,
  createdAt = null,
}) {
  const activeProfileKey = profileKey || (await api.getActiveProfile());
  if (!activeProfileKey) {
    throw new Error('parkOrderLocalFirst: profileKey is required — capture the signed-in account at Save (D14)');
  }

  const { receipt_number } = await issueReceiptNumber();
  const saleTime = createdAt || new Date().toISOString();
  const adjVal = Number(adjustment?.value) || 0;
  const adjReason = adjVal !== 0 && adjustment?.reason ? String(adjustment.reason).trim() : null;

  // Same dependency ordering as a real sale (D5): a locally quick-created customer
  // must sync before any draft referencing her.
  const customerId = customer?._outboxId
    ? ref(customer._outboxId, 'id')
    : (customer?.id && !String(customer.id).startsWith('local-') ? Number(customer.id) : null);

  const payload = {
    customer_id: customerId,
    order_type: orderType,
    notes: notes ? notes.trim() : null,
    status: 'draft',
    adjustment: adjVal,
    adjustment_reason: adjReason,
    items: items.map((i) => ({
      product_id: Number(i.product_id),
      quantity: Number(i.quantity) || 0,
      unit_price: i.unit_price === '' ? 0 : Number(i.unit_price),
      unit_deposit_fee: Number(i.unit_deposit_fee) || 0,
      units_per_case: Number(i.units_per_case) || 1,
      is_price_overridden: false,
    })),
    receipt_number,
    created_at: saleTime,
  };

  const dependsOn = customer?._outboxId ? [customer._outboxId] : [];
  const record = await enqueue({
    entityType: 'order',
    endpoint: '/orders',
    method: 'POST',
    payload,
    profileKey: activeProfileKey,
    receiptNumber: receipt_number,
    dependsOn,
    createdAt: saleTime,
  });

  // The payload is the request body and must stay exactly that. Everything a SCREEN
  // needs to show or resume this draft while it is still local — the customer's name,
  // each line's product name/SKU/unit — is server-derived and simply absent from it,
  // so it rides alongside as `display` instead of being smuggled into the body.
  await attachDisplay(record, display, customer);

  drainOutbox().catch(() => {});

  return { receipt_number, outboxId: record.id };
}

// The display half of a parked draft (see attachDisplay): the customer's name and the
// per-line product names the payload has no room for. Written next to the record, never
// inside `payload`.
function displayFor(display, customer) {
  const source = display || {};
  return {
    customer_name: source.customer_name || customer?.name || 'Customer',
    customer_type: source.customer_type || customer?.customer_type || 'regular',
    items: Array.isArray(source.items) ? source.items : [],
  };
}

async function attachDisplay(record, display, customer) {
  record.display = displayFor(display, customer);
  await nativeStore.setJson(outboxKey(record.id), record);
  return record;
}

// Merges a line's display fields onto the payload line it belongs to. Matched by
// position first (park/update always write both halves together) and by product id as
// a fallback, so a display blob written by an older build still lines up.
function mergeItems(payloadItems, displayItems) {
  return (payloadItems || []).map((line, idx) => {
    const shown = displayItems[idx]?.product_id === line.product_id
      ? displayItems[idx]
      : displayItems.find((d) => Number(d.product_id) === Number(line.product_id));
    return {
      ...line,
      id: line.product_id,
      product_name: shown?.product_name || '',
      sku: shown?.sku || '',
      unit: shown?.unit || 'cs',
      requires_bottle_return: Boolean(shown?.requires_bottle_return),
      bottles_returned: 0,
    };
  });
}

function recordToDraft(record) {
  const p = record.payload || {};
  const shown = displayFor(record.display, null);
  const items = (p.items || []).reduce((sum, i) => sum + Number(i.quantity || 0) * Number(i.unit_price || 0), 0);
  return {
    id: null,
    _local: true,
    _outboxId: record.id,
    receipt_number: p.receipt_number || record.receipt_number || null,
    // A draft queued behind a customer this device also created offline carries a $ref
    // placeholder, not a number — the same `local-<outboxId>` string the rest of the
    // app (posSave's localCustomerId, OrderCreateModal's isLocalCustomer) reads.
    customer_id: typeof p.customer_id === 'number'
      ? p.customer_id
      : (p.customer_id?.$ref !== undefined ? `local-${p.customer_id.$ref}` : null),
    customer_name: shown.customer_name,
    customer_type: shown.customer_type,
    order_type: p.order_type || 'delivery',
    notes: p.notes || null,
    adjustment: p.adjustment || 0,
    adjustment_reason: p.adjustment_reason || null,
    items: mergeItems(p.items, shown.items),
    personnel: [],
    status: 'draft',
    created_at: record.created_at,
    total_amount: items,
  };
}

// Every locally parked draft still waiting to reach the server — the local half of
// D6's union list. Once synced, drainOutbox removes the record and the server's own
// copy (visible via GET /orders?status=draft) is the only one left, so a caller that
// filters the server list against these receipt numbers never shows both.
export async function listLocalParkedOrders() {
  const records = await listRecords();
  return records
    .filter((r) => r.entity_type === 'order' && r.payload?.status === 'draft' && r.status === QUEUED)
    .map(recordToDraft);
}

// D6's union: the server's drafts (when reachable) plus this device's own local
// parks, with a local one dropped the moment its receipt number shows up server-side
// — the one dedup rule POSHistoryModal already uses for local receipts, applied here
// to drafts. Sorted newest first, matching every other list in the POS.
//
// `pendingDeletionRefs` (outbox.js) excludes a server draft this device has already
// queued a DELETE for — see cleanupOrphanedDraft in posSave.js. Without this, a
// draft superseded by Confirm & Print's local-first save keeps showing (and
// counting) until the queued DELETE actually reaches the server, which a genuinely
// offline device may not do for hours: the owner already sees a completed sale, not
// a phantom draft waiting on a network call they cannot see.
export function mergeParkedOrders(serverDrafts, localDrafts, deletionRefs = new Set()) {
  const live = deletionRefs.size
    ? serverDrafts.filter((d) => !deletionRefs.has(String(d.id)) && !deletionRefs.has(String(d.receipt_number)))
    : serverDrafts;
  const serverNums = new Set(live.map((d) => d.receipt_number).filter(Boolean));
  const unsynced = localDrafts.filter((d) => !serverNums.has(d.receipt_number));
  return [...live, ...unsynced].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

function findQueuedDraftRecord(records, receiptNumber) {
  return records.find(
    (r) => r.entity_type === 'order' && r.receipt_number === receiptNumber
      && r.status === QUEUED && r.payload?.status === 'draft'
  );
}

// Whether a parked draft is still only local (offline, or not yet drained).
export async function isDraftUnsynced(receiptNumber) {
  if (!receiptNumber) return false;
  const records = await listRecords();
  return Boolean(findQueuedDraftRecord(records, receiptNumber));
}

/**
 * Updates a still-local draft in place (D3/D6). Does not touch receipt history —
 * a draft is not a receipt (D9) until it is actually finalized into a real order.
 */
export async function updateLocalDraft({ receiptNumber, orderType, notes, items, adjustment, display = null, profileKey = null }) {
  if (!receiptNumber) throw new Error('updateLocalDraft requires a receipt number');
  const records = await listRecords();
  const record = findQueuedDraftRecord(records, receiptNumber);
  if (!record) throw new Error('Draft is not queued in the outbox');

  const adjVal = Number(adjustment?.value) || 0;
  const adjReason = adjVal !== 0 && adjustment?.reason ? String(adjustment.reason).trim() : null;

  record.payload = {
    ...record.payload,
    order_type: orderType || record.payload.order_type,
    notes: notes ? notes.trim() : null,
    adjustment: adjVal,
    adjustment_reason: adjReason,
    items: (items || []).map((i) => ({
      product_id: Number(i.product_id),
      quantity: Number(i.quantity) || 0,
      unit_price: i.unit_price === '' ? 0 : Number(i.unit_price),
      unit_deposit_fee: Number(i.unit_deposit_fee) || 0,
      units_per_case: Number(i.units_per_case) || 1,
      is_price_overridden: false,
    })),
  };
  if (display) record.display = displayFor(display, null);
  if (profileKey) record.profile_key = profileKey;
  await nativeStore.setJson(outboxKey(record.id), record);

  drainOutbox().catch(() => {});
  return recordToDraft(record);
}

// Discards a still-local draft (D6): removed from the outbox so it never drains and
// never resurrects, exactly like discardLocalOrder for a pending order.
export async function discardLocalDraft(receiptNumber) {
  if (!receiptNumber) return;
  const records = await listRecords();
  const matching = records.filter(
    (r) => r.receipt_number === receiptNumber && r.payload?.status === 'draft'
  );
  for (const r of matching) {
    await nativeStore.remove(outboxKey(r.id));
  }
}


// ── The server's own drafts, held for the blind case ────────────────────────
//
// The Drafts tab and the purple parked-drafts banner used to be purely server-driven,
// so an outage emptied them both: `GET /orders?status=draft` failed and the fallback
// (this device's synced order history) can never contain a draft, because
// `GET /orders/sync` deliberately excludes them — a draft is working state, not
// history. Criteria 5.1/5.6 want drafts to LOAD offline, so the list the server last
// gave us is cached whole, exactly like the catalogue: server-replaced reference data,
// refreshed on every reachable load, with no staleness UI (D16).
//
// Held drafts are read-only offline, which is not a limitation invented here: a draft
// on the server has synced, and ADR 0015 §5 / criterion 5.8 already restrict offline
// content editing to orders this device created and has not yet handed over. The
// drafts this device parked itself (listLocalParkedOrders) ARE editable offline, and
// they are merged in below.

export async function cacheServerDrafts(drafts) {
  const list = Array.isArray(drafts) ? drafts : [];
  await nativeStore.setJson(DRAFTS_KEY, list);
  return list;
}

export async function getCachedServerDrafts() {
  return (await nativeStore.getJson(DRAFTS_KEY)) || [];
}

/**
 * The parked-drafts list, one code path online and offline: the server's drafts when
 * it answers (cached on the way past), the last cached copy when it does not, unioned
 * either way with this device's still-queued local parks and minus anything already
 * queued for deletion.
 *
 * Never throws — a first-run device with no cache and no line simply has no drafts,
 * the same contract loadCatalogue() gives order taking.
 *
 * @returns {Promise<{drafts: object[], fromCache: boolean}>}
 */
export async function loadParkedOrders() {
  let serverDrafts;
  let fromCache = false;
  try {
    const rows = await api.get('/orders?status=draft');
    serverDrafts = await cacheServerDrafts(Array.isArray(rows) ? rows : []);
  } catch {
    serverDrafts = await getCachedServerDrafts();
    fromCache = true;
  }

  let local = [];
  let deletionRefs = new Set();
  try {
    [local, deletionRefs] = await Promise.all([listLocalParkedOrders(), pendingDeletionRefs()]);
  } catch {
    // A local read failure must not be the reason the server's own drafts vanish.
  }

  return { drafts: mergeParkedOrders(serverDrafts, local, deletionRefs), fromCache };
}
