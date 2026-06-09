-- Rename customer types: wholesale -> regular (no custom pricing), suki -> wholesaler (custom pricing)
ALTER TABLE customers DROP CONSTRAINT customers_customer_type_check;
UPDATE customers SET customer_type = 'regular'    WHERE customer_type = 'wholesale';
UPDATE customers SET customer_type = 'wholesaler' WHERE customer_type = 'suki';
ALTER TABLE customers ALTER COLUMN customer_type SET DEFAULT 'regular';
ALTER TABLE customers ADD CONSTRAINT customers_customer_type_check
  CHECK (customer_type IN ('regular', 'wholesaler'));
