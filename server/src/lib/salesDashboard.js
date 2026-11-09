// The Dashboard's sales and product figures (captain's grill, 2026-11-09).
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
// Everything is computed here, on the server, in four independent aggregate queries
// run side by side (each is one round trip, and the API sits ~200ms from the DB).

const SALES_START = '2026-11-01';
const TZ = 'Asia/Manila';
const SLOW_MOVER_DAYS = 14;
const TOP_PRODUCTS = 10;

// The shared preamble. $1 = "now" (timestamptz), $2 = SALES_START (date).
// `tz(d)` below is written out as `(d::timestamp AT TIME ZONE '${TZ}')` — the instant a
// Manila calendar day begins.
const BOUNDS = `
  b AS (
    SELECT $1::timestamptz AS now_ts,
           $2::date        AS cutoff,
           ($1::timestamptz AT TIME ZONE '${TZ}')::date                       AS today,
           date_trunc('week',  $1::timestamptz AT TIME ZONE '${TZ}')::date    AS week_start,
           date_trunc('month', $1::timestamptz AT TIME ZONE '${TZ}')::date    AS month_start
  )`;

// Order lines that count as sales, from SALES_START on. Callers narrow by created_at.
const SALE_LINES = `
  sale_lines AS (
    SELECT o.created_at,
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

// Today / this week / this month, each with a like-for-like comparison: the
// previous period up to the same point (same Manila time of day; same weekday and
// time; same day of the month and time — capped at the previous period's end, so
// 31 March compares with all of February). No comparison when the previous period
// starts before SALES_START.
const TOTALS_SQL = `
  WITH ${BOUNDS},
  periods AS (
    SELECT 'today' AS key, today AS cur_start, today + 1 AS cur_end, today - 1 AS prev_start FROM b
    UNION ALL
    SELECT 'week', week_start, week_start + 7, week_start - 7 FROM b
    UNION ALL
    SELECT 'month', month_start, (month_start + INTERVAL '1 month')::date,
           (month_start - INTERVAL '1 month')::date FROM b
  ),
  windows AS (
    SELECT p.key,
           GREATEST(p.cur_start, b.cutoff)                     AS from_date,
           ${day('GREATEST(p.cur_start, b.cutoff)')}           AS cur_from,
           -- Never past the end of today: a period's later days have not happened,
           -- and a device clock running ahead must not book a sale into them.
           LEAST(${day('p.cur_end')}, ${day('b.today + 1')})   AS cur_to,
           p.prev_start >= b.cutoff                            AS has_prev,
           ${day('p.prev_start')}                              AS prev_from,
           LEAST(${day('p.prev_start')} + (b.now_ts - ${day('p.cur_start')}),
                 ${day('p.cur_start')})                        AS prev_to
    FROM periods p CROSS JOIN b
  ),
  ${SALE_LINES}
  SELECT w.key,
         to_char(w.from_date, 'YYYY-MM-DD') AS from_date,
         w.has_prev,
         w.prev_from,
         w.prev_to,
         (SELECT COALESCE(SUM(s.value), 0) FROM sale_lines s
           WHERE s.created_at >= w.cur_from AND s.created_at < w.cur_to)  AS gross,
         CASE WHEN w.has_prev THEN
           (SELECT COALESCE(SUM(s.value), 0) FROM sale_lines s
             WHERE s.created_at >= w.prev_from AND s.created_at < w.prev_to)
         END                                                               AS prev_gross
  FROM windows w`;

// One row per Manila day of the current month, from its first counted day to today.
const DAILY_SQL = `
  WITH ${BOUNDS},
  ${SALE_LINES},
  days AS (
    SELECT d::date AS d
    FROM b, generate_series(GREATEST(b.month_start, b.cutoff), b.today, INTERVAL '1 day') AS d
  ),
  per_day AS (
    SELECT (s.created_at AT TIME ZONE '${TZ}')::date AS d, SUM(s.value) AS gross
    FROM sale_lines s CROSS JOIN b
    WHERE s.created_at >= ${day('GREATEST(b.month_start, b.cutoff)')}
      AND s.created_at <  ${day('b.today + 1')}
    GROUP BY 1
  )
  SELECT to_char(days.d, 'YYYY-MM-DD') AS date, COALESCE(per_day.gross, 0) AS gross
  FROM days LEFT JOIN per_day ON per_day.d = days.d
  ORDER BY days.d`;

// This month's best sellers by gross sales; "cases" is the summed line quantity.
const TOP_SQL = `
  WITH ${BOUNDS},
  ${SALE_LINES}
  SELECT p.id AS product_id, p.name, p.sku, p.unit,
         SUM(s.quantity) AS cases,
         SUM(s.value)    AS gross
  FROM sale_lines s
  JOIN products p ON p.id = s.product_id
  CROSS JOIN b
  WHERE s.created_at >= ${day('GREATEST(b.month_start, b.cutoff)')}
    AND s.created_at <  ${day('b.today + 1')}
  GROUP BY p.id, p.name, p.sku, p.unit
  ORDER BY gross DESC, cases DESC, p.name ASC
  LIMIT ${TOP_PRODUCTS}`;

// Active products with no counted sale in the last 14 Manila days (today included),
// the window clamped to SALES_START until that much history exists.
const SLOW_SQL = `
  WITH ${BOUNDS},
  ${SALE_LINES},
  win AS (
    SELECT GREATEST(b.today - ${SLOW_MOVER_DAYS - 1}, b.cutoff) AS from_date,
           b.today - ${SLOW_MOVER_DAYS - 1} < b.cutoff         AS clamped,
           b.today
    FROM b
  ),
  sold AS (
    SELECT DISTINCT s.product_id
    FROM sale_lines s CROSS JOIN win
    WHERE s.created_at >= ${day('win.from_date')}
      AND s.created_at <  ${day('win.today + 1')}
  )
  SELECT to_char(win.from_date, 'YYYY-MM-DD') AS from_date,
         to_char(win.today, 'YYYY-MM-DD')     AS to_date,
         GREATEST(win.today - win.from_date + 1, 0) AS days,
         win.clamped,
         p.id, p.name, p.sku, p.category, p.unit
  FROM win
  LEFT JOIN products p
    ON p.is_active = TRUE
   AND NOT EXISTS (SELECT 1 FROM sold WHERE sold.product_id = p.id)
  ORDER BY p.name ASC NULLS LAST`;

const money = (v) => Math.round(Number(v) * 100) / 100;

function comparison(row) {
  if (!row.has_prev) return { available: false };
  const current = money(row.gross);
  const previous = money(row.prev_gross);
  const change = money(current - previous);
  return {
    available: true,
    previous_gross: previous,
    previous_from: new Date(row.prev_from).toISOString(),
    previous_to: new Date(row.prev_to).toISOString(),
    change,
    // No percentage against nothing: a first sale after an empty period is "+₱X", not "+∞%".
    change_pct: previous > 0 ? Math.round((change / previous) * 1000) / 10 : null,
  };
}

/**
 * @param {{ query: Function }} db
 * @param {{ now?: Date }} [opts]  `now` is a test seam; the route always passes the real time.
 */
async function computeSalesDashboard(db, { now = new Date() } = {}) {
  const params = [now.toISOString(), SALES_START];
  const [totals, daily, top, slow] = await Promise.all([
    db.query(TOTALS_SQL, params),
    db.query(DAILY_SQL, params),
    db.query(TOP_SQL, params),
    db.query(SLOW_SQL, params),
  ]);

  const byKey = Object.fromEntries(totals.rows.map((r) => [r.key, {
    from: r.from_date,
    gross: money(r.gross),
    comparison: comparison(r),
  }]));

  const slowHead = slow.rows[0];
  return {
    as_of: now.toISOString(),
    sales_start: SALES_START,
    week_starts_on: 'monday',
    totals: { today: byKey.today, week: byKey.week, month: byKey.month },
    daily: daily.rows.map((r) => ({ date: r.date, gross: money(r.gross) })),
    top_products: top.rows.map((r) => ({
      product_id: r.product_id,
      name: r.name,
      sku: r.sku,
      unit: r.unit,
      cases: Number(r.cases),
      gross: money(r.gross),
    })),
    slow_movers: {
      from: slowHead.from_date,
      to: slowHead.to_date,
      days: Number(slowHead.days),
      clamped: slowHead.clamped,
      products: slow.rows.filter((r) => r.id != null).map((r) => ({
        id: r.id, name: r.name, sku: r.sku, category: r.category, unit: r.unit,
      })),
    },
  };
}

module.exports = { computeSalesDashboard, SALES_START, SLOW_MOVER_DAYS, TOP_PRODUCTS };
