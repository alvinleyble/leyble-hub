-- Support fractional case quantities (e.g. 0.5 cases for half-case orders)
-- Generated column must be dropped before altering the column it depends on

ALTER TABLE order_items DROP COLUMN line_total;
ALTER TABLE order_items DROP CONSTRAINT IF EXISTS order_items_quantity_check;
ALTER TABLE order_items ALTER COLUMN quantity TYPE NUMERIC(10,2);
ALTER TABLE order_items ADD CONSTRAINT order_items_quantity_check CHECK (quantity > 0);
ALTER TABLE order_items ADD COLUMN line_total NUMERIC(10,2)
  GENERATED ALWAYS AS (quantity * (unit_price + unit_deposit_fee)) STORED;
