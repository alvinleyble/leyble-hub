-- Migration 031: Add 'discounted' and 'unassigned' customer types
ALTER TABLE customers DROP CONSTRAINT customers_customer_type_check;
ALTER TABLE customers ADD CONSTRAINT customers_customer_type_check
  CHECK (customer_type IN ('regular', 'wholesaler', 'discounted', 'unassigned'));
