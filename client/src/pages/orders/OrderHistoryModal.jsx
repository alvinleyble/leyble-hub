import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../../api/client';
import { useToast } from '../../components/ui/Toast';
import Spinner from '../../components/ui/Spinner';
import { orderRef } from '../../utils/orderRef';

const PHP = (n) =>
  `₱${Number(n).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const listDateTime = (d) =>
  d ? new Date(d).toLocaleString('en-PH', {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit',
    }) : '—';

const DATE_PRESETS = [
  { id: 'all', label: 'All Time' },
  { id: 'today', label: 'Today' },
  { id: 'yesterday', label: 'Yesterday' },
  { id: '7d', label: 'Last 7 Days' },
];

const STATUS_BADGE = {
  draft:      'bg-violet-100 text-violet-800 border-violet-200',
  pending:    'bg-blue-100 text-blue-800 border-blue-200',
  in_transit: 'bg-amber-100 text-amber-800 border-amber-200',
  completed:  'bg-green-100 text-green-800 border-green-200',
  done:       'bg-slate-100 text-slate-600 border-slate-200',
  cancelled:  'bg-red-100 text-red-700 border-red-200',
};

const STATUS_LABEL = {
  draft:      'Draft',
  pending:    'Pending',
  in_transit: 'In Transit',
  completed:  'Delivered',
  done:       'Closed',
  cancelled:  'Cancelled',
};

export default function OrderHistoryModal({ onClose }) {
  const { addToast } = useToast();

  const [orders, setOrders]         = useState([]);
  const [loading, setLoading]       = useState(true);
  const [query, setQuery]           = useState('');
  const [dateFilter, setDateFilter] = useState('all');
  const [selectedOrder, setSelectedOrder] = useState(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  const load = async () => {
    setLoading(true);
    let dateParams = '';
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfYesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    const startOf7DaysAgo = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6);

    if (dateFilter === 'today') {
      dateParams = `&from_date=${encodeURIComponent(startOfToday.toISOString())}`;
    } else if (dateFilter === 'yesterday') {
      dateParams = `&from_date=${encodeURIComponent(startOfYesterday.toISOString())}&to_date=${encodeURIComponent(startOfToday.toISOString())}`;
    } else if (dateFilter === '7d') {
      dateParams = `&from_date=${encodeURIComponent(startOf7DaysAgo.toISOString())}`;
    }

    try {
      const rows = await api.get(`/orders?${dateParams.replace(/^&/, '')}`);
      setOrders(rows.sort((a, b) => new Date(b.created_at) - new Date(a.created_at)));
    } catch (err) {
      addToast(err.message || 'Failed to load order history.', 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [dateFilter]); // eslint-disable-line react-hooks/exhaustive-deps

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return orders;
    return orders.filter(
      (o) => (o.customer_name || '').toLowerCase().includes(q)
        || String(o.id ?? '').includes(q)
        || String(o.receipt_number ?? '').toLowerCase().includes(q)
    );
  }, [orders, query]);

  const handleSelectRow = async (o) => {
    if (selectedOrder?.id === o.id) {
      setSelectedOrder(null);
      return;
    }
    setLoadingDetail(true);
    try {
      const full = await api.get(`/orders/${o.id}`);
      setSelectedOrder(full);
    } catch {
      setSelectedOrder(o);
    } finally {
      setLoadingDetail(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="history-modal-title"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-white rounded-2xl w-full max-w-3xl max-h-[90vh] flex flex-col shadow-2xl overflow-hidden border border-slate-200">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 shrink-0">
          <div>
            <h2 id="history-modal-title" className="text-xl font-bold text-slate-900">
              🕘 Order History
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Quick view of past outgoing orders
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close history"
            className="w-10 h-10 flex items-center justify-center rounded-lg text-slate-400
                       hover:text-slate-700 hover:bg-slate-100 transition-colors
                       focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
          >
            ✕
          </button>
        </div>

        {/* Toolbar: Search + Date Presets */}
        <div className="px-6 py-3 border-b border-slate-200 bg-slate-50 shrink-0 space-y-3">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by customer or order number…"
            className="w-full h-11 px-4 border border-slate-300 rounded-xl text-sm text-slate-900 bg-white
                       focus:outline-none focus:ring-2 focus:ring-blue-600"
            aria-label="Search by customer or order number"
          />

          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Date presets">
            {DATE_PRESETS.map((preset) => {
              const active = dateFilter === preset.id;
              return (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => setDateFilter(preset.id)}
                  aria-pressed={active}
                  className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold border transition-colors
                    ${active
                      ? 'bg-blue-700 text-white border-blue-700 shadow-sm'
                      : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-100'}`}
                >
                  {preset.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Order List */}
        <div className="flex-1 overflow-y-auto p-6 min-h-0">
          {loading ? (
            <div className="flex items-center justify-center py-16"><Spinner size="lg" /></div>
          ) : visible.length === 0 ? (
            <div className="text-center py-16 text-slate-400">
              <p className="text-base font-semibold">No orders found.</p>
              <p className="text-xs text-slate-400 mt-1">Try changing the date range or search query.</p>
            </div>
          ) : (
            <ul className="space-y-3">
              {visible.map((o) => {
                const isSelected = selectedOrder?.id === o.id;
                return (
                  <li
                    key={o.id}
                    className={`rounded-xl border transition-colors shadow-sm overflow-hidden
                      ${isSelected ? 'border-blue-400 bg-blue-50/30' : 'border-slate-200 bg-white hover:border-slate-300'}`}
                  >
                    <div
                      onClick={() => handleSelectRow(o)}
                      className="p-4 cursor-pointer flex flex-wrap items-start justify-between gap-2"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="text-base font-bold text-slate-900">
                            {orderRef(o)} · {o.customer_name}
                          </p>
                        </div>
                        <p className="text-xs text-slate-500 mt-0.5">
                          {listDateTime(o.created_at)} · {o.order_type === 'pickup' ? '🏪 Pickup' : '🚚 Delivery'}
                        </p>
                        <div className="mt-2 flex flex-wrap gap-1.5 items-center">
                          <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold border ${STATUS_BADGE[o.status] ?? 'bg-slate-100 text-slate-500 border-slate-200'}`}>
                            {STATUS_LABEL[o.status] ?? o.status}
                          </span>
                          {((o.status === 'pending' && o.pending_receipt_printed_at)
                            || (['completed', 'done'].includes(o.status) && o.delivered_receipt_printed_at)) && (
                            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold border bg-slate-100 text-slate-600 border-slate-200">
                              🖶 Printed
                            </span>
                          )}
                        </div>
                      </div>

                      <div className="text-right">
                        <p className="text-lg font-bold text-slate-900 tabular-nums">
                          {PHP(Number(o.total_amount) + Number(o.adjustment || 0))}
                        </p>
                        <span className="text-xs text-blue-700 font-medium hover:underline mt-1 inline-block">
                          {isSelected ? 'Hide details ▲' : 'View details ▼'}
                        </span>
                      </div>
                    </div>

                    {isSelected && (
                      <div className="px-4 pb-4 pt-2 border-t border-slate-200 bg-slate-50 text-sm space-y-2">
                        {loadingDetail ? (
                          <div className="py-4 flex justify-center"><Spinner size="sm" /></div>
                        ) : (
                          <>
                            {selectedOrder.notes && (
                              <p className="text-xs text-slate-600 italic">Notes: "{selectedOrder.notes}"</p>
                            )}
                            {selectedOrder.items && selectedOrder.items.length > 0 && (
                              <div className="space-y-1 mt-2">
                                <p className="text-xs font-bold text-slate-500 uppercase tracking-wide">Items:</p>
                                <ul className="space-y-1 text-xs">
                                  {selectedOrder.items.map((i, idx) => (
                                    <li key={i.id || idx} className="flex justify-between text-slate-700">
                                      <span>{i.sku || i.product_name} × {i.quantity} {i.unit || 'cs'}</span>
                                      <span className="font-semibold text-slate-900 tabular-nums">
                                        {PHP(Number(i.quantity) * Number(i.unit_price))}
                                      </span>
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            )}
                            {Number(selectedOrder.adjustment) !== 0 && (
                              <div className="flex justify-between text-xs pt-2 border-t border-slate-200 text-slate-600">
                                <span>Adjustment{selectedOrder.adjustment_reason ? ` (${selectedOrder.adjustment_reason})` : ''}</span>
                                <span className="font-semibold tabular-nums">
                                  {Number(selectedOrder.adjustment) > 0 ? '+' : ''}{PHP(selectedOrder.adjustment)}
                                </span>
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3 bg-slate-50 border-t border-slate-200 flex justify-between items-center text-xs text-slate-500 shrink-0">
          <span>Showing {visible.length} order{visible.length === 1 ? '' : 's'}</span>
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg border border-slate-300 bg-white text-slate-700 font-semibold hover:bg-slate-100"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
