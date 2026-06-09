-- Generic, append-only activity log for system-wide changes (orders, customers,
-- products, personnel, tickets) that fall outside the product-stock-centric
-- inventory_audit_logs table. Never UPDATE or DELETE rows in this table.

CREATE TABLE activity_logs (
  id           SERIAL PRIMARY KEY,
  entity_type  VARCHAR(50) NOT NULL
                 CHECK (entity_type IN ('order', 'customer', 'product', 'personnel', 'ticket')),
  entity_id    INT,
  action       VARCHAR(50) NOT NULL,
  summary      TEXT        NOT NULL,
  performed_by INT         REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_activity_entity  ON activity_logs (entity_type, entity_id, created_at DESC);
CREATE INDEX idx_activity_created ON activity_logs (created_at DESC);
