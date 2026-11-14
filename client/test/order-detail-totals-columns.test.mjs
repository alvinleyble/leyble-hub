// F1 (UI audit): on a phone the order detail's Price/Case and Deposit columns are
// `hidden sm:table-cell`, leaving 3 columns, but the totals labels spanned 4 — so every
// amount landed in a 5th column past the card's `overflow-hidden` edge and 360px
// showed no amounts at all. jsdom has no layout, so this pins the arithmetic instead:
// in every row of the line-items table, the colSpans of the cells visible at each
// width must add up to exactly that width's header column count.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { React, act } from './render.mjs';
import { api } from '../src/api/client.js';
import { ToastProvider } from '../src/components/ui/Toast.jsx';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { __resetMemoryBackend } from '../src/offline/nativeStore.js';
import { __clearReceipts } from '../src/offline/receiptHistory.js';
import { showEverythingFor } from './show-everything.mjs';

const OrderDetailPage = (await import('../src/pages/orders/OrderDetailPage.jsx')).default;
const { createRoot } = await import('react-dom/client');

let savedGet;

beforeEach(async () => {
  savedGet = api.get;
  await __resetMemoryBackend();
  await __clearReceipts();
});

afterEach(() => { api.get = savedGet; });

const order = (overrides = {}) => ({
  id: 42,
  receipt_number: '1A-00042',
  revision: '5',
  status: 'done',
  order_type: 'delivery',
  customer_id: 7,
  customer_name: 'Aling Nena',
  created_at: '2026-09-09T01:00:00.000Z',
  adjustment: -50,
  adjustment_reason: 'Suki discount',
  delivery_fee_charged: 100,
  total_amount: 600,
  notes: null,
  items: [{
    id: 3, product_id: 9, product_name: 'Coke', sku: 'C-8', category: 'Softdrinks',
    unit: 'cs', quantity: 2, unit_price: 300, unit_deposit_fee: 5,
    units_per_case: 24, bottles_returned: 40, requires_bottle_return: true,
  }],
  personnel: [],
  ...overrides,
});

function renderDetail() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      React.createElement(MemoryRouter, { initialEntries: ['/orders/42'] },
        React.createElement(ToastProvider, null,
          React.createElement(Routes, null,
            React.createElement(Route, { path: '/orders/:id', element: React.createElement(OrderDetailPage) })
          )
        )
      )
    );
  });
  return { container, unmount: () => act(() => root.unmount()) };
}

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });

// Tailwind visibility from the class list: `hidden` hides below `sm`,
// `sm:table-cell` / `sm:hidden` override it from `sm` up.
function visibleAt(cell, width) {
  const classes = cell.className.split(/\s+/);
  if (width === 'phone') return !classes.includes('hidden');
  if (classes.includes('sm:hidden')) return false;
  return !classes.includes('hidden') || classes.includes('sm:table-cell');
}

const spanAt = (row, width) => [...row.children]
  .filter((cell) => visibleAt(cell, width))
  .reduce((sum, cell) => sum + (cell.colSpan || 1), 0);

function assertEveryRowFits(container) {
  const table = container.querySelector('table');
  assert.ok(table, 'the line-items table rendered');
  const headerRow = table.querySelector('thead tr');
  const columns = { phone: spanAt(headerRow, 'phone'), sm: spanAt(headerRow, 'sm') };
  assert.deepEqual(columns, { phone: 3, sm: 5 }, 'header: 3 columns on a phone, 5 from sm up');

  const rows = [...table.querySelectorAll('tbody tr, tfoot tr')];
  assert.ok(rows.length > 0);
  for (const row of rows) {
    for (const width of ['phone', 'sm']) {
      assert.equal(spanAt(row, width), columns[width],
        `"${row.textContent.trim()}" spans ${spanAt(row, width)} columns at ${width}, header has ${columns[width]}`);
    }
  }
  return rows;
}

test('every totals row spans exactly the visible columns on a phone and a tablet', async () => {
  api.get = async (path) => (path === '/orders/42' ? order() : []);
  const r = renderDetail();
  await settle();

  const rows = assertEveryRowFits(r.container);
  const footer = rows.filter((row) => row.parentElement.tagName === 'TFOOT').map((row) => row.textContent);
  for (const label of ['Delivery Fee', 'Adjustment', 'Order Total']) {
    assert.ok(footer.some((text) => text.includes(label)), `${label} row rendered`);
  }
  // The returned-bottle credit row sits under its product and fits the columns too.
  assert.ok(rows.some((row) => row.parentElement.tagName === 'TBODY' && row.textContent.includes('Bottles returned')));
  r.unmount();
});

// Migration 051: the listed price already includes the deposit. The closing breakdown
// reads like the closing receipt — the product at its listed price, then one
// "Bottles returned N × fee" credit line, and nothing at all when none came back.
const visibleText = (el) => [...el.querySelectorAll('td')]
  .filter((td) => !td.className.split(/\s+/).includes('hidden'))
  .map((td) => td.textContent.trim()).join(' | ');

test('a closed order credits the returned bottles under the product, word for word as the receipt', async () => {
  api.get = async (path) => (path === '/orders/42' ? order() : []);
  const r = renderDetail();
  await settle();

  const credit = r.container.querySelector('[data-testid="order-bottle-credit"]');
  assert.ok(credit, 'the credit row rendered');
  assert.equal(visibleText(credit), 'Bottles returned 40 × ₱5.00 | −₱200.00');
  for (const gone of ['Deposit fee', 'dep.', 'credit', 'Net deposit']) {
    assert.equal(r.container.querySelector('table').textContent.includes(gone), false, gone);
  }
  // 2 × ₱300.00 − 40 × ₱5.00 + ₱100.00 delivery − ₱50.00 adjustment
  assert.match(r.container.textContent, /Order Total₱450\.00/);
  r.unmount();
});

test('a closed order with no bottles returned shows nothing extra and totals the listed price', async () => {
  api.get = async (path) => (path === '/orders/42'
    ? order({ items: [{ ...order().items[0], bottles_returned: 0 }] }) : []);
  const r = renderDetail();
  await settle();

  assert.equal(r.container.querySelector('[data-testid="order-bottle-credit"]'), null);
  assert.equal(r.container.textContent.includes('Bottles returned'), false);
  // 2 × ₱300.00 + ₱100.00 delivery − ₱50.00 adjustment
  assert.match(r.container.textContent, /Order Total₱650\.00/);
  r.unmount();
});

test('the offline no-line-items row spans exactly the visible columns too', async () => {
  api.get = async (path) => (path === '/orders/42' ? order({ items: [] }) : []);
  const r = renderDetail();
  await settle();

  assertEveryRowFits(r.container);
  assert.match(r.container.textContent, /Line items not available offline/);
  r.unmount();
});

test('the cold-load skeleton footer spans exactly the visible columns', async () => {
  let release;
  api.get = () => new Promise((resolve) => { release = () => resolve(order()); });
  const r = renderDetail();

  assertEveryRowFits(r.container);
  await act(async () => { release?.(); });
  await settle();
  r.unmount();
});

test('closing a delivered order starts at no bottles returned, so its total does not move until some are counted', async (t) => {
  await showEverythingFor(t);
  api.get = async (path) => (path === '/orders/42'
    ? order({ status: 'completed', items: [{ ...order().items[0], bottles_returned: 0 }] }) : []);
  const r = renderDetail();
  await settle();

  const input = r.container.querySelector('input[aria-label="Bottles returned for C-8"]');
  assert.ok(input, 'the close form rendered');
  assert.equal(input.value, '0', 'no bottles returned is the default');
  assert.equal(r.container.querySelector('[data-testid="order-bottle-credit"]'), null);
  assert.match(r.container.textContent, /Order Total₱650\.00/, 'the same total as before closing');

  // Count 40 bottles back: the breakdown and the close form both show the same credit.
  // jsdom's input event does not reach React's controlled-input tracker; the suite's
  // usual way in is the element's own onChange prop (see batch-price-sign.test.mjs).
  const reactProps = Object.keys(input).find((key) => key.startsWith('__reactProps'));
  act(() => { input[reactProps].onChange({ target: { value: '40' } }); });
  const credit = r.container.querySelector('[data-testid="order-bottle-credit"]');
  assert.equal(visibleText(credit), 'Bottles returned 40 × ₱5.00 | −₱200.00');
  assert.match(r.container.textContent, /Bottles returned 40 × ₱5\.00 = −₱200\.00/);
  assert.match(r.container.textContent, /Order Total₱450\.00/);
  r.unmount();
});
