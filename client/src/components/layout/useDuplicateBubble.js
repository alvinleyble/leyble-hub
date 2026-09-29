import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api/client';
import { nativeStore } from '../../offline/nativeStore';
import { useRefreshListener } from '../../offline/refresh';
import { countDuplicateCustomers } from '../../utils/duplicateCustomers';

// The possible-duplicate count the operator has already been shown, so the Customers
// tab's bubble stays down until there are MORE duplicates than they last saw. Device
// state like the rest of `v25.` — it survives a restart, so the bubble does not pop
// back up every morning for duplicates nobody has merged yet.
export const SEEN_DUPLICATES_KEY = 'v25.ui.customerDuplicatesSeen';
const POLL_MS = 30_000;

/**
 * What the "seen" count becomes. Opening Customers marks every current duplicate as
 * seen. Anywhere else it only ever falls with the count — merging duplicates away has
 * to lower it, or new ones would stay hidden until they outnumbered the old total.
 */
export function nextSeenCount(count, seen, onCustomers) {
  if (onCustomers) return count;
  return Math.min(seen, count);
}

export function shouldShowBubble(count, seen, onCustomers) {
  return !onCustomers && count > seen;
}

/**
 * The number to show on the Customers tab's bubble, or 0 for no bubble. `enabled`
 * mirrors the old sidebar badge, which only ran with the offline core switched on.
 */
export function useDuplicateBubble({ enabled, onCustomers }) {
  const [count, setCount] = useState(null);
  const [seen, setSeen] = useState(null);

  useEffect(() => {
    if (!enabled) return undefined;
    let mounted = true;
    nativeStore.getString(SEEN_DUPLICATES_KEY)
      .then((raw) => {
        const n = Number(raw);
        if (mounted) setSeen(raw != null && Number.isFinite(n) ? n : 0);
      })
      .catch(() => { if (mounted) setSeen(0); });
    return () => { mounted = false; };
  }, [enabled]);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  const check = useCallback(async () => {
    try {
      const data = await api.get('/customers');
      if (mountedRef.current && Array.isArray(data)) setCount(countDuplicateCustomers(data));
    } catch {}
  }, []);

  // Re-checked on a timer, whenever the operator leaves or enters Customers (so a merge
  // done there shows as soon as they come back out), and on every refresh.
  useEffect(() => {
    if (!enabled) return undefined;
    check();
    const interval = setInterval(check, POLL_MS);
    return () => clearInterval(interval);
  }, [enabled, onCustomers, check]);
  useRefreshListener(() => (enabled ? check() : undefined));

  useEffect(() => {
    if (count == null || seen == null) return;
    const next = nextSeenCount(count, seen, onCustomers);
    if (next === seen) return;
    setSeen(next);
    nativeStore.setString(SEEN_DUPLICATES_KEY, next).catch(() => {});
  }, [count, seen, onCustomers]);

  if (!enabled || count == null || seen == null) return 0;
  return shouldShowBubble(count, seen, onCustomers) ? count : 0;
}
