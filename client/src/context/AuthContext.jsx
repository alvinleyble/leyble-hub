import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import { api } from '../api/client';
import { SESSION_KEY } from '../offline/keys';

const AuthContext = createContext(null);

let isNative = Capacitor.isNativePlatform();

export function __setIsNativeForTest(val) {
  isNative = val ?? Capacitor.isNativePlatform();
}

export async function getStoredSession() {
  try {
    if (isNative) {
      const { value } = await Preferences.get({ key: SESSION_KEY });
      if (value) return JSON.parse(value);
      if (typeof localStorage !== 'undefined') {
        const raw = localStorage.getItem(SESSION_KEY) || localStorage.getItem('cached_user');
        if (raw) return JSON.parse(raw);
      }
      return null;
    }
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(SESSION_KEY) || localStorage.getItem('cached_user');
      return raw ? JSON.parse(raw) : null;
    }
    return null;
  } catch {
    return null;
  }
}

export async function setStoredSession(session) {
  try {
    const raw = JSON.stringify(session);
    if (isNative) {
      await Preferences.set({ key: SESSION_KEY, value: raw });
    }
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(SESSION_KEY, raw);
    }
  } catch {}
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

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, checkAuth }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
