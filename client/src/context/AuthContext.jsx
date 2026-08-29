import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import { api } from '../api/client';
import { SESSION_KEY, LAST_IDENTITY_KEY } from '../offline/keys';

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

export async function setStoredSession(session) {
  await writeIdentity(SESSION_KEY, session);
  await writeIdentity(LAST_IDENTITY_KEY, session);
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

  const login = async (email, password) => {
    const me = await api.post('/auth/login', { email, password });
    setUser(me);
    if (me) await setStoredSession(me);
    return me;
  };

  const logout = async () => {
    try { await api.post('/auth/logout'); } catch { /* ignore */ }
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
    <AuthContext.Provider value={{ user, loading, login, logout, checkAuth, resumeOfflineSession }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
