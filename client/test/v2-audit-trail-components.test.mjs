import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, React, act } from './render.mjs';
import { api } from '../src/api/client.js';
import { ToastProvider } from '../src/components/ui/Toast.jsx';

const CustomerDetailDrawer = (await import('../src/components/customers/CustomerDetailDrawer.jsx')).default;
const ProductDetailDrawer = (await import('../src/components/inventory/ProductDetailDrawer.jsx')).default;
const InventoryV2Page = (await import('../src/pages/inventory/InventoryV2Page.jsx')).default;

let originalApiGet, originalApiPatch, originalApiPost, originalApiDel;

beforeEach(() => {
  originalApiGet = api.get;
  originalApiPatch = api.patch;
  originalApiPost = api.post;
  originalApiDel = api.del;
});

afterEach(() => {
  api.get = originalApiGet;
  api.patch = originalApiPatch;
  api.post = originalApiPost;
  api.del = originalApiDel;
});

function changeInput(input, value) {
  const prototype = input.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
  descriptor.set.call(input, value);
  const reactPropsKey = Object.keys(input).find((k) => k.startsWith('__reactProps'));
  if (reactPropsKey && input[reactPropsKey]?.onChange) {
    input[reactPropsKey].onChange({ target: { value, type: input.type || 'text', checked: input.checked } });
  }
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  input.dispatchEvent(new window.Event('change', { bubbles: true }));
}

test('F7: CustomerDetailDrawer switching pricing tabs preserves unsaved form edits and fetches only prices', async () => {
  const getCalls = [];
  api.get = async (path) => {
    getCalls.push(path);
    if (path === '/customers/1') {
      return {
        id: 1,
        name: 'Initial Name',
        customer_type: 'wholesaler',
        phone: '09123456789',
        address: 'Initial Address',
        notes: 'Initial Notes',
        is_active: true,
        orders: [],
      };
    }
    if (path.startsWith('/customers/1/prices')) {
      return [];
    }
    if (path === '/products') {
      return [];
    }
    return [];
  };

  const r = render(
    React.createElement(ToastProvider, null,
      React.createElement(CustomerDetailDrawer, { customerId: 1, onClose: () => {}, onSaved: () => {} })
    )
  );

  await act(async () => { await new Promise((res) => setTimeout(res, 20)); });

  // Modify form inputs
  const nameInput = r.container.querySelector('#cust-name');
  assert.ok(nameInput, 'Name input should exist');
  assert.equal(nameInput.value, 'Initial Name');

  await act(async () => {
    changeInput(nameInput, 'Unsaved Edited Name');
  });

  const notesInput = r.container.querySelector('#cust-notes');
  assert.ok(notesInput, 'Notes input should exist');
  await act(async () => {
    changeInput(notesInput, 'Unsaved Edited Notes');
  });

  // Switch to Pickup Custom Prices tab
  getCalls.length = 0;
  const pickupTabBtn = r.all('button').find((b) => b.textContent.includes('Pickup Custom Prices'));
  assert.ok(pickupTabBtn, 'Pickup custom prices tab button should exist');
  r.click(pickupTabBtn);
  await act(async () => { await new Promise((res) => setTimeout(res, 20)); });

  // Verify only price endpoint was called, NOT full customer reload
  assert.ok(getCalls.includes('/customers/1/prices?order_type=pickup'));
  assert.equal(getCalls.includes('/customers/1'), false, 'Customer details should NOT be re-fetched on tab switch');

  // Verify form input values were NOT wiped / reset
  const nameInputAfter = r.container.querySelector('#cust-name');
  assert.equal(nameInputAfter.value, 'Unsaved Edited Name', 'Form edits must survive tab switch');

  const notesInputAfter = r.container.querySelector('#cust-notes');
  assert.equal(notesInputAfter.value, 'Unsaved Edited Notes', 'Form edits must survive tab switch');

  r.unmount();
});

test('F13: ProductDetailDrawer details form has read-only stock and omits current_stock from save PATCH', async () => {
  api.get = async (path) => {
    if (path === '/products/42') {
      return {
        id: 42,
        name: 'Red Horse 500ml',
        category: 'Beer',
        unit: 'cs',
        sku: 'RH-500',
        base_wholesale_price: 550,
        deposit_fee: 5,
        units_per_case: 24,
        current_stock: 45,
        is_active: true,
        requires_bottle_return: true,
        audit_log: [],
      };
    }
    return {};
  };

  let patchPayload = null;
  api.patch = async (path, body) => {
    patchPayload = body;
    return { id: 42, ...body };
  };

  const r = render(
    React.createElement(ToastProvider, null,
      React.createElement(ProductDetailDrawer, { productId: 42, onClose: () => {}, onSaved: () => {} })
    )
  );

  await act(async () => { await new Promise((res) => setTimeout(res, 20)); });

  const stockInput = r.container.querySelector('#pd-stock');
  assert.ok(stockInput, 'Stock input should exist');
  assert.equal(stockInput.readOnly, true, 'Current stock input must be readOnly');
  assert.ok(stockInput.value.includes('45'), 'Current stock value rendered');

  // Check hint text
  assert.ok(r.text().includes('Adjust Stock & Audit'), 'Subtle hint pointing to Adjust Stock & Audit');

  // Submit Save Changes
  const saveBtn = r.all('button').find((b) => b.textContent.trim() === 'Save Changes');
  assert.ok(saveBtn, 'Save Changes button exists');
  r.click(saveBtn);
  await act(async () => { await new Promise((res) => setTimeout(res, 20)); });

  assert.ok(patchPayload, 'PATCH should have been called');
  assert.equal(patchPayload.current_stock, undefined, 'current_stock must NOT be sent in details PATCH payload');
  assert.equal(patchPayload.name, 'Red Horse 500ml');
  assert.equal(patchPayload.base_wholesale_price, 550);

  r.unmount();
});

test('F13: InventoryV2Page inline price edit and deposit flag toggle send audit reasons', async () => {
  api.get = async (path) => {
    if (path.startsWith('/products')) {
      return [
        {
          id: 10,
          name: 'Coke 1.5L',
          category: 'Soft Drinks',
          unit: 'cs',
          sku: 'CK-15',
          base_wholesale_price: 400,
          deposit_fee: 0,
          units_per_case: 12,
          current_stock: 50,
          is_active: true,
          requires_bottle_return: false,
        },
      ];
    }
    return [];
  };

  const patchCalls = [];
  api.patch = async (path, body) => {
    patchCalls.push({ path, body });
    return { id: 10, ...body };
  };

  const r = render(
    React.createElement(ToastProvider, null,
      React.createElement(InventoryV2Page, null)
    )
  );

  await act(async () => { await new Promise((res) => setTimeout(res, 20)); });

  // 1. Inline price edit
  const priceInput = r.container.querySelector('input[aria-label="Price per case for Coke 1.5L"]');
  assert.ok(priceInput, 'Inline price input exists');

  await act(async () => {
    changeInput(priceInput, '425');
  });
  await act(async () => {
    const reactPropsKey = Object.keys(priceInput).find((k) => k.startsWith('__reactProps'));
    if (reactPropsKey && priceInput[reactPropsKey]?.onBlur) {
      priceInput[reactPropsKey].onBlur({ currentTarget: priceInput, target: priceInput });
    }
    priceInput.dispatchEvent(new window.FocusEvent('blur', { bubbles: true }));
    priceInput.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true }));
  });
  await act(async () => { await new Promise((res) => setTimeout(res, 30)); });

  const pricePatch = patchCalls.find((c) => c.body.base_wholesale_price !== undefined);
  assert.ok(pricePatch, 'Price PATCH should be dispatched');
  assert.equal(pricePatch.body.base_wholesale_price, 425);
  assert.equal(pricePatch.body.reason, 'Inline price edit (Inventory)');

  // 2. Deposit flag toggle
  const depToggleBtn = r.all('button').find((b) => b.textContent.includes('w/o dep'));
  assert.ok(depToggleBtn, 'Deposit toggle button exists');

  r.click(depToggleBtn);
  await act(async () => { await new Promise((res) => setTimeout(res, 20)); });

  const depPatch = patchCalls.find((c) => c.body.requires_bottle_return !== undefined);
  assert.ok(depPatch, 'Deposit flag PATCH should be dispatched');
  assert.equal(depPatch.body.requires_bottle_return, true);
  assert.equal(depPatch.body.reason, 'Deposit flag toggled (Inventory)');

  r.unmount();
});
