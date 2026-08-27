import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, React, act } from './render.mjs';
import { api } from '../src/api/client.js';
import { ToastProvider } from '../src/components/ui/Toast.jsx';
import { __resetMemoryBackend } from '../src/offline/nativeStore.js';
import { ensureStationRegistered, __resetIssuance } from '../src/offline/station.js';
import { __clearOutbox } from '../src/offline/outbox.js';

const OrderCreateModal = (await import('../src/pages/orders/OrderCreateModal.jsx')).default;

let originalApiGet;
let originalApiPost;
let originalApiPatch;
let originalApiDel;
let originalApiRequest;

const products = [
  { id: 1, name: 'Coke Sakto 200ml', sku: 'C-8', category: 'Softdrinks', unit: 'cs', base_wholesale_price: 300, is_active: true },
  { id: 2, name: 'San Miguel Light', sku: 'SML', category: 'Beer', unit: 'cs', base_wholesale_price: 1065, is_active: true },
  { id: 3, name: 'Mineral Water 500ml', sku: 'WAT-500', category: 'Water', unit: 'cs', base_wholesale_price: 150, is_active: true },
];

const customers = [
  { id: 1, name: 'Alvin Store', customer_type: 'regular', is_active: true },
  { id: 2, name: 'Buddy Wholesaler', customer_type: 'wholesaler', is_active: true },
];

beforeEach(async () => {
  originalApiGet = api.get;
  originalApiPost = api.post;
  originalApiPatch = api.patch;
  originalApiDel = api.del;
  originalApiRequest = api.request;

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

  // G27 — the modal's final submit now goes through saveOrderLocalFirst, which
  // needs an active profile and a registered station (D1/D14) exactly like a real
  // signed-in, ProfileGate-passed session would already have by the time this modal
  // can ever mount.
  localStorage.setItem('activeProfile', 'josie');
  await __resetMemoryBackend();
  __resetIssuance();
  await __clearOutbox();
  api.post = async (path) => (path === '/stations/register'
    ? { station_number: 1, registered_at: '2026-08-26T00:00:00.000Z' }
    : { id: 100 });
  await ensureStationRegistered();
});

afterEach(() => {
  api.get = originalApiGet;
  api.post = originalApiPost;
  api.patch = originalApiPatch;
  api.del = originalApiDel;
  api.request = originalApiRequest;
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

// Helper to select customer in Combobox (types to trigger minChars=1 match)
async function selectFirstCustomer(r) {
  const custInput = r.byLabel('Customer');
  act(() => {
    custInput.focus();
    changeInput(custInput, 'Buddy');
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

test('OrderCreateModal: tapping a product tile adds a 0.5cs line to the order panel', async () => {
  const r = render(
    React.createElement(ToastProvider, null,
      React.createElement(OrderCreateModal, { onClose: () => {}, onSaved: () => {} })
    )
  );

  await act(async () => { await new Promise((res) => setTimeout(res, 30)); });

  assert.match(r.text(), /Tap a product on the left to start the order/);

  // Find Coke button (₱300 / cs)
  const cokeBtn = r.all('button').find((b) => b.getAttribute('aria-label')?.includes('Coke Sakto'));
  assert.ok(cokeBtn, 'Coke product tile button should exist');
  r.click(cokeBtn);
  await act(async () => { await new Promise((res) => setTimeout(res, 10)); });

  // Order line should now be present with 0.5 cs default and ₱150.00 total
  assert.match(r.text(), /Items \(0\.5 cs\)/);
  assert.match(r.text(), /₱150\.00/);

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

  assert.match(r.text(), /Items \(0\.5 cs\)/);

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

test('G27: OrderCreateModal submit saves locally first — no PATCH/finalize, onSaved receives the device-issued receipt number', async () => {
  let finalizeCalled = false;
  let deletedDraftPath = null;

  api.post = async (path) => {
    if (path === '/orders') return { id: 201 }; // the early server-side draft on customer-pick
    if (path.includes('/finalize')) { finalizeCalled = true; return { id: 201, status: 'pending' }; }
    return { id: 201 };
  };
  api.patch = async () => { throw new Error('PATCH must not be called — local-first save never round-trips (G27)'); };
  api.del = async (path) => { deletedDraftPath = path; return null; };
  // The background drain attempt inside saveOrderLocalFirst must not affect the
  // assertions below either way — force it to stay offline and queued.
  api.request = async () => { const err = new Error('Failed to fetch'); throw err; };

  let savedOrderId = null;
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

  assert.equal(finalizeCalled, false, 'local-first save must never finalize the early draft — it deletes it instead (G27)');
  assert.match(savedOrderId, /^1-\d{5}$/, 'onSaved must receive the device-issued receipt number (G27), not the draft row id');
  assert.equal(deletedDraftPath, '/orders/201', 'the superseded early draft must be cleaned up (best-effort) once the local-first order is the authority');

  r.unmount();
});

test('OrderCreateModal: Customer Combobox does NOT show dropdown upon focus when empty (minChars=1) and only shows after typing', async () => {
  const r = render(
    React.createElement(ToastProvider, null,
      React.createElement(OrderCreateModal, { onClose: () => {}, onSaved: () => {} })
    )
  );

  await act(async () => { await new Promise((res) => setTimeout(res, 30)); });

  const custInput = r.byLabel('Customer');
  assert.ok(custInput, 'Customer input should exist');

  // Focus the input with empty text
  act(() => {
    custInput.focus();
    custInput.dispatchEvent(new globalThis.window.Event('focus', { bubbles: true }));
  });
  await act(async () => { await new Promise((res) => setTimeout(res, 20)); });

  // Dropdown listbox should NOT be present
  assert.equal(r.all('ul[role="listbox"]').length, 0, 'Dropdown list must NOT render on focus when query is empty');

  // Type 1 character 'A'
  act(() => {
    changeInput(custInput, 'A');
  });
  await act(async () => { await new Promise((res) => setTimeout(res, 20)); });

  // Dropdown listbox should now be visible and display matching customer
  assert.equal(r.all('ul[role="listbox"]').length, 1, 'Dropdown list must render once >= 1 character typed');
  assert.ok(r.text().includes('Alvin Store'));

  r.unmount();
});

test('G27: submitting before the early draft-creation POST resolves still saves instantly (0ms checkout) and cleans the draft up once it does', async () => {
  const postCalls = [];
  const deleteCalls = [];
  let draftResolve;

  // Draft creation intentionally delayed to simulate the race window — local-first
  // save must not wait on it (that is the entire point of G27: no server round trip
  // gates Create Order, even a slow one already in flight).
  api.post = async (path, body) => {
    postCalls.push(path);
    if (path === '/orders' && body?.status === 'draft') {
      await new Promise((res) => { draftResolve = res; });
      return { id: 999 };
    }
    return { id: 999 };
  };
  api.patch = async () => { throw new Error('PATCH must not be called — local-first save never round-trips (G27)'); };
  api.del = async (path) => { deleteCalls.push(path); return null; };
  api.request = async () => { const err = new Error('Failed to fetch'); throw err; };

  let savedOrderId = null;
  const r = render(
    React.createElement(ToastProvider, null,
      React.createElement(OrderCreateModal, {
        onClose: () => {},
        onSaved: (id) => { savedOrderId = id; },
      })
    )
  );

  await act(async () => { await new Promise((res) => setTimeout(res, 30)); });

  // Select customer — triggers the in-flight draft creation (now deliberately delayed)
  await selectFirstCustomer(r);
  await act(async () => { await new Promise((res) => setTimeout(res, 30)); });

  // Add a product
  const cokeBtn = r.all('button').find((b) => b.getAttribute('aria-label')?.includes('Coke Sakto'));
  r.click(cokeBtn);
  await act(async () => { await new Promise((res) => setTimeout(res, 20)); });

  // Click Create Order BEFORE the draft creation resolves — this is the race window
  const submitBtn = r.all('button').find((b) => b.textContent.includes('Create Order'));
  assert.ok(submitBtn, 'Create order button should exist');
  await act(async () => {
    r.click(submitBtn);
    await new Promise((res) => setTimeout(res, 100));
  });

  // The order saved immediately — it did not wait for the still-pending draft POST.
  assert.match(savedOrderId, /^1-\d{5}$/, 'onSaved must fire with the receipt number without waiting on the slow draft creation');

  // Only ONE POST /orders call so far (the still-pending draft); local-first save
  // never issues a second POST /orders of its own.
  assert.equal(postCalls.filter((p) => p === '/orders').length, 1);
  assert.equal(deleteCalls.length, 0, 'nothing to clean up yet — the draft has not resolved to an id');

  // Now resolve the draft creation.
  await act(async () => {
    if (draftResolve) draftResolve();
    await new Promise((res) => setTimeout(res, 30));
  });

  // The now-superseded draft is cleaned up (best-effort, fire-and-forget) once its id
  // is known — never re-POSTed, never PATCHed/finalized.
  assert.deepEqual(deleteCalls, ['/orders/999']);
  assert.equal(postCalls.filter((p) => p === '/orders').length, 1);

  r.unmount();
});
