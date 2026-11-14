-- 051 — the listed price already includes every bottle's deposit.
--
-- A case of Red Horse Grande 1L lists at ₱641.00: ₱614.00 of beer plus 6 bottles at
-- ₱4.50 deposit. With no bottles back the customer pays ₱641.00; with all six back the
-- amount collected at close drops to ₱614.00. Migration 023's formula instead added the
-- deposit on un-returned bottles ON TOP of the listed price, so the same case closed at
-- ₱668.00 with nothing back and ₱641.00 with everything back.
--
-- A line is now worth what was listed, less a credit for the bottles that came back:
--
--   quantity * unit_price - bottles_returned * unit_deposit_fee
--
-- Stored prices and deposit fees are untouched. units_per_case drops out of the line
-- total: it still says how many bottles a case holds, but it no longer prices anything.
--
-- Open orders keep the figure the owners already see. Their stored total_amount is
-- goods-only (quantity * unit_price, recomputeTotal in server/src/routes/orders.js) and
-- nothing here writes to it; an open line has no bottles returned, so its rebuilt
-- line_total now equals that same goods figure.
--
-- Closed ('done') orders froze SUM(line_total) into total_amount under the old formula,
-- so the second half recalculates them once. server/db/previews/051_closed_order_totals.sql
-- lists every order this will change with its before and after totals, and writes nothing.
--
-- EVERY statement is guarded so a second run changes nothing, and the end state is the
-- same whichever path a database arrives by (reference: 040_receipt_device_letter.sql).

-- A generation expression cannot be altered in place before PostgreSQL 17, so the column
-- is dropped and rebuilt (inside migrate.js's one transaction, so never observably
-- absent). Rebuilding recalculates every line, open and closed. Guarded on the one thing
-- that tells the two shapes apart: the 023 expression reads units_per_case, this one does
-- not. Already rebuilt: skip, rather than rewrite the whole table for nothing.
DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_attribute a
    JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE a.attrelid = 'order_items'::regclass
      AND a.attname = 'line_total'
      AND a.attgenerated = 's'
      AND NOT a.attisdropped
      AND pg_get_expr(d.adbin, d.adrelid) NOT LIKE '%units_per_case%'
  ) THEN
    ALTER TABLE order_items DROP COLUMN IF EXISTS line_total;
    ALTER TABLE order_items
      ADD COLUMN line_total NUMERIC(10,2) GENERATED ALWAYS AS (
        quantity * unit_price - bottles_returned * unit_deposit_fee
      ) STORED;
  END IF;
END
$do$;

-- The one-time recalculation of already-closed orders: the same SUM(line_total) that
-- recomputeTotal stores for a 'done' order. Only an order whose stored total actually
-- differs is written, which is what makes a second run a no-op, and what keeps the count
-- honest. updated_at moves on exactly those orders so every tablet's delta sync
-- (GET /orders/sync, keyed on updated_at) fetches the corrected copy; the revision
-- trigger (048) advances with it, as it does for any other write.
DO $do$
DECLARE
  changed INT;
BEGIN
  WITH recalculated AS (
    SELECT o.id, COALESCE(SUM(oi.line_total), 0) AS total
      FROM orders o
      LEFT JOIN order_items oi ON oi.order_id = o.id
     WHERE o.status = 'done'
     GROUP BY o.id
  )
  UPDATE orders o
     SET total_amount = r.total,
         updated_at   = NOW()
    FROM recalculated r
   WHERE o.id = r.id
     AND o.total_amount IS DISTINCT FROM r.total;
  GET DIAGNOSTICS changed = ROW_COUNT;
  RAISE NOTICE '051: recalculated the total of % closed order(s)', changed;
END
$do$;
