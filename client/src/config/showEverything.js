import { useEffect, useSyncExternalStore } from 'react';
import { nativeStore } from '../offline/nativeStore.js';
import { SHOW_EVERYTHING_KEY } from '../offline/keys.js';

// The "Show everything" switch in Settings.
//
// The owners use the app as a receipt book: make, edit, print and cancel an order,
// look up customers and prices, glance at the Dashboard. Off (the default) shows only
// that. On shows the whole app exactly as it was before the trim: the order stages
// after printing (In Transit, Delivered, Closed), stock counts in Inventory, and the
// Incoming, Personnel, Tickets and Audit Log screens. Nothing is deleted either way;
// the hidden parts keep working underneath and the server is never told which way the
// switch is set.
//
// Device state, not account state: it lives in native storage under SHOW_EVERYTHING_KEY
// (readable blind, survives a restart and a logout), anyone on the device can flip it,
// and it takes effect at once through useShowEverything().

const listeners = new Set();
let state = { showEverything: false, ready: false };
let loading = null;

function publish(next) {
  state = next;
  for (const listener of listeners) listener();
}

function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const getSnapshot = () => state;

// Reads the stored value once per app run. A storage failure reads as off, the
// trimmed app, which is what a fresh device shows anyway.
export function loadShowEverything() {
  if (!loading) {
    loading = nativeStore.getString(SHOW_EVERYTHING_KEY)
      .catch(() => null)
      .then((raw) => {
        // A flip that landed while the read was in flight is newer than the read.
        if (!state.ready) publish({ showEverything: raw === 'on', ready: true });
        return state.showEverything;
      });
  }
  return loading;
}

export function getShowEverything() {
  return state.showEverything;
}

// Flips the switch for this device. The screen follows at once; the write to native
// storage is what makes it survive a restart.
export async function setShowEverything(value) {
  const on = Boolean(value);
  publish({ showEverything: on, ready: true });
  await nativeStore.setString(SHOW_EVERYTHING_KEY, on ? 'on' : 'off');
}

// `{ showEverything, ready }`. `ready` is false only until the first read from storage
// lands; until then the app shows its trimmed (default) form, and a guarded route waits
// rather than redirecting someone who has the switch on.
export function useShowEverything() {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  useEffect(() => { if (!snapshot.ready) loadShowEverything(); }, [snapshot.ready]);
  return snapshot;
}

// Test seam only: forget the in-memory value so the next read goes back to storage.
export function __resetShowEverythingForTest() {
  loading = null;
  publish({ showEverything: false, ready: false });
}
