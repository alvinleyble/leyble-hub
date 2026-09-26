// The top bar that replaced the sidebar: a title row (Leyble Hub, then the status light
// and the hamburger at the far right), six tabs under it across the full width on every
// screen size, and the menu behind the hamburger.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render as rawRender, React, act } from './render.mjs';
import { Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import { api } from '../src/api/client.js';
import { AuthProvider, __setIsNativeForTest } from '../src/context/AuthContext.jsx';
import { ToastProvider } from '../src/components/ui/Toast.jsx';
import { nativeStore, __resetMemoryBackend } from '../src/offline/nativeStore.js';
import { REFRESH_EVENT } from '../src/offline/refresh.js';
import { TAB_ITEMS, MENU_ITEMS } from '../src/components/layout/navigation.js';
import { lightStatus } from '../src/components/layout/StatusLight.jsx';
import {
  nextSeenCount, shouldShowBubble, SEEN_DUPLICATES_KEY,
} from '../src/components/layout/useDuplicateBubble.js';

const TopTabBar = (await import('../src/components/layout/TopTabBar.jsx')).default;
const MenuDrawer = (await import('../src/components/layout/MenuDrawer.jsx')).default;
const { StatusLightButton } = await import('../src/components/layout/StatusLight.jsx');
const { readFileSync } = await import('node:fs');
const TopTabBarSource = readFileSync(new URL('../src/components/layout/TopTabBar.jsx', import.meta.url), 'utf8');

const h = React.createElement;

// A failed assertion must not leave a tree mounted: its polling timers would keep the
// test process alive until the runner kills the whole file.
const mounted = [];
function render(element) {
  const view = rawRender(element);
  let live = true;
  const unmount = () => { if (live) { live = false; view.unmount(); } };
  const tracked = { ...view, unmount };
  mounted.push(tracked);
  return tracked;
}

function setOnLine(value) {
  Object.defineProperty(navigator, 'onLine', { value, configurable: true });
}

let originalApiGet;
beforeEach(() => {
  originalApiGet = api.get;
  __setIsNativeForTest(false);
  __resetMemoryBackend();
  localStorage.clear();
  setOnLine(true);
});
afterEach(() => {
  while (mounted.length) mounted.pop().unmount();
  api.get = originalApiGet;
  setOnLine(true);
});

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

// Two customers sharing a name and address are a possible duplicate pair (both flagged).
const customer = (id, name) => ({ id, name, phone: null, address: 'Antipolo', is_active: true });

let navigateTo = null;
function NavigateHandle() {
  navigateTo = useNavigate();
  return null;
}

async function renderAt(path, element) {
  const view = render(h(AuthProvider, null,
    h(Routes, null, h(Route, { path: '/', element: h(Navigate, { to: path, replace: true }) }), h(Route, { path: '*', element: null })),
    h(NavigateHandle),
    element));
  await flush();
  return view;
}

// ── Tabs ──────────────────────────────────────────────────────────────────────

test('the six tabs run Dashboard → Personnel, each named even when only its icon shows', async () => {
  api.get = async () => [];
  const view = await renderAt('/dashboard', h(TopTabBar, { onOpenMenu: () => {} }));
  const tabs = view.all('nav[aria-label="Main navigation"] a');
  assert.deepEqual(tabs.map((a) => a.getAttribute('href')),
    ['/dashboard', '/orders', '/incoming', '/inventory', '/customers', '/personnel']);
  assert.deepEqual(tabs.map((a) => a.textContent.trim()),
    ['Dashboard', 'Outgoing', 'Incoming', 'Inventory', 'Customers', 'Personnel'],
    'no "Orders" or "Supplies" words; the name is in the DOM (sr-only on phones)');
  for (const a of tabs) {
    const name = a.querySelector('.sr-only');
    assert.ok(name && name.className.includes('sm:not-sr-only'), `${a.textContent} names itself on phones via sr-only text`);
  }
  assert.deepEqual(TAB_ITEMS.map((t) => t.label), tabs.map((a) => a.textContent.trim()));
  view.unmount();
});

test('the page on screen is the active tab, including from one of its sub-pages', async () => {
  api.get = async () => [];
  const view = await renderAt('/orders/12', h(TopTabBar, { onOpenMenu: () => {} }));
  const active = view.all('a[aria-current="page"]');
  assert.equal(active.length, 1);
  assert.equal(active[0].getAttribute('href'), '/orders');
  view.unmount();
});

test('the title row holds Leyble Hub on the left, then the light and the hamburger at the far right', async () => {
  api.get = async () => [];
  let opened = 0;
  const view = await renderAt('/dashboard', h(TopTabBar, { onOpenMenu: () => { opened += 1; } }));
  const header = view.container.querySelector('header');
  const [titleRow, nav] = header.children;
  assert.equal(titleRow.getAttribute('data-testid'), 'app-title-row', 'the title row comes first…');
  assert.equal(nav.getAttribute('aria-label'), 'Main navigation', '…and the tabs sit under it');
  assert.equal(titleRow.firstElementChild.textContent, 'Leyble Hub');
  assert.doesNotMatch(titleRow.textContent, /Josie|Alvin|Luis/, 'no signed-in name under the title');

  assert.equal(nav.querySelector('button'), null, 'nothing but tabs in the tab row');
  assert.equal(nav.querySelector('[data-testid="nav-menu-button"]'), null);
  const buttons = titleRow.querySelectorAll('button');
  const last = buttons[buttons.length - 1];
  assert.equal(last.getAttribute('data-testid'), 'nav-menu-button');
  assert.equal(last.getAttribute('aria-label'), 'Open menu');
  view.click(last);
  assert.equal(opened, 1);
  view.unmount();
});

test('the light sits in the title row, directly left of the hamburger', async () => {
  api.get = async () => [];
  const view = await renderAt('/dashboard', h(TopTabBar, { onOpenMenu: () => {} }));
  const menuButton = view.container.querySelector('[data-testid="nav-menu-button"]');
  const cluster = menuButton.parentElement;
  assert.equal(cluster.closest('[data-testid="app-title-row"]')?.getAttribute('data-testid'), 'app-title-row');
  // StatusLight renders null with the build flag off (always, under test), so the
  // hamburger is the only thing there; the light's own slot is the one just before it.
  assert.equal(cluster.lastElementChild, menuButton);
  assert.match(TopTabBarSource, /<StatusLight \/>\s*<button[\s\S]*?data-testid="nav-menu-button"/,
    'the light is rendered immediately before the hamburger');
  view.unmount();
});

test('the six tabs share the full width in equal segments on every screen size', async () => {
  api.get = async () => [];
  const view = await renderAt('/dashboard', h(TopTabBar, { onOpenMenu: () => {} }));
  const tabs = view.all('nav[aria-label="Main navigation"] a');
  assert.equal(tabs.length, 6);
  for (const a of tabs) {
    assert.match(a.className, /\bflex-1\b/);
    assert.match(a.className, /\bbasis-0\b/, 'equal widths whatever the label length');
    assert.doesNotMatch(a.className, /max-w-/, 'no cap that would leave a gap on wide screens');
  }
  view.unmount();
});

// ── Menu ──────────────────────────────────────────────────────────────────────

test('the menu holds Leyble Hub + close, then Tickets, Audit Log, Settings, Log out', async () => {
  api.get = async (p) => (p === '/auth/me' ? { id: 1, email: 'josie@leyblestore.com', full_name: 'Josie' } : []);
  let closed = 0;
  const view = await renderAt('/dashboard', h(MenuDrawer, { open: true, onClose: () => { closed += 1; } }));
  const menu = view.container.querySelector('[data-testid="nav-menu"]');
  assert.match(menu.textContent, /^Leyble Hub/);
  assert.doesNotMatch(menu.textContent, /Josie/, 'the signed-in name no longer shows under the title');
  const rows = [...menu.querySelectorAll('nav a, nav button')].map((el) => el.textContent.trim());
  assert.deepEqual(rows, ['Tickets', 'Audit Log', 'Settings', 'Log out']);
  assert.deepEqual(MENU_ITEMS.map((m) => m.path), ['/tickets', '/audit', '/settings']);

  view.click(view.byLabel('Close menu'));
  assert.equal(closed, 1);
  view.press('Escape');
  assert.equal(closed, 2, 'Escape closes it too');
  view.unmount();
});

test('a shut menu is invisible, so its links are out of the tab order', async () => {
  api.get = async () => [];
  const view = await renderAt('/dashboard', h(MenuDrawer, { open: false, onClose: () => {} }));
  const menu = view.container.querySelector('[data-testid="nav-menu"]');
  assert.match(menu.className, /\binvisible\b/);
  assert.match(menu.className, /translate-x-full/);
  view.unmount();
});

// ── Status light ──────────────────────────────────────────────────────────────

test('lightStatus maps every state the old marker had onto four colours', () => {
  const s = (o) => lightStatus({ isOnline: true, ...o });
  assert.deepEqual(s({}), { tone: 'green', label: 'Online · all saved' });
  assert.deepEqual(s({ recentlyUpdated: true }), { tone: 'green', label: 'Updated just now' });
  assert.deepEqual(s({ recentlyUpdated: true, waitingCount: 2 }), { tone: 'blue', label: 'Updated just now · 2 waiting' },
    'green means everything is saved, so anything still waiting is blue');
  assert.deepEqual(s({ checking: true }), { tone: 'blue', label: 'Checking for updates…' });
  assert.deepEqual(s({ checking: true, waitingCount: 3 }), { tone: 'blue', label: 'Updating · 3 waiting' });
  assert.deepEqual(s({ waitingCount: 1 }), { tone: 'blue', label: 'Sending · 1 waiting' });
  assert.deepEqual(s({ isOnline: false }), { tone: 'orange', label: 'Offline' });
  assert.deepEqual(s({ isOnline: false, waitingCount: 3 }), { tone: 'orange', label: 'Offline · 3 waiting' });
  assert.deepEqual(s({ isOnline: false, checking: true }), { tone: 'orange', label: 'Offline' }, 'offline outranks checking');
  assert.deepEqual(s({ needsAttentionCount: 1 }), { tone: 'red', label: '1 needs attention' });
  assert.deepEqual(s({ needsAttentionCount: 2, waitingCount: 4, isOnline: false }), { tone: 'red', label: '2 need attention · 4 waiting' },
    'attention outranks everything');
});

test('the light has no visible words, names its status, and a tap spells it out', async () => {
  const view = render(h(ToastProvider, null, h(StatusLightButton)));
  await flush();
  const light = view.container.querySelector('[data-testid="status-light"]');
  assert.equal(light.textContent.trim(), '', 'text-less');
  assert.equal(light.getAttribute('data-tone'), 'green');
  assert.equal(light.getAttribute('aria-label'), 'Connection status: Online · all saved');
  assert.equal(view.container.querySelector('[role="status"]').textContent, 'Online · all saved');
  const dot = light.querySelector('span');
  assert.match(dot.className, /motion-safe:animate-status-pulse\b/, 'pulses only when motion is allowed');

  assert.equal(view.container.querySelector('[data-testid="status-light-popup"]'), null);
  view.click(light);
  assert.equal(view.container.querySelector('[data-testid="status-light-popup"]').textContent, 'Online · all saved');
  assert.equal(light.getAttribute('aria-expanded'), 'true');
  view.press('Escape');
  await flush();
  assert.equal(view.container.querySelector('[data-testid="status-light-popup"]'), null, 'Escape closes the popup');
  view.unmount();
});

test('offline, the light is orange', async () => {
  setOnLine(false);
  const view = render(h(ToastProvider, null, h(StatusLightButton)));
  await flush();
  const light = view.container.querySelector('[data-testid="status-light"]');
  assert.equal(light.getAttribute('data-tone'), 'orange');
  assert.equal(light.getAttribute('aria-label'), 'Connection status: Offline');
  view.unmount();
});

// ── Customers duplicate bubble ────────────────────────────────────────────────

test('seen logic: opening Customers marks every duplicate seen; merges lower it', () => {
  assert.equal(shouldShowBubble(2, 0, false), true);
  assert.equal(nextSeenCount(2, 0, true), 2, 'opening Customers sees them all');
  assert.equal(shouldShowBubble(2, 2, true), false);
  assert.equal(shouldShowBubble(2, 2, false), false, 'still hidden after leaving');
  assert.equal(shouldShowBubble(4, 2, false), true, 'back once there are more');
  assert.equal(nextSeenCount(1, 2, false), 1, 'a merge lowers the seen count…');
  assert.equal(shouldShowBubble(2, 1, false), true, '…so a fresh pair shows again');
  assert.equal(nextSeenCount(4, 2, false), 2, 'rising elsewhere does not mark anything seen');
});

test('the bubble shows on the Customers tab, hides once Customers is opened, and returns when the count rises', async () => {
  let customers = [customer(1, 'Aling Nena'), customer(2, 'Aling Nena')];
  api.get = async (p) => (p === '/customers' ? customers : []);
  const view = await renderAt('/dashboard', h(TopTabBar, { onOpenMenu: () => {}, duplicatesEnabled: true }));
  await flush();
  const bubble = () => view.container.querySelector('[data-testid="customers-duplicate-bubble"]');
  const customersTab = () => view.container.querySelector('[data-testid="nav-link-customers"]');

  assert.equal(bubble()?.textContent, '2');
  assert.match(customersTab().textContent, /2 possible duplicates/, 'the count is part of the tab\'s name');

  await act(async () => { navigateTo('/customers'); });
  await flush();
  assert.equal(bubble(), null, 'hidden once Customers is opened');
  assert.equal(await nativeStore.getString(SEEN_DUPLICATES_KEY), '2', 'the seen count is kept on the device');

  await act(async () => { navigateTo('/dashboard'); });
  await flush();
  assert.equal(bubble(), null, 'stays hidden after coming back out');

  customers = [...customers, customer(3, 'Mang Tomas'), customer(4, 'Mang Tomas')];
  await act(async () => { window.dispatchEvent(new window.CustomEvent(REFRESH_EVENT, { detail: {} })); });
  await flush();
  assert.equal(bubble()?.textContent, '4', 'back when new duplicates appear');
  view.unmount();
});

test('a seen count kept from an earlier session keeps the bubble down', async () => {
  await nativeStore.setString(SEEN_DUPLICATES_KEY, 2);
  api.get = async (p) => (p === '/customers' ? [customer(1, 'Aling Nena'), customer(2, 'Aling Nena')] : []);
  const view = await renderAt('/dashboard', h(TopTabBar, { onOpenMenu: () => {}, duplicatesEnabled: true }));
  await flush();
  assert.equal(view.container.querySelector('[data-testid="customers-duplicate-bubble"]'), null);
  view.unmount();
});
