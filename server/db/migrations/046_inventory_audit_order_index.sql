-- 046 — index the audit log by the order it belongs to.
--
-- `isStockOut()` (server/src/lib/inventory.js) is the gate on EVERY stock decision under
-- ADR 0012: dispatch, cancel, step-back and the edit path's reconciliation each ask it
-- whether this order's goods are currently out, by summing that order's own deltas in the
-- append-only inventory_audit_logs. Without an index that is a sequential scan of a table
-- which only ever grows — every movement of every product, for the life of the business —
-- to answer a question about a handful of rows.
--
-- It is one of the queries in the Edit Order → Save Changes transaction, which at the
-- production API's distance from the Sydney database has to fit inside the client's 5s
-- write budget, so the scan is paid at exactly the wrong moment.
--
-- INCLUDE (delta) lets the sum come straight off the index. The partial predicate keeps
-- the index to order-related rows only (deliveries and manual adjustments carry NULL
-- here); the planner proves `related_order_id = $1` implies `IS NOT NULL`, so every
-- lookup still uses it.
--
-- Purely additive, re-runnable, and safe to deploy ahead of the server code that benefits
-- from it (ADR 0014's release sequencing) — it changes no column, constraint or default.

CREATE INDEX IF NOT EXISTS idx_inventory_audit_logs_related_order
  ON inventory_audit_logs (related_order_id) INCLUDE (delta)
  WHERE related_order_id IS NOT NULL;
