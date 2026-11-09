// A GET /dashboard payload in the sales shape (server/src/lib/salesDashboard.js),
// for the tests that render DashboardPage. `overrides` replaces top-level keys.
export function salesDashboardPayload(overrides = {}) {
  return {
    as_of: '2026-11-09T02:15:00.000Z',
    sales_start: '2026-10-01',
    week_starts_on: 'monday',
    totals: {
      today: { from: '2026-11-09', gross: 4100, comparison: {
        available: true, previous_gross: 3660, change: 440, change_pct: 12,
        previous_from: '2026-11-07T16:00:00.000Z', previous_to: '2026-11-08T02:15:00.000Z' } },
      week: { from: '2026-11-09', gross: 4100, comparison: {
        available: true, previous_gross: 4456.5, change: -356.5, change_pct: -8,
        previous_from: '2026-11-01T16:00:00.000Z', previous_to: '2026-11-02T02:15:00.000Z' } },
      month: { from: '2026-11-01', gross: 52345.5, comparison: {
        available: true, previous_gross: 46000, change: 6345.5, change_pct: 13.8,
        previous_from: '2026-09-30T16:00:00.000Z', previous_to: '2026-10-09T02:15:00.000Z' } },
    },
    daily: [
      { date: '2026-11-01', gross: 0 },
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
    low_stock: [],
    ...overrides,
  };
}
