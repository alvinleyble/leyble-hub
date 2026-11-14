-- 052 — closed orders whose bottle counts were the old close form's prefill, not a count.
--
-- Until 051 the close form prefilled "all bottles returned" on every deposit line, and
-- under migration 023's formula that prefill changed nothing: all returned came to the
-- listed price. 051 made the listed price include the deposit and credits returned
-- bottles, so the same untouched prefill would now take a full bottle credit off every
-- one of those orders (a case of Red Horse Grande 1L: ₱641.00 → ₱614.00). The owners
-- confirmed the prefilled counts were accepted, not counted. So an order that records
-- EVERY bottle back on EVERY deposit line is read as prefill and reset to none returned,
-- which puts it back on exactly the listed price it closed at.
--
-- What counts as prefill, all of it required:
--   * status 'done' (only closing records returns);
--   * closed before 051 was applied — 051's applied_at in _migrations, written by
--     server/db/migrate.js in 051's own committed transaction before this file runs. An
--     order closed after that went through the new form, which defaults to 0, so a full
--     count there was typed by someone and is kept. Without 051's row (this file run by
--     hand, out of order) every closed order qualifies;
--   * at least one deposit line (unit_deposit_fee > 0), and on every deposit line
--     bottles_returned = quantity * units_per_case.
-- An order with a partial count on any deposit line is left as it is and keeps 051's
-- total; an order with no deposit lines is untouched.
--
-- Stock does not move: bottle returns never touched stock (the close route writes only
-- order_items.bottles_returned and the order's total; inventory_audit_logs is written
-- solely by stock movement, which keys on quantity). Nothing here writes
-- inventory_audit_logs, customer_product_prices or activity_logs — all append-only.
--
-- A second run changes nothing: a reset order no longer records every bottle back, and
-- only lines whose count is not already 0 are written.
--
-- server/db/previews/052_prefill_reset.sql shows the combined effect of 051 and this
-- migration on a database that has run neither, and writes nothing.

DO $do$
DECLARE
  cutoff      TIMESTAMPTZ;
  reset_ids   INT[];
BEGIN
  SELECT applied_at INTO cutoff
    FROM _migrations
   WHERE filename = '051_line_total_price_includes_deposit.sql';

  -- The lines first, so the GENERATED line_total is recomputed before the totals read it
  -- (a data-modifying CTE's writes are not visible to the rest of its own statement).
  WITH prefilled AS (
    SELECT o.id
      FROM orders o
     WHERE o.status = 'done'
       AND (o.closed_at IS NULL OR cutoff IS NULL OR o.closed_at < cutoff)
       AND EXISTS (
             SELECT 1 FROM order_items oi
              WHERE oi.order_id = o.id AND oi.unit_deposit_fee > 0)
       AND NOT EXISTS (
             SELECT 1 FROM order_items oi
              WHERE oi.order_id = o.id AND oi.unit_deposit_fee > 0
                AND oi.bottles_returned <> oi.quantity * oi.units_per_case)
  ), reset AS (
    UPDATE order_items oi
       SET bottles_returned = 0,
           updated_at       = NOW()
      FROM prefilled p
     WHERE oi.order_id = p.id
       AND oi.unit_deposit_fee > 0
       AND oi.bottles_returned <> 0
    RETURNING oi.order_id
  )
  SELECT COALESCE(array_agg(DISTINCT order_id), '{}') INTO reset_ids FROM reset;

  -- The same SUM(line_total) recomputeTotal stores for a 'done' order. updated_at moves
  -- on exactly these orders so every tablet's delta sync (GET /orders/sync) fetches the
  -- corrected copy; the revision trigger (048) advances with it.
  UPDATE orders o
     SET total_amount = (SELECT COALESCE(SUM(oi.line_total), 0)
                           FROM order_items oi WHERE oi.order_id = o.id),
         updated_at   = NOW()
   WHERE o.id = ANY(reset_ids);

  RAISE NOTICE '052: reset prefilled bottle counts on % closed order(s)', cardinality(reset_ids);
END
$do$;
