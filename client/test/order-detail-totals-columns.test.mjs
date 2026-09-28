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
  for (const label of ['Items', 'Deposit fee', 'Delivery Fee', 'Adjustment', 'Order Total']) {
    assert.ok(footer.some((text) => text.includes(label)), `${label} row rendered`);
  }
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
