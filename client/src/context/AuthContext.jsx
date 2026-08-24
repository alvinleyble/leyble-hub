import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { api } from '../api/client';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser]       = useState(null);
  const [loading, setLoading] = useState(true);

  const checkAuth = useCallback(async () => {
    try {
      const me = await api.get('/auth/me');
      setUser(me);
      try {
        if (me) localStorage.setItem('cached_user', JSON.stringify(me));
      } catch {}
    } catch (err) {
      if (err?.status === 401) {
        // Genuine 401 from server: clear user session
        setUser(null);
        try { localStorage.removeItem('cached_user'); } catch {}
      } else {
        // D15: A network failure, timeout, or DNS error must NEVER log the tablet out.
        // Recover cached user session if available.
        try {
          const raw = localStorage.getItem('cached_user');
          if (raw) {
            setUser(JSON.parse(raw));
          } else {
            setUser(null);
          }
        } catch {
          setUser(null);
        }
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { checkAuth(); }, [checkAuth]);

  const login = async (email, password) => {
    const me = await api.post('/auth/login', { email, password });
    setUser(me);
    try {
      if (me) localStorage.setItem('cached_user', JSON.stringify(me));
    } catch {}
    return me;
  };

  const logout = async () => {
    try { await api.post('/auth/logout'); } catch { /* ignore */ }
    setUser(null);
    try { localStorage.removeItem('cached_user'); } catch {}
  };

  return (
    <AuthContext.Provider value={{ user, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
