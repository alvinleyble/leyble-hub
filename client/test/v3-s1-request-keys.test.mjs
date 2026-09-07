// ADR 0017 #9, device half — the retry key, split off the receipt number.
//
// What these pin: a queued record carries its own key, that key is what a retry is
// recognised by, and the receipt number no longer has to carry that job. Same key
// twice is one order; two different keys are two orders (the server half of that pair
// is server/test/v3-s1-request-keys.test.js).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import './render.mjs'; // jsdom globals — api/client.js reads window/localStorage on import

import { api } from '../src/api/client.js';
import { nativeStore, __resetMemoryBackend } from '../src/offline/nativeStore.js';
import { outboxKey } from '../src/offline/keys.js';
import { enqueue, drainOutbox, listRecords, __clearOutbox } from '../src/offline/outbox.js';
import { newRequestKey, isRequestKey } from '../src/offline/requestKeys.js';

let savedApi;

beforeEach(async () => {
  __resetMemoryBackend();
  await __clearOutbox();
  savedApi = { post: api.post, request: api.request };
});

afterEach(() => {
  api.post = savedApi.post;
  api.request = savedApi.request;
});

// Records every body the drain sends, so a test can ask what actually left the device.
function captureSends(respond = () => ({ id: 1 })) {
  const sent = [];
  api.request = async (endpoint, options) => {
    const body = options.body ? JSON.parse(options.body) : null;
    sent.push({ endpoint, method: options.method, body });
    return respond(body, sent.length);
  };
  return sent;
}

// ── The key itself ──────────────────────────────────────────────────────────

test('newRequestKey mints an opaque key that fits the column and never repeats', () => {
  const keys = new Set();
  for (let i = 0; i < 2000; i++) {
    const key = newRequestKey();
    assert.ok(isRequestKey(key), `${key} is a well-formed retry key`);
    assert.ok(key.length <= 64, 'fits VARCHAR(64) in migration 039');
    keys.add(key);
  }
  assert.equal(keys.size, 2000, 'no collisions across a day of selling');
});

// ── One key per record, minted at enqueue ───────────────────────────────────

test('every queued record gets its own retry key, distinct from the receipt number', async () => {
  const first = await enqueue({
    entityType: 'order', endpoint: '/orders', payload: { customer_id: 1 },
    profileKey: 'luis', receiptNumber: '3-00007',
  });
  const second = await enqueue({
    entityType: 'order', endpoint: '/orders', payload: { customer_id: 2 },
    profileKey: 'luis', receiptNumber: '3-00008',
  });

  assert.ok(isRequestKey(first.request_key));
  assert.notEqual(first.request_key, second.request_key);
  assert.notEqual(first.request_key, first.receipt_number,
    'the retry key is never derived from the receipt number — that coupling is what ADR 0017 #9 removes');
});

test('the retry key is stored with the record, so a reload keeps it', async () => {
  const record = await enqueue({
    entityType: 'order', endpoint: '/orders', payload: {}, profileKey: 'josie',
  });
  const [reloaded] = await listRecords();
  assert.equal(reloaded.request_key, record.request_key);
});

// ── What the drain sends ────────────────────────────────────────────────────

test('the drain sends the retry key on the POST body', async () => {
  const sent = captureSends();
  const record = await enqueue({
    entityType: 'order', endpoint: '/orders', payload: { customer_id: 4 },
    profileKey: 'luis', receiptNumber: '3-00042',
  });

  await drainOutbox();

  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.request_key, record.request_key);
  assert.equal(sent[0].body.customer_id, 4, 'and leaves the rest of the payload alone');
});

test('a retried record resends the SAME key — that is what makes a resend recognisable', async () => {
  // First pass: the server commits but the response is lost on the way back. A thrown
  // error with no HTTP status is an outage, so the record stays queued.
  const sent = captureSends(() => { throw new Error('network down'); });
  const record = await enqueue({
    entityType: 'order', endpoint: '/orders', payload: { customer_id: 4 },
    profileKey: 'luis', receiptNumber: '3-00042',
  });
  await drainOutbox();

  const [stillQueued] = await listRecords();
  assert.equal(stillQueued.status, 'queued');

  // Second pass: the line is back.
  api.request = async (endpoint, options) => {
    sent.push({ endpoint, method: options.method, body: JSON.parse(options.body) });
    return { id: 91 };
  };
  await drainOutbox();

  assert.equal(sent.length, 2);
  assert.equal(sent[0].body.request_key, record.request_key);
  assert.equal(sent[1].body.request_key, record.request_key,
    'the same record keeps one key across every attempt');
  assert.equal((await listRecords()).length, 0);
});

test('two orders that collide on a receipt number still send different retry keys', async () => {
  const sent = captureSends();
  // The hazard ADR 0017 #9 exists for: two genuinely different sales wearing one
  // number. Coupled, the second was answered with the first's stored order and
  // vanished. Decoupled, the server sees two distinct records.
  await enqueue({
    entityType: 'order', endpoint: '/orders', payload: { customer_id: 1 },
    profileKey: 'luis', receiptNumber: '3-00042',
  });
  await enqueue({
    entityType: 'order', endpoint: '/orders', payload: { customer_id: 2 },
    profileKey: 'josie', receiptNumber: '3-00042',
  });

  await drainOutbox();

  assert.equal(sent.length, 2);
  assert.notEqual(sent[0].body.request_key, sent[1].body.request_key);
  assert.equal(sent[0].body.receipt_number, undefined, 'the payload is untouched by this mechanism');
});

test('a PATCH or DELETE carries no retry key — resending one is already idempotent', async () => {
  const sent = captureSends();
  await enqueue({
    entityType: 'order', endpoint: '/orders/3-00042', method: 'PATCH',
    payload: { notes: 'edited' }, profileKey: 'luis',
  });
  await enqueue({
    entityType: 'order_delete', endpoint: '/orders/3-00043', method: 'DELETE',
    payload: { orderRef: '3-00043' }, profileKey: 'luis',
  });

  await drainOutbox();

  assert.equal(sent.length, 2);
  for (const call of sent) {
    assert.equal(call.body.request_key, undefined, `${call.method} bodies stay as they were`);
  }
});

// ── The mixed-fleet window (ADR 0014) ───────────────────────────────────────

test('a record queued by a pre-039 build still drains, with no retry key invented for it', async () => {
  const sent = captureSends();
  // Exactly the shape a record written by the previous build has on disk: no
  // request_key field at all. It must still go, and it must NOT acquire a key here —
  // the server falls back to the receipt number for precisely this record.
  await nativeStore.setJson(outboxKey(1), {
    id: 1,
    entity_type: 'order',
    endpoint: '/orders',
    method: 'POST',
    payload: { customer_id: 5, receipt_number: '2-00019' },
    profile_key: 'josie',
    receipt_number: '2-00019',
    depends_on: [],
    status: 'queued',
    attempts: 0,
    last_error: null,
    created_at: '2026-09-01T02:00:00.000Z',
  });

  await drainOutbox();

  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.request_key, undefined);
  assert.equal(sent[0].body.receipt_number, '2-00019');
  assert.equal((await listRecords()).length, 0, 'and it clears from the outbox on success');
});

// ── A refused duplicate is recoverable, not lost ────────────────────────────

test('a 409 on a duplicated receipt number lands in the attention list, not the void', async () => {
  captureSends(() => {
    const err = new Error('Receipt number 3-00042 is already used by a different order.');
    err.status = 409;
    throw err;
  });
  await enqueue({
    entityType: 'order', endpoint: '/orders', payload: { customer_id: 2 },
    profileKey: 'josie', receiptNumber: '3-00042',
  });

  const result = await drainOutbox();

  assert.equal(result.sent, 0);
  const [record] = await listRecords();
  assert.equal(record.status, 'needs_attention');
  assert.match(record.last_error, /already used by a different order/,
    'the operator is told what happened — the outcome ADR 0017 #9 trades data loss for');
});
