-- 035 — keyset-pagination indexes for the offline sync layer (ADR 0015 §4, Slice 3.2).
--
-- A tablet mirrors order history and reference data by walking (updated_at, id) in
-- both directions: newest-first to backfill a brand-new device, oldest-first from its
-- own watermark for the delta every later login and reconnect asks for. Without these
-- indexes each of those pages is a full sort of the table, which on the store's real
-- history is the difference between a background trickle and a stall.
--
-- Purely additive: no column, constraint or default changes, so this is safe to deploy
-- on its own ahead of the server code that uses it (ADR 0014's release sequencing).

CREATE INDEX IF NOT EXISTS idx_orders_updated_at_id  ON orders    (updated_at, id);
CREATE INDEX IF NOT EXISTS idx_products_updated_at   ON products  (updated_at);
CREATE INDEX IF NOT EXISTS idx_customers_updated_at  ON customers (updated_at);
CREATE INDEX IF NOT EXISTS idx_personnel_updated_at  ON personnel (updated_at);
