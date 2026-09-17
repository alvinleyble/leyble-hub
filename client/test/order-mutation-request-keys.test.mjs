// The client half of exactly-once order mutations (migration 050, intentKeys.js).
//
// api/client.js aborts every request after REQUEST_TIMEOUT_MS. The abort is client-side
// only, so the server may well have committed — and the operator, told the save failed,
// taps Save again. These tests pin the rule that makes that second tap safe: the same
// intent carries the same `request_key` for as long as its outcome is unknown, and a
// fresh one the moment the server has answered.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import './render.mjs'; // jsdom globals

import { api } from '../src/api/client.js';
import {
  prepareMutationKey, rememberMutationKey, forgetMutationKey, __resetMutationKeys,
} from '../src/offline/intentKeys.js';
import { markOnline, __resetStatusState, stopReachabilityWatcher } from '../src/offline/status.js';
import { __resetMemoryBackend } from '../src/offline/nativeStore.js';

const keyOf = (bodyString) => JSON.parse(bodyString).request_key;

function reset() {
  __resetMutationKeys();
  __resetMemoryBackend();
  __resetStatusState();
  stopReachabilityWatcher();
  markOnline();
}

// ── intentKeys.js: what counts as one intent ─────────────────────────────────

test('only mutations of an existing order are keyed', async () => {
  reset();
  const body = JSON.stringify({ notes: 'x' });

  assert.ok(prepareMutationKey('/orders/12', 'PATCH', body));
  assert.ok(prepareMutationKey('/orders/1A-00042/adjustment', 'PATCH', body));
  assert.ok(prepareMutationKey('/orders/12/status', 'POST', body));
  assert.ok(prepareMutationKey('/orders/12/close', 'POST', body));
  assert.ok(prepareMutationKey('/orders/12/receipt-printed', 'POST', body));
  assert.ok(prepareMutationKey('/orders/12/finalize', 'POST', body));

  // A create is deliberately left alone: it already has its own identity on the wire
  // (the outbox record's key, the receipt number as the pre-039 fallback), and deriving
  // one from its body would let two separate sales of the same goods collapse into one.
  assert.equal(prepareMutationKey('/orders', 'POST', body), null);
  assert.equal(prepareMutationKey('/orders/12', 'GET', body), null);
  assert.equal(prepareMutationKey('/orders/12', 'DELETE', body), null);
  assert.equal(prepareMutationKey('/customers/12', 'PATCH', body), null);
  assert.equal(prepareMutationKey('/orders/12', 'PATCH', undefined), null);
});

test('a body that already carries a key — the outbox\'s own — is passed through untouched', async () => {
  reset();
  const queued = JSON.stringify({ status: 'in_transit', request_key: 'rk_fromtheoutbox' });
  assert.equal(prepareMutationKey('/orders/1A-00042/status', 'POST', queued), null);
});

test('the revision is not part of the intent, so a refreshed retry reuses the key', async () => {
  reset();
  const first = prepareMutationKey('/orders/12', 'PATCH',
    JSON.stringify({ notes: 'Fix price', revision: '3' }));
  rememberMutationKey(first.signature, first.key);

  // foregroundOrderSync has refreshed the screen in the meantime, so the retry holds the
  // revision the failed-but-committed write itself produced. Keying on the body verbatim
  // would mint a new key here and commit the edit twice.
  const retry = prepareMutationKey('/orders/12', 'PATCH',
    JSON.stringify({ notes: 'Fix price', revision: '4' }));
  assert.equal(retry.key, first.key);
  assert.equal(keyOf(retry.body), first.key);
});

test('a different edit, and any edit after the server has answered, gets a fresh key', async () => {
  reset();
  const first = prepareMutationKey('/orders/12', 'PATCH',
    JSON.stringify({ notes: 'Fix price', revision: '3' }));
  rememberMutationKey(first.signature, first.key);

  const other = prepareMutationKey('/orders/12', 'PATCH',
    JSON.stringify({ notes: 'Something else', revision: '3' }));
  assert.notEqual(other.key, first.key, 'a different body is a different write');

  forgetMutationKey(first.signature);
  const afterAnswer = prepareMutationKey('/orders/12', 'PATCH',
    JSON.stringify({ notes: 'Fix price', revision: '4' }));
  assert.notEqual(
    afterAnswer.key, first.key,
    'once the server has answered, retyping the same values is a new write, not a replay'
  );
});

// ── api/client.js: the wire ──────────────────────────────────────────────────

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => (name === 'Content-Type' ? 'application/json' : null) },
    json: async () => payload,
    clone: () => jsonResponse(payload, status),
  };
}

test('the same failed edit, retried, goes out under the key the first attempt used', async () => {
  reset();
  const originalFetch = globalThis.fetch;
  const sent = [];
  try {
    globalThis.fetch = (_url, opts) => {
      sent.push(JSON.parse(opts.body));
      const err = new Error('Failed to fetch');
      err.name = 'TypeError';
      return Promise.reject(err);
    };
    await assert.rejects(api.patch('/orders/12', { notes: 'Fix price', revision: '3' }));

    globalThis.fetch = (_url, opts) => {
      sent.push(JSON.parse(opts.body));
      return Promise.resolve(jsonResponse({ id: 12, notes: 'Fix price', revision: '4' }));
    };
    await api.patch('/orders/12', { notes: 'Fix price', revision: '4' });

    assert.equal(sent.length, 2);
    assert.ok(sent[0].request_key);
    assert.equal(
      sent[1].request_key, sent[0].request_key,
      'the retry must reuse the key so the server can recognise it as the same attempt'
    );

    // The server answered, so the question is settled: the next save is a new write.
    globalThis.fetch = (_url, opts) => {
      sent.push(JSON.parse(opts.body));
      return Promise.resolve(jsonResponse({ id: 12, notes: 'Fix price', revision: '5' }));
    };
    await api.patch('/orders/12', { notes: 'Fix price', revision: '5' });
    assert.notEqual(sent[2].request_key, sent[0].request_key);
  } finally {
    globalThis.fetch = originalFetch;
    stopReachabilityWatcher();
  }
});

test('an HTTP refusal settles the key too — the next attempt is a new write', async () => {
  reset();
  const originalFetch = globalThis.fetch;
  const sent = [];
  try {
    globalThis.fetch = (_url, opts) => {
      sent.push(JSON.parse(opts.body));
      return Promise.resolve(jsonResponse(
        { code: 'stale_write', error: 'changed elsewhere', order: { id: 12, revision: '9' } }, 409
      ));
    };
    await assert.rejects(api.patch('/orders/12', { notes: 'Fix price', revision: '3' }));

    globalThis.fetch = (_url, opts) => {
      sent.push(JSON.parse(opts.body));
      return Promise.resolve(jsonResponse({ id: 12, revision: '10' }));
    };
    await api.patch('/orders/12', { notes: 'Fix price', revision: '9' });

    assert.equal(sent.length, 2);
    assert.notEqual(
      sent[1].request_key, sent[0].request_key,
      'a 409 is an answer: the write did not happen, so the next one is not a replay'
    );
  } finally {
    globalThis.fetch = originalFetch;
    stopReachabilityWatcher();
  }
});

test('a create is never keyed from its body', async () => {
  reset();
  const originalFetch = globalThis.fetch;
  const sent = [];
  try {
    globalThis.fetch = (_url, opts) => {
      sent.push(JSON.parse(opts.body));
      return Promise.resolve(jsonResponse({ id: 99 }, 201));
    };
    await api.post('/orders', { customer_id: 1, status: 'draft' });
    assert.equal(sent[0].request_key, undefined);
  } finally {
    globalThis.fetch = originalFetch;
    stopReachabilityWatcher();
  }
});
