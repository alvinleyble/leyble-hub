import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, React, act } from './render.mjs';
import { api } from '../src/api/client.js';
import { ToastProvider } from '../src/components/ui/Toast.jsx';

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
