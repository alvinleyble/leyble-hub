CREATE TABLE products (
  id                   SERIAL PRIMARY KEY,
  name                 VARCHAR(255)  NOT NULL,
  category             VARCHAR(100),
  unit                 VARCHAR(50)   NOT NULL,
  sku                  VARCHAR(100)  UNIQUE,
  base_retail_price    NUMERIC(10,2) NOT NULL DEFAULT 0,
  base_wholesale_price NUMERIC(10,2) NOT NULL DEFAULT 0,
  deposit_fee          NUMERIC(10,2) NOT NULL DEFAULT 0,
  current_stock        INT           NOT NULL DEFAULT 0,
  is_active            BOOLEAN       NOT NULL DEFAULT TRUE,
  created_at           TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
