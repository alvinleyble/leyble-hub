// Pure helpers for the sales Dashboard. The server computes every figure
// (server/src/lib/salesDashboard.js); these only word and shape them for the screen.
import { formatPeso, formatSignedPeso } from './money';

const MINUS = '−';

// The first day sales are counted. The payload carries the server's own value; this
// is only the fallback for a copy that somehow lacks it.
export const SALES_START = '2026-06-01';

// Calendar dates arrive as plain 'YYYY-MM-DD' Manila days. Read them as UTC noon and
// format in UTC, so a device in any timezone shows the same day the server meant.
function asDay(ymd) {
  return new Date(`${ymd}T12:00:00Z`);
}

export function formatDay(ymd, opts = { weekday: 'short', month: 'short', day: 'numeric' }) {
  if (!ymd) return '';
  return asDay(ymd).toLocaleDateString('en-PH', { ...opts, timeZone: 'UTC' });
}

export function dayOfMonth(ymd) {
  return Number(String(ymd).slice(8, 10));
}

export function monthName(ymd) {
  return formatDay(ymd, { month: 'long', year: 'numeric' });
}

const shortDay = (ymd) => formatDay(ymd, { month: 'short', day: 'numeric' });

// "Nov 2 – Nov 8"
export function formatRange(from, to) {
  return `${shortDay(from)} – ${shortDay(to)}`;
}

// The time a payload was true, on Manila's clock: "12:50 AM".
export function formatAsOf(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Manila' });
}

function formatPct(pct) {
  const abs = Math.abs(pct);
  // Whole percents read best ("+12%"); keep a decimal only when rounding would say 0.
  const shown = Math.round(abs) === 0 && abs > 0 ? abs.toFixed(1) : String(Math.round(abs));
  return `${pct < 0 ? MINUS : '+'}${shown}%`;
}

function noComparison(salesStart) {
  const from = formatDay(salesStart || SALES_START, { month: 'short', day: 'numeric', year: 'numeric' });
  return { tone: 'none', arrow: '', text: 'No comparison yet', note: `Sales are counted from ${from}` };
}

// The up/down line itself: "+12% (+₱440.00)", or pesos alone against nothing.
function wordChange(change, pct) {
  if (!change) return { tone: 'flat', arrow: '', text: 'No change' };
  const up = change > 0;
  const money = formatSignedPeso(change);
  return {
    tone: up ? 'up' : 'down',
    arrow: up ? '▲' : '▼',
    text: pct === null || pct === undefined ? money : `${formatPct(pct)} (${money})`,
  };
}

/**
 * Words the like-for-like comparison builds released before 2026-11-10 showed. Kept
 * for anything still holding that shape; the current screen uses describeVerdict.
 *
 * @returns {{ tone: 'up'|'down'|'flat'|'none', arrow: string, text: string, note: string }}
 */
export function describeChange(comparison, previousLabel, salesStart = SALES_START) {
  if (!comparison || !comparison.available) return noComparison(salesStart);
  const { change, change_pct: pct, previous_gross: previous } = comparison;
  return { ...wordChange(change, pct), note: `vs ${previousLabel} so far (${formatPeso(previous)})` };
}

/**
 * A FINISHED period's verdict against its comparator. `comparatorLabel` names it:
 * "Mon, Nov 2", "Oct 26 – Nov 1", "September 2026".
 *
 * @returns {{ tone: 'up'|'down'|'flat'|'none', arrow: string, text: string, note: string }}
 */
export function describeVerdict(verdict, comparatorLabel, salesStart = SALES_START) {
  if (!verdict || !verdict.available) return noComparison(salesStart);
  return {
    ...wordChange(verdict.change, verdict.change_pct),
    note: `vs ${comparatorLabel} (${formatPeso(verdict.previous_gross)})`,
  };
}

/**
 * A period still RUNNING, as a share of the whole previous period. Never a verdict:
 * it is not finished, so it is neither up nor down yet.
 *
 * @param previous  `{ available, gross, progress_pct }`, or undefined on a copy saved
 *                  before this shape existed.
 * @param ofLabel   what the share is of: "yesterday", "last week", "October".
 * @returns {{ state: 'progress'|'none'|'unknown', pct?: number, bar?: number, text: string, note?: string }}
 */
export function describeProgress(previous, ofLabel, salesStart = SALES_START) {
  if (!previous) {
    return { state: 'unknown', text: 'Comparison shows once this device reconnects' };
  }
  if (!previous.available) {
    const { text, note } = noComparison(salesStart);
    return { state: 'none', text, note };
  }
  const total = formatPeso(previous.gross);
  if (previous.progress_pct === null || previous.progress_pct === undefined) {
    // Nothing sold in the whole previous period: there is no share to give.
    return { state: 'progress', pct: null, bar: 0, text: `All of ${ofLabel}: ${total}` };
  }
  const pct = Math.round(previous.progress_pct);
  return {
    state: 'progress',
    pct,
    bar: Math.max(0, Math.min(100, previous.progress_pct)),
    text: `${pct}% of all ${ofLabel} (${total})`,
  };
}

// ── Months ────────────────────────────────────────────────────────────────────

export function monthKey(ymd) {
  return String(ymd || '').slice(0, 7);
}

export function shiftMonth(ym, delta) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + delta, 1)).toISOString().slice(0, 7);
}

// "November 2026"
export function monthLabel(ym) {
  return monthName(`${ym}-01`);
}

// "Nov"
export function monthShort(ym) {
  return formatDay(`${ym}-01`, { month: 'short' });
}

/**
 * The month pager, bounded to the first counted month and the current one.
 * @returns {{ prev: string|null, next: string|null }}  null where the pager stops.
 */
export function pagerBounds(viewed, first, last) {
  const prev = shiftMonth(viewed, -1);
  const next = shiftMonth(viewed, 1);
  return { prev: prev >= first ? prev : null, next: next <= last ? next : null };
}

// What each of the three totals is called, given the payload's period dates.
export function periodLabels(key, total) {
  const prev = total?.previous ?? {};
  const cmp = prev.verdict ?? {};
  if (key === 'today') {
    return {
      label: 'Today', period: formatDay(total?.from), of: 'yesterday',
      finished: 'Yesterday', finishedPeriod: formatDay(prev.from), comparator: formatDay(cmp.from),
    };
  }
  if (key === 'week') {
    return {
      label: 'This week', period: `Since ${formatDay(total?.from)}`, of: 'last week',
      finished: 'Last week', finishedPeriod: prev.from ? formatRange(prev.from, prev.to) : '',
      comparator: cmp.from ? formatRange(cmp.from, cmp.to) : '',
    };
  }
  return {
    label: 'This month', period: monthName(total?.from),
    of: prev.from ? formatDay(prev.from, { month: 'long' }) : 'last month',
    finished: 'Last month', finishedPeriod: monthName(prev.from), comparator: monthName(cmp.from),
  };
}

// A round number at or above `max` for the chart's top gridline.
export function niceCeiling(max) {
  if (!(max > 0)) return 0;
  const pow = 10 ** Math.floor(Math.log10(max));
  for (const step of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) {
    if (step * pow >= max) return step * pow;
  }
  return 10 * pow;
}

export function formatCases(n) {
  const v = Number(n) || 0;
  const s = v.toLocaleString('en-PH', { maximumFractionDigits: 2 });
  return `${s} ${v === 1 ? 'case' : 'cases'}`;
}

// A cached copy from before the sales Dashboard (counters + order list) cannot be
// drawn by this screen; treat it as nothing held rather than rendering blanks.
export function isSalesPayload(value) {
  return Boolean(value && value.totals && Array.isArray(value.daily));
}

/**
 * Fills in what a payload from before the 2026-11-10 rework lacks (a copy this
 * device saved earlier and shows offline): the month it describes, today, and an
 * empty trend. Its totals keep no `previous`, which the cards word as "shows once
 * this device reconnects" rather than inventing a comparison.
 */
export function normalizeDashboard(payload) {
  const daily = payload.daily ?? [];
  const today = payload.today ?? daily[daily.length - 1]?.date ?? payload.totals?.today?.from;
  const month = payload.selected_month?.month ?? monthKey(payload.totals?.month?.from ?? today);
  return {
    ...payload,
    today,
    sales_start: payload.sales_start ?? SALES_START,
    selected_month: payload.selected_month ?? {
      month, from: payload.totals?.month?.from, in_progress: true, gross: payload.totals?.month?.gross ?? 0,
    },
    monthly: Array.isArray(payload.monthly) ? payload.monthly : [],
    top_products: payload.top_products ?? [],
    low_stock: payload.low_stock ?? [],
  };
}

// A legacy offline copy has only the gross-ranked top_products. Never re-sort that
// truncated list and call it a different top 10, or invent missing order counts.
export function productRanking(view, picked = 'cases') {
  const lists = view?.top_products_by;
  const available = ['cases', 'sales', 'orders'].every((key) => Array.isArray(lists?.[key]));
  const key = available ? picked : 'sales';
  return { key, available, rows: available ? lists[key] : (view?.top_products ?? []) };
}

export function productMetrics(product, ranking) {
  const values = {
    cases: formatCases(product.cases),
    sales: formatPeso(product.gross),
    orders: product.orders == null ? null : `${product.orders.toLocaleString('en-PH')} ${product.orders === 1 ? 'order' : 'orders'}`,
  };
  return {
    primary: values[ranking],
    secondary: ['cases', 'sales', 'orders'].filter((key) => key !== ranking && values[key] != null)
      .map((key) => values[key]).join(' · '),
  };
}

// The chart always spans the whole month, so a bar keeps the same width all month
// and the days still to come read as empty slots rather than stretching the bars so
// far. Days after the last one the server sent come back with `future: true`.
export function padToMonthEnd(daily) {
  if (!daily.length) return [];
  const last = daily[daily.length - 1].date;
  const [y, m] = last.split('-').map(Number);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const out = [...daily];
  for (let d = dayOfMonth(last) + 1; d <= daysInMonth; d += 1) {
    out.push({ date: `${last.slice(0, 8)}${String(d).padStart(2, '0')}`, gross: 0, future: true });
  }
  return out;
}
