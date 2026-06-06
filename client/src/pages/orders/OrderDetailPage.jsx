import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../../api/client';
import { useToast } from '../../components/ui/Toast';
import Button from '../../components/ui/Button';
import Spinner from '../../components/ui/Spinner';
import OrderCreateModal from './OrderCreateModal';

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

export default function OrderDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { addToast } = useToast();
  const printRef = useRef(null);

  const [order, setOrder]           = useState(null);
  const [loading, setLoading]       = useState(true);
  const [notFound, setNotFound]     = useState(false);
  const [transitioning, setTransitioning] = useState(false);
  const [confirmAction, setConfirmAction] = useState(null); // { newStatus, label, message, danger? }
  const [editing, setEditing]       = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    api.get(`/orders/${id}`)
      .then(setOrder)
      .catch((err) => {
        if (err.status === 404) setNotFound(true);
        else addToast('Failed to load order.', 'error');
      })
      .finally(() => setLoading(false));
  }, [id, addToast]);

  useEffect(() => { load(); }, [load]);

  const transition = async () => {
    if (!confirmAction) return;
    setTransitioning(true);
    try {
      const updated = await api.post(`/orders/${id}/status`, { status: confirmAction.newStatus });
      setOrder(updated);
      setConfirmAction(null);
      addToast(`Order ${confirmAction.label.toLowerCase()}.`, 'success');
    } catch (err) {
      if (err.data?.shortfalls) {
        const names = err.data.shortfalls
          .map((s) => `${s.product_name}: need ${s.required}, have ${s.available}`)
          .join('; ');
        addToast(`Insufficient stock — ${names}`, 'error');
      } else {
        addToast(err.message || 'Transition failed.', 'error');
      }
      setConfirmAction(null);
    } finally {
      setTransitioning(false);
    }
  };

  const handlePrint = () => {
    if (!printRef.current) return;
    const content = printRef.current.innerHTML;
    const win = window.open('', '_blank', 'width=420,height=700');
    win.document.write(`<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Receipt — Order #${order.id}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Courier New', monospace; font-size: 12px; width: 80mm; padding: 6mm; }
  .center { text-align: center; }
  .bold { font-weight: bold; }
  .line { border-top: 1px dashed #000; margin: 4px 0; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 2px 0; vertical-align: top; }
  td:last-child { text-align: right; }
  .total-row td { font-weight: bold; font-size: 14px; padding-top: 4px; }
</style>
</head>
<body>${content}</body>
</html>`);
    win.document.close();
    win.focus();
    win.print();
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
  const isOpen = !['done', 'cancelled'].includes(order.status);

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
        {order.status !== 'cancelled' && (
          <Button variant="secondary" size="sm" onClick={handlePrint}>
            Print Receipt
          </Button>
        )}
      </div>

      {/* Order header */}
      <div className="bg-white rounded-xl border border-slate-200 p-6 mb-4">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-1">Order</p>
            <h1 className="text-2xl font-bold text-slate-900">#{order.id}</h1>
            <p className="text-sm text-slate-500 mt-1">{fmtDate(order.created_at)}</p>
          </div>
          <span className={`inline-flex items-center px-4 py-1.5 rounded-full text-sm font-bold border ${st.color}`}>
            {st.label}
          </span>
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
            { label: 'Created',    val: order.created_at },
            { label: 'Dispatched', val: order.dispatched_at },
            { label: 'Delivered',  val: order.delivered_at },
            { label: 'Closed',     val: order.closed_at },
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
                  <p className="font-medium text-slate-800">{item.product_name}</p>
                  <p className="text-xs text-slate-400">{item.category}</p>
                </td>
                <td className="px-5 py-3 text-right tabular-nums text-slate-700">
                  {item.quantity} {item.unit}
                </td>
                <td className="px-4 py-3 text-right tabular-nums text-slate-500 hidden sm:table-cell">
                  {PHP(item.unit_price)}
                </td>
                <td className="px-4 py-3 text-right tabular-nums text-slate-500 hidden sm:table-cell">
                  {Number(item.unit_deposit_fee) > 0 ? PHP(item.unit_deposit_fee) : '—'}
                </td>
                <td className="px-5 py-3 text-right tabular-nums font-semibold text-slate-800">
                  {PHP(item.line_total)}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-slate-200 bg-slate-50">
              <td colSpan={4} className="px-5 py-4 text-right font-bold text-slate-700">Order Total</td>
              <td className="px-5 py-4 text-right font-bold text-xl tabular-nums text-slate-900">
                {PHP(order.total_amount)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      {/* Actions */}
      {isOpen && (
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
              {order.status === 'pending' && (
                <>
                  <Button
                    onClick={() => setEditing(true)}
                    variant="secondary"
                  >
                    Edit Order
                  </Button>
                  <Button
                    onClick={() => setConfirmAction({
                      newStatus: 'in_transit',
                      label: 'Start Dispatch',
                      message: 'Stock will be deducted from inventory. This cannot be undone without cancelling.',
                    })}
                  >
                    Start Dispatch →
                  </Button>
                </>
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
              {order.status === 'completed' && (
                <Button
                  variant="secondary"
                  onClick={() => setConfirmAction({
                    newStatus: 'done',
                    label: 'Close Order',
                    message: 'Close and archive this order. No further changes will be allowed.',
                  })}
                >
                  Close Order
                </Button>
              )}
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
            </div>
          )}
        </div>
      )}

      {/* Hidden receipt for print */}
      <div ref={printRef} style={{ display: 'none' }}>
        <div className="center bold" style={{ fontSize: '14px', marginBottom: '4px' }}>LEYBLE HUB</div>
        <div className="center" style={{ marginBottom: '8px' }}>Beverage Distributor — Antipolo</div>
        <div className="line" />
        <table style={{ marginBottom: '4px' }}>
          <tbody>
            <tr><td>Order #:</td><td>{order.id}</td></tr>
            <tr><td>Date:</td><td>{fmtDate(order.created_at, { month: 'short', day: 'numeric', year: 'numeric' })}</td></tr>
            <tr><td>Customer:</td><td>{order.customer_name}</td></tr>
            {order.personnel?.length > 0 && (
              <tr>
                <td>Personnel:</td>
                <td>{order.personnel.map((p) => `${p.full_name} (${p.role})`).join(', ')}</td>
              </tr>
            )}
          </tbody>
        </table>
        <div className="line" />
        <table>
          <thead>
            <tr>
              <td className="bold">Item</td>
              <td className="bold" style={{ textAlign: 'center' }}>Qty</td>
              <td className="bold" style={{ textAlign: 'right' }}>Price</td>
            </tr>
          </thead>
          <tbody>
            {order.items.map((item) => (
              <tr key={item.id}>
                <td style={{ paddingRight: '4px' }}>{item.product_name}</td>
                <td style={{ textAlign: 'center', whiteSpace: 'nowrap' }}>{item.quantity}x</td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  {PHP(item.unit_price)}
                  {Number(item.unit_deposit_fee) > 0 && (
                    <span style={{ display: 'block', fontSize: '10px' }}>
                      +{PHP(item.unit_deposit_fee)} dep.
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="total-row">
              <td colSpan={2}>TOTAL</td>
              <td>{PHP(order.total_amount)}</td>
            </tr>
          </tfoot>
        </table>
        <div className="line" />
        {order.notes && <div style={{ marginTop: '4px', fontSize: '11px' }}>Note: {order.notes}</div>}
        <div className="center" style={{ marginTop: '8px', fontSize: '11px' }}>Thank you!</div>
      </div>

      {/* Edit modal */}
      {editing && (
        <OrderCreateModal
          editOrder={order}
          onClose={() => setEditing(false)}
          onSaved={() => { setEditing(false); load(); }}
        />
      )}
    </div>
  );
}
