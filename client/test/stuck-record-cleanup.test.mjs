// ADR 0020 — the removal of five records stuck on the Needs attention list of three
// production devices (owner's instruction, 2026-11-25): 1C 478/981, 3D 1677/2345,
// 2A 2738. A number matches in a shape one of the two screens listing the record shows
// it in — the attention card (`#478` for queue id 478, or `1C-00478`) or Sync details
// (a change addressed to order `#478` / `1C-00478`) — only while that record is on the
// attention list, only on the named device, only if it was created before the end of
// 2026-11-25 in Manila. Everything waiting behind a removed record goes with it;
// nothing else does. A pass runs at every start and after any drain that moves a record
// to Needs attention.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import './render.mjs'; // jsdom globals — api/client.js reads window/localStorage on import

import { api } from '../src/api/client.js';
import { nativeStore, __resetMemoryBackend, __setBackend } from '../src/offline/nativeStore.js';
import {
  listRecords, listNeedsAttention, waitingCount, subscribeOutbox, pendingDeletionRefs, drainOutbox,
  repointRecord, __clearOutbox, NEEDS_ATTENTION, QUEUED, PARK_STREAK_KEY,
} from '../src/offline/outbox.js';
import { putReceipt, putOrderSnapshot, getReceipt, __clearReceipts } from '../src/offline/receiptHistory.js';
import { listLocalParkedOrders } from '../src/offline/parkedOrders.js';
import { buildSyncDetails, describeRecord } from '../src/offline/syncDetails.js';
import { outboxKey, DEVICE_LETTERS_KEY, OUTBOX_PREFIX } from '../src/offline/keys.js';
import { markOnline, stopReachabilityWatcher, __resetStatusState } from '../src/offline/status.js';
import {
  runStuckRecordCleanup, startStuckRecordCleanup, STUCK_RECORDS_REMOVED_2026_11_25,
} from '../src/offline/stuckRecordCleanup.js';

let savedRequest;
let savedGet;

beforeEach(async () => {
  __resetMemoryBackend();
  await __clearOutbox();
  await __clearReceipts();
  __resetStatusState();
  markOnline();
  savedRequest = api.request;
  savedGet = api.get;
  api.get = async () => [];
});

afterEach(() => {
  api.request = savedRequest;
  api.get = savedGet;
  stopReachabilityWatcher();
  __resetStatusState();
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

// Writes an outbox record directly, at the id and status the case needs. Created five
// days before the cutoff unless the case says otherwise.
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

// A storage backend over a Map the test can inspect.
function mapBackend(map, { set = () => {}, remove = () => {} } = {}) {
  return {
    async get(key) { return map.has(key) ? map.get(key) : null; },
    async set(key, value) { set(key); map.set(key, value); },
    async remove(key) { remove(key); map.delete(key); },
    async keys() { return [...map.keys()]; },
  };
}

function httpError(status, message = `Request failed (${status})`) {
  const err = new Error(message);
  err.status = status;
  return err;
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

  assert.deepEqual(result, { removed: 1 });
  assert.deepEqual(await ids(), [479]);
});

test('matches by receipt number parsed to this device and sequence (the list shows 1C-00981)', async () => {
  await deviceIs('1C');
  await put(12, attention({ receipt_number: '1C-00981' }));
  await put(13, attention({ receipt_number: '1C-00980' }));

  await runStuckRecordCleanup();

  assert.deepEqual(await ids(), [13]);
});

test('the right number on the wrong device does nothing', async () => {
  await deviceIs('1A');
  await put(478, attention());
  await put(20, attention({ receipt_number: '1A-00478' }));
  await put(21, attention({ entity_type: 'order_status', endpoint: '/orders/478/status' }));

  const result = await runStuckRecordCleanup();

  assert.deepEqual(result, { removed: 0 });
  assert.deepEqual(await ids(), [20, 21, 478]);
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
  await put(53, attention({ receipt_number: '3D-02738' })); // 2738 is named for 2A, not 3D

  const result = await runStuckRecordCleanup();

  assert.equal(result.removed, 2);
  assert.deepEqual(await ids(), [52, 53]);
});

// The same stuck change reads `#<queue id>` on its attention card, but Sync details
// names it by the order it is addressed to. Each row: the device, the record, and the
// title Sync details gives it — the number as it would have been read off that screen.
const NAMED_BY_TARGET_ORDER = [
  ['3D', { entity_type: 'order_status', endpoint: '/orders/1677/status', payload: { status: 'in_transit' } },
    'Status change: order #1677'],
  ['3D', { entity_type: 'order_status', endpoint: '/orders/3D-01677/status', payload: { status: 'in_transit' } },
    'Status change: order 3D-01677'],
  ['1C', { entity_type: 'receipt_printed', endpoint: '/orders/478/receipt-printed', payload: { phase: 'pending' } },
    'Receipt printed: order #478'],
  ['1C', { entity_type: 'receipt_printed', endpoint: '/orders/1C-00478/receipt-printed', payload: { phase: 'pending' } },
    'Receipt printed: order 1C-00478'],
  ['2A', { entity_type: 'order_delete', endpoint: '/orders/2738', method: 'DELETE', payload: { orderRef: 2738 } },
    'Discard draft #2738'],
  ['2A', { entity_type: 'order_delete', endpoint: '/orders/2A-02738', method: 'DELETE', payload: { orderRef: '2A-02738' } },
    'Discard draft 2A-02738'],
];

for (const [code, fields, title] of NAMED_BY_TARGET_ORDER) {
  test(`matches a stuck change by the order Sync details names it with ("${title}")`, async () => {
    await deviceIs(code);
    const record = await put(57, attention(fields));
    await put(58, attention({ entity_type: 'order_status', endpoint: '/orders/9999/status' }));
    assert.equal(describeRecord(record).title, title);

    assert.deepEqual(await runStuckRecordCleanup(), { removed: 1 });

    assert.deepEqual(await ids(), [58]);
  });
}

test('any other stuck change addressed to a named order is matched the same way', async () => {
  await deviceIs('1C');
  const record = await put(90, attention({
    entity_type: 'order_adjustment', endpoint: '/orders/981/adjustment', method: 'PATCH', payload: { adjustment: -50 },
  }));
  assert.equal(buildSyncDetails([record]).rows[0].request, 'PATCH /orders/981/adjustment');

  assert.deepEqual(await runStuckRecordCleanup(), { removed: 1 });

  assert.deepEqual(await ids(), []);
});

test('a change addressed to an order under another device code, a pre-letter number or another number: untouched', async () => {
  await deviceIs('1C');
  await put(60, attention({ entity_type: 'order_status', endpoint: '/orders/1A-00478/status' }));
  await put(61, attention({ entity_type: 'receipt_printed', endpoint: '/orders/3D-00981/receipt-printed' }));
  await put(62, attention({
    entity_type: 'order_delete', endpoint: '/orders/1-00478', method: 'DELETE', payload: { orderRef: '1-00478' },
  }));
  // 1677 is named for 3D, not for this device.
  await put(63, attention({ entity_type: 'order_status', endpoint: '/orders/1677/status' }));
  await put(64, attention({ entity_type: 'receipt_printed', endpoint: '/orders/1C-01677/receipt-printed' }));
  await put(65, attention({ entity_type: 'order_status', endpoint: '/orders/4780/status' }));
  // Addressed to a customer whose id happens to be a named number: not an order.
  await put(66, attention({ entity_type: 'customer_update', endpoint: '/customers/478', method: 'PATCH' }));

  assert.deepEqual(await runStuckRecordCleanup(), { removed: 0 });

  assert.deepEqual(await ids(), [60, 61, 62, 63, 64, 65, 66]);
});

test('a change addressed to a named order that is not on the attention list is never touched', async () => {
  await deviceIs('1C');
  await put(70, { entity_type: 'order_status', endpoint: '/orders/478/status', status: QUEUED });
  await put(71, { entity_type: 'receipt_printed', endpoint: '/orders/1C-00981/receipt-printed', status: 'sending' });
  await put(72, {
    entity_type: 'order_delete', endpoint: '/orders/981', method: 'DELETE', payload: { orderRef: 981 }, status: QUEUED,
  });

  assert.deepEqual(await runStuckRecordCleanup(), { removed: 0 });

  assert.deepEqual(await ids(), [70, 71, 72]);
});

test('records waiting behind a change matched by its target order go with it', async () => {
  await deviceIs('1C');
  await put(80, attention({ entity_type: 'order_status', endpoint: '/orders/478/status', payload: { status: 'in_transit' } }));
  await put(81, { entity_type: 'order_status', endpoint: '/orders/478/status', payload: { status: 'completed' }, depends_on: [80] });
  await put(82, { entity_type: 'customer_price', endpoint: '/customers/5/prices', depends_on: [81] });
  await put(83, { entity_type: 'receipt_printed', endpoint: '/orders/479/receipt-printed' }); // unrelated

  assert.deepEqual(await runStuckRecordCleanup(), { removed: 3 });

  assert.deepEqual(await ids(), [83]);
});

// The cutoff is 2026-11-26T00:00:00+08:00 (Asia/Manila), which is 2026-11-25T16:00:00Z.
test('a named number on a record created at or after the cutoff is never removed', async () => {
  await deviceIs('1C');
  await put(478, attention({ entity_type: 'customer', endpoint: '/customers', created_at: '2026-11-25T16:00:00.000Z' }));
  await put(20, attention({ receipt_number: '1C-00981', created_at: '2026-12-03T02:00:00.000Z' }));
  await put(21, attention({ entity_type: 'order_status', endpoint: '/orders/478/status', created_at: '2026-11-26T00:00:00+08:00' }));
  // The last millisecond before it still counts, and what waits behind that record goes
  // with it whenever it was created.
  await put(22, attention({ entity_type: 'receipt_printed', endpoint: '/orders/981/receipt-printed', created_at: '2026-11-25T15:59:59.999Z' }));
  await put(23, { entity_type: 'customer_price', endpoint: '/customers/5/prices', depends_on: [22], created_at: '2026-12-05T02:00:00.000Z' });

  assert.deepEqual(await runStuckRecordCleanup(), { removed: 2 });

  assert.deepEqual(await ids(), [20, 21, 478]);
});

test('a record with no readable creation time is not matched', async () => {
  await deviceIs('2A');
  await put(2738, attention({ entity_type: 'customer', endpoint: '/customers', created_at: undefined }));
  await put(30, attention({ receipt_number: '2A-02738', created_at: null }));
  await put(31, attention({ entity_type: 'order_status', endpoint: '/orders/2738/status', created_at: 'not a date' }));
  await put(32, attention({ entity_type: 'receipt_printed', endpoint: '/orders/2A-02738/receipt-printed', created_at: '' }));

  assert.deepEqual(await runStuckRecordCleanup(), { removed: 0 });

  assert.deepEqual(await ids(), [30, 31, 32, 2738]);
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

test('after a pass: attention list, waiting count, sync details and listeners all reflect it', async () => {
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

test('a named record being retried at one pass is removed by a later pass, once it is back on the list', async () => {
  await deviceIs('3D');
  await put(1677, { entity_type: 'customer', endpoint: '/customers', status: QUEUED });
  assert.deepEqual(await runStuckRecordCleanup(), { removed: 0 });
  assert.deepEqual(await ids(), [1677]);

  await put(1677, attention({ entity_type: 'customer', endpoint: '/customers' }));
  assert.deepEqual(await runStuckRecordCleanup(), { removed: 1 });
  assert.deepEqual(await ids(), []);
});

test('passes with nothing to do write nothing, however often they run', async () => {
  const map = new Map();
  let writes = 0;
  __setBackend(mapBackend(map, { set: () => { writes++; }, remove: () => { writes++; } }));

  // Before the device knows its code, on a device with nothing named on its list, and
  // again after a pass has removed what was.
  await put(981, attention());
  await put(12, attention({ receipt_number: '1C-00500' }));
  await put(478, { entity_type: 'customer', endpoint: '/customers' }); // named number, not on the list
  let before = new Map(map);
  writes = 0;
  for (let i = 0; i < 3; i++) assert.deepEqual(await runStuckRecordCleanup(), { removed: 0 });
  assert.equal(writes, 0);
  assert.deepEqual(new Map(map), before);

  await deviceIs('1C');
  assert.deepEqual(await runStuckRecordCleanup(), { removed: 1 });
  assert.deepEqual(await ids(), [12, 478]);

  before = new Map(map);
  writes = 0;
  for (let i = 0; i < 3; i++) assert.deepEqual(await runStuckRecordCleanup(), { removed: 0 });
  assert.equal(writes, 0);
  assert.deepEqual(new Map(map), before);
});

test('a device that does not know its code yet does nothing; a later pass does the job once it does', async () => {
  await put(478, attention());
  await put(110, attention({ receipt_number: '1C-00981' }));

  assert.deepEqual(await runStuckRecordCleanup(), { removed: 0 });
  assert.deepEqual(await ids(), [110, 478]);

  await deviceIs('1C');
  assert.deepEqual(await runStuckRecordCleanup(), { removed: 2 });
  assert.deepEqual(await ids(), []);
});

test('a failure inside a pass leaves the queue exactly as it was', async () => {
  // Fails on the second outbox delete.
  const map = new Map();
  let outboxRemoves = 0;
  __setBackend(mapBackend(map, {
    remove: (key) => {
      if (key.startsWith(OUTBOX_PREFIX) && ++outboxRemoves === 2) throw new Error('storage failed');
    },
  }));

  await deviceIs('1C');
  await put(478, attention({ parked_for: 'server_error' }));
  await put(479, { entity_type: 'receipt_printed', endpoint: '/orders/x/receipt-printed', depends_on: [478] });
  await put(480, attention({ receipt_number: '1C-00981' }));
  await putReceipt({ receipt_number: '1C-00981', status: 'pending', items: [] });
  await put(481, { receipt_number: '1C-00001' });
  await nativeStore.setJson(PARK_STREAK_KEY, { ids: [478] });
  const before = new Map(map);

  const result = await runStuckRecordCleanup();

  assert.deepEqual(result, { removed: 0, failed: true });
  assert.deepEqual(new Map(map), before);
});

test('a pass cut short after its first record removal, the restore failing too, is finished by a later pass', async () => {
  // Storage fails from the second outbox delete on, for writes and deletes alike, so
  // nothing the pass had already changed can be put back.
  const map = new Map();
  let outboxRemoves = 0;
  let broken = false;
  const failWhenBroken = () => { if (broken) throw new Error('storage failed'); };
  __setBackend(mapBackend(map, {
    set: failWhenBroken,
    remove: (key) => {
      if (key.startsWith(OUTBOX_PREFIX) && ++outboxRemoves === 2) broken = true;
      failWhenBroken();
    },
  }));

  await deviceIs('1C');
  // The named record, a sale waiting on it, and a print waiting on that sale.
  await put(478, attention({ entity_type: 'customer', endpoint: '/customers', payload: { name: 'Aling Nena' } }));
  await put(479, { receipt_number: '1C-00050', payload: { receipt_number: '1C-00050', items: [] }, depends_on: [478] });
  await putReceipt({ receipt_number: '1C-00050', status: 'pending', items: [] });
  await put(480, { entity_type: 'receipt_printed', endpoint: '/orders/1C-00050/receipt-printed', payload: { phase: 'pending' }, depends_on: [479] });
  // Unrelated, and free to go out.
  await put(481, { entity_type: 'customer', endpoint: '/customers', payload: { name: 'Mang Jun' } });

  assert.deepEqual(await runStuckRecordCleanup(), { removed: 0, failed: true });
  broken = false;

  // Only the end of the chain went. The named record is still on the attention list,
  // so the sale behind it is still held back: the drain sends the unrelated record only.
  assert.deepEqual(await ids(), [478, 479, 481]);
  assert.deepEqual((await listNeedsAttention()).map((r) => r.id), [478]);
  const sent = [];
  api.request = async (endpoint) => { sent.push(endpoint); return { id: 900 }; };
  await drainOutbox();
  assert.deepEqual(sent, ['/customers']);
  assert.deepEqual(await ids(), [478, 479]);

  assert.deepEqual(await runStuckRecordCleanup(), { removed: 2 });
  assert.deepEqual(await ids(), []);
  assert.equal(await getReceipt('1C-00050'), null);
});

// Last in the file: startStuckRecordCleanup leaves its outbox listener in place.
test('a drain that moves a named record back to Needs attention runs a pass by itself', { timeout: 5000 }, async () => {
  await deviceIs('3D');
  await put(1677, attention({ entity_type: 'customer', endpoint: '/customers', payload: { name: 'Aling Nena' } }));
  await repointRecord(1677); // "Send again as is": queued again, mid-retry

  // The pass at app start finds it queued and leaves it.
  assert.deepEqual(await startStuckRecordCleanup(), { removed: 0 });
  assert.deepEqual(await ids(), [1677]);

  // The server refuses it again. Nothing here asks for another pass.
  api.request = async () => { throw httpError(422, 'Customer name already exists'); };
  const removal = new Promise((resolve) => {
    const unsubscribe = subscribeOutbox((event) => {
      if (event.type === 'remove') { unsubscribe(); resolve(event); }
    });
  });
  const drained = await drainOutbox();
  assert.equal(drained.failed, 1);

  assert.deepEqual(await removal, { type: 'remove', removed: 1 });
  assert.deepEqual(await ids(), []);
});
