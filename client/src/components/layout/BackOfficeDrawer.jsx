import React, { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';

// Back Office = the four V1 modules that V2 does NOT rework. Selecting one
// leaves the V2 shell and lands on the untouched V1 route/UI.
const BACK_OFFICE_ITEMS = [
  { path: '/personnel', label: 'Personnel',         hint: 'Drivers, helpers & IDs' },
  { path: '/incoming',  label: 'Incoming Supplies', hint: 'Log deliveries, restock' },
  { path: '/tickets',   label: 'Tickets',           hint: 'Issues & resolutions' },
  { path: '/audit',     label: 'Audit Log',         hint: 'Stock & activity history' },
];

// Also reachable from here so the owners can still get at the V1 order/dashboard
// screens while V2 is being built out slice by slice.
const V1_ITEMS = [
  { path: '/dashboard', label: 'Dashboard (V1)',       hint: 'Original overview' },
  { path: '/orders',    label: 'Outgoing Orders (V1)', hint: 'Original order screens' },
];

export default function BackOfficeDrawer({ open, onClose }) {
  const navigate = useNavigate();
  const panelRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    panelRef.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const go = (path) => { onClose(); navigate(path); };

  const renderItem = ({ path, label, hint }) => (
    <button
      key={path}
      type="button"
      onClick={() => go(path)}
      className="flex w-full flex-col justify-center min-h-tablet px-5 py-3 text-left rounded-xl
                 text-v2-text hover:bg-v2-raised transition-colors duration-100
                 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-v2-accent"
    >
      <span className="text-lg font-semibold">{label}</span>
      <span className="text-base text-v2-muted">{hint}</span>
    </button>
  );

  return (
    <>
      <div
        className="v2-root fixed inset-0 z-40 bg-black/60"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Back Office"
        className="v2-root fixed right-0 top-0 z-50 h-full w-full max-w-md flex flex-col
                   bg-v2-surface border-l border-v2-border shadow-2xl focus:outline-none"
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-v2-border">
          <h2 className="text-xl font-bold text-v2-text">Back Office</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close Back Office"
            className="flex items-center justify-center min-h-tablet min-w-tablet rounded-xl
                       text-v2-muted hover:bg-v2-raised hover:text-v2-text
                       focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-v2-accent"
          >
            <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto p-3 flex flex-col gap-1" aria-label="Back Office navigation">
          {BACK_OFFICE_ITEMS.map(renderItem)}

          <p className="px-5 pt-5 pb-2 text-sm font-semibold uppercase tracking-wide text-v2-muted">
            Original screens
          </p>
          {V1_ITEMS.map(renderItem)}
        </nav>
      </div>
    </>
  );
}
