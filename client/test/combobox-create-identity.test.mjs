import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, React, act } from './render.mjs';
import { orderCustomerMatches, isExistingOrderCustomer } from '../src/utils/customerSearch.js';

const Combobox = (await import('../src/components/ui/Combobox.jsx')).default;

function createOffered(query, isCreateDuplicate) {
  const r = render(React.createElement(Combobox, {
    items: [{ id: 1, name: 'juan', address: 'brgy dalig' }],
    displayValue: (c) => c.name,
    match: orderCustomerMatches,
    renderRow: (c) => c.name,
    onSelect() {},
    onCreate() {},
    initialQuery: query,
    isCreateDuplicate,
    'aria-label': 'Test picker',
  }));
  try {
    // Invoke the input's real React handler without jsdom's native focus/IE
    // input-event polyfill. Other input tests use this same props-hook technique.
    const input = r.byLabel('Test picker');
    const propsKey = Object.keys(input).find((key) => key.startsWith('__reactProps'));
    act(() => input[propsKey].onFocus({ target: input }));
    return r.all('button').some((b) => b.textContent.includes('Create'));
  } finally {
    r.unmount();
  }
}

test('Combobox keeps its original exact-display-name guard unless a domain identity prop is supplied', () => {
  assert.equal(createOffered(' JUAN '), false);
  assert.equal(createOffered('juan/brgy dalig'), true);
});

test('Combobox uses the optional order-customer identity without suppressing a different note', () => {
  assert.equal(createOffered(' JUAN / BRGY DALIG ', isExistingOrderCustomer), false);
  assert.equal(createOffered('juan/eldo', isExistingOrderCustomer), true);
});
