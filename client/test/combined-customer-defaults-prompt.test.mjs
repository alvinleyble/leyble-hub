// Combined "Save as Customer Defaults?" prompt (captain-approved, 2026-09-12): a custom
// product price and a customer's persistent delivery fee (persistent-delivery-fee.md)
// used to have no relationship — the price got its own "Save Custom Price?" prompt at
// save time, the delivery fee had no save-to-customer prompt at all. This combines both
// into ONE confirmation surface at the end of a successful order save, each kind listed
// and selected independently, so the operator never sees two sequential dialogs and can
// decline either kind without touching the other.
//
// Covers:
//  1. Both kinds dirty at once -> one combined prompt, both sections present, both
//     selected by default, confirming queues both an outbox `customer_price` record and
//     a `customer_update` record.
//  2. Independent selection: deselecting one kind's checkbox before confirming leaves the
//     other kind's write queued and skips the deselected one entirely.
//  3. Unchanged value: retyping the delivery fee back to the customer's current saved
//     default (with no price edited) shows no prompt at all.
//  4. A later order that pre-fills the customer's saved delivery fee, then has it
//     changed with no price edited, offers only the delivery-fee section.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, React, act } from './render.mjs';
import { api } from '../src/api/client.js';
import { ToastProvider } from '../src/components/ui/Toast.jsx';
import { nativeStore, __resetMemoryBackend } from '../src/offline/nativeStore.js';
import { STATION_KEY } from '../src/offline/keys.js';
import { ensureStationRegistered, __resetIssuance } from '../src/offline/station.js';
import { __clearOutbox, listRecords } from '../src/offline/outbox.js';

const OrderCreateModal = (await import('../src/pages/orders/OrderCreateModal.jsx')).default;

const products = [
  { id: 1, name: 'Coke Sakto 200ml', sku: 'C-8', category: 'Softdrinks', unit: 'cs',
    base_wholesale_price: 300, units_per_case: 1, is_active: true,
    requires_bottle_return: false, deposit_fee: 0 },
];

// customer_type: 'wholesaler' so the (unrelated) mis-tagged-customer nudge never fires
// and can't be confused with the prompt under test.
const customerWithFee = {
  id: 1, name: 'Aling Nena', customer_type: 'wholesaler', is_active: true, delivery_fee: 100,
};

let originalApiGet, originalApiPost, originalApiPatch, originalApiDel, originalApiRequest;

beforeEach(async () => {
  originalApiGet = api.get;
  originalApiPost = api.post;
  originalApiPatch = api.patch;
  originalApiDel = api.del;
  originalApiRequest = api.request;

  api.get = async (path) => {
    if (path.startsWith('/customers?') || path === '/customers') return [customerWithFee];
    if (path.startsWith('/products')) return products;
    if (path.startsWith('/personnel')) return [];
    if (path.startsWith('/orders?status=draft')) return [];
    if (path.includes('/prices')) return []; // no saved custom prices
    return [];
  };
  api.post = async (path) => (path === '/orders' ? { id: 100 } : { id: 100 });
  api.patch = async () => ({ id: 100 });
  api.del = async () => ({ status: 'ok' });
  // The order's own local-first save fires a background drain attempt; keep it offline
  // and queued so it can never race the assertions below either way.
  api.request = async () => { throw new Error('Failed to fetch'); };

  localStorage.setItem('activeProfile', 'josie');
  await __resetMemoryBackend();
  __resetIssuance();
  await __clearOutbox();
  await nativeStore.setJson(STATION_KEY, { device_key: 'test-device-defaults', station_number: 9 });
  api.post = async (path) => (path === '/stations/register'
    ? { registered_at: '2026-09-12T00:00:00.000Z' }
    : { id: 100 });
  await ensureStationRegistered();
  api.post = async (path) => (path === '/orders' ? { id: 100 } : { id: 100 });
});

afterEach(() => {
  api.get = originalApiGet;
  api.post = originalApiPost;
  api.patch = originalApiPatch;
  api.del = originalApiDel;
  api.request = originalApiRequest;
});

function changeInput(input, value) {
  const descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
  descriptor.set.call(input, value);
  const key = Object.keys(input).find((k) => k.startsWith('__reactProps'));
  if (key && input[key]?.onChange) input[key].onChange({ target: { value, type: 'number' } });
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
}

async function selectCustomer(r, typed) {
  const custInput = r.byLabel('Customer');
  act(() => { custInput.focus(); changeInput(custInput, typed); });
  await act(async () => { await new Promise((res) => setTimeout(res, 20)); });

  let row;
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline && !row) {
    row = r.all('[role="option"] button').find((b) => b.textContent.includes(typed));
    if (!row) await act(async () => { await new Promise((res) => setTimeout(res, 20)); });
  }
  assert.ok(row, `no dropdown row matched "${typed}"`);
  act(() => { row.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true })); });
  await act(async () => { await new Promise((res) => setTimeout(res, 30)); });
}

function deliveryFeeInput(r) {
  const section = r.container.querySelector('[data-testid="order-delivery-fee-section"]');
  return section?.querySelector('input[type="number"]') ?? null;
}

// The delivery-fee auto-fill effect runs after the customer/products state settles,
// which can lag a beat behind the fixed sleeps above on a cold first render — poll
// instead of guessing a longer fixed delay.
async function waitForFeeValue(r, expected, timeout = 2000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (deliveryFeeInput(r)?.value === expected) return true;
    await act(async () => { await new Promise((res) => setTimeout(res, 20)); });
  }
  return deliveryFeeInput(r)?.value === expected;
}

async function open() {
  const r = render(
    React.createElement(ToastProvider, null,
      React.createElement(OrderCreateModal, { onClose: () => {}, onSaved: () => {} }))
  );
  await act(async () => { await new Promise((res) => setTimeout(res, 30)); });
  return r;
}

async function addProduct(r) {
  const cokeBtn = r.all('button').find((b) => b.getAttribute('aria-label')?.includes('Coke Sakto'));
  assert.ok(cokeBtn, 'expected the Coke product tile');
  r.click(cokeBtn);
  await act(async () => { await new Promise((res) => setTimeout(res, 20)); });
}

async function submitOrder(r) {
  const submitBtn = r.all('button').find((b) => b.textContent.includes('Create Order'));
  assert.ok(submitBtn, 'expected the "Create Order" button');
  await act(async () => { r.click(submitBtn); await new Promise((res) => setTimeout(res, 60)); });
}

async function addProductAndSubmit(r) {
  await addProduct(r);
  await submitOrder(r);
}

test('combined prompt: a dirty price and a changed delivery fee both appear, selected by default, and both queue on confirm', async () => {
  const r = await open();
  await selectCustomer(r, 'Aling');

  // Delivery fee auto-fills from the customer's saved default (100); change it.
  assert.ok(await waitForFeeValue(r, '100'), 'expected the fee to auto-fill from the customer default');
  const feeInput = deliveryFeeInput(r);
  act(() => { changeInput(feeInput, '150'); });
  await act(async () => { await new Promise((res) => setTimeout(res, 10)); });

  await addProduct(r);

  // Drop the line price below base (300 -> 250) — but only after the tile add, so it
  // registers as a hand-edit distinct from the auto-priced default.
  const priceInput = r.container.querySelector('input[id^="price-"]');
  act(() => { changeInput(priceInput, '250'); });
  await act(async () => { await new Promise((res) => setTimeout(res, 10)); });

  await submitOrder(r);

  assert.match(r.text(), /Save as Customer Defaults\?/, 'expected the combined prompt title');
  assert.match(r.text(), /Custom price/);
  assert.match(r.text(), /Delivery fee/);

  const checkboxes = r.all('input[type="checkbox"]');
  assert.equal(checkboxes.length, 2, 'expected one checkbox per eligible kind');
  assert.ok(checkboxes.every((c) => c.checked), 'both kinds must be selected by default');

  const confirmBtn = r.all('button').find((b) => b.textContent.trim() === 'Yes, Save');
  assert.ok(confirmBtn, 'expected the "Yes, Save" confirm button');
  await act(async () => { r.click(confirmBtn); await new Promise((res) => setTimeout(res, 40)); });

  const records = await listRecords();
  const priceRecords = records.filter((rec) => rec.entity_type === 'customer_price');
  const updateRecords = records.filter((rec) => rec.entity_type === 'customer_update');
  assert.equal(priceRecords.length, 1, 'expected one queued customer_price record');
  assert.equal(Number(priceRecords[0].payload.custom_unit_price), 250);
  assert.equal(updateRecords.length, 1, 'expected one queued customer_update record');
  assert.equal(Number(updateRecords[0].payload.delivery_fee), 150);

  r.unmount();
});

test('combined prompt: deselecting the delivery-fee kind queues only the custom price', async () => {
  const r = await open();
  await selectCustomer(r, 'Aling');

  const feeInput = deliveryFeeInput(r);
  act(() => { changeInput(feeInput, '150'); });
  await act(async () => { await new Promise((res) => setTimeout(res, 10)); });

  await addProduct(r);
  const priceInput = r.container.querySelector('input[id^="price-"]');
  act(() => { changeInput(priceInput, '250'); });
  await act(async () => { await new Promise((res) => setTimeout(res, 10)); });

  await submitOrder(r);

  const checkboxes = r.all('input[type="checkbox"]');
  assert.equal(checkboxes.length, 2);
  // Deselect the delivery-fee checkbox (the second section) without touching the price one.
  act(() => { checkboxes[1].click(); });
  await act(async () => { await new Promise((res) => setTimeout(res, 10)); });
  assert.equal(checkboxes[0].checked, true, 'the price kind must remain selected');

  const confirmBtn = r.all('button').find((b) => b.textContent.trim() === 'Yes, Save');
  await act(async () => { r.click(confirmBtn); await new Promise((res) => setTimeout(res, 40)); });

  const records = await listRecords();
  assert.equal(records.filter((rec) => rec.entity_type === 'customer_price').length, 1,
    'the still-selected price kind must still queue');
  assert.equal(records.filter((rec) => rec.entity_type === 'customer_update').length, 0,
    'the deselected delivery-fee kind must not queue');

  r.unmount();
});

test('no prompt when the delivery fee is retyped back to the customer\'s current saved default and no price changed', async () => {
  const r = await open();
  await selectCustomer(r, 'Aling');

  assert.ok(await waitForFeeValue(r, '100'));
  const feeInput = deliveryFeeInput(r);
  // Touch the field but land on the exact same value as the saved default.
  act(() => { changeInput(feeInput, '100'); });
  await act(async () => { await new Promise((res) => setTimeout(res, 10)); });

  await addProductAndSubmit(r); // price left at its auto-priced default, untouched

  assert.doesNotMatch(r.text(), /Save as Customer Defaults\?/,
    'no eligible change means no prompt at all');

  const records = await listRecords();
  assert.equal(records.filter((rec) => rec.entity_type === 'customer_price').length, 0);
  assert.equal(records.filter((rec) => rec.entity_type === 'customer_update').length, 0);

  r.unmount();
});

test('a later order that pre-fills the saved delivery fee, then changed, offers only the delivery-fee section', async () => {
  const r = await open();
  await selectCustomer(r, 'Aling');

  assert.ok(await waitForFeeValue(r, '100'), 'expected pre-fill from the customer\'s saved default');
  const feeInput = deliveryFeeInput(r);
  act(() => { changeInput(feeInput, '175'); });
  await act(async () => { await new Promise((res) => setTimeout(res, 10)); });

  await addProductAndSubmit(r); // price left at its auto-priced default, untouched

  assert.match(r.text(), /Save as Customer Defaults\?/);
  assert.doesNotMatch(r.text(), /Custom price/, 'no price section when no price is dirty');
  assert.match(r.text(), /Delivery fee/);

  const checkboxes = r.all('input[type="checkbox"]');
  assert.equal(checkboxes.length, 1, 'expected exactly one checkbox for the one eligible kind');
  assert.equal(checkboxes[0].checked, true);

  const confirmBtn = r.all('button').find((b) => b.textContent.trim() === 'Yes, Save');
  await act(async () => { r.click(confirmBtn); await new Promise((res) => setTimeout(res, 40)); });

  const records = await listRecords();
  assert.equal(records.filter((rec) => rec.entity_type === 'customer_price').length, 0);
  const updateRecords = records.filter((rec) => rec.entity_type === 'customer_update');
  assert.equal(updateRecords.length, 1);
  assert.equal(Number(updateRecords[0].payload.delivery_fee), 175);

  r.unmount();
});
