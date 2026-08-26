// V3.0 Slice 3 — re-hosting the V2.5 offline core on V1's screens (G27–G31).
//
// Covers what this slice actually changed: OrderCreateModal's local-first save path
// and its local-* customer guards (G27/G29/G31), OrderDetailPage's local fallback +
// silent background sync + offline-edit gating (G27/G28), CustomersPage's queued-
// customer merge (G29), and the engine/test hygiene pieces in offline/index.js and
// config/features.js (G30).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, React, act } from './render.mjs';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { api } from '../src/api/client.js';
import { ToastProvider } from '../src/components/ui/Toast.jsx';
import { __resetMemoryBackend } from '../src/offline/nativeStore.js';
import { ensureStationRegistered, __resetIssuance } from '../src/offline/station.js';
import { __clearOutbox, listRecords } from '../src/offline/outbox.js';
import { putReceipt } from '../src/offline/receiptHistory.js';
import { saveOrderLocalFirst, cleanupOrphanedDraftDirect, updateLocalOrder } from '../src/offline/posSave.js';
import { notifyDrainCompleteWith, __resetDrainNotifierState } from '../src/offline/drainNotifier.js';
import { startOfflineCore, stopOfflineCore } from '../src/offline/index.js';

const { createRoot } = await import('react-dom/client');

const OrderDetailPage   = (await import('../src/pages/orders/OrderDetailPage.jsx')).default;
const CustomersPage     = (await import('../src/pages/customers/CustomersPage.jsx')).default;
const OrderCreateModal  = (await import('../src/pages/orders/OrderCreateModal.jsx')).default;

// Same shape as render.mjs's render(), but with a real Route match so useParams()
// resolves — needed for OrderDetailPage, which render.mjs's bare MemoryRouter can't
// provide since it doesn't accept initialEntries.
function renderAtRoute(path, routePath, element) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      React.createElement(MemoryRouter, { initialEntries: [path] },
        React.createElement(Routes, null,
          React.createElement(Route, { path: routePath, element })
        )
      )
    );
  });
  return {
    container,
    text: () => container.textContent,
    unmount: () => act(() => { root.unmount(); }),
    all: (selector) => [...container.querySelectorAll(selector)],
    byLabel: (label) => container.querySelector(`[aria-label="${label}"]`),
    click: (el) => act(() => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); }),
  };
}

const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0));

// Same technique as v3-s1-order-create-modal.test.mjs: call the fiber's own onChange
// directly (not just dispatchEvent) — jsdom's IE-input-event polyfill in this React
// version throws on plain dispatchEvent alone (`attachEvent is not a function`),
// which otherwise leaves onChange never firing and Combobox's `open` state stuck.
function changeInput(input, value) {
  const descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
  descriptor.set.call(input, value);
  const reactPropsKey = Object.keys(input).find((k) => k.startsWith('__reactProps'));
  if (reactPropsKey && input[reactPropsKey]?.onChange) {
    input[reactPropsKey].onChange({ target: { value, type: input.type || 'text', checked: input.checked } });
  }
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  input.dispatchEvent(new window.Event('change', { bubbles: true }));
}

let saved = {};

beforeEach(async () => {
  saved = { get: api.get, post: api.post, patch: api.patch, del: api.del, request: api.request };
  await __resetMemoryBackend();
  __resetIssuance();
  await __clearOutbox();
  localStorage.setItem('activeProfile', 'josie');
});

afterEach(() => {
  api.get = saved.get;
  api.post = saved.post;
  api.patch = saved.patch;
  api.del = saved.del;
  api.request = saved.request;
});

async function enqueueCustomer(profileKey, name) {
  const { enqueue } = await import('../src/offline/outbox.js');
  return enqueue({
    entityType: 'customer', endpoint: '/customers', method: 'POST',
    payload: { name, customer_type: 'regular' }, profileKey,
  });
}

async function registerStation(number = 1) {
  api.post = async (path) => (path === '/stations/register'
    ? { station_number: number, registered_at: '2026-08-26T00:00:00.000Z' }
    : {});
  return ensureStationRegistered();
}

// ── G31 — personnel plumbing ─────────────────────────────────────────────────

test('G31: saveOrderLocalFirst carries personnel onto the local receipt (display shape) and the outbox payload (server shape)', async () => {
  await registerStation(4);
  api.request = async () => { const err = new Error('Failed to fetch'); throw err; };

  const order = await saveOrderLocalFirst({
    customer: { id: 5, name: 'Aling Nena' },
    items: [{ product_id: 1, product_name: 'Coke', quantity: 1, unit_price: 300 }],
    personnel: [
      { id: 9, role: 'Driver', full_name: 'Mang Jun' },
      { id: 10, role: 'Helper', full_name: 'Pedro' },
    ],
    profileKey: 'josie',
  });

  assert.deepEqual(order.personnel, [
    { id: 9, role: 'Driver', full_name: 'Mang Jun' },
    { id: 10, role: 'Helper', full_name: 'Pedro' },
  ]);

  const record = (await listRecords()).find((r) => r.entity_type === 'order');
  assert.ok(record, 'the order must still be queued for sync');
  assert.deepEqual(record.payload.personnel, [{ id: 9, role: 'Driver' }, { id: 10, role: 'Helper' }],
    'the outbox payload must match server/src/routes/orders.js syncPersonnel\'s {id, role} shape');
});

test('G31: updateLocalOrder rewrites personnel on both the local receipt and the still-queued outbox payload', async () => {
  await registerStation(2);
  api.request = async () => { const err = new Error('Failed to fetch'); throw err; };

  const order = await saveOrderLocalFirst({
    customer: { id: 5, name: 'Aling Nena' },
    items: [{ product_id: 1, product_name: 'Coke', quantity: 1, unit_price: 300 }],
    personnel: [{ id: 9, role: 'Driver', full_name: 'Mang Jun' }],
    profileKey: 'josie',
  });

  const updated = await updateLocalOrder({
    order,
    items: [{ product_id: 1, product_name: 'Coke', quantity: 2, unit_price: 300 }],
    notes: '',
    adjustment: { value: 0, reason: '' },
    personnel: [{ id: 9, role: 'Helper', full_name: 'Mang Jun' }, { id: 11, role: 'Driver', full_name: 'Ana' }],
  });

  assert.deepEqual(updated.personnel, [
    { id: 9, role: 'Helper', full_name: 'Mang Jun' },
    { id: 11, role: 'Driver', full_name: 'Ana' },
  ]);

  const record = (await listRecords()).find((r) => r.entity_type === 'order');
  assert.deepEqual(record.payload.personnel, [{ id: 9, role: 'Helper' }, { id: 11, role: 'Driver' }]);
});

// ── G27 — draft cleanup must never enter the outbox ──────────────────────────

test('G27: cleanupOrphanedDraftDirect deletes directly and never queues through the outbox, even when the delete fails', async () => {
  let deletedPath = null;
  api.del = async (path) => { deletedPath = path; throw new Error('offline'); };

  cleanupOrphanedDraftDirect(555);
  await flushMicrotasks();

  assert.equal(deletedPath, '/orders/555');
  assert.equal((await listRecords()).length, 0,
    'a throwaway draft delete must never sit in the outbox — that is exactly what caused the rejected PR\'s "Offline · 1 waiting" lockup');
});

test('G27: cleanupOrphanedDraftDirect is a no-op for a null/undefined/empty draft id', async () => {
  let called = false;
  api.del = async () => { called = true; };
  cleanupOrphanedDraftDirect(null);
  cleanupOrphanedDraftDirect(undefined);
  cleanupOrphanedDraftDirect('');
  await flushMicrotasks();
  assert.equal(called, false);
});

// ── G27 — silent background sync signal ──────────────────────────────────────

test('G27: notifyDrainCompleteWith dispatches leyble:drain-complete only when a drain actually sent something, on every such drain (not once per outage)', async () => {
  __resetDrainNotifierState();
  const events = [];
  const handler = (e) => events.push(e.detail);
  window.addEventListener('leyble:drain-complete', handler);

  notifyDrainCompleteWith({ sent: 0, waiting: 2 }, true);
  assert.equal(events.length, 0, 'nothing synced — nothing to silently re-read');

  notifyDrainCompleteWith({ sent: 3, waiting: 1 }, true);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], { sent: 3, waiting: 1 });

  // The toast advisory only fires once per outage (drainToastFired latch), but the
  // sync signal is a different concern and must not be blocked by that latch.
  notifyDrainCompleteWith({ sent: 1, waiting: 0 }, true);
  assert.equal(events.length, 2, 'a screen showing "Waiting to sync" needs every drain, not just the first');

  window.removeEventListener('leyble:drain-complete', handler);
});

// ── G30 — engine/test hygiene ─────────────────────────────────────────────────

test('G30: startOfflineCore registers a station and starts the drain loop without VITE_V25_OFFLINE_CORE set', async () => {
  let registerCalled = false;
  api.post = async (path) => {
    if (path === '/stations/register') { registerCalled = true; return { station_number: 7, registered_at: '2026-08-26T00:00:00.000Z' }; }
    return {};
  };

  const result = await startOfflineCore();

  assert.equal(registerCalled, true,
    'V1\'s rehosted OrderCreateModal calls saveOrderLocalFirst() unconditionally — the engine must run unconditionally too, or a production build with the flag off can never issue receipt numbers');
  assert.equal(result.enabled, true);

  stopOfflineCore();
});

test('G30: window.__leyble.simulateOffline(true) persists across a same-tab reload via sessionStorage', async () => {
  sessionStorage.removeItem('leyble_simulated_offline');
  const mod1 = await import('../src/config/features.js');
  mod1.setSimulatedOffline(true);
  assert.equal(sessionStorage.getItem('leyble_simulated_offline'), 'true');

  // A fresh module evaluation stands in for a page reload in the same tab.
  const mod2 = await import(`../src/config/features.js?reload=${Date.now()}-${Math.random()}`);
  assert.equal(mod2.isSimulatedOffline(), true,
    'a reload mid-simulated-outage must not silently drop back to "online" with no warning');

  mod2.setSimulatedOffline(false);
  assert.equal(sessionStorage.getItem('leyble_simulated_offline'), null);
  mod1.setSimulatedOffline(false);
});

// ── G29 — local-* customer guards in OrderCreateModal ────────────────────────

const products = [
  { id: 1, name: 'Coke Sakto 200ml', sku: 'C-8', category: 'Softdrinks', unit: 'cs', base_wholesale_price: 300, is_active: true },
];

function stubOrderModalApis({ customers = [] } = {}) {
  const priceFetches = [];
  api.get = async (path) => {
    if (path === '/customers') return customers;
    if (path === '/products') return products;
    if (path === '/personnel') return [];
    if (path.startsWith('/orders?status=draft')) return [];
    if (path.includes('/prices')) { priceFetches.push(path); return []; }
    return [];
  };
  return priceFetches;
}

test('G29: quick-creating a customer offline queues POST /customers and yields a local-<id> customer, never a direct online POST', async () => {
  const priceFetches = stubOrderModalApis();
  let draftPostCalled = false;
  api.post = async (path) => {
    if (path === '/orders') { draftPostCalled = true; return { id: 1 }; }
    throw new Error(`unexpected POST ${path} — quick-create must go through the outbox (G29), not api.post directly`);
  };
  api.request = async () => { const err = new Error('Failed to fetch'); throw err; }; // background drain stays queued

  const r = render(
    React.createElement(ToastProvider, null,
      React.createElement(OrderCreateModal, { onClose: () => {}, onSaved: () => {} })
    )
  );
  await act(async () => { await new Promise((res) => setTimeout(res, 30)); });

  const custInput = r.byLabel('Customer');
  act(() => {
    custInput.focus();
    changeInput(custInput, 'Brand New Sari-Sari');
  });
  await act(async () => { await new Promise((res) => setTimeout(res, 20)); });

  const createBtn = r.all('button').find((b) => b.textContent.includes('Create') && b.textContent.includes('Brand New Sari-Sari'));
  assert.ok(createBtn, 'quick-create option should be offered');
  // Combobox's create row fires on mousedown (so the tap can't blur-close the list
  // first), not click.
  act(() => { createBtn.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true })); });
  await act(async () => { await new Promise((res) => setTimeout(res, 30)); });

  const records = await listRecords();
  const customerRecord = records.find((rec) => rec.entity_type === 'customer');
  assert.ok(customerRecord, 'the quick-create must be queued in the outbox');
  assert.equal(customerRecord.payload.name, 'Brand New Sari-Sari');

  // Selecting the freshly quick-created local customer must skip the saved-prices
  // fetch entirely (there is no real id yet to fetch prices for).
  assert.match(r.text(), /Brand New Sari-Sari/);
  assert.equal(priceFetches.length, 0, 'GET /customers/local-*/prices must never be attempted');

  // The early draft-on-customer-pick effect must also skip for a local customer.
  assert.equal(draftPostCalled, false, 'no server draft should be created for an unresolved local customer id');

  r.unmount();
});

// ── G28 — offline edit rewrites the local order instead of PATCHing ─────────

test('G28: editing an unsynced order writes through updateLocalOrder and never calls api.patch', async () => {
  await registerStation(3);
  api.request = async () => { const err = new Error('Failed to fetch'); throw err; };

  const localOrder = await saveOrderLocalFirst({
    customer: { id: 5, name: 'Aling Nena', customer_type: 'regular' },
    items: [{ product_id: 1, product_name: 'Coke Sakto 200ml', sku: 'C-8', quantity: 1, unit_price: 300 }],
    profileKey: 'josie',
  });

  stubOrderModalApis({ customers: [{ id: 5, name: 'Aling Nena', customer_type: 'regular', is_active: true }] });
  api.patch = async (path) => { throw new Error(`api.patch(${path}) must not be called — the order is still unsynced (G28)`); };

  const r = render(
    React.createElement(ToastProvider, null,
      React.createElement(OrderCreateModal, {
        editOrder: { ...localOrder, id: undefined },
        offlineUnsynced: true,
        onClose: () => {},
        onSaved: () => {},
      })
    )
  );
  await act(async () => { await new Promise((res) => setTimeout(res, 30)); });

  const cokeBtn = r.all('button').find((b) => b.getAttribute('aria-label')?.includes('Coke Sakto'));
  assert.ok(cokeBtn);
  r.click(cokeBtn); // bumps quantity from 1 to 1.5 cases
  await act(async () => { await new Promise((res) => setTimeout(res, 20)); });

  const saveBtn = r.all('button').find((b) => b.textContent.includes('Save Changes'));
  assert.ok(saveBtn);
  await act(async () => {
    r.click(saveBtn);
    await new Promise((res) => setTimeout(res, 50));
  });

  const record = (await listRecords()).find((rec) => rec.entity_type === 'order');
  assert.ok(record, 'the order must still be the same queued outbox record, rewritten in place');
  assert.equal(Number(record.payload.items[0].quantity), 1.5);

  r.unmount();
});

// REGRESSION (found live, 2026-08-26): saveOrderLocalFirst stored `customer_id: null`
// for an order placed for a still-local customer (only the outbox payload had the
// $ref — the local receipt never remembered the local id at all). Editing such an
// order rendered a BLANK customer picker, and submitting failed validation
// ("Select a customer.") because customerId could never be recovered from
// editOrder.customer_id. Fixed in posSave.js (customer_id keeps `local-<outboxId>`
// on the local receipt) and OrderCreateModal.jsx (synthesises a picker entry from
// editOrder when GET /customers can't have it yet).
test('G28/G29 REGRESSION: editing an order placed for a still-local customer keeps that customer selected, not blank', async () => {
  await registerStation(9);
  api.request = async () => { const err = new Error('Failed to fetch'); throw err; };

  const profileKey = await api.getActiveProfile();
  const customerRec = await enqueueCustomer(profileKey, 'Sari-Sari ni Nena');
  const localCustomer = { id: `local-${customerRec.id}`, _outboxId: customerRec.id, name: 'Sari-Sari ni Nena', customer_type: 'regular' };

  const localOrder = await saveOrderLocalFirst({
    customer: localCustomer,
    items: [{ product_id: 1, product_name: 'Coke Sakto 200ml', sku: 'C-8', quantity: 1, unit_price: 300 }],
    profileKey: 'josie',
  });
  assert.equal(localOrder.customer_id, `local-${customerRec.id}`,
    'the local receipt must remember the local customer id, not null');

  stubOrderModalApis(); // GET /customers returns [] — the customer has not synced yet
  api.patch = async (path) => { throw new Error(`api.patch(${path}) must not be called — the order is still unsynced`); };

  const r = render(
    React.createElement(ToastProvider, null,
      React.createElement(OrderCreateModal, {
        editOrder: { ...localOrder, id: undefined },
        offlineUnsynced: true,
        onClose: () => {},
        onSaved: () => {},
      })
    )
  );
  await act(async () => { await new Promise((res) => setTimeout(res, 30)); });

  const custInput = r.byLabel('Customer');
  assert.equal(custInput.value, 'Sari-Sari ni Nena', 'the picker must show the local customer, not render blank');

  const saveBtn = r.all('button').find((b) => b.textContent.includes('Save Changes'));
  await act(async () => {
    r.click(saveBtn);
    await new Promise((res) => setTimeout(res, 30));
  });
  assert.equal(r.text().includes('Select a customer.'), false, 'submit must not fail validation for the already-selected customer');

  r.unmount();
});

test('G28: if the order already drained while the edit modal was open, submit falls back to the ordinary online PATCH', async () => {
  await registerStation(6);
  api.request = async () => { const err = new Error('Failed to fetch'); throw err; };

  const localOrder = await saveOrderLocalFirst({
    customer: { id: 5, name: 'Aling Nena', customer_type: 'regular' },
    items: [{ product_id: 1, product_name: 'Coke Sakto 200ml', sku: 'C-8', quantity: 1, unit_price: 300 }],
    profileKey: 'josie',
  });

  // saveOrderLocalFirst also fires a background drainOutbox() alongside the write;
  // let that settle before clearing, or its network-failure retry can silently
  // resurrect the very record this test is about to delete (see the identical
  // flushMicrotasks pattern in v25-offline-orphaned-draft.test.mjs).
  await flushMicrotasks();

  // The order drains for real before the edit is submitted — its outbox record is gone.
  await __clearOutbox();

  stubOrderModalApis({ customers: [{ id: 5, name: 'Aling Nena', customer_type: 'regular', is_active: true }] });
  let patchedPath = null;
  api.patch = async (path) => { patchedPath = path; return { id: 900 }; };

  const r = render(
    React.createElement(ToastProvider, null,
      React.createElement(OrderCreateModal, {
        editOrder: { ...localOrder, id: 900 },
        offlineUnsynced: true, // the parent's belief is stale — this is exactly the race G28 must handle gracefully
        onClose: () => {},
        onSaved: () => {},
      })
    )
  );
  await act(async () => { await new Promise((res) => setTimeout(res, 30)); });

  const cokeBtn = r.all('button').find((b) => b.getAttribute('aria-label')?.includes('Coke Sakto'));
  r.click(cokeBtn);
  await act(async () => { await new Promise((res) => setTimeout(res, 20)); });

  const saveBtn = r.all('button').find((b) => b.textContent.includes('Save Changes'));
  await act(async () => {
    r.click(saveBtn);
    await new Promise((res) => setTimeout(res, 50));
  });

  assert.equal(patchedPath, '/orders/900', 'must gracefully fall back to api.patch once updateLocalOrder finds nothing queued');

  r.unmount();
});

// ── G27/G28 — OrderDetailPage local fallback, banner, and action gating ─────

function makeLocalOrder(overrides = {}) {
  return {
    receipt_number: '1-00042',
    receipt_station: 1,
    receipt_sequence: 42,
    created_at: '2026-08-26T10:00:00.000Z',
    status: 'pending',
    customer_id: 5,
    customer_name: 'Aling Nena',
    customer_address: null,
    customer_phone: null,
    customer_type: 'regular',
    order_type: 'delivery',
    notes: null,
    adjustment: 0,
    adjustment_reason: null,
    items: [{
      id: 1, product_id: 1, product_name: 'Coke Sakto 200ml', sku: 'C-8', unit: 'cs',
      quantity: 1, unit_price: 300, unit_deposit_fee: 0, units_per_case: 1,
      requires_bottle_return: false, bottles_returned: 0, is_price_overridden: false,
    }],
    total_amount: 300,
    personnel: [],
    pending_receipt_printed_at: null,
    pending_receipt_printed_by: null,
    ...overrides,
  };
}

test('G27: OrderDetailPage falls back to local receipt history on a 404, shows "Waiting to sync", and G28 gates Dispatch while keeping Edit Order enabled', async () => {
  await putReceipt(makeLocalOrder());
  const err404 = new Error('Not found'); err404.status = 404;
  api.get = async () => { throw err404; };

  const r = renderAtRoute('/orders/1-00042', '/orders/:id',
    React.createElement(ToastProvider, null, React.createElement(OrderDetailPage))
  );
  await act(async () => { await new Promise((res) => setTimeout(res, 30)); });

  assert.match(r.text(), /Waiting to sync/);
  assert.match(r.text(), /Aling Nena/);

  const dispatchBtn = r.all('button').find((b) => b.textContent.includes('Start Dispatch'));
  assert.ok(dispatchBtn, 'Start Dispatch should render for a pending delivery order');
  assert.equal(dispatchBtn.disabled, true, 'G28: Dispatch must be disabled while unsynced');

  const editBtn = r.all('button').find((b) => b.textContent.trim() === 'Edit Order');
  assert.ok(editBtn);
  assert.equal(editBtn.disabled, false, 'G28: Edit Order must stay enabled while unsynced');

  r.unmount();
});

test('G27: a silent background re-read on leyble:drain-complete swaps to the server row and clears the banner without ever setting the full-page loading state', async () => {
  const err404 = new Error('Not found'); err404.status = 404;
  let getCalls = 0;
  api.get = async () => {
    getCalls++;
    if (getCalls === 1) throw err404;
    // Now reachable — the server has the order.
    return { ...makeLocalOrder(), id: 777, customer_name: 'Aling Nena (synced)' };
  };
  await putReceipt(makeLocalOrder());

  const r = renderAtRoute('/orders/1-00042', '/orders/:id',
    React.createElement(ToastProvider, null, React.createElement(OrderDetailPage))
  );
  await act(async () => { await new Promise((res) => setTimeout(res, 30)); });
  assert.match(r.text(), /Waiting to sync/);

  act(() => {
    window.dispatchEvent(new window.CustomEvent('leyble:drain-complete', { detail: { sent: 1, waiting: 0 } }));
  });
  await act(async () => { await new Promise((res) => setTimeout(res, 30)); });

  assert.doesNotMatch(r.text(), /Waiting to sync/, 'the banner must be dismissed once the server row arrives');
  assert.match(r.text(), /Aling Nena \(synced\)/, 'the page must silently swap to the server row');

  r.unmount();
});

// ── G29 — CustomersPage merges queued customers ──────────────────────────────

test('G29: CustomersPage merges a queued customer with a "Waiting to sync" badge, and clicking it shows an info toast instead of opening the drawer', async () => {
  api.get = async (path) => (path.startsWith('/customers') ? [] : []);
  const { enqueue } = await import('../src/offline/outbox.js');
  await enqueue({
    entityType: 'customer',
    endpoint: '/customers',
    method: 'POST',
    payload: { name: 'Brand New Sari-Sari', customer_type: 'regular' },
    profileKey: 'josie',
  });

  const r = render(
    React.createElement(ToastProvider, null, React.createElement(CustomersPage))
  );
  await act(async () => { await new Promise((res) => setTimeout(res, 30)); });

  assert.match(r.text(), /Brand New Sari-Sari/);
  assert.match(r.text(), /Waiting to sync/);

  const row = r.all('tr').find((tr) => tr.textContent.includes('Brand New Sari-Sari'));
  assert.ok(row);
  r.click(row);
  await act(async () => { await new Promise((res) => setTimeout(res, 20)); });

  assert.match(r.text(), /queued for sync/);
  // The edit drawer (CustomerDetailPanel) must not have opened — it always renders a
  // "Close" affordance and calls GET /customers/:id, which we did not stub for this id.
  assert.equal(r.all('[aria-label="Close"]').length, 0, 'the edit drawer must not open for a queued customer');

  r.unmount();
});

test('G29: a queued customer disappears from CustomersPage the moment its outbox record drains', async () => {
  api.get = async (path) => (path.startsWith('/customers') ? [] : []);
  const { enqueue, drainOutbox } = await import('../src/offline/outbox.js');
  await enqueue({
    entityType: 'customer', endpoint: '/customers', method: 'POST',
    payload: { name: 'Now Synced Store', customer_type: 'regular' }, profileKey: 'josie',
  });

  const r = render(
    React.createElement(ToastProvider, null, React.createElement(CustomersPage))
  );
  await act(async () => { await new Promise((res) => setTimeout(res, 30)); });
  assert.match(r.text(), /Now Synced Store/);

  api.request = async () => ({ id: 42, name: 'Now Synced Store' }); // the line returns
  await act(async () => { await drainOutbox(); await new Promise((res) => setTimeout(res, 20)); });

  assert.doesNotMatch(r.text(), /Waiting to sync/);

  r.unmount();
});
