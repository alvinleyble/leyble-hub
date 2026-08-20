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
  assert.equal(/[−+]₱/.test(r.text()), false);
  assert.match(r.container.querySelector('button[aria-label]').getAttribute('aria-label'),
    /₱300\.00 per case$/);
});

test('F1: a Suki rate is shown on the card, badged with the saving, and spelled out', () => {
  const r = grid({ priceFor: () => 245 });   // ₱55 off ₱300 = 18.3%
  assert.match(r.text(), /₱245\.00/);
  assert.equal(r.text().includes('₱300.00'), false, 'the standard price must not be shown');
  assert.match(r.text(), /−₱55\.00 \(18\.3%\)/, 'expected the discount badge');
  // Status is never colour-only (CLAUDE.md, Accessibility).
  assert.match(r.container.querySelector('button[aria-label]').getAttribute('aria-label'),
    /₱245\.00 per case, Suki price — ₱55\.00 less than standard \(18\.3%\)$/);
});

test('F1: an above-standard rate is badged as a markup, not as a saving', () => {
  const r = grid({ priceFor: () => 330 });
  assert.match(r.text(), /\+₱30\.00 \(10\.0%\)/);
  assert.match(r.container.querySelector('button[aria-label]').getAttribute('aria-label'),
    /₱30\.00 more than standard \(10\.0%\)$/);
});

test('F1: a zero standard price badges the gap without a percentage (no divide by zero)', () => {
  const r = render(React.createElement(POSProductGrid, {
    products: [{ ...coke, base_wholesale_price: 0 }], orderQty: {}, onAdd: () => {},
    priceFor: () => 100,
  }));
  assert.match(r.text(), /\+₱100\.00/);
  assert.equal(r.text().includes('%'), false);
});

test('F1: a channel with no custom rate falls back to standard, with no badge', () => {
  // e.g. flipped to Pickup with only a delivery rate saved — priceFor returns the base.
  const r = grid({ priceFor: (p) => Number(p.base_wholesale_price) });
  assert.match(r.text(), /₱300\.00/);
  assert.equal(/[−+]₱/.test(r.text()), false, 'no gap badge when the rate is standard');
});
