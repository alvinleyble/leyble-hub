import React, { useState } from 'react';
import NavIcon from '../layout/NavIcon';

/**
 * Search plus filters (docs/design/design-standard.md, Q3), the same on every screen:
 * the search box takes the full row; one "Filters" button beside it opens a panel
 * with everything else; while any filter is on, the button carries the count and each
 * active filter shows underneath as a chip with its own ✕.
 *
 * @param value/onChange/placeholder/ariaLabel/testId  the search box (omit onChange
 *                  for a screen with nothing to search: just the Filters button)
 * @param panel     filter controls shown when the Filters button is open (optional —
 *                  without it there is no Filters button)
 * @param active    [{ key, label, onRemove }] the filters currently on
 */
export default function SearchFilterBar({
  value, onChange, placeholder, ariaLabel, testId, inputType = 'search',
  panel, active = [], className = '',
}) {
  const [open, setOpen] = useState(false);
  const count = active.length;

  return (
    <div className={className}>
      <div className="flex gap-2">
        {onChange ? (
        <div className="relative flex-1 min-w-0">
          <NavIcon name="search" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-500" />
          <input
            type={inputType}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            aria-label={ariaLabel}
            data-testid={testId}
            className="w-full h-12 pl-10 pr-12 border border-slate-300 rounded-lg text-base text-slate-900
                       placeholder:text-slate-500 bg-white focus:outline-none focus:ring-2 focus:ring-blue-600
                       [&::-webkit-search-cancel-button]:hidden"
          />
          {value && (
            <button
              type="button"
              onClick={() => onChange('')}
              aria-label="Clear search"
              className="absolute right-0 top-0 flex h-12 w-12 items-center justify-center rounded-lg text-slate-500
                         hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
            >
              <NavIcon name="close" className="w-5 h-5" />
            </button>
          )}
        </div>
        ) : null}
        {panel && (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-label={count ? `Filters, ${count} on` : 'Filters'}
            className={`shrink-0 inline-flex items-center gap-2 h-12 px-3 md:px-4 rounded-lg border text-base font-semibold
                        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600
                        ${count ? 'border-blue-700 bg-blue-50 text-blue-800' : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'}`}
          >
            <NavIcon name="filter" className="w-5 h-5" />
            <span>Filters</span>
            {count > 0 && (
              <span className="inline-flex min-w-[24px] h-6 items-center justify-center rounded-full bg-blue-700 px-1.5 text-sm text-white">
                {count}
              </span>
            )}
          </button>
        )}
      </div>

      {/* Kept mounted while closed (just hidden) so the controls keep their state and
          their labels stay findable; `hidden` is display:none under Tailwind's reset. */}
      {panel && (
        <div hidden={!open} className="mt-3 rounded-xl border border-slate-200 bg-white p-4" data-testid="filters-panel">
          {panel}
        </div>
      )}

      {count > 0 && (
        <div className="mt-3 flex flex-wrap gap-2" aria-label="Active filters">
          {active.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={f.onRemove}
              aria-label={`Remove filter: ${f.label}`}
              className="inline-flex items-center gap-1.5 min-h-[48px] pl-4 pr-3 rounded-full border border-blue-300
                         bg-blue-50 text-base font-semibold text-blue-900 hover:bg-blue-100
                         focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
            >
              {f.label}
              <NavIcon name="close" className="w-4 h-4" />
            </button>
          ))}
          {count > 1 && (
            <button
              type="button"
              onClick={() => active.forEach((f) => f.onRemove())}
              className="min-h-[48px] px-3 text-base font-semibold text-slate-700 underline underline-offset-2
                         hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 rounded-lg"
            >
              Clear all
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// A labelled control inside the Filters panel: label above, control below (the app's
// "visible label above inputs" rule), 48px tall.
export function FilterField({ label, children }) {
  return (
    <label className="block min-w-0">
      <span className="block text-sm font-semibold text-slate-700 mb-1">{label}</span>
      {children}
    </label>
  );
}

export const FILTER_INPUT = `w-full h-12 px-3 border border-slate-300 rounded-lg text-base text-slate-900 bg-white
                             focus:outline-none focus:ring-2 focus:ring-blue-600`;
