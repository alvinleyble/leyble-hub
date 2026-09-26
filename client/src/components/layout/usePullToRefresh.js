import { useEffect, useRef, useState } from 'react';

// Distances are in on-screen pixels AFTER damping, so the finger travels about twice
// as far — the rubber-band feel every phone app has.
export const PULL_THRESHOLD = 64;
export const PULL_MAX = 96;
const DAMPING = 0.5;
// Movement below this is not yet a direction; it decides pull vs scroll vs swipe.
const SLOP = 8;

/**
 * True when a touch that started on `target` must not become a pull-to-refresh on
 * `container`: it is outside the container, inside something fixed on top of it (a
 * modal, drawer, side panel or bottom sheet — they render inside the page's DOM, so
 * their touches reach the container too), inside a dialog, or inside an inner
 * scrollable area that is itself not at its top (the finger means "scroll this up").
 * `data-no-pull-refresh` opts any subtree out explicitly.
 */
export function shouldIgnorePull(target, container) {
  if (!container || !target || !container.contains(target)) return true;
  const view = container.ownerDocument?.defaultView;
  for (let el = target; el && el !== container; el = el.parentElement) {
    if (el.nodeType !== 1) continue;
    if (el.hasAttribute('data-no-pull-refresh')) return true;
    if (el.getAttribute('role') === 'dialog' || el.getAttribute('aria-modal') === 'true') return true;
    if (el.scrollTop > 0) return true;
    const style = view?.getComputedStyle?.(el);
    if (style?.position === 'fixed') return true;
  }
  return false;
}

/**
 * Standard pull-down-to-refresh on a scroll container. Only arms when the container is
 * scrolled to its very top, and only once the finger has clearly moved DOWN (a mostly
 * sideways move is left to horizontal scrollers such as category chips). While a pull
 * is live the touchmove default is cancelled, so the WebView neither scrolls nor
 * paints its own overscroll glow under the indicator.
 *
 * Returns the current damped pull distance in px (0 when idle) for the indicator.
 */
export function usePullToRefresh(containerRef, { onRefresh, disabled = false } = {}) {
  const [pull, setPull] = useState(0);
  const onRefreshRef = useRef(onRefresh);
  const disabledRef = useRef(disabled);
  useEffect(() => { onRefreshRef.current = onRefresh; });
  useEffect(() => { disabledRef.current = disabled; }, [disabled]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;

    // idle → pending (touch down at top) → pulling (moved down) → idle
    let phase = 'idle';
    let startX = 0;
    let startY = 0;
    let distance = 0;

    const reset = () => {
      phase = 'idle';
      distance = 0;
      setPull(0);
    };

    const onStart = (e) => {
      phase = 'idle';
      if (disabledRef.current || e.touches.length !== 1) return;
      if (container.scrollTop > 0) return;
      if (shouldIgnorePull(e.target, container)) return;
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      phase = 'pending';
    };

    const onMove = (e) => {
      if (phase === 'idle') return;
      if (e.touches.length !== 1) { reset(); return; }
      const dx = e.touches[0].clientX - startX;
      const dy = e.touches[0].clientY - startY;
      if (phase === 'pending') {
        if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return;
        if (dy <= 0 || Math.abs(dx) > Math.abs(dy) || container.scrollTop > 0) {
          phase = 'idle';
          return;
        }
        phase = 'pulling';
      }
      if (dy <= 0) { reset(); return; }
      if (e.cancelable) e.preventDefault();
      distance = Math.min(PULL_MAX, (dy - SLOP) * DAMPING);
      setPull(Math.max(0, distance));
    };

    const onEnd = (e) => {
      const fire = phase === 'pulling' && e.type === 'touchend' && distance >= PULL_THRESHOLD;
      if (phase !== 'idle') reset();
      if (fire) onRefreshRef.current?.();
    };

    container.addEventListener('touchstart', onStart, { passive: true });
    // Not passive: a live pull has to be able to cancel the native scroll/overscroll.
    container.addEventListener('touchmove', onMove, { passive: false });
    container.addEventListener('touchend', onEnd);
    container.addEventListener('touchcancel', onEnd);
    return () => {
      container.removeEventListener('touchstart', onStart);
      container.removeEventListener('touchmove', onMove);
      container.removeEventListener('touchend', onEnd);
      container.removeEventListener('touchcancel', onEnd);
    };
  }, [containerRef]);

  return pull;
}
