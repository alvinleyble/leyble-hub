import React, { useEffect, useState, useCallback } from 'react';
import { api } from '../../api/client';
import { useToast } from '../../components/ui/Toast';
import Button from '../../components/ui/Button';
import Spinner from '../../components/ui/Spinner';
import OrderCloseForm, { breakdownForItem } from './OrderCloseForm';

const PHP = (n) =>
  `₱${Number(n).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const fmtDate = (d) =>
  d ? new Date(d).toLocaleString('en-PH', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : null;

// Guided step-through for closing a batch of delivered (`completed`) orders —
// reuses OrderCloseForm so the bottle-return math/live preview stays in one place.
export default function ReviewQueueModal({ orderIds, onClose }) {
  const { addToast } = useToast();
  const [orders, setOrders]   = useState({});
  const [loading, setLoading] = useState(true);
  const [activeId, setActiveId] = useState(orderIds[0]);
  const [closing, setClosing] = useState(false);
  // Live, in-progress bottle-return entries for the active order — lifted up from
  // OrderCloseForm so the order summary above it can show the same live breakdown.
  // Keyed by order_items.id; reset whenever the active order changes.
  const [returnCounts, setReturnCounts] = useState({});
  // Adjustment fields for the active order — reset on order change, saved before close.
  const [adjValue, setAdjValue] = useState('0');
  const [adjReason, setAdjReason] = useState('');

  const loadAll = useCallback(() => {
    setLoading(true);
    Promise.all(orderIds.map((orderId) => api.get(`/orders/${orderId}`)))
      .then((results) => {
        const map = {};
        results.forEach((o) => { map[o.id] = o; });
        setOrders(map);
      })
      .catch(() => addToast('Failed to load orders for review.', 'error'))
      .finally(() => setLoading(false));
  }, [orderIds, addToast]);

  useEffect(() => { loadAll(); }, [loadAll]);

  const order = orders[activeId];
  const bottleItems = order
    ? order.items.filter((i) => i.requires_bottle_return && Number(i.unit_deposit_fee) > 0)
    : [];

  // Reset the bottle-return entries and adjustment fields whenever the active (non-closed)
  // order changes — otherwise stale values from the previous order would linger.
  useEffect(() => {
    if (!order || order.status === 'done') return;
    const counts = {};
    order.items
      .filter((i) => i.requires_bottle_return && Number(i.unit_deposit_fee) > 0)
      .forEach((i) => { counts[i.id] = String(Number(i.quantity) * (Number(i.units_per_case) || 1)); });
    setReturnCounts(counts);
    setAdjValue(String(order.adjustment || '0'));
    setAdjReason(order.adjustment_reason || '');
  }, [activeId, order?.id]);

  const advanceToNextUnclosed = (closedId) => {
    const idx = orderIds.indexOf(closedId);
    const next = orderIds.slice(idx + 1).find((orderId) => orders[orderId]?.status !== 'done')
      ?? orderIds.find((orderId) => orderId !== closedId && orders[orderId]?.status !== 'done');
    if (next !== undefined) setActiveId(next);
  };

  const handleClosed = (updated) => {
    setOrders((prev) => ({ ...prev, [updated.id]: updated }));
    advanceToNextUnclosed(updated.id);
  };

  const saveAdjustmentIfChanged = async (orderId) => {
    const adj = Number(adjValue) || 0;
    const existing = Number(order.adjustment) || 0;
    if (adj === existing && adjReason.trim() === (order.adjustment_reason || '')) return;
    if (adj !== 0 && !adjReason.trim()) throw new Error('Adjustment reason is required when amount is non-zero.');
    await api.patch(`/orders/${orderId}/adjustment`, {
      adjustment: adj,
      adjustment_reason: adjReason.trim(),
    });
  };

  const handleCloseOrder = async () => {
    setClosing(true);
    try {
      await saveAdjustmentIfChanged(order.id);
      let updated;
      if (bottleItems.length > 0) {
        const items = Object.entries(returnCounts).map(([itemId, returned]) => ({
          id: Number(itemId),
          bottles_returned: Number(returned) || 0,
        }));
        updated = await api.post(`/orders/${order.id}/close`, { items });
      } else {
        updated = await api.post(`/orders/${order.id}/status`, { status: 'done' });
      }
      addToast('Order closed.', 'success');
      handleClosed(updated);
    } catch (err) {
      addToast(err.message || 'Failed to close order.', 'error');
    } finally {
      setClosing(false);
    }
  };

  const allDone = orderIds.every((orderId) => orders[orderId]?.status === 'done');

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-white" role="dialog" aria-modal="true" aria-label="Review deliveries">
      <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 shrink-0">
        <div>
          <h2 className="text-lg font-bold text-slate-900">Review Deliveries</h2>
          <p className="text-sm text-slate-500 mt-0.5">
            Step through each order, count returned bottles, and close it.
          </p>
        </div>
        <Button variant="secondary" onClick={onClose}>
          {allDone ? 'Done' : 'Close'}
        </Button>
      </div>

      {loading ? (
        <div className="flex-1 flex items-center justify-center"><Spinner size="lg" /></div>
      ) : (
        <>
          <div className="flex gap-2 px-6 py-3 border-b border-slate-200 overflow-x-auto shrink-0">
            {orderIds.map((orderId) => {
              const o = orders[orderId];
              const isDone   = o?.status === 'done';
              const isActive = orderId === activeId;
              return (
                <button
                  key={orderId}
                  onClick={() => setActiveId(orderId)}
                  className={`shrink-0 px-4 py-2.5 rounded-lg text-sm font-semibold border transition-colors
                    focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600
                    ${isActive
                      ? 'bg-blue-700 text-white border-blue-700'
                      : isDone
                        ? 'bg-slate-100 text-slate-400 border-slate-200'
                        : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'}`}
                >
                  Order #{orderId}{isDone ? ' ✓' : ''}
                </button>
              );
            })}
          </div>

          <div className="flex-1 overflow-y-auto p-6">
            {!order ? (
              <p className="text-slate-400 text-center py-20">Order not found.</p>
            ) : (
              <div className="max-w-2xl mx-auto">
                <div className="bg-white rounded-xl border border-slate-200 p-5 mb-4">
                  <div className="flex items-start justify-between gap-4 flex-wrap">
                    <div>
                      <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-1">Order #{order.id}</p>
                      <p className="text-base font-semibold text-slate-800">{order.customer_name}</p>
                      {order.customer_address && <p className="text-sm text-slate-500">{order.customer_address}</p>}
                    </div>
                    <a
                      href={`/orders/${order.id}`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-sm font-medium text-blue-700 hover:text-blue-900 focus-visible:outline-none
                                 focus-visible:ring-2 focus-visible:ring-blue-600 rounded"
                    >
                      View full order →
                    </a>
                  </div>

                  {order.personnel?.length > 0 && (
                    <p className="text-sm text-slate-500 mt-3">
                      {order.personnel.map((p) => `${p.full_name} (${p.role})`).join(', ')}
                    </p>
                  )}
                  {order.notes && (
                    <p className="text-sm text-slate-600 italic mt-2">"{order.notes}"</p>
                  )}

                  <ul className="mt-4 pt-4 border-t border-slate-100 space-y-2.5">
                    {order.items.map((item) => {
                      const b = breakdownForItem(item, returnCounts);
                      return (
                        <li key={item.id}>
                          <div className="flex justify-between text-sm">
                            <span className="text-slate-700">{item.product_name} — {item.quantity} {item.unit}</span>
                            <span className="font-medium text-slate-900 tabular-nums">{PHP(b.lineTotal)}</span>
                          </div>
                          {b.hasDeposit && (
                            <p className="text-xs text-slate-500 tabular-nums">
                              {b.unreturned > 0
                                ? <>{PHP(b.basePrice)} + {PHP(b.depositOwed)} deposit ({b.unreturned} unreturned)</>
                                : <>{PHP(b.basePrice)} — no deposit, all bottles returned</>}
                            </p>
                          )}
                        </li>
                      );
                    })}
                  </ul>

                  {(() => {
                    const breakdowns = order.items.map((item) => breakdownForItem(item, returnCounts));
                    const itemsSubtotal   = breakdowns.reduce((sum, b) => sum + b.basePrice, 0);
                    const depositSubtotal = breakdowns.reduce((sum, b) => sum + b.depositOwed, 0);
                    const liveAdj = Number(adjValue) || 0;
                    const orderTotal = itemsSubtotal + depositSubtotal + liveAdj;
                    const showBreakdown = bottleItems.length > 0 || liveAdj !== 0;
                    if (!showBreakdown) return null;
                    return (
                      <dl className="mt-4 pt-4 border-t border-slate-200 space-y-1.5 text-sm">
                        {bottleItems.length > 0 && (
                          <>
                            <div className="flex justify-between">
                              <dt className="text-slate-500">Items subtotal</dt>
                              <dd className="font-medium text-slate-700 tabular-nums">{PHP(itemsSubtotal)}</dd>
                            </div>
                            <div className="flex justify-between">
                              <dt className="text-slate-500">Deposit subtotal</dt>
                              <dd className="font-medium text-slate-700 tabular-nums">{PHP(depositSubtotal)}</dd>
                            </div>
                          </>
                        )}
                        {liveAdj !== 0 && (
                          <div className="flex justify-between">
                            <dt className="text-slate-500">
                              Adjustment{adjReason.trim() ? ` (${adjReason.trim()})` : ''}
                            </dt>
                            <dd className={`font-medium tabular-nums ${liveAdj > 0 ? 'text-red-600' : 'text-green-700'}`}>
                              {liveAdj > 0 ? '+' : ''}{PHP(liveAdj)}
                            </dd>
                          </div>
                        )}
                        <div className="flex justify-between pt-1.5 border-t border-slate-100">
                          <dt className="font-semibold text-slate-800">Order Total</dt>
                          <dd className="font-bold text-slate-900 tabular-nums">{PHP(orderTotal)}</dd>
                        </div>
                      </dl>
                    );
                  })()}
                </div>

                {order.status !== 'done' && bottleItems.length > 0 && (
                  <OrderCloseForm
                    order={order}
                    returnCounts={returnCounts}
                    onChangeReturnCounts={setReturnCounts}
                    onClosed={handleClosed}
                    hideCloseButton
                  />
                )}

                {order.status !== 'done' && (
                  <div className="bg-white rounded-xl border border-slate-200 p-5 mb-4">
                    <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-3">Adjustment</p>
                    <div className="space-y-3">
                      <div>
                        <label className="block text-sm font-medium text-slate-700 mb-1">
                          Amount (₱) — use negative for discount
                        </label>
                        <input
                          type="number"
                          step="0.01"
                          value={adjValue}
                          onChange={(e) => setAdjValue(e.target.value)}
                          className="w-full h-12 px-4 border border-slate-300 rounded-lg text-base
                                     focus:outline-none focus:ring-2 focus:ring-blue-600"
                          placeholder="0"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-slate-700 mb-1">
                          Reason{Number(adjValue) !== 0 && <span className="text-red-500 ml-0.5">*</span>}
                        </label>
                        <textarea
                          value={adjReason}
                          onChange={(e) => setAdjReason(e.target.value)}
                          rows={2}
                          className="w-full px-4 py-2.5 border border-slate-300 rounded-lg text-base text-slate-900
                                     focus:outline-none focus:ring-2 focus:ring-blue-600 resize-none"
                          placeholder="e.g. Customer rejected 2 cases, negotiated price"
                        />
                      </div>
                    </div>
                  </div>
                )}

                {order.status === 'done' ? (
                  <div className="bg-green-50 border border-green-200 rounded-xl p-5">
                    <p className="text-sm font-semibold text-green-800">✓ Closed — {fmtDate(order.closed_at)}</p>
                  </div>
                ) : (
                  <div className="bg-white rounded-xl border border-slate-200 p-5">
                    <Button
                      className="w-full"
                      onClick={handleCloseOrder}
                      loading={closing}
                      disabled={bottleItems.length > 0 && Object.values(returnCounts).some((v) => v === '')}
                    >
                      Close Order
                    </Button>
                  </div>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
