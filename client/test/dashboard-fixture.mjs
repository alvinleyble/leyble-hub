// GET /dashboard payloads in the sales shape (server/src/lib/salesDashboard.js), for
// the tests that render DashboardPage. `overrides` replaces top-level keys.
//
// The moment: Monday 9 November 2026, 10:15 AM Manila.

const legacy = (previous_gross, change, change_pct) => ({
  available: true, previous_gross, change, change_pct,
  previous_from: '2026-11-07T16:00:00.000Z', previous_to: '2026-11-08T02:15:00.000Z',
});

export function salesDashboardPayload(overrides = {}) {
  return {
    as_of: '2026-11-09T02:15:00.000Z',
    today: '2026-11-09',
    sales_start: '2026-06-01',
    week_starts_on: 'monday',
    totals: {
      today: {
        from: '2026-11-09', gross: 4100, comparison: legacy(3660, 440, 12), in_progress: true,
        previous: {
          available: true, from: '2026-11-08', to: '2026-11-08', gross: 4000, progress_pct: 102.5,
          verdict: { available: true, from: '2026-11-07', to: '2026-11-07', previous_gross: 3200, change: 800, change_pct: 25 },
        },
      },
      week: {
        from: '2026-11-09', gross: 4100, comparison: legacy(4456.5, -356.5, -8), in_progress: true,
        previous: {
          available: true, from: '2026-11-02', to: '2026-11-08', gross: 44245.5, progress_pct: 9.3,
          verdict: { available: true, from: '2026-10-26', to: '2026-11-01', previous_gross: 48000, change: -3754.5, change_pct: -7.8 },
        },
      },
      month: {
        from: '2026-11-01', gross: 52345.5, comparison: legacy(46000, 6345.5, 13.8), in_progress: true,
        previous: {
          available: true, from: '2026-10-01', to: '2026-10-31', gross: 150000, progress_pct: 34.9,
          verdict: { available: true, from: '2026-09-01', to: '2026-09-30', previous_gross: 140000, change: 10000, change_pct: 7.1 },
        },
      },
    },
    selected_month: {
      month: '2026-11', from: '2026-11-01', to: '2026-11-09', in_progress: true, gross: 52345.5,
      previous: { available: true, month: '2026-10', gross: 150000, progress_pct: 34.9 },
    },
    daily: [
      { date: '2026-11-01', gross: 3200 },
      { date: '2026-11-02', gross: 7000 },
      { date: '2026-11-03', gross: 12820 },
      { date: '2026-11-04', gross: 0 },
      { date: '2026-11-05', gross: 5000 },
      { date: '2026-11-06', gross: 6425.5 },
      { date: '2026-11-07', gross: 9000 },
      { date: '2026-11-08', gross: 4000 },
      { date: '2026-11-09', gross: 4100 },
    ],
    top_products: [
      { product_id: 59, name: 'Red Horse Grande 1L', sku: 'GRANDE', unit: 'cs', cases: 12.5, gross: 8012.5 },
      { product_id: 4, name: '8oz Coke', sku: null, unit: 'cs', cases: 20, gross: 4200 },
    ],
    slow_movers: {
      from: '2026-10-27', to: '2026-11-09', days: 14, clamped: false,
      products: [{ id: 108, name: 'Vitamilk 300ml', sku: null, category: 'Milk', unit: 'cs' }],
    },
    monthly: [
      { month: '2026-06', from: '2026-06-01', gross: 60000, in_progress: false },
      { month: '2026-07', from: '2026-07-01', gross: 120000, in_progress: false },
      { month: '2026-08', from: '2026-08-01', gross: 130000, in_progress: false },
      { month: '2026-09', from: '2026-09-01', gross: 140000, in_progress: false },
      { month: '2026-10', from: '2026-10-01', gross: 150000, in_progress: false },
      { month: '2026-11', from: '2026-11-01', gross: 52345.5, in_progress: true },
    ],
    low_stock: [],
    ...overrides,
  };
}

const MONTH_TOTALS = { '2026-06': 60000, '2026-07': 120000, '2026-08': 130000, '2026-09': 140000, '2026-10': 150000 };

// The same moment, viewing a FINISHED month (`?month=YYYY-MM`).
export function pastMonthPayload(month) {
  const [y, m] = month.split('-').map(Number);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const prev = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7);
  const gross = MONTH_TOTALS[month];
  const verdict = MONTH_TOTALS[prev] === undefined
    ? { available: false, month: prev }
    : {
      available: true, month: prev, previous_gross: MONTH_TOTALS[prev],
      change: gross - MONTH_TOTALS[prev],
      change_pct: Math.round(((gross - MONTH_TOTALS[prev]) / MONTH_TOTALS[prev]) * 1000) / 10,
    };
  const last = `${month}-${String(days).padStart(2, '0')}`;
  return salesDashboardPayload({
    selected_month: { month, from: `${month}-01`, to: last, in_progress: false, gross, verdict },
    daily: Array.from({ length: days }, (_, i) => ({
      date: `${month}-${String(i + 1).padStart(2, '0')}`, gross: i === 14 ? 9000 : 4000,
    })),
    top_products: [
      { product_id: 7, name: `San Miguel Pale Pilsen (${month})`, sku: null, unit: 'cs', cases: 40, gross: 30000 },
    ],
    slow_movers: {
      from: `${month}-${String(days - 13).padStart(2, '0')}`, to: last, days: 14, clamped: false,
      products: [{ id: 200, name: 'Tanduay Ice', sku: null, category: 'Liquor', unit: 'cs' }],
    },
  });
}
