import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useRefreshListener } from '../offline/refresh';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { StockBadge } from '../components/ui/Badge';
import Page, { PAGE_PADDING, SECTION_GAP } from '../components/ui/Page';
import PageHeader from '../components/ui/PageHeader';
import { PHP } from '../utils/money';
import { LOW_STOCK_THRESHOLD, toneClass } from '../utils/statusBadges';
import { Skeleton, SkeletonGroup } from '../components/ui/Skeleton';
import OfflineBanner from '../components/ui/OfflineBanner';
import { formatCardDateTime } from '../utils/dateFormat';
import {
  describeVerdict, describeProgress, periodLabels, formatDay, formatAsOf, dayOfMonth, monthLabel,
  monthShort, monthKey, pagerBounds, niceCeiling, formatCases, isSalesPayload, normalizeDashboard,
  padToMonthEnd,
} from '../utils/salesDashboard';
import { loadWithCache, readBackOfficeCache, DASHBOARD_CACHE } from '../offline/backOfficeCache.js';

// The Dashboard is sales and products (captain's grill, 2026-11-09; comparisons and
// history reworked 2026-11-10). Three gross-sales totals, each split into the period
// still running and the last one finished; the month day by day, paged back to June
// 2026; the month-by-month trend; and the viewed month's best sellers and slow movers.
// Every figure — and what counts as a sale — is computed on the server
// (server/src/lib/salesDashboard.js); this screen only lays them out.
//
// Colour has one job each here: AMBER means still counting (never up or down), GREEN
// and RED are the verdict on a finished period. Direction is always also carried by
// an arrow, signed wording and screen-reader text.

const CARD = 'bg-white rounded-xl border border-slate-200 overflow-hidden';
const SECTION_HEAD = 'px-4 md:px-5 py-3 border-b border-slate-300';
const PILL = 'inline-flex items-center px-2.5 py-0.5 rounded-full text-sm font-semibold border';
const SLOW_PREVIEW = 10;
const SWIPE_MIN_PX = 60;

const TONE_CLASS = {
  up: 'text-green-700',
  down: 'text-red-700',
  flat: 'text-slate-700',
  none: 'text-slate-600',
};

function InProgressBadge({ asOf, testId }) {
  return (
    <span className={`${PILL} ${toneClass('amber')}`} data-testid={testId}>
      <span className="uppercase tracking-wide">In progress</span>
      {asOf && <span className="font-normal">&nbsp;· as of {asOf}</span>}
    </span>
  );
}

function FinishedBadge() {
  return <span className={`${PILL} ${toneClass('slate')} uppercase tracking-wide`}>Finished</span>;
}

// The up/down line for a finished period. Arrow + sr-only word + signed figure.
function Verdict({ change, testId }) {
  return (
    <>
      <p className={`text-base font-semibold tabular-nums ${TONE_CLASS[change.tone]}`} data-testid={testId}>
        {change.arrow && <span aria-hidden="true">{change.arrow} </span>}
        {change.tone === 'up' && <span className="sr-only">Up </span>}
        {change.tone === 'down' && <span className="sr-only">Down </span>}
        {change.text}
      </p>
      <p className="text-sm text-slate-600">{change.note}</p>
    </>
  );
}

// How far a running period has got, against the whole previous one. Amber, never
// green or red: it is not finished, so it is neither up nor down yet.
function Progress({ progress, testId }) {
  if (progress.state !== 'progress') {
    return (
      <div className="mt-2" data-testid={testId}>
        <p className="text-base font-semibold text-slate-700">{progress.text}</p>
        {progress.note && <p className="text-sm text-slate-600">{progress.note}</p>}
      </div>
    );
  }
  return (
    <div className="mt-2" data-testid={testId}>
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(progress.bar)}
        aria-valuetext={progress.text}
        className="h-3 rounded-full bg-slate-200 overflow-hidden"
      >
        <div className="h-full rounded-full bg-amber-600" style={{ width: `${progress.bar}%` }} />
      </div>
      <p className="mt-1 text-base font-semibold text-amber-800 tabular-nums">{progress.text}</p>
    </div>
  );
}

// One total: the period still running on top, the last finished one underneath.
function SalesTotal({ periodKey, total, salesStart, asOf, testId }) {
  const l = periodLabels(periodKey, total);
  const previous = total?.previous;
  const progress = describeProgress(previous, l.of, salesStart);
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 md:p-5
                    sm:grid sm:grid-cols-2 sm:gap-6 lg:block" data-testid={testId}>
      <div data-testid={`${testId}-current`}>
        <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
          <div>
            <p className="text-base font-semibold text-slate-700">{l.label}</p>
            <p className="text-sm text-slate-600">{l.period}</p>
          </div>
          <InProgressBadge asOf={asOf} testId={`${testId}-status`} />
        </div>
        <p className="mt-1 text-3xl md:text-4xl font-bold text-slate-900 tabular-nums whitespace-nowrap">
          {PHP(total?.gross)}
        </p>
        <Progress progress={progress} testId={`${testId}-progress`} />
      </div>

      {previous?.available && (
        <div className="mt-3 pt-3 border-t border-slate-200
                        sm:mt-0 sm:pt-0 sm:border-t-0 sm:border-l sm:pl-6
                        lg:mt-3 lg:pt-3 lg:border-t lg:border-l-0 lg:pl-0"
             data-testid={`${testId}-finished`}>
          <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
            <div>
              <p className="text-base font-semibold text-slate-700">{l.finished}</p>
              <p className="text-sm text-slate-600">{l.finishedPeriod}</p>
            </div>
            <FinishedBadge />
          </div>
          <p className="mt-1 text-2xl font-bold text-slate-900 tabular-nums whitespace-nowrap">{PHP(previous.gross)}</p>
          <Verdict change={describeVerdict(previous.verdict, l.comparator, salesStart)} testId={`${testId}-change`} />
        </div>
      )}
    </div>
  );
}

// ‹ November 2026 › — bounded to the first counted month and this one.
function MonthPager({ viewed, first, last, onChange }) {
  const { prev, next } = pagerBounds(viewed, first, last);
  const arrow = `inline-flex items-center justify-center w-12 h-12 shrink-0 rounded-lg text-2xl font-bold
                 text-blue-700 hover:bg-blue-50 disabled:text-slate-300 disabled:hover:bg-transparent
                 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600`;
  return (
    <div className="flex items-center justify-between gap-2">
      <button type="button" className={arrow} disabled={!prev} onClick={() => prev && onChange(prev)}
              aria-label={prev ? `Previous month, ${monthLabel(prev)}` : 'Previous month'}
              data-testid="dashboard-month-prev">
        <span aria-hidden="true">‹</span>
      </button>
      <p className="text-lg font-bold text-slate-900 text-center" aria-live="polite" data-testid="dashboard-month-label">
        {monthLabel(viewed)}
      </p>
      <button type="button" className={arrow} disabled={!next} onClick={() => next && onChange(next)}
              aria-label={next ? `Next month, ${monthLabel(next)}` : 'Next month'}
              data-testid="dashboard-month-next">
        <span aria-hidden="true">›</span>
      </button>
    </div>
  );
}

// The viewed month's own total: in progress against all of last month, or finished
// with its verdict against the month before.
function MonthSummary({ month, salesStart, asOf }) {
  if (!month) return null;
  if (month.in_progress) {
    const of = month.previous?.month ? formatDay(`${month.previous.month}-01`, { month: 'long' }) : 'last month';
    return (
      <div className="mt-2" data-testid="dashboard-month-summary">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <InProgressBadge asOf={asOf} />
          <span className="text-base font-bold text-slate-900 tabular-nums whitespace-nowrap">{PHP(month.gross)} so far</span>
        </div>
        <Progress progress={describeProgress(month.previous, of, salesStart)} testId="dashboard-month-progress" />
      </div>
    );
  }
  const comparator = month.verdict?.month ? monthLabel(month.verdict.month) : '';
  return (
    <div className="mt-2" data-testid="dashboard-month-summary">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <FinishedBadge />
        <span className="text-base font-bold text-slate-900 tabular-nums whitespace-nowrap">{PHP(month.gross)}</span>
      </div>
      <Verdict change={describeVerdict(month.verdict, comparator, salesStart)} testId="dashboard-month-change" />
    </div>
  );
}

// One month, one bar per Manila day, on an axis spanning the whole month so the days
// still to come are empty slots. Today's bar is amber: it is still counting. Tap or
// hover a bar to read its day above the chart; the exact figures are always one tap
// away in the list underneath (the chart's table view).
function DailySalesChart({ daily, today }) {
  const [selected, setSelected] = useState(daily.length ? daily.length - 1 : -1);
  useEffect(() => { setSelected(daily.length ? daily.length - 1 : -1); }, [daily]);

  const top = niceCeiling(Math.max(0, ...daily.map((d) => d.gross)));
  const picked = daily[selected];
  const slots = padToMonthEnd(daily);
  const last = daily.length ? dayOfMonth(daily[daily.length - 1].date) : 0;
  const hasToday = daily.some((d) => d.date === today);
  // The 1st, every 5th and the last day shown — a 5th within two days of it gives way,
  // so labels never collide on a phone.
  const showTick = (ymd) => {
    const n = dayOfMonth(ymd);
    if (n === last || n === 1) return true;
    return n % 5 === 0 && Math.abs(n - last) > 2;
  };

  return (
    <div className="px-4 md:px-5 py-4">
      <p className="text-base text-slate-900 min-h-[24px]" aria-live="polite" data-testid="dashboard-daily-selected">
        {picked && (
          <>
            <span className="font-semibold">{formatDay(picked.date)}</span>
            {' · '}
            <span className="font-semibold tabular-nums whitespace-nowrap">{PHP(picked.gross)}</span>
            {picked.date === today && <span className="font-semibold text-amber-800"> · still counting</span>}
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
              const isToday = d.date === today;
              const fill = isToday
                ? (isSel ? 'bg-amber-700' : 'bg-amber-600 group-hover:bg-amber-700')
                : (isSel ? 'bg-blue-800' : 'bg-blue-500 group-hover:bg-blue-700');
              return (
                <button
                  key={d.date}
                  type="button"
                  aria-label={`${formatDay(d.date)}: ${PHP(d.gross)}${isToday ? ', still counting' : ''}`}
                  aria-pressed={isSel}
                  onClick={() => setSelected(i)}
                  onMouseEnter={() => setSelected(i)}
                  onFocus={() => setSelected(i)}
                  data-testid="dashboard-daily-bar"
                  data-today={isToday ? 'true' : undefined}
                  className="group relative flex-1 min-w-0 h-full flex items-end focus-visible:outline-none
                             focus-visible:ring-2 focus-visible:ring-blue-600 rounded-t"
                >
                  <span
                    aria-hidden="true"
                    className={`block w-full rounded-t ${fill}`}
                    style={{ height: d.gross > 0 ? `max(${pct}%, 2px)` : 0 }}
                  />
                </button>
              );
            })}
          </div>
        </div>
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

      {hasToday && (
        <p className="mt-2 flex items-center gap-2 text-sm text-slate-700">
          <span aria-hidden="true" className="inline-block w-3 h-3 rounded-sm bg-amber-600" />
          Today, still counting
        </p>
      )}

      <details className="mt-3 group/list">
        <summary className="inline-flex items-center min-h-[48px] cursor-pointer text-base font-semibold text-blue-700
                            rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600">
          Show each day&rsquo;s total
        </summary>
        <ul className="divide-y divide-slate-200 border-t border-slate-200" data-testid="dashboard-daily-list">
          {[...daily].reverse().map((d) => (
            <li key={d.date} className="flex items-center justify-between gap-4 py-2">
              <span className="text-base text-slate-800">
                {formatDay(d.date)}
                {d.date === today && <span className="text-amber-800 font-semibold"> · still counting</span>}
              </span>
              <span className="text-base font-semibold text-slate-900 tabular-nums whitespace-nowrap">{PHP(d.gross)}</span>
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}

// One bar per month since sales were first counted; the current month is amber. It
// scrolls sideways once the months outgrow the screen, starting at the newest. Tap a
// month to open it in the day-by-day chart above.
function MonthlySalesChart({ monthly, viewed, onPick }) {
  const scroller = useRef(null);
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [monthly.length]);

  const top = niceCeiling(Math.max(0, ...monthly.map((m) => m.gross)));
  const picked = monthly.find((m) => m.month === viewed) ?? monthly[monthly.length - 1];

  return (
    <div className="px-4 md:px-5 py-4">
      <p className="text-base text-slate-900 min-h-[24px]" aria-live="polite" data-testid="dashboard-monthly-selected">
        {picked && (
          <>
            <span className="font-semibold">{monthLabel(picked.month)}</span>
            {' · '}
            <span className="font-semibold tabular-nums whitespace-nowrap">{PHP(picked.gross)}</span>
            {picked.in_progress && <span className="font-semibold text-amber-800"> · still counting</span>}
          </>
        )}
      </p>
      <p className="mt-3 text-sm text-slate-600 tabular-nums">{PHP(top)}</p>
      <div ref={scroller} className="overflow-x-auto" data-testid="dashboard-monthly-scroll">
        <div className="min-w-full w-max">
          <div className="relative h-44 md:h-56 border-b-2 border-slate-400">
            <div aria-hidden="true" className="absolute inset-x-0 top-0 border-t border-slate-200" />
            <div aria-hidden="true" className="absolute inset-x-0 top-1/2 border-t border-slate-200" />
            <div className="relative h-full flex items-end gap-2" role="group" aria-label="Gross sales by month">
              {monthly.map((m) => {
                const pct = top > 0 ? (m.gross / top) * 100 : 0;
                const isSel = picked && m.month === picked.month;
                const fill = m.in_progress
                  ? (isSel ? 'bg-amber-700' : 'bg-amber-600 group-hover:bg-amber-700')
                  : (isSel ? 'bg-blue-800' : 'bg-blue-500 group-hover:bg-blue-700');
                return (
                  <button
                    key={m.month}
                    type="button"
                    aria-label={`${monthLabel(m.month)}: ${PHP(m.gross)}${m.in_progress ? ', still counting' : ''}`}
                    aria-pressed={Boolean(isSel)}
                    onClick={() => onPick(m.month)}
                    data-testid="dashboard-monthly-bar"
                    data-in-progress={m.in_progress ? 'true' : undefined}
                    className="group relative flex-1 min-w-[48px] h-full flex items-end rounded-t
                               focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
                  >
                    <span aria-hidden="true" className={`block w-full rounded-t ${fill}`}
                          style={{ height: m.gross > 0 ? `max(${pct}%, 2px)` : 0 }} />
                  </button>
                );
              })}
            </div>
          </div>
          <div aria-hidden="true" className="flex gap-2 mt-1">
            {monthly.map((m, i) => (
              <div key={m.month} className="flex-1 min-w-[48px] text-center text-sm text-slate-600 leading-tight">
                {monthShort(m.month)}
                {(i === 0 || m.month.endsWith('-01')) && <span className="block">{m.month.slice(0, 4)}</span>}
              </div>
            ))}
          </div>
        </div>
      </div>
      <p className="mt-2 flex items-center gap-2 text-sm text-slate-700">
        <span aria-hidden="true" className="inline-block w-3 h-3 rounded-sm bg-amber-600" />
        This month, still counting
      </p>
      <details className="mt-1">
        <summary className="inline-flex items-center min-h-[48px] cursor-pointer text-base font-semibold text-blue-700
                            rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600">
          Show each month&rsquo;s total
        </summary>
        <ul className="divide-y divide-slate-200 border-t border-slate-200" data-testid="dashboard-monthly-list">
          {[...monthly].reverse().map((m) => (
            <li key={m.month} className="flex items-center justify-between gap-4 py-2">
              <span className="text-base text-slate-800">
                {monthLabel(m.month)}
                {m.in_progress && <span className="text-amber-800 font-semibold"> · still counting</span>}
              </span>
              <span className="text-base font-semibold text-slate-900 tabular-nums whitespace-nowrap">{PHP(m.gross)}</span>
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}

function TopProducts({ rows, emptyText }) {
  if (!rows.length) {
    return <p className="px-5 py-10 text-center text-slate-600 text-base">{emptyText}</p>;
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

function slowMoversSubtitle(slow, pastMonth) {
  const range = `${formatDay(slow.from, { month: 'short', day: 'numeric' })} – ${formatDay(slow.to, { month: 'short', day: 'numeric' })}`;
  if (slow.clamped) {
    const days = `${slow.days} ${slow.days === 1 ? 'day' : 'days'}`;
    return `Active products with no sales ${range}. That is ${days}, not 14, because sales only count from ${formatDay(slow.from, { month: 'short', day: 'numeric' })}.`;
  }
  if (pastMonth) return `Active products with no sales in the last 14 days of ${monthLabel(pastMonth)} (${range})`;
  return `Active products with no sales in the last 14 days (${range})`;
}

// Mirrors the loaded layout's sections (three totals, the two charts, the three
// lists) so nothing shifts once real data replaces it.
function DashboardSkeleton() {
  return (
    <SkeletonGroup label="Loading dashboard" className={`${PAGE_PADDING} max-w-7xl mx-auto`}>
      <div className={SECTION_GAP}>
        <Skeleton className="h-8 w-40" />
      </div>
      <div className={`grid grid-cols-1 lg:grid-cols-3 gap-3 md:gap-4 ${SECTION_GAP}`}>
        {[0, 1, 2].map((i) => (
          <div key={i} className="rounded-xl border px-4 py-3 md:p-5 bg-white border-slate-200">
            <Skeleton className="h-4 w-20 mb-2" />
            <Skeleton className="h-9 w-40 mb-2" />
            <Skeleton className="h-3 w-full mb-2" />
            <Skeleton className="h-4 w-32" />
          </div>
        ))}
      </div>
      {[0, 1].map((s) => (
        <section key={s} className={`${CARD} ${SECTION_GAP}`}>
          <div className={SECTION_HEAD}><Skeleton className="h-5 w-48" /></div>
          <div className="px-4 md:px-5 py-4"><Skeleton className="h-44 md:h-56 w-full" /></div>
        </section>
      ))}
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

// Swipe left for the next month, right for the previous — a mostly-sideways drag only,
// so scrolling the page up and down never flips the month.
function useSwipe(onLeft, onRight) {
  const start = useRef(null);
  return {
    onTouchStart: (e) => {
      const t = e.touches?.[0];
      start.current = t ? { x: t.clientX, y: t.clientY } : null;
    },
    onTouchEnd: (e) => {
      const s = start.current;
      const t = e.changedTouches?.[0];
      start.current = null;
      if (!s || !t) return;
      const dx = t.clientX - s.x;
      const dy = t.clientY - s.y;
      if (Math.abs(dx) < SWIPE_MIN_PX || Math.abs(dx) < Math.abs(dy) * 1.5) return;
      if (dx < 0) onLeft(); else onRight();
    },
  };
}

export default function DashboardPage() {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');
  const [fromCache, setFromCache] = useState(false);
  const [cachedAt, setCachedAt]   = useState(null);
  // A month other than the current one, and what the server said about it. Only the
  // current month is held on the device; a past month is read live each time.
  const [viewed, setViewed] = useState(null);
  const [past, setPast] = useState({ month: null, data: null, loading: false, error: false });
  const pastReq = useRef(0);

  // ADR 0015 §9 — the Dashboard reads from a quietly-kept local copy when the line is
  // down, behind a banner naming when the copy was true, never the raw fetch failure.
  const load = useCallback(({ silent = false } = {}) => {
    if (!silent) { setLoading(true); setError(''); }
    return loadWithCache(DASHBOARD_CACHE, () => api.get('/dashboard'))
      .then(({ data: payload, fromCache: cached, cachedAt: at }) => {
        // A copy held from before the sales Dashboard cannot be drawn here.
        if (!isSalesPayload(payload)) throw new Error('no usable dashboard copy');
        setData(normalizeDashboard(payload));
        setFromCache(cached);
        setCachedAt(at);
      })
      .catch(() => { if (!silent) setError('offline-no-cache'); })
      .finally(() => setLoading(false));
  }, []);

  const loadPast = useCallback((month, { silent = false } = {}) => {
    const req = ++pastReq.current;
    if (!silent) setPast({ month, data: null, loading: true, error: false });
    // Never cached: the held copy is the current month's, and only that.
    return api.get(`/dashboard?month=${encodeURIComponent(month)}`)
      .then((payload) => {
        if (req !== pastReq.current) return;
        if (!isSalesPayload(payload)) throw new Error('unexpected dashboard shape');
        setPast({ month, data: normalizeDashboard(payload), loading: false, error: false });
      })
      .catch(() => {
        if (req !== pastReq.current || silent) return;
        setPast({ month, data: null, loading: false, error: true });
      });
  }, []);

  // Local-first paint: a device holding a previously cached dashboard shows it
  // immediately (no skeleton) while the live fetch below quietly confirms or
  // refreshes it in the background.
  useEffect(() => {
    let cancelled = false;
    readBackOfficeCache(DASHBOARD_CACHE).then((held) => {
      if (cancelled) return;
      if (held && isSalesPayload(held.value)) {
        setData(normalizeDashboard(held.value));
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

  const current = data ? data.selected_month.month : null;
  const first = data ? monthKey(data.sales_start) : null;
  const shown = viewed && viewed !== current ? viewed : current;

  const goTo = useCallback((month) => {
    if (!month || month === shown) return;
    if (month === current) {
      pastReq.current += 1;
      setViewed(null);
      setPast({ month: null, data: null, loading: false, error: false });
      return;
    }
    setViewed(month);
    loadPast(month);
  }, [shown, current, loadPast]);

  useRefreshListener(() => {
    load({ silent: true });
    if (viewed && viewed !== current) loadPast(viewed, { silent: true });
  });

  const bounds = shown && first ? pagerBounds(shown, first, current) : { prev: null, next: null };
  const swipe = useSwipe(() => goTo(bounds.next), () => goTo(bounds.prev));

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

  const { totals, monthly, low_stock: lowStock } = data;
  const salesStart = data.sales_start;
  const asOf = formatAsOf(data.as_of);
  const isPast = shown !== current;
  // What the month-specific sections draw: this month from the main payload, a past
  // month from its own live read once it has landed.
  const view = isPast ? (past.month === shown ? past.data : null) : data;
  const monthWaiting = isPast && !view && !past.error;
  const monthFailed = isPast && !view && past.error;

  return (
    <Page>
      <PageHeader title="Dashboard" subtitle={`Sales and products · as of ${formatCardDateTime(data.as_of)}`} />

      {fromCache && <OfflineBanner cachedAt={cachedAt}>{offlineLink}</OfflineBanner>}

      {/* ── Gross sales: today, this week, this month ─────────────── */}
      <div className={`grid grid-cols-1 lg:grid-cols-3 gap-3 md:gap-4 ${SECTION_GAP}`}>
        <SalesTotal periodKey="today" total={totals.today} salesStart={salesStart} asOf={asOf}
                    testId="dashboard-total-today" />
        <SalesTotal periodKey="week" total={totals.week} salesStart={salesStart} asOf={asOf}
                    testId="dashboard-total-week" />
        <SalesTotal periodKey="month" total={totals.month} salesStart={salesStart} asOf={asOf}
                    testId="dashboard-total-month" />
      </div>

      {/* ── One month, day by day, paged back to the first counted month ── */}
      <section className={`${CARD} ${SECTION_GAP}`} data-testid="dashboard-daily" {...swipe}>
        <div className={SECTION_HEAD}>
          <h2 className="text-lg font-bold text-slate-900">Gross sales by day</h2>
          <p className="text-sm text-slate-600">Philippine time. Swipe or use the arrows for another month.</p>
          <MonthPager viewed={shown} first={first} last={current} onChange={goTo} />
          {view && <MonthSummary month={view.selected_month} salesStart={salesStart} asOf={asOf} />}
        </div>
        {monthWaiting && (
          <div className="px-4 md:px-5 py-4" role="status" aria-label={`Loading ${monthLabel(shown)}`}>
            <Skeleton className="h-44 md:h-56 w-full" />
          </div>
        )}
        {monthFailed && (
          <div className="px-5 py-8 text-center" data-testid="dashboard-month-error">
            <p className="text-base text-slate-700">
              {monthLabel(shown)} needs a connection. This device keeps only this month&rsquo;s figures.
            </p>
            <button type="button" onClick={() => loadPast(shown)}
                    className="mt-2 min-h-[48px] px-4 text-base font-semibold text-blue-700 underline rounded-lg
                               focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600">
              Try again
            </button>
          </div>
        )}
        {view && (view.daily.length ? <DailySalesChart daily={view.daily} today={isPast ? null : data.today} /> : (
          <p className="px-5 py-10 text-center text-slate-600 text-base">No sales counted yet this month</p>
        ))}
      </section>

      {/* ── Every month since sales were first counted ─────────────── */}
      {monthly.length > 0 && (
        <section className={`${CARD} ${SECTION_GAP}`} data-testid="dashboard-monthly">
          <div className={SECTION_HEAD}>
            <h2 className="text-lg font-bold text-slate-900">Gross sales by month</h2>
            <p className="text-sm text-slate-600">
              Since {monthLabel(monthly[0].month)}, Philippine time. Tap a month to see its days.
            </p>
          </div>
          <MonthlySalesChart monthly={monthly} viewed={shown} onPick={goTo} />
        </section>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 md:gap-6">
        <section className={CARD}>
          <div className={SECTION_HEAD}>
            <h2 className="text-lg font-bold text-slate-900">Top 10 products</h2>
            <p className="text-sm text-slate-600">{monthLabel(shown)}, by gross sales</p>
          </div>
          {view
            ? <TopProducts rows={view.top_products}
                           emptyText={isPast ? `No sales in ${monthLabel(shown)}` : 'No sales yet this month'} />
            : <ListPlaceholder failed={monthFailed} />}
        </section>

        <section className={CARD}>
          <div className={SECTION_HEAD}>
            <h2 className="text-lg font-bold text-slate-900">
              Slow movers{view?.slow_movers?.products?.length ? ` (${view.slow_movers.products.length})` : ''}
            </h2>
            {view?.slow_movers && (
              <p className="text-sm text-slate-600" data-testid="dashboard-slow-window">
                {slowMoversSubtitle(view.slow_movers, isPast ? shown : null)}
              </p>
            )}
          </div>
          {view
            ? (view.slow_movers && <SlowMovers key={shown} slow={view.slow_movers} />)
            : <ListPlaceholder failed={monthFailed} />}
        </section>

        <section className={CARD}>
          <div className={SECTION_HEAD}>
            <h2 className="text-lg font-bold text-slate-900">Low Stock</h2>
            <p className="text-sm text-slate-600">Right now · products at or below {LOW_STOCK_THRESHOLD} units</p>
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

function ListPlaceholder({ failed }) {
  if (failed) {
    return <p className="px-5 py-10 text-center text-slate-600 text-base">Needs a connection</p>;
  }
  return (
    <div className="divide-y divide-slate-300" role="status" aria-label="Loading">
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex items-center justify-between gap-4 px-5 py-4 min-h-[48px]">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-4 w-16" />
        </div>
      ))}
    </div>
  );
}
