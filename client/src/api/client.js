import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';

const BASE = (import.meta.env.VITE_API_URL || '') + '/api/v1';

// Web (dev) authenticates with an HTTP-only cookie. The native Android app
// (Capacitor) can't use SameSite=strict cookies cross-origin, so it stores the
// JWT in @capacitor/preferences (native, app-sandboxed storage — NOT browser
// localStorage) and sends it as an Authorization: Bearer header instead.
const isNative = Capacitor.isNativePlatform();
const TOKEN_KEY = 'authToken';
// The account signed in on this device. ADR 0017 §5 deleted profiles, so this is no
// longer a picked persona — it is written from the login response and cleared on logout
// or a genuine 401, exactly like the token beside it. Nothing is sent to the server from
// it: the JWT already carries the identity. It exists so a record queued in the outbox
// can record WHO SAVED IT locally (D14) even after the app is closed and reopened.
const ACCOUNT_KEY = 'activeProfile';

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

// Who is signed in on this device, as a stable string (the account's email).
// Native: @capacitor/preferences (app-sandboxed, survives restarts). Web dev: localStorage.
// The storage key keeps its pre-0017 name so a device upgrading mid-outage does not lose
// the value already sitting beside its still-queued outbox records.
async function getActiveProfile() {
  if (!isNative) return localStorage.getItem(ACCOUNT_KEY);
  const { value } = await Preferences.get({ key: ACCOUNT_KEY });
  return value || null;
}

async function setActiveProfile(accountKey) {
  if (!isNative) {
    if (accountKey) localStorage.setItem(ACCOUNT_KEY, accountKey);
    else localStorage.removeItem(ACCOUNT_KEY);
    return;
  }
  if (accountKey) await Preferences.set({ key: ACCOUNT_KEY, value: accountKey });
  else await Preferences.remove({ key: ACCOUNT_KEY });
}

// ADR 0017 §5 — there is no `X-Active-Profile` header any more. Each person signs in
// with their own account, so the JWT alone says who is acting and the server has nothing
// to swap. The outbox still stores the account that made each record (D14), but that is
// now local-only bookkeeping; slice 5's remembered accounts is what will give it a wire
// form again once one device can hold more than one signed-in person.
async function request(path, options = {}) {
  // `profileKey` is pulled off and dropped rather than ignored in place, so a caller
  // still passing the per-record author (the outbox drain does) can't leak it into fetch.
  const { profileKey: _localAuthor, ...fetchOptions } = options;
  const headers = { 'Content-Type': 'application/json', ...fetchOptions.headers };
  const token = await getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

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
    const err = new Error('Unauthenticated');
    err.status = 401;
    throw err;
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
  // The outbox drain builds its own request (method and body come off the queued
  // record), so it needs the raw form.
  request,
  getActiveProfile,
  setActiveProfile,
};
