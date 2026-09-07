import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import { api } from '../api/client';
import { SESSION_KEY, LAST_IDENTITY_KEY } from '../offline/keys';
import { rememberAccount, markAccountUsed, findRememberedAccount } from '../offline/accounts';
// Imported from the module itself rather than the `offline` barrel: the barrel pulls in
// the whole engine (outbox, sync, catalogue), and this file is on the login path.
import { getStation, ensureStationRegistered } from '../offline/station';

const AuthContext = createContext(null);

let isNative = Capacitor.isNativePlatform();

export function __setIsNativeForTest(val) {
  isNative = val ?? Capacitor.isNativePlatform();
}

async function readIdentity(key, legacyKey) {
  try {
    if (isNative) {
      const { value } = await Preferences.get({ key });
      if (value) return JSON.parse(value);
      if (typeof localStorage !== 'undefined') {
        const raw = localStorage.getItem(key) || (legacyKey && localStorage.getItem(legacyKey));
        if (raw) return JSON.parse(raw);
      }
      return null;
    }
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(key) || (legacyKey && localStorage.getItem(legacyKey));
      return raw ? JSON.parse(raw) : null;
    }
    return null;
  } catch {
    return null;
  }
}

async function writeIdentity(key, session) {
  try {
    const raw = JSON.stringify(session);
    if (isNative) {
      await Preferences.set({ key, value: raw });
    }
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(key, raw);
    }
  } catch {}
}

export async function getStoredSession() {
  return readIdentity(SESSION_KEY, 'cached_user');
}

// Kept alongside SESSION_KEY, never cleared by removeStoredSession — this is the
// record ADR 0015 §3's "Resume Offline Session" login action reads once a normal
// logout or a genuine 401 has correctly cleared the live session.
export async function getLastKnownIdentity() {
  return readIdentity(LAST_IDENTITY_KEY);
}

// What is safe to keep on the device as "who is signed in". The login response also
// carries the JWT itself and `session_replaced`; neither belongs in a stored identity —
// on the web dev tier these keys fall back to localStorage (nativeStore.js), and a JWT
// must never land where page script can read it back (CLAUDE.md security rules). The
// token is stored by api/client.js, which keeps it out of browser storage entirely.
function identityOnly(session) {
  if (!session) return session;
  const { token: _token, session_replaced: _replaced, ...identity } = session;
  return identity;
}

export async function setStoredSession(session) {
  const identity = identityOnly(session);
  await writeIdentity(SESSION_KEY, identity);
  await writeIdentity(LAST_IDENTITY_KEY, identity);
  // ADR 0017 §5 — the signed-in account replaces the picked profile as "who is acting on
  // this device". Written here, the one place a session becomes real (fresh login, silent
  // /auth/me refresh, offline resume), and cleared by the 401/logout path in api/client.js.
  // It is never sent to the server; it is what a queued outbox record records locally so a
  // save made during an outage still says who made it (D14).
  if (identity?.email) await api.setActiveProfile(identity.email);
}

export async function removeStoredSession() {
  try {
    if (isNative) {
      await Preferences.remove({ key: SESSION_KEY });
    }
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(SESSION_KEY);
      localStorage.removeItem('cached_user');
    }
  } catch {}
}

export function AuthProvider({ children }) {
  const [user, setUser]       = useState(null);
  const [loading, setLoading] = useState(true);

  const checkAuth = useCallback(async () => {
    try {
      const me = await api.get('/auth/me');
      setUser(me);
      if (me) await setStoredSession(me);
    } catch (err) {
      if (err?.status === 401 || err?.message === 'Unauthenticated') {
        // Genuine 401 from server: clear user session
        setUser(null);
        await removeStoredSession();
      } else {
        // D15 / ADR 0015: A network failure, timeout, or DNS error must NEVER log the tablet out.
        // Recover cached user session from native storage (@capacitor/preferences under v25.session)
        // or sane web fallback with zero user prompt.
        const stored = await getStoredSession();
        setUser(stored);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { checkAuth(); }, [checkAuth]);

  // A password sign-in — the only thing that ever ADDS an account to this device
  // (ADR 0015 §2: a person's first sign-in on a device requires a connection). The
  // device_key rides along so the server can say WHERE this account's live session is
  // when it ends one somewhere else (ADR 0017 #8).
  const login = async (email, password) => {
    const station = await getStation().catch(() => null);
    const me = await api.post('/auth/login', {
      email, password, device_key: station?.device_key || undefined,
    });
    const identity = { id: me.id, email: me.email, full_name: me.full_name, role: me.role };
    setUser(identity);
    await setStoredSession(identity);
    // ADR 0017 #7 — this account has now proven itself on this tablet, so switching back
    // to it is two taps and no password from here on, blackout or not.
    await rememberAccount(identity, me.token);
    return me;
  };

  /**
   * ADR 0017 #7 — switch to an account this device already remembers. Two taps, no
   * password, and no server round trip: this is what has to work mid-blackout when Josie
   * takes over Alvin's tablet and the receipt has to say Josie.
   *
   * The switch is purely local. It moves the active token to that account's own
   * remembered one (api.useAccountToken), so from here on every request — including each
   * queued record the outbox drains — goes out as the right person, and station.js reads
   * the new session to pick that person's device letter for the next receipt number.
   *
   * `verified: false` means this device holds no token for them any more: a session
   * takeover on their other device (ADR 0017 #8), an explicit logout, or the web dev tier
   * after a reload. They can still sell — that is ADR 0015 §3's offline session — and
   * will be asked for their password the moment the line is back.
   */
  const switchAccount = async (idOrEmail) => {
    const account = await findRememberedAccount(idOrEmail);
    if (!account) return null;
    const identity = {
      id: account.id, email: account.email, full_name: account.full_name, role: account.role,
    };
    const verified = await api.useAccountToken(account.email);
    setUser(identity);
    await setStoredSession(identity);
    await markAccountUsed(account.email);
    // Re-confirm this person's device letter when there is a line to do it on. Allocation
    // is idempotent on (account, device) so this never hands out a second letter; offline
    // it simply fails and the drain loop retries it (offline/index.js).
    if (verified) ensureStationRegistered().catch(() => {});
    return { ...identity, verified };
  };

  // Signing out ends the session — on the server too, which clears the one-session row so
  // the token this device held is dead. It does NOT un-remember the account: the list is
  // device state and losing it would strand a tablet that logged out during a blackout
  // (ADR 0015 §3). Nor does it touch the outbox: receipts waiting to sync are device
  // state, and ADR 0017 #8 makes that a hard requirement.
  const logout = async () => {
    const signedOut = user?.email;
    try { await api.post('/auth/logout'); } catch { /* ignore */ }
    if (signedOut) await api.forgetAccountToken(signedOut);
    setUser(null);
    await removeStoredSession();
  };

  // ADR 0015 §3 — the login screen's "Resume Offline Session" action. Restores the
  // last identity this device was ever signed in as (survives logout and 401, unlike
  // SESSION_KEY) with no server round trip, then re-populates SESSION_KEY so the usual
  // silent network-failure restore in checkAuth keeps working from here on. Returns
  // the identity on success, null if this device has never signed in at all.
  const resumeOfflineSession = async () => {
    const identity = await getLastKnownIdentity();
    if (!identity) return null;
    setUser(identity);
    await setStoredSession(identity);
    return identity;
  };

  return (
    <AuthContext.Provider
      value={{ user, loading, login, logout, checkAuth, resumeOfflineSession, switchAccount }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
