import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import { NS } from './keys.js';

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
// the WebView one — that ban is about the production APK's WebView specifically
// (Android evicts it under pressure, "clear data" wipes it), not about a desktop
// browser tab that a developer controls. Round 2 Fix 3: without *some* persistence
// here, every reload during dev looked like a brand-new device to `station.js` and
// minted a fresh station number from the server — reproduced live as station
// numbers climbing past 40 from a single login. So dev prefers `window.localStorage`
// (same origin-scoped, per-tab-profile persistence Vite dev already relies on for
// the auth cookie's browser-only sibling path) and falls back to the in-memory map
// only when localStorage is unavailable or throws (private browsing, disabled
// storage, or the plain Node test runner). Test code forces the in-memory map via
// `__resetMemoryBackend()` regardless of what's available, so this never affects
// test isolation. Production is still the APK, where `preferencesBackend` is used
// unconditionally either way.
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

function detectLocalStorageBackend() {
  if (typeof window === 'undefined' || !window.localStorage) return null;
  try {
    const probeKey = `${NS}__probe__`;
    window.localStorage.setItem(probeKey, '1');
    window.localStorage.removeItem(probeKey);
  } catch {
    return null;
  }
  const ls = window.localStorage;
  return {
    async get(key) { try { return ls.getItem(key); } catch { return null; } },
    async set(key, value) { try { ls.setItem(key, value); } catch { /* quota/private-mode: degrade silently, same as an unreachable native store */ } },
    async remove(key) { try { ls.removeItem(key); } catch {} },
    async keys() {
      try {
        const out = [];
        for (let i = 0; i < ls.length; i++) {
          const k = ls.key(i);
          // Only ever return this store's own keys — localStorage is shared with
          // unrelated app state (authToken, activeProfile, preferred_ui, ...).
          if (k && k.startsWith(NS)) out.push(k);
        }
        return out;
      } catch { return []; }
    },
  };
}

const localStorageBackend = detectLocalStorageBackend();

let backend = isNative ? preferencesBackend : (localStorageBackend || memoryBackend);

// Test seam only — lets a test drive the layer without Capacitor. Production code
// never calls this.
export function __setBackend(next) {
  backend = next || (isNative ? preferencesBackend : (localStorageBackend || memoryBackend));
}

export function __resetMemoryBackend() {
  memory.clear();
  backend = memoryBackend;
}

// Test seam only — opts into the real (non-native) browser-dev default so a test can
// verify it actually persists to window.localStorage rather than the in-memory map
// every other test forces via __resetMemoryBackend() above.
export function __useLocalStorageBackendForTest() {
  if (!localStorageBackend) throw new Error('window.localStorage is unavailable in this test environment');
  backend = localStorageBackend;
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
