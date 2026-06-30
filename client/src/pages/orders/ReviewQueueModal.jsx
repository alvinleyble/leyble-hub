import React, { useEffect, useState, useCallback } from 'react';
import { api } from '../../api/client';
import { useToast } from '../../components/ui/Toast';
import Button from '../../components/ui/Button';
import Spinner from '../../components/ui/Spinner';
import Modal from '../../components/ui/Modal';
import OrderCloseForm, { breakdownForItem } from './OrderCloseForm';
import { Capacitor } from '@capacitor/core';
import OrderCreateModal from './OrderCreateModal';
import { usePrintReceipt } from './usePrintReceipt';
import PrinterPicker from './PrinterPicker';

const IS_NATIVE = Capacitor.isNativePlatform();

const PHP = (n) =>
  `₱${Number(n).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const fmtDate = (d) =>
  d ? new Date(d).toLocaleString('en-PH', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : null;

// Per-mode configuration for the guided step-through. Each mode controls which
// controls appear (print / deposit math / adjustment), when an order counts as
// "processed" (greyed + ✓ in the tab strip and skipped by advance-to-next), and
// the per-order action. `delivered` has no `actionFor` — it uses the close flow.
const MODES = {
  pending: {
    title: 'Review Pending Orders',
    subtitle: 'Step through each order, print the receipt, and send it out.',
    showPrint: true, showDeposit: false, showAdjustment: true,
    printedLabel: 'Printed (pending)',
    printedAtField: 'pending_receipt_printed_at',
    printedByField: 'pending_receipt_printed_by_name',
    isProcessed: (o) => o.status !== 'pending',
    actionFor: (o) => o.order_type === 'pickup'
      ? { label: 'Mark Picked Up ✓', status: 'completed',  done: 'Picked up' }
      : { label: 'Dispatch →',       status: 'in_transit', done: 'Dispatched' },
  },
  in_transit: {
    title: 'Review In-Transit Orders',
    subtitle: 'Step through each order on the way and mark it delivered.',
    showPrint: false, showDeposit: false, showAdjustment: false,
    isProcessed: (o) => o.status !== 'in_transit',
    actionFor: () => ({ label: 'Mark Delivered ✓', status: 'completed', done: 'Delivered' }),
  },
  delivered: {
    title: 'Review Deliveries',
    subtitle: 'Step through each order, count returned bottles, and close it.',
    showPrint: true, showDeposit: true, showAdjustment: true,
    printedLabel: 'Printed (delivered)',
    printedAtField: 'delivered_receipt_printed_at',
    printedByField: 'delivered_receipt_printed_by_name',
    isProcessed: (o) => o.status === 'done' || o.status === 'cancelled',
  },
};

// Guided step-through for a batch of orders. `mode` selects the operational moment:
// 'pending' (before dispatch), 'in_transit' (consistency-only), or 'delivered'
// (count returned bottles + close). Reuses OrderCloseForm so the bottle-return
// math/live preview stays in one place.
export default function ReviewQueueModal({ orderIds, onClose, mode = 'delivered' }) {
  const cfg = MODES[mode] ?? MODES.delivered;
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
  const [adjValue, setAdjValue] = useState('');
  const [adjReason, setAdjReason] = useState('');
  // Edit / cancel for the active order, without leaving the review flow.
  const [editing, setEditing] = useState(false);
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [cancelling, setCancelling] = useState(false);

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

  // While the active order is still being reviewed, its adjustment lives only in the
  // form (saved on close). Thread it into the receipt so the print matches the on-screen
  // total. Once processed, the saved order.adjustment is authoritative — pass undefined.
  const liveAdjustment = (cfg.showAdjustment && order && !cfg.isProcessed(order))
    ? { adjustment: Number(adjValue) || 0, adjustment_reason: adjReason.trim() }
    : undefined;

  const {
    handlePrint, printing,
    pickerVisible, pickerDevices, pickerLoading, pickerCurrent, printPending,
    savePrinter, scanWifi, testPrint, closePickerAndCancel, handleChangePrinter,
    twicePrompt, confirmTwice,
    printPrompt, taggingPrint, confirmPrintTag, cancelPrintTag,
  } = usePrintReceipt(order, returnCounts, (updated) =>
    setOrders((prev) => ({ ...prev, [updated.id]: updated })), liveAdjustment);

  // Reset the bottle-return entries and adjustment fields whenever the active
  // (unprocessed) order changes — otherwise stale values from the previous order
  // would linger. Bottle counts only matter in the deposit (delivered) mode.
  // The items signature makes this re-run after an in-review edit changes the
  // lines (the server re-creates order_items on edit, so ids always change) —
  // without it a newly added bottle-return product would never get an entry.
  const itemsSig = order
    ? order.items.map((i) => `${i.id}:${i.quantity}:${i.units_per_case}:${i.unit_deposit_fee}`).join('|')
    : '';
  useEffect(() => {
    if (!order || cfg.isProcessed(order)) return;
    const counts = {};
    if (cfg.showDeposit) {
      order.items
        .filter((i) => i.requires_bottle_return && Number(i.unit_deposit_fee) > 0)
        .forEach((i) => { counts[i.id] = String(Number(i.quantity) * (Number(i.units_per_case) || 1)); });
    }
    setReturnCounts(counts);
    setAdjValue(Number(order.adjustment) ? String(order.adjustment) : '');
    setAdjReason(order.adjustment_reason || '');
  }, [activeId, order?.id, itemsSig]);

  const advanceToNextUnprocessed = (processedId) => {
    const idx = orderIds.indexOf(processedId);
    const notDone = (orderId) => orders[orderId] && !cfg.isProcessed(orders[orderId]);
    const next = orderIds.slice(idx + 1).find(notDone)
      ?? orderIds.find((orderId) => orderId !== processedId && notDone(orderId));
    if (next !== undefined) setActiveId(next);
  };

  const handleClosed = (updated) => {
    setOrders((prev) => ({ ...prev, [updated.id]: updated }));
    advanceToNextUnprocessed(updated.id);
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

  // Pending / in-transit modes: advance the order by a simple status transition
  // (dispatch, mark picked up, or mark delivered) rather than the close flow.
  const handleAdvanceAction = async () => {
    setClosing(true);
    try {
      if (cfg.showAdjustment) await saveAdjustmentIfChanged(order.id);
      const { status } = cfg.actionFor(order);
      const updated = await api.post(`/orders/${order.id}/status`, { status });
      addToast('Order updated.', 'success');
      handleClosed(updated);
    } catch (err) {
      addToast(err.message || 'Failed to update order.', 'error');
    } finally {
      setClosing(false);
    }
  };

  // Reload the active order after an in-review edit so items/totals (and the
  // bottle-return entries via the itemsSig effect above) refresh.
  const handleEditSaved = async () => {
    setEditing(false);
    try {
      const updated = await api.get(`/orders/${activeId}`);
      setOrders((prev) => ({ ...prev, [updated.id]: updated }));
    } catch {
      addToast('Failed to reload the edited order.', 'error');
    }
  };

  const handleCancelOrder = async () => {
    setCancelling(true);
    try {
      const updated = await api.post(`/orders/${order.id}/status`, { status: 'cancelled' });
      addToast(`Order #${order.id} cancelled.`, 'success');
      setConfirmingCancel(false);
      handleClosed(updated);
    } catch (err) {
      addToast(err.message || 'Failed to cancel order.', 'error');
    } finally {
      setCancelling(false);
    }
  };

  const allProcessed = orderIds.every((orderId) => orders[orderId] && cfg.isProcessed(orders[orderId]));

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-white" role="dialog" aria-modal="true" aria-label={cfg.title}>
      <div className="flex items-center justify-between gap-4 px-6 py-4 border-b border-slate-200 shrink-0">
        <div className="min-w-0">
          <button
            onClick={onClose}
            className="text-sm font-medium text-blue-700 hover:text-blue-900 flex items-center gap-1
                       focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 rounded"
          >
            ← Orders
          </button>
          <h2 className="text-lg font-bold text-slate-900 mt-1">{cfg.title}</h2>
          <p className="text-sm text-slate-500 mt-0.5">
            {cfg.subtitle}
          </p>
        </div>
        <Button variant="secondary" onClick={onClose}>
          {allProcessed ? 'Done' : 'Close'}
        </Button>
      </div>

      {loading ? (
        <div className="flex-1 flex items-center justify-center"><Spinner size="lg" /></div>
      ) : (
        <>
          <div className="flex gap-2 px-6 py-3 border-b border-slate-200 overflow-x-auto shrink-0">
            {orderIds.map((orderId) => {
              const o = orders[orderId];
              const isDone   = o ? cfg.isProcessed(o) : false;
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
                    <div className="flex items-center gap-2 flex-wrap justify-end">
                      <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
                        Edit Order
                      </Button>
                      {cfg.showPrint && (
                        <Button variant="secondary" size="sm" onClick={handlePrint} loading={printing}>
                          Print Receipt
                        </Button>
                      )}
                      {cfg.showPrint && IS_NATIVE && (
                        <button
                          onClick={handleChangePrinter}
                          className="text-xs text-slate-400 hover:text-slate-600 underline
                                     focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 rounded"
                        >
                          Change printer
                        </button>
                      )}
                      {!['done', 'cancelled'].includes(order.status) && (
                        <Button variant="danger" size="sm" onClick={() => setConfirmingCancel(true)}>
                          Cancel Order
                        </Button>
                      )}
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
                  </div>

                  {cfg.showPrint && order[cfg.printedAtField] && (
                    <p className="text-sm text-slate-500 mt-2">
                      {cfg.printedLabel} {fmtDate(order[cfg.printedAtField])} by {order[cfg.printedByField]}
                    </p>
                  )}

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
                            <span className="text-slate-700">{item.sku || item.product_name} — {item.quantity} {item.unit}</span>
                            <span className="font-medium text-slate-900 tabular-nums">
                              {PHP(cfg.showDeposit ? b.lineTotal : b.basePrice)}
                            </span>
                          </div>
                          {cfg.showDeposit && b.hasDeposit && (
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
                    const depositSubtotal = cfg.showDeposit
                      ? breakdowns.reduce((sum, b) => sum + b.depositOwed, 0)
                      : 0;
                    const liveAdj = Number(adjValue) || 0;
                    const orderTotal = itemsSubtotal + depositSubtotal + liveAdj;
                    const showDepositRows = cfg.showDeposit && bottleItems.length > 0;
                    const showBreakdown = showDepositRows || liveAdj !== 0;
                    if (!showBreakdown) return null;
                    return (
                      <dl className="mt-4 pt-4 border-t border-slate-200 space-y-1.5 text-sm">
                        {showDepositRows && (
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

                {cfg.showDeposit && !cfg.isProcessed(order) && bottleItems.length > 0 && (
                  <OrderCloseForm
                    order={order}
                    returnCounts={returnCounts}
                    onChangeReturnCounts={setReturnCounts}
                    onClosed={handleClosed}
                    hideCloseButton
                  />
                )}

                {cfg.showAdjustment && !cfg.isProcessed(order) && (
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

                {cfg.isProcessed(order) ? (
                  order.status === 'cancelled' ? (
                    <div className="bg-red-50 border border-red-200 rounded-xl p-5">
                      <p className="text-sm font-semibold text-red-700">✕ Cancelled</p>
                    </div>
                  ) : (
                    <div className="bg-green-50 border border-green-200 rounded-xl p-5">
                      <p className="text-sm font-semibold text-green-800">
                        {cfg.actionFor
                          ? `✓ ${cfg.actionFor(order).done}`
                          : `✓ Closed — ${fmtDate(order.closed_at)}`}
                      </p>
                    </div>
                  )
                ) : (
                  <div className="bg-white rounded-xl border border-slate-200 p-5">
                    <Button
                      className="w-full"
                      onClick={cfg.actionFor ? handleAdvanceAction : handleCloseOrder}
                      loading={closing}
                      disabled={cfg.showDeposit && bottleItems.length > 0 && Object.values(returnCounts).some((v) => v === '')}
                    >
                      {cfg.actionFor ? cfg.actionFor(order).label : 'Close Order'}
                    </Button>
                  </div>
                )}
              </div>
            )}
          </div>
        </>
      )}

      {/* Printer picker (Android only) */}
      {pickerVisible && (
        <PrinterPicker
          devices={pickerDevices}
          loading={pickerLoading}
          current={pickerCurrent}
          printPending={printPending}
          onSave={savePrinter}
          onScanWifi={scanWifi}
          onTestPrint={testPrint}
          onClose={closePickerAndCancel}
        />
      )}

      {/* Print twice for your copy? — pending orders only, asked before printing */}
      {twicePrompt && (
        <Modal
          title="Print twice for your copy?"
          onClose={() => confirmTwice(false)}
          onConfirm={() => confirmTwice(true)}
          cancelLabel="No"
          confirmLabel="Yes"
          loading={printing}
        >
          Print a second copy for your records?
        </Modal>
      )}

      {/* Confirm tagging this order as printed, after returning from the print dialog */}
      {printPrompt && (
        <Modal
          title="Tag receipt as printed?"
          onClose={cancelPrintTag}
          onConfirm={confirmPrintTag}
          confirmLabel="Yes, tag as printed"
          loading={taggingPrint}
        >
          Do you want to tag Order #{printPrompt.orderId} as printed
          ({printPrompt.phase === 'pending' ? 'Pending' : 'Delivered'})?
        </Modal>
      )}

      {/* Edit the active order without leaving the review flow */}
      {editing && order && (
        <OrderCreateModal
          editOrder={order}
          onClose={() => setEditing(false)}
          onSaved={handleEditSaved}
        />
      )}

      {/* Confirm cancelling the active order */}
      {confirmingCancel && order && (
        <Modal
          title={`Cancel Order #${order.id}?`}
          onClose={() => setConfirmingCancel(false)}
          onConfirm={handleCancelOrder}
          confirmLabel="Yes, cancel order"
          confirmVariant="danger"
          loading={cancelling}
        >
          {order.status === 'pending'
            ? 'The order will be cancelled. No stock was deducted so none will be restored.'
            : 'The order will be cancelled and all stock will be restored to inventory.'}
        </Modal>
      )}
    </div>
  );
}
