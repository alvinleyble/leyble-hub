import React, { useEffect, useRef } from 'react';

const CHOICE = `flex min-h-tablet w-full items-center gap-3 rounded-xl px-5 py-3 text-left text-base font-bold
                transition-colors duration-100 focus-visible:outline-none focus-visible:ring-2
                focus-visible:ring-v2-accent disabled:opacity-50`;

// Dismissing the Review modal is ambiguous on a tablet — a stray backdrop tap looks
// exactly like a deliberate one — so closing it asks what the operator actually meant.
// Three choices, never two: void the order (a real cancel, stock back), keep it on the
// POS to print later, or go back to reviewing. `POSConfirm` is a fixed 2-button dialog,
// so this is its own component rather than a widened version of that one.
export default function POSReviewExitConfirm({
  orderId,
  customerName,
  canVoid = true,
  loading = false,
  onVoid,
  onKeep,
  onContinue,
}) {
  const panelRef = useRef(null);

  useEffect(() => {
    panelRef.current?.focus();
    const handler = (e) => { if (e.key === 'Escape') onContinue(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onContinue]);

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="pos-review-exit-title"
      onClick={(e) => { if (e.target === e.currentTarget) onContinue(); }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className="w-full max-w-md rounded-2xl border border-v2-border bg-v2-surface shadow-2xl outline-none"
      >
        <h2 id="pos-review-exit-title" className="border-b border-v2-border px-6 py-4 text-xl font-bold text-v2-text">
          {orderId ? `Close the review of order #${orderId}?` : 'Close this review?'}
        </h2>

        <div className="space-y-3 px-6 py-5">
          {canVoid && (
            <button type="button" onClick={onVoid} disabled={loading} className={`${CHOICE} bg-red-700 text-white hover:bg-red-600`}>
              <span aria-hidden="true">🗑️</span>
              <span className="min-w-0">
                <span className="block">{loading ? 'Voiding…' : 'Void / Trash this order'}</span>
                <span className="block text-sm font-normal text-red-100">
                  Void this order{customerName ? ` for ${customerName}` : ''} and put the stock back?
                  It will stay in History as Cancelled.
                </span>
              </span>
            </button>
          )}

          {/* Emerald, like Save Order — the accent red is too close to the danger red for
              the destructive and the safe choice to sit side by side in it. */}
          <button type="button" onClick={onKeep} disabled={loading} className={`${CHOICE} bg-emerald-600 text-white hover:bg-emerald-500`}>
            <span aria-hidden="true">🖨️</span>
            <span className="min-w-0">
              <span className="block">Keep &amp; Print Later</span>
              <span className="block text-sm font-normal text-emerald-50/90">
                The order stays on the POS — Print, Review and Edit stay available.
              </span>
            </span>
          </button>

          <button type="button" onClick={onContinue} disabled={loading} className={`${CHOICE} bg-v2-raised text-v2-text hover:bg-v2-border`}>
            <span aria-hidden="true">↩️</span>
            <span className="min-w-0">
              <span className="block">Continue Reviewing</span>
              <span className="block text-sm font-normal text-v2-muted">Go back to the order review.</span>
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}
