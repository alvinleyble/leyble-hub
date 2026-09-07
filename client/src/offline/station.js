import { api } from '../api/client';
import { nativeStore } from './nativeStore';
import {
  STATION_KEY, SEQUENCE_KEY, DELIVERY_SEQUENCE_KEY, DEVICE_LETTERS_KEY, SESSION_KEY,
} from './keys';
import { formatReceiptNumber, formatDeliveryRef } from './receiptNumbers';

// D1 / ADR 0017 — who this device numbers receipts as, and the numbers it issues.
//
// A receipt number is `<person><device letter>-<sequence>`, e.g. `1A-00042`. The person
// is the SIGNED-IN ACCOUNT (permanent, never reused); the letter distinguishes that
// person's own devices from each other and nothing else — the same physical tablet is
// legitimately `1A` for Alvin and `2B` for Josie. The sequence counts within that pair,
// starting at 00001.
//
// The pair is allocated by the server on the person's first successful ONLINE sign-in on
// this device (`POST /stations/register`, which the app calls on every start), and then
// remembered locally. From then on issuance is purely local, online or offline, with no
// server round trip — same code path every day (ADR 0003/0004).
//
// A REPLACEMENT DEVICE TAKES A FRESH LETTER and never inherits one (ADR 0017 #3). That
// is why there is no device list, no assignment UI, no high-water seeding and no reserve
// gap in this file: a letter that has never been used cannot collide with receipts a
// dead tablet issued and never synced, so there is nothing to reserve against. Setting
// up a replacement is signing in on it. ADR 0016's slots, the Devices screen that moved
// one, and the client half that asked for a reassignment are all gone with the concept.
//
// ONE thing survives them: a `station_number` this device is ALREADY holding. A tablet
// updated to this build but not yet able to reach the server keeps selling under that
// number until its letter arrives, and the server accepts that shape permanently
// (ADR 0017 #12/#13). It is read from local storage and never from a server response —
// nothing hands one out any more.

function newDeviceKey() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Older Android WebViews without randomUUID. Only ever needs to be unique across
  // this shop's handful of devices; the server's UNIQUE(device_key) is the backstop.
  return `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export async function getStation() {
  return nativeStore.getJson(STATION_KEY);
}

// ── The signed-in person's letter on this device ────────────────────────────

async function readDeviceLetters() {
  const stored = await nativeStore.getJson(DEVICE_LETTERS_KEY);
  return (stored && typeof stored === 'object') ? stored : {};
}

// Who is selling right now. Read from the stored session rather than passed in, because
// issuance happens deep inside a Save and every caller would otherwise have to thread
// the account down to it. AuthContext writes this key on every login, silent /auth/me
// refresh and offline resume, so it is the same answer the rest of the app has.
async function activeUserId() {
  const session = await nativeStore.getJson(SESSION_KEY);
  const id = session?.id;
  return Number.isInteger(id) ? id : null;
}

// This device's `{ person, letter, ... }` for whoever is signed in, or null if that
// person has never completed an online sign-in here. Slice 5's remembered accounts
// switch the answer by switching the session; the map already holds a letter per person.
export async function getReceiptIdentity() {
  const userId = await activeUserId();
  if (userId === null) return null;
  const entry = (await readDeviceLetters())[String(userId)];
  if (!Number.isInteger(entry?.person) || typeof entry?.letter !== 'string' || !entry.letter) {
    return null;
  }
  return entry;
}

// The counter this issuance draws from, e.g. '1A' for the letter scheme and '3' for a
// device still carrying a pre-letter number. Both live in the same map (see readCounters)
// and can never be confused for one another, because one has a letter and the other
// cannot.
export function receiptSeries({ person, letter } = {}) {
  return `${person}${letter || ''}`;
}

async function persistDeviceLetter(registered) {
  const userId = registered?.user_id;
  if (!Number.isInteger(userId)
      || !Number.isInteger(registered?.person)
      || typeof registered?.device_letter !== 'string'
      || !registered.device_letter) {
    return null;
  }

  const entry = {
    person: registered.person,
    letter: registered.device_letter.toUpperCase(),
    seller_name: registered.seller_name ?? null,
    allocated_at: registered.device_letter_allocated_at ?? null,
  };

  // Filed under the id the SERVER allocated for, never under whoever happens to be in
  // the stored session — a re-confirmation that lands while the tablet is being handed
  // over must not write Alvin's letter under Josie's account.
  const letters = await readDeviceLetters();
  letters[String(userId)] = entry;
  await nativeStore.setJson(DEVICE_LETTERS_KEY, letters);
  return entry;
}

// ── Sequence counters, one per series ───────────────────────────────────────
//
// Both sequence keys hold a MAP of series -> last issued, not a single device-wide
// number. The bug this exists for predates letters and is reachable again with them: a
// device that has sold as `2-000NN` and then sells as `1A-…` must resume each series'
// OWN count. Under one shared counter it kept advancing whichever was last active, so
// three reassignments in a row printed 2-00056, 1-00057, 3-00058 — one running series
// wearing three different prefixes. Per series, seedSequence's "never downwards" guard
// still does its real job (protecting a device holding receipts the server has not seen
// for THAT series) without leaking across series.
//
// A series key is the receipt prefix as text: '1A' under the letter scheme, '3' for a
// device still carrying a pre-letter number. They cannot collide — the old shape has no
// letter in it.

// Reads the counter map. A device from before per-series counters holds a bare scalar
// here — `getJson` parses it back as a number — which is that device's count under the
// series it is working right now, so it is adopted for `series` rather than dropped.
// Dropping it would restart at 00001 and re-issue numbers already on paper.
// `migrateLegacyCounter` below handles the one case where "right now" is the wrong
// answer.
async function readCounters(key, series) {
  const stored = await nativeStore.getJson(key);
  if (typeof stored === 'number') {
    return series ? { [series]: stored } : {};
  }
  return (stored && typeof stored === 'object') ? stored : {};
}

// The one-time upgrade, run at registration BEFORE the new series is seeded.
//
// A legacy scalar belongs to the series this device was working BEFORE this
// registration, never the one it is being handed now. Filing it under the new series
// would be the original bug all over again — the incoming series would inherit the
// outgoing series' count on the very changeover this feature exists for.
async function migrateLegacyCounter(key, previousSeries) {
  const stored = await nativeStore.getJson(key);
  if (typeof stored !== 'number') return;
  await nativeStore.setJson(key, previousSeries ? { [previousSeries]: stored } : {});
}

// Seeds one series' counter from the server's view of that series, never downwards.
//
// Under the letter scheme a fresh pair has nothing to seed from and simply starts at
// 00001 — that is the point of a fresh letter (ADR 0017 #3). It still matters for a
// pair the server HAS seen: taking the max protects a device that is ahead of the
// server because it is holding receipts it has not drained yet, or that reinstalled the
// app and would otherwise restart a series it has printed paper for.
async function seedSequence(key, series, next) {
  if (!series || !Number.isInteger(next) || next < 1) return;
  const counters = await readCounters(key, series);
  const floor = next - 1;
  if (floor > (Number(counters[series]) || 0)) {
    counters[series] = floor;
    await nativeStore.setJson(key, counters);
  }
}

async function persistRegistration(deviceKey, registered) {
  const previous = await getStation();

  // Whatever number this device already holds it keeps. Nothing on the server hands one
  // out since ADR 0017 removed the slot concept, so re-deriving it from the response
  // would only ever blank it — and blanking it would strand a tablet mid-switchover that
  // is still numbering its receipts from it (see the file header).
  const held = Number.isInteger(previous?.station_number) ? previous.station_number : null;

  const station = {
    device_key: deviceKey,
    station_number: held,
    registered_at: registered?.registered_at ?? previous?.registered_at ?? null,
  };
  await nativeStore.setJson(STATION_KEY, station);

  // The one-time counter upgrade, run BEFORE anything is seeded (seeding writes the same
  // key). A pre-per-series device holds a bare scalar, and it belongs to the series that
  // device was working — never to a letter series it is only now being handed.
  const heldSeries = held === null ? null : String(held);
  await migrateLegacyCounter(SEQUENCE_KEY, heldSeries);
  await migrateLegacyCounter(DELIVERY_SEQUENCE_KEY, heldSeries);

  // ADR 0017 — the half that actually numbers receipts from here on.
  const identity = await persistDeviceLetter(registered);
  if (identity) {
    const series = receiptSeries(identity);
    await seedSequence(SEQUENCE_KEY, series, registered?.next_pair_sequence);
    await seedSequence(DELIVERY_SEQUENCE_KEY, series, registered?.next_pair_delivery_sequence);
  }
  return station;
}

// True once this device can issue a receipt number AT ALL for whoever is signed in —
// either because that person holds a letter here (ADR 0017) or because the device is
// still carrying a pre-letter station number of its own.
//
// Deliberately NOT what the boot loop in index.js gates its retry on: a device on the
// old number can sell, but it sells under a number that belongs to whoever that device
// was set up for. The loop keeps re-registering until `getReceiptIdentity()` answers.
export async function isRegistered() {
  if (await getReceiptIdentity()) return true;
  const station = await getStation();
  return Number.isInteger(station?.station_number);
}

// Registers this device and returns its station. Safe — and expected — to call on every
// app start: allocation is idempotent on (account, device_key) server-side, so re-asking
// never hands out a second letter, and this call IS the "first successful online sign-in"
// that allocates the first one. Throws when offline; the caller decides whether that
// matters yet.
//
// Serialised through one in-flight promise, for the same reason issuance below is. Two
// overlapping calls on a device that has never registered would each find no device_key
// stored yet and each MINT ONE, and two device_keys are two devices: the account burns a
// second letter it will never use, the activity log records a device that does not
// exist, and the letter the tablet ends up holding is whichever response landed last.
// This is reachable in practice, not in theory — React StrictMode double-invokes the
// effect in `AuthedShell` that calls startOfflineCore(), which is exactly two overlapping
// calls, and it burned two letters per sign-in until this landed.
let registering = null;

export async function ensureStationRegistered({ label } = {}) {
  if (registering) return registering;

  registering = (async () => {
    const existing = await getStation();

    // Persist the device_key BEFORE registering, so a response lost in flight is
    // recoverable: the retry sends the same key and the server returns the same letter
    // rather than allocating a second one.
    const deviceKey = existing?.device_key || newDeviceKey();
    if (!existing?.device_key) {
      await nativeStore.setJson(STATION_KEY, { device_key: deviceKey, station_number: null });
    }

    const registered = await api.post('/stations/register', { device_key: deviceKey, label });
    return persistRegistration(deviceKey, registered);
  })();

  try {
    return await registering;
  } finally {
    // Cleared either way: a failed attempt (offline) must be retryable on the next tick,
    // and a successful one must still re-confirm on its usual cadence.
    registering = null;
  }
}

// ── Receipt issuance ────────────────────────────────────────────────────────
//
// Issuance is serialised through one promise chain. JavaScript is single-threaded, but
// the read-increment-write straddles two awaits, so two Saves in flight at once could
// otherwise read the same value and print the same number twice.
let issuing = Promise.resolve();

// Worded for the owners, not for a developer. Under ADR 0017 the fix is no longer an
// admin action on another screen — it is being online once while signed in.
export const NO_RECEIPT_IDENTITY_MESSAGE =
  'This device has not been given a receipt station number yet. Connect to the internet '
  + 'once while signed in, and it will set itself up.';

// Which person and which series this Save issues under.
//
// The letter scheme first; the number this device was already carrying second. That
// second branch is ADR 0014's switchover window in one place: a tablet updated to this
// build while offline keeps selling `3-00061` until it can reach the server, and the
// server accepts that shape permanently (ADR 0017 #12), so nothing it prints is
// stranded. It is a fallback only — nothing allocates a number of that shape any more.
async function resolveIssuingSeries() {
  const identity = await getReceiptIdentity();
  if (identity) {
    return { person: identity.person, letter: identity.letter, series: receiptSeries(identity) };
  }

  const station = await getStation();
  if (Number.isInteger(station?.station_number)) {
    return {
      person: station.station_number,
      letter: null,
      series: String(station.station_number),
    };
  }

  throw new Error(NO_RECEIPT_IDENTITY_MESSAGE);
}

async function nextSequence(series, key = SEQUENCE_KEY) {
  const counters = await readCounters(key, series);
  const next = (Number(counters[series]) || 0) + 1;
  counters[series] = next;
  // Persist BEFORE returning. If the app dies here the number is skipped, never
  // reused — a gap in the numbering is invisible, a repeat is two customers holding
  // the same receipt number.
  await nativeStore.setJson(key, counters);
  return next;
}

// Issues the next receipt number for this person on this device, e.g. '1A-00042'. No
// server round trip, online or offline — same code path every day (D2).
export async function issueReceiptNumber() {
  const run = issuing.then(async () => {
    const { person, letter, series } = await resolveIssuingSeries();
    const sequence = await nextSequence(series);
    return {
      receipt_number: formatReceiptNumber(person, sequence, letter),
      station: person,
      device: letter,
      sequence,
    };
  });
  // Keep the chain alive whatever happens, so one failure does not wedge issuance.
  issuing = run.catch(() => {});
  return run;
}

// Issues the next delivery reference for this device, e.g. '1A-DEL-00007' (ADR 0015 §8,
// ADR 0017 #14). Same contract as issueReceiptNumber above — no server round trip,
// serialised through the same promise chain — off its own counter (DELIVERY_SEQUENCE_KEY).
export async function issueDeliveryRef() {
  const run = issuing.then(async () => {
    const { person, letter, series } = await resolveIssuingSeries();
    const sequence = await nextSequence(series, DELIVERY_SEQUENCE_KEY);
    return {
      delivery_ref: formatDeliveryRef(person, sequence, letter),
      station: person,
      device: letter,
      sequence,
    };
  });
  issuing = run.catch(() => {});
  return run;
}

// Test seam: resets the in-process serialisation state between cases.
export function __resetIssuance() {
  issuing = Promise.resolve();
  registering = null;
}
