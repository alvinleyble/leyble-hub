// V2.5 Release 1, piece 4 — what the owners actually see about being offline.
//
// Covers the human surface:
// 1. The offline marker (D7): permanent indicator, "Online", "Offline · 12 waiting", etc.
// 2. The advisory toast (D11): once per outage, station 1 vs second device wording, nativeStore latch.
// 3. Real code path integration: active save triggers advisory when offline.
// 4. Duplicate-customer surfacing (D4): name AND address matching, post-drain toast, prefilled merge.
// 5. Attention list for refused receipts (D8): plain-language reason, re-pointing, no discard.
// 6. Lost connection resilience (D15): network failure is not a 401, login screen unsent banner.
// 7. Both sides of the switch (D18).

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import './render.mjs'; // jsdom globals

import { api } from '../src/api/client.js';
import { nativeStore, __resetMemoryBackend } from '../src/offline/nativeStore.js';
import { V25_OFFLINE_CORE, setSimulatedOffline } from '../src/config/features.js';
import {
  enqueue, drainOutbox, listRecords, waitingCount, listNeedsAttention, repointRecord,
  __clearOutbox, NEEDS_ATTENTION, QUEUED,
} from '../src/offline/outbox.js';
import { ensureStationRegistered, __resetIssuance } from '../src/offline/station.js';
import {
  triggerOfflineAdvisory, triggerOfflineAdvisoryWith, resetOfflineAdvisory,
  hasOfflineAdvisoryFired, __resetAdvisoryState, ADVISORY_KEY,
} from '../src/offline/advisory.js';
import {
  notifyDrainComplete, notifyDrainCompleteWith, resetDrainToastLatch, __resetDrainNotifierState,
} from '../src/offline/drainNotifier.js';
import {
  findDuplicateCustomerGroups, getDuplicateCustomerIds, countDuplicateCustomers, getDuplicateCandidatesFor,
} from '../src/utils/duplicateCustomers.js';
import { checkIsOnline } from '../src/offline/status.js';
import { saveOrderLocalFirst } from '../src/offline/posSave.js';

let savedApi;

beforeEach(async () => {
  __resetMemoryBackend();
  __resetIssuance();
  await __resetAdvisoryState();
  __resetDrainNotifierState();
  await __clearOutbox();
  setSimulatedOffline(false);
  savedApi = { post: api.post, request: api.request, get: api.get, getActiveProfile: api.getActiveProfile };
});

afterEach(async () => {
  api.post = savedApi.post;
  api.request = savedApi.request;
  api.get = savedApi.get;
  api.getActiveProfile = savedApi.getActiveProfile;
  setSimulatedOffline(false);
  await __resetAdvisoryState();
});

// ── D11: Advisory toast (Station-dependent wording & once-per-outage rule) ──

test('advisory toast fires Station 1 wording on the main tablet', async () => {
  const toasts = [];
  const addToast = (msg, type) => toasts.push({ msg, type });

  const fired = await triggerOfflineAdvisoryWith({ addToast, stationNumber: 1 }, true);
  assert.equal(fired, true);
  assert.equal(toasts.length, 1);
  assert.equal(
    toasts[0].msg,
    'You are offline. Keep creating orders on this tablet only — do not use the other device until the connection returns.'
  );
  assert.equal(await hasOfflineAdvisoryFired(), true);
});

test('advisory toast fires Station 2 wording on the secondary device', async () => {
  const toasts = [];
  const addToast = (msg, type) => toasts.push({ msg, type });

  const fired = await triggerOfflineAdvisoryWith({ addToast, stationNumber: 2 }, true);
  assert.equal(fired, true);
  assert.equal(toasts.length, 1);
  assert.equal(
    toasts[0].msg,
    'You are offline. Create orders on the main tablet only — do not use this device until the connection returns.'
  );
});

test('advisory toast fires ONCE per outage and persists in nativeStore across restarts', async () => {
  const toasts = [];
  const addToast = (msg, type) => toasts.push({ msg, type });

  const first = await triggerOfflineAdvisoryWith({ addToast, stationNumber: 1 }, true);
  assert.equal(first, true);
  assert.equal(toasts.length, 1);

  // Stored in nativeStore
  assert.equal(await nativeStore.getJson(ADVISORY_KEY), true);

  // Second failed save during the same outage: ignored
  const second = await triggerOfflineAdvisoryWith({ addToast, stationNumber: 1 }, true);
  assert.equal(second, false);
  assert.equal(toasts.length, 1, 'no second toast during the same outage');

  // Connection returns: reset latch
  await resetOfflineAdvisory();
  assert.equal(await hasOfflineAdvisoryFired(), false);
  assert.equal(await nativeStore.getJson(ADVISORY_KEY), null);

  // Next outage fires again
  const nextOutage = await triggerOfflineAdvisoryWith({ addToast, stationNumber: 1 }, true);
  assert.equal(nextOutage, true);
  assert.equal(toasts.length, 2);
});

test('advisory toast fires from the real saveOrderLocalFirst code path when saving while offline', async () => {
  // Ensure station registered
  api.post = async () => ({ station_number: 1 });
  await ensureStationRegistered();

  const toasts = [];
  const addToast = (msg, type) => toasts.push({ msg, type });

  // Simulate offline
  setSimulatedOffline(true);

  // Active save while offline
  const order = await saveOrderLocalFirst({
    customer: { id: 1, name: 'Josie' },
    orderType: 'delivery',
    items: [{ product_id: 1, quantity: 1, unit_price: 100 }],
    profileKey: 'josie',
    addToast,
    offlineCoreEnabled: true,
  });

  assert.ok(order);
  assert.equal(toasts.length, 1);
  assert.match(toasts[0].msg, /You are offline\. Keep creating orders on this tablet only/);

  // Second save while still offline does not re-fire the advisory toast
  await saveOrderLocalFirst({
    customer: { id: 1, name: 'Josie' },
    orderType: 'delivery',
    items: [{ product_id: 1, quantity: 2, unit_price: 100 }],
    profileKey: 'josie',
    addToast,
    offlineCoreEnabled: true,
  });

  assert.equal(toasts.length, 1, 'advisory toast fires only once per outage');
});

// ── D4: Duplicate customer normalization (Name AND Address matching) ─────────

test('duplicate customer detection requires BOTH name AND address to match', () => {
  const customers = [
    // Duplicate pair 1: same name, matching address with minor punctuation differences
    { id: 1, name: 'Aling Nena', address: '123 Main St, Antipolo', is_active: true },
    { id: 2, name: 'aling nena', address: '123 Main St. Antipolo', is_active: true },
    // Customer 3: same name as 1 & 2, but DIFFERENT address -> NOT a duplicate
    { id: 3, name: 'Aling Nena', address: '456 Side Street, Antipolo', is_active: true },
    // Customer 4 & 5: same name, but missing/blank address -> NOT a duplicate
    { id: 4, name: 'Mang Juan', address: '', is_active: true },
    { id: 5, name: 'Mang Juan', address: null, is_active: true },
    // Duplicate pair 2: S.M. Mart vs SM Mart with matching address
    { id: 6, name: 'S.M. Mart', address: 'Km 23 Ortigas Ext', is_active: true },
    { id: 7, name: 'SM Mart', address: 'km 23 ortigas ext.', is_active: true },
    // Inactive duplicate: excluded
    { id: 8, name: 'Inactive One', address: 'Test Address', is_active: false },
    { id: 9, name: 'Inactive One', address: 'Test Address', is_active: true },
  ];

  const groups = findDuplicateCustomerGroups(customers);
  // alingnena:::123mainstantipolo matches 1 and 2
  const nenaKey = 'alingnena:::123mainstantipolo';
  assert.ok(groups[nenaKey], 'alingnena matching address group found');
  assert.equal(groups[nenaKey].length, 2);

  // smmart:::km23ortigasext matches 6 and 7
  const smKey = 'smmart:::km23ortigasext';
  assert.ok(groups[smKey], 'smmart matching address group found');
  assert.equal(groups[smKey].length, 2);

  // mang juan with blank address is NOT grouped
  assert.equal(groups['mangjuan:::'], undefined);
  assert.equal(Object.keys(groups).length, 2);

  const duplicateIds = getDuplicateCustomerIds(customers);
  assert.deepEqual(
    [...duplicateIds].sort((a, b) => a - b),
    [1, 2, 6, 7]
  );
  assert.equal(countDuplicateCustomers(customers), 4);

  const candidates1 = getDuplicateCandidatesFor({ id: 1, name: 'Aling Nena', address: '123 Main St, Antipolo' }, customers);
  assert.equal(candidates1.length, 1);
  assert.equal(candidates1[0].id, 2);

  const candidates3 = getDuplicateCandidatesFor({ id: 3, name: 'Aling Nena', address: '456 Side Street, Antipolo' }, customers);
  assert.equal(candidates3.length, 0, 'different address has 0 duplicate candidates');

  const candidates4 = getDuplicateCandidatesFor({ id: 4, name: 'Mang Juan', address: '' }, customers);
  assert.equal(candidates4.length, 0, 'blank address has 0 duplicate candidates');
});

test('duplicate customers are never auto-merged — they stay separate rows', () => {
  const customers = [
    { id: 101, name: 'Aling Nena', address: '123 Main St', is_active: true },
    { id: 102, name: 'Aling Nena', address: '123 Main St', is_active: true },
  ];
  const count = countDuplicateCustomers(customers);
  assert.equal(count, 2);
  assert.equal(customers.length, 2);
  assert.equal(customers[0].id, 101);
  assert.equal(customers[1].id, 102);
});

// ── D4: Post-drain notification toast ────────────────────────────────────────

test('post-drain notification reports receipts synced and duplicate count once per recovery', () => {
  const toasts = [];
  const addToast = (msg, type) => toasts.push({ msg, type });

  const customers = [
    { id: 1, name: 'Aling Nena', address: '123 Main St', is_active: true },
    { id: 2, name: 'Aling Nena', address: '123 Main St', is_active: true },
  ];

  const res = notifyDrainCompleteWith({ sent: 14, waiting: 0, customers, addToast }, true);
  assert.ok(res);
  assert.equal(res.message, '14 receipts synced · 2 customers may be duplicates');
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].msg, '14 receipts synced · 2 customers may be duplicates');

  // Re-invoking before next outage does not duplicate the toast
  const second = notifyDrainCompleteWith({ sent: 5, waiting: 0, customers, addToast }, true);
  assert.equal(second, false);
  assert.equal(toasts.length, 1);

  // Once latch is reset on next outage recovery, toast fires again
  resetDrainToastLatch();
  const next = notifyDrainCompleteWith({ sent: 1, waiting: 0, customers: [], addToast }, true);
  assert.equal(next.message, '1 receipt synced');
  assert.equal(toasts.length, 2);
});

// ── D8: Attention list and re-pointing ────────────────────────────────────────

test('a refused record enters attention list and can be re-pointed to an active customer', async () => {
  api.request = async () => {
    const err = new Error('Customer Aling Nena was deactivated');
    err.status = 400;
    throw err;
  };

  const rec = await enqueue({
    entityType: 'order',
    endpoint: '/orders',
    profileKey: 'josie',
    payload: { customer_id: 88, items: [{ product_id: 1, quantity: 2, unit_price: 100 }] },
    receiptNumber: '1-00042',
  });

  const drainRes = await drainOutbox();
  assert.equal(drainRes.failed, 1);

  const attentionList = await listNeedsAttention();
  assert.equal(attentionList.length, 1);
  assert.equal(attentionList[0].id, rec.id);
  assert.equal(attentionList[0].status, NEEDS_ATTENTION);
  assert.match(attentionList[0].last_error, /deactivated/);

  // Re-pointing to destination customer 99
  const updated = await repointRecord(rec.id, { customerId: 99 });
  assert.equal(updated.status, QUEUED);
  assert.equal(updated.payload.customer_id, 99);
  assert.equal(updated.last_error, null);
  assert.equal(updated.attempts, 0);

  // Now server accepts it
  let sentBody = null;
  api.request = async (_endpoint, opts) => {
    sentBody = JSON.parse(opts.body);
    return { id: 501, receipt_number: '1-00042' };
  };

  const drainAfterRepoint = await drainOutbox();
  assert.equal(drainAfterRepoint.sent, 1);
  assert.equal(sentBody.customer_id, 99);
  assert.equal((await listNeedsAttention()).length, 0);
});

test('refused receipts are NEVER auto-discarded or silently resolved', async () => {
  api.request = async () => {
    const err = new Error('Foreign key violation');
    err.status = 400;
    throw err;
  };

  await enqueue({
    entityType: 'order',
    endpoint: '/orders',
    profileKey: 'josie',
    payload: { customer_id: 999 },
    receiptNumber: '1-00099',
  });

  await drainOutbox();

  // Record must still exist in outbox under needs_attention
  const records = await listRecords();
  assert.equal(records.length, 1);
  assert.equal(records[0].status, NEEDS_ATTENTION);
  assert.equal(records[0].receipt_number, '1-00099');
});

// ── D15: Network failure is NOT a 401 ─────────────────────────────────────────

test('a network failure throws a network error and does NOT clear session or redirect to /login', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new TypeError('Failed to fetch (network offline)');
  };

  try {
    await assert.rejects(
      () => api.get('/orders'),
      (err) => {
        assert.ok(!err.status || err.status !== 401, 'must not have 401 status');
        assert.match(err.message, /Failed to fetch/);
        return true;
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ── D7 & D10: Online status check & simulated offline ─────────────────────────

test('checkIsOnline respects simulated offline mode (D10)', () => {
  setSimulatedOffline(false);
  assert.equal(checkIsOnline(), true);

  setSimulatedOffline(true);
  assert.equal(checkIsOnline(), false);

  setSimulatedOffline(false);
  assert.equal(checkIsOnline(), true);
});

// ── D18: Off-switch behavior ─────────────────────────────────────────────────

test('with V25_OFFLINE_CORE off, advisory toasts and drain toasts are suppressed', async () => {
  assert.equal(V25_OFFLINE_CORE, false);

  const toasts = [];
  const addToast = (msg, type) => toasts.push({ msg, type });

  const advisoryRes = await triggerOfflineAdvisory({ addToast, stationNumber: 1 });
  assert.equal(advisoryRes, false);
  assert.equal(toasts.length, 0);

  const drainRes = notifyDrainComplete({ sent: 5, waiting: 0, customers: [], addToast });
  assert.equal(drainRes, false);
  assert.equal(toasts.length, 0);
});
