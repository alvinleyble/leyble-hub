import React, { useEffect, useMemo, useRef, useState } from 'react';

// Shared searchable picker used everywhere the app chooses a product / customer / order.
// Replaces the four hand-rolled comboboxes that used to drift apart. Designed for tablets:
// 48px dropdown rows, Enter selects the highlighted match, arrow keys move the highlight,
// and onMouseDown+preventDefault keeps focus on the input so taps never close it early.
//
// Single-select (default): selecting sets the input text to displayValue(item) and closes.
// Multi-add (POS) mode: pass keepOpenOnSelect + clearQueryOnSelect so the bar stays open and
// clears after each pick — tap-tap-tap to add many. `isAdded` flags rows already chosen.
//
// Inline create: pass `onCreate(query)` to show a "+ Create …" action row at the bottom of the
// list whenever the typed query is non-empty — for adding a record on the fly without leaving
// the picker. The parent does the async create and selects the result; pass `creating` to show
// a busy state on the row.
//
// `match(item, query)` is supplied by the caller (e.g. productMatches) and should return true
// for an empty query so the full list shows on focus.
const INPUT = `w-full h-12 px-4 border border-slate-300 rounded-lg text-base text-slate-900
               focus:outline-none focus:ring-2 focus:ring-blue-600`;

export default function Combobox({
  items,
  onSelect,
  match,
  renderRow,
  displayValue = (item) => String(item ?? ''),
  getKey = (item) => item.id,
  initialQuery = '',
  value = null,
  onQueryChange,
  placeholder = 'Search…',
  inputClassName = INPUT,
  emptyText = 'No matches.',
  maxRows = 50,
  keepOpenOnSelect = false,
  clearQueryOnSelect = false,
  preserveQueryOnSelect = false, // keep the typed text after a pick (tap same row again to bump)
  inlineDropdown = false, // render the list in-flow (push content down) instead of floating over it
  rawRow = false, // let renderRow own the whole row (its own buttons) instead of one tap-to-select button
  isAdded,
  onCreate,            // optional: (query) => void — shows a "+ Create …" row for the typed text
  renderCreate,        // optional: (query) => node — custom label for the create row
  creating = false,    // optional: busy flag while the parent saves the new record
  ...rest // id + aria-* injected by FormField, forwarded to <input>
}) {
  const [query, setQuery]   = useState(initialQuery);
  const [open, setOpen]     = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef(null);
  const blurTimer = useRef(null);
  const focusedRef = useRef(false);
  const containerRef = useRef(null);

  // When a selected `value` arrives or changes from the parent (e.g. an order being edited
  // whose customer list loads async), reflect its display text — but never clobber what the
  // user is actively typing.
  useEffect(() => {
    if (value != null && !focusedRef.current && !keepOpenOnSelect) {
      setQuery(displayValue(value));
    }
  }, [value]); // eslint-disable-line

  // Multi-add: blur no longer closes the list (so the keyboard can be dismissed while browsing),
  // so close it when the user taps outside the picker instead. Lets parents open the dropdown,
  // drop the keyboard, scroll-and-tap, then tap away to finish.
  useEffect(() => {
    if (!open || !keepOpenOnSelect) return;
    const onDocPointer = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) setOpen(false);
    };
    // CAPTURE phase, not bubble: a tap that adds a product makes its row replace itself
    // (the qty-0 "tap to add" button becomes a − qty + stepper), so by the time a bubble-phase
    // listener ran, e.target would already be detached from the DOM and contains() would wrongly
    // report "outside" → the list would close on every pick. Capture fires before React commits
    // that re-render, so e.target is still inside the picker and a real pick keeps the list open.
    document.addEventListener('mousedown', onDocPointer, true);
    document.addEventListener('touchstart', onDocPointer, true);
    return () => {
      document.removeEventListener('mousedown', onDocPointer, true);
      document.removeEventListener('touchstart', onDocPointer, true);
    };
  }, [open, keepOpenOnSelect]);

  const matches = useMemo(() => {
    const list = items.filter((i) => match(i, query));
    return list.slice(0, maxRows);
  }, [items, query, match, maxRows]);

  const trimmedQuery = query.trim();
  // Hide the create row when the typed text already names an existing item — guards against
  // creating an obvious duplicate.
  const exactExists = items.some(
    (i) => displayValue(i).trim().toLowerCase() === trimmedQuery.toLowerCase()
  );
  const canCreate = Boolean(onCreate) && trimmedQuery !== '' && !exactExists;

  const cancelClose = () => {
    if (blurTimer.current) { clearTimeout(blurTimer.current); blurTimer.current = null; }
  };

  // The parent does the async create + select; close and drop focus so the value effect can
  // reflect the new record's display text once it's selected.
  const handleCreate = () => {
    onCreate(trimmedQuery);
    setActive(0);
    setOpen(false);
    focusedRef.current = false;
    inputRef.current?.blur();
  };

  const select = (item) => {
    onSelect(item);
    if (!preserveQueryOnSelect) {
      setQuery(clearQueryOnSelect ? '' : displayValue(item));
    }
    setActive(0);
    // Multi-add: keep the list open but DON'T refocus the input — picking a product must never
    // force the on-screen keyboard back up, so parents can browse/scroll the list keyboard-free.
    // (onMouseDown+preventDefault on each row already leaves the input's focus state untouched.)
    setOpen(keepOpenOnSelect);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActive((a) => Math.min(a + 1, matches.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter') {
      if (open && matches[active]) { e.preventDefault(); select(matches[active]); }
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  return (
    <div className="relative" ref={containerRef}>
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
          setOpen(true);
          onQueryChange?.(e.target.value);
        }}
        onFocus={(e) => {
          focusedRef.current = true;
          cancelClose();
          setOpen(true);
          // When the user deliberately taps the field to search, select existing text so the
          // next keystroke replaces it (multi-add product bar).
          if (preserveQueryOnSelect) e.target.select();
        }}
        onBlur={() => {
          focusedRef.current = false;
          // Multi-add keeps the list open when focus is lost (e.g. keyboard dismissed) so it can
          // still be browsed; it closes on outside-tap/Escape instead (see effect above).
          if (!keepOpenOnSelect) {
            blurTimer.current = setTimeout(() => setOpen(false), 150);
          }
        }}
        onKeyDown={handleKeyDown}
        className={inputClassName}
        placeholder={placeholder}
        autoComplete="off"
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        {...rest}
      />

      {open && (
        <ul
          className={`${inlineDropdown ? '' : 'absolute z-30 left-0 right-0'} mt-1 bg-white
                      border border-slate-200 rounded-lg shadow-lg max-h-64 overflow-y-auto`}
          role="listbox"
        >
          {matches.map((item, idx) => (
            rawRow ? (
              // The row renders its own controls (e.g. a − qty + stepper); we pass `select`
              // (the add/bump action) so it can wire its own tap-to-add area.
              <li
                key={getKey(item)}
                role="option"
                aria-selected={idx === active}
                onMouseEnter={() => setActive(idx)}
                className={idx === active ? 'bg-blue-50/60' : ''}
              >
                {renderRow(item, {
                  active: idx === active,
                  added: isAdded?.(item) ?? false,
                  select: () => select(item),
                })}
              </li>
            ) : (
              <li key={getKey(item)} role="option" aria-selected={idx === active}>
                <button
                  type="button"
                  // preventDefault keeps focus on the input — the tap can't blur-close the list,
                  // and in multi-add mode the bar stays ready for the next product.
                  onMouseDown={(e) => { e.preventDefault(); select(item); }}
                  onMouseEnter={() => setActive(idx)}
                  className={`w-full text-left px-4 py-3 text-sm min-h-[48px] flex items-center
                              justify-between gap-2 ${idx === active ? 'bg-blue-50' : 'hover:bg-blue-50'}`}
                >
                  {renderRow(item, { active: idx === active, added: isAdded?.(item) ?? false })}
                </button>
              </li>
            )
          ))}
          {matches.length === 0 && !canCreate && (
            <li className="px-4 py-3 text-sm text-slate-400">{emptyText}</li>
          )}
          {canCreate && (
            <li role="option" aria-selected={false}>
              <button
                type="button"
                // preventDefault keeps focus on the input so the tap can't blur-close the list early.
                onMouseDown={(e) => { e.preventDefault(); if (!creating) handleCreate(); }}
                disabled={creating}
                className="w-full text-left px-4 py-3 text-sm min-h-[48px] flex items-center gap-2
                           border-t border-slate-100 font-semibold text-blue-700
                           hover:bg-blue-50 disabled:opacity-60 disabled:cursor-default"
              >
                {creating
                  ? 'Adding…'
                  : renderCreate
                    ? renderCreate(trimmedQuery)
                    : <>＋ Create “{trimmedQuery}”</>}
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
