// V3.0 Slice 3.2 — Counter POS & Orders full offline sync.
//
// What this slice changed, and therefore what is worth pinning here:
//   * the sync model itself (offline/sync.js): one full pull ever, deltas after that,
//     throttled reconnects, and a partial sync that can only ever leave MORE behind
//   * dual identifier resolution in the local order store (ADR 0015 §4)
//   * the order modal's catalogue (it had none — loadCatalogue had zero call sites)
//   * the customer directory's Add Customer going through the outbox (it did not)
//   * the Outgoing Orders directory falling back to the full local history
//   * ADR 0015 §5's offline forward transitions for an order only this tablet knows
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, React, act } from './render.mjs';
import { MemoryRouter } from 'react-router-dom';
import { api } from '../src/api/client.js';
import { ToastProvider } from '../src/components/ui/Toast.jsx';
import { __resetMemoryBackend, nativeStore } from '../src/offline/nativeStore.js';
import { SYNC_STATE_KEY } from '../src/offline/keys.js';
import { __clearOutbox, listRecords, enqueue } from '../src/offline/outbox.js';
import { __resetIssuance, ensureStationRegistered } from '../src/offline/station.js';
import {
  putReceipt, putOrderSnapshot, getReceipt, listReceipts, __clearReceipts,
} from '../src/offline/receiptHistory.js';
import {
  runSync, getSyncState, isFirstSetup, subscribeSync, __resetSyncState,
} from '../src/offline/sync.js';
import { getCachedProducts, getCachedCustomers, getCachedPersonnel } from '../src/offline/catalogue.js';
import { saveOrderLocalFirst, transitionLocalOrder, canTransitionOffline } from '../src/offline/posSave.js';
import { filterLocalHistory, localOrderRoute } from '../src/utils/localOrderHistory.js';

const { createRoot } = await import('react-dom/client');

const OrderCreateModal   = (await import('../src/pages/orders/OrderCreateModal.jsx')).default;
const CustomerFormModal  = (await import('../src/pages/customers/CustomerFormModal.jsx')).default;
const OrdersPage         = (await import('../src/pages/orders/OrdersPage.jsx')).default;

const settle = (ms = 30) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

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

let saved = {};

beforeEach(async () => {
  saved = { get: api.get, post: api.post, patch: api.patch, del: api.del, request: api.request };
  await __resetMemoryBackend();
  __resetIssuance();
  await __clearOutbox();
  await __clearReceipts();
  await __resetSyncState();
  localStorage.setItem('activeProfile', 'josie');
});

afterEach(() => {
  Object.assign(api, saved);
  localStorage.clear();
});

// ── Server fixtures ───────────────────────────────────────────────────────────

const PRODUCTS = [
  { id: 1, name: 'Coke Sakto 200ml', sku: 'C-8', category: 'Softdrinks', unit: 'cs',
    base_wholesale_price: 300, units_per_case: 24, is_active: true, updated_at: '2026-08-20T00:00:00.000Z' },
  { id: 2, name: 'Sprite 1L', sku: 'S-1', category: 'Softdrinks', unit: 'cs',
    base_wholesale_price: 420, units_per_case: 12, is_active: true, updated_at: '2026-08-21T00:00:00.000Z' },
];
const CUSTOMERS = [
  { id: 5, name: 'Aling Nena', customer_type: 'regular', is_active: true, updated_at: '2026-08-19T00:00:00.000Z' },
];
const PERSONNEL = [
  { id: 3, full_name: 'Luis Reyes', is_active: true, updated_at: '2026-08-18T00:00:00.000Z' },
];

const serverOrder = (id, overrides = {}) => ({
  id,
  receipt_number: null,
  created_at: `2026-08-${String(10 + id).padStart(2, '0')}T02:00:00.000Z`,
  updated_at: `2026-08-${String(10 + id).padStart(2, '0')}T02:00:00.000Z`,
  status: 'completed',
  customer_id: 5,
  customer_name: 'Aling Nena',
  order_type: 'delivery',
  total_amount: 300,
  adjustment: 0,
  items: [{ id: id * 10, product_id: 1, product_name: 'Coke Sakto 200ml', sku: 'C-8',
            unit: 'cs', quantity: 1, unit_price: 300, unit_deposit_fee: 0, units_per_case: 24,
            requires_bottle_return: false, bottles_returned: 0 }],
  personnel: [],
  ...overrides,
});

/**
 * A stand-in server that records every path asked for, so a test can assert on the
 * SHAPE of the conversation (full pull vs delta) and not only on its result.
 */
function stubServer({ orders = [], products = PRODUCTS, customers = CUSTOMERS, personnel = PERSONNEL, pageSize = 100 } = {}) {
  const calls = [];
  api.get = async (path) => {
    calls.push(path);
    if (path.startsWith('/orders/sync')) {
      const params = new URLSearchParams(path.split('?')[1] || '');
      const forward = params.get('direction') === 'forward';
      const cursor = params.get('cursor');
      const sorted = [...orders].sort((a, b) =>
        String(a.updated_at).localeCompare(String(b.updated_at)) || a.id - b.id);
      let pool = forward ? sorted : sorted.reverse();
      if (cursor) {
        const [at, id] = [cursor.slice(0, cursor.lastIndexOf('|')), Number(cursor.slice(cursor.lastIndexOf('|') + 1))];
        pool = pool.filter((o) => {
          const cmp = String(o.updated_at).localeCompare(at) || (o.id - id);
          return forward ? cmp > 0 : cmp < 0;
        });
      }
      const page = pool.slice(0, pageSize);
      // Cursors are minted by the server, at full precision — the client must never
      // rebuild one from the millisecond `updated_at` it sees in JSON.
      const cursorFor = (o) => (o ? `${o.updated_at}|${o.id}` : null);
      return {
        orders: page,
        has_more: pool.length > pageSize,
        first_cursor: cursorFor(page[0]),
        next_cursor: cursorFor(page[page.length - 1]),
      };
    }
    const since = new URLSearchParams(path.split('?')[1] || '').get('updated_since');
    const pick = path.startsWith('/products') ? products
      : path.startsWith('/personnel') ? personnel
      : path.startsWith('/customers') ? customers
      : [];
    return since ? pick.filter((r) => String(r.updated_at) > since) : pick;
  };
  api.post = async (path) => (path === '/stations/register'
    ? { slot_number: 1, next_sequence: 1, registered_at: '2026-08-26T00:00:00.000Z' } : {});
  return calls;
}

// ── 1. First-ever setup ───────────────────────────────────────────────────────

test('first setup: a tablet holding nothing pulls the full catalogue, customers, personnel AND the complete order history', async () => {
  const orders = [serverOrder(1), serverOrder(2), serverOrder(3)];
  stubServer({ orders });

  assert.equal(await isFirstSetup(), true, 'a device with no sync state has never been set up');

  const res = await runSync({ trigger: 'login', waitForOrders: true });

  assert.equal(res.firstSetup, true);
  assert.deepEqual(res.entitiesSynced.sort(), ['customers', 'personnel', 'products']);
  assert.deepEqual((await getCachedProducts()).map((p) => p.id), [1, 2]);
  assert.deepEqual((await getCachedCustomers()).map((c) => c.id), [5]);
  assert.deepEqual((await getCachedPersonnel()).map((p) => p.id), [3],
    'personnel is cached too — Driver/Helper assignment has to work blind (ADR 0015 §9)');

  const held = await listReceipts();
  assert.deepEqual(held.map((o) => o.id).sort(), [1, 2, 3], 'the WHOLE history, not just what this tablet created');
  assert.ok(held.every((o) => Array.isArray(o.items) && o.items.length > 0),
    'ADR 0015 §4: snapshots carry their line items — a summary row is what crashed the detail page');

  const state = await getSyncState();
  assert.equal(state.setup_complete, true);
  assert.equal(state.orders_backfill_complete, true);
  assert.equal(await isFirstSetup(), false);
});

test('first setup unlocks the app as soon as products/customers/personnel land, with order history still streaming', async () => {
  // The order history endpoint hangs: if the gate waited on it, this test would never
  // see essentialsReady go true, which is exactly the loading screen we refuse to show.
  const orders = [serverOrder(1)];
  stubServer({ orders });
  const realGet = api.get;
  api.get = async (path) => {
    if (path.startsWith('/orders/sync')) {
      await new Promise((r) => setTimeout(r, 300));
      return realGet(path);
    }
    return realGet(path);
  };

  const seen = [];
  const unsubscribe = subscribeSync((snap) => seen.push({ ...snap }));

  const pending = runSync({ trigger: 'login', waitForOrders: true });
  await new Promise((r) => setTimeout(r, 60));

  const unlocked = seen.find((s) => s.firstSetup && s.essentialsReady);
  assert.ok(unlocked, 'essentials must be reported ready well before the history finishes');
  assert.equal((await listReceipts()).length, 0, 'and at that moment the history has not landed yet');

  await pending;
  unsubscribe();
  assert.equal((await listReceipts()).length, 1, 'the history then arrives behind the unlocked app');
});

// ── 2. Incremental sync ───────────────────────────────────────────────────────

test('an already-set-up tablet only fetches what changed — no full catalogue pull, no history restart', async () => {
  // Seed the state a tablet has after a completed first setup, plus the data it holds.
  await nativeStore.setJson(SYNC_STATE_KEY, {
    setup_complete: true,
    reference_watermarks: {
      products:  '2026-08-21T00:00:00.000Z',
      customers: '2026-08-19T00:00:00.000Z',
      personnel: '2026-08-18T00:00:00.000Z',
    },
    orders_delta_cursor: '2026-08-12T02:00:00.000Z|2',
    orders_backfill_cursor: '2026-08-11T02:00:00.000Z|1',
    orders_backfill_complete: true,
    last_sync_completed_at: 0,
  });
  await putOrderSnapshot(serverOrder(1));
  await putOrderSnapshot(serverOrder(2));
  await nativeStore.setJson('v25.catalogue.products',  PRODUCTS);
  await nativeStore.setJson('v25.catalogue.customers', CUSTOMERS);
  await nativeStore.setJson('v25.catalogue.personnel', PERSONNEL);

  const changedProduct = { ...PRODUCTS[0], base_wholesale_price: 310, updated_at: '2026-08-27T00:00:00.000Z' };
  // Order 3 was created on ANOTHER tablet since our last sync — the case a device
  // cannot cover by remembering its own writes.
  const calls = stubServer({
    orders: [serverOrder(1), serverOrder(2), serverOrder(3)],
    products: [changedProduct, PRODUCTS[1]],
  });

  const res = await runSync({ trigger: 'login', waitForOrders: true });

  assert.equal(res.firstSetup, false);
  assert.ok(calls.every((c) => !c.startsWith('/products') || c.includes('updated_since')),
    'every reference fetch must be a delta — a full catalogue pull happens once per tablet, ever');
  assert.ok(calls.every((c) => !c.startsWith('/customers') || c.includes('updated_since')));
  assert.ok(calls.every((c) => !c.startsWith('/personnel') || c.includes('updated_since')));

  const historyCalls = calls.filter((c) => c.startsWith('/orders/sync'));
  assert.ok(historyCalls.length > 0);
  assert.ok(historyCalls.every((c) => c.includes('direction=forward') && c.includes('cursor=')),
    'history is asked forward from our own watermark, never re-walked from the newest page');

  const cached = await getCachedProducts();
  assert.equal(cached.find((p) => p.id === 1).base_wholesale_price, 310, 'the changed row wins');
  assert.equal(cached.length, 2, 'and the untouched row is still held — a delta MERGES, it never replaces');

  assert.deepEqual((await listReceipts()).map((o) => o.id).sort(), [1, 2, 3],
    "an order created on another tablet arrives in this one's history");
});

test('a reference delta that returns nothing leaves the held copy exactly as it was', async () => {
  await nativeStore.setJson(SYNC_STATE_KEY, {
    setup_complete: true,
    reference_watermarks: { products: '2026-09-01T00:00:00.000Z', customers: '2026-09-01T00:00:00.000Z', personnel: '2026-09-01T00:00:00.000Z' },
    orders_delta_cursor: '2026-08-12T02:00:00.000Z|2',
    orders_backfill_complete: true,
    last_sync_completed_at: 0,
  });
  await nativeStore.setJson('v25.catalogue.products', PRODUCTS);

  stubServer({ orders: [] });
  await runSync({ trigger: 'login', waitForOrders: true });

  assert.deepEqual((await getCachedProducts()).map((p) => p.id), [1, 2]);
  assert.equal((await getSyncState()).reference_watermarks.products, '2026-09-01T00:00:00.000Z',
    'an empty delta must not drag the watermark backwards');
});

// ── 3. Reconnect throttling ───────────────────────────────────────────────────

test('two reconnects inside the throttle window cost exactly one sync', async () => {
  const calls = stubServer({ orders: [serverOrder(1)] });
  await runSync({ trigger: 'login', waitForOrders: true });

  // Age the watermark past the throttle window, so the first of the two reconnects
  // below is genuinely eligible — otherwise this would only be re-testing that the
  // login sync it just ran still counts (which the next assertion covers anyway).
  await nativeStore.setJson('v25.sync.state', { ...(await getSyncState()), last_sync_completed_at: 1 });

  const before = calls.length;
  const first  = await runSync({ trigger: 'reconnect', waitForOrders: true });
  const afterFirst = calls.length;
  const second = await runSync({ trigger: 'reconnect', waitForOrders: true });

  assert.notEqual(first.skipped, true, 'the first reconnect, outside the window, genuinely runs');
  assert.ok(afterFirst > before, 'and it talks to the server');
  assert.equal(second.skipped, true, 'the second, moments later, is skipped — a flapping link costs one sync');
  assert.equal(second.reason, 'throttled');
  assert.equal(calls.length, afterFirst, 'a throttled reconnect makes no requests at all');
});

test('a reconnect moments after a login sync is throttled too — the window is about the last sync, not the trigger before it', async () => {
  const calls = stubServer({ orders: [] });
  await runSync({ trigger: 'login', waitForOrders: true });
  const before = calls.length;

  const res = await runSync({ trigger: 'reconnect', waitForOrders: true });
  assert.equal(res.skipped, true);
  assert.equal(calls.length, before);
});

test('a deliberate login is never throttled, however recent the last sync was', async () => {
  stubServer({ orders: [] });
  await runSync({ trigger: 'login', waitForOrders: true });
  const again = await runSync({ trigger: 'login', waitForOrders: true });
  assert.notEqual(again.skipped, true, 'signing in is an explicit act — it always checks in');
});

// ── 4. Interruption safety ────────────────────────────────────────────────────

test('a sync interrupted partway leaves everything it already fetched in place, and resumes rather than restarting', async () => {
  const orders = [serverOrder(1), serverOrder(2), serverOrder(3), serverOrder(4)];
  stubServer({ orders, pageSize: 2 });

  // Drop the line after the first history page.
  const realGet = api.get;
  let historyPages = 0;
  api.get = async (path) => {
    if (path.startsWith('/orders/sync')) {
      historyPages++;
      if (historyPages > 1) throw new Error('Failed to fetch');
    }
    return realGet(path);
  };

  await runSync({ trigger: 'login', waitForOrders: true });

  const partial = (await listReceipts()).map((o) => o.id).sort();
  assert.equal(partial.length, 2, 'the page that did land is kept — never cleared and repopulated');
  assert.deepEqual(partial, [3, 4], 'and it is the newest slice, the part the counter actually reaches for');

  const state = await getSyncState();
  assert.equal(state.orders_backfill_complete, false);
  assert.ok(state.orders_backfill_cursor, 'the cursor records where to pick up');

  // Line returns. The next sync resumes the backfill rather than starting over.
  api.get = realGet;
  await runSync({ trigger: 'login', waitForOrders: true });

  assert.deepEqual((await listReceipts()).map((o) => o.id).sort(), [1, 2, 3, 4]);
  assert.equal((await getSyncState()).orders_backfill_complete, true);
});

// ── 5. Dual identifier resolution (ADR 0015 §4) ───────────────────────────────

test('getReceipt resolves a device receipt number, a numeric row id, and a synced order that has both', async () => {
  await putReceipt({ receipt_number: '1-00042', id: undefined, customer_name: 'Local sale', created_at: '2026-08-26T10:00:00.000Z' });
  await putOrderSnapshot(serverOrder(1240, { receipt_number: null }));
  await putOrderSnapshot(serverOrder(77, { receipt_number: '2-00009' }));

  assert.equal((await getReceipt('1-00042')).customer_name, 'Local sale');
  assert.equal((await getReceipt(1240)).id, 1240, 'a pre-V2.5 order has only a row id and must still open');
  assert.equal((await getReceipt('1240')).id, 1240, 'the id arrives from the URL as a string');
  assert.equal((await getReceipt('2-00009')).id, 77);
  assert.equal((await getReceipt(77)).receipt_number, '2-00009',
    'the same order must resolve from either identifier — links carry whichever they have');
  assert.equal(await getReceipt('nope'), null);
});

test('a synced order snapshot is stored with items and personnel arrays even when the server sends neither', async () => {
  await putOrderSnapshot({ id: 9, receipt_number: null, created_at: '2026-08-26T00:00:00.000Z' });
  const stored = await getReceipt(9);
  assert.deepEqual(stored.items, [], 'never undefined — the detail page reads this synchronously in render');
  assert.deepEqual(stored.personnel, []);
});

// ── 6. Local history filtering ────────────────────────────────────────────────

test('filterLocalHistory applies the same status, date and search rules the server does', async () => {
  const history = [
    { id: 1, status: 'pending',   customer_name: 'Aling Nena', created_at: '2026-08-20T02:00:00.000Z', receipt_number: '1-00001' },
    { id: 2, status: 'completed', customer_name: 'Mang Juan',  created_at: '2026-08-25T02:00:00.000Z', receipt_number: '1-00002' },
    { id: 3, status: 'draft',     customer_name: 'Aling Nena', created_at: '2026-08-26T02:00:00.000Z', receipt_number: '1-00003' },
  ];

  assert.deepEqual(filterLocalHistory(history, { statusTab: 'all' }).map((o) => o.id), [2, 1],
    'newest first, and drafts stay out of All exactly as the server keeps them out');
  assert.deepEqual(filterLocalHistory(history, { statusTab: 'draft' }).map((o) => o.id), [3]);
  assert.deepEqual(filterLocalHistory(history, { statusTab: 'all', search: 'Mang' }).map((o) => o.id), [2]);
  assert.deepEqual(filterLocalHistory(history, { statusTab: 'all', search: '1-00001' }).map((o) => o.id), [1]);
  assert.deepEqual(
    filterLocalHistory(history, { statusTab: 'all', fromDate: '2026-08-25', toDate: '2026-08-25' }).map((o) => o.id),
    [2], 'both ends of the date range are inclusive whole days');

  assert.equal(localOrderRoute({ receipt_number: '1-00002', id: 2 }), '1-00002');
  assert.equal(localOrderRoute({ receipt_number: null, id: 2 }), 2);
});

test('OrdersPage falls back to the full local history when the server cannot be reached', async () => {
  await putOrderSnapshot(serverOrder(1, { customer_name: 'Aling Nena', status: 'completed' }));
  await putOrderSnapshot(serverOrder(2, { customer_name: 'Mang Juan', status: 'pending' }));
  api.get = async () => { throw new Error('Failed to fetch'); };

  const r = renderPage(React.createElement(OrdersPage));
  await settle(60);

  assert.match(r.text(), /showing this device's saved order history/);
  assert.match(r.text(), /Aling Nena/);
  assert.match(r.text(), /Mang Juan/,
    'both orders are visible — neither was created on this tablet, which is the whole point');
  assert.doesNotMatch(r.text(), /No orders yet/);

  r.unmount();
});

test('OrdersPage shows a still-queued order once, not twice, when the table is served from local history', async () => {
  api.post = async (path) => (path === '/stations/register'
    ? { slot_number: 3, next_sequence: 1, registered_at: '2026-08-26T00:00:00.000Z' } : {});
  await ensureStationRegistered();
  api.request = async () => { throw new Error('Failed to fetch'); };

  const local = await saveOrderLocalFirst({
    customer: { id: 5, name: 'Aling Nena' },
    items: [{ product_id: 1, product_name: 'Coke', sku: 'C-8', quantity: 1, unit_price: 300 }],
    profileKey: 'josie',
  });

  api.get = async () => { throw new Error('Failed to fetch'); };
  const r = renderPage(React.createElement(OrdersPage));
  await settle(80);

  const rows = r.all('tbody tr').filter((tr) => tr.textContent.includes('Aling Nena'));
  assert.equal(rows.length, 1,
    'the outbox row and the local-history copy are the same sale — it must appear once, badged');
  assert.match(rows[0].textContent, /Waiting to sync/);

  r.unmount();
});

test('OrderDetailPage opens an order this tablet never created and never visited, from the synced history alone', async () => {
  // Exactly the field-testing failure this slice exists for: the order came from the
  // eager sync, not from a visit and not from a local save.
  stubServer({ orders: [serverOrder(1240, {
    receipt_number: null, customer_name: 'Mang Juan', status: 'pending',
    created_at: '2026-08-24T02:00:00.000Z', updated_at: '2026-08-24T02:00:00.000Z',
  })] });
  await runSync({ trigger: 'login', waitForOrders: true });

  api.get = async () => { throw new Error('Failed to fetch'); };
  const OrderDetailPage = (await import('../src/pages/orders/OrderDetailPage.jsx')).default;

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const { Routes, Route } = await import('react-router-dom');
  act(() => {
    root.render(React.createElement(MemoryRouter, { initialEntries: ['/orders/1240'] },
      React.createElement(Routes, null,
        React.createElement(Route, {
          path: '/orders/:id',
          element: React.createElement(ToastProvider, null, React.createElement(OrderDetailPage)),
        }))));
  });
  await settle(60);

  assert.match(container.textContent, /Mang Juan/, 'the order opens by its numeric id, offline');
  assert.match(container.textContent, /C-8/, 'with its line items — not a summary row');
  assert.doesNotMatch(container.textContent, /Line items not available offline/);
  assert.doesNotMatch(container.textContent, /Invalid Date/);
  assert.doesNotMatch(container.textContent, /Order not found/);
  assert.doesNotMatch(container.textContent, /Waiting to sync/,
    'it is a synced order; only the offline-copy notice applies');

  act(() => { root.unmount(); });
});

// ── 7. Offline order creation ─────────────────────────────────────────────────

test('OrderCreateModal loads its catalogue from the device when the server is unreachable', async () => {
  stubServer({ orders: [] });
  await runSync({ trigger: 'login', waitForOrders: true });

  api.get = async () => { throw new Error('Failed to fetch'); };

  const r = renderPage(React.createElement(OrderCreateModal, { onClose() {}, onSaved() {} }));
  await settle(60);

  assert.match(r.text(), /Coke Sakto 200ml/, 'the product grid fills from the held catalogue');
  assert.match(r.text(), /Luis Reyes/, 'and so does the Driver/Helper list');
  assert.doesNotMatch(r.text(), /Failed to load form data/);

  r.unmount();
});

test('OrderCreateModal offers a customer who was added from the directory while offline', async () => {
  stubServer({ orders: [] });
  await runSync({ trigger: 'login', waitForOrders: true });
  await enqueue({
    entityType: 'customer', endpoint: '/customers', method: 'POST',
    payload: { name: 'Blackout Sari-Sari', customer_type: 'regular' }, profileKey: 'josie',
  });

  api.get = async () => { throw new Error('Failed to fetch'); };

  const r = renderPage(React.createElement(OrderCreateModal, { onClose() {}, onSaved() {} }));
  await settle(60);

  const search = r.all('input').find((i) => (i.getAttribute('aria-label') || '') === 'Customer');
  assert.ok(search, 'the customer combobox must render');
  act(() => { changeInput(search, 'Blackout'); });
  await settle(30);

  assert.match(r.text(), /Blackout Sari-Sari/,
    'a customer queued from the directory has to be pickable, or adding her during the outage achieved nothing');

  r.unmount();
});

test('CustomerFormModal queues the new customer in the outbox instead of a bare POST that fails offline', async () => {
  let posted = false;
  api.post = async () => { posted = true; throw new Error('Failed to fetch'); };
  api.request = async () => { throw new Error('Failed to fetch'); };

  let savedCalled = false;
  const r = renderPage(React.createElement(CustomerFormModal, {
    onClose() {}, onSaved() { savedCalled = true; },
  }));
  await settle(20);

  const nameInput = r.all('input').find((i) => i.type === 'text');
  act(() => { changeInput(nameInput, 'Mang Toto Store'); });
  const saveBtn = r.all('button').find((b) => b.textContent.includes('Save Customer'));
  await act(async () => {
    saveBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await new Promise((res) => setTimeout(res, 60));
  });

  const queued = (await listRecords()).filter((rec) => rec.entity_type === 'customer');
  assert.equal(queued.length, 1, 'the customer must be queued, not lost to a failed fetch');
  assert.equal(queued[0].payload.name, 'Mang Toto Store');
  assert.equal(queued[0].profile_key, 'josie', 'D14: the profile that made it rides with it');
  assert.equal(posted, false, 'and it never goes out as a direct api.post');
  assert.equal(savedCalled, true, 'the modal still closes cleanly — the operator is not blocked');

  r.unmount();
});

// ── 8. Offline status transitions (ADR 0015 §5) ───────────────────────────────

test('canTransitionOffline allows the forward lifecycle and nothing else', () => {
  assert.equal(canTransitionOffline('pending', 'in_transit'), true);
  assert.equal(canTransitionOffline('pending', 'completed'), true, 'a pickup handed over during an outage');
  assert.equal(canTransitionOffline('in_transit', 'completed'), true);
  assert.equal(canTransitionOffline('in_transit', 'pending'), false, 'reversals undo shared state');
  assert.equal(canTransitionOffline('pending', 'cancelled'), false);
  assert.equal(canTransitionOffline('completed', 'done'), false, 'settlement counts bottles centrally');
});

test('dispatching an unsynced order offline updates it locally and queues the transition behind its own creation', async () => {
  api.post = async (path) => (path === '/stations/register'
    ? { slot_number: 3, next_sequence: 1, registered_at: '2026-08-26T00:00:00.000Z' } : {});
  await ensureStationRegistered();
  api.request = async () => { throw new Error('Failed to fetch'); }; // nothing drains

  const local = await saveOrderLocalFirst({
    customer: { id: 5, name: 'Aling Nena' },
    items: [{ product_id: 1, product_name: 'Coke', sku: 'C-8', quantity: 1, unit_price: 300 }],
    profileKey: 'josie',
  });

  const updated = await transitionLocalOrder({ order: local, newStatus: 'in_transit', profileKey: 'josie' });
  assert.equal(updated.status, 'in_transit');
  assert.ok(updated.dispatched_at);
  assert.equal((await getReceipt(local.receipt_number)).status, 'in_transit',
    'the counter screen tells the truth about the truck immediately');

  const records = await listRecords();
  const orderRecord  = records.find((r) => r.entity_type === 'order');
  const statusRecord = records.find((r) => r.entity_type === 'order_status');
  assert.ok(statusRecord, 'the transition is its own outbox record — POST /orders cannot express it');
  assert.equal(statusRecord.endpoint, `/orders/${local.receipt_number}/status`);
  assert.deepEqual(statusRecord.payload, { status: 'in_transit' });
  assert.deepEqual(statusRecord.depends_on, [orderRecord.id],
    'and it can only be sent after the order it transitions actually exists');
  assert.ok(statusRecord.id > orderRecord.id, 'so it drains after it, never before');
});

test('an order that has already synced cannot be transitioned offline', async () => {
  await putOrderSnapshot(serverOrder(1240, { status: 'pending', receipt_number: '1-00001' }));
  const synced = await getReceipt(1240);

  await assert.rejects(
    () => transitionLocalOrder({ order: synced, newStatus: 'in_transit', profileKey: 'josie' }),
    /not queued in the outbox/,
    'once other tablets can see it, its status is shared state — ADR 0015 §5',
  );
});
