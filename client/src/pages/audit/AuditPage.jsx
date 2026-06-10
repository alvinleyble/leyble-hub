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

const ENTITY_LABELS = {
  order:     'Order',
  customer:  'Customer',
  product:   'Product',
  personnel: 'Personnel',
  ticket:    'Ticket',
};

const ENTITY_TYPES = Object.keys(ENTITY_LABELS);

const ACTIVITY_ACTION_LABELS = {
  created:        'Created',
  edited:         'Edited',
  status_changed: 'Status Changed',
  adjusted:       'Adjusted',
  closed:         'Closed',
  resolved:       'Resolved',
  price_set:      'Price Set',
};

const ACTIVITY_ACTION_COLORS = {
  created:        'bg-green-100  text-green-800  border-green-300',
  edited:         'bg-amber-100  text-amber-800  border-amber-300',
  status_changed: 'bg-blue-100   text-blue-800   border-blue-300',
  adjusted:       'bg-purple-100 text-purple-800 border-purple-300',
  closed:         'bg-slate-100  text-slate-700  border-slate-300',
  resolved:       'bg-slate-100  text-slate-700  border-slate-300',
  price_set:      'bg-blue-100   text-blue-800   border-blue-300',
};

const SELECT = `h-12 px-4 border border-slate-300 rounded-lg text-base text-slate-900 bg-white
                focus:outline-none focus:ring-2 focus:ring-blue-600`;

const DATE_INPUT = `h-12 px-3 border border-slate-300 rounded-lg text-base text-slate-900
                    focus:outline-none focus:ring-2 focus:ring-blue-600`;

const TAB_BUTTON = (active) => `px-4 py-1.5 rounded-lg text-sm font-semibold border transition-colors
  ${active
    ? 'bg-slate-800 text-white border-slate-800'
    : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'}`;

// Renders an "Order #123" / "Customer: Name" style reference for an activity entry,
// linking through to the relevant detail page where one exists.
function EntityRef({ entry }) {
  const label = ENTITY_LABELS[entry.entity_type] ?? entry.entity_type;
  if (entry.entity_type === 'order' && entry.entity_id) {
    return (
      <Link
        to={`/orders/${entry.entity_id}`}
        className="text-blue-700 hover:underline font-medium"
        onClick={(ev) => ev.stopPropagation()}
      >
        Order #{entry.entity_id}
      </Link>
    );
  }
  return (
    <span className="font-medium text-slate-900">
      {label}{entry.entity_id ? ` #${entry.entity_id}` : ''}
    </span>
  );
}

export default function AuditPage() {
  const { addToast } = useToast();

  const [tab, setTab] = useState('inventory');

  // ── Inventory tab state ─────────────────────────────────────────────────
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

  useEffect(() => { if (tab === 'inventory') load(); }, [tab, load]);

  const hasFilters = productId || actionType || fromDate || toDate;

  const clearFilters = () => {
    setProductId('');
    setActionType('');
    setFromDate('');
    setToDate('');
  };

  // ── Activity tab state ──────────────────────────────────────────────────
  const [activityEntries, setActivityEntries]   = useState([]);
  const [activityLoading, setActivityLoading]   = useState(true);

  const [entityType, setEntityType]           = useState('');
  const [activityFromDate, setActivityFromDate] = useState('');
  const [activityToDate, setActivityToDate]     = useState('');

  const loadActivity = useCallback(() => {
    setActivityLoading(true);
    const params = new URLSearchParams();
    if (entityType)       params.set('entity_type', entityType);
    if (activityFromDate) params.set('from_date',   activityFromDate);
    if (activityToDate)   params.set('to_date',     activityToDate);
    params.set('limit', '500');
    const qs = params.toString();

    api.get(`/audit/activity?${qs}`)
      .then(setActivityEntries)
      .catch(() => addToast('Failed to load activity log.', 'error'))
      .finally(() => setActivityLoading(false));
  }, [entityType, activityFromDate, activityToDate, addToast]);

  useEffect(() => { if (tab === 'activity') loadActivity(); }, [tab, loadActivity]);

  const hasActivityFilters = entityType || activityFromDate || activityToDate;

  const clearActivityFilters = () => {
    setEntityType('');
    setActivityFromDate('');
    setActivityToDate('');
  };

  const formatDateTime = (value) => (
    <>
      {new Date(value).toLocaleDateString('en-PH', {
        month: 'short', day: 'numeric', year: 'numeric',
      })}
      <span className="block text-xs">
        {new Date(value).toLocaleTimeString('en-PH', {
          hour: '2-digit', minute: '2-digit',
        })}
      </span>
    </>
  );

  return (
    <div className="p-6 max-w-7xl mx-auto">

      {/* ── Header ───────────────────────────────────────────────── */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900">Audit Log</h1>
        <p className="text-sm text-slate-400 mt-1">
          Read-only record of everything that happens in the system — inventory and
          pricing history, plus orders, customers, products, personnel, and tickets.
        </p>
      </div>

      {/* ── Tab switcher ─────────────────────────────────────────── */}
      <div className="flex gap-1.5 mb-6">
        <button type="button" onClick={() => setTab('inventory')} className={TAB_BUTTON(tab === 'inventory')}>
          Inventory
        </button>
        <button type="button" onClick={() => setTab('activity')} className={TAB_BUTTON(tab === 'activity')}>
          Activity
        </button>
      </div>

      {tab === 'inventory' ? (
        <>
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
                  {p.sku || p.name}{!p.is_active ? ' (inactive)' : ''}
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
                className={DATE_INPUT}
                aria-label="From date"
              />
            </div>
            <div className="flex gap-2 items-center">
              <label className="text-sm text-slate-500 font-medium whitespace-nowrap">To</label>
              <input
                type="date"
                value={toDate}
                onChange={(e) => setToDate(e.target.value)}
                className={DATE_INPUT}
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
                    <tr className="bg-slate-50 text-slate-500 text-sm uppercase tracking-wider border-b border-slate-200">
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
                          {formatDateTime(e.created_at)}
                        </td>
                        <td className="px-5 py-3 font-medium text-slate-900">
                          {e.sku || e.product_name}
                        </td>
                        <td className="px-5 py-3">
                          <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-sm font-semibold border whitespace-nowrap
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
        </>
      ) : (
        <>
          {/* ── Activity filters ─────────────────────────────────────── */}
          <div className="flex flex-wrap gap-3 mb-6">
            <select
              value={entityType}
              onChange={(e) => setEntityType(e.target.value)}
              className={SELECT}
              aria-label="Filter by entity type"
            >
              <option value="">All Types</option>
              {ENTITY_TYPES.map((t) => (
                <option key={t} value={t}>{ENTITY_LABELS[t]}</option>
              ))}
            </select>

            <div className="flex gap-2 items-center">
              <label className="text-sm text-slate-500 font-medium whitespace-nowrap">From</label>
              <input
                type="date"
                value={activityFromDate}
                onChange={(e) => setActivityFromDate(e.target.value)}
                className={DATE_INPUT}
                aria-label="From date"
              />
            </div>
            <div className="flex gap-2 items-center">
              <label className="text-sm text-slate-500 font-medium whitespace-nowrap">To</label>
              <input
                type="date"
                value={activityToDate}
                onChange={(e) => setActivityToDate(e.target.value)}
                className={DATE_INPUT}
                aria-label="To date"
              />
            </div>

            {hasActivityFilters && (
              <button
                onClick={clearActivityFilters}
                className="h-12 px-4 text-sm font-medium text-slate-500 hover:text-slate-800
                           border border-slate-300 rounded-lg bg-white hover:bg-slate-50
                           focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 whitespace-nowrap"
              >
                Clear filters
              </button>
            )}
          </div>

          {/* ── Activity table ───────────────────────────────────────── */}
          {activityLoading ? (
            <div className="flex items-center justify-center h-64">
              <Spinner size="lg" />
            </div>
          ) : activityEntries.length === 0 ? (
            <p className="text-center text-slate-400 text-base py-20">
              {hasActivityFilters ? 'No entries match your filters.' : 'No activity recorded yet.'}
            </p>
          ) : (
            <>
              <div className="bg-white rounded-xl border border-slate-200 overflow-hidden overflow-x-auto">
                <table className="w-full text-sm min-w-[640px]">
                  <thead>
                    <tr className="bg-slate-50 text-slate-500 text-sm uppercase tracking-wider border-b border-slate-200">
                      <th className="text-left px-5 py-3 font-semibold whitespace-nowrap">Date / Time</th>
                      <th className="text-left px-5 py-3 font-semibold">Entity</th>
                      <th className="text-left px-5 py-3 font-semibold">Action</th>
                      <th className="text-left px-5 py-3 font-semibold">Summary</th>
                      <th className="text-left px-5 py-3 font-semibold hidden xl:table-cell">By</th>
                    </tr>
                  </thead>
                  <tbody>
                    {activityEntries.map((e) => (
                      <tr key={e.id} className="border-t border-slate-100 hover:bg-slate-50">
                        <td className="px-5 py-3 text-slate-400 tabular-nums whitespace-nowrap">
                          {formatDateTime(e.created_at)}
                        </td>
                        <td className="px-5 py-3 whitespace-nowrap">
                          <EntityRef entry={e} />
                        </td>
                        <td className="px-5 py-3">
                          <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-sm font-semibold border whitespace-nowrap
                            ${ACTIVITY_ACTION_COLORS[e.action] ?? 'bg-slate-100 text-slate-600 border-slate-200'}`}>
                            {ACTIVITY_ACTION_LABELS[e.action] ?? e.action}
                          </span>
                        </td>
                        <td className="px-5 py-3 text-slate-600 max-w-lg">
                          <span className="block">{e.summary}</span>
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
                {activityEntries.length} {activityEntries.length === 1 ? 'entry' : 'entries'} shown
                {activityEntries.length === 500 && ' (limit reached — refine filters to see more)'}
              </p>
            </>
          )}
        </>
      )}
    </div>
  );
}
