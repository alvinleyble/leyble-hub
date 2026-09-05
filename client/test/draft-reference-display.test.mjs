// A draft order must never show a database row id.
//
// ADR 0017 discontinued the legacy `#<id>` numbering: a sale is named by its
// account/device receipt number (`2A-00001`). A draft, though, is an unfinalized
// scratchpad — `OrderCreateModal` auto-saves one to the server the moment a customer is
// picked, and the server deliberately leaves its `receipt_number` NULL rather than burn
// a sequence number on a sale that may never happen. `orderRef()` used to fall straight
// through to `#${order.id}` for exactly that case, so an online draft listed itself as
// `#2482` — the one numbering the app is supposed to have stopped showing.
//
// The rule these tests pin: `status === 'draft'` displays as its device-issued receipt
// number when it has one (a draft parked while blind — that number is its only identity,
// it has no row id at all), and otherwise as the plain word `Draft`. Never `#<id>`.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, React, act } from './render.mjs';
import { api } from '../src/api/client.js';
import { ToastProvider } from '../src/components/ui/Toast.jsx';
import { orderRef, orderRefWith, orderRefFromId } from '../src/utils/orderRef.js';
import { nativeStore, __resetMemoryBackend } from '../src/offline/nativeStore.js';
import { STATION_KEY } from '../src/offline/keys.js';
import { ensureStationRegistered, __resetIssuance } from '../src/offline/station.js';
import { __clearOutbox } from '../src/offline/outbox.js';

const OrdersPage       = (await import('../src/pages/orders/OrdersPage.jsx')).default;
const DashboardPage    = (await import('../src/pages/DashboardPage.jsx')).default;
const OrderCreateModal = (await import('../src/pages/orders/OrderCreateModal.jsx')).default;

const settle = (ms = 40) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

let saved = {};

beforeEach(async () => {
  saved = { get: api.get, post: api.post, patch: api.patch, del: api.del, request: api.request };
  await __resetMemoryBackend();
  __resetIssuance();
  await __clearOutbox();
  localStorage.setItem('activeProfile', 'josie');
});

afterEach(() => {
  Object.assign(api, saved);
  localStorage.clear();
});

// ── 1. orderRef itself ────────────────────────────────────────────────────────
//
// import.meta.env is stubbed to {} for every test file, so V25_OFFLINE_CORE reads false
// here and orderRef() exercises the switch-OFF path; orderRefWith(…, true) is how the
// switch-ON path (what every shipped build runs) gets covered.

test('orderRef names a server draft "Draft", never the row id it happens to carry', () => {
  const serverDraft = { id: 2482, receipt_number: null, status: 'draft' };
  assert.equal(orderRef(serverDraft), 'Draft');
  assert.equal(orderRefWith(serverDraft, true), 'Draft');
  assert.doesNotMatch(orderRefWith(serverDraft, true), /#/,
    'a draft must not leak `#<id>` — that is the numbering ADR 0017 discontinued');
});

test('orderRef names a locally parked draft by its device-issued number, on either side of the switch', () => {
  // A draft parked while blind has no row id at all, so its receipt number IS its name.
  const parked = { id: null, receipt_number: '2A-00007', status: 'draft' };
  assert.equal(orderRef(parked), '2A-00007');
  assert.equal(orderRefWith(parked, true), '2A-00007');
});

test('orderRef leaves every non-draft order exactly as it was', () => {
  assert.equal(orderRef({ id: 42 }), '#42');
  assert.equal(orderRef({ id: 42, receipt_number: '1-00042' }), '#42');
  assert.equal(orderRef({ id: 42, receipt_number: '1-00042', status: 'pending' }), '#42');
  assert.equal(orderRefWith({ id: 42, receipt_number: '1-00042', status: 'pending' }, true), '1-00042');
  assert.equal(orderRefWith({ id: 42, status: 'cancelled' }, true), '#42');
  assert.equal(orderRefWith({ id: 42 }, true), '#42');
});

test('orderRefFromId is unchanged — it holds an id and a number, never a status', () => {
  // Audit entries, a ticket's related order: these know nothing about draft-ness, and a
  // draft never reaches them anyway (drafts write no activity_logs row, and GET /orders
  // excludes them unless status=draft is asked for).
  assert.equal(orderRefFromId(2482, null), '#2482');
  assert.equal(orderRefFromId(2482, undefined), '#2482');
});

// ── 2. OrdersPage — Drafts tab, both views ────────────────────────────────────

const SERVER_DRAFT = {
  id: 2482, receipt_number: null, status: 'draft', order_type: 'delivery',
  customer_id: 5, customer_name: 'Aling Nena', total_amount: 0, adjustment: 0,
  created_at: '2026-09-05T01:00:00.000Z', sold_by_name: 'Josie',
  pending_receipt_printed_at: null, delivered_receipt_printed_at: null,
};

async function renderDraftsTab() {
  api.get = async (path) => {
    if (path.startsWith('/orders?status=draft')) return [SERVER_DRAFT];
    if (path.startsWith('/orders')) return { orders: [], pagination: { total: 0, totalPages: 1 } };
    return [];
  };
  const r = render(React.createElement(ToastProvider, null, React.createElement(OrdersPage, null)));
  await settle(60);
  const draftsTab = r.all('button').find((b) => b.textContent.trim() === 'Drafts');
  assert.ok(draftsTab, 'the Drafts tab must exist');
  await r.click(draftsTab);
  await settle(60);
  return r;
}

test('OrdersPage mobile card shows a server draft as "Draft", and keeps its 3-row layout', async () => {
  const r = await renderDraftsTab();

  const mobile = r.container.querySelector('.lg\\:hidden.divide-y');
  assert.ok(mobile, 'the phone-width card list must still render');
  const cards = mobile.querySelectorAll('[data-testid="orders-row"]');
  assert.equal(cards.length, 1, 'the draft must still be listed');

  assert.equal(cards[0].children.length, 3, 'the balanced 3-row card layout must be unbroken');

  const ref = cards[0].querySelector('p.font-mono');
  assert.ok(ref, 'row 1 still carries the reference');
  assert.equal(ref.textContent.trim(), 'Draft');
  assert.doesNotMatch(cards[0].textContent, /#2482/, 'the row id must not appear anywhere on the card');

  r.unmount();
});

test('OrdersPage desktop table shows a server draft as "Draft"', async () => {
  const r = await renderDraftsTab();

  const rows = r.container.querySelectorAll('tr[data-testid="orders-row"]');
  assert.equal(rows.length, 1, 'the draft must still be listed in the table');
  assert.equal(rows[0].querySelector('td.font-mono').textContent.trim(), 'Draft');
  assert.doesNotMatch(rows[0].textContent, /#2482/);

  r.unmount();
});

test('OrdersPage: clicking a draft row still opens it for resume, and Discard is untouched', async () => {
  const fetched = [];
  api.get = async (path) => {
    if (path.startsWith('/orders?status=draft')) return [SERVER_DRAFT];
    if (path === `/orders/${SERVER_DRAFT.id}`) { fetched.push(path); return { ...SERVER_DRAFT, items: [], personnel: [] }; }
    if (path.startsWith('/orders')) return { orders: [], pagination: { total: 0, totalPages: 1 } };
    return [];
  };

  const r = render(React.createElement(ToastProvider, null, React.createElement(OrdersPage, null)));
  await settle(60);
  await r.click(r.all('button').find((b) => b.textContent.trim() === 'Drafts'));
  await settle(60);

  // The Discard button the Drafts tab hangs off each row is still there…
  const discard = r.all('button').filter((b) => b.textContent.trim() === 'Discard');
  assert.ok(discard.length >= 1, 'per-row Discard must survive the display change');

  // …and the row itself still resumes rather than navigating to the read-only detail page.
  const row = r.container.querySelector('tr[data-testid="orders-row"]');
  await r.click(row);
  await settle(60);
  assert.deepEqual(fetched, [`/orders/${SERVER_DRAFT.id}`],
    'openDraft must still fetch the full draft to resume it');

  r.unmount();
});

// ── 3. DashboardPage — Active Orders ──────────────────────────────────────────
//
// GET /dashboard unions the open statuses with everything created in the last 5 days,
// so a draft saved this morning lands in Active Orders too.

const DASHBOARD_PAYLOAD = {
  summary: { in_transit_count: 0, pending_count: 1, completed_count: 0, pending_tickets: 0 },
  orders: [
    SERVER_DRAFT,
    { id: 2483, receipt_number: '2A-00001', status: 'pending', order_type: 'delivery',
      customer_name: 'Corner Store', total_amount: 500, created_at: '2026-09-05T02:00:00.000Z',
      sold_by_name: 'Josie', pending_receipt_printed_at: null, delivered_receipt_printed_at: null },
  ],
  low_stock: [],
};

test('DashboardPage shows a draft as "Draft" in both the card and the table view', async () => {
  api.get = async (path) => (path === '/dashboard' ? DASHBOARD_PAYLOAD : {});

  const r = render(React.createElement(DashboardPage, null));
  await settle(40);

  const cards = r.container.querySelectorAll('.lg\\:hidden.divide-y [data-testid="dashboard-order-row"]');
  assert.equal(cards.length, 2);
  assert.equal(cards[0].children.length, 3, 'the balanced 3-row card layout must be unbroken');
  assert.equal(cards[0].querySelector('a.font-mono').textContent.trim(), 'Draft');
  assert.doesNotMatch(cards[0].textContent, /#2482/);

  const tableRows = r.container.querySelectorAll('table [data-testid="dashboard-order-row"]');
  assert.equal(tableRows.length, 2);
  assert.equal(tableRows[0].querySelector('a.font-mono').textContent.trim(), 'Draft');
  assert.doesNotMatch(tableRows[0].textContent, /#2482/);

  // The switch is off in tests, so the pending order keeps its `#<id>` here — the point
  // is only that the draft did NOT, i.e. the two rows are treated differently.
  assert.match(tableRows[1].textContent, /#2483/);

  r.unmount();
});

// ── 4. OrderCreateModal — the resumed-draft title ─────────────────────────────

test('OrderCreateModal titles a resumed server draft "Draft", not "Draft #2482"', async () => {
  api.get = async (path) => {
    if (path.startsWith('/products')) return [];
    if (path.startsWith('/customers')) return [];
    if (path.startsWith('/personnel')) return [];
    return [];
  };

  const r = render(React.createElement(ToastProvider, null,
    React.createElement(OrderCreateModal, {
      editOrder: { ...SERVER_DRAFT, items: [], personnel: [] },
      onClose: () => {},
      onSaved: () => {},
    })));
  await settle(40);

  const heading = r.container.querySelector('h2');
  assert.ok(heading, 'the modal must still render its heading');
  assert.match(heading.textContent, /Draft/);
  assert.doesNotMatch(heading.textContent, /#2482/, 'the row id must not ride along in the title');
  assert.doesNotMatch(heading.textContent, /Draft\s+Draft/, 'and "Draft" must not be printed twice');

  r.unmount();
});

test('OrderCreateModal keeps a parked draft\'s device-issued number in the title', async () => {
  await nativeStore.setJson(STATION_KEY, { device_key: 'test-device', station_number: 2 });
  api.post = async () => ({ registered_at: '2026-09-05T00:00:00.000Z' });
  await ensureStationRegistered();

  api.get = async () => [];

  const r = render(React.createElement(ToastProvider, null,
    React.createElement(OrderCreateModal, {
      editOrder: {
        id: null, _local: true, _outboxId: 3, receipt_number: '2A-00007', status: 'draft',
        order_type: 'delivery', customer_id: 5, customer_name: 'Aling Nena',
        items: [], personnel: [], total_amount: 0, adjustment: 0,
        created_at: '2026-09-05T01:00:00.000Z',
      },
      onClose: () => {},
      onSaved: () => {},
    })));
  await settle(40);

  assert.match(r.container.querySelector('h2').textContent, /Draft 2A-00007/);

  r.unmount();
});
