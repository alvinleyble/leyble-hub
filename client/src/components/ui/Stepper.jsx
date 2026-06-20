import React, { useRef } from 'react';
import useHoldRepeat from './useHoldRepeat';

// Large +/- flanking a number input — designed for easy finger/thumb use on tablets.
// `step` controls the increment (e.g. 0.5 for half-cases, 1 for whole bottles).
// `onChange` receives the raw string value so callers keep their string-based form
// state and the field stays freely typeable; the +/- buttons round/clamp to step.
// Press-and-hold a +/- button to ramp continuously (clamped to min/max).
// `id` + aria-* (injected by FormField) are forwarded to the inner <input>.
export default function Stepper({
  value,
  onChange,
  step = 1,
  min = 0,
  max = 9999,
  label,
  ...rest
}) {
  const num = parseFloat(value);
  const current = Number.isFinite(num) ? num : 0;

  const round = (n) => Number(n.toFixed(2));            // kill float noise (e.g. 0.30000004)
  const clamp = (n) => Math.min(max, Math.max(min, n));
  const setVal = (n) => onChange(String(clamp(round(n))));

  // A ref to the latest value so the hold-repeat interval steps from the up-to-date number
  // (its callback closure would otherwise capture a stale `current`).
  const currentRef = useRef(current);
  currentRef.current = current;
  const decHold = useHoldRepeat(() => setVal(currentRef.current - step));
  const incHold = useHoldRepeat(() => setVal(currentRef.current + step));

  const btnBase = `
    flex items-center justify-center w-12 h-12 shrink-0 bg-white
    text-slate-700 text-2xl font-bold select-none
    border border-slate-300
    hover:bg-slate-100 active:bg-slate-200
    transition-colors duration-100
    disabled:opacity-40 disabled:cursor-not-allowed
    focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-inset
  `;

  return (
    <div className="flex w-full items-stretch" role="group" aria-label={label}>
      <button
        type="button"
        {...decHold}
        disabled={current <= min}
        aria-label={`Decrease ${label || 'value'}`}
        className={`${btnBase} rounded-l-lg border-r-0`}
      >
        −
      </button>

      <input
        type="number"
        inputMode="decimal"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => onChange(e.target.value)}
        aria-label={label}
        {...rest}
        className="flex-1 min-w-0 h-12 text-center text-base font-semibold text-slate-900
                   border border-slate-300
                   focus:outline-none focus:ring-2 focus:ring-blue-600 focus:ring-inset
                   [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
      />

      <button
        type="button"
        {...incHold}
        disabled={current >= max}
        aria-label={`Increase ${label || 'value'}`}
        className={`${btnBase} rounded-r-lg border-l-0`}
      >
        +
      </button>
    </div>
  );
}
