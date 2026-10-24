// Production, 2026-10-23: a device sent `PATCH /api/v1/customers/[object Object]`.
// Postgres refused the id (22P02) and that one record jammed the device's sync queue.
//
// The record came from the combined "Save as Customer Defaults?" prompt, editing an
// order that was still waiting to sync for a customer this device had created offline
// — once her own POST /customers had already drained. With her queued create gone,
// the order modal could only rebuild her from the order's `local-<outboxId>` id, and
// that rebuilt row carried no `_outboxId`. The delivery-fee write then queued
// `endpointParams: { customerId: { $ref: undefined, field: 'id' } }`; JSON drops the
// undefined `$ref`, the stored `{ field: 'id' }` no longer looks like a reference, and
// the drain pasted the object itself into the URL.
//
// Every customer edit the app queues must reach the server under her real id.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, React, act } from './render.mjs';
import { api } from '../src/api/client.js';
import { ToastProvider } from '../src/components/ui/Toast.jsx';
import { nativeStore, __resetMemoryBackend } from '../src/offline/nativeStore.js';
import { STATION_KEY } from '../src/offline/keys.js';
import { ensureStationRegistered, __resetIssuance } from '../src/offline/station.js';
import { __clearOutbox, listRecords, enqueue, drainOutbox, ref } from '../src/offline/outbox.js';
import { saveOrderLocalFirst } from '../src/offline/posSave.js';
import { parkOrderLocalFirst, listLocalParkedOrders } from '../src/offline/parkedOrders.js';
import { updateCustomerLocalFirst } from '../src/offline/queuedCustomers.js';
import { stopReachabilityWatcher, __resetStatusState } from '../src/offline/status.js';

const OrderCreateModal = (await import('../src/pages/orders/OrderCreateModal.jsx')).default;

const SERVER_CUSTOMER_ID = 42;

const products = [
  { id: 1, name: 'Coke Sakto 200ml', sku: 'C-8', category: 'Softdrinks', unit: 'cs',
    base_wholesale_price: 300, units_per_case: 1, is_active: true,
    requires_bottle_return: false, deposit_fee: 0 },
];

const offline = () => { throw new TypeError('Failed to fetch'); };
// A save kicks off its own background drain; wait for it rather than be skipped by it.
async function drainNow() {
  for (let i = 0; i < 50; i++) {
    const res = await drainOutbox();
    if (!res.skipped) return res;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('the outbox never stopped draining');
}

const settle = (ms = 40) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

let saved;

beforeEach(async () => {
  saved = { get: api.get, post: api.post, patch: api.patch, del: api.del, request: api.request };
  localStorage.clear();
  localStorage.setItem('activeProfile', 'josie');
  await __resetMemoryBackend();
  __resetIssuance();
  await __clearOutbox();
  await nativeStore.setJson(STATION_KEY, { device_key: 'test-device-real-id', station_number: 9 });
  api.post = async () => ({ registered_at: '2026-10-24T00:00:00.000Z' });
  await ensureStationRegistered();

  // The server knows her by now; this device's catalogue copy has not caught up.
  api.get = async (path) => {
    if (path.startsWith('/products')) return products;
    if (path.startsWith('/customers')) return [];
    if (path.startsWith('/personnel')) return [];
    return [];
  };
  api.request = async () => offline();
});

afterEach(() => {
  stopReachabilityWatcher();
  __resetStatusState();
  Object.assign(api, saved);
  localStorage.clear();
});

// A customer created offline, an order for her saved behind her, and then a drain in
// which her create reaches the server but the order does not.
async function syncOnlyHerCreate(saveBehindHer) {
  const customerRecord = await enqueue({
    entityType: 'customer', endpoint: '/customers', method: 'POST',
    payload: { name: 'Bagong Suki', customer_type: 'regular' }, profileKey: 'josie',
  });
  const saved = await saveBehindHer(
    { id: `local-${customerRecord.id}`, _outboxId: customerRecord.id, name: 'Bagong Suki' },
  );

  api.request = async (endpoint, opts) => {
    if (endpoint === '/customers' && opts.method === 'POST') {
      return { id: SERVER_CUSTOMER_ID, name: 'Bagong Suki' };
    }
    return offline();
  };
  await drainNow();
  const left = await listRecords();
  assert.ok(!left.some((r) => r.entity_type === 'customer'), 'her create has drained');
  assert.ok(left.some((r) => r.entity_type === 'order'), 'the order is still waiting');
  api.request = async () => offline();
  return saved;
}

test('saving an edited order\'s delivery fee as an offline-created customer\'s default PATCHes her real id', async () => {
  const order = await syncOnlyHerCreate((customer) => saveOrderLocalFirst({
    customer,
    orderType: 'delivery',
    items: [{ product_id: 1, product_name: 'Coke Sakto 200ml', quantity: 2, unit_price: 300 }],
    deliveryFeeCharged: 100,
    profileKey: 'josie',
    soldByName: 'Josie',
  }));

  const r = render(
    React.createElement(ToastProvider, null,
      React.createElement(OrderCreateModal, {
        editOrder: order, offlineUnsynced: true, onClose: () => {}, onSaved: () => {},
      }))
  );
  await settle(60);

  const saveBtn = r.all('button').find((b) => b.textContent.includes('Save Changes'));
  assert.ok(saveBtn, 'expected the "Save Changes" button');
  await act(async () => { r.click(saveBtn); await new Promise((res) => setTimeout(res, 60)); });

  assert.match(r.text(), /Save as Customer Defaults\?/, 'the delivery fee is offered as her default');
  const confirmBtn = r.all('button').find((b) => b.textContent.trim() === 'Yes, Save');
  assert.ok(confirmBtn, 'expected the "Yes, Save" confirm button');
  await act(async () => { r.click(confirmBtn); await new Promise((res) => setTimeout(res, 40)); });
  r.unmount();

  const update = (await listRecords()).find((rec) => rec.entity_type === 'customer_update');
  assert.ok(update, 'the delivery-fee default was queued');

  const sent = [];
  api.request = async (endpoint, opts) => {
    sent.push({ endpoint, method: opts.method });
    if (endpoint === '/orders') return { id: 900 };
    return { id: SERVER_CUSTOMER_ID };
  };
  await drainNow();

  const patches = sent.filter((s) => s.method === 'PATCH');
  assert.deepEqual(patches.map((s) => s.endpoint), [`/customers/${SERVER_CUSTOMER_ID}`]);
});

test('resuming a parked draft for an offline-created customer whose create has drained sells to her real id', async () => {
  await syncOnlyHerCreate((customer) => parkOrderLocalFirst({
    customer,
    orderType: 'delivery',
    items: [{ product_id: 1, quantity: 2, unit_price: 300 }],
    display: {
      customer_name: 'Bagong Suki',
      items: [{ product_id: 1, product_name: 'Coke Sakto 200ml', sku: 'C-8', unit: 'cs' }],
    },
    profileKey: 'josie',
  }));
  const [draft] = await listLocalParkedOrders();
  api.del = async () => {};

  const r = render(
    React.createElement(ToastProvider, null,
      React.createElement(OrderCreateModal, { editOrder: draft, onClose: () => {}, onSaved: () => {} }))
  );
  await settle(60);

  const createBtn = r.all('button').find((b) => b.textContent.includes('Create Order'));
  assert.ok(createBtn, 'expected the "Create Order" button');
  await act(async () => { r.click(createBtn); await new Promise((res) => setTimeout(res, 60)); });
  r.unmount();

  const sent = [];
  api.request = async (endpoint, opts) => {
    sent.push({ endpoint, method: opts.method, body: JSON.parse(opts.body) });
    return { id: 900 };
  };
  await drainNow();

  const sales = sent.filter((s) => s.endpoint === '/orders' && s.method === 'POST' && s.body.status !== 'draft');
  assert.deepEqual(sales.map((s) => s.body.customer_id), [SERVER_CUSTOMER_ID]);
});

test('updateCustomerLocalFirst queues the edit under the id it was given', async () => {
  await updateCustomerLocalFirst('7', { phone: '09991112222' }, { profileKey: 'josie' });
  const [record] = await listRecords();
  assert.equal(record.endpoint, '/customers/7');
});

test('a reference with no outbox record behind it is refused when it is made, not sent as [object Object]', () => {
  assert.throws(() => ref(undefined, 'id'), /outbox/i);
  assert.throws(() => ref(null, 'id'), /outbox/i);
});
