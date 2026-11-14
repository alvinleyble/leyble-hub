// The Dashboard's sales and product figures (captain's grill, 2026-11-09; comparisons
// and history reworked 2026-11-10).
//
// Every figure here rests on the same definition of a sale, and it is easy to get
// wrong, so it lives in one place:
//
//  * A SALE is every order except `draft` and `cancelled`. Pending counts: staff
//    create an order, print it and stop, so nearly every real sale stays pending.
//    It is dated by `orders.created_at` (the device's sale time), never by a later
//    status change.
//  * Nothing created before SALES_START (Asia/Manila) counts, anywhere.
//  * A line is worth `quantity × unit_price`, and nothing else. The stored
//    `unit_price` is the LISTED case price, which already includes every bottle's
//    deposit (Red Horse Grande 1L: unit_price 641 = 614 goods + 6 × 4.50). The
//    separately stored `unit_deposit_fee` is only what the close flow credits back
//    when bottles come home, so adding it again would count the deposit twice
//    (641 → 668), and reading the post-close `line_total`/`total_amount` would let
//    returned bottles shrink a sale (641 → 614). Returns never reduce a sales figure.
//  * Days, weeks and months are Asia/Manila calendar periods. A week starts on
//    MONDAY (Postgres `date_trunc('week')`, ISO). A period that starts before
//    SALES_START counts only from SALES_START.
//
// How a period is compared (captain, 2026-11-14). A period still running is never
// given a verdict: it is shown IN PROGRESS, as a share of the WHOLE previous period
// (today against all of yesterday, this week against all of last week, this month
// against all of last month). The up/down verdict belongs to the last FINISHED
// period, judged against its own comparator:
//   yesterday  vs the day before yesterday (every day, including Sundays),
//   last week  vs the week before,
//   last month vs the month before.
// A comparison whose comparator starts before SALES_START is not made at all.
//
// Everything is computed here, on the server, in five independent aggregate queries
// run side by side (each is one round trip, and the API sits ~200ms from the DB).

const SALES_START = '2026-06-01';
const TZ = 'Asia/Manila';
const TZ_OFFSET_MS = 8 * 60 * 60 * 1000; // Manila is UTC+8 all year (no DST)
const SLOW_MOVER_DAYS = 14;
const TOP_PRODUCTS = 10;

// The shared preamble. $1 = "now" (timestamptz), $2 = SALES_START (date), $3 = the
// first day of the month being viewed (date). `day(d)` below is
// `(d::timestamp AT TIME ZONE '${TZ}')` — the instant a Manila calendar day begins.
const BOUNDS = `
  b AS (
    SELECT $1::timestamptz AS now_ts,
           $2::date        AS cutoff,
           ($1::timestamptz AT TIME ZONE '${TZ}')::date                       AS today,
           date_trunc('week',  $1::timestamptz AT TIME ZONE '${TZ}')::date    AS week_start,
           date_trunc('month', $1::timestamptz AT TIME ZONE '${TZ}')::date    AS month_start,
           $3::date                                                           AS sel_start,
           ($3::date + INTERVAL '1 month')::date                              AS sel_end
  )`;

// Order lines that count as sales, from SALES_START on. Callers narrow by created_at.
const SALE_LINES = `
  sale_lines AS (
    SELECT o.created_at, o.id AS order_id,
           oi.product_id,
           oi.quantity,
           oi.quantity * oi.unit_price AS value
    FROM orders o
    JOIN order_items oi ON oi.order_id = o.id
    CROSS JOIN b
    WHERE o.status NOT IN ('draft', 'cancelled')
      AND o.created_at >= (b.cutoff::timestamp AT TIME ZONE '${TZ}')
  )`;

const day = (expr) => `((${expr})::timestamp AT TIME ZONE '${TZ}')`;

// Today / this week / this month. For each, four [from, to) windows:
//   cur   the period so far (never past the end of today: a device clock running
//         ahead must not book a sale into a day that has not happened);
//   prev  the WHOLE previous period — yesterday, last week, last month. It is both
//         what the running period is measured against and the last finished period;
//   cmp   what that finished period is judged against — the day before for
//         yesterday, the week before for last week, the month before for last month;
//   like  the previous period up to the same point — the old like-for-like window,
//         kept only for `comparison`, which app builds released before 2026-11-10 read.
const TOTALS_SQL = `
  WITH ${BOUNDS},
  periods AS (
    SELECT 'today' AS key, today AS cur_start, today + 1 AS cur_end,
           today - 1 AS prev_start, today AS prev_end,
           today - 2 AS cmp_start,  today - 1 AS cmp_end
    FROM b
    UNION ALL
    SELECT 'week', week_start, week_start + 7, week_start - 7, week_start,
           week_start - 14, week_start - 7
    FROM b
    UNION ALL
    SELECT 'month', month_start, (month_start + INTERVAL '1 month')::date,
           (month_start - INTERVAL '1 month')::date, month_start,
           (month_start - INTERVAL '2 months')::date, (month_start - INTERVAL '1 month')::date
    FROM b
  ),
  windows AS (
    SELECT p.*,
           GREATEST(p.cur_start, b.cutoff)                     AS from_date,
           ${day('GREATEST(p.cur_start, b.cutoff)')}           AS cur_from,
           LEAST(${day('p.cur_end')}, ${day('b.today + 1')})   AS cur_to,
           p.prev_start >= b.cutoff                            AS has_prev,
           p.cmp_start  >= b.cutoff                            AS has_cmp,
           ${day('p.prev_start')}                              AS prev_from,
           ${day('p.prev_end')}                                AS prev_to,
           ${day('p.cmp_start')}                               AS cmp_from,
           ${day('p.cmp_end')}                                 AS cmp_to,
           LEAST(${day('p.prev_start')} + (b.now_ts - ${day('p.cur_start')}),
                 ${day('p.cur_start')})                        AS like_to
    FROM periods p CROSS JOIN b
  ),
  ${SALE_LINES},
  sums AS (
    SELECT w.key,
           COALESCE(SUM(s.value) FILTER (WHERE s.created_at >= w.cur_from  AND s.created_at < w.cur_to),  0) AS gross,
           COALESCE(SUM(s.value) FILTER (WHERE s.created_at >= w.prev_from AND s.created_at < w.prev_to), 0) AS prev_gross,
           COALESCE(SUM(s.value) FILTER (WHERE s.created_at >= w.cmp_from  AND s.created_at < w.cmp_to),  0) AS cmp_gross,
           COALESCE(SUM(s.value) FILTER (WHERE s.created_at >= w.prev_from AND s.created_at < w.like_to), 0) AS like_gross
    FROM windows w
    LEFT JOIN sale_lines s ON s.created_at >= w.cmp_from AND s.created_at < w.cur_to
    GROUP BY w.key
  )
  SELECT w.key,
         to_char(w.from_date, 'YYYY-MM-DD')        AS from_date,
         w.has_prev, w.has_cmp,
         to_char(w.prev_start, 'YYYY-MM-DD')       AS prev_start,
         to_char(w.prev_end - 1, 'YYYY-MM-DD')     AS prev_last,
         to_char(w.cmp_start, 'YYYY-MM-DD')        AS cmp_start,
         to_char(w.cmp_end - 1, 'YYYY-MM-DD')      AS cmp_last,
         w.prev_from, w.like_to,
         s.gross, s.prev_gross, s.cmp_gross, s.like_gross
  FROM windows w JOIN sums s USING (key)`;

// One row per Manila day of the month being viewed, from its first counted day to
// its last day — or to today, for the month still running.
const DAILY_SQL = `
  WITH ${BOUNDS},
  ${SALE_LINES},
  rng AS (
    SELECT GREATEST(b.sel_start, b.cutoff) AS first_day,
           LEAST(b.sel_end - 1, b.today)   AS last_day
    FROM b
  ),
  days AS (
    SELECT d::date AS d
    FROM rng, generate_series(rng.first_day, rng.last_day, INTERVAL '1 day') AS d
  ),
  per_day AS (
    SELECT (s.created_at AT TIME ZONE '${TZ}')::date AS d, SUM(s.value) AS gross
    FROM sale_lines s CROSS JOIN rng
    WHERE s.created_at >= ${day('rng.first_day')}
      AND s.created_at <  ${day('rng.last_day + 1')}
    GROUP BY 1
  )
  SELECT to_char(days.d, 'YYYY-MM-DD') AS date, COALESCE(per_day.gross, 0) AS gross
  FROM days LEFT JOIN per_day ON per_day.d = days.d
  ORDER BY days.d`;

// Aggregate the viewed month once, then select each true top 10 in SQL. Keep the
// old gross/cases/name ranking separately: installed builds depend on top_products.
// New ties use the other measures before name (and id for identical names).
const TOP_SQL = `
  WITH ${BOUNDS},
  ${SALE_LINES},
  aggregates AS (
    SELECT p.id AS product_id, p.name, p.sku, p.unit,
           SUM(s.quantity) AS cases,
           SUM(s.value)    AS gross,
           COUNT(DISTINCT s.order_id) AS orders
    FROM sale_lines s
    JOIN products p ON p.id = s.product_id
    CROSS JOIN b
    WHERE s.created_at >= ${day('GREATEST(b.sel_start, b.cutoff)')}
      AND s.created_at <  ${day('LEAST(b.sel_end, b.today + 1)')}
    GROUP BY p.id, p.name, p.sku, p.unit
  ), ranked AS (
    SELECT *,
      ROW_NUMBER() OVER (ORDER BY gross DESC, cases DESC, name ASC, product_id) AS legacy_rank,
      ROW_NUMBER() OVER (ORDER BY cases DESC, gross DESC, orders DESC, name ASC, product_id) AS cases_rank,
      ROW_NUMBER() OVER (ORDER BY gross DESC, cases DESC, orders DESC, name ASC, product_id) AS sales_rank,
      ROW_NUMBER() OVER (ORDER BY orders DESC, cases DESC, gross DESC, name ASC, product_id) AS orders_rank
    FROM aggregates
  )
  SELECT * FROM ranked
  WHERE LEAST(legacy_rank, cases_rank, sales_rank, orders_rank) <= ${TOP_PRODUCTS}`;

// Active products with no counted sale in the 14 Manila days ending on the viewed
// month's last day — or ending today, for the month still running — clamped to
// SALES_START until that much history exists.
const SLOW_SQL = `
  WITH ${BOUNDS},
  ${SALE_LINES},
  win0 AS (SELECT LEAST(b.sel_end - 1, b.today) AS to_date, b.cutoff FROM b),
  win AS (
    SELECT GREATEST(to_date - ${SLOW_MOVER_DAYS - 1}, cutoff) AS from_date,
           to_date - ${SLOW_MOVER_DAYS - 1} < cutoff         AS clamped,
           to_date
    FROM win0
  ),
  sold AS (
    SELECT DISTINCT s.product_id
    FROM sale_lines s CROSS JOIN win
    WHERE s.created_at >= ${day('win.from_date')}
      AND s.created_at <  ${day('win.to_date + 1')}
  )
  SELECT to_char(win.from_date, 'YYYY-MM-DD') AS from_date,
         to_char(win.to_date, 'YYYY-MM-DD')   AS to_date,
         GREATEST(win.to_date - win.from_date + 1, 0) AS days,
         win.clamped,
         p.id, p.name, p.sku, p.category, p.unit
  FROM win
  LEFT JOIN products p
    ON p.is_active = TRUE
   AND NOT EXISTS (SELECT 1 FROM sold WHERE sold.product_id = p.id)
  ORDER BY p.name ASC NULLS LAST`;

// One row per month from the start month to the current one (the trend chart). It
// also carries the viewed month's total and the month before it, for that verdict.
const MONTHLY_SQL = `
  WITH ${BOUNDS},
  ${SALE_LINES},
  months AS (
    SELECT m::date AS m
    FROM b, generate_series(date_trunc('month', b.cutoff)::date, b.month_start, INTERVAL '1 month') AS m
  ),
  per_month AS (
    SELECT date_trunc('month', s.created_at AT TIME ZONE '${TZ}')::date AS m, SUM(s.value) AS gross
    FROM sale_lines s CROSS JOIN b
    WHERE s.created_at < ${day('b.today + 1')}
    GROUP BY 1
  )
  SELECT to_char(months.m, 'YYYY-MM')                        AS month,
         to_char(GREATEST(months.m, b.cutoff), 'YYYY-MM-DD')  AS from_date,
         months.m >= b.cutoff                                 AS whole,
         COALESCE(per_month.gross, 0)                         AS gross,
         months.m = b.month_start                             AS in_progress
  FROM months CROSS JOIN b
  LEFT JOIN per_month ON per_month.m = months.m
  ORDER BY months.m`;

const money = (v) => Math.round(Number(v) * 100) / 100;
// One decimal place, and never a percentage of nothing.
const pctOf = (part, whole) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);

function change(current, previous) {
  const delta = money(current - previous);
  return { previous_gross: previous, change: delta, change_pct: pctOf(delta, previous) };
}

// The old like-for-like comparison, unchanged, for app builds released before the
// 2026-11-10 rework: they word it "vs yesterday so far (₱X)", which is only true of
// this window. The current screen reads `previous` instead.
function legacyComparison(row) {
  if (!row.has_prev) return { available: false };
  return {
    available: true,
    previous_from: new Date(row.prev_from).toISOString(),
    previous_to: new Date(row.like_to).toISOString(),
    ...change(money(row.gross), money(row.like_gross)),
  };
}

function periodTotal(row) {
  const gross = money(row.gross);
  const previous = { available: row.has_prev, from: row.prev_start, to: row.prev_last };
  if (row.has_prev) {
    previous.gross = money(row.prev_gross);
    previous.progress_pct = pctOf(gross, previous.gross);
    previous.verdict = row.has_cmp
      ? { available: true, from: row.cmp_start, to: row.cmp_last, ...change(previous.gross, money(row.cmp_gross)) }
      : { available: false, from: row.cmp_start, to: row.cmp_last };
  }
  return {
    from: row.from_date,
    gross,
    comparison: legacyComparison(row),
    in_progress: true,
    // The whole previous period: the running period's yardstick, and also the last
    // finished period, carrying its own up/down verdict.
    previous,
  };
}

function badMonth(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

function manilaDate(now) {
  return new Date(now.getTime() + TZ_OFFSET_MS).toISOString().slice(0, 10);
}

function shiftMonth(ym, delta) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + delta, 1)).toISOString().slice(0, 7);
}

/**
 * The month whose days, best sellers and slow movers are shown: `YYYY-MM`, from the
 * start month to the current Manila month. Absent means the current month. Anything
 * else throws an error carrying status 400.
 */
function resolveMonth(month, now) {
  const current = manilaDate(now).slice(0, 7);
  if (month === undefined || month === null || month === '') return current;
  if (typeof month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    throw badMonth('month must be YYYY-MM');
  }
  const first = SALES_START.slice(0, 7);
  if (month < first) throw badMonth(`Sales are counted from ${SALES_START}; there is no month before ${first}`);
  if (month > current) throw badMonth(`${month} has not started yet`);
  return month;
}

function selectedMonth(monthly, month, daily) {
  const i = monthly.findIndex((r) => r.month === month);
  const row = monthly[i];
  const before = monthly[i - 1];
  const prevMonth = shiftMonth(month, -1);
  // A comparator that starts before SALES_START is no comparison: June has no May.
  const hasPrev = Boolean(before && before.whole);
  const prevGross = hasPrev ? money(before.gross) : null;
  const out = {
    month,
    from: row.from_date,
    to: daily.length ? daily[daily.length - 1].date : row.from_date,
    in_progress: row.in_progress,
    gross: money(row.gross),
  };
  if (row.in_progress) {
    out.previous = hasPrev
      ? { available: true, month: prevMonth, gross: prevGross, progress_pct: pctOf(out.gross, prevGross) }
      : { available: false, month: prevMonth };
  } else {
    out.verdict = hasPrev
      ? { available: true, month: prevMonth, ...change(out.gross, prevGross) }
      : { available: false, month: prevMonth };
  }
  return out;
}

/**
 * @param {{ query: Function }} db
 * @param {{ now?: Date, month?: string }} [opts]  `now` is a test seam; the route
 *   always passes the real time. `month` is the request's `?month=YYYY-MM`.
 */
async function computeSalesDashboard(db, { now = new Date(), month } = {}) {
  const viewed = resolveMonth(month, now);
  const params = [now.toISOString(), SALES_START, `${viewed}-01`];
  const [totals, daily, top, slow, monthly] = await Promise.all([
    db.query(TOTALS_SQL, params),
    db.query(DAILY_SQL, params),
    db.query(TOP_SQL, params),
    db.query(SLOW_SQL, params),
    db.query(MONTHLY_SQL, params),
  ]);

  const byKey = Object.fromEntries(totals.rows.map((r) => [r.key, periodTotal(r)]));
  const dailyRows = daily.rows.map((r) => ({ date: r.date, gross: money(r.gross) }));
  const slowHead = slow.rows[0];
  const topList = (rank, withOrders = true) => top.rows
    .filter((r) => Number(r[rank]) <= TOP_PRODUCTS)
    .sort((a, b) => Number(a[rank]) - Number(b[rank]))
    .map((r) => ({
      product_id: r.product_id, name: r.name, sku: r.sku, unit: r.unit,
      cases: Number(r.cases), gross: money(r.gross),
      ...(withOrders ? { orders: Number(r.orders) } : {}),
    }));
  return {
    as_of: now.toISOString(),
    today: manilaDate(now),
    sales_start: SALES_START,
    week_starts_on: 'monday',
    totals: { today: byKey.today, week: byKey.week, month: byKey.month },
    // The month that `daily`, `top_products` and `slow_movers` describe.
    selected_month: selectedMonth(monthly.rows, viewed, dailyRows),
    daily: dailyRows,
    top_products: topList('legacy_rank', false),
    top_products_by: {
      cases: topList('cases_rank'),
      sales: topList('sales_rank'),
      orders: topList('orders_rank'),
    },
    slow_movers: {
      from: slowHead.from_date,
      to: slowHead.to_date,
      days: Number(slowHead.days),
      clamped: slowHead.clamped,
      products: slow.rows.filter((r) => r.id != null).map((r) => ({
        id: r.id, name: r.name, sku: r.sku, category: r.category, unit: r.unit,
      })),
    },
    // One row per month from the start month to now; the last is still running.
    monthly: monthly.rows.map((r) => ({
      month: r.month, from: r.from_date, gross: money(r.gross), in_progress: r.in_progress,
    })),
  };
}

module.exports = {
  computeSalesDashboard, resolveMonth, SALES_START, SLOW_MOVER_DAYS, TOP_PRODUCTS,
};
