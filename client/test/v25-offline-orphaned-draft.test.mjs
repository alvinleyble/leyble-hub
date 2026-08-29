// V2.5 Release 1, piece 3, Deliverable 1 — the orphaned server-side draft.
//
// Regression: with V25_OFFLINE_CORE on, POSPage.jsx creates a server-side draft row
// early (around line 269, POST /orders with status:'draft'). Before this fix, Confirm
// & Print's V25_OFFLINE_CORE branch called saveOrderLocalFirst and abandoned that
// draft's row id entirely — the draft was never finalized and never deleted, so it
// sat in Drafts forever, and the Drafts badge climbed by one on every sale. Orders
// 1210 / 1213 in the captain's copy were orphaned this way by sales 2-00002 /
// 2-00004. These tests fail on the code before cleanupOrphanedDraft existed and
// handleConfirmPrint called it, and pass after.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import './render.mjs'; // jsdom globals

import { api } from '../src/api/client.js';
import { __resetMemoryBackend } from '../src/offline/nativeStore.js';
import {
  enqueue, drainOutbox, listRecords, listNeedsAttention, pendingDeletionRefs,
  __clearOutbox, QUEUED,
} from '../src/offline/outbox.js';
import { mergeParkedOrders } from '../src/offline/parkedOrders.js';
import { ensureStationRegistered, __resetIssuance } from '../src/offline/station.js';
import { saveOrderLocalFirst, cleanupOrphanedDraft } from '../src/offline/posSave.js';

let savedApi;

beforeEach(async () => {
  __resetMemoryBackend();
  __resetIssuance();
  await __clearOutbox();
  savedApi = { post: api.post, request: api.request, getActiveProfile: api.getActiveProfile };
});

afterEach(() => {
  api.post = savedApi.post;
  api.request = savedApi.request;
  api.getActiveProfile = savedApi.getActiveProfile;
});

async function registerStation(number = 1) {
  api.post = async () => ({ slot_number: number, next_sequence: 1, registered_at: '2026-08-23T00:00:00.000Z' });
  return ensureStationRegistered();
}

// Several offline writes (saveOrderLocalFirst, cleanupOrphanedDraft's own
// queueOrderDeletion) fire an internal background drainOutbox() alongside the write.
// A macrotask yield guarantees that attempt has fully settled (network-failure
// microtask chains, no timers involved) before a test swaps in a new api.request mock
// and drives its own explicit drain.
const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0));

test('REGRESSION: a local-first sale reconciles the draft it grew from — the draft is deleted, not left behind', async () => {
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

test('cleanup is queued through the outbox, not fire-and-forget, when the line is down at print time', async () => {
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

test('a repeated arrival of the cleanup is harmless — a 404 on retry counts as done, not a needs-attention item', async () => {
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

// ── Captain review round 1, item 1 ──────────────────────────────────────────────
//
// Live reproduction (localhost:5173, V25_OFFLINE_CORE on, simulated offline): the
// early-draft POST is a raw fetch, unaffected by the simulated-offline switch, so it
// reaches the real (still-running) dev server and creates a genuine numeric draft row
// — exactly the captain's setup. Confirm & Print's local-first save then makes that
// row orphaned, and cleanupOrphanedDraft correctly queues its deletion — but while
// genuinely offline, drainOutbox() (also gated on the same switch) never sends it.
// GET /orders?status=draft is a raw fetch too, so it keeps returning the row until
// the queued DELETE actually drains, which is exactly what the captain saw: the
// badge stuck on 1 through "Confirm & Print" and even after going back online, since
// nothing re-ran refreshCounts() once the drain finally emptied the outbox.
//
// The fix has two parts: a list built off the server's response must exclude a row
// this device already queued a deletion for (mergeParkedOrders + pendingDeletionRefs
// below), and POSPage.jsx now re-runs refreshCounts() on every outbox event via
// subscribeOutbox, so a background drain updates the badge with nobody watching.
test('REGRESSION (review round 1): a queued-but-undrained deletion is excluded from the merged list, not just from the outbox', async () => {
  await registerStation(2);

  // Genuinely offline: the queued deletion cannot drain yet.
  api.request = async () => { const err = new Error('Failed to fetch'); throw err; };

  // Confirm & Print orphaned the early server-side draft (captain's #1412).
  await cleanupOrphanedDraft({ draftRef: 1412, profileKey: 'josie' });
  await flushMicrotasks();

  const pending = await pendingDeletionRefs();
  assert.ok(pending.has('1412'), 'the queued deletion must be discoverable by its target ref');

  // The server has not processed the DELETE yet — its own list response still
  // includes the row, exactly what the captain's browser kept fetching.
  const serverDrafts = [
    { id: 1412, receipt_number: null, customer_id: 5, created_at: '2026-08-24T10:00:00Z' },
  ];

  const merged = mergeParkedOrders(serverDrafts, [], pending);
  assert.deepEqual(merged, [], 'a draft already queued for deletion must not still be counted or listed');
});

test('a deletion queued against a receipt-number ref (a synced local park) is excluded the same way', async () => {
  await registerStation(1);
  api.request = async () => { const err = new Error('Failed to fetch'); throw err; };

  await cleanupOrphanedDraft({ draftRef: '1-00007', profileKey: 'luis' });
  await flushMicrotasks();

  const pending = await pendingDeletionRefs();
  assert.ok(pending.has('1-00007'));

  const serverDrafts = [
    { id: 88, receipt_number: '1-00007', customer_id: 2, created_at: '2026-08-24T09:00:00Z' },
  ];
  assert.deepEqual(mergeParkedOrders(serverDrafts, [], pending), []);
});

test('pendingDeletionRefs ignores a deletion that has already drained', async () => {
  await enqueue({
    entityType: 'order_delete', endpoint: '/orders/500', method: 'DELETE',
    payload: { orderRef: 500 }, profileKey: 'josie',
  });
  api.request = async () => null; // succeeds — the DELETE actually lands
  await drainOutbox();

  assert.equal((await pendingDeletionRefs()).size, 0, 'a drained deletion must not keep hiding anything');
});
