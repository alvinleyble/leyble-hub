import React, { useEffect, useRef } from 'react';

const PHP = (n) =>
  `₱${Number(n).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Dark-themed 2-step Save Custom Price prompt modal for the V2 POS (proposal §4).
// Matches docs/product/proposals/save-custom-price-prompt.md.
export default function POSSavePriceModal({
  prompt, // { step: 'first' | 'second', orderId, customer, orderType, dirty: [...], busy }
  onAcceptFirst,
  onConfirmConvert,
  onDecline,
}) {
  const panelRef = useRef(null);

  useEffect(() => {
    panelRef.current?.focus();
    const handler = (e) => { if (e.key === 'Escape') onDecline(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onDecline]);

  if (!prompt) return null;

  const isMultiple = prompt.dirty?.length > 1;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="pos-save-price-title"
      onClick={(e) => { if (e.target === e.currentTarget && !prompt.busy) onDecline(); }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className="w-full max-w-md rounded-2xl border border-v2-border bg-v2-surface shadow-2xl outline-none"
      >
        {/* Step 1: Save custom price(s)? */}
        {prompt.step === 'first' && (
          <>
            <h2 id="pos-save-price-title" className="border-b border-v2-border px-6 py-4 text-xl font-bold text-v2-text">
              Save Custom Price{isMultiple ? 's' : ''}?
            </h2>

            <div className="px-6 py-5 text-base leading-relaxed text-v2-muted">
              <p>
                Save the custom price{isMultiple ? 's' : ''} for{' '}
                <strong className="text-v2-text">{prompt.customer.name}</strong> on future{' '}
                <strong className="text-v2-accent">{prompt.orderType}</strong> orders?
              </p>

              <ul className="mt-4 space-y-2 rounded-xl border border-v2-border bg-v2-bg p-3">
                {prompt.dirty.map((d) => (
                  <li key={d.product_id} className="flex items-center justify-between text-sm">
                    <span className="font-medium text-v2-text truncate pr-2">
                      {d.sku ? <span className="font-mono text-xs text-v2-accent mr-1.5">{d.sku}</span> : null}
                      {d.product_name}
                    </span>
                    <span className="font-bold tabular-nums text-v2-accent shrink-0">
                      {PHP(d.unit_price)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>

            <div className="flex justify-end gap-3 border-t border-v2-border px-6 py-4">
              <button
                type="button"
                onClick={onDecline}
                disabled={prompt.busy}
                className="flex min-h-tablet items-center rounded-xl bg-v2-raised px-5 text-base font-bold text-v2-text
                           hover:bg-v2-border focus-visible:outline-none focus-visible:ring-2
                           focus-visible:ring-v2-accent disabled:opacity-50"
              >
                No
              </button>
              <button
                type="button"
                onClick={onAcceptFirst}
                disabled={prompt.busy}
                className="flex min-h-tablet items-center rounded-xl bg-v2-accent-strong px-5 text-base font-bold text-white
                           hover:bg-v2-accent focus-visible:outline-none focus-visible:ring-2
                           focus-visible:ring-v2-accent disabled:opacity-50"
              >
                {prompt.busy ? 'Saving…' : 'Yes, Save'}
              </button>
            </div>
          </>
        )}

        {/* Step 2: Convert to Wholesaler? (Regular customers only) */}
        {prompt.step === 'second' && (
          <>
            <h2 id="pos-save-price-title" className="border-b border-v2-border px-6 py-4 text-xl font-bold text-v2-text">
              Convert to Wholesaler?
            </h2>

            <div className="px-6 py-5 text-base leading-relaxed text-v2-muted">
              Saving {isMultiple ? 'these custom prices' : 'this custom price'} for{' '}
              <strong className="text-v2-text">{prompt.customer.name}</strong> will make them a{' '}
              <strong className="text-amber-300">Wholesaler</strong>. Continue?
            </div>

            <div className="flex justify-end gap-3 border-t border-v2-border px-6 py-4">
              <button
                type="button"
                onClick={onDecline}
                disabled={prompt.busy}
                className="flex min-h-tablet items-center rounded-xl bg-v2-raised px-5 text-base font-bold text-v2-text
                           hover:bg-v2-border focus-visible:outline-none focus-visible:ring-2
                           focus-visible:ring-v2-accent disabled:opacity-50"
              >
                No
              </button>
              <button
                type="button"
                onClick={onConfirmConvert}
                disabled={prompt.busy}
                className="flex min-h-tablet items-center rounded-xl bg-v2-accent-strong px-5 text-base font-bold text-white
                           hover:bg-v2-accent focus-visible:outline-none focus-visible:ring-2
                           focus-visible:ring-v2-accent disabled:opacity-50"
              >
                {prompt.busy ? 'Saving…' : 'Yes, Continue'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
