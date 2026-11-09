import React, { useEffect, useState, useCallback } from 'react';
import { useRefreshListener } from '../offline/refresh';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { StockBadge } from '../components/ui/Badge';
import Page, { PAGE_PADDING, SECTION_GAP } from '../components/ui/Page';
import PageHeader from '../components/ui/PageHeader';
import { PHP } from '../utils/money';
import { LOW_STOCK_THRESHOLD } from '../utils/statusBadges';
import { Skeleton, SkeletonGroup } from '../components/ui/Skeleton';
import OfflineBanner from '../components/ui/OfflineBanner';
import { formatCardDateTime } from '../utils/dateFormat';
import {
  describeChange, formatDay, dayOfMonth, monthName, niceCeiling, formatCases, isSalesPayload, padToMonthEnd,
} from '../utils/salesDashboard';
import { loadWithCache, readBackOfficeCache, DASHBOARD_CACHE } from '../offline/backOfficeCache.js';

// The Dashboard is sales and products (captain's grill, 2026-11-09): three gross-sales
// totals, this month day by day, the month's best sellers and the slow movers. Every
// figure — and what counts as a sale — is computed on the server
// (server/src/lib/salesDashboard.js); this screen only lays them out.

const CARD = 'bg-white rounded-xl border border-slate-200 overflow-hidden';
const SECTION_HEAD = 'px-4 md:px-5 py-3 border-b border-slate-300';
const SLOW_PREVIEW = 10;

const TONE_CLASS = {
  up: 'text-green-700',
  down: 'text-red-700',
  flat: 'text-slate-700',
  none: 'text-slate-600',
};

// One gross-sales total with its change indicator. Direction is carried by the
// arrow AND the signed wording, never by colour alone.
function SalesTotal({ label, period, total, previousLabel, salesStart, testId }) {
  const change = describeChange(total?.comparison, previousLabel, salesStart);
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 md:p-5" data-testid={testId}>
      <p className="text-base font-semibold text-slate-700">{label}</p>
      <p className="text-sm text-slate-600">{period}</p>
      <p className="mt-1 text-3xl md:text-4xl font-bold text-slate-900 tabular-nums whitespace-nowrap">
        {PHP(total?.gross)}
      </p>
      <p className={`mt-1 text-base font-semibold tabular-nums ${TONE_CLASS[change.tone]}`}
         data-testid={`${testId}-change`}>
        {change.arrow && <span aria-hidden="true">{change.arrow} </span>}
        {change.tone === 'up' && <span className="sr-only">Up </span>}
        {change.tone === 'down' && <span className="sr-only">Down </span>}
        {change.text}
      </p>
      <p className="text-sm text-slate-600">{change.note}</p>
    </div>
  );
}

// This month, one bar per Manila day so far, on an axis spanning the whole month so
// the days still to come are empty slots. Thin bars on a recessive grid; tap or hover
// a bar to read its day above the chart, and the exact figures are always one tap away
// in the list underneath (the chart's table view).
function DailySalesChart({ daily }) {
  const [selected, setSelected] = useState(daily.length ? daily.length - 1 : -1);
  useEffect(() => { setSelected(daily.length ? daily.length - 1 : -1); }, [daily]);

  const top = niceCeiling(Math.max(0, ...daily.map((d) => d.gross)));
  const picked = daily[selected];
  const slots = padToMonthEnd(daily);
  const today = daily.length ? dayOfMonth(daily[daily.length - 1].date) : 0;
  // The 1st, every 5th and today — a 5th within two days of today gives way to it, so
  // labels never collide on a phone.
  const showTick = (ymd) => {
    const n = dayOfMonth(ymd);
    if (n === today || n === 1) return true;
    return n % 5 === 0 && Math.abs(n - today) > 2;
  };

  return (
    <div className="px-4 md:px-5 py-4">
      <p className="text-base text-slate-900 min-h-[24px]" aria-live="polite" data-testid="dashboard-daily-selected">
        {picked && (
          <>
            <span className="font-semibold">{formatDay(picked.date)}</span>
            {' · '}
            <span className="font-semibold tabular-nums whitespace-nowrap">{PHP(picked.gross)}</span>
          </>
        )}
      </p>

      <div className="relative mt-3">
        <p className="text-sm text-slate-600 tabular-nums">{PHP(top)}</p>
        <div className="relative h-44 md:h-56 border-b-2 border-slate-400">
          {/* Top and middle gridlines — recessive, behind the bars. */}
          <div aria-hidden="true" className="absolute inset-x-0 top-0 border-t border-slate-200" />
          <div aria-hidden="true" className="absolute inset-x-0 top-1/2 border-t border-slate-200" />
          <div className="absolute inset-0 flex items-end gap-[2px]" role="group" aria-label="Gross sales by day">
            {slots.map((d, i) => {
              if (d.future) return <div key={d.date} aria-hidden="true" className="flex-1 min-w-0" />;
              const pct = top > 0 ? (d.gross / top) * 100 : 0;
              const isSel = i === selected;
              return (
                <button
                  key={d.date}
                  type="button"
                  aria-label={`${formatDay(d.date)}: ${PHP(d.gross)}`}
                  aria-pressed={isSel}
                  onClick={() => setSelected(i)}
                  onMouseEnter={() => setSelected(i)}
                  onFocus={() => setSelected(i)}
                  data-testid="dashboard-daily-bar"
                  className="group relative flex-1 min-w-0 h-full flex items-end focus-visible:outline-none
                             focus-visible:ring-2 focus-visible:ring-blue-600 rounded-t"
                >
                  <span
                    aria-hidden="true"
                    className={`block w-full rounded-t ${isSel ? 'bg-blue-800' : 'bg-blue-500 group-hover:bg-blue-700'}`}
                    style={{ height: d.gross > 0 ? `max(${pct}%, 2px)` : 0 }}
                  />
                </button>
              );
            })}
          </div>
        </div>
        {/* Day numbers: the 1st, every 5th and today, so labels never collide on a phone. */}
        <div aria-hidden="true" className="flex gap-[2px] mt-1">
          {slots.map((d) => (
            <div key={d.date} className="relative flex-1 min-w-0 h-5">
              {showTick(d.date) && (
                <span className="absolute left-1/2 -translate-x-1/2 text-sm text-slate-600 tabular-nums">
                  {dayOfMonth(d.date)}
                </span>
              )}
            </div>
          ))}
        </div>
      </div>

      <details className="mt-3 group/list">
        <summary className="inline-flex items-center min-h-[48px] cursor-pointer text-base font-semibold text-blue-700
                            rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600">
          Show each day&rsquo;s total
        </summary>
        <ul className="divide-y divide-slate-200 border-t border-slate-200" data-testid="dashboard-daily-list">
          {[...daily].reverse().map((d) => (
            <li key={d.date} className="flex items-center justify-between gap-4 py-2">
              <span className="text-base text-slate-800">{formatDay(d.date)}</span>
              <span className="text-base font-semibold text-slate-900 tabular-nums whitespace-nowrap">{PHP(d.gross)}</span>
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}

function TopProducts({ rows }) {
  if (!rows.length) {
    return <p className="px-5 py-10 text-center text-slate-600 text-base">No sales yet this month</p>;
  }
  return (
    <ol className="divide-y divide-slate-300" data-testid="dashboard-top-products">
      {rows.map((p, i) => (
        <li key={p.product_id} data-testid="dashboard-top-product"
            className="flex items-start gap-3 px-4 md:px-5 py-3 min-h-[48px]">
          <span className="w-7 shrink-0 text-base font-bold text-slate-600 tabular-nums">{i + 1}.</span>
          <div className="min-w-0 flex-1">
            <p className="text-base font-semibold text-slate-900 break-words">{p.name}</p>
            <p className="text-sm text-slate-600 tabular-nums">{formatCases(p.cases)} sold</p>
          </div>
          <span className="shrink-0 text-base font-bold text-slate-900 tabular-nums whitespace-nowrap">{PHP(p.gross)}</span>
        </li>
      ))}
    </ol>
  );
}

function SlowMovers({ slow }) {
  const [showAll, setShowAll] = useState(false);
  const products = slow.products ?? [];
  const shown = showAll ? products : products.slice(0, SLOW_PREVIEW);
  if (!products.length) {
    return <p className="px-5 py-10 text-center text-slate-600 text-base">Every active product has sold in this window</p>;
  }
  return (
    <>
      <ul className="divide-y divide-slate-300" data-testid="dashboard-slow-movers">
        {shown.map((p) => (
          <li key={p.id} data-testid="dashboard-slow-mover" className="px-4 md:px-5 py-3 min-h-[48px]">
            <p className="text-base font-semibold text-slate-900 break-words">{p.name}</p>
            {p.category && <p className="text-sm text-slate-600">{p.category}</p>}
          </li>
        ))}
      </ul>
      {products.length > SLOW_PREVIEW && (
        <div className="border-t border-slate-300 px-4 md:px-5">
          <button
            type="button"
            onClick={() => setShowAll((v) => !v)}
            className="min-h-[48px] w-full text-left text-base font-semibold text-blue-700 rounded-lg
                       focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
          >
            {showAll ? 'Show fewer' : `Show all ${products.length}`}
          </button>
        </div>
      )}
    </>
  );
}

function slowMoversSubtitle(slow) {
  const range = `${formatDay(slow.from, { month: 'short', day: 'numeric' })} – ${formatDay(slow.to, { month: 'short', day: 'numeric' })}`;
  if (slow.clamped) {
    const days = `${slow.days} ${slow.days === 1 ? 'day' : 'days'}`;
    return `Active products with no sales ${range}. That is ${days}, not 14, because sales only count from ${formatDay(slow.from, { month: 'short', day: 'numeric' })}.`;
  }
  return `Active products with no sales in the last 14 days (${range})`;
}

// Mirrors the loaded layout's sections (three totals, the chart, the three lists) so
// nothing shifts once real data replaces it.
function DashboardSkeleton() {
  return (
    <SkeletonGroup label="Loading dashboard" className={`${PAGE_PADDING} max-w-7xl mx-auto`}>
      <div className={SECTION_GAP}>
        <Skeleton className="h-8 w-40" />
      </div>
      <div className={`grid grid-cols-1 sm:grid-cols-3 gap-3 md:gap-4 ${SECTION_GAP}`}>
        {[0, 1, 2].map((i) => (
          <div key={i} className="rounded-xl border px-4 py-3 md:p-5 bg-white border-slate-200">
            <Skeleton className="h-4 w-20 mb-2" />
            <Skeleton className="h-9 w-40 mb-2" />
            <Skeleton className="h-4 w-32" />
          </div>
        ))}
      </div>
      <section className={`${CARD} ${SECTION_GAP}`}>
        <div className={SECTION_HEAD}><Skeleton className="h-5 w-48" /></div>
        <div className="px-4 md:px-5 py-4"><Skeleton className="h-44 md:h-56 w-full" /></div>
      </section>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 md:gap-6">
        {[0, 1, 2].map((s) => (
          <section key={s} className={CARD}>
            <div className={SECTION_HEAD}><Skeleton className="h-5 w-32" /></div>
            <div className="divide-y divide-slate-300">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="flex items-center justify-between gap-4 px-5 py-4 min-h-[48px]">
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="h-4 w-16" />
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </SkeletonGroup>
  );
}

const offlineLink = (
  <Link
    to="/orders"
    className="inline-flex items-center justify-center min-h-[48px] px-5 rounded-lg
               bg-amber-600 text-white text-base font-semibold hover:bg-amber-700
               focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-700"
  >
    Go to Outgoing Orders
  </Link>
);

export default function DashboardPage() {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');
  const [fromCache, setFromCache] = useState(false);
  const [cachedAt, setCachedAt]   = useState(null);

  // ADR 0015 §9 — the Dashboard reads from a quietly-kept local copy when the line is
  // down, behind a banner naming when the copy was true, never the raw fetch failure.
  const load = useCallback(({ silent = false } = {}) => {
    if (!silent) { setLoading(true); setError(''); }
    return loadWithCache(DASHBOARD_CACHE, () => api.get('/dashboard'))
      .then(({ data: payload, fromCache: cached, cachedAt: at }) => {
        // A copy held from before the sales Dashboard cannot be drawn here.
        if (!isSalesPayload(payload)) throw new Error('no usable dashboard copy');
        setData(payload);
        setFromCache(cached);
        setCachedAt(at);
      })
      .catch(() => { if (!silent) setError('offline-no-cache'); })
      .finally(() => setLoading(false));
  }, []);

  // Local-first paint: a device holding a previously cached dashboard shows it
  // immediately (no skeleton) while the live fetch below quietly confirms or
  // refreshes it in the background.
  useEffect(() => {
    let cancelled = false;
    readBackOfficeCache(DASHBOARD_CACHE).then((held) => {
      if (cancelled) return;
      if (held && isSalesPayload(held.value)) {
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

  useRefreshListener(() => load({ silent: true }));

  if (loading) return <DashboardSkeleton />;

  if (error || !data) {
    return (
      <Page wide={false}>
        <PageHeader title="Dashboard" />
        <OfflineBanner message="No connection, and this device has no dashboard figures saved yet.">
          {offlineLink}
        </OfflineBanner>
        <p className="text-base text-slate-600">
          Taking orders works with no internet. Figures here fill in the next time this
          tablet reaches the server.
        </p>
        <button onClick={() => load()} className="mt-4 text-blue-700 underline text-base min-h-[48px]">
          Try again
        </button>
      </Page>
    );
  }

  const { totals, daily, top_products: top = [], slow_movers: slow, low_stock: lowStock = [] } = data;
  const salesStart = data.sales_start;
  const weekLabel = `Since ${formatDay(totals.week?.from)}`;

  return (
    <Page>
      <PageHeader title="Dashboard" subtitle={`Sales and products · as of ${formatCardDateTime(data.as_of)}`} />

      {fromCache && <OfflineBanner cachedAt={cachedAt}>{offlineLink}</OfflineBanner>}

      {/* ── Gross sales: today, this week, this month ─────────────── */}
      <div className={`grid grid-cols-1 sm:grid-cols-3 gap-3 md:gap-4 ${SECTION_GAP}`}>
        <SalesTotal label="Today" period={formatDay(totals.today?.from)} total={totals.today}
                    previousLabel="yesterday" salesStart={salesStart} testId="dashboard-total-today" />
        <SalesTotal label="This week" period={weekLabel} total={totals.week}
                    previousLabel="last week" salesStart={salesStart} testId="dashboard-total-week" />
        <SalesTotal label="This month" period={monthName(totals.month?.from)} total={totals.month}
                    previousLabel="last month" salesStart={salesStart} testId="dashboard-total-month" />
      </div>

      {/* ── This month, day by day ─────────────────────────────────── */}
      <section className={`${CARD} ${SECTION_GAP}`} data-testid="dashboard-daily">
        <div className={SECTION_HEAD}>
          <h2 className="text-lg font-bold text-slate-900">Gross sales by day</h2>
          <p className="text-sm text-slate-600">{monthName(totals.month?.from)}, Philippine time</p>
        </div>
        {daily.length ? <DailySalesChart daily={daily} /> : (
          <p className="px-5 py-10 text-center text-slate-600 text-base">No sales counted yet this month</p>
        )}
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 md:gap-6">
        <section className={CARD}>
          <div className={SECTION_HEAD}>
            <h2 className="text-lg font-bold text-slate-900">Top 10 products</h2>
            <p className="text-sm text-slate-600">This month, by gross sales</p>
          </div>
          <TopProducts rows={top} />
        </section>

        <section className={CARD}>
          <div className={SECTION_HEAD}>
            <h2 className="text-lg font-bold text-slate-900">
              Slow movers{slow?.products?.length ? ` (${slow.products.length})` : ''}
            </h2>
            {slow && <p className="text-sm text-slate-600" data-testid="dashboard-slow-window">{slowMoversSubtitle(slow)}</p>}
          </div>
          {slow && <SlowMovers slow={slow} />}
        </section>

        <section className={CARD}>
          <div className={SECTION_HEAD}>
            <h2 className="text-lg font-bold text-slate-900">Low Stock</h2>
            <p className="text-sm text-slate-600">Products at or below {LOW_STOCK_THRESHOLD} units</p>
          </div>
          {lowStock.length === 0 ? (
            <p className="px-5 py-10 text-center text-slate-600 text-base">All stock levels are healthy</p>
          ) : (
            <ul className="divide-y divide-slate-300">
              {lowStock.map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-4 px-4 md:px-5 py-3 min-h-[48px]">
                  <div className="min-w-0">
                    <p className="font-semibold text-slate-900 break-words">{p.name}</p>
                    {p.category && <p className="text-sm text-slate-600 mt-0.5">{p.category}</p>}
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
