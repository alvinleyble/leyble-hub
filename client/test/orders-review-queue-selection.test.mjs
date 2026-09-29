// Orders page: handing a bulk selection to "Review Selected" consumes it. The page stays
// mounted under the full-screen review queue, so the revision bumps from work done INSIDE
// the queue reach the page's orders-changed listener — they must not come back as the
// ADR 0019 "Review changed orders before continuing" freeze once the queue closes. A
// change from elsewhere while the operator is still on the list must freeze as before.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, React, act } from './render.mjs';
import { api } from '../src/api/client.js';
import { ToastProvider } from '../src/components/ui/Toast.jsx';
import { __resetMemoryBackend } from '../src/offline/nativeStore.js';
import { __clearReceipts } from '../src/offline/receiptHistory.js';

const OrdersPage = (await import('../src/pages/orders/OrdersPage.jsx')).default;

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
  status: 'completed',
  order_type: 'delivery',
  customer_id: 7,
  customer_name: 'Aling Nena',
  created_at: '2026-09-09T01:00:00.000Z',
  adjustment: 0,
  adjustment_reason: null,
  total_amount: 300,
  notes: null,
  items: [],
  personnel: [],
  ...overrides,
});

const settle = (ms = 30) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });

const buttons = (r) => [...r.container.querySelectorAll('button')];
const buttonNamed = (r, text) => buttons(r).find((button) => button.textContent.trim() === text);

async function renderWithSelection(status) {
  const rows = [
    order({ id: 41, receipt_number: '1A-00041', revision: '5', status }),
    order({ id: 42, receipt_number: '1A-00042', revision: '8', status }),
  ];
  api.get = async (path) => {
    if (path === '/orders?status=draft') return [];
    if (path.startsWith('/orders?')) {
      return { orders: rows, pagination: { page: 1, limit: 50, total: rows.length, totalPages: 1 } };
    }
    const single = rows.find((row) => path === `/orders/${row.id}`);
    if (single) return single;
    return [];
  };

  const r = render(React.createElement(ToastProvider, null, React.createElement(OrdersPage)));
  await settle();
  r.click(r.container.querySelector(`[data-testid="orders-tab-${status}"]`));
  await settle();
  r.click(r.container.querySelector('[aria-label="Select order #41"]'));
  r.click(r.container.querySelector('[aria-label="Select order #42"]'));
  assert.match(r.text(), /2 orders selected/);
  return r;
}

test('closing a review queue opened from the selection leaves no stale banner and no frozen selection', async () => {
  const r = await renderWithSelection('completed');

  r.click(buttonNamed(r, 'Review Selected'));
  await settle();
  assert.ok(r.container.querySelector('[role="dialog"]'), 'the review queue is open');

  // Closing #41 inside the queue bumps its revision; the 5-second delta poll reports it
  // while the page is still mounted underneath.
  act(() => window.dispatchEvent(new window.CustomEvent('leyble:orders-changed', {
    detail: { ids: [41], orders: [order({ id: 41, receipt_number: '1A-00041', revision: '6', status: 'done' })] },
  })));
  await settle(20);

  const close = buttons(r).find((button) => button.textContent.includes('← Orders'));
  assert.ok(close);
  r.click(close);
  await settle();

  assert.equal(r.container.querySelector('[role="dialog"]'), null, 'the queue closed');
  assert.doesNotMatch(r.text(), /Review changed order/);
  assert.doesNotMatch(r.text(), /unchanged order/);
  assert.doesNotMatch(r.text(), /orders? selected/, 'the selection was handed to the queue');

  // Bulk actions are usable straight away, with no "Clear all" first.
  r.click(r.container.querySelector('[aria-label="Select order #42"]'));
  assert.match(r.text(), /1 order selected/);
  assert.ok(buttonNamed(r, 'Review Selected'), 'bulk action is offered, not blocked');
  r.unmount();
});

test('a revision bump to a selected order while the queue is NOT open still freezes the selection', async () => {
  const r = await renderWithSelection('in_transit');
  assert.ok(buttons(r).some((button) => button.textContent.includes('Mark Delivered')));

  act(() => window.dispatchEvent(new window.CustomEvent('leyble:orders-changed', {
    detail: { ids: [41], orders: [order({ id: 41, receipt_number: '1A-00041', revision: '6', status: 'in_transit' })] },
  })));
  await settle(20);

  assert.match(r.text(), /Review changed order before continuing/);
  assert.match(r.text(), /1 unchanged order remains selected/);
  assert.equal(buttons(r).find((button) => button.textContent.includes('Mark Delivered')), undefined);
  assert.equal(buttonNamed(r, 'Review Selected'), undefined);
  r.unmount();
});
