-- Per-bottle deposit tracking with close-order bottle return gate
-- Products get a flag indicating returnable bottles; order items cache
-- units_per_case and record bottles_returned at close time.
-- Backward compat: defaults produce the same line_total as the old formula.

ALTER TABLE products
  ADD COLUMN requires_bottle_return BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE order_items
  ADD COLUMN units_per_case   INT NOT NULL DEFAULT 1,
  ADD COLUMN bottles_returned INT NOT NULL DEFAULT 0;

-- Existing rows: units_per_case=1, bottles_returned=0
-- New formula: qty*price + (qty*1-0)*deposit = qty*(price+deposit)  ← identical to old
ALTER TABLE order_items DROP COLUMN line_total;
ALTER TABLE order_items ADD COLUMN line_total NUMERIC(10,2)
  GENERATED ALWAYS AS (
    quantity * unit_price +
    (quantity * units_per_case - bottles_returned) * unit_deposit_fee
  ) STORED;
