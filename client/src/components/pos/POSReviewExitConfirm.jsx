import React, { useEffect, useRef } from 'react';

const CHOICE = `flex min-h-tablet flex-1 items-center justify-center gap-2 whitespace-nowrap rounded-xl
                px-3 text-lg font-bold transition-colors duration-100 focus-visible:outline-none
                focus-visible:ring-2 focus-visible:ring-v2-accent disabled:opacity-50`;

// Dismissing the review of an order that is already **Created**. A draft needs no such
// dialog — nothing is committed and the cart is still on the panel behind the modal, so
// its review just closes — but a Created order has deducted stock and a receipt waiting,
// and on a tablet an accidental backdrop tap looks exactly like a deliberate one. So it
// asks, and neither answer can strand the print buffer or open Edit Mode nobody wanted.
//
// There is no Discard here on purpose: a Created order can only be cancelled, which is a
// deliberate decision taken from History, where it stays visible as 🚫 Cancelled.
export default function POSReviewExitConfirm({ orderId, onKeep, onBack }) {
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
          {orderId ? `Order #${orderId}` : 'This order'}
        </h2>

        <p className="px-6 pt-5 text-base text-v2-muted">
          Keep leaves it on the POS with Print, Review and Edit ready. To void it, cancel
          it from History.
        </p>

        <div className="flex gap-3 px-6 py-5">
          <button
            type="button"
            onClick={onKeep}
            aria-label="Keep the order on the POS and stop reviewing"
            className={`${CHOICE} bg-emerald-600 text-white hover:bg-emerald-500`}
          >
            🖨️ Keep
          </button>

          <button
            type="button"
            onClick={onBack}
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
