-- Discarding vs cancelling. Both put the stock back and leave the order in the
-- 'cancelled' status, but they mean different things:
--   * cancelled — a deliberate decision about an existing order, taken from History.
--     Stays visible there as 🚫 Cancelled.
--   * discarded — an order abandoned in the moment at the POS review stage, before it
--     ever left the counter. Never a business event worth reviewing, so it is hidden
--     from POS History rather than cluttering the Cancelled list.
-- A saved order is never hard-deleted (inventory_audit_logs / activity_logs reference
-- it and are append-only), so this is a marker on the cancellation, mirroring
-- supplier_deliveries.voided_at (migration 029).
ALTER TABLE orders
  ADD COLUMN discarded_at TIMESTAMPTZ,
  ADD COLUMN discarded_by INT REFERENCES users(id);
