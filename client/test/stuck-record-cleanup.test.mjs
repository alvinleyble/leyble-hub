// ADR 0020 — the one-time removal of five records stuck on the Needs attention list of
// three production devices (owner's instruction, 2026-11-25): 1C #478/#981, 3D
// #1677/#2345, 2A #2738. A number matches in the shape the list shows it — `#478` (no
// receipt number, queue id 478) or `1C-00478` — only while that record is on the
// attention list, only on the named device. Everything waiting behind a removed record
// goes with it; nothing else does.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { nativeStore, __resetMemoryBackend, __setBackend } from '../src/offline/nativeStore.js';
import {
  listRecords, listNeedsAttention, waitingCount, subscribeOutbox, pendingDeletionRefs,
  __clearOutbox, NEEDS_ATTENTION, QUEUED, PARK_STREAK_KEY,
} from '../src/offline/outbox.js';
import { putReceipt, putOrderSnapshot, getReceipt, __clearReceipts } from '../src/offline/receiptHistory.js';
import { listLocalParkedOrders } from '../src/offline/parkedOrders.js';
import { buildSyncDetails } from '../src/offline/syncDetails.js';
import { outboxKey, DEVICE_LETTERS_KEY } from '../src/offline/keys.js';
import {
  runStuckRecordCleanup, STUCK_RECORDS_MARKER_KEY, STUCK_RECORDS_REMOVED_2026_11_25,
} from '../src/offline/stuckRecordCleanup.js';

beforeEach(async () => {
  __resetMemoryBackend();
  await __clearOutbox();
  await __clearReceipts();
});

// The device's `<person><letter>` code(s), as station.js stores them after sign-in.
async function deviceIs(...codes) {
  const letters = {};
  codes.forEach((code, i) => {
    const [, person, letter] = /^(\d+)([A-Z]+)$/.exec(code);
    letters[String(100 + i)] = { person: Number(person), letter, seller_name: null, allocated_at: null };
  });
  await nativeStore.setJson(DEVICE_LETTERS_KEY, letters);
}

// Writes an outbox record directly, at the id and status the case needs.
async function put(id, fields = {}) {
  const record = {
    id,
    entity_type: 'order',
    endpoint: '/orders',
    method: 'POST',
    payload: {},
    profile_key: 'alvin@leyblestore.com',
    receipt_number: null,
    request_key: `rk-${id}`,
    depends_on: [],
    status: QUEUED,
    attempts: 0,
    last_error: null,
    created_at: '2026-11-20T01:00:00.000Z',
    ...fields,
  };
  await nativeStore.setJson(outboxKey(id), record);
  return record;
}

const attention = (fields = {}) => ({ status: NEEDS_ATTENTION, attempts: 3, last_error: 'Customer not found', ...fields });

async function ids() {
  return (await listRecords()).map((r) => r.id);
}

test('the fixed set is exactly the five numbers the owner named, on the three devices', () => {
  assert.deepEqual(
    JSON.parse(JSON.stringify(STUCK_RECORDS_REMOVED_2026_11_25)),
    { '1C': [478, 981], '3D': [1677, 2345], '2A': [2738] },
  );
});

test('matches by queue id when the record has no receipt number (the list shows #478)', async () => {
  await deviceIs('1C');
  await put(478, attention({ entity_type: 'customer', endpoint: '/customers', receipt_number: null }));
  await put(479, { entity_type: 'customer', endpoint: '/customers' });

  const result = await runStuckRecordCleanup();

  assert.deepEqual(result, { ran: true, removed: 1 });
  assert.deepEqual(await ids(), [479]);
});

test('matches by receipt number parsed to this device and sequence (the list shows 1C-00981)', async () => {
  await deviceIs('1C');
  await put(12, attention({ receipt_number: '1C-00981' }));
  await put(13, attention({ receipt_number: '1C-00980' }));

  await runStuckRecordCleanup();

  assert.deepEqual(await ids(), [13]);
});

test('the right number on the wrong device does nothing (marker still set)', async () => {
  await deviceIs('1A');
  await put(478, attention());
  await put(20, attention({ receipt_number: '1A-00478' }));

  const result = await runStuckRecordCleanup();

  assert.deepEqual(result, { ran: true, removed: 0 });
  assert.deepEqual(await ids(), [20, 478]);
  assert.ok(await nativeStore.getString(STUCK_RECORDS_MARKER_KEY));
});

test('a matching number that is not on the attention list is never touched', async () => {
  await deviceIs('3D');
  await put(1677, { status: QUEUED });
  await put(30, { receipt_number: '3D-02345', status: QUEUED });
  await put(31, { receipt_number: '3D-01677', status: 'sending' });

  await runStuckRecordCleanup();

  assert.deepEqual(await ids(), [30, 31, 1677]);
});

test('right sequence under another device code, a pre-letter number, or a delivery reference: untouched', async () => {
  await deviceIs('2A');
  await put(40, attention({ receipt_number: '2B-02738' }));
  await put(41, attention({ receipt_number: '1A-02738' }));
  await put(42, attention({ receipt_number: '2-02738' }));
  await put(43, attention({ entity_type: 'delivery', endpoint: '/incoming', receipt_number: '2A-DEL-02738' }));

  await runStuckRecordCleanup();

  assert.deepEqual(await ids(), [40, 41, 42, 43]);
});

test('a device holding several codes matches each named one it holds', async () => {
  await deviceIs('2A', '3D');
  await put(50, attention({ receipt_number: '2A-02738' }));
  await put(51, attention({ receipt_number: '3D-02345' }));
  await put(52, attention({ receipt_number: '1C-00478' })); // 1C is not this device

  const result = await runStuckRecordCleanup();

  assert.equal(result.removed, 2);
  assert.deepEqual(await ids(), [52]);
});

test('direct, chained and order-target waiters go with it; unrelated records stay', async () => {
  await deviceIs('1C');
  // The matched sale, and its held receipt.
  await put(60, attention({ receipt_number: '1C-00478' }));
  // Direct by depends_on.
  await put(61, { entity_type: 'receipt_printed', endpoint: '/orders/1C-00478/receipt-printed', depends_on: [60] });
  // Chained: waits on 61, not on 60.
  await put(62, { entity_type: 'customer_price', endpoint: '/customers/5/prices', depends_on: [61] });
  // Order-target only: addressed to the sale, no depends_on link (an older build's record).
  await put(63, { entity_type: 'order_status', endpoint: '/orders/1C-00478/status' });
  // Chained behind the order-target waiter.
  await put(64, { entity_type: 'order_status', endpoint: '/orders/77/status', depends_on: [63] });
  // Unrelated: another sale, a write to another order, a customer the sale depends ON.
  await put(65, { receipt_number: '1C-00479' });
  await put(66, { entity_type: 'order_status', endpoint: '/orders/1C-00479/status', depends_on: [65] });
  await put(59, { entity_type: 'customer', endpoint: '/customers' });
  await put(67, attention({ receipt_number: '1C-00500' })); // stuck, but not named

  const result = await runStuckRecordCleanup();

  assert.equal(result.removed, 5);
  assert.deepEqual(await ids(), [59, 65, 66, 67]);
});

test('after the step: attention list, waiting count, sync details and listeners all reflect it', async () => {
  await deviceIs('3D');
  await put(1677, attention({ entity_type: 'customer', endpoint: '/customers' }));
  await put(1700, { receipt_number: '3D-00100', depends_on: [1677] });
  await put(1701, { receipt_number: '3D-00101' });
  await put(1702, attention({ receipt_number: '3D-02345' }));

  assert.equal((await listNeedsAttention()).length, 2);
  assert.equal(await waitingCount(), 2);

  const events = [];
  const unsubscribe = subscribeOutbox((e) => events.push(e));
  await runStuckRecordCleanup();
  unsubscribe();

  assert.equal((await listNeedsAttention()).length, 0);
  assert.equal(await waitingCount(), 1);
  const details = buildSyncDetails(await listRecords());
  assert.equal(details.attentionCount, 0);
  assert.equal(details.waitingCount, 1);
  assert.deepEqual(details.rows.map((r) => r.id), [1701]);
  assert.deepEqual(events.map((e) => e.type), ['remove']);
});

test('a removed sale takes its never-synced held receipt; a server snapshot under the same number stays', async () => {
  await deviceIs('1C');
  await put(70, attention({ receipt_number: '1C-00478', payload: { receipt_number: '1C-00478' } }));
  await putReceipt({ receipt_number: '1C-00478', status: 'pending', items: [] });
  // A different sale the server holds under the colliding number 1C-00981 (a 409 case):
  // the sync stored the server's row, with its id, under that receipt key.
  await put(71, attention({ receipt_number: '1C-00981', payload: { receipt_number: '1C-00981' } }));
  await putOrderSnapshot({ id: 5150, receipt_number: '1C-00981', status: 'pending', items: [] });
  // An unrelated held receipt stays.
  await putReceipt({ receipt_number: '1C-00500', status: 'pending', items: [] });

  await runStuckRecordCleanup();

  assert.equal(await getReceipt('1C-00478'), null);
  assert.equal((await getReceipt('1C-00981'))?.id, 5150);
  assert.ok(await getReceipt('1C-00500'));
});

test('a removed parked draft and a removed draft discard leave nothing listed or pending', async () => {
  await deviceIs('2A');
  await put(80, attention({ receipt_number: '2A-02738', payload: { status: 'draft' } }));
  await put(2738, attention({ entity_type: 'order_delete', endpoint: '/orders/900', method: 'DELETE', payload: { orderRef: 900 } }));
  await put(81, { receipt_number: '2A-00010', payload: { status: 'draft' } });

  await runStuckRecordCleanup();

  assert.deepEqual((await listLocalParkedOrders()).map((d) => d.receipt_number), ['2A-00010']);
  assert.deepEqual([...await pendingDeletionRefs()], []);
  assert.deepEqual(await ids(), [81]);
});

test('removed ids leave the server-error park streak; other ids in it stay', async () => {
  await deviceIs('1C');
  await put(478, attention({ parked_for: 'server_error' }));
  await put(90, attention({ parked_for: 'server_error', receipt_number: '1C-00090' }));
  await nativeStore.setJson(PARK_STREAK_KEY, { ids: [478, 90] });

  await runStuckRecordCleanup();

  assert.deepEqual((await nativeStore.getJson(PARK_STREAK_KEY)).ids, [90]);
});

test('a second run does nothing, even to a later record with a named number', async () => {
  await deviceIs('1C');
  await put(478, attention());
  assert.deepEqual(await runStuckRecordCleanup(), { ran: true, removed: 1 });

  await put(100, attention({ receipt_number: '1C-00981' }));
  assert.deepEqual(await runStuckRecordCleanup(), { ran: false, reason: 'already-ran' });
  assert.deepEqual(await ids(), [100]);
});

test('an unknown device code does nothing and does not set the marker', async () => {
  await put(478, attention());
  await put(110, attention({ receipt_number: '1C-00981' }));

  assert.deepEqual(await runStuckRecordCleanup(), { ran: false, reason: 'no-device-code' });
  assert.deepEqual(await ids(), [110, 478]);
  assert.equal(await nativeStore.getString(STUCK_RECORDS_MARKER_KEY), null);

  // Once the device learns it is 1C, the next start does the job.
  await deviceIs('1C');
  assert.deepEqual(await runStuckRecordCleanup(), { ran: true, removed: 2 });
});

test('a failure inside the step leaves the queue exactly as it was, and no marker', async () => {
  // A backend over a Map we can inspect, that fails on the second outbox delete.
  const map = new Map();
  let outboxRemoves = 0;
  __setBackend({
    async get(key) { return map.has(key) ? map.get(key) : null; },
    async set(key, value) { map.set(key, value); },
    async remove(key) {
      if (key.startsWith('v25.outbox.') && ++outboxRemoves === 2) throw new Error('storage failed');
      map.delete(key);
    },
    async keys() { return [...map.keys()]; },
  });

  await deviceIs('1C');
  await put(478, attention({ parked_for: 'server_error' }));
  await put(479, { entity_type: 'receipt_printed', endpoint: '/orders/x/receipt-printed', depends_on: [478] });
  await put(480, attention({ receipt_number: '1C-00981' }));
  await putReceipt({ receipt_number: '1C-00981', status: 'pending', items: [] });
  await put(481, { receipt_number: '1C-00001' });
  await nativeStore.setJson(PARK_STREAK_KEY, { ids: [478] });
  const before = new Map(map);

  const result = await runStuckRecordCleanup();

  assert.deepEqual(result, { ran: false, reason: 'failed' });
  assert.deepEqual(new Map(map), before);
  assert.equal(map.has(STUCK_RECORDS_MARKER_KEY), false);
});
