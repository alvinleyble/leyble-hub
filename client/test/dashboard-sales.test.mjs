// The sales Dashboard (captain's grill 2026-11-09; comparisons and history reworked
// 2026-11-10; split into Sales / Products / Stock sub-tabs the same day): three totals, each split into the period still running (amber, IN
// PROGRESS, a share of the whole previous period) and the last finished one (green or
// red verdict); the month day by day, paged back to June 2026; the month-by-month
// trend; the viewed month's top 10 and slow movers. The server computes every figure;
// these pin how the screen words and pages them.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { React, act } from './render.mjs';
import { MemoryRouter } from 'react-router-dom';
import { api } from '../src/api/client.js';
import { __resetMemoryBackend } from '../src/offline/nativeStore.js';
import { writeBackOfficeCache, readBackOfficeCache, __clearBackOfficeCache, DASHBOARD_CACHE } from '../src/offline/backOfficeCache.js';
import {
  describeChange, describeVerdict, describeProgress, pagerBounds, shiftMonth, niceCeiling, formatCases,
  isSalesPayload, normalizeDashboard,
} from '../src/utils/salesDashboard.js';
import { salesDashboardPayload, pastMonthPayload } from './dashboard-fixture.mjs';
import { nativeStore } from '../src/offline/nativeStore.js';
import { DASHBOARD_TAB_KEY } from '../src/offline/keys.js';

const { createRoot } = await import('react-dom/client');
const DashboardPage = (await import('../src/pages/DashboardPage.jsx')).default;

// Non-breaking spaces (the "as of" join, ICU's narrow one before AM/PM) read as spaces.
const norm = (t) => t.replace(/[  ]/g, ' ');

const settle = (ms = 30) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

function renderPage() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => { root.render(React.createElement(MemoryRouter, null, React.createElement(DashboardPage))); });
  return {
    container,
    text: () => container.textContent,
    q: (id) => container.querySelector(`[data-testid="${id}"]`),
    all: (id) => [...container.querySelectorAll(`[data-testid="${id}"]`)],
    unmount: () => act(() => { root.unmount(); container.remove(); }),
  };
}

// GET /dashboard answers this month; `?month=` answers that past month.
function serve({ failMonths = false } = {}) {
  const calls = [];
  api.get = async (path) => {
    calls.push(path);
    const m = /month=(\d{4}-\d{2})/.exec(path);
    if (!m) return salesDashboardPayload();
    if (failMonths) throw new TypeError('Failed to fetch');
    return pastMonthPayload(m[1]);
  };
  return calls;
}

async function openTab(r, key) {
  await act(async () => { r.q(`dashboard-tab-${key}`).click(); });
  await settle();
}

function touch(el, type, x, y) {
  const ev = new Event(type, { bubbles: true });
  const point = [{ clientX: x, clientY: y }];
  Object.defineProperty(ev, type === 'touchend' ? 'changedTouches' : 'touches', { value: point });
  el.dispatchEvent(ev);
}

let saved;
beforeEach(async () => {
  saved = { get: api.get };
  await __resetMemoryBackend();
  await __clearBackOfficeCache();
});
afterEach(() => { Object.assign(api, saved); });

test('each running period is IN PROGRESS in amber, as a share of the whole previous period', async () => {
  serve();
  const r = renderPage();
  await settle();

  const today = r.q('dashboard-total-today');
  assert.match(today.textContent, /₱4,100\.00/);
  assert.equal(norm(r.q('dashboard-total-today-status').textContent), 'In progress · as of 10:15 AM');
  assert.ok(r.q('dashboard-total-today-status').className.includes('amber'), 'the label is amber');

  const progress = r.q('dashboard-total-today-progress');
  assert.equal(progress.textContent, '103% of all yesterday (₱4,000.00)');
  const bar = progress.querySelector('[role="progressbar"]');
  assert.equal(bar.getAttribute('aria-valuenow'), '100', 'past 100% the bar is simply full');
  assert.equal(bar.getAttribute('aria-valuetext'), '103% of all yesterday (₱4,000.00)');
  assert.ok(bar.firstChild.className.includes('bg-amber-600'));
  assert.doesNotMatch(r.q('dashboard-total-today-current').innerHTML, /green|red-/,
    'a running period is never coloured as up or down');

  assert.equal(r.q('dashboard-total-week-progress').textContent, '9% of all last week (₱44,245.50)');
  assert.equal(r.q('dashboard-total-month-progress').textContent, '35% of all October (₱150,000.00)');
  assert.match(r.q('dashboard-total-week').textContent, /Since Mon, Nov 9/);
  assert.match(r.q('dashboard-total-month').textContent, /November 2026/);
  assert.doesNotMatch(r.text(), /so far \(/, 'the old like-for-like wording is gone');
  r.unmount();
});

test('the last finished period carries the green or red verdict, against its own comparator', async () => {
  serve();
  const r = renderPage();
  await settle();

  const yesterday = r.q('dashboard-total-today-finished');
  assert.match(yesterday.textContent, /^YesterdaySun, Nov 8Finished₱4,000\.00/);
  const up = r.q('dashboard-total-today-change');
  assert.equal(up.textContent, '▲ Up +25% (+₱800.00)');
  assert.ok(up.className.includes('text-green-700'), 'up is green');
  assert.match(yesterday.textContent, /vs Sun, Nov 1 \(₱3,200\.00\)$/, 'the same weekday a week earlier');

  const lastWeek = r.q('dashboard-total-week-finished');
  assert.match(lastWeek.textContent, /Last weekNov 2 – Nov 8/);
  const down = r.q('dashboard-total-week-change');
  assert.equal(down.textContent, '▼ Down −8% (−₱3,754.50)', 'a real minus sign before the peso sign (Q15)');
  assert.ok(down.className.includes('text-red-700'), 'down is red');
  assert.match(lastWeek.textContent, /vs Oct 26 – Nov 1 \(₱48,000\.00\)/);

  const lastMonth = r.q('dashboard-total-month-finished');
  assert.match(lastMonth.textContent, /Last monthOctober 2026Finished₱150,000\.00/);
  assert.equal(r.q('dashboard-total-month-change').textContent, '▲ Up +7% (+₱10,000.00)');
  assert.match(lastMonth.textContent, /vs September 2026 \(₱140,000\.00\)/);
  r.unmount();
});

test('"No comparison yet" when the period compared with starts before sales were counted', async () => {
  const base = salesDashboardPayload();
  api.get = async () => salesDashboardPayload({
    totals: {
      ...base.totals,
      // 1 June 2026: there is no May to measure against.
      month: { ...base.totals.month, from: '2026-06-01',
        previous: { available: false, from: '2026-05-01', to: '2026-05-31' } },
      // Last week counted; the week before it began in May.
      week: { ...base.totals.week, previous: { ...base.totals.week.previous,
        verdict: { available: false, from: '2026-05-25', to: '2026-05-31' } } },
    },
  });
  const r = renderPage();
  await settle();

  assert.equal(r.q('dashboard-total-month-progress').textContent, 'No comparison yetSales are counted from Jun 1, 2026');
  assert.equal(r.q('dashboard-total-month-finished'), null, 'no finished month to show');
  assert.ok(r.q('dashboard-total-month-status'), 'still labelled in progress');

  assert.ok(r.q('dashboard-total-week-finished'), 'last week still shows its total');
  assert.equal(r.q('dashboard-total-week-change').textContent, 'No comparison yet');
  assert.match(r.q('dashboard-total-week-finished').textContent, /Sales are counted from Jun 1, 2026/);
  r.unmount();
});

test('the old counters and order list are gone', async () => {
  serve();
  const r = renderPage();
  await settle();
  assert.equal(r.all('dashboard-order-row').length, 0);
  assert.doesNotMatch(r.text(), /In Transit|Awaiting Close|Open Tickets|Active Orders/);
  r.unmount();
});

test('day-by-day chart: one bar per day so far, today amber and picked, tap a bar to read it', async () => {
  serve();
  const r = renderPage();
  await settle();

  assert.equal(r.q('dashboard-month-label').textContent, 'November 2026');
  assert.match(norm(r.q('dashboard-month-summary').textContent), /In progress · as of 10:15 AM₱52,345\.50 so far35% of all October \(₱150,000\.00\)/);

  const bars = r.all('dashboard-daily-bar');
  assert.equal(bars.length, 9);
  assert.equal(bars[8].getAttribute('aria-pressed'), 'true', 'today is picked first');
  assert.equal(bars[8].dataset.today, 'true');
  assert.match(bars[8].getAttribute('aria-label'), /Nov 9: ₱4,100\.00, still counting/);
  assert.ok(bars[8].firstChild.className.includes('bg-amber'), "today's bar is amber");
  assert.ok(bars[7].firstChild.className.includes('bg-blue'), 'a finished day is blue');
  assert.match(r.q('dashboard-daily-selected').textContent, /Nov 9.*₱4,100\.00 · still counting/);
  assert.match(bars[2].getAttribute('aria-label'), /^Mon, Nov 3: ₱12,820\.00$|^Tue, Nov 3: ₱12,820\.00$/);

  await act(async () => { bars[2].click(); });
  assert.match(r.q('dashboard-daily-selected').textContent, /Nov 3.*₱12,820\.00$/);

  const rows = [...r.q('dashboard-daily-list').querySelectorAll('li')];
  assert.equal(rows.length, 9);
  assert.match(rows[0].textContent, /Nov 9 · still counting/);
  r.unmount();
});

test('month pager: back to a finished month, bounded at June 2026 and at this month', async () => {
  const calls = serve();
  const r = renderPage();
  await settle();

  const next = () => r.q('dashboard-month-next');
  const prev = () => r.q('dashboard-month-prev');
  assert.equal(next().disabled, true, 'nothing after this month');
  assert.equal(prev().getAttribute('aria-label'), 'Previous month, October 2026');

  await act(async () => { prev().click(); });
  await settle();
  assert.ok(calls.includes('/dashboard?month=2026-10'));
  assert.equal(r.q('dashboard-month-label').textContent, 'October 2026');
  const summary = r.q('dashboard-month-summary').textContent;
  assert.match(summary, /^FINISHED|^Finished/);
  assert.match(summary, /₱150,000\.00/);
  assert.equal(r.q('dashboard-month-change').textContent, '▲ Up +7% (+₱10,000.00)');
  assert.match(summary, /vs September 2026 \(₱140,000\.00\)/);
  assert.doesNotMatch(summary, /In progress/);
  assert.equal(r.all('dashboard-daily-bar').length, 31, 'the whole month');
  assert.equal(r.all('dashboard-daily-bar').filter((b) => b.dataset.today).length, 0, 'no amber day');
  assert.match(r.all('dashboard-top-product')[0].textContent, /Red Horse Grande 1L/,
    "the Products tab keeps its own month: Sales' pager does not move it");
  assert.equal(next().disabled, false);
  // The cards never move: they are always today, this week, this month.
  assert.match(r.q('dashboard-total-today').textContent, /₱4,100\.00/);

  for (let i = 0; i < 4; i += 1) {
    await act(async () => { prev().click(); });
    await settle();
  }
  assert.equal(r.q('dashboard-month-label').textContent, 'June 2026');
  assert.equal(prev().disabled, true, 'nothing before June 2026');
  assert.equal(r.q('dashboard-month-change').textContent, 'No comparison yet', 'June has no May');
  assert.match(r.q('dashboard-month-summary').textContent, /Sales are counted from Jun 1, 2026/);
  assert.equal(calls.filter((c) => c.includes('month=2026-05')).length, 0);

  // Back to this month: drawn from the payload already held, not fetched again.
  const before = calls.length;
  for (let i = 0; i < 5; i += 1) {
    await act(async () => { next().click(); });
    await settle();
  }
  assert.equal(r.q('dashboard-month-label').textContent, 'November 2026');
  assert.equal(next().disabled, true);
  assert.equal(calls.slice(before).filter((c) => c === '/dashboard').length, 0);
  assert.equal(r.all('dashboard-daily-bar').length, 9);
  r.unmount();
});

test('swiping the day-by-day chart pages months; a mostly-vertical drag does not', async () => {
  serve();
  const r = renderPage();
  await settle();
  const section = r.q('dashboard-daily');

  await act(async () => { touch(section, 'touchstart', 300, 100); touch(section, 'touchend', 100, 110); });
  await settle();
  assert.equal(r.q('dashboard-month-label').textContent, 'November 2026', 'swiping left at this month goes nowhere');

  await act(async () => { touch(section, 'touchstart', 100, 100); touch(section, 'touchend', 300, 110); });
  await settle();
  assert.equal(r.q('dashboard-month-label').textContent, 'October 2026', 'swipe right: the month before');

  await act(async () => { touch(section, 'touchstart', 100, 100); touch(section, 'touchend', 180, 400); });
  await settle();
  assert.equal(r.q('dashboard-month-label').textContent, 'October 2026', 'a scroll is not a swipe');

  await act(async () => { touch(section, 'touchstart', 300, 100); touch(section, 'touchend', 100, 90); });
  await settle();
  assert.equal(r.q('dashboard-month-label').textContent, 'November 2026', 'swipe left: the month after');
  r.unmount();
});

test('by-month trend: one bar per month since June 2026, this month amber; tap one to open its days', async () => {
  const calls = serve();
  const r = renderPage();
  await settle();

  const bars = r.all('dashboard-monthly-bar');
  assert.equal(bars.length, 6);
  assert.match(bars[0].getAttribute('aria-label'), /^June 2026: ₱60,000\.00$/);
  assert.equal(bars[5].dataset.inProgress, 'true');
  assert.match(bars[5].getAttribute('aria-label'), /November 2026: ₱52,345\.50, still counting/);
  assert.ok(bars[5].firstChild.className.includes('bg-amber'));
  assert.ok(bars[4].firstChild.className.includes('bg-blue'));
  assert.equal(bars.filter((b) => b.dataset.inProgress).length, 1);
  assert.match(r.q('dashboard-monthly-selected').textContent, /November 2026 · ₱52,345\.50 · still counting/);
  assert.ok(r.q('dashboard-monthly-scroll').className.includes('overflow-x-auto'), 'scrolls once months outgrow the screen');

  await act(async () => { bars[1].click(); });
  await settle();
  assert.ok(calls.includes('/dashboard?month=2026-07'));
  assert.equal(r.q('dashboard-month-label').textContent, 'July 2026');
  assert.match(r.q('dashboard-monthly-selected').textContent, /July 2026 · ₱120,000\.00$/);
  r.unmount();
});

test('a past month read with no connection says so, and the pager still works', async () => {
  serve({ failMonths: true });
  const r = renderPage();
  await settle();
  await act(async () => { r.q('dashboard-month-prev').click(); });
  await settle();
  assert.match(r.q('dashboard-month-error').textContent, /October 2026 needs a connection/);
  assert.equal(r.all('dashboard-daily-bar').length, 0, 'never the current month drawn under a past month\'s name');
  await act(async () => { r.q('dashboard-month-next').click(); });
  await settle();
  assert.equal(r.all('dashboard-daily-bar').length, 9);
  r.unmount();
});

test('only the current month is held for offline use', async () => {
  serve();
  const r = renderPage();
  await settle();
  await act(async () => { r.q('dashboard-month-prev').click(); });
  await settle();
  const held = await readBackOfficeCache(DASHBOARD_CACHE);
  assert.equal(held.value.selected_month.month, '2026-11');
  r.unmount();
});

test('top products show cases sold; slow movers say when their window is clamped', async () => {
  api.get = async () => salesDashboardPayload({
    slow_movers: {
      from: '2026-06-01', to: '2026-06-09', days: 9, clamped: true,
      products: [{ id: 108, name: 'Vitamilk 300ml', sku: null, category: 'Milk', unit: 'cs' }],
    },
  });
  const r = renderPage();
  await settle();
  await openTab(r, 'products');

  const top = r.all('dashboard-top-product');
  assert.equal(top.length, 2);
  assert.match(top[0].textContent, /1\.Red Horse Grande 1L12\.5 cases sold₱8,012\.50/);
  assert.match(top[1].textContent, /20 cases sold/);

  assert.match(r.q('dashboard-slow-window').textContent, /no sales Jun 1 – Jun 9\. That is 9 days, not 14, because sales only count from Jun 1\./);
  assert.equal(r.all('dashboard-slow-mover').length, 1);
  r.unmount();
});

test('a full 14-day slow-mover window names its dates without the clamp note', async () => {
  api.get = async () => salesDashboardPayload({
    slow_movers: { from: '2026-11-17', to: '2026-11-30', days: 14, clamped: false, products: [] },
  });
  const r = renderPage();
  await settle();
  await openTab(r, 'products');
  assert.match(r.q('dashboard-slow-window').textContent, /no sales in the last 14 days \(Nov 17 – Nov 30\)/);
  assert.doesNotMatch(r.text(), /not 14/);
  r.unmount();
});

test('offline: the last loaded figures show behind the "as of" banner', async () => {
  await writeBackOfficeCache(DASHBOARD_CACHE, salesDashboardPayload());
  api.get = async () => { throw new TypeError('Failed to fetch'); };
  const r = renderPage();
  await settle();
  assert.match(r.text(), /Viewing offline data/);
  assert.match(r.text(), /Last updated/);
  assert.match(r.text(), /₱52,345\.50/);
  assert.equal(r.q('dashboard-total-today-progress').textContent, '103% of all yesterday (₱4,000.00)');
  r.unmount();
});

test('offline: a copy saved before the 2026-11-10 rework still draws, without inventing a comparison', async () => {
  // Exactly what the released build cached: like-for-like comparisons, no history.
  const old = salesDashboardPayload();
  for (const k of ['today', 'week', 'month']) delete old.totals[k].previous;
  delete old.selected_month; delete old.monthly; delete old.today;
  old.sales_start = '2026-10-01';
  await writeBackOfficeCache(DASHBOARD_CACHE, old);
  api.get = async () => { throw new TypeError('Failed to fetch'); };
  const r = renderPage();
  await settle();

  assert.match(r.text(), /Viewing offline data/);
  assert.match(r.q('dashboard-total-today').textContent, /₱4,100\.00/);
  assert.equal(r.q('dashboard-total-today-progress').textContent, 'Comparison shows once this device reconnects');
  assert.equal(r.q('dashboard-total-today-finished'), null);
  assert.doesNotMatch(r.text(), /so far \(/);
  assert.equal(r.q('dashboard-month-label').textContent, 'November 2026');
  assert.equal(r.all('dashboard-daily-bar').length, 9);
  assert.equal(r.all('dashboard-daily-bar').filter((b) => b.dataset.today).length, 1, 'its last day is today');
  assert.equal(r.q('dashboard-monthly'), null, 'no trend to draw');
  r.unmount();
});

test('offline: a copy held from the old counters Dashboard is not drawn as blank figures', async () => {
  await writeBackOfficeCache(DASHBOARD_CACHE, { summary: { pending_count: 4 }, orders: [], low_stock: [] });
  api.get = async () => { throw new TypeError('Failed to fetch'); };
  const r = renderPage();
  await settle();
  assert.match(r.text(), /no dashboard figures saved yet/);
  assert.doesNotMatch(r.text(), /₱0\.00/);
  r.unmount();
});

test('three sub-tabs: Sales opens by default, as a real tablist', async () => {
  serve();
  const r = renderPage();
  await settle();

  const list = r.container.querySelector('[role="tablist"]');
  assert.equal(list.getAttribute('aria-label'), 'Dashboard sections');
  const tabs = [...list.querySelectorAll('[role="tab"]')];
  assert.deepEqual(tabs.map((t) => t.textContent), ['Sales', 'Products', 'Stock']);
  assert.deepEqual(tabs.map((t) => t.getAttribute('aria-selected')), ['true', 'false', 'false']);
  assert.deepEqual(tabs.map((t) => t.tabIndex), [0, -1, -1], 'only the selected tab is in the Tab order');
  for (const t of tabs) {
    assert.ok(t.className.includes('min-h-[48px]'), `${t.textContent} is a 48px target`);
    const panel = r.container.querySelector(`#${t.getAttribute('aria-controls')}`);
    assert.equal(panel.getAttribute('role'), 'tabpanel');
    assert.equal(panel.getAttribute('aria-labelledby'), t.id);
  }

  assert.equal(r.q('dashboard-panel-sales').hidden, false);
  assert.equal(r.q('dashboard-panel-products').hidden, true);
  assert.equal(r.q('dashboard-panel-stock').hidden, true);
  assert.ok(r.q('dashboard-panel-sales').contains(r.q('dashboard-total-today')), 'Sales: the three totals');
  assert.ok(r.q('dashboard-panel-sales').contains(r.q('dashboard-daily')), 'Sales: the day-by-day chart');
  assert.ok(r.q('dashboard-panel-sales').contains(r.q('dashboard-monthly')), 'Sales: the by-month trend');
  assert.ok(r.q('dashboard-panel-products').contains(r.q('dashboard-top-products')), 'Products: top 10');
  assert.ok(r.q('dashboard-panel-products').contains(r.q('dashboard-slow-movers')), 'Products: slow movers');
  assert.ok(r.q('dashboard-panel-stock').contains(r.q('dashboard-low-stock')), 'Stock: low stock');

  await openTab(r, 'stock');
  assert.equal(r.q('dashboard-panel-sales').hidden, true);
  assert.equal(r.q('dashboard-panel-stock').hidden, false);
  assert.equal(r.q('dashboard-tab-stock').getAttribute('aria-selected'), 'true');
  r.unmount();
});

test('the tabs answer the keyboard: arrows wrap, Home and End jump, focus follows', async () => {
  serve();
  const r = renderPage();
  await settle();
  const key = async (k) => {
    await act(async () => {
      document.activeElement.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true }));
    });
  };
  r.q('dashboard-tab-sales').focus();
  await key('ArrowRight');
  assert.equal(r.q('dashboard-tab-products').getAttribute('aria-selected'), 'true');
  assert.equal(document.activeElement, r.q('dashboard-tab-products'));
  await key('ArrowRight');
  await key('ArrowRight');
  assert.equal(document.activeElement, r.q('dashboard-tab-sales'), 'wraps from the last to the first');
  await key('ArrowLeft');
  assert.equal(document.activeElement, r.q('dashboard-tab-stock'), 'and back');
  await key('Home');
  assert.equal(r.q('dashboard-tab-sales').getAttribute('aria-selected'), 'true');
  await key('End');
  assert.equal(r.q('dashboard-tab-stock').getAttribute('aria-selected'), 'true');
  assert.equal(r.q('dashboard-panel-stock').hidden, false);
  r.unmount();
});

test('the last tab used is remembered on this device', async () => {
  serve();
  const first = renderPage();
  await settle();
  await openTab(first, 'products');
  first.unmount();

  const again = renderPage();
  await settle();
  assert.equal(again.q('dashboard-tab-products').getAttribute('aria-selected'), 'true');
  assert.equal(again.q('dashboard-panel-products').hidden, false);
  assert.equal(await nativeStore.getString(DASHBOARD_TAB_KEY), 'products');
  again.unmount();

  // Anything else held under the key is ignored, not trusted.
  await nativeStore.setString(DASHBOARD_TAB_KEY, 'orders');
  const third = renderPage();
  await settle();
  assert.equal(third.q('dashboard-tab-sales').getAttribute('aria-selected'), 'true');
  third.unmount();
});

test('Products has its own month pager, bounded at June 2026 and this month', async () => {
  const calls = serve();
  const r = renderPage();
  await settle();
  await openTab(r, 'products');

  const prev = () => r.q('dashboard-products-month-prev');
  const next = () => r.q('dashboard-products-month-next');
  assert.equal(r.q('dashboard-products-month-label').textContent, 'November 2026');
  assert.equal(next().disabled, true);

  await act(async () => { prev().click(); });
  await settle();
  assert.ok(calls.includes('/dashboard?month=2026-10'));
  assert.equal(r.q('dashboard-products-month-label').textContent, 'October 2026');
  assert.match(r.all('dashboard-top-product')[0].textContent, /San Miguel Pale Pilsen \(2026-10\)/);
  assert.match(r.q('dashboard-products-month').parentElement.textContent, /October 2026, by gross sales/);
  assert.match(r.q('dashboard-slow-window').textContent, /last 14 days of October 2026 \(Oct 18 – Oct 31\)/);
  assert.equal(r.q('dashboard-month-label').textContent, 'November 2026', "Sales' pager stays where it was");

  for (let i = 0; i < 4; i += 1) {
    await act(async () => { prev().click(); });
    await settle();
  }
  assert.equal(r.q('dashboard-products-month-label').textContent, 'June 2026');
  assert.equal(prev().disabled, true);
  assert.equal(calls.filter((c) => c.includes('month=2026-05')).length, 0);

  const section = r.q('dashboard-panel-products').firstChild;
  await act(async () => { touch(section, 'touchstart', 300, 100); touch(section, 'touchend', 100, 110); });
  await settle();
  assert.equal(r.q('dashboard-products-month-label').textContent, 'July 2026', 'swipe left: the month after');
  r.unmount();
});

test('Products for a past month with no connection says so instead of empty lists', async () => {
  serve({ failMonths: true });
  const r = renderPage();
  await settle();
  await openTab(r, 'products');
  await act(async () => { r.q('dashboard-products-month-prev').click(); });
  await settle();
  assert.match(r.q('dashboard-products-month-error').textContent, /October 2026 needs a connection/);
  assert.equal(r.all('dashboard-top-product').length, 0, "never this month's list under October's name");
  r.unmount();
});

test('Stock: the low-stock list, flagged on its tab with a worded count', async () => {
  api.get = async () => salesDashboardPayload({
    low_stock: [
      { id: 1, name: '8oz Coke', category: 'Softdrinks', unit: 'case', current_stock: 0 },
      { id: 2, name: 'Mismo Coke', category: 'Softdrinks', unit: 'case', current_stock: 6 },
    ],
  });
  const r = renderPage();
  await settle();
  const count = r.q('dashboard-tab-stock-count');
  assert.equal(count.textContent, '2 low');
  assert.ok(count.className.includes('amber'));
  assert.equal(r.q('dashboard-tab-stock').textContent, 'Stock2 low');

  await openTab(r, 'stock');
  const items = r.all('dashboard-low-stock-item');
  assert.equal(items.length, 2);
  assert.match(items[0].textContent, /8oz Coke.*0 case.*Out of stock/);
  assert.match(items[1].textContent, /Mismo Coke.*6 case.*Low stock/);
  r.unmount();

  api.get = async () => salesDashboardPayload();
  const healthy = renderPage();
  await settle();
  assert.equal(healthy.q('dashboard-tab-stock-count'), null, 'no flag when nothing is low');
  await openTab(healthy, 'stock');
  assert.match(healthy.q('dashboard-low-stock').textContent, /All stock levels are healthy/);
  healthy.unmount();
});

test('offline: the held copy draws on every tab', async () => {
  await writeBackOfficeCache(DASHBOARD_CACHE, salesDashboardPayload());
  api.get = async () => { throw new TypeError('Failed to fetch'); };
  const r = renderPage();
  await settle();
  assert.match(r.text(), /Viewing offline data/);
  await openTab(r, 'products');
  assert.equal(r.all('dashboard-top-product').length, 2);
  await openTab(r, 'stock');
  assert.match(r.q('dashboard-low-stock').textContent, /All stock levels are healthy/);
  r.unmount();
});

test('describeVerdict and describeProgress word every state', () => {
  assert.deepEqual(describeVerdict({ available: false }, 'Mon, Nov 2', '2026-06-01'),
    { tone: 'none', arrow: '', text: 'No comparison yet', note: 'Sales are counted from Jun 1, 2026' });
  assert.equal(describeVerdict(undefined, 'x').note, 'Sales are counted from Jun 1, 2026', 'the default start is 1 June');
  assert.deepEqual(describeVerdict({ available: true, previous_gross: 0, change: 641, change_pct: null }, 'Mon, Nov 2'),
    { tone: 'up', arrow: '▲', text: '+₱641.00', note: 'vs Mon, Nov 2 (₱0.00)' }, 'no percent against nothing');
  assert.equal(describeVerdict({ available: true, previous_gross: 500, change: 0, change_pct: 0 }, 'x').text, 'No change');
  assert.equal(describeVerdict({ available: true, previous_gross: 100000, change: 300, change_pct: 0.3 }, 'x').text,
    '+0.3% (+₱300.00)', 'a decimal only when a whole percent would read 0');
  assert.equal(describeVerdict({ available: true, previous_gross: 300, change: -100, change_pct: -33.3 }, 'x').text,
    '−33% (−₱100.00)');

  assert.deepEqual(describeProgress({ available: true, gross: 11700, progress_pct: 35.2 }, 'yesterday'),
    { state: 'progress', pct: 35, bar: 35.2, text: '35% of all yesterday (₱11,700.00)' });
  assert.equal(describeProgress({ available: true, gross: 1000, progress_pct: 250 }, 'last week').bar, 100);
  assert.deepEqual(describeProgress({ available: true, gross: 0, progress_pct: null }, 'yesterday'),
    { state: 'progress', pct: null, bar: 0, text: 'All of yesterday: ₱0.00' });
  assert.deepEqual(describeProgress({ available: false }, 'May'),
    { state: 'none', text: 'No comparison yet', note: 'Sales are counted from Jun 1, 2026' });
  assert.equal(describeProgress(undefined, 'x').state, 'unknown');

  // The like-for-like wording stays for anything still holding that shape.
  assert.equal(describeChange({ available: true, previous_gross: 3660, change: 440, change_pct: 12 }, 'yesterday').note,
    'vs yesterday so far (₱3,660.00)');
});

test('pager bounds: June 2026 to the current month, across a year end', () => {
  assert.deepEqual(pagerBounds('2026-11', '2026-06', '2026-11'), { prev: '2026-10', next: null });
  assert.deepEqual(pagerBounds('2026-06', '2026-06', '2026-11'), { prev: null, next: '2026-07' });
  assert.deepEqual(pagerBounds('2026-08', '2026-06', '2026-11'), { prev: '2026-07', next: '2026-09' });
  assert.deepEqual(pagerBounds('2026-06', '2026-06', '2026-06'), { prev: null, next: null }, 'June is all there is');
  assert.deepEqual(pagerBounds('2027-01', '2026-06', '2027-02'), { prev: '2026-12', next: '2027-02' });
  assert.equal(shiftMonth('2027-01', -1), '2026-12');
  assert.equal(shiftMonth('2026-12', 1), '2027-01');
});

test('chart and list helpers', () => {
  assert.equal(niceCeiling(12820), 15000);
  assert.equal(niceCeiling(0), 0);
  assert.equal(niceCeiling(641), 800);
  assert.equal(formatCases(1), '1 case');
  assert.equal(formatCases(12.5), '12.5 cases');
  assert.equal(isSalesPayload({ summary: {}, orders: [] }), false);
  assert.equal(isSalesPayload(salesDashboardPayload()), true);
  const old = normalizeDashboard({ totals: { month: { from: '2026-11-01', gross: 5 } }, daily: [{ date: '2026-11-03', gross: 5 }] });
  assert.deepEqual([old.today, old.selected_month.month, old.monthly, old.sales_start],
    ['2026-11-03', '2026-11', [], '2026-06-01']);
});
