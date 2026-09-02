// G6 (docs/offline-accessibility-acceptance-criteria.md) — the Inventory offline
// banner has to clear promptly on reconnect, not just when a filter happens to be
// touched. InventoryPage.jsx already wires this (see the comment above its `online`
// / `leyble:drain-complete` listeners) but there was no test exercising the actual
// reconnect path. This pins it down at the unit level: fire each event and assert
// the banner text disappears once the live GET succeeds.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, React, act } from './render.mjs';
import { api } from '../src/api/client.js';
import { ToastProvider } from '../src/components/ui/Toast.jsx';
import { nativeStore, __resetMemoryBackend } from '../src/offline/nativeStore.js';
import { PRODUCTS_KEY } from '../src/offline/keys.js';
import { __clearOutbox } from '../src/offline/outbox.js';

const InventoryPage = (await import('../src/pages/inventory/InventoryPage.jsx')).default;

const CACHED_PRODUCT = { id: 1, name: 'Coke 1.5L', sku: 'C-1.5', category: 'Soda', current_stock: 10, is_active: true };
const LIVE_PRODUCTS = [{ ...CACHED_PRODUCT, current_stock: 8 }];

let saved = {};

beforeEach(async () => {
  saved = { get: api.get, post: api.post, patch: api.patch, del: api.del, request: api.request };
  await __resetMemoryBackend();
  await __clearOutbox();
  localStorage.clear();
  localStorage.setItem('activeProfile', 'josie');
  await nativeStore.setJson(PRODUCTS_KEY, [CACHED_PRODUCT]);
});

afterEach(() => {
  api.get = saved.get;
  api.post = saved.post;
  api.patch = saved.patch;
  api.del = saved.del;
  api.request = saved.request;
});

const offlineError = () => { throw new TypeError('Failed to fetch'); };
const settle = (ms = 30) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

test('InventoryPage: the offline banner clears on the browser online event once the live fetch succeeds', async () => {
  api.get = async () => offlineError();
  const r = render(React.createElement(ToastProvider, null, React.createElement(InventoryPage)));
  await settle();

  assert.match(r.text(), /Viewing offline data/, 'banner shown while serving the cached copy');

  api.get = async () => LIVE_PRODUCTS;
  await act(async () => { window.dispatchEvent(new window.Event('online')); });
  await settle();

  assert.doesNotMatch(r.text(), /Viewing offline data/, 'banner clears once reconnect brings back a live read');
  r.unmount();
});

test('InventoryPage: the offline banner clears on leyble:drain-complete once the live fetch succeeds', async () => {
  api.get = async () => offlineError();
  const r = render(React.createElement(ToastProvider, null, React.createElement(InventoryPage)));
  await settle();

  assert.match(r.text(), /Viewing offline data/, 'banner shown while serving the cached copy');

  api.get = async () => LIVE_PRODUCTS;
  await act(async () => {
    window.dispatchEvent(new window.CustomEvent('leyble:drain-complete', { detail: { sent: 1, waiting: 0 } }));
  });
  await settle();

  assert.doesNotMatch(r.text(), /Viewing offline data/, 'banner clears once the drain-complete refresh brings back a live read');
  r.unmount();
});

test('InventoryPage: the online event alone does not clear the banner if the live fetch still fails', async () => {
  api.get = async () => offlineError();
  const r = render(React.createElement(ToastProvider, null, React.createElement(InventoryPage)));
  await settle();

  assert.match(r.text(), /Viewing offline data/);

  // navigator.onLine flips before the server is actually reachable again — the banner
  // must stay up rather than optimistically clearing on the browser event alone.
  await act(async () => { window.dispatchEvent(new window.Event('online')); });
  await settle();

  assert.match(r.text(), /Viewing offline data/, 'banner stays while the live GET still fails');
  r.unmount();
});
