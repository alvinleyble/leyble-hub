ALTER TABLE customer_product_prices
  ADD COLUMN order_type VARCHAR(20) NOT NULL DEFAULT 'delivery'
    CHECK (order_type IN ('delivery', 'pickup'));
