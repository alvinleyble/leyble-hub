import { api } from '../api/client';
import { nativeStore } from './nativeStore';
import { STATION_KEY, SEQUENCE_KEY, DELIVERY_SEQUENCE_KEY } from './keys';
import { formatReceiptNumber, formatDeliveryRef } from './receiptNumbers';

// D1 / ADR 0016 — the device's station number, and the receipt numbers issued from it.
//
// The number lives in native storage and is used with no server round trip, exactly as
// ADR 0003/0004 set it up. What ADR 0016 changed is where it comes from: this store runs
// exactly three tablets, one per person, so the number is one of three fixed SLOTS the
// server assigns this device (1 = Alvin, 2 = Josie, 3 = Luis) rather than the next value
// of an unbounded sequence. A fourth device gets no slot at all instead of a number 4.
//
// It is still not the active profile (that identifies the person and can be switched
// mid-shift) and still not chosen by hand — a slot is assigned, one device at a time,
// by a single server-side statement. It survives logout: D15 makes it device state, not
// session state.
//
// The server is authoritative on who holds which slot, so registration re-confirms on
// every start rather than short-circuiting on what is stored. A tablet whose slot was
// handed to its replacement learns that here and stops issuing, instead of printing into
// a number space it no longer owns. A registration that simply fails to answer changes
// nothing — the stored slot is kept and the tablet carries on blind.
//
// A brand-new device installed DURING an outage cannot register, and so cannot issue
// receipts. D1 accepts that corner — the paper booklet covers it — so there is no
// provisional-number path here.

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

export async function isRegistered() {
  const station = await getStation();
  return Number.isInteger(station?.station_number);
}

// ── Sequence counters, one per slot ─────────────────────────────────────────
//
// Both sequence keys hold a MAP of slot -> last issued, not a single device-wide
// number. A device that has sold under slot 2 and is then given slot 1 has to resume
// slot 1's own count; under one shared counter it kept advancing slot 2's, so three
// reassignments in a row printed 2-00056, 1-00057, 3-00058 — one running series
// wearing three different prefixes. seedSequence's "never downwards" guard was doing
// that: it compared the incoming slot's number against whatever slot was last active
// on this device. Per-slot, the guard still does its real job (protecting a tablet
// holding receipts the server has not seen for THAT slot) without leaking across
// slots.

// Reads the counter map. A device from before per-slot counters holds a bare scalar
// here — `getJson` parses it back as a number — which is that device's count under the
// slot it is working right now, so it is adopted for `station` rather than dropped.
// Dropping it would restart at 00001 and re-issue numbers already on paper.
// `migrateLegacyCounter` below handles the one case where "right now" is the wrong
// answer.
async function readCounters(key, station) {
  const stored = await nativeStore.getJson(key);
  if (typeof stored === 'number') {
    return Number.isInteger(station) ? { [station]: stored } : {};
  }
  return (stored && typeof stored === 'object') ? stored : {};
}

// The one-time upgrade, run at registration BEFORE the new slot is seeded.
//
// A legacy scalar belongs to the slot this device was working BEFORE this
// registration, never the one it is being handed now. Filing it under the new slot
// would be the original bug all over again — the incoming slot would inherit the
// outgoing slot's count on the very reassignment this feature exists for.
async function migrateLegacyCounter(key, previousStation) {
  const stored = await nativeStore.getJson(key);
  if (typeof stored !== 'number') return;
  await nativeStore.setJson(
    key,
    Number.isInteger(previousStation) ? { [previousStation]: stored } : {}
  );
}

// Seeds one slot's counter from the server's view of that slot, never downwards.
//
// This is what makes a replacement tablet continue Josie's numbering instead of
// restarting it at 00001 — restarting would re-issue numbers the old tablet already
// printed. Since ADR 0017 #9 that no longer swallows the new order into the old one
// (the retry key is separate now — see requestKeys.js), but a receipt number is still
// unique, so the collision surfaces as a 409 the sale cannot sync past until a human
// re-issues it. Still worth avoiding. Taking the max also protects the ordinary
// re-confirmation: a tablet holding receipts for THIS slot that it has not drained yet
// is AHEAD of the server, and must keep its own counter.
async function seedSequence(key, station, next) {
  if (!Number.isInteger(station) || !Number.isInteger(next) || next < 1) return;
  const counters = await readCounters(key, station);
  const floor = next - 1;
  if (floor > (Number(counters[station]) || 0)) {
    counters[station] = floor;
    await nativeStore.setJson(key, counters);
  }
}

async function persistRegistration(deviceKey, registered) {
  const previousStation = (await getStation())?.station_number;
  // Pre-ADR-0016 servers answer with station_number and no slot. Honoured only when it
  // is already inside 1-3, so a new client keeps working against an old server during
  // the deploy window without ever being able to print a station this store does not
  // have (ADR 0016 #1 is absolute; a device with no usable number simply cannot sell,
  // which is recoverable, whereas an out-of-range number on paper is not).
  const legacy = registered?.station_number;
  const slot = Number.isInteger(registered?.slot_number)
    ? registered.slot_number
    : (Number.isInteger(legacy) && legacy >= 1 && legacy <= 3 ? legacy : null);

  const station = {
    device_key: deviceKey,
    station_number: slot,
    slot_number: Number.isInteger(registered?.slot_number) ? registered.slot_number : null,
    owner_name: registered?.owner_name ?? null,
    registered_at: registered?.registered_at ?? null,
  };
  await nativeStore.setJson(STATION_KEY, station);

  if (slot !== null) {
    await migrateLegacyCounter(SEQUENCE_KEY, previousStation);
    await migrateLegacyCounter(DELIVERY_SEQUENCE_KEY, previousStation);
    await seedSequence(SEQUENCE_KEY, slot, registered?.next_sequence);
    await seedSequence(DELIVERY_SEQUENCE_KEY, slot, registered?.next_delivery_sequence);
  }
  return station;
}

// Registers this device and returns its station. Safe — and now expected — to call on
// every app start: registration is idempotent on device_key server-side, so re-asking
// never allocates anything, and the answer is what keeps a reassigned slot honest.
// Throws when offline; the caller decides whether that matters yet.
export async function ensureStationRegistered({ label } = {}) {
  const existing = await getStation();

  // Persist the device_key BEFORE registering, so a response lost in flight is
  // recoverable: the retry sends the same key and the server returns the same slot
  // rather than assigning a second one.
  const deviceKey = existing?.device_key || newDeviceKey();
  if (!existing?.device_key) {
    await nativeStore.setJson(STATION_KEY, { device_key: deviceKey, station_number: null });
  }

  const registered = await api.post('/stations/register', { device_key: deviceKey, label });
  return persistRegistration(deviceKey, registered);
}

// ADR 0016 #2 — the device-replacement action, from the Devices screen.
//
// Moves one of the three slots onto a device. `deviceKey` defaults to this tablet,
// which is the ordinary case (the owner sets up the replacement in their hands); the
// Devices screen passes another device's key when assigning from a second tablet.
export async function assignStationSlot(slotNumber, { deviceKey } = {}) {
  const existing = await getStation();
  const key = deviceKey || existing?.device_key;
  if (!key) throw new Error('This device has not registered yet — connect once first.');

  const assigned = await api.post(`/stations/slots/${slotNumber}/assign`, { device_key: key });

  // Only adopt the result locally when the slot went to THIS device; assigning a slot
  // to some other tablet must not renumber the one doing the assigning.
  if (!deviceKey || deviceKey === existing?.device_key) {
    return persistRegistration(key, assigned);
  }
  return assigned;
}

// The three slots, who holds each, and every device registered without one.
export async function getStationSlots() {
  return api.get('/stations');
}

// ── Receipt sequence ────────────────────────────────────────────────────────
//
// Issuance is serialised through one promise chain. JavaScript is single-threaded, but
// the read-increment-write straddles two awaits, so two Saves in flight at once could
// otherwise read the same value and print the same number twice.
let issuing = Promise.resolve();

// Worded for the owners, not for a developer: this is what a replacement tablet shows
// before anyone has given it a slot, and the fix is a two-tap admin action.
export const NO_SLOT_MESSAGE =
  'This tablet has not been given a station number yet. Open the menu → Devices and assign it a slot (1, 2 or 3).';

async function nextSequence(station, key = SEQUENCE_KEY) {
  const counters = await readCounters(key, station);
  const next = (Number(counters[station]) || 0) + 1;
  counters[station] = next;
  // Persist BEFORE returning. If the app dies here the number is skipped, never
  // reused — a gap in the numbering is invisible, a repeat is two customers holding
  // the same receipt number.
  await nativeStore.setJson(key, counters);
  return next;
}

// Issues the next receipt number for this device, e.g. '1-00042'. No server round
// trip, online or offline — same code path every day (D2).
export async function issueReceiptNumber() {
  const run = issuing.then(async () => {
    const station = await getStation();
    if (!Number.isInteger(station?.station_number)) {
      throw new Error(NO_SLOT_MESSAGE);
    }
    const sequence = await nextSequence(station.station_number);
    return {
      receipt_number: formatReceiptNumber(station.station_number, sequence),
      station: station.station_number,
      sequence,
    };
  });
  // Keep the chain alive whatever happens, so one failure does not wedge issuance.
  issuing = run.catch(() => {});
  return run;
}

// Issues the next delivery reference for this device, e.g. '1-DEL-00007' (ADR 0015
// §8). Same contract as issueReceiptNumber above — no server round trip, serialised
// through the same promise chain — off its own counter (see DELIVERY_SEQUENCE_KEY).
export async function issueDeliveryRef() {
  const run = issuing.then(async () => {
    const station = await getStation();
    if (!Number.isInteger(station?.station_number)) {
      throw new Error(NO_SLOT_MESSAGE);
    }
    const sequence = await nextSequence(station.station_number, DELIVERY_SEQUENCE_KEY);
    return {
      delivery_ref: formatDeliveryRef(station.station_number, sequence),
      station: station.station_number,
      sequence,
    };
  });
  issuing = run.catch(() => {});
  return run;
}

// Test seam: resets the in-process serialisation chain between cases.
export function __resetIssuance() {
  issuing = Promise.resolve();
}
