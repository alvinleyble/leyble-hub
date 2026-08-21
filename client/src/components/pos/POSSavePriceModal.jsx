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
  const [selectedType, setSelectedType] = React.useState('unassigned');

  useEffect(() => {
    setSelectedType('unassigned');
  }, [prompt?.orderId, prompt?.step]);

  useEffect(() => {
    panelRef.current?.focus();
    const handler = (e) => { if (e.key === 'Escape') onDecline(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onDecline]);

  if (!prompt) return null;

  const isMultiple = prompt.dirty?.length > 1;

  const typeOptions = [
    { value: 'unassigned', label: 'Unassigned', desc: 'Default custom pricing category', color: 'border-red-500/40 bg-red-500/10 text-red-300' },
    { value: 'wholesaler', label: 'Wholesaler', desc: 'Standard bulk pricing tier', color: 'border-amber-500/40 bg-amber-500/10 text-amber-300' },
    { value: 'discounted', label: 'Discounted', desc: 'Reduced custom rate tier', color: 'border-blue-500/40 bg-blue-500/10 text-blue-300' },
    { value: 'markup',     label: 'Markup',     desc: 'Special surcharge pricing tier', color: 'border-purple-500/40 bg-purple-500/10 text-purple-300' },
  ];

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="pos-save-price-title"
      onClick={(e) => { if (e.target === e.currentTarget && !prompt.busy) onDecline(); }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className="w-full max-w-lg rounded-2xl border border-v2-border bg-v2-surface shadow-2xl outline-none"
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
                <strong className="text-v2-text">{prompt.orderType}</strong> orders?
              </p>

              <ul className="mt-4 space-y-2 rounded-xl border border-v2-border bg-v2-bg p-3">
                {prompt.dirty.map((d) => (
                  <li key={d.product_id} className="flex items-center justify-between text-sm">
                    <span className="font-medium text-v2-text truncate pr-2">
                      {d.sku ? <span className="font-mono text-xs text-v2-muted mr-1.5">{d.sku}</span> : null}
                      {d.product_name}
                    </span>
                    <span className="font-bold tabular-nums text-v2-text shrink-0">
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
                className="flex min-h-tablet items-center rounded-xl bg-emerald-600 px-5 text-base font-bold text-white
                           hover:bg-emerald-500 shadow-sm focus-visible:outline-none focus-visible:ring-2
                           focus-visible:ring-v2-accent disabled:opacity-50"
              >
                {prompt.busy ? 'Saving…' : 'Yes, Save'}
              </button>
            </div>
          </>
        )}

        {/* Step 2: Choose Customer Type (Regular customers only) */}
        {prompt.step === 'second' && (
          <>
            <h2 id="pos-save-price-title" className="border-b border-v2-border px-6 py-4 text-xl font-bold text-v2-text">
              Select Customer Type
            </h2>

            <div className="px-6 py-5 text-base leading-relaxed text-v2-muted">
              <p>
                Saving custom prices for <strong className="text-v2-text">{prompt.customer.name}</strong> requires assigning a customer type:
              </p>

              <div className="mt-4 grid grid-cols-2 gap-2.5">
                {typeOptions.map((opt) => {
                  const isSelected = selectedType === opt.value;
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => setSelectedType(opt.value)}
                      className={`flex min-h-[60px] flex-col justify-center rounded-xl border p-3 text-left transition
                        ${isSelected
                          ? `border-v2-accent bg-v2-bg ring-2 ring-v2-accent`
                          : `border-v2-border bg-v2-bg/60 hover:bg-v2-bg`
                        }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className={`rounded-full border px-2 py-0.5 text-xs font-bold uppercase ${opt.color}`}>
                          {opt.label}
                        </span>
                        {isSelected && <span className="text-xs font-bold text-v2-accent">✓ Selected</span>}
                      </div>
                      <span className="mt-1 text-xs text-v2-muted">{opt.desc}</span>
                    </button>
                  );
                })}
              </div>
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
                Cancel
              </button>
              <button
                type="button"
                onClick={() => onConfirmConvert(selectedType)}
                disabled={prompt.busy}
                className="flex min-h-tablet items-center rounded-xl bg-emerald-600 px-5 text-base font-bold text-white
                           hover:bg-emerald-500 shadow-sm focus-visible:outline-none focus-visible:ring-2
                           focus-visible:ring-v2-accent disabled:opacity-50"
              >
                {prompt.busy ? 'Saving…' : 'Yes, Save Price'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
