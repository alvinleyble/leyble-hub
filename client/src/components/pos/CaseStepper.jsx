import React from 'react';
import useHoldRepeat from '../ui/useHoldRepeat';

// 0.5-case stepper for the POS order lines. Tap steps by half a case; press-and-hold
// accelerates (shared useHoldRepeat).
const BTN = `flex items-center justify-center w-12 h-12 rounded-xl text-xl font-bold
             select-none touch-none transition-colors duration-100 border
             focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600
             disabled:opacity-40 disabled:cursor-not-allowed`;

export default function CaseStepper({ quantity, onStep, label, amber = false }) {
  const dec = useHoldRepeat(() => onStep(-0.5));
  const inc = useHoldRepeat(() => onStep(+0.5));

  const tone = amber
    ? 'bg-amber-100 text-amber-900 hover:bg-amber-200 border-amber-300'
    : 'bg-slate-100 text-slate-800 hover:bg-slate-200 border-slate-300';

  return (
    <div className="flex items-center gap-1.5">
      <button
        type="button"
        {...dec}
        className={`${BTN} ${tone}`}
        aria-label={`Remove half a case of ${label}`}
      >
        −
      </button>

      <span
        className="min-w-[4rem] text-center text-lg font-bold tabular-nums text-slate-900"
        aria-live="polite"
      >
        {quantity}
        <span className="ml-1 text-xs font-semibold text-slate-500">cs</span>
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
