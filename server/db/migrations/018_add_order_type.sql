ALTER TABLE orders
  ADD COLUMN order_type VARCHAR(20) NOT NULL DEFAULT 'delivery'
    CHECK (order_type IN ('delivery', 'pickup'));
