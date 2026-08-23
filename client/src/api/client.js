import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';

const BASE = (import.meta.env.VITE_API_URL || '') + '/api/v1';

// Web (dev) authenticates with an HTTP-only cookie. The native Android app
// (Capacitor) can't use SameSite=strict cookies cross-origin, so it stores the
// JWT in @capacitor/preferences (native, app-sandboxed storage — NOT browser
// localStorage) and sends it as an Authorization: Bearer header instead.
const isNative = Capacitor.isNativePlatform();
const TOKEN_KEY = 'authToken';
const PROFILE_KEY = 'activeProfile';

async function getToken() {
  if (!isNative) return null;
  const { value } = await Preferences.get({ key: TOKEN_KEY });
  return value || null;
}

async function setToken(token) {
  if (!isNative) return;
  if (token) await Preferences.set({ key: TOKEN_KEY, value: token });
  else await Preferences.remove({ key: TOKEN_KEY });
}

// Which of Josie / Luis / Admin is currently driving the app — see server/src/middleware/auth.js.
// Native: @capacitor/preferences (app-sandboxed, survives restarts). Web dev: localStorage.
async function getActiveProfile() {
  if (!isNative) return localStorage.getItem(PROFILE_KEY);
  const { value } = await Preferences.get({ key: PROFILE_KEY });
  return value || null;
}

async function setActiveProfile(profileKey) {
  if (!isNative) {
    if (profileKey) localStorage.setItem(PROFILE_KEY, profileKey);
    else localStorage.removeItem(PROFILE_KEY);
    return;
  }
  if (profileKey) await Preferences.set({ key: PROFILE_KEY, value: profileKey });
  else await Preferences.remove({ key: PROFILE_KEY });
}

// `options.profileKey` overrides the currently active profile for this one call.
// D14: a record queued in the outbox carries the profile that was active when it was
// SAVED, and the drain replays that profile per record. Without this override every
// receipt from a Tuesday outage would be filed under whoever happens to be holding the
// tablet when the line comes back — Josie credited with Luis's day, in the activity log
// and in the stock movements alike.
async function request(path, options = {}) {
  const { profileKey, ...fetchOptions } = options;
  const headers = { 'Content-Type': 'application/json', ...fetchOptions.headers };
  const token = await getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const activeProfile = profileKey ?? (await getActiveProfile());
  if (activeProfile) headers['X-Active-Profile'] = activeProfile;

  const res = await fetch(`${BASE}${path}`, {
    credentials: 'include',
    ...fetchOptions,
    headers,
  });

  if (res.status === 401) {
    // Clears session state by name only. D15: the device's station number, its waiting
    // receipts and its local receipt history live under the `v25.` prefix and are
    // device state, not session state — they must survive logout and re-login, so this
    // must never become a prefix sweep of native storage.
    await setToken(null);
    await setActiveProfile(null);
    if (window.location.pathname !== '/login') {
      window.location.href = '/login';
    }
    throw new Error('Unauthenticated');
  }

  const contentType = res.headers.get('Content-Type') || '';
  const data = contentType.includes('application/json') ? await res.json() : null;

  if (!res.ok) {
    const err = new Error(data?.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.data = data;
    throw err;
  }

  // Persist / clear the native token around auth transitions (no-op on web).
  if (path === '/auth/login' && data?.token) await setToken(data.token);
  if (path === '/auth/logout') {
    await setToken(null);
    await setActiveProfile(null);
  }

  return data;
}

export const api = {
  get:   (path,       opts) => request(path, { ...opts }),
  post:  (path, body, opts) => request(path, { ...opts, method: 'POST',  body: JSON.stringify(body) }),
  patch: (path, body, opts) => request(path, { ...opts, method: 'PATCH', body: JSON.stringify(body) }),
  del:   (path,       opts) => request(path, { ...opts, method: 'DELETE' }),
  // The outbox drain builds its own request (method, body and per-record profile all
  // come off the queued record), so it needs the raw form.
  request,
  getActiveProfile,
  setActiveProfile,
};
