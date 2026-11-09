// Pure helpers for the sales Dashboard. The server computes every figure
// (server/src/lib/salesDashboard.js); these only word and shape them for the screen.
import { formatPeso, formatSignedPeso } from './money';

const MINUS = '−';

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

function formatPct(pct) {
  const abs = Math.abs(pct);
  // Whole percents read best ("+12%"); keep a decimal only when rounding would say 0.
  const shown = Math.round(abs) === 0 && abs > 0 ? abs.toFixed(1) : String(Math.round(abs));
  return `${pct < 0 ? MINUS : '+'}${shown}%`;
}

/**
 * Words one change indicator. `previousLabel` names what it is compared with
 * ("yesterday", "last week", "last month"); `salesStart` is the first counted day.
 *
 * @returns {{ tone: 'up'|'down'|'flat'|'none', arrow: string, text: string, note: string }}
 */
export function describeChange(comparison, previousLabel, salesStart = '2026-11-01') {
  if (!comparison || !comparison.available) {
    const from = formatDay(salesStart, { month: 'short', day: 'numeric', year: 'numeric' });
    return { tone: 'none', arrow: '', text: 'No comparison yet', note: `Sales are counted from ${from}` };
  }
  const { change, change_pct: pct, previous_gross: previous } = comparison;
  const note = `vs ${previousLabel} so far (${formatPeso(previous)})`;
  if (!change) return { tone: 'flat', arrow: '', text: 'No change', note };
  const up = change > 0;
  const money = formatSignedPeso(change);
  return {
    tone: up ? 'up' : 'down',
    arrow: up ? '▲' : '▼',
    text: pct === null || pct === undefined ? money : `${formatPct(pct)} (${money})`,
    note,
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
  const s = Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100);
  return `${s} ${v === 1 ? 'case' : 'cases'}`;
}

// A cached copy from before the sales Dashboard (counters + order list) cannot be
// drawn by this screen; treat it as nothing held rather than rendering blanks.
export function isSalesPayload(value) {
  return Boolean(value && value.totals && Array.isArray(value.daily));
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
