// V2.5 Release 1, piece 3 — the orphaned-draft fix, parked orders, and the quiet
// catalogue.
//
// Covers:
// 1. Deliverable 1 (regression): the server-side draft Confirm & Print's local-first
//    save abandons must be reconciled away, online and offline, and a repeat cleanup
//    must be harmless.
// 2. Deliverable 2: parked orders park locally when blind (parkedOrders.js), the
//    union list drops a local one the moment it syncs, editing/discarding work while
//    still local, and a possible double is flagged on drain (duplicateOrders.js /
//    drainNotifier.js), reusing D4's exact toast shape.
// 3. Deliverable 3: the catalogue cache falls back to the held copy when the server
//    is unreachable (catalogue.js), with no error thrown.
// 4. Both sides of the switch (D18) for the pieces that take an explicit flag.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import './render.mjs'; // jsdom globals

import { api } from '../src/api/client.js';
import { nativeStore, __resetMemoryBackend } from '../src/offline/nativeStore.js';
import {
  enqueue, drainOutbox, listRecords, listNeedsAttention,
  __clearOutbox, QUEUED,
} from '../src/offline/outbox.js';
import { ensureStationRegistered, __resetIssuance } from '../src/offline/station.js';
import { saveOrderLocalFirst, cleanupOrphanedDraft } from '../src/offline/posSave.js';
import {
  parkOrderLocalFirst, listLocalParkedOrders, mergeParkedOrders, isDraftUnsynced,
  updateLocalDraft, discardLocalDraft,
} from '../src/offline/parkedOrders.js';
import { getReceipt } from '../src/offline/receiptHistory.js';
import {
  findPossibleDoubleGroups, getPossibleDoubleOrderIds, countPossibleDoubleOrders,
} from '../src/utils/duplicateOrders.js';
import { notifyDrainCompleteWith, __resetDrainNotifierState } from '../src/offline/drainNotifier.js';
import { getCachedProducts, getCachedCustomers, loadCatalogue } from '../src/offline/catalogue.js';
import { V25_OFFLINE_CORE } from '../src/config/features.js';

let savedApi;

beforeEach(async () => {
  __resetMemoryBackend();
  __resetIssuance();
  __resetDrainNotifierState();
  await __clearOutbox();
  savedApi = {
    post: api.post, request: api.request, get: api.get, getActiveProfile: api.getActiveProfile,
  };
});

afterEach(() => {
  api.post = savedApi.post;
  api.request = savedApi.request;
  api.get = savedApi.get;
  api.getActiveProfile = savedApi.getActiveProfile;
});

async function registerStation(number = 1) {
  api.post = async () => ({ station_number: number, registered_at: '2026-08-23T00:00:00.000Z' });
  return ensureStationRegistered();
}

// Several offline writes (parkOrderLocalFirst, cleanupOrphanedDraft, etc.) fire an
// internal background drainOutbox() alongside the write, same as the existing
// saveOrderLocalFirst/queueReceiptPrinted pattern. A macrotask yield guarantees that
// attempt has fully settled (network-failure microtask chains, no timers involved)
// before a test swaps in a new api.request mock and drives its own explicit drain.
const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0));

// ── Deliverable 1: the orphaned server-side draft ───────────────────────────────
//
// Reproduces the captain's report: a POS flow creates a server-side draft row early
// (POSPage.jsx's early-draft effect), and before this fix, Confirm & Print's
// V25_OFFLINE_CORE branch called saveOrderLocalFirst and abandoned that draft's id
// entirely — the draft was never finalized and never deleted, so it sat in Drafts
// forever (orders 1210 / 1213 in the captain's copy, orphaned by sales 2-00002 /
// 2-00004). This test fails on the code before cleanupOrphanedDraft existed and
// POSPage's handleConfirmPrint called it, and passes after.

test('REGRESSION (Deliverable 1): a local-first sale reconciles the draft it grew from — the draft is deleted, not left behind', async () => {
  await registerStation(2);

  // Unreachable while queueing, so the background drain each queueing call fires
  // (saveOrderLocalFirst, cleanupOrphanedDraft) cannot race the explicit drain below —
  // everything simply stays queued until this test controls the drain itself.
  api.request = async () => { const err = new Error('Failed to fetch'); throw err; };

  // The early server-side draft POSPage.jsx creates when a customer is picked —
  // simulated here as a known row id, exactly like order 1210 in the captain's report.
  const orphanedDraftRef = 1210;

  const saved = await saveOrderLocalFirst({
    customer: { id: 42, name: 'Aling Nena', customer_type: 'regular' },
    items: [{ product_id: 1, product_name: 'Coke', quantity: 2, unit_price: 300 }],
    profileKey: 'josie',
  });
  assert.equal(saved.receipt_number, '2-00001', 'this is sale 2-00001, matching the report\'s 2-00002/2-00004 shape');

  // The fix: reconcile the draft rather than leaving a second, dead row behind.
  await cleanupOrphanedDraft({ draftRef: orphanedDraftRef, profileKey: 'josie' });
  await flushMicrotasks();

  // The line returns.
  const requests = [];
  api.request = async (path, options) => {
    requests.push({ path, method: options.method });
    if (path === '/orders' && options.method === 'POST') {
      return { id: 9001, receipt_number: JSON.parse(options.body).receipt_number };
    }
    if (path === '/orders/1210' && options.method === 'DELETE') {
      return null; // 204, no body
    }
    throw new Error(`unexpected request: ${options.method} ${path}`);
  };
  const result = await drainOutbox();

  const deleteCall = requests.find((r) => r.path === '/orders/1210' && r.method === 'DELETE');
  assert.ok(deleteCall, 'the orphaned draft must be deleted once the local-first order is the authority (D2/D13)');
  assert.equal(result.failed, 0, 'cleanup must not land on the needs-attention list in the ordinary case');
  assert.equal((await listNeedsAttention()).length, 0);
});

test('Deliverable 1: cleanup is queued through the outbox, not fire-and-forget, when the line is down at print time', async () => {
  await registerStation(1);

  // The device cannot reach the server right now.
  api.request = async (path, options) => {
    if (path === '/orders' && options.method === 'POST') {
      return { id: 500, receipt_number: JSON.parse(options.body).receipt_number };
    }
    const err = new Error('Failed to fetch');
    throw err; // no .status — a genuine network failure
  };

  await saveOrderLocalFirst({
    customer: { id: 7, name: 'Mang Juan' },
    items: [{ product_id: 1, quantity: 1, unit_price: 100 }],
    profileKey: 'luis',
  });

  await cleanupOrphanedDraft({ draftRef: 1213, profileKey: 'luis' });
  await flushMicrotasks();

  // The line is down: the cleanup record must still be queued (never dropped), not
  // silently swallowed by a fire-and-forget request.
  const records = await listRecords();
  const cleanupRecord = records.find((r) => r.endpoint === '/orders/1213' && r.method === 'DELETE');
  assert.ok(cleanupRecord, 'the cleanup must be queued in the outbox rather than attempted once and forgotten');
  assert.equal(cleanupRecord.status, QUEUED);

  // The line returns: the queued cleanup drains on its own.
  const sentPaths = [];
  api.request = async (path, options) => {
    sentPaths.push(`${options.method} ${path}`);
    if (options.method === 'DELETE') return null;
    return { id: 999, receipt_number: JSON.parse(options.body).receipt_number };
  };
  await drainOutbox();
  assert.ok(sentPaths.includes('DELETE /orders/1213'), 'the queued cleanup must actually fire once the line is back');
});

test('Deliverable 1: a repeated arrival of the cleanup is harmless — a 404 on retry counts as done, not a needs-attention item', async () => {
  // Plain enqueue (not queueOrderDeletion) so this test drives exactly one drain
  // pass itself, rather than racing queueOrderDeletion's own background attempt.
  await enqueue({
    entityType: 'order_delete', endpoint: '/orders/1210', method: 'DELETE', payload: {}, profileKey: 'josie',
  });

  api.request = async () => {
    const err = new Error('Order not found');
    err.status = 404; // already deleted by an earlier attempt whose response was lost
    throw err;
  };
  const result = await drainOutbox();

  assert.equal(result.sent, 1, 'a 404 on a retried DELETE must count as success, not a failure');
  assert.equal(result.failed, 0);
  assert.equal((await listRecords()).length, 0, 'the record must clear from the outbox, not sit as an orphaned retry forever');
  assert.equal((await listNeedsAttention()).length, 0, 'nobody should have to act on a cleanup that already succeeded');
});

test('Deliverable 1: a still-local (never synced) orphaned draft is discarded with no DELETE call at all', async () => {
  await registerStation(1);
  // Left unreachable throughout, so the park's own background drain attempt (fired
  // by parkOrderLocalFirst) can never succeed — the record stays queued, which is
  // exactly the "still local" state cleanupOrphanedDraft must resolve without any
  // network call of its own.
  const deleteCalls = [];
  api.request = async (path, options) => {
    if (options.method === 'DELETE') deleteCalls.push(path);
    const err = new Error('Failed to fetch');
    throw err;
  };

  const { receipt_number } = await parkOrderLocalFirst({
    customer: { id: 3, name: 'Sari Sari' },
    items: [{ product_id: 1, quantity: 1, unit_price: 50 }],
    profileKey: 'josie',
  });
  await flushMicrotasks();
  assert.equal(await isDraftUnsynced(receipt_number), true);

  await cleanupOrphanedDraft({ draftRef: receipt_number, profileKey: 'josie' });
  await flushMicrotasks();

  assert.equal(await isDraftUnsynced(receipt_number), false, 'the still-local draft record must be gone');
  assert.equal((await listLocalParkedOrders()).length, 0);
  assert.equal(deleteCalls.length, 0, 'a still-local draft has nothing on the server to delete');
});

// ── Deliverable 2: parked orders (D6) ───────────────────────────────────────────

test('a draft parks locally when the online create fails, gets a device-issued number, and never touches receipt history (D9)', async () => {
  await registerStation(1);

  const { receipt_number, outboxId } = await parkOrderLocalFirst({
    customer: { id: 10, name: 'Tindahan ni Aling Josie' },
    orderType: 'pickup',
    items: [{ product_id: 5, quantity: 1, unit_price: 200 }],
    profileKey: 'luis',
  });

  assert.equal(receipt_number, '1-00001');
  assert.ok(outboxId);

  const local = await listLocalParkedOrders();
  assert.equal(local.length, 1);
  assert.equal(local[0].receipt_number, receipt_number);
  assert.equal(local[0].status, 'draft');
  assert.equal(local[0]._outboxId, outboxId);

  // A draft is not a receipt (D9) until it is actually finalized into a real order.
  assert.equal(await getReceipt(receipt_number), null);

  const records = await listRecords();
  assert.equal(records[0].payload.status, 'draft');
  assert.equal(records[0].receipt_number, receipt_number);
});

test('a locally quick-created customer syncs before the draft that references her (D5), same as a real sale', async () => {
  await registerStation(1);
  // Unreachable while queueing, so parkOrderLocalFirst's own background drain attempt
  // cannot race the explicit drain below.
  api.request = async () => { const err = new Error('Failed to fetch'); throw err; };

  const customerRecord = await enqueue({
    entityType: 'customer', endpoint: '/customers', profileKey: 'josie', payload: { name: 'New Suki' },
  });

  await parkOrderLocalFirst({
    customer: { id: `local-${customerRecord.id}`, _outboxId: customerRecord.id, name: 'New Suki' },
    items: [{ product_id: 1, quantity: 1, unit_price: 100 }],
    profileKey: 'josie',
  });
  await flushMicrotasks();

  const sent = [];
  api.request = async (path, options) => {
    sent.push(path);
    return path === '/customers' ? { id: 55 } : { id: 700, receipt_number: JSON.parse(options.body).receipt_number };
  };
  const result = await drainOutbox();
  assert.equal(result.sent, 2);
  assert.deepEqual(sent, ['/customers', '/orders']);
});

test('the union list drops a local park the moment its receipt number appears on the server — no duplicate row', async () => {
  await registerStation(1);
  const local = [
    { receipt_number: '1-00001', created_at: '2026-08-20T10:00:00Z' },
    { receipt_number: '1-00002', created_at: '2026-08-20T11:00:00Z' },
  ];
  const server = [
    { id: 900, receipt_number: '1-00001', created_at: '2026-08-20T10:00:00Z' }, // now synced
  ];

  const merged = mergeParkedOrders(server, local);
  assert.equal(merged.length, 2, 'the synced local one must not also appear from the local half');
  assert.deepEqual(merged.map((o) => o.receipt_number).sort(), ['1-00001', '1-00002']);
});

test('editing a still-local draft updates the outbox record in place; once synced, it is no longer "unsynced"', async () => {
  await registerStation(1);
  // Unreachable while parking and editing, so the record is still provably local —
  // not synced by a racing background drain — when updateLocalDraft runs.
  api.request = async () => { const err = new Error('Failed to fetch'); throw err; };

  const { receipt_number } = await parkOrderLocalFirst({
    customer: { id: 1, name: 'Aling Nena' },
    items: [{ product_id: 1, quantity: 1, unit_price: 100 }],
    profileKey: 'josie',
  });
  await flushMicrotasks();
  assert.equal(await isDraftUnsynced(receipt_number), true);

  const updated = await updateLocalDraft({
    receiptNumber: receipt_number,
    orderType: 'delivery',
    notes: 'Leave at gate',
    items: [{ product_id: 1, quantity: 3, unit_price: 100 }],
    adjustment: { value: 0, reason: '' },
    profileKey: 'josie',
  });
  assert.equal(updated.total_amount, 300);
  await flushMicrotasks();

  const records = await listRecords();
  assert.equal(records[0].payload.notes, 'Leave at gate');
  assert.equal(records[0].payload.items[0].quantity, 3);
  assert.equal(records[0].payload.status, 'draft', 'still parked, not somehow finalized by the edit');

  // The line returns and the draft syncs — it is no longer local.
  api.request = async (path, options) => {
    if (path === '/orders') return { id: 42, receipt_number: JSON.parse(options.body).receipt_number };
    throw new Error(`unexpected ${path}`);
  };
  await drainOutbox();
  assert.equal(await isDraftUnsynced(receipt_number), false);
});

test('discarding a still-local draft removes it from the outbox — it never resurrects on drain', async () => {
  await registerStation(1);
  api.request = async () => { throw new Error('a discarded draft must never reach the server'); };

  const { receipt_number } = await parkOrderLocalFirst({
    customer: { id: 1, name: 'Aling Nena' },
    items: [{ product_id: 1, quantity: 1, unit_price: 100 }],
    profileKey: 'josie',
  });
  await flushMicrotasks();

  await discardLocalDraft(receipt_number);
  assert.equal(await isDraftUnsynced(receipt_number), false);
  assert.equal((await listLocalParkedOrders()).length, 0);

  const result = await drainOutbox();
  assert.equal(result.sent, 0);
});

// ── Deliverable 2: possible-double flagging (D6 reusing D4's exact pattern) ─────

test('two independently-printed copies of the same parked order are flagged as a possible double', () => {
  const orders = [
    { id: 1, customer_id: 5, order_type: 'delivery', status: 'pending', total_amount: 600, adjustment: 0, receipt_number: '1-00010' },
    { id: 2, customer_id: 5, order_type: 'delivery', status: 'pending', total_amount: 600, adjustment: 0, receipt_number: '2-00003' },
    // A different total — a different order, not a double.
    { id: 3, customer_id: 5, order_type: 'delivery', status: 'pending', total_amount: 900, adjustment: 0, receipt_number: '2-00004' },
    // Cancelled — already handled by the owner, excluded.
    { id: 4, customer_id: 5, order_type: 'delivery', status: 'cancelled', total_amount: 600, adjustment: 0, receipt_number: '1-00011' },
    // No device-issued number (pre-2.5 order) — excluded.
    { id: 5, customer_id: 5, order_type: 'delivery', status: 'pending', total_amount: 600, adjustment: 0, receipt_number: null },
  ];

  const groups = findPossibleDoubleGroups(orders);
  assert.equal(Object.keys(groups).length, 1);
  const ids = getPossibleDoubleOrderIds(orders);
  assert.deepEqual([...ids].sort(), [1, 2]);
  assert.equal(countPossibleDoubleOrders(orders), 2);
});

test('the same order returned twice is not a double — distinct receipt numbers are required', () => {
  const orders = [
    { id: 1, customer_id: 5, order_type: 'delivery', status: 'pending', total_amount: 600, adjustment: 0, receipt_number: '1-00010' },
    { id: 1, customer_id: 5, order_type: 'delivery', status: 'pending', total_amount: 600, adjustment: 0, receipt_number: '1-00010' },
  ];
  assert.equal(countPossibleDoubleOrders(orders), 0);
});

test('post-drain toast reuses D4\'s exact shape, appending an orders-may-be-doubled clause only when there is one to say', () => {
  const toasts = [];
  const addToast = (msg, type) => toasts.push({ msg, type });

  const orders = [
    { id: 1, customer_id: 5, order_type: 'delivery', status: 'pending', total_amount: 600, adjustment: 0, receipt_number: '1-00010' },
    { id: 2, customer_id: 5, order_type: 'delivery', status: 'pending', total_amount: 600, adjustment: 0, receipt_number: '2-00003' },
  ];

  const res = notifyDrainCompleteWith({ sent: 14, waiting: 0, customers: [], orders, addToast }, true);
  assert.equal(res.message, '14 receipts synced · 2 orders may be doubled');
  assert.equal(toasts[0].msg, '14 receipts synced · 2 orders may be doubled');

  // No customers, no orders: the message stays exactly what piece 4 already shipped.
  const plain = notifyDrainCompleteWith({ sent: 3, waiting: 0, customers: [], orders: [], addToast }, true);
  assert.equal(plain, false, 'once per outage — already fired above');
});

// ── Deliverable 3: the quiet catalogue (D16) ────────────────────────────────────

test('loadCatalogue refreshes the held copy when the server is reachable', async () => {
  const products = [{ id: 1, name: 'Coke', is_active: true }];
  const customers = [{ id: 1, name: 'Aling Nena', is_active: true }];
  api.get = async (path) => (path === '/products' ? products : customers);

  const result = await loadCatalogue();
  assert.equal(result.fromCache, false);
  assert.deepEqual(result.products, products);
  assert.deepEqual(result.customers, customers);

  assert.deepEqual(await getCachedProducts(), products);
  assert.deepEqual(await getCachedCustomers(), customers);
});

test('loadCatalogue falls back to the held copy when the server is unreachable — no error, no staleness signal returned', async () => {
  const products = [{ id: 9, name: 'Sprite', is_active: true }];
  const customers = [{ id: 9, name: 'Mang Juan', is_active: true }];
  api.get = async (path) => (path === '/products' ? products : customers);
  await loadCatalogue(); // primes the cache

  api.get = async () => { throw new Error('Failed to fetch'); };
  const result = await loadCatalogue();
  assert.equal(result.fromCache, true);
  assert.deepEqual(result.products, products);
  assert.deepEqual(result.customers, customers);
});

test('loadCatalogue on a brand-new device with an empty cache and no connectivity returns empty, never throws', async () => {
  api.get = async () => { throw new Error('Failed to fetch'); };
  const result = await loadCatalogue();
  assert.equal(result.fromCache, true);
  assert.deepEqual(result.products, []);
  assert.deepEqual(result.customers, []);
});

// ── D18: the release switch ─────────────────────────────────────────────────────

test('with the switch off, the possible-double toast clause never appears', () => {
  assert.equal(V25_OFFLINE_CORE, false);
  const toasts = [];
  const orders = [
    { id: 1, customer_id: 5, order_type: 'delivery', status: 'pending', total_amount: 600, adjustment: 0, receipt_number: '1-00010' },
    { id: 2, customer_id: 5, order_type: 'delivery', status: 'pending', total_amount: 600, adjustment: 0, receipt_number: '2-00003' },
  ];
  const res = notifyDrainCompleteWith({ sent: 5, waiting: 0, orders, addToast: (m, t) => toasts.push({ m, t }) }, false);
  assert.equal(res, false);
  assert.equal(toasts.length, 0);
});
