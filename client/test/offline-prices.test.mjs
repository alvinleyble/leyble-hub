// Offline pricing gap fix (ADR 0009 addendum) — saved customer prices (`customer_product_prices`)
// are now cached in native storage alongside the products/customers catalogue, so an order taken
// offline still bills the customer's agreed rate instead of silently falling back to base price.
//
// Covers:
// 1. client/src/offline/catalogue.js — loadCustomerPrices()/getCachedCustomerPrices() cache and
//    fall back per (customer, order_type), never throw, and don't cross-contaminate between
//    customers or channels.
// 2. client/src/pages/orders/OrderCreateModal.jsx — the saved-price effect and the mis-tagged-
//    customer nudge (hasAnySavedPrice) both apply the cached rate when the live fetch fails.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import './render.mjs'; // jsdom globals
import { render, React, act } from './render.mjs';

import { api } from '../src/api/client.js';
import { ToastProvider } from '../src/components/ui/Toast.jsx';
import { __resetMemoryBackend } from '../src/offline/nativeStore.js';
import { getCachedCustomerPrices, loadCustomerPrices } from '../src/offline/catalogue.js';

const OrderCreateModal = (await import('../src/pages/orders/OrderCreateModal.jsx')).default;

let saved;
beforeEach(() => {
  __resetMemoryBackend();
  saved = { get: api.get, post: api.post, patch: api.patch, del: api.del };
});

afterEach(() => {
  api.get = saved.get; api.post = saved.post; api.patch = saved.patch; api.del = saved.del;
});

// ── Unit: client/src/offline/catalogue.js price caching ─────────────────────────

test('loadCustomerPrices caches the live response, keyed by customer AND order_type', async () => {
  const rows = [{ id: 9, product_id: 1, custom_unit_price: '280.00' }];
  api.get = async (path) => (path === '/customers/1/prices?order_type=delivery' ? rows : []);

  const result = await loadCustomerPrices(1, 'delivery');
  assert.equal(result.fromCache, false);
  assert.deepEqual(result.prices, rows);

  assert.deepEqual(await getCachedCustomerPrices(1, 'delivery'), rows);
  // Neither the other channel nor another customer's key was touched.
  assert.deepEqual(await getCachedCustomerPrices(1, 'pickup'), []);
  assert.deepEqual(await getCachedCustomerPrices(2, 'delivery'), []);
});

test('loadCustomerPrices falls back to the cached copy when the live fetch fails', async () => {
  const rows = [{ id: 9, product_id: 1, custom_unit_price: '280.00' }];
  api.get = async () => rows;
  await loadCustomerPrices(1, 'delivery'); // primes the cache

  api.get = async () => { throw new Error('Failed to fetch'); };
  const result = await loadCustomerPrices(1, 'delivery');
  assert.equal(result.fromCache, true);
  assert.deepEqual(result.prices, rows);
});

test('loadCustomerPrices on a brand-new device with no cache and no connectivity returns [], never throws', async () => {
  api.get = async () => { throw new Error('Failed to fetch'); };
  const result = await loadCustomerPrices(1, 'delivery');
  assert.equal(result.fromCache, true);
  assert.deepEqual(result.prices, []);
});

// ── Integration: OrderCreateModal ────────────────────────────────────────────────

const products = [
  { id: 1, name: 'Coke Sakto 200ml', sku: 'C-8', category: 'Softdrinks', unit: 'cs',
    base_wholesale_price: 300, units_per_case: 1, is_active: true },
];

const customers = [
  { id: 1, name: 'Aling Nena',       customer_type: 'wholesaler', is_active: true },
  { id: 2, name: 'Buddy Wholesaler', customer_type: 'regular',    is_active: true },
];

const savedPriceRow = { id: 9, product_id: 1, custom_unit_price: '280.00', product_name: 'Coke Sakto 200ml', sku: 'C-8' };

let pricesReachable;
let priceRows; // '<customerId>:<order_type>' -> rows

function installApi() {
  api.get = async (path) => {
    if (path.startsWith('/customers?') || path === '/customers') return customers;
    if (path.startsWith('/products')) return products;
    if (path.startsWith('/personnel')) return [];
    const m = path.match(/^\/customers\/(\d+)\/prices\?order_type=(\w+)$/);
    if (m) {
      if (!pricesReachable) throw new Error('Failed to fetch');
      return priceRows[`${m[1]}:${m[2]}`] ?? [];
    }
    return [];
  };
  api.post = async () => ({ id: 100 });
  api.patch = async (path, body) => {
    const id = Number(path.split('/')[2]);
    const c = customers.find((x) => x.id === id);
    return { ...c, customer_type: body.customer_type };
  };
  api.del = async () => ({ status: 'ok' });
}

beforeEach(() => {
  pricesReachable = true;
  priceRows = {};
  installApi();
});

const settle = (ms = 40) => act(async () => { await new Promise((res) => setTimeout(res, ms)); });

async function waitFor(predicate, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await settle(20);
  }
  return predicate();
}

async function open(props = {}) {
  const r = render(
    React.createElement(ToastProvider, null,
      React.createElement(OrderCreateModal, { onClose: () => {}, onSaved: () => {}, ...props })
    )
  );
  await waitFor(() => r.text().includes('Customer'));
  await settle();
  return r;
}

function changeInput(input, value) {
  const descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
  if (descriptor?.set) descriptor.set.call(input, value); else input.value = value;
  const key = Object.keys(input).find((k) => k.startsWith('__reactProps'));
  if (key && input[key]?.onChange) input[key].onChange({ target: { value, type: 'text' } });
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  input.dispatchEvent(new window.Event('change', { bubbles: true }));
}

async function pickCustomer(r, typed) {
  const input = r.byLabel('Customer');
  act(() => { input.focus(); changeInput(input, typed); });

  let row;
  await waitFor(() => {
    row = r.all('[role="option"] button').find((b) => b.textContent.includes(typed));
    return Boolean(row);
  });
  assert.ok(row, `no dropdown row matched "${typed}"`);
  act(() => { row.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true })); });
  await settle();
}

const savedPricesBadgeText = (r) => {
  const text = r.text();
  const m = text.match(/Saved delivery prices applied \((\d+) product/);
  return m ? Number(m[1]) : null;
};

function addButtonFor(r, productName) {
  return r.all('button').find((b) => (b.getAttribute('aria-label') || '').startsWith(`Add half a case of ${productName}`));
}

test('online: selecting a customer with saved prices applies and caches the agreed rate', async () => {
  priceRows['1:delivery'] = [savedPriceRow];
  const r = await open();
  await pickCustomer(r, 'Aling');

  assert.ok(await waitFor(() => savedPricesBadgeText(r) === 1), 'the saved-prices badge should show 1 product');

  const add = addButtonFor(r, 'Coke Sakto 200ml');
  assert.ok(add, 'the product card should be present');
  r.click(add);
  await settle();

  const priceInput = r.container.querySelector('input[id^="price-"]');
  assert.equal(priceInput.value, '280', 'the line should be created at the agreed rate, not base price');

  // And the device now holds this customer's rate for offline use.
  assert.deepEqual(await getCachedCustomerPrices(1, 'delivery'), [savedPriceRow]);
  r.unmount();
});

test('offline: a previously-cached customer still bills the agreed rate, not base price', async () => {
  // Prime the cache while online (a prior session on this device).
  priceRows['1:delivery'] = [savedPriceRow];
  await loadCustomerPrices(1, 'delivery');

  // Now the line is down: the live prices endpoint fails outright.
  pricesReachable = false;

  const r = await open();
  await pickCustomer(r, 'Aling');

  assert.ok(await waitFor(() => savedPricesBadgeText(r) === 1),
    'the cached saved price must still apply while offline');

  const add = addButtonFor(r, 'Coke Sakto 200ml');
  r.click(add);
  await settle();

  const priceInput = r.container.querySelector('input[id^="price-"]');
  assert.equal(priceInput.value, '280', 'offline order creation must bill the cached agreed rate');
  r.unmount();
});

test('offline: a regular customer with no cached saved price still falls back to base price (accepted gap)', async () => {
  pricesReachable = false; // never had a chance to cache anything for this customer

  const r = await open();
  await pickCustomer(r, 'Buddy');
  await settle(120);

  assert.equal(savedPricesBadgeText(r), null, 'no saved-prices badge without a cached or live rate');

  const add = addButtonFor(r, 'Coke Sakto 200ml');
  r.click(add);
  await settle();

  const priceInput = r.container.querySelector('input[id^="price-"]');
  assert.equal(priceInput.value, '300', 'falls back to base wholesale price, same as an unreachable server today');
  r.unmount();
});

test('offline: the mis-tagged-customer nudge still fires from the cached copy', async () => {
  // "Buddy" is tagged regular but holds a saved delivery price — prime it online first.
  priceRows['2:delivery'] = [savedPriceRow];
  await loadCustomerPrices(2, 'delivery');
  await loadCustomerPrices(2, 'pickup'); // caches an empty pickup entry, same as a live round-trip would

  pricesReachable = false;

  const r = await open();
  await pickCustomer(r, 'Buddy');

  assert.ok(await waitFor(() => r.text().includes('has custom prices')),
    'the nudge must still see the cached saved price while offline');
  r.unmount();
});
