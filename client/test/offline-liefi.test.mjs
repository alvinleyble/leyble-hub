// Lie-Fi detection: a network that LOOKS up (navigator.onLine stays true, the wifi
// icon is full) but silently black-holes requests — a captive portal, a dead upstream
// link that still accepts the TCP handshake. Before this, a black-holed request rode
// the browser's own 60-120s fetch timeout before anything told the operator; nothing
// then watched for the line coming back except whatever screen happened to have
// useOfflineStatus mounted.
//
// Covers:
// 1. client.js's request() aborts a black-holed request after REQUEST_TIMEOUT_MS and
//    calls markOffline() immediately — but not for a caller-initiated abort, and not
//    for an ordinary HTTP error where the server was actually reached.
// 2. status.js's reachability watcher: starts itself on markOffline(), probes GET
//    /health on a short interval, flips back online (markOnline + 'online' event +
//    drainOutbox) the moment the probe succeeds, never runs two probes concurrently,
//    survives a failed probe with no unhandled rejection, and leaves no interval
//    running once recovered.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './render.mjs'; // jsdom globals

import { api } from '../src/api/client.js';
import { __resetMemoryBackend } from '../src/offline/nativeStore.js';
import {
  checkIsOnline, markOffline, markOnline, startReachabilityWatcher, stopReachabilityWatcher,
  __resetStatusState,
} from '../src/offline/status.js';
import { __clearOutbox } from '../src/offline/outbox.js';

async function flush() {
  // Real macrotask tick — lets pending microtasks/promise chains settle. setImmediate
  // rather than setTimeout(0) deliberately: several tests here fake setTimeout (or
  // setInterval) via mock.timers, and this helper must stay real regardless of which
  // timer API a given test is faking.
  await new Promise((resolve) => setImmediate(resolve));
}

async function resetAll() {
  __resetMemoryBackend();
  await __clearOutbox();
  __resetStatusState();
}

// ── client.js: request timeout ────────────────────────────────────────────────

test('a black-holed request aborts after the timeout threshold and marks offline immediately', async () => {
  await resetAll();
  markOnline();
  assert.equal(checkIsOnline(true), true);

  const originalFetch = globalThis.fetch;
  let sawSignal = false;
  globalThis.fetch = (_url, opts) => new Promise((resolve, reject) => {
    sawSignal = Boolean(opts.signal);
    // Never resolves on its own — this IS the black hole. The only way out is the
    // abort our own timeout fires.
    opts.signal.addEventListener('abort', () => {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      reject(err);
    });
  });

  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const pending = api.get('/orders');
    // Several plain awaits (token/profile lookups) run before request() reaches its
    // own setTimeout call — flush those first so the fake timer is actually armed
    // before we advance virtual time.
    await flush();

    // Not due yet — well short of the timeout.
    mock.timers.tick(3000);
    assert.equal(checkIsOnline(true), true, 'must not flip offline before the deadline');

    // Crosses the threshold: the request must abort now, not 60-120s from now.
    mock.timers.tick(2000);

    await assert.rejects(pending, (err) => {
      assert.equal(err.timedOut, true, 'the rejection must be attributable to our own timeout');
      return true;
    });

    assert.ok(sawSignal, 'fetch must receive an AbortSignal');
    assert.equal(checkIsOnline(true), false, 'a black-holed request must mark the app offline immediately');
  } finally {
    mock.timers.reset();
    globalThis.fetch = originalFetch;
    await resetAll();
  }
});

test('a caller-initiated abort is not read as a network failure and does not mark offline', async () => {
  await resetAll();
  markOnline();

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (_url, opts) => new Promise((_resolve, reject) => {
    const rejectAborted = () => {
      const err = new Error('The user aborted a request');
      err.name = 'AbortError';
      reject(err);
    };
    // The caller's own abort() (below) fires before request() ever reaches this fetch
    // call — several plain awaits (token/profile lookups) sit in between — so the
    // combined signal here can already be aborted by the time this mock runs at all.
    if (opts.signal.aborted) rejectAborted();
    else opts.signal.addEventListener('abort', rejectAborted);
  });

  const callerController = new AbortController();
  try {
    const pending = api.get('/orders', { signal: callerController.signal });
    callerController.abort();

    await assert.rejects(pending);
    assert.equal(checkIsOnline(true), true, 'a caller cancelling its own request is not a Lie-Fi condition');
  } finally {
    globalThis.fetch = originalFetch;
    await resetAll();
  }
});

test('an HTTP error where the server actually answered is not read as a network failure', async () => {
  await resetAll();
  markOnline();

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 500,
    headers: { get: () => 'application/json' },
    json: async () => ({ error: 'Internal error' }),
    clone() { return this; },
  });

  try {
    await assert.rejects(() => api.get('/orders'), (err) => {
      assert.equal(err.status, 500);
      return true;
    });
    assert.equal(checkIsOnline(true), true, 'the server was reached — this is not the Lie-Fi case');
  } finally {
    globalThis.fetch = originalFetch;
    await resetAll();
  }
});

// ── status.js: reachability recovery watcher ──────────────────────────────────

test('the reachability watcher flips offline to online once GET /health answers, and stops itself', async () => {
  await resetAll();
  markOffline();
  assert.equal(checkIsOnline(true), false);

  const originalFetch = globalThis.fetch;
  let fetchedUrl = null;
  globalThis.fetch = async (url) => {
    fetchedUrl = String(url);
    return { ok: true, json: async () => ({ status: 'ok' }) };
  };

  let onlineEventFired = false;
  const handleOnline = () => { onlineEventFired = true; };
  window.addEventListener('online', handleOnline);

  mock.timers.enable({ apis: ['setInterval'] });
  try {
    startReachabilityWatcher({ enabled: true, intervalMs: 10 });
    mock.timers.tick(10);
    await flush();

    assert.match(fetchedUrl, /\/health/);
    assert.equal(checkIsOnline(true), true, 'a successful probe must flip the app back online');
    assert.equal(onlineEventFired, true, 'recovery must dispatch a real online event for existing listeners');

    // The watcher must not still be ticking after recovery — advancing well past
    // several more intervals must not trigger another fetch.
    fetchedUrl = null;
    mock.timers.tick(1000);
    await flush();
    assert.equal(fetchedUrl, null, 'the watcher must stop itself once reachability is confirmed');
  } finally {
    window.removeEventListener('online', handleOnline);
    stopReachabilityWatcher();
    mock.timers.reset();
    globalThis.fetch = originalFetch;
    await resetAll();
  }
});

test('the reachability watcher never runs two probes concurrently', async () => {
  await resetAll();
  markOffline();

  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  let resolveFetch;
  globalThis.fetch = () => {
    fetchCalls++;
    return new Promise((resolve) => { resolveFetch = resolve; });
  };

  mock.timers.enable({ apis: ['setInterval'] });
  try {
    startReachabilityWatcher({ enabled: true, intervalMs: 10 });

    // Three ticks while the first probe is still in flight — none of them may start
    // a second, overlapping probe.
    mock.timers.tick(10);
    await flush();
    mock.timers.tick(10);
    await flush();
    mock.timers.tick(10);
    await flush();
    assert.equal(fetchCalls, 1, 'a probe already in flight must not be duplicated');

    resolveFetch({ ok: true, json: async () => ({}) });
    await flush();
    assert.equal(checkIsOnline(true), true);
  } finally {
    stopReachabilityWatcher();
    mock.timers.reset();
    globalThis.fetch = originalFetch;
    await resetAll();
  }
});

test('a failed probe keeps retrying with no unhandled promise rejection and no leaked timer', async () => {
  await resetAll();
  markOffline();

  let unhandled = false;
  const onUnhandledRejection = () => { unhandled = true; };
  process.on('unhandledRejection', onUnhandledRejection);

  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new TypeError('still down'); };

  mock.timers.enable({ apis: ['setInterval'] });
  try {
    startReachabilityWatcher({ enabled: true, intervalMs: 10 });

    mock.timers.tick(10);
    await flush();
    mock.timers.tick(10);
    await flush();

    assert.ok(calls >= 2, 'the loop must keep retrying after a failed probe');
    assert.equal(checkIsOnline(true), false, 'a still-failing probe must not flip the app online');
  } finally {
    stopReachabilityWatcher();
    mock.timers.reset();
    globalThis.fetch = originalFetch;
    process.off('unhandledRejection', onUnhandledRejection);
    await resetAll();
  }

  assert.equal(unhandled, false, 'a rejected probe must never surface as an unhandled rejection');
});

test('starting the watcher twice does not create a second interval', async () => {
  await resetAll();
  markOffline();

  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => { fetchCalls++; return { ok: false }; };

  mock.timers.enable({ apis: ['setInterval'] });
  try {
    startReachabilityWatcher({ enabled: true, intervalMs: 10 });
    startReachabilityWatcher({ enabled: true, intervalMs: 10 }); // second call: must be a no-op

    mock.timers.tick(10);
    await flush();

    assert.equal(fetchCalls, 1, 'a duplicate start must not double the probe cadence');
  } finally {
    globalThis.fetch = originalFetch;
    stopReachabilityWatcher();
    mock.timers.reset();
    await resetAll();
  }
});
