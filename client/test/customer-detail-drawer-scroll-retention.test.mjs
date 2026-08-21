import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, React, act } from './render.mjs';
import { api } from '../src/api/client.js';
import { ToastProvider } from '../src/components/ui/Toast.jsx';

const CustomerDetailDrawer = (await import('../src/components/customers/CustomerDetailDrawer.jsx')).default;
const CustomerDetailPanel = (await import('../src/pages/customers/CustomerDetailPanel.jsx')).default;

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

test('CustomerDetailDrawer: saving customer edits refreshes silently without unmounting the scroll container', async () => {
  let customerData = {
    id: 10,
    name: 'Aling Nena Store',
    customer_type: 'wholesaler',
    phone: '09112223333',
    address: 'Antipolo City',
    notes: 'Preferred delivery in morning',
    is_active: true,
    orders: [],
  };

  const getCalls = [];
  const patchCalls = [];
  let onSavedCalled = false;

  api.get = async (path) => {
    getCalls.push(path);
    if (path === '/customers/10') return customerData;
    if (path.startsWith('/customers/10/prices')) return [];
    if (path === '/products') return [];
    return [];
  };

  api.patch = async (path, body) => {
    patchCalls.push({ path, body });
    customerData = { ...customerData, ...body };
    return customerData;
  };

  const r = render(
    React.createElement(ToastProvider, null,
      React.createElement(CustomerDetailDrawer, {
        customerId: 10,
        onClose: () => {},
        onSaved: () => { onSavedCalled = true; },
      })
    )
  );

  // Initial load completes
  await act(async () => { await new Promise((res) => setTimeout(res, 30)); });

  // Locate the scrollable container and note its reference
  const scrollContainer = r.container.querySelector('.overflow-y-auto');
  assert.ok(scrollContainer, 'Scrollable container must exist in drawer');

  const nameInput = r.container.querySelector('#cust-name');
  assert.ok(nameInput, 'Name input must exist');
  assert.equal(nameInput.value, 'Aling Nena Store');

  // Edit the name
  await act(async () => {
    changeInput(nameInput, 'Aling Nena Superstore');
  });

  // Click Save Changes
  const saveBtn = r.all('button').find((b) => b.textContent.includes('Save Changes'));
  assert.ok(saveBtn, 'Save Changes button must exist');

  getCalls.length = 0;
  r.click(saveBtn);

  // Wait for PATCH and silent GET to resolve
  await act(async () => { await new Promise((res) => setTimeout(res, 50)); });

  // Verify PATCH was called
  assert.equal(patchCalls.length, 1);
  assert.equal(patchCalls[0].path, '/customers/10');
  assert.equal(patchCalls[0].body.name, 'Aling Nena Superstore');

  // Verify onSaved was called
  assert.equal(onSavedCalled, true, 'onSaved callback must be called');

  // Verify customer was re-fetched in background
  assert.ok(getCalls.includes('/customers/10'), 'Customer must be re-fetched on save');

  // Verify scroll container was NOT unmounted / replaced
  const scrollContainerAfter = r.container.querySelector('.overflow-y-auto');
  assert.equal(
    scrollContainerAfter,
    scrollContainer,
    'Scroll container DOM node must NOT be unmounted or replaced on save'
  );

  // Verify updated data is rendered
  assert.equal(r.container.querySelector('#cust-name').value, 'Aling Nena Superstore');

  r.unmount();
});

test('CustomerDetailDrawer: custom price setting does not unmount drawer or show full-screen spinner', async () => {
  const customerData = {
    id: 10,
    name: 'Aling Nena Store',
    customer_type: 'wholesaler',
    phone: '09112223333',
    address: 'Antipolo City',
    notes: '',
    is_active: true,
    orders: [],
  };

  const productsData = [
    { id: 1, name: 'San Miguel Pale Pilsen', sku: 'SMP-330', unit: 'cs', base_wholesale_price: 600, is_active: true },
  ];

  let customPrices = [];
  const postCalls = [];

  api.get = async (path) => {
    if (path === '/customers/10') return customerData;
    if (path.startsWith('/customers/10/prices')) return customPrices;
    if (path === '/products') return productsData;
    return [];
  };

  api.post = async (path, body) => {
    postCalls.push({ path, body });
    if (path === '/customers/10/prices') {
      const entry = {
        id: 101,
        customer_id: 10,
        product_id: body.product_id,
        product_name: 'San Miguel Pale Pilsen',
        sku: 'SMP-330',
        unit: 'cs',
        custom_unit_price: body.custom_unit_price,
        notes: body.notes,
        order_type: body.order_type,
        created_at: new Date().toISOString(),
      };
      customPrices = [entry];
      return entry;
    }
    return {};
  };

  const r = render(
    React.createElement(ToastProvider, null,
      React.createElement(CustomerDetailDrawer, {
        customerId: 10,
        onClose: () => {},
        onSaved: () => {},
      })
    )
  );

  await act(async () => { await new Promise((res) => setTimeout(res, 30)); });

  const scrollContainer = r.container.querySelector('.overflow-y-auto');
  assert.ok(scrollContainer);

  // Open + Set Price form
  const setPriceBtn = r.all('button').find((b) => b.textContent.includes('+ Set Price'));
  assert.ok(setPriceBtn, '+ Set Price button exists');
  r.click(setPriceBtn);
  await act(async () => { await new Promise((res) => setTimeout(res, 20)); });

  // Select product from combobox
  const productInput = r.container.querySelector('input[placeholder="Search product by name or SKU…"]');
  assert.ok(productInput, 'Product picker input exists');
  await act(async () => {
    changeInput(productInput, 'SMP');
  });

  const optionBtn = r.all('button').find((b) => b.textContent.includes('San Miguel Pale Pilsen'));
  assert.ok(optionBtn, 'Product dropdown option exists');
  r.click(optionBtn);
  await act(async () => { await new Promise((res) => setTimeout(res, 20)); });

  // Custom price input
  const priceInput = r.container.querySelector('#custom-price-input');
  assert.ok(priceInput, 'Custom price input exists');
  await act(async () => {
    changeInput(priceInput, '550');
  });

  // Save Price
  const savePriceBtn = r.all('button').find((b) => b.textContent.includes('Save Price'));
  assert.ok(savePriceBtn, 'Save Price button exists');
  r.click(savePriceBtn);
  await act(async () => { await new Promise((res) => setTimeout(res, 40)); });

  assert.equal(postCalls.length, 1);
  assert.equal(postCalls[0].body.custom_unit_price, 550);

  // Verify scroll container retained
  const scrollContainerAfter = r.container.querySelector('.overflow-y-auto');
  assert.equal(scrollContainerAfter, scrollContainer, 'Scroll container must remain mounted');

  r.unmount();
});

test('CustomerDetailPanel (V1): saving customer edits refreshes silently without unmounting the container', async () => {
  let customerData = {
    id: 5,
    name: 'Tindahan ni Juan',
    customer_type: 'regular',
    phone: '09998887777',
    address: 'Marikina City',
    notes: 'Special discounts on bulk',
    is_active: true,
    orders: [],
  };

  const getCalls = [];
  const patchCalls = [];
  let onSavedCalled = false;

  api.get = async (path) => {
    getCalls.push(path);
    if (path === '/customers/5') return customerData;
    if (path.startsWith('/customers/5/prices')) return [];
    if (path === '/products') return [];
    return [];
  };

  api.patch = async (path, body) => {
    patchCalls.push({ path, body });
    customerData = { ...customerData, ...body };
    return customerData;
  };

  const r = render(
    React.createElement(ToastProvider, null,
      React.createElement(CustomerDetailPanel, {
        customerId: 5,
        onClose: () => {},
        onSaved: () => { onSavedCalled = true; },
      })
    )
  );

  await act(async () => { await new Promise((res) => setTimeout(res, 30)); });

  const scrollContainer = r.container.querySelector('.overflow-y-auto');
  assert.ok(scrollContainer, 'Scrollable container exists');

  const nameInput = r.container.querySelector('input[value="Tindahan ni Juan"]');
  assert.ok(nameInput, 'Name input exists');

  await act(async () => {
    changeInput(nameInput, 'Tindahan ni Juan Updated');
  });

  const saveBtn = r.all('button').find((b) => b.textContent.includes('Save Changes'));
  assert.ok(saveBtn, 'Save Changes button exists');

  getCalls.length = 0;
  r.click(saveBtn);
  await act(async () => { await new Promise((res) => setTimeout(res, 50)); });

  assert.equal(patchCalls.length, 1);
  assert.equal(patchCalls[0].path, '/customers/5');
  assert.equal(patchCalls[0].body.name, 'Tindahan ni Juan Updated');
  assert.equal(onSavedCalled, true);
  assert.ok(getCalls.includes('/customers/5'));

  const scrollContainerAfter = r.container.querySelector('.overflow-y-auto');
  assert.equal(scrollContainerAfter, scrollContainer, 'V1 scroll container must not unmount on save');

  r.unmount();
});
