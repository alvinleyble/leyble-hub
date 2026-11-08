// One record the server keeps answering with a 5xx must not hold a device's whole
// outbox hostage (production, 2026-10-23: three tablets jammed behind two records that
// got a 500 on every retry). Captain's decision 2026-09-29: after about five failed
// tries while the server is otherwise reachable, the record moves to the attention list
// and the rest of the queue carries on. Never deleted; its dependants wait with it.
//
// "Otherwise reachable" is proven inside the drain pass itself: the 5xx only counts
// against a record when the same pass got some other record accepted. A pass where
// everything gets a 5xx is the server being unwell and parks nothing.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import './render.mjs'; // jsdom globals — api/client.js reads window/localStorage on import

import { api } from '../src/api/client.js';
import { __resetMemoryBackend } from '../src/offline/nativeStore.js';
import {
  enqueue, drainOutbox, listRecords, listNeedsAttention, ref, repointRecord,
  __clearOutbox, NEEDS_ATTENTION, QUEUED,
} from '../src/offline/outbox.js';
import {
  markOnline, checkIsOnline, stopReachabilityWatcher, __resetStatusState,
} from '../src/offline/status.js';

const THRESHOLD = 5;

let savedRequest;
let sent; // every endpoint the drain actually put on the wire, in order

beforeEach(async () => {
  __resetMemoryBackend();
  await __clearOutbox();
  __resetStatusState();
  markOnline();
  savedRequest = api.request;
  sent = [];
});

afterEach(() => {
  api.request = savedRequest;
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

// `failFor(path)` decides each request: return an Error to throw it, or nothing to
// answer 201 with a fresh id.
let nextServerId = 1000;
function serve(failFor) {
  api.request = async (path) => {
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

test('a record the server keeps failing with a 5xx parks after the threshold while the rest of the queue drains', async () => {
  serve((path) => (path === '/bad' ? httpError(500, 'Internal server error') : null));
  const bad = await queue('/bad');

  for (let pass = 1; pass <= THRESHOLD; pass++) {
    await queue(`/good/${pass}`);
    const result = await drainOutbox();

    assert.equal(result.sent, 1, `pass ${pass}: the sale behind the bad record still goes out`);
    assert.ok(sent.includes(`/good/${pass}`), `pass ${pass}: /good/${pass} was sent`);
    const record = await stored(bad.id);
    assert.ok(record, 'the bad record is never deleted');
    assert.equal(record.server_errors, pass);
    assert.equal(record.attempts, pass);
    assert.match(record.last_error, /Internal server error/);
    if (pass < THRESHOLD) {
      assert.equal(record.status, QUEUED, `pass ${pass}: still retrying`);
      assert.equal(result.failed, 0);
    } else {
      assert.equal(record.status, NEEDS_ATTENTION, 'parked on the attention list at the threshold');
      assert.equal(result.failed, 1);
    }
  }

  // Everything that was not the bad record has drained; the bad record is the only one
  // left, on the attention list, and the server was never marked offline over it.
  const left = await listRecords();
  assert.deepEqual(left.map((r) => r.id), [bad.id]);
  assert.deepEqual((await listNeedsAttention()).map((r) => r.id), [bad.id]);
  assert.equal(checkIsOnline(true), true, 'one bad record is not an outage');

  // Once parked it is no longer retried; new sales go straight through.
  sent = [];
  await queue('/good/after');
  await drainOutbox();
  assert.deepEqual(sent, ['/good/after']);
});

test('the pass that parks the record carries on with the records behind it', async () => {
  serve((path) => (path === '/bad' ? httpError(500) : null));
  const bad = await queue('/bad');
  for (let pass = 1; pass < THRESHOLD; pass++) {
    await queue(`/good/${pass}`);
    await drainOutbox();
  }
  sent = [];
  await queue('/good/a');
  await queue('/good/b');

  const result = await drainOutbox();
  assert.deepEqual(sent, ['/bad', '/good/a', '/good/b']);
  assert.equal(result.sent, 2);
  assert.equal((await stored(bad.id)).status, NEEDS_ATTENTION);
});

test('records that depend on a parked record stay queued with it, however far down the chain', async () => {
  serve((path) => (path === '/customers' ? httpError(500) : null));

  // customer (bad) → order (refers to her by $ref) → status change (depends on the order
  // by receipt number only, no $ref) → receipt print (depends on the order)
  const customer = await enqueue({
    entityType: 'customer', endpoint: '/customers', profileKey: 'josie', payload: { name: 'Aling Nena' },
  });
  const order = await queue('/orders', { payload: { customer_id: ref(customer.id) }, dependsOn: [customer.id] });
  const status = await queue('/orders/1A-00001/status', { dependsOn: [order.id] });
  const printed = await queue('/orders/1A-00001/receipt-printed', { dependsOn: [order.id] });

  for (let pass = 1; pass <= THRESHOLD + 2; pass++) {
    await queue(`/good/${pass}`);
    await drainOutbox();
  }

  assert.equal((await stored(customer.id)).status, NEEDS_ATTENTION);
  for (const dependant of [order, status, printed]) {
    const record = await stored(dependant.id);
    assert.ok(record, `record ${dependant.endpoint} is still on the device`);
    assert.equal(record.status, QUEUED, `${dependant.endpoint} waits with the parked customer`);
    assert.equal(record.attempts, 0, `${dependant.endpoint} was never tried`);
  }
  assert.deepEqual(
    sent.filter((p) => p.startsWith('/orders')), [],
    'nothing that depends on the parked customer ever went out',
  );

  // Re-queueing the parked record (the attention list's own action) lets the chain go.
  serve(() => null);
  const requeued = await repointRecord(customer.id);
  assert.equal(requeued.server_errors, 0, 'a re-queued record starts a clean count');
  await drainOutbox();
  assert.deepEqual(await listRecords(), []);
});

test('a server-wide outage where every record gets a 5xx parks nothing', async () => {
  serve(() => httpError(503, 'Service unavailable'));
  const records = [await queue('/a'), await queue('/b'), await queue('/c')];

  for (let pass = 1; pass <= THRESHOLD * 3; pass++) {
    const result = await drainOutbox();
    assert.equal(result.sent, 0);
    assert.equal(result.failed, 0, `pass ${pass}: nothing parked`);
  }

  assert.deepEqual(await listNeedsAttention(), []);
  for (const { id } of records) {
    const record = await stored(id);
    assert.equal(record.status, QUEUED);
    assert.ok(!record.server_errors, 'no 5xx counted against any record without proof the server was serving');
    assert.equal(record.attempts, THRESHOLD * 3, 'every failure is still recorded in attempts');
  }
  assert.equal(checkIsOnline(true), false, 'an outage still marks the server unreachable');
});

test('network failures, the client timeout and a 401 never count toward the threshold', async () => {
  let failure = () => httpError(500);
  serve((path) => (path === '/bad' ? failure() : null));
  const bad = await queue('/bad');

  // THRESHOLD - 1 genuine record-specific 5xx failures: one short of parking.
  for (let pass = 1; pass < THRESHOLD; pass++) {
    await queue(`/good/${pass}`);
    await drainOutbox();
  }
  assert.equal((await stored(bad.id)).server_errors, THRESHOLD - 1);

  // Many more failures of the other kinds. Each still ends the pass exactly as before.
  for (const make of [networkError, timeoutError, () => httpError(401, 'Session ended')]) {
    failure = make;
    for (let i = 0; i < THRESHOLD; i++) {
      await queue('/good/behind');
      sent = [];
      const result = await drainOutbox();
      assert.deepEqual(sent, ['/bad'], `${make.name || '401'}: the pass stops at the head record`);
      assert.equal(result.sent, 0);
      const record = await stored(bad.id);
      assert.equal(record.status, QUEUED, `${make.name || '401'} must not park the record`);
      assert.equal(record.server_errors, THRESHOLD - 1, `${make.name || '401'} must not count`);
    }
  }
  const before = await stored(bad.id);
  assert.ok(before.attempts > THRESHOLD, 'attempts kept counting every failure, as it always has');

  // The next genuine record-specific 5xx is the one that parks it.
  failure = () => httpError(500);
  await drainOutbox();
  const after = await stored(bad.id);
  assert.equal(after.server_errors, THRESHOLD);
  assert.equal(after.status, NEEDS_ATTENTION);
});

test('a 401 leaves every record queued, including one carrying 5xx failures', async () => {
  let unauthorised = false;
  serve((path) => {
    if (unauthorised) return httpError(401, 'Session ended');
    return path === '/bad' ? httpError(500) : null;
  });
  const bad = await queue('/bad');
  for (let pass = 1; pass < THRESHOLD; pass++) {
    await queue(`/good/${pass}`);
    await drainOutbox();
  }

  unauthorised = true;
  const waiting = [await queue('/good/x'), await queue('/good/y')];
  await drainOutbox();

  assert.deepEqual(await listNeedsAttention(), []);
  for (const { id } of [bad, ...waiting]) {
    assert.equal((await stored(id)).status, QUEUED);
  }
});
