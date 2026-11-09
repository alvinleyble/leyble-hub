// The sales Dashboard (captain's grill, 2026-11-09): three gross-sales totals with
// like-for-like change indicators, this month day by day, the top 10 products and the
// slow movers. The server computes every figure; these pin how the screen words them.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { React, act } from './render.mjs';
import { MemoryRouter } from 'react-router-dom';
import { api } from '../src/api/client.js';
import { __resetMemoryBackend } from '../src/offline/nativeStore.js';
import { writeBackOfficeCache, __clearBackOfficeCache, DASHBOARD_CACHE } from '../src/offline/backOfficeCache.js';
import { describeChange, niceCeiling, formatCases, isSalesPayload } from '../src/utils/salesDashboard.js';
import { salesDashboardPayload } from './dashboard-fixture.mjs';

const { createRoot } = await import('react-dom/client');
const DashboardPage = (await import('../src/pages/DashboardPage.jsx')).default;

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

let saved;
beforeEach(async () => {
  saved = { get: api.get };
  await __resetMemoryBackend();
  await __clearBackOfficeCache();
});
afterEach(() => { Object.assign(api, saved); });

test('three gross-sales totals, each with its like-for-like change indicator', async () => {
  api.get = async () => salesDashboardPayload();
  const r = renderPage();
  await settle();

  const today = r.q('dashboard-total-today');
  assert.match(today.textContent, /₱4,100\.00/);
  const up = r.q('dashboard-total-today-change');
  assert.match(up.textContent, /▲ Up \+12% \(\+₱440\.00\)/);
  assert.ok(up.className.includes('text-green-700'), 'up is green');
  assert.match(today.textContent, /vs yesterday so far \(₱3,660\.00\)/);

  const down = r.q('dashboard-total-week-change');
  assert.match(down.textContent, /▼ Down −8% \(−₱356\.50\)/, 'a real minus sign before the peso sign (Q15)');
  assert.ok(down.className.includes('text-red-700'), 'down is red');

  const month = r.q('dashboard-total-month');
  assert.match(month.textContent, /₱52,345\.50/);
  assert.match(r.q('dashboard-total-month-change').textContent, /^No comparison yet$/);
  assert.match(month.textContent, /Sales are counted from Nov 1, 2026/);
  assert.match(month.textContent, /November 2026/);
  r.unmount();
});

test('the old counters and order list are gone', async () => {
  api.get = async () => salesDashboardPayload();
  const r = renderPage();
  await settle();
  assert.equal(r.all('dashboard-order-row').length, 0);
  assert.doesNotMatch(r.text(), /In Transit|Awaiting Close|Open Tickets|Active Orders/);
  r.unmount();
});

test('day-by-day chart: one bar per day so far, today picked, tap a bar to read it', async () => {
  api.get = async () => salesDashboardPayload();
  const r = renderPage();
  await settle();

  const bars = r.all('dashboard-daily-bar');
  assert.equal(bars.length, 9);
  assert.equal(bars[8].getAttribute('aria-pressed'), 'true', 'today is picked first');
  assert.match(r.q('dashboard-daily-selected').textContent, /Nov 9.*₱4,100\.00/);
  assert.match(bars[2].getAttribute('aria-label'), /Nov 3: ₱12,820\.00/);

  await act(async () => { bars[2].click(); });
  assert.match(r.q('dashboard-daily-selected').textContent, /Nov 3.*₱12,820\.00/);

  // The table view: every day's exact figure, newest first.
  const rows = [...r.q('dashboard-daily-list').querySelectorAll('li')];
  assert.equal(rows.length, 9);
  assert.match(rows[0].textContent, /Nov 9/);
  r.unmount();
});

test('top products show cases sold; slow movers say when their window is clamped', async () => {
  api.get = async () => salesDashboardPayload();
  const r = renderPage();
  await settle();

  const top = r.all('dashboard-top-product');
  assert.equal(top.length, 2);
  assert.match(top[0].textContent, /1\.Red Horse Grande 1L12\.5 cases sold₱8,012\.50/);
  assert.match(top[1].textContent, /20 cases sold/);

  assert.match(r.q('dashboard-slow-window').textContent, /no sales Nov 1 – Nov 9\. That is 9 days, not 14, because sales only count from Nov 1\./);
  assert.equal(r.all('dashboard-slow-mover').length, 1);
  r.unmount();
});

test('a full 14-day slow-mover window names its dates without the clamp note', async () => {
  api.get = async () => salesDashboardPayload({
    slow_movers: { from: '2026-11-17', to: '2026-11-30', days: 14, clamped: false, products: [] },
  });
  const r = renderPage();
  await settle();
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

test('describeChange words every case', () => {
  assert.deepEqual(describeChange({ available: false }, 'yesterday', '2026-11-01'),
    { tone: 'none', arrow: '', text: 'No comparison yet', note: 'Sales are counted from Nov 1, 2026' });
  const fromNothing = describeChange({ available: true, previous_gross: 0, change: 641, change_pct: null }, 'yesterday');
  assert.equal(fromNothing.text, '+₱641.00', 'no percent against an empty period');
  assert.equal(fromNothing.tone, 'up');
  assert.equal(describeChange({ available: true, previous_gross: 500, change: 0, change_pct: 0 }, 'last week').text, 'No change');
  assert.equal(describeChange({ available: true, previous_gross: 100000, change: 300, change_pct: 0.3 }, 'x').text,
    '+0.3% (+₱300.00)', 'a decimal only when a whole percent would read 0');
  assert.equal(describeChange({ available: true, previous_gross: 300, change: -100, change_pct: -33.3 }, 'x').text,
    '−33% (−₱100.00)');
});

test('chart and list helpers', () => {
  assert.equal(niceCeiling(12820), 15000);
  assert.equal(niceCeiling(0), 0);
  assert.equal(niceCeiling(641), 800);
  assert.equal(formatCases(1), '1 case');
  assert.equal(formatCases(12.5), '12.5 cases');
  assert.equal(isSalesPayload({ summary: {}, orders: [] }), false);
  assert.equal(isSalesPayload(salesDashboardPayload()), true);
});
