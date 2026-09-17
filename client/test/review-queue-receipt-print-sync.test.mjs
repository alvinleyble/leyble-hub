// Regression tests: the Review Queue modal learns what a receipt print actually did.
//
// Both shipping APKs build with VITE_V25_OFFLINE_CORE on, so `usePrintReceipt` tags a
// print through the OUTBOX (queueReceiptPrinted) rather than calling
// POST /orders/:id/receipt-printed from the screen. The POST therefore happens later,
// inside a drain, and the route bumps `updated_at` and ADR 0019's `revision` behind the
// screen's back. OrderDetailPage survives that because it listens for
// leyble:drain-complete and re-reads; ReviewQueueModal had no such listener, so it kept
// the pre-print revision and the next five-second foreground delta arrived looking like
// another device's edit — raising the amber "changed on another device" banner over the
// operator's own print while their unsaved adjustment entry held it on screen.
//
// The fix has two halves, both covered here:
//   1. the drain adopts the authoritative order a receipt-print record gets back
//      (written to local history, carried on leyble:drain-complete), and
//   2. ReviewQueueModal adopts it, and treats a delta it already holds as an echo.
//
// The case the fix must not break is the last test: a genuine change from another
// device is still unseen, and still warns.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { React, act } from './render.mjs';
import { api } from '../src/api/client.js';
import { ToastProvider } from '../src/components/ui/Toast.jsx';
import { __resetMemoryBackend } from '../src/offline/nativeStore.js';
import { __clearReceipts, getReceipt, putOrderSnapshot } from '../src/offline/receiptHistory.js';
import { __clearOutbox } from '../src/offline/outbox.js';
import { queueReceiptPrinted } from '../src/offline/posSave.js';
import { isNewerRevision } from '../src/pages/orders/orderConcurrency.js';

const ReviewQueueModal = (await import('../src/pages/orders/ReviewQueueModal.jsx')).default;
const { createRoot } = await import('react-dom/client');

let saved = {};

beforeEach(async () => {
  saved = { get: api.get, post: api.post, patch: api.patch, del: api.del, request: api.request };
  await __resetMemoryBackend();
  await __clearReceipts();
  await __clearOutbox();
  localStorage.setItem('activeProfile', 'josie');
});

afterEach(() => {
  Object.assign(api, saved);
  localStorage.clear();
});

const order = (overrides = {}) => ({
  id: 42,
  receipt_number: '1A-00042',
  revision: '5',
  status: 'pending',
  order_type: 'delivery',
  customer_id: 7,
  customer_name: 'Aling Nena',
  created_at: '2026-09-09T01:00:00.000Z',
  adjustment: 0,
  adjustment_reason: null,
  total_amount: 300,
  notes: null,
  items: [{
    id: 3, product_id: 9, product_name: 'Coke', sku: 'C-8', category: 'Softdrinks',
    unit: 'cs', quantity: 1, unit_price: 300, unit_deposit_fee: 0,
    units_per_case: 24, bottles_returned: 0, requires_bottle_return: false,
  }],
  personnel: [],
  ...overrides,
});

// What POST /orders/:id/receipt-printed answers with: the same order, its print
// timestamp set and its revision advanced by migration 048's trigger.
const printedOrder = (overrides = {}) => order({
  revision: '6',
  pending_receipt_printed_at: '2026-09-17T01:00:00.000Z',
  pending_receipt_printed_by_name: 'Josie',
  ...overrides,
});

const settle = (ms = 30) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });

function changeInput(input, value) {
  const prototype = input.tagName === 'TEXTAREA'
    ? window.HTMLTextAreaElement.prototype
    : window.HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
  if (descriptor?.set) descriptor.set.call(input, value); else input.value = value;
  const reactPropsKey = Object.keys(input).find((key) => key.startsWith('__reactProps'));
  if (reactPropsKey && input[reactPropsKey]?.onChange) {
    input[reactPropsKey].onChange({ target: { value } });
  }
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  input.dispatchEvent(new window.Event('change', { bubbles: true }));
}

function renderQueue({ mode = 'pending', initial = order() } = {}) {
  api.get = async (path) => (path === `/orders/${initial.id}` ? initial : []);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(React.createElement(ToastProvider, null,
      React.createElement(ReviewQueueModal, {
        orderIds: [initial.id], mode, onClose: () => {},
      })));
  });
  return {
    container,
    text: () => container.textContent,
    adjustment: () => container.querySelector('input[type="number"]'),
    unmount: () => act(() => root.unmount()),
  };
}

const dispatch = (name, detail) => act(() => {
  window.dispatchEvent(new window.CustomEvent(name, { detail }));
});

const BANNER = /This order changed on another device/;

test('a drained receipt-print record adopts the server order and publishes it', async () => {
  const requests = [];
  api.request = async (path, options) => {
    requests.push({ path, method: options?.method });
    return printedOrder();
  };
  const events = [];
  const listener = (event) => events.push(event.detail);
  window.addEventListener('leyble:drain-complete', listener);

  // The local copy queueReceiptPrinted hands straight back to the screen still carries
  // the pre-print revision — it cannot know the server's answer yet.
  const local = await queueReceiptPrinted({ order: order(), phase: 'pending' });
  assert.equal(local.revision, '5');
  assert.ok(local.pending_receipt_printed_at, 'the print is visible locally right away');

  await settle(40);
  window.removeEventListener('leyble:drain-complete', listener);

  assert.deepEqual(requests, [{ path: '/orders/1A-00042/receipt-printed', method: 'POST' }]);
  const held = await getReceipt('1A-00042');
  assert.equal(held.revision, '6', 'the drain writes the authoritative row to local history');
  const published = events.flatMap((detail) => detail?.orders || []);
  assert.equal(published.length, 1);
  assert.equal(published[0].revision, '6');
  assert.equal(String(published[0].id), '42');
});

test('the drain never walks held history backwards past a later snapshot', async () => {
  api.request = async () => printedOrder();
  // The foreground sync stored a newer row (another tablet dispatched the order) while
  // this device's print was still in flight.
  await putOrderSnapshot(order({ revision: '9', status: 'in_transit' }));

  await queueReceiptPrinted({ order: order(), phase: 'pending' });
  await settle(40);

  const held = await getReceipt('1A-00042');
  assert.equal(held.revision, '9');
  assert.equal(held.status, 'in_transit', 'the print answer is older and does not overwrite it');
});

test('this device own print no longer warns over an unsaved adjustment entry', async () => {
  const r = renderQueue();
  await settle();

  // The operator is part-way through typing an adjustment: reviewDirty is true, which
  // is what makes the modal hold a delta back behind the banner instead of adopting it.
  act(() => changeInput(r.adjustment(), '-50'));
  await settle();

  // Their print drains: the outbox POST returns the order with revision 6.
  dispatch('leyble:drain-complete', { sent: 1, waiting: 0, orders: [printedOrder()] });
  await settle();

  // …and the five-second foreground poll then echoes that very same row back.
  dispatch('leyble:orders-changed', { ids: [42], orders: [printedOrder()] });
  await settle();

  assert.doesNotMatch(r.text(), BANNER, 'our own print is not another device');
  assert.equal(r.adjustment().value, '-50', 'the half-typed adjustment is untouched');
  assert.match(r.text(), /Printed \(pending\)/, 'and the print itself is now on screen');
  r.unmount();
});

test('a poll that beats the drain raises the banner, and the drain then clears it', async () => {
  const r = renderQueue();
  await settle();
  act(() => changeInput(r.adjustment(), '-50'));
  await settle();

  // The POST has landed on the server but this device has not finished its drain pass,
  // so the poll gets there first and the modal has no way yet to know whose change it is.
  dispatch('leyble:orders-changed', { ids: [42], orders: [printedOrder()] });
  await settle();
  assert.match(r.text(), BANNER);

  dispatch('leyble:drain-complete', { sent: 1, waiting: 0, orders: [printedOrder()] });
  await settle();

  assert.doesNotMatch(r.text(), BANNER, 'the drain explains the change the poll could not');
  assert.equal(r.adjustment().value, '-50');
  r.unmount();
});

test('a genuine change from another device still warns, and the print does not clear it', async () => {
  const r = renderQueue();
  await settle();
  act(() => changeInput(r.adjustment(), '-50'));
  await settle();

  // Another tablet dispatched the order after this device printed it, so the row the
  // poll delivers is ahead of the print's own revision.
  const remote = order({ revision: '7', status: 'in_transit' });
  dispatch('leyble:orders-changed', { ids: [42], orders: [remote] });
  await settle();
  assert.match(r.text(), BANNER);

  dispatch('leyble:drain-complete', { sent: 1, waiting: 0, orders: [printedOrder()] });
  await settle();

  assert.match(r.text(), BANNER, 'an older print never clears a newer remote change');
  assert.equal(r.adjustment().value, '-50');
  r.unmount();
});

test('isNewerRevision only counts forward, and treats an unorderable pair as news', () => {
  assert.equal(isNewerRevision({ revision: '5' }, { revision: '6' }), true);
  assert.equal(isNewerRevision({ revision: '6' }, { revision: '6' }), false);
  assert.equal(isNewerRevision({ revision: '6' }, { revision: '5' }), false);
  // Pre-048 rows and pre-048 snapshots are unorderable; never swallow a real change.
  assert.equal(isNewerRevision(undefined, { revision: '6' }), true);
  assert.equal(isNewerRevision({ revision: '5' }, {}), true);
});
