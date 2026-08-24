import { issueReceiptNumber } from './station.js';
import { enqueue, listRecords, drainOutbox, QUEUED, ref } from './outbox.js';
import { outboxKey } from './keys.js';
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
// It gets a device-issued receipt number purely as its local identity and anti-
// duplicate key (D13) — server/src/lib/idempotency.js is deliberately table-agnostic
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
  profileKey = null,
  createdAt = null,
}) {
  const activeProfileKey = profileKey || (await api.getActiveProfile());
  if (!activeProfileKey) {
    throw new Error('parkOrderLocalFirst: profileKey is required — capture the profile at Save (D14)');
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

  drainOutbox().catch(() => {});

  return { receipt_number, outboxId: record.id };
}

function recordToDraft(record) {
  const p = record.payload || {};
  const items = (p.items || []).reduce((sum, i) => sum + Number(i.quantity || 0) * Number(i.unit_price || 0), 0);
  return {
    id: null,
    _outboxId: record.id,
    receipt_number: p.receipt_number || record.receipt_number || null,
    customer_id: typeof p.customer_id === 'number' ? p.customer_id : null,
    order_type: p.order_type || 'delivery',
    notes: p.notes || null,
    adjustment: p.adjustment || 0,
    adjustment_reason: p.adjustment_reason || null,
    items: p.items || [],
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
export function mergeParkedOrders(serverDrafts, localDrafts) {
  const serverNums = new Set(serverDrafts.map((d) => d.receipt_number).filter(Boolean));
  const unsynced = localDrafts.filter((d) => !serverNums.has(d.receipt_number));
  return [...serverDrafts, ...unsynced].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
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
export async function updateLocalDraft({ receiptNumber, orderType, notes, items, adjustment, profileKey = null }) {
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
