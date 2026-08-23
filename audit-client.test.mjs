import { test } from 'node:test';
import assert from 'node:assert/strict';

import { round2, roundQty, lineTotal, orderTotals, totalCases }
  from './client/src/components/pos/posMath.js';
import { generateEscPos } from './client/src/pages/orders/escposReceipt.js';
import { generateReceiptHtml } from './client/src/pages/orders/receiptTemplate.js';

const dec = (bytes) => Array.from(bytes).map((b) => String.fromCharCode(b)).join('');

const baseOrder = (over = {}) => ({
  id: 42,
  status: 'pending',
  order_type: 'delivery',
  created_at: '2026-08-20T03:00:00.000Z',
  customer_name: 'Muñoz Sari-Sari Store',
  customer_address: 'Peñafrancia St, Antipolo',
  adjustment: 0,
  adjustment_reason: null,
  notes: null,
  items: [],
  ...over,
});

const item = (over = {}) => ({
  id: 1, product_id: 1, product_name: 'Coke Sakto 200ml', sku: 'C-8',
  unit: 'cs', quantity: 2, unit_price: 250, unit_deposit_fee: 0,
  units_per_case: 24, bottles_returned: 0, requires_bottle_return: false,
  ...over,
});

test('posMath: goods-only totals, 0.5-case aware', () => {
  const items = [item({ quantity: 0.5, unit_price: 199.99 }), item({ id: 2, quantity: 2.5, unit_price: 120 })];
  assert.equal(lineTotal(items[0]), 100);      // 0.5 * 199.99 = 99.995 -> 100.00
  assert.equal(orderTotals(items, -50).goods, 400);
  assert.equal(orderTotals(items, -50).total, 350);
  assert.equal(totalCases(items), 3);
});

test('posMath: deposit is never folded into any figure', () => {
  const items = [item({ quantity: 1, unit_price: 100, unit_deposit_fee: 5, units_per_case: 24 })];
  assert.equal(orderTotals(items, 0).total, 100);   // 24 * 5 deposit deliberately ignored
});

test('posMath: float dust from repeated 0.5 steps stays clean', () => {
  let q = 0;
  for (let i = 0; i < 7; i++) q = roundQty(q + 0.5);
  assert.equal(q, 3.5);
  assert.equal(round2(0.1 + 0.2), 0.3);
});

test('ESC/POS: non-ASCII characters are truncated to a single byte with no code page selected', () => {
  const bytes = generateEscPos(baseOrder({ items: [item()] }), {}, {});
  const text = dec(bytes);
  // No ESC t (0x1B 0x74) code-page selection anywhere in the stream
  assert.equal(text.includes('\x1B\x74'), false, 'expected NO ESC t code-page command');
  // "ñ" (U+00F1) became a bare 0xF1 byte, printer-code-page dependent
  assert.ok(text.includes('Mu\xF1oz'), 'ñ emitted as raw 0xF1');
  // ...and the peso sign is deliberately avoided (fmtMoney uses "PHP")
  assert.ok(text.includes('PHP250.00'));
  assert.equal(text.includes('₱'), false);
});

test('ESC/POS: padLR does not truncate — a long line overflows the 48-char width', () => {
  const long = item({ product_name: 'X'.repeat(60), sku: null, unit: 'cases-of-twentyfour' });
  const text = dec(generateEscPos(baseOrder({ items: [long] }), {}, {}));
  const overflow = text.split('\n').filter((l) => l.length > 48);
  assert.ok(overflow.length > 0, 'expected at least one line wider than 48 chars');
});

test('HTML receipt: a product with no SKU prints a BLANK first line (name is dropped)', () => {
  const html = generateReceiptHtml(baseOrder({ items: [item({ sku: null })] }), {}, {});
  assert.equal(html.includes('Coke Sakto 200ml'), false,
    'HTML receipt never prints the product name');
  assert.ok(html.includes('<div style="font-weight:bold"></div>'),
    'empty bold line where the product identity should be');
});

test('ESC/POS receipt: falls back to the product name when SKU is missing (diverges from HTML)', () => {
  const text = dec(generateEscPos(baseOrder({ items: [item({ sku: null })] }), {}, {}));
  assert.ok(text.includes('Coke Sakto 200ml'));
});

test('receipt: pending receipts are goods-only; deposit only appears at completed/done', () => {
  const withDep = [item({ quantity: 1, unit_price: 100, unit_deposit_fee: 5, units_per_case: 24,
                          requires_bottle_return: true })];
  const pending = dec(generateEscPos(baseOrder({ items: withDep, status: 'pending' }), {}, {}));
  assert.equal(pending.includes('Deposit fee'), false);
  assert.ok(pending.includes('TOTAL') && pending.includes('PHP100.00'));

  const done = dec(generateEscPos(baseOrder({ items: withDep, status: 'done' }), {}, {}));
  assert.ok(done.includes('Deposit fee'));
  assert.ok(done.includes('PHP220.00'), '100 goods + 24*5 deposit = 220');
});

test('receipt: generateEscPos/generateReceiptHtml expose NO overrides.showDeposit escape hatch', () => {
  const withDep = [item({ quantity: 1, unit_price: 100, unit_deposit_fee: 5, units_per_case: 24 })];
  const forced = dec(generateEscPos(baseOrder({ items: withDep, status: 'pending' }), {}, { showDeposit: true }));
  assert.equal(forced.includes('Deposit fee'), false,
    'overrides.showDeposit is documented in CLAUDE.md but is not implemented');
});

// V2.5 D1 — the paper carries the device-issued receipt number once a device is
// issuing them, and the row id (as before) for every order that predates them.
test('receipts print the device-issued receipt number when the order has one', () => {
  const html = generateReceiptHtml(baseOrder({ receipt_number: '2-00042', items: [item()] }));
  assert.match(html, /No: 2-00042/);
  assert.match(html, /<title>Receipt 2-00042<\/title>/);

  const escpos = dec(generateEscPos(baseOrder({ receipt_number: '2-00042', items: [item()] })));
  assert.match(escpos, /No: 2-00042/);
});

test('an order with no receipt number prints its padded row id, exactly as before', () => {
  const html = generateReceiptHtml(baseOrder({ items: [item()] }));
  assert.match(html, /No: 00042/);
  const escpos = dec(generateEscPos(baseOrder({ items: [item()] })));
  assert.match(escpos, /No: 00042/);
});
