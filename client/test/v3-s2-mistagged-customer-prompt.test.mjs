// The mis-tagged-customer nudge in the New Order modal.
//
// A `regular` customer holding rows in customer_product_prices is a contradiction: under ADR
// 0009 those prices are live regardless of the tag, so the tag is simply wrong about the
// account. The prompt fires on selection and offers to correct it.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, React, act } from './render.mjs';
import { api } from '../src/api/client.js';
import { ToastProvider } from '../src/components/ui/Toast.jsx';

const OrderCreateModal = (await import('../src/pages/orders/OrderCreateModal.jsx')).default;

const products = [
  { id: 1, name: 'Coke Sakto 200ml', sku: 'C-8', category: 'Softdrinks', unit: 'cs', base_wholesale_price: 300, is_active: true },
];

const customers = [
  { id: 1, name: 'Aling Nena', customer_type: 'regular',    is_active: true },
  { id: 2, name: 'Buddy Wholesaler', customer_type: 'wholesaler', is_active: true },
];

const savedPriceRow = { id: 9, product_id: 1, customer_id: 1, custom_unit_price: '280.00', product_name: 'Coke Sakto 200ml', sku: 'C-8' };

let saved;
// `prices` maps '<customerId>:<order_type>' to the rows that endpoint returns.
let priceRows;
let patchCalls;

function installApi() {
  api.get = async (path) => {
    if (path.startsWith('/customers?') || path === '/customers') return customers;
    if (path.startsWith('/products')) return products;
    if (path.startsWith('/personnel')) return [];
    const m = path.match(/^\/customers\/(\d+)\/prices\?order_type=(\w+)$/);
    if (m) return priceRows[`${m[1]}:${m[2]}`] ?? [];
    return [];
  };
  api.post = async () => ({ id: 100 });
  api.patch = async (path, body) => {
    patchCalls.push({ path, body });
    const id = Number(path.split('/')[2]);
    const c = customers.find((x) => x.id === id);
    return { ...c, customer_type: body.customer_type };
  };
  api.del = async () => ({ status: 'ok' });
}

beforeEach(() => {
  saved = { get: api.get, post: api.post, patch: api.patch, del: api.del };
  patchCalls = [];
  priceRows = {};
  installApi();
});

afterEach(() => {
  api.get = saved.get; api.post = saved.post; api.patch = saved.patch; api.del = saved.del;
});

function changeInput(input, value) {
  const descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
  if (descriptor?.set) descriptor.set.call(input, value); else input.value = value;
  const key = Object.keys(input).find((k) => k.startsWith('__reactProps'));
  if (key && input[key]?.onChange) input[key].onChange({ target: { value, type: 'text' } });
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  input.dispatchEvent(new window.Event('change', { bubbles: true }));
}

const settle = (ms = 40) => act(async () => { await new Promise((res) => setTimeout(res, ms)); });

// The first render in a file pays for the JSX transform and react-dom warm-up, so a fixed sleep
// is a race. Poll instead, and keep `settle()` only for asserting that nothing appeared.
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

// Pick from the dropdown by firing the row's own onMouseDown (Combobox.jsx:219) rather than by
// pressing Enter: Enter selects whatever the highlight is on, which is not reliably set until the
// list has rendered, so on a cold first render it silently selects nothing.
async function pickCustomer(r, typed) {
  const input = r.byLabel('Customer');
  act(() => { input.focus(); changeInput(input, typed); });

  let row;
  await waitFor(() => {
    row = r.all('[role="option"] button').find((b) => b.textContent.includes(typed));
    return Boolean(row);
  });
  assert.ok(row, `no dropdown row matched "${typed}"`);
  act(() => { row.dispatchEvent(new globalThis.window.MouseEvent('mousedown', { bubbles: true })); });
  await settle();
}

const promptShown = (r) => r.text().includes('has custom prices');

test('a regular customer with saved prices is flagged on selection', async () => {
  priceRows['1:delivery'] = [savedPriceRow];
  const r = await open();
  await pickCustomer(r, 'Aling');

  assert.ok(await waitFor(() => promptShown(r)), 'the prompt should appear');
  assert.match(r.text(), /Aling Nena/);
  for (const label of ['Markup', 'Discounted', 'Wholesale', 'Skip']) {
    assert.ok(r.all('button').some((b) => b.textContent.trim().startsWith(label)),
      `a ${label} button should be offered`);
  }
  r.unmount();
});

test('the pickup channel counts too — the tag is wrong whichever channel holds the rows', async () => {
  priceRows['1:pickup'] = [savedPriceRow];   // nothing on delivery, which is the order's channel
  const r = await open();
  await pickCustomer(r, 'Aling');

  assert.ok(await waitFor(() => promptShown(r)), 'a pickup-only saved price must still flag the customer');
  r.unmount();
});

test('a regular customer with no saved prices is left alone', async () => {
  const r = await open();
  await pickCustomer(r, 'Aling');
  await settle(120);

  assert.equal(promptShown(r), false);
  r.unmount();
});

test('an already-tagged customer is never nagged, saved prices or not', async () => {
  priceRows['2:delivery'] = [savedPriceRow];
  const r = await open();
  await pickCustomer(r, 'Buddy');
  await settle(120);

  assert.equal(promptShown(r), false, 'wholesaler is already an honest tag');
  r.unmount();
});

test('choosing a tag PATCHes the customer and closes the prompt', async () => {
  priceRows['1:delivery'] = [savedPriceRow];
  const r = await open();
  await pickCustomer(r, 'Aling');

  await waitFor(() => promptShown(r));
  const discounted = r.all('button').find((b) => b.textContent.trim().startsWith('Discounted'));
  r.click(discounted);
  await settle();

  assert.deepEqual(patchCalls, [{ path: '/customers/1', body: { customer_type: 'discounted' } }]);
  assert.equal(promptShown(r), false, 'the prompt closes once the tag is corrected');
  r.unmount();
});

test('Skip dismisses without touching the customer, and re-selecting asks again', async () => {
  priceRows['1:delivery'] = [savedPriceRow];
  const r = await open();
  await pickCustomer(r, 'Aling');

  await waitFor(() => promptShown(r));
  const skip = r.all('button').find((b) => b.textContent.trim() === 'Skip');
  r.click(skip);
  await settle(20);

  assert.equal(promptShown(r), false);
  assert.deepEqual(patchCalls, [], 'Skip must not change the customer');

  // No dismissal memory, by design (captain's instruction): picking them again asks again.
  const clear = r.all('button').find((b) => b.textContent.trim() === 'Clear');
  if (clear) {
    r.click(clear);
    await settle(20);
  }
  await pickCustomer(r, 'Aling');
  assert.ok(await waitFor(() => promptShown(r)), 'selecting the same customer again must nag again');
  r.unmount();
});

test('editing a live order does not nag — the create flow owns this prompt', async () => {
  priceRows['1:delivery'] = [savedPriceRow];
  const editOrder = {
    id: 55, status: 'pending', order_type: 'delivery', customer_id: 1,
    items: [], adjustment: 0, adjustment_reason: '',
  };
  const r = await open({ editOrder });
  await settle(120);

  assert.equal(promptShown(r), false);
  r.unmount();
});
