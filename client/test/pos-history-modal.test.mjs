import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, React, act } from './render.mjs';
import { api } from '../src/api/client.js';
import { ToastProvider } from '../src/components/ui/Toast.jsx';

const POSHistoryModal = (await import('../src/components/pos/POSHistoryModal.jsx')).default;
const POSPage = (await import('../src/pages/pos/POSPage.jsx')).default;

let originalApiGet;

beforeEach(() => {
  originalApiGet = api.get;
});

afterEach(() => {
  api.get = originalApiGet;
});

const makeOrder = (id, over = {}) => ({
  id,
  status: 'pending',
  order_type: 'delivery',
  customer_name: `Customer ${id}`,
  total_amount: 500,
  adjustment: 0,
  created_at: new Date().toISOString(),
  pending_receipt_printed_at: null,
  ...over,
});

test('F12: POSHistoryModal passes expected from_date/to_date query params when switching date presets', async () => {
  const getCalls = [];
  api.get = async (path) => {
    getCalls.push(path);
    return [];
  };

  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfYesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const startOf7DaysAgo = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6);

  const r = render(
    React.createElement(ToastProvider, null,
      React.createElement(POSHistoryModal, { onClose: () => {} })
    )
  );

  // Initial load (All Time)
  await act(async () => { await new Promise((res) => setTimeout(res, 20)); });
  assert.ok(getCalls.includes('/orders?status=pending'));
  assert.ok(getCalls.includes('/orders?status=cancelled'));

  // Switch to Today
  getCalls.length = 0;
  const todayBtn = r.all('button').find((b) => b.textContent.trim() === 'Today');
  assert.ok(todayBtn, 'Today button should exist');
  r.click(todayBtn);
  await act(async () => { await new Promise((res) => setTimeout(res, 20)); });

  const todayPending = `/orders?status=pending&from_date=${encodeURIComponent(startOfToday.toISOString())}`;
  const todayCancelled = `/orders?status=cancelled&from_date=${encodeURIComponent(startOfToday.toISOString())}`;
  assert.ok(getCalls.includes(todayPending), `Expected call ${todayPending}, got: ${getCalls.join(', ')}`);
  assert.ok(getCalls.includes(todayCancelled), `Expected call ${todayCancelled}, got: ${getCalls.join(', ')}`);

  // Switch to Yesterday
  getCalls.length = 0;
  const yesterdayBtn = r.all('button').find((b) => b.textContent.trim() === 'Yesterday');
  assert.ok(yesterdayBtn, 'Yesterday button should exist');
  r.click(yesterdayBtn);
  await act(async () => { await new Promise((res) => setTimeout(res, 20)); });

  const yestPending = `/orders?status=pending&from_date=${encodeURIComponent(startOfYesterday.toISOString())}&to_date=${encodeURIComponent(startOfToday.toISOString())}`;
  const yestCancelled = `/orders?status=cancelled&from_date=${encodeURIComponent(startOfYesterday.toISOString())}&to_date=${encodeURIComponent(startOfToday.toISOString())}`;
  assert.ok(getCalls.includes(yestPending), `Expected call ${yestPending}, got: ${getCalls.join(', ')}`);
  assert.ok(getCalls.includes(yestCancelled), `Expected call ${yestCancelled}, got: ${getCalls.join(', ')}`);

  // Switch to Last 7 Days
  getCalls.length = 0;
  const weekBtn = r.all('button').find((b) => b.textContent.trim() === 'Last 7 Days');
  assert.ok(weekBtn, 'Last 7 Days button should exist');
  r.click(weekBtn);
  await act(async () => { await new Promise((res) => setTimeout(res, 20)); });

  const weekPending = `/orders?status=pending&from_date=${encodeURIComponent(startOf7DaysAgo.toISOString())}`;
  const weekCancelled = `/orders?status=cancelled&from_date=${encodeURIComponent(startOf7DaysAgo.toISOString())}`;
  assert.ok(getCalls.includes(weekPending), `Expected call ${weekPending}, got: ${getCalls.join(', ')}`);
  assert.ok(getCalls.includes(weekCancelled), `Expected call ${weekCancelled}, got: ${getCalls.join(', ')}`);

  // Switch back to All Time
  getCalls.length = 0;
  const allBtn = r.all('button').find((b) => b.textContent.trim() === 'All Time');
  assert.ok(allBtn, 'All Time button should exist');
  r.click(allBtn);
  await act(async () => { await new Promise((res) => setTimeout(res, 20)); });

  assert.ok(getCalls.includes('/orders?status=pending'));
  assert.ok(getCalls.includes('/orders?status=cancelled'));
  assert.equal(getCalls.some((c) => c.includes('from_date')), false, 'All Time should omit from_date');

  r.unmount();
});

test('F12: 200-row cap warning footnote renders when exactly 200 orders are returned, and is absent when fewer than 200 return', async () => {
  // Case A: exactly 200 orders
  const twoHundredOrders = Array.from({ length: 200 }, (_, i) => makeOrder(i + 1));
  api.get = async (path) => {
    if (path.includes('status=pending')) return twoHundredOrders;
    if (path.includes('status=cancelled')) return [];
    return [];
  };

  const r200 = render(
    React.createElement(ToastProvider, null,
      React.createElement(POSHistoryModal, { onClose: () => {} })
    )
  );
  await act(async () => { await new Promise((res) => setTimeout(res, 20)); });

  assert.match(
    r200.text(),
    /Showing the 200 most recent — narrow the date range or search to see older orders\./,
    'Expected 200-row cap warning footnote to render'
  );
  r200.unmount();

  // Case B: fewer than 200 orders (e.g. 50)
  const fiftyOrders = Array.from({ length: 50 }, (_, i) => makeOrder(i + 1));
  api.get = async (path) => {
    if (path.includes('status=pending')) return fiftyOrders;
    if (path.includes('status=cancelled')) return [];
    return [];
  };

  const r50 = render(
    React.createElement(ToastProvider, null,
      React.createElement(POSHistoryModal, { onClose: () => {} })
    )
  );
  await act(async () => { await new Promise((res) => setTimeout(res, 20)); });

  assert.equal(
    r50.text().includes('Showing the 200 most recent'),
    false,
    '200-row cap warning should NOT render when fewer than 200 orders are returned'
  );
  r50.unmount();
});

test('F2: POSPage header badge reflects all pending unprinted orders and sets updated aria-label', async () => {
  const getCalls = [];
  const pendingOrders = [
    makeOrder(1, { pending_receipt_printed_at: null }),
    makeOrder(2, { pending_receipt_printed_at: null }),
    makeOrder(3, { pending_receipt_printed_at: '2026-08-20T10:00:00.000Z' }), // printed
  ];

  api.get = async (path) => {
    getCalls.push(path);
    if (path === '/products') return [{ id: 1, name: 'Coke', is_active: true, base_wholesale_price: 100 }];
    if (path === '/customers') return [{ id: 1, name: 'Sari-Sari', is_active: true, customer_type: 'regular' }];
    if (path === '/orders?status=draft') return [];
    if (path === '/orders?status=pending') return pendingOrders;
    return [];
  };

  const r = render(
    React.createElement(ToastProvider, null,
      React.createElement(POSPage, null)
    )
  );
  await act(async () => { await new Promise((res) => setTimeout(res, 30)); });

  // Verify GET /orders?status=pending was called without from_date
  assert.ok(getCalls.includes('/orders?status=pending'), 'Must fetch /orders?status=pending without date constraints');
  assert.equal(getCalls.some((c) => c.includes('from_date')), false, 'Must not contain from_date in refreshCounts');

  // Verify History button aria-label reflects all pending unprinted orders (2 unprinted)
  const historyBtn = r.byLabel('History — 2 orders not printed');
  assert.ok(historyBtn, 'History button should have aria-label "History — 2 orders not printed"');
  assert.match(historyBtn.textContent, /2/, 'Badge should show 2');

  r.unmount();
});
