-- Append-only Suki/VIP pricing history.
-- Most recent row per (customer_id, product_id) is the active custom price.
CREATE TABLE customer_product_prices (
  id                 SERIAL PRIMARY KEY,
  customer_id        INT           NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  product_id         INT           NOT NULL REFERENCES products(id)  ON DELETE CASCADE,
  custom_unit_price  NUMERIC(10,2),
  custom_deposit_fee NUMERIC(10,2),
  set_by_user_id     INT           REFERENCES users(id),
  notes              TEXT,
  created_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW()
  -- No updated_at: this table is append-only.
);

CREATE INDEX idx_cpp_customer_product_time
  ON customer_product_prices (customer_id, product_id, created_at DESC);
