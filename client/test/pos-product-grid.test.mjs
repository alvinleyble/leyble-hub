// F1 — the catalogue card must read the price the line will actually be created with:
// the selected customer's rate for the current channel, badged when it differs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, React } from './render.mjs';

const POSProductGrid = (await import('../src/components/pos/POSProductGrid.jsx')).default;

const coke = {
  id: 1, name: 'Coke Sakto 200ml', sku: 'C-8', category: 'Softdrinks',
  unit: 'cs', base_wholesale_price: 300, units_per_case: 24,
};

const grid = (props = {}) =>
  render(React.createElement(POSProductGrid, {
    products: [coke], orderQty: {}, onAdd: () => {}, ...props,
  }));

test('F1: with no customer picked the card shows the standard price and no badge', () => {
  const r = grid();
  assert.match(r.text(), /₱300\.00/);
  assert.equal(r.text().includes('Suki'), false);
  assert.match(r.container.querySelector('button[aria-label]').getAttribute('aria-label'),
    /₱300\.00 per case$/);
});

test('F1: a Suki rate is shown on the card, badged, and spelled out in the aria-label', () => {
  const r = grid({ priceFor: () => 260 });
  assert.match(r.text(), /₱260\.00/);
  assert.equal(r.text().includes('₱300.00'), false, 'the standard price must not be shown');
  assert.ok(r.text().includes('Suki'), 'expected the Suki badge');
  // Status is never colour-only (CLAUDE.md, Accessibility).
  assert.match(r.container.querySelector('button[aria-label]').getAttribute('aria-label'),
    /Coke Sakto 200ml \(C-8\), ₱260\.00 per case, Suki price$/);
});

test('F1: a channel with no custom rate falls back to standard, with no badge', () => {
  // e.g. flipped to Pickup with only a delivery rate saved — priceFor returns the base.
  const r = grid({ priceFor: (p) => Number(p.base_wholesale_price) });
  assert.match(r.text(), /₱300\.00/);
  assert.equal(r.text().includes('Suki'), false);
});
