import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, React, act } from './render.mjs';
import { api } from '../src/api/client.js';
import { __resetMemoryBackend } from '../src/offline/nativeStore.js';
import * as outbox from '../src/offline/outbox.js';
import { getCachedEntity, applyCatalogueDelta } from '../src/offline/catalogue.js';
import { __resetStatusState, stopReachabilityWatcher } from '../src/offline/status.js';
import { queuedProductsFromOutbox } from '../src/offline/productMutations.js';
import { ToastProvider } from '../src/components/ui/Toast.jsx';
import NeedsAttentionModal from '../src/components/pos/NeedsAttentionModal.jsx';

const existing = { id: 81, name: 'Cola One Litre', sku: 'clvb 1l', unit: 'case', base_wholesale_price: '200.00', current_stock: '12', is_active: true };
let originalRequest, originalGet;
beforeEach(async () => {
  __resetMemoryBackend();
  __resetStatusState();
  await outbox.__clearOutbox();
  originalRequest = api.request;
  originalGet = api.get;
  api.get = async () => [];
});
afterEach(() => { api.request = originalRequest; api.get = originalGet; stopReachabilityWatcher(); __resetStatusState(); });
const duplicate = () => Object.assign(new Error('This record already exists.'), { status: 409, data: { code: 'duplicate', existing_product: existing } });
const queueProduct = (name = '  COLA   one litre  ') => outbox.enqueue({ entityType: 'product', endpoint: '/products', profileKey: 'josie', payload: { name, sku: existing.sku, unit: 'case', base_wholesale_price: 999, current_stock: 99 } });
async function park() {
  const record = await queueProduct('Different drink');
  api.request = async () => { throw duplicate(); };
  await outbox.drainOutbox();
  return record;
}

test('same normalized name adopts the server product and resolves order, price and stock references', async () => {
  const product = await queueProduct();
  await applyCatalogueDelta('products', [{ ...product.payload, id: `local-${product.id}` }]);
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
  assert.deepEqual(await outbox.listRecords(), []);
  assert.equal(calls[0][1].items[0].product_id, existing.id);
  assert.equal(calls[1][1].product_id, existing.id);
  assert.equal(calls[2][0], '/products/81');
  assert.deepEqual(await getCachedEntity('products'), [existing], 'server values stand; create values are not applied');
  assert.deepEqual(await queuedProductsFromOutbox(), []);
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
  assert.deepEqual(await getCachedEntity('products'), [existing]);
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

test('lost response retry adopts the already accepted product without applying initial stock twice', async () => {
  const product = await queueProduct(existing.name);
  api.request = async () => { throw new TypeError('lost response after server accepted create'); };
  await outbox.drainOutbox();
  const [retry] = await outbox.listRecords();
  assert.equal(retry.request_key, product.request_key);
  api.request = async () => { throw duplicate(); };
  await outbox.drainOutbox();
  assert.deepEqual(await outbox.listNeedsAttention(), []);
  assert.deepEqual(await outbox.listRecords(), []);
  assert.equal((await getCachedEntity('products'))[0].current_stock, '12');
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
  api.request = async () => { const err = duplicate(); err.data.existing_product = { ...existing, sku: existing.sku.toUpperCase() }; throw err; };
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

test('clash card shows both names and both actions, never the customer picker', async () => {
  await park();
  let view;
  await act(async () => { view = render(React.createElement(ToastProvider, null, React.createElement(NeedsAttentionModal))); });
  try {
    assert.match(view.text(), /Different drink/);
    assert.match(view.text(), /Cola One Litre/);
    assert.match(view.text(), /clvb 1l/);
    assert.ok(view.all('button').some(b => b.textContent === 'Use existing product'));
    assert.ok(view.all('button').some(b => b.textContent === 'Change code'));
    assert.doesNotMatch(view.text(), /Assign to Active Customer/);
    api.request = async () => { throw new Error('explicit adoption does not send a create'); };
    await act(async () => {
      view.click(view.all('button').find(b => b.textContent === 'Use existing product'));
      await new Promise(resolve => setTimeout(resolve, 20));
    });
    assert.deepEqual(await outbox.listRecords(), []);
    assert.deepEqual(await getCachedEntity('products'), [existing]);
  } finally { view.unmount(); }
});

test('Change code card input saves the new code and drains without altering entered product details', async () => {
  await park();
  let view;
  await act(async () => { view = render(React.createElement(ToastProvider, null, React.createElement(NeedsAttentionModal))); });
  try {
    view.click(view.all('button').find(b => b.textContent === 'Change code'));
    const input = view.all('input')[0];
    assert.ok(view.all('label').some(label => label.htmlFor === input.id && label.textContent === 'New product code'));
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, 'new-code');
      // Same jsdom input-event workaround used by the existing form suites.
      const propsKey = Object.keys(input).find(key => key.startsWith('__reactProps'));
      input[propsKey].onChange({ target: { value: 'new-code' } });
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
