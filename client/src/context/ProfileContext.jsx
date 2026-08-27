import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { api } from '../api/client';

const ProfileContext = createContext(null);

// Netflix-style "who's using this" — separate from login (see CLAUDE.md: single shared
// login, but activity_logs.performed_by needs to attribute the right person).
export function ProfileProvider({ children }) {
  const [profiles, setProfiles]           = useState([]);
  const [activeProfile, setActiveProfile] = useState(null);
  const [needsPick, setNeedsPick]         = useState(false);
  const [loading, setLoading]             = useState(true);

  useEffect(() => {
    (async () => {
      let list = [];
      let persistedKey = null;
      try {
        [list, persistedKey] = await Promise.all([
          api.get('/auth/profiles'),
          api.getActiveProfile(),
        ]);
        if (Array.isArray(list) && list.length > 0) {
          try { localStorage.setItem('cached_profiles', JSON.stringify(list)); } catch {}
        }
      } catch {
        try {
          const raw = localStorage.getItem('cached_profiles');
          if (raw) list = JSON.parse(raw);
          else {
            list = [
              { profile_key: 'josie', full_name: 'Josie' },
              { profile_key: 'luis', full_name: 'Luis' },
              { profile_key: 'admin', full_name: 'Admin' },
            ];
          }
        } catch {
          list = [
            { profile_key: 'josie', full_name: 'Josie' },
            { profile_key: 'luis', full_name: 'Luis' },
            { profile_key: 'admin', full_name: 'Admin' },
          ];
        }
        persistedKey = await api.getActiveProfile();
      }
      setProfiles(list);
      const persisted = list.find((p) => p.profile_key === persistedKey) || null;
      setActiveProfile(persisted);
      setNeedsPick(!persisted);
      setLoading(false);
    })();
  }, []);

  const chooseProfile = useCallback(async (profileKey) => {
    await api.setActiveProfile(profileKey);
    setActiveProfile((prev) => profiles.find((p) => p.profile_key === profileKey) || prev);
    setNeedsPick(false);
  }, [profiles]);

  const switchProfile = useCallback(() => setNeedsPick(true), []);

  return (
    <ProfileContext.Provider value={{ profiles, activeProfile, needsPick, loading, chooseProfile, switchProfile }}>
      {children}
    </ProfileContext.Provider>
  );
}

export function useProfile() {
  const ctx = useContext(ProfileContext);
  if (!ctx) throw new Error('useProfile must be used within ProfileProvider');
  return ctx;
}
