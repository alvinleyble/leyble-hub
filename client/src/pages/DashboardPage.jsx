import React, { useEffect, useState, useCallback } from 'react';
import { useRefreshListener } from '../offline/refresh';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { StatusBadge, StockBadge, TagBadge } from '../components/ui/Badge';
import Page, { PAGE_PADDING } from '../components/ui/Page';
import PageHeader from '../components/ui/PageHeader';
import ListCard from '../components/ui/ListCard';
import NavIcon from '../components/layout/NavIcon';
import { PHP } from '../utils/money';
import { LOW_STOCK_THRESHOLD } from '../utils/statusBadges';
import { Skeleton, SkeletonGroup } from '../components/ui/Skeleton';
import OfflineBanner from '../components/ui/OfflineBanner';
import { orderRef } from '../utils/orderRef';
import { formatCardDateTime } from '../utils/dateFormat';
import { loadWithCache, readBackOfficeCache, DASHBOARD_CACHE } from '../offline/backOfficeCache.js';

// The four counts at the top. Shorter on phones (UI audit F18) so the orders below
// them start on the first screen; the tile colours follow the shared status colours
// (design standard Q5): In Transit amber, Pending blue, Delivered-awaiting-close green.
function SummaryCard({ label, value, colorClass = 'text-slate-900', bgClass = 'bg-white border-slate-200' }) {
  return (
    <div className={`rounded-xl border px-4 py-3 md:p-5 ${bgClass}`}>
      <p className="text-sm font-semibold text-slate-700 uppercase tracking-wide">{label}</p>
      <p className={`text-3xl md:text-4xl font-bold mt-1 md:mt-2 tabular-nums ${colorClass}`}>{value}</p>
    </div>
  );
}

const isPrinted = (order) => Boolean(
  (order.status === 'pending' && order.pending_receipt_printed_at)
  || (['completed', 'done'].includes(order.status) && order.delivered_receipt_printed_at)
);

// Mirrors the loaded layout's exact card/section heights (grid-cols-2 md:grid-cols-4
// summary cards, the Active Orders table, the Low Stock panel) so nothing shifts once
// real data replaces it.
function DashboardSkeleton() {
  return (
    <SkeletonGroup label="Loading dashboard" className={`${PAGE_PADDING} max-w-7xl mx-auto`}>
      <div className="h-8 w-40 mb-6">
        <Skeleton className="h-8 w-40" />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-4 mb-4 md:mb-8">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="rounded-xl border px-4 py-3 md:p-5 bg-white border-slate-200">
            <Skeleton className="h-3 w-20 mb-3" />
            <Skeleton className="h-9 w-16" />
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <section className="xl:col-span-2 bg-white rounded-xl border border-slate-200 overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4 border-b border-slate-400">
            <Skeleton className="h-5 w-32" />
            <Skeleton className="h-4 w-14" />
          </div>
          <div className="divide-y divide-slate-300">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="px-5 py-4 flex items-center justify-between gap-4">
                <div className="min-w-0 flex-1 space-y-2">
                  <Skeleton className="h-4 w-28" />
                  <Skeleton className="h-3 w-44" />
                </div>
                <Skeleton className="h-5 w-20 shrink-0" />
              </div>
            ))}
          </div>
        </section>

        <section className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-400">
            <Skeleton className="h-5 w-24 mb-2" />
            <Skeleton className="h-3 w-40" />
          </div>
          <div className="divide-y divide-slate-300">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="flex items-center justify-between gap-4 px-5 py-4 min-h-[48px]">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-4 w-12" />
              </div>
            ))}
          </div>
        </section>
      </div>
    </SkeletonGroup>
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
  const load = useCallback(({ silent = false } = {}) => {
    if (!silent) { setLoading(true); setError(''); }
    return loadWithCache(DASHBOARD_CACHE, () => api.get('/dashboard'))
      .then(({ data: payload, fromCache: cached, cachedAt: at }) => {
        setData(payload);
        setFromCache(cached);
        setCachedAt(at);
      })
      .catch(() => { if (!silent) setError('offline-no-cache'); })
      .finally(() => setLoading(false));
  }, []);

  // Local-first paint: a device holding a previously cached dashboard shows it
  // immediately (no skeleton) while the live fetch below quietly confirms or
  // refreshes it in the background. Only a device with nothing held yet falls
  // through to the cold-load skeleton.
  useEffect(() => {
    let cancelled = false;
    readBackOfficeCache(DASHBOARD_CACHE).then((held) => {
      if (cancelled) return;
      if (held) {
        setData(held.value);
        setFromCache(true);
        setCachedAt(held.cachedAt);
        setLoading(false);
        load({ silent: true });
      } else {
        load();
      }
    }).catch(() => { if (!cancelled) load(); });
    return () => { cancelled = true; };
  }, [load]);

  // Pull-down / re-tapping the menu item. Quiet, like the cache-first reload above:
  // the figures already on screen stay put until the fresh ones land.
  useRefreshListener(() => load({ silent: true }));

  if (loading) {
    return <DashboardSkeleton />;
  }

  // Nothing live and nothing held: a clean placeholder pointing at the one screen that
  // works with no connection at all, never the raw failure text.
  if (error || !data) {
    return (
      <Page wide={false}>
        <PageHeader title="Dashboard" />
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
      </Page>
    );
  }

  // Defensive: the cached copy is our own payload, but this screen exists to stop a
  // blackout ever producing a white screen, so a partial one degrades rather than throws.
  const summary = data.summary ?? {};
  const orders = data.orders ?? [];
  const low_stock = data.low_stock ?? [];

  return (
    <Page>
      <PageHeader title="Dashboard" />

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
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-4 mb-4 md:mb-8">
        <SummaryCard
          label="In Transit"
          value={summary.in_transit_count}
          bgClass="bg-amber-50 border-amber-200"
          colorClass="text-amber-900"
        />
        <SummaryCard
          label="Pending"
          value={summary.pending_count}
          bgClass="bg-blue-50 border-blue-200"
          colorClass="text-blue-800"
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

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4 md:gap-6">

        {/* ── Active orders ──────────────────────────────────────── */}
        <section className="xl:col-span-2 bg-white rounded-xl border border-slate-200 overflow-hidden">
          <div className="flex items-center justify-between gap-3 pl-4 md:pl-5 pr-2 py-2 border-b border-slate-300">
            <div className="min-w-0">
              <h2 className="text-lg font-bold text-slate-900">Active Orders</h2>
              {/* The server's order, kept on purpose: the work that needs doing first. */}
              <p className="text-sm text-slate-600">In transit first, then pending — oldest first</p>
            </div>
            <Link
              to="/orders"
              className="inline-flex items-center gap-1 min-h-[48px] px-3 rounded-lg text-blue-700 text-base font-semibold
                         hover:bg-blue-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 shrink-0"
            >
              View all
              <NavIcon name="chevronRight" className="w-5 h-5" />
            </Link>
          </div>

          {orders.length === 0 ? (
            <p className="px-5 py-12 text-center text-slate-500 text-base">
              No active orders at the moment
            </p>
          ) : (
            <div className="overflow-x-auto" data-testid="dashboard-orders-list">
              {/* Phone + upright-tablet cards (D5, Q1) in the shared card recipe (Q6).
                  The whole card is the tap target; the receipt number is no longer a
                  separate 25px link (UI audit F9). */}
              <div className="md:hidden divide-y divide-slate-300">
                {orders.map((order) => (
                  <ListCard
                    key={order.id}
                    data-testid="dashboard-order-row"
                    onClick={() => navigate(`/orders/${order.id}`)}
                    title={order.customer_name}
                    titleRight={PHP(order.total_amount)}
                    meta={<><span className="font-mono">{orderRef(order)}</span> · {formatCardDateTime(order.created_at)}</>}
                    metaRight={`Sold by: ${order.sold_by_name?.trim() || '—'}`}
                    badges={[
                      <StatusBadge key="status" status={order.status} />,
                      isPrinted(order) && <TagBadge key="printed" kind="printed" />,
                    ]}
                  />
                ))}
              </div>

              {/* No Personnel column any more: the V3.5 order form stopped assigning a
                  driver/helper, so it read "—" on every row (UI audit F18). */}
              <table className="hidden md:table w-full text-base">
                <thead>
                  <tr className="bg-slate-50 text-slate-600 text-sm uppercase tracking-wider">
                    <th className="text-left px-4 lg:px-5 py-3 font-semibold">Receipt</th>
                    <th className="text-left px-4 lg:px-5 py-3 font-semibold">Customer</th>
                    <th className="text-left px-4 lg:px-5 py-3 font-semibold">Status</th>
                    <th className="text-right px-4 lg:px-5 py-3 font-semibold">Total</th>
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
                      <td className="px-4 lg:px-5 py-4 font-mono text-sm text-slate-600 whitespace-nowrap">
                        {orderRef(order)}
                      </td>
                      <td className="px-4 lg:px-5 py-4 font-medium text-slate-900">{order.customer_name}</td>
                      <td className="px-4 lg:px-5 py-4">
                        <div className="flex flex-wrap gap-1.5 items-center">
                          <StatusBadge status={order.status} />
                          {isPrinted(order) && <TagBadge kind="printed" />}
                        </div>
                      </td>
                      <td className="px-4 lg:px-5 py-4 text-right font-semibold text-slate-900 tabular-nums whitespace-nowrap">
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
            <p className="text-sm text-slate-600 mt-0.5">Products at or below {LOW_STOCK_THRESHOLD} units</p>
          </div>

          {low_stock.length === 0 ? (
            <p className="px-5 py-12 text-center text-slate-500 text-base">
              All stock levels are healthy
            </p>
          ) : (
            <ul className="divide-y divide-slate-300">
              {low_stock.map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-4 px-4 md:px-5 py-3 min-h-[48px]">
                  <div className="min-w-0">
                    <p className="font-semibold text-slate-900 line-clamp-2 break-words">{p.name}</p>
                    {p.category && (
                      <p className="text-sm text-slate-600 mt-0.5">{p.category}</p>
                    )}
                  </div>
                  {/* The number and a worded badge — never colour alone (Q5). */}
                  <div className="shrink-0 flex flex-col items-end gap-1">
                    <span className="text-base font-bold tabular-nums text-slate-900 whitespace-nowrap">
                      {p.current_stock} {p.unit}
                    </span>
                    <StockBadge stock={p.current_stock} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

      </div>
    </Page>
  );
}
