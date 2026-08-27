-- Migration 032: Add 'markup' customer type
-- Note: 031 was widened to also permit 'markup' because production already permitted
-- 'markup' out-of-band and held 'markup' customer rows before 031 ran. This migration
-- is kept for environments where 031 was already applied without 'markup' (e.g. dev DB),
-- and acts as an idempotent no-op on databases running 031 fresh (e.g. production).
ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_customer_type_check;
ALTER TABLE customers ADD CONSTRAINT customers_customer_type_check
  CHECK (customer_type IN ('regular', 'wholesaler', 'discounted', 'markup', 'unassigned'));
