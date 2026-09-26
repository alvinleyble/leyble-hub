// Settings page: Profile, Printer, This device, Sync, About — and the read-only state
// each section reads (the device's receipt series, the waiting list, "Last synced").
//
// `import.meta.env` is stubbed and there is no Capacitor bridge under node, so every
// section defaults to its browser (web) branch here. The native layouts are covered by
// passing `native` explicitly, or through the presentational PrinterPanel.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, React, act } from './render.mjs';
import { api } from '../src/api/client.js';
import { ToastProvider } from '../src/components/ui/Toast.jsx';
import { AuthProvider, setStoredSession, __setIsNativeForTest } from '../src/context/AuthContext.jsx';
import { nativeStore, __resetMemoryBackend } from '../src/offline/nativeStore.js';
import {
  SESSION_KEY, STATION_KEY, SEQUENCE_KEY, DEVICE_LETTERS_KEY, CUSTOMERS_KEY, PRODUCTS_KEY,
} from '../src/offline/keys.js';
import { enqueue, drainOutbox, listRecords, ref, __clearOutbox, NEEDS_ATTENTION } from '../src/offline/outbox.js';
import { getDeviceReceiptSummary, issueReceiptNumber, __resetIssuance } from '../src/offline/station.js';
import { describeOutboxRecord, listWaitingItems } from '../src/offline/waitingItems.js';
import { recordLastSynced, getLastSynced } from '../src/offline/lastSynced.js';
import { runSync, getSyncState, __resetSyncState } from '../src/offline/sync.js';
import { setMockAppInfo, setMockPlayStoreOpener } from '../src/version/appVersion.js';
import { printerTestPageEscPos } from '../src/pages/shared/listEscPos.js';

const SettingsPage = (await import('../src/pages/SettingsPage.jsx')).default;
const PrinterSection = (await import('../src/pages/settings/PrinterSection.jsx')).default;
const { PrinterPanel } = await import('../src/pages/settings/PrinterSection.jsx');
const DeviceSection = (await import('../src/pages/settings/DeviceSection.jsx')).default;
const SyncSection = (await import('../src/pages/settings/SyncSection.jsx')).default;
const { formatSyncedAt } = await import('../src/pages/settings/SyncSection.jsx');
const AboutSection = (await import('../src/pages/settings/AboutSection.jsx')).default;

const ALVIN = { id: 7, email: 'alvin@leyblestore.com', full_name: 'Alvin', role: 'admin' };

let saved;

beforeEach(async () => {
  saved = { get: api.get, request: api.request };
  __resetMemoryBackend();
  __resetIssuance();
  __setIsNativeForTest(false);
  await __clearOutbox();
  await __resetSyncState();
  localStorage.clear();
});

afterEach(() => {
  Object.assign(api, saved);
  setMockAppInfo(null);
  setMockPlayStoreOpener(null);
});

const settle = () => act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); });

async function signInWithLetter({ person = 1, letter = 'A', lastSequence = null } = {}) {
  await nativeStore.setJson(SESSION_KEY, ALVIN);
  await nativeStore.setJson(DEVICE_LETTERS_KEY, { [ALVIN.id]: { person, letter } });
  if (lastSequence !== null) {
    await nativeStore.setJson(SEQUENCE_KEY, { [`${person}${letter}`]: lastSequence });
  }
}

// ── This device: the series and the last number, read-only ──────────────────

test('device summary names the series and the last receipt issued in it', async () => {
  await signInWithLetter({ lastSequence: 42 });
  assert.deepEqual(await getDeviceReceiptSummary(), { series: '1A', lastReceiptNumber: '1A-00042' });
});

test('device summary reads without advancing the counter', async () => {
  await signInWithLetter({ lastSequence: 42 });
  await getDeviceReceiptSummary();
  await getDeviceReceiptSummary();
  assert.equal((await issueReceiptNumber()).receipt_number, '1A-00043');
  assert.equal((await getDeviceReceiptSummary()).lastReceiptNumber, '1A-00043');
});

test('device summary: a letter with no receipts yet, a pre-letter device, and an unregistered one', async () => {
  await signInWithLetter();
  assert.deepEqual(await getDeviceReceiptSummary(), { series: '1A', lastReceiptNumber: null });

  __resetMemoryBackend();
  await nativeStore.setJson(STATION_KEY, { device_key: 'k', station_number: 3 });
  await nativeStore.setJson(SEQUENCE_KEY, { 3: 61 });
  assert.deepEqual(await getDeviceReceiptSummary(), { series: '3', lastReceiptNumber: '3-00061' });

  __resetMemoryBackend();
  assert.deepEqual(await getDeviceReceiptSummary(), { series: null, lastReceiptNumber: null });
});

test('This device section shows the series and last receipt, or the set-up note', async () => {
  let view = render(React.createElement(DeviceSection, { summary: { series: '1A', lastReceiptNumber: '1A-00042' } }));
  assert.equal(view.container.querySelector('[data-testid="settings-device-series"]').textContent, '1A');
  assert.equal(view.container.querySelector('[data-testid="settings-device-last-receipt"]').textContent, '1A-00042');
  view.unmount();

  view = render(React.createElement(DeviceSection, { summary: { series: '1A', lastReceiptNumber: null } }));
  assert.equal(view.container.querySelector('[data-testid="settings-device-last-receipt"]').textContent, 'None yet');
  view.unmount();

  view = render(React.createElement(DeviceSection, { summary: { series: null, lastReceiptNumber: null } }));
  assert.ok(view.container.querySelector('[data-testid="settings-device-unregistered"]'));
  assert.match(view.text(), /Connect to the internet once/);
  view.unmount();
});

// ── Sync: the waiting list's labels ─────────────────────────────────────────

test('waiting items are named by kind and a short human label', () => {
  const customers = new Map([[5, { id: 5, name: 'Aling Nena' }]]);
  const products = new Map([[1, { id: 1, name: 'Coke Sakto 200ml' }]]);
  const personnel = new Map([[3, { id: 3, full_name: 'Luis Reyes' }]]);
  const newCustomer = { id: 1, entity_type: 'customer', payload: { name: 'Mang Tonyo' } };
  const records = new Map([[1, newCustomer]]);
  const lookups = { customers, products, personnel, records };
  const d = (record) => {
    const { kind, label } = describeOutboxRecord({ id: 9, status: 'queued', ...record }, lookups);
    return `${kind} | ${label}`;
  };

  assert.equal(d({ entity_type: 'order', receipt_number: '1A-00042', payload: { customer_id: 5 } }),
    'Order | 1A-00042 · Aling Nena');
  assert.equal(d({ entity_type: 'order', receipt_number: '1A-00043', payload: { customer_id: ref(1) } }),
    'Order | 1A-00043 · Mang Tonyo');
  assert.equal(d({ entity_type: 'order', receipt_number: '1A-00044', payload: { status: 'draft', customer_id: 5 },
    display: { customer_name: 'Aling Nena (display)' } }), 'Draft order | 1A-00044 · Aling Nena (display)');
  assert.equal(d({ entity_type: 'order_status', endpoint: '/orders/1A-00042/status', payload: { status: 'in_transit' } }),
    'Order status | 1A-00042 · now In Transit');
  assert.equal(d({ entity_type: 'receipt_printed', endpoint: '/orders/1240/receipt-printed', payload: {} }),
    'Receipt printed | #1240');
  assert.equal(d({ entity_type: 'customer', payload: { name: 'Mang Tonyo' } }), 'New customer | Mang Tonyo');
  assert.equal(d({ entity_type: 'customer_update', endpoint: '/customers/5', payload: { phone: 'x' } }),
    'Customer change | Aling Nena');
  assert.equal(d({ entity_type: 'customer_price', endpoint: '/customers/:customerId/prices',
    endpoint_params: { customerId: ref(1) }, payload: { product_id: 1 } }),
  'Custom price | Mang Tonyo · Coke Sakto 200ml');
  assert.equal(d({ entity_type: 'product_update', endpoint: '/products/1', payload: { current_stock: 4 } }),
    'Stock count | Coke Sakto 200ml');
  assert.equal(d({ entity_type: 'product_batch_price', endpoint: '/products/batch-price',
    payload: { updates: [{ id: 1 }, { id: 2 }] } }), 'Price change | 2 products');
  assert.equal(d({ entity_type: 'delivery', payload: { delivery_ref: '1A-DEL-00007', supplier_name: 'Coca-Cola' } }),
    'Incoming delivery | 1A-DEL-00007 · Coca-Cola');
  assert.equal(d({ entity_type: 'personnel_update', endpoint: '/personnel/3', payload: {} }),
    'Personnel change | Luis Reyes');

  assert.equal(describeOutboxRecord({ id: 1, entity_type: 'order', status: NEEDS_ATTENTION, payload: {} }).needsAttention, true);
});

test('listWaitingItems reads the outbox and the held catalogue, oldest first, without changing either', async () => {
  await nativeStore.setJson(CUSTOMERS_KEY, [{ id: 5, name: 'Aling Nena', is_active: true }]);
  await nativeStore.setJson(PRODUCTS_KEY, [{ id: 1, name: 'Coke Sakto 200ml', is_active: false }]);
  await enqueue({ entityType: 'order', endpoint: '/orders', payload: { customer_id: 5 },
    receiptNumber: '1A-00001', profileKey: ALVIN.email });
  await enqueue({ entityType: 'product_update', endpoint: '/products/1', method: 'PATCH',
    payload: { current_stock: 3 }, profileKey: ALVIN.email });

  const before = await listRecords();
  const items = await listWaitingItems();
  assert.deepEqual(items.map((i) => `${i.kind} | ${i.label}`), [
    'Order | 1A-00001 · Aling Nena',
    'Stock count | Coke Sakto 200ml', // an inactive product is still named
  ]);
  assert.deepEqual(await listRecords(), before);
});

// ── Sync: "Last synced" ─────────────────────────────────────────────────────

test('formatSyncedAt: Never, Today, Yesterday, and an older date', () => {
  const now = new Date(2026, 8, 27, 15, 0);
  assert.equal(formatSyncedAt(null, now), 'Never');
  assert.match(formatSyncedAt(new Date(2026, 8, 27, 9, 5).getTime(), now), /^Today, 9:05/);
  assert.match(formatSyncedAt(new Date(2026, 8, 26, 9, 5).getTime(), now), /^Yesterday, 9:05/);
  assert.match(formatSyncedAt(new Date(2026, 8, 20, 9, 5).getTime(), now), /^Sep 20, 9:05/);
});

test('a drain that sends something records Last synced; one that sends nothing does not', async () => {
  assert.equal(await getLastSynced(), null);
  api.request = async () => { throw new Error('Failed to fetch'); };
  await enqueue({ entityType: 'customer', endpoint: '/customers', payload: { name: 'X' }, profileKey: ALVIN.email });
  await drainOutbox();
  assert.equal(await getLastSynced(), null, 'an unreachable server is not a sync');

  api.request = async () => ({ id: 1 });
  const before = Date.now();
  await drainOutbox();
  assert.ok((await getLastSynced()) >= before);
});

test('a sync run records Last synced only when the server answered', async () => {
  api.get = async () => { throw new Error('Failed to fetch'); };
  await runSync({ trigger: 'login' });
  assert.ok((await getSyncState()).last_sync_completed_at > 0, 'the throttle stamp is unchanged behaviour');
  assert.equal(await getLastSynced(), null);

  api.get = async (path) => (path.startsWith('/orders/sync')
    ? { orders: [], has_more: false, first_cursor: null, next_cursor: null }
    : []);
  const before = Date.now();
  await runSync({ trigger: 'login', waitForOrders: true });
  assert.ok((await getLastSynced()) >= before);
});

test('Sync section: Never and nothing waiting, then the waiting list and a time', async () => {
  const view = render(React.createElement(SyncSection));
  await settle();
  assert.equal(view.container.querySelector('[data-testid="settings-sync-last"]').textContent, 'Never');
  assert.ok(view.container.querySelector('[data-testid="settings-sync-empty"]'));
  assert.equal(view.all('button').length, 0, 'view-only: no sync or clear button');

  await act(async () => {
    await enqueue({ entityType: 'customer', endpoint: '/customers', payload: { name: 'Mang Tonyo' }, profileKey: ALVIN.email });
    await recordLastSynced();
  });
  await settle();
  const items = view.all('[data-testid="settings-sync-item"]');
  assert.equal(items.length, 1);
  assert.match(items[0].textContent, /New customer/);
  assert.match(items[0].textContent, /Mang Tonyo/);
  assert.match(items[0].textContent, /Waiting/);
  assert.match(view.container.querySelector('[data-testid="settings-sync-last"]').textContent, /^Today, /);
  view.unmount();
});

// ── Printer ─────────────────────────────────────────────────────────────────

test('Printer section on the web says printer setup lives in the Android app', () => {
  const view = render(React.createElement(PrinterSection, { native: false }));
  assert.ok(view.container.querySelector('[data-testid="settings-printer-web-note"]'));
  assert.match(view.text(), /available in the Android app/);
  assert.equal(view.all('button').length, 0);
  view.unmount();
});

test('Printer panel shows the saved printer with Change printer and Test print', async () => {
  let changed = 0;
  let tested = 0;
  const view = render(React.createElement(PrinterPanel, {
    printer: { type: 'wifi', address: '192.168.1.39', port: 9100, name: 'VOZY G80 (Wi-Fi)' },
    onChange: () => { changed++; },
    onTest: async () => { tested++; },
  }));
  assert.equal(view.container.querySelector('[data-testid="settings-printer-name"]').textContent, 'VOZY G80 (Wi-Fi)');
  assert.match(view.container.querySelector('[data-testid="settings-printer-connection"]').textContent, /Wi-Fi.*192\.168\.1\.39:9100/);
  view.click(view.container.querySelector('[data-testid="settings-printer-change"]'));
  view.click(view.container.querySelector('[data-testid="settings-printer-test"]'));
  await settle();
  assert.equal(changed, 1);
  assert.equal(tested, 1);
  view.unmount();
});

test('Printer panel with nothing saved offers Choose printer and no Test print', () => {
  const view = render(React.createElement(PrinterPanel, { printer: null, onChange: () => {}, onTest: async () => {} }));
  assert.ok(view.container.querySelector('[data-testid="settings-printer-none"]'));
  assert.equal(view.container.querySelector('[data-testid="settings-printer-change"]').textContent, 'Choose printer');
  assert.equal(view.container.querySelector('[data-testid="settings-printer-test"]'), null);
  view.unmount();
});

test('the test page is plain ESC/POS that names the printer and ends in a cut', () => {
  const bytes = printerTestPageEscPos({ printerName: 'VOZY G80', deviceSeries: '1A' });
  const text = String.fromCharCode(...bytes);
  assert.deepEqual([...bytes.slice(0, 2)], [0x1b, 0x40]);
  assert.match(text, /PRINTER TEST/);
  assert.match(text, /VOZY G80/);
  assert.match(text, /1A/);
  assert.match(text, /This is not a receipt/);
  assert.deepEqual([...bytes.slice(-4)], [0x1d, 0x56, 0x41, 0x03]);
});

// ── About ───────────────────────────────────────────────────────────────────

test('About on the web: build info is in the Android app; Check for updates opens the listing', async () => {
  const opened = [];
  setMockPlayStoreOpener((id) => opened.push(id));
  setMockAppInfo({ version: '1.2.1', build: '30', id: 'com.leyble.hub' });
  const view = render(React.createElement(AboutSection, { native: false }));
  await settle();
  assert.ok(view.container.querySelector('[data-testid="settings-about-web-note"]'));
  assert.doesNotMatch(view.text(), /build 30/);
  view.click(view.container.querySelector('[data-testid="settings-about-check-updates"]'));
  assert.deepEqual(opened, ['com.leyble.hub']);
  view.unmount();
});

test('About in the app: version, build and the server minimum verdict', async () => {
  setMockAppInfo({ version: '1.2.1', build: '30', id: 'com.leyble.hub' });
  const answers = [{ min_version: '28' }, { min_version: '31' }, { min_version: null }, new Error('Failed to fetch')];
  api.get = async (path) => {
    assert.equal(path, '/version');
    const next = answers.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  const expectMin = async (pattern) => {
    const view = render(React.createElement(AboutSection, { native: true }));
    await settle();
    assert.equal(view.container.querySelector('[data-testid="settings-about-version"]').textContent,
      'Version 1.2.1 · build 30');
    assert.match(view.container.querySelector('[data-testid="settings-about-min"]').textContent, pattern);
    view.unmount();
  };
  await expectMin(/Meets the minimum \(28\)/);
  await expectMin(/Below the minimum \(31\)/);
  await expectMin(/No minimum set/);
  await expectMin(/Could not check/);
});

// ── The page ────────────────────────────────────────────────────────────────

test('Settings shows Profile, Printer, This device, Sync and About, top to bottom', async () => {
  api.get = async () => { throw new Error('Failed to fetch'); };
  await setStoredSession(ALVIN);
  await signInWithLetter({ lastSequence: 42 });
  const view = render(
    React.createElement(ToastProvider, null,
      React.createElement(AuthProvider, null, React.createElement(SettingsPage))),
  );
  await settle();
  const headings = view.all('h2').map((h) => h.textContent.trim());
  assert.deepEqual(headings, ['Profile', 'Printer', 'This device', 'Sync', 'About']);
  assert.equal(view.container.querySelector('[data-testid="settings-device-series"]').textContent, '1A');
  assert.equal(view.container.querySelector('[data-testid="settings-device-last-receipt"]').textContent, '1A-00042');
  assert.ok(view.container.querySelector('[data-testid="settings-printer-web-note"]'));
  assert.ok(view.container.querySelector('[data-testid="settings-about-web-note"]'));
  view.unmount();
});
