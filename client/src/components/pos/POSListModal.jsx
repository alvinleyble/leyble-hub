import React from 'react';

// Shared shell for the POS list popups (History, Drafts) so they stay one visual
// pattern: same backdrop, panel, header, search row, scrolling list and footnote.
// Each list supplies its own rows and row actions.

export const LIST_ACTION_BTN = `flex min-h-tablet items-center justify-center rounded-xl px-4 text-base font-bold
                                transition-colors duration-100 focus-visible:outline-none focus-visible:ring-2
                                focus-visible:ring-v2-accent disabled:cursor-not-allowed disabled:opacity-50`;

export const LIST_ROW = 'rounded-xl border border-v2-border bg-v2-bg p-3';

// Date + time the way the receipts print it (MM/DD/YYYY h:mm AM).
export const listDateTime = (iso) => {
  const d = new Date(iso);
  const h = d.getHours();
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()} ` +
         `${h % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
};

export default function POSListModal({
  id,                 // used for the aria/label ids and the search input
  title,
  closeLabel,
  searchLabel,
  query,
  onQueryChange,
  filters = null,     // optional extra controls under the search field
  loading,
  loadingText = 'Loading orders…',
  isEmpty,
  emptyText = 'No orders to show.',
  footnote = null,
  onClose,
  children,
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby={`${id}-title`}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="flex h-[92vh] w-full max-w-4xl flex-col rounded-2xl border border-v2-border bg-v2-surface shadow-2xl">
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-v2-border px-5 py-4">
          <h2 id={`${id}-title`} className="text-2xl font-bold text-v2-text">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={closeLabel}
            className="flex h-12 w-12 items-center justify-center rounded-xl text-xl text-v2-muted
                       hover:bg-v2-raised hover:text-v2-text focus-visible:outline-none
                       focus-visible:ring-2 focus-visible:ring-v2-accent"
          >
            ✕
          </button>
        </div>

        {/* Search + filters */}
        <div className="shrink-0 space-y-3 border-b border-v2-border px-5 py-4">
          <div>
            <label htmlFor={`${id}-search`} className="block text-sm font-bold uppercase tracking-wide text-v2-muted">
              {searchLabel}
            </label>
            <input
              id={`${id}-search`}
              type="text"
              value={query}
              onChange={(e) => onQueryChange(e.target.value)}
              autoComplete="off"
              className="mt-1 h-14 w-full rounded-xl border border-v2-border bg-v2-bg px-4 text-lg text-v2-text
                         placeholder:text-slate-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-v2-accent"
            />
          </div>
          {filters}
        </div>

        {/* Rows */}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {loading ? (
            <p className="py-10 text-center text-lg text-v2-muted">{loadingText}</p>
          ) : isEmpty ? (
            <p className="py-10 text-center text-lg text-v2-muted">{emptyText}</p>
          ) : (
            <ul className="space-y-3">{children}</ul>
          )}
        </div>

        {footnote && (
          <p className="shrink-0 border-t border-v2-border px-5 py-3 text-sm text-v2-muted">{footnote}</p>
        )}
      </div>
    </div>
  );
}
