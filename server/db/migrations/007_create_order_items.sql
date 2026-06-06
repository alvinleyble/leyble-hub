CREATE TABLE order_items (
  id                  SERIAL PRIMARY KEY,
  order_id            INT           NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id          INT           NOT NULL REFERENCES products(id),
  quantity            INT           NOT NULL DEFAULT 1 CHECK (quantity > 0),
  -- unit_price and unit_deposit_fee are plain mutable columns.
  -- They may be updated to any value >= 0, including 0 (e.g. deposit waived).
  unit_price          NUMERIC(10,2) NOT NULL,
  unit_deposit_fee    NUMERIC(10,2) NOT NULL DEFAULT 0,
  is_price_overridden BOOLEAN       NOT NULL DEFAULT FALSE,
  -- line_total is a generated column: auto-recomputes on any update to the three inputs.
  line_total          NUMERIC(10,2) GENERATED ALWAYS AS
                        (quantity * (unit_price + unit_deposit_fee)) STORED,
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_order_items_order ON order_items (order_id);
