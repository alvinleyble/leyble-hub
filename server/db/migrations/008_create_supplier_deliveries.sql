CREATE TABLE supplier_deliveries (
  id            SERIAL PRIMARY KEY,
  supplier_name VARCHAR(255)  NOT NULL,
  notes         TEXT,
  received_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  created_by    INT           REFERENCES users(id),
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
