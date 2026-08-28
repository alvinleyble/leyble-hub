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
      if (me) await api.setCachedUser(me);
    } catch (err) {
      if (err?.status === 401) {
        // Genuine 401 from server: clear user session
        setUser(null);
        await api.setCachedUser(null);
      } else {
        // D15: A network failure, timeout, or DNS error must NEVER log the tablet out.
        // Recover cached user session if available from native storage or decoded JWT.
        try {
          const cached = await api.getCachedUser();
          setUser(cached || null);
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
    if (me) await api.setCachedUser(me);
    return me;
  };

  const logout = async () => {
    try { await api.post('/auth/logout'); } catch { /* ignore */ }
    setUser(null);
    await api.setCachedUser(null);
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
