// Five small, independently-fixable bugs surfaced by the 2026-08-28 offline
// acceptance-criteria audit (data/leyble-hub-offline-acceptance-criteria-grill/report.md),
// in code Slice 3.1/3.2 already shipped:
//   1. Inventory/Customers/Personnel list pages never read the existing catalogue cache.
//   2. OrdersPage's parked-drafts banner (loadDrafts) had no offline fallback.
//   3. OrderCreateModal's "Save Custom Price?" dialog wasn't wired to the outbox.
//   4. logout() wiped the exact identity record an offline re-login needs; a settled
//      "Resume Offline Session" login action (ADR 0015 §3) never existed.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, React, act } from './render.mjs';
import { Preferences } from '@capacitor/preferences';
import { api } from '../src/api/client.js';
import { ToastProvider } from '../src/components/ui/Toast.jsx';
import { nativeStore, __resetMemoryBackend } from '../src/offline/nativeStore.js';
import { PRODUCTS_KEY, CUSTOMERS_KEY, PERSONNEL_KEY, SESSION_KEY, LAST_IDENTITY_KEY, DRAFTS_KEY } from '../src/offline/keys.js';
import { __clearOutbox, listRecords } from '../src/offline/outbox.js';
import { putReceipt } from '../src/offline/receiptHistory.js';
import {
  AuthProvider, useAuth,
  getStoredSession, setStoredSession, removeStoredSession, getLastKnownIdentity,
  __setIsNativeForTest,
} from '../src/context/AuthContext.jsx';

const InventoryPage  = (await import('../src/pages/inventory/InventoryPage.jsx')).default;
const CustomersPage  = (await import('../src/pages/customers/CustomersPage.jsx')).default;
const PersonnelPage  = (await import('../src/pages/personnel/PersonnelPage.jsx')).default;
const OrdersPage     = (await import('../src/pages/orders/OrdersPage.jsx')).default;
const OrderCreateModal = (await import('../src/pages/orders/OrderCreateModal.jsx')).default;

let saved = {};

beforeEach(async () => {
  saved = { get: api.get, post: api.post, patch: api.patch, del: api.del, request: api.request };
  await __resetMemoryBackend();
  await __clearOutbox();
  localStorage.clear();
  await Preferences.clear().catch(() => {});
  localStorage.setItem('activeProfile', 'josie');
  __setIsNativeForTest(false);
});

afterEach(() => {
  api.get = saved.get;
  api.post = saved.post;
  api.patch = saved.patch;
  api.del = saved.del;
  api.request = saved.request;
  __setIsNativeForTest(false);
});

const offlineError = () => { const e = new TypeError('Failed to fetch'); throw e; };

// ── 1. Inventory/Customers/Personnel offline cache fallback ─────────────────────

test('InventoryPage: falls back to the catalogue product cache when GET /products fails offline', async () => {
  await nativeStore.setJson(PRODUCTS_KEY, [
    { id: 1, name: 'Coke 1.5L', sku: 'C-1.5', category: 'Soda', current_stock: 10, is_active: true },
  ]);
  api.get = async () => offlineError();

  const r = render(React.createElement(ToastProvider, null, React.createElement(InventoryPage)));
  await act(async () => { await new Promise((res) => setTimeout(res, 30)); });

  assert.match(r.text(), /Coke 1\.5L/);
  assert.doesNotMatch(r.text(), /Failed to load products/);
  r.unmount();
});

test('InventoryPage: shows the offline-empty-cache message (not the generic failure toast) when there is nothing cached', async () => {
  api.get = async () => offlineError();

  const r = render(React.createElement(ToastProvider, null, React.createElement(InventoryPage)));
  await act(async () => { await new Promise((res) => setTimeout(res, 30)); });

  assert.match(r.text(), /this device has no product catalogue yet/);
  r.unmount();
});

test('CustomersPage: falls back to the catalogue customer cache when GET /customers fails offline', async () => {
  await nativeStore.setJson(CUSTOMERS_KEY, [
    { id: 5, name: 'Aling Nena Sari-Sari', customer_type: 'regular', is_active: true },
  ]);
  api.get = async () => offlineError();

  const r = render(React.createElement(ToastProvider, null, React.createElement(CustomersPage)));
  await act(async () => { await new Promise((res) => setTimeout(res, 30)); });

  assert.match(r.text(), /Aling Nena Sari-Sari/);
  r.unmount();
});

test('PersonnelPage: falls back to the catalogue personnel cache when GET /personnel fails offline', async () => {
  await nativeStore.setJson(PERSONNEL_KEY, [
    { id: 9, full_name: 'Luis Cruz', is_active: true },
  ]);
  api.get = async () => offlineError();

  const r = render(React.createElement(ToastProvider, null, React.createElement(PersonnelPage)));
  await act(async () => { await new Promise((res) => setTimeout(res, 30)); });

  assert.match(r.text(), /Luis Cruz/);
  r.unmount();
});

// ── 2. OrdersPage parked-drafts banner offline fallback ─────────────────────────

// The banner's offline fallback used to read this device's synced order HISTORY, which
// by construction can never hold a draft: `GET /orders/sync` excludes them on purpose
// (a draft is working state, not history), and `putReceipt` is only ever called for a
// local SALE. So the fallback matched nothing in the field and the banner emptied the
// moment the line dropped — this test's original fixture hand-wrote a draft into
// receipt history, a shape no code path actually produces. The drafts the server gave
// us are now cached in their own key (offline/parkedOrders.js), which is what survives
// the outage.
test('OrdersPage: parked-drafts banner serves the cached server drafts when GET /orders?status=draft fails offline', async () => {
  await nativeStore.setJson(DRAFTS_KEY, [{
    id: 7001, receipt_number: null, status: 'draft', order_type: 'delivery',
    customer_name: 'Parked While Blind', total_amount: 0, adjustment: 0,
    created_at: new Date().toISOString(),
  }]);
  api.get = async (path) => {
    if (path.startsWith('/orders?status=draft')) return offlineError();
    if (path.startsWith('/orders')) return offlineError();
    return [];
  };

  const r = render(React.createElement(ToastProvider, null, React.createElement(OrdersPage)));
  await act(async () => { await new Promise((res) => setTimeout(res, 30)); });

  assert.match(r.text(), /1 parked draft/);
  assert.match(r.text(), /Parked While Blind/);
  r.unmount();
});

// The list the banner counts is cached on every reachable load, so the outage that
// follows has something to show — the catalogue's refresh-quietly rule (D16) applied to
// drafts.
test('OrdersPage: a successful draft load caches the server drafts for the next outage', async () => {
  api.get = async (path) => {
    if (path.startsWith('/orders?status=draft')) {
      return [{ id: 7002, status: 'draft', customer_name: 'Cached On The Way Past',
                total_amount: 0, adjustment: 0, created_at: new Date().toISOString() }];
    }
    if (path.startsWith('/orders')) return { orders: [], pagination: { total: 0, totalPages: 1 } };
    return [];
  };

  const r = render(React.createElement(ToastProvider, null, React.createElement(OrdersPage)));
  await act(async () => { await new Promise((res) => setTimeout(res, 30)); });
  r.unmount();

  const cached = await nativeStore.getJson(DRAFTS_KEY);
  assert.equal(cached.length, 1);
  assert.equal(cached[0].customer_name, 'Cached On The Way Past');
});

// ── 3. OrderCreateModal's "Save Custom Price?" dialog routes through the outbox ─

test('OrderCreateModal: the "Save Custom Price?" prompt queues a customer_price outbox record instead of calling api.post directly', async () => {
  api.get = async (path) => {
    if (path.startsWith('/customers/5/prices')) return [];
    if (path.startsWith('/products'))  return [{
      id: 1, name: 'Coke 1.5L', sku: 'C-1.5', is_active: true,
      base_wholesale_price: 50, units_per_case: 24, requires_bottle_return: false, deposit_fee: 0,
    }];
    if (path.startsWith('/customers')) return [{ id: 5, name: 'Aling Nena', customer_type: 'regular', is_active: true }];
    if (path.startsWith('/personnel')) return [];
    return [];
  };
  let apiPostCalledForPrices = false;
  api.post = async (path) => {
    if (path.includes('/prices')) apiPostCalledForPrices = true;
    return {};
  };
  api.patch = async () => ({});

  const editOrder = {
    id: 555, status: 'pending', customer_id: 5, order_type: 'delivery',
    adjustment: 0, adjustment_reason: '', notes: '',
    items: [{
      id: 1, product_id: 1, product_name: 'Coke 1.5L', sku: 'C-1.5', unit: 'cs',
      quantity: 2, unit_price: 45, unit_deposit_fee: 0, units_per_case: 24,
    }],
    personnel: [],
  };

  const r = render(
    React.createElement(ToastProvider, null,
      React.createElement(OrderCreateModal, { onClose: () => {}, onSaved: () => {}, editOrder }))
  );
  await act(async () => { await new Promise((res) => setTimeout(res, 40)); });

  const saveButton = r.all('button').find((b) => b.textContent.trim() === 'Save Changes');
  assert.ok(saveButton, 'expected a "Save Changes" button for a real edit');
  await act(async () => { r.click(saveButton); await new Promise((res) => setTimeout(res, 40)); });

  const confirmButton = r.all('button').find((b) => b.textContent.trim() === 'Yes, Save');
  assert.ok(confirmButton, 'expected the "Save Custom Price?" prompt to open (unit_price 45 differs from base 50)');

  await act(async () => { r.click(confirmButton); await new Promise((res) => setTimeout(res, 40)); });

  const records = await listRecords();
  const priceRecords = records.filter((rec) => rec.entity_type === 'customer_price');
  assert.equal(priceRecords.length, 1, 'expected one queued customer_price outbox record');
  assert.equal(priceRecords[0].endpoint, '/customers/5/prices');
  assert.equal(priceRecords[0].payload.product_id, 1);
  assert.equal(Number(priceRecords[0].payload.custom_unit_price), 45);
  assert.equal(apiPostCalledForPrices, false, 'the price save must be queued, never a direct api.post');

  r.unmount();
});

// ── 4. Last-known-identity survives logout()/401, and can resume offline ────────

test('AuthContext: setStoredSession also writes LAST_IDENTITY_KEY, and removeStoredSession (logout/401 path) leaves it untouched', async () => {
  __setIsNativeForTest(true);
  const mockUser = { id: 42, email: 'josie@leyblestore.com', full_name: 'Josie Leyble', role: 'admin' };

  await setStoredSession(mockUser);
  const { value: identityBefore } = await Preferences.get({ key: LAST_IDENTITY_KEY });
  assert.deepEqual(JSON.parse(identityBefore), mockUser);

  await removeStoredSession();

  const { value: sessionAfter } = await Preferences.get({ key: SESSION_KEY });
  assert.equal(sessionAfter, null, 'the live session must still be cleared by logout/401');

  const { value: identityAfter } = await Preferences.get({ key: LAST_IDENTITY_KEY });
  assert.deepEqual(JSON.parse(identityAfter), mockUser, 'the last-known identity must survive removeStoredSession');

  assert.deepEqual(await getLastKnownIdentity(), mockUser);
});

test('AuthContext: web builds persist LAST_IDENTITY_KEY to localStorage the same way', async () => {
  __setIsNativeForTest(false);
  const mockUser = { id: 7, email: 'luis@leyblestore.com', full_name: 'Luis Leyble', role: 'staff' };

  await setStoredSession(mockUser);
  await removeStoredSession();

  assert.equal(localStorage.getItem(SESSION_KEY), null);
  assert.deepEqual(JSON.parse(localStorage.getItem(LAST_IDENTITY_KEY)), mockUser);
  assert.deepEqual(await getLastKnownIdentity(), mockUser);
});

test('AuthProvider.resumeOfflineSession: restores the user from the last-known identity and re-populates the live session', async () => {
  const mockUser = { id: 42, email: 'josie@leyblestore.com', full_name: 'Josie Leyble', role: 'admin' };
  await setStoredSession(mockUser);
  await removeStoredSession(); // simulate a prior logout

  api.get = async (path) => (path === '/auth/me' ? offlineError() : {});

  let authResult = null;
  function TestConsumer() {
    const auth = useAuth();
    authResult = auth;
    return React.createElement('div', null, auth.user ? `user:${auth.user.email}` : 'user:none');
  }

  const { text, unmount } = render(
    React.createElement(AuthProvider, null, React.createElement(TestConsumer, null))
  );
  await act(async () => { await new Promise((res) => setTimeout(res, 30)); });

  assert.ok(text().includes('user:none'), 'no live session after a prior logout, offline');

  let resumed;
  await act(async () => { resumed = await authResult.resumeOfflineSession(); });

  assert.deepEqual(resumed, mockUser);
  assert.ok(text().includes('user:josie@leyblestore.com'));

  // Session storage should be repopulated so the ordinary silent-restore keeps working.
  assert.deepEqual(await getStoredSession(), mockUser);

  unmount();
});

test('AuthProvider.resumeOfflineSession: returns null on a device that has never signed in', async () => {
  let authResult = null;
  function TestConsumer() {
    authResult = useAuth();
    return null;
  }
  api.get = async () => offlineError();

  const { unmount } = render(
    React.createElement(AuthProvider, null, React.createElement(TestConsumer, null))
  );
  await act(async () => { await new Promise((res) => setTimeout(res, 30)); });

  let resumed = 'unset';
  await act(async () => { resumed = await authResult.resumeOfflineSession(); });
  assert.equal(resumed, null);

  unmount();
});
