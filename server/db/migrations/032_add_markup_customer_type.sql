-- Migration 032: Add 'markup' customer type
ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_customer_type_check;
ALTER TABLE customers ADD CONSTRAINT customers_customer_type_check
  CHECK (customer_type IN ('regular', 'wholesaler', 'discounted', 'markup', 'unassigned'));
