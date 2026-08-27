import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateReceiptHtml } from '../src/pages/orders/receiptTemplate.js';
import { generateEscPos } from '../src/pages/orders/escposReceipt.js';
import { render, React } from './render.mjs';
import { ToastProvider } from '../src/components/ui/Toast.jsx';

const CustomerCreateModal = (await import('../src/components/customers/CustomerCreateModal.jsx')).default;
const CustomerFormModal   = (await import('../src/pages/customers/CustomerFormModal.jsx')).default;

test('receiptTemplate: contains 6 blank spacer lines underneath Total', () => {
  const mockOrder = {
    id: 1234,
    order_type: 'delivery',
    status: 'pending',
    created_at: new Date('2026-08-21T12:00:00Z').toISOString(),
    customer_name: 'Mang Juan',
    items: [
      { id: 1, sku: 'SMP', product_name: 'Pale Pilsen', unit: 'cs', quantity: 2, unit_price: 600, unit_deposit_fee: 0, units_per_case: 24, bottles_returned: 0 },
    ],
  };

  const html = generateReceiptHtml(mockOrder);
  // Match the spacer lines between total-row and hr
  const spacerMatch = html.match(/<div class="total-row">[\s\S]*?<\/div>([\s\S]*?)<div class="hr"><\/div>\s*<div style="font-size:8px/);
  assert.ok(spacerMatch, 'Total row and hr separator must exist');
  const spacersSection = spacerMatch[1];
  const blankDivCount = (spacersSection.match(/<div>&nbsp;<\/div>/g) || []).length;
  assert.equal(blankDivCount, 6, `Expected exactly 6 spacer divs, found ${blankDivCount}`);
});

test('escposReceipt: contains 6 blank spacer lines underneath Total before terms', () => {
  const mockOrder = {
    id: 1234,
    order_type: 'delivery',
    status: 'pending',
    created_at: new Date('2026-08-21T12:00:00Z').toISOString(),
    customer_name: 'Mang Juan',
    items: [
      { id: 1, sku: 'SMP', product_name: 'Pale Pilsen', unit: 'cs', quantity: 2, unit_price: 600, unit_deposit_fee: 0, units_per_case: 24, bottles_returned: 0 },
    ],
  };

  const bytes = generateEscPos(mockOrder);
  const text = new TextDecoder('latin1').decode(bytes);
  const totalIndex = text.indexOf('TOTAL');
  assert.ok(totalIndex > 0, 'TOTAL must exist in escpos output');
  const termsIndex = text.indexOf('TERMS:');
  assert.ok(termsIndex > totalIndex, 'TERMS must follow TOTAL in escpos output');

  const between = text.slice(totalIndex, termsIndex);
  const lfMatches = between.match(/\n/g) || [];
  // 1 LF for the TOTAL line + 6 LF for the blank lines + 1 LF for the hr dashed line = 8
  assert.equal(lfMatches.length, 8, `Expected 8 LFs between TOTAL and TERMS, got ${lfMatches.length}`);
});

test('CustomerCreateModal: select options have clean single-word labels', () => {
  const r = render(
    React.createElement(ToastProvider, null,
      React.createElement(CustomerCreateModal, { onClose: () => {}, onSaved: () => {} })
    )
  );
  const select = r.container.querySelector('select#cc-type');
  assert.ok(select, 'Customer type select must exist');
  const options = Array.from(select.querySelectorAll('option')).map((o) => o.textContent);
  // ADR 0009 / migration 034: 'Unassigned' is gone, collapsed into 'Regular'.
  assert.deepEqual(options, ['Regular', 'Wholesaler', 'Discounted', 'Markup']);
  r.unmount();
});

test('CustomerFormModal (V1): select options have clean single-word labels', () => {
  const r = render(
    React.createElement(ToastProvider, null,
      React.createElement(CustomerFormModal, { onClose: () => {}, onSaved: () => {} })
    )
  );
  const select = r.container.querySelector('select');
  assert.ok(select, 'Customer type select must exist');
  const options = Array.from(select.querySelectorAll('option')).map((o) => o.textContent);
  // ADR 0009 / migration 034: 'Unassigned' is gone, collapsed into 'Regular'.
  assert.deepEqual(options, ['Regular', 'Wholesaler', 'Discounted', 'Markup']);
  r.unmount();
});
