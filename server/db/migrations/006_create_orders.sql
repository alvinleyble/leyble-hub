CREATE TABLE orders (
  id           SERIAL PRIMARY KEY,
  customer_id  INT           NOT NULL REFERENCES customers(id),
  driver_id    INT           REFERENCES personnel(id),
  helper_id    INT           REFERENCES personnel(id),
  status       VARCHAR(50)   NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'in_transit', 'completed', 'cancelled', 'done')),
  notes        TEXT,
  total_amount NUMERIC(10,2) NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  dispatched_at TIMESTAMPTZ,
  delivered_at  TIMESTAMPTZ,
  closed_at     TIMESTAMPTZ
);

CREATE INDEX idx_orders_status     ON orders (status);
CREATE INDEX idx_orders_customer   ON orders (customer_id);
CREATE INDEX idx_orders_created_at ON orders (created_at DESC);
