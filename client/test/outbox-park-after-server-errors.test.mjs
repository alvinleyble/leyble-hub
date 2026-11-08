// One record the server keeps answering with a 5xx must not hold a device's whole
// outbox hostage (production, 2026-10-23: three tablets jammed behind two records that
// got a 500 on every retry). Captain's decision 2026-11-09 (A+): the queue stays
// strictly in order; after a 5xx the device asks the server whether it can save data
// (GET /health/write), and only a 2xx there counts the failure as a strike. At 5
// strikes the record moves to Needs attention — never deleted, its dependants waiting
// with it — and the queue continues. At most 2 records in a row are moved aside until
// another record is accepted. A strike counts only when at least 60 seconds have passed
// since that record's previous one, so a record keeps failing for about 5 minutes before
// it moves; the attention list offers a record moved aside this way "Send again as is".
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, React, act } from './render.mjs'; // jsdom globals — api/client.js reads window/localStorage on import

import { api } from '../src/api/client.js';
import { nativeStore, __resetMemoryBackend } from '../src/offline/nativeStore.js';
import {
  enqueue, drainOutbox, listRecords, listNeedsAttention, ref, repointRecord,
  __clearOutbox, NEEDS_ATTENTION, QUEUED,
} from '../src/offline/outbox.js';
import { putReceipt } from '../src/offline/receiptHistory.js';
import { markOnline, stopReachabilityWatcher, __resetStatusState } from '../src/offline/status.js';
import { ToastProvider } from '../src/components/ui/Toast.jsx';

const NeedsAttentionModal = (await import('../src/components/pos/NeedsAttentionModal.jsx')).default;

const STRIKES = 5;
const STRIKE_SPACING_MS = 60_000;
const WRITE_CHECK = '/health/write';
// The device-state key the park streak persists under (survives a reload).
const PARK_STREAK_KEY = 'v25.serverErrorParkStreak';

const realNow = Date.now;
let clock; // the device clock the drain reads its strike times from

let savedRequest;
let savedGet;
let sent; // every record endpoint the drain put on the wire, in order (checks excluded)
let checks; // how many write checks were made

beforeEach(async () => {
  __resetMemoryBackend();
  await __clearOutbox();
  __resetStatusState();
  markOnline();
  clock = realNow();
  Date.now = () => clock;
  savedRequest = api.request;
  savedGet = api.get;
  sent = [];
  checks = 0;
});

afterEach(() => {
  Date.now = realNow;
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

// What api/client.js throws when the line is down: a rejected fetch, no status.
function networkError() {
  return new TypeError('Failed to fetch');
}

// What api/client.js throws when its own 5-second budget aborts the request.
function timeoutError() {
  const err = new Error('The connection timed out.');
  err.name = 'AbortError';
  err.timedOut = true;
  return err;
}

// `failFor(path)` decides each record request (return an Error to throw it, nothing to
// answer 201); `check()` decides the write check the same way.
let nextServerId = 1000;
function serve(failFor, check = () => null) {
  api.request = async (path) => {
    if (path === WRITE_CHECK) {
      checks++;
      const failure = check();
      if (failure) throw failure;
      return { status: 'ok', writable: true };
    }
    sent.push(path);
    const failure = failFor(path);
    if (failure) throw failure;
    return { id: nextServerId++ };
  };
}

function queue(endpoint, extra = {}) {
  return enqueue({ entityType: 'order', endpoint, profileKey: 'josie', payload: {}, ...extra });
}

async function stored(id) {
  return (await listRecords()).find((r) => r.id === id);
}

// One pass, a full strike spacing after the last, so every 5xx with a passing check counts.
async function drainLater(ms = STRIKE_SPACING_MS) {
  clock += ms;
  return drainOutbox();
}

async function drainTimes(n) {
  for (let i = 0; i < n; i++) await drainLater();
}

async function parkStreak() {
  return (await nativeStore.getJson(PARK_STREAK_KEY))?.count ?? 0;
}

test('a record with repeated 5xx and a passing write check parks after 5 strikes, then the rest drains', async () => {
  serve((path) => (path === '/bad' ? httpError(500, 'Internal server error') : null));
  const bad = await queue('/bad');
  const behind = [await queue('/good/1'), await queue('/good/2')];

  for (let pass = 1; pass < STRIKES; pass++) {
    sent = [];
    const result = await drainLater();
    assert.deepEqual(sent, ['/bad'], `pass ${pass}: nothing goes out behind the failing record`);
    assert.equal(result.sent, 0);
    const record = await stored(bad.id);
    assert.equal(record.status, QUEUED);
    assert.equal(record.server_strikes, pass);
    assert.equal(record.attempts, pass);
    assert.match(record.last_error, /Internal server error/);
  }

  sent = [];
  const result = await drainLater();
  assert.deepEqual(sent, ['/bad', '/good/1', '/good/2'], 'the pass that parks it carries on behind it');
  assert.equal(result.sent, 2);
  assert.equal(result.failed, 1);

  const parked = await stored(bad.id);
  assert.ok(parked, 'the bad record is never deleted');
  assert.equal(parked.status, NEEDS_ATTENTION);
  assert.equal(parked.server_strikes, STRIKES);
  assert.match(parked.last_error, /Internal server error/);
  assert.deepEqual((await listRecords()).map((r) => r.id), [bad.id]);
  for (const { id } of behind) assert.equal(await stored(id), undefined);

  // Once parked it is no longer retried; new sales go straight through.
  sent = [];
  await queue('/good/after');
  await drainOutbox();
  assert.deepEqual(sent, ['/good/after']);
});

test('records that depend on a parked record stay queued with it, however far down the chain', async () => {
  serve((path) => (path === '/customers' ? httpError(500) : null));

  // customer (bad) → order (refers to her by $ref) → status change and receipt print
  // (depend on the order by receipt number only, no $ref)
  const customer = await enqueue({
    entityType: 'customer', endpoint: '/customers', profileKey: 'josie', payload: { name: 'Aling Nena' },
  });
  const order = await queue('/orders', { payload: { customer_id: ref(customer.id) }, dependsOn: [customer.id] });
  const status = await queue('/orders/1A-00001/status', { dependsOn: [order.id] });
  const printed = await queue('/orders/1A-00001/receipt-printed', { dependsOn: [order.id] });
  const unrelated = await queue('/good/unrelated');

  await drainTimes(STRIKES + 3);

  assert.equal((await stored(customer.id)).status, NEEDS_ATTENTION);
  for (const dependant of [order, status, printed]) {
    const record = await stored(dependant.id);
    assert.ok(record, `${dependant.endpoint} is still on the device`);
    assert.equal(record.status, QUEUED, `${dependant.endpoint} waits with the parked customer`);
    assert.equal(record.attempts, 0, `${dependant.endpoint} was never tried`);
  }
  assert.equal(await stored(unrelated.id), undefined, 'an unrelated record behind them still went');
  assert.deepEqual(sent.filter((p) => p.startsWith('/orders')), [], 'nothing depending on her went out');

  // Re-queueing the parked record (the attention list's own action) lets the chain go.
  serve(() => null);
  const requeued = await repointRecord(customer.id);
  assert.equal(requeued.server_strikes, 0, 'a re-queued record starts a clean count');
  assert.equal(requeued.last_strike_at, null);
  await drainOutbox();
  assert.deepEqual(await listRecords(), []);
});

test('a failing write check (server-wide outage) parks nothing', async () => {
  const failures = [
    ['503 not writable', () => httpError(503, 'Database is not accepting writes')],
    ['500', () => httpError(500)],
    ['network failure', networkError],
    ['timeout', timeoutError],
    ['401', () => httpError(401, 'Session ended')],
  ];
  for (const [label, checkFailure] of failures) {
    __resetMemoryBackend();
    await __clearOutbox();
    serve(() => httpError(500, 'Internal server error'), checkFailure);
    const records = [await queue('/a'), await queue('/b')];

    await drainTimes(STRIKES * 3);

    assert.deepEqual(await listNeedsAttention(), [], `${label}: nothing parked`);
    const head = await stored(records[0].id);
    assert.equal(head.status, QUEUED);
    assert.ok(!head.server_strikes, `${label}: no strike without a passing write check`);
    assert.equal(head.attempts, STRIKES * 3, `${label}: every failure is still recorded in attempts`);
    assert.equal((await stored(records[1].id)).attempts, 0, `${label}: nothing sent behind the head record`);
  }
});

test('a 404 from the write check (a server without it) parks nothing', async () => {
  serve((path) => (path === '/bad' ? httpError(500) : null), () => httpError(404, 'Not found'));
  const bad = await queue('/bad');
  const behind = await queue('/good');

  await drainTimes(STRIKES * 3);

  const record = await stored(bad.id);
  assert.equal(record.status, QUEUED);
  assert.ok(!record.server_strikes);
  assert.equal((await stored(behind.id)).status, QUEUED, 'the queue behind it waits, as today');
  assert.equal(checks, STRIKES * 3, 'the check is asked once per 5xx');
});

test('network failures, the client timeout and a 401 on the record never count as strikes', async () => {
  let failure = () => httpError(500);
  serve((path) => (path === '/bad' ? failure() : null));
  const bad = await queue('/bad');
  await queue('/good/behind');

  await drainTimes(STRIKES - 1);
  assert.equal((await stored(bad.id)).server_strikes, STRIKES - 1, 'one short of parking');

  for (const [label, make] of [['network', networkError], ['timeout', timeoutError], ['401', () => httpError(401, 'Session ended')]]) {
    failure = make;
    for (let i = 0; i < STRIKES; i++) {
      sent = [];
      const before = checks;
      await drainLater();
      assert.deepEqual(sent, ['/bad'], `${label}: the pass stops at the head record`);
      assert.equal(checks, before, `${label}: no write check is made`);
      const record = await stored(bad.id);
      assert.equal(record.status, QUEUED, `${label} must not park the record`);
      assert.equal(record.server_strikes, STRIKES - 1, `${label} must not count`);
    }
  }
  assert.ok((await stored(bad.id)).attempts > STRIKES, 'attempts kept counting every failure');

  // The next genuine 5xx with a passing check is the one that parks it.
  failure = () => httpError(500);
  await drainLater();
  const parked = await stored(bad.id);
  assert.equal(parked.server_strikes, STRIKES);
  assert.equal(parked.status, NEEDS_ATTENTION);
});

test('a later record is never sent in a pass after an earlier record got a 5xx', async () => {
  serve((path) => (path === '/customers/42' ? httpError(500) : null));
  // Two edits to the same customer, oldest first: the correction must never land first.
  const first = await queue('/customers/42', { payload: { phone: '0917-111' } });
  const correction = await queue('/customers/42', { payload: { phone: '0917-112' } });
  const other = await queue('/good/other');

  for (let pass = 1; pass < STRIKES; pass++) {
    sent = [];
    await drainLater();
    assert.deepEqual(sent, ['/customers/42'], `pass ${pass}: only the failing head record is tried`);
  }
  assert.equal((await stored(correction.id)).attempts, 0);
  assert.equal((await stored(other.id)).attempts, 0);
  assert.equal((await stored(first.id)).status, QUEUED);
});

test('the cap: with 3 consecutive bad records only 2 park, until a record is accepted', async () => {
  const bad = new Set(['/bad/1', '/bad/2', '/bad/3', '/bad/4']);
  serve((path) => (bad.has(path) ? httpError(500) : null));
  const b1 = await queue('/bad/1');
  const b2 = await queue('/bad/2');
  const b3 = await queue('/bad/3');
  const good = await queue('/good');
  const b4 = await queue('/bad/4');

  // Far more passes than three records need to reach five strikes each.
  await drainTimes(STRIKES * 6);

  assert.equal((await stored(b1.id)).status, NEEDS_ATTENTION);
  assert.equal((await stored(b2.id)).status, NEEDS_ATTENTION);
  const third = await stored(b3.id);
  assert.equal(third.status, QUEUED, 'the third bad record in a row is not parked');
  assert.ok(third.server_strikes >= STRIKES, 'even though it has reached the threshold');
  assert.equal((await stored(good.id)).status, QUEUED, 'the pass stops at it, as before');
  assert.equal(await parkStreak(), 2);

  // A record is accepted (the server fix reaches /bad/3): the streak resets and the
  // next bad record may park again.
  bad.delete('/bad/3');
  await drainOutbox();
  assert.equal(await stored(b3.id), undefined);
  assert.equal(await stored(good.id), undefined);
  assert.equal(await parkStreak(), 0, 'an accepted record resets the streak');
  await drainTimes(STRIKES);
  assert.equal((await stored(b4.id)).status, NEEDS_ATTENTION);
  assert.equal(await parkStreak(), 1);
});

test('the park streak is device state and an accepted record resets it', async () => {
  serve((path) => (path === '/bad' ? httpError(500) : null));
  await queue('/bad');
  await drainTimes(STRIKES);
  assert.equal(await parkStreak(), 1, 'persisted on the device, so it survives a reload');

  // Still 1 with nothing accepted since.
  await drainOutbox();
  assert.equal(await parkStreak(), 1);

  await queue('/good');
  await drainOutbox();
  assert.equal(await parkStreak(), 0);
});

test('repeated 5xx passes within 60 seconds add only one strike', async () => {
  serve((path) => (path === '/bad' ? httpError(500) : null));
  const bad = await queue('/bad');
  await queue('/good/behind');

  // A reconnect's double pass plus the drain loop: ten passes inside one minute.
  await drainLater(0);
  for (let i = 0; i < 9; i++) await drainLater(6_000);
  let record = await stored(bad.id);
  assert.equal(record.server_strikes, 1);
  assert.equal(record.status, QUEUED);
  assert.equal(record.attempts, 10, 'every failure is still recorded in attempts');
  assert.equal(checks, 10, 'each 5xx still asks the write check');

  await drainLater(STRIKE_SPACING_MS - 54_000); // exactly 60 seconds after the first strike
  record = await stored(bad.id);
  assert.equal(record.server_strikes, 2);
});

test('strikes spaced 60 seconds or more apart park the record at 5, about five minutes in', async () => {
  serve((path) => (path === '/bad' ? httpError(500) : null));
  const bad = await queue('/bad');
  const behind = await queue('/good/behind');

  // The 30-second drain loop: a strike lands on every other pass.
  const firstStrikeAt = clock + 30_000;
  for (let pass = 1; pass <= 8; pass++) {
    await drainLater(30_000);
    assert.equal((await stored(bad.id)).server_strikes, Math.ceil(pass / 2), `pass ${pass}`);
  }
  assert.equal((await stored(bad.id)).status, QUEUED, 'four strikes in, still queued');
  assert.equal((await stored(behind.id)).status, QUEUED);

  await drainLater(30_000);
  const parked = await stored(bad.id);
  assert.equal(parked.server_strikes, STRIKES);
  assert.equal(parked.status, NEEDS_ATTENTION);
  assert.equal(parked.last_strike_at - firstStrikeAt, 4 * STRIKE_SPACING_MS);
  assert.equal(await stored(behind.id), undefined, 'the queue carried on behind it');
});

async function settle() {
  for (let i = 0; i < 5; i++) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
}

function buttonIn(card, label) {
  return [...card.querySelectorAll('button')].find((b) => b.textContent.trim() === label);
}

test('the attention list sends a server-error record again as is; a 4xx refusal still offers only re-point', async () => {
  let refusal = httpError(500, 'Internal server error');
  serve((path) => {
    if (path === '/orders') return httpError(500, 'Internal server error');
    if (path === '/refused') return refusal;
    return null;
  });

  const refused = await queue('/refused', {
    receiptNumber: '1A-00001',
    payload: { customer_id: 7, items: [{ product_id: 3, quantity: 1, unit_price: 100 }] },
  });
  const sale = await queue('/orders', {
    receiptNumber: '1A-00002',
    payload: {
      customer_id: 42,
      order_type: 'delivery',
      items: [{ product_id: 9, quantity: 2, unit_price: 155.5 }],
      receipt_number: '1A-00002',
    },
  });
  await putReceipt({ receipt_number: '1A-00002', customer_name: 'Aling Nena', items: [] });
  const status = await queue('/orders/1A-00002/status', { dependsOn: [sale.id] });

  // The refused record takes a server-error strike before the server refuses its data.
  await drainLater();
  refusal = httpError(422, 'Product is inactive');
  await drainTimes(STRIKES);
  assert.equal((await stored(refused.id)).status, NEEDS_ATTENTION);
  assert.equal((await stored(refused.id)).server_strikes, 1);
  const before = await stored(sale.id);
  assert.equal(before.status, NEEDS_ATTENTION);
  assert.equal(before.server_strikes, STRIKES);
  assert.equal((await stored(status.id)).status, QUEUED);

  api.get = async () => [{ id: 7, name: 'Mang Tonyo', is_active: true }];
  const view = render(
    React.createElement(ToastProvider, null, React.createElement(NeedsAttentionModal, { onClose: () => {} })),
  );
  await settle();

  const saleCard = view.container.querySelector(`[data-testid="attention-record-${sale.id}"]`);
  const refusedCard = view.container.querySelector(`[data-testid="attention-record-${refused.id}"]`);
  assert.ok(saleCard && refusedCard, 'both records are listed');

  assert.match(saleCard.textContent, /server/i);
  assert.match(saleCard.textContent, /not a problem with the sale/);
  assert.match(saleCard.textContent, /Customer: Aling Nena/, "the order's current customer is named");
  assert.ok(buttonIn(saleCard, 'Send again as is'), 'a server-error record can be sent again as is');
  assert.equal(buttonIn(saleCard, 'Confirm & Re-point'), undefined);
  assert.equal(saleCard.querySelector('input'), null, 'no customer picker for a server error');

  assert.ok(buttonIn(refusedCard, 'Confirm & Re-point'), 'a 4xx refusal keeps the re-point flow');
  assert.ok(refusedCard.querySelector('input'), 'with its customer picker');
  assert.equal(buttonIn(refusedCard, 'Send again as is'), undefined, 'and is never sent again as is');
  assert.doesNotMatch(refusedCard.textContent, /not a problem with the sale/);

  view.click(buttonIn(saleCard, 'Send again as is'));
  await settle();

  const after = await stored(sale.id);
  assert.equal(after.status, QUEUED);
  assert.equal(after.server_strikes, 0);
  assert.equal(after.last_strike_at, null);
  assert.equal(after.attempts, 0);
  assert.equal(after.last_error, null);
  assert.equal(JSON.stringify(after.payload), JSON.stringify(before.payload), 'the payload is untouched');
  assert.equal(after.request_key, before.request_key);
  assert.equal(view.container.querySelector(`[data-testid="attention-record-${sale.id}"]`), null);
  assert.equal((await stored(refused.id)).status, NEEDS_ATTENTION, 'the 4xx refusal is left as it was');

  // Back in the queue, it and the record waiting on it both go once the server is fixed.
  serve(() => null);
  sent = [];
  await drainLater();
  assert.deepEqual(sent, ['/orders', '/orders/1A-00002/status']);
  assert.deepEqual((await listRecords()).map((r) => r.id), [refused.id]);

  view.unmount();
});
