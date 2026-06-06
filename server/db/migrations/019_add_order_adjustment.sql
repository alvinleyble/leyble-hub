ALTER TABLE orders
  ADD COLUMN adjustment        NUMERIC(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN adjustment_reason TEXT;
