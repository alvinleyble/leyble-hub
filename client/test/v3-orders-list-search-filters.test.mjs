import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, React, act } from './render.mjs';
import { api } from '../src/api/client.js';
import { ToastProvider } from '../src/components/ui/Toast.jsx';

const OrdersPage = (await import('../src/pages/orders/OrdersPage.jsx')).default;

let originalApiGet;
let originalApiPost;
let originalApiDel;

beforeEach(() => {
  originalApiGet = api.get;
  originalApiPost = api.post;
  originalApiDel = api.del;
});

afterEach(() => {
  api.get = originalApiGet;
  api.post = originalApiPost;
  api.del = originalApiDel;
});

function changeInput(input, value) {
  const prototype = input.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype
    : input.tagName === 'SELECT' ? window.HTMLSelectElement.prototype
    : window.HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
  if (descriptor?.set) {
    descriptor.set.call(input, value);
  } else {
    input.value = value;
  }
  const reactPropsKey = Object.keys(input).find((k) => k.startsWith('__reactProps'));
  if (reactPropsKey && input[reactPropsKey]?.onChange) {
    input[reactPropsKey].onChange({ target: { value, type: input.type || 'text', checked: input.checked } });
  }
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  input.dispatchEvent(new window.Event('change', { bubbles: true }));
}

const makeOrder = (id, over = {}) => ({
  id,
  customer_id: id,
  status: 'pending',
  order_type: 'delivery',
  customer_name: `Customer ${id}`,
  total_amount: 500,
  adjustment: 0,
  created_at: new Date().toISOString(),
  pending_receipt_printed_at: null,
  delivered_receipt_printed_at: null,
  receipt_number: `1-000${id}`,
  ...over,
});

test('G20: OrdersPage instant client-side search matches customer_name, id, #id, and receipt_number', async () => {
  const mockOrders = [
    makeOrder(101, { customer_name: 'Alpha Beverage', receipt_number: '1-000101' }),
    makeOrder(102, { customer_name: 'Bravo Cantina', receipt_number: '1-000102' }),
    makeOrder(103, { customer_name: 'Charlie Store', receipt_number: '2-000555' }),
  ];

  api.get = async (path) => {
    if (path.startsWith('/orders?status=draft')) return [];
    if (path.startsWith('/orders')) return mockOrders;
    return [];
  };

  const r = render(
    React.createElement(ToastProvider, null,
      React.createElement(OrdersPage, null)
    )
  );

  await act(async () => { await new Promise((res) => setTimeout(res, 25)); });

  const searchInput = r.byLabel('Search orders');
  assert.ok(searchInput, 'Search orders input should be rendered');

  // Initial table rows
  let rows = r.all('tbody tr');
  assert.equal(rows.length, 3, 'Should show all 3 orders initially');

  // Search by customer name
  act(() => {
    changeInput(searchInput, 'Alpha');
  });
  await act(async () => { await new Promise((res) => setTimeout(res, 20)); });
  rows = r.all('tbody tr');
  assert.equal(rows.length, 1);
  assert.ok(r.text().includes('Alpha Beverage'));
  assert.ok(!r.text().includes('Bravo Cantina'));

  // Search by numeric ID
  act(() => {
    changeInput(searchInput, '102');
  });
  await act(async () => { await new Promise((res) => setTimeout(res, 20)); });
  rows = r.all('tbody tr');
  assert.equal(rows.length, 1);
  assert.ok(r.text().includes('Bravo Cantina'));

  // Search with leading '#'
  act(() => {
    changeInput(searchInput, '#103');
  });
  await act(async () => { await new Promise((res) => setTimeout(res, 20)); });
  rows = r.all('tbody tr');
  assert.equal(rows.length, 1);
  assert.ok(r.text().includes('Charlie Store'));

  // Search by receipt number
  act(() => {
    changeInput(searchInput, '2-000555');
  });
  await act(async () => { await new Promise((res) => setTimeout(res, 20)); });
  rows = r.all('tbody tr');
  assert.equal(rows.length, 1);
  assert.ok(r.text().includes('Charlie Store'));

  // Clear search button
  const clearBtn = r.byLabel('Clear search');
  assert.ok(clearBtn, 'Clear search button should exist when query is non-empty');
  r.click(clearBtn);
  await act(async () => { await new Promise((res) => setTimeout(res, 20)); });
  rows = r.all('tbody tr');
  assert.equal(rows.length, 3, 'Should restore all 3 orders after clearing search');
});

test('G21: Possible double toggle pill filters to duplicate group and displays badge', async () => {
  // Orders 201 and 202 share customer_id, order_type, total_amount, adjustment, status=pending, but different receipt_number
  const mockOrders = [
    makeOrder(201, { customer_id: 10, customer_name: 'Twin Store', total_amount: 1200, adjustment: 0, receipt_number: '1-000201' }),
    makeOrder(202, { customer_id: 10, customer_name: 'Twin Store', total_amount: 1200, adjustment: 0, receipt_number: '2-000202' }),
    makeOrder(203, { customer_id: 20, customer_name: 'Unique Store', total_amount: 800, adjustment: 0, receipt_number: '1-000203' }),
  ];

  api.get = async (path) => {
    if (path.startsWith('/orders?status=draft')) return [];
    if (path.startsWith('/orders')) return mockOrders;
    return [];
  };

  const r = render(
    React.createElement(ToastProvider, null,
      React.createElement(OrdersPage, null)
    )
  );

  await act(async () => { await new Promise((res) => setTimeout(res, 25)); });

  // Check that row badge exists on 201 and 202
  const badges = r.all('span').filter((s) => s.textContent.includes('possible double'));
  assert.equal(badges.length, 2, 'Should display 2 possible double badges in rows');

  // Toggle "Possible double only"
  const doublePill = r.all('button').find((b) => b.textContent.includes('Possible double only'));
  assert.ok(doublePill, 'Possible double only pill should exist');
  assert.equal(doublePill.getAttribute('aria-pressed'), 'false');

  r.click(doublePill);
  await act(async () => { await new Promise((res) => setTimeout(res, 20)); });

  assert.equal(doublePill.getAttribute('aria-pressed'), 'true');
  const rows = r.all('tbody tr');
  assert.equal(rows.length, 2, 'Should only show the 2 duplicate orders when toggled');
  assert.ok(!r.text().includes('Unique Store'));

  // Untoggle
  r.click(doublePill);
  await act(async () => { await new Promise((res) => setTimeout(res, 20)); });
  assert.equal(r.all('tbody tr').length, 3, 'Should show all 3 orders after untoggling');
});

test('G21: Print status filter (All, Printed, Not Printed) filters correctly', async () => {
  const mockOrders = [
    makeOrder(301, { status: 'pending', pending_receipt_printed_at: '2026-08-25T10:00:00Z', customer_name: 'Printed Pending' }),
    makeOrder(302, { status: 'pending', pending_receipt_printed_at: null, customer_name: 'Unprinted Pending' }),
    makeOrder(303, { status: 'completed', delivered_receipt_printed_at: '2026-08-25T11:00:00Z', customer_name: 'Printed Delivered' }),
    makeOrder(304, { status: 'completed', delivered_receipt_printed_at: null, customer_name: 'Unprinted Delivered' }),
  ];

  api.get = async (path) => {
    if (path.startsWith('/orders?status=draft')) return [];
    if (path.startsWith('/orders')) return mockOrders;
    return [];
  };

  const r = render(
    React.createElement(ToastProvider, null,
      React.createElement(OrdersPage, null)
    )
  );

  await act(async () => { await new Promise((res) => setTimeout(res, 25)); });

  const printSelect = r.byLabel('Filter by print status');
  assert.ok(printSelect, 'Filter by print status dropdown should exist');

  // Filter: Printed
  act(() => {
    changeInput(printSelect, 'printed');
  });
  await act(async () => { await new Promise((res) => setTimeout(res, 20)); });

  let rows = r.all('tbody tr');
  assert.equal(rows.length, 2);
  assert.ok(r.text().includes('Printed Pending'));
  assert.ok(r.text().includes('Printed Delivered'));
  assert.ok(!r.text().includes('Unprinted Pending'));
  assert.ok(!r.text().includes('Unprinted Delivered'));

  // Filter: Not Printed
  act(() => {
    changeInput(printSelect, 'unprinted');
  });
  await act(async () => { await new Promise((res) => setTimeout(res, 20)); });

  rows = r.all('tbody tr');
  assert.equal(rows.length, 2);
  assert.ok(r.text().includes('Unprinted Pending'));
  assert.ok(r.text().includes('Unprinted Delivered'));
  assert.ok(!r.text().includes('Printed Pending'));
  assert.ok(!r.text().includes('Printed Delivered'));

  // Filter: All
  act(() => {
    changeInput(printSelect, 'all');
  });
  await act(async () => { await new Promise((res) => setTimeout(res, 20)); });

  rows = r.all('tbody tr');
  assert.equal(rows.length, 4);
});

test('G22: Drafts bulk discard-all with modal confirmation and parallel deletion', async () => {
  const mockDrafts = [
    makeOrder(401, { status: 'draft', customer_name: 'Draft One' }),
    makeOrder(402, { status: 'draft', customer_name: 'Draft Two' }),
  ];

  const deletedIds = [];
  api.get = async (path) => {
    if (path.includes('status=draft')) return mockDrafts;
    return [];
  };
  api.del = async (path) => {
    deletedIds.push(path);
    return { ok: true };
  };

  const r = render(
    React.createElement(ToastProvider, null,
      React.createElement(OrdersPage, null)
    )
  );

  await act(async () => { await new Promise((res) => setTimeout(res, 25)); });

  // Switch to Drafts tab
  const draftsTab = r.all('button').find((b) => b.textContent.trim() === 'Drafts');
  assert.ok(draftsTab, 'Drafts tab button should exist');
  r.click(draftsTab);
  await act(async () => { await new Promise((res) => setTimeout(res, 25)); });

  // Discard all button should appear
  const discardAllBtn = r.all('button').find((b) => b.textContent.includes('Discard all (2)'));
  assert.ok(discardAllBtn, 'Discard all (2) button should be visible on Drafts tab');

  // Tap Discard all -> opens modal
  r.click(discardAllBtn);
  await act(async () => { await new Promise((res) => setTimeout(res, 20)); });

  assert.ok(r.text().includes('Discard all 2 drafts?'));
  assert.ok(r.text().includes('All parked drafts will be permanently removed. This cannot be undone.'));

  // Cancel via Keep
  const keepBtn = r.all('button').find((b) => b.textContent.trim() === 'Keep');
  assert.ok(keepBtn, 'Keep button should exist in modal');
  r.click(keepBtn);
  await act(async () => { await new Promise((res) => setTimeout(res, 20)); });
  assert.equal(deletedIds.length, 0, 'No api.del should have been called on Keep');

  // Re-open and confirm Discard all
  const discardAllBtnAgain = r.all('button').find((b) => b.textContent.includes('Discard all (2)'));
  r.click(discardAllBtnAgain);
  await act(async () => { await new Promise((res) => setTimeout(res, 20)); });

  const confirmModalDiscardBtn = r.all('button').find((b) => b.textContent.trim() === 'Discard all');
  assert.ok(confirmModalDiscardBtn, 'Modal Discard all button should exist');
  r.click(confirmModalDiscardBtn);
  await act(async () => { await new Promise((res) => setTimeout(res, 25)); });

  assert.equal(deletedIds.length, 2);
  assert.ok(deletedIds.includes('/orders/401'));
  assert.ok(deletedIds.includes('/orders/402'));
  assert.ok(r.text().includes('All 2 drafts discarded.'));
});

test('G23: Personnel column is removed from table header and rows', async () => {
  const mockOrders = [
    makeOrder(501, { customer_name: 'Test Customer', personnel_summary: 'Driver Dan (Driver)' }),
  ];

  api.get = async (path) => {
    if (path.startsWith('/orders?status=draft')) return [];
    if (path.startsWith('/orders')) return mockOrders;
    return [];
  };

  const r = render(
    React.createElement(ToastProvider, null,
      React.createElement(OrdersPage, null)
    )
  );

  await act(async () => { await new Promise((res) => setTimeout(res, 25)); });

  const thElements = r.all('th');
  const thTexts = thElements.map((th) => th.textContent.trim());
  assert.ok(!thTexts.some((t) => t.includes('Personnel')), `Headers should not contain Personnel: ${thTexts.join(', ')}`);

  // Ensure table body row does not render the personnel summary string
  assert.ok(!r.text().includes('Driver Dan'), 'Table row should not render personnel summary');
});
