import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, React, act } from './render.mjs';
import { api } from '../src/api/client.js';
import { ToastProvider } from '../src/components/ui/Toast.jsx';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { __resetMemoryBackend } from '../src/offline/nativeStore.js';
import { __clearReceipts } from '../src/offline/receiptHistory.js';

const OrderDetailPage = (await import('../src/pages/orders/OrderDetailPage.jsx')).default;
const OrdersPage = (await import('../src/pages/orders/OrdersPage.jsx')).default;
const ReviewQueueModal = (await import('../src/pages/orders/ReviewQueueModal.jsx')).default;
const { createRoot } = await import('react-dom/client');

let savedApi;

beforeEach(async () => {
  savedApi = { get: api.get, post: api.post, patch: api.patch };
  await __resetMemoryBackend();
  await __clearReceipts();
});

afterEach(() => Object.assign(api, savedApi));

const order = (overrides = {}) => ({
  id: 42,
  receipt_number: '1A-00042',
  revision: '5',
  status: 'pending',
  order_type: 'delivery',
  customer_id: 7,
  customer_name: 'Aling Nena',
  created_at: '2026-09-09T01:00:00.000Z',
  adjustment: 0,
  adjustment_reason: null,
  total_amount: 300,
  notes: null,
  items: [{
    id: 3, product_id: 9, product_name: 'Coke', sku: 'C-8', category: 'Softdrinks',
    unit: 'cs', quantity: 1, unit_price: 300, unit_deposit_fee: 0,
    units_per_case: 24, bottles_returned: 0, requires_bottle_return: false,
  }],
  personnel: [],
  ...overrides,
});

function renderDetail() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      React.createElement(MemoryRouter, { initialEntries: ['/orders/42'] },
        React.createElement(ToastProvider, null,
          React.createElement(Routes, null,
            React.createElement(Route, { path: '/orders/:id', element: React.createElement(OrderDetailPage) })
          )
        )
      )
    );
  });
  return {
    container,
    text: () => container.textContent,
    button: (text) => [...container.querySelectorAll('button')].find((button) => button.textContent.includes(text)),
    click: (button) => act(() => button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))),
    unmount: () => act(() => root.unmount()),
  };
}

// Controlled-input typing, same idiom as batch-price-sign.test.mjs: React's onChange
// has to be driven directly, since a bare dispatched input event never reaches it.
function changeInput(el, value) {
  const proto = el.tagName === 'TEXTAREA'
    ? window.HTMLTextAreaElement.prototype
    : window.HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
  if (descriptor?.set) descriptor.set.call(el, value); else el.value = value;
  const key = Object.keys(el).find((k) => k.startsWith('__reactProps'));
  if (key && el[key]?.onChange) el[key].onChange({ target: { value } });
  el.dispatchEvent(new window.Event('input', { bubbles: true }));
  el.dispatchEvent(new window.Event('change', { bubbles: true }));
}

function stubReads(initial) {
  api.get = async (path) => {
    if (path === '/orders/42') return initial;
    if (path.startsWith('/products')) return initial.items.map((item) => ({
      id: item.product_id, name: item.product_name, sku: item.sku, category: item.category,
      unit: item.unit, base_wholesale_price: item.unit_price, current_stock: 10,
      units_per_case: item.units_per_case, deposit_fee: 0, is_active: true,
    }));
    if (path.includes('/prices')) return [];
    if (path.startsWith('/customers')) return [{ id: 7, name: 'Aling Nena', customer_type: 'regular', is_active: true }];
    if (path.startsWith('/personnel')) return [];
    return [];
  };
}

test('a non-editing detail adopts a foreground delta immediately without another fetch', async () => {
  const initial = order();
  stubReads(initial);
  let orderReads = 0;
  const get = api.get;
  api.get = async (path) => { if (path === '/orders/42') orderReads += 1; return get(path); };
  const r = renderDetail();
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });

  const current = order({ revision: '6', status: 'in_transit' });
  act(() => window.dispatchEvent(new window.CustomEvent('leyble:orders-changed', {
    detail: { ids: [42], receiptNumbers: ['1A-00042'], orders: [current] },
  })));

  assert.match(r.text(), /In Transit/);
  assert.equal(orderReads, 1, 'the complete delta snapshot redraws in place; no spinner-producing refetch');
  r.unmount();
});

test('a delta never replaces an open edit form and instead shows the stale-edit warning', async () => {
  stubReads(order());
  const r = renderDetail();
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  r.click(r.button('Edit Order'));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });

  act(() => window.dispatchEvent(new window.CustomEvent('leyble:orders-changed', {
    detail: { ids: [42], orders: [order({ revision: '6', status: 'in_transit' })] },
  })));

  assert.match(r.text(), /Your form is unchanged; saving it may be refused/);
  assert.match(r.text(), /Edit Order #42/);
  r.unmount();
});

test('a changed bulk selection stays visible and blocks confirmation until deliberately removed', async () => {
  let serverRows = [
    order({ id: 41, receipt_number: '1A-00041', revision: '5' }),
    order({ id: 42, receipt_number: '1A-00042', revision: '8' }),
  ];
  api.get = async (path) => {
    if (path === '/orders?status=draft') return [];
    if (path.startsWith('/orders?')) {
      return { orders: serverRows, pagination: { page: 1, limit: 50, total: serverRows.length, totalPages: 1 } };
    }
    return [];
  };

  const r = render(React.createElement(ToastProvider, null, React.createElement(OrdersPage)));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
  r.click(r.container.querySelector('[data-testid="orders-tab-pending"]'));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
  r.click(r.container.querySelector('[aria-label="Select order #41"]'));
  r.click(r.container.querySelector('[aria-label="Select order #42"]'));
  assert.match(r.text(), /2 orders selected/);

  const changed = order({ id: 41, receipt_number: '1A-00041', revision: '6', status: 'in_transit' });
  serverRows = [serverRows[1]];
  act(() => window.dispatchEvent(new window.CustomEvent('leyble:orders-changed', {
    detail: { ids: [41], orders: [changed] },
  })));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });

  assert.match(r.text(), /Review changed order before continuing/);
  assert.match(r.text(), /#41 is now In Transit/);
  assert.match(r.text(), /1 unchanged order remains selected/);
  assert.equal(r.button?.('Dispatch Selected'), undefined);

  const remove = [...r.container.querySelectorAll('button')].find((button) => button.textContent.includes('Remove #41'));
  assert.ok(remove);
  r.click(remove);
  assert.match(r.text(), /1 order selected/);
  assert.ok([...r.container.querySelectorAll('button')].some((button) => button.textContent.includes('Dispatch Selected')));
  r.unmount();
});

test('bulk transition commits each order independently and names the exact skipped stale order', async () => {
  const rows = [
    order({ id: 41, receipt_number: '1A-00041', revision: '5' }),
    order({ id: 42, receipt_number: '1A-00042', revision: '8' }),
  ];
  api.get = async (path) => {
    if (path === '/orders?status=draft') return [];
    if (path.startsWith('/orders?')) return { orders: rows, pagination: { page: 1, limit: 50, total: 2, totalPages: 1 } };
    return [];
  };
  const posts = [];
  api.post = async (path, body) => {
    posts.push({ path, body });
    if (path.includes('/42/')) {
      const err = new Error('stale');
      err.status = 409;
      err.data = { code: 'stale_write', order: order({ id: 42, receipt_number: '1A-00042', revision: '9', status: 'in_transit' }) };
      throw err;
    }
    return order({ id: 41, receipt_number: '1A-00041', revision: '6', status: 'in_transit' });
  };

  const r = render(React.createElement(ToastProvider, null, React.createElement(OrdersPage)));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
  r.click(r.container.querySelector('[data-testid="orders-tab-pending"]'));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
  r.click(r.container.querySelector('[aria-label="Select order #41"]'));
  r.click(r.container.querySelector('[aria-label="Select order #42"]'));
  const start = [...r.container.querySelectorAll('button')].find((button) => button.textContent.includes('Dispatch Selected'));
  r.click(start);
  const confirm = [...r.container.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Dispatch Selected');
  r.click(confirm);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 40)); });

  assert.equal(posts.length, 2, 'one stale order never rolls back or prevents its neighbour');
  assert.equal(posts[0].body.revision, '5');
  assert.equal(posts[1].body.revision, '8');
  assert.match(r.text(), /1 of 2 dispatched; 1 skipped: #42 — changed on another device/);
  r.unmount();
});

test('a stale edit sends the revision captured at open, adopts the 409 order, and never retries', async () => {
  stubReads(order());
  const current = order({ revision: '6', status: 'in_transit', notes: 'Changed elsewhere' });
  const patches = [];
  api.patch = async (path, body) => {
    patches.push({ path, body });
    const err = new Error('stale');
    err.status = 409;
    err.data = { code: 'stale_write', order: current };
    throw err;
  };

  const r = renderDetail();
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  r.click(r.button('Edit Order'));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  const save = r.button('Save Changes');
  assert.ok(save);
  r.click(save);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });

  assert.equal(patches.length, 1, 'stale intent is never retried');
  assert.equal(patches[0].body.revision, '5');
  assert.match(r.text(), /Changed elsewhere/);
  assert.match(r.text(), /Your change was not saved/);
  assert.doesNotMatch(r.text(), /Edit Order #42/);
  r.unmount();
});

// ── The delta poller re-delivers this device's OWN writes ────────────────────────
// sync.js's forward delta is "everything changed anywhere (this tablet or another
// one)" — it has no self-origination filter. Every write path here already adopts the
// server's response, so that echo normally arrives at the revision the screen is
// already showing. Only a strictly NEWER revision is somebody else's change.

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });

const adjustable = (overrides = {}) => order({ status: 'completed', ...overrides });

function typeAdjustment(r, amount, reason) {
  act(() => changeInput(r.container.querySelector('input[type="number"]'), amount));
  if (reason !== undefined) act(() => changeInput(r.container.querySelector('textarea'), reason));
}

test('a saved adjustment echoed back by the delta is this device and raises no warning', async () => {
  stubReads(adjustable());
  const saved = adjustable({ revision: '6', adjustment: -50, adjustment_reason: 'Negotiated' });
  const patches = [];
  api.patch = async (path, body) => { patches.push({ path, body }); return saved; };

  const r = renderDetail();
  await settle();
  r.click(r.button('+ Add Adjustment'));
  await settle();
  typeAdjustment(r, '-50', 'Negotiated');
  r.click(r.button('Save Adjustment'));
  await settle();

  assert.deepEqual(patches.map((p) => p.path), ['/orders/42/adjustment']);
  assert.equal(patches[0].body.adjustment, -50);
  assert.match(r.text(), /Adjustment saved/);

  // The next foreground poll returns the order this device just wrote, at the very
  // revision the save already adopted.
  act(() => window.dispatchEvent(new window.CustomEvent('leyble:orders-changed', {
    detail: { ids: [42], receiptNumbers: ['1A-00042'], orders: [saved] },
  })));
  await settle();

  assert.doesNotMatch(r.text(), /changed on another device/);
  r.unmount();
});

test('editing an existing adjustment takes the same path and is likewise silent', async () => {
  stubReads(adjustable({ revision: '6', adjustment: -50, adjustment_reason: 'Negotiated' }));
  const saved = adjustable({ revision: '7', adjustment: -75, adjustment_reason: 'Negotiated more' });
  api.patch = async () => saved;

  const r = renderDetail();
  await settle();
  // A non-zero adjustment auto-expands the panel on load, so this is the same form.
  assert.ok(r.container.querySelector('input[type="number"]'));
  typeAdjustment(r, '-75', 'Negotiated more');
  r.click(r.button('Save Adjustment'));
  await settle();

  act(() => window.dispatchEvent(new window.CustomEvent('leyble:orders-changed', {
    detail: { ids: [42], orders: [saved] },
  })));
  await settle();

  assert.doesNotMatch(r.text(), /changed on another device/);
  r.unmount();
});

test('a strictly newer revision from another device still raises the warning', async () => {
  stubReads(adjustable({ revision: '6', adjustment: -50, adjustment_reason: 'Negotiated' }));
  api.patch = async () => adjustable({ revision: '7', adjustment: -75, adjustment_reason: 'More' });

  const r = renderDetail();
  await settle();
  typeAdjustment(r, '-75', 'More');
  r.click(r.button('Save Adjustment'));
  await settle();

  // Another tablet dispatched it: 8 is newer than the 7 this device holds.
  act(() => window.dispatchEvent(new window.CustomEvent('leyble:orders-changed', {
    detail: { ids: [42], orders: [adjustable({
      revision: '8', status: 'in_transit', adjustment: -75, adjustment_reason: 'More',
    })] },
  })));
  await settle();

  assert.match(r.text(), /This order changed on another device/);
  r.unmount();
});

test('a delta page carrying an OLDER revision is ignored, never adopted backwards', async () => {
  stubReads(adjustable({ revision: '6', adjustment: -50, adjustment_reason: 'Negotiated' }));
  api.patch = async () => adjustable({ revision: '7', adjustment: -75, adjustment_reason: 'More' });

  const r = renderDetail();
  await settle();
  typeAdjustment(r, '-75', 'More');
  r.click(r.button('Save Adjustment'));
  await settle();

  // A page fetched before the save landed. Warning on it would be false, and adopting
  // it would roll the screen back to the pre-save value.
  act(() => window.dispatchEvent(new window.CustomEvent('leyble:orders-changed', {
    detail: { ids: [42], orders: [adjustable({
      revision: '6', adjustment: -50, adjustment_reason: 'Negotiated',
    })] },
  })));
  await settle();

  assert.doesNotMatch(r.text(), /changed on another device/);
  assert.match(r.text(), /75\.00/, 'the newer saved value survives the stale page');
  assert.doesNotMatch(r.text(), /Negotiated$/);
  r.unmount();
});

test('clearing an adjustment to zero collapses the panel and its own echo stays silent', async () => {
  stubReads(adjustable({ revision: '6', adjustment: -50, adjustment_reason: 'Negotiated' }));
  const saved = adjustable({ revision: '7', adjustment: 0, adjustment_reason: null });
  api.patch = async () => saved;

  const r = renderDetail();
  await settle();
  typeAdjustment(r, '0');
  r.click(r.button('Save Adjustment'));
  await settle();

  act(() => window.dispatchEvent(new window.CustomEvent('leyble:orders-changed', {
    detail: { ids: [42], orders: [saved] },
  })));
  await settle();

  assert.doesNotMatch(r.text(), /changed on another device/);
  r.unmount();
});

test('a background drain never discards the adjustment the operator is still typing', async () => {
  stubReads(adjustable());
  let reads = 0;
  const get = api.get;
  api.get = async (path) => { if (path === '/orders/42') reads += 1; return get(path); };

  const r = renderDetail();
  await settle();
  r.click(r.button('+ Add Adjustment'));
  await settle();
  typeAdjustment(r, '-50', 'Negotiated');
  assert.equal(r.container.querySelector('input[type="number"]').value, '-50');

  // drainNotifier fires this whenever ANY outbox record drains — a queued
  // receipt-print, an unrelated order. The re-read it triggers ends in
  // adoptAuthoritativeOrder, which would reset the form from the server row.
  act(() => window.dispatchEvent(new window.CustomEvent('leyble:drain-complete', {
    detail: { sent: 1, waiting: 0 },
  })));
  await settle();

  assert.equal(reads, 1, 'the silent re-read is deferred, not run under the open form');
  const input = r.container.querySelector('input[type="number"]');
  assert.ok(input, 'the adjustment panel is still open');
  assert.equal(input.value, '-50', 'and still holds what the operator typed');

  // Closing the panel is the screen going idle: the deferred re-read runs then.
  r.click(r.button('Cancel'));
  await settle();
  assert.equal(reads, 2, 'the drain re-read is not dropped, only postponed');
  r.unmount();
});

// The review queue holds its own map of orders and gates on its own dirty flags, so
// it needs the same predicate applied to its own loop.
function renderReviewQueue(orderIds = [42]) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      React.createElement(ToastProvider, null,
        React.createElement(ReviewQueueModal, { orderIds, mode: 'pending', onClose: () => {} }))
    );
  });
  return {
    container,
    text: () => container.textContent,
    unmount: () => act(() => root.unmount()),
  };
}

test('the review queue ignores its own echo but still flags a genuinely newer revision', async () => {
  const initial = order({ revision: '5' });
  api.get = async (path) => (path === '/orders/42' ? initial : []);

  const r = renderReviewQueue();
  await settle();
  // Typing in the adjustment field is what makes the queue "dirty" — this is the
  // state in which a delta is held back and announced instead of adopted.
  act(() => changeInput(r.container.querySelector('input[type="number"]'), '-50'));
  await settle();

  act(() => window.dispatchEvent(new window.CustomEvent('leyble:orders-changed', {
    detail: { ids: [42], orders: [order({ revision: '5' })] },
  })));
  await settle();
  assert.doesNotMatch(r.text(), /changed on another device/, 'same revision is this device');

  act(() => window.dispatchEvent(new window.CustomEvent('leyble:orders-changed', {
    detail: { ids: [42], orders: [order({ revision: '6', status: 'in_transit' })] },
  })));
  await settle();
  assert.match(r.text(), /This order changed on another device/, 'a newer revision still warns');
  r.unmount();
});
