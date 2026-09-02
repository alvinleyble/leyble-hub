// V3.0 — the two offline-drafts regressions the captain hit on a device, in work
// Slice 3.1/3.2 had already merged (criteria 5.1, 5.6, 5.13 in
// docs/offline-accessibility-acceptance-criteria.md).
//
//   1. Drafts did not load offline. The Drafts tab and the purple parked-drafts banner
//      were served from `GET /orders?status=draft` with the ordinary local-history
//      fallback behind them — but `GET /orders/sync` deliberately never mirrors a
//      draft (working state, not history), so that fallback could only ever come back
//      empty. Offline the tab said "No draft orders." with eleven parked on the server.
//
//   2. Auto-draft-save did nothing offline. `OrderCreateModal`'s early POST /orders
//      and its debounced PATCH were bare network calls; blind, the POST failed,
//      `draftId` never got set, the debounce never fired, and closing the modal lost
//      the order. `parkOrderLocalFirst`/`updateLocalDraft` — written for exactly this —
//      had no production call site at all.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, React, act } from './render.mjs';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { api } from '../src/api/client.js';
import { ToastProvider } from '../src/components/ui/Toast.jsx';
import { __resetMemoryBackend, nativeStore } from '../src/offline/nativeStore.js';
import { DRAFTS_KEY } from '../src/offline/keys.js';
import { __clearOutbox, listRecords, enqueue, QUEUED } from '../src/offline/outbox.js';
import { __resetIssuance, ensureStationRegistered } from '../src/offline/station.js';
import { __clearReceipts, putOrderSnapshot, getReceipt } from '../src/offline/receiptHistory.js';
import {
  parkOrderLocalFirst, listLocalParkedOrders, loadParkedOrders,
  getCachedServerDrafts, updateLocalDraft,
} from '../src/offline/parkedOrders.js';

const { createRoot } = await import('react-dom/client');

const OrdersPage       = (await import('../src/pages/orders/OrdersPage.jsx')).default;
const OrderCreateModal = (await import('../src/pages/orders/OrderCreateModal.jsx')).default;
const OrderDetailPage  = (await import('../src/pages/orders/OrderDetailPage.jsx')).default;

const settle = (ms = 40) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

function renderPage(element) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(React.createElement(MemoryRouter, null,
      React.createElement(ToastProvider, null, element)));
  });
  return {
    container,
    text: () => container.textContent,
    all: (sel) => [...container.querySelectorAll(sel)],
    click: (el) => act(() => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); }),
    unmount: () => act(() => { root.unmount(); }),
  };
}

// Same shape as renderPage above, but with real Routes so a navigate() out of
// OrdersPage (opening a historical draft) actually lands on OrderDetailPage.
function renderOrdersFlow(initialPath = '/orders') {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      React.createElement(MemoryRouter, { initialEntries: [initialPath] },
        React.createElement(ToastProvider, null,
          React.createElement(Routes, null,
            React.createElement(Route, { path: '/orders', element: React.createElement(OrdersPage) }),
            React.createElement(Route, { path: '/orders/:id', element: React.createElement(OrderDetailPage) }),
          )
        )
      )
    );
  });
  return {
    container,
    text: () => container.textContent,
    all: (sel) => [...container.querySelectorAll(sel)],
    click: (el) => act(() => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); }),
    unmount: () => act(() => { root.unmount(); }),
  };
}

function changeInput(input, value) {
  const proto = input.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
  descriptor.set.call(input, value);
  const key = Object.keys(input).find((k) => k.startsWith('__reactProps'));
  if (key && input[key]?.onChange) {
    input[key].onChange({ target: { value, type: input.type || 'text', checked: input.checked } });
  }
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  input.dispatchEvent(new window.Event('change', { bubbles: true }));
}

const offline = async () => { throw new Error('Failed to fetch'); };

const PRODUCTS = [
  { id: 1, name: 'Coke Sakto 200ml', sku: 'C-8', category: 'Softdrinks', unit: 'cs',
    base_wholesale_price: 300, units_per_case: 24, is_active: true, requires_bottle_return: false, deposit_fee: 0 },
];
const CUSTOMERS = [{ id: 5, name: 'Aling Nena', customer_type: 'regular', is_active: true }];

let saved = {};

beforeEach(async () => {
  saved = { get: api.get, post: api.post, patch: api.patch, del: api.del, request: api.request };
  await __resetMemoryBackend();
  __resetIssuance();
  await __clearOutbox();
  await __clearReceipts();
  localStorage.setItem('activeProfile', 'josie');
});

afterEach(() => {
  Object.assign(api, saved);
  localStorage.clear();
});

async function registerStation(number = 1) {
  api.post = async () => ({ slot_number: number, next_sequence: 1, registered_at: '2026-08-23T00:00:00.000Z' });
  await ensureStationRegistered();
}

// ── 1. The parked-drafts list survives an outage ───────────────────────────────

test('loadParkedOrders caches the server drafts and serves that copy when the server is unreachable', async () => {
  const serverDraft = {
    id: 7001, status: 'draft', order_type: 'delivery', customer_name: 'Aling Nena',
    total_amount: 0, adjustment: 0, created_at: '2026-08-29T01:00:00.000Z',
  };
  api.get = async (path) => {
    assert.ok(path.startsWith('/orders?status=draft'));
    return [serverDraft];
  };

  const online = await loadParkedOrders();
  assert.equal(online.fromCache, false);
  assert.equal(online.drafts.length, 1);
  assert.deepEqual(await getCachedServerDrafts(), [serverDraft]);

  api.get = offline;
  const blind = await loadParkedOrders();
  assert.equal(blind.fromCache, true);
  assert.equal(blind.drafts.length, 1, 'the drafts the server last gave us must still be listed');
  assert.equal(blind.drafts[0].customer_name, 'Aling Nena');
});

test('loadParkedOrders never throws on a first-run device with no cache and no line', async () => {
  api.get = offline;
  const { drafts, fromCache } = await loadParkedOrders();
  assert.equal(fromCache, true);
  assert.deepEqual(drafts, []);
});

test('loadParkedOrders unions this device\'s own parks with the cached server drafts, deduped by receipt number', async () => {
  await registerStation(1);
  api.request = offline;                 // the park's background drain gets nowhere
  api.getActiveProfile = async () => 'josie';

  const { receipt_number } = await parkOrderLocalFirst({
    customer: { id: 5, name: 'Aling Nena' },
    items: [{ product_id: 1, quantity: 1, unit_price: 300, units_per_case: 24 }],
    display: { customer_name: 'Aling Nena', items: [{ product_id: 1, product_name: 'Coke Sakto 200ml', sku: 'C-8' }] },
    profileKey: 'josie',
  });
  await settle(0);

  // The server already holds a copy of that same draft (it drained on another pass)
  // plus one of its own; the local half must drop out, the other must stay.
  await nativeStore.setJson(DRAFTS_KEY, [
    { id: 7001, receipt_number, status: 'draft', customer_name: 'Aling Nena', created_at: '2026-08-29T01:00:00.000Z' },
    { id: 7002, receipt_number: null, status: 'draft', customer_name: 'Someone Else', created_at: '2026-08-29T00:00:00.000Z' },
  ]);
  api.get = offline;

  const { drafts } = await loadParkedOrders();
  assert.equal(drafts.length, 2, 'a local park whose receipt number is already server-side must not double up');
  assert.deepEqual(drafts.map((d) => d.customer_name), ['Aling Nena', 'Someone Else']);
  assert.equal(drafts[0].id, 7001, 'and the server row wins over the local one');
});

// ── 2. A locally parked draft carries enough to be shown and resumed ───────────

test('a locally parked draft keeps the names the POST body has no field for', async () => {
  await registerStation(1);
  api.request = offline;
  api.getActiveProfile = async () => 'josie';

  await parkOrderLocalFirst({
    customer: { id: 5, name: 'Aling Nena', customer_type: 'wholesaler' },
    items: [{ product_id: 1, quantity: 2, unit_price: 300, units_per_case: 24 }],
    display: {
      customer_name: 'Aling Nena',
      customer_type: 'wholesaler',
      items: [{ product_id: 1, product_name: 'Coke Sakto 200ml', sku: 'C-8', unit: 'cs' }],
    },
    profileKey: 'josie',
  });
  await settle(0);

  const [draft] = await listLocalParkedOrders();
  assert.equal(draft._local, true);
  assert.equal(draft.customer_name, 'Aling Nena');
  assert.equal(draft.customer_type, 'wholesaler');
  assert.equal(draft.total_amount, 600);
  assert.equal(draft.items[0].product_name, 'Coke Sakto 200ml', 'or a resumed draft comes back as nameless lines');
  assert.equal(draft.items[0].sku, 'C-8');

  // The request body itself stays exactly a request body.
  const [record] = await listRecords();
  assert.equal(record.payload.items[0].product_name, undefined);
  assert.equal(record.payload.status, 'draft');
});

test('a draft parked behind a customer created on this device exposes her local id', async () => {
  await registerStation(1);
  api.request = offline;
  api.getActiveProfile = async () => 'josie';

  const customerRecord = await enqueue({
    entityType: 'customer', endpoint: '/customers', method: 'POST',
    payload: { name: 'Blackout Sari-Sari' }, profileKey: 'josie',
  });

  await parkOrderLocalFirst({
    customer: { id: `local-${customerRecord.id}`, _outboxId: customerRecord.id, name: 'Blackout Sari-Sari' },
    items: [{ product_id: 1, quantity: 1, unit_price: 300, units_per_case: 24 }],
    profileKey: 'josie',
  });
  await settle(0);

  const [draft] = await listLocalParkedOrders();
  assert.equal(draft.customer_id, `local-${customerRecord.id}`,
    'the $ref placeholder is the outbox\'s business; a screen needs the local- id every other screen reads');
});

test('updateLocalDraft rewrites the same record, names included, rather than queueing a second draft', async () => {
  await registerStation(1);
  api.request = offline;
  api.getActiveProfile = async () => 'josie';

  const { receipt_number } = await parkOrderLocalFirst({
    customer: { id: 5, name: 'Aling Nena' },
    items: [{ product_id: 1, quantity: 1, unit_price: 300, units_per_case: 24 }],
    display: { customer_name: 'Aling Nena', items: [{ product_id: 1, product_name: 'Coke Sakto 200ml' }] },
    profileKey: 'josie',
  });
  await settle(0);

  await updateLocalDraft({
    receiptNumber: receipt_number,
    orderType: 'pickup',
    notes: 'leave at the gate',
    items: [{ product_id: 1, quantity: 3, unit_price: 300, units_per_case: 24 }],
    adjustment: { value: -50, reason: 'agreed discount' },
    display: { customer_name: 'Aling Nena', items: [{ product_id: 1, product_name: 'Coke Sakto 200ml' }] },
  });
  await settle(0);

  const records = await listRecords();
  assert.equal(records.length, 1, 'editing a parked draft must never fan out into extra outbox records');

  const [draft] = await listLocalParkedOrders();
  assert.equal(draft.order_type, 'pickup');
  assert.equal(draft.notes, 'leave at the gate');
  assert.equal(draft.adjustment, -50);
  assert.equal(draft.total_amount, 900);
  assert.equal(draft.items[0].product_name, 'Coke Sakto 200ml');
});

// ── 3. The modal parks a draft when the early POST cannot get out ──────────────

test('OrderCreateModal parks the draft on this device when picking a customer while the server is unreachable', async () => {
  await registerStation(1);
  api.get = async (path) => {
    if (path.startsWith('/products'))  return PRODUCTS;
    if (path.startsWith('/customers')) return CUSTOMERS;
    if (path.startsWith('/personnel')) return [];
    return [];
  };
  api.post = offline;      // the early draft POST cannot get out
  api.request = offline;   // and neither can the outbox drain behind it

  const r = renderPage(React.createElement(OrderCreateModal, { onClose() {}, onSaved() {} }));
  await settle(60);

  const search = r.all('input').find((i) => (i.getAttribute('aria-label') || '') === 'Customer');
  assert.ok(search, 'the customer combobox must render');
  act(() => { changeInput(search, 'Aling'); });
  await settle(20);

  const option = r.all('li[role="option"] button').find((el) => el.textContent.includes('Aling Nena'));
  assert.ok(option, 'the matching customer must be offered');
  await act(async () => { option.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true })); });
  await settle(1000); // past the 800ms auto-save debounce, so the indicator settles

  const drafts = await listLocalParkedOrders();
  assert.equal(drafts.length, 1, 'an order drafted blind has to be written somewhere on this device');
  assert.equal(drafts[0].customer_id, 5);
  assert.equal(drafts[0].customer_name, 'Aling Nena');
  assert.match(r.text(), /Draft saved automatically/, 'and the operator has to be told it was saved');

  r.unmount();
});

test('OrderCreateModal keeps parking into the same draft record as the order is built', async () => {
  await registerStation(1);
  api.get = async (path) => {
    if (path.startsWith('/products'))  return PRODUCTS;
    if (path.startsWith('/customers')) return CUSTOMERS;
    if (path.startsWith('/personnel')) return [];
    return [];
  };
  api.post = offline;
  api.patch = offline;
  api.request = offline;

  const r = renderPage(React.createElement(OrderCreateModal, { onClose() {}, onSaved() {} }));
  await settle(60);

  const search = r.all('input').find((i) => (i.getAttribute('aria-label') || '') === 'Customer');
  act(() => { changeInput(search, 'Aling'); });
  await settle(20);
  const option = r.all('li[role="option"] button').find((el) => el.textContent.includes('Aling Nena'));
  await act(async () => { option.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true })); });
  await settle(60);

  const card = r.all('button').find((b) => b.textContent.includes('Coke Sakto 200ml'));
  assert.ok(card, 'the product grid must be usable offline');
  await r.click(card);
  await settle(1200); // past the 800ms auto-save debounce

  const records = await listRecords();
  const drafts = records.filter((rec) => rec.entity_type === 'order' && rec.payload?.status === 'draft');
  assert.equal(drafts.length, 1, 'one draft record, rewritten — never one per keystroke');
  assert.equal(drafts[0].status, QUEUED);
  assert.equal(drafts[0].payload.items.length, 1, 'and the line the operator added has to be in it');
  assert.equal(drafts[0].payload.items[0].product_id, 1);

  r.unmount();
});

// ── 4. The Drafts tab itself ──────────────────────────────────────────────────

test('OrdersPage Drafts tab lists the cached server drafts and this device\'s own parks while offline', async () => {
  await registerStation(1);
  api.request = offline;
  api.getActiveProfile = async () => 'josie';

  await parkOrderLocalFirst({
    customer: { id: 5, name: 'Aling Nena' },
    items: [{ product_id: 1, quantity: 1, unit_price: 300, units_per_case: 24 }],
    display: { customer_name: 'Parked While Blind', items: [] },
    profileKey: 'josie',
  });
  await settle(0);

  await nativeStore.setJson(DRAFTS_KEY, [{
    id: 7002, receipt_number: null, status: 'draft', order_type: 'delivery',
    customer_name: 'Parked Before The Outage', total_amount: 0, adjustment: 0,
    created_at: '2026-08-29T00:00:00.000Z',
  }]);
  api.get = offline;

  const r = renderPage(React.createElement(OrdersPage));
  await settle(60);

  const draftsTab = r.all('button').find((b) => b.textContent.trim() === 'Drafts');
  assert.ok(draftsTab);
  await r.click(draftsTab);
  await settle(60);

  assert.doesNotMatch(r.text(), /No draft orders/);
  assert.match(r.text(), /Parked Before The Outage/, 'the server\'s drafts have to survive the outage');
  assert.match(r.text(), /Parked While Blind/, 'and so do the ones this device parked itself');
  assert.match(r.text(), /Waiting to sync/, 'a still-local draft says so');

  r.unmount();
});

test('OrdersPage parked-drafts banner counts both halves of the list', async () => {
  await registerStation(1);
  api.request = offline;
  api.getActiveProfile = async () => 'josie';

  await parkOrderLocalFirst({
    customer: { id: 5, name: 'Aling Nena' },
    items: [],
    display: { customer_name: 'Parked While Blind', items: [] },
    profileKey: 'josie',
  });
  await settle(0);

  await nativeStore.setJson(DRAFTS_KEY, [{
    id: 7002, status: 'draft', customer_name: 'Parked Before The Outage',
    total_amount: 0, adjustment: 0, created_at: '2026-08-29T00:00:00.000Z',
  }]);
  api.get = offline;

  const r = renderPage(React.createElement(OrdersPage));
  await settle(60);

  assert.match(r.text(), /2 parked drafts/);
  r.unmount();
});

// ── 5. Opening a HISTORICAL (already-synced) draft while offline ───────────────
//
// Captain decision 2026-09-02, reversing the more-permissive 2026-08-29 one: a
// synced draft stays under the same offline lock as any other synced order — no
// edit, no adjustment, no convert-to-a-real-order, no delete/discard. The one real
// bug (the draft was on the server, but tapping it while offline failed/blanked
// instead of opening read-only) traced to `openDraft` discarding the fetched order
// the moment it displayed it, so a later outage had nothing to fall back to —
// unlike every other order, which OrderDetailPage.jsx's own load() always snapshots.

function makeHistoricalDraft(overrides = {}) {
  return {
    id: 9001,
    status: 'draft',
    order_type: 'delivery',
    customer_id: 5,
    customer_name: 'Aling Nena',
    customer_address: null,
    customer_phone: null,
    notes: null,
    adjustment: 0,
    adjustment_reason: null,
    items: [{
      id: 1, product_id: 1, product_name: 'Coke Sakto 200ml', sku: 'C-8', unit: 'cs',
      quantity: 2, unit_price: 300, unit_deposit_fee: 0, units_per_case: 24,
      requires_bottle_return: false, bottles_returned: 0, is_price_overridden: false,
    }],
    personnel: [],
    total_amount: 600,
    created_at: '2026-08-29T00:00:00.000Z',
    ...overrides,
  };
}

test('OrdersPage: tapping a historical draft this device has already cached opens it read-only offline, with no reachable edit/adjustment/cancel control and no mutation endpoint hit', async () => {
  await registerStation(1);
  api.getActiveProfile = async () => 'josie';

  const draft = makeHistoricalDraft();
  // Models the fix's own write path: the first time this device opened the draft
  // (while online), OrderDetailPage-style snapshotting is what makes this available
  // later — see putOrderSnapshot(full) in OrdersPage.jsx's openDraft.
  await putOrderSnapshot(draft);
  await nativeStore.setJson(DRAFTS_KEY, [draft]);

  // Now offline: every live fetch fails, and no mutation must ever reach the server.
  api.get = offline;
  api.patch = async (path) => { throw new Error(`api.patch(${path}) must not be called — a historical draft is read-only offline`); };
  api.post  = async (path) => { throw new Error(`api.post(${path}) must not be called — a historical draft is read-only offline`); };
  api.del   = async (path) => { throw new Error(`api.del(${path}) must not be called — a historical draft is read-only offline`); };

  const r = renderOrdersFlow('/orders');
  await settle(60);

  const draftsTab = r.all('button').find((b) => b.textContent.trim() === 'Drafts');
  await r.click(draftsTab);
  await settle(60);

  const row = r.all('td').find((td) => td.textContent.includes('Aling Nena'))?.closest('tr');
  assert.ok(row, 'the historical draft must still list while offline');
  await r.click(row);
  await settle(60);

  assert.doesNotMatch(r.text(), /needs a connection to open/, 'the fetch failure must fall back to the cached snapshot, not error out');
  assert.doesNotMatch(r.text(), /Order not found/);
  assert.match(r.text(), /Aling Nena/, 'the draft must open showing its contents');
  assert.match(r.text(), /Coke Sakto 200ml|C-8/, 'line items must render from the cached snapshot');
  assert.match(r.text(), /showing this device's saved copy/, 'the usual offline-copy banner applies, same as any synced order');

  assert.equal(r.all('button').find((b) => b.textContent.trim() === 'Edit Order'), undefined,
    'Edit Order must be absent, not just disabled, for a historical draft offline');
  assert.equal(r.all('button').find((b) => /Add Adjustment|^Edit$/.test(b.textContent.trim())), undefined,
    'the adjustment control must be absent for a historical draft offline');
  assert.equal(r.all('button').find((b) => b.textContent.trim() === 'Cancel Order'), undefined,
    'Cancel Order must be absent for a historical draft offline');

  r.unmount();
});

test('OrdersPage: a historical draft never opened before this outage still fails gracefully (no cached snapshot to fall back to)', async () => {
  await registerStation(1);
  api.getActiveProfile = async () => 'josie';

  await nativeStore.setJson(DRAFTS_KEY, [makeHistoricalDraft({ id: 9002, customer_name: 'Never Opened Yet' })]);
  api.get = offline;

  const r = renderOrdersFlow('/orders');
  await settle(60);

  const draftsTab = r.all('button').find((b) => b.textContent.trim() === 'Drafts');
  await r.click(draftsTab);
  await settle(60);

  const row = r.all('td').find((td) => td.textContent.includes('Never Opened Yet'))?.closest('tr');
  assert.ok(row);
  await r.click(row);
  await settle(60);

  assert.match(r.text(), /needs a connection to open/, 'unchanged: a genuine cache miss still surfaces the existing offline toast');
  r.unmount();
});
