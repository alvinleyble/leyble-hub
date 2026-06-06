CREATE TABLE customers (
  id            SERIAL PRIMARY KEY,
  name          VARCHAR(255)  NOT NULL,
  customer_type VARCHAR(50)   NOT NULL DEFAULT 'retail'
                  CHECK (customer_type IN ('retail', 'wholesale', 'suki')),
  address       TEXT,
  phone         VARCHAR(50),
  notes         TEXT,
  is_active     BOOLEAN       NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
