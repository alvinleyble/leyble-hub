// A record the server keeps answering with a 5xx is a problem with that record, not
// with the line. The drain used to call markOffline() after every such pass, so the
// /health watcher flipped the device back online about 7 seconds later, drained, hit
// the same record and went offline again — the status light and every online-only
// action flipping back and forth for the five minutes the record takes to park
// (found in review of the park-after-failures change, 2026-11-08).
//
// What stays: a network failure or the client's own timeout still takes the device
// offline, and so does a 5xx when /health itself does not answer. What changes: a 5xx
// from a server that is plainly there leaves the device online.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import './render.mjs'; // jsdom globals — api/client.js reads window/localStorage on import

import { api } from '../src/api/client.js';
import { __resetMemoryBackend } from '../src/offline/nativeStore.js';
import {
  enqueue, drainOutbox, listRecords, __clearOutbox, NEEDS_ATTENTION, QUEUED,
} from '../src/offline/outbox.js';
import { checkIsOnline, markOnline, __resetStatusState } from '../src/offline/status.js';

const STRIKES = 5;
const DRAIN_LOOP_MS = 30_000; // offline/index.js's DRAIN_INTERVAL_MS
const WRITE_CHECK = '/health/write';

const realNow = Date.now;
const realFetch = globalThis.fetch;
let clock;
let savedRequest;
let sent;
let healthProbes;

beforeEach(async () => {
  __resetMemoryBackend();
  await __clearOutbox();
  __resetStatusState();
  markOnline();
  clock = realNow();
  Date.now = () => clock;
  savedRequest = api.request;
  sent = [];
  healthProbes = 0;
  serveHealth(true);
});

afterEach(() => {
  Date.now = realNow;
  api.request = savedRequest;
  globalThis.fetch = realFetch;
  __resetStatusState();
});

function httpError(status, message = `Request failed (${status})`) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// GET /health, which status.js probes with a bare fetch.
function serveHealth(up) {
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/health')) {
      healthProbes++;
      if (up === null) throw new TypeError('Failed to fetch');
      return { ok: up, status: up ? 200 : 502 };
    }
    throw new Error(`unexpected fetch ${url}`);
  };
}

let nextServerId = 1000;
function serve(failFor, check = () => null) {
  api.request = async (path) => {
    if (path === WRITE_CHECK) {
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

async function drainLater(ms) {
  clock += ms;
  return drainOutbox();
}

// What the device's connection state does after each pass, the way the status light
// and every `checkIsOnline` gate see it. Offline would start status.js's /health
// watcher, which finds the server up, marks the device online and drains again — the
// flip. `markOnline()` stands in for that recovery so the next pass starts from the
// same place the real watcher would leave it.
async function passesUntilParked(id, intervalMs) {
  const wentOffline = [];
  for (let pass = 1; pass <= 20; pass++) {
    await drainLater(intervalMs);
    if (!checkIsOnline(true)) {
      wentOffline.push(pass);
      markOnline();
    }
    if ((await stored(id))?.status === NEEDS_ATTENTION) return { pass, wentOffline };
  }
  return { pass: null, wentOffline };
}

test('a lone record the server keeps answering with a 5xx never takes the device offline, and still parks after 5 strikes', async () => {
  serve((path) => (path === '/bad' ? httpError(500, 'Internal server error') : null));
  const bad = await queue('/bad');

  const { pass, wentOffline } = await passesUntilParked(bad.id, DRAIN_LOOP_MS);

  assert.deepEqual(wentOffline, [], 'no pass marks the device offline');
  assert.equal(pass, 9, 'parked on the drain loop\'s 9th pass, 4 minutes after the first strike');
  const parked = await stored(bad.id);
  assert.ok(parked, 'never deleted');
  assert.equal(parked.status, NEEDS_ATTENTION);
  assert.equal(parked.server_strikes, STRIKES);
  assert.equal(healthProbes, 0, 'a passing write check already proves the server is there');
});

test('a 5xx whose write check also fails stays online while /health answers', async () => {
  // The database refusing writes, or a server that predates the check: the server is
  // still answering, so this says nothing about the line either.
  for (const checkFailure of [() => httpError(503, 'Database is not accepting writes'), () => httpError(404)]) {
    __resetMemoryBackend();
    await __clearOutbox();
    markOnline();
    serve(() => httpError(500), checkFailure);
    const bad = await queue('/bad');

    for (let pass = 0; pass < 6; pass++) {
      await drainLater(DRAIN_LOOP_MS);
      assert.equal(checkIsOnline(true), true, `pass ${pass + 1}: still online`);
    }
    const record = await stored(bad.id);
    assert.equal(record.status, QUEUED, 'no strike, so nothing parks');
    assert.equal(record.attempts, 6);
  }
});

test('a 5xx while /health does not answer still takes the device offline', async () => {
  // A gateway answering 502 for a server that is down: /health says so too.
  for (const health of [false, null]) {
    __resetMemoryBackend();
    await __clearOutbox();
    markOnline();
    serveHealth(health);
    serve(() => httpError(502, 'Bad gateway'), () => httpError(502, 'Bad gateway'));
    const bad = await queue('/bad');

    await drainLater(DRAIN_LOOP_MS);

    assert.equal(checkIsOnline(true), false, `/health ${health === null ? 'unreachable' : 'not ok'}: offline`);
    assert.equal((await stored(bad.id)).status, QUEUED);
  }
});

test('a network failure or the client timeout on the record still takes the device offline', async () => {
  const timeout = () => Object.assign(new Error('The connection timed out.'), { name: 'AbortError', timedOut: true });
  for (const failure of [() => new TypeError('Failed to fetch'), timeout]) {
    __resetMemoryBackend();
    await __clearOutbox();
    markOnline();
    serve(failure);
    const record = await queue('/orders');
    const behind = await queue('/orders/next');

    await drainLater(1);

    assert.equal(checkIsOnline(true), false);
    assert.deepEqual(sent.slice(-1), ['/orders'], 'the pass stops at it');
    assert.equal((await stored(record.id)).status, QUEUED);
    assert.equal((await stored(behind.id)).attempts, 0);
  }
});
