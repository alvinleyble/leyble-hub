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
  const spacerMatch = html.match(/<div class="total-row">[\s\S]*?<\/div>([\s\S]*?)<div class="hr"><\/div>\s*<div class="center thanks">/);
  assert.ok(spacerMatch, 'Total row and hr separator must exist');
  const spacersSection = spacerMatch[1];
  const blankDivCount = (spacersSection.match(/<div>&nbsp;<\/div>/g) || []).length;
  assert.equal(blankDivCount, 6, `Expected exactly 6 spacer divs, found ${blankDivCount}`);
});

test('escposReceipt: contains 6 blank spacer lines underneath Total before the footer', () => {
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
  const footerIndex = text.indexOf('Thank you for your business!');
  assert.ok(footerIndex > totalIndex, 'footer must follow TOTAL in escpos output');
  const dividerIndex = text.indexOf('-'.repeat(48), totalIndex);
  assert.ok(dividerIndex > totalIndex && dividerIndex < footerIndex, 'divider sits between TOTAL and the footer');

  // 1 LF ends the TOTAL line itself, then exactly 6 blank lines before the divider.
  const beforeDivider = text.slice(totalIndex, dividerIndex);
  assert.equal((beforeDivider.match(/\n/g) || []).length, 7, 'TOTAL line + 6 blank lines');
  assert.ok(/\n{6}$/.test(beforeDivider), 'the 6 blank lines are consecutive');
  // ...plus 1 LF for the divider line itself = 8 before the footer starts.
  const between = text.slice(totalIndex, footerIndex);
  assert.equal((between.match(/\n/g) || []).length, 8, 'TOTAL + 6 blanks + divider');
});

const footerOrder = (over = {}) => ({
  id: 1234,
  order_type: 'delivery',
  status: 'pending',
  created_at: new Date('2026-08-21T12:00:00Z').toISOString(),
  customer_name: 'Mang Juan',
  items: [
    { id: 1, sku: 'SMP', product_name: 'Pale Pilsen', unit: 'cs', quantity: 2, unit_price: 600, unit_deposit_fee: 0, units_per_case: 24, bottles_returned: 0 },
  ],
  ...over,
});

const GONE = [
  'TERMS',
  '18% interest per annum',
  "attorney's fee",
  'attorney&#39;s fee',
  'Antipolo City',
  'Received the above merchandise',
  'in good order and condition',
];

test('receipt footer: old terms, "Received..." and the "By:" signature are gone from both receipts', () => {
  for (const order of [footerOrder(), footerOrder({ order_type: 'pickup' })]) {
    const html = generateReceiptHtml(order);
    const escpos = new TextDecoder('latin1').decode(generateEscPos(order));
    for (const [name, out] of [['HTML', html], ['ESC/POS', escpos]]) {
      for (const phrase of GONE) assert.ok(!out.includes(phrase), `${name} (${order.order_type}) must not contain "${phrase}"`);
    }
    // The signature line, not the pickup header's "Received by:" customer line.
    assert.ok(!/>By:</.test(html), 'HTML has no By: signature line');
    assert.ok(!/(^|\n)By: /.test(escpos), 'ESC/POS has no By: signature line');
    assert.ok(!escpos.includes('____'), 'ESC/POS prints no signature underline');
    // Terms used Font B (ESC M 1) and tight line spacing (ESC 3 20); neither is sent any more.
    assert.ok(!escpos.includes('\x1bM\x01'), 'no Font B switch');
    assert.ok(!escpos.includes('\x1b3\x14'), 'no custom line spacing');
  }
  const pickup = generateReceiptHtml(footerOrder({ order_type: 'pickup' }));
  assert.ok(pickup.includes('Received by:'), 'the pickup header customer line stays');
});

test('receipt footer: both receipts end with the single thank-you line', () => {
  const order = footerOrder();
  const html = generateReceiptHtml(order);
  assert.ok(html.includes('Thank you for your business!'));
  assert.ok(!html.includes('Salamat po'), 'HTML has no second footer line');
  assert.ok(html.indexOf('Thank you for your business!') < html.indexOf('</body>'));

  const bytes = generateEscPos(order);
  const text = new TextDecoder('latin1').decode(bytes);
  // Centred (ESC a 1), the one line, back to left (ESC a 0), then the unchanged feed + cut.
  assert.ok(text.includes('\x1ba\x01Thank you for your business!\n\x1ba\x00'), 'centred, then left restored, no blank line after');
  assert.ok(!text.includes('Salamat po'), 'ESC/POS has no second footer line');
  assert.deepEqual(Array.from(bytes.slice(-7)), [0x1B, 0x64, 0x04, 0x1D, 0x56, 0x41, 0x03], 'final feed + partial cut unchanged');
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
