-- Read-only preview of migrations 051 and 052 together
-- (051_line_total_price_includes_deposit.sql, then 052_reset_prefilled_bottle_returns.sql).
--
-- Lists every closed order with its stored total now, the total it ends on once both have
-- run, and whether 052 resets its prefilled bottle counts to zero; then a one-row
-- summary. It computes the final figure from the line's own columns rather than from
-- line_total, so it gives the same answer on a database that has run neither (production,
-- where both land in one deploy), only 051, or both (where every final total equals the
-- stored one and nothing is reset). It only SELECTs.
--
-- Which orders count as prefill follows 052 exactly: closed before 051's applied_at in
-- _migrations — every closed order when 051 has not run yet — with at least one deposit
-- line and every deposit line recording every bottle back, or more (a stray tap over the
-- full count still reads as prefill).
--
--   psql "$DATABASE_URL" -f server/db/previews/052_prefill_reset.sql

BEGIN TRANSACTION READ ONLY;

WITH cutoff AS (
  SELECT (SELECT applied_at FROM _migrations
           WHERE filename = '051_line_total_price_includes_deposit.sql') AS at
), closed AS (
  SELECT o.id,
         o.total_amount AS current_total,
         (o.closed_at IS NULL OR c.at IS NULL OR o.closed_at < c.at)
           AND EXISTS (SELECT 1 FROM order_items oi
                        WHERE oi.order_id = o.id AND oi.unit_deposit_fee > 0
                          AND oi.bottles_returned <> 0)
           AND NOT EXISTS (SELECT 1 FROM order_items oi
                            WHERE oi.order_id = o.id AND oi.unit_deposit_fee > 0
                              AND oi.bottles_returned < oi.quantity * oi.units_per_case)
           AS counts_reset
    FROM orders o CROSS JOIN cutoff c
   WHERE o.status = 'done'
), final AS (
  SELECT cl.id, cl.current_total, cl.counts_reset,
         -- 051's line formula, with 052's reset applied; the same per-line rounding the
         -- NUMERIC(10,2) generated column applies.
         COALESCE(SUM((oi.quantity * oi.unit_price
                       - CASE WHEN cl.counts_reset THEN 0 ELSE oi.bottles_returned END
                         * oi.unit_deposit_fee)::NUMERIC(10,2)), 0) AS final_total
    FROM closed cl
    LEFT JOIN order_items oi ON oi.order_id = cl.id
   GROUP BY cl.id, cl.current_total, cl.counts_reset
)
SELECT f.id                                    AS order_id,
       COALESCE(o.receipt_number, '#' || o.id) AS receipt,
       c.name                                  AS customer,
       o.closed_at::date                       AS closed_on,
       f.current_total,
       f.final_total,
       f.final_total - f.current_total         AS change,
       f.counts_reset
  FROM final f
  JOIN orders o ON o.id = f.id
  LEFT JOIN customers c ON c.id = o.customer_id
 ORDER BY o.closed_at NULLS FIRST, f.id;

WITH cutoff AS (
  SELECT (SELECT applied_at FROM _migrations
           WHERE filename = '051_line_total_price_includes_deposit.sql') AS at
), closed AS (
  SELECT o.id,
         o.total_amount AS current_total,
         (o.closed_at IS NULL OR c.at IS NULL OR o.closed_at < c.at)
           AND EXISTS (SELECT 1 FROM order_items oi
                        WHERE oi.order_id = o.id AND oi.unit_deposit_fee > 0
                          AND oi.bottles_returned <> 0)
           AND NOT EXISTS (SELECT 1 FROM order_items oi
                            WHERE oi.order_id = o.id AND oi.unit_deposit_fee > 0
                              AND oi.bottles_returned < oi.quantity * oi.units_per_case)
           AS counts_reset
    FROM orders o CROSS JOIN cutoff c
   WHERE o.status = 'done'
), final AS (
  SELECT cl.id, cl.current_total, cl.counts_reset,
         COALESCE(SUM((oi.quantity * oi.unit_price
                       - CASE WHEN cl.counts_reset THEN 0 ELSE oi.bottles_returned END
                         * oi.unit_deposit_fee)::NUMERIC(10,2)), 0) AS final_total
    FROM closed cl
    LEFT JOIN order_items oi ON oi.order_id = cl.id
   GROUP BY cl.id, cl.current_total, cl.counts_reset
)
SELECT COUNT(*)                                                           AS closed_orders,
       COUNT(*) FILTER (WHERE counts_reset)                               AS orders_reset,
       COUNT(*) FILTER (WHERE counts_reset
                          AND final_total IS DISTINCT FROM current_total) AS reset_with_total_change,
       COUNT(*) FILTER (WHERE final_total IS DISTINCT FROM current_total) AS orders_total_changed,
       COALESCE(SUM(current_total) FILTER (WHERE final_total IS DISTINCT FROM current_total), 0)
                                                                          AS changed_current_sum,
       COALESCE(SUM(final_total)   FILTER (WHERE final_total IS DISTINCT FROM current_total), 0)
                                                                          AS changed_final_sum
  FROM final;

ROLLBACK;
