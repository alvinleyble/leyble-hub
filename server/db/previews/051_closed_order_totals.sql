-- Read-only preview of migration 051 (051_line_total_price_includes_deposit.sql).
--
-- Lists every closed order whose stored total the migration will change, with its total
-- before and after, then a one-row summary. It computes the new figure from the line's
-- own columns rather than from line_total, so it gives the same answer before the
-- migration (to preview it) and after (where it returns no rows). It only SELECTs.
--
--   psql "$DATABASE_URL" -f server/db/previews/051_closed_order_totals.sql

BEGIN TRANSACTION READ ONLY;

WITH recalculated AS (
  SELECT o.id,
         o.total_amount AS before_total,
         -- The same per-line rounding the NUMERIC(10,2) generated column applies.
         COALESCE(SUM((oi.quantity * oi.unit_price
                       - oi.bottles_returned * oi.unit_deposit_fee)::NUMERIC(10,2)), 0)
           AS after_total
    FROM orders o
    LEFT JOIN order_items oi ON oi.order_id = o.id
   WHERE o.status = 'done'
   GROUP BY o.id
), changed AS (
  SELECT r.*
    FROM recalculated r
   WHERE r.before_total IS DISTINCT FROM r.after_total
)
SELECT ch.id                                   AS order_id,
       COALESCE(o.receipt_number, '#' || o.id) AS receipt,
       c.name                                  AS customer,
       o.closed_at::date                       AS closed_on,
       ch.before_total,
       ch.after_total,
       ch.after_total - ch.before_total        AS change
  FROM changed ch
  JOIN orders o ON o.id = ch.id
  LEFT JOIN customers c ON c.id = o.customer_id
 ORDER BY o.closed_at NULLS FIRST, ch.id;

WITH recalculated AS (
  SELECT o.id,
         o.total_amount AS before_total,
         COALESCE(SUM((oi.quantity * oi.unit_price
                       - oi.bottles_returned * oi.unit_deposit_fee)::NUMERIC(10,2)), 0)
           AS after_total
    FROM orders o
    LEFT JOIN order_items oi ON oi.order_id = o.id
   WHERE o.status = 'done'
   GROUP BY o.id
)
SELECT COUNT(*) FILTER (WHERE before_total IS DISTINCT FROM after_total) AS orders_changed,
       COUNT(*)                                                         AS closed_orders,
       COALESCE(SUM(before_total) FILTER (WHERE before_total IS DISTINCT FROM after_total), 0)
                                                                        AS before_sum,
       COALESCE(SUM(after_total)  FILTER (WHERE before_total IS DISTINCT FROM after_total), 0)
                                                                        AS after_sum
  FROM recalculated;

ROLLBACK;
