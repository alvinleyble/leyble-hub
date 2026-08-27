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

test('ProductCard button has touch-pan-y and not touch-none so vertical drag can scroll grid', () => {
  const r = grid();
  const btn = r.container.querySelector('button[aria-label]');
  assert.ok(btn.className.includes('touch-pan-y'), 'card button must have touch-pan-y');
  assert.equal(btn.className.includes('touch-none'), false, 'card button must not have touch-none');
  r.unmount();
});

test('quick tap on a card adds one unit', () => {
  let added = [];
  const r = grid({ onAdd: (p) => added.push(p) });
  const card = r.container.querySelector('button[aria-label]');
  r.pointerDown(card, { clientX: 100, clientY: 100 });
  r.pointerUp(card, { clientX: 101, clientY: 100 });
  assert.equal(added.length, 1, 'tap must add one unit');
  assert.equal(added[0].id, coke.id);
  r.unmount();
});

test('quick tap starting on card text/badge adds one unit', () => {
  let added = [];
  const r = grid({ onAdd: (p) => added.push(p) });
  const child = r.container.querySelector('button[aria-label] span');
  assert.ok(child, 'expected child span element');
  r.pointerDown(child, { clientX: 100, clientY: 100 });
  r.pointerUp(child, { clientX: 100, clientY: 101 });
  assert.equal(added.length, 1, 'tap on child must add one unit');
  assert.equal(added[0].id, coke.id);
  r.unmount();
});

test('pointerdown then move past threshold (> 10px) then up does NOT add anything (scroll gesture)', () => {
  let added = [];
  const r = grid({ onAdd: (p) => added.push(p) });
  const card = r.container.querySelector('button[aria-label]');
  r.pointerDown(card, { clientX: 100, clientY: 100 });
  r.pointerMove(card, { clientX: 100, clientY: 85 }); // 15px drag vertically
  r.pointerUp(card, { clientX: 100, clientY: 85 });
  assert.equal(added.length, 0, 'drag must not add product so scroll container can scroll');
  r.unmount();
});

test('pointerdown-and-drag starting on a child element (text/badge) does NOT add anything', () => {
  let added = [];
  const r = grid({ onAdd: (p) => added.push(p) });
  const child = r.container.querySelector('button[aria-label] span');
  r.pointerDown(child, { clientX: 100, clientY: 100 });
  r.pointerMove(child, { clientX: 100, clientY: 120 }); // 20px drag
  r.pointerUp(child, { clientX: 100, clientY: 120 });
  assert.equal(added.length, 0, 'drag on child must not add product');
  r.unmount();
});

test('pointercancel cancels pending action and does not add', () => {
  let added = [];
  const r = grid({ onAdd: (p) => added.push(p) });
  const card = r.container.querySelector('button[aria-label]');
  r.pointerDown(card, { clientX: 100, clientY: 100 });
  r.pointerCancel(card);
  assert.equal(added.length, 0, 'pointercancel must not add product');
  r.unmount();
});

test('press-and-hold in place on a card ramps quantity continuously via repeat behavior', async () => {
  let count = 0;
  const r = grid({ onAdd: () => { count++; } });
  const card = r.container.querySelector('button[aria-label]');
  r.pointerDown(card, { clientX: 100, clientY: 100 });
  assert.equal(count, 0, 'should not add synchronously on pointerdown');

  // Wait 400ms delay + 150ms for interval ticks
  await new Promise((res) => setTimeout(res, 550));
  assert.ok(count >= 2, `expected at least 2 ticks during hold, got ${count}`);

  const prevCount = count;
  r.pointerUp(card, { clientX: 100, clientY: 100 });
  assert.equal(count, prevCount, 'pointerup after hold must not fire extra add');

  // Wait to verify repeat timer stopped
  await new Promise((res) => setTimeout(res, 200));
  assert.equal(count, prevCount, 'repeat must stop after pointerup');
  r.unmount();
});


