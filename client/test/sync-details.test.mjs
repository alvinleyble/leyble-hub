// Sync details — the read-only view of what a tablet still has to send. From the
// 2026-09-29 grill on a device stuck at 356 waiting: the outbox saved `attempts` and
// `last_error` on every record but never showed them, and the release build is not
// webview-debuggable, so the only way to see why a device was stuck was the production
// server logs. The drain sends the oldest record first, so the view lists oldest first
// and names the one the next pass tries, its tries, and its last error in plain words
// with the raw message one tap away.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render as rawRender, React, act } from './render.mjs';

import { api } from '../src/api/client.js';
import { nativeStore, __resetMemoryBackend } from '../src/offline/nativeStore.js';
import { PRODUCTS_KEY, CUSTOMERS_KEY, PERSONNEL_KEY } from '../src/offline/keys.js';
import {
  enqueue, drainOutbox, listRecords, ref, __clearOutbox, NEEDS_ATTENTION, QUEUED,
} from '../src/offline/outbox.js';
import {
  buildSyncDetails, buildLookups, describeRecord, plainError, loadSyncDetails, formatWhen,
  STATE_NEXT, STATE_WAITING, STATE_BLOCKED, STATE_ATTENTION,
} from '../src/offline/syncDetails.js';
import { markOnline, stopReachabilityWatcher, __resetStatusState } from '../src/offline/status.js';
import { ToastProvider } from '../src/components/ui/Toast.jsx';

const SyncDetailsModal = (await import('../src/components/layout/SyncDetailsModal.jsx')).default;
const { StatusLightButton } = await import('../src/components/layout/StatusLight.jsx');
const NeedsAttentionModal = (await import('../src/components/pos/NeedsAttentionModal.jsx')).default;

const h = React.createElement;
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

const mounted = [];
function render(element) {
  const view = rawRender(element);
  let live = true;
  const unmount = () => { if (live) { live = false; view.unmount(); } };
  mounted.push(unmount);
  return { ...view, unmount };
}

let savedRequest;
let savedGet;
beforeEach(async () => {
  __resetMemoryBackend();
  await __clearOutbox();
  __resetStatusState();
  markOnline();
  savedRequest = api.request;
  savedGet = api.get;
  api.get = async () => [];
});
afterEach(() => {
  while (mounted.length) mounted.pop()();
  api.request = savedRequest;
  api.get = savedGet;
  stopReachabilityWatcher();
  __resetStatusState();
});

function httpError(status, message = `Request failed (${status})`) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// A record as the outbox stores it; only what each case needs.
const rec = (id, fields = {}) => ({
  id, entity_type: 'order', endpoint: '/orders', method: 'POST', payload: {},
  profile_key: 'alvin@leyblestore.com', status: QUEUED, attempts: 0, last_error: null,
  created_at: `2026-11-1${id % 10}T02:00:00.000Z`, depends_on: [], ...fields,
});

// ── What each record is, in staff words ──────────────────────────────────────

test('every record type the app queues is named in staff words, never a bare endpoint', () => {
  const lookups = buildLookups({
    products: [{ id: 7, name: 'Coke 1L' }, { id: 8, name: 'Sprite 1.5L' }],
    customers: [{ id: 12, name: 'Aling Nena', is_active: false }],
    personnel: [{ id: 3, full_name: 'Mang Jose' }],
    records: [rec(40, { entity_type: 'customer', endpoint: '/customers', payload: { name: 'Bagong Suki' } })],
  });
  const d = (fields) => describeRecord(rec(50, fields), lookups);

  assert.deepEqual(
    d({ receipt_number: '1A-00042', payload: { customer_id: 12, items: [
      { quantity: 2, unit_price: 300 }, { quantity: 1, unit_price: 155.5 },
    ] } }),
    { title: 'Order 1A-00042', detail: 'Customer: Aling Nena · 2 items · ₱755.50' },
    'a sale names its receipt, customer (a deactivated one too) and goods',
  );
  assert.equal(d({ receipt_number: '1A-00043', payload: { customer_id: ref(40), items: [] } }).detail,
    'Customer: Bagong Suki (new)', 'a customer quick-created on this tablet is named from her own record');
  assert.equal(d({ receipt_number: '1A-00044', payload: { status: 'draft' }, display: { customer_name: 'Tindahan' } }).title,
    'Draft order 1A-00044');
  assert.deepEqual(d({ entity_type: 'order_status', endpoint: '/orders/1A-00042/status', payload: { status: 'in_transit' } }),
    { title: 'Status change: order 1A-00042', detail: 'Mark as In Transit' });
  assert.equal(d({ entity_type: 'receipt_printed', endpoint: '/orders/1240/receipt-printed', payload: { phase: 'initial' } }).title,
    'Receipt printed: order #1240', 'a legacy order with no receipt number reads as #<id>');
  assert.equal(d({ entity_type: 'order_delete', method: 'DELETE', endpoint: '/orders/1A-00007', payload: { orderRef: '1A-00007' } }).title,
    'Discard draft 1A-00007');
  assert.equal(d({ entity_type: 'customer', payload: { name: 'Sari-sari ni Liza' } }).title, 'New customer: Sari-sari ni Liza');
  assert.deepEqual(d({ entity_type: 'customer_update', method: 'PATCH', endpoint: '/customers/12', payload: { delivery_fee: 50, phone: '0917' } }),
    { title: 'Customer edit: Aling Nena', detail: 'Changed: delivery fee, phone' });
  assert.equal(d({ entity_type: 'customer_update', endpoint: '/customers/:customerId',
    endpoint_params: { customerId: ref(40) }, payload: { delivery_fee: 50 } }).title, 'Customer edit: Bagong Suki (new)');
  assert.deepEqual(d({ entity_type: 'customer_price', endpoint: '/customers/12/prices',
    payload: { product_id: 7, custom_unit_price: 280, order_type: 'pickup' } }),
  { title: 'Custom price: Aling Nena', detail: 'Coke 1L · ₱280.00 · Pickup' });
  assert.equal(d({ entity_type: 'product', payload: { name: 'Royal 1L' } }).title, 'New product: Royal 1L');
  assert.deepEqual(d({ entity_type: 'product_update', method: 'PATCH', endpoint: '/products/7', payload: { current_stock: 40 } }),
    { title: 'Product edit: Coke 1L', detail: 'Changed: stock count' });
  assert.deepEqual(d({ entity_type: 'product_batch_price', endpoint: '/products/batch-price',
    payload: { updates: [{ id: 7, new_price: 1 }, { id: 8, new_price: 2 }], reason: 'supplier' } }),
  { title: 'Price change: 2 products', detail: 'Coke 1L, Sprite 1.5L' });
  assert.deepEqual(d({ entity_type: 'delivery', endpoint: '/incoming',
    payload: { delivery_ref: '1A-DEL-00007', supplier_name: 'Coca-Cola FEMSA', items: [{}, {}, {}] } }),
  { title: 'Supplier delivery 1A-DEL-00007', detail: 'Coca-Cola FEMSA · 3 products' });
  assert.equal(d({ entity_type: 'personnel', payload: { full_name: 'Pedro' } }).title, 'New personnel: Pedro');
  assert.equal(d({ entity_type: 'personnel_update', endpoint: '/personnel/3', payload: { phone: '1' } }).title,
    'Personnel edit: Mang Jose');
  assert.deepEqual(d({ entity_type: 'something_new', endpoint: '/x/y' }), { title: 'Other change', detail: null });
});

test('an id the device holds no name for still reads as words', () => {
  const d = (fields) => describeRecord(rec(1, fields));
  assert.equal(d({ entity_type: 'product_update', endpoint: '/products/99', payload: { unit: 'case' } }).title, 'Product edit: a product');
  assert.equal(d({ entity_type: 'customer_update', endpoint: '/customers/99', payload: {} }).title, 'Customer edit: a customer');
  assert.equal(d({ receipt_number: '2B-00001', payload: { customer_id: 99, items: [] } }).detail, null);
});

// ── The last error, in plain words ───────────────────────────────────────────

test('the last error reads in plain words, by what kind of answer it was', () => {
  const e = (fields) => plainError(rec(1, fields));
  assert.equal(e({}), null, 'no error, nothing to say');
  assert.equal(e({ last_error: 'Internal server error', last_error_status: 500 }), 'The server had an error while saving this.');
  assert.equal(e({ last_error: 'Request failed (500)' }), 'The server had an error while saving this.',
    'a record saved before the status was kept still reads its status from the message');
  assert.equal(e({ last_error: 'Server is temporarily restarting', last_error_status: 503 }), 'The server was restarting or unavailable.');
  assert.equal(e({ last_error: 'Order not found', last_error_status: 404, status: NEEDS_ATTENTION }),
    'The server could not find what this points to (it may have been deleted or merged).');
  assert.equal(e({ last_error: 'stale_write', last_error_status: 409, status: NEEDS_ATTENTION }),
    'The server says this clashes with a change already saved.');
  assert.equal(e({ last_error: 'customer_id is required', last_error_status: 400, status: NEEDS_ATTENTION }),
    'The server refused this change.');
  assert.equal(e({ last_error: 'Failed to fetch' }), 'Could not reach the server — no internet, or the server was down.');
  assert.equal(e({ last_error: 'Connection timed out (5s). The server or internet took too long to respond.' }),
    'The server took too long to answer (more than 5 seconds).');
  assert.equal(e({ last_error: 'Request failed (500)', status: NEEDS_ATTENTION, parked_for: 'server_error' }),
    'The server kept having an error saving this, so it was set aside. It is not a problem with the details.');
  assert.equal(e({ last_error: 'Depends on outbox record 4, which no longer exists and left no resolvable reference.', status: NEEDS_ATTENTION }),
    'It depends on another change that is no longer on this tablet, so it cannot be sent.');
  assert.equal(e({ last_error: 'something odd' }), 'The last try failed.');
});

// ── Order, and which record is at the head ───────────────────────────────────

test('rows come oldest first, and the one the next pass tries is marked', () => {
  const details = buildSyncDetails([
    rec(5, { receipt_number: '1A-00005' }),
    rec(2, { receipt_number: '1A-00002', attempts: 7, last_error: 'Internal server error', last_error_status: 500,
      last_attempt_at: '2026-11-14T03:00:00.000Z' }),
    rec(9, { receipt_number: '1A-00009' }),
  ]);
  assert.deepEqual(details.rows.map((r) => r.id), [2, 5, 9], 'outbox id order — the order the drain sends in');
  assert.deepEqual(details.rows.map((r) => r.state), [STATE_NEXT, STATE_WAITING, STATE_WAITING]);
  const head = details.rows[0];
  assert.equal(head.title, 'Order 1A-00002');
  assert.equal(head.attempts, 7);
  assert.equal(head.error, 'The server had an error while saving this.');
  assert.equal(head.rawError, 'Internal server error', 'the raw message is kept beside the plain words');
  assert.equal(head.errorStatus, 500);
  assert.equal(head.lastAttemptAt, '2026-11-14T03:00:00.000Z');
  assert.equal(head.request, 'POST /orders');
  assert.equal(details.waitingCount, 3);
  assert.equal(details.attentionCount, 0);
});

test('a record on the attention list is listed and marked, and what waits on it is not "next"', () => {
  const details = buildSyncDetails([
    rec(1, { receipt_number: '1A-00001', status: NEEDS_ATTENTION, attempts: 1, last_error: 'bad', last_error_status: 400 }),
    rec(2, { entity_type: 'order_status', endpoint: '/orders/1A-00001/status', payload: { status: 'in_transit' } }),
    rec(3, { entity_type: 'receipt_printed', endpoint: '/orders/1A-00003/receipt-printed', depends_on: [2] }),
    rec(4, { receipt_number: '1A-00004' }),
  ]);
  assert.deepEqual(details.rows.map((r) => r.state), [STATE_ATTENTION, STATE_BLOCKED, STATE_BLOCKED, STATE_NEXT],
    'a status change addressed to a parked order waits, and so does anything linked to it; the drain moves on to 4');
  assert.equal(details.attentionCount, 1);
  assert.equal(details.waitingCount, 3);
});

test('nothing on the device is an empty list', () => {
  assert.deepEqual(buildSyncDetails([]), { rows: [], waitingCount: 0, attentionCount: 0 });
  assert.deepEqual(buildSyncDetails(undefined), { rows: [], waitingCount: 0, attentionCount: 0 });
});

test('times read with their date, and a missing time is null', () => {
  assert.equal(formatWhen(null), null);
  assert.equal(formatWhen('not a date'), null);
  assert.match(formatWhen('2026-11-14T03:05:00.000Z'), /Nov 14/);
});

// ── The drain keeps what the view shows ──────────────────────────────────────

test('a failed send records when it was tried and what the server answered, and loads with names from the device', async () => {
  await nativeStore.setJson(CUSTOMERS_KEY, [{ id: 12, name: 'Aling Nena', is_active: true }]);
  await nativeStore.setJson(PRODUCTS_KEY, []);
  await nativeStore.setJson(PERSONNEL_KEY, []);
  await enqueue({
    entityType: 'order', endpoint: '/orders', payload: { customer_id: 12, items: [{ quantity: 1, unit_price: 100 }] },
    profileKey: 'luis@leyblestore.com', receiptNumber: '3A-00356', createdAt: '2026-09-29T01:00:00.000Z',
  });
  await enqueue({ entityType: 'order', endpoint: '/orders', payload: { customer_id: 12 }, profileKey: 'luis@leyblestore.com', receiptNumber: '3A-00357' });

  api.request = async (path) => {
    if (path === '/health/write') return { ok: true };
    throw httpError(500, 'column "x" does not exist');
  };
  const before = Date.now();
  await drainOutbox();
  await drainOutbox();

  const [stuck, behind] = await listRecords();
  assert.equal(stuck.attempts, 2);
  assert.equal(stuck.last_error_status, 500);
  assert.ok(Date.parse(stuck.last_attempt_at) >= before, 'the last try is timed');
  assert.equal(behind.attempts, 0, 'the drain stops at the head, so the record behind it was never tried');

  const details = await loadSyncDetails();
  assert.equal(details.rows[0].title, 'Order 3A-00356');
  assert.equal(details.rows[0].detail, 'Customer: Aling Nena · 1 item · ₱100.00');
  assert.equal(details.rows[0].state, STATE_NEXT);
  assert.equal(details.rows[0].attempts, 2);
  assert.equal(details.rows[0].error, 'The server had an error while saving this.');
  assert.equal(details.rows[0].rawError, 'column "x" does not exist');
  assert.equal(details.rows[1].attempts, 0);
  assert.equal(details.rows[1].error, null);
});

test('a network failure is timed too, with no server answer', async () => {
  await enqueue({ entityType: 'customer', endpoint: '/customers', payload: { name: 'Liza' }, profileKey: 'a@b' });
  api.request = async () => { throw new TypeError('Failed to fetch'); };
  await drainOutbox();
  const [r] = await listRecords();
  assert.equal(r.attempts, 1);
  assert.equal(r.last_error_status, null);
  assert.ok(r.last_attempt_at);
  const details = await loadSyncDetails();
  assert.equal(details.rows[0].error, 'Could not reach the server — no internet, or the server was down.');
});

// ── The view ─────────────────────────────────────────────────────────────────

test('the view lists the head record first with its tries, last error and raw message', async () => {
  const rows = buildSyncDetails([
    rec(1, { receipt_number: '3A-00356', payload: { customer_id: 12 }, attempts: 41, last_error: 'column "x" does not exist',
      last_error_status: 500, last_attempt_at: '2026-11-14T03:00:00.000Z' }),
    rec(2, { receipt_number: '3A-00357' }),
    rec(3, { entity_type: 'customer', endpoint: '/customers', payload: { name: 'Liza' }, status: NEEDS_ATTENTION,
      attempts: 1, last_error: 'name taken', last_error_status: 400 }),
  ], buildLookups({ customers: [{ id: 12, name: 'Aling Nena' }] }));
  let closed = 0;
  const view = render(h(SyncDetailsModal, { onClose: () => { closed++; }, load: async () => rows }));
  await flush();

  assert.match(view.container.querySelector('[data-testid="sync-details-summary"]').textContent, /2 waiting to send · 1 needs attention/);
  const cards = view.all('[data-testid^="sync-details-record-"]');
  assert.deepEqual(cards.map((c) => c.getAttribute('data-state')), [STATE_NEXT, STATE_WAITING, STATE_ATTENTION]);

  const head = cards[0];
  assert.equal(head.querySelector('[data-testid="sync-details-state"]').textContent, 'Next to send');
  assert.equal(head.querySelector('[data-testid="sync-details-title"]').textContent, 'Order 3A-00356');
  assert.match(head.textContent, /Customer: Aling Nena/);
  assert.equal(head.querySelector('[data-testid="sync-details-attempts"]').textContent, '41 times');
  assert.match(head.querySelector('[data-testid="sync-details-last-try"]').textContent, /Nov 14/);
  assert.equal(head.querySelector('[data-testid="sync-details-error"]').textContent, 'The server had an error while saving this.');
  assert.equal(head.querySelector('[data-testid="sync-details-raw-error"]').textContent, 'column "x" does not exist');
  assert.match(head.querySelector('[data-testid="sync-details-technical"]').textContent, /POST \/orders/);

  assert.equal(cards[1].querySelector('[data-testid="sync-details-attempts"]').textContent, 'Not tried yet');
  assert.equal(cards[1].querySelector('[data-testid="sync-details-error"]'), null);
  assert.equal(cards[2].querySelector('[data-testid="sync-details-state"]').textContent, 'Needs attention');

  // Read-only: the only buttons are the two ways to close it.
  const buttons = view.all('button').map((b) => b.getAttribute('aria-label') || b.textContent.trim());
  assert.deepEqual(buttons, ['Close', 'Close']);

  view.press('Escape');
  assert.equal(closed, 1);
});

test('the view says so when nothing is waiting', async () => {
  const view = render(h(SyncDetailsModal, { onClose: () => {} }));
  await flush();
  assert.match(view.container.querySelector('[data-testid="sync-details-empty"]').textContent, /Nothing waiting to sync/);
});

test('the view follows the queue while it is open', async () => {
  const view = render(h(SyncDetailsModal, { onClose: () => {} }));
  await flush();
  assert.ok(view.container.querySelector('[data-testid="sync-details-empty"]'));
  await act(async () => {
    await enqueue({ entityType: 'product', endpoint: '/products', payload: { name: 'Royal 1L' }, profileKey: 'a@b' });
  });
  await flush();
  assert.equal(view.container.querySelector('[data-testid="sync-details-title"]').textContent, 'New product: Royal 1L');
});

// ── Where staff open it ──────────────────────────────────────────────────────

test('the status light popup opens sync details', async () => {
  const view = render(h(ToastProvider, null, h(StatusLightButton)));
  await flush();
  view.click(view.container.querySelector('[data-testid="status-light"]'));
  const open = view.container.querySelector('[data-testid="status-light-sync-details"]');
  assert.ok(open, 'the popup offers Sync details');
  view.click(open);
  await flush();
  assert.ok(view.container.querySelector('[data-testid="sync-details-modal"]'));
  assert.equal(view.container.querySelector('[data-testid="status-light-popup"]'), null, 'the popup is put away');
});

test('the attention list offers sync details only when given the way there', async () => {
  const plain = render(h(ToastProvider, null, h(NeedsAttentionModal, { onClose: () => {} })));
  await flush();
  assert.equal(plain.container.querySelector('[data-testid="attention-sync-details"]'), null);
  plain.unmount();

  let opened = 0;
  const view = render(h(ToastProvider, null, h(NeedsAttentionModal, { onClose: () => {}, onShowSyncDetails: () => { opened++; } })));
  await flush();
  view.click(view.container.querySelector('[data-testid="attention-sync-details"]'));
  assert.equal(opened, 1);
});
