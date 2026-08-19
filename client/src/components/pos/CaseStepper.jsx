import React from 'react';
import useHoldRepeat from '../ui/useHoldRepeat';

// 0.5-case stepper for the V2 POS order lines. Tap steps by half a case; press-and-hold
// accelerates (shared useHoldRepeat, same behaviour as the V1 order search bar).
// 56px targets — above the 48px minimum, sized for a tablet used at arm's length.
const BTN = `flex items-center justify-center w-14 h-14 rounded-xl text-2xl font-bold
             select-none touch-none transition-colors duration-100
             focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-v2-accent
             disabled:opacity-40 disabled:cursor-not-allowed`;

export default function CaseStepper({ quantity, onStep, label, amber = false }) {
  const dec = useHoldRepeat(() => onStep(-0.5));
  const inc = useHoldRepeat(() => onStep(+0.5));

  const tone = amber
    ? 'bg-amber-900/50 text-amber-100 hover:bg-amber-800/70'
    : 'bg-v2-raised text-v2-text hover:bg-v2-border';

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        {...dec}
        className={`${BTN} ${tone}`}
        aria-label={`Remove half a case of ${label}`}
      >
        −
      </button>

      <span
        className="min-w-[4.5rem] text-center text-xl font-bold tabular-nums text-v2-text"
        aria-live="polite"
      >
        {quantity}
        <span className="ml-1 text-sm font-semibold text-v2-muted">cs</span>
      </span>

      <button
        type="button"
        {...inc}
        className={`${BTN} ${tone}`}
        aria-label={`Add half a case of ${label}`}
      >
        +
      </button>
    </div>
  );
}
