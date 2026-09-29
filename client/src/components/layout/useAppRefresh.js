import { useState, useCallback, useRef } from 'react';
import { refreshApp } from '../../offline/refresh.js';
import { useToast } from '../ui/Toast.jsx';

// Long enough that a refresh answered instantly still reads as "it did something".
const MIN_SPIN_MS = 400;

/**
 * The UI half of a refresh: runs `refreshApp()` and tracks whether it is running, for
 * the spinner at the top of the page. It speaks only when something is wrong — offline,
 * or the refresh itself failed. A normal refresh ends silently, like any other app.
 */
export function useAppRefresh() {
  const [refreshing, setRefreshing] = useState(false);
  const runningRef = useRef(false);
  const { addToast } = useToast();

  const refresh = useCallback(async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    setRefreshing(true);
    const minSpin = new Promise((resolve) => setTimeout(resolve, MIN_SPIN_MS));
    try {
      const { online } = await refreshApp();
      await minSpin;
      if (!online) addToast("You're offline — showing what's saved on this tablet.", 'info');
    } catch {
      await minSpin;
      addToast('Refresh failed. Please try again.', 'error');
    } finally {
      runningRef.current = false;
      setRefreshing(false);
    }
  }, [addToast]);

  return { refresh, refreshing };
}
