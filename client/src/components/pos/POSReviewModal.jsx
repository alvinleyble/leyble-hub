import React, { useEffect, useRef } from 'react';
import { lineTotal, orderTotals, totalCases } from './posMath';

const PHP = (n) =>
  `₱${Number(n).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const SECONDARY = `flex min-h-tablet items-center justify-center gap-2 whitespace-nowrap rounded-xl px-5
                   text-base font-bold transition-colors duration-100 focus-visible:outline-none
                   focus-visible:ring-2 focus-visible:ring-v2-accent disabled:opacity-50`;

const PRIMARY = `flex-1 flex min-h-tablet items-center justify-center gap-2 rounded-xl bg-v2-accent-strong px-6
                 text-lg font-black text-white hover:bg-v2-accent shadow-md transition-colors duration-100
                 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-v2-accent disabled:opacity-50`;

const formatQty = (qty) => {
  const n = Number(qty) || 0;
  return `${n.toLocaleString('en-PH', { minimumFractionDigits: n % 1 === 0 ? 1 : 1, maximumFractionDigits: 2 })} cs`;
};

// Tablet-optimized pre-print review for V2 POS — a full-screen, high-contrast breakdown
// of items, custom suki pricing and totals, with tactile 52px+ actions.
//
// It reviews the order while it is still a **draft**, and only ever a draft: nothing is
// created and no stock moves until Confirm & Print, so Discard genuinely deletes it and
// backing out costs nothing. Dismissing it (✕ / Escape / backdrop / Edit Items) simply
// returns to the cart, which is still sitting on the panel behind it — no confirmation,
// because there is nothing to lose. Looking at an order that already exists is a
// different job, done read-only from POS History's 👁️ View (OrderViewModal).
export default function POSReviewModal({
  order,
  products = [],
  customPrices = {},
  saving = false,
  onConfirm,
  onEdit,
  onClose,
  onDiscard,
  onDraft,
}) {
  const modalRef = useRef(null);

  useEffect(() => {
    modalRef.current?.focus();
    // Escape / backdrop / ✕ mean "close", never "edit" — dismissing the review must
    // not drop the operator into amber edit mode they never asked for.
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  if (!order) return null;

  const items = order.items || [];
  const adjustmentVal = Number(order.adjustment) || 0;
  const totals = orderTotals(items, adjustmentVal);

  const isCustomPrice = (item) =>
    Boolean(item.is_price_overridden) ||
    (order.customer_type === 'wholesaler' && Boolean(customPrices[item.product_id]));

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-3 sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="pos-review-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={modalRef}
        tabIndex={-1}
        className="flex h-[92vh] w-full max-w-4xl flex-col rounded-2xl border border-v2-border bg-v2-surface shadow-2xl outline-none overflow-hidden"
      >
        {/* ── Header ────────────────────────────────────────────────────────── */}
        <div className="shrink-0 flex items-start justify-between gap-4 border-b border-v2-border bg-v2-surface px-6 py-4">
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-black uppercase tracking-wider text-v2-accent">
                {order.id ? `📝 Draft #${order.id}` : '📝 Order Review'}
              </span>
              {order.customer_type === 'wholesaler' ? (
                <span className="inline-flex items-center rounded-full border border-amber-500/40 bg-amber-500/10 px-2.5 py-0.5 text-xs font-bold text-amber-300">
                  Wholesaler
                </span>
              ) : order.customer_type === 'discounted' ? (
                <span className="inline-flex items-center rounded-full border border-blue-500/40 bg-blue-500/10 px-2.5 py-0.5 text-xs font-bold text-blue-300">
                  Discounted
                </span>
              ) : order.customer_type === 'unassigned' ? (
                <span className="inline-flex items-center rounded-full border border-yellow-500/40 bg-yellow-500/10 px-2.5 py-0.5 text-xs font-bold text-yellow-300">
                  Unassigned
                </span>
              ) : (
                <span className="inline-flex items-center rounded-full border border-v2-border bg-v2-raised px-2.5 py-0.5 text-xs font-bold text-v2-muted">
                  Regular
                </span>
              )}
              <span className="inline-flex items-center rounded-full border border-v2-pill-border bg-v2-pill-active px-2.5 py-0.5 text-xs font-bold text-v2-pill-text">
                {order.order_type === 'pickup' ? '🏪 Pickup' : '🚚 Delivery'}
              </span>
            </div>

            <h2 id="pos-review-title" className="text-2xl sm:text-3xl font-black text-v2-text tracking-tight truncate">
              {order.customer_name || 'Customer'}
            </h2>

            {(order.customer_address || order.customer_phone) && (
              <p className="text-xs sm:text-sm text-v2-muted truncate">
                {[order.customer_address, order.customer_phone].filter(Boolean).join(' · ')}
              </p>
            )}
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="Close review"
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl text-xl text-v2-muted
                       hover:bg-v2-raised hover:text-v2-text focus-visible:outline-none
                       focus-visible:ring-2 focus-visible:ring-v2-accent"
          >
            ✕
          </button>
        </div>

        {/* ── Itemized Bill Table ───────────────────────────────────────────── */}
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-3">
          {items.length === 0 ? (
            <p className="py-12 text-center text-lg text-v2-muted">No items in this order.</p>
          ) : (
            <table className="w-full text-left border-collapse">
              <thead className="sticky top-0 z-10 bg-v2-surface border-b border-v2-border text-xs uppercase tracking-wider text-v2-muted">
                <tr>
                  <th className="py-2.5 pr-4 font-bold text-left w-24">Cases</th>
                  <th className="py-2.5 px-2 font-bold text-left">Item Description</th>
                  <th className="py-2.5 px-4 font-bold text-right w-36">Price /cs</th>
                  <th className="py-2.5 pl-4 font-bold text-right w-36">Line Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-v2-border/60">
                {items.map((item, idx) => {
                  const sukiApplied = isCustomPrice(item);
                  return (
                    <tr key={item.id || item._key || idx} className="hover:bg-v2-raised/40 transition-colors">
                      <td className="py-3 pr-4 align-top">
                        <span className="inline-block rounded-lg bg-v2-raised px-2.5 py-1 text-base font-black tabular-nums text-v2-text border border-v2-border">
                          {formatQty(item.quantity)}
                        </span>
                      </td>
                      <td className="py-3 px-2 align-top">
                        <p className="text-base font-bold text-v2-text leading-snug">
                          {item.product_name}
                        </p>
                        <div className="flex flex-wrap items-center gap-2 mt-0.5 text-xs text-v2-muted">
                          {item.sku && <span className="font-mono font-semibold">{item.sku}</span>}
                          {item.unit && <span>· {item.unit}</span>}
                          {Number(item.units_per_case) > 1 && (
                            <span>({item.units_per_case} btls/cs)</span>
                          )}
                        </div>
                      </td>
                      <td className="py-3 px-4 align-top text-right whitespace-nowrap">
                        <p className="text-base font-bold tabular-nums text-v2-text">
                          {PHP(item.unit_price)}
                          <span className="text-xs font-normal text-v2-muted"> /cs</span>
                        </p>
                        {sukiApplied && (
                          <span
                            style={{
                              backgroundColor: 'var(--v2-suki-badge-bg)',
                              borderColor: 'var(--v2-suki-badge-border)',
                              color: 'var(--v2-suki-badge-text)',
                            }}
                            className="mt-0.5 inline-flex items-center rounded border px-1.5 py-0.5 text-[11px] font-bold"
                          >
                            Suki Price
                          </span>
                        )}
                      </td>
                      <td className="py-3 pl-4 align-top text-right whitespace-nowrap">
                        <p className="text-lg font-black tabular-nums text-v2-text">
                          {PHP(lineTotal(item))}
                        </p>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* ── Totals & Adjustments Footer ───────────────────────────────────── */}
        <div className="shrink-0 border-t border-v2-border bg-v2-bg px-6 py-4 space-y-3">
          {order.notes && (
            <div className="rounded-xl border border-v2-border bg-v2-surface px-3 py-2 text-sm text-v2-muted">
              <span className="font-bold text-v2-text">Notes: </span>
              <span>{order.notes}</span>
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-end">
            <div className="space-y-1 text-sm text-v2-muted">
              <div className="flex justify-between sm:justify-start sm:gap-4">
                <span>Total Cases:</span>
                <span className="font-bold text-v2-text tabular-nums">{totalCases(items)} cases</span>
              </div>
              <div className="flex justify-between sm:justify-start sm:gap-4">
                <span>Goods Subtotal:</span>
                <span className="font-bold text-v2-text tabular-nums">{PHP(totals.goods)}</span>
              </div>
              {totals.adjustment !== 0 && (
                <div className="flex justify-between sm:justify-start sm:gap-4 text-amber-300">
                  <span>
                    Adjustment{order.adjustment_reason ? ` (${order.adjustment_reason})` : ''}:
                  </span>
                  <span className="font-bold tabular-nums">
                    {totals.adjustment > 0 ? '+' : ''}{PHP(totals.adjustment)}
                  </span>
                </div>
              )}
            </div>

            <div className="flex flex-col items-end justify-center rounded-xl bg-v2-surface border border-v2-border p-3">
              <span className="text-xs font-black uppercase tracking-wider text-v2-muted">Grand Total Due</span>
              <span className="text-3xl sm:text-4xl font-black tabular-nums text-v2-text">
                {PHP(totals.total)}
              </span>
            </div>
          </div>
        </div>

        {/* ── Tactile Action Buttons (52px+ touch height) ────────────────────── */}
        <div className="shrink-0 border-t border-v2-border bg-v2-surface px-6 py-4 flex flex-col sm:flex-row items-stretch gap-3">
          <button
            type="button"
            onClick={onDiscard}
            disabled={saving}
            className={`${SECONDARY} bg-red-700 text-white hover:bg-red-600`}
          >
            🗑️ Discard
          </button>

          <button
            type="button"
            onClick={onDraft}
            disabled={saving}
            className={`${SECONDARY} bg-v2-raised text-v2-text hover:bg-v2-border`}
          >
            📝 Draft
          </button>

          <button
            type="button"
            onClick={onEdit}
            disabled={saving}
            className={`${SECONDARY} bg-v2-raised text-v2-text hover:bg-v2-border`}
          >
            ✏️ Edit Items
          </button>

          <button
            type="button"
            onClick={onConfirm}
            disabled={saving || items.length === 0}
            className={PRIMARY}
          >
            {saving ? 'Creating…' : '✅ Confirm & Print'}
          </button>
        </div>
      </div>
    </div>
  );
}
