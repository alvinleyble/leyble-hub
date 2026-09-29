// The captain's round-8 review of the before/after screenshots (design standard R2–R5):
// phones and upright tablets share one card layout (tables only from 1024px), Customers
// and Personnel keep their previous rows with an em dash for a blank field and a badge on
// every row, and the Outgoing table on a sideways tablet gains its own Print Status column
// with the date AND time in the Date column.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, React, act } from './render.mjs';
import { api } from '../src/api/client.js';
import { ToastProvider } from '../src/components/ui/Toast.jsx';
import { __resetMemoryBackend } from '../src/offline/nativeStore.js';
import { __clearOutbox } from '../src/offline/outbox.js';

const CustomersPage = (await import('../src/pages/customers/CustomersPage.jsx')).default;
const PersonnelPage = (await import('../src/pages/personnel/PersonnelPage.jsx')).default;
const OrdersPage = (await import('../src/pages/orders/OrdersPage.jsx')).default;

let saved = {};

beforeEach(async () => {
  saved = { get: api.get, post: api.post, request: api.request };
  await __resetMemoryBackend();
  await __clearOutbox();
  localStorage.setItem('activeProfile', 'josie');
});

afterEach(() => {
  Object.assign(api, saved);
});

const settle = (ms = 40) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
const mount = (Page) => render(React.createElement(ToastProvider, null, React.createElement(Page)));
const phoneList = (r) => r.container.querySelector('.lg\\:hidden.divide-y');

test('R1: the card list is the layout below 1024px, and the table only from 1024px', async () => {
  api.get = async (path) => (path.startsWith('/customers')
    ? [{ id: 1, name: 'Buddy', customer_type: 'wholesaler', phone: '0917', address: 'Antipolo', is_active: true }]
    : []);
  const r = mount(CustomersPage);
  await settle();
  assert.ok(phoneList(r), 'cards are gated lg:hidden, so an 800px upright tablet gets them');
  const table = r.container.querySelector('table');
  assert.match(table.className, /\bhidden lg:table\b/, 'the table appears only at lg (1024px)');
  assert.doesNotMatch(r.container.innerHTML, /\bmd:(hidden|table)\b/, 'nothing switches at 768px any more');
  r.unmount();
});

test('R4: a Customers row is name + type, then mobile · address with an em dash for each blank, and Active on every row', async () => {
  api.get = async (path) => (path.startsWith('/customers') ? [
    { id: 1, name: 'Buddy', customer_type: 'wholesaler', phone: '09171234567', address: 'Antipolo', is_active: true },
    { id: 2, name: 'No Details Store', customer_type: 'regular', phone: '', address: null, is_active: true },
  ] : []);
  const r = mount(CustomersPage);
  await settle();

  const cards = phoneList(r).querySelectorAll('[data-testid="customers-row"]');
  assert.equal(cards.length, 2);
  const [full, blank] = cards;
  const line = (card, n) => card.querySelector(`[data-card-line="${n}"]`);

  assert.match(line(full, 1).textContent, /Buddy/);
  assert.match(line(full, 1).textContent, /Wholesale/, 'line 1 carries the customer type');
  assert.match(line(full, 2).textContent, /09171234567 · Antipolo/);
  assert.match(line(full, 2).textContent, /Active/, 'an ordinary active customer is badged Active too');

  assert.match(line(blank, 2).textContent, /— · —/, 'a blank mobile and a blank address each read as an em dash');
  assert.match(line(blank, 2).textContent, /Active/);

  const rows = r.container.querySelectorAll('tr[data-testid="customers-row"]');
  const blankCells = [...rows[1].querySelectorAll('td')].map((td) => td.textContent.trim());
  assert.ok(blankCells.filter((t) => t === '—').length >= 2, 'the sideways-tablet table shows — in both blank cells');
  r.unmount();
});

test('R2: a Personnel row keeps its previous look — name, mobile or an em dash, one status badge on the right', async () => {
  api.get = async (path) => (path.startsWith('/personnel') ? [
    { id: 1, full_name: 'Mang Tonyo', phone: '', is_active: true },
  ] : []);
  const r = mount(PersonnelPage);
  await settle();

  const card = phoneList(r).querySelector('[data-testid="personnel-row"]');
  assert.ok(card);
  assert.match(card.querySelector('[data-card-line="1"]').textContent, /Mang Tonyo/);
  assert.equal(card.querySelector('[data-card-line="2"]').textContent.trim(), '—');
  const aside = card.lastElementChild;
  assert.match(aside.className, /self-center/, 'the badge sits centred on the right of the row');
  assert.equal(aside.textContent.trim(), 'Active');
  r.unmount();
});

test('R5: the Outgoing table has its own Print Status column, and the Date column shows the time', async () => {
  const base = {
    customer_id: 1, status: 'pending', order_type: 'delivery', total_amount: 500, adjustment: 0,
    sold_by_name: 'Josie', delivered_receipt_printed_at: null,
  };
  api.get = async (path) => (path.startsWith('/orders') ? [
    { ...base, id: 901, customer_name: 'Printed Store', receipt_number: '1-000901', created_at: '2026-07-03T12:28:00', pending_receipt_printed_at: '2026-07-03T12:30:00' },
    { ...base, id: 902, customer_name: 'Unprinted Store', receipt_number: '1-000902', created_at: '2026-07-03T09:05:00', pending_receipt_printed_at: null },
  ] : []);
  const r = mount(OrdersPage);
  await settle();

  const headers = [...r.container.querySelectorAll('thead th')].map((th) => th.textContent.trim());
  const printCol = headers.indexOf('Print Status');
  const dateCol = headers.indexOf('Date');
  const statusCol = headers.indexOf('Status');
  assert.ok(printCol > -1, 'Print Status is its own column');
  assert.ok(!r.container.querySelector('thead select'), 'no filter lives in a column header');

  const rows = [...r.container.querySelectorAll('tr[data-testid="orders-row"]')];
  const cell = (row, i) => row.querySelectorAll('td')[i].textContent.trim();
  const byName = (name) => rows.find((row) => row.textContent.includes(name));

  assert.equal(cell(byName('Printed Store'), printCol), 'Printed');
  assert.equal(cell(byName('Unprinted Store'), printCol), 'Not Printed');
  assert.doesNotMatch(cell(byName('Printed Store'), statusCol), /Printed/, 'the Status column no longer carries it');

  assert.match(cell(byName('Printed Store'), dateCol), /Jul 3, 2026/);
  assert.match(cell(byName('Printed Store'), dateCol), /12:28/, 'the Date column carries the time');
  r.unmount();
});
