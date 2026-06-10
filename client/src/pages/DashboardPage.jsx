import React, { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { StatusBadge } from '../components/ui/Badge';
import Spinner from '../components/ui/Spinner';

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
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');

  const load = useCallback(() => {
    setLoading(true);
    api.get('/dashboard')
      .then(setData)
      .catch((err) => setError(err.message || 'Failed to load dashboard'))
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

  const { summary, orders, low_stock } = data;

  return (
    <div className="p-6 max-w-7xl mx-auto">
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
          <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200">
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
                    <th className="text-left px-5 py-3 font-semibold">Order #</th>
                    <th className="text-left px-5 py-3 font-semibold">Customer</th>
                    <th className="text-left px-5 py-3 font-semibold hidden lg:table-cell">Personnel</th>
                    <th className="text-left px-5 py-3 font-semibold">Status</th>
                    <th className="text-right px-5 py-3 font-semibold">Total</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {orders.map((order) => (
                    <tr key={order.id} className="hover:bg-slate-50 transition-colors">
                      <td className="px-5 py-4">
                        <Link
                          to={`/orders/${order.id}`}
                          className="font-mono font-semibold text-blue-700 hover:underline
                                     focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 rounded"
                        >
                          #{order.id}
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
          <div className="px-5 py-4 border-b border-slate-200">
            <h2 className="text-lg font-bold text-slate-900">Low Stock</h2>
            <p className="text-sm text-slate-400 mt-0.5">Products at or below 10 units</p>
          </div>

          {low_stock.length === 0 ? (
            <p className="px-5 py-12 text-center text-slate-400 text-base">
              All stock levels are healthy
            </p>
          ) : (
            <ul className="divide-y divide-slate-100">
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
