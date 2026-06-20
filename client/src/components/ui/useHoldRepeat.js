import { useCallback, useEffect, useRef } from 'react';

// Press-and-hold to repeat an action. Fires once on press, then (after a short delay) repeatedly
// until release/leave/cancel — so holding + or − ramps the quantity continuously. Release is
// caught on `window` so it still stops if the button disables or unmounts mid-hold (e.g. a −
// that removed the line). The action itself clamps, so this never produces negative quantities.
// Returns handlers to spread onto a <button>; keyboard (Enter/Space) fires once and auto-repeats
// via the OS key-repeat.
export default function useHoldRepeat(action, { delay = 400, interval = 110 } = {}) {
  const actionRef = useRef(action);
  actionRef.current = action;
  const delayTimer = useRef(null);
  const repeatTimer = useRef(null);

  const stop = useCallback(() => {
    if (delayTimer.current) { clearTimeout(delayTimer.current); delayTimer.current = null; }
    if (repeatTimer.current) { clearInterval(repeatTimer.current); repeatTimer.current = null; }
    window.removeEventListener('pointerup', stop);
    window.removeEventListener('pointercancel', stop);
  }, []);

  const start = useCallback((e) => {
    if (e.button != null && e.button > 0) return; // ignore right/middle mouse buttons
    e.preventDefault();                            // don't steal focus / pop the keyboard / select text
    actionRef.current();
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    delayTimer.current = setTimeout(() => {
      repeatTimer.current = setInterval(() => actionRef.current(), interval);
    }, delay);
  }, [delay, interval, stop]);

  const onKeyDown = useCallback((e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); actionRef.current(); }
  }, []);

  useEffect(() => stop, [stop]); // clear timers + listeners on unmount

  return { onPointerDown: start, onPointerLeave: stop, onKeyDown };
}
