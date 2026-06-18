import React, { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../../api/client';
import { useToast } from '../../components/ui/Toast';
import Button from '../../components/ui/Button';
import Spinner from '../../components/ui/Spinner';
import Modal from '../../components/ui/Modal';
import { Capacitor } from '@capacitor/core';
import OrderCreateModal from './OrderCreateModal';
import OrderCloseForm from './OrderCloseForm';
import { usePrintReceipt } from './usePrintReceipt';
import PrinterPicker from './PrinterPicker';

const IS_NATIVE = Capacitor.isNativePlatform();

const PHP = (n) =>
  `₱${Number(n).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const fmtDate = (d, opts = { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) =>
  d ? new Date(d).toLocaleString('en-PH', opts) : null;

const STATUS = {
  pending:    { label: 'Pending',     color: 'bg-blue-100 text-blue-800 border-blue-300' },
  in_transit: { label: 'In Transit',  color: 'bg-amber-100 text-amber-800 border-amber-300' },
  completed:  { label: 'Delivered',   color: 'bg-green-100 text-green-800 border-green-300' },
  done:       { label: 'Closed',      color: 'bg-slate-100 text-slate-600 border-slate-200' },
  cancelled:  { label: 'Cancelled',   color: 'bg-red-100 text-red-700 border-red-300' },
};

const ROLE_COLOR = {
  Driver: 'bg-purple-100 text-purple-800 border-purple-300',
  Helper: 'bg-teal-100 text-teal-800 border-teal-300',
};

const INPUT = `w-full px-4 py-2.5 border border-slate-300 rounded-lg text-base text-slate-900
               focus:outline-none focus:ring-2 focus:ring-blue-600`;

export default function OrderDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { addToast } = useToast();
  const [order, setOrder]           = useState(null);
  const [loading, setLoading]       = useState(true);
  const [notFound, setNotFound]     = useState(false);
  const [transitioning, setTransitioning] = useState(false);
  const [confirmAction, setConfirmAction] = useState(null);
  const [editing, setEditing]       = useState(false);
  const [closing, setClosing]       = useState(false);

  // Adjustment form state
  const [adjExpanded, setAdjExpanded] = useState(false);
  const [adjValue, setAdjValue]       = useState('0');
  const [adjReason, setAdjReason]     = useState('');
  const [savingAdj, setSavingAdj]     = useState(false);

  // Live, in-progress bottle-return entries — lifted up from OrderCloseForm so its
  // breakdown math can read them. Keyed by order_items.id.
  const [returnCounts, setReturnCounts] = useState({});

  const {
    handlePrint, printing,
    pickerVisible, pickerDevices, pickerLoading, pickerCurrent, printPending,
    savePrinter, scanWifi, testPrint, closePickerAndCancel, handleChangePrinter,
    printPrompt, taggingPrint, confirmPrintTag, cancelPrintTag,
  } = usePrintReceipt(order, returnCounts, setOrder);

  const load = useCallback(() => {
    setLoading(true);
    api.get(`/orders/${id}`)
      .then((o) => {
        setOrder(o);
        setAdjValue(String(o.adjustment || '0'));
        setAdjReason(o.adjustment_reason || '');
        setAdjExpanded(Number(o.adjustment) !== 0);
      })
      .catch((err) => {
        if (err.status === 404) setNotFound(true);
        else addToast('Failed to load order.', 'error');
      })
      .finally(() => setLoading(false));
  }, [id, addToast]);

  useEffect(() => { load(); }, [load]);

  const bottleItems = order
    ? order.items.filter((i) => i.requires_bottle_return && Number(i.unit_deposit_fee) > 0)
    : [];
  const bottleItemIds = bottleItems.map((i) => i.id).join(',');

  // Reset the in-progress bottle-return entries whenever the set of returnable items
  // changes (initial load, or items added/removed via editing) — otherwise stale
  // item ids could linger in returnCounts.
  useEffect(() => {
    if (!order || order.status !== 'completed' || bottleItems.length === 0) return;
    const counts = {};
    bottleItems.forEach((i) => {
      const stored = Number(i.bottles_returned);
      const total  = Number(i.quantity) * (Number(i.units_per_case) || 1);
      counts[i.id] = String(stored > 0 ? stored : total);
    });
    setReturnCounts(counts);
  }, [bottleItemIds, order?.status]);

  const transition = async () => {
    if (!confirmAction) return;
    setTransitioning(true);
    try {
      const updated = await api.post(`/orders/${id}/status`, { status: confirmAction.newStatus });
      setOrder(updated);
      setConfirmAction(null);
      addToast(`Order ${confirmAction.label.toLowerCase()}.`, 'success');
    } catch (err) {
      addToast(err.message || 'Transition failed.', 'error');
      setConfirmAction(null);
    } finally {
      setTransitioning(false);
    }
  };

  const saveAdjustment = async () => {
    const adj = Number(adjValue);
    if (isNaN(adj)) { addToast('Enter a valid number.', 'error'); return; }
    if (adj !== 0 && !adjReason.trim()) { addToast('Adjustment reason is required.', 'error'); return; }
    setSavingAdj(true);
    try {
      const updated = await api.patch(`/orders/${id}/adjustment`, {
        adjustment: adj,
        adjustment_reason: adjReason.trim(),
      });
      setOrder(updated);
      setAdjValue(String(updated.adjustment || '0'));
      setAdjReason(updated.adjustment_reason || '');
      addToast('Adjustment saved.', 'success');
    } catch (err) {
      addToast(err.message || 'Failed to save adjustment.', 'error');
    } finally {
      setSavingAdj(false);
    }
  };

  const handleCloseOrder = async () => {
    setClosing(true);
    try {
      let updated;
      if (bottleItems.length > 0) {
        const items = Object.entries(returnCounts).map(([itemId, returned]) => ({
          id: Number(itemId),
          bottles_returned: Number(returned) || 0,
        }));
        updated = await api.post(`/orders/${id}/close`, { items });
      } else {
        updated = await api.post(`/orders/${id}/status`, { status: 'done' });
      }
      setOrder(updated);
      setAdjValue(String(updated.adjustment || '0'));
      setAdjReason(updated.adjustment_reason || '');
      addToast('Order closed.', 'success');
    } catch (err) {
      addToast(err.message || 'Failed to close order.', 'error');
    } finally {
      setClosing(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Spinner size="lg" />
      </div>
    );
  }

  if (notFound) {
    return (
      <div className="p-6 max-w-2xl mx-auto text-center">
        <p className="text-xl font-semibold text-slate-400 mt-20">Order not found.</p>
        <Button className="mt-4" variant="secondary" onClick={() => navigate('/orders')}>
          ← Back to Orders
        </Button>
      </div>
    );
  }

  if (!order) return null;

  const st = STATUS[order.status] ?? { label: order.status, color: 'bg-slate-100 text-slate-500 border-slate-200' };
  const isPickup      = order.order_type === 'pickup';
  const isDepositable = order.status === 'done' || order.status === 'completed';
  const finalTotal = Number(order.total_amount) + Number(order.adjustment || 0);
  const hasAdj     = Number(order.adjustment) !== 0;

  const itemsSubtotal = order.items.reduce(
    (sum, i) => sum + Number(i.quantity) * Number(i.unit_price), 0);

  const itemNetDeposit = (item) => {
    if (!isDepositable) return 0;
    const dep = Number(item.unit_deposit_fee);
    if (!dep) return 0;
    const totalBottles = Number(item.quantity) * (Number(item.units_per_case) || 1);
    const isLive = item.requires_bottle_return && order.status === 'completed'
                   && returnCounts[item.id] !== undefined && returnCounts[item.id] !== '';
    const returned = isLive
      ? Math.max(Number(returnCounts[item.id]) || 0, 0)
      : Math.max(Number(item.bottles_returned) || 0, 0);
    return (totalBottles - returned) * dep;
  };

  const depositTotal = order.items.reduce((sum, i) => sum + itemNetDeposit(i), 0);

  const liveTotal   = itemsSubtotal + depositTotal + Number(order.adjustment || 0);
  const hasDeposits = order.items.some(i => Number(i.unit_deposit_fee) > 0);

  return (
    <div className="p-6 max-w-3xl mx-auto">

      {/* Back + Print */}
      <div className="flex items-center justify-between mb-6">
        <button
          onClick={() => navigate('/orders')}
          className="text-sm font-medium text-blue-700 hover:text-blue-900 flex items-center gap-1"
        >
          ← Orders
        </button>
        {!['in_transit'].includes(order.status) && (
          <div className="flex items-center gap-3">
            <Button variant="secondary" size="sm" onClick={handlePrint} loading={printing}>
              Print Receipt
            </Button>
            {IS_NATIVE && (
              <button
                onClick={handleChangePrinter}
                className="text-xs text-slate-400 hover:text-slate-600 underline
                           focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 rounded"
              >
                Change printer
              </button>
            )}
          </div>
        )}
      </div>

      {(order.pending_receipt_printed_at || order.delivered_receipt_printed_at) && (
        <div className="mb-4 -mt-4 space-y-1">
          {order.pending_receipt_printed_at && (
            <p className="text-sm text-slate-500">
              Printed (pending) {fmtDate(order.pending_receipt_printed_at)} by {order.pending_receipt_printed_by_name}
            </p>
          )}
          {order.delivered_receipt_printed_at && (
            <p className="text-sm text-slate-500">
              Printed (delivered) {fmtDate(order.delivered_receipt_printed_at)} by {order.delivered_receipt_printed_by_name}
            </p>
          )}
        </div>
      )}

      {/* Order header */}
      <div className="bg-white rounded-xl border border-slate-200 p-6 mb-4">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-1">Order</p>
            <h1 className="text-2xl font-bold text-slate-900">#{order.id}</h1>
            <p className="text-sm text-slate-500 mt-1">{fmtDate(order.created_at)}</p>
          </div>
          <div className="flex items-center gap-2 flex-wrap justify-end">
            <span className={`inline-flex items-center px-3 py-1 rounded-full text-xs font-semibold border
              ${isPickup
                ? 'bg-blue-100 text-blue-800 border-blue-300'
                : 'bg-slate-100 text-slate-600 border-slate-200'}`}>
              {isPickup ? '🏪 Pickup' : '🚚 Delivery'}
            </span>
            <span className={`inline-flex items-center px-4 py-1.5 rounded-full text-sm font-bold border ${st.color}`}>
              {st.label}
            </span>
          </div>
        </div>

        {/* Customer */}
        <div className="mt-5 pt-5 border-t border-slate-100">
          <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-2">Customer</p>
          <p className="text-base font-semibold text-slate-800">{order.customer_name}</p>
          {order.customer_address && <p className="text-sm text-slate-500">{order.customer_address}</p>}
          {order.customer_phone   && <p className="text-sm text-slate-500">{order.customer_phone}</p>}
        </div>

        {/* Personnel */}
        {order.personnel?.length > 0 && (
          <div className="mt-4 pt-4 border-t border-slate-100">
            <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-2">Assigned Personnel</p>
            <div className="flex flex-wrap gap-2">
              {order.personnel.map((p) => (
                <div key={p.id} className="flex items-center gap-1.5">
                  <span className="text-sm font-medium text-slate-700">{p.full_name}</span>
                  <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold border
                    ${ROLE_COLOR[p.role] ?? 'bg-slate-100 text-slate-600 border-slate-200'}`}>
                    {p.role}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Timestamps */}
        <div className="mt-4 pt-4 border-t border-slate-100 grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { label: 'Created',                              val: order.created_at },
            { label: 'Dispatched',                           val: !isPickup ? order.dispatched_at : null },
            { label: isPickup ? 'Picked Up' : 'Delivered',  val: order.delivered_at },
            { label: 'Closed',                               val: order.closed_at },
          ].filter((t) => t.val).map((t) => (
            <div key={t.label}>
              <p className="text-xs font-semibold text-slate-400 uppercase">{t.label}</p>
              <p className="text-xs text-slate-600 mt-0.5">
                {fmtDate(t.val, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
              </p>
            </div>
          ))}
        </div>

        {order.notes && (
          <div className="mt-4 pt-4 border-t border-slate-100">
            <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-1">Notes</p>
            <p className="text-sm text-slate-600 italic">"{order.notes}"</p>
          </div>
        )}
      </div>

      {/* Line items */}
      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden mb-4">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-slate-50 text-slate-500 text-xs uppercase tracking-wide border-b border-slate-200">
              <th className="text-left px-5 py-3 font-semibold">Product</th>
              <th className="text-right px-5 py-3 font-semibold">Qty</th>
              <th className="text-right px-4 py-3 font-semibold hidden sm:table-cell">Price/Case</th>
              <th className="text-right px-4 py-3 font-semibold hidden sm:table-cell">Deposit</th>
              <th className="text-right px-5 py-3 font-semibold">Total</th>
            </tr>
          </thead>
          <tbody>
            {order.items.map((item) => (
              <tr key={item.id} className="border-t border-slate-100">
                <td className="px-5 py-3">
                  <p className="font-medium text-slate-800">{item.sku || item.product_name}</p>
                </td>
                <td className="px-5 py-3 text-right tabular-nums text-slate-700">
                  {item.quantity} {item.unit}
                </td>
                <td className="px-4 py-3 text-right tabular-nums text-slate-500 hidden sm:table-cell">
                  {PHP(item.unit_price)}
                </td>
                <td className="px-4 py-3 text-right tabular-nums text-slate-500 hidden sm:table-cell">
                  {Number(item.unit_deposit_fee) > 0 && isDepositable ? (
                    <div>
                      <div>{PHP(item.unit_deposit_fee)}/bottle</div>
                      {Number(item.bottles_returned) > 0 && (
                        <div className="text-xs text-green-700 mt-0.5">
                          −{item.bottles_returned} returned
                        </div>
                      )}
                    </div>
                  ) : '—'}
                </td>
                <td className="px-5 py-3 text-right tabular-nums font-semibold text-slate-800">
                  <div>{PHP(Number(item.quantity) * Number(item.unit_price))}</div>
                  {Number(item.unit_deposit_fee) > 0 && isDepositable && (
                    <div className={`text-xs font-normal mt-0.5 ${itemNetDeposit(item) < 0 ? 'text-green-700' : 'text-slate-500'}`}>
                      {itemNetDeposit(item) < 0
                        ? `− ${PHP(Math.abs(itemNetDeposit(item)))} credit`
                        : `+ ${PHP(itemNetDeposit(item))} dep.`}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            {hasDeposits && isDepositable && (
              <>
                <tr className="border-t border-slate-200 bg-slate-50">
                  <td colSpan={4} className="px-5 py-3 text-right text-slate-500">Items</td>
                  <td className="px-5 py-3 text-right tabular-nums text-slate-700">
                    {PHP(itemsSubtotal)}
                  </td>
                </tr>
                <tr className="border-t border-slate-100 bg-slate-50">
                  <td colSpan={4} className="px-5 py-3 text-right text-slate-500">Deposit fee</td>
                  <td className={`px-5 py-3 text-right tabular-nums ${depositTotal < 0 ? 'text-green-700' : 'text-slate-700'}`}>
                    {depositTotal < 0
                      ? `− ${PHP(Math.abs(depositTotal))}`
                      : `+ ${PHP(depositTotal)}`}
                  </td>
                </tr>
              </>
            )}
            {hasAdj && (
              <tr className="border-t border-slate-100 bg-slate-50">
                <td colSpan={4} className="px-5 py-3 text-right text-slate-500">
                  Adjustment
                  {order.adjustment_reason && (
                    <span className="ml-2 text-xs text-slate-400 italic">({order.adjustment_reason})</span>
                  )}
                </td>
                <td className={`px-5 py-3 text-right tabular-nums font-medium
                  ${Number(order.adjustment) > 0 ? 'text-red-600' : 'text-green-700'}`}>
                  {Number(order.adjustment) > 0 ? '+' : ''}{PHP(order.adjustment)}
                </td>
              </tr>
            )}
            <tr className="border-t-2 border-slate-200 bg-slate-50">
              <td colSpan={4} className="px-5 py-4 text-right font-bold text-slate-700">
                Order Total
              </td>
              <td className="px-5 py-4 text-right font-bold text-xl tabular-nums text-slate-900">
                {PHP(liveTotal)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      {/* Bottle returns — review inline before closing */}
      {order.status === 'completed' && bottleItems.length > 0 && (
        <OrderCloseForm
          order={order}
          returnCounts={returnCounts}
          onChangeReturnCounts={setReturnCounts}
          hideCloseButton
        />
      )}

      {/* Adjustment */}
      <div className="bg-white rounded-xl border border-slate-200 p-5 mb-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs font-bold text-slate-400 uppercase tracking-widest">Adjustment</p>
            {!adjExpanded && (
              <p className="text-sm text-slate-500 mt-1">
                {hasAdj
                  ? <span className={Number(order.adjustment) > 0 ? 'text-red-600 font-semibold' : 'text-green-700 font-semibold'}>
                      {Number(order.adjustment) > 0 ? '+' : ''}{PHP(order.adjustment)}
                      {order.adjustment_reason && ` — ${order.adjustment_reason}`}
                    </span>
                  : 'None'}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={() => setAdjExpanded((v) => !v)}
            className="text-sm text-blue-700 hover:text-blue-900 font-medium
                       focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 rounded"
          >
            {adjExpanded ? 'Cancel' : hasAdj ? 'Edit' : '+ Add Adjustment'}
          </button>
        </div>

        {adjExpanded && (
          <div className="mt-4 space-y-3">
            <div>
              <label className="block text-sm font-semibold text-slate-700 mb-1">
                Amount (₱) — use negative for discount
              </label>
              <input
                type="number"
                step="0.01"
                value={adjValue}
                onChange={(e) => setAdjValue(e.target.value)}
                className={INPUT}
                placeholder="e.g. -50 for discount, 200 for surcharge"
              />
            </div>
            <div>
              <label className="block text-sm font-semibold text-slate-700 mb-1">
                Reason {Number(adjValue) !== 0 && <span className="text-red-500">*</span>}
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
            <Button onClick={saveAdjustment} loading={savingAdj}>
              Save Adjustment
            </Button>
          </div>
        )}
      </div>

      {order.status === 'completed' && (
        <div className="bg-white rounded-xl border border-slate-200 p-5 mb-4">
          <Button className="w-full" onClick={handleCloseOrder} loading={closing}>
            Close Order
          </Button>
        </div>
      )}

      {/* Actions */}
      <div className="bg-white rounded-xl border border-slate-200 p-5 mb-4">
        <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-4">Actions</p>

        {confirmAction ? (
          <div className={`p-4 rounded-lg border ${confirmAction.danger ? 'bg-red-50 border-red-200' : 'bg-blue-50 border-blue-200'}`}>
            <p className={`text-sm font-semibold mb-1 ${confirmAction.danger ? 'text-red-800' : 'text-blue-800'}`}>
              Confirm: {confirmAction.label}
            </p>
            <p className={`text-sm mb-4 ${confirmAction.danger ? 'text-red-700' : 'text-blue-700'}`}>
              {confirmAction.message}
            </p>
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" onClick={() => setConfirmAction(null)} disabled={transitioning}>
                Cancel
              </Button>
              <Button
                size="sm"
                variant={confirmAction.danger ? 'danger' : 'primary'}
                onClick={transition}
                loading={transitioning}
              >
                {confirmAction.label}
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap gap-3">
            {/* Edit is always available */}
            <Button variant="secondary" onClick={() => setEditing(true)}>
              Edit Order
            </Button>

            {/* Delivery pending: Start Dispatch */}
            {order.status === 'pending' && !isPickup && (
              <Button
                onClick={() => setConfirmAction({
                  newStatus: 'in_transit',
                  label: 'Start Dispatch',
                  message: 'Stock will be deducted from inventory. This cannot be undone without cancelling.',
                })}
              >
                Start Dispatch →
              </Button>
            )}

            {/* Pickup pending: Mark as Picked Up */}
            {order.status === 'pending' && isPickup && (
              <Button
                onClick={() => setConfirmAction({
                  newStatus: 'completed',
                  label: 'Mark as Picked Up',
                  message: 'Stock will be deducted from inventory once the customer picks up.',
                })}
              >
                Mark as Picked Up ✓
              </Button>
            )}

            {order.status === 'in_transit' && (
              <Button
                variant="secondary"
                onClick={() => setConfirmAction({
                  newStatus: 'pending',
                  label: 'Back to Pending',
                  message: 'Stock will be restored to inventory.',
                })}
              >
                ← Back to Pending
              </Button>
            )}

            {order.status === 'in_transit' && (
              <Button
                variant="warning"
                onClick={() => setConfirmAction({
                  newStatus: 'completed',
                  label: 'Mark as Delivered',
                  message: 'Confirm that this order was received by the customer.',
                })}
              >
                Mark as Delivered ✓
              </Button>
            )}

            {order.status === 'completed' && !isPickup && (
              <Button
                variant="secondary"
                onClick={() => setConfirmAction({
                  newStatus: 'in_transit',
                  label: 'Back to In Transit',
                  message: 'Confirm this order has not yet been delivered.',
                })}
              >
                ← Back to In Transit
              </Button>
            )}

            {order.status === 'completed' && isPickup && (
              <Button
                variant="secondary"
                onClick={() => setConfirmAction({
                  newStatus: 'pending',
                  label: 'Back to Pending',
                  message: 'Stock will be restored to inventory.',
                })}
              >
                ← Back to Pending
              </Button>
            )}

            {order.status === 'done' && (
              <Button
                variant="secondary"
                onClick={() => setConfirmAction({
                  newStatus: 'completed',
                  label: 'Reopen Order',
                  message: 'Reopen this order for further changes.',
                })}
              >
                ← Reopen Order
              </Button>
            )}

            {!['done', 'cancelled'].includes(order.status) && (
              <Button
                variant="danger"
                onClick={() => setConfirmAction({
                  newStatus: 'cancelled',
                  label: 'Cancel Order',
                  message: order.status === 'pending'
                    ? 'The order will be cancelled. No stock was deducted so none will be restored.'
                    : 'The order will be cancelled and all stock will be restored to inventory.',
                  danger: true,
                })}
              >
                Cancel Order
              </Button>
            )}
          </div>
        )}
      </div>

      {/* Edit modal */}
      {editing && (
        <OrderCreateModal
          editOrder={order}
          onClose={() => setEditing(false)}
          onSaved={() => { setEditing(false); load(); }}
        />
      )}

      {/* Printer picker (Android only — shown on first print or "Change printer") */}
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

      {/* Confirm tagging this order as printed */}
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

    </div>
  );
}
