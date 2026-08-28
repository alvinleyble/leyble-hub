import React, { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { StatusBadge } from '../components/ui/Badge';
import Spinner from '../components/ui/Spinner';
import { orderRef } from '../utils/orderRef';

const PHP = (amount) =>
  `₱${Number(amount).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function SummaryCard({ label, value, colorClass = 'text-slate-900', bgClass = 'bg-white border-slate-200' }) {
  return (
    <div className={`rounded-xl border p-5 ${bgClass}`}>
      <p className="text-sm font-semibold text-slate-500 uppercase tracking-wide">{label}</p>
      <p className={`text-4xl font-bold mt-2 tabular-nums ${colorClass}`}>{value}</p>
    </div>
  );
}

export default function DashboardPage() {
  const [data, setData]             = useState(null);
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState('');
  const [isOfflineData, setIsOfflineData] = useState(false);
  const [isOfflineEmpty, setIsOfflineEmpty] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    setIsOfflineEmpty(false);

    api.get('/dashboard')
      .then((res) => {
        setData(res);
        setIsOfflineData(false);
        try {
          localStorage.setItem('cached_dashboard', JSON.stringify(res));
        } catch {}
      })
      .catch((err) => {
        // Try recovering cached dashboard data
        try {
          const raw = localStorage.getItem('cached_dashboard');
          if (raw) {
            setData(JSON.parse(raw));
            setIsOfflineData(true);
            return;
          }
        } catch {}

        const isNetwork = (typeof navigator !== 'undefined' && !navigator.onLine) ||
          /failed to fetch|network|load failed/i.test(err?.message || '');

        if (isNetwork) {
          setIsOfflineEmpty(true);
        } else {
          setError(err.message || 'Failed to load dashboard');
        }
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Spinner size="lg" />
      </div>
    );
  }

  if (isOfflineEmpty) {
    return (
      <div className="p-6 max-w-xl mx-auto mt-12 bg-white rounded-xl border border-slate-200 shadow-sm text-center">
        <div className="w-12 h-12 rounded-full bg-amber-100 text-amber-800 flex items-center justify-center mx-auto mb-4 text-2xl font-bold">
          📡
        </div>
        <h2 className="text-xl font-bold text-slate-900 mb-2">You are currently offline</h2>
        <p className="text-slate-600 mb-6 text-base leading-relaxed">
          Live dashboard metrics are paused while disconnected. Outgoing orders and sales remain fully available.
        </p>
        <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
          <Link
            to="/orders"
            className="w-full sm:w-auto px-5 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-semibold text-center focus:outline-none focus:ring-2 focus:ring-blue-500 shadow-sm"
          >
            Go to Outgoing Orders →
          </Link>
          <button
            onClick={load}
            className="w-full sm:w-auto px-4 py-2.5 rounded-lg border border-slate-300 hover:bg-slate-50 text-slate-700 font-semibold focus:outline-none focus:ring-2 focus:ring-blue-500 shadow-sm"
          >
            Retry Connection
          </button>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-8">
        <p className="text-red-700 text-base font-medium">{error}</p>
        <button onClick={load} className="mt-3 text-blue-700 underline text-base">
          Retry
        </button>
      </div>
    );
  }

  if (!data) return null;

  const { summary, orders, low_stock } = data;

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {isOfflineData && (
        <div className="mb-6 p-4 rounded-xl bg-amber-50 border border-amber-200 text-amber-900 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-lg">📡</span>
            <span className="text-sm font-medium">
              Showing cached dashboard data. Live statistics will refresh once reconnected.
            </span>
          </div>
          <button onClick={load} className="text-xs font-semibold underline hover:text-amber-950">
            Refresh
          </button>
        </div>
      )}

      <h1 className="text-2xl font-bold text-slate-900 mb-6">Dashboard</h1>

      {/* ── Summary cards ─────────────────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        <SummaryCard
          label="In Transit"
          value={summary.in_transit_count}
          bgClass="bg-blue-50 border-blue-200"
          colorClass="text-blue-800"
        />
        <SummaryCard
          label="Pending"
          value={summary.pending_count}
          bgClass="bg-amber-50 border-amber-200"
          colorClass="text-amber-800"
        />
        <SummaryCard
          label="Awaiting Close"
          value={summary.completed_count}
          bgClass="bg-green-50 border-green-200"
          colorClass="text-green-800"
        />
        <SummaryCard
          label="Open Tickets"
          value={summary.pending_tickets}
          bgClass={summary.pending_tickets > 0 ? 'bg-red-50 border-red-200' : 'bg-white border-slate-200'}
          colorClass={summary.pending_tickets > 0 ? 'text-red-700' : 'text-slate-900'}
        />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">

        {/* ── Active orders table ────────────────────────────────── */}
        <section className="xl:col-span-2 bg-white rounded-xl border border-slate-200 overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4 border-b border-slate-400">
            <h2 className="text-lg font-bold text-slate-900">Active Orders</h2>
            <Link
              to="/orders"
              className="text-blue-700 text-sm font-semibold hover:underline
                         focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 rounded"
            >
              View all
            </Link>
          </div>

          {orders.length === 0 ? (
            <p className="px-5 py-12 text-center text-slate-400 text-base">
              No active orders at the moment
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-base">
                <thead>
                  <tr className="bg-slate-50 text-slate-500 text-sm uppercase tracking-wider">
                    <th className="text-left px-5 py-3 font-semibold">Receipt</th>
                    <th className="text-left px-5 py-3 font-semibold">Customer</th>
                    <th className="text-left px-5 py-3 font-semibold hidden lg:table-cell">Personnel</th>
                    <th className="text-left px-5 py-3 font-semibold">Status</th>
                    <th className="text-right px-5 py-3 font-semibold">Total</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-300">
                  {orders.map((order) => (
                    <tr key={order.id} className="hover:bg-slate-50 transition-colors">
                      <td className="px-5 py-4">
                        <Link
                          to={`/orders/${order.id}`}
                          className="font-mono font-semibold text-blue-700 hover:underline
                                     focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 rounded"
                        >
                          {orderRef(order)}
                        </Link>
                      </td>
                      <td className="px-5 py-4 font-medium text-slate-900">{order.customer_name}</td>
                      <td className="px-5 py-4 text-slate-500 hidden lg:table-cell text-sm max-w-[180px]">
                        <span className="block truncate">{order.personnel_summary ?? '—'}</span>
                      </td>
                      <td className="px-5 py-4">
                        <div className="flex flex-wrap gap-1.5 items-center">
                          <StatusBadge status={order.status} />
                          {((order.status === 'pending' && order.pending_receipt_printed_at)
                            || (['completed', 'done'].includes(order.status) && order.delivered_receipt_printed_at)) && (
                            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-sm font-semibold border bg-slate-100 text-slate-600 border-slate-300">
                              🖶 Printed
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-5 py-4 text-right font-semibold text-slate-900 tabular-nums">
                        {PHP(order.total_amount)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* ── Low stock panel ────────────────────────────────────── */}
        <section className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-400">
            <h2 className="text-lg font-bold text-slate-900">Low Stock</h2>
            <p className="text-sm text-slate-400 mt-0.5">Products at or below 10 units</p>
          </div>

          {low_stock.length === 0 ? (
            <p className="px-5 py-12 text-center text-slate-400 text-base">
              All stock levels are healthy
            </p>
          ) : (
            <ul className="divide-y divide-slate-300">
              {low_stock.map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-4 px-5 py-4 min-h-[48px]">
                  <div className="min-w-0">
                    <p className="font-semibold text-slate-900 truncate">{p.name}</p>
                    {p.category && (
                      <p className="text-xs text-slate-400 mt-0.5">{p.category}</p>
                    )}
                  </div>
                  <span
                    className={`text-base font-bold tabular-nums shrink-0
                      ${p.current_stock === 0 ? 'text-red-600' : 'text-amber-600'}`}
                  >
                    {p.current_stock} {p.unit}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

      </div>
    </div>
  );
}
