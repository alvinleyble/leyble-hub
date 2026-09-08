import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import './render.mjs';
import { render } from './render.mjs';
import { Route, Routes } from 'react-router-dom';

import { formatConnectionError } from '../src/utils/errors.js';
import { api } from '../src/api/client.js';
import { ToastProvider, useToast } from '../src/components/ui/Toast.jsx';
import RefreshButton from '../src/components/layout/RefreshButton.jsx';
import OrderDetailPage from '../src/pages/orders/OrderDetailPage.jsx';

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
}

// ── 1. formatConnectionError ──────────────────────────────────────────────────

test('formatConnectionError: Mode 1 - Thermal Printer Disconnection', () => {
  const expected = 'Thermal printer disconnected. Please check that the printer is powered on and Bluetooth is enabled on this tablet.';

  assert.equal(formatConnectionError({ isPrinterError: true }), expected);
  assert.equal(formatConnectionError(new Error('Bluetooth connection failed')), expected);
  assert.equal(formatConnectionError(new Error('socket hang up')), expected);
  assert.equal(formatConnectionError({ message: 'device disconnected from socket' }), expected);
});

test('formatConnectionError: Mode 2 - 5-Second Timeout / Lie-Fi', () => {
  const expected = 'Connection timed out (5s). The server or internet took too long to respond. Tap Retry to try again.';

  assert.equal(formatConnectionError({ timedOut: true }), expected);
  assert.equal(formatConnectionError({ name: 'AbortError' }), expected);
  const abortErr = new Error('signal is aborted without reason');
  abortErr.name = 'AbortError';
  assert.equal(formatConnectionError(abortErr), expected);
});

test('formatConnectionError: Mode 3 - Server Gateway / Restart', () => {
  const expected = 'Server is temporarily restarting or updating. Please try again in a few moments.';

  assert.equal(formatConnectionError({ status: 502 }), expected);
  assert.equal(formatConnectionError({ status: 503 }), expected);
  assert.equal(formatConnectionError({ status: 504 }), expected);
});

test('formatConnectionError: Mode 4 - Total Offline / Network Failure', () => {
  const expected = 'No internet connection. Operating in offline mode — your changes are safely stored on this tablet.';

  assert.equal(formatConnectionError(new TypeError('Failed to fetch')), expected);
  assert.equal(formatConnectionError(new Error('Network error with no status')), expected);

  // When navigator.onLine is false
  const origOnLine = navigator.onLine;
  try {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    assert.equal(formatConnectionError({ status: 400 }), expected);
  } finally {
    Object.defineProperty(navigator, 'onLine', { value: origOnLine, configurable: true });
  }
});

test('formatConnectionError: Fallback for other errors', () => {
  assert.equal(formatConnectionError({ status: 400, message: 'Invalid input' }), 'Operation failed.');
  assert.equal(formatConnectionError({ status: 500, message: 'Crash' }, 'Custom fallback'), 'Custom fallback');
});

// ── 2. API Client Timeout & Retry Mechanics ───────────────────────────────────

test('api client: GET request absorbs transient timeout via 1-shot retry and returns data', async () => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;

  globalThis.fetch = (_url, opts) => new Promise((resolve, reject) => {
    attempts++;
    if (attempts === 1) {
      // First attempt times out
      opts.signal.addEventListener('abort', () => {
        const err = new Error('signal is aborted without reason');
        err.name = 'AbortError';
        reject(err);
      });
    } else {
      // Second attempt succeeds
      resolve({
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => ({ success: true, items: [1, 2, 3] }),
      });
    }
  });

  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const pending = api.get('/test-retry-success');
    await flush();

    // Advance 5000ms for attempt 1 timeout
    mock.timers.tick(5000);
    await flush();

    // Advance 1000ms pause before retry
    mock.timers.tick(1000);
    await flush();

    const result = await pending;
    assert.deepEqual(result, { success: true, items: [1, 2, 3] });
    assert.equal(attempts, 2, 'must have retried once silently');
  } finally {
    mock.timers.reset();
    globalThis.fetch = originalFetch;
  }
});

test('api client: GET request attaches friendlyMessage and rewrites raw message on final timeout', async () => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;

  globalThis.fetch = (_url, opts) => new Promise((_resolve, reject) => {
    attempts++;
    opts.signal.addEventListener('abort', () => {
      const err = new Error('signal is aborted without reason');
      err.name = 'AbortError';
      reject(err);
    });
  });

  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const pending = api.get('/test-retry-exhausted');
    await flush();

    // Attempt 1 timeout
    mock.timers.tick(5000);
    await flush();

    // Pause
    mock.timers.tick(1000);
    await flush();

    // Attempt 2 timeout
    mock.timers.tick(5000);

    await assert.rejects(pending, (err) => {
      assert.equal(err.timedOut, true);
      assert.match(err.friendlyMessage, /Connection timed out \(5s\)/);
      assert.equal(err.message, err.friendlyMessage, 'must replace raw engine abort message with friendly message');
      return true;
    });
    assert.equal(attempts, 2, 'attempted initial + 1 retry');
  } finally {
    mock.timers.reset();
    globalThis.fetch = originalFetch;
  }
});

test('api client: POST request does NOT auto-retry on timeout', async () => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;

  globalThis.fetch = (_url, opts) => new Promise((_resolve, reject) => {
    attempts++;
    opts.signal.addEventListener('abort', () => {
      const err = new Error('signal is aborted without reason');
      err.name = 'AbortError';
      reject(err);
    });
  });

  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const pending = api.post('/test-no-post-retry', { action: 'pay' });
    await flush();

    // Attempt 1 timeout
    mock.timers.tick(5000);

    await assert.rejects(pending, (err) => {
      assert.equal(err.timedOut, true);
      return true;
    });
    assert.equal(attempts, 1, 'POST must not retry automatically to prevent duplicate mutations');
  } finally {
    mock.timers.reset();
    globalThis.fetch = originalFetch;
  }
});

// ── 3. Actionable Toasts ──────────────────────────────────────────────────────

test('Toast: supports action property and invokes action onClick', async () => {
  let clicked = false;

  function TestToastConsumer() {
    const { addToast } = useToast();
    return React.createElement(
      'button',
      {
        onClick: () => addToast('Connection failed', 'error', {
          label: 'Retry Now',
          onClick: () => { clicked = true; },
        }),
      },
      'Trigger Toast'
    );
  }

  const r = render(
    React.createElement(
      ToastProvider,
      null,
      React.createElement(TestToastConsumer)
    )
  );

  r.click(r.all('button')[0]);
  await flush();

  assert.ok(r.text().includes('Connection failed'), 'Toast message rendered');
  const actionBtn = r.all('button').find((b) => b.textContent === 'Retry Now');
  assert.ok(actionBtn, 'Retry action button rendered');

  r.click(actionBtn);
  await flush();
  assert.equal(clicked, true, 'action callback executed on click');
});

// ── 4. OrderDetailPage Recovery Card ──────────────────────────────────────────

const { createRoot } = await import('react-dom/client');
const { act } = React;
const { MemoryRouter } = await import('react-router-dom');

function renderAtRoute(path, routePath, element) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      React.createElement(MemoryRouter, { initialEntries: [path] },
        React.createElement(Routes, null,
          React.createElement(Route, { path: routePath, element })
        )
      )
    );
  });
  return {
    container,
    text: () => container.textContent,
    unmount: () => act(() => { root.unmount(); }),
    all: (selector) => [...container.querySelectorAll(selector)],
    byLabel: (label) => container.querySelector(`[aria-label="${label}"]`),
    click: (el) => act(() => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); }),
  };
}

test('OrderDetailPage: renders friendly recovery card on network failure with Try Again button', async () => {
  const originalGet = api.get;
  let getCalls = 0;

  api.get = async () => {
    getCalls++;
    const err = new Error('Failed to fetch');
    err.friendlyMessage = formatConnectionError(err);
    throw err;
  };

  try {
    const r = renderAtRoute(
      '/orders/88888',
      '/orders/:id',
      React.createElement(
        ToastProvider,
        null,
        React.createElement(OrderDetailPage)
      )
    );

    await flush();
    await flush();

    // Verify recovery card appears instead of null
    assert.ok(
      r.text().includes('Unable to reach the server to load this order.'),
      'Recovery card explanatory text rendered'
    );
    assert.ok(r.text().includes('Try Again'), 'Try Again button rendered');
    assert.ok(r.text().includes('Back to Orders'), 'Back to Orders button rendered');

    // Click Try Again
    const tryAgainBtn = r.all('button').find((b) => b.textContent.includes('Try Again'));
    assert.ok(tryAgainBtn);
    r.click(tryAgainBtn);
    await flush();
    await flush();

    assert.ok(getCalls >= 2, 'Try Again button triggered reload');
  } finally {
    api.get = originalGet;
  }
});

// ── 5. Header Refresh Button ──────────────────────────────────────────────────

test('RefreshButton: dispatches leyble:refresh and shows toast when clicked', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    return { ok: true, json: async () => ({ status: 'ok' }) };
  };

  let sawRefreshEvent = false;
  const onRefresh = () => { sawRefreshEvent = true; };
  window.addEventListener('leyble:refresh', onRefresh);

  try {
    const r = render(
      React.createElement(
        ToastProvider,
        null,
        React.createElement(RefreshButton, { variant: 'v1' })
      )
    );

    const btn = r.byLabel('Refresh connection and sync');
    assert.ok(btn, 'Refresh button rendered with aria-label');

    r.click(btn);
    await flush();
    await new Promise((resolve) => setTimeout(resolve, 600));
    await flush();

    assert.equal(sawRefreshEvent, true, 'dispatched leyble:refresh event');
    assert.ok(
      r.text().includes('Connection refreshed') || r.text().includes('Refreshed'),
      'toast message rendered'
    );
  } finally {
    window.removeEventListener('leyble:refresh', onRefresh);
    globalThis.fetch = originalFetch;
  }
});
