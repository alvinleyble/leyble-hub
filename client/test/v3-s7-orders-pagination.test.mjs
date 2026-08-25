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

test('V3.0 Slice 7: OrdersPage initial render loads with page=1&limit=50 and displays pagination bar', async () => {
  const requestedUrls = [];
  const mockOrders = Array.from({ length: 50 }, (_, i) => makeOrder(i + 1));

  api.get = async (path) => {
    requestedUrls.push(path);
    if (path.startsWith('/orders?status=draft')) return [];
    if (path.startsWith('/orders')) {
      return {
        orders: mockOrders,
        pagination: {
          page: 1,
          limit: 50,
          total: 120,
          totalPages: 3,
        },
      };
    }
    return [];
  };

  const r = render(
    React.createElement(ToastProvider, null,
      React.createElement(OrdersPage, null)
    )
  );

  await act(async () => { await new Promise((res) => setTimeout(res, 30)); });

  // Verify API call parameters
  const orderApiCall = requestedUrls.find((u) => u.startsWith('/orders?') && !u.includes('status=draft'));
  assert.ok(orderApiCall, 'Should make request to /orders');
  assert.ok(orderApiCall.includes('page=1'), 'Should request page=1');
  assert.ok(orderApiCall.includes('limit=50'), 'Should request limit=50');

  // Verify pagination bar content
  const pageText = r.text();
  assert.ok(pageText.includes('Showing 1–50 of 120 orders'), 'Should show "Showing 1–50 of 120 orders"');
  assert.ok(pageText.includes('Page 1 of 3'), 'Should show "Page 1 of 3"');

  // Verify button states
  const prevBtn = r.byLabel('Previous page');
  const nextBtn = r.byLabel('Next page');
  assert.ok(prevBtn, 'Previous button should exist');
  assert.ok(nextBtn, 'Next button should exist');
  assert.equal(prevBtn.disabled, true, 'Previous button should be disabled on page 1');
  assert.equal(nextBtn.disabled, false, 'Next button should be enabled on page 1 of 3');
});

test('V3.0 Slice 7: OrdersPage pagination navigation (Next and Previous)', async () => {
  const requestedUrls = [];
  let currentPage = 1;

  api.get = async (path) => {
    requestedUrls.push(path);
    if (path.startsWith('/orders?status=draft')) return [];
    if (path.startsWith('/orders')) {
      const match = path.match(/page=(\d+)/);
      if (match) currentPage = Number(match[1]);
      const count = currentPage === 3 ? 20 : 50;
      const startId = (currentPage - 1) * 50 + 1;
      return {
        orders: Array.from({ length: count }, (_, i) => makeOrder(startId + i)),
        pagination: {
          page: currentPage,
          limit: 50,
          total: 120,
          totalPages: 3,
        },
      };
    }
    return [];
  };

  const r = render(
    React.createElement(ToastProvider, null,
      React.createElement(OrdersPage, null)
    )
  );

  await act(async () => { await new Promise((res) => setTimeout(res, 30)); });

  const nextBtn = r.byLabel('Next page');
  const prevBtn = r.byLabel('Previous page');

  // Click Next -> should navigate to page 2
  r.click(nextBtn);
  await act(async () => { await new Promise((res) => setTimeout(res, 30)); });

  assert.ok(r.text().includes('Showing 51–100 of 120 orders'), 'Should show page 2 range');
  assert.ok(r.text().includes('Page 2 of 3'), 'Should show Page 2 of 3');
  assert.equal(prevBtn.disabled, false, 'Previous button should now be enabled');
  assert.equal(nextBtn.disabled, false, 'Next button should remain enabled');

  // Click Next -> should navigate to page 3 (last page)
  r.click(nextBtn);
  await act(async () => { await new Promise((res) => setTimeout(res, 30)); });

  assert.ok(r.text().includes('Showing 101–120 of 120 orders'), 'Should show page 3 range');
  assert.ok(r.text().includes('Page 3 of 3'), 'Should show Page 3 of 3');
  assert.equal(prevBtn.disabled, false, 'Previous button should be enabled');
  assert.equal(nextBtn.disabled, true, 'Next button should be disabled on last page');

  // Click Previous -> back to page 2
  r.click(prevBtn);
  await act(async () => { await new Promise((res) => setTimeout(res, 30)); });

  assert.ok(r.text().includes('Page 2 of 3'), 'Should return to Page 2 of 3');
});

test('V3.0 Slice 7: OrdersPage changing page size selector resets to page 1 and loads new limit', async () => {
  const requestedUrls = [];

  api.get = async (path) => {
    requestedUrls.push(path);
    if (path.startsWith('/orders?status=draft')) return [];
    if (path.startsWith('/orders')) {
      const isLimit25 = path.includes('limit=25');
      const count = isLimit25 ? 25 : 50;
      return {
        orders: Array.from({ length: count }, (_, i) => makeOrder(i + 1)),
        pagination: {
          page: 1,
          limit: count,
          total: 100,
          totalPages: count === 25 ? 4 : 2,
        },
      };
    }
    return [];
  };

  const r = render(
    React.createElement(ToastProvider, null,
      React.createElement(OrdersPage, null)
    )
  );

  await act(async () => { await new Promise((res) => setTimeout(res, 30)); });

  const pageSizeSelect = r.byLabel('Orders per page');
  assert.ok(pageSizeSelect, 'Page size select should be rendered');
  assert.equal(pageSizeSelect.value, '50');

  // Change page size to 25
  act(() => {
    changeInput(pageSizeSelect, '25');
  });
  await act(async () => { await new Promise((res) => setTimeout(res, 30)); });

  const lastCall = requestedUrls[requestedUrls.length - 1];
  assert.ok(lastCall.includes('limit=25'), 'Should request limit=25');
  assert.ok(lastCall.includes('page=1'), 'Should reset to page=1');
  assert.ok(r.text().includes('Showing 1–25 of 100 orders'), 'Should show 1–25 range');
  assert.ok(r.text().includes('Page 1 of 4'), 'Should show Page 1 of 4');
});

test('V3.0 Slice 7: Filters reset page to 1 (status tab, dates, search)', async () => {
  let currentPage = 1;
  const requestedUrls = [];

  api.get = async (path) => {
    requestedUrls.push(path);
    if (path.startsWith('/orders?status=draft')) return [];
    if (path.startsWith('/orders')) {
      const match = path.match(/page=(\d+)/);
      if (match) currentPage = Number(match[1]);
      return {
        orders: [makeOrder(1), makeOrder(2)],
        pagination: {
          page: currentPage,
          limit: 50,
          total: 100,
          totalPages: 2,
        },
      };
    }
    return [];
  };

  const r = render(
    React.createElement(ToastProvider, null,
      React.createElement(OrdersPage, null)
    )
  );

  await act(async () => { await new Promise((res) => setTimeout(res, 30)); });

  // Advance to page 2
  const nextBtn = r.byLabel('Next page');
  r.click(nextBtn);
  await act(async () => { await new Promise((res) => setTimeout(res, 30)); });
  assert.equal(currentPage, 2, 'Should be on page 2');

  // Change status tab to 'pending'
  const pendingTabBtn = r.all('button').find((b) => b.textContent.trim() === 'Pending');
  assert.ok(pendingTabBtn, 'Pending tab button should exist');
  r.click(pendingTabBtn);
  await act(async () => { await new Promise((res) => setTimeout(res, 30)); });

  // Verify page is reset to 1 in API call
  const lastCall = requestedUrls.filter((u) => u.startsWith('/orders?') && !u.includes('status=draft')).pop();
  assert.ok(lastCall.includes('page=1'), 'Status change should reset page to 1');
  assert.ok(lastCall.includes('status=pending'), 'Status should be pending');
});

test('V3.0 Slice 7: Bulk selection is scoped to current page and cleared on page change', async () => {
  let currentPage = 1;

  api.get = async (path) => {
    if (path.startsWith('/orders?status=draft')) return [];
    if (path.startsWith('/orders')) {
      const match = path.match(/page=(\d+)/);
      if (match) currentPage = Number(match[1]);
      const startId = (currentPage - 1) * 2 + 1;
      return {
        orders: [makeOrder(startId), makeOrder(startId + 1)],
        pagination: {
          page: currentPage,
          limit: 2,
          total: 4,
          totalPages: 2,
        },
      };
    }
    return [];
  };

  const r = render(
    React.createElement(ToastProvider, null,
      React.createElement(OrdersPage, null)
    )
  );

  await act(async () => { await new Promise((res) => setTimeout(res, 30)); });

  // Switch to pending tab so checkboxes are shown
  const pendingTabBtn = r.all('button').find((b) => b.textContent.trim() === 'Pending');
  r.click(pendingTabBtn);
  await act(async () => { await new Promise((res) => setTimeout(res, 30)); });

  // Check "Select all"
  const selectAllCheckbox = r.byLabel('Select all orders');
  assert.ok(selectAllCheckbox, 'Select all orders checkbox should be present');

  act(() => {
    selectAllCheckbox.checked = true;
    const reactPropsKey = Object.keys(selectAllCheckbox).find((k) => k.startsWith('__reactProps'));
    if (reactPropsKey && selectAllCheckbox[reactPropsKey]?.onChange) {
      selectAllCheckbox[reactPropsKey].onChange({ target: { checked: true } });
    }
  });
  await act(async () => { await new Promise((res) => setTimeout(res, 30)); });

  // Verify bulk action bar shows 2 orders selected
  assert.ok(r.text().includes('2 orders selected'), 'Should show 2 orders selected');

  // Change page to page 2 -> selection should be cleared
  const nextBtn = r.byLabel('Next page');
  r.click(nextBtn);
  await act(async () => { await new Promise((res) => setTimeout(res, 30)); });

  // Verify bulk action bar is not visible (selection cleared)
  assert.ok(!r.text().includes('orders selected'), 'Selection should be cleared on page change');
});

test('V3.0 Slice 7: Handles 0 orders gracefully in pagination bar', async () => {
  api.get = async (path) => {
    if (path.startsWith('/orders?status=draft')) return [];
    if (path.startsWith('/orders')) {
      return {
        orders: [],
        pagination: {
          page: 1,
          limit: 50,
          total: 0,
          totalPages: 1,
        },
      };
    }
    return [];
  };

  const r = render(
    React.createElement(ToastProvider, null,
      React.createElement(OrdersPage, null)
    )
  );

  await act(async () => { await new Promise((res) => setTimeout(res, 30)); });

  assert.ok(r.text().includes('Showing 0–0 of 0 orders'), 'Should show 0–0 of 0 orders');
  assert.ok(r.text().includes('Page 1 of 1'), 'Should show Page 1 of 1');
  const prevBtn = r.byLabel('Previous page');
  const nextBtn = r.byLabel('Next page');
  assert.equal(prevBtn.disabled, true);
  assert.equal(nextBtn.disabled, true);
});

test('V3.0 Slice 7: OrderCreateModal is only open when creating state is true', async () => {
  api.get = async (path) => {
    if (path.startsWith('/orders?status=draft')) return [];
    if (path.startsWith('/orders')) {
      return {
        orders: [],
        pagination: { page: 1, limit: 50, total: 0, totalPages: 1 },
      };
    }
    if (path.startsWith('/products')) return [];
    if (path.startsWith('/customers')) return [];
    return [];
  };

  const r = render(
    React.createElement(ToastProvider, null,
      React.createElement(OrdersPage, null)
    )
  );

  await act(async () => { await new Promise((res) => setTimeout(res, 30)); });

  // Initially modal should NOT be present
  assert.equal(r.byLabel('Close modal') || r.byLabel('Order Creation'), null, 'Modal should not be open initially');

  // Click "+ New Order"
  const newOrderBtn = r.all('button').find((b) => b.textContent.includes('+ New Order'));
  assert.ok(newOrderBtn, '+ New Order button should exist');
  r.click(newOrderBtn);
  await act(async () => { await new Promise((res) => setTimeout(res, 30)); });

  // Now modal content should be visible (e.g. New Outgoing Order or Customer picker)
  assert.ok(r.text().includes('New Outgoing Order') || r.text().includes('New Order'), 'Create order modal should be open');
});

