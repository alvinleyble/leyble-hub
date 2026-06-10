-- Tracks the most recent confirmed receipt print for an order, separately for the
-- 'pending' phase and the 'delivered' (completed/done) phase. Overwritten on each
-- confirmed print; each confirmation is also recorded in activity_logs for history.
ALTER TABLE orders
  ADD COLUMN pending_receipt_printed_at   TIMESTAMPTZ,
  ADD COLUMN pending_receipt_printed_by   INT REFERENCES users(id),
  ADD COLUMN delivered_receipt_printed_at TIMESTAMPTZ,
  ADD COLUMN delivered_receipt_printed_by INT REFERENCES users(id);
