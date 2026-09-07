// G7 (docs/offline-accessibility-acceptance-criteria.md) — editing an existing
// customer offline queued and synced correctly, but nothing on the customer's row in
// the directory said so. Inventory already had both halves of this affordance
// (queuedProductsFromOutbox for a product CREATED blind, pendingProductEditIds for one
// EDITED blind); Customers only had the first half. This pins down the fix:
// pendingCustomerEditIds() in queuedCustomers.js, mirroring pendingProductEditIds()'s
// exact approach, wired into CustomersPage.jsx's existing "⏳ Waiting to sync" badge.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, React, act } from './render.mjs';
import { api } from '../src/api/client.js';
import { ToastProvider } from '../src/components/ui/Toast.jsx';
import { nativeStore, __resetMemoryBackend } from '../src/offline/nativeStore.js';
import { CUSTOMERS_KEY } from '../src/offline/keys.js';
import { __clearOutbox, listRecords } from '../src/offline/outbox.js';
import { updateCustomerLocalFirst, pendingCustomerEditIds } from '../src/offline/queuedCustomers.js';
import { applyCatalogueDelta } from '../src/offline/catalogue.js';

const CustomersPage = (await import('../src/pages/customers/CustomersPage.jsx')).default;

const CUSTOMER = {
  id: 4, name: 'Tindahan ni Juan', customer_type: 'regular', phone: '09998887777',
  address: 'Marikina City', notes: '', is_active: true,
};

let saved = {};

beforeEach(async () => {
  saved = { get: api.get, post: api.post, patch: api.patch, del: api.del, request: api.request };
  await __resetMemoryBackend();
  await __clearOutbox();
  localStorage.clear();
  localStorage.setItem('activeProfile', 'josie');
});

afterEach(() => {
  Object.assign(api, saved);
  localStorage.clear();
});

const offline = () => { throw new TypeError('Failed to fetch'); };
const settle = (ms = 40) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

// ── pendingCustomerEditIds() ──────────────────────────────────────────────────

test('pendingCustomerEditIds: nothing pending to begin with', async () => {
  assert.equal((await pendingCustomerEditIds()).size, 0);
});

test('pendingCustomerEditIds: a queued customer_update is reported by id', async () => {
  api.request = async () => offline();
  await applyCatalogueDelta('customers', [CUSTOMER]);

  await updateCustomerLocalFirst(CUSTOMER.id, { phone: '09991112222' }, { profileKey: 'josie' });

  const pending = await pendingCustomerEditIds();
  assert.ok(pending.has(String(CUSTOMER.id)), 'the customer just edited says so');
});

test('pendingCustomerEditIds: a queued CREATE is not reported as a pending edit — it has no row to badge', async () => {
  api.request = async () => offline();
  const { enqueue } = await import('../src/offline/outbox.js');
  await enqueue({
    entityType: 'customer', endpoint: '/customers', method: 'POST',
    payload: { name: 'New Sari-Sari' }, profileKey: 'josie',
  });

  assert.equal((await pendingCustomerEditIds()).size, 0);
  assert.equal((await listRecords()).filter((r) => r.entity_type === 'customer').length, 1);
});

test('pendingCustomerEditIds: the badge clears itself once the edit drains', async () => {
  api.request = async () => offline();
  await applyCatalogueDelta('customers', [CUSTOMER]);

  await updateCustomerLocalFirst(CUSTOMER.id, { phone: '09991112222' }, { profileKey: 'josie' });
  assert.equal((await pendingCustomerEditIds()).size, 1);

  api.request = async () => ({ ...CUSTOMER, phone: '09991112222' });
  const { drainOutbox } = await import('../src/offline/outbox.js');
  await drainOutbox();

  assert.equal((await pendingCustomerEditIds()).size, 0, 'nothing is still waiting');
});

// ── CustomersPage: the row badge itself ───────────────────────────────────────

test('CustomersPage: an offline-edited customer row shows Waiting to sync', async () => {
  await nativeStore.setJson(CUSTOMERS_KEY, [CUSTOMER]);
  api.get = async () => offline();
  api.request = async () => offline();

  const r = render(React.createElement(ToastProvider, null, React.createElement(CustomersPage)));
  await settle();

  assert.match(r.text(), /Tindahan ni Juan/);
  assert.doesNotMatch(r.text(), /Waiting to sync/, 'nothing queued yet');

  await act(async () => {
    await updateCustomerLocalFirst(CUSTOMER.id, { phone: '09991112222' }, { profileKey: 'josie' });
  });
  await settle();

  assert.match(r.text(), /Waiting to sync/, 'the edited row now shows the sync badge');
  r.unmount();
});
