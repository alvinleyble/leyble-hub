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

// The receipt as printed: bold on/off toggles dropped so a line reads as one string.
const text = (bytes) => dec(bytes).replace(/\x1BE[\x00\x01]/g, '');

test('receipt: the listed price already holds the deposit — nothing is added at close', () => {
  const withDep = [item({ quantity: 1, unit_price: 100, unit_deposit_fee: 5, units_per_case: 24,
                          requires_bottle_return: true })];
  const pending = text(generateEscPos(baseOrder({ items: withDep, status: 'pending' }), {}, {}));
  assert.equal(pending.includes('Deposit fee'), false);
  assert.ok(pending.includes('TOTAL') && pending.includes('PHP100.00'));

  const done = text(generateEscPos(baseOrder({ items: withDep, status: 'done' }), {}, {}));
  assert.equal(done.includes('Deposit'), false);
  assert.equal(done.includes('Bottles returned'), false);
  assert.match(done, /\nTOTAL +PHP100\.00\n/, 'no bottles back: the same 100 as before closing');
});

// The closing receipt (migration 051): Red Horse Grande 1L at 641 a case, 6 bottles at
// 4.50. A credit line under the product only when bottles come back, nothing else.
const rhGrande = (over = {}) => item({
  id: 7, sku: 'RH Grande 1L', product_name: 'Red Horse Grande 1L', quantity: 1, unit_price: 641,
  unit_deposit_fee: 4.5, units_per_case: 6, requires_bottle_return: true, ...over,
});
const htmlText = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&times;/g, '×').replace(/\s+/g, ' ');

test('closing receipt, all six bottles back: 641.00, then Bottles returned 6 x 4.50 -27.00, TOTAL 614.00', () => {
  const order = baseOrder({ status: 'done', items: [rhGrande({ bottles_returned: 6 })] });
  const escpos = text(generateEscPos(order));
  assert.match(escpos,
    /RH Grande 1L\n  1 cs x PHP641\.00 +PHP641\.00\n  Bottles returned 6 x PHP4\.50 +-PHP27\.00\n/);
  assert.match(escpos, /\nTOTAL +PHP614\.00\n/);
  assert.equal(escpos.split('\n').find((l) => l.includes('Bottles returned')).length, 48,
    'the credit line fills, and fits, the 48-column paper');
  for (const gone of ['Dep:', 'Ret:', 'Net deposit', 'Net credit', 'Deposit fee']) {
    assert.equal(escpos.includes(gone), false, gone);
  }

  const html = htmlText(generateReceiptHtml(order));
  assert.match(html, /1 cs × ₱641\.00 ₱641\.00 Bottles returned 6 × ₱4\.50 -₱27\.00/);
  assert.match(html, /TOTAL ₱614\.00/);
  for (const gone of ['Deposit', 'Returned:', 'Net deposit', 'Net credit']) {
    assert.equal(html.includes(gone), false, gone);
  }
});

test('closing receipt, some bottles back on a multi-line order with delivery fee and adjustment', () => {
  const order = baseOrder({
    status: 'done', delivery_fee_charged: 50, adjustment: -20, adjustment_reason: 'Suki',
    items: [rhGrande({ quantity: 2, bottles_returned: 5 }), item({ id: 8, quantity: 2, unit_price: 300 })],
  });
  const escpos = text(generateEscPos(order));
  assert.match(escpos, /  2 cs x PHP641\.00 +PHP1,282\.00\n  Bottles returned 5 x PHP4\.50 +-PHP22\.50\n/);
  assert.equal(escpos.match(/Bottles returned/g).length, 1, 'only the returnable line gets one');
  // Items is the net of the item lines: 1282 - 22.50 + 600
  assert.match(escpos, /\nItems +PHP1,859\.50\n/);
  assert.match(escpos, /\nDelivery Fee +PHP50\.00\n/);
  assert.match(escpos, /\nFINAL TOTAL +PHP1,889\.50\n/);

  const html = htmlText(generateReceiptHtml(order));
  assert.match(html, /Bottles returned 5 × ₱4\.50 -₱22\.50/);
  assert.match(html, /Items ₱1,859\.50 Delivery Fee ₱50\.00/);
  assert.match(html, /FINAL TOTAL ₱1,889\.50/);
});

test('closing receipt reads the counts being typed on the close form; pending ignores returns', () => {
  const delivered = baseOrder({ status: 'completed', items: [rhGrande()] });
  assert.match(text(generateEscPos(delivered, { 7: '6' })), /\nTOTAL +PHP614\.00\n/);
  assert.match(text(generateEscPos(delivered, { 7: '0' })), /\nTOTAL +PHP641\.00\n/);
  assert.match(htmlText(generateReceiptHtml(delivered, { 7: '3' })), /Bottles returned 3 × ₱4\.50 -₱13\.50.*TOTAL ₱627\.50/);

  const pending = baseOrder({ status: 'pending', items: [rhGrande()] });
  assert.equal(text(generateEscPos(pending, { 7: '6' })).includes('Bottles returned'), false);
  assert.match(text(generateEscPos(pending, { 7: '6' })), /\nTOTAL +PHP641\.00\n/);
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
