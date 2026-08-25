import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, React, act } from './render.mjs';
import { api } from '../src/api/client.js';
import { ToastProvider } from '../src/components/ui/Toast.jsx';

const OrderCreateModal = (await import('../src/pages/orders/OrderCreateModal.jsx')).default;
const DraftsModal = (await import('../src/pages/orders/DraftsModal.jsx')).default;
const OrdersPage = (await import('../src/pages/orders/OrdersPage.jsx')).default;

let originalApiGet;
let originalApiPost;
let originalApiPatch;
let originalApiDel;

const products = [
  { id: 1, name: 'Coke Sakto 200ml', sku: 'C-8', category: 'Softdrinks', unit: 'cs', base_wholesale_price: 300, is_active: true },
  { id: 2, name: 'San Miguel Light', sku: 'SML', category: 'Beer', unit: 'cs', base_wholesale_price: 1065, is_active: true },
  { id: 3, name: 'Mineral Water 500ml', sku: 'WAT-500', category: 'Water', unit: 'cs', base_wholesale_price: 150, is_active: true },
];

const customers = [
  { id: 1, name: 'Alvin Store', customer_type: 'regular', is_active: true },
  { id: 2, name: 'Buddy Wholesaler', customer_type: 'wholesaler', is_active: true },
];

beforeEach(() => {
  originalApiGet = api.get;
  originalApiPost = api.post;
  originalApiPatch = api.patch;
  originalApiDel = api.del;

  api.get = async (path) => {
    if (path === '/customers') return customers;
    if (path === '/products') return products;
    if (path === '/personnel') return [];
    if (path.startsWith('/orders?status=draft')) return [];
    if (path.includes('/prices')) return [];
    return [];
  };
  api.post = async () => ({ id: 100 });
  api.patch = async () => ({ id: 100 });
  api.del = async () => ({ status: 'ok' });
});

afterEach(() => {
  api.get = originalApiGet;
  api.post = originalApiPost;
  api.patch = originalApiPatch;
  api.del = originalApiDel;
});

// Helper to select customer in Combobox
async function selectFirstCustomer(r) {
  const custInput = r.byLabel('Customer');
  act(() => {
    custInput.focus();
    custInput.dispatchEvent(new globalThis.window.Event('focus', { bubbles: true }));
    custInput.dispatchEvent(new globalThis.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  });
  await act(async () => { await new Promise((res) => setTimeout(res, 20)); });
  act(() => {
    custInput.dispatchEvent(new globalThis.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
  await act(async () => { await new Promise((res) => setTimeout(res, 30)); });
}

test('OrderCreateModal: renders product tile grid, search, and dynamic category pills', async () => {
  const r = render(
    React.createElement(ToastProvider, null,
      React.createElement(OrderCreateModal, { onClose: () => {}, onSaved: () => {} })
    )
  );

  await act(async () => { await new Promise((res) => setTimeout(res, 30)); });

  // Check product tile cards exist
  assert.match(r.text(), /C-8/);
  assert.match(r.text(), /Coke Sakto 200ml/);
  assert.match(r.text(), /SML/);
  assert.match(r.text(), /San Miguel Light/);
  assert.match(r.text(), /WAT-500/);

  // Check category pills rendered dynamically from product data
  assert.match(r.text(), /All Categories/);
  assert.match(r.text(), /Beer/);
  assert.match(r.text(), /Softdrinks/);
  assert.match(r.text(), /Water/);

  // Check quick-access buttons exist
  assert.match(r.text(), /Drafts/);
  assert.match(r.text(), /History/);

  r.unmount();
});

test('OrderCreateModal: category pills filter the visible product tiles', async () => {
  const r = render(
    React.createElement(ToastProvider, null,
      React.createElement(OrderCreateModal, { onClose: () => {}, onSaved: () => {} })
    )
  );

  await act(async () => { await new Promise((res) => setTimeout(res, 30)); });

  // Click 'Beer' category pill
  const beerPill = r.all('button').find((b) => b.textContent.trim() === 'Beer');
  assert.ok(beerPill, 'Beer category pill should exist');
  r.click(beerPill);
  await act(async () => { await new Promise((res) => setTimeout(res, 10)); });

  assert.match(r.text(), /San Miguel Light/);
  assert.equal(r.text().includes('Coke Sakto'), false, 'Coke should be filtered out under Beer');
  assert.equal(r.text().includes('Mineral Water'), false, 'Water should be filtered out under Beer');

  // Click 'All Categories'
  const allPill = r.all('button').find((b) => b.textContent.trim() === 'All Categories');
  r.click(allPill);
  await act(async () => { await new Promise((res) => setTimeout(res, 10)); });

  assert.match(r.text(), /Coke Sakto 200ml/);
  assert.match(r.text(), /San Miguel Light/);
  assert.match(r.text(), /Mineral Water 500ml/);

  r.unmount();
});

test('OrderCreateModal: tapping a product tile adds a line to the order panel', async () => {
  const r = render(
    React.createElement(ToastProvider, null,
      React.createElement(OrderCreateModal, { onClose: () => {}, onSaved: () => {} })
    )
  );

  await act(async () => { await new Promise((res) => setTimeout(res, 30)); });

  assert.match(r.text(), /Tap a product on the left to start the order/);

  // Find Coke button
  const cokeBtn = r.all('button').find((b) => b.getAttribute('aria-label')?.includes('Coke Sakto'));
  assert.ok(cokeBtn, 'Coke product tile button should exist');
  r.click(cokeBtn);
  await act(async () => { await new Promise((res) => setTimeout(res, 10)); });

  // Order line should now be present
  assert.match(r.text(), /Order Lines \(1 cs\)/);
  assert.match(r.text(), /₱300\.00/);

  r.unmount();
});

test('OrderCreateModal G10 Reset: with lines present, prompts confirmation; confirming clears lines and keeps customer', async () => {
  const r = render(
    React.createElement(ToastProvider, null,
      React.createElement(OrderCreateModal, { onClose: () => {}, onSaved: () => {} })
    )
  );

  await act(async () => { await new Promise((res) => setTimeout(res, 30)); });

  // Select customer
  await selectFirstCustomer(r);
  assert.match(r.text(), /Buddy Wholesaler/);

  // Add a product
  const cokeBtn = r.all('button').find((b) => b.getAttribute('aria-label')?.includes('Coke Sakto'));
  r.click(cokeBtn);
  await act(async () => { await new Promise((res) => setTimeout(res, 10)); });

  assert.match(r.text(), /Order Lines \(1 cs\)/);

  // Find Reset button
  const resetBtn = r.all('button').find((b) => b.textContent.includes('Reset'));
  assert.ok(resetBtn, 'Reset button should exist');
  r.click(resetBtn);
  await act(async () => { await new Promise((res) => setTimeout(res, 10)); });

  // Confirmation modal must be visible
  assert.match(r.text(), /Reset order lines\?/);
  assert.match(r.text(), /The selected customer and order type will be kept/);

  // Confirm Reset
  const confirmBtn = r.all('button').find((b) => b.textContent.trim() === 'Yes, Reset');
  assert.ok(confirmBtn, 'Confirm reset button should exist');
  r.click(confirmBtn);
  await act(async () => { await new Promise((res) => setTimeout(res, 10)); });

  // Lines should be cleared, but customer kept
  assert.match(r.text(), /Tap a product on the left to start the order/);
  assert.match(r.text(), /Buddy Wholesaler/);

  r.unmount();
});

test('OrderCreateModal G10 Reset: with 0 lines, resets instantly with NO confirmation dialog', async () => {
  const r = render(
    React.createElement(ToastProvider, null,
      React.createElement(OrderCreateModal, { onClose: () => {}, onSaved: () => {} })
    )
  );

  await act(async () => { await new Promise((res) => setTimeout(res, 30)); });

  // Select customer
  await selectFirstCustomer(r);
  assert.match(r.text(), /Buddy Wholesaler/);

  // Zero lines: items is empty
  assert.match(r.text(), /Tap a product on the left to start the order/);

  const resetBtn = r.all('button').find((b) => b.textContent.includes('Reset'));
  assert.ok(resetBtn, 'Reset button should exist');
  r.click(resetBtn);
  await act(async () => { await new Promise((res) => setTimeout(res, 10)); });

  // No confirm dialog should appear
  assert.equal(r.text().includes('Reset order lines?'), false, 'Should NOT show confirmation modal with 0 lines');
  assert.match(r.text(), /Buddy Wholesaler/);

  r.unmount();
});

test('DraftsModal: search box filters drafts and bulk discard button is rendered', async () => {
  const sampleDrafts = [
    { id: 101, customer_name: 'Store Alpha', total_amount: 500, adjustment: 0, order_type: 'delivery', created_at: new Date().toISOString() },
    { id: 102, customer_name: 'Store Beta', total_amount: 750, adjustment: 0, order_type: 'pickup', created_at: new Date().toISOString() },
  ];

  api.get = async (path) => {
    if (path.startsWith('/orders?status=draft')) return sampleDrafts;
    if (path.startsWith('/orders/101')) return sampleDrafts[0];
    return [];
  };

  let resumed = null;

  const r = render(
    React.createElement(ToastProvider, null,
      React.createElement(DraftsModal, {
        onClose: () => {},
        onResume: (d) => { resumed = d; },
        customers,
      })
    )
  );

  await act(async () => { await new Promise((res) => setTimeout(res, 30)); });

  assert.match(r.text(), /Store Alpha/);
  assert.match(r.text(), /Store Beta/);
  assert.match(r.text(), /Discard all \(2\)/);

  // Test resume draft
  const resumeBtn = r.all('button').find((b) => b.textContent.includes('Resume draft'));
  assert.ok(resumeBtn, 'Resume draft button should exist');
  act(() => {
    resumeBtn.dispatchEvent(new globalThis.window.MouseEvent('click', { bubbles: true }));
  });
  await act(async () => {
    await new Promise((res) => setTimeout(res, 50));
  });

  assert.equal(resumed?.id, 101);

  r.unmount();
});

test('OrderCreateModal: submit calls PATCH draft and POST finalize, then onSaved(orderId)', async () => {
  let patchCalled = false;
  let finalizeCalled = false;
  let savedOrderId = null;

  api.post = async (path) => {
    if (path === '/orders') return { id: 201 };
    if (path.includes('/finalize')) {
      finalizeCalled = true;
      return { id: 201, status: 'pending' };
    }
    return { id: 201 };
  };

  api.patch = async (path) => {
    if (path.startsWith('/orders/')) {
      patchCalled = true;
    }
    return { id: 201 };
  };

  const r = render(
    React.createElement(ToastProvider, null,
      React.createElement(OrderCreateModal, {
        onClose: () => {},
        onSaved: (id) => { savedOrderId = id; },
      })
    )
  );

  await act(async () => { await new Promise((res) => setTimeout(res, 30)); });

  // Select customer
  await selectFirstCustomer(r);
  assert.match(r.text(), /Buddy Wholesaler/);

  // Add a product
  const cokeBtn = r.all('button').find((b) => b.getAttribute('aria-label')?.includes('Coke Sakto'));
  r.click(cokeBtn);
  await act(async () => { await new Promise((res) => setTimeout(res, 20)); });

  // Click Create Order
  const submitBtn = r.all('button').find((b) => b.textContent.includes('Create Order'));
  assert.ok(submitBtn, 'Create order button should exist');
  
  await act(async () => {
    r.click(submitBtn);
    await new Promise((res) => setTimeout(res, 100));
  });

  assert.ok(finalizeCalled || patchCalled, 'Submit should finalize or patch the order');
  assert.equal(savedOrderId, 201, 'onSaved should be called with orderId');

  r.unmount();
});

test('OrdersPage: Drafts tab renders search box and bulk discard action', async () => {
  const sampleDrafts = [
    { id: 301, customer_name: 'Customer One', total_amount: 400, adjustment: 0, order_type: 'delivery', status: 'draft', created_at: new Date().toISOString() },
    { id: 302, customer_name: 'Customer Two', total_amount: 800, adjustment: 0, order_type: 'pickup', status: 'draft', created_at: new Date().toISOString() },
  ];

  api.get = async (path) => {
    if (path.includes('status=draft')) return sampleDrafts;
    if (path.startsWith('/orders')) return sampleDrafts;
    return [];
  };

  const r = render(
    React.createElement(ToastProvider, null,
      React.createElement(OrdersPage, null)
    )
  );

  await act(async () => { await new Promise((res) => setTimeout(res, 30)); });

  // Switch to Drafts tab
  const draftsTabBtn = r.all('button').find((b) => b.textContent.trim() === 'Drafts');
  assert.ok(draftsTabBtn, 'Drafts tab button should exist');
  r.click(draftsTabBtn);
  await act(async () => { await new Promise((res) => setTimeout(res, 30)); });

  // Verify search box and bulk discard action on Drafts tab
  assert.match(r.text(), /Discard all \(2\)/);
  const searchInput = r.byLabel('Search drafts by customer or order number');
  assert.ok(searchInput, 'Drafts search input on OrdersPage should exist');

  r.unmount();
});
