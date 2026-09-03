import React, { useEffect, useState, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { StatusBadge } from '../components/ui/Badge';
import Spinner from '../components/ui/Spinner';
import OfflineBanner from '../components/ui/OfflineBanner';
import { orderRef } from '../utils/orderRef';
import { loadWithCache, DASHBOARD_CACHE } from '../offline/backOfficeCache.js';

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
  const navigate = useNavigate();
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');
  const [fromCache, setFromCache] = useState(false);
  const [cachedAt, setCachedAt]   = useState(null);

  // ADR 0015 §9 — the Dashboard reads from a quietly-kept local copy when the line is
  // down. It used to render the raw fetch failure ("Failed to fetch") as the whole
  // screen, which is both alarming and useless: the owner opening it during a blackout
  // wants last night's figures and a way through to the counter, not an error string.
  const load = useCallback(() => {
    setLoading(true);
    setError('');
    loadWithCache(DASHBOARD_CACHE, () => api.get('/dashboard'))
      .then(({ data: payload, fromCache: cached, cachedAt: at }) => {
        setData(payload);
        setFromCache(cached);
        setCachedAt(at);
      })
      .catch(() => setError('offline-no-cache'))
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

  // Nothing live and nothing held: a clean placeholder pointing at the one screen that
  // works with no connection at all, never the raw failure text.
  if (error || !data) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <h1 className="text-2xl font-bold text-slate-900 mb-6">Dashboard</h1>
        <OfflineBanner message="No connection, and this device has no dashboard figures saved yet.">
          <Link
            to="/orders"
            className="inline-flex items-center justify-center min-h-[48px] px-5 rounded-lg
                       bg-amber-600 text-white text-base font-semibold hover:bg-amber-700
                       focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-700"
          >
            Go to Outgoing Orders
          </Link>
        </OfflineBanner>
        <p className="text-base text-slate-600">
          Taking orders works with no internet. Figures here fill in the next time this
          tablet reaches the server.
        </p>
        <button onClick={load} className="mt-4 text-blue-700 underline text-base min-h-[48px]">
          Try again
        </button>
      </div>
    );
  }

  // Defensive: the cached copy is our own payload, but this screen exists to stop a
  // blackout ever producing a white screen, so a partial one degrades rather than throws.
  const summary = data.summary ?? {};
  const orders = data.orders ?? [];
  const low_stock = data.low_stock ?? [];

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <h1 className="text-2xl font-bold text-slate-900 mb-6">Dashboard</h1>

      {fromCache && (
        <OfflineBanner cachedAt={cachedAt}>
          <Link
            to="/orders"
            className="inline-flex items-center justify-center min-h-[48px] px-5 rounded-lg
                       bg-amber-600 text-white text-base font-semibold hover:bg-amber-700
                       focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-700"
          >
            Go to Outgoing Orders
          </Link>
        </OfflineBanner>
      )}

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
            <div className="overflow-x-auto" data-testid="dashboard-orders-list">
              {/* Phone-width cards (D5) — receipt, customer, status, total (the D5-specified
                  Orders field set), same rows/testids as the table below, hidden at lg */}
              <div className="lg:hidden divide-y divide-slate-300">
                {orders.map((order) => (
                  <div
                    key={order.id}
                    data-testid="dashboard-order-row"
                    onClick={() => navigate(`/orders/${order.id}`)}
                    className="p-4 active:bg-blue-50 cursor-pointer"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <Link
                          to={`/orders/${order.id}`}
                          className="font-mono text-sm text-slate-500
                                     focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 rounded"
                        >
                          {orderRef(order)}
                        </Link>
                        <p className="font-medium text-slate-900 mt-0.5 truncate">{order.customer_name}</p>
                      </div>
                      <p className="text-right font-semibold text-slate-900 tabular-nums shrink-0">
                        {PHP(order.total_amount)}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-1.5 items-center mt-2">
                      <StatusBadge status={order.status} />
                      {((order.status === 'pending' && order.pending_receipt_printed_at)
                        || (['completed', 'done'].includes(order.status) && order.delivered_receipt_printed_at)) && (
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-sm font-semibold border bg-slate-100 text-slate-600 border-slate-300">
                          🖶 Printed
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              <table className="hidden lg:table w-full text-base">
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
                    <tr
                      key={order.id}
                      data-testid="dashboard-order-row"
                      onClick={() => navigate(`/orders/${order.id}`)}
                      className="hover:bg-slate-50 transition-colors cursor-pointer"
                    >
                      <td className="px-5 py-4">
                        <Link
                          to={`/orders/${order.id}`}
                          className="font-mono text-sm text-slate-500
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
