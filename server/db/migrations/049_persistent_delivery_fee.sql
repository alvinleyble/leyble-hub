-- Persistent per-customer delivery fee.
-- docs/product/proposals/persistent-delivery-fee.md, decisions 1-2-5-14.
--
-- customers.delivery_fee is the standing, mutable rate (decision 2: one plain scalar,
-- not a history table — activity_logs already covers "what changed and when").
-- orders.delivery_fee_charged is the snapshot copied onto an order at creation time
-- (decision 6), kept as its own column rather than folded into `adjustment`
-- (decision 5) so an order can carry both independently.
--
-- Both nullable with no default: every existing row stays NULL, meaning "not
-- configured" (decision 3) — zero behavior change on rollout. Both charge-only
-- (decision 14): CHECK constraints dropped by name and re-added so a re-run against
-- an already-migrated database is a no-op.

ALTER TABLE customers ADD COLUMN IF NOT EXISTS delivery_fee NUMERIC(10,2);
ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_delivery_fee_charge_only;
ALTER TABLE customers ADD CONSTRAINT customers_delivery_fee_charge_only
  CHECK (delivery_fee IS NULL OR delivery_fee >= 0);

ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_fee_charged NUMERIC(10,2);
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_delivery_fee_charged_charge_only;
ALTER TABLE orders ADD CONSTRAINT orders_delivery_fee_charged_charge_only
  CHECK (delivery_fee_charged IS NULL OR delivery_fee_charged >= 0);
