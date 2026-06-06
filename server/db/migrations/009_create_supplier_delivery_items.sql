CREATE TABLE supplier_delivery_items (
  id                SERIAL PRIMARY KEY,
  delivery_id       INT           NOT NULL REFERENCES supplier_deliveries(id) ON DELETE CASCADE,
  product_id        INT           NOT NULL REFERENCES products(id),
  quantity_received INT           NOT NULL CHECK (quantity_received > 0),
  unit_cost         NUMERIC(10,2),
  notes             TEXT,
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_sdi_delivery ON supplier_delivery_items (delivery_id);
