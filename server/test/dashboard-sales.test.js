// The Dashboard's sales and product figures (lib/salesDashboard.js, captain's grill
// 2026-11-09). Every test pins `now` and asserts on the CHANGE its own rows make, so
// whatever other suites left in the shared test database cannot move the answer.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const http = require('node:http');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://localhost/leyble_hub';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-key-32-chars-minimum!!';

const db = require('../src/db');
const dashboardRoutes = require('../src/routes/dashboard');
const { errorHandler } = require('../src/middleware/errorHandler');
const { computeSalesDashboard, resolveMonth } = require('../src/lib/salesDashboard');

const RUN = `${Date.now()}`;
// A Manila wall-clock time as an instant. Manila is UTC+8 all year (no DST).
const mnl = (local) => new Date(`${local}+08:00`);
const at = (local) => computeSalesDashboard(db, { now: mnl(local) });

describe('Dashboard sales figures', () => {
  let customerId;
  const productIds = [];
  let grande; // the captain's own example: 641 per case = 614 goods + 6 × ₱4.50

  async function product(name, { price = 100, deposit = 0, upc = 1, active = true } = {}) {
    const { rows: [p] } = await db.query(
      `INSERT INTO products (name, category, unit, base_wholesale_price, deposit_fee,
                             units_per_case, requires_bottle_return, current_stock, is_active)
       VALUES ($1, 'TEST_DASH', 'cs', $2, $3, $4, $5, 100, $6) RETURNING id, name`,
      [`${name} ${RUN}`, price, deposit, upc, deposit > 0, active]
    );
    productIds.push(p.id);
    return { ...p, price, deposit, upc };
  }

  // One order, its lines written exactly as the order routes store them.
  async function order(status, createdLocal, lines) {
    const { rows: [o] } = await db.query(
      `INSERT INTO orders (customer_id, status, order_type, created_at)
       VALUES ($1, $2, 'pickup', $3) RETURNING id`,
      [customerId, status, mnl(createdLocal)]
    );
    for (const l of lines) {
      await db.query(
        `INSERT INTO order_items (order_id, product_id, quantity, unit_price, unit_deposit_fee,
                                  units_per_case, bottles_returned)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [o.id, l.p.id, l.qty, l.price ?? l.p.price, l.p.deposit, l.p.upc, l.returned ?? 0]
      );
    }
    return o.id;
  }

  const total = (d, key) => d.totals[key].gross;
  const dayOf = (d, date) => d.daily.find((r) => r.date === date)?.gross ?? 0;

  before(async () => {
    const { rows: [c] } = await db.query(
      `INSERT INTO customers (name, customer_type) VALUES ($1, 'regular') RETURNING id`,
      [`TEST_DASH Customer ${RUN}`]
    );
    customerId = c.id;
    grande = await product('TEST_DASH Red Horse Grande 1L', { price: 641, deposit: 4.5, upc: 6 });
  });

  after(async () => {
    await db.query('DELETE FROM orders WHERE customer_id = $1', [customerId]);
    if (productIds.length) await db.query('DELETE FROM products WHERE id = ANY($1)', [productIds]);
    await db.query('DELETE FROM customers WHERE id = $1', [customerId]);
  });

  it('counts pending and closed orders at the full listed price; drafts and cancelled never count', async () => {
    const NOW = '2026-11-03T10:00:00';
    const before = await at(NOW);

    await order('pending', '2026-11-03T09:00:00', [{ p: grande, qty: 1 }]);
    // Closed, every bottle came home. The close flow collects less, the sale does not.
    const closedId = await order('done', '2026-11-03T08:00:00', [{ p: grande, qty: 1, returned: 6 }]);
    await order('draft', '2026-11-03T08:30:00', [{ p: grande, qty: 5 }]);
    await order('cancelled', '2026-11-03T08:45:00', [{ p: grande, qty: 7 }]);

    const after = await at(NOW);
    assert.equal(total(after, 'today') - total(before, 'today'), 1282, 'two cases at ₱641, nothing else');
    assert.equal(total(after, 'month') - total(before, 'month'), 1282);

    // The two figures the sale must NOT be: the post-close total (deposit fully
    // credited back) and price + deposit again (the deposit counted twice).
    const { rows: [line] } = await db.query(
      'SELECT line_total FROM order_items WHERE order_id = $1', [closedId]);
    assert.equal(Number(line.line_total), 641, 'the stored post-close line total, for reference');
    const { rows: [pendingLine] } = await db.query(
      `SELECT oi.line_total FROM order_items oi JOIN orders o ON o.id = oi.order_id
       WHERE o.customer_id = $1 AND o.status = 'pending' AND o.created_at = $2`,
      [customerId, mnl('2026-11-03T09:00:00')]);
    assert.equal(Number(pendingLine.line_total), 668, 'line_total adds the deposit on top — the dashboard must not');
  });

  it('a closed order with bottles returned still counts at 641 per case, not less', async () => {
    const NOW = '2026-11-04T10:00:00';
    const before = await at(NOW);
    await order('done', '2026-11-04T07:00:00', [{ p: grande, qty: 2, returned: 12 }]);
    await order('completed', '2026-11-04T07:30:00', [{ p: grande, qty: 0.5, returned: 3 }]);
    const after = await at(NOW);
    assert.equal(total(after, 'today') - total(before, 'today'), 1602.5, '2.5 cases × ₱641');
  });

  it('nothing created before 2026-06-01 (Asia/Manila) appears in any figure', async () => {
    const NOW = '2026-06-01T10:00:00'; // a Monday
    const before = await at(NOW);
    await order('pending', '2026-05-31T23:59:00', [{ p: grande, qty: 3 }]);
    await order('pending', '2026-06-01T00:00:00', [{ p: grande, qty: 1 }]);
    const after = await at(NOW);

    for (const key of ['today', 'week', 'month']) {
      assert.equal(total(after, key) - total(before, key), 641, `${key}: only the 1 June order`);
    }
    assert.equal(after.totals.week.from, '2026-06-01');
    assert.equal(after.totals.month.from, '2026-06-01');
    assert.deepEqual(after.daily.map((r) => r.date), ['2026-06-01'], 'no May day in the chart');
    assert.deepEqual(after.monthly.map((r) => r.month), ['2026-06'], 'no May bar in the trend');
    assert.equal(after.monthly[0].gross - before.monthly[0].gross, 641);

    // The same boundary seen from later in the month: the 31 May order never appears.
    const later = await at('2026-06-20T10:00:00');
    assert.ok(total(later, 'month') >= 641, 'the 1 June order is in June');
    assert.equal(later.daily[0].date, '2026-06-01');
  });

  it('October sales are counted, and November compares with October straight away', async () => {
    const NOW = '2026-11-03T10:00:00';
    const before = await at(NOW);
    await order('pending', '2026-10-02T09:00:00', [{ p: grande, qty: 1, price: 55 }]);
    await order('pending', '2026-11-03T08:00:00', [{ p: grande, qty: 1, price: 66 }]);
    const after = await at(NOW);

    // The month is November alone; October is the comparison, not part of the figure.
    assert.equal(after.totals.month.from, '2026-11-01');
    assert.equal(total(after, 'month') - total(before, 'month'), 66);
    const c = after.totals.month.comparison;
    assert.equal(c.available, true, 'October is a full counted month');
    assert.equal(c.previous_from, mnl('2026-10-01T00:00:00').toISOString());
    assert.equal(c.previous_gross - before.totals.month.comparison.previous_gross, 55);
  });

  it('days are Asia/Manila days: 23:59:59 and 00:00 fall either side of midnight', async () => {
    const NOW = '2026-11-03T12:00:00';
    const before = await at(NOW);
    await order('pending', '2026-11-02T23:59:59', [{ p: grande, qty: 1, price: 100 }]);
    await order('pending', '2026-11-03T00:00:00', [{ p: grande, qty: 1, price: 10 }]);
    const after = await at(NOW);

    assert.equal(dayOf(after, '2026-11-02') - dayOf(before, '2026-11-02'), 100);
    assert.equal(dayOf(after, '2026-11-03') - dayOf(before, '2026-11-03'), 10);
    assert.equal(total(after, 'today') - total(before, 'today'), 10);
    // Tuesday 3 Nov: the week (Monday start) holds both.
    assert.equal(after.totals.week.from, '2026-11-02');
    assert.equal(total(after, 'week') - total(before, 'week'), 110);
    // 2026-11-02T23:59:59+08:00 is 15:59:59Z — a UTC day boundary would put both on the 2nd.
    assert.deepEqual(after.daily.map((r) => r.date), ['2026-11-01', '2026-11-02', '2026-11-03']);
  });

  it('the week starts on Monday and the month on the 1st, Manila time', async () => {
    const d = await at('2026-11-12T09:00:00'); // a Thursday
    assert.equal(d.week_starts_on, 'monday');
    assert.equal(d.totals.today.from, '2026-11-12');
    assert.equal(d.totals.week.from, '2026-11-09');
    assert.equal(d.totals.month.from, '2026-11-01');
    assert.equal(d.daily.length, 12, 'one bar per day of the month so far');
    assert.equal(d.daily.at(-1).date, '2026-11-12');
  });

  describe('comparisons — the running period against the WHOLE previous one', () => {
    // 2032, far from every other test's data. Mon 1 Mar 2032 starts a week and a month.
    it('at 00:50 on Tuesday 2 March: yesterday, last week and February are whole and finished', async () => {
      await order('pending', '2032-01-15T09:00:00', [{ p: grande, qty: 1, price: 3000 }]); // January
      await order('pending', '2032-02-18T09:00:00', [{ p: grande, qty: 1, price: 500 }]);  // week of 16 Feb
      await order('pending', '2032-02-23T09:00:00', [{ p: grande, qty: 1, price: 800 }]);  // Mon a week before yesterday
      await order('pending', '2032-02-29T22:00:00', [{ p: grande, qty: 1, price: 200 }]);  // last Sunday, late
      await order('pending', '2032-03-01T10:00:00', [{ p: grande, qty: 1, price: 1000 }]); // yesterday
      await order('pending', '2032-03-02T00:30:00', [{ p: grande, qty: 1, price: 100 }]);  // today so far
      const d = await at('2032-03-02T00:50:00');

      const today = d.totals.today;
      assert.equal(today.in_progress, true);
      assert.equal(today.gross, 100);
      assert.deepEqual(today.previous, {
        available: true, from: '2032-03-01', to: '2032-03-01', gross: 1000, progress_pct: 10,
        verdict: { available: true, from: '2032-02-23', to: '2032-02-23',
          previous_gross: 800, change: 200, change_pct: 25 },
      }, 'all of yesterday, judged against Monday a week earlier');
      // The old like-for-like window (yesterday 00:00–00:50) stays for released app builds.
      assert.equal(today.comparison.previous_gross, 0);
      assert.equal(today.comparison.previous_to, mnl('2032-03-01T00:50:00').toISOString());

      const week = d.totals.week;
      assert.equal(week.from, '2032-03-01');
      assert.equal(week.gross, 1100);
      assert.deepEqual(week.previous, {
        available: true, from: '2032-02-23', to: '2032-02-29', gross: 1000, progress_pct: 110,
        verdict: { available: true, from: '2032-02-16', to: '2032-02-22',
          previous_gross: 500, change: 500, change_pct: 100 },
      }, 'all of last week — Sunday night included — against the week before');
      assert.equal(week.comparison.previous_gross, 800, 'like-for-like: last Monday + 50 minutes');

      const month = d.totals.month;
      assert.equal(month.gross, 1100);
      assert.deepEqual(month.previous, {
        available: true, from: '2032-02-01', to: '2032-02-29', gross: 1500, progress_pct: 73.3,
        verdict: { available: true, from: '2032-01-01', to: '2032-01-31',
          previous_gross: 3000, change: -1500, change_pct: -50 },
      }, 'all of February (a leap year) against January');
    });

    // Thu 1 Jul 2032; Mon 19 Jul starts the week.
    it('mid-period (Wednesday 21 July, 3 PM): the whole previous periods, not just up to now', async () => {
      await order('pending', '2032-05-20T09:00:00', [{ p: grande, qty: 1, price: 1000 }]); // May
      await order('pending', '2032-06-10T09:00:00', [{ p: grande, qty: 1, price: 2000 }]); // June
      await order('pending', '2032-07-06T09:00:00', [{ p: grande, qty: 1, price: 400 }]);  // week of 5 Jul
      await order('pending', '2032-07-13T09:00:00', [{ p: grande, qty: 1, price: 250 }]);  // Tue a week ago
      await order('pending', '2032-07-16T09:00:00', [{ p: grande, qty: 1, price: 350 }]);  // last week
      await order('pending', '2032-07-19T09:00:00', [{ p: grande, qty: 1, price: 75 }]);   // this Monday
      await order('pending', '2032-07-20T14:00:00', [{ p: grande, qty: 1, price: 400 }]);  // yesterday, before 3 PM
      await order('pending', '2032-07-20T23:30:00', [{ p: grande, qty: 1, price: 100 }]);  // yesterday, late
      await order('pending', '2032-07-21T10:00:00', [{ p: grande, qty: 1, price: 125 }]);  // today
      const d = await at('2032-07-21T15:00:00');

      assert.equal(d.totals.today.gross, 125);
      assert.deepEqual(d.totals.today.previous, {
        available: true, from: '2032-07-20', to: '2032-07-20', gross: 500, progress_pct: 25,
        verdict: { available: true, from: '2032-07-13', to: '2032-07-13',
          previous_gross: 250, change: 250, change_pct: 100 },
      }, 'yesterday counts its late order too');
      assert.equal(d.totals.today.comparison.previous_gross, 400, 'like-for-like stops at 3 PM');

      assert.equal(d.totals.week.gross, 700);
      assert.deepEqual(d.totals.week.previous, {
        available: true, from: '2032-07-12', to: '2032-07-18', gross: 600, progress_pct: 116.7,
        verdict: { available: true, from: '2032-07-05', to: '2032-07-11',
          previous_gross: 400, change: 200, change_pct: 50 },
      });

      assert.equal(d.totals.month.gross, 1700);
      assert.deepEqual(d.totals.month.previous, {
        available: true, from: '2032-06-01', to: '2032-06-30', gross: 2000, progress_pct: 85,
        verdict: { available: true, from: '2032-05-01', to: '2032-05-31',
          previous_gross: 1000, change: 1000, change_pct: 100 },
      });
    });

    it('at 00:50 on the 1st (Wednesday 1 September): all of August, and no percent against nothing', async () => {
      await order('pending', '2032-08-03T09:00:00', [{ p: grande, qty: 1, price: 500 }]);
      await order('pending', '2032-08-31T23:00:00', [{ p: grande, qty: 1, price: 1000 }]);
      await order('pending', '2032-09-01T00:10:00', [{ p: grande, qty: 1, price: 30 }]);
      const d = await at('2032-09-01T00:50:00');

      assert.equal(d.totals.month.from, '2032-09-01');
      assert.equal(d.totals.month.gross, 30);
      assert.deepEqual(d.totals.month.previous, {
        available: true, from: '2032-08-01', to: '2032-08-31', gross: 1500, progress_pct: 2,
        verdict: { available: true, from: '2032-07-01', to: '2032-07-31',
          previous_gross: 1700, change: -200, change_pct: -11.8 },
      });
      assert.equal(d.totals.month.comparison.previous_gross, 0, 'like-for-like: 1 August 00:00–00:50');
      // Yesterday (Tue 31 Aug) against Tue 24 Aug, which sold nothing: pesos, no percent.
      assert.deepEqual(d.totals.today.previous.verdict, {
        available: true, from: '2032-08-24', to: '2032-08-24', previous_gross: 0, change: 1000, change_pct: null,
      });
      assert.equal(d.totals.today.previous.progress_pct, 3);
    });

    it('no comparison when the comparator starts before 2026-06-01', async () => {
      const avail = (d, key) => [d.totals[key].previous.available, d.totals[key].previous.verdict?.available ?? false];

      const first = await at('2026-06-01T10:00:00'); // Monday the 1st
      for (const key of ['today', 'week', 'month']) {
        assert.deepEqual(avail(first, key), [false, false], `${key}: nothing before 1 June`);
        assert.equal(first.totals[key].comparison.available, false);
      }
      assert.deepEqual(first.selected_month.previous, { available: false, month: '2026-05' });

      const tue = await at('2026-06-02T10:00:00');
      assert.deepEqual(avail(tue, 'today'), [true, false], 'yesterday is 1 June; Monday 25 May is not counted');
      assert.deepEqual(avail(tue, 'week'), [false, false], 'last week began 25 May');

      const nextTue = await at('2026-06-09T10:00:00');
      assert.deepEqual(avail(nextTue, 'today'), [true, true], 'Monday 8 June against Monday 1 June');
      assert.deepEqual(avail(nextTue, 'week'), [true, false], 'last week is 1–7 June; the week before is May');

      const third = await at('2026-06-15T10:00:00');
      assert.deepEqual(avail(third, 'week'), [true, true], '8–14 June against 1–7 June');
      assert.deepEqual(avail(third, 'month'), [false, false]);

      const july = await at('2026-07-01T10:00:00');
      assert.deepEqual(avail(july, 'month'), [true, false], 'July runs against June; June has no May');
      const aug = await at('2026-08-01T10:00:00');
      assert.deepEqual(avail(aug, 'month'), [true, true], 'July against June');
    });
  });

  describe('the month being viewed (?month=YYYY-MM)', () => {
    it('a past month is finished: every day, its best sellers, its own 14-day slow-mover window and a verdict', async () => {
      // July 2032's orders come from the mid-period test above: 1,700 against June's 2,000.
      const d = await computeSalesDashboard(db, { now: mnl('2032-09-01T00:50:00'), month: '2032-07' });
      assert.deepEqual(d.selected_month, {
        month: '2032-07', from: '2032-07-01', to: '2032-07-31', in_progress: false, gross: 1700,
        verdict: { available: true, month: '2032-06', previous_gross: 2000, change: -300, change_pct: -15 },
      });
      assert.equal(d.daily.length, 31, 'the whole month, not up to today');
      assert.equal(d.daily.reduce((n, r) => n + r.gross, 0), 1700);
      assert.equal(d.top_products.length, 1);
      assert.equal(d.top_products[0].product_id, grande.id);
      assert.equal(d.top_products[0].gross, 1700);
      assert.deepEqual([d.slow_movers.from, d.slow_movers.to, d.slow_movers.days, d.slow_movers.clamped],
        ['2032-07-18', '2032-07-31', 14, false]);
      assert.equal(d.slow_movers.products.some((p) => p.id === grande.id), false, 'it sold on 19–21 July');
      // The totals stay on the real today, whichever month is viewed.
      assert.equal(d.totals.month.from, '2032-09-01');
    });

    it('the current month is in progress: up to today, measured against all of last month', async () => {
      const d = await computeSalesDashboard(db, { now: mnl('2032-07-21T15:00:00'), month: '2032-07' });
      assert.deepEqual(d.selected_month, {
        month: '2032-07', from: '2032-07-01', to: '2032-07-21', in_progress: true, gross: 1700,
        previous: { available: true, month: '2032-06', gross: 2000, progress_pct: 85 },
      });
      assert.equal(d.daily.length, 21);
      assert.equal(d.daily.at(-1).date, '2032-07-21');
      const dflt = await at('2032-07-21T15:00:00');
      assert.deepEqual(dflt.selected_month, d.selected_month, 'no month means this month');
      assert.deepEqual(dflt.daily, d.daily);
    });

    it('June 2026, the first month, has no month before it to be judged against', async () => {
      const d = await computeSalesDashboard(db, { now: mnl('2026-11-10T00:50:00'), month: '2026-06' });
      assert.equal(d.selected_month.in_progress, false);
      assert.deepEqual(d.selected_month.verdict, { available: false, month: '2026-05' });
      assert.equal(d.daily[0].date, '2026-06-01');
      assert.equal(d.daily.length, 30);
      assert.deepEqual([d.slow_movers.from, d.slow_movers.to], ['2026-06-17', '2026-06-30']);
    });

    it('refuses a month before June 2026, after the current month, or not shaped YYYY-MM', () => {
      const now = mnl('2026-11-10T00:50:00');
      assert.equal(resolveMonth(undefined, now), '2026-11');
      assert.equal(resolveMonth('2026-06', now), '2026-06');
      assert.equal(resolveMonth('2026-11', now), '2026-11');
      for (const bad of ['2026-05', '2026-12', '2027-01', '2026-13', '2026-6', 'june', ['2026-07']]) {
        assert.throws(() => resolveMonth(bad, now), (err) => err.status === 400, String(bad));
      }
      // The current month is Manila's: 23:30 UTC on 31 Oct is already 1 November there.
      assert.equal(resolveMonth('2026-11', new Date('2026-10-31T23:30:00Z')), '2026-11');
    });
  });

  describe('by-month trend', () => {
    it('one row per month from June 2026 to now, the last one in progress', async () => {
      const NOW = '2026-08-15T10:00:00';
      const before = await at(NOW);
      await order('pending', '2026-06-30T23:59:00', [{ p: grande, qty: 1, price: 70 }]);
      await order('pending', '2026-07-01T00:00:00', [{ p: grande, qty: 1, price: 80 }]);
      await order('cancelled', '2026-07-02T09:00:00', [{ p: grande, qty: 1, price: 9000 }]);
      await order('pending', '2026-08-15T09:00:00', [{ p: grande, qty: 1, price: 90 }]);
      await order('pending', '2026-08-16T09:00:00', [{ p: grande, qty: 1, price: 9000 }]); // tomorrow
      const after = await at(NOW);

      assert.deepEqual(after.monthly.map((r) => [r.month, r.from, r.in_progress]), [
        ['2026-06', '2026-06-01', false], ['2026-07', '2026-07-01', false], ['2026-08', '2026-08-01', true],
      ]);
      assert.deepEqual(after.monthly.map((r, i) => r.gross - before.monthly[i].gross), [70, 80, 90]);
      assert.equal(after.monthly.at(-1).gross, total(after, 'month'), 'the running month matches its card');
    });

    it('keeps growing a bar a month', async () => {
      const d = await at('2032-09-01T00:50:00');
      assert.equal(d.monthly.length, 6 * 12 + 4, 'June 2026 to September 2032');
      assert.equal(d.monthly[0].month, '2026-06');
      assert.deepEqual(d.monthly.at(-1), { month: '2032-09', from: '2032-09-01', gross: 30, in_progress: true });
      assert.equal(d.monthly.find((r) => r.month === '2032-07').gross, 1700);
      assert.equal(d.monthly.filter((r) => r.in_progress).length, 1);
    });
  });

  describe('legacy like-for-like comparison (read by app builds released before 2026-11-10)', () => {
    it('today compares with yesterday up to the same Manila time of day', async () => {
      const NOW = '2026-11-10T10:00:00';
      const before = await at(NOW);
      await order('pending', '2026-11-09T09:59:00', [{ p: grande, qty: 1, price: 200 }]); // counts
      await order('pending', '2026-11-09T10:01:00', [{ p: grande, qty: 1, price: 5000 }]); // later in the day: no
      await order('pending', '2026-11-10T08:00:00', [{ p: grande, qty: 1, price: 300 }]);
      const after = await at(NOW);

      const c = after.totals.today.comparison;
      assert.equal(c.available, true);
      assert.equal(c.previous_from, mnl('2026-11-09T00:00:00').toISOString());
      assert.equal(c.previous_to, mnl('2026-11-09T10:00:00').toISOString());
      assert.equal(c.previous_gross - before.totals.today.comparison.previous_gross, 200);
      assert.equal(c.change, total(after, 'today') - c.previous_gross);
    });

    it('this week compares with last week up to the same weekday and time', async () => {
      const NOW = '2026-11-10T10:00:00'; // Tuesday; last week = Mon 2 Nov 00:00 → Tue 3 Nov 10:00
      const before = await at(NOW);
      await order('pending', '2026-11-03T09:59:00', [{ p: grande, qty: 1, price: 70 }]);  // counts
      await order('pending', '2026-11-03T10:01:00', [{ p: grande, qty: 1, price: 900 }]); // no
      await order('pending', '2026-11-04T08:00:00', [{ p: grande, qty: 1, price: 900 }]); // no
      const after = await at(NOW);

      const c = after.totals.week.comparison;
      assert.equal(c.available, true);
      assert.equal(c.previous_from, mnl('2026-11-02T00:00:00').toISOString());
      assert.equal(c.previous_to, mnl('2026-11-03T10:00:00').toISOString());
      assert.equal(c.previous_gross - before.totals.week.comparison.previous_gross, 70);
    });

    it('this month compares with last month up to the same day and time', async () => {
      const NOW = '2026-12-10T10:00:00';
      const before = await at(NOW);
      await order('pending', '2026-11-10T09:59:00', [{ p: grande, qty: 1, price: 40 }]);  // counts
      await order('pending', '2026-11-10T10:01:00', [{ p: grande, qty: 1, price: 800 }]); // no
      await order('pending', '2026-12-02T08:00:00', [{ p: grande, qty: 1, price: 60 }]);
      const after = await at(NOW);

      const c = after.totals.month.comparison;
      assert.equal(c.available, true);
      assert.equal(c.previous_from, mnl('2026-11-01T00:00:00').toISOString());
      assert.equal(c.previous_to, mnl('2026-11-10T10:00:00').toISOString());
      assert.equal(c.previous_gross - before.totals.month.comparison.previous_gross, 40);
      assert.equal(total(after, 'month') - total(before, 'month'), 60);
    });

    it('a longer month compares with ALL of a shorter one, never spilling into this month', async () => {
      const c = (await at('2027-03-31T10:00:00')).totals.month.comparison;
      assert.equal(c.previous_from, mnl('2027-02-01T00:00:00').toISOString());
      assert.equal(c.previous_to, mnl('2027-03-01T00:00:00').toISOString());
    });

    it('percent change is withheld against an empty previous period', async () => {
      // Far from any other suite's data: nothing yesterday, one sale today.
      const NOW = '2031-08-12T10:00:00';
      const before = await at(NOW);
      assert.equal(before.totals.today.comparison.previous_gross, 0);
      await order('pending', '2031-08-12T09:00:00', [{ p: grande, qty: 1 }]);
      const c = (await at(NOW)).totals.today.comparison;
      assert.equal(c.change, 641);
      assert.equal(c.change_pct, null);
    });

    it('percent change is rounded to one decimal place', async () => {
      const NOW = '2031-09-16T10:00:00';
      await order('pending', '2031-09-15T09:00:00', [{ p: grande, qty: 1, price: 300 }]);
      await order('pending', '2031-09-16T09:00:00', [{ p: grande, qty: 1, price: 200 }]);
      const c = (await at(NOW)).totals.today.comparison;
      assert.equal(c.previous_gross, 300);
      assert.equal(c.change, -100);
      assert.equal(c.change_pct, -33.3);
    });
  });

  describe('products', () => {
    it('top 10 this month by gross sales, with cases sold', async () => {
      const NOW = '2031-05-20T10:00:00';
      const ps = [];
      for (let i = 1; i <= 12; i += 1) ps.push(await product(`TEST_DASH Top ${String(i).padStart(2, '0')}`));
      // Gross descends with i; Top 04 and Top 05 tie on gross and split on cases.
      const plan = [
        [ps[0], 1, 5000], [ps[1], 2, 2000], [ps[2], 3, 1000],
        [ps[3], 2, 450],  [ps[4], 3, 300],  // both ₱900; Top 05 has more cases
        [ps[5], 1, 800],  [ps[6], 1, 700],  [ps[7], 1, 600], [ps[8], 1, 500],
        [ps[9], 1, 400],  [ps[10], 1, 300],
      ];
      for (const [p, qty, price] of plan) await order('pending', '2031-05-10T09:00:00', [{ p, qty, price }]);
      // Top 12 sold big — but last month, and in a cancelled order this month.
      await order('pending', '2031-04-30T23:00:00', [{ p: ps[11], qty: 100, price: 1000 }]);
      await order('cancelled', '2031-05-11T09:00:00', [{ p: ps[11], qty: 100, price: 1000 }]);

      const d = await at(NOW);
      const names = d.top_products.map((r) => r.name.replace(` ${RUN}`, ''));
      assert.deepEqual(names, [
        'TEST_DASH Top 01', 'TEST_DASH Top 02', 'TEST_DASH Top 03',
        'TEST_DASH Top 05', 'TEST_DASH Top 04',
        'TEST_DASH Top 06', 'TEST_DASH Top 07', 'TEST_DASH Top 08', 'TEST_DASH Top 09', 'TEST_DASH Top 10',
      ]);
      assert.deepEqual(d.top_products[0], {
        product_id: ps[0].id, name: ps[0].name, sku: null, unit: 'cs', cases: 1, gross: 5000,
      });
      assert.equal(d.top_products[3].cases, 3);
      assert.equal(d.top_products[3].gross, 900);
    });

    it('top products count a returned-bottle line at full price', async () => {
      const NOW = '2031-06-05T10:00:00';
      await order('done', '2031-06-02T09:00:00', [{ p: grande, qty: 1.5, returned: 9 }]);
      const d = await at(NOW);
      const row = d.top_products.find((r) => r.product_id === grande.id);
      assert.equal(row.cases, 1.5);
      assert.equal(row.gross, 961.5);
    });

    it('slow movers: active products with no counted sale in the last 14 Manila days', async () => {
      const NOW = '2031-07-20T10:00:00'; // window 7 Jul 00:00 → today
      const inside = await product('TEST_DASH Slow inside');
      const justOut = await product('TEST_DASH Slow just-out');
      const never = await product('TEST_DASH Slow never');
      const inactive = await product('TEST_DASH Slow inactive', { active: false });
      const cancelledOnly = await product('TEST_DASH Slow cancelled-only');
      const draftOnly = await product('TEST_DASH Slow draft-only');

      await order('pending', '2031-07-07T00:00:00', [{ p: inside, qty: 1 }]);
      await order('pending', '2031-07-06T23:59:59', [{ p: justOut, qty: 1 }]);
      await order('cancelled', '2031-07-10T09:00:00', [{ p: cancelledOnly, qty: 1 }]);
      await order('draft', '2031-07-10T09:00:00', [{ p: draftOnly, qty: 1 }]);

      const d = await at(NOW);
      assert.deepEqual(
        [d.slow_movers.from, d.slow_movers.to, d.slow_movers.days, d.slow_movers.clamped],
        ['2031-07-07', '2031-07-20', 14, false]
      );
      const slow = new Set(d.slow_movers.products.map((p) => p.id));
      assert.equal(slow.has(inside.id), false, 'sold on the window\'s first Manila day');
      assert.equal(slow.has(justOut.id), true, 'last sold one second before the window');
      assert.equal(slow.has(never.id), true);
      assert.equal(slow.has(inactive.id), false, 'inactive products are not listed');
      assert.equal(slow.has(cancelledOnly.id), true, 'a cancelled order is not a sale');
      assert.equal(slow.has(draftOnly.id), true, 'a draft is not a sale');
    });

    it('slow-mover window is clamped to 2026-06-01 until 14 days of history exist', async () => {
      const early = await at('2026-06-05T10:00:00');
      assert.deepEqual(
        [early.slow_movers.from, early.slow_movers.days, early.slow_movers.clamped],
        ['2026-06-01', 5, true]
      );
      const full = await at('2026-06-14T10:00:00');
      assert.deepEqual([full.slow_movers.from, full.slow_movers.days, full.slow_movers.clamped],
        ['2026-06-01', 14, false]);
      const nov = await at('2026-11-09T10:00:00');
      assert.deepEqual([nov.slow_movers.from, nov.slow_movers.days, nov.slow_movers.clamped],
        ['2026-10-27', 14, false]);
    });

    it('a product sold only before 2026-06-01 still counts as a slow mover', async () => {
      const old = await product('TEST_DASH Slow pre-cutoff');
      await order('pending', '2026-05-31T23:59:00', [{ p: old, qty: 1 }]);
      const d = await at('2026-06-05T10:00:00');
      assert.equal(new Set(d.slow_movers.products.map((p) => p.id)).has(old.id), true,
        'a May sale is outside the counted history');
    });
  });

  describe('GET /api/v1/dashboard', () => {
    let server;
    let baseUrl;
    let token;

    before(async () => {
      const { rows: [user] } = await db.query(
        `SELECT id, email, full_name, role FROM users WHERE is_active = TRUE ORDER BY id LIMIT 1`);
      token = jwt.sign({ id: user.id, email: user.email, role: user.role, full_name: user.full_name },
        process.env.JWT_SECRET);
      const app = express();
      app.use(express.json());
      app.use(cookieParser());
      app.use('/api/v1/dashboard', dashboardRoutes);
      app.use(errorHandler);
      server = http.createServer(app);
      await new Promise((resolve) => server.listen(0, resolve));
      baseUrl = `http://localhost:${server.address().port}/api/v1/dashboard`;
    });

    after(async () => { if (server) await new Promise((resolve) => server.close(resolve)); });

    it('answers sales and products only — the old counters and order list are gone', async () => {
      const res = await fetch(baseUrl, { headers: { Authorization: `Bearer ${token}` } });
      assert.equal(res.status, 200);
      const body = await res.json();
      for (const k of ['as_of', 'totals', 'daily', 'top_products', 'slow_movers', 'low_stock']) {
        assert.ok(k in body, `has ${k}`);
      }
      assert.equal(body.sales_start, '2026-06-01');
      assert.equal('orders' in body, false);
      assert.equal('summary' in body, false);
      // The fields an app build released before 2026-11-10 reads keep their shape.
      for (const key of ['today', 'week', 'month']) {
        assert.equal(typeof body.totals[key].gross, 'number');
        assert.equal(typeof body.totals[key].comparison.available, 'boolean');
      }
      assert.ok(Array.isArray(body.daily) && Array.isArray(body.top_products));
      assert.ok(Array.isArray(body.slow_movers.products) && Array.isArray(body.low_stock));
      // And the new ones sit beside them.
      assert.equal(body.monthly[0].month, '2026-06');
      assert.equal(body.monthly.at(-1).in_progress, true);
      assert.equal(body.selected_month.month, body.monthly.at(-1).month);
    });

    it('?month= picks a past month', async () => {
      const res = await fetch(`${baseUrl}?month=2026-06`, { headers: { Authorization: `Bearer ${token}` } });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.selected_month.month, '2026-06');
      assert.equal(body.selected_month.in_progress, false);
      assert.equal(body.daily[0].date, '2026-06-01');
      assert.equal(body.daily.length, 30);
    });

    for (const bad of ['2026-05', '2099-01', '2026-13', 'june', '2026-6']) {
      it(`?month=${bad} is a 400`, async () => {
        const res = await fetch(`${baseUrl}?month=${bad}`, { headers: { Authorization: `Bearer ${token}` } });
        assert.equal(res.status, 400);
        assert.match((await res.json()).error, /month|counted|started/);
      });
    }

    it('still requires a signed-in account', async () => {
      const res = await fetch(baseUrl);
      assert.equal(res.status, 401);
    });
  });
});
