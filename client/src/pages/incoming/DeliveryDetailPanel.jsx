import React, { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { useToast } from '../../components/ui/Toast';
import Spinner from '../../components/ui/Spinner';

const PHP = (n) =>
  `₱${Number(n).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function DeliveryDetailPanel({ deliveryId, onClose }) {
  const { addToast } = useToast();
  const [delivery, setDelivery] = useState(null);
  const [loading, setLoading]   = useState(true);

  useEffect(() => {
    api.get(`/incoming/${deliveryId}`)
      .then(setDelivery)
      .catch(() => addToast('Failed to load delivery.', 'error'))
      .finally(() => setLoading(false));
  }, [deliveryId]); // eslint-disable-line

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-black/30"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Panel */}
      <div
        className="fixed right-0 top-0 h-full w-full max-w-lg z-50
                   bg-white shadow-2xl flex flex-col overflow-hidden"
        role="dialog"
        aria-modal="true"
        aria-labelledby="delivery-panel-title"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-5 border-b border-slate-200 shrink-0">
          <h2 id="delivery-panel-title" className="text-xl font-bold text-slate-900">
            {delivery ? `Delivery #${delivery.id}` : 'Delivery'}
          </h2>
          <button
            onClick={onClose}
            aria-label="Close panel"
            className="w-12 h-12 flex items-center justify-center rounded-lg text-slate-400
                       hover:text-slate-700 hover:bg-slate-100
                       focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
          >
            ✕
          </button>
        </div>

        {loading ? (
          <div className="flex-1 flex items-center justify-center">
            <Spinner size="lg" />
          </div>
        ) : !delivery ? (
          <div className="flex-1 flex items-center justify-center">
            <p className="text-slate-400 text-base">Delivery not found.</p>
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto">

            {/* ── Meta ──────────────────────────────────────────────── */}
            <div className="px-6 py-5 border-b border-slate-200 space-y-3">
              <div>
                <p className="text-xs font-semibold text-slate-400 uppercase tracking-widest mb-1">Supplier</p>
                <p className="text-lg font-bold text-slate-900">{delivery.supplier_name}</p>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-xs font-semibold text-slate-400 uppercase tracking-widest mb-1">Date Received</p>
                  <p className="text-base text-slate-800">
                    {new Date(delivery.received_at).toLocaleDateString('en-PH', {
                      year: 'numeric', month: 'long', day: 'numeric',
                    })}
                  </p>
                </div>
                <div>
                  <p className="text-xs font-semibold text-slate-400 uppercase tracking-widest mb-1">Logged By</p>
                  <p className="text-base text-slate-800">{delivery.created_by_name ?? '—'}</p>
                </div>
              </div>

              {delivery.notes && (
                <div>
                  <p className="text-xs font-semibold text-slate-400 uppercase tracking-widest mb-1">Notes</p>
                  <p className="text-base text-slate-700 whitespace-pre-wrap">{delivery.notes}</p>
                </div>
              )}
            </div>

            {/* ── Items ─────────────────────────────────────────────── */}
            <div className="px-6 py-5">
              <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-3">
                Products Received ({delivery.items?.length ?? 0})
              </p>

              {delivery.items?.length === 0 ? (
                <p className="text-slate-400 text-sm">No items on this delivery.</p>
              ) : (
                <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-slate-50 text-slate-500 text-xs uppercase tracking-wider border-b border-slate-200">
                        <th className="text-left px-4 py-3 font-semibold">Product</th>
                        <th className="text-right px-4 py-3 font-semibold">Qty</th>
                        <th className="text-right px-4 py-3 font-semibold hidden sm:table-cell">Unit Cost</th>
                      </tr>
                    </thead>
                    <tbody>
                      {delivery.items.map((item) => (
                        <tr key={item.id} className="border-t border-slate-100">
                          <td className="px-4 py-3">
                            <p className="font-semibold text-slate-900">{item.sku || item.product_name}</p>
                            {item.notes && (
                              <p className="text-xs text-slate-400 mt-0.5">{item.notes}</p>
                            )}
                          </td>
                          <td className="px-4 py-3 text-right font-bold text-slate-900 tabular-nums">
                            {item.quantity_received}
                            <span className="text-xs text-slate-400 font-normal ml-1">{item.unit}</span>
                          </td>
                          <td className="px-4 py-3 text-right text-slate-500 tabular-nums hidden sm:table-cell">
                            {item.unit_cost != null ? PHP(item.unit_cost) : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

          </div>
        )}
      </div>
    </>
  );
}
