-- Append-only. Application code must never UPDATE or DELETE rows here.
CREATE TABLE inventory_audit_logs (
  id                  SERIAL PRIMARY KEY,
  product_id          INT           NOT NULL REFERENCES products(id),
  action_type         VARCHAR(100)  NOT NULL
                        CHECK (action_type IN (
                          'manual_adjustment',
                          'restock',
                          'price_change',
                          'order_fulfillment',
                          'order_edit',
                          'order_cancel'
                        )),
  field_changed       VARCHAR(100),
  previous_value      TEXT,
  new_value           TEXT,
  delta               INT,
  reason              TEXT,
  performed_by        INT           REFERENCES users(id),
  related_order_id    INT           REFERENCES orders(id),
  related_delivery_id INT           REFERENCES supplier_deliveries(id),
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_product ON inventory_audit_logs (product_id, created_at DESC);
CREATE INDEX idx_audit_action  ON inventory_audit_logs (action_type);
