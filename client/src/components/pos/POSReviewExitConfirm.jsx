import React, { useEffect, useRef } from 'react';

const CHOICE = `flex min-h-tablet flex-1 items-center justify-center gap-2 whitespace-nowrap rounded-xl
                px-3 text-lg font-bold transition-colors duration-100 focus-visible:outline-none
                focus-visible:ring-2 focus-visible:ring-v2-accent disabled:opacity-50`;

// Dismissing the Review modal is ambiguous on a tablet — a stray backdrop tap looks
// exactly like a deliberate one — so closing it asks what the operator actually meant.
// Three one-word choices: discard the order (stock back), leave it and clear the screen,
// or go back to reviewing. `POSConfirm` is a fixed 2-button dialog, so this is its own
// component rather than a widened version of that one.
export default function POSReviewExitConfirm({
  orderId,
  canDiscard = true,
  loading = false,
  onDiscard,
  onLeave,
  onBack,
}) {
  const panelRef = useRef(null);

  useEffect(() => {
    panelRef.current?.focus();
    const handler = (e) => { if (e.key === 'Escape') onBack(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onBack]);

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="pos-review-exit-title"
      onClick={(e) => { if (e.target === e.currentTarget) onBack(); }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className="w-full max-w-md rounded-2xl border border-v2-border bg-v2-surface shadow-2xl outline-none"
      >
        {/* Never "close": closing an order is a distinct domain action here (the
            settlement step where bottle returns are counted and it goes done). */}
        <h2 id="pos-review-exit-title" className="border-b border-v2-border px-6 py-4 text-xl font-bold text-v2-text">
          {canDiscard
            ? (orderId ? `Discard order #${orderId}?` : 'Discard this order?')
            : (orderId ? `Order #${orderId}` : 'This order')}
        </h2>

        {/* One line of context, not three: Discard is destructive and the buttons
            themselves say nothing about the stock. */}
        <p className="px-6 pt-5 text-base text-v2-muted">
          {canDiscard
            ? 'Discard puts the stock back. Draft leaves the order and clears the screen.'
            : 'Draft leaves the order and clears the screen.'}
        </p>

        <div className="flex gap-3 px-6 py-5">
          {canDiscard && (
            <button
              type="button"
              onClick={onDiscard}
              disabled={loading}
              aria-label="Discard this order and put the stock back"
              className={`${CHOICE} bg-red-700 text-white hover:bg-red-600`}
            >
              {loading ? 'Discarding…' : '🗑️ Discard'}
            </button>
          )}

          <button
            type="button"
            onClick={onLeave}
            disabled={loading}
            aria-label="Leave the order as it is and clear the screen"
            className={`${CHOICE} bg-emerald-600 text-white hover:bg-emerald-500`}
          >
            📝 Draft
          </button>

          <button
            type="button"
            onClick={onBack}
            disabled={loading}
            aria-label="Go back to reviewing this order"
            className={`${CHOICE} bg-v2-raised text-v2-text hover:bg-v2-border`}
          >
            ↩️ Go Back
          </button>
        </div>
      </div>
    </div>
  );
}
