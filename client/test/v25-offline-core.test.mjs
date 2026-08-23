// V2.5 Release 1, piece 1 — the offline foundations.
//
// Covers what the piece is actually responsible for: receipt numbers issued on the
// device (D1), the outbox's ordering and per-record profile capture (D5/D14), the
// storage layer surviving a logout (D15/D17), and the release switch defaulting off
// (D18).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import './render.mjs'; // jsdom globals — api/client.js reads window/localStorage on import

import { api } from '../src/api/client.js';
import { nativeStore, __resetMemoryBackend } from '../src/offline/nativeStore.js';
import { STATION_KEY, SEQUENCE_KEY, OUTBOX_PREFIX, RECEIPT_PREFIX, NS } from '../src/offline/keys.js';
import {
  ensureStationRegistered, issueReceiptNumber, getStation, isRegistered, __resetIssuance,
} from '../src/offline/station.js';
import {
  enqueue, drainOutbox, listRecords, waitingCount, listNeedsAttention, ref,
  __clearOutbox, NEEDS_ATTENTION,
} from '../src/offline/outbox.js';
import { putReceipt, getReceipt, listReceipts, pruneReceipts } from '../src/offline/receiptHistory.js';
import { formatReceiptNumber, parseReceiptNumber } from '../src/offline/receiptNumbers.js';
import {
  saveOrderLocalFirst, queueReceiptPrinted, isOrderUnsynced, updateLocalOrder, discardLocalOrder,
} from '../src/offline/posSave.js';
import { orderRef, orderRefWith } from '../src/utils/orderRef.js';
import { V25_OFFLINE_CORE } from '../src/config/features.js';

let savedApi;

beforeEach(async () => {
  __resetMemoryBackend();
  __resetIssuance();
  await __clearOutbox();
  savedApi = { post: api.post, request: api.request };
});

afterEach(() => {
  api.post = savedApi.post;
  api.request = savedApi.request;
});

async function registerStation(number = 1) {
  api.post = async () => ({ station_number: number, registered_at: '2026-08-23T00:00:00.000Z' });
  return ensureStationRegistered();
}

// ── D1: station registration ────────────────────────────────────────────────

test('registers once and keeps the station number it was given', async () => {
  let calls = 0;
  api.post = async (path, body) => {
    calls++;
    assert.equal(path, '/stations/register');
    assert.ok(body.device_key, 'a device_key is sent so the server can be idempotent');
    return { station_number: 2, registered_at: '2026-08-23T00:00:00.000Z' };
  };

  const first = await ensureStationRegistered();
  assert.equal(first.station_number, 2);
  assert.equal(await isRegistered(), true);

  // Every later start is a no-op: the device never asks for a second number.
  const second = await ensureStationRegistered();
  assert.equal(second.station_number, 2);
  assert.equal(calls, 1);
});

test('a device_key is persisted before registering, so a lost response cannot burn a second number', async () => {
  api.post = async () => { throw new Error('Failed to fetch'); };
  await assert.rejects(() => ensureStationRegistered());

  const stored = await nativeStore.getJson(STATION_KEY);
  assert.ok(stored.device_key, 'the key survives the failed attempt');
  assert.equal(stored.station_number, null);

  let sentKey = null;
  api.post = async (_path, body) => {
    sentKey = body.device_key;
    return { station_number: 1, registered_at: '2026-08-23T00:00:00.000Z' };
  };
  await ensureStationRegistered();
  assert.equal(sentKey, stored.device_key, 'the retry re-sends the same device_key');
});

// ── D1: receipt numbers issued locally at Save ──────────────────────────────

test('issues zero-padded receipt numbers in sequence, with no server round trip', async () => {
  await registerStation(1);
  api.post = () => { throw new Error('the device must not call the server to number a receipt'); };

  assert.equal((await issueReceiptNumber()).receipt_number, '1-00001');
  assert.equal((await issueReceiptNumber()).receipt_number, '1-00002');
  assert.equal((await issueReceiptNumber()).receipt_number, '1-00003');
});

test('the sequence is stored before the number is handed out, so a crash skips rather than repeats', async () => {
  await registerStation(1);
  const issued = await issueReceiptNumber();
  assert.equal(issued.sequence, 1);
  assert.equal(await nativeStore.getString(SEQUENCE_KEY), '1');
});

test('concurrent Saves never receive the same number', async () => {
  await registerStation(3);
  const issued = await Promise.all(Array.from({ length: 25 }, () => issueReceiptNumber()));
  const numbers = issued.map((i) => i.receipt_number);
  assert.equal(new Set(numbers).size, 25);
  assert.deepEqual([...numbers].sort(), numbers.slice().sort());
  assert.equal(numbers.includes('3-00025'), true);
});

test('two stations issue the same sequence under different numbers', async () => {
  assert.equal(formatReceiptNumber(1, 42), '1-00042');
  assert.equal(formatReceiptNumber(2, 42), '2-00042');
  assert.deepEqual(parseReceiptNumber('2-00042'), { station: 2, sequence: 42 });
  assert.equal(parseReceiptNumber('nonsense'), null);
});

test('a device with no station cannot issue a receipt number', async () => {
  await assert.rejects(() => issueReceiptNumber(), /station number/);
});

// ── D14: the profile is captured at Save, replayed at drain ─────────────────

test('a queued record drains under the profile captured at Save, not the one active now', async () => {
  const sent = [];
  api.request = async (path, options) => {
    sent.push({ path, profileKey: options.profileKey });
    return { id: sent.length };
  };

  await enqueue({
    entityType: 'order', endpoint: '/orders', profileKey: 'luis',
    payload: { customer_id: 1 }, receiptNumber: '1-00001',
  });
  await enqueue({
    entityType: 'order', endpoint: '/orders', profileKey: 'josie',
    payload: { customer_id: 2 }, receiptNumber: '1-00002',
  });

  const result = await drainOutbox();
  assert.equal(result.sent, 2);
  assert.deepEqual(sent.map((s) => s.profileKey), ['luis', 'josie']);
  assert.equal(await waitingCount(), 0);
});

test('a record cannot be queued without a profile', async () => {
  await assert.rejects(
    () => enqueue({ entityType: 'order', endpoint: '/orders', payload: {} }),
    /profileKey is required/
  );
});

// ── D5: a locally created customer syncs before the order that references her ──

test('an order queued behind a new customer picks up her real id', async () => {
  const sent = [];
  api.request = async (path, options) => {
    sent.push({ path, body: JSON.parse(options.body) });
    return path === '/customers' ? { id: 77 } : { id: 500 };
  };

  const customer = await enqueue({
    entityType: 'customer', endpoint: '/customers', profileKey: 'josie',
    payload: { name: 'Aling Nena' },
  });
  await enqueue({
    entityType: 'order', endpoint: '/orders', profileKey: 'josie',
    payload: { customer_id: ref(customer.id), receipt_number: '1-00001' },
    dependsOn: [customer.id],
  });

  const result = await drainOutbox();
  assert.equal(result.sent, 2);
  assert.deepEqual(sent.map((s) => s.path), ['/customers', '/orders']);
  assert.equal(sent[1].body.customer_id, 77);
});

test('an order whose customer has not synced stays queued rather than going without her', async () => {
  api.request = async (path) => {
    if (path === '/customers') { const e = new Error('down'); e.status = 500; throw e; }
    throw new Error('the order must not be sent before its customer');
  };

  const customer = await enqueue({
    entityType: 'customer', endpoint: '/customers', profileKey: 'josie',
    payload: { name: 'Aling Nena' },
  });
  await enqueue({
    entityType: 'order', endpoint: '/orders', profileKey: 'josie',
    payload: { customer_id: ref(customer.id) }, dependsOn: [customer.id],
  });

  await drainOutbox();
  assert.equal(await waitingCount(), 2);
});

// ── D8/D13: what happens on the way back ────────────────────────────────────

test('a network failure leaves the record queued; the pass stops rather than hammering', async () => {
  let attempts = 0;
  api.request = async () => { attempts++; throw new Error('Failed to fetch'); };

  await enqueue({ entityType: 'order', endpoint: '/orders', profileKey: 'josie', payload: {} });
  await enqueue({ entityType: 'order', endpoint: '/orders', profileKey: 'josie', payload: {} });

  const result = await drainOutbox();
  assert.equal(result.sent, 0);
  assert.equal(attempts, 1, 'no point trying the next record down a dead line');
  assert.equal(await waitingCount(), 2);
});

test('a refused record goes to the attention list, never silently away', async () => {
  api.request = async () => { const e = new Error('Customer not found'); e.status = 400; throw e; };
  await enqueue({ entityType: 'order', endpoint: '/orders', profileKey: 'josie', payload: {} });

  const result = await drainOutbox();
  assert.equal(result.failed, 1);
  const stuck = await listNeedsAttention();
  assert.equal(stuck.length, 1);
  assert.equal(stuck[0].status, NEEDS_ATTENTION);
  assert.match(stuck[0].last_error, /Customer not found/);
});

test('a replayed receipt number answered with 200 clears the record just like a 201', async () => {
  // The server's idempotent path (D13) returns the stored order rather than an error,
  // so the device stops retrying. Anything 2xx reaches the client the same way.
  api.request = async () => ({ id: 900, receipt_number: '1-00001' });
  await enqueue({
    entityType: 'order', endpoint: '/orders', profileKey: 'josie',
    payload: {}, receiptNumber: '1-00001',
  });
  const result = await drainOutbox();
  assert.equal(result.sent, 1);
  assert.equal((await listRecords()).length, 0);
});

// ── D15/D17: device state, not session state ────────────────────────────────

test('the outbox, station and history survive a logout and never touch WebView storage', async () => {
  await registerStation(1);
  await issueReceiptNumber();
  await enqueue({ entityType: 'order', endpoint: '/orders', profileKey: 'josie', payload: {} });
  await putReceipt({ receipt_number: '1-00001', created_at: new Date().toISOString() });

  // What the 401/logout path in api/client.js clears, by name.
  await nativeStore.remove('authToken');
  await nativeStore.remove('activeProfile');

  assert.equal((await getStation()).station_number, 1);
  assert.equal(await waitingCount(), 1);
  assert.equal((await listReceipts()).length, 1);

  const keys = await nativeStore.keys();
  assert.ok(keys.every((k) => k.startsWith(NS)), 'device state all sits under one prefix');
  assert.equal(localStorage.getItem(STATION_KEY), null, 'nothing leaks into localStorage');
  assert.equal(typeof globalThis.indexedDB, 'undefined');
});

test('one key per record: a receipt is stored on its own key, and pruning is per record', async () => {
  const day = 24 * 60 * 60 * 1000;
  const now = Date.now();
  await putReceipt({ receipt_number: '1-00001', created_at: new Date(now - 40 * day).toISOString() });
  await putReceipt({ receipt_number: '1-00002', created_at: new Date(now - 2 * day).toISOString() });
  await putReceipt({ receipt_number: '1-00003', created_at: 'not a date' });

  assert.equal((await nativeStore.keysWithPrefix(RECEIPT_PREFIX)).length, 3);
  const pruned = await pruneReceipts({ now });
  assert.equal(pruned, 1);

  const kept = (await listReceipts()).map((r) => r.receipt_number).sort();
  assert.deepEqual(kept, ['1-00002', '1-00003'], 'an unreadable date is kept, never dropped');
});

test('outbox keys sort into insertion order without a separate index', async () => {
  for (let i = 0; i < 12; i++) {
    await enqueue({ entityType: 'order', endpoint: '/orders', profileKey: 'josie', payload: { i } });
  }
  const keys = await nativeStore.keysWithPrefix(OUTBOX_PREFIX);
  const ids = (await listRecords()).map((r) => r.id);
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b));
  assert.ok(keys.length >= 12);
});

// ── D18: the release switch ─────────────────────────────────────────────────

test('the release switch defaults off, and with it off an order still reads as #id', () => {
  assert.equal(V25_OFFLINE_CORE, false);
  assert.equal(orderRef({ id: 42 }), '#42');
  assert.equal(orderRef({ id: 42, receipt_number: '1-00042' }), '#42');
});

test('with the switch on, an order reads by its receipt number — legacy orders still by id', () => {
  assert.equal(orderRefWith({ id: 42, receipt_number: '1-00042' }, true), '1-00042');
  // The ~1,300 orders that predate V2.5 are never backfilled (D1), so they keep the
  // only name they have.
  assert.equal(orderRefWith({ id: 42 }, true), '#42');
});

// ── Piece 2: POS Save path is local-first (D2, D3, D5, D9, D14) ────────────

test('saveOrderLocalFirst writes order locally, numbers it, stores in history, and enqueues for drain', async () => {
  await registerStation(1);
  const now = new Date('2026-08-23T10:00:00.000Z').toISOString();

  const customer = { id: 10, name: 'Tindahan ni Aling Josie', customer_type: 'regular' };
  const items = [
    { product_id: 101, product_name: 'Coke 1.5L', sku: 'COKE-1.5', unit: 'cs', quantity: 2, unit_price: 300, unit_deposit_fee: 50, units_per_case: 12 },
  ];

  const localOrder = await saveOrderLocalFirst({
    customer,
    orderType: 'delivery',
    notes: 'Gate delivery',
    adjustment: { value: -20, reason: 'Friend discount' },
    items,
    profileKey: 'luis',
    createdAt: now,
  });

  assert.equal(localOrder.receipt_number, '1-00001');
  assert.equal(localOrder.receipt_station, 1);
  assert.equal(localOrder.receipt_sequence, 1);
  assert.equal(localOrder.created_at, now);
  assert.equal(localOrder.customer_id, 10);
  assert.equal(localOrder.customer_name, 'Tindahan ni Aling Josie');
  assert.equal(localOrder.total_amount, 600); // goods-only total (qty * price) while open
  assert.equal(localOrder.adjustment, -20);

  // Persisted in local receipt history (D9)
  const inHistory = await getReceipt('1-00001');
  assert.ok(inHistory, 'stored in local receipt history');
  assert.equal(inHistory.receipt_number, '1-00001');
  assert.equal(inHistory.items.length, 1);

  // Queued in outbox (D13/D14)
  const records = await listRecords();
  assert.equal(records.length, 1);
  assert.equal(records[0].entity_type, 'order');
  assert.equal(records[0].profile_key, 'luis');
  assert.equal(records[0].receipt_number, '1-00001');
  assert.equal(records[0].payload.adjustment, -20);
  assert.equal(records[0].payload.adjustment_reason, 'Friend discount');
});

test('saveOrderLocalFirst with mid-order quick-created customer sets dependency and reference', async () => {
  await registerStation(1);

  const quickCreatedCust = {
    id: 'local-1',
    _outboxId: 1,
    name: 'New Suki Corner',
    customer_type: 'unassigned',
  };

  const localOrder = await saveOrderLocalFirst({
    customer: quickCreatedCust,
    orderType: 'pickup',
    items: [{ product_id: 102, product_name: 'Sprite', quantity: 1, unit_price: 250 }],
    profileKey: 'josie',
  });

  assert.equal(localOrder.receipt_number, '1-00001');
  const records = await listRecords();
  assert.equal(records.length, 1);
  assert.deepEqual(records[0].depends_on, [1]);
  assert.deepEqual(records[0].payload.customer_id, ref(1, 'id'));
});

test('queueReceiptPrinted marks receipt locally and enqueues printed event with profile attribution', async () => {
  await registerStation(1);

  const order = {
    receipt_number: '1-00001',
    status: 'pending',
    items: [{ product_id: 1, quantity: 1, unit_price: 100 }],
    total_amount: 100,
    created_at: new Date().toISOString(),
  };
  await putReceipt(order);

  await queueReceiptPrinted({ order, phase: 'pending', profileKey: 'luis' });

  const updatedHistory = await getReceipt('1-00001');
  assert.ok(updatedHistory.pending_receipt_printed_at, 'marked printed in local history');

  const records = await listRecords();
  const printedRec = records.find((r) => r.entity_type === 'receipt_printed');
  assert.ok(printedRec);
  assert.equal(printedRec.profile_key, 'luis');
  assert.equal(printedRec.endpoint, '/orders/1-00001/receipt-printed');
});

test('unsynced order in outbox can be edited or discarded on device (D3)', async () => {
  await registerStation(1);

  const order = await saveOrderLocalFirst({
    customer: { id: 5, name: 'Sari Sari', customer_type: 'regular' },
    items: [{ product_id: 1, product_name: 'Beer', quantity: 1, unit_price: 100 }],
    profileKey: 'luis',
  });

  assert.equal(await isOrderUnsynced(order.receipt_number), true);

  // Edit on device
  const updated = await updateLocalOrder({
    order,
    items: [{ product_id: 1, product_name: 'Beer', quantity: 3, unit_price: 100 }],
    notes: 'Updated notes',
    adjustment: { value: 0, reason: '' },
    profileKey: 'luis',
  });

  assert.equal(updated.total_amount, 300);
  const inHistory = await getReceipt(order.receipt_number);
  assert.equal(inHistory.total_amount, 300);

  const recordsAfterEdit = await listRecords();
  assert.equal(recordsAfterEdit[0].payload.items[0].quantity, 3);
  assert.equal(recordsAfterEdit[0].payload.notes, 'Updated notes');

  // Discard on device
  await discardLocalOrder(order.receipt_number);
  assert.equal(await isOrderUnsynced(order.receipt_number), false);
  assert.equal((await listRecords()).length, 0);
  assert.equal(await getReceipt(order.receipt_number), null);
});
