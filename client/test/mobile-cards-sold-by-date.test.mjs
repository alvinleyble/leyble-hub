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

test('OrdersPage: mobile cards render strict 3-row layout with Date & Time and Sold by', async () => {
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

  // Locate the mobile card container
  const mobileContainer = r.container.querySelector('.lg\\:hidden.divide-y');
  assert.ok(mobileContainer, 'Mobile cards container (.lg:hidden.divide-y) should exist');

  const cards = mobileContainer.querySelectorAll('[data-testid="orders-row"]');
  assert.equal(cards.length, 3, 'Should render 3 mobile order cards');

  // Test Card 1 (with sold_by_name and long names)
  const card1 = cards[0];
  const card1Rows = card1.children;
  assert.equal(card1Rows.length, 3, 'Card must have strict 3-row layout');

  // Row 1: Receipt ref & Total
  assert.ok(card1Rows[0].className.includes('justify-between'), 'Row 1 has justify-between');
  assert.ok(card1Rows[0].textContent.includes('#801') || card1Rows[0].textContent.includes('1-000801'), 'Row 1 displays receipt reference');
  assert.ok(card1Rows[0].textContent.includes('1,250.00'), 'Row 1 displays total amount');
  const row1Total = card1Rows[0].querySelector('.shrink-0');
  assert.ok(row1Total, 'Row 1 total amount has shrink-0');

  // Row 2: Customer Name (min-w-0 truncate) & Date/Time (shrink-0 text-xs text-slate-500)
  assert.ok(card1Rows[1].className.includes('justify-between'), 'Row 2 has justify-between');
  assert.ok(card1Rows[1].className.includes('items-baseline'), 'Row 2 has items-baseline');
  const row2CustName = card1Rows[1].querySelector('p');
  assert.ok(row2CustName.className.includes('min-w-0'), 'Row 2 customer name has min-w-0');
  assert.ok(row2CustName.className.includes('truncate'), 'Row 2 customer name has truncate');
  assert.ok(row2CustName.textContent.includes('Very Long Customer Name'), 'Row 2 displays customer name');

  const row2DateTime = card1Rows[1].querySelector('.shrink-0');
  assert.ok(row2DateTime, 'Row 2 Date & Time has shrink-0');
  assert.ok(row2DateTime.className.includes('text-xs'), 'Row 2 Date & Time has text-xs');
  assert.ok(row2DateTime.className.includes('text-slate-500'), 'Row 2 Date & Time has text-slate-500');
  assert.ok(row2DateTime.textContent.includes('Jul 3'), 'Row 2 displays formatted Date & Time');

  // Row 3: Status pills (shrink-0) & Sold by (min-w-0 truncate text-xs text-slate-500 text-right)
  assert.ok(card1Rows[2].className.includes('justify-between'), 'Row 3 has justify-between');
  assert.ok(card1Rows[2].className.includes('items-center'), 'Row 3 has items-center');
  assert.ok(card1Rows[2].className.includes('mt-2'), 'Row 3 has mt-2');

  const row3Pills = card1Rows[2].querySelector('.shrink-0');
  assert.ok(row3Pills, 'Row 3 status pills wrapper has shrink-0');

  const row3SoldBy = card1Rows[2].querySelector('.text-right');
  assert.ok(row3SoldBy, 'Row 3 Sold by has text-right');
  assert.ok(row3SoldBy.className.includes('min-w-0'), 'Row 3 Sold by has min-w-0');
  assert.ok(row3SoldBy.className.includes('truncate'), 'Row 3 Sold by has truncate');
  assert.ok(row3SoldBy.className.includes('text-xs'), 'Row 3 Sold by has text-xs');
  assert.ok(row3SoldBy.className.includes('text-slate-500'), 'Row 3 Sold by has text-slate-500');
  assert.equal(row3SoldBy.textContent.trim(), 'Sold by: Cashier Maria Long Surname That Truncates');

  // Test Card 2 (sold_by_name is null -> falls back to 'Sold by: —')
  const card2 = cards[1];
  const card2SoldBy = card2.children[2].querySelector('.text-right');
  assert.equal(card2SoldBy.textContent.trim(), 'Sold by: —', 'Card 2 should fallback to Sold by: — when sold_by_name is null');

  // Test Card 3 (sold_by_name is whitespace -> falls back to 'Sold by: —')
  const card3 = cards[2];
  const card3SoldBy = card3.children[2].querySelector('.text-right');
  assert.equal(card3SoldBy.textContent.trim(), 'Sold by: —', 'Card 3 should fallback to Sold by: — when sold_by_name is whitespace');

  r.unmount();
});

test('DashboardPage: mobile cards render strict 3-row layout with Date & Time and Sold by', async () => {
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

  const mobileContainer = r.container.querySelector('.lg\\:hidden.divide-y');
  assert.ok(mobileContainer, 'Dashboard mobile cards container (.lg:hidden.divide-y) should exist');

  const cards = mobileContainer.querySelectorAll('[data-testid="dashboard-order-row"]');
  assert.equal(cards.length, 2, 'Should render 2 mobile dashboard order cards');

  // Test Card 1
  const card1 = cards[0];
  const card1Rows = card1.children;
  assert.equal(card1Rows.length, 3, 'Dashboard card must have strict 3-row layout');

  // Row 1
  assert.ok(card1Rows[0].textContent.includes('#901') || card1Rows[0].textContent.includes('1-000901'));
  assert.ok(card1Rows[0].textContent.includes('3,450.00'));
  assert.ok(card1Rows[0].querySelector('.shrink-0'), 'Row 1 total has shrink-0');

  // Row 2
  assert.ok(card1Rows[1].className.includes('justify-between'), 'Row 2 has justify-between');
  assert.ok(card1Rows[1].className.includes('items-baseline'), 'Row 2 has items-baseline');
  const custP = card1Rows[1].querySelector('p');
  assert.ok(custP.className.includes('min-w-0'), 'Row 2 customer name has min-w-0');
  assert.ok(custP.className.includes('truncate'), 'Row 2 customer name has truncate');
  assert.ok(custP.textContent.includes('Alvin Store Main'));

  const dateSpan = card1Rows[1].querySelector('.shrink-0');
  assert.ok(dateSpan, 'Row 2 Date & Time has shrink-0');
  assert.ok(dateSpan.className.includes('text-xs'), 'Row 2 Date & Time has text-xs');
  assert.ok(dateSpan.className.includes('text-slate-500'), 'Row 2 Date & Time has text-slate-500');
  assert.ok(dateSpan.textContent.includes('Jul 3'), 'Row 2 Date & Time includes Jul 3');

  // Row 3
  assert.ok(card1Rows[2].className.includes('justify-between'), 'Row 3 has justify-between');
  assert.ok(card1Rows[2].className.includes('items-center'), 'Row 3 has items-center');
  assert.ok(card1Rows[2].className.includes('mt-2'), 'Row 3 has mt-2');
  assert.ok(card1Rows[2].querySelector('.shrink-0'), 'Row 3 status pill has shrink-0');

  const soldBySpan = card1Rows[2].querySelector('.text-right');
  assert.ok(soldBySpan, 'Row 3 Sold by has text-right');
  assert.ok(soldBySpan.className.includes('min-w-0'), 'Row 3 Sold by has min-w-0');
  assert.ok(soldBySpan.className.includes('truncate'), 'Row 3 Sold by has truncate');
  assert.equal(soldBySpan.textContent.trim(), 'Sold by: Manager Luis');

  // Test Card 2 fallback
  const card2 = cards[1];
  const card2SoldBy = card2.children[2].querySelector('.text-right');
  assert.equal(card2SoldBy.textContent.trim(), 'Sold by: —');

  r.unmount();
});

test('OrdersPage: unsynced local order mobile card renders strict 3-row layout with Date & Time and Sold by', async () => {
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

  const mobileContainer = r.container.querySelector('.lg\\:hidden.divide-y');
  assert.ok(mobileContainer);

  const card = mobileContainer.children[0];
  assert.ok(card);
  assert.equal(card.children.length, 3, 'Local unsynced card must have 3 rows');

  // Row 1: Receipt ref & Total
  assert.ok(card.children[0].textContent.includes('#local-1') || card.children[0].textContent.includes(localOrder.receipt_number));
  assert.ok(card.children[0].textContent.includes('300.00'));
  assert.ok(card.children[0].querySelector('.shrink-0'), 'Row 1 total has shrink-0');

  // Row 2: Customer Name (min-w-0 truncate) & Date/Time (shrink-0 text-xs text-slate-500)
  assert.ok(card.children[1].className.includes('justify-between'));
  assert.ok(card.children[1].className.includes('items-baseline'));
  const custName = card.children[1].querySelector('p');
  assert.ok(custName.className.includes('min-w-0'));
  assert.ok(custName.className.includes('truncate'));
  assert.ok(custName.textContent.includes('Aling Nena'));

  const dateSpan = card.children[1].querySelector('.shrink-0');
  assert.ok(dateSpan.className.includes('text-xs'));
  assert.ok(dateSpan.className.includes('text-slate-500'));

  // Row 3: Status pills (shrink-0) & Sold by (min-w-0 truncate text-xs text-slate-500 text-right)
  assert.ok(card.children[2].className.includes('justify-between'));
  assert.ok(card.children[2].className.includes('items-center'));
  assert.ok(card.children[2].querySelector('.shrink-0'), 'Row 3 status pill has shrink-0');

  const soldBy = card.children[2].querySelector('.text-right');
  assert.ok(soldBy.className.includes('min-w-0'));
  assert.ok(soldBy.className.includes('truncate'));
  assert.ok(soldBy.textContent.includes('Sold by:'));

  r.unmount();
});

