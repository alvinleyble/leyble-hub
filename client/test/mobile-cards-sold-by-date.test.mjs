import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, React, act } from './render.mjs';
import { api } from '../src/api/client.js';
import { ToastProvider } from '../src/components/ui/Toast.jsx';
import { formatCardDateTime } from '../src/utils/dateFormat.js';
import { nativeStore, __resetMemoryBackend } from '../src/offline/nativeStore.js';
import { STATION_KEY } from '../src/offline/keys.js';
import { ensureStationRegistered, __resetIssuance } from '../src/offline/station.js';
import { __clearOutbox } from '../src/offline/outbox.js';
import { saveOrderLocalFirst } from '../src/offline/posSave.js';

const OrdersPage = (await import('../src/pages/orders/OrdersPage.jsx')).default;
const DashboardPage = (await import('../src/pages/DashboardPage.jsx')).default;


// The shared phone card recipe (components/ui/ListCard.jsx, design standard Q6):
// line 1 = customer + total, line 2 = receipt · date + "Sold by", line 3 = badges.
const cardLines = (card) => [...card.querySelectorAll('[data-card-line]')];
function assertRecipe(card, { name, ref, total, date, soldBy }) {
  const [l1, l2, l3] = cardLines(card);
  assert.equal(cardLines(card).length, 3, 'card has the three recipe lines');
  const nameP = l1.querySelector('p');
  assert.ok(nameP.textContent.includes(name), 'line 1 names the customer');
  assert.ok(!/truncate|line-clamp/.test(nameP.className), 'a long name wraps; it is never cut short');
  const totalEl = l1.querySelector('.shrink-0');
  assert.ok(totalEl.textContent.includes(total), 'line 1 carries the total');
  assert.ok(totalEl.className.includes('whitespace-nowrap'), 'the total never splits across lines');
  assert.ok(l2.textContent.includes(ref), 'line 2 carries the receipt reference');
  if (date) assert.ok(l2.textContent.includes(date), 'line 2 carries the date & time');
  assert.equal(l2.querySelector('.text-right').textContent.trim(), soldBy, 'line 2 names who sold it');
  assert.ok(l2.className.includes('text-sm') && l2.className.includes('text-slate-600'),
    'details are 14px slate-600 — the design standard Q7 floor, not 12px light grey');
  assert.ok(l3, 'line 3 holds the badges');
  assert.equal(card.querySelectorAll('.text-xs').length, 0, 'nothing on the card is under 14px');
}

let originalApiGet;
let originalApiPost;
let originalApiDel;
let originalApiRequest;

async function registerStation(number = 1) {
  await nativeStore.setJson(STATION_KEY, { device_key: 'test-device', station_number: number });
  api.post = async (path) => (path === '/stations/register'
    ? { registered_at: '2026-08-26T00:00:00.000Z' }
    : {});
  return ensureStationRegistered();
}

beforeEach(async () => {
  originalApiGet = api.get;
  originalApiPost = api.post;
  originalApiDel = api.del;
  originalApiRequest = api.request;
  await __resetMemoryBackend();
  __resetIssuance();
  await __clearOutbox();
  localStorage.setItem('activeProfile', 'josie');
});

afterEach(() => {
  api.get = originalApiGet;
  api.post = originalApiPost;
  api.del = originalApiDel;
  api.request = originalApiRequest;
});

test('formatCardDateTime: formats valid timestamps as MMM d, h:mma', () => {
  const d1 = new Date('2026-07-03T12:28:00');
  const formatted1 = formatCardDateTime(d1);
  assert.ok(formatted1.includes('Jul 3'), `Expected 'Jul 3', got '${formatted1}'`);
  assert.ok(formatted1.includes('12:28'), `Expected '12:28', got '${formatted1}'`);
  assert.ok(formatted1.includes('PM'), `Expected 'PM', got '${formatted1}'`);

  const d2 = '2026-11-15T09:05:00';
  const formatted2 = formatCardDateTime(d2);
  assert.ok(formatted2.includes('Nov 15'), `Expected 'Nov 15', got '${formatted2}'`);
  assert.ok(formatted2.includes('9:05'), `Expected '9:05', got '${formatted2}'`);
  assert.ok(formatted2.includes('AM'), `Expected 'AM', got '${formatted2}'`);
});

test('formatCardDateTime: safely handles null, undefined, empty, and invalid dates without throwing', () => {
  assert.equal(formatCardDateTime(null), '');
  assert.equal(formatCardDateTime(undefined), '');
  assert.equal(formatCardDateTime(''), '');
  assert.equal(formatCardDateTime('not-a-date'), '');
  assert.equal(formatCardDateTime(NaN), '');
  assert.equal(formatCardDateTime({}), '');
});

test('OrdersPage: mobile cards follow the shared card recipe with Date & Time and Sold by', async () => {
  const mockOrders = [
    {
      id: 801,
      customer_id: 1,
      customer_name: 'Very Long Customer Name Enterprise Distributor Corp That Should Truncate Cleanly',
      status: 'pending',
      order_type: 'delivery',
      total_amount: 1250,
      adjustment: 0,
      created_at: '2026-07-03T12:28:00',
      receipt_number: '1-000801',
      sold_by_name: 'Cashier Maria Long Surname That Truncates',
      pending_receipt_printed_at: null,
      delivered_receipt_printed_at: null,
    },
    {
      id: 802,
      customer_id: 2,
      customer_name: 'Corner Sari-Sari Store',
      status: 'pending',
      order_type: 'pickup',
      total_amount: 500,
      adjustment: 0,
      created_at: '2026-07-03T14:30:00',
      receipt_number: '1-000802',
      sold_by_name: null,
      pending_receipt_printed_at: null,
      delivered_receipt_printed_at: null,
    },
    {
      id: 803,
      customer_id: 3,
      customer_name: 'Neighborhood Bakery',
      status: 'pending',
      order_type: 'delivery',
      total_amount: 320,
      adjustment: 0,
      created_at: '2026-07-03T16:45:00',
      receipt_number: '1-000803',
      sold_by_name: '   ',
      pending_receipt_printed_at: null,
      delivered_receipt_printed_at: null,
    },
  ];

  api.get = async (path) => {
    if (path.startsWith('/orders?status=draft')) return [];
    if (path.startsWith('/orders')) return mockOrders;
    return [];
  };

  const r = render(
    React.createElement(ToastProvider, null,
      React.createElement(OrdersPage, null)
    )
  );

  await act(async () => { await new Promise((res) => setTimeout(res, 25)); });

  const mobileContainer = r.container.querySelector('.md\\:hidden.divide-y');
  assert.ok(mobileContainer, 'Phone cards container (.md:hidden.divide-y) should exist');

  const cards = mobileContainer.querySelectorAll('[data-testid="orders-row"]');
  assert.equal(cards.length, 3, 'Should render 3 mobile order cards');

  assertRecipe(cards[0], {
    name: 'Very Long Customer Name', ref: '#801', total: '1,250.00', date: 'Jul 3',
    soldBy: 'Sold by: Cashier Maria Long Surname That Truncates',
  });
  // sold_by_name null / whitespace -> "Sold by: —"
  assertRecipe(cards[1], { name: 'Corner Sari-Sari Store', ref: '#802', total: '500.00', soldBy: 'Sold by: —' });
  assertRecipe(cards[2], { name: 'Neighborhood Bakery', ref: '#803', total: '320.00', soldBy: 'Sold by: —' });

  r.unmount();
});

test('DashboardPage: mobile cards follow the shared card recipe with Date & Time and Sold by', async () => {
  const payload = {
    summary: { in_transit_count: 0, pending_count: 2, completed_count: 0, pending_tickets: 0 },
    orders: [
      {
        id: 901,
        customer_id: 11,
        customer_name: 'Alvin Store Main',
        status: 'pending',
        order_type: 'delivery',
        total_amount: 3450,
        created_at: '2026-07-03T12:28:00',
        receipt_number: '1-000901',
        sold_by_name: 'Manager Luis',
        pending_receipt_printed_at: null,
        delivered_receipt_printed_at: null,
      },
      {
        id: 902,
        customer_id: 12,
        customer_name: 'Wholesale Depot',
        status: 'pending',
        order_type: 'pickup',
        total_amount: 880,
        created_at: '2026-07-03T15:10:00',
        receipt_number: '1-000902',
        sold_by_name: null,
        pending_receipt_printed_at: null,
        delivered_receipt_printed_at: null,
      },
    ],
    low_stock: [],
  };

  api.get = async (path) => {
    if (path === '/dashboard') return payload;
    return {};
  };

  const r = render(React.createElement(DashboardPage, null));
  await act(async () => { await new Promise((res) => setTimeout(res, 25)); });

  const mobileContainer = r.container.querySelector('.md\\:hidden.divide-y');
  assert.ok(mobileContainer, 'Dashboard phone cards container (.md:hidden.divide-y) should exist');

  const cards = mobileContainer.querySelectorAll('[data-testid="dashboard-order-row"]');
  assert.equal(cards.length, 2, 'Should render 2 mobile dashboard order cards');

  assertRecipe(cards[0], { name: 'Alvin Store Main', ref: '#901', total: '3,450.00', date: 'Jul 3', soldBy: 'Sold by: Manager Luis' });
  assertRecipe(cards[1], { name: 'Wholesale Depot', ref: '#902', total: '880.00', soldBy: 'Sold by: —' });

  r.unmount();
});

test('OrdersPage: unsynced local order mobile card follows the shared card recipe', async () => {
  await registerStation(1);
  api.request = async () => { const err = new Error('Failed to fetch'); throw err; };
  api.get = async () => [];

  const localOrder = await saveOrderLocalFirst({
    customer: { id: 5, name: 'Aling Nena Super Store' },
    items: [{ product_id: 1, product_name: 'Coke Sakto 200ml', sku: 'C-8', quantity: 1, unit_price: 300 }],
    profileKey: 'josie',
  });

  const r = render(
    React.createElement(ToastProvider, null,
      React.createElement(OrdersPage, null)
    )
  );
  await act(async () => { await new Promise((res) => setTimeout(res, 35)); });

  const mobileContainer = r.container.querySelector('.md\\:hidden.divide-y');
  assert.ok(mobileContainer);

  const card = mobileContainer.children[0];
  assert.ok(card);
  const ref = card.textContent.includes(localOrder.receipt_number) ? localOrder.receipt_number : '#local-1';
  assertRecipe(card, { name: 'Aling Nena', ref, total: '300.00', soldBy: card.querySelector('[data-card-line="2"] .text-right').textContent.trim() });
  assert.match(card.querySelector('[data-card-line="2"] .text-right').textContent, /^Sold by:/);
  assert.match(card.textContent, /Waiting to sync/, 'the local order is badged as waiting to sync');

  r.unmount();
});

