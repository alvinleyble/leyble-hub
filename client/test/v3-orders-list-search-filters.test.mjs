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

test('G21: Possible duplicates toggle pill filters to duplicate group and displays badge', async () => {
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
  const badges = r.all('span').filter((s) => s.textContent.includes('possible duplicates'));
  assert.equal(badges.length, 2, 'Should display 2 possible duplicates badges in rows');

  // Toggle "Possible Duplicates"
  const doublePill = r.all('button').find((b) => b.textContent.includes('Possible Duplicates'));
  assert.ok(doublePill, 'Possible Duplicates pill should exist');
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

test('G21: Print status filter (All, Printed, Not Printed) directly on Status column header filters correctly', async () => {
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

  const printSelect = r.byLabel('Filter status by print state');
  assert.ok(printSelect, 'Filter status by print state dropdown should exist in header');

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

test('G22: Drafts tab supports checkboxes and bulk discard via bulk action bar', async () => {
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

  // Checkboxes should be enabled on Drafts tab
  const selectAll = r.byLabel('Select all orders');
  assert.ok(selectAll, 'Select all orders checkbox should be rendered on Drafts tab');

  // Select all drafts
  r.click(selectAll);
  await act(async () => { await new Promise((res) => setTimeout(res, 20)); });

  // Bulk action bar should appear with Discard Selected
  const discardSelectedBtn = r.all('button').find((b) => b.textContent.trim() === 'Discard Selected');
  assert.ok(discardSelectedBtn, 'Discard Selected button should be visible in bulk action bar');

  // Click Discard Selected -> sets confirmation in bulk bar
  r.click(discardSelectedBtn);
  await act(async () => { await new Promise((res) => setTimeout(res, 20)); });

  assert.ok(r.text().includes('Confirm: Discard Selected'));
  assert.ok(r.text().includes('2 selected draft order(s) will be permanently removed'));

  // Cancel via Cancel
  const cancelBtn = r.all('button').find((b) => b.textContent.trim() === 'Cancel');
  assert.ok(cancelBtn, 'Cancel button should exist in bulk confirmation');
  r.click(cancelBtn);
  await act(async () => { await new Promise((res) => setTimeout(res, 20)); });
  assert.equal(deletedIds.length, 0, 'No api.del should have been called on Cancel');

  // Clear selection
  const clearBtn = r.all('button').find((b) => b.textContent.trim() === 'Clear');
  assert.ok(clearBtn, 'Clear button should exist in bulk action bar');
  r.click(clearBtn);
  await act(async () => { await new Promise((res) => setTimeout(res, 20)); });

  // Select first draft checkbox specifically
  const firstDraftCheckbox = r.byLabel('Select order #401');
  assert.ok(firstDraftCheckbox, 'Select order #401 checkbox should exist');
  r.click(firstDraftCheckbox);
  await act(async () => { await new Promise((res) => setTimeout(res, 20)); });

  // Click Discard Selected again
  const discardSelectedBtn2 = r.all('button').find((b) => b.textContent.trim() === 'Discard Selected');
  r.click(discardSelectedBtn2);
  await act(async () => { await new Promise((res) => setTimeout(res, 20)); });

  // Confirm discard
  const confirmBtn = r.all('button').find((b) => b.textContent.trim() === 'Discard Selected');
  r.click(confirmBtn);
  await act(async () => { await new Promise((res) => setTimeout(res, 25)); });

  assert.equal(deletedIds.length, 1);
  assert.ok(deletedIds.includes('/orders/401'));
  assert.ok(r.text().includes('1 draft discarded.'));
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
  r.unmount();
});

test('OrdersPage: displays "Sold by" column header and renders seller name or em-dash fallback', async () => {
  const mockOrders = [
    makeOrder(601, { customer_name: 'Alpha Store', sold_by_name: 'Cashier 1' }),
    makeOrder(602, { customer_name: 'Bravo Shop', sold_by_name: null }),
    makeOrder(603, { customer_name: 'Charlie Market', sold_by_name: '   ' }),
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

  // 1. Column header exists and is positioned between "Customer" and "Total"
  const thElements = r.all('th');
  const thTexts = thElements.map((th) => th.textContent.trim());
  assert.ok(thTexts.includes('Sold by'), `"Sold by" column header should exist: ${thTexts.join(', ')}`);

  const customerIdx = thTexts.indexOf('Customer');
  const soldByIdx = thTexts.indexOf('Sold by');
  const totalIdx = thTexts.indexOf('Total');
  assert.ok(customerIdx !== -1 && soldByIdx !== -1 && totalIdx !== -1, 'Customer, Sold by, Total headers present');
  assert.equal(soldByIdx, customerIdx + 1, 'Sold by should be immediately after Customer');
  assert.equal(totalIdx, soldByIdx + 1, 'Total should be immediately after Sold by');

  // 2. Table rows display seller name when present and em-dash when null or empty
  const tableRows = r.all('table tbody tr');
  assert.equal(tableRows.length, 3);
  assert.ok(tableRows[0].textContent.includes('Cashier 1'), 'Row 1 should display seller name');
  assert.ok(tableRows[1].textContent.includes('—'), 'Row 2 should display em-dash fallback when sold_by_name is null');
  assert.ok(tableRows[2].textContent.includes('—'), 'Row 3 should display em-dash fallback when sold_by_name is whitespace');

  r.unmount();
});

test('G20: OrdersPage instant client-side search matches sold_by_name', async () => {
  const mockOrders = [
    makeOrder(701, { customer_name: 'Alpha Store', sold_by_name: 'Cashier 1' }),
    makeOrder(702, { customer_name: 'Bravo Shop', sold_by_name: 'Manager Luis' }),
    makeOrder(703, { customer_name: 'Charlie Market', sold_by_name: null }),
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
  assert.ok(searchInput, 'Search input should exist');

  // Search by exact seller name
  act(() => {
    changeInput(searchInput, 'Cashier 1');
  });
  await act(async () => { await new Promise((res) => setTimeout(res, 20)); });

  let rows = r.all('tbody tr');
  assert.equal(rows.length, 1);
  assert.ok(r.text().includes('Alpha Store'));
  assert.ok(r.text().includes('Cashier 1'));
  assert.ok(!r.text().includes('Bravo Shop'));

  // Search case-insensitively by partial seller name
  act(() => {
    changeInput(searchInput, 'luis');
  });
  await act(async () => { await new Promise((res) => setTimeout(res, 20)); });

  rows = r.all('tbody tr');
  assert.equal(rows.length, 1);
  assert.ok(r.text().includes('Bravo Shop'));
  assert.ok(r.text().includes('Manager Luis'));
  assert.ok(!r.text().includes('Alpha Store'));

  r.unmount();
});

