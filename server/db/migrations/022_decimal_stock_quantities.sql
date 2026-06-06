-- Allow half-case (0.5) quantities throughout stock tracking
ALTER TABLE products
  ALTER COLUMN current_stock TYPE NUMERIC(10,2);

ALTER TABLE supplier_delivery_items
  ALTER COLUMN quantity_received TYPE NUMERIC(10,2);
