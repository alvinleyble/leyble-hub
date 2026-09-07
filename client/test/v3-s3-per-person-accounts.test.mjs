// ADR 0017 §5/§6 — profiles are deleted as a concept. Each person signs in with their
// own account, so nothing stands between a successful login and the app shell, and the
// chrome names the signed-in person rather than a picked persona.
//
// These are the app-half checks the on-device Appium suite used to cover with its
// `profile-picker` assertions (e2e/appium/helpers/auth.js), plus the one piece of
// plumbing that quietly depended on the picker: the account a locally-saved record is
// attributed to, which now comes from the session rather than from a pick.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, React, act } from './render.mjs';
import { api } from '../src/api/client.js';
import { AuthProvider, setStoredSession, __setIsNativeForTest } from '../src/context/AuthContext.jsx';

const Sidebar = (await import('../src/components/layout/Sidebar.jsx')).default;

let originalApiGet;

beforeEach(() => {
  originalApiGet = api.get;
  api.get = async () => [];
  __setIsNativeForTest(false);
  localStorage.clear();
});

afterEach(() => {
  api.get = originalApiGet;
  __setIsNativeForTest(false);
});

test('the sidebar names the signed-in account and offers no profile switch', async () => {
  api.get = async (path) => {
    if (path === '/auth/me') return { id: 2, email: 'luis@leyblestore.com', full_name: 'Luis', role: 'admin' };
    if (path === '/customers') return [];
    throw new Error(`unexpected GET ${path}`);
  };

  const view = render(React.createElement(AuthProvider, null, React.createElement(Sidebar)));
  await act(async () => { await Promise.resolve(); });

  assert.match(view.text(), /Luis/, 'the chrome names whoever signed in');
  assert.doesNotMatch(view.text(), /Switch profile/, 'the profile switch is gone with the picker');
  assert.match(view.text(), /Log out/, 'signing out is still the way off an account');
  view.unmount();
});

test('nothing asks the server for a profile list any more', async () => {
  const asked = [];
  api.get = async (path) => {
    asked.push(path);
    if (path === '/auth/me') return { id: 1, email: 'josie@leyblestore.com', full_name: 'Josie', role: 'admin' };
    return [];
  };

  const view = render(React.createElement(AuthProvider, null, React.createElement(Sidebar)));
  await act(async () => { await Promise.resolve(); });

  assert.equal(asked.includes('/auth/profiles'), false, 'GET /auth/profiles is deleted server-side');
  view.unmount();
});

test('a session makes its own account the author of everything saved on this device', async () => {
  // D14 still needs an author per queued record; it is now the signed-in account rather
  // than a picked profile, so establishing a session is what supplies it.
  await setStoredSession({ id: 3, email: 'alvin@leyblestore.com', full_name: 'Admin', role: 'admin' });
  assert.equal(await api.getActiveProfile(), 'alvin@leyblestore.com');

  await setStoredSession({ id: 2, email: 'luis@leyblestore.com', full_name: 'Luis', role: 'admin' });
  assert.equal(await api.getActiveProfile(), 'luis@leyblestore.com',
    'signing in as someone else re-points it — that is the only way it moves now');
});

test('no request carries an X-Active-Profile header', async () => {
  const seen = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    seen.push(options.headers);
    return {
      status: 200, ok: true,
      headers: { get: () => 'application/json' },
      json: async () => ({ ok: true }),
    };
  };
  try {
    localStorage.setItem('activeProfile', 'josie@leyblestore.com');
    await api.request('/orders');
    // Even when a caller still passes the per-record author, it stays off the wire.
    await api.request('/orders', { method: 'POST', body: '{}', profileKey: 'luis@leyblestore.com' });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(seen.length, 2);
  for (const headers of seen) {
    assert.equal('X-Active-Profile' in headers, false);
  }
});
