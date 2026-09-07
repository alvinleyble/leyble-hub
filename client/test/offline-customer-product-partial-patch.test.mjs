// Regression test for offline-multi-device clobber audit item 4
// (data/leyble-hub-offline-multidevice-clobber-audit/report.md).
//
// CustomerDetailPanel's handleSave and ProductDetailPanel's handleSaveDetails used to
// build a FULL-FORM patch (every field, not a diff) before queueing it. If two tablets
// edited the same customer/product while either was offline, whichever save drained
// second would silently overwrite every field from the first save — including fields
// neither tablet touched — because the client resent them from a possibly-stale cached
// snapshot.
//
// Each test below reproduces exactly that two-tablet shape end to end: Tablet A saves a
// field online (landing on "the server"); Tablet B, holding a cache from BEFORE A's
// edit, saves a DIFFERENT field offline and later syncs. Before the fix this queued
// Tablet B's stale copy of A's field alongside B's own change, and draining it silently
// reverted A's edit. After the fix, only the field each tablet actually touched is sent,
// so both edits survive the drain in either order.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, React, act } from './render.mjs';
import { api } from '../src/api/client.js';
import { ToastProvider } from '../src/components/ui/Toast.jsx';
import { __resetMemoryBackend } from '../src/offline/nativeStore.js';
import { __clearOutbox, drainOutbox } from '../src/offline/outbox.js';
import { __clearConflicts } from '../src/offline/reconcile.js';
import { applyCatalogueDelta } from '../src/offline/catalogue.js';

const CustomerDetailPanel = (await import('../src/pages/customers/CustomerDetailPanel.jsx')).default;
const ProductDetailPanel  = (await import('../src/pages/inventory/ProductDetailPanel.jsx')).default;

const settle = (ms = 40) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
const offline = () => { throw new Error('Failed to fetch'); };
const withToast = (el) => React.createElement(ToastProvider, null, el);

function changeInput(input, value) {
  const prototype = input.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
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
  await __clearOutbox();
  await __clearConflicts();
  localStorage.setItem('activeProfile', 'josie');
});

afterEach(() => {
  Object.assign(api, saved);
  localStorage.clear();
});

// ── Customers — the real everyday risk (name/type/address/phone/notes) ──────────────

test('two tablets editing different customer fields, one offline then syncing, both survive', async () => {
  const server = {
    customer: {
      id: 4, name: 'Tindahan ni Juan', customer_type: 'regular', phone: '09998887777',
      address: 'Marikina City', notes: '', is_active: true,
    },
  };
  // Tablet B's cache is taken BEFORE Tablet A's edit lands — exactly the staleness
  // window the audit describes.
  await applyCatalogueDelta('customers', [{ ...server.customer }]);

  // Server mock: a real PATCH — only overwrite fields present in the body, matching
  // customers.js's actual "undefined field falls back to existing" behavior.
  const patchOntoServer = async (path, options) => {
    if (options.method === 'PATCH' && path === '/customers/4') {
      const body = JSON.parse(options.body);
      server.customer = { ...server.customer, ...body };
      return { ...server.customer, orders: [] };
    }
    return {};
  };

  // ── Tablet A: online, edits address only ──
  api.get = async (path) => (path === '/customers/4' ? { ...server.customer, orders: [] } : []);
  api.request = patchOntoServer;

  const a = render(withToast(React.createElement(CustomerDetailPanel, {
    customerId: 4, onClose: () => {}, onSaved: () => {},
  })));
  await settle();
  await act(() => {
    changeInput(a.container.querySelector(`input[value="${server.customer.address}"]`), 'New Address, Antipolo');
  });
  const saveA = a.all('button').find((b) => b.textContent.includes('Save Changes'));
  a.click(saveA);
  await settle();
  a.unmount();

  assert.equal(server.customer.address, 'New Address, Antipolo', "tablet A's edit landed");
  assert.equal(server.customer.phone, '09998887777', 'unrelated field untouched by A');

  // ── Tablet B: offline, holding the pre-A cache, edits phone only ──
  api.get = async () => offline();
  api.request = async () => offline();

  const b = render(withToast(React.createElement(CustomerDetailPanel, {
    customerId: 4, onClose: () => {}, onSaved: () => {},
  })));
  await settle();
  const phoneInput = b.container.querySelector('input[value="09998887777"]');
  assert.ok(phoneInput, "tablet B is rendering its stale cached copy (pre-A's address change)");
  await act(() => { changeInput(phoneInput, '09991234567'); });
  const saveB = b.all('button').find((b2) => b2.textContent.includes('Save Changes'));
  b.click(saveB);
  await settle();
  b.unmount();

  // Reconnect and drain what Tablet B queued.
  api.get = async (path) => (path === '/customers/4' ? { ...server.customer, orders: [] } : []);
  api.request = patchOntoServer;
  await drainOutbox();

  // Both edits must survive — this is exactly what the pre-fix full-form resend broke.
  assert.equal(server.customer.phone, '09991234567', "tablet B's edit landed");
  assert.equal(server.customer.address, 'New Address, Antipolo',
    "tablet A's address must survive tablet B's later, unrelated save");
});

// ── Products — lower but real exposure on master-data fields ────────────────────────

test('two tablets editing different product fields, one offline then syncing, both survive', async () => {
  const server = {
    product: {
      id: 7, name: 'Red Horse 500ml', sku: 'RH-5', category: 'Beer', unit: 'cs',
      base_wholesale_price: 900, deposit_fee: 5, current_stock: 20, units_per_case: 24,
      requires_bottle_return: true, is_active: true,
    },
  };
  await applyCatalogueDelta('products', [{ ...server.product }]);

  const patchOntoServer = async (path, options) => {
    if (options.method === 'PATCH' && path === '/products/7') {
      const body = JSON.parse(options.body);
      server.product = { ...server.product, ...body };
      return { ...server.product };
    }
    return {};
  };

  // ── Tablet A: online, edits category only ──
  api.get = async (path) => (path === '/products/7' ? { ...server.product, audit_log: [] } : []);
  api.request = patchOntoServer;

  const a = render(withToast(React.createElement(ProductDetailPanel, {
    productId: 7, onClose: () => {}, onSaved: () => {},
  })));
  await settle();
  await act(() => {
    changeInput(a.container.querySelector(`input[value="${server.product.category}"]`), 'Beer & Malt');
  });
  const saveA = a.all('button').find((b) => b.textContent.includes('Save Changes'));
  a.click(saveA);
  await settle();
  a.unmount();

  assert.equal(server.product.category, 'Beer & Malt', "tablet A's edit landed");
  assert.equal(server.product.sku, 'RH-5', 'unrelated field untouched by A');

  // ── Tablet B: offline, holding the pre-A cache, edits SKU only ──
  api.get = async () => offline();
  api.request = async () => offline();

  const b = render(withToast(React.createElement(ProductDetailPanel, {
    productId: 7, cachedProduct: { id: 7, name: 'Red Horse 500ml', sku: 'RH-5', category: 'Beer',
      unit: 'cs', base_wholesale_price: 900, deposit_fee: 5, current_stock: 20, units_per_case: 24,
      requires_bottle_return: true, is_active: true },
    onClose: () => {}, onSaved: () => {},
  })));
  await settle();
  const skuInput = b.container.querySelector('input[value="RH-5"]');
  assert.ok(skuInput, "tablet B is rendering its stale cached copy (pre-A's category change)");
  await act(() => { changeInput(skuInput, 'RH-5-NEW'); });
  const saveB = b.all('button').find((b2) => b2.textContent.includes('Save Changes'));
  b.click(saveB);
  await settle();
  b.unmount();

  // Reconnect and drain what Tablet B queued.
  api.get = async (path) => (path === '/products/7' ? { ...server.product, audit_log: [] } : []);
  api.request = patchOntoServer;
  await drainOutbox();

  // Both edits must survive — this is exactly what the pre-fix full-form resend broke.
  assert.equal(server.product.sku, 'RH-5-NEW', "tablet B's edit landed");
  assert.equal(server.product.category, 'Beer & Malt',
    "tablet A's category must survive tablet B's later, unrelated save");
});
