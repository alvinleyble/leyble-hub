import React from 'react';

// Large +/- flanking a number input — designed for easy finger/thumb use.
export default function Stepper({ value, onChange, min = 0, max = 9999, label }) {
  const decrement = () => onChange(Math.max(min, Number(value) - 1));
  const increment = () => onChange(Math.min(max, Number(value) + 1));

  const btnBase = `
    flex items-center justify-center w-12 h-12 bg-white
    text-slate-700 text-2xl font-bold select-none
    border border-slate-300
    hover:bg-slate-100 active:bg-slate-200
    transition-colors duration-100
    disabled:opacity-40 disabled:cursor-not-allowed
    focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-inset
  `;

  return (
    <div className="inline-flex items-center" role="group" aria-label={label}>
      <button
        type="button"
        onClick={decrement}
        disabled={Number(value) <= min}
        aria-label={`Decrease ${label}`}
        className={`${btnBase} rounded-l-lg border-r-0`}
      >
        −
      </button>

      <input
        type="number"
        inputMode="numeric"
        value={value}
        min={min}
        max={max}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label={label}
        className="w-16 h-12 text-center text-base font-semibold text-slate-900
                   border border-slate-300
                   focus:outline-none focus:ring-2 focus:ring-blue-600 focus:ring-inset
                   [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
      />

      <button
        type="button"
        onClick={increment}
        disabled={Number(value) >= max}
        aria-label={`Increase ${label}`}
        className={`${btnBase} rounded-r-lg border-l-0`}
      >
        +
      </button>
    </div>
  );
}
