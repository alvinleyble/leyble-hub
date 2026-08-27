import { useCallback, useEffect, useRef } from 'react';

// Press-and-hold to repeat an action, with touch-scroll detection.
//
// A quick tap in place fires once on pointerup.
// A genuine press-and-hold (no movement > threshold for `delay` ms) begins repeating
// every `interval` ms until release/leave/cancel.
// A drag exceeding `threshold` (default 10px) is treated as a scroll gesture: pending actions
// and repeat timers are cancelled, allowing native container scrolling without accidentally
// adding items.
//
// Release is caught on `window` so it still stops if the button disables or unmounts mid-hold.
// Returns handlers to spread onto a <button>; keyboard (Enter/Space) fires once and auto-repeats
// via the OS key-repeat.
export default function useHoldRepeat(action, { delay = 400, interval = 110, threshold = 10 } = {}) {
  const actionRef = useRef(action);
  actionRef.current = action;

  const delayRef = useRef(delay);
  delayRef.current = delay;

  const intervalRef = useRef(interval);
  intervalRef.current = interval;

  const thresholdRef = useRef(threshold);
  thresholdRef.current = threshold;

  const delayTimer = useRef(null);
  const repeatTimer = useRef(null);
  const pointerHandled = useRef(false);
  const isTracking = useRef(false);
  const hasMoved = useRef(false);
  const didHold = useRef(false);
  const startPos = useRef(null);
  const pointerId = useRef(null);

  const cleanupListeners = useRef(null);

  const stop = useCallback(() => {
    if (delayTimer.current) {
      clearTimeout(delayTimer.current);
      delayTimer.current = null;
    }
    if (repeatTimer.current) {
      clearInterval(repeatTimer.current);
      repeatTimer.current = null;
    }
    if (cleanupListeners.current) {
      cleanupListeners.current();
    }
    isTracking.current = false;
    hasMoved.current = true;
    startPos.current = null;
    pointerId.current = null;

    setTimeout(() => {
      pointerHandled.current = false;
    }, 50);
  }, []);

  const onPointerMove = useCallback((e) => {
    if (!isTracking.current || !startPos.current) return;
    if (pointerId.current != null && e.pointerId != null && e.pointerId !== pointerId.current) return;

    const x = e.clientX ?? startPos.current.x;
    const y = e.clientY ?? startPos.current.y;
    const dx = x - startPos.current.x;
    const dy = y - startPos.current.y;

    if (Math.hypot(dx, dy) > thresholdRef.current) {
      hasMoved.current = true;
      if (delayTimer.current) {
        clearTimeout(delayTimer.current);
        delayTimer.current = null;
      }
      if (repeatTimer.current) {
        clearInterval(repeatTimer.current);
        repeatTimer.current = null;
      }
    }
  }, []);

  const onPointerUp = useCallback((e) => {
    if (!isTracking.current) return;
    if (pointerId.current != null && e.pointerId != null && e.pointerId !== pointerId.current) return;

    if (startPos.current) {
      const x = e.clientX ?? startPos.current.x;
      const y = e.clientY ?? startPos.current.y;
      const dx = x - startPos.current.x;
      const dy = y - startPos.current.y;
      if (Math.hypot(dx, dy) > thresholdRef.current) {
        hasMoved.current = true;
      }
    }

    const shouldFireTap = !hasMoved.current && !didHold.current;

    if (delayTimer.current) {
      clearTimeout(delayTimer.current);
      delayTimer.current = null;
    }
    if (repeatTimer.current) {
      clearInterval(repeatTimer.current);
      repeatTimer.current = null;
    }
    if (cleanupListeners.current) {
      cleanupListeners.current();
    }

    isTracking.current = false;
    startPos.current = null;
    pointerId.current = null;

    if (shouldFireTap) {
      actionRef.current();
    }

    setTimeout(() => {
      pointerHandled.current = false;
    }, 50);
  }, []);

  const onPointerCancel = useCallback(() => {
    stop();
  }, [stop]);

  cleanupListeners.current = () => {
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerCancel);
  };

  const start = useCallback((e) => {
    if (e.button != null && e.button > 0) return; // ignore right/middle mouse buttons
    if (isTracking.current) return; // ignore secondary touch points while tracking

    // For mouse, preventDefault prevents text selection / focus stealing without blocking scrolling.
    // For touch, calling preventDefault on pointerdown suppresses native scroll gestures.
    if (e.pointerType === 'mouse' && e.cancelable) {
      e.preventDefault();
    }

    // Clean up any existing run
    if (delayTimer.current) { clearTimeout(delayTimer.current); delayTimer.current = null; }
    if (repeatTimer.current) { clearInterval(repeatTimer.current); repeatTimer.current = null; }
    if (cleanupListeners.current) { cleanupListeners.current(); }

    pointerHandled.current = true;
    isTracking.current = true;
    hasMoved.current = false;
    didHold.current = false;
    pointerId.current = e.pointerId ?? null;
    startPos.current = {
      x: e.clientX ?? 0,
      y: e.clientY ?? 0,
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerCancel);

    delayTimer.current = setTimeout(() => {
      if (isTracking.current && !hasMoved.current) {
        didHold.current = true;
        actionRef.current();
        repeatTimer.current = setInterval(() => {
          actionRef.current();
        }, intervalRef.current);
      }
    }, delayRef.current);
  }, [onPointerMove, onPointerUp, onPointerCancel]);

  const onKeyDown = useCallback((e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      actionRef.current();
    }
  }, []);

  const onClick = useCallback((e) => {
    if (e?.button != null && e.button > 0) return;
    if (!pointerHandled.current) {
      actionRef.current();
    }
  }, []);

  useEffect(() => stop, [stop]); // clear timers + listeners on unmount

  return { onPointerDown: start, onPointerLeave: stop, onKeyDown, onClick };
}
