import React, { useEffect, useRef, useState } from 'react';
import Button from './Button';
import NavIcon from '../layout/NavIcon';
import { SECTION_GAP } from './Page';

/**
 * The one page header (docs/design/design-standard.md, Q2 + Q9): the title on the
 * left and the page's one main action on the right, on ONE row at every size.
 *
 * Extra actions:
 *  - exactly one → a plain secondary button (icon only on phones, word from 768px);
 *  - two or more → a ⋮ menu at the far right (after the main button) on phones and
 *    upright tablets, and
 *    ordinary buttons on a landscape tablet (≥1024px) where there is room.
 *
 * @param {{ label, shortLabel?, onClick, disabled?, loading?, testId? }} [primary]
 * @param {Array<{ label, icon?, onClick, disabled?, loading?, testId? }>} [actions]
 */
export default function PageHeader({ title, subtitle, primary, actions = [], children }) {
  const extras = actions.filter(Boolean);
  return (
    <div className={SECTION_GAP}>
      <div className="flex items-center justify-between gap-3">
        <h1 className="min-w-0 text-xl md:text-2xl font-bold text-slate-900">{title}</h1>
        <div className="flex items-center gap-2 shrink-0">
          {extras.length === 1 && <SingleAction action={extras[0]} />}
          {extras.length >= 2 && (
            <div className="hidden lg:flex items-center gap-2">
              {extras.map((a) => (
                <Button key={a.label} variant="secondary" onClick={a.onClick} disabled={a.disabled}
                        loading={a.loading} data-testid={a.testId}>
                  {a.icon && <NavIcon name={a.icon} className="w-5 h-5" />}
                  {a.label}
                </Button>
              ))}
            </div>
          )}
          {primary && (
            <Button onClick={primary.onClick} disabled={primary.disabled} loading={primary.loading}
                    data-testid={primary.testId} className="whitespace-nowrap">
              {/* A shorter word on a narrow phone, so title and button still share
                  one row without the title breaking mid-word. */}
              {primary.shortLabel ? (
                <>
                  <span className="sm:hidden">{primary.shortLabel}</span>
                  <span className="hidden sm:inline">{primary.label}</span>
                </>
              ) : primary.label}
            </Button>
          )}
          {/* The ⋮ menu is always the last thing on the row — the far right, where
              Android puts it. */}
          {extras.length >= 2 && <OverflowMenu actions={extras} className="lg:hidden" />}
          {children}
        </div>
      </div>
      {subtitle && <p className="mt-1 text-sm md:text-base text-slate-600">{subtitle}</p>}
    </div>
  );
}

function SingleAction({ action: a }) {
  return (
    <Button variant="secondary" onClick={a.onClick} disabled={a.disabled} loading={a.loading}
            aria-label={a.label} data-testid={a.testId} className="px-3 md:px-5">
      {a.icon && <NavIcon name={a.icon} className="w-5 h-5" />}
      <span className={a.icon ? 'hidden md:inline' : ''}>{a.label}</span>
    </Button>
  );
}

export function OverflowMenu({ actions, className = '', label = 'More actions' }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (!wrapRef.current?.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={wrapRef} className={`relative ${className}`}>
      <button
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex h-12 w-12 items-center justify-center rounded-lg border border-slate-300 bg-white
                   text-slate-700 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2
                   focus-visible:ring-blue-600"
      >
        <NavIcon name="more" className="w-6 h-6" />
      </button>
      {open && (
        // The button sits at the far right of the header, so the menu hangs from the
        // right edge and grows leftwards — never off the screen.
        <div role="menu" className="absolute right-0 top-full z-30 mt-1 w-60 rounded-xl border border-slate-200
                                    bg-white py-1 shadow-lg">
          {actions.map((a) => (
            <button
              key={a.label}
              type="button"
              role="menuitem"
              disabled={a.disabled || a.loading}
              data-testid={a.testId}
              onClick={() => { setOpen(false); a.onClick?.(); }}
              className="flex w-full items-center gap-3 px-4 min-h-[48px] text-left text-base text-slate-800
                         hover:bg-blue-50 disabled:opacity-50 disabled:cursor-not-allowed
                         focus-visible:outline-none focus-visible:bg-blue-50"
            >
              {a.icon && <NavIcon name={a.icon} className="w-5 h-5 shrink-0 text-slate-600" />}
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
