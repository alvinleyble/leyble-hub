import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, React, act } from './render.mjs';
import { ToastProvider } from '../src/components/ui/Toast.jsx';

import BatchPriceEditModal, {
  computeUniformPrice as computeV1,
} from '../src/pages/inventory/BatchPriceEditModal.jsx';
import InventoryBatchPriceModal, {
  computeUniformPrice as computeV2,
} from '../src/components/inventory/InventoryBatchPriceModal.jsx';

const SAMPLE_PRODUCTS = [
  { id: 1, name: 'San Miguel Pale Pilsen 330ml', sku: 'SMP-330', base_wholesale_price: '100.00' },
  { id: 2, name: 'Red Horse 500ml', sku: 'RH-500', base_wholesale_price: '50.00' },
];

function changeInput(input, value) {
  const descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
  if (descriptor?.set) descriptor.set.call(input, value); else input.value = value;
  const key = Object.keys(input).find((k) => k.startsWith('__reactProps'));
  if (key && input[key]?.onChange) input[key].onChange({ target: { value } });
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  input.dispatchEvent(new window.Event('change', { bubbles: true }));
}

test('computeUniformPrice (V1 & V2): set mode assigns exact price and clamps negative', () => {
  for (const compute of [computeV1, computeV2]) {
    const resPos = compute(100, 'set', '125.50');
    assert.equal(resPos.clamped, 125.5);
    assert.equal(resPos.wasClamped, false);

    const resNeg = compute(100, 'set', '-10.00');
    assert.equal(resNeg.clamped, 0);
    assert.equal(resNeg.wasClamped, true);

    const resZero = compute(100, 'set', '0');
    assert.equal(resZero.clamped, 0);
    assert.equal(resZero.wasClamped, false);
  }
});

test('computeUniformPrice (V1 & V2): percent adjustment is sign-dependent', () => {
  for (const compute of [computeV1, computeV2]) {
    // Positive percent increases
    const resInc = compute(100, 'percent', '10');
    assert.equal(resInc.clamped, 110);
    assert.equal(resInc.wasClamped, false);

    // Negative percent decreases
    const resDec = compute(100, 'percent', '-10');
    assert.equal(resDec.clamped, 90);
    assert.equal(resDec.wasClamped, false);

    // Extreme negative percent clamps to 0
    const resClamp = compute(100, 'percent', '-150');
    assert.equal(resClamp.clamped, 0);
    assert.equal(resClamp.wasClamped, true);
  }
});

test('computeUniformPrice (V1 & V2): fixed adjustment is sign-dependent', () => {
  for (const compute of [computeV1, computeV2]) {
    // Positive fixed increases
    const resInc = compute(100, 'fixed', '5.25');
    assert.equal(resInc.clamped, 105.25);
    assert.equal(resInc.wasClamped, false);

    // Negative fixed decreases
    const resDec = compute(100, 'fixed', '-5.25');
    assert.equal(resDec.clamped, 94.75);
    assert.equal(resDec.wasClamped, false);

    // Extreme negative fixed clamps to 0
    const resClamp = compute(100, 'fixed', '-120');
    assert.equal(resClamp.clamped, 0);
    assert.equal(resClamp.wasClamped, true);
  }
});

test('computeUniformPrice (V1 & V2): rounding to 2 decimal places', () => {
  for (const compute of [computeV1, computeV2]) {
    // 33.33 * 1.10 = 36.663 -> rounds to 36.66
    const res = compute(33.33, 'percent', '10');
    assert.equal(res.clamped, 36.66);
    assert.equal(res.wasClamped, false);
  }
});

test('BatchPriceEditModal (V1): direction toggle removed, allows negative inputs and updates prices', async () => {
  const view = render(
    React.createElement(ToastProvider, null,
      React.createElement(BatchPriceEditModal, {
        products: SAMPLE_PRODUCTS,
        onClose: () => {},
        onSaved: () => {},
      })
    )
  );

  // Direction toggle (+ Increase / − Decrease) must NOT exist
  assert.equal(document.body.textContent.includes('+ Increase'), false);
  assert.equal(document.body.textContent.includes('− Decrease'), false);
  assert.equal(document.body.textContent.includes('Direction'), false);

  // Default mode is percent
  const input = document.body.querySelector('input[type="number"]');
  assert.ok(input, 'adjustment input exists');
  assert.equal(input.placeholder, 'e.g. 5 or -5');
  assert.equal(input.getAttribute('min'), null, 'no min="0" on percent input');

  // Type negative percent: -10
  await act(async () => {
    changeInput(input, '-10');
  });

  // Table should show ₱90.00 for Product 1 (current 100) and ₱45.00 for Product 2 (current 50)
  assert.ok(document.body.textContent.includes('₱90.00'), 'product 1 decreased to 90');
  assert.ok(document.body.textContent.includes('₱45.00'), 'product 2 decreased to 45');

  // Switch to Fixed
  const fixedBtn = Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent.includes('Fixed'));
  assert.ok(fixedBtn, 'fixed button exists');
  await act(async () => {
    fixedBtn.click();
  });
  assert.equal(input.placeholder, 'e.g. 2.00 or -2.00');
  assert.equal(input.getAttribute('min'), null, 'no min="0" on fixed input');

  // Switch to Set
  const setBtn = Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent.includes('Set to'));
  assert.ok(setBtn, 'set button exists');
  await act(async () => {
    setBtn.click();
  });
  assert.equal(input.placeholder, 'e.g. 2.00');
  assert.equal(input.getAttribute('min'), '0', 'min="0" on set input');

  view.unmount();
});

test('InventoryBatchPriceModal (V2): direction toggle removed, allows negative inputs and updates prices', async () => {
  const view = render(
    React.createElement(ToastProvider, null,
      React.createElement(InventoryBatchPriceModal, {
        products: SAMPLE_PRODUCTS,
        onClose: () => {},
        onSaved: () => {},
      })
    )
  );

  // Direction toggle (+ Increase / − Decrease) must NOT exist
  assert.equal(document.body.textContent.includes('+ Increase'), false);
  assert.equal(document.body.textContent.includes('− Decrease'), false);
  assert.equal(document.body.textContent.includes('Direction'), false);

  // Default mode is percent
  const input = document.body.querySelector('#batch-adj-value');
  assert.ok(input, 'batch-adj-value input exists');
  assert.equal(input.placeholder, 'e.g. 5 or -5');
  assert.equal(input.getAttribute('min'), null, 'no min="0" on percent input');

  // Type negative percent: -20
  await act(async () => {
    changeInput(input, '-20');
  });

  // Table should show ₱80.00 for Product 1 (current 100) and ₱40.00 for Product 2 (current 50)
  assert.ok(document.body.textContent.includes('₱80.00'), 'product 1 decreased to 80');
  assert.ok(document.body.textContent.includes('₱40.00'), 'product 2 decreased to 40');

  // Switch to Fixed
  const fixedBtn = Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent.includes('Fixed'));
  assert.ok(fixedBtn, 'fixed button exists');
  await act(async () => {
    fixedBtn.click();
  });
  assert.equal(input.placeholder, 'e.g. 2.00 or -2.00');
  assert.equal(input.getAttribute('min'), null, 'no min="0" on fixed input');

  // Switch to Set
  const setBtn = Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent.includes('Set to'));
  assert.ok(setBtn, 'set button exists');
  await act(async () => {
    setBtn.click();
  });
  assert.equal(input.placeholder, 'e.g. 2.00');
  assert.equal(input.getAttribute('min'), '0', 'min="0" on set input');

  view.unmount();
});
