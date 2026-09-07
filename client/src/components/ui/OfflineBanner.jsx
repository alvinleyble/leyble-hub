import React from 'react';

// ADR 0015 §9 — the calm amber banner every read-only-offline screen wears.
//
// Calm is the whole point. The screens this sits on (Dashboard, Personnel, Tickets,
// Audit, Incoming) are being read during a blackout by owners in their late fifties
// who need to know two things and nothing else: this is a copy, and here is when it
// was true. It is not an error, so it is not red, it does not shout, and it never
// replaces the content it describes.
//
// Status is carried by text as well as colour (accessibility rule), and the whole
// thing is `role="status"` so a screen reader announces it without stealing focus.

function formatCachedAt(value) {
  if (!value) return null;
  const t = new Date(value);
  if (Number.isNaN(t.getTime())) return null;
  return t.toLocaleString('en-PH', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

/**
 * @param {string}  [message]   the lead sentence; defaults to §9's exact wording
 * @param {string}  [cachedAt]  ISO timestamp of the copy being shown
 * @param {node}    [children]  actions (e.g. a button through to Outgoing Orders)
 */
export default function OfflineBanner({ message, cachedAt, children, className = '' }) {
  const stamp = formatCachedAt(cachedAt);

  return (
    <div
      role="status"
      className={`flex flex-col sm:flex-row sm:items-center gap-3 rounded-xl border border-amber-300
                  bg-amber-50 px-5 py-4 mb-6 ${className}`}
    >
      <span className="text-2xl leading-none shrink-0" aria-hidden="true">📴</span>
      <div className="min-w-0 flex-1">
        <p className="text-base font-semibold text-amber-900">
          {message || 'Viewing offline data · Changes sync when connected'}
        </p>
        {stamp && (
          <p className="text-sm text-amber-800 mt-0.5">
            Last updated {stamp}
          </p>
        )}
      </div>
      {children && <div className="flex gap-2 shrink-0">{children}</div>}
    </div>
  );
}
