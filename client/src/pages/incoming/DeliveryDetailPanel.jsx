import React, { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { useToast } from '../../components/ui/Toast';
import Button from '../../components/ui/Button';
import Spinner from '../../components/ui/Spinner';
import OfflineBanner from '../../components/ui/OfflineBanner';
import { checkIsOnline } from '../../offline/status.js';

const PHP = (n) =>
  `₱${Number(n).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function DeliveryDetailPanel({ deliveryId, onClose, onEdit, onDeleted, cachedDelivery = null }) {
  const { addToast } = useToast();
  const [delivery, setDelivery]     = useState(null);
  const [loading, setLoading]       = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [voiding, setVoiding]       = useState(false);
  const [fromCache, setFromCache]   = useState(false);

  // ADR 0015 §9 — the panel used to answer a blind tap with "Delivery not found",
  // which is untrue: the row is right there in the list's own cached copy. It renders
  // that instead, read-only. Line items only show when the cached row carries them
  // (the list endpoint returns a count, not the lines), so the items block below has to
  // tolerate their absence rather than assume the full shape.
  useEffect(() => {
    api.get(`/incoming/${deliveryId}`)
      .then((data) => { setDelivery(data); setFromCache(false); })
      .catch(() => {
        if (cachedDelivery) { setDelivery(cachedDelivery); setFromCache(true); return; }
        addToast('Failed to load delivery.', 'error');
      })
      .finally(() => setLoading(false));
  }, [deliveryId]); // eslint-disable-line

  // §8 — voiding reverses stock movements on a shared record, and editing an
  // already-logged delivery reconciles them. Both stay online-only; only LOGGING a new
  // truck works blind.
  const mutationsBlocked = fromCache || !checkIsOnline();
  const blockedTip = mutationsBlocked ? 'Needs a connection' : undefined;

  const handleVoid = async () => {
    setVoiding(true);
    try {
      await api.del(`/incoming/${deliveryId}`);
      addToast('Delivery deleted; stock reversed.', 'success');
      onDeleted();
    } catch (err) {
      addToast(err.message || 'Failed to delete delivery.', 'error');
      setVoiding(false);
      setConfirming(false);
    }
  };

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
        <div className="flex items-center justify-between px-6 py-5 border-b border-slate-400 shrink-0">
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

            {fromCache && (
              <div className="px-6 pt-5">
                <OfflineBanner
                  className="mb-0"
                  message="Viewing offline data · Editing or deleting a delivery needs a connection"
                />
              </div>
            )}

            {/* ── Meta ──────────────────────────────────────────────── */}
            <div className="px-6 py-5 border-b border-slate-400 space-y-3">
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
                Products Received ({delivery.items?.length ?? delivery.item_count ?? 0})
              </p>

              {!delivery.items ? (
                <p className="text-slate-400 text-sm">
                  {delivery.item_count
                    ? `${delivery.item_count} product${delivery.item_count === 1 ? '' : 's'} — the line items need a connection to open.`
                    : 'Line items not available offline.'}
                </p>
              ) : delivery.items.length === 0 ? (
                <p className="text-slate-400 text-sm">No items on this delivery.</p>
              ) : (
                <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-slate-50 text-slate-500 text-xs uppercase tracking-wider border-b border-slate-400">
                        <th className="text-left px-4 py-3 font-semibold">Product</th>
                        <th className="text-right px-4 py-3 font-semibold">Qty</th>
                        <th className="text-right px-4 py-3 font-semibold hidden sm:table-cell">Unit Cost</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(delivery.items || []).map((item) => (
                        <tr key={item.id} className="border-t border-slate-300">
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

            {/* ── Actions ───────────────────────────────────────────── */}
            <div className="px-6 py-5 border-t border-slate-400">
              <Button
                variant="secondary"
                onClick={() => onEdit(delivery)}
                disabled={mutationsBlocked}
                title={blockedTip}
              >
                Edit Delivery
              </Button>
              {mutationsBlocked && (
                <p className="text-sm text-slate-500 mt-2">
                  Editing a logged delivery re-reconciles stock, so it needs a connection.
                </p>
              )}
            </div>

            {/* ── Danger Zone (delete = void + reverse stock) ───────── */}
            <div className="px-6 py-5 border-t border-slate-400">
              <p className="text-xs font-bold text-red-400 uppercase tracking-widest mb-3">Danger Zone</p>

              {!confirming ? (
                <>
                  <Button
                    variant="danger"
                    onClick={() => setConfirming(true)}
                    disabled={mutationsBlocked}
                    title={blockedTip}
                  >
                    Delete delivery
                  </Button>
                  {mutationsBlocked && (
                    <p className="text-sm text-slate-500 mt-2">
                      Deleting a delivery reverses stock on a record every device shares — it needs a connection.
                    </p>
                  )}
                </>
              ) : (
                <div className="p-4 bg-red-50 rounded-lg border border-red-200">
                  <p className="text-base font-semibold text-red-900 mb-1">
                    Delete this delivery?
                  </p>
                  <p className="text-sm text-red-800 mb-4">
                    The stock this delivery added will be subtracted back out of inventory.
                    The record stays in the audit log but is removed from this list. This can't be undone.
                  </p>
                  <div className="flex gap-2">
                    <Button variant="secondary" disabled={voiding} onClick={() => setConfirming(false)}>
                      Cancel
                    </Button>
                    <Button variant="danger" loading={voiding} onClick={handleVoid}>
                      Yes, delete
                    </Button>
                  </div>
                </div>
              )}
            </div>

          </div>
        )}
      </div>
    </>
  );
}
