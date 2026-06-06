import React, { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import { useToast } from '../../components/ui/Toast';
import Spinner from '../../components/ui/Spinner';

const ACTION_LABELS = {
  manual_adjustment: 'Manual Adjustment',
  restock:           'Restock',
  price_change:      'Price Change',
  order_fulfillment: 'Order Fulfilled',
  order_edit:        'Order Edit',
  order_cancel:      'Order Cancelled',
};

const ACTION_COLORS = {
  manual_adjustment: 'bg-purple-100 text-purple-800 border-purple-300',
  restock:           'bg-green-100  text-green-800  border-green-300',
  price_change:      'bg-blue-100   text-blue-800   border-blue-300',
  order_fulfillment: 'bg-slate-100  text-slate-700  border-slate-300',
  order_edit:        'bg-amber-100  text-amber-800  border-amber-300',
  order_cancel:      'bg-red-100    text-red-800    border-red-300',
};

const ACTION_TYPES = Object.keys(ACTION_LABELS);

const SELECT = `h-12 px-4 border border-slate-300 rounded-lg text-base text-slate-900 bg-white
                focus:outline-none focus:ring-2 focus:ring-blue-600`;

export default function AuditPage() {
  const { addToast } = useToast();

  const [entries, setEntries]   = useState([]);
  const [products, setProducts] = useState([]);
  const [loading, setLoading]   = useState(true);

  const [productId, setProductId]     = useState('');
  const [actionType, setActionType]   = useState('');
  const [fromDate, setFromDate]       = useState('');
  const [toDate, setToDate]           = useState('');

  // Load product list once (including inactive — old logs may reference them)
  useEffect(() => {
    api.get('/products?include_inactive=true')
      .then((p) => setProducts(p.sort((a, b) => a.name.localeCompare(b.name))))
      .catch(() => {});
  }, []);

  const load = useCallback(() => {
    setLoading(true);
    const params = new URLSearchParams();
    if (productId)  params.set('product_id',  productId);
    if (actionType) params.set('action_type', actionType);
    if (fromDate)   params.set('from_date',   fromDate);
    if (toDate)     params.set('to_date',     toDate);
    params.set('limit', '500');
    const qs = params.toString();

    api.get(`/audit?${qs}`)
      .then(setEntries)
      .catch(() => addToast('Failed to load audit log.', 'error'))
      .finally(() => setLoading(false));
  }, [productId, actionType, fromDate, toDate, addToast]);

  useEffect(() => { load(); }, [load]);

  const hasFilters = productId || actionType || fromDate || toDate;

  const clearFilters = () => {
    setProductId('');
    setActionType('');
    setFromDate('');
    setToDate('');
  };

  return (
    <div className="p-6 max-w-7xl mx-auto">

      {/* ── Header ───────────────────────────────────────────────── */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900">Audit Log</h1>
        <p className="text-sm text-slate-400 mt-1">
          Read-only record of all inventory changes. Showing up to 500 entries — use filters to narrow results.
        </p>
      </div>

      {/* ── Filters ──────────────────────────────────────────────── */}
      <div className="flex flex-wrap gap-3 mb-6">
        <select
          value={productId}
          onChange={(e) => setProductId(e.target.value)}
          className={SELECT}
          aria-label="Filter by product"
        >
          <option value="">All Products</option>
          {products.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}{!p.is_active ? ' (inactive)' : ''}
            </option>
          ))}
        </select>

        <select
          value={actionType}
          onChange={(e) => setActionType(e.target.value)}
          className={SELECT}
          aria-label="Filter by action type"
        >
          <option value="">All Actions</option>
          {ACTION_TYPES.map((a) => (
            <option key={a} value={a}>{ACTION_LABELS[a]}</option>
          ))}
        </select>

        <div className="flex gap-2 items-center">
          <label className="text-sm text-slate-500 font-medium whitespace-nowrap">From</label>
          <input
            type="date"
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value)}
            className="h-12 px-3 border border-slate-300 rounded-lg text-base text-slate-900
                       focus:outline-none focus:ring-2 focus:ring-blue-600"
            aria-label="From date"
          />
        </div>
        <div className="flex gap-2 items-center">
          <label className="text-sm text-slate-500 font-medium whitespace-nowrap">To</label>
          <input
            type="date"
            value={toDate}
            onChange={(e) => setToDate(e.target.value)}
            className="h-12 px-3 border border-slate-300 rounded-lg text-base text-slate-900
                       focus:outline-none focus:ring-2 focus:ring-blue-600"
            aria-label="To date"
          />
        </div>

        {hasFilters && (
          <button
            onClick={clearFilters}
            className="h-12 px-4 text-sm font-medium text-slate-500 hover:text-slate-800
                       border border-slate-300 rounded-lg bg-white hover:bg-slate-50
                       focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 whitespace-nowrap"
          >
            Clear filters
          </button>
        )}
      </div>

      {/* ── Table ────────────────────────────────────────────────── */}
      {loading ? (
        <div className="flex items-center justify-center h-64">
          <Spinner size="lg" />
        </div>
      ) : entries.length === 0 ? (
        <p className="text-center text-slate-400 text-base py-20">
          {hasFilters ? 'No entries match your filters.' : 'No audit entries yet.'}
        </p>
      ) : (
        <>
          <div className="bg-white rounded-xl border border-slate-200 overflow-hidden overflow-x-auto">
            <table className="w-full text-sm min-w-[640px]">
              <thead>
                <tr className="bg-slate-50 text-slate-500 text-xs uppercase tracking-wider border-b border-slate-200">
                  <th className="text-left px-5 py-3 font-semibold whitespace-nowrap">Date / Time</th>
                  <th className="text-left px-5 py-3 font-semibold">Product</th>
                  <th className="text-left px-5 py-3 font-semibold">Action</th>
                  <th className="text-right px-5 py-3 font-semibold">Change</th>
                  <th className="text-left px-5 py-3 font-semibold hidden lg:table-cell">Prev → New</th>
                  <th className="text-left px-5 py-3 font-semibold hidden md:table-cell">Reason / Reference</th>
                  <th className="text-left px-5 py-3 font-semibold hidden xl:table-cell">By</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.id} className="border-t border-slate-100 hover:bg-slate-50">
                    <td className="px-5 py-3 text-slate-400 tabular-nums whitespace-nowrap">
                      {new Date(e.created_at).toLocaleDateString('en-PH', {
                        month: 'short', day: 'numeric', year: 'numeric',
                      })}
                      <span className="block text-xs">
                        {new Date(e.created_at).toLocaleTimeString('en-PH', {
                          hour: '2-digit', minute: '2-digit',
                        })}
                      </span>
                    </td>
                    <td className="px-5 py-3 font-medium text-slate-900">
                      {e.product_name}
                    </td>
                    <td className="px-5 py-3">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold border whitespace-nowrap
                        ${ACTION_COLORS[e.action_type] ?? 'bg-slate-100 text-slate-600 border-slate-200'}`}>
                        {ACTION_LABELS[e.action_type] ?? e.action_type}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-right tabular-nums font-bold">
                      {e.delta != null ? (
                        <span className={Number(e.delta) >= 0 ? 'text-green-700' : 'text-red-600'}>
                          {Number(e.delta) >= 0 ? '+' : ''}{e.delta}
                        </span>
                      ) : (
                        <span className="text-slate-300 font-normal">—</span>
                      )}
                    </td>
                    <td className="px-5 py-3 text-slate-500 tabular-nums hidden lg:table-cell whitespace-nowrap">
                      {e.previous_value != null && e.new_value != null
                        ? `${e.previous_value} → ${e.new_value}`
                        : '—'}
                    </td>
                    <td className="px-5 py-3 text-slate-500 hidden md:table-cell max-w-xs">
                      <span className="block truncate">
                        {e.reason ?? (
                          e.related_order_id
                            ? <Link
                                to={`/orders/${e.related_order_id}`}
                                className="text-blue-700 hover:underline"
                                onClick={(ev) => ev.stopPropagation()}
                              >
                                Order #{e.related_order_id}
                              </Link>
                            : e.related_delivery_id
                            ? `Delivery #${e.related_delivery_id}`
                            : '—'
                        )}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-slate-500 hidden xl:table-cell whitespace-nowrap">
                      {e.performed_by_name ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="text-xs text-slate-400 mt-3 text-right">
            {entries.length} {entries.length === 1 ? 'entry' : 'entries'} shown
            {entries.length === 500 && ' (limit reached — refine filters to see more)'}
          </p>
        </>
      )}
    </div>
  );
}
