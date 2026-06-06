import React, { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api/client';
import { useToast } from '../../components/ui/Toast';
import Button from '../../components/ui/Button';
import Spinner from '../../components/ui/Spinner';
import OrderCreateModal from './OrderCreateModal';

const PHP = (n) =>
  `₱${Number(n).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const STATUS_TABS = [
  { value: 'all',        label: 'All' },
  { value: 'pending',    label: 'Pending' },
  { value: 'in_transit', label: 'In Transit' },
  { value: 'completed',  label: 'Delivered' },
  { value: 'done',       label: 'Closed' },
  { value: 'cancelled',  label: 'Cancelled' },
];

const STATUS_BADGE = {
  pending:    'bg-blue-100 text-blue-800 border-blue-300',
  in_transit: 'bg-amber-100 text-amber-800 border-amber-300',
  completed:  'bg-green-100 text-green-800 border-green-300',
  done:       'bg-slate-100 text-slate-500 border-slate-200',
  cancelled:  'bg-red-100 text-red-700 border-red-300',
};

const STATUS_LABEL = {
  pending:    'Pending',
  in_transit: 'In Transit',
  completed:  'Delivered',
  done:       'Closed',
  cancelled:  'Cancelled',
};

export default function OrdersPage() {
  const navigate = useNavigate();
  const { addToast } = useToast();

  const [orders, setOrders]       = useState([]);
  const [loading, setLoading]     = useState(true);
  const [statusTab, setStatusTab] = useState('all');
  const [fromDate, setFromDate]   = useState('');
  const [toDate, setToDate]       = useState('');
  const [creating, setCreating]   = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    const params = new URLSearchParams();
    if (statusTab !== 'all') params.set('status', statusTab);
    if (fromDate) params.set('from_date', fromDate);
    if (toDate)   params.set('to_date',   toDate);

    api.get(`/orders?${params}`)
      .then(setOrders)
      .catch(() => addToast('Failed to load orders', 'error'))
      .finally(() => setLoading(false));
  }, [statusTab, fromDate, toDate, addToast]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
        <h1 className="text-2xl font-bold text-slate-900">Outgoing Orders</h1>
        <Button onClick={() => setCreating(true)}>+ New Order</Button>
      </div>

      {/* Status tabs */}
      <div className="flex flex-wrap gap-1.5 mb-4">
        {STATUS_TABS.map((tab) => (
          <button
            key={tab.value}
            onClick={() => setStatusTab(tab.value)}
            className={`px-4 py-2 rounded-lg text-sm font-semibold border transition-colors
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600
              ${statusTab === tab.value
                ? 'bg-blue-700 text-white border-blue-700'
                : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'}`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Date range filters */}
      <div className="flex flex-wrap gap-3 mb-6">
        <div className="flex gap-2 items-center">
          <label className="text-sm text-slate-500 font-medium whitespace-nowrap">From</label>
          <input
            type="date"
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value)}
            className="h-10 px-3 border border-slate-300 rounded-lg text-base text-slate-900
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
            className="h-10 px-3 border border-slate-300 rounded-lg text-base text-slate-900
                       focus:outline-none focus:ring-2 focus:ring-blue-600"
            aria-label="To date"
          />
        </div>
        {(fromDate || toDate) && (
          <button
            onClick={() => { setFromDate(''); setToDate(''); }}
            className="h-10 px-4 text-sm font-medium text-slate-500 hover:text-slate-800
                       border border-slate-300 rounded-lg bg-white hover:bg-slate-50
                       focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 whitespace-nowrap"
          >
            Clear dates
          </button>
        )}
      </div>

      {/* Table */}
      {loading ? (
        <div className="flex items-center justify-center h-64"><Spinner size="lg" /></div>
      ) : orders.length === 0 ? (
        <p className="text-center text-slate-400 text-base py-20">
          {statusTab === 'all' ? 'No orders yet.' : `No ${STATUS_LABEL[statusTab]?.toLowerCase()} orders.`}
        </p>
      ) : (
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          <table className="w-full text-base">
            <thead>
              <tr className="bg-slate-50 text-slate-500 text-xs uppercase tracking-wider border-b border-slate-200">
                <th className="text-left px-5 py-3 font-semibold w-16">#</th>
                <th className="text-left px-5 py-3 font-semibold">Customer</th>
                <th className="text-left px-5 py-3 font-semibold hidden lg:table-cell">Personnel</th>
                <th className="text-right px-5 py-3 font-semibold">Total</th>
                <th className="text-left px-5 py-3 font-semibold hidden md:table-cell">Date</th>
                <th className="text-left px-5 py-3 font-semibold">Status</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr
                  key={o.id}
                  onClick={() => navigate(`/orders/${o.id}`)}
                  className="border-t border-slate-100 hover:bg-blue-50 cursor-pointer transition-colors"
                >
                  <td className="px-5 py-4 font-mono text-slate-500 text-sm">#{o.id}</td>
                  <td className="px-5 py-4">
                    <p className="font-semibold text-slate-900">{o.customer_name}</p>
                  </td>
                  <td className="px-5 py-4 text-sm text-slate-500 hidden lg:table-cell max-w-[200px]">
                    <span className="block truncate">{o.personnel_summary ?? '—'}</span>
                  </td>
                  <td className="px-5 py-4 text-right font-bold text-slate-900 tabular-nums">
                    {PHP(o.total_amount)}
                  </td>
                  <td className="px-5 py-4 text-sm text-slate-500 hidden md:table-cell">
                    {new Date(o.created_at).toLocaleDateString('en-PH', {
                      month: 'short', day: 'numeric', year: 'numeric',
                    })}
                  </td>
                  <td className="px-5 py-4">
                    <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold border ${STATUS_BADGE[o.status] ?? 'bg-slate-100 text-slate-500 border-slate-200'}`}>
                      {STATUS_LABEL[o.status] ?? o.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {creating && (
        <OrderCreateModal
          onClose={() => setCreating(false)}
          onSaved={() => { setCreating(false); load(); }}
        />
      )}
    </div>
  );
}
