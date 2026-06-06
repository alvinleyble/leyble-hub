CREATE TABLE tickets (
  id                   SERIAL PRIMARY KEY,
  title                VARCHAR(255)  NOT NULL,
  description          TEXT          NOT NULL,
  related_order_id     INT           REFERENCES orders(id),
  related_personnel_id INT           REFERENCES personnel(id),
  amount               NUMERIC(10,2),
  status               VARCHAR(50)   NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending', 'resolved')),
  created_by           INT           REFERENCES users(id),
  resolved_by          INT           REFERENCES users(id),
  resolved_at          TIMESTAMPTZ,
  resolution_notes     TEXT,
  created_at           TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_tickets_status ON tickets (status);
