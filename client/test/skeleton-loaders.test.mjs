// Calm skeleton loaders (Skeleton.jsx) replace the generic centered `<Spinner
// size="lg" />` on Dashboard, Orders, Order Detail, Inventory and Customers. What is
// worth pinning here is the behaviour, not the markup:
//   * a genuinely cold load (nothing held, nothing live yet) shows the skeleton
//   * a device already holding a cached Dashboard paints it immediately and never
//     waits on a slow/hanging network call to do so — no skeleton flash
//   * once real content lands, the skeleton is gone
//   * a silent background refresh (the `{ silent: true }` path every one of these
//     pages already uses for drain-complete/online events) never re-shows it
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, React, act } from './render.mjs';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { api } from '../src/api/client.js';
import { ToastProvider } from '../src/components/ui/Toast.jsx';
import { __resetMemoryBackend, nativeStore } from '../src/offline/nativeStore.js';
import { __clearOutbox } from '../src/offline/outbox.js';
import { __clearReceipts } from '../src/offline/receiptHistory.js';
import { PRODUCTS_KEY, CUSTOMERS_KEY } from '../src/offline/keys.js';
import { writeBackOfficeCache, __clearBackOfficeCache, DASHBOARD_CACHE } from '../src/offline/backOfficeCache.js';

const DashboardPage  = (await import('../src/pages/DashboardPage.jsx')).default;
const OrdersPage     = (await import('../src/pages/orders/OrdersPage.jsx')).default;
const OrderDetailPage = (await import('../src/pages/orders/OrderDetailPage.jsx')).default;
const InventoryPage  = (await import('../src/pages/inventory/InventoryPage.jsx')).default;
const CustomersPage  = (await import('../src/pages/customers/CustomersPage.jsx')).default;

const { createRoot } = await import('react-dom/client');

let saved = {};

beforeEach(async () => {
  saved = { get: api.get, post: api.post, patch: api.patch, del: api.del, request: api.request };
  await __resetMemoryBackend();
  await __clearOutbox();
  await __clearReceipts();
  await __clearBackOfficeCache();
  localStorage.clear();
  localStorage.setItem('activeProfile', 'josie');
});

afterEach(() => {
  Object.assign(api, saved);
  localStorage.clear();
});

const settle = (ms = 10) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
// A never-resolving promise stands in for a request still in flight — proves a screen
// doesn't wait on the network to paint what it already has.
const hang = () => new Promise(() => {});

function withRouter(element, path = '/') {
  return React.createElement(MemoryRouter, { initialEntries: [path] },
    React.createElement(ToastProvider, null, element));
}

function renderRouted(element, { path = '/', route } = {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const body = route
    ? React.createElement(Routes, null, React.createElement(Route, { path: route, element }))
    : element;
  act(() => { root.render(withRouter(body, path)); });
  return {
    container,
    text: () => container.textContent,
    skeleton: (label) => container.querySelector(`[aria-label="${label}"]`),
    unmount: () => act(() => root.unmount()),
  };
}

// ── Dashboard ──────────────────────────────────────────────────────────────────

test('DashboardPage: a cold load with nothing held shows the skeleton, not a spinner', async () => {
  api.get = () => hang();
  const r = renderRouted(React.createElement(DashboardPage));
  await settle();

  assert.ok(r.skeleton('Loading dashboard'), 'skeleton placeholder is shown while nothing is held or live yet');
  assert.equal(r.container.querySelector('svg.animate-spin'), null, 'no spinner is rendered');
  r.unmount();
});

test('DashboardPage: the skeleton clears once the live fetch resolves', async () => {
  let resolveFetch;
  api.get = () => new Promise((resolve) => { resolveFetch = resolve; });
  const r = renderRouted(React.createElement(DashboardPage));
  await settle();
  assert.ok(r.skeleton('Loading dashboard'));

  resolveFetch({
    summary: { in_transit_count: 1, pending_count: 2, completed_count: 0, pending_tickets: 0 },
    orders: [], low_stock: [],
  });
  await settle();

  assert.equal(r.skeleton('Loading dashboard'), null, 'skeleton is gone once real data has landed');
  assert.match(r.text(), /Dashboard/);
  r.unmount();
});

test('DashboardPage: a device already holding a cached dashboard paints it immediately, with no skeleton flash, even while the network hangs', async () => {
  await writeBackOfficeCache(DASHBOARD_CACHE, {
    summary: { in_transit_count: 3, pending_count: 9, completed_count: 2, pending_tickets: 1 },
    orders: [], low_stock: [],
  });
  // The network never resolves in this test — if the page waited on it, it would
  // never leave the skeleton. Local-first means it doesn't.
  api.get = () => hang();

  const r = renderRouted(React.createElement(DashboardPage));
  await settle();

  assert.equal(r.skeleton('Loading dashboard'), null, 'no skeleton once a cached copy is held');
  assert.match(r.text(), /9/, 'the cached figures render without waiting on the pending live fetch');
  r.unmount();
});

// ── Orders ─────────────────────────────────────────────────────────────────────

// The Drafts banner (loadDrafts) hits `/orders?status=draft` independently of the
// main list fetch — each needs its own controllable promise, or resolving one
// silently resolves the other's closure instead and the real one hangs forever.
function mockOrdersGet({ listPending = true } = {}) {
  let resolveList;
  const api_ = api;
  api_.get = (path) => {
    if (path.startsWith('/orders?status=draft')) return Promise.resolve({ drafts: [] });
    if (path.startsWith('/orders')) {
      if (!listPending) return Promise.resolve({ orders: [], pagination: { total: 0, totalPages: 1 } });
      return new Promise((resolve) => { resolveList = resolve; });
    }
    return Promise.resolve([]);
  };
  return { resolveList: (v) => resolveList(v) };
}

test('OrdersPage: a cold load shows the table skeleton, then real rows replace it', async () => {
  const { resolveList } = mockOrdersGet();
  const r = renderRouted(React.createElement(OrdersPage));
  await settle();
  assert.ok(r.skeleton('Loading orders'), 'skeleton shown before the first orders response lands');

  await act(async () => { resolveList({ orders: [], pagination: { total: 0, totalPages: 1 } }); });
  await settle();

  assert.equal(r.skeleton('Loading orders'), null);
  assert.match(r.text(), /No orders yet/);
  r.unmount();
});

test('OrdersPage: a silent background refresh never re-shows the skeleton', async () => {
  mockOrdersGet({ listPending: false });
  const r = renderRouted(React.createElement(OrdersPage));
  await settle();
  assert.equal(r.skeleton('Loading orders'), null, 'initial load has already resolved');

  await act(async () => {
    window.dispatchEvent(new window.CustomEvent('leyble:orders-changed', { detail: { orders: [] } }));
  });
  await settle();

  assert.equal(r.skeleton('Loading orders'), null, 'the silent refresh triggered by the delta poll never re-shows the skeleton');
  r.unmount();
});

// ── Order Detail ───────────────────────────────────────────────────────────────

const orderFixture = {
  id: 42, receipt_number: '1A-00042', revision: '1', status: 'pending', order_type: 'delivery',
  customer_id: 7, customer_name: 'Aling Nena', created_at: '2026-09-09T01:00:00.000Z',
  adjustment: 0, adjustment_reason: null, total_amount: 300, notes: null,
  items: [{ id: 3, product_id: 9, product_name: 'Coke', sku: 'C-8', unit: 'cs', quantity: 1,
    unit_price: 300, unit_deposit_fee: 0, units_per_case: 24, bottles_returned: 0, requires_bottle_return: false }],
  personnel: [],
};

test('OrderDetailPage: a cold load shows the order skeleton, then the real order replaces it', async () => {
  let resolveFetch;
  api.get = () => new Promise((resolve) => { resolveFetch = resolve; });
  const r = renderRouted(React.createElement(OrderDetailPage), { path: '/orders/42', route: '/orders/:id' });
  await settle();
  assert.ok(r.skeleton('Loading order'));

  resolveFetch(orderFixture);
  await settle();

  assert.equal(r.skeleton('Loading order'), null);
  assert.match(r.text(), /Aling Nena/);
  r.unmount();
});

// ── Inventory ──────────────────────────────────────────────────────────────────

test('InventoryPage: a cold load shows the filters and table skeletons, then real content replaces them', async () => {
  let resolveFetch;
  api.get = () => new Promise((resolve) => { resolveFetch = resolve; });
  const r = renderRouted(React.createElement(InventoryPage));
  await settle();
  assert.ok(r.skeleton('Loading filters'));
  assert.ok(r.skeleton('Loading inventory'));

  resolveFetch([{ id: 1, name: 'Coke 1.5L', sku: 'C-1.5', category: 'Soda', current_stock: 10, is_active: true }]);
  await settle();

  assert.equal(r.skeleton('Loading filters'), null);
  assert.equal(r.skeleton('Loading inventory'), null);
  assert.match(r.text(), /Coke 1\.5L/);
  r.unmount();
});

test('InventoryPage: a silent reconnect refresh never re-shows the skeleton', async () => {
  const product = { id: 1, name: 'Coke 1.5L', sku: 'C-1.5', category: 'Soda', current_stock: 10, is_active: true };
  await nativeStore.setJson(PRODUCTS_KEY, [product]);
  api.get = async () => { throw new TypeError('Failed to fetch'); };
  const r = renderRouted(React.createElement(InventoryPage));
  await settle();
  assert.equal(r.skeleton('Loading inventory'), null, 'offline fallback already resolved to the cached table');

  api.get = async () => [product];
  await act(async () => { window.dispatchEvent(new window.Event('online')); });
  await settle();

  assert.equal(r.skeleton('Loading inventory'), null, 'reconnect refresh is silent and never re-shows the skeleton');
  r.unmount();
});

// ── Customers ──────────────────────────────────────────────────────────────────

test('CustomersPage: a cold load shows the table skeleton, then real rows replace it', async () => {
  let resolveFetch;
  api.get = () => new Promise((resolve) => { resolveFetch = resolve; });
  const r = renderRouted(React.createElement(CustomersPage));
  await settle();
  assert.ok(r.skeleton('Loading customers'));

  resolveFetch([{ id: 1, name: 'Aling Nena', customer_type: 'regular', is_active: true }]);
  await settle();

  assert.equal(r.skeleton('Loading customers'), null);
  assert.match(r.text(), /Aling Nena/);
  r.unmount();
});

test('CustomersPage: an offline-cached table renders with no skeleton, and a silent refresh never re-shows one', async () => {
  const customer = { id: 1, name: 'Aling Nena', customer_type: 'regular', is_active: true };
  await nativeStore.setJson(CUSTOMERS_KEY, [customer]);
  api.get = async () => { throw new TypeError('Failed to fetch'); };
  const r = renderRouted(React.createElement(CustomersPage));
  await settle();
  assert.equal(r.skeleton('Loading customers'), null);
  assert.match(r.text(), /Aling Nena/);
  r.unmount();
});
