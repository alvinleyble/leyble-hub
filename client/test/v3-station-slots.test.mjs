// ADR 0016 — three fixed station slots, and the Devices screen that moves one.
//
// The engine half (seeding, revalidation, refusing to issue without a slot) lives in
// v25-offline-core.test.mjs beside the rest of the receipt-number rules. What is worth
// pinning here is the screen the owners actually use during a tablet replacement: it
// has to name the three slots and their owners, say which number the replacement will
// start at BEFORE anyone commits to it, warn that the outgoing tablet stops issuing,
// and then send the assignment for the right device.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { React, act } from './render.mjs';
import { MemoryRouter } from 'react-router-dom';
import { api } from '../src/api/client.js';
import { ToastProvider } from '../src/components/ui/Toast.jsx';
import { __resetMemoryBackend, nativeStore } from '../src/offline/nativeStore.js';
import { STATION_KEY } from '../src/offline/keys.js';
import { __resetIssuance } from '../src/offline/station.js';

const { createRoot } = await import('react-dom/client');
const StationsPage = (await import('../src/pages/stations/StationsPage.jsx')).default;

const settle = (ms = 30) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

function renderPage(element) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(React.createElement(MemoryRouter, null,
      React.createElement(ToastProvider, null, element)));
  });
  return {
    container,
    text: () => container.textContent,
    all: (sel) => [...container.querySelectorAll(sel)],
    click: (el) => act(() => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); }),
    unmount: () => act(() => { root.unmount(); }),
  };
}

const buttonNamed = (view, label) =>
  view.all('button').find((b) => b.textContent.trim().startsWith(label));

const THIS_DEVICE = 'device-in-my-hands';

// Slot 2's tablet has been replaced: the old one is gone, the new one has signed in and
// is sitting in the unassigned list, and slot 2's numbering is up to 2-00417.
const roster = {
  slots: [
    { slot_number: 1, owner_name: 'Alvin', device: { device_key: 'alvin-tablet', label: null, slot_assigned_at: '2026-08-20T01:00:00.000Z', slot_assigned_by: 'Admin' }, last_sequence: 12, next_sequence: 13 },
    { slot_number: 2, owner_name: 'Josie', device: { device_key: 'josie-old-tablet', label: null, slot_assigned_at: '2026-08-20T01:00:00.000Z', slot_assigned_by: 'Admin' }, last_sequence: 417, next_sequence: 418 },
    { slot_number: 3, owner_name: 'Luis', device: null, last_sequence: 0, next_sequence: 1 },
  ],
  unassigned: [
    { device_key: THIS_DEVICE, label: null, registered_at: '2026-08-29T01:00:00.000Z', last_seen_at: '2026-08-29T02:00:00.000Z' },
  ],
};

let saved = {};

beforeEach(async () => {
  saved = { get: api.get, post: api.post };
  await __resetMemoryBackend();
  __resetIssuance();
  api.get = async () => JSON.parse(JSON.stringify(roster));
  await nativeStore.setJson(STATION_KEY, { device_key: THIS_DEVICE, station_number: null, slot_number: null });
});

afterEach(() => {
  Object.assign(api, saved);
});

test('names the three slots and their owners, and says this tablet cannot issue receipts yet', async () => {
  const view = renderPage(React.createElement(StationsPage));
  await settle();

  const text = view.text();
  assert.match(text, /Slot 1 — Alvin/);
  assert.match(text, /Slot 2 — Josie/);
  assert.match(text, /Slot 3 — Luis/);
  assert.match(text, /Not assigned — this tablet cannot issue receipt numbers yet/);

  // The number a slot will hand out next is on the card, so nobody has to guess what a
  // reassignment does to the series before doing it.
  assert.match(text, /2-00418/);
  view.unmount();
});

test('confirming a replacement states the continuing number and warns about the outgoing tablet', async () => {
  const view = renderPage(React.createElement(StationsPage));
  await settle();

  // Slot 2 is Josie's, currently held by the tablet being replaced.
  const useThis = view.all('button').filter((b) => b.textContent.trim() === 'Use this tablet');
  assert.equal(useThis.length, 3, 'every slot this tablet does not hold offers to take it');
  view.click(useThis[1]);
  await settle();

  const text = view.text();
  assert.match(text, /Give Slot 2 \(Josie\) to this tablet\?/);
  assert.match(text, /2-00418/, 'the continuing number, not 2-00001');
  assert.match(text, /will stop issuing receipts/);
  assert.match(text, /no orders waiting to sync/);
  view.unmount();
});

test('confirming sends the assignment for this device and re-reads the roster', async () => {
  const posts = [];
  api.post = async (path, body) => {
    posts.push({ path, body });
    return {
      device_key: THIS_DEVICE, slot_number: 2, station_number: 2, owner_name: 'Josie',
      next_sequence: 468, next_delivery_sequence: 1, changed: true, replaced_previous: true,
    };
  };

  const view = renderPage(React.createElement(StationsPage));
  await settle();
  view.click(view.all('button').filter((b) => b.textContent.trim() === 'Use this tablet')[1]);
  await settle();
  view.click(buttonNamed(view, 'Move the slot'));
  await settle();

  assert.equal(posts.length, 1);
  assert.equal(posts[0].path, '/stations/slots/2/assign');
  assert.equal(posts[0].body.device_key, THIS_DEVICE);

  // The answer is adopted locally, which is what lets this tablet start issuing at once.
  const stored = await nativeStore.getJson(STATION_KEY);
  assert.equal(stored.station_number, 2);
  assert.equal(stored.slot_number, 2);
  view.unmount();
});

test('a slot nobody holds is offered without the outgoing-tablet warning', async () => {
  const view = renderPage(React.createElement(StationsPage));
  await settle();

  view.click(view.all('button').filter((b) => b.textContent.trim() === 'Use this tablet')[2]); // Luis, unheld
  await settle();

  const text = view.text();
  assert.match(text, /Give Slot 3 \(Luis\) to this tablet\?/);
  assert.doesNotMatch(text, /will stop issuing receipts/);
  assert.ok(buttonNamed(view, 'Assign the slot'), 'wording is "assign", not "move"');
  view.unmount();
});
