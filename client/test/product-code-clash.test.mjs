import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, React, act } from './render.mjs';
import { api } from '../src/api/client.js';
import { __resetMemoryBackend } from '../src/offline/nativeStore.js';
import * as outbox from '../src/offline/outbox.js';
import { getCachedEntity, applyCatalogueDelta } from '../src/offline/catalogue.js';
import { __resetStatusState, stopReachabilityWatcher } from '../src/offline/status.js';
import { queuedProductsFromOutbox, createProductLocalFirst } from '../src/offline/productMutations.js';
import { ToastProvider } from '../src/components/ui/Toast.jsx';
import NeedsAttentionModal from '../src/components/pos/NeedsAttentionModal.jsx';
import ProductFormModal from '../src/pages/inventory/ProductFormModal.jsx';

// The server row as POST /products stores it (NUMERIC columns arrive as strings).
const existing = {
  id: 81, name: 'Cola One Litre', sku: 'clvb 1l', category: null, unit: 'case',
  base_wholesale_price: '200.00', deposit_fee: '0.00', current_stock: '12.00',
  units_per_case: 1, requires_bottle_return: false, is_active: true,
};
let originalRequest, originalGet;
beforeEach(async () => {
  __resetMemoryBackend();
  __resetStatusState();
  await outbox.__clearOutbox();
  originalRequest = api.request;
  originalGet = api.get;
  api.get = async () => [];
  localStorage.setItem('activeProfile', 'josie');
});
afterEach(() => { api.request = originalRequest; api.get = originalGet; localStorage.clear(); stopReachabilityWatcher(); __resetStatusState(); });
const duplicate = (product = existing) => Object.assign(new Error('This record already exists.'), { status: 409, data: { code: 'duplicate', existing_product: product } });
// The same body ProductFormModal sends for the same product typed in on another device.
const queueProduct = (name = '  COLA   one litre  ', values = {}) => outbox.enqueue({
  entityType: 'product', endpoint: '/products', profileKey: 'josie',
  payload: {
    name, category: null, unit: 'case', sku: existing.sku, base_wholesale_price: 200,
    deposit_fee: 0, current_stock: 12, units_per_case: 1, requires_bottle_return: false, ...values,
  },
});
async function park(name = 'Different drink', values = { base_wholesale_price: 999 }, product = existing) {
  const record = await queueProduct(name, values);
  api.request = async () => { throw duplicate(product); };
  await outbox.drainOutbox();
  return record;
}
const settle = (ms = 20) => act(async () => { await new Promise(resolve => setTimeout(resolve, ms)); });
function setInput(input, value) {
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, value);
  // Same jsdom input-event workaround used by the existing form suites.
  const propsKey = Object.keys(input).find(key => key.startsWith('__reactProps'));
  input[propsKey].onChange({ target: { value } });
}
const inputFor = (view, label) => {
  const node = view.all('label').find(l => l.textContent.replace('*', '').trim() === label);
  return document.getElementById(node.htmlFor);
};
const attentionModal = () => React.createElement(ToastProvider, null, React.createElement(NeedsAttentionModal));

test('same normalized name and same entered values adopt the server product and resolve order, price and stock references', async () => {
  const product = await queueProduct();
  const calls = [];
  for (const [entityType, endpoint, method, payload, endpointParams] of [
    ['order', '/orders', 'POST', { items: [{ product_id: outbox.ref(product.id) }] }],
    ['customer_prices', '/customers/1/prices', 'POST', { product_id: outbox.ref(product.id) }],
    ['product_update', '/products/:productId', 'PATCH', { current_stock: 8 }, { productId: outbox.ref(product.id) }],
  ]) await outbox.enqueue({ entityType, endpoint, method, payload, endpointParams, dependsOn: [product.id], profileKey: 'josie' });
  api.request = async (path, options) => {
    if (path === '/products') throw duplicate();
    calls.push([path, JSON.parse(options.body)]);
    return { id: 500 };
  };
  const result = await outbox.drainOutbox();
  assert.equal(result.sent, 4);
  assert.deepEqual(result.adopted, [product.id]);
  assert.deepEqual(await outbox.listRecords(), []);
  assert.equal(calls[0][1].items[0].product_id, existing.id);
  assert.equal(calls[1][1].product_id, existing.id);
  assert.equal(calls[2][0], '/products/81');
  assert.deepEqual(await queuedProductsFromOutbox(), []);
});

test('same name with a different entered price or initial stock reaches Needs attention instead of being adopted', async () => {
  for (const values of [
    { base_wholesale_price: 999 },
    { base_wholesale_price: 0 },
    { current_stock: 50 },
  ]) {
    await outbox.__clearOutbox();
    await queueProduct(existing.name, values);
    api.request = async () => { throw duplicate(); };
    const result = await outbox.drainOutbox();
    assert.deepEqual(result.adopted, [], `${Object.keys(values)[0]} differs, so nothing is adopted`);
    const [parked] = await outbox.listNeedsAttention();
    assert.ok(outbox.isProductCodeClash(parked), `${Object.keys(values)[0]} differs, so a person decides`);
    assert.deepEqual(outbox.productClashDifferences(parked.payload, parked.product_clash.existing_product).map(d => d.field), Object.keys(values));
  }
});

test('values the offline form locks or leaves blank never send a same-name create to a person', async () => {
  const configured = {
    ...existing, category: 'Soft Drinks', units_per_case: 24, requires_bottle_return: true,
    deposit_fee: '5.00', current_stock: '30.00',
  };
  const product = await queueProduct(existing.name, { current_stock: 0 });
  api.request = async () => { throw duplicate(configured); };
  const result = await outbox.drainOutbox();
  assert.deepEqual(result.adopted, [product.id]);
  assert.deepEqual(await outbox.listNeedsAttention(), []);
  assert.deepEqual(await outbox.listRecords(), []);
});

test('a deleted (deactivated) product is never adopted silently, even when every value matches', async () => {
  await queueProduct(existing.name);
  api.request = async () => { throw duplicate({ ...existing, is_active: false }); };
  const result = await outbox.drainOutbox();
  assert.deepEqual(result.adopted, []);
  const [parked] = await outbox.listNeedsAttention();
  assert.ok(outbox.isProductCodeClash(parked));
  assert.equal(parked.product_clash.existing_product.is_active, false);
});

test('Use existing product on a deleted product reactivates it through the product update path, then adopts it', async () => {
  const product = await park(existing.name, {}, { ...existing, is_active: false });
  const calls = [];
  api.request = async (path, options) => {
    calls.push([path, options.method, JSON.parse(options.body)]);
    if (path === '/products/81' && options.method === 'PATCH') return { ...existing, is_active: true };
    if (path === '/products') throw new Error('adoption must not resend the create');
    return { id: 3 };
  };
  await outbox.useExistingProduct(product.id);
  assert.deepEqual(calls, [['/products/81', 'PATCH', { is_active: true }]]);
  assert.equal((await outbox.drainOutbox()).sent, 1);
  await outbox.enqueue({ entityType: 'price', endpoint: '/prices', payload: { product_id: outbox.ref(product.id) }, profileKey: 'josie' });
  await outbox.drainOutbox();
  assert.deepEqual(calls.at(-1), ['/prices', 'POST', { product_id: 81, request_key: calls.at(-1)[2].request_key }]);
  assert.deepEqual(await outbox.listRecords(), []);
});

test('bringing back a deleted product without a connection leaves the question waiting', async () => {
  const product = await park(existing.name, {}, { ...existing, is_active: false });
  api.request = async () => { throw new TypeError('Failed to fetch'); };
  await assert.rejects(() => outbox.useExistingProduct(product.id), /needs a connection/);
  const [still] = await outbox.listNeedsAttention();
  assert.equal(still.id, product.id);
  assert.equal(still.product_adoption, undefined);
});

test('different names park with both names and block dependants without changing order flow', async () => {
  const product = await park();
  const order = await outbox.enqueue({ entityType: 'order', endpoint: '/orders', payload: { product_id: outbox.ref(product.id) }, dependsOn: [product.id], profileKey: 'josie' });
  let sent = false;
  api.request = async () => { sent = true; };
  await outbox.drainOutbox();
  assert.equal(sent, false);
  const [parked] = await outbox.listNeedsAttention();
  assert.equal(parked.payload.name, 'Different drink');
  assert.equal(parked.product_clash.existing_product.name, existing.name);
  assert.equal(parked.product_clash.sku, existing.sku);
  assert.equal((await outbox.listRecords()).find(r => r.id === order.id).status, outbox.QUEUED);
});

test('Use existing product completes through the drain and remembers its reference', async () => {
  const product = await park();
  await outbox.useExistingProduct(product.id);
  api.request = async () => { throw new Error('adoption must not resend the create'); };
  assert.equal((await outbox.drainOutbox()).sent, 1);
  await outbox.enqueue({ entityType: 'price', endpoint: '/prices', payload: { product_id: outbox.ref(product.id) }, profileKey: 'josie' });
  api.request = async (_path, options) => { assert.equal(JSON.parse(options.body).product_id, 81); return { id: 2 }; };
  await outbox.drainOutbox();
  assert.deepEqual(await outbox.listRecords(), []);
});

test('Use existing product never writes the clash-time copy over a newer held catalogue row', async () => {
  const product = await park();
  const newer = { ...existing, base_wholesale_price: '210.00', current_stock: '8.00', order_count: 40 };
  await applyCatalogueDelta('products', [newer]);
  await outbox.useExistingProduct(product.id);
  api.request = async () => { throw new Error('adoption must not resend the create'); };
  assert.equal((await outbox.drainOutbox()).sent, 1);
  assert.deepEqual(await getCachedEntity('products'), [newer]);
});

test('Change code requeues the same record with its entered fields and new code', async () => {
  const product = await park();
  await assert.rejects(() => outbox.changeProductCode(product.id, '   '));
  await outbox.changeProductCode(product.id, '  clvb-new  ');
  const [queued] = await outbox.listRecords();
  assert.equal(queued.id, product.id);
  assert.equal(queued.status, outbox.QUEUED);
  assert.equal(queued.payload.sku, 'clvb-new');
  assert.equal(queued.payload.name, 'Different drink');
  assert.equal(queued.product_clash, null);
  api.request = async (_path, options) => { assert.equal(JSON.parse(options.body).sku, 'clvb-new'); return { ...queued.payload, id: 90 }; };
  await outbox.drainOutbox();
  assert.deepEqual(await outbox.listRecords(), []);
});

test('lost response retry of this device\'s own accepted create is adopted silently', async () => {
  const product = await queueProduct(existing.name);
  api.request = async () => { throw new TypeError('lost response after server accepted create'); };
  await outbox.drainOutbox();
  const [retry] = await outbox.listRecords();
  assert.equal(retry.request_key, product.request_key);
  api.request = async () => { throw duplicate(); };
  const result = await outbox.drainOutbox();
  assert.deepEqual(result.adopted, [product.id]);
  assert.deepEqual(await outbox.listNeedsAttention(), []);
  assert.deepEqual(await outbox.listRecords(), []);
});

test('old server duplicate with no product body stays recoverable; unrelated order duplicate is unchanged', async () => {
  await queueProduct();
  await outbox.enqueue({ entityType: 'order', endpoint: '/orders', payload: {}, profileKey: 'josie' });
  api.request = async () => { throw Object.assign(new Error('Duplicate'), { status: 409, data: { code: 'duplicate' } }); };
  await outbox.drainOutbox();
  assert.equal((await outbox.listNeedsAttention()).length, 2);
});

test('only whitespace and case are normalized in names; SKU spelling is never loosened', async () => {
  for (const name of ['Cola-One-Litre', 'Cola One Litre Extra']) {
    await outbox.__clearOutbox();
    await queueProduct(name);
    api.request = async () => { throw duplicate(); };
    await outbox.drainOutbox();
    assert.equal((await outbox.listNeedsAttention()).length, 1);
  }
  await outbox.__clearOutbox();
  await queueProduct();
  api.request = async () => { throw duplicate({ ...existing, sku: existing.sku.toUpperCase() }); };
  await outbox.drainOutbox();
  assert.equal((await outbox.listNeedsAttention()).length, 1, 'no case-insensitive SKU lookup or adoption');
});

test('a 200 replay of an already-accepted create still completes normally', async () => {
  await queueProduct(existing.name);
  api.request = async () => existing;
  assert.equal((await outbox.drainOutbox()).sent, 1);
  assert.deepEqual(await outbox.listRecords(), []);
});

test('clash bookkeeping merges onto the current stored record, not the pass-start copy', async () => {
  const product = await queueProduct('Different drink');
  const { nativeStore } = await import('../src/offline/nativeStore.js');
  const { outboxKey } = await import('../src/offline/keys.js');
  api.request = async () => {
    const current = await nativeStore.getJson(outboxKey(product.id));
    await nativeStore.setJson(outboxKey(product.id), { ...current, payload: { ...current.payload, category: 'Concurrent edit' } });
    throw duplicate();
  };
  await outbox.drainOutbox();
  assert.equal((await outbox.listNeedsAttention())[0].payload.category, 'Concurrent edit');
});

test('clash card shows both names, each differing value for this device and the server, and both actions', async () => {
  await park('Different drink', { base_wholesale_price: 999, current_stock: 50 });
  let view;
  await act(async () => { view = render(attentionModal()); });
  try {
    assert.match(view.text(), /Different drink/);
    assert.match(view.text(), /Cola One Litre/);
    assert.match(view.text(), /clvb 1l/);
    const rows = view.all('[data-testid^="product-clash-difference-"]').map(li => li.textContent);
    assert.deepEqual(rows, [
      'Price: this device ₱999.00, server ₱200.00',
      'Stock: this device 50, server 12',
    ]);
    assert.doesNotMatch(view.text(), /deleted/);
    assert.ok(view.all('button').some(b => b.textContent === 'Use existing product'));
    assert.ok(view.all('button').some(b => b.textContent === 'Change code'));
    assert.doesNotMatch(view.text(), /Assign to Active Customer/);
    api.request = async () => { throw new Error('explicit adoption does not send a create'); };
    await act(async () => {
      view.click(view.all('button').find(b => b.textContent === 'Use existing product'));
      await new Promise(resolve => setTimeout(resolve, 20));
    });
    assert.deepEqual(await outbox.listRecords(), []);
  } finally { view.unmount(); }
});

test('clash card says plainly when the existing product was deleted, and Use existing product brings it back', async () => {
  await park(existing.name, {}, { ...existing, is_active: false });
  let view;
  await act(async () => { view = render(attentionModal()); });
  try {
    assert.match(view.text(), /This product was deleted \(deactivated\) on the server/);
    assert.deepEqual(view.all('[data-testid^="product-clash-difference-"]'), []);
    const calls = [];
    api.request = async (path, options) => {
      calls.push([path, options.method]);
      if (path === '/products') throw new Error('adoption must not resend the create');
      return { ...existing, is_active: true };
    };
    await act(async () => {
      view.click(view.all('button').find(b => b.textContent === 'Use existing product'));
      await new Promise(resolve => setTimeout(resolve, 20));
    });
    assert.deepEqual(calls, [['/products/81', 'PATCH']]);
    assert.deepEqual(await outbox.listRecords(), []);
  } finally { view.unmount(); }
});

test('Change code card input saves the new code and drains without altering entered product details', async () => {
  await park();
  let view;
  await act(async () => { view = render(attentionModal()); });
  try {
    view.click(view.all('button').find(b => b.textContent === 'Change code'));
    const input = inputFor(view, 'New product code');
    await act(async () => {
      setInput(input, 'new-code');
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    let body;
    api.request = async (_endpoint, options) => { body = JSON.parse(options.body); return { ...body, id: 91 }; };
    await act(async () => {
      view.all('form')[0].dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
      await new Promise(resolve => setTimeout(resolve, 20));
    });
    assert.equal(body.sku, 'new-code');
    assert.equal(body.name, 'Different drink');
    assert.equal(body.base_wholesale_price, 999);
    assert.deepEqual(await outbox.listRecords(), []);
  } finally { view.unmount(); }
});

test('an online Add Product that adopts an existing product says so, never "added to inventory"', async () => {
  const atZero = { ...existing, current_stock: '0.00' };
  api.request = async () => { throw duplicate(atZero); };
  let view;
  await act(async () => { view = render(React.createElement(ToastProvider, null, React.createElement(ProductFormModal, { onClose() {}, onSaved() {} }))); });
  try {
    await act(async () => {
      setInput(inputFor(view, 'Product Name'), 'Cola One Litre');
      setInput(inputFor(view, 'SKU'), existing.sku);
      setInput(inputFor(view, 'Wholesale Price (₱ / case)'), '200');
    });
    view.click(view.all('button').find(b => b.textContent.includes('Save Product')));
    await settle(60);
    assert.match(view.text(), /Cola One Litre already exists; using the existing product\./);
    assert.doesNotMatch(view.text(), /added to inventory/);
    assert.deepEqual(await outbox.listRecords(), []);
  } finally { view.unmount(); }
});

test('an online Add Product that clashes sends the operator to Needs attention, never "will sync when connected"', async () => {
  api.request = async () => { throw duplicate(); };
  let view;
  await act(async () => { view = render(React.createElement(ToastProvider, null, React.createElement(ProductFormModal, { onClose() {}, onSaved() {} }))); });
  try {
    await act(async () => {
      setInput(inputFor(view, 'Product Name'), 'Cola One Litre');
      setInput(inputFor(view, 'SKU'), existing.sku);
      setInput(inputFor(view, 'Wholesale Price (₱ / case)'), '999');
    });
    view.click(view.all('button').find(b => b.textContent.includes('Save Product')));
    await settle(60);
    assert.match(view.text(), /Product code already exists; tap the status light to choose\./);
    assert.doesNotMatch(view.text(), /will sync when connected|added to inventory|using the existing product/);
    assert.equal((await outbox.listNeedsAttention()).length, 1);
  } finally { view.unmount(); }
});

test('createProductLocalFirst reports a genuinely new product as created, not adopted or clashing', async () => {
  api.request = async (_path, options) => ({ ...JSON.parse(options.body), id: 92 });
  const result = await createProductLocalFirst({ name: 'Brand new', unit: 'case', sku: 'new-1', base_wholesale_price: 50 }, { profileKey: 'josie' });
  assert.equal(result.synced, true);
  assert.equal(result.adopted, false);
  assert.equal(result.clash, false);
});
