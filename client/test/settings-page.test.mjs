// Settings page: Profile, Printer, This device, About — and the read-only state each
// section reads (the device's receipt series, the installed version).
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
  SESSION_KEY, STATION_KEY, SEQUENCE_KEY, DEVICE_LETTERS_KEY,
} from '../src/offline/keys.js';
import { __clearOutbox } from '../src/offline/outbox.js';
import { getDeviceReceiptSummary, issueReceiptNumber, __resetIssuance } from '../src/offline/station.js';
import { setMockAppInfo, setMockPlayStoreOpener } from '../src/version/appVersion.js';
import { printerTestPageEscPos } from '../src/pages/shared/listEscPos.js';

const SettingsPage = (await import('../src/pages/SettingsPage.jsx')).default;
const PrinterSection = (await import('../src/pages/settings/PrinterSection.jsx')).default;
const { PrinterPanel } = await import('../src/pages/settings/PrinterSection.jsx');
const DeviceSection = (await import('../src/pages/settings/DeviceSection.jsx')).default;
const AboutSection = (await import('../src/pages/settings/AboutSection.jsx')).default;

const ALVIN = { id: 7, email: 'alvin@leyblestore.com', full_name: 'Alvin', role: 'admin' };

let saved;

beforeEach(async () => {
  saved = { get: api.get, request: api.request };
  __resetMemoryBackend();
  __resetIssuance();
  __setIsNativeForTest(false);
  await __clearOutbox();
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

// ── The page: a list of rows, each opening its own screen ──────────────────

const { createRoot } = await import('react-dom/client');
const { MemoryRouter, Routes, Route, useLocation } = await import('react-router-dom');

let currentPath = null;
function PathProbe() {
  currentPath = useLocation().pathname;
  return null;
}

// render.mjs mounts at `/` with no routes, so the routed page gets its own router here,
// matching App.jsx's two Settings routes.
function renderSettingsAt(path) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      React.createElement(ToastProvider, null,
        React.createElement(AuthProvider, null,
          React.createElement(MemoryRouter, { initialEntries: [path] },
            React.createElement(PathProbe),
            React.createElement(Routes, null,
              React.createElement(Route, { path: '/settings', element: React.createElement(SettingsPage) }),
              React.createElement(Route, { path: '/settings/:section', element: React.createElement(SettingsPage) }),
            ),
          ),
        ),
      ),
    );
  });
  return {
    container,
    q: (sel) => container.querySelector(sel),
    all: (sel) => [...container.querySelectorAll(sel)],
    click: (el) => act(() => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, button: 0 })); }),
    unmount: () => { act(() => root.unmount()); container.remove(); },
  };
}

async function settingsSetup() {
  api.get = async () => { throw new Error('Failed to fetch'); };
  await setStoredSession(ALVIN);
  await signInWithLetter({ lastSequence: 42 });
}

test('/settings is a list of rows — Profile, Printer, This device, About — each with a summary and nothing expanded', async () => {
  await settingsSetup();
  const view = renderSettingsAt('/settings');
  await settle();

  const rows = view.all('[data-testid^="settings-row-"][href]');
  assert.deepEqual(rows.map((r) => r.getAttribute('href')),
    ['/settings/profile', '/settings/printer', '/settings/device', '/settings/about']);
  const summary = (id) => view.q(`[data-testid="settings-row-${id}-summary"]`).textContent;
  assert.match(rows[2].textContent, /This device/);
  assert.equal(summary('profile'), 'Alvin');
  assert.equal(summary('printer'), 'Set up in the Android app');
  assert.equal(summary('device'), '1A');
  assert.equal(summary('about'), 'Shown in the Android app');
  // Collapsed: none of the sub-settings' content is on the list screen.
  for (const id of ['profile', 'printer', 'device', 'about']) {
    assert.equal(view.q(`[data-testid="settings-${id}"]`), null, `${id} content is not shown on the list`);
  }
  view.unmount();
});

test('tapping a row opens that sub-setting on its own screen, and Back returns to the list', async () => {
  await settingsSetup();
  const view = renderSettingsAt('/settings');
  await settle();

  view.click(view.q('[data-testid="settings-row-device"]'));
  await settle();
  assert.equal(currentPath, '/settings/device');
  assert.equal(view.q('h1').textContent, 'This device');
  assert.equal(view.q('[data-testid="settings-device-series"]').textContent, '1A');
  assert.equal(view.q('[data-testid="settings-device-last-receipt"]').textContent, '1A-00042');
  assert.equal(view.q('[data-testid="settings-row-device"]'), null, 'the list is gone');

  view.click(view.q('[data-testid="settings-back"]'));
  await settle();
  assert.equal(currentPath, '/settings');
  assert.ok(view.q('[data-testid="settings-row-device"]'));
  view.unmount();
});

test('each sub-screen holds exactly its own section', async () => {
  await settingsSetup();
  const cases = {
    profile: 'settings-profile-name',
    printer: 'settings-printer-web-note',
    device: 'settings-device-series',
    about: 'settings-about-web-note',
  };
  for (const [id, testId] of Object.entries(cases)) {
    const view = renderSettingsAt(`/settings/${id}`);
    await settle();
    assert.ok(view.q(`[data-testid="${testId}"]`), `${id} shows its content`);
    assert.deepEqual(view.all('section').map((sec) => sec.dataset.testid), [`settings-${id}`]);
    assert.ok(view.q('[data-testid="settings-back"]'));
    view.unmount();
  }
});

test('an unknown sub-setting goes back to the list', async () => {
  await settingsSetup();
  const view = renderSettingsAt('/settings/nope');
  await settle();
  assert.equal(currentPath, '/settings');
  assert.ok(view.q('[data-testid="settings-row-profile"]'));
  view.unmount();
});

test('in the app the rows summarise the saved printer (Not set) and the installed version', async () => {
  const { PrinterProvider } = await import('../src/context/PrinterContext.jsx');
  const SettingsList = (await import('../src/pages/settings/SettingsList.jsx')).default;
  setMockAppInfo({ version: '1.2.1', build: '30', id: 'com.leyble.hub' });
  const view = render(
    React.createElement(ToastProvider, null,
      React.createElement(PrinterProvider, null,
        React.createElement(SettingsList, {
          native: true, userName: 'Alvin', receiptSummary: { series: null, lastReceiptNumber: null },
        }))),
  );
  await settle();
  const summary = (id) => view.container.querySelector(`[data-testid="settings-row-${id}-summary"]`).textContent;
  assert.equal(summary('printer'), 'Not set');
  assert.equal(summary('about'), 'Version 1.2.1 · build 30');
  assert.equal(summary('device'), 'Not set up yet');
  view.unmount();
});

test('Sync is not part of Settings: no row and no /settings/sync screen', async () => {
  await settingsSetup();
  let view = renderSettingsAt('/settings');
  await settle();
  assert.equal(view.q('[data-testid="settings-row-sync"]'), null);
  view.unmount();

  view = renderSettingsAt('/settings/sync');
  await settle();
  assert.equal(currentPath, '/settings');
  view.unmount();
});
