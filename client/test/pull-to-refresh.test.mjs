// Refresh without a refresh button: pull the page down from its top, or tap the tab
// (or menu item) of the page that is already open. Both run one shared routine (offline/refresh.js)
// that checks the line, sends what is waiting, and asks the page on screen to reload.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, React, act } from './render.mjs';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { api } from '../src/api/client.js';
import { AuthProvider, __setIsNativeForTest } from '../src/context/AuthContext.jsx';
import { ToastProvider } from '../src/components/ui/Toast.jsx';
import { markOnline } from '../src/offline/status.js';
import { refreshApp, useRefreshListener, REFRESH_EVENT } from '../src/offline/refresh.js';
import { useAppRefresh } from '../src/components/layout/useAppRefresh.js';
import { usePullToRefresh, shouldIgnorePull, PULL_THRESHOLD } from '../src/components/layout/usePullToRefresh.js';

import { isCurrentPage } from '../src/components/layout/navigation.js';

const TopTabBar = (await import('../src/components/layout/TopTabBar.jsx')).default;
const MenuDrawer = (await import('../src/components/layout/MenuDrawer.jsx')).default;

const h = React.createElement;

function setOnLine(value) {
  Object.defineProperty(navigator, 'onLine', { value, configurable: true });
}

let originalApiGet;
beforeEach(() => {
  originalApiGet = api.get;
  __setIsNativeForTest(false);
  localStorage.clear();
  setOnLine(true);
});
afterEach(() => {
  api.get = originalApiGet;
  setOnLine(true);
  // markOffline() starts the reachability watcher; markOnline() stops it, so no timer
  // outlives the test.
  markOnline();
});

// ── The shared routine ────────────────────────────────────────────────────────

test('refreshApp: dispatches leyble:refresh and waits for the page reloads it was handed', async () => {
  let resolveReload;
  let reloadSettled = false;
  const onRefresh = (event) => {
    event.detail.waitUntil(new Promise((resolve) => { resolveReload = resolve; })
      .then(() => { reloadSettled = true; }));
  };
  window.addEventListener(REFRESH_EVENT, onRefresh);
  try {
    let done = false;
    const run = refreshApp().then((res) => { done = true; return res; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(done, false, 'still refreshing while the page reload is outstanding');
    assert.equal(refreshApp(), refreshApp(), 'overlapping calls share one run');
    resolveReload();
    const { online } = await run;
    assert.equal(reloadSettled, true);
    assert.equal(online, true);
  } finally {
    window.removeEventListener(REFRESH_EVENT, onRefresh);
  }
});

test('refreshApp: a hung reload cannot hold the spinner past the cap', async () => {
  const onRefresh = (event) => event.detail.waitUntil(new Promise(() => {}));
  window.addEventListener(REFRESH_EVENT, onRefresh);
  try {
    const { online } = await refreshApp({ waitCapMs: 30 });
    assert.equal(online, true);
  } finally {
    window.removeEventListener(REFRESH_EVENT, onRefresh);
  }
});

test('refreshApp: reports offline when the line is down, and still reloads the page', async () => {
  setOnLine(false);
  let detail = null;
  const onRefresh = (event) => { detail = event.detail; };
  window.addEventListener(REFRESH_EVENT, onRefresh);
  try {
    const { online } = await refreshApp();
    assert.equal(online, false);
    assert.equal(detail?.online, false, 'the page still hears the refresh and falls back to what it holds');
  } finally {
    window.removeEventListener(REFRESH_EVENT, onRefresh);
  }
});

test('useRefreshListener: calls the latest handler and hands its promise to the refresh', async () => {
  const calls = [];
  function Page({ label }) {
    useRefreshListener(() => { calls.push(label); return Promise.resolve(); });
    return h('p', null, label);
  }
  const view = render(h(Page, { label: 'first' }));
  act(() => { view.unmount(); });
  const view2 = render(h(Page, { label: 'second' }));
  await refreshApp();
  assert.deepEqual(calls, ['second'], 'an unmounted page no longer listens');
  view2.unmount();
});

// ── Feedback: quiet on success, speaks when offline or failed ─────────────────

function RefreshHarness() {
  const { refresh, refreshing } = useAppRefresh();
  return h('div', null,
    h('button', { type: 'button', onClick: refresh, 'data-testid': 'go' }, 'go'),
    refreshing ? h('span', { 'data-testid': 'busy' }, 'busy') : null);
}

async function runHarnessRefresh() {
  const view = render(h(ToastProvider, null, h(RefreshHarness)));
  view.click(view.container.querySelector('[data-testid="go"]'));
  assert.ok(view.container.querySelector('[data-testid="busy"]'), 'spinner shows while refreshing');
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 450)); });
  assert.equal(view.container.querySelector('[data-testid="busy"]'), null, 'spinner clears when done');
  return view;
}

test('useAppRefresh: a successful refresh shows no message', async () => {
  const view = await runHarnessRefresh();
  assert.doesNotMatch(view.text(), /refreshed|online|offline/i);
  view.unmount();
});

test('useAppRefresh: offline says so', async () => {
  setOnLine(false);
  const view = await runHarnessRefresh();
  assert.match(view.text(), /offline/i);
  view.unmount();
});

test('useAppRefresh: a broken refresh says it failed', async () => {
  // A throwing page listener is reported by the DOM, never thrown to the dispatcher, so
  // break the routine itself: make the event it dispatches impossible to build.
  const OriginalCustomEvent = window.CustomEvent;
  window.CustomEvent = function Broken() { throw new Error('boom'); };
  try {
    const view = await runHarnessRefresh();
    assert.match(view.text(), /Refresh failed/);
    view.unmount();
  } finally {
    window.CustomEvent = OriginalCustomEvent;
  }
});

// ── Re-tapping the open page's tab ────────────────────────────────────────────

test('isCurrentPage: exact page only — a sub-page is not the page', () => {
  assert.equal(isCurrentPage('/orders', '/orders'), true);
  assert.equal(isCurrentPage('/orders/', '/orders'), true);
  assert.equal(isCurrentPage('/orders/12', '/orders'), false);
  assert.equal(isCurrentPage('/inventory', '/orders'), false);
});

function Where() {
  return h('output', { 'data-testid': 'where' }, useLocation().pathname);
}

async function renderNavAt(path, component, props) {
  api.get = async (p) => {
    if (p === '/auth/me') return { id: 1, email: 'josie@leyblestore.com', full_name: 'Josie', role: 'admin' };
    return [];
  };
  const view = render(h(AuthProvider, null,
    h(Routes, null, h(Route, { path: '/', element: h(Navigate, { to: path, replace: true }) }), h(Route, { path: '*', element: null })),
    h(Where),
    h(component, props)));
  await act(async () => { await Promise.resolve(); });
  return view;
}

const whereOf = (view) => view.container.querySelector('[data-testid="where"]').textContent;
const link = (view, name) => view.container.querySelector(`[data-testid="nav-link-${name}"]`);

test('Tab bar: tapping the tab of the page already open refreshes it instead of navigating', async () => {
  let refreshed = 0;
  const view = await renderNavAt('/orders', TopTabBar, { onRefresh: () => { refreshed += 1; }, onOpenMenu: () => {} });
  assert.equal(whereOf(view), '/orders');

  view.click(link(view, 'orders'));
  assert.equal(refreshed, 1, 'Outgoing on Outgoing refreshes');
  assert.equal(whereOf(view), '/orders');

  view.click(link(view, 'inventory'));
  assert.equal(refreshed, 1, 'a different tab is an ordinary navigation');
  assert.equal(whereOf(view), '/inventory');

  view.click(link(view, 'inventory'));
  assert.equal(refreshed, 2, 'and re-tapping that one refreshes it in turn');
  view.unmount();
});

test('Tab bar: from a sub-page, the section tab navigates back rather than refreshing', async () => {
  let refreshed = 0;
  const view = await renderNavAt('/orders/12', TopTabBar, { onRefresh: () => { refreshed += 1; }, onOpenMenu: () => {} });
  view.click(link(view, 'orders'));
  assert.equal(refreshed, 0);
  assert.equal(whereOf(view), '/orders');
  view.unmount();
});

test('Menu: re-tapping the open page refreshes it, and every tap closes the menu', async () => {
  let refreshed = 0;
  let closed = 0;
  const view = await renderNavAt('/tickets', MenuDrawer, {
    open: true, onRefresh: () => { refreshed += 1; }, onClose: () => { closed += 1; },
  });
  view.click(link(view, 'tickets'));
  assert.equal(refreshed, 1, 'Tickets on Tickets refreshes');
  assert.equal(closed, 1);
  assert.equal(whereOf(view), '/tickets');

  view.click(link(view, 'audit'));
  assert.equal(refreshed, 1);
  assert.equal(closed, 2);
  assert.equal(whereOf(view), '/audit');
  view.unmount();
});

// ── Pull-down ─────────────────────────────────────────────────────────────────

function touch(target, type, points) {
  const event = new window.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'touches', { value: points.map(([clientX, clientY]) => ({ clientX, clientY })) });
  act(() => { target.dispatchEvent(event); });
  return event;
}

function PullHarness({ onRefresh }) {
  const ref = React.useRef(null);
  const pull = usePullToRefresh(ref, { onRefresh });
  return h('main', { ref, 'data-testid': 'scroller', 'data-pull': String(pull) },
    h('p', { 'data-testid': 'content' }, 'rows'),
    h('div', { 'data-testid': 'sheet', style: { position: 'fixed' } }, h('p', { 'data-testid': 'in-sheet' }, 'modal')),
    h('div', { 'data-testid': 'inner' }, h('p', { 'data-testid': 'in-inner' }, 'list')));
}

function renderPull() {
  let count = 0;
  const view = render(h(PullHarness, { onRefresh: () => { count += 1; } }));
  const q = (id) => view.container.querySelector(`[data-testid="${id}"]`);
  return { view, q, refreshes: () => count };
}

function drag(target, from, to, { end = 'touchend' } = {}) {
  touch(target, 'touchstart', [from]);
  const steps = 6;
  let last;
  for (let i = 1; i <= steps; i += 1) {
    last = touch(target, 'touchmove', [[from[0] + ((to[0] - from[0]) * i) / steps, from[1] + ((to[1] - from[1]) * i) / steps]]);
  }
  touch(target, end, []);
  return last;
}

const FAR = PULL_THRESHOLD * 2 + 40;

test('pull-down: pulling far enough from the top refreshes, and the pull shows while dragging', () => {
  const { view, q, refreshes } = renderPull();
  touch(q('content'), 'touchstart', [[100, 10]]);
  const move = touch(q('content'), 'touchmove', [[100, 10 + FAR]]);
  assert.ok(Number(q('scroller').dataset.pull) >= PULL_THRESHOLD, 'indicator follows the finger');
  assert.equal(move.defaultPrevented, true, 'the WebView does not scroll/overscroll under a live pull');
  touch(q('content'), 'touchend', []);
  assert.equal(refreshes(), 1);
  assert.equal(q('scroller').dataset.pull, '0');
  view.unmount();
});

test('pull-down: a short pull springs back without refreshing', () => {
  const { view, q, refreshes } = renderPull();
  drag(q('content'), [100, 10], [100, 40]);
  assert.equal(refreshes(), 0);
  view.unmount();
});

test('pull-down: only from the top — a scrolled page just scrolls', () => {
  const { view, q, refreshes } = renderPull();
  Object.defineProperty(q('scroller'), 'scrollTop', { value: 120, configurable: true });
  drag(q('content'), [100, 10], [100, 10 + FAR]);
  assert.equal(refreshes(), 0);
  view.unmount();
});

test('pull-down: a sideways swipe is left to horizontal scrollers', () => {
  const { view, q, refreshes } = renderPull();
  const last = drag(q('content'), [10, 10], [10 + FAR * 2, 10 + FAR]);
  assert.equal(refreshes(), 0);
  assert.equal(last.defaultPrevented, false);
  view.unmount();
});

test('pull-down: an upward swipe scrolls as normal', () => {
  const { view, q, refreshes } = renderPull();
  drag(q('content'), [100, 300], [100, 300 - FAR]);
  assert.equal(refreshes(), 0);
  view.unmount();
});

test('pull-down: a cancelled touch never refreshes', () => {
  const { view, q, refreshes } = renderPull();
  drag(q('content'), [100, 10], [100, 10 + FAR], { end: 'touchcancel' });
  assert.equal(refreshes(), 0);
  view.unmount();
});

test('pull-down: modals/drawers and a scrolled inner list keep their own gesture', () => {
  const { view, q, refreshes } = renderPull();
  drag(q('in-sheet'), [100, 10], [100, 10 + FAR]);
  assert.equal(refreshes(), 0, 'a fixed overlay (modal, drawer, bottom sheet) is not the page');

  Object.defineProperty(q('inner'), 'scrollTop', { value: 50, configurable: true });
  drag(q('in-inner'), [100, 10], [100, 10 + FAR]);
  assert.equal(refreshes(), 0, 'an inner list not at its top scrolls itself up first');

  assert.equal(shouldIgnorePull(q('content'), q('scroller')), false);
  assert.equal(shouldIgnorePull(document.body, q('scroller')), true, 'outside the page');
  view.unmount();
});
