// ADR 0017 slice 7 — the human-facing half: what the paper says, and how a customer's
// half-remembered number gets found.
//
// #10  "Sold by" is removed from paper receipts (displayed on-screen instead).
//      Both the HTML receipt and the ESC/POS one omit "Sold by" and always agree.
// #11  Order search accepts BARE DIGITS. `42` returns every order whose SEQUENCE is 42
//      across all prefixes, as a disambiguation list showing customer name and date —
//      customers read digits off faded thermal paper and skip the prefix.
// #12  Never sort by receipt number. The three shapes coexist permanently and do not
//      sort as text; every list orders by time.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, React, act } from './render.mjs';
import { api } from '../src/api/client.js';
import { ToastProvider } from '../src/components/ui/Toast.jsx';
import { generateReceiptHtml } from '../src/pages/orders/receiptTemplate.js';
import { generateEscPos } from '../src/pages/orders/escposReceipt.js';
import { parseBareSequence } from '../src/offline/receiptNumbers.js';
import { orderMatchesSearch } from '../src/utils/orderSearch.js';

import { MemoryRouter, Routes, Route } from 'react-router-dom';

const OrdersPage = (await import('../src/pages/orders/OrdersPage.jsx')).default;
const OrderDetailPage = (await import('../src/pages/orders/OrderDetailPage.jsx')).default;
const ReviewQueueModal = (await import('../src/pages/orders/ReviewQueueModal.jsx')).default;
const { createRoot } = await import('react-dom/client');

let originalApiGet;
beforeEach(() => { originalApiGet = api.get; });
afterEach(() => { api.get = originalApiGet; });

function changeInput(input, value) {
  const descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
  if (descriptor?.set) descriptor.set.call(input, value); else input.value = value;
  const key = Object.keys(input).find((k) => k.startsWith('__reactProps'));
  if (key && input[key]?.onChange) input[key].onChange({ target: { value, type: 'text' } });
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  input.dispatchEvent(new window.Event('change', { bubbles: true }));
}

const decode = (bytes) => String.fromCharCode(...bytes);

const receiptOrder = (over = {}) => ({
  id: 900,
  receipt_number: '3A-00042',
  status: 'pending',
  order_type: 'delivery',
  customer_name: 'Aling Nena Store',
  customer_address: 'Antipolo',
  created_at: '2026-09-01T10:00:00.000Z',
  adjustment: 0,
  adjustment_reason: null,
  items: [{
    id: 1, sku: 'CC-15L', unit: 'cs', quantity: 2, unit_price: 660,
    unit_deposit_fee: 0, units_per_case: 12, bottles_returned: 0,
    requires_bottle_return: false,
  }],
  personnel: [],
  ...over,
});

// ── #10 — paper receipt omits "Sold by" (displayed on-screen instead) ────────

test('#10: the printed HTML receipt does not include Sold by', () => {
  const html = generateReceiptHtml(receiptOrder({ sold_by_name: 'Luis' }));
  assert.ok(!html.includes('Sold by:'), 'the HTML receipt does not carry the seller');
  assert.ok(html.includes('No: 3A-00042'), 'receipt number is still printed');
});

test('#10: the ESC/POS receipt omits Sold by — the two must never disagree', () => {
  const text = decode(generateEscPos(receiptOrder({ sold_by_name: 'Luis' })));
  assert.ok(!text.includes('Sold by:'), 'the ESC/POS receipt does not carry the seller');
  assert.ok(text.includes('No: 3A-00042'), 'receipt number is still printed');
});

test('#10: an order prints no Sold by line regardless of whether seller is present or missing', () => {
  // Every order created before migration 042 — nothing is backfilled (ADR 0017 #12).
  for (const missing of [undefined, null, '', '   ', 'Luis', 'José Ñoño']) {
    const order = receiptOrder({ sold_by_name: missing });
    assert.ok(!generateReceiptHtml(order).includes('Sold by:'), `HTML, sold_by_name=${JSON.stringify(missing)}`);
    assert.ok(!decode(generateEscPos(order)).includes('Sold by:'), `ESC/POS, sold_by_name=${JSON.stringify(missing)}`);
  }
});

test('#10: the ESC/POS output contains only valid ASCII, even with non-ASCII order data', () => {
  const text = decode(generateEscPos(receiptOrder({ sold_by_name: 'José Ñoño' })));
  assert.ok(!text.includes('Sold by:'), 'no Sold by line printed');
  assert.ok(!/[^\x00-\x7F]/.test(text.split('TERMS')[0]), 'no non-ASCII reaches the printer');
});

// ── #11 — bare digits are a sequence ────────────────────────────────────────

test('#11: parseBareSequence takes what a customer reads off the paper, and nothing else', () => {
  assert.equal(parseBareSequence('42'), 42);
  assert.equal(parseBareSequence('00042'), 42, 'leading zeros are the same number');
  assert.equal(parseBareSequence('#1240'), 1240, 'a legacy order is bare digits behind a hash');
  assert.equal(parseBareSequence('1A-00042'), null, 'a full receipt number is not a bare sequence');
  assert.equal(parseBareSequence('Aling Nena'), null);
  assert.equal(parseBareSequence('0'), null);
});

test('#11: orderMatchesSearch matches on SEQUENCE across prefixes, not on substring', () => {
  const numbered = (seq, over = {}) => ({
    id: 500 + seq, customer_name: 'Store', receipt_sequence: seq, ...over,
  });
  assert.equal(orderMatchesSearch(numbered(42, { receipt_number: '1A-00042' }), '42'), true);
  assert.equal(orderMatchesSearch(numbered(42, { receipt_number: '2B-00042' }), '42'), true);
  assert.equal(orderMatchesSearch(numbered(42, { receipt_number: '3-00042' }), '42'), true);
  // The near misses a `%42%` substring match would have dragged in.
  assert.equal(orderMatchesSearch(numbered(420, { receipt_number: '1A-00420' }), '42'), false);
  assert.equal(orderMatchesSearch(numbered(142, { receipt_number: '1A-00142' }), '42'), false);
  // A legacy order has no sequence — its row id is the only number it has.
  assert.equal(orderMatchesSearch({ id: 42, customer_name: 'Old' }, '42'), true);
  // Names still work.
  assert.equal(orderMatchesSearch({ id: 7, customer_name: 'Aling Nena' }, 'nena'), true);
});

test('#11: typing bare digits in Orders returns every series at that sequence, as a list', async () => {
  const mockOrders = [
    { id: 601, customer_name: 'Aling Nena Store', receipt_number: '1A-00042', receipt_sequence: 42,
      status: 'pending', order_type: 'delivery', total_amount: 660, adjustment: 0,
      created_at: '2026-09-01T02:00:00.000Z' },
    { id: 602, customer_name: 'Mang Tonio Sari-Sari', receipt_number: '2B-00042', receipt_sequence: 42,
      status: 'pending', order_type: 'delivery', total_amount: 1320, adjustment: 0,
      created_at: '2026-09-02T03:00:00.000Z' },
    { id: 603, customer_name: 'Aling Nena Store', receipt_number: '3-00042', receipt_sequence: 42,
      status: 'completed', order_type: 'pickup', total_amount: 504, adjustment: 0,
      created_at: '2026-08-20T01:00:00.000Z' },
    // The near miss. A substring search for "42" would have listed this one too.
    { id: 604, customer_name: 'Mang Tonio Sari-Sari', receipt_number: '1A-00420', receipt_sequence: 420,
      status: 'pending', order_type: 'delivery', total_amount: 432, adjustment: 0,
      created_at: '2026-09-03T04:00:00.000Z' },
  ];

  api.get = async (path) => {
    if (path.startsWith('/orders?status=draft')) return [];
    if (path.startsWith('/orders')) return mockOrders;
    return [];
  };

  const r = render(
    React.createElement(ToastProvider, null, React.createElement(OrdersPage, null))
  );
  await act(async () => { await new Promise((res) => setTimeout(res, 25)); });

  const searchInput = r.byLabel('Search orders');
  assert.ok(searchInput);
  assert.equal(r.all('tbody tr').length, 4, 'all four to begin with');

  act(() => { changeInput(searchInput, '42'); });
  await act(async () => { await new Promise((res) => setTimeout(res, 20)); });

  const rows = r.all('tbody tr');
  assert.equal(rows.length, 3, 'the three orders numbered 42, and not 1A-00420');
  // Matched on the ROW, not on the rendered number: `orderRef()` is gated on
  // V25_OFFLINE_CORE, which every test file reads as false (client/test/jsx-register.mjs
  // stubs import.meta.env), so these rows render as `#601` here. The rule under test is
  // which orders survive the filter, and that is what the ids say.
  const ids = rows.map((row) => row.textContent);
  assert.ok(ids.some((t) => t.includes('#601')) && ids.some((t) => t.includes('#602'))
    && ids.some((t) => t.includes('#603')), 'all three series at sequence 42');
  assert.ok(!ids.some((t) => t.includes('#604')), 'the near miss (sequence 420) stays out');
  const text = r.text();

  // A disambiguation list is only useful if it says which is which.
  assert.ok(text.includes('Aling Nena Store') && text.includes('Mang Tonio Sari-Sari'),
    'each row names its customer');
  const hint = r.container.querySelector('[data-testid="orders-sequence-hint"]');
  assert.ok(hint, 'and the page says outright that several orders share this number');
  assert.ok(hint.textContent.includes('3 orders numbered'));

  // Zero-padded is the same number.
  act(() => { changeInput(searchInput, '00042'); });
  await act(async () => { await new Promise((res) => setTimeout(res, 20)); });
  assert.equal(r.all('tbody tr').length, 3);

  // A full receipt number still narrows to the one order it names.
  act(() => { changeInput(searchInput, '2B-00042'); });
  await act(async () => { await new Promise((res) => setTimeout(res, 20)); });
  assert.equal(r.all('tbody tr').length, 1);
  assert.ok(r.text().includes('Mang Tonio Sari-Sari'));
  assert.ok(!r.container.querySelector('[data-testid="orders-sequence-hint"]'),
    'no hint when the term is not a bare sequence');

  r.unmount();
});

// ── #12 — never sort by receipt number ──────────────────────────────────────

test('#12: the list keeps the time order it was given, whatever the numbers sort as', async () => {
  // Deliberately adversarial: newest first by date, but the numbers run the other way
  // and span all three shapes that coexist permanently.
  const mockOrders = [
    { id: 701, customer_name: 'Newest', receipt_number: '1A-00001', receipt_sequence: 1,
      status: 'pending', order_type: 'delivery', total_amount: 100, adjustment: 0,
      created_at: '2026-09-03T00:00:00.000Z' },
    { id: 702, customer_name: 'Middle', receipt_number: '3-00500', receipt_sequence: 500,
      status: 'pending', order_type: 'delivery', total_amount: 100, adjustment: 0,
      created_at: '2026-08-15T00:00:00.000Z' },
    { id: 1240, customer_name: 'Legacy', receipt_number: null,
      status: 'pending', order_type: 'delivery', total_amount: 100, adjustment: 0,
      created_at: '2026-07-01T00:00:00.000Z' },
  ];

  api.get = async (path) => {
    if (path.startsWith('/orders?status=draft')) return [];
    if (path.startsWith('/orders')) return mockOrders;
    return [];
  };

  const r = render(
    React.createElement(ToastProvider, null, React.createElement(OrdersPage, null))
  );
  await act(async () => { await new Promise((res) => setTimeout(res, 25)); });

  const names = r.all('tbody tr').map((row) => row.textContent);
  assert.equal(names.length, 3);
  assert.ok(names[0].includes('Newest'));
  assert.ok(names[1].includes('Middle'));
  assert.ok(names[2].includes('Legacy'));

  r.unmount();
});

// ── On-screen staff attribution (ReviewQueueModal + OrderDetailPage) ───────

function renderWithEntries(element, initialEntries = ['/']) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      React.createElement(MemoryRouter, { initialEntries },
        React.createElement(ToastProvider, null, element)
      )
    );
  });
  return {
    container,
    text: () => container.textContent,
    unmount: () => act(() => { root.unmount(); }),
  };
}

test('#10 on-screen: ReviewQueueModal displays "Sold by: <name>" when present', async () => {
  api.get = async (path) => {
    if (path === '/orders/901') {
      return receiptOrder({ id: 901, sold_by_name: 'Luis' });
    }
    return {};
  };

  const r = render(
    React.createElement(ToastProvider, null,
      React.createElement(ReviewQueueModal, { orderIds: [901], onClose: () => {} })
    )
  );
  await act(async () => { await new Promise((res) => setTimeout(res, 30)); });

  assert.ok(r.text().includes('Sold by: Luis'), 'ReviewQueueModal renders staff attribution');
  r.unmount();
});

test('#10 on-screen: ReviewQueueModal omits "Sold by" when sold_by_name is missing', async () => {
  api.get = async (path) => {
    if (path === '/orders/902') {
      return receiptOrder({ id: 902, sold_by_name: null });
    }
    return {};
  };

  const r = render(
    React.createElement(ToastProvider, null,
      React.createElement(ReviewQueueModal, { orderIds: [902], onClose: () => {} })
    )
  );
  await act(async () => { await new Promise((res) => setTimeout(res, 30)); });

  assert.ok(!r.text().includes('Sold by:'), 'ReviewQueueModal omits staff attribution when absent');
  r.unmount();
});

test('#10 on-screen: OrderDetailPage displays "Sold by: <name>" when present', async () => {
  api.get = async (path) => {
    if (path === '/orders/901') {
      return receiptOrder({ id: 901, sold_by_name: 'Luis' });
    }
    return {};
  };

  const r = renderWithEntries(
    React.createElement(Routes, null,
      React.createElement(Route, { path: '/orders/:id', element: React.createElement(OrderDetailPage) })
    ),
    ['/orders/901']
  );
  await act(async () => { await new Promise((res) => setTimeout(res, 30)); });

  assert.ok(r.text().includes('Sold by: Luis'), 'OrderDetailPage renders staff attribution');
  r.unmount();
});

test('#10 on-screen: OrderDetailPage omits "Sold by" when sold_by_name is missing', async () => {
  api.get = async (path) => {
    if (path === '/orders/902') {
      return receiptOrder({ id: 902, sold_by_name: null });
    }
    return {};
  };

  const r = renderWithEntries(
    React.createElement(Routes, null,
      React.createElement(Route, { path: '/orders/:id', element: React.createElement(OrderDetailPage) })
    ),
    ['/orders/902']
  );
  await act(async () => { await new Promise((res) => setTimeout(res, 30)); });

  assert.ok(!r.text().includes('Sold by:'), 'OrderDetailPage omits staff attribution when absent');
  r.unmount();
});
