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
      const [list, persistedKey] = await Promise.all([
        api.get('/auth/profiles'),
        api.getActiveProfile(),
      ]);
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
