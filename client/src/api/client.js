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

async function request(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...options.headers };
  const token = await getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const activeProfile = await getActiveProfile();
  if (activeProfile) headers['X-Active-Profile'] = activeProfile;

  const res = await fetch(`${BASE}${path}`, {
    credentials: 'include',
    ...options,
    headers,
  });

  if (res.status === 401) {
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
  get:   (path)       => request(path),
  post:  (path, body) => request(path, { method: 'POST',  body: JSON.stringify(body) }),
  patch: (path, body) => request(path, { method: 'PATCH', body: JSON.stringify(body) }),
  del:   (path)       => request(path, { method: 'DELETE' }),
  getActiveProfile,
  setActiveProfile,
};
