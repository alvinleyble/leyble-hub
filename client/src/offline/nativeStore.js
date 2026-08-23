import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';

// D17 — device state lives in the app's own NATIVE storage. Never localStorage, never
// IndexedDB: Android evicts WebView storage under pressure and a routine "clear data"
// tap wipes it, which is exactly the silent loss of unsent sales the release exists to
// prevent.
//
// The chosen mechanism is @capacitor/preferences — the same native, app-sandboxed
// store the auth token already uses (Android SharedPreferences underneath). What makes
// it hold 30 days of receipts (D9) rather than buckle under them is the layout: ONE
// KEY PER RECORD, never one growing JSON blob. A blob would be re-serialised and
// rewritten on every save and would tear if a write were interrupted mid-receipt; a
// key per record writes only the record that changed, and a torn write can lose at
// most that one key. Keys are enumerable (`Preferences.keys()`), so an ordered listing
// comes from sorting keys rather than from an index that could drift out of step with
// the records it indexes.
//
// Sizing: at the shop's volume, 30 days is on the order of a thousand receipts of a
// couple of KB each — low single-digit MB across a thousand-odd keys, well inside what
// SharedPreferences handles. If the local history ever outgrows that, D17's answer is
// a real native storage plugin (@capacitor-community/sqlite), never a fall back to
// WebView storage. This module is the seam for that swap: everything above it speaks
// only get/set/remove/keys, so replacing the backend is one file.
//
// Justification of record: docs/product/proposals/v2-5-offline-accessibility.md §D17.

const isNative = Capacitor.isNativePlatform();

// Local browser dev (`npm run dev`) has no native store, and D17 forbids reaching for
// the WebView one. So dev gets an in-memory map: the offline machinery runs and can be
// exercised, but nothing survives a page reload. That is a deliberate dev-only
// limitation, not a storage tier — production is the APK, where the native store is
// real. Test code uses the same map.
const memory = new Map();

const memoryBackend = {
  async get(key) { return memory.has(key) ? memory.get(key) : null; },
  async set(key, value) { memory.set(key, value); },
  async remove(key) { memory.delete(key); },
  async keys() { return [...memory.keys()]; },
};

const preferencesBackend = {
  async get(key) { const { value } = await Preferences.get({ key }); return value ?? null; },
  async set(key, value) { await Preferences.set({ key, value }); },
  async remove(key) { await Preferences.remove({ key }); },
  async keys() { const { keys } = await Preferences.keys(); return keys || []; },
};

let backend = isNative ? preferencesBackend : memoryBackend;

// Test seam only — lets a test drive the layer without Capacitor. Production code
// never calls this.
export function __setBackend(next) {
  backend = next || (isNative ? preferencesBackend : memoryBackend);
}

export function __resetMemoryBackend() {
  memory.clear();
  backend = memoryBackend;
}

export const nativeStore = {
  isNative,
  getString: (key) => backend.get(key),
  setString: (key, value) => backend.set(key, String(value)),
  remove: (key) => backend.remove(key),
  keys: () => backend.keys(),

  async getJson(key) {
    const raw = await backend.get(key);
    if (raw == null) return null;
    try {
      return JSON.parse(raw);
    } catch {
      // A record that cannot be parsed is corrupt, not absent. Do not delete it —
      // a silently dropped receipt is the failure mode this whole release is about.
      // Leave it in place for the attention list (piece 4) to surface.
      return null;
    }
  },

  async setJson(key, value) {
    await backend.set(key, JSON.stringify(value));
  },

  async keysWithPrefix(prefix) {
    const all = await backend.keys();
    return all.filter((k) => k.startsWith(prefix)).sort();
  },
};
