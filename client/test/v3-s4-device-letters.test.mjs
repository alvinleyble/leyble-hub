// ADR 0017 slice 4 — the device half of the letter scheme.
//
// The server allocates the pair (server/test/v3-s4-device-letters.test.js drives that
// matrix against the real database). What this file pins is what the DEVICE does with
// the answer, which is where a customer-visible mistake would actually be printed:
//
//   • the letter is remembered PER PERSON, so the same device serves 1A and 2A at once
//   • the sequence counts within the pair and restarts at 00001 for a new pair
//   • the counter never leaks across pairs — the pre-letter version of that bug printed
//     one running series wearing three different prefixes
//   • the number is persisted BEFORE it is handed out, and issuance is serialised
//   • it survives a logout, because it is device state, not session state
//   • a device that cannot reach the server yet keeps selling under its old slot
//
// A DEVICE IS ITS STORAGE, which is what makes "no second tablet needed" true: swapping
// the backing store below is exactly what carrying a different tablet would do.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import './render.mjs';

import { api } from '../src/api/client.js';
import { nativeStore, __setBackend, __resetMemoryBackend } from '../src/offline/nativeStore.js';
import { SESSION_KEY, STATION_KEY, SEQUENCE_KEY, DELIVERY_SEQUENCE_KEY, DEVICE_LETTERS_KEY } from '../src/offline/keys.js';
import {
  ensureStationRegistered, issueReceiptNumber, issueDeliveryRef, getReceiptIdentity,
  isRegistered, receiptSeries, __resetIssuance,
} from '../src/offline/station.js';

let savedApi;

// ── The fleet ───────────────────────────────────────────────────────────────

// One physical device = one storage map. Nothing else distinguishes them.
function makeDevice(name) {
  const store = new Map();
  return {
    name,
    backend: {
      async get(key) { return store.has(key) ? store.get(key) : null; },
      async set(key, value) { store.set(key, value); },
      async remove(key) { store.delete(key); },
      async keys() { return [...store.keys()]; },
    },
  };
}

async function pickUp(device) {
  __setBackend(device.backend);
  __resetIssuance();
}

async function signIn(person) {
  await nativeStore.setJson(SESSION_KEY, {
    id: person.id, email: person.email, full_name: person.name, role: 'admin',
  });
}

async function signOut() {
  await nativeStore.remove(SESSION_KEY);
}

// The allocator, mirroring server/src/routes/stations.js: one letter per
// (person, device_key) pair, walking forward from that person's highest.
function makeServer() {
  const allocated = new Map();   // `${userId}:${deviceKey}` -> letter
  const highest = new Map();     // userId -> last letter handed out
  const calls = [];

  return {
    calls,
    async post(path, body) {
      assert.equal(path, '/stations/register');
      assert.ok(body.device_key, 'a device_key identifies the device');
      calls.push(body.device_key);

      const person = makeServer.signedIn;
      const pair = `${person.id}:${body.device_key}`;
      if (!allocated.has(pair)) {
        const last = highest.get(person.id) || null;
        const next = last === null ? 'A' : String.fromCharCode(last.charCodeAt(0) + 1);
        allocated.set(pair, next);
        highest.set(person.id, next);
      }

      return {
        device_key: body.device_key,
        registered_at: '2026-09-04T00:00:00.000Z',
        // ADR 0017 slice 6 removed the slot concept, so the response carries no leading
        // number for hardware at all — only the person's letter for this device.
        user_id: person.id,
        person: person.person,
        seller_name: person.name,
        device_letter: allocated.get(pair),
        receipt_prefix: `${person.person}${allocated.get(pair)}`,
        next_pair_sequence: 1,
        next_pair_delivery_sequence: 1,
      };
    },
  };
}

const ALVIN = { id: 11, email: 'alvin@leyblestore.com', name: 'Alvin', person: 1 };
const JOSIE = { id: 22, email: 'josie@leyblestore.com', name: 'Josie', person: 2 };

let fakeServer;

beforeEach(() => {
  savedApi = { post: api.post, get: api.get };
  __resetMemoryBackend();
  __resetIssuance();
  fakeServer = makeServer();
  api.post = (path, body) => fakeServer.post(path, body);
});

afterEach(() => {
  Object.assign(api, savedApi);
  __resetMemoryBackend();
});

// Signs `person` in on `device` and completes the one online sign-in that allocates.
async function setUp(device, person) {
  await pickUp(device);
  await signIn(person);
  makeServer.signedIn = person;
  await ensureStationRegistered();
}

async function issue(n = 1) {
  const out = [];
  for (let i = 0; i < n; i++) out.push((await issueReceiptNumber()).receipt_number);
  return out;
}

// ── The collision matrix ────────────────────────────────────────────────────

const matrix = [
  {
    what: 'the same person on two devices — one number, two letters, two series',
    async run() {
      const tablet = makeDevice('tablet');
      const phone = makeDevice('phone');

      await setUp(tablet, ALVIN);
      const onTablet = await issue(3);

      await setUp(phone, ALVIN);
      const onPhone = await issue(2);

      assert.deepEqual(onTablet, ['1A-00001', '1A-00002', '1A-00003']);
      assert.deepEqual(onPhone, ['1B-00001', '1B-00002'], 'the phone starts its OWN series at 00001');

      // Back on the tablet: it resumes its own count, it does not inherit the phone's.
      await pickUp(tablet);
      assert.deepEqual(await issue(1), ['1A-00004']);
    },
  },
  {
    what: 'the same device for two people — two numbers, each with their own A',
    async run() {
      const shared = makeDevice('shared-tablet');

      await setUp(shared, ALVIN);
      const alvins = await issue(2);

      // Josie takes over the same tablet mid-shift and signs in on it.
      await signIn(JOSIE);
      makeServer.signedIn = JOSIE;
      await ensureStationRegistered();
      const josies = await issue(2);

      assert.deepEqual(alvins, ['1A-00001', '1A-00002']);
      assert.deepEqual(josies, ['2A-00001', '2A-00002'], 'her first device is HER A');

      // And Alvin's own series on this device is untouched by hers.
      await signIn(ALVIN);
      assert.deepEqual(await issue(1), ['1A-00003']);
    },
  },
  {
    what: 'a replacement device takes a fresh letter and never inherits the dead one',
    async run() {
      const dead = makeDevice('dead-tablet');
      const spare = makeDevice('spare-phone');
      const replacement = makeDevice('replacement-tablet');

      await setUp(dead, ALVIN);
      await issue(40);
      await setUp(spare, ALVIN);

      // The tablet dies with receipts on it that never synced. Nobody assigns anything:
      // the replacement is simply signed in on.
      await setUp(replacement, ALVIN);

      const issued = await issue(2);
      assert.deepEqual(issued, ['1C-00001', '1C-00002']);
      assert.ok(!issued.some((n) => n.startsWith('1A-')),
        'a letter the dead tablet used could collide with what it never synced');
    },
  },
  {
    what: 'the sequence restarts at 00001 for each pair, and never for the same pair twice',
    async run() {
      const device = makeDevice('one-device');
      await setUp(device, ALVIN);
      assert.deepEqual(await issue(2), ['1A-00001', '1A-00002']);

      // Re-registering (every app start does) must not wind the count back.
      await ensureStationRegistered();
      assert.deepEqual(await issue(1), ['1A-00003']);
    },
  },
];

for (const { what, run } of matrix) {
  test(`collision matrix — ${what}`, run);
}

// ── Storage rules ───────────────────────────────────────────────────────────

test('the letter is stored per person, so one device holds both at once', async () => {
  const shared = makeDevice('shared');
  await setUp(shared, ALVIN);
  await signIn(JOSIE);
  makeServer.signedIn = JOSIE;
  await ensureStationRegistered();

  assert.deepEqual(await nativeStore.getJson(DEVICE_LETTERS_KEY), {
    11: { person: 1, letter: 'A', seller_name: 'Alvin', allocated_at: null },
    22: { person: 2, letter: 'A', seller_name: 'Josie', allocated_at: null },
  });
});

test('the counters are keyed by series, so two pairs on one device never share a count', async () => {
  const shared = makeDevice('shared');
  await setUp(shared, ALVIN);
  await issue(3);
  await signIn(JOSIE);
  makeServer.signedIn = JOSIE;
  await ensureStationRegistered();
  await issue(1);

  assert.deepEqual(await nativeStore.getJson(SEQUENCE_KEY), { '1A': 3, '2A': 1 });
});

test('the letter survives a logout — it is device state, not session state (ADR 0015 §3)', async () => {
  const device = makeDevice('tablet');
  await setUp(device, ALVIN);
  await issue(5);

  await signOut();
  assert.equal(await getReceiptIdentity(), null, 'nobody is signed in, so nobody is selling');

  // Signing back in reaches the same letter with no server call at all — which is what
  // lets a tablet that logged out during an outage keep selling.
  api.post = () => { throw new Error('the device must not need the server to sign back in'); };
  await signIn(ALVIN);
  assert.equal(receiptSeries(await getReceiptIdentity()), '1A');
  assert.deepEqual(await issue(1), ['1A-00006'], 'and it resumes its own count');
});

test('the sequence is stored before the number is handed out, so a crash skips rather than repeats', async () => {
  const device = makeDevice('tablet');
  await setUp(device, ALVIN);
  const issued = await issueReceiptNumber();

  assert.equal(issued.sequence, 1);
  assert.equal(issued.device, 'A');
  assert.deepEqual(await nativeStore.getJson(SEQUENCE_KEY), { '1A': 1 });
});

test('concurrent Saves never receive the same number', async () => {
  const device = makeDevice('tablet');
  await setUp(device, ALVIN);

  const issued = await Promise.all(Array.from({ length: 25 }, () => issueReceiptNumber()));
  const numbers = issued.map((i) => i.receipt_number);
  assert.equal(new Set(numbers).size, 25);
  assert.equal(numbers.includes('1A-00025'), true);
});

test('delivery references carry the same prefix off their own counter (ADR 0017 #14)', async () => {
  const device = makeDevice('tablet');
  await setUp(device, ALVIN);
  await issue(4);

  const first = await issueDeliveryRef();
  const second = await issueDeliveryRef();
  assert.equal(first.delivery_ref, '1A-DEL-00001', 'not continued from the receipt count');
  assert.equal(second.delivery_ref, '1A-DEL-00002');
  assert.deepEqual(await nativeStore.getJson(DELIVERY_SEQUENCE_KEY), { '1A': 2 });
});

// ── ADR 0014's switchover window ────────────────────────────────────────────

test('a device updated to this build but not yet online keeps selling under its old number', async () => {
  const device = makeDevice('mid-rollout-tablet');
  await pickUp(device);
  await signIn(ALVIN);

  // What such a tablet holds the moment the new APK starts: a pre-letter number and a
  // count under it, and no letter, because it has not been able to register yet.
  await nativeStore.setJson(STATION_KEY, { device_key: 'rolled-out', station_number: 3 });
  await nativeStore.setJson(SEQUENCE_KEY, { 3: 60 });

  assert.equal(await isRegistered(), true);
  assert.deepEqual(await issue(2), ['3-00061', '3-00062'],
    'the old format, which the server accepts permanently (ADR 0017 #12)');

  // The line returns and the letter arrives. From here on it prints the new format, and
  // the old count is left exactly where it was rather than being carried across.
  makeServer.signedIn = ALVIN;
  await ensureStationRegistered();
  assert.deepEqual(await issue(1), ['1A-00001']);
  assert.deepEqual(await nativeStore.getJson(SEQUENCE_KEY), { 3: 62, '1A': 1 });
});

test('a device with neither a letter nor a number of its own refuses to issue, rather than guessing', async () => {
  const device = makeDevice('brand-new');
  await pickUp(device);
  await signIn(ALVIN);

  assert.equal(await isRegistered(), false);
  await assert.rejects(() => issueReceiptNumber(), /station number/);
});

// Found in the browser pass, not in a unit test: React StrictMode double-invokes the
// effect that calls startOfflineCore(), so a fresh install registered twice at once, each
// call minting its own device_key because neither had stored one yet. Two device_keys are
// two devices — the account burned a second letter it would never use, the activity log
// recorded a device that did not exist, and the tablet kept whichever answer landed last.
// Alvin's first sign-in came out as `1B`, his second device as `1D`.
test('two overlapping registrations are one device, not two', async () => {
  const device = makeDevice('fresh-install');
  await pickUp(device);
  await signIn(ALVIN);
  makeServer.signedIn = ALVIN;

  await Promise.all([ensureStationRegistered(), ensureStationRegistered()]);

  assert.equal(new Set(fakeServer.calls).size, 1, 'one device_key, minted once');
  assert.equal(receiptSeries(await getReceiptIdentity()), '1A', 'and the first letter, not the second');
});

test('a re-confirmation files the letter under the account the SERVER allocated for', async () => {
  const device = makeDevice('tablet');
  await setUp(device, ALVIN);

  // The tablet is handed over and Josie signs in, but a re-confirmation for Alvin that
  // was already in flight lands afterwards. It must not overwrite her entry with his.
  await signIn(JOSIE);
  makeServer.signedIn = ALVIN;
  await ensureStationRegistered();

  assert.equal(await getReceiptIdentity(), null, 'Josie still has no letter on this device');
  const letters = await nativeStore.getJson(DEVICE_LETTERS_KEY);
  assert.deepEqual(Object.keys(letters), ['11']);
});
