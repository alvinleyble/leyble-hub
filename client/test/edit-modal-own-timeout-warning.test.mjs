// The Edit Order modal's "changed on another device" warning, after a save from THIS
// device timed out on the client but was committed by the server.
//
// api/client.js aborts every request after 5s; the abort never reaches the server, which
// commits (R → R+1). The screen was never told, so it still holds R — and the next
// foreground delta delivers R+1 as strictly newer, which the host parked behind the open
// form and announced as another device's change (staging order 2258, 2026-09-25). A
// normal save never shows this because it adopts the server's returned revision, so its
// own echo arrives EQUAL and silent.
//
// The fix asks the server, not the revision: resend the held, unanswered attempt under
// its own request key (migration 050 claims the key before the revision check). A spent
// key is answered with a replay — the write was ours — and an unspent one is refused
// with 409 against the newer revision, so neither writes anything. These tests run the
// real api client against a fake server that honours both rules, so the held key, the
// resend and the replay are all the production code paths.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { React, act } from './render.mjs';
import { api } from '../src/api/client.js';
import { ToastProvider } from '../src/components/ui/Toast.jsx';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { __resetMemoryBackend } from '../src/offline/nativeStore.js';
import { __clearReceipts } from '../src/offline/receiptHistory.js';
import { __resetMutationKeys } from '../src/offline/intentKeys.js';
import { markOnline, __resetStatusState, stopReachabilityWatcher } from '../src/offline/status.js';

const OrderDetailPage = (await import('../src/pages/orders/OrderDetailPage.jsx')).default;
const ReviewQueueModal = (await import('../src/pages/orders/ReviewQueueModal.jsx')).default;
const { createRoot } = await import('react-dom/client');

const WARNING = /changed on another device/;

let savedApi;
let savedFetch;

beforeEach(async () => {
  savedApi = { get: api.get, post: api.post, patch: api.patch };
  savedFetch = globalThis.fetch;
  __resetMutationKeys();
  __resetStatusState();
  markOnline();
  await __resetMemoryBackend();
  await __clearReceipts();
});

afterEach(() => {
  Object.assign(api, savedApi);
  globalThis.fetch = savedFetch;
  stopReachabilityWatcher();
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
  delivery_fee_charged: null,
  items: [{
    id: 3, product_id: 9, product_name: 'Coke', sku: 'C-8', category: 'Softdrinks',
    unit: 'cs', quantity: 1, unit_price: 300, unit_deposit_fee: 0,
    units_per_case: 24, bottles_returned: 0, requires_bottle_return: false,
  }],
  personnel: [],
  ...overrides,
});

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => (name === 'Content-Type' ? 'application/json' : null) },
    json: async () => payload,
    clone: () => jsonResponse(payload, status),
  };
}

// The server half of migration 048 + 050 for PATCH /orders/42, in miniature: a spent
// key is answered with the stored order before anything else; otherwise a stale
// revision is refused; otherwise the write commits once and spends the key.
function fakeServer() {
  const server = {
    order: order(),
    spent: new Set(),
    commits: 0,
    patches: [],
    // What happens to the NEXT committed-or-refused write's reply on the wire:
    // 'answer' (normal), 'hang' (held past the client's 5s budget), 'drop' (the request
    // dies before the server sees it).
    wire: 'answer',
    otherDevice(changes) {
      server.order = order({
        ...server.order, ...changes, revision: String(Number(server.order.revision) + 1),
      });
    },
  };

  globalThis.fetch = (url, opts = {}) => {
    const method = (opts.method || 'GET').toUpperCase();
    if (!(method === 'PATCH' && String(url).endsWith('/orders/42'))) {
      return Promise.resolve(jsonResponse({}));
    }
    const body = JSON.parse(opts.body);
    server.patches.push(body);
    const wire = server.wire;
    server.wire = 'answer';

    if (wire === 'drop') {
      const err = new TypeError('Failed to fetch');
      return Promise.reject(err);
    }

    let reply;
    if (server.spent.has(body.request_key)) {
      reply = jsonResponse(server.order);
    } else if (String(body.revision) !== String(server.order.revision)) {
      reply = jsonResponse(
        { code: 'stale_write', error: 'Order changed', order: server.order }, 409
      );
    } else {
      server.commits += 1;
      server.spent.add(body.request_key);
      server.order = order({
        ...server.order,
        notes: body.notes,
        revision: String(Number(server.order.revision) + 1),
      });
      reply = jsonResponse(server.order);
    }

    if (wire === 'hang') {
      // Committed above; the reply never makes it back before the client gives up.
      return new Promise((_resolve, reject) => {
        opts.signal?.addEventListener('abort', () => {
          const err = new Error('The operation was aborted.');
          err.name = 'AbortError';
          reject(err);
        });
      });
    }
    return Promise.resolve(reply);
  };

  api.get = async (path) => {
    if (path === '/orders/42') return server.order;
    if (path.startsWith('/products')) return server.order.items.map((item) => ({
      id: item.product_id, name: item.product_name, sku: item.sku, category: item.category,
      unit: item.unit, base_wholesale_price: item.unit_price, current_stock: 10,
      units_per_case: item.units_per_case, deposit_fee: 0, is_active: true,
    }));
    if (path.includes('/prices')) return [];
    if (path.startsWith('/customers')) return [{ id: 7, name: 'Aling Nena', customer_type: 'regular', is_active: true }];
    return [];
  };

  return server;
}

function mount(element) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => { root.render(element); });
  return {
    container,
    text: () => container.textContent,
    button: (text) => [...container.querySelectorAll('button')].find((b) => b.textContent.includes(text)),
    click: (button) => act(() => button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))),
    unmount: () => act(() => root.unmount()),
  };
}

const renderDetail = () => mount(
  React.createElement(MemoryRouter, { initialEntries: ['/orders/42'] },
    React.createElement(ToastProvider, null,
      React.createElement(Routes, null,
        React.createElement(Route, { path: '/orders/:id', element: React.createElement(OrderDetailPage) })
      )
    )
  )
);

const renderReviewQueue = () => mount(
  React.createElement(ToastProvider, null,
    React.createElement(ReviewQueueModal, { orderIds: [42], mode: 'pending', onClose: () => {} }))
);

const settle = (ms = 30) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });

function changeInput(el, value) {
  const descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
  if (descriptor?.set) descriptor.set.call(el, value); else el.value = value;
  const key = Object.keys(el).find((k) => k.startsWith('__reactProps'));
  if (key && el[key]?.onChange) el[key].onChange({ target: { value } });
  el.dispatchEvent(new window.Event('input', { bubbles: true }));
}

const typeNotes = (r, value) => act(() => changeInput(
  r.container.querySelector('[data-testid="order-edit-notes-input"]'), value
));

function deliver(row) {
  act(() => window.dispatchEvent(new window.CustomEvent('leyble:orders-changed', {
    detail: { ids: [row.id], receiptNumbers: [row.receipt_number], orders: [row] },
  })));
}

async function openEdit(r) {
  await settle();
  r.click(r.button('Edit Order'));
  await settle();
  assert.match(r.text(), /Edit Order #|Edit Order 1A-00042/);
}

// ── The regression ───────────────────────────────────────────────────────────

test('a save that timed out but committed is this device\'s own change: its delta raises no warning', async () => {
  const server = fakeServer();
  const r = renderDetail();
  await openEdit(r);

  typeNotes(r, 'Deliver after 3pm');
  server.wire = 'hang';
  r.click(r.button('Save Changes'));
  // The real 5s client budget, not a shortcut: this is the abort the operator saw.
  await settle(5300);

  assert.match(r.text(), /timed out/i, 'the operator was told the save failed');
  assert.equal(server.commits, 1, 'while the server committed it');
  assert.equal(server.order.revision, '6');

  // The next foreground poll delivers the order this device's own save produced.
  deliver(server.order);
  await settle();

  assert.doesNotMatch(r.text(), WARNING,
    'the only change since revision 5 is this device\'s own save');
  assert.equal(server.commits, 1, 'asking the server wrote nothing');
  assert.equal(server.patches.at(-1).request_key, server.patches[0].request_key,
    'the question went out under the timed-out attempt\'s own key');

  // Retrying the unchanged form is still the same attempt, answered as a replay.
  r.click(r.button('Save Changes'));
  await settle();
  assert.match(r.text(), /Order updated/);
  assert.doesNotMatch(r.text(), /Save Changes/, 'the modal closed on the replayed answer');
  assert.equal(server.commits, 1, 'exactly one edit, never two');
  assert.equal(server.order.revision, '6');
  r.unmount();
});

test('after its own write is proven, a further change to the form saves against that revision', async () => {
  const server = fakeServer();
  const r = renderDetail();
  await openEdit(r);

  typeNotes(r, 'Deliver after 3pm');
  // Commit first, then lose the reply — the same "committed but unanswered" outcome as
  // the 5s abort above, reached without waiting it out.
  const fetchWithCommit = globalThis.fetch;
  globalThis.fetch = (url, opts) => fetchWithCommit(url, opts)
    .then(() => { throw new TypeError('Failed to fetch'); });
  r.click(r.button('Save Changes'));
  await settle();
  globalThis.fetch = fetchWithCommit;
  assert.equal(server.commits, 1);

  deliver(server.order);
  await settle();
  assert.doesNotMatch(r.text(), WARNING);

  // The operator keeps typing after the failure. That is a new write, not a replay —
  // and it must not be refused as "changed on another device" for sitting on top of
  // this device's own revision 6.
  typeNotes(r, 'Deliver after 4pm');
  r.click(r.button('Save Changes'));
  await settle();

  const last = server.patches.at(-1);
  assert.equal(last.revision, '6', 'saved against the revision its own write produced');
  assert.notEqual(last.request_key, server.patches[0].request_key, 'a different edit, a fresh key');
  assert.match(r.text(), /Order updated/);
  assert.doesNotMatch(r.text(), /Your change was not saved/);
  assert.equal(server.commits, 2);
  assert.equal(server.order.notes, 'Deliver after 4pm');
  r.unmount();
});

// ── Guards: a genuine edit from another device is never hidden ───────────────

test('another device\'s edit still warns when this device\'s timed-out save never landed', async () => {
  const server = fakeServer();
  const r = renderDetail();
  await openEdit(r);

  typeNotes(r, 'Deliver after 3pm');
  server.wire = 'drop'; // never reached the server
  r.click(r.button('Save Changes'));
  await settle();
  assert.equal(server.commits, 0);

  // Meanwhile another tablet edits the order once — revision 6, exactly one ahead, the
  // same shape this device's own write would have had.
  server.otherDevice({ notes: 'Changed on Luis\'s tablet' });
  deliver(server.order);
  await settle();

  assert.match(r.text(), WARNING, 'the server refused the held key: revision 6 is not ours');
  assert.equal(server.order.revision, '6', 'asking wrote nothing');
  assert.equal(server.order.notes, 'Changed on Luis\'s tablet');
  r.unmount();
});

test('another device\'s edit on top of this device\'s own timed-out save still warns', async () => {
  const server = fakeServer();
  const r = renderDetail();
  await openEdit(r);

  typeNotes(r, 'Deliver after 3pm');
  server.wire = 'hang';
  r.click(r.button('Save Changes'));
  await settle(5300);
  assert.equal(server.commits, 1);

  // Both writes land before the next poll: the delta is two revisions ahead of what
  // this screen holds, so it cannot be only this device's own write.
  server.otherDevice({ status: 'in_transit' });
  const probesBefore = server.patches.length;
  deliver(server.order);
  await settle();

  assert.match(r.text(), WARNING);
  assert.equal(server.patches.length, probesBefore, 'nothing to ask: no candidate fits two revisions');
  r.unmount();
});

test('own write first, then another device\'s: the second delta warns', async () => {
  const server = fakeServer();
  const r = renderDetail();
  await openEdit(r);

  typeNotes(r, 'Deliver after 3pm');
  server.wire = 'hang';
  r.click(r.button('Save Changes'));
  await settle(5300);

  deliver(server.order);
  await settle();
  assert.doesNotMatch(r.text(), WARNING, 'revision 6 is this device\'s own save');

  server.otherDevice({ status: 'in_transit' });
  deliver(server.order);
  await settle();
  assert.match(r.text(), WARNING, 'revision 7 is somebody else\'s');
  r.unmount();
});

// ── The review queue hosts the same Edit modal ───────────────────────────────

test('the review queue\'s Edit modal applies the same proof', async () => {
  const server = fakeServer();
  const r = renderReviewQueue();
  await settle();
  r.click(r.button('Edit Order'));
  await settle();

  typeNotes(r, 'Deliver after 3pm');
  const fetchWithCommit = globalThis.fetch;
  globalThis.fetch = (url, opts) => fetchWithCommit(url, opts)
    .then(() => { throw new TypeError('Failed to fetch'); });
  r.click(r.button('Save Changes'));
  await settle();
  globalThis.fetch = fetchWithCommit;
  assert.equal(server.commits, 1);

  deliver(server.order);
  await settle();
  assert.doesNotMatch(r.text(), WARNING, 'its own committed save');

  server.otherDevice({ notes: 'Changed on Luis\'s tablet' });
  deliver(server.order);
  await settle();
  assert.match(r.text(), WARNING, 'a later edit from another device');
  r.unmount();
});
