import { useState, useEffect, useCallback } from 'react';
import { V25_OFFLINE_CORE, isSimulatedOffline } from '../config/features';
import { waitingCount, listNeedsAttention, subscribeOutbox } from './outbox';

/**
 * Checks current online status taking simulated offline into account.
 */
export function checkIsOnline() {
  if (isSimulatedOffline()) return false;
  if (typeof navigator !== 'undefined' && typeof navigator.onLine === 'boolean') {
    return navigator.onLine;
  }
  return true;
}

/**
 * Live React hook for offline & outbox queue state.
 */
export function useOfflineStatus() {
  const [isOnline, setIsOnline] = useState(checkIsOnline);
  const [waiting, setWaiting] = useState(0);
  const [needsAttention, setNeedsAttention] = useState(0);

  const refresh = useCallback(async () => {
    setIsOnline(checkIsOnline());
    if (!V25_OFFLINE_CORE) return;
    try {
      const [wCount, attn] = await Promise.all([
        waitingCount(),
        listNeedsAttention(),
      ]);
      setWaiting(wCount);
      setNeedsAttention(attn.length);
    } catch {
      // Ignore reading errors
    }
  }, []);

  useEffect(() => {
    refresh();

    const handleOnline = () => { setIsOnline(checkIsOnline()); refresh(); };
    const handleOffline = () => { setIsOnline(false); refresh(); };

    if (typeof window !== 'undefined') {
      window.addEventListener('online', handleOnline);
      window.addEventListener('offline', handleOffline);
    }

    const unsubscribe = subscribeOutbox(() => {
      refresh();
    });

    const interval = setInterval(refresh, 5000);

    return () => {
      if (typeof window !== 'undefined') {
        window.removeEventListener('online', handleOnline);
        window.removeEventListener('offline', handleOffline);
      }
      unsubscribe();
      clearInterval(interval);
    };
  }, [refresh]);

  return {
    isOnline,
    waitingCount: waiting,
    needsAttentionCount: needsAttention,
    refresh,
  };
}
