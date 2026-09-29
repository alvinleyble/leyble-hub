// The shared pieces behind docs/design/design-standard.md: the one status/stock badge
// vocabulary (Q5) and the one money formatter (Q15). Before these existed the Dashboard
// carried its own status map with Pending and In Transit swapped (UI audit F3) and
// Tickets printed a negative as "₱-135.00" (F19).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ORDER_STATUS, orderStatusBadge, orderStatusLabel, ticketStatusBadge, tagBadge,
  stockState, stockBadge, LOW_STOCK_THRESHOLD,
} from '../src/utils/statusBadges.js';
import { formatPeso, formatSignedPeso, PHP } from '../src/utils/money.js';

// ── Q5: status and stock badges ───────────────────────────────────────────────

test('every order status has the one word and colour the whole app uses', () => {
  const expected = {
    draft:      ['Draft', 'violet'],
    pending:    ['Pending', 'blue'],
    in_transit: ['In Transit', 'amber'],
    completed:  ['Delivered', 'green'],
    done:       ['Closed', 'slate'],
    cancelled:  ['Cancelled', 'red'],
  };
  for (const [status, [label, colour]] of Object.entries(expected)) {
    const b = orderStatusBadge(status);
    assert.equal(b.label, label, `${status} reads "${label}"`);
    assert.match(b.className, new RegExp(`bg-${colour}-100`), `${status} is ${colour}`);
    assert.match(b.className, new RegExp(`text-${colour}-\\d00`), `${status} text is ${colour}`);
  }
  assert.deepEqual(Object.keys(ORDER_STATUS).sort(), Object.keys(expected).sort());
});

test('Pending is blue and In Transit amber — the Dashboard no longer disagrees (F3)', () => {
  assert.match(orderStatusBadge('pending').className, /bg-blue-100/);
  assert.match(orderStatusBadge('in_transit').className, /bg-amber-100/);
  assert.equal(orderStatusLabel('completed'), 'Delivered', 'never "Completed"');
  assert.equal(orderStatusLabel('done'), 'Closed', 'never "Done"');
});

test('an unknown status still gets its own word and a neutral colour, never nothing', () => {
  const b = orderStatusBadge('mystery');
  assert.equal(b.label, 'mystery');
  assert.match(b.className, /bg-slate-100/);
  assert.equal(orderStatusBadge(undefined).label, '');
});

test('a ticket that is still open is Pending in the same blue as an order', () => {
  assert.deepEqual(ticketStatusBadge('pending'), orderStatusBadge('pending'));
  assert.equal(ticketStatusBadge('resolved').label, 'Resolved');
  assert.match(ticketStatusBadge('resolved').className, /bg-green-100/);
});

test('stock state: out at zero or below, low up to the threshold, nothing otherwise', () => {
  assert.equal(LOW_STOCK_THRESHOLD, 10);
  assert.equal(stockState(0), 'out');
  assert.equal(stockState(-2), 'out');
  assert.equal(stockState('0.00'), 'out', 'NUMERIC columns arrive as strings');
  assert.equal(stockState(0.5), 'low');
  assert.equal(stockState(10), 'low');
  assert.equal(stockState('10.00'), 'low');
  assert.equal(stockState(10.5), null);
  assert.equal(stockState(77), null);
  assert.equal(stockState(null), 'out', 'Number(null) is 0 — an unknown count is not treated as healthy');
  assert.equal(stockState(undefined), null);
  assert.equal(stockState('abc'), null);
});

test('a stock state is always a word, never just a colour', () => {
  assert.deepEqual(
    { label: stockBadge(0).label, red: /bg-red-100/.test(stockBadge(0).className) },
    { label: 'Out of stock', red: true },
  );
  assert.equal(stockBadge(4).label, 'Low stock');
  assert.match(stockBadge(4).className, /bg-amber-100/);
  assert.equal(stockBadge(50), null, 'ordinary stock carries no badge (Q6)');
});

test('tag badges carry their word', () => {
  assert.equal(tagBadge('printed').label, 'Printed');
  assert.equal(tagBadge('unsynced').label, 'Waiting to sync');
  assert.equal(tagBadge('duplicate').label, 'Possible duplicate');
  assert.equal(tagBadge('pickup').label, 'Pickup');
  assert.equal(tagBadge('inactive').label, 'Inactive');
});

// ── Q15: money ────────────────────────────────────────────────────────────────

test('formatPeso writes ₱ with thousands separators and two decimals', () => {
  assert.equal(formatPeso(1234.5), '₱1,234.50');
  assert.equal(formatPeso('14133.5'), '₱14,133.50');
  assert.equal(formatPeso(0), '₱0.00');
  assert.equal(PHP, formatPeso, 'PHP is the same formatter under the name screens already use');
});

test('a negative puts a real minus sign BEFORE the peso sign (F19)', () => {
  assert.equal(formatPeso(-135), '−₱135.00');
  assert.equal(formatPeso('-96.00'), '−₱96.00');
  assert.ok(!formatPeso(-135).includes('₱-'), 'never "₱-135.00"');
});

test('tiny negatives that round to zero do not print as "−₱0.00"', () => {
  assert.equal(formatPeso(-0.001), '₱0.00');
  assert.equal(formatPeso(-0), '₱0.00');
});

test('junk input reads as zero rather than "₱NaN"', () => {
  assert.equal(formatPeso(undefined), '₱0.00');
  assert.equal(formatPeso(null), '₱0.00');
  assert.equal(formatPeso('abc'), '₱0.00');
});

test('formatSignedPeso adds a plus only for a real credit, and the minus for a debit', () => {
  assert.equal(formatSignedPeso(120), '+₱120.00');
  assert.equal(formatSignedPeso(-135), '−₱135.00');
  assert.equal(formatSignedPeso(0), '₱0.00', 'zero is neither a credit nor a debit');
  assert.equal(formatSignedPeso(0.001), '₱0.00');
});

// ── receipt numbers inside free text keep together (F19) ──────────────────────
import { keepRefsWhole } from '../src/utils/orderRef.js';

test('keepRefsWhole stops "Order 1-00112" breaking at its hyphen, in every receipt shape', () => {
  assert.equal(keepRefsWhole('Adjustment — Order 1-00112'), 'Adjustment — Order 1‑00112');
  assert.equal(keepRefsWhole('Short payment — Order 2A-00002'), 'Short payment — Order 2A‑00002');
  assert.equal(keepRefsWhole('Truck 1A-DEL-00007 late'), 'Truck 1A‑DEL‑00007 late');
  assert.equal(keepRefsWhole('Sari-sari store paid'), 'Sari-sari store paid', 'ordinary hyphenated words are left alone');
  assert.equal(keepRefsWhole(null), null);
});
