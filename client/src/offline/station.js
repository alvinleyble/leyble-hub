import { api } from '../api/client';
import { nativeStore } from './nativeStore';
import { STATION_KEY, SEQUENCE_KEY, DELIVERY_SEQUENCE_KEY } from './keys';
import { formatReceiptNumber, formatDeliveryRef } from './receiptNumbers';

// D1 — the device's station number, and the receipt numbers issued from it.
//
// The station number is claimed from the server ONCE, at install, and then lives in
// native storage forever. It is not the active profile (that identifies the person and
// can be switched mid-shift) and it is not chosen by hand (one careless tap gives two
// devices the same number space, and the collision only shows up on paper). It
// survives logout: D15 makes it device state, not session state.
//
// A wiped or reinstalled device generates a fresh device_key and therefore claims a
// NEW station number. Numbers only creep upward and are never reused.
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

// Claims a station number if this device does not have one yet, and returns it.
// Safe to call on every app start: it is a no-op once registered, and registration is
// idempotent on device_key server-side, so a lost response does not burn a number.
// Throws when offline — the caller decides whether that matters yet.
export async function ensureStationRegistered({ label } = {}) {
  const existing = await getStation();
  if (Number.isInteger(existing?.station_number)) return existing;

  // Persist the device_key BEFORE registering, so a response lost in flight is
  // recoverable: the retry sends the same key and the server returns the same station
  // rather than allocating a second one.
  const deviceKey = existing?.device_key || newDeviceKey();
  if (!existing?.device_key) {
    await nativeStore.setJson(STATION_KEY, { device_key: deviceKey, station_number: null });
  }

  const registered = await api.post('/stations/register', { device_key: deviceKey, label });
  const station = {
    device_key: deviceKey,
    station_number: registered.station_number,
    registered_at: registered.registered_at,
  };
  await nativeStore.setJson(STATION_KEY, station);
  return station;
}

// ── Receipt sequence ────────────────────────────────────────────────────────
//
// Issuance is serialised through one promise chain. JavaScript is single-threaded, but
// the read-increment-write straddles two awaits, so two Saves in flight at once could
// otherwise read the same value and print the same number twice.
let issuing = Promise.resolve();

async function nextSequence(key = SEQUENCE_KEY) {
  const raw = await nativeStore.getString(key);
  const next = (Number(raw) || 0) + 1;
  // Persist BEFORE returning. If the app dies here the number is skipped, never
  // reused — a gap in the numbering is invisible, a repeat is two customers holding
  // the same receipt number.
  await nativeStore.setString(key, next);
  return next;
}

// Issues the next receipt number for this device, e.g. '1-00042'. No server round
// trip, online or offline — same code path every day (D2).
export async function issueReceiptNumber() {
  const run = issuing.then(async () => {
    const station = await getStation();
    if (!Number.isInteger(station?.station_number)) {
      throw new Error('This device has not been assigned a station number yet.');
    }
    const sequence = await nextSequence();
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
      throw new Error('This device has not been assigned a station number yet.');
    }
    const sequence = await nextSequence(DELIVERY_SEQUENCE_KEY);
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
