import { useEffect, useRef } from 'react';
import { probeReachability, checkIsOnline, markOnline, markOffline } from './status.js';
import { drainOutbox, waitingCount } from './outbox.js';

export const REFRESH_EVENT = 'leyble:refresh';

// A page's reload normally lands in well under a second; this only bounds how long the
// refresh spinner waits on one that hangs (the API's own 5s timeout plus a cache read).
const RELOAD_WAIT_CAP_MS = 8000;

let inFlight = null;

/**
 * The one refresh routine, shared by pull-down and by re-clicking the open page's menu
 * item (it used to live inside the header's refresh button):
 *   1. force a reachability probe and record the answer,
 *   2. send any waiting records if the line is up,
 *   3. dispatch `leyble:refresh` so the page on screen reloads its data.
 *
 * Listeners may hand their reload's promise to `event.detail.waitUntil(promise)`; the
 * routine resolves once those settle (capped), so the spinner covers the reload itself
 * rather than vanishing before the rows change. Overlapping calls share one run.
 *
 * Resolves `{ online }`. Rejects only if the routine itself breaks — every step that
 * can fail on a bad line already degrades to "offline" on its own.
 */
export function refreshApp({ waitCapMs = RELOAD_WAIT_CAP_MS } = {}) {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    await probeReachability({ force: true }).catch(() => {});
    const online = checkIsOnline(true);
    if (online) markOnline();
    else markOffline();

    const count = await waitingCount().catch(() => 0);
    if (online && count > 0) {
      await drainOutbox().catch(() => {});
    }

    const waits = [];
    const Evt = (typeof window !== 'undefined' && window.CustomEvent) || globalThis.CustomEvent;
    if (typeof window !== 'undefined' && Evt) {
      window.dispatchEvent(new Evt(REFRESH_EVENT, {
        detail: { online, waitUntil: (p) => { if (p && typeof p.then === 'function') waits.push(p); } },
      }));
    }
    if (waits.length > 0) {
      let timer;
      await Promise.race([
        Promise.allSettled(waits),
        new Promise((resolve) => { timer = setTimeout(resolve, waitCapMs); }),
      ]);
      clearTimeout(timer);
    }
    return { online };
  })().finally(() => { inFlight = null; });
  return inFlight;
}

/**
 * Reload this screen when the app is refreshed. `handler` may return its reload's
 * promise so the refresh spinner stays up until the data has landed. The latest
 * handler is always the one called, so it can close over current state freely.
 */
export function useRefreshListener(handler) {
  const handlerRef = useRef(handler);
  useEffect(() => { handlerRef.current = handler; });
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const onRefresh = (event) => {
      const result = handlerRef.current?.(event);
      event.detail?.waitUntil?.(result);
    };
    window.addEventListener(REFRESH_EVENT, onRefresh);
    return () => window.removeEventListener(REFRESH_EVENT, onRefresh);
  }, []);
}
