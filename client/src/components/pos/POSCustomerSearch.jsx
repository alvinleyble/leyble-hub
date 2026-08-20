import React, { useMemo, useRef, useState } from 'react';
import { customerMatches } from '../../utils/customerSearch';

// Customer picker for the V2 POS order panel. Same searchable-combobox mechanics the rest
// of the app uses (see client/src/components/ui/Combobox.jsx): filter on keystroke,
// onFocus opens the list, onBlur closes it after 150ms so a row's onMouseDown lands
// first. Dark-themed for the V2 shell and sized for tablet taps.
// The bar starts blank so the full customer list is one tap away.
export default function POSCustomerSearch({
  customers,
  selected,
  onSelect,
  onClear,
  disabled = false,
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen]   = useState(false);
  const blurTimer = useRef(null);

  const matches = useMemo(
    () => customers.filter((c) => customerMatches(c, query)).slice(0, 50),
    [customers, query]
  );

  const closeSoon = () => {
    blurTimer.current = setTimeout(() => setOpen(false), 150);
  };
  const cancelClose = () => {
    if (blurTimer.current) { clearTimeout(blurTimer.current); blurTimer.current = null; }
  };

  const pick = (customer) => {
    onSelect(customer);
    setQuery('');
    setOpen(false);
  };

  // Locked (saved / amber edit): the backend only accepts a customer change on a
  // draft, so V2 shows who the order is for and nothing more. See §2.5 of the proposal.
  if (disabled) {
    return (
      <div>
        <p className="text-sm font-bold uppercase tracking-wide text-v2-muted">Customer</p>
        <p className="mt-1 text-xl font-bold text-v2-text">{selected?.name ?? '—'}</p>
        {selected?.address && (
          <p className="text-base text-v2-muted">{selected.address}</p>
        )}
      </div>
    );
  }

  return (
    <div className="relative">
      <label htmlFor="pos-customer" className="block text-sm font-bold uppercase tracking-wide text-v2-muted">
        Customer
      </label>

      {selected ? (
        <div className="mt-1 flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="truncate text-xl font-bold text-v2-text">{selected.name}</p>
            <p className="truncate text-base text-v2-muted">
              {selected.customer_type === 'wholesaler' ? 'Wholesaler — custom pricing applied' : 'Regular customer'}
              {selected.address ? ` · ${selected.address}` : ''}
            </p>
          </div>
          <button
            type="button"
            onClick={onClear}
            className="flex h-12 shrink-0 items-center rounded-xl bg-v2-raised px-4 text-base font-semibold
                       text-v2-text transition-colors duration-100 hover:bg-v2-border
                       focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-v2-accent"
          >
            Change
          </button>
        </div>
      ) : (
        <input
          id="pos-customer"
          type="text"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => { cancelClose(); setOpen(true); }}
          onBlur={closeSoon}
          autoComplete="off"
          role="combobox"
          aria-expanded={open}
          aria-autocomplete="list"
          placeholder="Type a name…"
          className="mt-1 h-14 w-full rounded-xl border border-v2-border bg-v2-bg px-4 text-lg
                     text-v2-text placeholder:text-v2-muted
                     focus:outline-none focus-visible:ring-2 focus-visible:ring-v2-accent"
        />
      )}

      {open && !selected && (
        <ul
          role="listbox"
          aria-label="Customer matches"
          className="absolute left-0 right-0 z-30 mt-1 max-h-80 overflow-y-auto rounded-xl border
                     border-v2-border bg-v2-surface shadow-2xl"
        >
          {matches.length === 0 && (
            <li className="px-4 py-4 text-base text-v2-muted">No customers match.</li>
          )}
          {matches.map((c) => (
            <li key={c.id} role="option" aria-selected={false}>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(c)}
                className="flex min-h-tablet w-full items-center justify-between gap-3 px-4 py-3 text-left
                           hover:bg-v2-raised focus-visible:outline-none focus-visible:ring-2
                           focus-visible:ring-v2-accent"
              >
                <span className="min-w-0">
                  <span className="block truncate text-lg font-semibold text-v2-text">{c.name}</span>
                  {c.address && <span className="block truncate text-sm text-v2-muted">{c.address}</span>}
                </span>
                {c.customer_type === 'wholesaler' && (
                  <span className="shrink-0 rounded-full border border-amber-400/50 bg-amber-400/10 px-2 py-0.5
                                   text-xs font-bold uppercase text-amber-300">
                    Wholesaler
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
